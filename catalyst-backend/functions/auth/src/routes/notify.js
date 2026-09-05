'use strict';

/**
 * The unsubscribe door, the delivery webhook, and the operator's view of both.
 *
 * WHY THE UNSUBSCRIBE PAGE ASKS FOR NOTHING. No sign-in, no email address to
 * confirm, no "are you sure" that leads to a login wall. A person who has
 * decided they want no more mail is the last person to ask for a password,
 * and CASL's ten-business-day rule exists because of systems that made this
 * hard. The token is the authorisation. It is sixteen checked characters, it
 * carries no identity, and the worst it can do in a stranger's hands is stop
 * mail that the stranger would have to have intercepted to know about.
 *
 * TWO WAYS IN, AND THE SECOND ONE NEVER RENDERS A PAGE. `List-Unsubscribe-Post`
 * (RFC 8058) is the header Gmail and Apple Mail read to show their own
 * unsubscribe button; pressing it POSTs here from the mail client, with no
 * session, no Origin this function would recognise, and nobody looking at a
 * browser. It answers 200 with two words. The GET renders the page for the
 * person who clicked the link in the footer instead.
 *
 * WHY BOTH ARE CSRF EXEMPT. See lib/csrf.js: the exemption is granted where a
 * route carries a stronger check of its own. Here that is the token, and for
 * the webhook it is the shared secret. A forged unsubscribe POST needs the
 * token, and anyone holding the token can already GET the page.
 *
 * NO CONFIRMATION EMAIL. Sending another message to somebody who just asked
 * for fewer is the wrong answer. The page confirms, and the header press is
 * confirmed by the client's own interface.
 */

const { wrap } = require('../lib/errors');
const datastore = require('../lib/datastore');
const ratelimit = require('../lib/ratelimit');
const unsub = require('../lib/notify/unsub');
const suppress = require('../lib/notify/suppress');
const outbox = require('../lib/notify/outbox');
const reminders = require('../lib/notify/reminders');
const registry = require('../lib/notify/registry');
const { requireUser } = require('../lib/guards');
const { requireAdmin } = require('./admin');
const { AppError, badRequest } = require('../lib/errors');
const audit = require('../lib/audit');

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * One self-contained page, no stylesheet and no script.
 *
 * Self-contained because this is served by the backend through a rewrite and
 * has no access to the site's build; scriptless because the global CSP has no
 * 'unsafe-inline' for script and this page has nothing that needs one. The
 * form posts to itself.
 */
function page({ title, body, action, buttonLabel, done }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex,nofollow">`
    + `<title>${esc(title)} · Whollar</title>`
    + `<style>`
    + `:root{color-scheme:light}`
    + `body{margin:0;padding:48px 20px;background:#F1EFE8;`
    + `font:16px/1.55 Satoshi,'General Sans',Inter,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#0E2A20}`
    + `main{max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:32px}`
    + `h1{margin:0 0 12px;font-size:22px;line-height:1.25}`
    + `p{margin:0 0 16px;color:#4A5D57}`
    + `.ok{color:#1E9E63;font-weight:700}`
    + `button{appearance:none;border:0;border-radius:8px;background:#1E9E63;color:#fff;`
    + `font:700 15px/1 inherit;padding:13px 22px;cursor:pointer}`
    + `a{color:#178A5A}`
    + `.fine{font-size:13px;color:#6B7C77;margin-top:24px}`
    + `</style></head><body><main>`
    + `<h1>${esc(title)}</h1>`
    + body
    + (action
      ? `<form method="post" action="${esc(action)}"><button type="submit">${esc(buttonLabel)}</button></form>`
      : '')
    + `<p class="fine">${done
      ? 'You will still get messages about your own account, such as sign-in codes and anything about a cohort you have joined. Those are not marketing and there is no way to switch them off.'
      : 'This will not affect messages about your own account, such as sign-in codes.'}</p>`
    + `</main></body></html>`;
}

function scopeLabel(scope) {
  if (scope === unsub.ALL) return 'all Whollar marketing email';
  const c = registry.CATEGORIES[scope];
  return c ? c.label.toLowerCase() : String(scope);
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

function mount(router, cfg) {

  /**
   * The confirmation page. GET, so it is side-effect free: a mail client or a
   * link scanner that prefetches every URL in a message must not be able to
   * unsubscribe somebody who never clicked. That is not hypothetical, it is
   * what corporate link protection does to every link it sees.
   */
  router.get('/u/:token', wrap(async (req, res) => {
    await ratelimit.withinLimit(req.catalyst, req, {
      key: 'unsub.view', max: 120, windowSec: 3600,
    });

    const row = await unsub.resolve(req.catalyst, req.params.token);
    res.set('Cache-Control', 'no-store');
    res.type('html');

    if (!row) {
      /* A wrong token gets the same page a correct one would, minus the
         button. Saying "no such token" would confirm which tokens exist. */
      return res.status(404).send(page({
        title: 'That link has expired',
        body: '<p>We could not read that unsubscribe link. It may have been broken by the mail client that displayed it.</p>'
          + '<p>You can change what Whollar sends you from your dashboard at any time, or reply to any Whollar email and a person will do it for you.</p>',
      }));
    }

    if (row.used_at) {
      return res.status(200).send(page({
        title: 'Already unsubscribed',
        body: `<p class="ok">You are unsubscribed from ${esc(scopeLabel(row.scope))}.</p>`
          + '<p>Nothing further is needed. If mail keeps arriving, reply to it and a person will look.</p>',
        done: true,
      }));
    }

    /* The action carries the CANONICAL token from the row, not the string in
       the URL bar. lib/notify/optoken.js accepts hyphens and lowercase when it
       reads one, because a token copied out of a plain-text email sometimes
       arrives with a line break in it, but lib/csrf.js exempts only the strict
       shape. Echoing back what was typed would therefore render a page whose
       own button is refused. */
    return res.status(200).send(page({
      title: 'Unsubscribe',
      body: `<p>This stops ${esc(scopeLabel(row.scope))}. It takes effect immediately.</p>`,
      action: `/u/${encodeURIComponent(row.token)}`,
      buttonLabel: 'Unsubscribe',
    }));
  }));

  /**
   * Apply it. Reached from the page's own form and from the one-click header,
   * and the two are answered differently: a browser gets the page back, a mail
   * client gets a bare 200 it will never render.
   *
   * Idempotent. A client retrying a one-click POST is normal, and the second
   * press must not be an error.
   */
  router.post('/u/:token', wrap(async (req, res) => {
    await ratelimit.withinLimit(req.catalyst, req, {
      key: 'unsub.apply', max: 60, windowSec: 3600,
    });

    const row = await unsub.resolve(req.catalyst, req.params.token);
    const oneClick = String(req.headers['list-unsubscribe'] || '').length > 0
      || String((req.body && req.body['List-Unsubscribe']) || '') === 'One-Click'
      || !String(req.headers.accept || '').includes('text/html');

    if (!row) {
      if (oneClick) return res.status(200).type('text/plain').send('ok');
      res.set('Cache-Control', 'no-store');
      return res.status(404).type('html').send(page({
        title: 'That link has expired',
        body: '<p>We could not read that unsubscribe link.</p>',
      }));
    }

    const applied = await unsub.apply(req.catalyst, row, {
      source: oneClick ? 'one_click' : 'page',
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'notify.unsubscribe',
      outcome: applied.ok ? 'success' : 'failure',
      userId: row.recipient_id,
      detail: { scope: row.scope, source: oneClick ? 'one_click' : 'page' },
    });

    if (oneClick) return res.status(200).type('text/plain').send('ok');

    res.set('Cache-Control', 'no-store');
    return res.status(200).type('html').send(page({
      title: 'Unsubscribed',
      body: `<p class="ok">Done. You are unsubscribed from ${esc(scopeLabel(row.scope))}.</p>`
        + '<p>It takes effect now, not in a few days.</p>',
      done: true,
    }));
  }));

  /* ---------------------------------------------------------------- *
   * The delivery webhook
   * ---------------------------------------------------------------- */

  /**
   * ZeptoMail's delivery reports.
   *
   * MATCH ON client_reference FIRST. That is the outbox row key, a value this
   * system chose, so a report can always be tied back to the row that asked
   * for the send. The provider's own message id is the fallback for reports
   * that lost the reference.
   *
   * IDEMPOTENT AND FAST. A repeated event is a no-op and the answer is 200
   * either way: a webhook receiver that 500s teaches the provider to retry
   * forever, and one that is slow gets timed out and retried anyway.
   *
   * OPENS ARE NOT RECORDED. There is no tracking pixel on member mail, by
   * decision: under Law 25 a pixel needs a stated purpose, open rates are
   * unreliable behind privacy proxies, and nothing in this system makes a
   * decision from one. An `open` event that arrives anyway is dropped rather
   * than stored.
   */
  router.post('/hooks/zeptomail', wrap(async (req, res) => {
    /* No secret configured means no webhook. An unauthenticated endpoint that
       writes suppressions is a way for anyone to silence anyone. */
    const secret = cfg.MAIL_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ ok: false });

    const offered = String(req.headers['x-whollar-hook'] || req.query.key || '');
    if (!timingSafeEqual(offered, secret)) return res.status(401).json({ ok: false });

    const events = normalizeEvents(req.body);
    let handled = 0;

    for (const ev of events) {
      try {
        await handleEvent(req, ev);
        handled += 1;
      } catch (err) {
        console.error(JSON.stringify({
          req_id: req.id, level: 'error', message: 'webhook event failed',
          detail: String((err && err.message) || err).slice(0, 200),
        }));
      }
    }
    res.status(200).json({ ok: true, handled });
  }));

  /* ---------------------------------------------------------------- *
   * The member's own record
   * ---------------------------------------------------------------- */

  /**
   * What we have sent this person, and what happened to it.
   *
   * Metadata only: subject, when, and the delivery state. The body is not
   * stored, so this cannot show it. That is a Phase A limit, recorded here
   * rather than hidden: full snapshots need a blob store and one is not wired.
   */
  router.get('/me/notifications', wrap(async (req, res) => {
    const user = requireUser(req);
    let rows = [];
    try {
      rows = await datastore.queryAll(req.catalyst, outbox.TABLE,
        ['notify_key', 'template_key', 'subject', 'status', 'category',
          'sent_at', 'created_at'],
        `recipient_id = ${datastore.lit(user.user_id)}`);
    } catch {
      /* Table absent: an empty history is the honest answer, not a 500. */
    }
    const items = (rows || [])
      .filter((r) => r.status === 'sent')
      .sort((a, b) => String(b.sent_at || b.created_at || '')
        .localeCompare(String(a.sent_at || a.created_at || '')))
      .slice(0, 50)
      .map((r) => ({
        subject: r.subject,
        category: r.category,
        sent_at: r.sent_at,
        status: r.status,
      }));
    res.status(200).json({ ok: true, notifications: items });
  }));

  /* ---------------------------------------------------------------- *
   * The operator's view
   *
   * Mounted unconditionally, and each route calls requireAdmin itself. That
   * is the same shape /health/diagnostics uses in app.js and for the same
   * reason: the environment gate is not the only thing that should stand
   * between the outbox and the public internet.
   * ---------------------------------------------------------------- */

  /**
   * Send what is due, now.
   *
   * There is no cron in this stack, so the drain rides on the same read paths
   * lib/notices.js sweeps from: the first dashboard load after a stage flips
   * is what sends the mail. This is the other half, for the case where nobody
   * is browsing, which is mostly an operator testing alone. Point Catalyst Job
   * Scheduling at it on a one-minute timer and the reminder lane works without
   * anything else changing.
   */
  router.post('/admin/notify/drain', wrap(async (req, res) => {
    requireAdmin(req);
    const result = await outbox.drain(req.catalyst, cfg, { now: Date.now() });
    res.status(200).json({ ok: true, ...result });
  }));

  /**
   * ONE TIMER TARGET. Sweep for reminders, then send what is due.
   *
   * Point Catalyst Job Scheduling at this and the whole notification layer
   * runs on a clock. Two separate jobs would be two things to create, two to
   * forget, and this project has a standing example of exactly that: crmSync
   * was written to be cron-invoked and the job was never created, which read
   * as a broken pipeline for weeks. One target is harder to half-configure.
   *
   * Order matters and is not interchangeable. Sweeping first means a reminder
   * that becomes due this minute goes out this minute rather than waiting a
   * full interval for the next drain. Draining first would add one interval of
   * latency to every reminder, which on a two-hour bid-close warning is a
   * meaningful slice of the warning.
   *
   * Hourly is the interval to set. The sweep window is ninety minutes wide, so
   * an hourly timer cannot step over an offset, and every offset here is
   * measured in hours rather than minutes.
   *
   * AUTHENTICATED TWO WAYS, because a timer has no session. An admin session
   * works, so an operator can force a pass by hand. A shared secret in
   * `X-Cron-Secret` works, which is what Job Scheduling can actually send.
   * Same shape crmSync already uses, minus its query-string fallback: a secret
   * in a URL lands in access logs and in the scheduler's own run history, and
   * there is no legacy job here that needs the concession.
   */
  /**
   * A welcome to an address that just held a spot in the waitlist popup.
   *
   * WHY THIS ROUTE EXISTS AT ALL. The popup posts to the formSubmit function,
   * which owns the marketing tables and the share code. But everything that
   * decides whether we are ALLOWED to write to an address lives here and only
   * here: the CASL category table, the suppression list, the unsubscribe token
   * that must be in a commercial footer, the postal address that must be there
   * with it, the notify_key that stops a double submit sending twice, and a
   * transport with an SMTP fallback that works while ZeptoMail is refusing.
   * Rebuilding any of that in formSubmit would be a second copy of the rules
   * that govern whether a message is lawful, kept in step by nothing.
   *
   * So formSubmit carries the ask across in one call and this does the work.
   *
   * AUTHENTICATED BY THE SHARED SECRET, never by a session, because the caller
   * is a server. Same header and same constant time comparison as the tick,
   * and lib/csrf.js grants the same conditional exemption on the same
   * reasoning: a custom header cannot be set from a browser here.
   *
   * IT DRAINS BEFORE IT ANSWERS. There is still no cron in this stack, so a
   * row left in the outbox waits for the next dashboard load by anybody, which
   * for a confirmation somebody is watching for is not a schedule. The drain
   * is capped and best effort; the enqueue is what matters and it has already
   * happened by then.
   */
  router.post('/internal/waitlist-welcome', wrap(async (req, res) => {
    requireTickCaller(req, cfg);

    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!email || email.indexOf('@') < 1) throw badRequest('A valid email is required.');

    /* The label the copy says out loud. A closed list, because an unrecognised
       product reaching a subject line is how a letter goes out naming
       something we do not sell. */
    const LABELS = { tires: 'winter tires', internet: 'home internet', home: 'what you are waiting for' };
    const product = String(b.product || '').toLowerCase();

    const shareUrl = String(b.shareUrl || '').trim();
    const context = {
      product_label: LABELS[product] || LABELS.home,
      join_url: 'https://www.whollar.ca/join',
    };
    /* Only when there is one. The template drops the sharing half rather than
       rendering an empty link, which is why share_url is not in `required`. */
    if (shareUrl) {
      context.share_url = shareUrl;
      context.share_code = String(b.shareCode || '').trim() || null;
    }

    const result = await outbox.enqueue(req.catalyst, cfg, {
      templateKey: 'waitlist.welcome',
      /* Keyed on the address and nothing else, so the same person holding a
         spot twice, or on two hosts, is one letter. The notify_key is built
         from this with the template and the recipient, and the store's Unique
         on it is what actually enforces the promise. */
      eventKey: `waitlist.welcome:${email}`,
      recipient: { type: 'address', id: email, email },
      context,
    });

    /* Never sends inline. `informational` waits for the drain by design, so
       trigger one rather than leaving a confirmation somebody is watching for
       to wait on a page load by a stranger. */
    const drained = await outbox.drain(req.catalyst, cfg, { now: Date.now() })
      .catch((err) => { console.error('[notify] waitlist welcome drain failed:', err); return null; });

    res.status(200).json({ ok: true, status: result && result.status, drain: drained });
  }));

  router.post('/admin/notify/tick', wrap(async (req, res) => {
    requireTickCaller(req, cfg);
    const now = Date.now();
    const swept = await reminders.sweep(req.catalyst, cfg, null, now);
    const drained = await outbox.drain(req.catalyst, cfg, { now });
    res.status(200).json({ ok: true, reminders: swept, drain: drained });
  }));

  /**
   * The outbox, newest first, filtered by status.
   *
   * `failed` is the one worth watching: it carries `missing:<key>` for a
   * context that could not render and `scrubbed:<rule>` for a message the
   * privacy scrubber refused, and those two mean very different things.
   */
  router.get('/admin/notify/outbox', wrap(async (req, res) => {
    requireAdmin(req);
    const status = String(req.query.status || '').trim();
    const where = status ? `status = ${datastore.lit(status)}` : 'ROWID > 0';
    let rows = [];
    try {
      rows = await datastore.queryAll(req.catalyst, outbox.TABLE,
        ['notify_key', 'event_key', 'template_key', 'recipient_type', 'campaign_id',
          'send_priority', 'casl_class', 'status', 'attempts', 'last_error',
          'subject', 'earliest_send_at', 'created_at', 'sent_at'],
        where);
    } catch (err) {
      return res.status(200).json({
        ok: true, available: false,
        note: 'notification_outbox is not readable: see create-tables.md section 33',
        detail: String((err && err.message) || err).slice(0, 200),
        rows: [],
      });
    }
    /* No recipient address and no context: an operator listing is not a place
       to hand back everybody's email address, and the row key is enough to
       pull one message when there is a reason to. */
    const out = rows
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300));
    res.status(200).json({ ok: true, available: true, count: out.length, rows: out });
  }));

  /** One message: its row, and every delivery event against it. */
  router.get('/admin/notify/outbox/:key', wrap(async (req, res) => {
    requireAdmin(req);
    const key = String(req.params.key || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);
    if (!key) throw badRequest('That is not a notification key.');
    const row = await outbox.find(req.catalyst, key);
    if (!row) throw new AppError('NOT_FOUND', 'No such notification.');
    res.status(200).json({
      ok: true,
      row,
      deliveries: await outbox.deliveriesFor(req.catalyst, key),
    });
  }));

  /** The suppression list. */
  router.get('/admin/notify/suppressions', wrap(async (req, res) => {
    requireAdmin(req);
    try {
      res.status(200).json({ ok: true, available: true,
        rows: await suppress.list(req.catalyst, { limit: 300 }) });
    } catch (err) {
      res.status(200).json({
        ok: true, available: false,
        note: 'email_suppressions is not readable: see create-tables.md section 33',
        detail: String((err && err.message) || err).slice(0, 200),
        rows: [],
      });
    }
  }));

  /**
   * Lift a suppression.
   *
   * The one write here that can do harm: re-enabling an address that
   * complained sends mail to somebody who pressed the spam button, and the
   * cost of that lands on every other member's deliverability. So it takes a
   * reason, it is audited with the reason, and it refuses to guess.
   */
  router.post('/admin/notify/suppressions/lift', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const email = suppress.norm((req.body || {}).email);
    const reason = String((req.body || {}).reason || '').trim();
    if (!email) throw badRequest('Which address?');
    if (reason.length < 3 || reason.length > 255) {
      throw badRequest('Lifting a suppression needs a reason (3 to 255 characters). The audit row carries it.');
    }
    const before = await suppress.lookup(req.catalyst, email);
    const lifted = await suppress.remove(req.catalyst, email);

    await audit.record(req.catalyst, req, {
      type: 'notify.suppression.lift',
      outcome: lifted ? 'success' : 'failure',
      userId: admin.user_id,
      email: admin.email_normalized,
      detail: { lifted, was: before.listed ? before.reason : null, reason },
    });
    res.status(200).json({ ok: true, lifted });
  }));

  return router;
}

/* ------------------------------------------------------------------ *
 * Callers
 * ------------------------------------------------------------------ */

/**
 * Who may run a tick: an admin, or something holding the cron secret.
 *
 * With no secret configured the route is admin-only, which is the safe
 * default and is exactly the state before a timer exists. It is never open:
 * a tick sends real email, and an unauthenticated endpoint that sends email is
 * an endpoint somebody will use to send email.
 */
function requireTickCaller(req, cfg) {
  const secret = cfg.NOTIFY_CRON_SECRET;
  const offered = String(req.headers['x-cron-secret'] || '');
  if (secret && offered && timingSafeEqual(offered, secret)) return { cron: true };
  return { admin: requireAdmin(req) };
}

/* ------------------------------------------------------------------ *
 * Webhook helpers
 * ------------------------------------------------------------------ */

/** Constant time, and length-safe: a bare === leaks the length by timing. */
function timingSafeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return require('node:crypto').timingSafeEqual(A, B);
}

/**
 * ZeptoMail posts a single event or a batch, and the shape has moved between
 * versions. Read all the shapes rather than pinning one: a webhook that stops
 * parsing after a provider release is a suppression list that stops growing,
 * and nothing about that is visible until a domain is already in trouble.
 */
function normalizeEvents(body) {
  if (!body) return [];
  const raw = Array.isArray(body) ? body
    : Array.isArray(body.events) ? body.events
      : Array.isArray(body.data) ? body.data
        : [body];

  return raw.map((e) => {
    const d = (e && e.event_message) || e || {};
    const details = Array.isArray(d.details) ? d.details[0] : d;
    return {
      type: String(e.event_name || d.event_name || e.type || '').toLowerCase(),
      clientReference: d.client_reference || details.client_reference || null,
      messageId: details.message_id || d.message_id || null,
      email: (details.email_info && details.email_info.to
        && details.email_info.to[0] && details.email_info.to[0].email_address
        && details.email_info.to[0].email_address.address)
        || details.email || null,
      reason: details.reason || details.details || d.reason || null,
      code: details.bounce_code || details.code || null,
    };
  });
}

/** Which of our states a provider event name means. */
function statusFor(type, code) {
  if (type.includes('bounce')) {
    const c = String(code || '');
    /* 5xx is permanent, 4xx is temporary. Unknown is treated as soft: a
       wrongly hard-suppressed address is a person who cannot sign in. */
    return /^5/.test(c) || /hard/.test(type) ? 'bounced_hard' : 'bounced_soft';
  }
  if (type.includes('complain') || type.includes('spam')) return 'complained';
  if (type.includes('deliver')) return 'delivered';
  if (type.includes('click')) return 'clicked';
  if (type.includes('open')) return 'opened';
  if (type.includes('soft')) return 'bounced_soft';
  return 'unknown';
}

async function handleEvent(req, ev) {
  const status = statusFor(ev.type, ev.code);

  /* Opens are not stored. See the route comment. */
  if (status === 'opened') return;

  const key = ev.clientReference || null;
  if (key) {
    await outbox.recordDelivery(req.catalyst, { notify_key: key }, {
      provider_message_id: ev.messageId,
      transport: 'zeptomail',
      status,
      detail: ev.reason,
    });
  }

  if (status === 'bounced_hard' || status === 'complained') {
    const email = ev.email;
    if (!email) return;
    await suppress.add(req.catalyst, {
      email,
      reason: status === 'complained' ? 'complaint' : 'hard_bounce',
      source: `webhook:${ev.type}`.slice(0, 120),
    });
    /* An operator alert, not a log line. A member whose address hard bounces
       cannot receive a sign-in code, which means they cannot sign in, which
       means they need a person rather than a retry. */
    console.error(JSON.stringify({
      req_id: req.id,
      level: 'error',
      alert: status === 'complained' ? 'mail_complaint' : 'mail_hard_bounce',
      message: 'an address has been suppressed',
      reason: String(ev.reason || '').slice(0, 120),
    }));
  }
}

module.exports = { mount, normalizeEvents, statusFor, page, requireTickCaller };
