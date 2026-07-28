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
const { verify: verifySchema } = require('./lib/schema');
const { errorHandler, wrap, AppError } = require('./lib/errors');
const otpRoutes = require('./routes/otp');
const googleRoutes = require('./routes/google');

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
  // new route cannot forget it — a cached auth response would hand one visitor
  // another visitor's session.
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    next();
  });

  // 2. Body parsers. urlencoded is not optional — Apple's callback is
  //    form-encoded and omitting it is the single most common Apple failure.
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // 3. Origin allowlist on every state-changing request.
  app.use(csrf.middleware(cfg));

  // 4. Session loader. Populates req.auth for every route; never rejects —
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
      phase: 3,
      request_id: req.id,
      node: process.versions.node,
      env: cfg.NODE_ENV,
      features: cfg.FEATURES,
      // Reported rather than inferred: "why did no email arrive" should be
      // answerable from outside without reading the logs.
      mail_transport: mailer.transportName(cfg),
    });
  });

  /**
   * Who am I?
   *
   * Answers 200 with `authenticated: false` rather than 401 when signed out.
   * This is the endpoint every page calls on load to decide what to render, and
   * "no session" is a normal answer to that question, not an error — a 401 here
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
  googleRoutes.mount(router, cfg);

  if (!cfg.IS_PRODUCTION) {
    mountDevRoutes(router, cfg);
  }

  // Both mounts share one router instance. The 404 fallback must live on the
  // app, not the router — a catch-all inside the router would be reached via
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
  /**
   * Schema + request-shape diagnostics.
   *
   * Two questions it answers, both otherwise guesswork. First, do the
   * hand-created Data Store tables match what the code expects? Catalyst has no
   * DDL API, so tables are clicked in by hand and a mistyped column fails at
   * runtime rather than at deploy — checking ten tables and sixty columns by
   * eye is exactly the job a machine should do once. Second, what survives the
   * Vercel proxy hop? `Origin` is the whole CSRF defence and the client IP feeds
   * `ip_hash` and rate limiting.
   *
   * Reports shapes and names only. The Origin value is echoed because it is our
   * own domain and the exact string is the point; the client IP is reduced to a
   * family and a boolean, because that one is personal data.
   */
  router.get('/health/diagnostics', wrap(async (req, res) => {
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
    for (const table of ['users', 'sessions', 'auth_events', 'auth_challenges',
      'auth_identities', 'consents']) {
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

  /**
   * Mint a session without a login flow.
   *
   * Phase 3 has not shipped, so there is no way to obtain a session yet — which
   * would leave the whole of Phase 2 untestable until the phase after it lands.
   * This route closes that gap and exercises precisely the code path the real
   * OTP verify will call: find-or-create the user, then `sessions.create`.
   *
   * Gated on NODE_ENV. It is the single most dangerous route in this codebase
   * if it ever reaches production, so it does not merely refuse there — it is
   * never registered.
   */
  router.post('/dev/session', wrap(async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const userType = (req.body && req.body.userType) === 'provider' ? 'provider' : 'member';

    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
      throw new AppError('VALIDATION_ERROR', 'A valid email is required.');
    }

    let user = await datastore.findBy(
      req.catalyst, sessions.USERS, 'email_normalized', email, sessions.USER_COLUMNS
    );

    if (!user) {
      const userId = crypto.randomUUID();
      await datastore.insertRow(req.catalyst, sessions.USERS, {
        user_id: userId,
        email_normalized: email,
        email_display: String((req.body && req.body.email) || '').trim(),
        first_name: (req.body && req.body.firstName) || null,
        user_type: userType,
        status: 'active',
        last_login_at: datastore.nowDb(),
        crm_contact_id: null,
      });
      user = await datastore.findBy(
        req.catalyst, sessions.USERS, 'user_id', userId, sessions.USER_COLUMNS
      );
    } else {
      await datastore.updateRow(req.catalyst, sessions.USERS, {
        ROWID: user.ROWID, last_login_at: datastore.nowDb(),
      });
    }

    const created = await sessions.create(req.catalyst, req, res, {
      userId: user.user_id, userType: user.user_type,
    });

    await audit.record(req.catalyst, req, {
      type: 'dev.session.create',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { user_type: user.user_type },
    });

    res.status(200).json({
      ok: true,
      dev: true,
      user: sessions.publicUser(user),
      expiresAt: created.expiresAt,
    });
  }));

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
      reason: 'configuration incomplete — auth routes are disabled',
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
