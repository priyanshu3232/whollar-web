'use strict';

/**
 * One error type, one response shape, one rule: the client is told what it can
 * act on and nothing else.
 *
 * Auth error messages are a genuine information leak. "No account with that
 * email" and "wrong password" together turn a login form into an account
 * enumeration oracle — anyone can discover who has an account here. So the
 * distinction lives in `logDetail`, which goes to `auth_events`, while the
 * client gets one deliberately identical message. `SERVER_ERROR` additionally
 * carries the request id so a user can quote it and we can find the log line.
 */

const CODES = Object.freeze({
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED:  401,
  FORBIDDEN:        403,
  NOT_FOUND:        404,
  CONFLICT:         409,
  RATE_LIMITED:     429,
  SERVER_ERROR:     500,
  NOT_IMPLEMENTED:  501,
});

class AppError extends Error {
  /**
   * @param {keyof CODES} code
   * @param {string} message   Shown to the user. Assume it will be screenshotted.
   * @param {object} [opts]
   * @param {string} [opts.logDetail]  The honest reason. Never sent to the client.
   * @param {object} [opts.headers]    e.g. { 'Retry-After': '60' }
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'AppError';
    this.code = CODES[code] ? code : 'SERVER_ERROR';
    this.status = CODES[this.code];
    this.logDetail = opts.logDetail || null;
    this.headers = opts.headers || null;
    this.expose = true;
  }
}

/** Shorthands for the codes that get thrown from more than one place. */
const badRequest   = (m, o) => new AppError('VALIDATION_ERROR', m, o);
const unauthorized = (m, o) => new AppError('UNAUTHENTICATED', m || 'Please sign in again.', o);
const forbidden    = (m, o) => new AppError('FORBIDDEN', m || 'You do not have access to that.', o);
const rateLimited  = (m, o) => new AppError('RATE_LIMITED', m || 'Too many attempts. Please try again shortly.', o);
const notImplemented = (feature) => new AppError(
  'NOT_IMPLEMENTED',
  'That sign-in method is not available yet.',
  { logDetail: `feature disabled: ${feature}` }
);

/**
 * Terminal Express error handler.
 *
 * Anything that is not an AppError is, by definition, unanticipated — so it is
 * reported as a bare SERVER_ERROR and its message is logged rather than sent.
 * A stack trace or a driver message in a response body is how internals leak.
 */
function errorHandler(err, req, res, _next) {
  const app = err instanceof AppError
    ? err
    : new AppError('SERVER_ERROR', `Something went wrong. Reference: ${req.id}`, {
      logDetail: String((err && err.message) || err).slice(0, 500),
    });

  console[app.status >= 500 ? 'error' : 'warn'](JSON.stringify({
    req_id: req.id,
    level: app.status >= 500 ? 'error' : 'warn',
    code: app.code,
    status: app.status,
    path: req.path,
    detail: app.logDetail,
  }));

  if (app.headers) for (const [k, v] of Object.entries(app.headers)) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(app.status).json({ error: { code: app.code, message: app.message } });
}

/**
 * Wrap an async handler so a rejected promise reaches `errorHandler`.
 * Express 4 does not do this itself: an unhandled rejection in a route hangs
 * the request until the platform times it out, which reads as "the server is
 * slow" rather than "the server threw".
 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  AppError, CODES, errorHandler, wrap,
  badRequest, unauthorized, forbidden, rateLimited, notImplemented,
};
