#!/usr/bin/env node
/* Unit tests for referral codes, both sides of them.
 *
 *   node --test scripts/test-referral.mjs
 *
 * WHY THIS IS IN CI. The referral loop is two independent implementations of
 * one string: lib/referral.js normalises what gets stored, and the browser's
 * W.referral normalises what a share link banks and what the join form sends.
 * The count on the dashboard is an exact string match between them. If the two
 * ever disagree by a character, nothing errors anywhere: codes store, links
 * follow, signups succeed, and every referral silently counts as zero.
 *
 * That is not hypothetical. It is what the previous version shipped: the
 * dashboard displayed `WHL-<FIRSTNAME>-7` while the server counted
 * `WHL-<hex>`, so the feature could never have attributed anybody. The last
 * test here is the one that stops it recurring: the same inputs through both
 * implementations, asserted equal.
 *
 * The browser half is the real file, loaded in a vm with the handful of
 * globals it touches, rather than a copy of the rule pasted in here. A copy
 * would pass its own tests while disagreeing with what ships.
 *
 * No database: codeFor / coreOf / normalize are pure, and resolve returns
 * before it queries for anything unparseable, which is asserted below with a
 * store that throws if it is reached at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backend, ROOT } from './backend-module.mjs';

const referral = backend('lib/referral.js');

/** js/whollar-core.js, loaded as a browser would, with a link in the URL. */
function loadCore(search = '') {
  const store = {};
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URLSearchParams,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    location: { search, origin: 'https://www.whollar.ca', href: 'https://www.whollar.ca/' },
    document: {
      addEventListener() {}, readyState: 'complete', documentElement: {},
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    },
    navigator: { userAgent: 'node' },
    fetch: () => Promise.reject(new Error('no network in tests')),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(ROOT, 'js/whollar-core.js'), 'utf8'), sandbox, {
    filename: 'whollar-core.js',
  });
  return sandbox.WHOLLAR;
}

const UID = '3f9a2c1d-77b4-4b0e-9f2a-6d1c5e8a0b31';
const INPUTS = [
  'WHL-3F9A2C1D', 'whl-3f9a2c1d', 'whl 3f9a2c1d', '3F9A2C1D', ' WHL-3F9A2C1D ',
  'whl-priyanshu-3f9a2c1d', 'WHL-PRIYA-7', 'WHL-3F9A', 'neighbour@example.ca',
  '', 'zzzzzzzz', '00000000', 'WHL-FFFFFFFF', '3F9A2C1',
];

test('codeFor is the id prefix, uppercased', () => {
  assert.equal(referral.codeFor({ user_id: UID }), 'WHL-3F9A2C1D');
});

test('the code is a literal prefix of the id it came from', () => {
  // This is the property that lets `user_id LIKE 'hex%'` resolve a typed code.
  const core = referral.coreOf(referral.codeFor({ user_id: UID }));
  assert.ok(UID.startsWith(core), `${UID} does not start with ${core}`);
});

test('every form a human or a link produces reads as the same code', () => {
  for (const input of [
    'WHL-3F9A2C1D', 'whl-3f9a2c1d', 'whl 3f9a2c1d', '3F9A2C1D',
    ' WHL-3F9A2C1D ', 'whl-priyanshu-3f9a2c1d',
  ]) {
    assert.equal(referral.normalize(input), 'WHL-3F9A2C1D', `input: ${input}`);
  }
});

test('what is not a code reads as no code', () => {
  for (const input of [
    '', null, undefined, 'WHL-', 'WHL-3F9A', 'WHL-PRIYA-7',
    'neighbour@example.ca', 'not hex zzzzzzzz', '3F9A2C1',
  ]) {
    assert.equal(referral.normalize(input), null, `input: ${JSON.stringify(input)}`);
  }
});

test('an unparseable code never reaches the store', async () => {
  const store = { zcql: () => { throw new Error('reached the store'); } };
  assert.equal(await referral.resolve(store, 'WHL-PRIYA-7'), null);
  assert.equal(await referral.resolve(store, ''), null);
});

test('a share link is banked on arrival and spent later', () => {
  const W = loadCore('?ref=WHL-3f9a2c1d');
  assert.equal(W.referral.pending(), 'WHL-3F9A2C1D');
  W.referral.clear();
  assert.equal(W.referral.pending(), null, 'a spent code must not be re-attributed');
});

test('a page with no link in its URL banks nothing', () => {
  const W = loadCore('?demo=1');
  assert.equal(W.referral.pending(), null);
});

test('the share link round-trips through capture', () => {
  const W = loadCore('');
  const link = W.referral.link('WHL-3F9A2C1D');
  assert.equal(link, 'https://www.whollar.ca/waitlist/?ref=WHL-3F9A2C1D');
  const landed = loadCore(link.slice(link.indexOf('?')));
  assert.equal(landed.referral.pending(), 'WHL-3F9A2C1D');
});

test('server and browser normalise identically', () => {
  const W = loadCore('');
  for (const input of INPUTS) {
    assert.equal(
      W.referral.normalize(input), referral.normalize(input),
      `browser and server disagree on ${JSON.stringify(input)}`
    );
  }
});
