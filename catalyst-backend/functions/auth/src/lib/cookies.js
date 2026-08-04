'use strict';

/**
 * The session cookie: one name, one set of attributes, one place to change them.
 *
 * Written by hand rather than through `res.cookie()` so that every attribute is
 * visible in one place and none of them can be quietly dropped by a helper's
 * defaults. A missing `HttpOnly` is not the kind of thing that shows up in
 * testing.
 */

const NAME = 'whollar_session';

/**
 * Cookies are HOST-ONLY: no `Domain` attribute at all.
 *
 * This is what makes the same code work in production, on a Vercel preview and
 * on localhost without configuration. A `Domain=.whollar.ca` cookie is simply
 * not settable from a `*.vercel.app` preview, so pinning the domain would mean
 * auth could never be tested anywhere but production.
 *
 * Host-only is also the stricter choice: the cookie goes to `www.whollar.ca`
 * and to nothing else: not to a sibling subdomain, not to the apex. Nothing is
 * lost by that here, because the apex 308s to `www` and no visitor stays on it.
 *
 * `COOKIE_DOMAIN` is still validated in config, and comes back into use at the
 * point `api.whollar.ca` fronts the function directly: at that moment the API
 * and the site stop sharing a host and the cookie has to be scoped to the
 * parent domain to reach both.
 */

/**
 * `Secure` everywhere except plain-http localhost, where it would make the
 * cookie unsettable. Decided from the forwarded protocol, since TLS terminates
 * at the proxy and this function only ever sees http itself.
 */
function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto) return proto === 'https';
  return req.protocol === 'https';
}

/**
 * SameSite=Lax, not Strict.
 *
 * Strict withholds the cookie on any cross-site navigation, including a click
 * from an email or from the OAuth provider's own redirect back to us: the user
 * would land on the dashboard, appear signed out, and sign in again in a loop.
 * Lax sends the cookie on top-level GET navigations while still withholding it
 * from cross-site POSTs, which is the CSRF case that matters.
 */
const SAME_SITE = 'Lax';

function serialize(name, value, attrs) {
  const parts = [`${name}=${value}`];
  if (attrs.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(attrs.maxAge)}`);
  if (attrs.expires) parts.push(`Expires=${attrs.expires.toUTCString()}`);
  parts.push(`Path=${attrs.path || '/'}`);
  parts.push(`SameSite=${attrs.sameSite || SAME_SITE}`);
  if (attrs.httpOnly !== false) parts.push('HttpOnly');
  if (attrs.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Append rather than assign: never clobber a Set-Cookie already on the response. */
function append(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', (Array.isArray(existing) ? existing : [existing]).concat(cookie));
}

/** Read the session token from the request, or null. */
function read(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    if (pair.slice(0, idx).trim() !== NAME) continue;
    const raw = pair.slice(idx + 1).trim();
    if (!raw) return null;
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}

/** Set the session cookie. `ttlMs` should match the row's `expires_at`. */
function set(req, res, value, ttlMs) {
  append(res, serialize(NAME, encodeURIComponent(value), {
    maxAge: Math.floor(ttlMs / 1000),
    secure: isSecureRequest(req),
    httpOnly: true,
    sameSite: SAME_SITE,
    path: '/',
  }));
}

/**
 * Clear it. The attributes must match those it was set with: a browser treats
 * a differing Path or Domain as a different cookie and leaves the original in
 * place, which looks exactly like "logout does nothing".
 */
function clear(req, res) {
  append(res, serialize(NAME, '', {
    maxAge: 0,
    expires: new Date(0),
    secure: isSecureRequest(req),
    httpOnly: true,
    sameSite: SAME_SITE,
    path: '/',
  }));
}

module.exports = { NAME, read, set, clear, isSecureRequest };
