'use strict';

/**
 * The response envelope, and the clock that rides on it.
 *
 * WHY EVERY RESPONSE CARRIES serverTime. The partner console renders
 * countdowns to bid deadlines, and a bid placed one second after close is a
 * different outcome from one placed one second before. If the browser reads
 * its own clock, a machine a few minutes fast shows a partner a window that is
 * already shut, or worse, one that looks open when it is not. So the server
 * states the time, on every payload, and the console offsets from it. There is
 * no separate GET /time: a clock fetched on its own is a clock that can be
 * stale by the time the payload it describes arrives.
 *
 * EPOCH MILLISECONDS, NOT THE DB STRING. lib/datastore.js documents at length
 * that Catalyst hands dates back as `YYYY-MM-DD HH:MM:SS` with no zone marker
 * even though they are UTC, so `new Date(s)` shifts by the reader's offset.
 * Sending that string to a browser would reproduce, in every client, the bug
 * the datastore module already fixed once. An integer cannot be misread.
 *
 * Timestamps INSIDE payloads follow the same rule: `ms()` converts a stored
 * column to epoch milliseconds at the edge, so no consumer ever sees the
 * ambiguous string.
 */

const datastore = require('./datastore');

/**
 * Send a success payload with the server clock attached.
 *
 *   return ok(res, { campaigns });
 *
 * `ok: true` is kept because every existing route sends it and the front end
 * checks for it.
 */
function ok(res, payload) {
  return res.json(Object.assign({ ok: true, serverTime: Date.now() }, payload || {}));
}

/**
 * A stored datetime column as epoch milliseconds, or null.
 * Use at every boundary where a stored date becomes part of a payload.
 */
function ms(dbValue) {
  const d = datastore.fromDb(dbValue);
  return d ? d.getTime() : null;
}

module.exports = { ok, ms };
