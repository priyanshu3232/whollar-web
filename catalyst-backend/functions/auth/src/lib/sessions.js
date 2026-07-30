'use strict';

/**
 * Session lifecycle: mint, load, roll, revoke.
 *
 * The cookie carries a 256-bit random token. The database stores only its
 * SHA-256, so a dump of `sessions` yields nothing that can be replayed — the
 * same reason passwords are not stored in the clear, applied to the credential
 * that is actually presented on every request.
 */

const crypto = require('node:crypto');

const datastore = require('./datastore');
const cookies = require('./cookies');
const { token, hashSessionToken, hashIp } = require('./crypto');
const { clientIp, userAgent } = require('./request');

const SESSIONS = 'sessions';
const USERS = 'users';

const SESSION_COLUMNS = ['ROWID', 'session_id', 'token_hash', 'user_id', 'expires_at', 'revoked_at'];
const USER_COLUMNS = ['ROWID', 'user_id', 'email_normalized', 'email_display', 'first_name', 'user_type', 'status'];

/**
 * Members roll; partners and admins do not.
 *
 * A household should stay signed in across weeks of not thinking about their
 * internet bill; every visit pushes the expiry out. A partner console shows
 * competitor pricing and cohort internals, so its 12 hours is an absolute
 * ceiling — an unattended laptop stops being a way in after one working day,
 * regardless of activity. The admin console can flip approvals and pause
 * bidding, so it gets the same absolute ceiling for the same reason.
 */
const rolls = (userType) => userType === 'member';

/** Refresh only inside the last half of the lifetime. */
const REFRESH_AFTER_FRACTION = 0.5;

function ttlFor(cfg, userType) {
  if (userType === 'provider') return cfg.SESSION_TTL_MS.provider;
  if (userType === 'admin') return cfg.SESSION_TTL_MS.admin || cfg.SESSION_TTL_MS.provider;
  return cfg.SESSION_TTL_MS.member;
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

/**
 * Mint a session and set the cookie. Returns the row's public facts; the raw
 * token is intentionally not returned — it exists only in the Set-Cookie header
 * so that no call site can log it by accident.
 */
async function create(catalystApp, req, res, { userId, userType }) {
  const cfg = req.app.get('cfg');
  const raw = token(32);
  const ttlMs = ttlFor(cfg, userType);
  const expiresAt = datastore.inMsDb(ttlMs);

  const sessionId = crypto.randomUUID();

  await datastore.insertRow(catalystApp, SESSIONS, {
    session_id: sessionId,
    token_hash: hashSessionToken(raw),
    user_id: userId,
    expires_at: expiresAt,
    revoked_at: null,
    ip_hash: hashIp(clientIp(req), cfg),
    user_agent: userAgent(req),
  });

  cookies.set(req, res, raw, ttlMs);
  return { sessionId, expiresAt, ttlMs };
}

/* ------------------------------------------------------------------ *
 * Load
 * ------------------------------------------------------------------ */

/**
 * Resolve the cookie to a live session and its user, or null.
 *
 * Returns null — never throws — for every "not signed in" case: no cookie, no
 * matching row, revoked, expired, or the user is gone or disabled. A caller
 * should not have to distinguish those, and telling them apart at the API
 * boundary would leak whether a given token ever existed.
 *
 * Expiry is enforced in code rather than in the query. `expires_at` is a string
 * column, so a `WHERE expires_at > …` comparison would be lexical, and the
 * moment the format varies at all that silently stops meaning what it says.
 */
async function load(catalystApp, req, res) {
  const raw = cookies.read(req);
  if (!raw) return null;

  let session;
  try {
    session = await datastore.findBy(
      catalystApp, SESSIONS, 'token_hash', hashSessionToken(raw), SESSION_COLUMNS
    );
  } catch {
    // A malformed cookie value cannot reach lit()'s charset check as a valid
    // hash, and a rejected literal throws. Treat it as "not signed in".
    return null;
  }
  if (!session) return null;
  if (session.revoked_at) return null;
  if (datastore.isExpired(session.expires_at)) return null;

  const user = await datastore.findBy(catalystApp, USERS, 'user_id', session.user_id, USER_COLUMNS);
  if (!user) return null;
  if (user.status !== 'active') return null;

  if (res) await maybeRoll(catalystApp, req, res, session, user);

  return { session, user };
}

/**
 * Extend a member's session when it is more than half spent.
 *
 * The fraction is what makes this affordable: refreshing on every request would
 * add a write to every authenticated page load. Failure is swallowed — a
 * session that did not get extended is a minor inconvenience later, whereas a
 * failed request now is one the user sees.
 */
async function maybeRoll(catalystApp, req, res, session, user) {
  if (!rolls(user.user_type)) return;

  const cfg = req.app.get('cfg');
  const ttlMs = ttlFor(cfg, user.user_type);
  const expiresAt = datastore.fromDb(session.expires_at);
  if (!expiresAt) return;

  const remaining = expiresAt.getTime() - Date.now();
  if (remaining > ttlMs * REFRESH_AFTER_FRACTION) return;

  try {
    const next = datastore.inMsDb(ttlMs);
    await datastore.updateRow(catalystApp, SESSIONS, { ROWID: session.ROWID, expires_at: next });
    session.expires_at = next;
    cookies.set(req, res, cookies.read(req), ttlMs);
  } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ *
 * Revoke
 * ------------------------------------------------------------------ */

/**
 * Revoke, rather than delete.
 *
 * The row is the evidence that a session existed and when it ended, which is
 * what makes "was this account used after the password was reset?" answerable.
 * `authCronCleanup` sweeps rows that are long expired.
 */
async function revoke(catalystApp, session) {
  if (!session || !session.ROWID) return;
  await datastore.updateRow(catalystApp, SESSIONS, {
    ROWID: session.ROWID,
    revoked_at: datastore.nowDb(),
  });
}

/**
 * Revoke every live session for a user. Called on password reset and on
 * "sign out everywhere" — a password change that leaves old sessions working
 * does not actually lock anyone out.
 */
async function revokeAllForUser(catalystApp, userId) {
  // Paginated, not a bare SELECT. ZCQL stops at 300 rows without complaining,
  // so an unbounded query here would leave every session past the 300th alive
  // — and this is the call that runs after a password reset, i.e. exactly when
  // "most of them were revoked" is not good enough.
  const rows = await datastore.queryAll(
    catalystApp, SESSIONS, ['revoked_at'],
    `user_id = ${datastore.lit(userId)}`
  );
  const now = datastore.nowDb();
  let revoked = 0;
  for (const row of rows) {
    if (row.revoked_at) continue;
    try {
      await datastore.updateRow(catalystApp, SESSIONS, { ROWID: row.ROWID, revoked_at: now });
      revoked++;
    } catch { /* keep going: one failure must not strand the rest */ }
  }
  return revoked;
}

/* ------------------------------------------------------------------ *
 * Shape sent to the browser
 * ------------------------------------------------------------------ */

/**
 * The user as the frontend is allowed to see them.
 *
 * An explicit allowlist, not a delete-list: a column added to `users` later is
 * then invisible here by default rather than newly exposed by accident.
 */
function publicUser(user) {
  return {
    email: user.email_display || user.email_normalized,
    firstName: user.first_name || null,
    userType: user.user_type,
  };
}

module.exports = {
  create, load, revoke, revokeAllForUser, publicUser,
  ttlFor, rolls,
  SESSIONS, USERS, SESSION_COLUMNS, USER_COLUMNS,
};
