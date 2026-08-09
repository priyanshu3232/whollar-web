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
const { calculateCheckup, lookupBenchmark, monthsBetween, provinceFromPostalCode,
        buildCard, money, INTERNET_PLANS } =
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
  eq('3 cliff', r.cliff, { month: 18, date: '2026-12-08', monthsAway: 3, from: 120, to: 200 });
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

/* 5 — promo already expired: SAME derivation as promo-active (Q03 is the
   with-discount price by definition, post-promo = Q03 + Q09), and "you pay
   now" is today's month of the schedule, which is the rack rate. The old
   expired branch read Q03 as the rack rate and told a $120-with-$90-off
   household they pay $30/mo. */
{
  const r = calculateCheckup({ ...GOLDEN, promoEndDate: '2026-05-26' });
  eq('5 promoActive', r.promoActive, false);
  eq('5 promoPrice (schedule[0])', r.schedule[0], 120);  // Q03, as always
  eq('5 postPromo', r.postPromoPrice, 200);              // Q03 + Q09, as always
  eq('5 currentMonthly is today, not month 1', r.currentMonthly, 200);
}

/* 5b — the reported case: $120 after a $90 discount, promo expired Dec 2025,
   24-month contract from Jan 2025. Pays $210 today; the card says so in the
   past tense. */
{
  const r = calculateCheckup({
    postalCode: 'L5V 1A9', downloadMbps: 1500, currentPrice: 120, discountAmount: 90,
    contractLengthMonths: 24, contractStartDate: '2025-01-15', promoEndDate: '2025-12-15',
    today: '2026-08-08',
  });
  eq('5b postPromo', r.postPromoPrice, 210);
  eq('5b currentMonthly', r.currentMonthly, 210);
  eq('5b totalPaid', r.totalPaid, 11 * 120 + 13 * 210);
  const card = buildCard(r, 'L5V');
  eq('5b past tense', card.note.startsWith('Your promotion ended'), true);
  eq('5b rate is 210', card.note.includes('The rate is $210/mo and stays there'), true);
  eq('5b pay-now stat', card.stats[0].value, '$210/mo');
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

/* 11 — speed above every plan AND above every high-speed tier */
{
  const b = lookupBenchmark('X1A 0A1', 5000); // Northwest Territories, top plan 1000
  eq('11 matched flag', b.matched, 'below_requested_speed');
  eq('11 fallback plan speed', b.mbps, 1000);
}

/* 11b — 1.5/3 Gbps: the workbook prices neither, so the tier table fills the
   gap instead of degrading to a slower provincial plan. */
{
  const t15 = lookupBenchmark('X1A 0A1', 1500);
  eq('11b 1.5G matched', t15.matched, 'high_speed_tier');
  eq('11b 1.5G price', t15.monthly, 55);
  eq('11b 1.5G no provider named', t15.provider, null);

  const t30 = lookupBenchmark('V6B 1A1', 3000); // BC, top plan 1000
  eq('11b 3G matched', t30.matched, 'high_speed_tier');
  eq('11b 3G price', t30.monthly, 65);

  /* 2 Gbps has no tier of its own: the next tier up that clears it wins. */
  eq('11b 2G rounds up to 3G tier', lookupBenchmark('V6B 1A1', 2000).monthly, 65);

  /* A real provincial plan that already clears the speed still wins: the
     tiers are a gap-filler, never a competitor. */
  const on = lookupBenchmark('N6A 1A1', 1500); // Ontario carries a 1500 plan
  eq('11b province plan wins', on.matched, 'at_or_above_speed');

  /* Nothing under a gig may move because of this. */
  eq('11b 100M unmoved', lookupBenchmark('N6A 1A1', 100).monthly, 38.95);
  eq('11b 1000M unmoved', lookupBenchmark('X1A 0A1', 1000).monthly, 219.95);
}

/* 12 — month-end anchor clamps */
eq('12 Jan31->Feb28', monthsBetween('2025-01-31', '2025-02-28'), 1);
eq('12 Jan31->Mar01', monthsBetween('2025-01-31', '2025-03-01'), 2);

/* 12b — same-day-of-month boundary: a promo running exactly 12 months from
   start to end must count as 12, not 13. This is the off-by-one regression
   (fixed 2026-08-10): the old code only decremented when the end day-of-month
   was strictly LESS than the start day-of-month, so an equal day-of-month
   boundary fell through and got counted twice. */
eq('12b Jan15->Jan15 +1y', monthsBetween('2026-01-15', '2027-01-15'), 12);
eq('12b Jan01->Jan01 +1y', monthsBetween('2026-01-01', '2027-01-01'), 12);
{
  const r = calculateCheckup({
    postalCode: 'L5V 1A9', downloadMbps: 500, currentPrice: 120, discountAmount: 80,
    contractLengthMonths: 24, contractStartDate: '2026-01-15', promoEndDate: '2027-01-15',
    today: '2026-08-08',
  });
  eq('12b promoMonths', r.promoMonths, 12);
  eq('12b cliff date === promo end date', r.cliff.date, '2027-01-15');
}

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

/* ================= Result-card content layer (13 tests) ================= */

/* Flat-price helper: run a real checkup with no promo. */
const flat = (price, term) => calculateCheckup({
  postalCode: 'L5V 1A9', downloadMbps: 100, currentPrice: price,
  discountAmount: 0, contractLengthMonths: term, promoEndDate: null, today: '2026-08-08',
});
const allText = (c) => [c.headline, c.body, c.basis, c.note || '', c.caveat || '',
  c.cta, ...c.stats.flatMap((s) => [s.label, s.value, s.sub || ''])].join(' | ');

/* C1 — $50 vs $38.95 over 36 months -> moderate_saving */
const c1 = buildCard(flat(50, 36), 'L5V');
eq('C1 case', c1.case, 'moderate_saving');

/* C2 — $42 vs $38.95 over 24 months -> small_saving */
const c2 = buildCard(flat(42, 24), 'L5V');
eq('C2 case', c2.case, 'small_saving');

/* C3 — $35 vs $38.95 -> no_saving: ONE stat, no $0 anywhere */
const c3 = buildCard(flat(35, 24), 'L5V');
eq('C3 case', c3.case, 'no_saving');
eq('C3 one stat', c3.stats.length, 1);
eq('C3 cta', c3.cta, 'Join your L5V cohort');
eq('C3 no $0', allText(c3).includes('$0'), false);

/* C4 — $130 vs $44.99 -> big_saving with the multiple in the headline */
const c4 = buildCard(calculateCheckup({
  postalCode: 'L5V 1A9', downloadMbps: 500, currentPrice: 130,
  discountAmount: 0, contractLengthMonths: 24, promoEndDate: null, today: '2026-08-08',
}), 'L5V');
eq('C4 case', c4.case, 'big_saving');
eq('C4 headline', c4.headline, 'Your speed does not cost this much.');

/* C5 — the golden promo scenario: big_saving, note present, case unmoved by it */
const c5r = calculateCheckup(GOLDEN);
const c5 = buildCard(c5r, 'L5V');
eq('C5 case', c5.case, 'big_saving');
eq('C5 note', c5.note, 'Your promotion ends Dec 2026. The rate goes to $200/mo.');

/* C6 — below_requested_speed sets the caveat; case still chosen on overPct */
const c6 = buildCard(calculateCheckup({
  postalCode: 'X1A 0A1', downloadMbps: 5000, currentPrice: 300,
  discountAmount: 0, contractLengthMonths: 24, promoEndDate: null, today: '2026-08-08',
}), 'X1A');
eq('C6 caveat', c6.caveat,
  'Speed note. No plan we track in Northwest Territories reaches 5000 Mbps. '
  + 'This compares a slower plan, so the real gap is likely smaller.');

/* C6b — a tier-sourced benchmark is a real price at the speed asked for, so
   it must NOT raise the "treat this as a floor" caveat. Its basis line must
   also say so: it is a reference rate, not one of the advertised plans the
   standard basis line claims to track. */
{
  const c = buildCard(calculateCheckup({
    postalCode: 'X1A 0A1', downloadMbps: 1500, currentPrice: 300,
    discountAmount: 0, contractLengthMonths: 24, promoEndDate: null, today: '2026-08-08',
  }), 'X1A');
  eq('C6b no caveat on tier', c.caveat, undefined);
  eq('C6b tier basis', c.basis,
    "Measured against a reference rate for this speed — we don't track an advertised plan this fast in your area.");
}

/* C7 — basis line on every case, identical */
const cards = [c1, c2, c3, c4, c5, c6];
eq('C7 basis identical', new Set(cards.map((c) => c.basis)).size, 1);
eq('C7 basis non-empty', cards.every((c) => c.basis.length > 0), true);

/* C8 — the card carries no eyebrow badge and no line under the button: both
   were dropped, and a stray one reappearing means a case was hand-edited. */
eq('C8 no badge', cards.every((c) => c.badge === undefined), true);
eq('C8 no ctaSub', cards.every((c) => c.ctaSub === undefined), true);
eq('C8 cta on every case', cards.every((c) => c.cta === 'Join your L5V cohort' || c.cta === 'Join your X1A cohort'), true);

/* C9 — banned vocabulary */
eq('C9 banned words', cards.every((c) => !/typical|list price/i.test(allText(c))), true);

/* C10 — no provider or plan name from the sheet may appear */
{
  const names = Object.values(INTERNET_PLANS).flat()
    .flatMap((p) => [p.provider, p.plan]);
  const leaked = cards.filter((c) => names.some((n) => allText(c).includes(n)));
  eq('C10 no plan names', leaked.map((c) => c.case), []);
}

/* C11 — never tie price to cohort size */
eq('C11 no headcount pricing',
  cards.every((c) => !/more members|cohort fills|the bigger the|headcount/i.test(allText(c))), true);

/* C12 — money formatting */
eq('C12 money(4140.36)', money(4140.36), '$4,140.36');
eq('C12 money(50)', money(50), '$50');

/* C13 — band boundaries land in the HIGHER band (synthetic results) */
{
  const fake = (savings, bench) => ({
    currentMonthly: 50, totalSavings: savings, totalBenchmark: bench,
    totalPaid: bench + savings, termMonths: 24, cliff: null,
    benchmark: { matched: 'at_or_above_speed', province: 'Ontario' }, downloadMbps: 100,
  });
  eq('C13 0.02 -> small', buildCard(fake(2, 100), 'L5V').case, 'small_saving');
  eq('C13 0.15 -> moderate', buildCard(fake(15, 100), 'L5V').case, 'moderate_saving');
  eq('C13 0.50 -> big', buildCard(fake(50, 100), 'L5V').case, 'big_saving');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('\nall tests passed');
