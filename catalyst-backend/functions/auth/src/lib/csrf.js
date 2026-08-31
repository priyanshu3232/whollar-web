'use strict';

/**
 * CSRF defence: an Origin allowlist on every state-changing request.
 *
 * WHY NOT A CSRF TOKEN. The usual answer is a token in a custom header, but a
 * custom header makes a request non-simple and triggers a CORS preflight, and
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
 * Three exemptions, each because the route carries a stronger check than an
 * origin match rather than a weaker one.
 *
 * The OAuth callback: the visitor arrives back on it by top-level navigation
 * from the provider, so whatever Origin the browser attaches is a third party
 * that could never appear in our allowlist. The route's own defence is a
 * single-use `state` row, looked up and deleted in one operation, so a
 * replayed or forged callback finds no row.
 *
 * POST /u/:token, the unsubscribe: the token is the authorisation. Sixteen
 * checked characters, no identity encoded in it, and RFC 8058 requires the
 * one-click POST to work from a mail client that sends no Origin this
 * function could ever recognise. A forger who has the token can already open
 * the page and press the button by hand.
 * The pattern is the STRICT token shape, not the lenient one optoken.normalize
 * accepts: a hyphenated or lowercased token still opens the page, and the
 * page's form posts the canonical form back. Widening this to match the
 * leniency would widen a CSRF exemption to buy nothing.
 *
 * POST /hooks/zeptomail, the delivery webhook: a shared secret compared in
 * constant time, and no session is involved at all.
 */
const EXEMPT = [
  /^\/(auth\/)?google\/callback$/,
  /^\/(auth\/)?u\/[A-Za-z0-9]+$/,
  /^\/(auth\/)?hooks\/zeptomail$/,
];

/**
 * A fourth exemption, and it is CONDITIONAL, which none of the three above is.
 *
 * POST /admin/notify/tick is what Catalyst Job Scheduling calls to sweep for
 * due reminders and drain the outbox. A timer sends no Origin and no Referer,
 * so an unconditional origin check refuses every run, and the failure is the
 * quiet kind: the job reports a 403, nobody reads the job's run history, and
 * the reminder lane simply never fires.
 *
 * But the route ALSO accepts an admin session, and exempting it outright would
 * mean a page on any origin could make a signed-in admin's browser trigger a
 * send. So the exemption is granted only when the request carries the
 * `x-cron-secret` header at all. That is safe for a reason worth stating: a
 * custom header makes a cross-origin request non-simple, so the browser sends
 * a CORS preflight first, and the Catalyst gateway answers preflight without
 * CORS headers, so the browser refuses to send the real request. A forger in a
 * browser therefore cannot set this header, and anything that can set it is
 * not a browser and has to know the secret anyway.
 *
 * The header only has to be PRESENT here. Whether it is correct is settled in
 * constant time by requireTickCaller in routes/notify.js, which is where a
 * secret comparison belongs.
 */
const TICK = /^\/(auth\/)?admin\/notify\/tick$/;

function isExempt(req) {
  const path = req.path;
  if (EXEMPT.some((re) => re.test(path))) return true;
  return TICK.test(path) && Boolean(req.headers['x-cron-secret']);
}

function middleware(cfg) {
  const allowed = new Set(cfg.ALLOWED_ORIGINS);

  return function checkOrigin(req, res, next) {
    if (SAFE_METHODS.has(req.method) || isExempt(req)) return next();

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
