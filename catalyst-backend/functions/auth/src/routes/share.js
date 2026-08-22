'use strict';

/**
 * Cohort share: the short link that carries a referral, and the event log
 * behind the share sheet.
 *
 *   GET  /r/:token       302 to the join surface, attribution banked two ways
 *   POST /share/event    fire and forget telemetry from the share sheet
 *
 * THE SHORT LINK IS THE ATTRIBUTION CARRIER. The dashboard hands out
 * https://www.whollar.ca/r/<token> (a vercel.json rewrite lands it here), and
 * this route banks the token in BOTH places the join flow can later read:
 *
 *   1. the `?ref=` parameter on the redirect target, which whollar-core.js
 *      captures into localStorage on arrival and spends at signup. This is
 *      the existing lane and it works with script enabled and cookies blocked.
 *   2. a server-set HttpOnly cookie, which routes/otp.js reads as a fallback
 *      when a signup arrives with no code. Server-set on purpose: Safari's
 *      tracking prevention caps SCRIPT-set cookies at seven days, which would
 *      quietly destroy attribution for most Canadian mobile traffic. A
 *      server-set first-party cookie is not capped that way.
 *
 * FIRST TOUCH WINS ON THE COOKIE. If a valid cookie is already present, a
 * second sender's link does not overwrite it: the member who made the first
 * introduction created the intent. The click is still logged, so the second
 * touch is visible in `invite_click` even though it earns no cookie.
 *
 * A BAD TOKEN IS NOT AN ERROR. A mistyped, tampered or retired token 302s to
 * the same join surface with no attribution and no error surfaced: the
 * recipient came to join, not to debug the sender's link. The failed
 * validation is a row in `invite_click` with token_valid false.
 *
 * EVERY WRITE IN THIS FILE IS BEST-EFFORT. `invite_click` and `share_event`
 * (create-tables.md section 25) may not exist in the console yet, and a
 * missing table must cost a log line, never a redirect or a share. This is
 * the same contract as product_interest (section 23).
 *
 * No PII in either table: IPs and user agents are stored as the peppered
 * hashes the rest of the codebase uses, never raw.
 */

const referral = require('../lib/referral');
const datastore = require('../lib/datastore');
const ratelimit = require('../lib/ratelimit');
const { wrap } = require('../lib/errors');
const { clientIp, userAgent } = require('../lib/request');
const { hashIp, sha256 } = require('../lib/crypto');
const { isSecureRequest } = require('../lib/cookies');

const REF_COOKIE = 'whollar_ref';
const REF_COOKIE_DAYS = 30;

/* The join surface. One live destination for every stage today: per-cohort
 * landing pages do not exist on the static site, so the stage pivot lives in
 * the share COPY (the dashboard's string table), not in the URL. When cohort
 * pages ship, this is the one line that changes. */
const LANDING_PATH = '/waitlist/';

/** The banked referral cookie on this request, normalized, or null. */
function readRefCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    if (pair.slice(0, idx).trim() !== REF_COOKIE) continue;
    let raw = pair.slice(idx + 1).trim();
    try { raw = decodeURIComponent(raw); } catch { /* use as-is */ }
    return referral.normalize(raw);
  }
  return null;
}

/** Append the attribution cookie without clobbering any Set-Cookie already
 *  on the response. Same attribute discipline as lib/cookies.js: HttpOnly,
 *  SameSite=Lax, Secure behind the proxy, Path=/. */
function setRefCookie(req, res, value) {
  const parts = [
    `${REF_COOKIE}=${encodeURIComponent(value)}`,
    `Max-Age=${REF_COOKIE_DAYS * 24 * 60 * 60}`,
    'Path=/',
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  const cookie = parts.join('; ');
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', (Array.isArray(existing) ? existing : [existing]).concat(cookie));
}

/** Expire it. routes/otp.js calls this once an attribution is spent. */
function clearRefCookie(req, res) {
  const parts = [`${REF_COOKIE}=`, 'Max-Age=0', 'Path=/', 'SameSite=Lax', 'HttpOnly'];
  if (isSecureRequest(req)) parts.push('Secure');
  const cookie = parts.join('; ');
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', (Array.isArray(existing) ? existing : [existing]).concat(cookie));
}

/* The event names the sheet may report. A whitelist rather than a length cap:
 * this table will be read by humans, and a free-text event column collects
 * whatever a curious person types into a devtools console. */
const EVENTS = new Set([
  'share_control_shown', 'share_opened', 'share_channel_selected',
  'share_copied', 'share_native_completed', 'share_dismissed',
]);
const cap = (v, n) => (v == null ? null : String(v).slice(0, n));

function mount(router) {
  /**
   * The short link. Public, no session, GET so the csrf middleware exempts it.
   *
   * Rate limited per IP with a deliberately high ceiling: one building-wide
   * share can legitimately land dozens of clicks from one NAT in a minute,
   * and the limit exists to blunt token enumeration, not neighbours.
   */
  router.get('/r/:token', wrap(async (req, res) => {
    const allowed = await ratelimit.withinLimit(req.catalyst, req, {
      key: 'share.land', max: 120, windowSec: 3600,
    });
    /* Over the limit the redirect still happens, attribution just does not:
     * failing the navigation itself would strand a human on an error page to
     * slow a bot that can read a 429 as easily as a 302. */

    const token = referral.normalize(req.params.token);
    const already = readRefCookie(req);

    if (allowed && token && !already) setRefCookie(req, res, token);

    /* One row per landing, valid or not, before the redirect is sent.
     * Best-effort: the table may not exist yet (create-tables.md section 25). */
    try {
      const cfg = req.app.get('cfg');
      await datastore.insertRow(req.catalyst, 'invite_click', {
        token: token || null,
        token_valid: token ? 'yes' : 'no',
        landed_at: datastore.nowDb(),
        ip_hash: hashIp(clientIp(req), cfg),
        ua_hash: sha256(userAgent(req) || ''),
        first_touch: token && already && already !== token ? 'no' : 'yes',
      });
    } catch (err) {
      console.error(JSON.stringify({
        req_id: req.id, level: 'warn', message: 'invite click insert failed',
        detail: String((err && err.message) || err).slice(0, 200),
      }));
    }

    /* The ?ref= parameter is the second attribution lane (localStorage via
     * whollar-core), and it doubles as the no-cookie path. */
    const target = token
      ? `${LANDING_PATH}?ref=${encodeURIComponent(token)}`
      : LANDING_PATH;
    res.redirect(302, target);
  }));

  /**
   * Share sheet telemetry. Fire and forget from the client (keepalive), so the
   * answer is 202 on anything shaped right and the write is best-effort. No
   * body value is trusted beyond its length and, for `event`, the whitelist.
   */
  router.post('/share/event', wrap(async (req, res) => {
    const allowed = await ratelimit.withinLimit(req.catalyst, req, {
      key: 'share.event', max: 120, windowSec: 3600,
    });
    const body = req.body || {};
    const event = EVENTS.has(body.event) ? body.event : null;

    if (allowed && event) {
      try {
        const cfg = req.app.get('cfg');
        await datastore.insertRow(req.catalyst, 'share_event', {
          event,
          member_id: (req.auth && req.auth.user && req.auth.user.user_id) || null,
          cohort_id: cap(body.cohortId, 64),
          stage_at_share: cap(body.stage, 24),
          channel: cap(body.channel, 24),
          placement: cap(body.placement, 24),
          tier: cap(body.tier, 12),
          target: cap(body.target, 12),
          reason: cap(body.reason, 24),
          created_at: datastore.nowDb(),
          ip_hash: hashIp(clientIp(req), cfg),
          ua_hash: sha256(userAgent(req) || ''),
        });
      } catch (err) {
        console.error(JSON.stringify({
          req_id: req.id, level: 'warn', message: 'share event insert failed',
          detail: String((err && err.message) || err).slice(0, 200),
        }));
      }
    }
    res.status(202).json({ ok: true });
  }));
}

module.exports = { mount, readRefCookie, clearRefCookie, REF_COOKIE };
