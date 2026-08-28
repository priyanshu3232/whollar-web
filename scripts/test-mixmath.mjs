#!/usr/bin/env node
/* The custom mix arithmetic, and the one property it exists for.
 *
 *   node --test scripts/test-mixmath.mjs
 *
 * A mix splits a tier's reduction into named cents. The property: for ANY
 * gap and ANY shares that total 100%, the cents total the gap, exactly. Not
 * within a cent; exactly. A household reads those line items under an
 * effective price the partner promised, and a cent that went missing in
 * rounding is a cent the record cannot explain.
 *
 * The second thing checked is that the console's copy and the server's copy
 * are the same function. build-mixmath.mjs --check keeps the files identical;
 * this keeps the behaviour identical, on the same thousand cases, which is
 * the check that would catch a generator bug rather than a stale file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as browser from '../partner/core/mixmath.js';
import { backend } from './backend-module.mjs';

const server = backend('lib/mixmath.js');

/* A fixed-seed generator, so a failing case is the same case tomorrow. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** n shares in tenths that total exactly 1000, none zero. */
function shares(rand, n) {
  const cuts = new Set();
  while (cuts.size < n - 1) cuts.add(1 + Math.floor(rand() * 999));
  const points = [0, ...[...cuts].sort((a, b) => a - b), 1000];
  const out = [];
  for (let i = 1; i < points.length; i++) out.push(points[i] - points[i - 1]);
  return out;
}

test('property: sum(amounts) === gap for 1,000 random gaps and share sets', () => {
  const rand = lcg(20260828);
  for (let k = 0; k < 1000; k++) {
    const gap = Math.floor(rand() * 50000) + (rand() < 0.1 ? 0 : 1);
    const n = 1 + Math.floor(rand() * 5);
    const t = shares(rand, n);
    const a = browser.allocate(gap, t);
    assert.equal(a.length, n, `case ${k}: one amount per row`);
    assert.equal(a.reduce((x, y) => x + y, 0), gap, `case ${k}: gap ${gap} shares ${t.join('/')}`);
    a.forEach((c) => assert.ok(Number.isInteger(c) && c >= 0, `case ${k}: whole non-negative cents`));
    assert.deepEqual(server.allocate(gap, t), a, `case ${k}: the server copy lands on the same cents`);
  }
});

test('the motivating example: $100 sticker, $80 effective, 50/50 is $10 and $10', () => {
  const snap = browser.tierSnapshot(
    { name: '300 Mbps', stickerPrice: '100', effectivePrice: '80' },
    [{ type: 'member', sharePct: '50' }, { type: 'promo', sharePct: '50' }], 24);
  assert.equal(snap.gapCents, 2000);
  assert.deepEqual(snap.mix.map((r) => r.amountCents), [1000, 1000]);
  assert.deepEqual(snap.mix.map((r) => r.label), ['Member discount', 'Promotional credit']);
  assert.deepEqual(snap.mix.map((r) => [r.periodStartMo, r.periodEndMo]), [[0, 24], [0, 24]]);
});

test('70/30 across two tiers: $50 gap is $35/$15, $21 gap is $14.70/$6.30', () => {
  const rows = [{ type: 'member', sharePct: '70' }, { type: 'promo', sharePct: '30' }];
  const a = browser.tierSnapshot({ name: '300 Mbps', stickerPrice: '100', effectivePrice: '50' }, rows, 24);
  const b = browser.tierSnapshot({ name: '100 Mbps', stickerPrice: '65', effectivePrice: '44' }, rows, 24);
  assert.deepEqual(a.mix.map((r) => r.amountCents), [3500, 1500]);
  assert.deepEqual(b.mix.map((r) => r.amountCents), [1470, 630]);
});

test('largest remainder: a one-cent gap at 50/50 is $0.01 and $0.00, first row wins the tie', () => {
  assert.deepEqual(browser.allocate(1, [500, 500]), [1, 0]);
  assert.deepEqual(browser.allocate(3, [500, 500]), [2, 1]);
  /* 33.3 / 33.3 / 33.4 on $1.00: floors 33, 33, 33, remainders 300, 300, 400. */
  assert.deepEqual(browser.allocate(100, [333, 333, 334]), [33, 33, 34]);
});

test('a $1 gap over five rows: some rows floor to $0 and the total still lands', () => {
  const a = browser.allocate(100, [50, 50, 50, 50, 800]);
  assert.equal(a.reduce((x, y) => x + y, 0), 100);
  assert.deepEqual(a, [5, 5, 5, 5, 80]);
  const b = browser.allocate(7, [10, 10, 10, 10, 960]);
  assert.equal(b.reduce((x, y) => x + y, 0), 7);
  assert.ok(b.some((c) => c === 0), 'at least one row rounds to nothing');
});

test('shares that do not total 100% are floored and not padded', () => {
  assert.deepEqual(browser.allocate(1000, [500, 400]), [500, 400]);
  assert.deepEqual(browser.allocate(1000, [600, 500]), [600, 500]);
});

test('shareTenths: one decimal, comma accepted, everything else refused', () => {
  assert.equal(browser.shareTenths('50'), 500);
  assert.equal(browser.shareTenths('33.3'), 333);
  assert.equal(browser.shareTenths('33,3'), 333);
  assert.equal(browser.shareTenths(' 100 '), 1000);
  assert.equal(browser.shareTenths('0'), 0);
  assert.equal(browser.shareTenths(33.3), 333);
  assert.equal(browser.shareTenths('33.33'), null);
  assert.equal(browser.shareTenths('-5'), null);
  assert.equal(browser.shareTenths('101'), null);
  assert.equal(browser.shareTenths('abc'), null);
  assert.equal(browser.shareTenths(''), null);
  assert.equal(browser.shareTenths('.5'), null);
  assert.equal(browser.shareTenths(null), null);
});

test('fmtShare and centsStr read the way a partner reads them', () => {
  assert.equal(browser.fmtShare(500), '50');
  assert.equal(browser.fmtShare(333), '33.3');
  assert.equal(browser.fmtShare(1000), '100');
  assert.equal(browser.centsStr(1000), '10.00');
  assert.equal(browser.centsStr(1470), '14.70');
  assert.equal(browser.centsStr(5), '0.05');
  assert.equal(browser.centsStr(0), '0.00');
});

test('checkMix: under and over say the arithmetic, in the copy the panel shows', () => {
  const under = browser.checkMix([{ type: 'member', sharePct: '41' }, { type: 'promo', sharePct: '41' }]);
  assert.equal(under.ok, false);
  assert.equal(under.problems[0], 'Your mix covers 82% of the reduction. Add 18% more.');
  const over = browser.checkMix([{ type: 'member', sharePct: '60' }, { type: 'promo', sharePct: '50' }]);
  assert.equal(over.ok, false);
  assert.equal(over.problems[0], 'Your mix adds to 110% of the reduction. Remove 10%.');
  const over2 = browser.checkMix([{ type: 'member', sharePct: '65' }, { type: 'promo', sharePct: '50' }]);
  assert.equal(over2.problems[0], 'Your mix adds to 115% of the reduction. Remove 15%.');
  const dec = browser.checkMix([{ type: 'member', sharePct: '33.3' }, { type: 'promo', sharePct: '33.3' }, { type: 'cash', sharePct: '33.4' }]);
  assert.equal(dec.ok, true, 'one decimal place sums exactly, no epsilon');
  assert.equal(dec.sumTenths, 1000);
});

test('checkMix: a single row carries the whole reduction whatever its input says', () => {
  const one = browser.checkMix([{ type: 'member', sharePct: '' }]);
  assert.equal(one.ok, true);
  assert.equal(one.sumTenths, 1000);
  assert.equal(one.rows[0].tenths, 1000);
});

test('checkMix: row-level problems block, duplicates only warn', () => {
  const zero = browser.checkMix([{ type: 'member', sharePct: '100' }, { type: 'promo', sharePct: '0' }]);
  assert.equal(zero.ok, false);
  assert.ok(zero.problems.includes('Every row needs a share above zero, or remove the row.'));
  const empty = browser.checkMix([{ type: 'member', sharePct: '100' }, { type: 'promo', sharePct: '' }]);
  assert.ok(empty.problems.includes('Every row needs a share above zero, or remove the row.'));
  const unnamed = browser.checkMix([{ type: 'member', sharePct: '50' }, { type: 'own', label: '', sharePct: '50' }]);
  assert.equal(unnamed.ok, false);
  assert.ok(unnamed.problems.includes('Give this discount a name households will see.'));
  const short = browser.checkMix([{ type: 'member', sharePct: '50' }, { type: 'own', label: 'ab', sharePct: '50' }]);
  assert.ok(short.problems.includes('Name this discount in 3 to 40 plain characters.'));
  const pressure = browser.checkMix([{ type: 'member', sharePct: '50' }, { type: 'own', label: 'Today only rate', sharePct: '50' }]);
  assert.equal(pressure.ok, false);
  const dup = browser.checkMix([{ type: 'member', sharePct: '50' }, { type: 'own', label: 'Member discount', sharePct: '50' }]);
  assert.equal(dup.ok, true);
  assert.equal(dup.warnings.length, 1);
  const six = browser.checkMix(Array.from({ length: 6 }, () => ({ type: 'member', sharePct: '10' })));
  assert.equal(six.ok, false);
  const bad = browser.checkMix([{ type: 'member', sharePct: '50' }, { type: 'promo', sharePct: '50.55' }]);
  assert.ok(bad.problems.includes('Enter each share as a number from 0.1 to 100, with one decimal at most.'));
});

test('tierSnapshot: a zero gap names nothing, a negative gap is reported and names nothing', () => {
  const flat = browser.tierSnapshot({ name: '1 Gig', stickerPrice: '99', effectivePrice: '99' }, [{ type: 'member', sharePct: '100' }], 24);
  assert.equal(flat.gapCents, 0);
  assert.deepEqual(flat.mix, []);
  const neg = browser.tierSnapshot({ name: '1 Gig', stickerPrice: '90', effectivePrice: '99' }, [{ type: 'member', sharePct: '100' }], 24);
  assert.equal(neg.gapCents, -900);
  assert.deepEqual(neg.mix, []);
});

test('the server copy exports the same names and agrees on validation copy', () => {
  for (const k of Object.keys(browser)) {
    assert.equal(typeof server[k], typeof browser[k], `server exports ${k}`);
  }
  const rows = [{ type: 'member', sharePct: '60' }, { type: 'promo', sharePct: '50' }];
  assert.deepEqual(server.checkMix(rows), browser.checkMix(rows));
  const snapB = browser.tierSnapshot({ name: '300 Mbps', stickerPrice: '100', effectivePrice: '50' }, rows, 12);
  const snapS = server.tierSnapshot({ name: '300 Mbps', stickerPrice: '100', effectivePrice: '50' }, rows, 12);
  assert.deepEqual(snapS, snapB);
});
