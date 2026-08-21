#!/usr/bin/env node
/* Unit tests for the opaque referral token: the format, the checksum, the
 * issuance retry, and how it coexists with the legacy derived code.
 *
 *   node --test scripts/test-referral-token.mjs
 *
 * WHY THE CHECKSUM TESTS ARE EXHAUSTIVE. The check character exists to catch
 * every single-character mistype and every transposition, and it only does so
 * because its modulus is prime (31). The first draft of this design used the
 * payload alphabet's own size, 30, and missed 6.9% of substitutions, because
 * 30 shares factors with the positional weights. A spot check passes under
 * either modulus; only sweeping every substitution of every position proves
 * the property that justifies spending a character on a checksum at all. So
 * the sweeps here permit zero misses, and a future alphabet change that
 * breaks the primality argument fails loudly.
 *
 * WHY THE COEXISTENCE TESTS EXIST. Two code forms resolve through one
 * normalize(): the legacy WHL-<8 hex> (a literal prefix of the member's
 * user_id, already in the wild) and the token. The count on the dashboard is
 * an exact string match on what normalize() stored, so an input routed to the
 * wrong form is a referral that silently never counts. The routing rule is
 * exact, not probabilistic: generate() never mints an all-hex payload, so
 * eight bare hex characters always mean legacy. Both halves of that contract
 * are asserted here, against the same modules production runs.
 *
 * No database: issueToken and tokenFor take the catalyst app as a parameter,
 * so a fake with a scripted zcql/insertRow is a real test of the retry and
 * lazy-mint logic, not a mock of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { backend } from './backend-module.mjs';

const token = backend('lib/token.js');
const referral = backend('lib/referral.js');
const datastore = backend('lib/datastore.js');

const { PAYLOAD_ALPHABET, CHECK_ALPHABET, PAYLOAD_LEN, TOKEN_LEN } = token;

/* ------------------------------------------------------------------ *
 * Format
 * ------------------------------------------------------------------ */

test('generate returns 8 characters: 7 payload, 1 check', () => {
  for (let i = 0; i < 1000; i++) {
    const t = token.generate();
    assert.equal(t.length, TOKEN_LEN, t);
    for (const c of t.slice(0, PAYLOAD_LEN)) {
      assert.ok(PAYLOAD_ALPHABET.includes(c), `payload char ${c} in ${t}`);
    }
    assert.ok(CHECK_ALPHABET.includes(t[PAYLOAD_LEN]), `check char of ${t}`);
    assert.equal(token.normalize(t), t, `generated token must self-normalize: ${t}`);
  }
});

test('no minted payload reads as hexadecimal', () => {
  // The disambiguation guarantee: all-hex means legacy, so generate() must
  // never produce a payload made only of 0-9 B C D F.
  for (let i = 0; i < 2000; i++) {
    const payload = token.generate().slice(0, PAYLOAD_LEN);
    assert.ok(!/^[0-9BCDF]{7}$/.test(payload), `hex-lookalike payload minted: ${payload}`);
  }
});

test('the alphabets are what the checksum argument depends on', () => {
  assert.equal(PAYLOAD_ALPHABET.length, 30);
  assert.equal(CHECK_ALPHABET.length, 31); // prime, and that primality is load bearing
  for (const c of 'AEILOU') assert.ok(!PAYLOAD_ALPHABET.includes(c), c);
  assert.ok(CHECK_ALPHABET.endsWith('A'), 'A is the reclaimed 31st symbol');
});

/* ------------------------------------------------------------------ *
 * Checksum: exhaustive, zero misses permitted
 * ------------------------------------------------------------------ */

test('every single-character payload substitution is caught', () => {
  for (let n = 0; n < 200; n++) {
    const t = token.generate();
    const payload = t.slice(0, PAYLOAD_LEN);
    for (let i = 0; i < PAYLOAD_LEN; i++) {
      for (const c of PAYLOAD_ALPHABET) {
        if (c === payload[i]) continue;
        const mutated = payload.slice(0, i) + c + payload.slice(i + 1) + t[PAYLOAD_LEN];
        assert.equal(token.normalize(mutated), null, `undetected substitution: ${t} -> ${mutated}`);
      }
    }
  }
});

test('every payload transposition is caught, adjacent or not', () => {
  for (let n = 0; n < 200; n++) {
    const t = token.generate();
    const payload = t.slice(0, PAYLOAD_LEN).split('');
    for (let i = 0; i < PAYLOAD_LEN; i++) {
      for (let j = i + 1; j < PAYLOAD_LEN; j++) {
        if (payload[i] === payload[j]) continue;
        const swapped = payload.slice();
        [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
        const mutated = swapped.join('') + t[PAYLOAD_LEN];
        assert.equal(token.normalize(mutated), null, `undetected transposition: ${t} -> ${mutated}`);
      }
    }
  }
});

test('a corrupted check character is caught', () => {
  const t = token.generate();
  for (const c of CHECK_ALPHABET) {
    if (c === t[PAYLOAD_LEN]) continue;
    assert.equal(token.normalize(t.slice(0, PAYLOAD_LEN) + c), null);
  }
});

/* ------------------------------------------------------------------ *
 * Leniency and rejection
 * ------------------------------------------------------------------ */

test('hyphens, spaces and case are forgiven', () => {
  const t = token.generate();
  const shown = token.display(t);
  assert.equal(shown, t.slice(0, 4) + '-' + t.slice(4));
  for (const input of [shown, shown.toLowerCase(), ` ${t.toLowerCase()} `, t.slice(0, 2) + ' ' + t.slice(2)]) {
    assert.equal(token.normalize(input), t, `input: ${JSON.stringify(input)}`);
  }
});

test('O reads as 0, I and L read as 1', () => {
  // Build payloads containing the character the substitution maps to, so the
  // lenient reading lands on a real token.
  const withZero = '0' + 'KMPQTV'; // 7 chars, contains 0, not all hex-lookalike
  const withOne = '1' + 'KMPQTV';
  const t0 = withZero + token.checkChar(withZero);
  const t1 = withOne + token.checkChar(withOne);
  assert.equal(token.normalize('O' + 'KMPQTV' + t0[7]), t0);
  assert.equal(token.normalize('I' + 'KMPQTV' + t1[7]), t1);
  assert.equal(token.normalize('L' + 'KMPQTV' + t1[7]), t1);
});

test('wrong lengths, foreign characters and A in the payload are rejected', () => {
  const t = token.generate();
  assert.equal(token.normalize(t.slice(0, 7)), null, '7 characters');
  assert.equal(token.normalize(t + t[0]), null, '9 characters');
  assert.equal(token.normalize("' OR 1=1 --"), null, 'injection shape');
  assert.equal(token.normalize(null), null);
  assert.equal(token.normalize(42), null);
  // A is legal in the check position only.
  const withA = 'A' + t.slice(1);
  assert.equal(token.normalize(withA), null, 'A in the payload');
});

test('every normalized token passes the ZCQL literal whitelist', () => {
  // normalize() is the injection defence on this path; lit() is the second
  // lock on the same door. Both must accept every token that can exist.
  for (let i = 0; i < 500; i++) {
    const t = token.generate();
    assert.equal(datastore.lit(t), `'${t}'`);
  }
});

/* ------------------------------------------------------------------ *
 * Coexistence with the legacy derived code
 * ------------------------------------------------------------------ */

test('referral.normalize routes each form to its own system', () => {
  const t = token.generate();
  assert.equal(referral.normalize(t), t, 'a token normalizes to itself');
  assert.equal(referral.normalize(token.display(t)), t, 'display form too');
  assert.ok(referral.isTokenForm(referral.normalize(t)));

  // Legacy forms are untouched by the token path.
  assert.equal(referral.normalize('WHL-3F9A2C1D'), 'WHL-3F9A2C1D');
  assert.equal(referral.normalize('whl 3f9a2c1d'), 'WHL-3F9A2C1D');
  assert.ok(!referral.isTokenForm('WHL-3F9A2C1D'));
});

test('eight bare hex characters are always legacy, even when they checksum', () => {
  // '00000000' passes the token checksum (sum 0 -> check '0'), which is
  // exactly why generate() refuses all-hex payloads: the rule below must be
  // unconditional or 1 in 31 bare legacy cores would silently stop counting.
  assert.equal(token.normalize('00000000'), '00000000', 'the ambiguity is real');
  assert.equal(referral.normalize('00000000'), 'WHL-00000000', 'and normalize resolves it to legacy');
  assert.equal(referral.normalize('3F9A2C1D'), 'WHL-3F9A2C1D');
});

test('what is neither form reads as no code', () => {
  for (const input of ['', null, undefined, 'neighbour@example.ca', 'WHL-PRIYA-7', "' OR 1=1 --", 'zzzzzzzz']) {
    assert.equal(referral.normalize(input), null, `input: ${JSON.stringify(input)}`);
  }
});

/* ------------------------------------------------------------------ *
 * Fakes for the storage-touching halves
 * ------------------------------------------------------------------ */

/**
 * A catalyst app whose datastore and zcql are scripted.
 *   inserts: array of Error (thrown) or null (accepted), consumed per call
 *   query:   (sql) => rows, for everything read through zcql
 */
function fakeApp({ inserts = [], query = () => [] } = {}) {
  const state = { insertCalls: 0, rows: [], queries: [] };
  return {
    state,
    datastore: () => ({
      table: () => ({
        insertRow: async (row) => {
          const step = state.insertCalls < inserts.length ? inserts[state.insertCalls] : null;
          state.insertCalls += 1;
          if (step instanceof Error) throw step;
          state.rows.push(row);
          return row;
        },
      }),
    }),
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        state.queries.push(sql);
        return query(sql);
      },
    }),
  };
}

// The real wording, confirmed against the Development console 2026-08-21:
// a second insert of an existing token errors with exactly this text.
const duplicateError = () => new Error('Duplicate value for token. Please give a different value');

/* ------------------------------------------------------------------ *
 * Issuance
 * ------------------------------------------------------------------ */

test('a collision regenerates and the second attempt inserts cleanly', async () => {
  const app = fakeApp({ inserts: [duplicateError(), null] });
  const t = await referral.issueToken(app, 'member', 'user-1');
  assert.equal(app.state.insertCalls, 2);
  assert.equal(app.state.rows.length, 1);
  assert.equal(app.state.rows[0].token, t);
  assert.equal(app.state.rows[0].owner_type, 'member');
  assert.equal(app.state.rows[0].status, 'active');
  assert.equal(app.state.rows[0].clicks, 0);
  // Catalyst's format, never ISO-8601: the store rejects toISOString().
  assert.match(app.state.rows[0].issued_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('issuance stops at five attempts and then raises', async () => {
  const app = fakeApp({ inserts: [duplicateError(), duplicateError(), duplicateError(), duplicateError(), duplicateError(), duplicateError()] });
  await assert.rejects(() => referral.issueToken(app, 'member', 'user-1'), /exhausted retries/);
  assert.equal(app.state.insertCalls, 5, 'not a loop that can spin');
});

test('a non-duplicate failure raises immediately, not after five round trips', async () => {
  const app = fakeApp({ inserts: [new Error('No such Table with the given name exists')] });
  await assert.rejects(() => referral.issueToken(app, 'member', 'user-1'), /No such Table/);
  assert.equal(app.state.insertCalls, 1, 'a missing table is not retried');
});

/* ------------------------------------------------------------------ *
 * tokenFor: the lazy mint
 * ------------------------------------------------------------------ */

const USER = { user_id: 'u-1' };

test('an existing active token is returned, nothing is minted', async () => {
  const app = fakeApp({ query: () => [{ token: 'K7MQT4WB', status: 'active', ROWID: 1 }] });
  assert.equal(await referral.tokenFor(app, USER), 'K7MQT4WB');
  assert.equal(app.state.insertCalls, 0);
});

test('a member with only a suspended token gets null, not a fresh mint', async () => {
  const app = fakeApp({ query: () => [{ token: 'K7MQT4WB', status: 'suspended', ROWID: 1 }] });
  assert.equal(await referral.tokenFor(app, USER), null);
  assert.equal(app.state.insertCalls, 0, 'suspension is a decision, not a gap to fill');
});

test('a member with no token gets one minted on first ask', async () => {
  const app = fakeApp({ query: () => [] });
  const t = await referral.tokenFor(app, USER);
  assert.equal(t.length, TOKEN_LEN);
  assert.equal(app.state.insertCalls, 1);
});

test('a store that cannot answer yields null, never a throw', async () => {
  const app = fakeApp({ query: () => { throw new Error('table missing'); } });
  assert.equal(await referral.tokenFor(app, USER), null);
  assert.equal(await referral.tokenFor(app, null), null);
});

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/** Scripted answers: tokens table then users table, matched on the FROM. */
function resolverApp({ tokenRow, ownerRow }) {
  return fakeApp({
    query: (sql) => {
      if (/FROM referral_token/i.test(sql)) return tokenRow ? [tokenRow] : [];
      if (/FROM users/i.test(sql)) return ownerRow ? [ownerRow] : [];
      throw new Error(`unexpected query: ${sql}`);
    },
  });
}

test('an active member token resolves to its owner', async () => {
  const t = token.generate();
  const app = resolverApp({
    tokenRow: { owner_type: 'member', owner_id: 'u-9', status: 'active' },
    ownerRow: { user_id: 'u-9', first_name: 'Priya', email_normalized: 'p@x.ca', status: 'active' },
  });
  const resolved = await referral.resolve(app, t);
  assert.equal(resolved && resolved.user_id, 'u-9');
  assert.equal(resolved.first_name, 'Priya');
});

test('a suspended token resolves to nobody', async () => {
  const t = token.generate();
  const app = resolverApp({
    tokenRow: { owner_type: 'member', owner_id: 'u-9', status: 'suspended' },
    ownerRow: { user_id: 'u-9', first_name: 'Priya', email_normalized: 'p@x.ca', status: 'active' },
  });
  assert.equal(await referral.resolve(app, t), null);
});

test('a partner-owned token does not resolve through the member path', async () => {
  const t = token.generate();
  const app = resolverApp({
    tokenRow: { owner_type: 'partner', owner_id: 'org-1', status: 'active' },
    ownerRow: { user_id: 'org-1', first_name: 'North', email_normalized: 'n@x.ca', status: 'active' },
  });
  assert.equal(await referral.resolve(app, t), null);
});

test('a deleted owner does not resolve', async () => {
  const t = token.generate();
  const app = resolverApp({
    tokenRow: { owner_type: 'member', owner_id: 'u-9', status: 'active' },
    ownerRow: { user_id: 'u-9', first_name: 'Priya', email_normalized: 'p@x.ca', status: 'deleted' },
  });
  assert.equal(await referral.resolve(app, t), null);
});

test('a store that cannot answer resolution yields null', async () => {
  const t = token.generate();
  const app = fakeApp({ query: () => { throw new Error('down'); } });
  assert.equal(await referral.resolve(app, t), null);
});

/* ------------------------------------------------------------------ *
 * Counting across both forms
 * ------------------------------------------------------------------ */

test('one referrer, two stored forms, one number', async () => {
  const byCode = {
    "'WHL-3F9A2C1D'": [
      { ROWID: 1, user_id: 'a', status: 'active' },
      { ROWID: 2, user_id: 'b', status: 'pending' },
      { ROWID: 3, user_id: 'self', status: 'active' },
    ],
    "'K7MQT4WB'": [
      { ROWID: 4, user_id: 'c', status: 'active' },
      { ROWID: 5, user_id: 'a', status: 'active' }, // impossible twice, asserted anyway
    ],
  };
  const app = fakeApp({
    query: (sql) => {
      for (const [lit, rows] of Object.entries(byCode)) {
        if (sql.includes(`referral_code = ${lit}`)) return rows;
      }
      return [];
    },
  });
  const count = await referral.countFor(app, ['WHL-3F9A2C1D', 'K7MQT4WB', null], 'self');
  assert.deepEqual(count, { joined: 2, pending: 1 }, 'self excluded, duplicate user counted once, null code skipped');
});

test('no codes means zero, and an unreadable store means zero', async () => {
  const throwing = fakeApp({ query: () => { throw new Error('down'); } });
  assert.deepEqual(await referral.countFor(throwing, ['WHL-3F9A2C1D'], 'self'), { joined: 0, pending: 0 });
  assert.deepEqual(await referral.countFor(fakeApp(), [], 'self'), { joined: 0, pending: 0 });
  assert.deepEqual(await referral.countFor(fakeApp(), null, 'self'), { joined: 0, pending: 0 });
});
