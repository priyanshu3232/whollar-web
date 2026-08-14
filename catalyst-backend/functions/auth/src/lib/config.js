'use strict';

/**
 * Environment configuration with fail-fast validation.
 *
 * A function that boots with a missing pepper and silently hashes with
 * `undefined` is worse than one that refuses to boot. So: this module
 * validates everything at require time and throws a single ConfigError
 * listing *every* problem at once (not the first one: you should not have
 * to redeploy five times to find five typos).
 *
 * Two tiers:
 *
 *   BOOT      Required for the function to serve any auth traffic at all.
 *             Missing/invalid -> throw. index.js catches this and mounts a
 *             degraded app: /health reports which names are missing (names
 *             only, never values), every other route 503s. Fails closed.
 *
 *   GROUPS    Feature bundles (mail, google, crm, consents). Each is
 *             all-or-nothing: set none and the feature reports `enabled:false`
 *             and its routes 501; set some and it is a configuration error
 *             (half-configured OAuth is the failure mode that eats a day).
 *
 * Nothing in here is ever logged. `redacted()` is the only safe dump.
 */

class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid auth function configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/* ------------------------------------------------------------------ *
 * Validators. Each returns { value } or { error: 'reason' }.
 * ------------------------------------------------------------------ */

const isLocal = (host) => host === 'localhost' || host === '127.0.0.1';

const v = {
  enum: (...allowed) => (raw) =>
    allowed.includes(raw)
      ? { value: raw }
      : { error: `must be one of ${allowed.join(' | ')} (got ${JSON.stringify(raw)})` },

  /** Absolute https URL, no trailing slash, no path. */
  baseUrl: (raw) => {
    let u;
    try { u = new URL(raw); } catch { return { error: 'is not a valid absolute URL' }; }
    if (u.protocol !== 'https:' && !isLocal(u.hostname)) {
      return { error: 'must use https (http is only allowed for localhost)' };
    }
    if (u.pathname !== '/' || u.search || u.hash) {
      return { error: 'must be an origin with no path, query or fragment' };
    }
    return { value: u.origin };
  },

  /** Cookie Domain attribute: a leading-dot parent domain, e.g. .whollar.ca */
  cookieDomain: (raw) => {
    if (raw === 'localhost') return { value: raw };
    if (!raw.startsWith('.')) {
      return { error: 'must start with a dot so it covers subdomains, e.g. .whollar.ca' };
    }
    if (!/^\.[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw)) {
      return { error: 'is not a valid domain' };
    }
    return { value: raw };
  },

  /**
   * Origin allowlist -> frozen array of origins.
   *
   * Separator is comma, whitespace or semicolon, in any mix. That leniency is
   * not aesthetic: the Catalyst console validates environment-variable input
   * itself, and which punctuation it will accept is neither documented nor
   * stable. Accepting all three means a console that rejects one separator
   * never forces a code change, and `https://a.ca https://b.ca` is a legal
   * value here. An origin can never itself contain any of the three, so this
   * cannot merge two entries by accident.
   */
  origins: (raw) => {
    const parts = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return { error: 'must list at least one origin' };
    const bad = [];
    const out = [];
    for (const p of parts) {
      let u;
      try { u = new URL(p); } catch { bad.push(p); continue; }
      if (u.pathname !== '/' || u.search) { bad.push(p); continue; }
      if (u.protocol !== 'https:' && !isLocal(u.hostname)) { bad.push(p); continue; }
      out.push(u.origin);
    }
    if (bad.length) return { error: `contains invalid origins: ${bad.join(', ')}` };
    return { value: Object.freeze([...new Set(out)]) };
  },

  /**
   * High-entropy secret: must decode to >= 32 bytes, i.e. 256 bits.
   *
   * The decode is base64, but hex passes too (64 hex chars decode as base64 to
   * 48 bytes) and hex is what the setup doc now recommends: the Catalyst
   * console rejects some punctuation in values, and base64's '+', '/' and '='
   * are prime candidates. Either encoding is fine: the pepper is used as an
   * opaque string, so this check is an entropy floor, not a format contract.
   */
  pepper: (raw) => {
    let buf;
    try { buf = Buffer.from(raw, 'base64'); } catch { return { error: 'is not valid base64' }; }
    // Buffer.from is lenient; round-trip to catch junk that silently decodes short.
    if (buf.length < 32) {
      return { error: `must decode to at least 32 bytes of base64 (got ${buf.length})` };
    }
    return { value: raw };
  },

  int: (min, max) => (raw) => {
    if (!/^\d+$/.test(raw)) return { error: 'must be a whole number' };
    const n = Number(raw);
    if (n < min || n > max) return { error: `must be between ${min} and ${max}` };
    return { value: n };
  },

  /** Document version stamp written into `consents`. Dated, so it sorts. */
  docVersion: (raw) =>
    /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? { value: raw }
      : { error: 'must be a YYYY-MM-DD version stamp, e.g. 2026-07-01' },

  nonEmpty: (raw) =>
    raw.trim().length ? { value: raw.trim() } : { error: 'must not be empty' },

  /** A bare domain name, lowercased: `whollar.com`. Not an origin, not an email. */
  domain: (raw) => {
    const s = String(raw).trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
      return { error: 'must be a bare domain name, e.g. whollar.com' };
    }
    return { value: s };
  },

  /**
   * Optional email allowlist -> frozen array, normalized. Same separator
   * leniency as `origins`, for the same Catalyst-console reason. Empty is a
   * valid value: the domain gate alone is then the whole allowlist.
   */
  emailList: (raw) => {
    const parts = String(raw).split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter((p) => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p));
    if (bad.length) return { error: `contains invalid emails: ${bad.join(', ')}` };
    return { value: Object.freeze([...new Set(parts)]) };
  },
};

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

// Required before the function will serve auth traffic.
const BOOT = {
  NODE_ENV:        { check: v.enum('development', 'production', 'test'), fallback: 'development' },
  APP_BASE_URL:    { check: v.baseUrl },
  API_BASE_URL:    { check: v.baseUrl },
  COOKIE_DOMAIN:   { check: v.cookieDomain },
  ALLOWED_ORIGINS: { check: v.origins },
  CODE_PEPPER:     { check: v.pepper, secret: true },
  IP_PEPPER:       { check: v.pepper, secret: true },

  // Applies to every mail transport, so it lives here rather than inside one
  // provider's group: a reply to a no-reply address should reach a human
  // rather than hard-bounce, whichever way the mail went out.
  MAIL_REPLY_TO:   { check: v.nonEmpty, fallback: 'info@whollar.com' },

  SESSION_TTL_MEMBER_DAYS:   { check: v.int(1, 365), fallback: '30' },
  SESSION_TTL_PARTNER_HOURS: { check: v.int(1, 168), fallback: '12' },
};

// All-or-nothing feature bundles.
const GROUPS = {
  /**
   * SMTP relay: the transport that needs no DNS work at all.
   *
   * Sending through the mailbox provider that the domain's SPF already
   * authorizes means there is nothing to verify: no DKIM record to add, no
   * domain-verification wait. It is second choice on deliverability, so `mail`
   * (ZeptoMail) wins when both are set, but it is first choice on being
   * available today, and a login system that cannot send a code is not a login
   * system.
   *
   * Use a domain whose reputation is not your business mail's. Sending login
   * codes through the same mailbox host that carries your customer
   * correspondence means one spam complaint can throttle both.
   */
  smtp: {
    SMTP_USER: { check: v.nonEmpty, secret: true },
    SMTP_PASS: { check: v.nonEmpty, secret: true },
    SMTP_FROM: { check: v.nonEmpty },
    SMTP_HOST: { check: v.nonEmpty, fallback: 'smtp.ionos.com' },
    // 587 + STARTTLS rather than 465 + implicit TLS: it is the submission port
    // RFC 6409 specifies, and the one least likely to be blocked outbound.
    SMTP_PORT: { check: v.int(1, 65535), fallback: '587' },
  },

  // Unset -> mailer falls back to SMTP, then to the `log` transport, which is
  // what makes the login flow testable before any provider exists.
  mail: {
    ZEPTOMAIL_TOKEN: { check: v.nonEmpty, secret: true },
    ZEPTOMAIL_FROM:  { check: v.nonEmpty },
    // Regional. This project is on Zoho's Canadian DC (see the crm group), and
    // hard-coding the US host would route Canadian addresses through a US
    // endpoint. Defaulted rather than required so it does not, on its own,
    // count as "the operator configured mail".
    ZEPTOMAIL_API_BASE: { check: v.baseUrl, fallback: 'https://api.zeptomail.com' },
  },
  // Needed from Phase 3: signup writes versioned consent rows.
  consents: {
    TERMS_VERSION:         { check: v.docVersion },
    PRIVACY_VERSION:       { check: v.docVersion },
    PARTNER_TERMS_VERSION: { check: v.docVersion },
  },
  // Phase 4.
  google: {
    GOOGLE_CLIENT_ID:     { check: v.nonEmpty },
    GOOGLE_CLIENT_SECRET: { check: v.nonEmpty, secret: true },
    GOOGLE_REDIRECT_URI:  { check: v.nonEmpty },
  },
  /**
   * The admin console (admin.whollar.ca).
   *
   * Unset -> FEATURES.admin is false and no /admin route is mounted at all:
   * the surface does not exist until an operator decides it does. The domain
   * is the allowlist, every mailbox on it can become an admin, so it must
   * be a domain whose mailboxes the company alone controls. ADMIN_EMAILS adds
   * individual off-domain addresses (a contractor, a founder's personal
   * address) without widening the domain gate.
   */
  admin: {
    ADMIN_EMAIL_DOMAIN:      { check: v.domain },
    ADMIN_EMAILS:            { check: v.emailList, fallback: '' },
    SESSION_TTL_ADMIN_HOURS: { check: v.int(1, 48), fallback: '12' },
  },

  // Phase 6. Canadian DC hosts are defaulted, not guessed at call time.
  crm: {
    ZOHO_CRM_CLIENT_ID:     { check: v.nonEmpty },
    ZOHO_CRM_CLIENT_SECRET: { check: v.nonEmpty, secret: true },
    ZOHO_CRM_REFRESH_TOKEN: { check: v.nonEmpty, secret: true },
    ZOHO_ACCOUNTS_BASE:     { check: v.baseUrl, fallback: 'https://accounts.zohocloud.ca' },
    ZOHO_API_BASE:          { check: v.baseUrl, fallback: 'https://www.zohoapis.ca' },
  },
};

/* ------------------------------------------------------------------ *
 * Loader
 * ------------------------------------------------------------------ */

function readOne(name, spec, env, problems) {
  const raw = env[name] === undefined || env[name] === '' ? spec.fallback : env[name];
  if (raw === undefined) return undefined;
  const res = spec.check(String(raw));
  if (res.error) {
    problems.push(`${name} ${res.error}`);
    return undefined;
  }
  return res.value;
}

function load(env = process.env) {
  const problems = [];
  const missing = [];
  const out = {};

  for (const [name, spec] of Object.entries(BOOT)) {
    const provided = env[name] !== undefined && env[name] !== '';
    if (!provided && spec.fallback === undefined) { missing.push(name); continue; }
    out[name] = readOne(name, spec, env, problems);
  }

  const features = {};
  for (const [group, vars] of Object.entries(GROUPS)) {
    const names = Object.keys(vars);
    // A var with a fallback doesn't count as "the operator configured this group".
    const explicit = names.filter((n) => vars[n].fallback === undefined && env[n] !== undefined && env[n] !== '');
    const requiredNames = names.filter((n) => vars[n].fallback === undefined);

    if (explicit.length === 0) {
      features[group] = false;
      continue;
    }
    const absent = requiredNames.filter((n) => env[n] === undefined || env[n] === '');
    if (absent.length) {
      problems.push(
        `${group} is partially configured, also set: ${absent.join(', ')} ` +
        `(a half-configured feature must not boot)`
      );
      features[group] = false;
      continue;
    }
    for (const n of names) out[n] = readOne(n, vars[n], env, problems);
    features[group] = true;
  }

  if (missing.length) {
    problems.unshift(`missing required variables: ${missing.join(', ')}`);
  }
  if (problems.length) throw new ConfigError(problems);

  out.FEATURES = Object.freeze(features);
  out.IS_PRODUCTION = out.NODE_ENV === 'production';

  // Session lifetimes in ms, resolved once. Members roll; partners and admins
  // do not (§1): an admin session is an absolute ceiling, like a partner's.
  out.SESSION_TTL_MS = Object.freeze({
    member: out.SESSION_TTL_MEMBER_DAYS * 24 * 60 * 60 * 1000,
    provider: out.SESSION_TTL_PARTNER_HOURS * 60 * 60 * 1000,
    admin: (features.admin ? out.SESSION_TTL_ADMIN_HOURS : 12) * 60 * 60 * 1000,
  });

  return Object.freeze(out);
}

/**
 * Which BOOT names are absent, without throwing. Used by the degraded-boot
 * health route so a misconfigured deploy is diagnosable from the outside
 * without ever exposing a value.
 */
function missingBootNames(env = process.env) {
  return Object.entries(BOOT)
    .filter(([n, spec]) => spec.fallback === undefined && (env[n] === undefined || env[n] === ''))
    .map(([n]) => n);
}

/** Safe-to-log view. Secrets become `set` / `unset`, never their value. */
function redacted(cfg) {
  const secretNames = new Set(
    [...Object.entries(BOOT), ...Object.values(GROUPS).flatMap((g) => Object.entries(g))]
      .filter(([, spec]) => spec.secret)
      .map(([n]) => n)
  );
  const out = {};
  for (const [k, val] of Object.entries(cfg)) {
    out[k] = secretNames.has(k) ? (val ? 'set' : 'unset') : val;
  }
  return out;
}

module.exports = { load, missingBootNames, redacted, ConfigError, BOOT, GROUPS };
