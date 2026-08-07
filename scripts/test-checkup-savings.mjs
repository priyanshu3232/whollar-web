#!/usr/bin/env node
/* The 14 acceptance tests from the savings-logic spec (2026-08-08).
 * Run: node scripts/test-checkup-savings.mjs
 * These pin the field-semantics fix: currentPrice = what you pay TODAY,
 * discountAmount = the monthly amount taken OFF, postPromo = current + discount.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { calculateCheckup, lookupBenchmark, monthsBetween, provinceFromPostalCode } =
  require(join(ROOT, 'js/checkup-savings.js'));

let failed = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
}

/* Shared golden input (spec §5 / test 3) */
const GOLDEN = {
  postalCode: 'L5V 1A9', downloadMbps: 500,
  currentPrice: 120, discountAmount: 80, contractLengthMonths: 36,
  contractStartDate: '2025-06-08', promoEndDate: '2026-11-26',
  today: '2026-08-08',
};

/* 1 — benchmark lookup */
{
  const b = lookupBenchmark('L5V 1A9', 500);
  eq('1 benchmark price', b.monthly, 44.99);
  eq('1 benchmark plan', `${b.provider} ${b.plan}`, 'Carrytel Internet 500');
  eq('1 benchmark province', b.province, 'Ontario');
}

/* 2 — promo month count */
eq('2 monthsBetween', monthsBetween('2025-06-08', '2026-11-26'), 18);

/* 3 — GOLDEN promo active */
{
  const r = calculateCheckup(GOLDEN);
  eq('3 postPromo', r.postPromoPrice, 200);
  eq('3 promoMonths', r.promoMonths, 18);
  eq('3 totalPaid', r.totalPaid, 5760);
  eq('3 totalSavings', r.totalSavings, 4140.36);
  eq('3 cliff', r.cliff, { month: 18, from: 120, to: 200 });
}

/* 4 — GOLDEN multi-promo */
{
  const r = calculateCheckup({
    ...GOLDEN, contractLengthMonths: 24,
    promoPeriods: [{ monthlyAmount: 35, months: 3 }, { monthlyAmount: 60, months: 6 }],
  });
  eq('4 totalPaid', r.totalPaid, 3465);
  eq('4 totalSavings', r.totalSavings, 2385.24);
}

/* 5 — promo already expired: today's price is the rack rate */
{
  const r = calculateCheckup({ ...GOLDEN, promoEndDate: '2026-05-26' });
  eq('5 promoActive', r.promoActive, false);
  eq('5 promoPrice (schedule[0])', r.schedule[0], 40);   // current - discount
  eq('5 postPromo', r.postPromoPrice, 120);              // current
}

/* 6 — discount 0: flat schedule, no cliff */
{
  const r = calculateCheckup({ ...GOLDEN, discountAmount: 0 });
  eq('6 flat schedule', r.schedule.every((x) => x === 120), true);
  eq('6 cliff', r.cliff, null);
  eq('6 zero-discount warning', r.warnings.some((w) => w.includes('$0')), true);
}

/* 7 — promo covers the full term: no cliff */
{
  const r = calculateCheckup({ ...GOLDEN, promoEndDate: '2028-07-01' });
  eq('7 promoMonths === term', r.promoMonths, 36);
  eq('7 cliff', r.cliff, null);
}

/* 8 — already below benchmark: savings clamp to 0, never abs() */
{
  const r = calculateCheckup({ ...GOLDEN, currentPrice: 30, discountAmount: 0, promoEndDate: null });
  eq('8 totalSavings', r.totalSavings, 0);
}

/* 9 — periods overrun the term: schedule truncates */
{
  const r = calculateCheckup({
    ...GOLDEN, contractLengthMonths: 12,
    promoPeriods: [{ monthlyAmount: 50, months: 10 }, { monthlyAmount: 70, months: 10 }],
  });
  eq('9 schedule length', r.schedule.length, 12);
}

/* 10 — X0A is Nunavut */
eq('10 X0A 1H0', provinceFromPostalCode('X0A 1H0'), 'Nunavut');

/* 11 — speed above every plan in the province */
{
  const b = lookupBenchmark('X1A 0A1', 2000); // Northwest Territories, top plan 1000
  eq('11 matched flag', b.matched, 'below_requested_speed');
  eq('11 fallback plan speed', b.mbps, 1000);
}

/* 12 — month-end anchor clamps */
eq('12 Jan31->Feb28', monthsBetween('2025-01-31', '2025-02-28'), 1);
eq('12 Jan31->Mar01', monthsBetween('2025-01-31', '2025-03-01'), 2);

/* 13 — promo end unknown: assume 12 months, warn */
{
  const r = calculateCheckup({ ...GOLDEN, promoEndDate: null });
  eq('13 promoMonths', r.promoMonths, 12);
  eq('13 warning', r.warnings.some((w) => w.includes('assumed 12 months')), true);
}

/* 14 — discount larger than what you pay: warn, do not explode */
{
  const r = calculateCheckup({ ...GOLDEN, currentPrice: 60, discountAmount: 80 });
  eq('14 warning', r.warnings.some((w) => w.includes('post-promo price')), true);
  eq('14 postPromo still derived', r.postPromoPrice, 140);
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('\nall tests passed');
