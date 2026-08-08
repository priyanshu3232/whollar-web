#!/usr/bin/env node
/* Unit tests for WHOLLAR.buildSchedule / WHOLLAR.contractQuote
 * (js/whollar-core.js) — the contract schedule engine behind the checkup
 * card's savings total.
 *
 *   node --test scripts/test-contract-quote.mjs
 *
 * Loads whollar-core.js as a plain script, same trick as
 * scripts/test-select-band.mjs: the file has no import/export statements, so
 * a dynamic import just executes it for its globalThis.WHOLLAR side effect.
 *
 * Money is integer cents throughout, matching the engine. `today` is passed
 * explicitly in every case so the suite never depends on the wall clock.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
await import('file://' + join(ROOT, 'js/whollar-core.js'));
const { buildSchedule, contractQuote, addMonths, selectBand } = globalThis.WHOLLAR;

const D = d => d * 100; // dollars -> cents, for legibility below
const BENCH = D(70);    // the benchmark in every case that has one

test('promo runs to its end date, then the regular price takes over', () => {
  // 36 months from 2025-06-08, $80 while the promo lasts, $120 after it ends
  // on 2026-11-26. Bills land on the 8th, so the last promo bill is
  // 2026-11-08 — cycle 18.
  const s = buildSchedule({
    termMonths: 36,
    regularPriceCents: D(120),
    discountPriceCents: D(80),
    contractStart: '2025-06-08',
    promoEnd: '2026-11-26'
  });
  assert.equal(s.prices.length, 36);
  assert.equal(s.prices.filter(p => p === D(80)).length, 18);
  assert.equal(s.prices.filter(p => p === D(120)).length, 18);
  assert.equal(s.flags.assumedStart, false);
  assert.equal(s.flags.assumedPromoMonths, null);
});

test('elapsed cycles, and forward savings over what is left of the term', () => {
  const q = contractQuote({
    termMonths: 36,
    regularPriceCents: D(120),
    discountPriceCents: D(80),
    contractStart: '2025-06-08',
    promoEnd: '2026-11-26',
    basePriceCents: BENCH,
    today: '2026-08-08'
  });
  // Jun 8 2025 through Aug 8 2026 inclusive is 15 bills.
  assert.equal(q.months.elapsed, 15);
  assert.equal(q.months.remaining, 21);
  assert.equal(q.months.horizon, 21, 'no horizon given -> the whole remainder');
  assert.equal(q.nowCents, D(80), 'still inside the promo today');

  // 15 billed at $80 = $1200 against 15 * $70 = $1050.
  assert.equal(q.toDate.payCents, D(1200));
  assert.equal(q.toDate.differenceCents, D(150));

  // Ahead: 3 more promo months at $80 + 18 at $120 = $2400, against
  // 21 * $70 = $1470.
  assert.equal(q.forward.payCents, D(2400));
  assert.equal(q.forward.atMarketCents, D(1470));
  assert.equal(q.forward.savingsCents, D(930));
  assert.equal(q.total.differenceCents, D(1080), '36 months, whole term');
  assert.equal(q.flags.priceChangesInHorizon, true);
  assert.equal(q.flags.atOrBelowMarket, false);
});

test('the cliff inside the window is exactly what months x today\'s gap misses', () => {
  // Same household as above. The old flat maths — 21 months at today's $80
  // against $70 — would have promised $210. The schedule says $930 because
  // eighteen of those bills are $120, not $80.
  const flat = 21 * (D(80) - BENCH);
  assert.equal(flat, D(210));
  const q = contractQuote({
    termMonths: 36, regularPriceCents: D(120), discountPriceCents: D(80),
    contractStart: '2025-06-08', promoEnd: '2026-11-26',
    basePriceCents: BENCH, today: '2026-08-08'
  });
  assert.equal(q.forward.savingsCents, D(930));
  assert.notEqual(q.forward.savingsCents, flat);
});

test('horizonMonths trims the window and is capped at the remainder', () => {
  const args = {
    termMonths: 36, regularPriceCents: D(120), discountPriceCents: D(80),
    contractStart: '2025-06-08', promoEnd: '2026-11-26',
    basePriceCents: BENCH, today: '2026-08-08'
  };
  // Next 12: 3 at $80 + 9 at $120 = $1320 against 12 * $70 = $840.
  const q12 = contractQuote({ ...args, horizonMonths: 12 });
  assert.equal(q12.months.horizon, 12);
  assert.equal(q12.forward.savingsCents, D(480));
  // Asking for more than is left cannot invent cycles.
  const q99 = contractQuote({ ...args, horizonMonths: 99 });
  assert.equal(q99.months.horizon, 21);
  assert.equal(q99.forward.savingsCents, D(930));
});

test('stacked month-by-month rows override the single-promo fields', () => {
  const s = buildSchedule({
    termMonths: 24,
    regularPriceCents: D(120),
    discountPriceCents: D(80),      // ignored: rows win
    promoEnd: '2030-01-01',         // ignored: rows win
    periods: [{ priceCents: D(35), months: 3 }, { priceCents: D(60), months: 6 }],
    contractStart: '2026-01-15'
  });
  assert.equal(s.prices.filter(p => p === D(35)).length, 3);
  assert.equal(s.prices.filter(p => p === D(60)).length, 6);
  assert.equal(s.prices.filter(p => p === D(120)).length, 15, 'rest of the term at regular');
  assert.equal(s.prices.reduce((a, b) => a + b, 0), D(3 * 35 + 6 * 60 + 15 * 120));
});

test('rows shorter than the term are topped up; rows longer are truncated', () => {
  const short = buildSchedule({
    termMonths: 6, regularPriceCents: D(100),
    periods: [{ priceCents: D(40), months: 2 }], contractStart: '2026-01-01'
  });
  assert.deepEqual(short.prices, [D(40), D(40), D(100), D(100), D(100), D(100)]);

  const long = buildSchedule({
    termMonths: 3, regularPriceCents: D(100),
    periods: [{ priceCents: D(40), months: 12 }], contractStart: '2026-01-01'
  });
  assert.deepEqual(long.prices, [D(40), D(40), D(40)]);
});

test('a promo that ended before the contract began buys zero promo cycles', () => {
  const s = buildSchedule({
    termMonths: 12, regularPriceCents: D(100), discountPriceCents: D(60),
    contractStart: '2026-05-01', promoEnd: '2026-04-01'
  });
  assert.equal(s.prices.filter(p => p === D(60)).length, 0);
});

test('a discount with no end date assumes twelve months, and says so', () => {
  const s = buildSchedule({
    termMonths: 36, regularPriceCents: D(120), discountPriceCents: D(80),
    contractStart: '2026-01-01', today: '2026-01-01'
  });
  assert.equal(s.flags.assumedPromoMonths, 12);
  assert.equal(s.prices.filter(p => p === D(80)).length, 13, 'the cycle billed today, plus twelve ahead');
});

test('the assumed promo runs forward from today, not from a start long past', () => {
  // Fifteen bills in with a discount still on the bill and no end date. An
  // assumption anchored at the contract start would have expired it ten
  // months ago, pricing today's cycle at the full rate while the card says
  // the household pays the discounted one.
  const q = contractQuote({
    termMonths: 36, regularPriceCents: D(120), discountPriceCents: D(80),
    contractStart: '2025-06-08', basePriceCents: BENCH, today: '2026-08-08'
  });
  assert.equal(q.months.elapsed, 15);
  assert.equal(q.nowCents, D(80), 'agrees with what the household is paying');
  assert.equal(q.flags.assumedPromoMonths, 12);
  // Ahead: 12 more at $80, then 9 at $120.
  assert.equal(q.forward.payCents, D(12 * 80 + 9 * 120));
  assert.equal(q.forward.savingsCents, D(12 * 10 + 9 * 50));
  // And it under-promises rather than over-promises: assuming the promo had
  // already lapsed would have claimed $1050 over the same 21 months.
  assert.ok(q.forward.savingsCents < D(1050));
});

test('an unknown start date counts nothing as elapsed', () => {
  const q = contractQuote({
    termMonths: 24, regularPriceCents: D(120),
    basePriceCents: BENCH, today: '2026-08-08'
  });
  assert.equal(q.flags.assumedStart, true);
  assert.equal(q.months.elapsed, 0);
  assert.equal(q.months.remaining, 24);
  assert.equal(q.toDate.payCents, 0);
  assert.equal(q.forward.savingsCents, D(24 * 50));
});

test('a finished term leaves nothing ahead', () => {
  const q = contractQuote({
    termMonths: 12, regularPriceCents: D(100),
    contractStart: '2024-01-01', basePriceCents: BENCH, today: '2026-08-08'
  });
  assert.equal(q.months.elapsed, 12);
  assert.equal(q.months.remaining, 0);
  assert.equal(q.forward.savingsCents, 0);
});

test('below the benchmark never renders as a negative saving', () => {
  const q = contractQuote({
    termMonths: 24, regularPriceCents: D(65),
    contractStart: '2026-01-01', basePriceCents: BENCH, today: '2026-01-01'
  });
  assert.equal(q.flags.atOrBelowMarket, true);
  assert.equal(q.forward.differenceCents < 0, true, 'the honest number stays signed');
  assert.equal(q.forward.savingsCents, 0, 'the displayed number is floored');
});

test('no benchmark yields no money figures rather than an invented one', () => {
  const q = contractQuote({
    termMonths: 24, regularPriceCents: D(120),
    contractStart: '2026-01-01', basePriceCents: null, today: '2026-01-01'
  });
  assert.equal(q.flags.noBenchmark, true);
  assert.equal(q.forward, null);
  assert.equal(q.toDate, null);
  assert.equal(q.total, null);
  // Cycle 1 bills on the start date itself, so a contract opened today has
  // already had one bill: 23 ahead, not 24.
  assert.equal(q.months.elapsed, 1);
  assert.equal(q.months.remaining, 23, 'the schedule itself still stands');
});

test('month-end bill dates clamp instead of skidding into the next month', () => {
  assert.equal(addMonths(new Date(2026, 0, 31), 1).getDate(), 28, 'Jan 31 + 1mo, 2026');
  assert.equal(addMonths(new Date(2024, 0, 31), 1).getDate(), 29, 'leap year');
  assert.equal(addMonths(new Date(2026, 0, 31), 3).getDate(), 30, 'Jan 31 + 3mo = Apr 30');
});

test('a schedule with no monthly charge builds nothing', () => {
  // A blank field is "not given". Number('') is 0, so this is the difference
  // between no answer and a free contract.
  assert.equal(buildSchedule({ termMonths: 24, regularPriceCents: '' }), null);
  assert.equal(buildSchedule({ termMonths: 24, regularPriceCents: null }), null);
  assert.equal(buildSchedule({ termMonths: 24 }), null);
  assert.equal(buildSchedule({ termMonths: 24, regularPriceCents: NaN }), null);
  assert.equal(buildSchedule({ termMonths: 24, regularPriceCents: -1 }), null);
  assert.equal(contractQuote({ termMonths: 24, regularPriceCents: '' }), null);
  // A genuine zero is still a schedule.
  assert.deepEqual(buildSchedule({ termMonths: 2, regularPriceCents: 0 }).prices, [0, 0]);
});

test('selectBand takes the schedule total when given one, band unchanged', () => {
  const args = {
    userPriceCents: D(80), basePriceCents: BENCH, periodMonths: 21,
    onPromo: true, promoEndDate: '2026-11-26'
  };
  const flat = selectBand(args);
  const sched = selectBand({ ...args, scheduleSavingsCents: D(930) });
  assert.equal(sched.bandId, flat.bandId, 'the verdict is about today\'s price only');
  assert.equal(flat.savingsCents, D(210), 'fallback: months x today\'s gap');
  assert.equal(sched.savingsCents, D(930));
});

test('selectBand floors a negative schedule total and ignores a junk one', () => {
  const args = { userPriceCents: D(60), basePriceCents: BENCH, periodMonths: 24 };
  assert.equal(selectBand({ ...args, scheduleSavingsCents: -5000 }).savingsCents, 0);
  assert.equal(selectBand({ ...args, scheduleSavingsCents: 'x' }).savingsCents, 0,
    'unparseable -> fallback, which is itself 0 below the benchmark');
  assert.equal(selectBand({ userPriceCents: D(90), basePriceCents: BENCH, periodMonths: 24, scheduleSavingsCents: null }).savingsCents,
    24 * D(20), 'null -> fallback');
});

test('a lookup miss still suppresses the savings row, schedule or not', () => {
  const r = selectBand({ userPriceCents: D(120), basePriceCents: null, scheduleSavingsCents: D(930) });
  assert.equal(r.showSavingsRow, false);
  assert.equal(r.showBenchmarkRow, false);
  assert.equal(r.bandId, 3);
});
