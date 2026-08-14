'use strict';

/**
 * Fixed-window rate limiting on Catalyst Cache.
 *
 * Cache, not memory: this is a serverless function, so instances are ephemeral
 * and plural. An in-memory counter limits one instance for as long as it
 * happens to live, which is to say it limits nothing.
 *
 * The window is fixed rather than sliding, which permits a burst of up to 2×max
 * across a window boundary. That is a known and accepted property: these
 * limits exist to blunt automation, and the precise defence against guessing a
 * code is the per-challenge attempt counter, not this.
 */

const { rateLimited } = require('./errors');
const { clientIp } = require('./request');
const { hashIp } = require('./crypto');

/**
 * @returns {Promise<boolean>} true if the request may proceed
 */
async function withinLimit(catalystApp, req, { key, max, windowSec, perIp = true }) {
  try {
    const cfg = req.app.get('cfg');
    const seg = catalystApp.cache().segment();
    const window = Math.floor(Date.now() / (windowSec * 1000));

    // The bucket key holds a HASHED ip, never a raw one. Cache entries are just
    // as much a store of personal data as a table is, and the pepper is already
    // to hand.
    const who = perIp ? `:${hashIp(clientIp(req), cfg) || 'unknown'}` : '';
    const bucket = `rl:${key}${who}:${window}`;
    const ttlHours = Math.max(1, Math.ceil(windowSec / 3600));

    let count = 0;
    try { count = parseInt(await seg.getValue(bucket), 10) || 0; } catch { count = 0; }
    if (count >= max) return false;

    const next = String(count + 1);
    try { await seg.put(bucket, next, ttlHours); }
    catch { try { await seg.update(bucket, next, ttlHours); } catch { /* best effort */ } }
    return true;
  } catch {
    // Fail OPEN. A cache outage must not lock every visitor out of signing in:
    // the failure mode of failing closed here is a total auth outage, which is
    // worse than a temporarily unenforced limit.
    return true;
  }
}

/**
 * Per-identifier limiting: an email address rather than an IP.
 *
 * The IP limit and this one answer different questions. An IP limit stops one
 * machine hammering many accounts; this stops many machines converging on one
 * account, which is the shape of a targeted attack and the shape NAT and mobile
 * carriers make an IP limit useless against.
 */
async function withinLimitFor(catalystApp, req, identifier, opts) {
  const { sha256 } = require('./crypto');
  return withinLimit(catalystApp, req, {
    ...opts,
    perIp: false,
    key: `${opts.key}:${sha256(String(identifier)).slice(0, 32)}`,
  });
}

/** Throwing wrapper for use inside a route. */
async function enforce(catalystApp, req, opts) {
  if (await withinLimit(catalystApp, req, opts)) return;
  throw rateLimited(undefined, {
    logDetail: `rate limit ${opts.key} (max ${opts.max}/${opts.windowSec}s)`,
    headers: { 'Retry-After': String(opts.windowSec) },
  });
}

async function enforceFor(catalystApp, req, identifier, opts) {
  if (await withinLimitFor(catalystApp, req, identifier, opts)) return;
  throw rateLimited(undefined, {
    logDetail: `rate limit ${opts.key} per-identifier (max ${opts.max}/${opts.windowSec}s)`,
    headers: { 'Retry-After': String(opts.windowSec) },
  });
}

module.exports = { withinLimit, withinLimitFor, enforce, enforceFor };
