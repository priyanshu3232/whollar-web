/* Session revalidation, and the two rules that matter about it.
 *
 * The local record proves nothing: it is writable from a browser console and
 * it can outlive the cookie. A definite 401 means the session is gone and the
 * console must stop painting.
 *
 * A NETWORK FAILURE IS NOT THAT, and must never sign anyone out. The provider
 * session is 12 hours and does not roll, so a partner who loses wifi for
 * thirty seconds mid-afternoon would otherwise be thrown back to a login form
 * and have to start again. scripts/qa-console.mjs asserts both halves: group 4
 * that a definite 401 signs the tab out, group 5 that a network failure does
 * not. Group 5 is the one that matters.
 *
 * A 403 IS NOT THAT EITHER, and this is the second rule because getting it
 * wrong looked exactly like a broken login. Half the console sits behind
 * requireApproved, so an org still under review answers 403 on the routes it
 * cannot use yet: declaring coverage, placing a bid, reading statements or the
 * delivery board. Bouncing on that signed a partner out of the console they
 * had just signed into, mid-click, with no error they could read. It is a page
 * state and the view that made the call owns it. Billing and delivery each
 * carried a private 401-only copy of this helper for that reason; coverage did
 * not, which is how POST /provider/coverage came to log people out. One rule
 * here instead of three copies and a gap.
 *
 * The single exception is revalidate() below, where the read is /provider/me:
 * that route refuses a non-partner with 403, and someone who is not a partner
 * has no console to be left sitting in.
 */

import { api } from './api.js';
import { check } from './contract.js';
import { set } from './state.js';

export function isAuthError(err) {
  return !!err && (err.status === 401 || err.code === 'UNAUTHENTICATED');
}

/** Send them to sign in, carrying where they were so they come back here. */
export function bounce() {
  var W = window.WHOLLAR;
  if (W && W.partner) W.partner.clear();
  location.replace('/whollar-login-provider?next=' + encodeURIComponent(location.pathname + location.hash));
}

/**
 * Bounce only on a definite auth failure. Anything else, a 403 from an
 * approval gate included, is left to the caller to render.
 */
export function authFailed(err) {
  if (isAuthError(err)) bounce();
  return isAuthError(err);
}

/**
 * Re-read who this is from the server and update the store.
 *
 * Called on boot and on every return to the tab, so a session that expired
 * while the partner was elsewhere is caught on return rather than on their
 * next click, halfway through writing a bid.
 */
export function revalidate() {
  return api.me().then(function (r) {
    check('providerMe', r);
    set({
      user: r.user || null,
      org: r.org || null,
      approved: r.approved === true,
      role: (r.org && r.org.role) || null
    });
    return r;
  }, function (err) {
    /* The one place 403 still bounces: /provider/me answers it for a signed-in
       account that is not a partner at all, and there is no partner console to
       leave them in. Everywhere else 403 means "not yet approved for this",
       which is a screen, not a sign-out. */
    if (isAuthError(err) || (err && err.status === 403)) { bounce(); return null; }
    /* Offline or backend down. The chrome already has the local record, so
       leave it up rather than blanking a console over one failed poll. */
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[whollar] provider/me failed:', err && err.message);
    }
    return null;
  });
}

export function mount() {
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') revalidate();
  });
}
