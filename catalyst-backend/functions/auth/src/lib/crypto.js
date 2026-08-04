'use strict';

/**
 * Every hash, token and comparison in the auth system.
 *
 * Centralised so that "which of these is peppered?", "which comparison is
 * constant-time?" and "how long is a session token?" each have exactly one
 * answer, discoverable in one file.
 */

const crypto = require('node:crypto');

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

/**
 * 32 bytes = 256 bits, base64url so it is cookie- and URL-safe without
 * escaping. Used for session tokens, OAuth `state` and `nonce`, and the PKCE
 * verifier. Guessing one is not a threat model at this size; leaking one is,
 * which is why the *hash* is what gets stored.
 */
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/**
 * A numeric one-time code, zero-padded, drawn without modulo bias.
 *
 * `randomInt` is rejection-sampled by Node, so unlike `randomBytes()[0] % 10`
 * every digit is equally likely. Six digits is 10^6: weak on its own, which is
 * why the attempt counter and short TTL on `auth_challenges` are not optional
 * extras but the other half of this control.
 */
function numericCode(digits = 6) {
  let out = '';
  for (let i = 0; i < digits; i++) out += crypto.randomInt(0, 10);
  return out;
}

/* ------------------------------------------------------------------ *
 * Hashes
 * ------------------------------------------------------------------ */

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

/**
 * Session tokens are hashed WITHOUT a pepper, deliberately.
 *
 * A pepper defends a low-entropy secret against an offline brute force of a
 * stolen table. A 256-bit random token has nothing to brute force, so a pepper
 * buys nothing here, and it would cost something real: rotating it would
 * invalidate every live session at once. `sessions.token_hash` therefore stays
 * a plain digest, and stays queryable.
 */
const hashSessionToken = (raw) => sha256(raw);

/**
 * OTP codes are hashed WITH a pepper, equally deliberately.
 *
 * Six digits is a 10^6 search space: anyone holding the table could recover
 * every live code in milliseconds. The pepper lives in the function's
 * environment rather than the database, so a database compromise alone is not
 * enough. Rotating it invalidates only codes currently in flight, which expire
 * in ten minutes anyway.
 */
const hashCode = (code, cfg) => sha256(`${code}${cfg.CODE_PEPPER}`);

/**
 * IPs are peppered so the table holds no raw addresses, only comparable ones:
 * enough to spot "same source hammering the login", never enough to reveal who.
 *
 * Note the pepper cannot be rotated without making historical hashes
 * incomparable with new ones, which breaks abuse forensics across the boundary.
 */
const hashIp = (ip, cfg) => (ip ? sha256(`${ip}${cfg.IP_PEPPER}`) : null);

/* ------------------------------------------------------------------ *
 * Comparison
 * ------------------------------------------------------------------ */

/**
 * Constant-time string compare.
 *
 * `a === b` on a secret leaks its prefix through timing: it returns on the
 * first differing byte, so a remote attacker can recover a token character by
 * character. `timingSafeEqual` needs equal-length buffers, so unequal lengths
 * are compared against a fixed dummy rather than short-circuited: returning
 * early on a length mismatch would leak the length.
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------------------------------------------ *
 * Passwords (partners only, members never have a password row)
 * ------------------------------------------------------------------ */

/**
 * scrypt parameters. N=16384, r=8, p=1 is the widely cited interactive-login
 * baseline: roughly 16 MB of memory and ~100 ms per hash on modest hardware.
 *
 * These travel with each stored hash in `credentials.algo` so the cost can be
 * raised later without locking out everyone who signed up before: on a
 * successful login with an older `algo`, re-hash and store.
 */
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });
const ALGO_ID = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${SCRYPT.keylen}`;

// Node's default maxmem (32 MB) is below what N=16384, r=8 needs, and the
// failure is an opaque throw at hash time rather than at startup.
const MAXMEM = 256 * 1024 * 1024;

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(password), salt, SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAXMEM },
      (err, derived) => {
        if (err) return reject(err);
        resolve({
          hash: `${salt.toString('base64')}$${derived.toString('base64')}`,
          algo: ALGO_ID,
        });
      });
  });
}

/**
 * Verify against a stored hash, reading the parameters out of `algo` so old
 * hashes keep working after the cost is raised.
 */
function verifyPassword(password, stored, algo) {
  return new Promise((resolve) => {
    if (!stored || typeof stored !== 'string' || !stored.includes('$')) return resolve(false);

    const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$(\d+)$/.exec(String(algo || ALGO_ID));
    const params = m
      ? { N: +m[1], r: +m[2], p: +m[3], keylen: +m[4] }
      : { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen };

    const [saltB64, hashB64] = stored.split('$');
    let salt;
    try { salt = Buffer.from(saltB64, 'base64'); } catch { return resolve(false); }

    crypto.scrypt(String(password), salt, params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, derived) => {
        if (err) return resolve(false);
        resolve(safeEqual(derived.toString('base64'), hashB64));
      });
  });
}

/** Should this hash be re-computed on next successful login? */
const needsRehash = (algo) => String(algo || '') !== ALGO_ID;

/* ------------------------------------------------------------------ *
 * PKCE
 * ------------------------------------------------------------------ */

/** S256 challenge for an OAuth authorization request. */
const pkceChallenge = (verifier) =>
  crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');

module.exports = {
  token, numericCode,
  sha256, hashSessionToken, hashCode, hashIp,
  safeEqual,
  hashPassword, verifyPassword, needsRehash, ALGO_ID,
  pkceChallenge,
};
