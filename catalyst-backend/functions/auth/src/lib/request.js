'use strict';

/**
 * Facts about the caller, extracted once and consistently.
 *
 * Two hops sit between the browser and this function (Vercel's proxy and
 * Catalyst's gateway), so "the client's IP" is a question with several possible
 * answers, and picking the wrong one silently breaks rate limiting.
 */

/**
 * Best available client IP.
 *
 * Order matters. `x-vercel-forwarded-for` is set by Vercel itself and overwrites
 * anything the client sent, so it is the only header here that a caller cannot
 * forge while travelling through the proxy. `x-real-ip` and the leftmost
 * `x-forwarded-for` entry are fallbacks for a request that reached Catalyst
 * directly, and those a caller *can* forge.
 *
 * That is tolerable because of what an IP is and is not used for here. It feeds
 * rate limiting and `ip_hash` forensics; it never grants access. Someone
 * spoofing the header can evade their own rate limit, which is precisely why
 * the per-challenge `attempts` counter, not the IP limit, is the primary defence
 * against guessing an OTP.
 */
function clientIp(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  return first(req.headers['x-vercel-forwarded-for'])
      || first(req.headers['x-real-ip'])
      || first(req.headers['x-forwarded-for'])
      || req.ip
      || '';
}

/** `sessions.user_agent` and `auth_events.user_agent` are Var Char 255. */
const userAgent = (req) => String(req.headers['user-agent'] || '').slice(0, 255);

/**
 * The origin a non-GET request claims to come from.
 *
 * `Origin` is the header to trust: browsers set it on every cross-origin
 * request and on same-origin non-GET requests, and script cannot override it.
 * `Referer` is the fallback for the handful of older clients that omit Origin:
 * weaker, since it can be suppressed, but suppressed is not the same as forged,
 * and a request with neither is rejected rather than assumed safe.
 */
function claimedOrigin(req) {
  if (req.headers.origin) return String(req.headers.origin);
  const ref = req.headers.referer;
  if (!ref) return null;
  try { return new URL(String(ref)).origin; } catch { return null; }
}

module.exports = { clientIp, userAgent, claimedOrigin };
