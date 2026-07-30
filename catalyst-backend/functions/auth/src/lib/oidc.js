'use strict';

/**
 * Shared OpenID Connect machinery. Google is the only provider on it today;
 * nothing here is Google-specific, so a second one would reuse it as is.
 *
 * Authorization Code + PKCE, server-side throughout. The browser never receives
 * a token it could forge or replay; it only ever carries an opaque `code` that
 * is useless without the verifier this server kept.
 *
 * ID tokens are verified properly — signature, issuer, audience, expiry, nonce —
 * rather than merely decoded. The OIDC spec does permit trusting TLS alone when
 * a token arrives over a direct back-channel call (§3.1.3.7), and that shortcut
 * is common. It is not taken here: signature verification is the difference
 * between "we believe Google sent this" and "we can prove it", and the cost is
 * one cached HTTP call.
 */

const crypto = require('node:crypto');
const datastore = require('./datastore');
const { token, pkceChallenge } = require('./crypto');
const { badRequest, forbidden } = require('./errors');

const STATE_TABLE = 'oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * JWKS
 * ------------------------------------------------------------------ */

/**
 * Signing keys, cached in module scope for the life of the container.
 *
 * Providers rotate these, so a cache that never expires eventually rejects
 * every login. An hour is well inside Google's rotation cadence, and a miss
 * costs one request. On a verification failure the cache is
 * dropped and refetched once, which is what makes a mid-rotation login work
 * rather than fail until the TTL happens to lapse.
 */
const jwksCache = new Map();
const JWKS_TTL_MS = 60 * 60 * 1000;

async function fetchJwks(jwksUri, { force = false } = {}) {
  const hit = jwksCache.get(jwksUri);
  if (!force && hit && hit.expires > Date.now()) return hit.keys;

  const res = await fetch(jwksUri, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`jwks fetch ${res.status} from ${jwksUri}`);
  const body = await res.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(jwksUri, { keys, expires: Date.now() + JWKS_TTL_MS });
  return keys;
}

const b64urlToBuf = (s) => Buffer.from(String(s), 'base64url');

/**
 * Verify a compact JWS and return its payload.
 *
 * Algorithm is taken from OUR allowlist, never from the token's own header —
 * trusting `alg` is how `alg: none` and RS256/HMAC confusion attacks work.
 */
async function verifyIdToken(idToken, { jwksUri, issuer, audience, nonce, algorithms = ['RS256', 'ES256'] }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw badRequest('Malformed identity token.');

  const [headerB64, payloadB64, sigB64] = parts;
  let header, payload;
  try {
    header = JSON.parse(b64urlToBuf(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch {
    throw badRequest('Malformed identity token.');
  }

  if (!algorithms.includes(header.alg)) {
    throw forbidden('Sign-in failed.', { logDetail: `unexpected alg ${header.alg}` });
  }

  const verifyWith = async (force) => {
    const keys = await fetchJwks(jwksUri, { force });
    const jwk = keys.find((k) => k.kid === header.kid) || (keys.length === 1 ? keys[0] : null);
    if (!jwk) return false;

    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const sig = b64urlToBuf(sigB64);

    // ES256 signatures are raw r||s from a JWS; Node expects that shape to be
    // declared, or it will try to parse them as DER and fail on every token.
    return header.alg === 'ES256'
      ? crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
      : crypto.verify('sha256', data, key, sig);
  };

  let ok = false;
  try { ok = await verifyWith(false); } catch { ok = false; }
  // One forced refetch: the key may have rotated since the cache was filled.
  if (!ok) {
    try { ok = await verifyWith(true); } catch { ok = false; }
  }
  if (!ok) throw forbidden('Sign-in failed.', { logDetail: 'id_token signature invalid' });

  const now = Math.floor(Date.now() / 1000);
  const issuers = Array.isArray(issuer) ? issuer : [issuer];
  if (!issuers.includes(payload.iss)) {
    throw forbidden('Sign-in failed.', { logDetail: `bad iss ${payload.iss}` });
  }
  // `aud` may be a string or an array; both are legal.
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(audience)) {
    throw forbidden('Sign-in failed.', { logDetail: 'aud does not match our client id' });
  }
  // 60s of clock skew. Without it, a server a minute fast rejects valid tokens
  // intermittently — which presents as "sign-in randomly fails".
  if (typeof payload.exp !== 'number' || payload.exp + 60 < now) {
    throw forbidden('Sign-in failed.', { logDetail: 'id_token expired' });
  }
  if (typeof payload.iat === 'number' && payload.iat - 60 > now) {
    throw forbidden('Sign-in failed.', { logDetail: 'id_token issued in the future' });
  }
  // The nonce ties this token to the authorization request WE started. Without
  // it, a token minted for another session of ours could be replayed here.
  if (nonce && payload.nonce !== nonce) {
    throw forbidden('Sign-in failed.', { logDetail: 'nonce mismatch' });
  }

  return payload;
}

/* ------------------------------------------------------------------ *
 * state / nonce / PKCE
 * ------------------------------------------------------------------ */

/**
 * Begin an authorization request: mint the one-time values and persist them.
 *
 * `redirectTo` is validated by the caller before it reaches here, and is stored
 * rather than round-tripped through the provider so a tampered callback URL
 * cannot redirect the user off-site after a successful login.
 */
async function beginFlow(catalystApp, { provider, redirectTo }) {
  const state = token(32);
  const nonce = token(32);
  const verifier = token(32);

  await datastore.insertRow(catalystApp, STATE_TABLE, {
    state,
    pkce_verifier: verifier,
    nonce,
    redirect_to: String(redirectTo || '/dashboard').slice(0, 255),
    provider,
    expires_at: datastore.inMsDb(STATE_TTL_MS),
  });

  return { state, nonce, verifier, challenge: pkceChallenge(verifier) };
}

/**
 * Consume the state row. Look up AND delete in one operation.
 *
 * This row *is* the CSRF defence for the callback, so the two cannot be
 * separate steps: any gap between them is a window in which a replayed callback
 * still finds the row. Returns null on anything suspect — no row, wrong
 * provider, or expired — and the caller must treat all three identically.
 */
async function consumeFlow(catalystApp, { state, provider }) {
  if (!state || typeof state !== 'string' || state.length > 255) return null;

  let row;
  try {
    row = await datastore.takeOnce(
      catalystApp, STATE_TABLE, 'state', state,
      ['state', 'pkce_verifier', 'nonce', 'redirect_to', 'provider', 'expires_at']
    );
  } catch {
    // A state value outside lit()'s charset throws rather than matching. That
    // is a forged callback, and it is indistinguishable from an unknown one.
    return null;
  }
  if (!row) return null;
  if (row.provider !== provider) return null;
  if (datastore.isExpired(row.expires_at)) return null;
  return row;
}

/** Only ever a same-origin path — the open-redirect guard, server side. */
function safeRedirect(raw, fallback = '/dashboard') {
  if (!raw) return fallback;
  const s = String(raw);
  // Must start with a single slash. `//evil.com` and `/\evil.com` are both
  // read as protocol-relative URLs by browsers.
  if (!/^\/[^/\\]/.test(s)) return fallback;
  if (s.length > 255) return fallback;
  return s;
}

const formEncode = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

module.exports = {
  STATE_TABLE, STATE_TTL_MS,
  fetchJwks, verifyIdToken,
  beginFlow, consumeFlow, safeRedirect, formEncode,
};
