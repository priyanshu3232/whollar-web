'use strict';

/**
 * One-time email codes.
 *
 * Six digits is a 10^6 search space, which is weak on its own. Three controls
 * make it adequate, and all three are load-bearing:
 *
 *   TTL          10 minutes, stored in `expires_at` and checked on read
 *   ATTEMPTS     5 per challenge, after which the challenge is dead
 *   SINGLE USE   `consumed_at` is the replay defence
 *
 * Remove any one and the remaining two do not compensate. The attempt counter
 * in particular is the primary defence, not the IP rate limit: an attacker with
 * a botnet has many IPs but still only gets five guesses at a given code.
 *
 * The TTL lives in the row rather than in Catalyst Cache because Cache expiry
 * is expressed in whole hours, so a 10-minute code is not representable there.
 */

const crypto = require('node:crypto');

const datastore = require('./datastore');
const { numericCode, hashCode, hashIp, safeEqual } = require('./crypto');
const { clientIp } = require('./request');
const { badRequest } = require('./errors');

const TABLE = 'auth_challenges';

const TTL_MINUTES = 10;
const TTL_MS = TTL_MINUTES * 60 * 1000;
const MAX_ATTEMPTS = 5;

const PURPOSES = Object.freeze(['login', 'signup', 'password_reset']);

const COLUMNS = ['ROWID', 'challenge_id', 'email_normalized', 'code_hash',
  'purpose', 'expires_at', 'attempts', 'consumed_at'];

/**
 * Issue a code.
 *
 * Any earlier unconsumed challenge for the same email and purpose is consumed
 * first. Without that, requesting a second code leaves the first one live, so
 * "resend" would widen the attack surface with every click rather than
 * replacing it — and a user who then typed the older code would be told it was
 * wrong, which is confusing and true only by accident.
 */
async function start(catalystApp, req, { email, purpose = 'login' }) {
  if (!PURPOSES.includes(purpose)) throw badRequest('Unknown purpose.');

  const cfg = req.app.get('cfg');
  await consumeOutstanding(catalystApp, email, purpose);

  const code = numericCode(6);
  const challengeId = crypto.randomUUID();

  await datastore.insertRow(catalystApp, TABLE, {
    challenge_id: challengeId,
    email_normalized: email,
    code_hash: hashCode(code, cfg),
    purpose,
    expires_at: datastore.inMsDb(TTL_MS),
    attempts: 0,
    consumed_at: null,
    ip_hash: hashIp(clientIp(req), cfg),
  });

  return { challengeId, code, ttlMinutes: TTL_MINUTES };
}

/**
 * Check a code.
 *
 * Every failure — no challenge, expired, exhausted, wrong code — returns the
 * same shape and the caller surfaces the same message. Distinguishing them
 * would turn this into an oracle for which addresses have a code in flight.
 * `reason` exists for the audit row, not for the response body.
 *
 * @returns {{ok: boolean, reason?: string, challenge?: object}}
 */
async function verify(catalystApp, req, { email, code, purpose = 'login' }) {
  const cfg = req.app.get('cfg');

  const challenge = await mostRecent(catalystApp, email, purpose);
  if (!challenge) return { ok: false, reason: 'no_challenge' };
  if (challenge.consumed_at) return { ok: false, reason: 'already_used' };
  if (datastore.isExpired(challenge.expires_at)) return { ok: false, reason: 'expired' };

  const attempts = parseInt(challenge.attempts, 10) || 0;
  if (attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  // Constant-time. Both sides are digests of equal length, so a plain ===
  // would leak the matching prefix through timing.
  const matches = safeEqual(hashCode(String(code), cfg), challenge.code_hash);

  if (!matches) {
    // Increment BEFORE returning. If this write fails the attempt is not
    // counted, so it is awaited rather than fired and forgotten — an
    // uncounted attempt is an unlimited one.
    await datastore.updateRow(catalystApp, TABLE, {
      ROWID: challenge.ROWID, attempts: attempts + 1,
    });
    return { ok: false, reason: 'mismatch', remaining: MAX_ATTEMPTS - (attempts + 1) };
  }

  // Consume on success. This is the replay defence, so a failure here must fail
  // the verification — a code that stays live after being accepted once is a
  // code that can be used twice.
  await datastore.updateRow(catalystApp, TABLE, {
    ROWID: challenge.ROWID, consumed_at: datastore.nowDb(),
  });

  return { ok: true, challenge };
}

/**
 * Newest challenge for this email and purpose.
 *
 * `code_hash` is an Encrypted column — selectable but never filterable — so the
 * lookup is by email and the comparison happens in code. That is the whole
 * reason the column is encrypted rather than plain.
 */
async function mostRecent(catalystApp, email, purpose) {
  const rows = await datastore.query(
    catalystApp, TABLE,
    `SELECT ${COLUMNS.join(', ')} FROM ${TABLE} ` +
    `WHERE email_normalized = ${datastore.lit(email)} AND purpose = ${datastore.lit(purpose)} ` +
    `ORDER BY CREATEDTIME DESC LIMIT 1`
  );
  return rows[0] || null;
}

/** Retire any live challenges for this email and purpose. */
async function consumeOutstanding(catalystApp, email, purpose) {
  const rows = await datastore.queryAll(
    catalystApp, TABLE, ['consumed_at'],
    `email_normalized = ${datastore.lit(email)} AND purpose = ${datastore.lit(purpose)}`
  );
  const now = datastore.nowDb();
  for (const row of rows) {
    if (row.consumed_at) continue;
    try {
      await datastore.updateRow(catalystApp, TABLE, { ROWID: row.ROWID, consumed_at: now });
    } catch { /* best effort — a stale live code is bounded by its own TTL */ }
  }
}

module.exports = {
  TABLE, TTL_MINUTES, TTL_MS, MAX_ATTEMPTS, PURPOSES, COLUMNS,
  start, verify, mostRecent, consumeOutstanding,
};
