'use strict';

/**
 * The outbox: one row per (event, template, recipient), and the only thing
 * that talks to the mailer.
 *
 * WHY ANYTHING AT ALL, when nine call sites already send email perfectly well.
 * Because none of them can answer a question the business now has to answer.
 * Was this sent. Was it delivered. Did it bounce. Did this person opt out
 * before or after it went. Send it again. Do not send it twice. Hold it until
 * seven in the morning. Do not send it at all, because that address complained
 * a fortnight ago. Every one of those is a property of a record, and until
 * this module there was no record: there was a function call and an audit line
 * saying `delivered: true`.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN.
 *
 *   enqueue   decide, once, whether this may be sent at all, and write it down
 *   drain     decide, again and freshly, whether it should still be sent now
 *   send      hand it to the transport with a reference that comes back
 *   record    a delivery row per attempt, and a webhook that closes the loop
 *
 * The double decision is not redundancy. Enqueue asks "is this person allowed
 * to receive this", which is a consent question and settles at enqueue time.
 * Drain asks "is this still true", which is a world question and can only be
 * asked at send time. A cohort that was at `bidding` when the row was written
 * and is at `offers` when the drain reaches it must not send the bidding
 * letter, and no amount of care at enqueue time can know that.
 *
 * SECURITY MAIL DOES NOT WAIT. A sign-in code queued for a scheduler is a
 * member standing at a login form watching nothing happen. `security`
 * priority drains inline, in the request that created it, and the row exists
 * so that the send is still recorded, deduplicated and suppressible. The
 * outbox is the ledger for that mail, not a delay on it.
 *
 * CLAIM BEFORE SEND. Same rule lib/notices.js established and for the same
 * reason: the row is moved to `sending` and the move is verified before the
 * transport is touched. Crash after claiming and one letter is missed; crash
 * after sending and the letter goes twice on the next pass. For mail, missing
 * beats duplicating.
 *
 * NO CRON IN THIS STACK. The drain is called from the same read paths
 * lib/notices.js sweeps from, and from an operator route. Job Scheduling can
 * call the operator route on a timer once one exists; nothing here assumes it
 * does, and nothing breaks when it does not.
 */

const crypto = require('node:crypto');
const datastore = require('../datastore');
const mailer = require('../mailer');
const registry = require('./registry');
const layout = require('./layout');
const suppress = require('./suppress');
const unsub = require('./unsub');
const scrub = require('./scrub');

const TABLE = 'notification_outbox';
const DELIVERIES = 'notification_deliveries';

const COLUMNS = Object.freeze(['notify_key', 'event_key', 'template_key',
  'recipient_type', 'recipient_id', 'recipient_email', 'locale', 'timezone',
  'campaign_id', 'context', 'send_priority', 'casl_class', 'category',
  'collapse_group', 'earliest_send_at', 'status', 'attempts', 'last_error',
  'subject', 'body_sha', 'created_at', 'updated_at', 'sent_at']);

const DELIVERY_COLUMNS = Object.freeze(['outbox_key', 'provider_message_id',
  'client_reference', 'transport', 'status', 'status_at', 'detail', 'created_at']);

const STATUS = Object.freeze(['queued', 'held', 'superseded', 'sending', 'sent',
  'failed', 'suppressed', 'cancelled']);

/** How many rows one drain pass takes. A cohort larger than this finishes on the next. */
const BATCH = 60;

/** Attempts before a row is left alone for a person to look at. */
const MAX_ATTEMPTS = 5;

/** The collapse window from H6: ten minutes, per recipient, per group. */
const COLLAPSE_MS = 10 * 60 * 1000;

/**
 * How long a claim may sit in `sending` before it is presumed dead.
 *
 * Generous next to any real send, which is one HTTP call, and deliberately so:
 * treating a live claim as dead is how one letter goes out twice, and the
 * whole claim-before-send ordering exists to prefer a missed letter to a
 * duplicate. Fifteen minutes is longer than a function invocation can live.
 */
const STALE_CLAIM_MS = 15 * 60 * 1000;

const QUIET_FROM = 22;  // 22:00 recipient local
const QUIET_TO = 7;     // 07:00 recipient local

const MAX_CONTEXT = 6000;

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

/**
 * The idempotency key. Unique in the table, so a duplicate insert is a no-op
 * by design rather than by a check that can race.
 *
 * `scheduled_slot` is empty for an event-driven send and the reminder offset
 * label for a scheduled one, so "the T-24h reminder for this campaign" is a
 * different row from "the T-2h reminder for this campaign" while a second
 * sweep of either is the same row.
 */
function idempotencyKey({ eventKey, templateKey, recipientType, recipientId, slot = '' }) {
  return crypto.createHash('sha256')
    .update(`${eventKey}:${templateKey}:${recipientType}:${recipientId}:${slot}`)
    .digest('hex');
}

/**
 * A stable Message-ID from the row key, so a resend is a visible duplicate in
 * the reader's client rather than a silent second copy of the same letter.
 */
const messageIdFor = (notifyKey, host) => `<${notifyKey}@${host || 'whollar.com'}>`;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

/* ------------------------------------------------------------------ *
 * Quiet hours
 * ------------------------------------------------------------------ */

/** The hour of the day at `at` in `tz`, or null if the zone is unusable. */
function localHour(at, tz) {
  try {
    const s = new Intl.DateTimeFormat('en-CA',
      { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date(at));
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? (h === 24 ? 0 : h) : null;
  } catch {
    return null;
  }
}

/**
 * When this row may earliest go out.
 *
 * Quiet hours hold informational and reminder mail between 22:00 and 07:00 in
 * the recipient's own zone. They never hold action-required or security mail:
 * an offer deadline at midnight is a thing a household needs to know about at
 * midnight.
 *
 * Partner contacts are exempt entirely. These are business inboxes, and a bid
 * window that closes at eight in the morning needs its reminder at six.
 *
 * An unusable timezone falls through to sending now rather than holding
 * indefinitely: a message nobody can explain the delay of is worse than one
 * that arrived at an odd hour.
 */
function earliestSend(now, { priority, recipientType, timezone }) {
  if (priority === 'security' || priority === 'action_required') return now;
  if (recipientType === 'partner' || recipientType === 'admin') return now;

  const tz = timezone || 'America/Toronto';
  const h = localHour(now, tz);
  if (h === null) return now;
  if (h < QUIET_TO || h >= QUIET_FROM) {
    /* Walk forward an hour at a time to the first hour that is not quiet.
       Arithmetic on the offset would be wrong twice a year; asking the
       formatter is not. */
    for (let i = 1; i <= 12; i++) {
      const t = now + i * 3600 * 1000;
      const hh = localHour(t, tz);
      if (hh !== null && hh >= QUIET_TO && hh < QUIET_FROM) {
        /* Land on the hour rather than at a ragged minute, so a cohort's
           letters arrive together instead of trickling. */
        return t - (new Date(t).getUTCMinutes() * 60 + new Date(t).getUTCSeconds()) * 1000;
      }
    }
    return now;
  }
  return now;
}

/* ------------------------------------------------------------------ *
 * Enqueue
 * ------------------------------------------------------------------ */

/**
 * Write one row, having decided it may be written.
 *
 *   -> { status, notifyKey, row? , why? }
 *
 * Never sends. Never throws for a business reason: a suppressed recipient, a
 * declined category and a missing context key are all recorded outcomes, not
 * errors, because the caller is a route serving a person who did something
 * else entirely and must not fail because a letter could not go.
 */
async function enqueue(catalystApp, cfg, {
  templateKey, eventKey, slot = '',
  recipient,           // { type, id, email, locale, timezone, orgId }
  context = {},
  campaignId = null,
  now = Date.now(),
}) {
  const entry = registry.get(templateKey);
  if (!entry) throw new Error(`notify: unknown template ${templateKey}`);
  if (!recipient || !recipient.type || !recipient.id) {
    throw new Error(`notify: ${templateKey} needs a recipient type and id`);
  }

  const email = suppress.norm(recipient.email);
  const notifyKey = idempotencyKey({
    eventKey: eventKey || templateKey,
    templateKey,
    recipientType: recipient.type,
    recipientId: recipient.id,
    slot,
  });

  const base = {
    notify_key: notifyKey,
    event_key: String(eventKey || templateKey).slice(0, 190),
    template_key: templateKey,
    recipient_type: recipient.type,
    recipient_id: String(recipient.id).slice(0, 64),
    recipient_email: email,
    locale: recipient.locale || 'en',
    timezone: recipient.timezone || 'America/Toronto',
    campaign_id: campaignId,
    /* `send_priority`, not `priority`: the latter is reserved in ZCQL and the
       console will not create a column by that name. The registry entry still
       calls it `priority`. */
    send_priority: entry.priority,
    casl_class: entry.casl,
    category: entry.category,
    collapse_group: entry.collapse ? `${entry.collapse}:${campaignId || 'none'}` : null,
    attempts: 0,
    /* From the injected clock, not `nowDb()`.
     *
     * The drain compares `now` against these, and `markSuperseded` compares
     * two of them against each other. A row stamped from the wall clock and
     * then judged against an injected one is a scheduler that behaves
     * differently in a test than in production, which is the same as having
     * no test. Every timestamp this module writes comes from the same clock
     * the caller passed in. */
    created_at: datastore.toDb(new Date(now)),
    updated_at: datastore.toDb(new Date(now)),
  };

  /* No address, nothing to decide. Recorded rather than dropped, because
     "why did this household not get the letter" is a question somebody asks. */
  if (!email) {
    return write(catalystApp, { ...base, status: 'suppressed', last_error: 'no_address',
      context: '{}', earliest_send_at: datastore.toDb(new Date(now)) });
  }

  /* Required context, checked before anything is written: a row that can
     never render is a row nobody wants in the table. */
  const gaps = registry.missing(entry, context);
  if (gaps.length) {
    return write(catalystApp, { ...base, status: 'failed',
      last_error: `missing:${gaps.join(',')}`.slice(0, 190),
      context: json(context), earliest_send_at: datastore.toDb(new Date(now)) });
  }

  /* Consent, in two parts. The address may be blocked outright, and the
     person may have declined this category. Both are settled here because
     both are true or false at the moment the event happened. */
  const allowed = await suppress.allows(catalystApp, email, entry.casl);
  if (!allowed.allowed) {
    return write(catalystApp, { ...base, status: 'suppressed', last_error: allowed.why,
      context: json(context), earliest_send_at: datastore.toDb(new Date(now)) });
  }
  const wanted = await unsub.wants(catalystApp,
    { recipientType: recipient.type, recipientId: recipient.id }, entry.category);
  if (!wanted) {
    return write(catalystApp, { ...base, status: 'suppressed', last_error: 'category_declined',
      context: json(context), earliest_send_at: datastore.toDb(new Date(now)) });
  }

  /* A commercial message with no postal address configured is refused rather
     than sent without one. An invented address in a compliance footer is
     worse than a missing send, and the operator alert names the missing key. */
  if (entry.casl === 'cem' && !cfg.MAIL_POSTAL_ADDRESS) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'commercial send refused: MAIL_POSTAL_ADDRESS is not configured',
      template: templateKey,
    }));
    return write(catalystApp, { ...base, status: 'failed', last_error: 'no_postal_address',
      context: json(context), earliest_send_at: datastore.toDb(new Date(now)) });
  }

  const at = earliestSend(now, {
    priority: entry.priority,
    recipientType: recipient.type,
    timezone: base.timezone,
  });

  return write(catalystApp, {
    ...base,
    context: json(context),
    status: at > now ? 'held' : 'queued',
    earliest_send_at: datastore.toDb(new Date(at)),
  });
}

function json(ctx) {
  const s = JSON.stringify(ctx || {});
  /* A context that will not fit is a bug in the caller, not a reason to
     truncate silently into an unparseable string. */
  if (s.length > MAX_CONTEXT) throw new Error(`notify: context too large (${s.length} chars)`);
  return s;
}

/**
 * Insert, and treat a unique-key collision as the success it is: the row is
 * already there, this event has already been queued, and nothing more is
 * owed. That is the whole of the deduplication.
 */
async function write(catalystApp, row) {
  try {
    await datastore.insertRow(catalystApp, TABLE, row);
    return { status: row.status, notifyKey: row.notify_key, created: true, row };
  } catch (err) {
    const existing = await find(catalystApp, row.notify_key).catch(() => null);
    if (existing) return { status: existing.status, notifyKey: row.notify_key, created: false, row: existing };
    throw err;
  }
}

const find = (catalystApp, notifyKey) =>
  datastore.findBy(catalystApp, TABLE, 'notify_key', notifyKey, ['ROWID'].concat(COLUMNS));

/* ------------------------------------------------------------------ *
 * Drain
 * ------------------------------------------------------------------ */

/**
 * Send what is due.
 *
 *   -> { picked, sent, failed, superseded, cancelled }
 *
 * ORDERING. A recipient's letters about one campaign must not arrive out of
 * order: a "bidding is open" after an "offer is in" is worse than no letter.
 * Rows are taken oldest first, and a row is skipped while an older row for
 * the same recipient and campaign is still not terminal. Superseding handles
 * the common case before ordering ever has to; ordering is the backstop for
 * the templates that do not supersede.
 */
async function drain(catalystApp, cfg, { now = Date.now(), limit = BATCH } = {}) {
  const out = { picked: 0, sent: 0, failed: 0, superseded: 0, cancelled: 0 };

  /* Two reads with one `=` predicate each, rather than one with an IN list.
     ZCQL takes the IN, but nothing else in this codebase emits one and the
     fake store the test suites run against parses the shape every other query
     here uses. A query form that only production can execute is a query form
     no test covers. */
  let rows = [];
  try {
    for (const status of ['queued', 'held']) {
      /* eslint-disable-next-line no-await-in-loop */
      const page = await datastore.queryAll(catalystApp, TABLE, ['ROWID'].concat(COLUMNS),
        `status = ${datastore.lit(status)}`);
      rows = rows.concat(page || []);
    }
  } catch {
    return out;   // table absent: do nothing, quietly, exactly like notices
  }
  if (!rows.length) return out;

  const due = rows
    .filter((r) => {
      const at = datastore.fromDb(r.earliest_send_at);
      return !at || at.getTime() <= now;
    })
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));

  /* Supersede first, over the whole due set, because the row that wins is the
     newest in its group and picking that needs every member of the group. */
  const superseded = markSuperseded(due);
  for (const r of superseded) {
    out.superseded += 1;
    await setStatus(catalystApp, r, 'superseded', 'newer_in_group', now).catch(() => {});
  }
  const live = due.filter((r) => !superseded.includes(r));

  /* Lanes already occupied by a row another drain is mid-send on.
   *
   * Without this, a letter still in flight is invisible to the ordering rule,
   * because the drain reads only `queued` and `held`, and the next stage's
   * letter can overtake it. That is the exact failure ordering exists to stop:
   * "bidding is open" arriving after "your offer is in".
   *
   * A `sending` row older than STALE_CLAIM_MS is treated as dead rather than
   * as in flight. A drain that crashed between the claim and the send leaves
   * one behind, and a lane blocked forever by a row nobody is working on is a
   * household that never hears from us again. */
  const blocked = new Set();
  try {
    const inFlight = await datastore.queryAll(catalystApp, TABLE,
      ['recipient_id', 'campaign_id', 'updated_at', 'notify_key'], "status = 'sending'");
    for (const r of inFlight || []) {
      const age = now - ms(r.updated_at);
      if (age > STALE_CLAIM_MS) {
        console.error(JSON.stringify({
          level: 'error',
          message: 'stale claim: a drain left a row in sending',
          notify_key: r.notify_key,
          age_minutes: Math.round(age / 60000),
        }));
        continue;
      }
      blocked.add(`${r.recipient_id}:${r.campaign_id || ''}`);
    }
  } catch {
    /* Unreadable: fall through with no lanes blocked. Ordering degrades to
       best effort rather than the drain stopping. */
  }

  for (const r of live) {
    if (out.picked >= limit) break;

    const lane = `${r.recipient_id}:${r.campaign_id || ''}`;
    if (blocked.has(lane)) continue;   // an older letter in this lane is not done

    out.picked += 1;
    const result = await sendRow(catalystApp, cfg, r, now);
    if (result.ok) out.sent += 1;
    else if (result.cancelled) out.cancelled += 1;
    else { out.failed += 1; blocked.add(lane); }
  }
  return out;
}

/**
 * Within each collapse group, for each recipient, the newest row wins and
 * every older one is superseded.
 *
 * A digest would be the other answer, and it is the wrong one for a stage
 * letter: "bidding has opened, and also your offer is in" reads as a system
 * talking to itself. The templates that want a digest declare
 * collapseMode 'digest' and are left alone here until one exists.
 */
function markSuperseded(rows) {
  const newest = new Map();
  const out = [];
  for (const r of rows) {
    if (!r.collapse_group) continue;
    const entry = registry.get(r.template_key);
    if (!entry || entry.collapseMode !== 'supersede') continue;
    const k = `${r.recipient_id}:${r.collapse_group}`;
    const prev = newest.get(k);
    if (!prev) { newest.set(k, r); continue; }
    const older = String(prev.created_at || '') <= String(r.created_at || '') ? prev : r;
    const keep = older === prev ? r : prev;
    /* Only collapse rows created close together. Two stage letters a week
       apart are two things that happened, not a burst. */
    const gap = Math.abs(ms(keep.created_at) - ms(older.created_at));
    if (gap > COLLAPSE_MS) { newest.set(k, keep); continue; }
    out.push(older);
    newest.set(k, keep);
  }
  return out;
}

const ms = (v) => {
  const d = datastore.fromDb(v);
  return d ? d.getTime() : 0;
};

/**
 * One row, all the way out.
 *
 * Claims by moving to `sending` and verifying the move, so two overlapping
 * drains cannot both send the same letter. Then re-validates, renders, runs
 * the scrubber over both the context and the finished body, and sends.
 */
async function sendRow(catalystApp, cfg, row, now = Date.now()) {
  const entry = registry.get(row.template_key);
  if (!entry) {
    await setStatus(catalystApp, row, 'failed', `unknown_template:${row.template_key}`, now);
    return { ok: false };
  }

  /* Claim. A failed claim is not an error: somebody else has it. */
  if (!await claim(catalystApp, row, now)) return { ok: false, claimed: false };

  let ctx;
  try {
    ctx = JSON.parse(row.context || '{}');
  } catch {
    await setStatus(catalystApp, row, 'failed', 'context_unparseable', now);
    return { ok: false };
  }

  /* Still true? A reminder whose deadline has passed, a stage letter whose
     cohort has moved on, an offer nudge for a household that decided. Every
     template that can go stale declares this; most cannot and do not. */
  if (typeof entry.stillRelevant === 'function') {
    let ok = true;
    try {
      ok = await entry.stillRelevant(ctx, { catalystApp, cfg, now });
    } catch {
      ok = true;   // an unanswerable question is not a reason to withhold
    }
    if (!ok) {
      await setStatus(catalystApp, row, 'cancelled', 'no_longer_relevant', now);
      return { ok: false, cancelled: true };
    }
  }

  /* Consent again at send time, because the row may have been sitting since
     before somebody unsubscribed. This is the check that makes a held
     overnight message honour a midnight opt-out. */
  const allowed = await suppress.allows(catalystApp, row.recipient_email, entry.casl);
  if (!allowed.allowed) {
    await setStatus(catalystApp, row, 'suppressed', allowed.why, now);
    return { ok: false, cancelled: true };
  }

  let message;
  try {
    message = await build(catalystApp, cfg, entry, row, ctx);
  } catch (err) {
    await setStatus(catalystApp, row, 'failed',
      `render:${String((err && err.message) || err).slice(0, 150)}`, now);
    return { ok: false };
  }
  if (message.blocked) {
    /* A scrubber hit. The send fails and an operator is told, because a
       message that would have disclosed one partner's data to another is not
       a thing to retry quietly. */
    console.error(JSON.stringify({
      level: 'error',
      message: 'notification blocked by the privacy scrubber',
      template: row.template_key,
      notify_key: row.notify_key,
      hits: message.hits.map((h) => `${h.rule}@${h.where}`),
    }));
    await setStatus(catalystApp, row, 'failed', `scrubbed:${message.hits[0].rule}`, now);
    return { ok: false, scrubbed: true };
  }

  try {
    const result = await mailer.send(cfg, message.wire);
    await recordDelivery(catalystApp, row, {
      provider_message_id: (result && result.messageId) || null,
      transport: (result && result.transport) || null,
      status: 'accepted',
      detail: null,
    }, now);
    /* The SMTP fallback carrying a message means ZeptoMail refused it, and
       from the outside that looks like a healthy send. It is an operator
       alert, not a log line. */
    if (result && result.transport === 'smtp' && cfg.FEATURES && cfg.FEATURES.mail) {
      console.error(JSON.stringify({
        level: 'error',
        alert: 'smtp_fallback_engaged',
        message: 'ZeptoMail refused a send and the SMTP fallback carried it',
        template: row.template_key,
      }));
    }
    await datastore.updateRow(catalystApp, TABLE, {
      ROWID: row.ROWID,
      status: 'sent',
      subject: String(message.subject).slice(0, 190),
      body_sha: message.bodySha,
      sent_at: datastore.toDb(new Date(now)),
      updated_at: datastore.toDb(new Date(now)),
      last_error: null,
    });
    return { ok: true };
  } catch (err) {
    const attempts = (Number(row.attempts) || 0) + 1;
    const retryable = err && err.retryable !== false && attempts < MAX_ATTEMPTS;
    await recordDelivery(catalystApp, row, {
      provider_message_id: null,
      transport: null,
      status: 'failed',
      detail: String((err && err.message) || err).slice(0, 300),
    }, now);
    await datastore.updateRow(catalystApp, TABLE, {
      ROWID: row.ROWID,
      status: retryable ? 'queued' : 'failed',
      attempts,
      last_error: String((err && err.message) || err).slice(0, 190),
      earliest_send_at: datastore.toDb(new Date(now + backoffMs(attempts))),
      updated_at: datastore.toDb(new Date(now)),
    });
    return { ok: false };
  }
}

/** 1m, 5m, 30m, 2h, 12h. Past that the row is left for a person. */
function backoffMs(attempts) {
  const ladder = [60e3, 300e3, 1800e3, 7200e3, 43200e3];
  return ladder[Math.min(attempts, ladder.length) - 1] || 43200e3;
}

/**
 * Take the row. The write is ROWID-keyed, which is the only reliable write
 * here, and it is read back: a write that reports success and did not happen
 * is the failure mode this whole file would be built on top of otherwise.
 */
async function claim(catalystApp, row, now = Date.now()) {
  try {
    await datastore.updateRow(catalystApp, TABLE, {
      ROWID: row.ROWID, status: 'sending', updated_at: datastore.toDb(new Date(now)),
    });
    const back = await datastore.findBy(catalystApp, TABLE, 'notify_key',
      row.notify_key, ['ROWID', 'status']);
    return Boolean(back && back.status === 'sending');
  } catch {
    return false;
  }
}

async function setStatus(catalystApp, row, status, why, now = Date.now()) {
  if (!STATUS.includes(status)) throw new Error(`notify: bad status ${status}`);
  try {
    await datastore.updateRow(catalystApp, TABLE, {
      ROWID: row.ROWID,
      status,
      last_error: why ? String(why).slice(0, 190) : null,
      updated_at: datastore.toDb(new Date(now)),
    });
  } catch {
    /* Nothing further to try. The next drain sees the row again, and the
       claim is what keeps that from double sending. */
  }
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

/**
 * Context to wire message: render, footer, scrub, headers.
 *
 * Returns `{ blocked: true, hits }` rather than throwing on a scrubber hit,
 * because a hit is a decision the caller records differently from a crash.
 */
async function build(catalystApp, cfg, entry, row, ctx) {
  const audience = entry.audience === 'auto'
    ? (row.recipient_type === 'partner' ? 'partner' : 'member')
    : entry.audience;

  const rendered = registry.render(entry, ctx, {
    locale: row.locale || 'en',
    timezone: row.timezone || 'America/Toronto',
  });

  const base = String(cfg.APP_BASE_URL || 'https://www.whollar.ca').replace(/\/+$/, '');
  const prefsPath = row.recipient_type === 'partner' ? '/partner#account' : '/dashboard#settings';

  let unsubscribeUrl = null;
  if (entry.casl === 'cem') {
    const token = await unsub.tokenFor(catalystApp, {
      recipientType: row.recipient_type,
      recipientId: row.recipient_id,
      scope: unsub.ALL,
    });
    /* No token, no commercial send. The alternative is a message that claims
       an opt-out exists and links to nothing. */
    if (!token) throw new Error('no_unsubscribe_token');
    unsubscribeUrl = `${base}/u/${token}`;
  }

  const footer = layout.footerBlocks({
    legalName: cfg.MAIL_LEGAL_NAME || 'Whollar',
    postalAddress: cfg.MAIL_POSTAL_ADDRESS || null,
    contactEmail: cfg.MAIL_REPLY_TO || null,
    whyLine: whyLine(entry, row),
    unsubscribeUrl,
    preferencesUrl: `${base}${prefsPath}`,
    calendarUrl: null,   // phase B
  });

  const message = layout.assemble({
    audience,
    subject: rendered.subject,
    preheader: rendered.preheader,
    greeting: rendered.greeting,
    blocks: rendered.blocks,
    footer,
  });

  /* The scrubber, over the context and then over the finished body.
   *
   * The only thing allowed through from this side is the recipient's own
   * email address, which is a fact about the row rather than about the
   * context. Everything else the recipient is entitled to see, their own org
   * name above all, is resolved by the scrubber from the recipient's own
   * rows. Passing `ctx.org_name` here would allow whatever name the context
   * happens to carry, and a context carrying the WRONG partner's name is
   * precisely the leak this is for. */
  const denylist = await scrub.denylistFor(catalystApp, {
    campaignId: row.campaign_id,
    audience,
    recipient: { type: row.recipient_type, id: row.recipient_id },
    allow: [row.recipient_email].filter(Boolean),
  });
  const hits = scrub.checkContext(ctx, denylist)
    .concat(scrub.check(message.subject, message.html, message.text, denylist));
  if (hits.length) return { blocked: true, hits };

  const host = senderHost(cfg, entry);
  const headers = {};
  if (unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  return {
    subject: message.subject,
    bodySha: sha(`${message.subject}\n${message.html}`),
    wire: {
      to: row.recipient_email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      from: senderAddress(cfg, entry),
      replyTo: cfg.MAIL_REPLY_TO || undefined,
      clientReference: row.notify_key,
      messageId: messageIdFor(row.notify_key, host),
      headers: Object.keys(headers).length ? headers : undefined,
    },
  };
}

/**
 * Which sender this message goes out as.
 *
 * Two Mail Agents on two subdomains, so a complaint about an announcement
 * cannot cost a member their ability to receive a sign-in code. Both fall back
 * to the single configured sender, which is what everything used before the
 * split and what a half-configured environment still gets.
 */
function senderAddress(cfg, entry) {
  if (entry.casl === 'cem') return cfg.MAIL_FROM_CEM || cfg.ZEPTOMAIL_FROM;
  return cfg.MAIL_FROM_TRANSACTIONAL || cfg.ZEPTOMAIL_FROM;
}

function senderHost(cfg, entry) {
  const addr = String(senderAddress(cfg, entry) || '');
  const at = addr.lastIndexOf('@');
  return at > 0 ? addr.slice(at + 1) : 'whollar.com';
}

/**
 * "Why you got this", named to the consent that justifies it. CASL wants a
 * commercial message to say which consent it relies on, and a transactional
 * one to be honest that it is not asking permission.
 */
function whyLine(entry, row) {
  if (entry.casl === 'cem') {
    return 'You are getting this because you asked Whollar to tell you about this.';
  }
  if (row.recipient_type === 'partner') {
    return 'You are getting this because you are a founding partner with a Whollar account.';
  }
  return 'You are getting this because you have a Whollar account.';
}

/* ------------------------------------------------------------------ *
 * Deliveries
 * ------------------------------------------------------------------ */

/** One row per attempt, and later per webhook event on the same attempt. */
async function recordDelivery(catalystApp, row, patch, now = Date.now()) {
  const at = datastore.toDb(new Date(now));
  try {
    await datastore.insertRow(catalystApp, DELIVERIES, {
      outbox_key: row.notify_key,
      client_reference: row.notify_key,
      provider_message_id: patch.provider_message_id || null,
      transport: patch.transport || null,
      status: patch.status,
      status_at: at,
      detail: patch.detail ? String(patch.detail).slice(0, 500) : null,
      created_at: at,
    });
  } catch {
    /* The delivery ledger is the reporting surface, not the send itself. A
       missing table must not turn a delivered email into a failed one. */
  }
}

/** Every delivery event for one outbox row, oldest first. */
async function deliveriesFor(catalystApp, notifyKey) {
  try {
    const rows = await datastore.queryAll(catalystApp, DELIVERIES, DELIVERY_COLUMNS,
      `outbox_key = ${datastore.lit(notifyKey)}`);
    return (rows || []).sort((a, b) =>
      String(a.status_at || '').localeCompare(String(b.status_at || '')));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * The one-shot path
 * ------------------------------------------------------------------ */

/**
 * Enqueue and, for security mail, send in the same breath.
 *
 * This is what a route calls. It returns what the route needs for its own
 * audit line (`delivered`, and the transport), so migrating the nine existing
 * call sites does not change what any of them logs.
 */
async function dispatch(catalystApp, cfg, spec) {
  const queued = await enqueue(catalystApp, cfg, spec);
  const entry = registry.get(spec.templateKey);

  if (!entry || entry.priority !== 'security') {
    return { ...queued, delivered: false, inline: false };
  }
  if (queued.status !== 'queued') {
    return { ...queued, delivered: false, inline: true };
  }

  const row = queued.row && queued.row.ROWID
    ? queued.row
    : await find(catalystApp, queued.notifyKey);
  if (!row) return { ...queued, delivered: false, inline: true };

  const sent = await sendRow(catalystApp, cfg, row, spec.now || Date.now());
  return { ...queued, delivered: Boolean(sent.ok), inline: true };
}

/** Fire and forget, for a read path that must not wait on mail. */
function drainAsync(catalystApp, cfg, opts) {
  Promise.resolve(drain(catalystApp, cfg, opts)).catch(() => {});
}

module.exports = {
  TABLE, DELIVERIES, COLUMNS, DELIVERY_COLUMNS, STATUS, BATCH,
  MAX_ATTEMPTS, COLLAPSE_MS, STALE_CLAIM_MS, QUIET_FROM, QUIET_TO,
  idempotencyKey, messageIdFor, earliestSend, localHour,
  enqueue, dispatch, drain, drainAsync, sendRow, build,
  find, setStatus, recordDelivery, deliveriesFor, backoffMs,
  senderAddress, senderHost, whyLine, markSuperseded,
};
