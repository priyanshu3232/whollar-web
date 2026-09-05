'use strict';

/**
 * The suppression list: the addresses nothing may be sent to, and why.
 *
 * THIS IS THE PIECE THE SITE HAS BEEN PROMISING AND NOT HAVING. Four signup
 * surfaces tell people they can unsubscribe at any time and privacy.html says
 * every message carries an easy way to. Until this module there was no list,
 * so a withdrawal could not have been honoured even if somebody had asked for
 * one, and a hard bounce was retried forever.
 *
 * THE ASYMMETRY, and it is deliberate.
 *
 *   hard_bounce, complaint     block everything, transactional included
 *   unsubscribed_all, manual   block cem only
 *
 * A complaint means a person pressed "this is spam". Continuing to send them
 * sign-in codes after that is how a sending domain gets filtered, and the
 * damage lands on every other member's ability to log in. A hard bounce means
 * the address does not exist, so a transactional send to it is not a service,
 * it is a bounce loop. Both raise an operator alert when the recipient is an
 * active account, because a member who cannot receive a code cannot sign in
 * and needs a human, not a retry.
 *
 * FAIL CLOSED FOR CEM, OPEN FOR TRANSACTIONAL. If this table is unreadable we
 * do not know whether an address opted out. Sending a commercial message on
 * that guess is a CASL breach; withholding a sign-in code on it is a locked
 * door. So an unreadable list blocks cem and lets transactional through, and
 * says so loudly in the log either way.
 */

const datastore = require('../datastore');

const TABLE = 'email_suppressions';
const COLUMNS = Object.freeze(['email', 'reason', 'source', 'first_seen_at', 'last_seen_at']);

const REASONS = Object.freeze(['hard_bounce', 'complaint', 'unsubscribed_all', 'manual']);
/** The two that stop a transactional send as well. */
const BLOCK_ALL = Object.freeze(['hard_bounce', 'complaint']);

const norm = (email) => String(email || '').trim().toLowerCase().slice(0, 255);

/**
 * What the list says about one address.
 *   -> { listed: false }
 *    | { listed: true, reason, blocksTransactional }
 *    | { unknown: true }   the table could not be read
 */
async function lookup(catalystApp, email) {
  const key = norm(email);
  if (!key) return { listed: false };
  try {
    const row = await datastore.findBy(catalystApp, TABLE, 'email', key, ['ROWID'].concat(COLUMNS));
    if (!row) return { listed: false };
    return {
      listed: true,
      reason: row.reason,
      blocksTransactional: BLOCK_ALL.includes(String(row.reason)),
      row,
    };
  } catch {
    return { unknown: true };
  }
}

/**
 * May this message go to this address?
 *   -> { allowed: true } | { allowed: false, why }
 */
async function allows(catalystApp, email, caslClass) {
  const s = await lookup(catalystApp, email);
  if (s.unknown) {
    if (caslClass === 'cem') {
      console.error(JSON.stringify({
        level: 'error',
        message: 'suppression list unreadable: refusing a commercial send',
        table: TABLE,
      }));
      return { allowed: false, why: 'suppression_list_unreadable' };
    }
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'suppression list unreadable: allowing a transactional send',
      table: TABLE,
    }));
    return { allowed: true };
  }
  if (!s.listed) return { allowed: true };
  if (caslClass === 'cem') return { allowed: false, why: `suppressed:${s.reason}` };
  return s.blocksTransactional
    ? { allowed: false, why: `suppressed:${s.reason}` }
    : { allowed: true };
}

/**
 * Add or refresh a suppression. Idempotent: a second complaint on the same
 * address moves `last_seen_at` and leaves the original reason alone, because
 * the first reason is the one that explains the block.
 *
 * One exception: a soft reason is upgraded by a hard one. An address that
 * unsubscribed and later hard bounces is a dead address, and recording it as
 * merely unsubscribed would keep sending it sign-in codes.
 */
async function add(catalystApp, { email, reason, source }) {
  const key = norm(email);
  if (!key) return null;
  if (!REASONS.includes(reason)) throw new Error(`suppress: unknown reason ${reason}`);
  const now = datastore.nowDb();

  let existing = null;
  try {
    existing = await datastore.findBy(catalystApp, TABLE, 'email', key, ['ROWID', 'reason']);
  } catch {
    /* Table missing. The insert below reports it properly. */
  }

  if (existing) {
    const upgrade = BLOCK_ALL.includes(reason) && !BLOCK_ALL.includes(String(existing.reason));
    await datastore.updateRow(catalystApp, TABLE, {
      ROWID: existing.ROWID,
      last_seen_at: now,
      ...(upgrade ? { reason, source: String(source || '').slice(0, 120) } : {}),
    });
    return { ...existing, upgraded: upgrade };
  }

  await datastore.insertRow(catalystApp, TABLE, {
    email: key,
    reason,
    source: String(source || '').slice(0, 120),
    first_seen_at: now,
    last_seen_at: now,
  });
  return { email: key, reason, created: true };
}

/**
 * Lift a suppression. Operator only, and it is the one write here that can
 * hurt: re-enabling a complained-about address sends mail to somebody who
 * pressed the spam button. The route that calls this requires a reason.
 */
async function remove(catalystApp, email) {
  const key = norm(email);
  if (!key) return false;
  const row = await datastore.findBy(catalystApp, TABLE, 'email', key, ['ROWID']);
  if (!row) return false;
  await datastore.deleteRow(catalystApp, TABLE, row.ROWID);
  return true;
}

/** Every suppression, newest last seen first. For the operator's list. */
async function list(catalystApp, { limit = 200 } = {}) {
  const rows = await datastore.queryAll(catalystApp, TABLE, COLUMNS, 'ROWID > 0');
  return (rows || [])
    .sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))
    .slice(0, limit);
}

module.exports = { TABLE, COLUMNS, REASONS, BLOCK_ALL, norm, lookup, allows, add, remove, list };
