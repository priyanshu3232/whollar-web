'use strict';

/**
 * Stored passwords, and the lockout that makes a six-character guess pointless.
 *
 * One row per user in `credentials`, keyed by `user_id`. A user with no row has
 * no password — which is the normal state for anyone who arrived by emailed
 * code or by Google, and is why every read here returns null rather than
 * throwing. "No password set" is a real, supported account state, not an error.
 *
 * `hash` is an Encrypted column: selectable, never filterable. Nothing here
 * ever puts it in a WHERE clause, and nothing should — the lookup is always by
 * `user_id` and the comparison always happens in code, inside `verifyPassword`.
 *
 * WHY A LOCKOUT AS WELL AS A RATE LIMIT. The IP rate limit in `ratelimit.js`
 * bounds how fast one machine can guess. It does not bound a botnet spreading
 * one account's guesses across a thousand addresses, because each address stays
 * comfortably under the limit. `failed_count` is per-ACCOUNT, so that attack
 * runs into the same wall as a single-machine one.
 */

const datastore = require('./datastore');
const { hashPassword, verifyPassword, needsRehash } = require('./crypto');
const { badRequest } = require('./errors');

const TABLE = 'credentials';

const COLUMNS = ['ROWID', 'user_id', 'hash', 'algo', 'updated_at',
  'failed_count', 'locked_until'];

/**
 * Wrong guesses before the account stops answering, and for how long.
 *
 * Ten is deliberately well above the five allowed on an emailed code. A code is
 * a secret we issued minutes ago, so five is generous; a password is something
 * a person is recalling, and locking a legitimate user out of their own account
 * on the sixth typo is a support ticket, not security.
 */
const MAX_FAILED = 10;
const LOCK_MS = 15 * 60 * 1000;

/**
 * Password rules, kept to the two that actually correlate with strength.
 *
 * Deliberately NO composition requirement (an uppercase, a digit, a symbol).
 * Those rules push people to `Password1!`, which is weaker than a long
 * passphrase and harder to remember, and current NIST guidance advises against
 * them. Length is the control that matters.
 *
 * The upper bound is not a strength rule — scrypt hashes any length, but it
 * hashes a 10 MB paste slowly enough to be a denial-of-service lever.
 */
const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

/**
 * Throws a user-facing error, so the message has to be one we are happy to show
 * verbatim. The email comparison catches the single most common weak choice
 * that a length rule alone lets through.
 */
function assertAcceptable(password, email) {
  const value = String(password || '');
  if (value.length < MIN_LENGTH) {
    throw badRequest(`Use at least ${MIN_LENGTH} characters. A short phrase you'll remember beats a short jumble.`);
  }
  if (value.length > MAX_LENGTH) {
    throw badRequest(`Passwords can be at most ${MAX_LENGTH} characters.`);
  }
  if (email && value.trim().toLowerCase() === String(email).trim().toLowerCase()) {
    throw badRequest('Your password can’t be your email address.');
  }
}

/** The credential row for a user, or null when they have no password. */
const forUser = (catalystApp, userId) =>
  datastore.findBy(catalystApp, TABLE, 'user_id', userId, COLUMNS);

/**
 * Set or replace a user's password.
 *
 * Resets the failure counter and any lock: whoever set this password has
 * demonstrated control of the account, so carrying a previous attacker's
 * failed attempts forward would let them keep the owner locked out.
 */
async function set(catalystApp, userId, password) {
  const { hash, algo } = await hashPassword(password);
  const existing = await forUser(catalystApp, userId);

  const fields = {
    hash, algo,
    updated_at: datastore.nowDb(),
    failed_count: 0,
    locked_until: null,
  };

  if (existing) {
    await datastore.updateRow(catalystApp, TABLE, { ROWID: existing.ROWID, ...fields });
    return { created: false };
  }

  try {
    await datastore.insertRow(catalystApp, TABLE, { user_id: userId, ...fields });
  } catch (err) {
    // `user_id` is unique, so a concurrent set lost the race. Its password is
    // as valid as ours would have been — but ours is the one the caller just
    // chose, so overwrite rather than silently keeping the other.
    const raced = await forUser(catalystApp, userId);
    if (!raced) throw err;
    await datastore.updateRow(catalystApp, TABLE, { ROWID: raced.ROWID, ...fields });
    return { created: false };
  }
  return { created: true };
}

/**
 * Check a password.
 *
 * @returns {{ok: boolean, reason?: string, retryAfterMs?: number, rehashed?: boolean}}
 *
 * Every failure shape is reported distinctly HERE, for the audit row. The route
 * collapses them into one message — see the note in errors.js about what a
 * login form tells an attacker.
 *
 * A locked account does not get its password checked at all. Checking it first
 * and then refusing would make the lock leak whether the guess was right, which
 * is the one bit the lock exists to withhold.
 */
async function check(catalystApp, userId, password) {
  const row = await forUser(catalystApp, userId);
  if (!row) return { ok: false, reason: 'no_credential' };

  if (row.locked_until && !datastore.isExpired(row.locked_until)) {
    return {
      ok: false,
      reason: 'locked',
      retryAfterMs: Math.max(0, new Date(datastore.fromDb(row.locked_until)).getTime() - Date.now()),
    };
  }

  const matches = await verifyPassword(password, row.hash, row.algo);

  if (!matches) {
    // A lock that expired is a clean slate: the counter restarts rather than
    // resuming at ten, or the eleventh wrong guess ever would lock the account
    // permanently.
    const wasLocked = row.locked_until && datastore.isExpired(row.locked_until);
    const failed = (wasLocked ? 0 : (parseInt(row.failed_count, 10) || 0)) + 1;
    const lock = failed >= MAX_FAILED;

    // Awaited, not fired and forgotten: an uncounted attempt is an unlimited
    // one, and this is the primary defence against a distributed guess.
    await datastore.updateRow(catalystApp, TABLE, {
      ROWID: row.ROWID,
      failed_count: failed,
      locked_until: lock ? datastore.inMsDb(LOCK_MS) : null,
    });

    return {
      ok: false,
      reason: lock ? 'locked_now' : 'mismatch',
      retryAfterMs: lock ? LOCK_MS : undefined,
    };
  }

  // Correct. Clear the counter, and take the opportunity to move an old hash
  // to current parameters — the only moment the plaintext is available to do it.
  const fields = { ROWID: row.ROWID };
  let rehashed = false;

  if ((parseInt(row.failed_count, 10) || 0) !== 0 || row.locked_until) {
    fields.failed_count = 0;
    fields.locked_until = null;
  }
  if (needsRehash(row.algo)) {
    const next = await hashPassword(password);
    fields.hash = next.hash;
    fields.algo = next.algo;
    fields.updated_at = datastore.nowDb();
    rehashed = true;
  }

  if (Object.keys(fields).length > 1) {
    // Best-effort: a bookkeeping write must not fail a correct sign-in.
    try { await datastore.updateRow(catalystApp, TABLE, fields); } catch { /* ignore */ }
  }

  return { ok: true, rehashed };
}

module.exports = {
  TABLE, COLUMNS, MIN_LENGTH, MAX_LENGTH, MAX_FAILED, LOCK_MS,
  assertAcceptable, forUser, set, check,
};
