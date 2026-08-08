#!/usr/bin/env node
/* Unit tests for WHOLLAR.selectBand (js/whollar-core.js).
 *
 *   node --test scripts/test-select-band.mjs
 *
 * Loads whollar-core.js as a plain script (it has no import/export
 * statements, so a dynamic import just executes it for its globalThis.
 * WHOLLAR side effect, same as loading it in a browser).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// whollar-core.js closes with `})(window);` (it's written for the browser
// only) — give it one so it attaches WHOLLAR to globalThis, same object.
globalThis.window = globalThis;
await import('file://' + join(ROOT, 'js/whollar-core.js'));
const selectBand = globalThis.WHOLLAR.selectBand;

/* Boundary table under test (see the comment above W.selectBand):
     1  ratio >= +0.15
     2  +0.05 <= ratio <  +0.15
     3  -0.05 <  ratio <  +0.05
     4  -0.20 <  ratio <= -0.05
     5  ratio <= -0.20
   base = 10000 cents ($100) throughout, so userPriceCents = base * (1 + ratio). */
const BASE = 10000;
const atRatio = r => Math.round(BASE * (1 + r));

test('band 1: at and above +0.15', () => {
  assert.equal(selectBand({ userPriceCents: atRatio(0.15), basePriceCents: BASE }).bandId, 1);
  assert.equal(selectBand({ userPriceCents: atRatio(0.30), basePriceCents: BASE }).bandId, 1);
});

test('band 2: midpoint and both boundaries', () => {
  assert.equal(selectBand({ userPriceCents: atRatio(0.05), basePriceCents: BASE }).bandId, 2, 'lower boundary +0.05 is band 2');
  assert.equal(selectBand({ userPriceCents: atRatio(0.10), basePriceCents: BASE }).bandId, 2, 'midpoint');
  assert.equal(selectBand({ userPriceCents: atRatio(0.1499), basePriceCents: BASE }).bandId, 2, 'just under the band-1 boundary');
});

test('band 3: midpoint (ratio 0) and the open boundaries just inside it', () => {
  assert.equal(selectBand({ userPriceCents: BASE, basePriceCents: BASE }).bandId, 3, 'ratio 0');
  assert.equal(selectBand({ userPriceCents: atRatio(0.0499), basePriceCents: BASE }).bandId, 3);
  assert.equal(selectBand({ userPriceCents: atRatio(-0.0499), basePriceCents: BASE }).bandId, 3);
});

test('band 4: midpoint and both boundaries, including onPromo=true (band 5 without a qualifying ratio)', () => {
  assert.equal(selectBand({ userPriceCents: atRatio(-0.05), basePriceCents: BASE }).bandId, 4, 'exactly -0.05 is band 4 per the table (see the contradicting-prose note in whollar-core.js)');
  assert.equal(selectBand({ userPriceCents: atRatio(-0.12), basePriceCents: BASE }).bandId, 4, 'midpoint');
  assert.equal(selectBand({ userPriceCents: atRatio(-0.1999), basePriceCents: BASE }).bandId, 4, 'just above the band-5 boundary');
});

test('band 5: at and below -0.20, only with onPromo and a real date', () => {
  const r = selectBand({ userPriceCents: atRatio(-0.20), basePriceCents: BASE, onPromo: true, promoEndDate: '2026-12-01' });
  assert.equal(r.bandId, 5, 'exactly -0.20 is band 5');
  const r2 = selectBand({ userPriceCents: atRatio(-0.40), basePriceCents: BASE, onPromo: true, promoEndDate: '2026-12-01' });
  assert.equal(r2.bandId, 5);
});

test('guardrail: basePriceCents null returns band 3 with benchmark + savings rows suppressed', () => {
  const r = selectBand({ userPriceCents: 9000, basePriceCents: null });
  assert.equal(r.bandId, 3);
  assert.equal(r.showBenchmarkRow, false);
  assert.equal(r.showSavingsRow, false);
  assert.equal(r.showPromoDateRow, false);
  assert.equal(r.savingsCents, 0);
});

test('guardrail: deltaRatio <= -0.20 with onPromo false returns band 4, not band 5', () => {
  const r = selectBand({ userPriceCents: atRatio(-0.30), basePriceCents: BASE, onPromo: false, promoEndDate: '2026-12-01' });
  assert.equal(r.bandId, 4);
  const r2 = selectBand({ userPriceCents: atRatio(-0.30), basePriceCents: BASE, promoEndDate: '2026-12-01' }); // onPromo omitted
  assert.equal(r2.bandId, 4);
});

test('guardrail: deltaRatio <= -0.20 with onPromo true but no promoEndDate returns band 4', () => {
  const r = selectBand({ userPriceCents: atRatio(-0.30), basePriceCents: BASE, onPromo: true, promoEndDate: null });
  assert.equal(r.bandId, 4);
});

test('savings never negative for bands 3, 4, 5', () => {
  assert.equal(selectBand({ userPriceCents: BASE, basePriceCents: BASE, periodMonths: 24 }).savingsCents, 0); // band 3
  assert.equal(selectBand({ userPriceCents: atRatio(-0.12), basePriceCents: BASE, periodMonths: 24 }).savingsCents, 0); // band 4
  const band5 = selectBand({ userPriceCents: atRatio(-0.30), basePriceCents: BASE, periodMonths: 24, onPromo: true, promoEndDate: '2026-12-01' });
  assert.equal(band5.showPromoDateRow, true);
  assert.equal(band5.savingsCents, null, 'band 5 replaces the savings row entirely, it does not render a negative number');
});

test('savings scales linearly with periodMonths for bands 1 and 2, stays 0 for bands 3/4', () => {
  const deltaPerMonth = 2000; // $20 over base
  const r12 = selectBand({ userPriceCents: BASE + deltaPerMonth, basePriceCents: BASE, periodMonths: 12 });
  const r24 = selectBand({ userPriceCents: BASE + deltaPerMonth, basePriceCents: BASE, periodMonths: 24 });
  assert.equal(r12.bandId, 1);
  assert.equal(r12.savingsCents, deltaPerMonth * 12);
  assert.equal(r24.savingsCents, deltaPerMonth * 24);
  assert.equal(r24.savingsCents, r12.savingsCents * 2);

  const band3at12 = selectBand({ userPriceCents: BASE, basePriceCents: BASE, periodMonths: 12 });
  const band3at36 = selectBand({ userPriceCents: BASE, basePriceCents: BASE, periodMonths: 36 });
  assert.equal(band3at12.savingsCents, 0);
  assert.equal(band3at36.savingsCents, 0);
});

test('integer cents throughout: no floating point drift on the period multiplication', () => {
  // A delta chosen to be an awkward float when divided/multiplied (e.g. cents that don't
  // divide evenly by common periods), to catch any stray non-integer creeping in.
  const r = selectBand({ userPriceCents: 10033, basePriceCents: 8877, periodMonths: 17 });
  assert.equal(Number.isInteger(r.savingsCents), true);
  assert.equal(r.savingsCents, (10033 - 8877) * 17);
});

test('defaults periodMonths to 24 when omitted or invalid', () => {
  const withDefault = selectBand({ userPriceCents: atRatio(0.20), basePriceCents: BASE });
  const explicit24 = selectBand({ userPriceCents: atRatio(0.20), basePriceCents: BASE, periodMonths: 24 });
  assert.equal(withDefault.savingsCents, explicit24.savingsCents);
});
