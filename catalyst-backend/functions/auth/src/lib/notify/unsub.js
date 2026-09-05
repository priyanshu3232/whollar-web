'use strict';

/**
 * Unsubscribe tokens, and the two ways one gets used.
 *
 * TWO PATHS, ONE EFFECT.
 *
 *   GET  /u/:token   a one-tap confirmation page, no sign-in required
 *   POST /u/:token   applies it, from that page or from the RFC 8058
 *                    List-Unsubscribe-Post header, where the mail client
 *                    presses the button on the reader's behalf and never
 *                    renders a page at all
 *
 * NO SIGN-IN, deliberately. Requiring a login to stop email is the pattern
 * CASL's ten-business-day rule exists to punish, and a person who has decided
 * they want no more mail is the last person who should be asked for a
 * password. The token is the authorisation, which is why it is sixteen
 * checked characters and carries no identity.
 *
 * TOKENS ARE PER RECIPIENT AND PER SCOPE, NOT PER MESSAGE. Minting a fresh row
 * for every email would put millions of rows in a table whose only job is a
 * lookup, and it would mean an old email's link stopped working, which is
 * exactly when people use them. One row per (recipient, scope), reused, and
 * `used_at` records the first time it was pressed rather than burning it.
 *
 * SCOPE. `all_cem` stops every commercial electronic message. A category
 * scope stops one. Category preferences live in `user_prefs.notify`, the blob
 * lib/prefs.js already owns, so a category unsubscribe writes there and the
 * dashboard's own settings card reads the same value. Address-level blocks
 * live in `email_suppressions`. Two stores, two different questions: "does
 * this person want this kind of mail" and "may this address be written to at
 * all".
 */

const datastore = require('../datastore');
const optoken = require('./optoken');
const prefs = require('../prefs');
const users = require('../users');
const suppress = require('./suppress');
const registry = require('./registry');

const TABLE = 'unsubscribe_tokens';
const COLUMNS = Object.freeze(['token', 'recipient_type', 'recipient_id', 'scope',
  'created_at', 'used_at']);

const ALL = 'all_cem';

/** Scopes a token may carry: everything commercial, or one category. */
function validScope(scope) {
  if (scope === ALL) return true;
  const c = registry.CATEGORIES[scope];
  return Boolean(c) && !c.locked;
}

const keyFor = (recipientType, recipientId, scope) =>
  `${recipientType}:${recipientId}:${scope}`.slice(0, 200);

/**
 * The token for this recipient and scope, minting one if there is none.
 *
 * Returns null rather than throwing when the table is missing: a missing
 * unsubscribe table must not stop a transactional send, and the caller
 * refuses the cem send on the same null.
 */
async function tokenFor(catalystApp, { recipientType, recipientId, scope = ALL }) {
  if (!validScope(scope)) throw new Error(`unsub: bad scope ${scope}`);
  const key = keyFor(recipientType, recipientId, scope);
  try {
    const existing = await datastore.findBy(catalystApp, TABLE, 'token_key', key, ['ROWID', 'token']);
    if (existing && existing.token) return existing.token;
  } catch {
    return null;
  }
  const token = optoken.generate();
  try {
    await datastore.insertRow(catalystApp, TABLE, {
      token_key: key,
      token,
      recipient_type: recipientType,
      recipient_id: recipientId,
      scope,
      created_at: datastore.nowDb(),
    });
    return token;
  } catch {
    /* Lost a race on the unique key: the winner's row is the answer. */
    try {
      const row = await datastore.findBy(catalystApp, TABLE, 'token_key', key, ['token']);
      return (row && row.token) || null;
    } catch {
      return null;
    }
  }
}

/** Resolve a token to its row, or null. Validates the shape before querying. */
async function resolve(catalystApp, raw) {
  const token = optoken.normalize(raw);
  if (!token) return null;
  try {
    const row = await datastore.findBy(catalystApp, TABLE, 'token',
      token, ['ROWID'].concat(COLUMNS));
    return row || null;
  } catch {
    return null;
  }
}

/**
 * Apply an unsubscribe. Idempotent: pressing the link twice is the same as
 * pressing it once, and the second press must not error, because a mail
 * client retrying a List-Unsubscribe-Post is normal.
 *
 * Applies IMMEDIATELY, well inside CASL's ten business days. No confirmation
 * email is sent: another email to somebody who just asked for fewer is the
 * wrong answer, and the page confirms instead.
 */
async function apply(catalystApp, row, { source = 'link' } = {}) {
  if (!row) return { ok: false, why: 'unknown_token' };
  const scope = String(row.scope || ALL);

  if (scope === ALL) {
    /* Address level as well as preference level, because `all_cem` has to
       hold even for a person whose account is later deleted and whose
       preference blob goes with it. The address is looked up rather than
       stored on the token row: one copy of an email address is enough, and
       the row is already a mapping to the account that owns it. */
    const email = await emailFor(catalystApp, row);
    if (email) {
      await suppress.add(catalystApp, {
        email,
        reason: 'unsubscribed_all',
        source: `unsub:${source}`,
      });
    }
    await setCategory(catalystApp, row, null, false);
  } else {
    await setCategory(catalystApp, row, scope, false);
  }

  try {
    if (!row.used_at) {
      await datastore.updateRow(catalystApp, TABLE, {
        ROWID: row.ROWID, used_at: datastore.nowDb(),
      });
    }
  } catch {
    /* The stamp is a convenience. The preference write is the fact. */
  }

  return { ok: true, scope };
}

/** The address behind a token row, or null. Never stored on the row itself. */
async function emailFor(catalystApp, row) {
  if (row.recipient_type !== 'member' && row.recipient_type !== 'partner') return null;
  try {
    const u = await users.findById(catalystApp, row.recipient_id);
    return (u && u.email_normalized) || null;
  } catch {
    return null;
  }
}

/**
 * Write one category, or every unlockable category, into `user_prefs.notify`.
 *
 * The blob is the store the member dashboard's own settings card reads, so an
 * unsubscribe pressed in a mail client shows up as an off toggle on the
 * dashboard without a second source of truth. A locked category is never
 * written: security and account mail have no off switch, and offering one in
 * a link would be a promise the system cannot keep.
 */
async function setCategory(catalystApp, row, category, enabled) {
  if (row.recipient_type !== 'member' && row.recipient_type !== 'partner') return;
  const patch = {};
  if (category) {
    if (registry.CATEGORIES[category] && registry.CATEGORIES[category].locked) return;
    patch[category] = Boolean(enabled);
  } else {
    for (const [name, meta] of Object.entries(registry.CATEGORIES)) {
      if (meta.locked) continue;
      if (meta.casl !== 'cem') continue;
      patch[name] = Boolean(enabled);
    }
  }
  const current = await prefs.get(catalystApp, row.recipient_id);
  const notify = Object.assign({}, current.notify || {}, patch);
  await prefs.merge(catalystApp, row.recipient_id, { notify });
}

/**
 * Does this recipient want this category?
 *
 * Default is ON for transactional categories and OFF for cem, which is the
 * only defensible default under CASL: express consent has to be given, never
 * assumed, and a status email about a cohort somebody joined is a service
 * they asked for.
 */
async function wants(catalystApp, { recipientType, recipientId }, category) {
  const meta = registry.CATEGORIES[category];
  if (!meta) return false;
  if (meta.locked) return true;
  if (recipientType !== 'member' && recipientType !== 'partner') return true;
  const blob = await prefs.get(catalystApp, recipientId);
  const notify = (blob && blob.notify) || {};
  if (Object.prototype.hasOwnProperty.call(notify, category)) return Boolean(notify[category]);
  return meta.casl !== 'cem';
}

module.exports = {
  TABLE, COLUMNS, ALL, validScope, keyFor,
  tokenFor, resolve, apply, setCategory, wants, emailFor,
};
