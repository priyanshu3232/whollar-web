'use strict';

/**
 * Whollar auth — Advanced I/O function entry point.
 *
 * Config is validated at cold start. If it fails, we do NOT boot a working
 * app with `undefined` peppers; we boot a degraded one that 503s every auth
 * route and reports the missing variable names on /health. Fails closed,
 * stays diagnosable.
 */

const { load, missingBootNames } = require('./src/lib/config');
const { buildApp, buildDegradedApp } = require('./src/app');

let app;
try {
  const cfg = load();
  app = buildApp(cfg);
} catch (err) {
  const problems = err.problems || [String(err && err.message)];
  console.error(JSON.stringify({ level: 'fatal', message: 'auth config invalid', problems }));
  app = buildDegradedApp(problems, missingBootNames());
}

module.exports = app;
