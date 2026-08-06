'use strict';

/**
 * The member's account beyond the bill: profile, preferences, feedback,
 * referral standing, and the two rights every account owner has — take your
 * data out, and delete the account.
 *
 *   POST /me/profile    update name / phone / postal code
 *   GET  /me/prefs      the stored preference blob
 *   POST /me/prefs      merge preference keys (notification toggles, interests)
 *   POST /me/event      record feedback: a provider rating, an outage report,
 *                       a "first in line" interest signal
 *   GET  /me/referral   this member's share code and how many joined with it
 *   GET  /me/export     everything we hold about this account, as JSON
 *   POST /me/delete     revoke sessions, delete owned rows, scrub the account
 *
 * Everything is keyed on the session's user_id. The email appears only in
 * /me/delete's typed confirmation, where it is the proof of intent, and in
 * /me/referral's count, where other people typed this member's code.
 */

const datastore = require('../lib/datastore');
const users = require('../lib/users');
const sessions = require('../lib/sessions');
const prefs = require('../lib/prefs');
const audit = require('../lib/audit');
const cookies = require('../lib/cookies');
const ratelimit = require('../lib/ratelimit');
const { wrap, badRequest, unauthorized, forbidden } = require('../lib/errors');

const EVENTS = 'user_events';
const EVENT_KINDS = new Set(['rating', 'outage', 'interest', 'provider-notify']);

function requireUser(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  return req.auth.user;
}

function requireMember(req) {
  const user = requireUser(req);
  if (user.user_type !== 'member') {
    throw forbidden('This account is not a member account.', {
      logDetail: 'non-member hit /me',
    });
  }
  return user;
}

/**
 * The member's share code, derived rather than stored: the first four hex
 * characters of their user id, which is stable, typable, and already unique
 * enough for the population it serves. Other people type it into the signup
 * form's referral field; the count below is that field matched back.
 */
const referralCodeFor = (user) =>
  'WHL-' + String(user.user_id).replace(/-/g, '').slice(0, 4).toUpperCase();

/**
 * Record a feedback event. Append-only; the admin console is the reader.
 * Payload is capped and stored as JSON — never filtered on, so Text is fine.
 */
async function recordEvent(catalystApp, user, kind, payload) {
  const json = JSON.stringify(payload == null ? {} : payload).slice(0, 4000);
  await datastore.insertRow(catalystApp, EVENTS, {
    user_id: user.user_id,
    user_type: user.user_type,
    kind,
    payload: json,
    created_at: datastore.nowDb(),
  });
}

function mount(router) {
  /**
   * Update the profile fields a member may change about themselves. Selective:
   * only the keys present in the body are touched, so saving a phone number
   * does not blank the postal code. Email is deliberately absent — the address
   * is the account's identity and every credential hangs off it; changing it
   * is a support conversation, not a PATCH.
   */
  router.post('/me/profile', wrap(async (req, res) => {
    const user = requireMember(req);
    const body = req.body || {};

    const fields = { ROWID: user.ROWID };
    if ('firstName' in body) {
      const first = users.firstNameFrom(user.email_normalized, body.firstName);
      if (!first) throw badRequest('Enter a first name.');
      fields.first_name = first;
    }
    if ('lastName' in body) {
      const s = String(body.lastName == null ? '' : body.lastName).trim().slice(0, 100);
      fields.last_name = s || null;
    }
    if ('phone' in body) {
      const s = String(body.phone == null ? '' : body.phone).replace(/[^\d+\-() .]/g, '').trim().slice(0, 32);
      fields.phone = s || null;
    }
    if ('postalCode' in body) {
      const postal = String(body.postalCode || '').trim().toUpperCase().slice(0, 10);
      if (postal && !/^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/.test(postal)) {
        throw badRequest('That does not look like a Canadian postal code, e.g. N5Y 2T6.');
      }
      fields.postal_code = postal || null;
      // Derived here, never taken from the client — the FSA decides the cohort.
      fields.fsa = postal ? postal.replace(/\s+/g, '').slice(0, 3) : null;
    }
    if ('provinceCode' in body) {
      const s = String(body.provinceCode || '').trim().toUpperCase().slice(0, 2);
      fields.province_code = s || null;
    }

    if (Object.keys(fields).length === 1) {
      throw badRequest('Nothing to update.');
    }

    await datastore.updateRow(catalyst(req), users.USERS, fields);
    const fresh = await users.findById(catalyst(req), user.user_id);

    audit.recordAsync(catalyst(req), req, {
      type: 'member.profile.update',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { fields: Object.keys(fields).filter((k) => k !== 'ROWID') },
    });

    res.status(200).json({
      ok: true,
      user: sessions.publicUser({ ...user, ...fresh }),
    });
  }));

  /** The preference blob, whichever dashboard is asking. -> { ok, prefs } */
  router.get('/me/prefs', wrap(async (req, res) => {
    const user = requireUser(req);
    res.status(200).json({ ok: true, prefs: await prefs.get(catalyst(req), user.user_id) });
  }));

  /**
   * Merge preference keys. The caller owns whole top-level keys ('alerts',
   * 'interests', 'notify') and sends complete values for them. -> { ok, prefs }
   */
  router.post('/me/prefs', wrap(async (req, res) => {
    const user = requireUser(req);
    const body = req.body || {};
    const patch = {};
    for (const key of ['alerts', 'interests', 'notify']) {
      if (key in body) patch[key] = body[key];
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to save.');

    const merged = await prefs.merge(catalyst(req), user.user_id, patch);
    res.status(200).json({ ok: true, prefs: merged });
  }));

  /**
   * Record feedback: a provider rating, an outage report, an interest signal.
   * -> { ok }. A failure is a failure — the dashboards only say "logged"
   * when it was.
   */
  router.post('/me/event', wrap(async (req, res) => {
    const user = requireUser(req);
    const body = req.body || {};
    const kind = String(body.kind || '').trim();
    if (!EVENT_KINDS.has(kind)) throw badRequest('Unknown event kind.');

    await ratelimit.enforce(catalyst(req), req, { key: 'me.event.ip', max: 60, windowSec: 3600 });

    try {
      await recordEvent(catalyst(req), user, kind, body.payload);
    } catch (err) {
      throw badRequest('That could not be recorded right now. Please try again shortly.', {
        logDetail: `user_events write failed: ${String((err && err.message) || err).slice(0, 200)}`,
      });
    }

    audit.recordAsync(catalyst(req), req, {
      type: 'member.event',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { kind },
    });

    res.status(200).json({ ok: true });
  }));

  /**
   * The member's share code and how many accounts were created with it.
   * -> { ok, code, joined }. The count tolerates the code being typed in
   * either case; a missing users query degrades to zero, never to an error.
   */
  router.get('/me/referral', wrap(async (req, res) => {
    const user = requireMember(req);
    const code = referralCodeFor(user);

    let joined = 0;
    try {
      for (const candidate of [code, code.toLowerCase()]) {
        const rows = await datastore.queryAll(
          catalyst(req), users.USERS, ['user_id'],
          `referral_code = ${datastore.lit(candidate)}`
        );
        joined += rows.filter((r) => r.user_id !== user.user_id).length;
      }
    } catch { /* count stays 0 */ }

    res.status(200).json({ ok: true, code, joined });
  }));

  /**
   * Everything this account owns, in one JSON document. PIPEDA's access right,
   * self-serve: the browser downloads the response as a file. Each table is
   * read best-effort — an unprovisioned table appears as an empty list, not as
   * a failed export.
   */
  router.get('/me/export', wrap(async (req, res) => {
    const user = requireUser(req);
    const app = catalyst(req);
    const uid = user.user_id;

    const rows = async (table, cols) => {
      try {
        return await datastore.queryAll(app, table, cols, `user_id = ${datastore.lit(uid)}`);
      } catch { return []; }
    };
    const strip = (list) => list.map(({ ROWID, ...rest }) => rest);

    const bill = await (async () => {
      try {
        const row = await datastore.findBy(app, 'member_bills', 'user_id', uid,
          ['provider', 'monthly_cost', 'download_speed', 'access_tech', 'promo_end_date',
            'promo_expired', 'contract_start_date', 'contract_length',
            'switch_threshold', 'source', 'updated_at']);
        if (!row) return null;
        const { ROWID, ...rest } = row;
        return rest;
      } catch { return null; }
    })();

    const doc = {
      exportedAt: new Date().toISOString(),
      account: sessions.publicUser(user),
      bill,
      campaigns: strip(await rows('campaign_members', ['campaign_id', 'status', 'fsa', 'joined_at'])),
      consents: strip(await rows('consents', ['doc_type', 'doc_version', 'accepted_at'])),
      preferences: await prefs.get(app, uid),
      feedback: strip(await rows(EVENTS, ['kind', 'payload', 'created_at'])),
    };

    audit.recordAsync(app, req, {
      type: 'member.export',
      outcome: 'success',
      userId: uid,
      email: user.email_normalized,
    });

    res.status(200).json({ ok: true, data: doc });
  }));

  /**
   * Delete the account. The typed email is the confirmation — a button that
   * deletes on one click is how support tickets are born. Sessions are revoked
   * first, owned rows deleted, and the users row scrubbed rather than removed:
   * the row anchors the audit trail, but nothing personal stays on it. The
   * email slot is rewritten to a tombstone so the address can sign up fresh.
   */
  router.post('/me/delete', wrap(async (req, res) => {
    const user = requireUser(req);
    const app = catalyst(req);
    const typed = users.normalizeEmail((req.body || {}).confirmEmail || '');
    if (!typed || typed !== user.email_normalized) {
      throw badRequest('Type the account email exactly to confirm deletion.');
    }

    // The audit row is written first, while the email is still real.
    await audit.record(app, req, {
      type: 'member.delete',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
    });

    await sessions.revokeAllForUser(app, user.user_id);

    const dropWhere = async (table) => {
      try {
        const rows = await datastore.queryAll(app, table, ['user_id'],
          `user_id = ${datastore.lit(user.user_id)}`);
        for (const row of rows) {
          try { await datastore.deleteRow(app, table, row.ROWID); } catch { /* keep going */ }
        }
      } catch { /* table missing: nothing to delete */ }
    };
    await dropWhere('credentials');
    await dropWhere('auth_identities');
    await dropWhere('member_bills');
    await dropWhere('campaign_members');
    await dropWhere(EVENTS);
    try {
      const p = await datastore.findBy(app, prefs.TABLE, 'pref_key', user.user_id, ['ROWID']);
      if (p) await datastore.deleteRow(app, prefs.TABLE, p.ROWID);
    } catch { /* ditto */ }

    await datastore.updateRow(app, users.USERS, {
      ROWID: user.ROWID,
      status: 'deleted',
      email_normalized: `deleted:${user.user_id}`.slice(0, 255),
      email_display: 'Deleted account',
      first_name: null,
      last_name: null,
      postal_code: null,
      fsa: null,
      province_code: null,
      phone: null,
      referral_code: null,
    });

    cookies.clear(req, res);
    res.status(200).json({ ok: true });
  }));
}

/** The Catalyst app for this request — one name for it in every route above. */
const catalyst = (req) => req.catalyst;

module.exports = { mount, referralCodeFor, EVENTS };
