'use strict';

/**
 * Opaque tokens for unsubscribe links and, later, calendar feeds.
 *
 * SAME ALPHABET AS lib/token.js, TWICE THE LENGTH, AND THE LENGTH IS THE
 * POINT. A referral token is meant to be shared, said aloud and typed in, so
 * eight characters and 30^7 of keyspace is the right trade. These are neither
 * shared nor typed: they live in a mailto footer and a one-click header, and
 * a guessed one lets a stranger change somebody else's contact preferences.
 * Two checked halves give 30^14, roughly 4.8 * 10^20, which puts guessing
 * outside the reach of anything a rate limiter would have to argue with.
 *
 * NO IDENTITY IN THE TOKEN. Not the user id, not the email, not a hash of
 * either. The row is the mapping. A token that encodes who it belongs to
 * discloses that to anyone who sees the link, including every mail relay it
 * passes through, and unsubscribe links pass through a lot of them.
 *
 * BOTH HALVES ARE CHECKED, so a truncated or corrupted token is rejected
 * before it ever reaches a query, and `normalize` whitelists against the
 * alphabet at a fixed length so the value cannot carry a ZCQL payload.
 * datastore.lit() validates a second time; neither check may be skipped.
 */

const token = require('../token');

const HALVES = 2;
const LEN = token.TOKEN_LEN * HALVES; // 16

/** A fresh 16-character token. */
function generate() {
  let out = '';
  for (let i = 0; i < HALVES; i++) out += token.generate();
  return out;
}

/**
 * The canonical form, or null. Accepts the same human leniency lib/token.js
 * does (hyphens, spaces, lowercase, O for 0, I and L for 1), because a token
 * copied out of a plain-text email sometimes arrives with a line break in it.
 */
function normalize(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s\-_.]/g, '');
  if (s.length !== LEN) return null;
  let out = '';
  for (let i = 0; i < HALVES; i++) {
    const half = token.normalize(s.slice(i * token.TOKEN_LEN, (i + 1) * token.TOKEN_LEN));
    if (!half) return null;
    out += half;
  }
  return out;
}

module.exports = { generate, normalize, LEN, HALVES };
