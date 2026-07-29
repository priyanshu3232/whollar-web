'use strict';

/**
 * Append-only writes to `auth_events`.
 *
 * This is the only production debugging tool the auth system has. There is no
 * way to reproduce "this person could not sign in last Tuesday" without it, so
 * every route writes here — on success as well as failure. A trail that only
 * records failures cannot answer "did this even reach us?", which is the first
 * question every time.
 *
 * Two rules, both enforced here rather than trusted to call sites:
 *
 *   1. NEVER write a code, token, password or raw IP. `scrub()` removes them
 *      by key name and by shape, so a caller who passes a whole request body
 *      by accident does not thereby log a password.
 *
 *   2. A failed audit write must never fail the request. Losing a log line is
 *      bad; refusing someone's login because the log line could not be written
 *      is worse. Every write is best-effort and swallows its own errors.
 */

const datastore = require('./datastore');
const { hashIp } = require('./crypto');
const { clientIp, userAgent } = require('./request');

const TABLE = 'auth_events';

/** Key names whose values never belong in a log, at any nesting depth. */
const FORBIDDEN_KEYS = /^(code|otp|token|password|pass|pwd|secret|hash|authorization|cookie|id_token|access_token|refresh_token|client_secret|pkce_verifier|verifier|state|nonce|ip)$/i;

/** Shapes that are a secret regardless of what the key is called. */
const looksSecret = (s) =>
  /^\d{6}$/.test(s) ||                       // a bare OTP
  /^[A-Fa-f0-9]{32,}$/.test(s) ||            // a digest
  /^[A-Za-z0-9_-]{40,}$/.test(s);            // a base64url token

/**
 * Recursively strip secrets. Values are replaced with a marker rather than
 * dropped, because "there was a token here" is useful and the token is not.
 */
function scrub(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = FORBIDDEN_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string') {
    if (looksSecret(value)) return '[redacted]';
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }

  return value;
}

/**
 * Write one event. Best-effort by design — see rule 2 above.
 *
 * @param {object}  catalystApp
 * @param {object}  req
 * @param {object}  event
 * @param {string}  event.type      e.g. 'otp.start', 'session.load', 'partner.login'
 * @param {'success'|'failure'} event.outcome
 * @param {string}  [event.userId]
 * @param {string}  [event.email]   normalized; the column is flagged PII
 * @param {object}  [event.detail]  scrubbed before it is written
 */
async function record(catalystApp, req, event) {
  try {
    const cfg = req.app.get('cfg');
    const ip = clientIp(req);

    await datastore.insertRow(catalystApp, TABLE, {
      event_type: String(event.type || 'unknown').slice(0, 64),
      user_id: event.userId || null,
      email_normalized: event.email || null,
      ip_hash: hashIp(ip, cfg),
      user_agent: userAgent(req),
      outcome: event.outcome === 'success' ? 'success' : 'failure',
      detail: JSON.stringify(scrub({ req_id: req.id, ...(event.detail || {}) })).slice(0, 10000),
    });
  } catch (err) {
    // Logged, never thrown. If auditing is broken we still want the request to
    // succeed, and we want to know — hence console.error rather than silence.
    console.error(JSON.stringify({
      req_id: req && req.id,
      level: 'error',
      message: 'audit write failed',
      event_type: event && event.type,
      detail: String((err && err.message) || err).slice(0, 200),
    }));
  }
}

/** Fire-and-forget: for the hot path, where awaiting a log write adds latency. */
function recordAsync(catalystApp, req, event) {
  Promise.resolve(record(catalystApp, req, event)).catch(() => {});
}

module.exports = { record, recordAsync, scrub, TABLE };
