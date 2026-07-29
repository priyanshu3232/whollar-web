/**
 * Local dev server that behaves like production.
 *
 * `npm start` runs `serve`, which is static-only. That is fine for pages and
 * fatal for auth: `/api/auth/*` exists in production purely because of the
 * `rewrites` block in vercel.json, and `serve` does not read that file. So
 * locally every auth call 404s, the 404 body is HTML, `res.json()` throws on
 * it, and the page reports a transport failure — "We couldn't reach our
 * servers" — for what is really a missing route. That error is the reason this
 * file exists.
 *
 * `vercel dev` would also work, but it refuses to start without a `build`
 * script in package.json, and adding one changes what Vercel runs on every
 * production deploy. Not a trade worth making for a local convenience.
 *
 *   node scripts/dev-server.mjs          # port 3000
 *   PORT=4000 node scripts/dev-server.mjs
 *
 * Port 3000 is the default on purpose: the auth function's ALLOWED_ORIGINS
 * lists `http://localhost:3000`, and the CSRF check is an exact-match set, so
 * any other port is rejected with a 403 that looks like a bug.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 3000);

// Kept in step with the rewrite in vercel.json. If that changes, change this.
const API_PREFIX = '/api/auth';
const API_TARGET = 'https://whollar-110003037934.development.catalystserverless.ca/server/auth';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.lottie': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/**
 * Proxy an auth call to Catalyst.
 *
 * Two headers decide whether this works at all:
 *
 *   Origin              forwarded unchanged, because it IS the CSRF check.
 *                       Dropping it turns every POST into a 403.
 *   x-forwarded-proto   deliberately `http`. The function sets `Secure` on the
 *                       session cookie when it sees https, and a Secure cookie
 *                       is not stored by every browser on plain-http localhost
 *                       — so claiming https here would break sign-in locally in
 *                       a way that looks like the session silently vanishing.
 */
async function proxy(req, res, url) {
  const target = API_TARGET + url.pathname.slice(API_PREFIX.length) + url.search;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // host must not be forwarded: it would name localhost to a server that
    // routes on it. hop-by-hop headers are ours to terminate, not relay.
    if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) continue;
    headers[k] = v;
  }
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = `localhost:${PORT}`;

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }

  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: { code: 'PROXY_ERROR', message: `Could not reach Catalyst: ${err.message}` },
    }));
  }

  const out = {};
  upstream.headers.forEach((value, key) => {
    if (['content-encoding', 'content-length', 'transfer-encoding'].includes(key)) return;
    // getSetCookie keeps multiple Set-Cookie headers separate; the plain
    // iterator folds them into one comma-joined string, which browsers then
    // parse as a single malformed cookie and the session never appears.
    if (key === 'set-cookie') return;
    out[key] = value;
  });
  const cookies = upstream.headers.getSetCookie?.() || [];
  if (cookies.length) out['set-cookie'] = cookies;

  res.writeHead(upstream.status, out);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

/** `cleanUrls`, as vercel.json and serve.json both enable. */
async function resolveFile(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const candidates = rel.endsWith('/')
    ? [join(rel, 'index.html')]
    : [rel, `${rel}.html`, join(rel, 'index.html')];

  for (const c of candidates) {
    const full = join(ROOT, c);
    if (!full.startsWith(ROOT)) continue;          // no escaping the repo
    try {
      const s = await stat(full);
      if (s.isFile()) return full;
    } catch { /* next candidate */ }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
    return proxy(req, res, url);
  }

  const file = await resolveFile(url.pathname === '/' ? '/index.html' : url.pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`404 — no file for ${url.pathname}`);
  }

  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    // No caching locally, ever. The 24h cache on .js in production is exactly
    // how you end up debugging a stale whollar-core.js against a fresh page.
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

server.listen(PORT, () => {
  console.log(`\n  Whollar dev server\n`);
  console.log(`    site   http://localhost:${PORT}`);
  console.log(`    api    ${API_PREFIX}/*  ->  ${API_TARGET}\n`);
  console.log(`    try    http://localhost:${PORT}/waitlist/`);
  console.log(`           http://localhost:${PORT}/whollar-login-consumer\n`);
});
