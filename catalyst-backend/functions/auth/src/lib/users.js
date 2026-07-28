'use strict';

/**
 * The user repository: one human, many ways in.
 *
 * Every login path — email OTP, Google, Apple, partner password — converges
 * here. That convergence is the whole point of the `users` / `auth_identities`
 * split: sign up with a code today, click "Continue with Google" on the same
 * address next month, and it is the same account rather than a duplicate.
 */

const crypto = require('node:crypto');
const datastore = require('./datastore');

const USERS = 'users';
const IDENTITIES = 'auth_identities';

const USER_COLUMNS = ['ROWID', 'user_id', 'email_normalized', 'email_display',
  'first_name', 'user_type', 'status', 'crm_contact_id'];

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

const findByEmail = (catalystApp, email) =>
  datastore.findBy(catalystApp, USERS, 'email_normalized', normalizeEmail(email), USER_COLUMNS);

const findById = (catalystApp, userId) =>
  datastore.findBy(catalystApp, USERS, 'user_id', userId, USER_COLUMNS);

/**
 * Create a user, or return the existing one if a concurrent request won.
 *
 * The unique constraint on `email_normalized` is what makes this safe: two
 * simultaneous signups both find nothing, both insert, and exactly one insert
 * fails. Catching that failure and re-reading is the correction. A check-then-
 * insert without the constraint would produce two accounts for one person, and
 * the second would be the one nobody can sign into.
 */
async function findOrCreate(catalystApp, { email, firstName, userType = 'member', status = 'active' }) {
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
      last_login_at: null,
      crm_contact_id: null,
    });
  } catch (err) {
    // Lost the race — or a genuine failure. Re-reading distinguishes them:
    // if a row is now present, the constraint did its job.
    const raced = await findByEmail(catalystApp, normalized);
    if (raced) return { user: raced, created: false };
    throw err;
  }

  const user = await findById(catalystApp, userId);
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

/** Best-effort — a missing last_login_at is not worth failing a login over. */
async function touchLastLogin(catalystApp, user) {
  try {
    await datastore.updateRow(catalystApp, USERS, {
      ROWID: user.ROWID, last_login_at: datastore.nowDb(),
    });
  } catch { /* ignore */ }
}

module.exports = {
  USERS, IDENTITIES, USER_COLUMNS,
  normalizeEmail, isEmail, firstNameFrom,
  findByEmail, findById, findOrCreate,
  linkIdentity, findByIdentity, touchLastLogin,
};
