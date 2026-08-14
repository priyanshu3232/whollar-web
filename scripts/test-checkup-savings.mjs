#!/usr/bin/env node
/* Engine acceptance tests for the v17 checkup migration (spec section 9.3,
 * plus the tone thresholds from 9.4 and the assumption tags from 6.2).
 * Run: node --test scripts/test-checkup-savings.mjs
 *
 * Every date-sensitive case injects `today`, so these are deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const E = require(join(ROOT, 'js/checkup-savings.js'));

const TODAY = '2026-08-13';
const base = (over) => Object.assign({
  province: 'Ontario', speedMbps: 100,
  during: 0, after: 0, multi: false, periods: [], fallback: 0,
  startDate: null, promoEnd: null, today: TODAY
}, over);

/* ---- 12: the window is always 12 months ---- */
test('12: window is 12 regardless of contract or elapsed time', () => {
  assert.equal(E.WINDOW_MONTHS, 12);
  const r1 = E.computeCheckup(base({ during: 80 }));
  const r2 = E.computeCheckup(base({ during: 80, startDate: '2024-09-13', promoEnd: '2026-09-13', after: 130 }));
  assert.equal(r1.months, 12);
  assert.equal(r2.months, 12);
});

/* ---- 13: 23 months into a 24 month term still gets a full figure ---- */
test('13: late-term household does not collapse toward zero', () => {
  const r = E.computeCheckup(base({ during: 80, after: 130, startDate: '2024-09-13', promoEnd: '2026-09-13' }));
  assert.equal(r.basis, 'dated');
  assert.equal(r.current.detail.monthsAtCurrent, 1);
  assert.equal(r.current.detail.monthsAtSticker, 11);
  assert.equal(r.current.total, 1 * 80 + 11 * 130); /* 1510: a full 12 months */
  assert.equal(r.savings, +(1510 - 38.95 * 12).toFixed(2));
  assert.ok(r.savings > 1000);
});

/* ---- 14: lapsed promo pays the after-promo price now ---- */
test('14: promo already lapsed: now = after-promo price, flagged post promo', () => {
  const r = E.computeCheckup(base({ during: 60, after: 110, promoEnd: '2026-05-01' }));
  assert.equal(r.now.amount, 110);
  assert.equal(r.now.postPromo, true);
  const running = E.computeCheckup(base({ during: 60, after: 110, promoEnd: '2026-11-01' }));
  assert.equal(running.now.amount, 60);
  assert.equal(running.now.postPromo, false);
});

/* ---- 15: multi promo, 8 months elapsed, 6@50 then 18@95 ---- */
test('15: multi promo walks elapsed months before pricing the window', () => {
  const input = base({
    multi: true,
    periods: [{ amount: 50, months: 6 }, { amount: 95, months: 18 }],
    startDate: '2025-12-13'
  });
  const cur = E.currentCost(input);
  assert.equal(cur.basis, 'periods');
  assert.equal(cur.total, 1140);
  assert.equal(cur.uncovered, 0);
  assert.equal(E.nowPrice(input).amount, 95);
});

/* ---- 16: Ontario pools provincial data with offers ---- */
test('16: Ontario at 1.5 Gig takes the cheapest qualifying offer', () => {
  const b = E.bestPlan('Ontario', 1500);
  assert.equal(b.p, 55);
  assert.equal(b.src, 'offer');
  assert.ok(!b.fallbackGeo);
});
test('16: Ontario at 100 Mbps takes the provincial dataset', () => {
  const b = E.bestPlan('Ontario', 100);
  assert.equal(b.p, 38.95);
  assert.equal(b.src, 'plansavvy');
});

/* ---- 17: outside Ontario offers are a fallback only ---- */
test('17: BC at 100 Mbps stays provincial', () => {
  const b = E.bestPlan('British Columbia', 100);
  assert.equal(b.p, 38.95);
  assert.equal(b.src, 'plansavvy');
  assert.ok(!b.fallbackGeo);
});
test('17: BC at 1.5 Gig falls back to offers and flags fallbackGeo', () => {
  const b = E.bestPlan('British Columbia', 1500);
  assert.equal(b.p, 55);
  assert.equal(b.src, 'offer');
  assert.equal(b.fallbackGeo, true);
});

/* ---- 18: the four single promo bases ---- */
test('18: basis tags across the four single promo permutations', () => {
  const noneNone = E.currentCost(base({ during: 90 }));
  assert.equal(noneNone.basis, 'current-only');
  assert.equal(noneNone.total, 12 * 90);

  const stickOnly = E.currentCost(base({ during: 90, after: 140 }));
  assert.equal(stickOnly.basis, 'midpoint-estimate');
  assert.equal(stickOnly.total, 6 * 90 + 6 * 140);

  const dateOnly = E.currentCost(base({ during: 90, promoEnd: '2026-12-13' }));
  assert.equal(dateOnly.basis, 'dated-no-sticker');
  assert.equal(dateOnly.total, 12 * 90); /* held at the current rate */
  assert.equal(dateOnly.assumedRate, 90);

  const both = E.currentCost(base({ during: 90, after: 140, promoEnd: '2026-12-13' }));
  assert.equal(both.basis, 'dated');
  assert.equal(both.total, 4 * 90 + 8 * 140);
});

/* ---- 19: overpaid to date ---- */
test('19: overpaid is null without a start date', () => {
  assert.equal(E.overpaidToDate(base({ during: 200 }), 38.95), null);
});
test('19: overpaid is null under 3 elapsed months', () => {
  assert.equal(E.overpaidToDate(base({ during: 200, startDate: '2026-06-13' }), 38.95), null);
});
test('19: overpaid is null under the 60 dollar floor', () => {
  const r = E.overpaidToDate(base({ during: 55, startDate: '2026-05-13' }), 38.95);
  assert.equal(r, null); /* 3 * 16.05 = 48.15 */
});
test('19: overpaid nets promo months that beat the benchmark', () => {
  /* 12 elapsed, promo ended 2 months ago: 10 months at during, 2 at after */
  const above = E.overpaidToDate(base({ during: 60, after: 110, startDate: '2025-08-13', promoEnd: '2026-06-13' }), 38.95);
  assert.equal(+above.toFixed(2), +(10 * (60 - 38.95) + 2 * (110 - 38.95)).toFixed(2));
  /* same shape but the promo genuinely beat the market: netted below floor */
  const netted = E.overpaidToDate(base({ during: 30, after: 110, startDate: '2025-08-13', promoEnd: '2026-06-13' }), 38.95);
  assert.equal(netted, null); /* 10*(30-38.95) + 2*(110-38.95) = 52.6 < 60 */
});

/* ---- tone thresholds (9.4 test 20, engine side) ---- */
test('20: tone bands at overPct 0.05 / 0.20 / 0.50', () => {
  /* current-only basis so cur = 12 * during; ON 100 bench = 38.95 * 12 = 467.40 */
  const tone = (during) => E.computeCheckup(base({ during })).tone;
  assert.equal(tone(41), 'fair');       /* pct = 24.60 / 492.00 = .05 */
  assert.equal(tone(48.68), 'moderate');/* pct = .1998 */
  assert.equal(tone(77.9), 'high');     /* pct = .50 */
});
test('no-benchmark tone when nothing qualifies at the speed', () => {
  const r = E.computeCheckup(base({ during: 90, speedMbps: 99999 }));
  assert.equal(r.ok, false);
  assert.equal(r.tone, 'no-benchmark');
  assert.equal(r.benchmark, null);
  assert.equal(r.current.total, 1080); /* the hero still has a figure to show */
});

/* ---- cliff pill (9.4 test 23, engine side) ---- */
test('23: cliff pill at 75 days, absent at 400 days, absent when ended', () => {
  assert.equal(E.cliffSoon(base({ promoEnd: '2026-10-27' })), true);   /* ~75 days */
  assert.equal(E.cliffSoon(base({ promoEnd: '2027-09-17' })), false);  /* ~400 days */
  assert.equal(E.cliffSoon(base({ promoEnd: '2026-05-01' })), false);  /* ended */
  assert.equal(E.cliffSoon(base({ multi: true, promoEnd: '2026-10-27' })), false);
});

/* ---- assumption tags (6.2 triggers) ---- */
test('assumption tags: one per trigger, none when fully specified', () => {
  const full = E.computeCheckup(base({ during: 90, after: 140, promoEnd: '2026-12-13' }));
  assert.deepEqual(full.assumptions, []);
  assert.deepEqual(E.computeCheckup(base({ during: 90, after: 140 })).assumptions, ['midpoint-estimate']);
  assert.deepEqual(E.computeCheckup(base({ during: 90 })).assumptions, ['current-only']);
  assert.deepEqual(E.computeCheckup(base({ during: 90, promoEnd: '2026-12-13' })).assumptions, ['dated-no-sticker']);
  const short = E.computeCheckup(base({ multi: true, periods: [{ amount: 80, months: 5 }] }));
  assert.deepEqual(short.assumptions, ['uncovered']);
  assert.equal(short.current.detail.uncovered, 7);
});

/* ---- multi promo fallback price covers the tail ---- */
test('periods short of the window price the tail at the fallback', () => {
  const cur = E.currentCost(base({ multi: true, periods: [{ amount: 80, months: 5 }], fallback: 120 }));
  assert.equal(cur.total, 5 * 80 + 7 * 120);
  assert.equal(cur.uncovered, 0);
  assert.equal(cur.assumedRate, 120);
});

/* ---- monthsUntil counts whole months only ---- */
test('monthsUntil subtracts one before the day of month is reached', () => {
  assert.equal(E.monthsUntil('2026-09-12', TODAY), 0);
  assert.equal(E.monthsUntil('2026-09-13', TODAY), 1);
  assert.equal(E.monthsUntil('2026-08-01', TODAY), -1);
});
