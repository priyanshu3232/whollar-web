'use strict';

/**
 * Sign in with Google — Authorization Code + PKCE.
 *
 *   GET /google/start     -> 302 to Google
 *   GET /google/callback  -> exchange, verify, link, session, 302 to the app
 *
 * Both are GETs because both are top-level browser navigations. That is also
 * why they are exempt from the Origin check in lib/csrf.js: the callback's
 * defence is the single-use `state` row, which is stricter than an origin
 * match, not weaker.
 */

const { wrap } = require('../lib/errors');
const oidc = require('../lib/oidc');
const users = require('../lib/users');
const sessions = require('../lib/sessions');
const consents = require('../lib/consents');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
// Google is inconsistent about the scheme on `iss`, and always has been. Both
// are legitimate; accepting only one rejects a share of real logins.
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Failures redirect to the login page with a code rather than rendering an
 * error. The user is mid-navigation in a browser; a JSON body would be a dead
 * end with no way back.
 */
function fail(res, cfg, reason) {
  const url = `${cfg.APP_BASE_URL}/whollar-login-consumer?error=${encodeURIComponent(reason)}`;
  res.redirect(302, url);
}

function mount(router, cfg) {
  router.get('/google/start', wrap(async (req, res) => {
    /**
     * Unconfigured is answered with a redirect, not the 501 the other feature
     * groups use. Both of these routes are top-level browser navigations, so a
     * JSON body would strand the visitor on a raw error page with no way back —
     * the same reason `fail()` exists below. The login page renders this code
     * as "Google sign-in isn't available right now" and its email form is still
     * there underneath.
     */
    if (!cfg.FEATURES.google) return fail(res, cfg, 'google_unavailable');

    await ratelimit.enforce(req.catalyst, req, {
      key: 'google.start.ip', max: 30, windowSec: 3600,
    });

    const redirectTo = oidc.safeRedirect(req.query.next, '/dashboard');
    const flow = await oidc.beginFlow(req.catalyst, { provider: 'google', redirectTo });

    const params = oidc.formEncode({
      client_id: cfg.GOOGLE_CLIENT_ID,
      redirect_uri: cfg.GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: flow.challenge,
      code_challenge_method: 'S256',
      // Ask for an account choice every time. Without it a shared device
      // silently reuses whoever signed in last, which on a household product
      // is the wrong default.
      prompt: 'select_account',
    });

    audit.recordAsync(req.catalyst, req, { type: 'google.start', outcome: 'success' });
    res.redirect(302, `${AUTH_ENDPOINT}?${params}`);
  }));

  router.get('/google/callback', wrap(async (req, res) => {
    // Same reasoning as /google/start: a navigation, so a redirect. Reaching
    // here with the group switched off means it was turned off mid-flow.
    if (!cfg.FEATURES.google) return fail(res, cfg, 'google_unavailable');

    // Google reports user-side refusals here rather than by not calling back.
    if (req.query.error) {
      audit.recordAsync(req.catalyst, req, {
        type: 'google.callback', outcome: 'failure',
        detail: { provider_error: String(req.query.error).slice(0, 100) },
      });
      return fail(res, cfg, 'google_cancelled');
    }

    const flow = await oidc.consumeFlow(req.catalyst, {
      state: req.query.state, provider: 'google',
    });
    if (!flow) {
      audit.recordAsync(req.catalyst, req, {
        type: 'google.callback', outcome: 'failure', detail: { reason: 'bad_or_replayed_state' },
      });
      return fail(res, cfg, 'expired');
    }

    const code = String(req.query.code || '');
    if (!code) return fail(res, cfg, 'expired');

    // Back-channel exchange. The verifier never left this server, so a stolen
    // `code` alone cannot be redeemed.
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: oidc.formEncode({
        code,
        client_id: cfg.GOOGLE_CLIENT_ID,
        client_secret: cfg.GOOGLE_CLIENT_SECRET,
        redirect_uri: cfg.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: flow.pkce_verifier,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => '');
      audit.recordAsync(req.catalyst, req, {
        type: 'google.callback', outcome: 'failure',
        detail: { reason: 'token_exchange_failed', status: tokenRes.status, body: body.slice(0, 200) },
      });
      return fail(res, cfg, 'google_failed');
    }

    const tokens = await tokenRes.json();
    if (!tokens.id_token) return fail(res, cfg, 'google_failed');

    let claims;
    try {
      claims = await oidc.verifyIdToken(tokens.id_token, {
        jwksUri: JWKS_URI,
        issuer: ISSUERS,
        audience: cfg.GOOGLE_CLIENT_ID,
        nonce: flow.nonce,
        algorithms: ['RS256'],
      });
    } catch (err) {
      audit.recordAsync(req.catalyst, req, {
        type: 'google.callback', outcome: 'failure',
        detail: { reason: 'id_token_invalid', detail: String(err && err.logDetail) },
      });
      return fail(res, cfg, 'google_failed');
    }

    const email = users.normalizeEmail(claims.email);
    const sub = String(claims.sub || '');
    if (!sub || !users.isEmail(email)) return fail(res, cfg, 'google_failed');

    /**
     * An unverified Google address is refused.
     *
     * Google will hand back addresses it has not confirmed the holder owns.
     * Accepting one lets somebody take over an existing Whollar account simply
     * by putting that address on a fresh Google account — the identity is
     * linked by email, so an unverified email is an unauthenticated claim.
     */
    if (claims.email_verified === false) {
      audit.recordAsync(req.catalyst, req, {
        type: 'google.callback', outcome: 'failure', email,
        detail: { reason: 'email_not_verified_at_google' },
      });
      return fail(res, cfg, 'google_unverified');
    }

    // Identity first, email second. `sub` is stable; a Google account's email
    // can change, and matching on email alone would strand the user in a new
    // account the day they rename it.
    let user = await users.findByIdentity(req.catalyst, 'google', sub);
    let created = false;

    if (!user) {
      const found = await users.findOrCreate(req.catalyst, {
        email,
        firstName: claims.given_name || claims.name || null,
        userType: 'member',
      });
      user = found.user;
      created = found.created;

      // Links a Google login to an account that already signed up by email —
      // the whole point of keeping identities in their own table.
      await users.linkIdentity(req.catalyst, {
        userId: user.user_id, provider: 'google',
        providerUid: sub, emailAtProvider: email,
      });

      if (created) {
        await consents.recordSignup(req.catalyst, req, {
          userId: user.user_id, userType: 'member',
        });
      }
    }

    if (user.status !== 'active') {
      audit.recordAsync(req.catalyst, req, {
        type: 'google.callback', outcome: 'failure', email, userId: user.user_id,
        detail: { reason: 'account_not_active', status: user.status },
      });
      return fail(res, cfg, 'account_disabled');
    }

    await users.touchLastLogin(req.catalyst, user);
    await sessions.create(req.catalyst, req, res, {
      userId: user.user_id, userType: user.user_type,
    });

    audit.recordAsync(req.catalyst, req, {
      type: created ? 'google.signup' : 'google.login',
      outcome: 'success', email, userId: user.user_id,
    });

    // The stored destination, never one echoed back by the provider.
    res.redirect(302, `${cfg.APP_BASE_URL}${oidc.safeRedirect(flow.redirect_to)}`);
  }));
}

module.exports = { mount, AUTH_ENDPOINT, TOKEN_ENDPOINT, JWKS_URI, ISSUERS };
