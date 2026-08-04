'use strict';

/**
 * Per-account preferences: one JSON blob per user in `user_prefs`.
 *
 * Members and providers share the table: a preference is a fact about the
 * person, and the keys inside the blob ('alerts', 'interests', 'notify') are
 * namespaced by what each dashboard writes. Reads degrade to {} when the table
 * is missing, so the toggles render their defaults; writes throw, because a
 * toggle that says "saved" over a write that went nowhere is the exact lie
 * this feature replaces.
 */

const datastore = require('./datastore');
const { AppError } = require('./errors');

const TABLE = 'user_prefs';
const MAX_JSON = 4000;

/** The stored preferences for a user, or {} - missing row and missing table alike. */
async function get(catalystApp, userId) {
  try {
    const row = await datastore.findBy(catalystApp, TABLE, 'pref_key', userId, ['ROWID', 'prefs']);
    if (!row || !row.prefs) return {};
    const parsed = JSON.parse(row.prefs);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the stored blob and return the result. Top-level keys
 * only: the caller sends whole values for the keys it owns. Throws a clear
 * "not available" when the table is missing rather than a generic 500.
 */
async function merge(catalystApp, userId, patch) {
  const current = await get(catalystApp, userId);
  const next = { ...current, ...patch };
  const json = JSON.stringify(next);
  if (json.length > MAX_JSON) {
    throw new AppError('VALIDATION_ERROR', 'Those preferences are too large to save.');
  }

  try {
    const row = await datastore.findBy(catalystApp, TABLE, 'pref_key', userId, ['ROWID']);
    if (row) {
      await datastore.updateRow(catalystApp, TABLE, {
        ROWID: row.ROWID, prefs: json, updated_at: datastore.nowDb(),
      });
    } else {
      await datastore.insertRow(catalystApp, TABLE, {
        pref_key: userId, prefs: json, updated_at: datastore.nowDb(),
      });
    }
  } catch (err) {
    throw new AppError('SERVER_ERROR',
      'Preferences are not available right now. Please try again shortly.', {
        logDetail: `user_prefs write failed: ${String((err && err.message) || err).slice(0, 200)}`,
      });
  }
  return next;
}

module.exports = { TABLE, get, merge };
