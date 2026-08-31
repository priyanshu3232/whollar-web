'use strict';

/**
 * Route table + global middleware for the auth function.
 *
 * Path shape: Advanced I/O functions are served under `/server/<fn>/…`, so on
 * the raw Catalyst domain this function lives at `/server/auth`. The browser
 * reaches it same-origin at `https://www.whollar.ca/api/auth/*` via the rewrite
 * in `vercel.json`. To keep one contract across both, the router is mounted at
 * BOTH `/` and `/auth`, so these are all the same endpoint:
 *
 *   https://www.whollar.ca/api/auth/health                       (browser)
 *   https://<project>.development.catalystserverless.ca/server/auth/health
 *   https://<project>.development.catalystserverless.ca/server/auth/auth/health
 */

const express = require('express');
const crypto = require('node:crypto');

const datastore = require('./lib/datastore');
const sessions = require('./lib/sessions');
const cookies = require('./lib/cookies');
const csrf = require('./lib/csrf');
const audit = require('./lib/audit');
const mailer = require('./lib/mailer');
const { verify: verifySchema, TABLE_NAMES } = require('./lib/schema');
const { errorHandler, wrap, AppError } = require('./lib/errors');
const otpRoutes = require('./routes/otp');
const passwordRoutes = require('./routes/password');
const resetRoutes = require('./routes/reset');
const googleRoutes = require('./routes/google');
const providerRoutes = require('./routes/provider');
const memberRoutes = require('./routes/member');
const meRoutes = require('./routes/me');
const ratingRoutes = require('./routes/rating');
const interestRoutes = require('./routes/interest');
const campaignRoutes = require('./routes/campaigns');
const deskRoutes = require('./routes/desk');
const applicationRoutes = require('./routes/application');
const contractRoutes = require('./routes/contracts');
const deliveryRoutes = require('./routes/delivery');
const billingRoutes = require('./routes/billing');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const shareRoutes = require('./routes/share');
const seatRoutes = require('./routes/seat');
const notifyRoutes = require('./routes/notify');
const exclusionRoutes = require('./routes/exclusions');
const outbox = require('./lib/notify/outbox');

/**
 * Strip anything address-shaped out of a provider error before it is returned.
 *
 * ZeptoMail rejections quote the offending recipient back in the response body,
 * and that body is what lands in `send_error`. The diagnostic value is in the
 * status and the reason ("domain not verified"), never in who it was for.
 */
function redactEmails(text) {
  if (!text) return null;
  return String(text).replace(/[^\s<>"']+@[^\s<>"']+/g, '[redacted]');
}

function buildApp(cfg) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // Reachable as req.app.get('cfg') from anywhere, so no module has to be
  // constructed with config or reach for process.env a second time.
  app.set('cfg', cfg);

  // 1. Request id + structured logger.
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // Structured, and deliberately free of anything user-identifying:
      // no email, no code, no token, no raw IP. §12.
      console.log(JSON.stringify({
        req_id: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(ms),
      }));
    });
    next();
  });

  // Nothing this function returns is ever cacheable. Set once, centrally, so a
  // new route cannot forget it: a cached auth response would hand one visitor
  // another visitor's session.
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    next();
  });

  // 2. Body parsers. Every route of ours speaks JSON; urlencoded is kept so a
  //    form-encoded POST parses into a real body rather than an empty one and
  //    fails validation on its merits.
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // 3. Origin allowlist on every state-changing request.
  app.use(csrf.middleware(cfg));

  // 4. Session loader. Populates req.auth for every route; never rejects:
  //    a route that requires a session says so itself, via requireSession.
  app.use(wrap(async (req, res, next) => {
    req.catalyst = datastore.app(req);
    req.auth = await sessions.load(req.catalyst, req, res);
    next();
  }));

  // 5. Routes.
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'auth',
      phase: 5,
      request_id: req.id,
      node: process.versions.node,
      env: cfg.NODE_ENV,
      features: cfg.FEATURES,
      // Reported rather than inferred: "why did no email arrive" should be
      // answerable from outside without reading the logs. The endpoint is
      // included because ZeptoMail is regional and pointing a Canadian-DC
      // token at the US host fails as "Invalid API Token", which sends you
      // hunting for a bad token rather than a wrong hostname.
      mail_transport: mailer.transportName(cfg),
      mail_endpoint: cfg.FEATURES.mail ? (cfg.ZEPTOMAIL_API_BASE || null) : null,
      // The From address is public: it appears in the header of every message
      // we send. Surfacing it turns "does this match the verified domain?" from
      // a console hunt into one curl, and a mismatch there is rejected on every
      // send with an error that does not mention the domain.
      mail_from: cfg.FEATURES.mail ? (cfg.ZEPTOMAIL_FROM || null)
        : (cfg.FEATURES.smtp ? (cfg.SMTP_FROM || null) : null),
      /* The addresses mail actually leaves as, per transport, because "which
         sender" is the question a delivery failure most often turns out to be
         and it was answerable nowhere. A transactional sender naming a
         subdomain with no verified Mail Agent behind it refuses every send,
         and the relay's own mailbox is the only address the fallback can use.
         Public for the same reason `mail_from` is: these appear in the From
         line of every email this system sends. */
      mail_senders: {
        /* Resolved through the outbox's own function rather than restated
           here, so a health check cannot report a sender the mail path does
           not use. */
        transactional: outbox.senderAddress(cfg, { casl: 'transactional' }) || null,
        cem: outbox.senderAddress(cfg, { casl: 'cem' }) || null,
        smtp_relay: cfg.FEATURES.smtp ? (cfg.SMTP_FROM || null) : null,
      },
    });
  });

  /**
   * Did the last codes actually go out?
   *
   * Every send-bearing route answers identically whether the provider accepted
   * the mail or rejected it: that symmetry is what stops /signup and /otp/start
   * being used to probe which addresses have accounts. The cost is that a total
   * delivery outage looks exactly like success from outside, and the only place
   * the distinction survives is the `delivered` flag on the audit row.
   *
   * This is the replacement for the old /dev/events, which answered the same
   * question by returning the rows wholesale: including the email column. It
   * reports delivery OUTCOMES only: no address is selected from the table, and
   * the provider's error string is redacted before it is returned, because a
   * rejection body routinely echoes the recipient back (see mailer.js). That is
   * what makes this safe to leave mounted outside dev, which matters because
   * "is mail working?" is a production question.
   */
  router.get('/health/mail', wrap(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    // Deliberately no email_normalized: what is never read cannot leak.
    const rows = await datastore.query(
      req.catalyst, audit.TABLE,
      `SELECT CREATEDTIME, event_type, outcome, detail FROM ${audit.TABLE} ` +
      `ORDER BY CREATEDTIME DESC LIMIT ${limit}`
    );

    const events = [];
    let delivered = 0;
    let failed = 0;

    for (const row of rows) {
      let detail;
      try { detail = JSON.parse(row.detail); } catch { detail = null; }
      // Only rows that actually carry a send outcome; `delivered` is the marker.
      if (!detail || typeof detail.delivered !== 'boolean') continue;

      if (detail.delivered) delivered += 1; else failed += 1;

      events.push({
        at: row.CREATEDTIME,
        type: row.event_type,
        outcome: row.outcome,
        delivered: detail.delivered,
        transport: detail.transport || null,
        send_error: redactEmails(detail.send_error),
      });
    }

    /* The outbox's own view, alongside the audit one.
     *
     * The audit rows above are what the mail path recorded before the outbox
     * existed and are kept because they cover the whole history. This is the
     * answer to the questions the audit rows cannot reach: how many messages
     * are waiting, how many are held for quiet hours, how many failed and
     * why, and how many addresses are suppressed. `available: false` means the
     * tables are not created yet, which is a different fault from zero rows
     * and worth telling apart.
     *
     * ADMIN ONLY, unlike the rest of this route.
     *
     * The route above it is deliberately public, and the paragraph explaining
     * why is careful about what that costs: outcomes, never addresses. These
     * fields are a different kind of thing. A complaint count is business
     * telemetry, send volume by status is a picture of how much mail this
     * company moves, and `webhook_configured: false` tells a stranger that
     * bounce handling is off, which is a recon signal rather than a health
     * check. So the public answer stays exactly what it was, and the
     * operational detail needs a session. */
    const isAdmin = Boolean(req.auth && req.auth.user && req.auth.user.user_type === 'admin');

    /* CAN WE SEE THE TABLES, asked separately from what is in them.
     *
     * These two booleans are public and the counts beside them are not, and the
     * line between them is the line between a schema fact and business
     * telemetry. "notification_outbox exists and is readable" tells an outsider
     * nothing they could not learn by watching an email arrive. "there are 412
     * queued and 9 complaints" tells them how much mail this company moves and
     * how much of it people hate, which is nobody's business.
     *
     * It is public because it is the go/no-go for a deploy, and a deploy check
     * that needs a session is a deploy check nobody runs. That is not a
     * hypothetical: this exact endpoint was unreadable at the moment it was
     * most needed, because the admin console it assumed has never been
     * deployed. */
    const readable = async (table) => {
      try {
        await datastore.queryAll(req.catalyst, table, ['ROWID'], 'ROWID > 0', { maxPages: 1 });
        return true;
      } catch {
        return false;
      }
    };
    const outboxAvailable = await readable(outbox.TABLE);
    const suppressionsAvailable = await readable('email_suppressions');

    let outboxSummary = { available: outboxAvailable };
    let suppressions = { available: suppressionsAvailable };

    if (isAdmin && outboxAvailable) {
      try {
        const counts = {};
        for (const status of outbox.STATUS) {
          /* eslint-disable-next-line no-await-in-loop */
          const page = await datastore.queryAll(req.catalyst, outbox.TABLE, ['notify_key'],
            `status = ${datastore.lit(status)}`);
          counts[status] = (page || []).length;
        }
        const failedRows = await datastore.queryAll(req.catalyst, outbox.TABLE,
          ['last_error'], "status = 'failed'");
        const reasons = {};
        for (const r of failedRows || []) {
          const kind = String(r.last_error || 'unknown').split(':')[0];
          reasons[kind] = (reasons[kind] || 0) + 1;
        }
        outboxSummary = { available: true, counts, failure_reasons: reasons };
      } catch {
        /* The table answered a moment ago and will not now. Leave the boolean. */
      }
    }

    if (isAdmin && suppressionsAvailable) {
      try {
        const rows2 = await datastore.queryAll(req.catalyst, 'email_suppressions', ['reason'], 'ROWID > 0');
        const byReason = {};
        for (const r of rows2 || []) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
        suppressions = { available: true, total: (rows2 || []).length, by_reason: byReason };
      } catch {
        /* ditto */
      }
    }

    res.status(200).json({
      service: 'auth',
      request_id: req.id,
      transport: mailer.transportName(cfg),
      mail_from: cfg.FEATURES.mail ? (cfg.ZEPTOMAIL_FROM || null)
        : (cfg.FEATURES.smtp ? (cfg.SMTP_FROM || null) : null),
      /* Which endpoint the bytes actually leave through. It is regional, and
         "is this the Canadian host" is a question that should be answerable
         without reading environment variables. Public, because it names no
         volume and no recipient, and because a US host here is the kind of
         mistake that should be findable by anyone who thinks to look. */
      mail_endpoint: cfg.ZEPTOMAIL_API_BASE || mailer.DEFAULT_API_BASE,
      scanned: rows.length,
      delivered,
      failed,
      /* Public: whether the layer can function at all. Carries no volume and
         no configured value, only whether a table answers and whether a
         variable is set. This is the deploy check. */
      outbox: outboxSummary,
      suppressions,
      /* A commercial send is refused outright without this, so its absence is
         a fact about what the system will do, not a note about config. */
      postal_address_configured: Boolean(cfg.MAIL_POSTAL_ADDRESS),
      /* Unset, the delivery webhook answers 503 and the suppression list never
         grows, which from outside is indistinguishable from nothing ever
         bouncing. */
      webhook_configured: Boolean(cfg.MAIL_WEBHOOK_SECRET),
      /* Unset, POST /admin/notify/tick is admin-only and the timer cannot call
         it, so no reminder ever fires on a clock. Reported because the failure
         a wrong secret produces is UNAUTHENTICATED, which reads as "the header
         did not match" and is equally consistent with "the variable is not set
         at all". This is the one bit that tells those apart, and hunting the
         difference by hand is a bad half hour. The VALUE is never reported. */
      cron_configured: Boolean(cfg.NOTIFY_CRON_SECRET),
      events,
    });
  }));

  /**
   * Who am I?
   *
   * Answers 200 with `authenticated: false` rather than 401 when signed out.
   * This is the endpoint every page calls on load to decide what to render, and
   * "no session" is a normal answer to that question, not an error: a 401 here
   * would put a red line in the console of every logged-out visitor.
   */
  router.get('/session', (req, res) => {
    if (!req.auth) return res.status(200).json({ authenticated: false, user: null });
    res.status(200).json({
      authenticated: true,
      user: sessions.publicUser(req.auth.user),
      expiresAt: req.auth.session.expires_at,
    });
  });

  /**
   * Sign out. Idempotent: signing out twice, or without a session, succeeds.
   * A logout that can fail is a logout users do not trust.
   */
  router.post('/logout', wrap(async (req, res) => {
    if (req.auth) {
      await sessions.revoke(req.catalyst, req.auth.session);
      audit.recordAsync(req.catalyst, req, {
        type: 'session.logout',
        outcome: 'success',
        userId: req.auth.user.user_id,
        email: req.auth.user.email_normalized,
      });
    }
    cookies.clear(req, res);
    res.status(200).json({ ok: true });
  }));

  otpRoutes.mount(router, cfg);
  passwordRoutes.mount(router, cfg);
  resetRoutes.mount(router, cfg);
  googleRoutes.mount(router, cfg);
  providerRoutes.mount(router, cfg);
  memberRoutes.mount(router);
  meRoutes.mount(router);
  ratingRoutes.mount(router);
  interestRoutes.mount(router);
  campaignRoutes.mount(router, cfg);
  deskRoutes.mount(router);
  applicationRoutes.mount(router);
  contractRoutes.mount(router);
  deliveryRoutes.mount(router);
  billingRoutes.mount(router);
  // Mounts nothing unless the `admin` config group is set: see routes/admin.js.
  adminRoutes.mount(router, cfg);
  publicRoutes.mount(router);
  shareRoutes.mount(router);
  seatRoutes.mount(router);
  /* The unsubscribe door and the delivery webhook. Both are reached without a
     session: see routes/notify.js for why each is safe without one. */
  notifyRoutes.mount(router, cfg);
  /* The brand registry, member exclusions, and the partner roster. Mounted
     after campaigns so nothing here shadows an existing /provider path. */
  exclusionRoutes.mount(router);

  /**
   * Schema + request-shape diagnostics.
   *
   * Requires an admin session unconditionally, NOT `!cfg.IS_PRODUCTION`, on
   * purpose. This dumps per-table row counts and the full column-level schema
   * for every table (users, sessions, credentials, campaigns, auth_events…),
   * which is exactly the kind of thing a misconfigured `NODE_ENV` must not be
   * the only thing standing between this and the public internet. requireAdmin
   * is the independent backstop: even if the environment gate fails open, this
   * still refuses anyone who isn't an authenticated admin.
   *
   * Reports shapes and names only. The Origin value is echoed because it is our
   * own domain and the exact string is the point; the client IP is reduced to a
   * family and a boolean, because that one is personal data.
   */
  router.get('/health/diagnostics', wrap(async (req, res) => {
    adminRoutes.requireAdmin(req);

    const fwd = String(req.headers['x-forwarded-for'] || '');
    const hops = fwd ? fwd.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const ip = req.ip || '';

    let schema;
    try {
      schema = await verifySchema(req.catalyst);
    } catch (err) {
      schema = { ok: false, error: String((err && err.message) || err).slice(0, 200) };
    }

    // Row counts, capped. Chiefly to confirm auth_events is actually being
    // written: audit failures are swallowed by design so they cannot break a
    // login, which also means a broken audit trail is invisible until the day
    // you need it. Counting is the cheapest way to notice.
    // ZCQL caps how many rows one query may return, and exceeding the cap is a
    // hard 400 rather than a truncated result set. `?cap=` exists so the real
    // ceiling can be probed without a redeploy per attempt.
    const CAP = Math.min(Math.max(parseInt(req.query.cap, 10) || 200, 1), 1000);
    const counts = {};
    // Every table the schema declares, not a hand-kept subset: a list that has
    // to be extended by hand is a list that silently stops covering the table
    // you most need to look at.
    for (const table of TABLE_NAMES) {
      try {
        const rows = await datastore.query(
          req.catalyst, table, `SELECT ROWID FROM ${table} LIMIT ${CAP}`
        );
        counts[table] = rows.length >= CAP ? `${CAP}+` : rows.length;
      } catch (err) {
        counts[table] = `error: ${String((err && err.message) || err).slice(0, 300)}`;
      }
    }

    res.status(200).json({
      service: 'auth',
      request_id: req.id,
      request: {
        origin: req.headers.origin || null,
        referer_present: Boolean(req.headers.referer),
        sec_fetch_site: req.headers['sec-fetch-site'] || null,
        forwarded_hops: hops.length,
        client_ip_present: Boolean(ip),
        client_ip_family: ip.includes(':') ? 'ipv6' : (ip ? 'ipv4' : null),
        via_vercel: Boolean(req.headers['x-vercel-id']),
        cookie_present: Boolean(cookies.read(req)),
      },
      authenticated: Boolean(req.auth),
      counts,
      schema,
    });
  }));

  if (!cfg.IS_PRODUCTION) {
    mountDevRoutes(router, cfg);
  }

  // Both mounts share one router instance. The 404 fallback must live on the
  // app, not the router: a catch-all inside the router would be reached via
  // the `/` mount and swallow every request before the `/auth` mount ran.
  app.use('/', router);
  app.use('/auth', router);

  app.use((req, res, next) => {
    next(new AppError('NOT_FOUND', 'Not found.', { logDetail: `${req.method} ${req.path}` }));
  });

  // 6. Error handler.
  app.use(errorHandler);

  return app;
}

/**
 * NON-PRODUCTION ONLY. Absent entirely when NODE_ENV=production, so these fall
 * through to the 404 rather than existing and refusing.
 */
function mountDevRoutes(router, cfg) {
  /** Revoke every session for the signed-in user. Exercises the reset path. */
  router.post('/dev/logout-everywhere', wrap(async (req, res) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Please sign in again.');
    const revoked = await sessions.revokeAllForUser(req.catalyst, req.auth.user.user_id);
    cookies.clear(req, res);
    res.status(200).json({ ok: true, revoked });
  }));
}

/**
 * Served when config validation failed at cold start. The function refuses to
 * do any auth work, but stays diagnosable from outside: /health returns the
 * *names* of the variables that need setting, never their values.
 */
function buildDegradedApp(problems, missingNames) {
  const app = express();
  app.disable('x-powered-by');

  app.get(['/health', '/auth/health'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      status: 'degraded',
      service: 'auth',
      node: process.versions.node,
      reason: 'configuration incomplete: auth routes are disabled',
      missing: missingNames,
      problems,
    });
  });

  app.use((req, res) => {
    res.status(503).json({
      error: { code: 'SERVER_ERROR', message: 'Authentication is not configured on this environment.' },
    });
  });

  return app;
}

module.exports = { buildApp, buildDegradedApp };
