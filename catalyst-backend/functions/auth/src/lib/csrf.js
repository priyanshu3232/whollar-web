'use strict';

/**
 * CSRF defence: an Origin allowlist on every state-changing request.
 *
 * WHY NOT A CSRF TOKEN. The usual answer is a token in a custom header, but a
 * custom header makes a request non-simple and triggers a CORS preflight — and
 * `js/whollar-core.js` records that the Catalyst gateway answers preflight
 * itself, without CORS headers. Requests to this function therefore have to
 * stay preflight-free, which rules out `X-CSRF-Token`.
 *
 * WHY THIS IS ENOUGH. Two independent controls have to fail together:
 *
 *   1. `SameSite=Lax` on the session cookie means a cross-site POST does not
 *      carry the cookie at all, so a forged request arrives unauthenticated.
 *   2. This check: browsers set `Origin` on every non-GET request and script
 *      cannot override it, so a forged request announces where it came from.
 *
 * A request with no usable origin is REJECTED, not waved through. "Absent" is
 * the state an attacker can most easily produce, so defaulting to allow would
 * hand them the bypass.
 *
 * Verified empirically against the live proxy before this was written: Origin
 * and Referer both survive the Vercel hop intact.
 */

const { forbidden } = require('./errors');
const { claimedOrigin } = require('./request');

/** GET/HEAD/OPTIONS must stay side-effect free, so they need no origin check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * OAuth callbacks are the one legitimate exception.
 *
 * Apple returns the user by POSTing a form from `appleid.apple.com`, so its
 * Origin is genuinely a third party and could never appear in our allowlist.
 * That is safe here because those routes carry their own, stronger defence: a
 * single-use `state` row that is looked up and deleted in one operation. A
 * replayed or forged callback finds no row and is rejected — which is a
 * stricter test than an origin match, not a weaker one.
 */
const EXEMPT = [/^\/(auth\/)?(google|apple)\/callback$/];

function isExempt(path) {
  return EXEMPT.some((re) => re.test(path));
}

function middleware(cfg) {
  const allowed = new Set(cfg.ALLOWED_ORIGINS);

  return function checkOrigin(req, res, next) {
    if (SAFE_METHODS.has(req.method) || isExempt(req.path)) return next();

    const origin = claimedOrigin(req);

    if (!origin) {
      return next(forbidden('That request could not be verified. Please reload the page and try again.', {
        logDetail: `no Origin or Referer on ${req.method} ${req.path}`,
      }));
    }
    if (!allowed.has(origin)) {
      return next(forbidden('That request could not be verified. Please reload the page and try again.', {
        // The origin is attacker-supplied but not a secret, and knowing which
        // origin was rejected is the whole diagnostic value of this line.
        logDetail: `origin not allowed: ${origin.slice(0, 200)}`,
      }));
    }
    return next();
  };
}

module.exports = { middleware, isExempt, SAFE_METHODS };
