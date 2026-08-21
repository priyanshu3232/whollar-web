'use strict';

/**
 * Opaque referral tokens: 7 payload characters and 1 check character.
 *
 * WHY THIS EXISTS when lib/referral.js already derives a code. The derived
 * code is `WHL-` plus the first eight hex characters of `user_id`, which means
 * it is a literal prefix of the member's UUID: every share link discloses a
 * third of the account's primary identifier to anyone who sees it. An opaque
 * token shares nothing, so it is what the dashboard will hand out once the
 * resolver ships. The derived code stays resolvable forever, because links
 * carrying it are already in the wild.
 *
 * THE ALPHABET. Crockford base32 already drops I, L, O, U so a mistyped
 * lookalike cannot change the value. A and E are removed on top of that so
 * seven random characters cannot spell anything worth apologising for. That
 * leaves 30 payload symbols and a keyspace of 30^7, about 21.9 billion.
 *
 * THE CHECK CHARACTER, and why its alphabet has 31 symbols. A checksum modulo
 * 30 does not catch every single-character mistype: 30 factors as 2, 3 and 5,
 * so a substitution whose value shift shares a factor with its positional
 * weight lands on the same checksum. Measured, not assumed: mod 30 misses
 * 6.9% of substitutions; mod 31 with weights 2..8 misses none, and catches
 * every transposition of two payload characters as well. 31 is prime, and a
 * prime modulus is the entire point. The 31st symbol is A, reclaimed for the
 * check position only: it is excluded from the payload for word-avoidance,
 * and a trailing A cannot form a word after seven vowel-free characters.
 *
 * INJECTION. `normalize` is the only function whose output ever reaches a
 * query, and it whitelists against this alphabet at a fixed length, so a
 * normalized token cannot carry a ZCQL payload. `datastore.lit()` validates
 * it a second time on the way in; both checks are cheap and neither is
 * allowed to be bypassed.
 */

const crypto = require('node:crypto');

const PAYLOAD_ALPHABET = '0123456789BCDFGHJKMNPQRSTVWXYZ'; // 30 symbols
const CHECK_ALPHABET = PAYLOAD_ALPHABET + 'A';             // 31, prime
const MOD = CHECK_ALPHABET.length;                         // 31
const BASE = PAYLOAD_ALPHABET.length;                      // 30
const PAYLOAD_LEN = 7;
const TOKEN_LEN = 8;

const PAYLOAD_RE = new RegExp(`^[${PAYLOAD_ALPHABET}]{${PAYLOAD_LEN}}$`);

/** One uniformly random payload symbol. Rejection sampling: 256 % 30 is not
 * zero, so a bare modulo would favour the first six symbols of the alphabet
 * by one part in 240, and a share code is not the place to shave entropy. */
function randomSymbol() {
  const limit = 256 - (256 % BASE); // 240
  for (;;) {
    const b = crypto.randomBytes(1)[0];
    if (b < limit) return PAYLOAD_ALPHABET[b % BASE];
  }
}

/**
 * The check character for a payload, or null if the payload is not seven
 * characters of the payload alphabet. Positional weights 2..8 against the
 * prime modulus; the prime is load bearing, see the header.
 */
function checkChar(payload) {
  if (typeof payload !== 'string' || payload.length !== PAYLOAD_LEN) return null;
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    const v = PAYLOAD_ALPHABET.indexOf(payload[i]);
    if (v < 0) return null;
    sum += v * (i + 2);
  }
  return CHECK_ALPHABET[sum % MOD];
}

/**
 * The payload symbols that also read as hexadecimal. A payload made ONLY of
 * these is never minted, see `generate`.
 */
const HEX_LOOKALIKE_RE = /^[0-9BCDF]{7}$/;

/**
 * A fresh token: 7 random payload characters plus their check character.
 *
 * One shape is rejected and redrawn: a payload consisting entirely of
 * hex-reading characters (0-9, B, C, D, F). The legacy referral code is eight
 * bare hex characters, and an all-hex token would be indistinguishable from
 * one, so lib/referral.js could not route a bare typed string to the right
 * system. Guaranteeing at least one non-hex character here makes "all hex"
 * mean "legacy", unambiguously, forever. The cost is 0.48% of the keyspace
 * ((14/30)^7) and about one redraw per two hundred mints.
 */
function generate() {
  for (;;) {
    let payload = '';
    for (let i = 0; i < PAYLOAD_LEN; i++) payload += randomSymbol();
    if (HEX_LOOKALIKE_RE.test(payload)) continue;
    return payload + checkChar(payload);
  }
}

/**
 * The canonical 8-character token from whatever a human produced, or null.
 *
 * Accepts hyphens, spaces, dots, underscores and lowercase, plus the
 * substitutions people actually make: O for 0, I and L for 1. Those are
 * Crockford's own leniency rules, and 1 is in the payload alphabet so the
 * mapping is meaningful. Everything else, wrong length, a symbol outside the
 * alphabet, A anywhere but the check position, a checksum that does not
 * verify, returns null.
 */
function normalize(input) {
  if (typeof input !== 'string') return null;
  const s = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== TOKEN_LEN) return null;
  const payload = s.slice(0, PAYLOAD_LEN);
  const check = s[PAYLOAD_LEN];
  if (!PAYLOAD_RE.test(payload)) return null;
  if (CHECK_ALPHABET.indexOf(check) < 0) return null;
  if (checkChar(payload) !== check) return null;
  return s;
}

/** `K7MQT4WB` -> `K7MQ-T4WB`. Display only; the hyphen is never stored. */
function display(token) {
  const t = String(token || '');
  return t.length === TOKEN_LEN ? t.slice(0, 4) + '-' + t.slice(4) : t;
}

module.exports = {
  generate, normalize, display, checkChar,
  PAYLOAD_ALPHABET, CHECK_ALPHABET, PAYLOAD_LEN, TOKEN_LEN,
};
