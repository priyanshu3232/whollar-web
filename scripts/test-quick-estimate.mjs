#!/usr/bin/env node
/* Unit tests for the homepage quick estimate (js/whollar-core.js):
 * W.estimateBenchFor, W.quickEstimate, W.estimateAreaLabel.
 *
 *   node --test scripts/test-quick-estimate.mjs
 *
 * Loads the generated table and then core as plain scripts, the same order
 * index.html uses. Both are classic scripts with no import/export, so a
 * dynamic import just runs them for their globalThis.WHOLLAR side effect.
 *
 * These assert BEHAVIOUR, not specific prices: the spreadsheet is refreshed
 * and a test pinned to "$43 in Toronto" would go red on a price change that
 * is not a defect. The one thing pinned is that the biggest metros resolve
 * at city basis, because that is what the ALIAS table exists to guarantee
 * and it is exactly what regresses silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
await import('file://' + join(ROOT, 'js/whollar-estimate-bench.js'));
await import('file://' + join(ROOT, 'js/whollar-core.js'));
const W = globalThis.WHOLLAR;

test('the generated table loaded', () => {
  assert.ok(Object.keys(W.ESTIMATE_BY_CITY).length > 400);
  assert.equal(Object.keys(W.ESTIMATE_BY_PROVINCE).length, 13);
  assert.ok(Object.keys(W.ESTIMATE_FSA_CITY).length > 1000);
});

test('every emitted record is complete and >= 100 Mbps', () => {
  const all = [...Object.values(W.ESTIMATE_BY_CITY), ...Object.values(W.ESTIMATE_BY_PROVINCE)];
  for (const r of all) {
    assert.ok(r.p > 0, 'a zero or negative monthly would render as free internet');
    assert.ok(r.mb >= 100, 'the 100 Mbps floor is what makes the comparison honest');
    assert.ok(typeof r.who === 'string' && r.who.length > 0, 'the provider is named on the card');
    assert.ok(r.eff >= r.p, 'eff includes upfront/24, so it can never be below the monthly');
  }
});

test('every FSA in the table points at a city that exists', () => {
  for (const [fsa, key] of Object.entries(W.ESTIMATE_FSA_CITY)) {
    assert.ok(W.ESTIMATE_BY_CITY[key], `${fsa} -> ${key} is a dead reference`);
  }
});

/* The metros the ALIAS table exists for. GeoNames splits Toronto into
   Scarborough/North York/Etobicoke and Montreal into its boroughs; if those
   aliases break, these fall to the province number without any other signal. */
test('the largest metros resolve at city basis', () => {
  const cases = [
    ['M5V 3A8', 'Toronto'], ['M1B 1A1', 'Toronto'], ['M2N 1A1', 'Toronto'],
    ['M9V 1A1', 'Toronto'], ['K1A 0B1', 'Ottawa'], ['K2K 1A1', 'Ottawa'],
    ['H2X 1Y4', 'Montreal'], ['H4L 1A1', 'Montreal'], ['H7N 1A1', 'Laval'],
    ['V6B 1A1', 'Vancouver'], ['T2P 1A1', 'Calgary'], ['T5J 1A1', 'Edmonton'],
    ['G1V 1A1', 'Quebec City'], ['L8P 1A1', 'Hamilton'], ['B3J 1A1', 'Halifax'],
    ['R3C 1A1', 'Winnipeg'], ['N9A 1A1', 'Windsor'], ['V8W 1A1', 'Victoria']
  ];
  for (const [pc, city] of cases) {
    const e = W.estimateBenchFor(pc);
    assert.ok(e, `${pc} did not resolve at all`);
    assert.equal(e.basis, 'city', `${pc} fell back to the province`);
    assert.equal(e.city, city, `${pc} resolved to ${e.city}`);
  }
});

test('an unmapped FSA falls back to the province, and says so', () => {
  /* GeoNames carries the administrative region for much of Quebec, not a
     city, so there is nothing to match and the province is the right answer.
     G1R is downtown Quebec City and is labelled "Capitale-Nationale": the
     largest known coverage gap, and the reason the basis has to reach the
     copy rather than being assumed to be local. The .coverage.txt beside
     the generated file lists every case. */
  for (const pc of ['G0A 1A0', 'G1R 1A1']) {
    const e = W.estimateBenchFor(pc);
    assert.ok(e, `${pc} produced no reference at all`);
    assert.equal(e.basis, 'province');
    assert.equal(e.city, null);
    assert.equal(e.provinceCode, 'QC');
  }
});

/* The alias table is the one hand-maintained mapping here, and a wrong entry
   is invisible: it produces a confident city answer from another city's
   prices. Montreal is the H prefix and Quebec City the G prefix throughout,
   so a Montreal-aliased FSA outside H is a mis-alias. */
test('no FSA is aliased across the Montreal / Quebec City boundary', () => {
  for (const [fsa, key] of Object.entries(W.ESTIMATE_FSA_CITY)) {
    if (key === 'QC|Montreal') assert.equal(fsa[0], 'H', `${fsa} -> Montreal`);
    if (key === 'QC|Quebec City') assert.equal(fsa[0], 'G', `${fsa} -> Quebec City`);
  }
});

test('the area label never presents a province number as local', () => {
  assert.equal(W.estimateAreaLabel(W.estimateBenchFor('M5V 3A8')), 'in Toronto');
  assert.equal(W.estimateAreaLabel(W.estimateBenchFor('G0A 1A0')), 'across Quebec');
  assert.equal(W.estimateAreaLabel(null), '');
});

test('annual = floor(monthly delta) * 12, rounded down', () => {
  const bench = W.estimateBenchFor('M5V 3A8').p;
  for (const [bill, expected] of [
    [bench + 10, 120], [bench + 10.9, 120], [bench + 0.99, 0], [bench + 1, 12]
  ]) {
    const e = W.quickEstimate(bill, 'M5V 3A8');
    assert.ok(e.ok);
    assert.equal(e.annual, expected, `bill ${bill} against benchmark ${bench}`);
  }
});

test('a bill at or below the benchmark is a real outcome, never a negative', () => {
  const bench = W.estimateBenchFor('M5V 3A8').p;
  for (const bill of [bench, bench - 1, bench - 20, W.ESTIMATE_BILL_MIN]) {
    const e = W.quickEstimate(bill, 'M5V 3A8');
    assert.ok(e.ok, `${bill} should still be a valid estimate`);
    assert.equal(e.atOrBelow, true);
    assert.equal(e.annual, 0);
    assert.ok(e.annual >= 0, 'a negative saving must never be produced');
  }
});

test('bills outside 20 to 400 are rejected, inclusive bounds accepted', () => {
  for (const bad of [19, 19.99, 400.01, 401, 0, -50, NaN, null, 'abc', undefined]) {
    assert.equal(W.quickEstimate(bad, 'M5V 3A8').reason, 'bill', `${bad} was accepted`);
  }
  for (const good of [20, 90, 400]) {
    assert.equal(W.quickEstimate(good, 'M5V 3A8').ok, true, `${good} was rejected`);
  }
});

test('invalid and incomplete postal codes are rejected', () => {
  /* "ZZZ9Q9" is the case the old length-only check let through, and K1D/K1F
     use letters Canada Post never issues. A bare FSA is rejected because it
     is far more often a half-typed entry than a deliberate one. */
  for (const bad of ['ZZZ9Q9', 'K1D 0B1', 'K1F 0B1', 'M5V', 'M5V 3A', '', '90210', null, undefined]) {
    assert.equal(W.quickEstimate(90, bad).reason, 'postal', `${bad} was accepted`);
  }
});

test('formatting and case do not change the answer', () => {
  const a = W.quickEstimate(90, 'M5V 3A8');
  for (const variant of ['m5v3a8', 'M5V3A8', ' m5v 3a8 ', 'M5v-3A8']) {
    assert.deepEqual(W.quickEstimate(90, variant), a, `${variant} differed`);
  }
});

test('only the FSA is retained, never the full code', () => {
  const e = W.quickEstimate(90, 'M5V 3A8');
  assert.equal(e.fsa, 'M5V');
  assert.equal(Object.values(e).includes('M5V 3A8'), false, 'the full code leaked into the result');
});

test('the annual figure stays inside what the backend accepts', () => {
  /* catalyst-backend/functions/formSubmit/index.js caps
     estimatedAnnualSavings at 5000. A cheaper benchmark or a wider bill
     range would push past it and every estimate would 400. */
  const all = [...Object.values(W.ESTIMATE_BY_CITY), ...Object.values(W.ESTIMATE_BY_PROVINCE)];
  const cheapest = Math.min(...all.map(r => r.p));
  assert.ok(Math.floor(W.ESTIMATE_BILL_MAX - cheapest) * 12 <= 5000);
});
