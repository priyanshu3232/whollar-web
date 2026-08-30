#!/usr/bin/env node
/* The speed ladder, held to the same answers in every runtime.
 *
 *   node --test scripts/test-tiers.mjs
 *
 * Three copies of the ladder exist: partner/core/tiers.js (the source), the
 * generated lib/tiers.js the Catalyst function requires, and a hand-kept
 * mirror inside dashboard.html, which is a classic script and cannot import
 * anything. build-tiers.mjs --check keeps the first two identical; this keeps
 * the third in step, and holds the snap rule to the cases the window rule
 * depends on: "Not sure" is null, not the lowest rung.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as browser from '../partner/core/tiers.js';
import { backend } from './backend-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = backend('lib/tiers.js');

const CASES = [
  ['', null], [null, null], ['0', null], [0, null], ['Not sure', null],
  ['25', null], ['49.9', null],
  ['50', '50 Mbps'], [50, '50 Mbps'], ['75', '50 Mbps'],
  ['100', '100 Mbps'], ['150', '100 Mbps'], ['299', '100 Mbps'],
  ['300', '300 Mbps'], ['500', '500 Mbps'], ['500 Mbps', '500 Mbps'],
  ['940', '500 Mbps'], ['1000', '1 Gig'], ['1 Gbps', '1 Gig'], ['1 Gig', '1 Gig'],
  ['1.5 Gig', '1.5 Gig'], ['1500', '1.5 Gig'], ['2500', '2.5 Gig'], ['8000', '2.5 Gig'],
];

test('tierForSpeed snaps at or below, and never below the ladder', () => {
  for (const [input, want] of CASES) {
    assert.equal(browser.tierForSpeed(input), want, `browser ${JSON.stringify(input)}`);
    assert.equal(server.tierForSpeed(input), want, `server ${JSON.stringify(input)}`);
  }
});

test('labels and Mbps round-trip', () => {
  for (const [mbps, label] of browser.TIER_LADDER) {
    assert.equal(browser.tierMbps(label), mbps);
    assert.equal(browser.tierLabel(mbps), label);
    assert.equal(server.tierMbps(label), mbps);
    assert.equal(server.tierLabel(mbps), label);
  }
  assert.equal(browser.tierMbps('200 Mbps'), null);
  assert.equal(browser.tierLabel(200), null);
  assert.equal(browser.tierIndex('1 Gig'), 4);
  assert.equal(browser.tierIndex('nope'), -1);
});

test('the dashboard mirror carries the same ladder', () => {
  const html = readFileSync(join(ROOT, 'dashboard.html'), 'utf8');
  const names = html.match(/^var TIERS=(\[[^\n]*\]);/m);
  const mbps = html.match(/^var TIERMBPS=(\{[^\n]*\});/m);
  assert.ok(names && mbps, 'dashboard.html declares TIERS and TIERMBPS');
  const tiers = JSON.parse(names[1].replace(/'/g, '"'));
  const map = JSON.parse(mbps[1].replace(/'/g, '"'));
  assert.deepEqual(tiers, [...browser.TIER_NAMES]);
  for (const [n, label] of browser.TIER_LADDER) assert.equal(map[label], n);
});

test('the console suggestion tables name only ladder tiers', () => {
  const src = readFileSync(join(ROOT, 'partner/views/ticket.js'), 'utf8');
  const m = src.match(/^var SUGG = (\{[^\n]*\});/m);
  assert.ok(m, 'ticket.js declares SUGG');
  const keys = Object.keys(JSON.parse(m[1].replace(/'/g, '"').replace(/(\w+):/g, '"$1":')));
  for (const k of keys) assert.ok(browser.TIER_NAMES.includes(k), `SUGG key ${k}`);
});
