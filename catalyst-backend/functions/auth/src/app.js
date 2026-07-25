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
