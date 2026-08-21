'use strict';

/**
 * The user repository: one human, many ways in.
 *
 * Every login path, email OTP, Google, partner password, converges
 * here. That convergence is the whole point of the `users` / `auth_identities`
 * split: sign up with a code today, click "Continue with Google" on the same
 * address next month, and it is the same account rather than a duplicate.
 */

const crypto = require('node:crypto');
const datastore = require('./datastore');

const USERS = 'users';
const IDENTITIES = 'auth_identities';

/**
 * TWO LISTS, and this is the one place in the codebase where that pattern is
 * not a convenience but an outage guard.
 *
 * Tables here are created BY HAND (there is no DDL API), so code and schema
 * deploy separately and in either order, and asking ZCQL for a column that
 * does not exist throws. Every authenticated request in the system reads a
 * user, so a projection naming one column the live table has not got does not
 * degrade one screen: it returns 500 from sign-in, from the session load, and
 * therefore from every route behind it. That is a total auth outage caused by
 * a column nothing on the sign-in path even reads.
 *
 * BASE is what authentication genuinely needs. The two newest columns are
 * additions from later work (`referral_code` from the referral system,
 * `crm_contact_id` written back by crm-sync), and neither is load-bearing for
 * letting somebody in. They are tried first and dropped if the table has not
 * caught up. The consequence of the fallback is a referral not being credited
 * on that read, which is a bug worth having instead of nobody being able to
 * sign in at all.
 */
const USER_COLUMNS_BASE = ['ROWID', 'user_id', 'email_normalized', 'email_display',
  'first_name', 'last_name', 'user_type', 'status',
  'postal_code', 'fsa', 'province_code', 'phone'];
const USER_COLUMNS = USER_COLUMNS_BASE.concat(['referral_code', 'crm_contact_id']);

/**
 * The signup fields that are not identity: everything the waitlist form
 * collects beyond an email and a password.
 *
 * Trimmed and length-capped here rather than at the route, so every path that
 * creates a user gets the same treatment. A value longer than its column does
 * not error on insert; Catalyst truncates it, which is how a postal code
 * quietly becomes a prefix of itself.
 */
function profileFrom(input = {}) {
  const cap = (v, n) => {
    const s = String(v == null ? '' : v).trim();
    return s ? s.slice(0, n) : null;
  };
  // Upper-cased here and not merely in the browser. These are compared against
  // each other later, an FSA from one row against a postal code from another,
  // and a mix of `K1A` and `k1a` in one column turns every such comparison into
  // a silent miss.
  const upper = (v, n) => { const s = cap(v, n); return s ? s.toUpperCase() : null; };

  const postal = upper(input.postalCode, 10);
  return {
    last_name: cap(input.lastName, 100),
    postal_code: postal,
    // Derived here, never trusted from the client: the FSA decides which cohort
    // someone lands in, and a caller that could set it independently of the
    // postal code could put themselves in any region they liked.
    fsa: postal ? postal.replace(/\s+/g, '').slice(0, 3) : null,
    province_code: upper(input.provinceCode, 2),
    phone: cap(input.phone, 32),
    referral_code: cap(input.referralCode, 64),
  };
}

/**
 * Lowercase and trim. Nothing else.
 *
 * Specifically NOT stripping dots or `+tags`, though Gmail ignores both. Two
 * reasons. Most providers treat them as significant, so `a.b@corp.ca` and
 * `ab@corp.ca` really are different people almost everywhere; and normalising
 * them together would silently merge two accounts, which is unrecoverable in a
 * way that having two accounts is not.
 */
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

/**
 * Deliberately stricter than the RFC.
 *
 * The RFC permits quoted local parts and bracketed IP domains; accepting them
 * buys nothing here and drags them through `lit()`'s charset check, which would
 * throw rather than reject cleanly. Requiring a 2+ character TLD also matches
 * the frontend's `W.isEmail`, so a value that passes in the browser cannot then
 * fail at the server for a reason the user never sees.
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const isEmail = (email) => EMAIL_RE.test(String(email || '')) && String(email).length <= 254;

/** "sam.kaur@northline.ca" -> "Sam". A supplied given name always wins. */
function firstNameFrom(email, given) {
  const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (given && String(given).trim()) return titleCase(String(given).trim()).slice(0, 100);
  const local = (String(email).split('@')[0] || '').split(/[._\-+0-9]/)[0] || '';
  return local ? titleCase(local).slice(0, 100) : null;
}

/**
 * One user, read with the full projection and retried with the base one.
 *
 * The retry is narrow on purpose: it re-runs the same lookup with fewer
 * columns, so a genuinely broken table still throws on the second attempt and
 * the caller still sees the failure. What it will not do is turn a missing
 * optional column into a sign-in outage. The miss is logged, once per process
 * is not worth the machinery, so every time: an auth path quietly running
 * degraded is exactly the thing that should be noisy.
 */
async function readUser(catalystApp, column, value) {
  try {
    return await datastore.findBy(catalystApp, USERS, column, value, USER_COLUMNS);
  } catch (err) {
    const row = await datastore.findBy(catalystApp, USERS, column, value, USER_COLUMNS_BASE);
    console.error(JSON.stringify({
      level: 'error',
      message: 'users read fell back to the base projection',
      detail: String((err && err.message) || err).slice(0, 200),
      missing_one_of: ['referral_code', 'crm_contact_id'],
    }));
    return row;
  }
}

const findByEmail = (catalystApp, email) =>
  readUser(catalystApp, 'email_normalized', normalizeEmail(email));

const findById = (catalystApp, userId) =>
  readUser(catalystApp, 'user_id', userId);

/**
 * Create a user, or return the existing one if a concurrent request won.
 *
 * The unique constraint on `email_normalized` is what makes this safe: two
 * simultaneous signups both find nothing, both insert, and exactly one insert
 * fails. Catching that failure and re-reading is the correction. A check-then-
 * insert without the constraint would produce two accounts for one person, and
 * the second would be the one nobody can sign into.
 */
async function findOrCreate(catalystApp, {
  email, firstName, userType = 'member', status = 'active', profile,
}) {
  const normalized = normalizeEmail(email);

  const existing = await findByEmail(catalystApp, normalized);
  if (existing) return { user: existing, created: false };

  const userId = crypto.randomUUID();
  try {
    await datastore.insertRow(catalystApp, USERS, {
      user_id: userId,
      email_normalized: normalized,
      email_display: String(email).trim().slice(0, 255),
      first_name: firstNameFrom(normalized, firstName),
      user_type: userType,
      status,
      ...profileFrom(profile),
      last_login_at: null,
      crm_contact_id: null,
    });
  } catch (err) {
    // Lost the race, or a genuine failure. Re-reading distinguishes them:
    // if a row is now present, the constraint did its job.
    const raced = await findByEmail(catalystApp, normalized);
    if (raced) return { user: raced, created: false };
    throw err;
  }

  const user = await findById(catalystApp, userId);

  /* A member's opaque share token, minted with the account. Best-effort by
   * contract: the `referral_token` table is created by hand and may lag this
   * code, and a signup is worth more than a token that lib/referral.js's
   * `tokenFor` will mint lazily on the first dashboard read anyway. The
   * require is local to keep users <-> referral acyclic at module load. */
  if (userType === 'member') {
    try {
      await require('./referral').issueToken(catalystApp, 'member', userId);
    } catch { /* already logged inside issueToken */ }
  }

  return { user, created: true };
}

/**
 * Record a credential as belonging to a user. Idempotent.
 *
 * `provider_key` is the composite `(provider, provider_uid)` flattened into one
 * column, because Catalyst's unique constraint is per-column and has no
 * composite form. It is built here and nowhere else.
 */
async function linkIdentity(catalystApp, { userId, provider, providerUid, emailAtProvider }) {
  const providerKey = `${provider}:${providerUid}`;

  const existing = await datastore.findBy(
    catalystApp, IDENTITIES, 'provider_key', providerKey, ['ROWID', 'user_id']
  );
  if (existing) return { linked: false, conflict: existing.user_id !== userId, row: existing };

  try {
    await datastore.insertRow(catalystApp, IDENTITIES, {
      user_id: userId,
      provider,
      provider_uid: String(providerUid).slice(0, 255),
      provider_key: providerKey.slice(0, 255),
      email_at_provider: emailAtProvider ? normalizeEmail(emailAtProvider).slice(0, 255) : null,
      linked_at: datastore.nowDb(),
    });
  } catch (err) {
    const raced = await datastore.findBy(
      catalystApp, IDENTITIES, 'provider_key', providerKey, ['ROWID', 'user_id']
    );
    if (raced) return { linked: false, conflict: raced.user_id !== userId, row: raced };
    throw err;
  }
  return { linked: true, conflict: false };
}

/** Find the user behind a given provider identity, or null. */
async function findByIdentity(catalystApp, provider, providerUid) {
  const row = await datastore.findBy(
    catalystApp, IDENTITIES, 'provider_key', `${provider}:${providerUid}`, ['ROWID', 'user_id']
  );
  return row ? findById(catalystApp, row.user_id) : null;
}

/**
 * Overwrite the profile fields on an existing row.
 *
 * Only used while an account is still `pending`: someone repeating an
 * unfinished signup may well be correcting the postal code they got wrong the
 * first time, and keeping the original would place them in the wrong cohort
 * with no way to say so. Once an account is active this must not be called:
 * changing a verified member's region belongs behind an authenticated profile
 * endpoint, not behind an unauthenticated signup form.
 */
async function updateProfile(catalystApp, user, { firstName, profile }) {
  const fields = { ROWID: user.ROWID, ...profileFrom(profile) };
  const first = firstNameFrom(user.email_normalized, firstName);
  if (first) fields.first_name = first;
  await datastore.updateRow(catalystApp, USERS, fields);
  return { ...user, ...fields };
}

/**
 * Move an account between statuses.
 *
 * NOT best-effort, unlike `touchLastLogin` below: this is what turns a pending
 * signup into a usable account, and a silently dropped write there leaves
 * someone who verified their email still unable to sign in.
 */
async function setStatus(catalystApp, user, status) {
  await datastore.updateRow(catalystApp, USERS, { ROWID: user.ROWID, status });
  return { ...user, status };
}

/** Best-effort: a missing last_login_at is not worth failing a login over. */
async function touchLastLogin(catalystApp, user) {
  try {
    await datastore.updateRow(catalystApp, USERS, {
      ROWID: user.ROWID, last_login_at: datastore.nowDb(),
    });
  } catch { /* ignore */ }
}

module.exports = {
  USERS, IDENTITIES, USER_COLUMNS, USER_COLUMNS_BASE,
  normalizeEmail, isEmail, firstNameFrom, profileFrom,
  findByEmail, findById, findOrCreate,
  linkIdentity, findByIdentity, touchLastLogin, setStatus, updateProfile,
};
