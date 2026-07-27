'use strict';

/**
 * Route table + global middleware for the auth function.
 *
 * PHASE 0 — only /health exists. The middleware order below is the order
 * mandated in §4 and later phases fill in the numbered gaps; the comments
 * are load-bearing, not decoration.
 *
 * Path shape: Advanced I/O functions are served under `/server/<fn>/…`, so on
 * the raw Catalyst domain this function lives at `/server/auth`. In production
 * the API Gateway / domain mapping fronts it as `https://api.whollar.ca/auth/*`.
 * To keep one contract across both, the router is mounted at BOTH `/` and
 * `/auth`, so these are all the same endpoint:
 *
 *   https://api.whollar.ca/auth/health                          (production)
 *   https://<project>.development.catalystserverless.ca/server/auth/health
 *   https://<project>.development.catalystserverless.ca/server/auth/auth/health
 */

const express = require('express');
const crypto = require('node:crypto');

const datastore = require('./lib/datastore');
const { verify: verifySchema } = require('./lib/schema');

function buildApp(cfg) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // 1. Request id + structured logger.
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // Structured, and deliberately free of anything user-identifying:
      // no email, no code, no token, no raw IP. §12.
      console.log(JSON.stringify({
        req_id: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(ms),
      }));
    });
    next();
  });

  // 2. Body parsers. urlencoded is not optional — Apple's callback is
  //    form-encoded and omitting it is the single most common Apple failure.
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // 3. Origin allowlist check on non-GET  — Phase 2 (lib/csrf.js).
  // 4. Session loader                     — Phase 2 (lib/cookies.js + sessions).

  // 5. Routes.
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      status: 'ok',
      service: 'auth',
      phase: 0,
      request_id: req.id,
      node: process.versions.node,
      env: cfg.NODE_ENV,
      features: cfg.FEATURES,
    });
  });

  /**
   * Schema + request-shape diagnostics. NON-PRODUCTION ONLY — in production
   * this route does not exist at all, and falls through to the 404 below.
   *
   * Two questions it answers, both of which are otherwise guesswork:
   *
   *   1. Do the hand-created Data Store tables match what the code expects?
   *      Catalyst has no DDL API, so the tables are clicked in by hand and a
   *      mistyped column fails at runtime rather than at deploy. Checking by
   *      eye across ten tables and sixty columns is exactly the job a machine
   *      should do once.
   *
   *   2. What actually survives the Vercel proxy hop? `Origin` is the whole
   *      CSRF defence and the client IP feeds `ip_hash` and rate limiting; if
   *      the proxy drops or rewrites either, the design has to change. Better
   *      to learn that here than from a security control that silently never
   *      fires.
   *
   * It reports shapes and names only. The Origin value is echoed because it is
   * our own domain and the exact string is the point; the client IP is reduced
   * to a family and a boolean, because that one is personal data.
   */
  if (!cfg.IS_PRODUCTION) {
    router.get('/health/diagnostics', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      const fwd = String(req.headers['x-forwarded-for'] || '');
      const hops = fwd ? fwd.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const ip = req.ip || '';

      const request = {
        origin: req.headers.origin || null,
        referer_present: Boolean(req.headers.referer),
        sec_fetch_site: req.headers['sec-fetch-site'] || null,
        forwarded_hops: hops.length,
        client_ip_present: Boolean(ip),
        client_ip_family: ip.includes(':') ? 'ipv6' : (ip ? 'ipv4' : null),
        via_vercel: Boolean(req.headers['x-vercel-id'] || req.headers['x-vercel-forwarded-for']),
        proxy_headers_seen: Object.keys(req.headers)
          .filter((h) => /^(x-forwarded|x-vercel|x-real-ip|forwarded|cf-)/.test(h))
          .sort(),
      };

      let schema;
      try {
        schema = await verifySchema(datastore.app(req));
      } catch (err) {
        schema = { ok: false, error: String((err && err.message) || err).slice(0, 200) };
      }

      res.status(200).json({ service: 'auth', request_id: req.id, request, schema });
    });
  }

  // Both mounts share one router instance. The 404 fallback must live on the
  // app, not the router — a catch-all inside the router would be reached via
  // the `/` mount and swallow every request before the `/auth` mount ran.
  app.use('/', router);
  app.use('/auth', router);

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'VALIDATION_ERROR', message: 'Not found.' } });
  });

  // 6. Error handler — Phase 2 replaces this with the AppError mapper in
  //    lib/errors.js. Until then: never leak a cause to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error(JSON.stringify({ req_id: req.id, level: 'error', message: String(err && err.message) }));
    res.status(500).json({
      error: { code: 'SERVER_ERROR', message: `Something went wrong. Reference: ${req.id}` },
    });
  });

  return app;
}

/**
 * Served when config validation failed at cold start. The function refuses to
 * do any auth work, but stays diagnosable from outside: /health returns the
 * *names* of the variables that need setting, never their values.
 */
function buildDegradedApp(problems, missingNames) {
  const app = express();
  app.disable('x-powered-by');

  app.get(['/health', '/auth/health'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      status: 'degraded',
      service: 'auth',
      phase: 0,
      node: process.versions.node,
      reason: 'configuration incomplete — auth routes are disabled',
      missing: missingNames,
      problems,
    });
  });

  app.use((req, res) => {
    res.status(503).json({
      error: { code: 'SERVER_ERROR', message: 'Authentication is not configured on this environment.' },
    });
  });

  return app;
}

module.exports = { buildApp, buildDegradedApp };
