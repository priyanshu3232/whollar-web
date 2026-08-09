#!/usr/bin/env node
/* The 50-case savings-engine harness.
 *
 *   node scripts/test-checkup-50-cases.mjs          # write checkup-50-test-results.csv
 *   node scripts/test-checkup-50-cases.mjs --check  # CI: fail on any diff from the committed fixture
 *
 * The 50 scenarios below are the input columns lifted from the CSV as it
 * existed before this harness did — hand-built coverage of every province,
 * every card band, every promo shape (stacked periods, month-end clamps,
 * withheld dates, negative/oversized discounts), and both fallback paths off
 * the plan pool. This script is the missing piece that regenerates the rest
 * of that CSV from calculateCheckup()/buildCard() instead of the numbers
 * having been typed in or computed by hand once and left to drift.
 *
 * `today` is fixed at 2026-08-08 for every case (matching cases #47/#49,
 * "ends exactly today" / "ends tomorrow", which only make sense against a
 * fixed anchor) — using the real current date would make the fixture
 * unreproducible.
 *
 * The `badge` column from the pre-harness CSV is gone: buildCard() no longer
 * returns one (see the 2026-08-09 card-copy rewrite).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { calculateCheckup, buildCard, provinceFromPostalCode } =
  require(join(ROOT, 'js/checkup-savings.js'));

const CHECK = process.argv.includes('--check');
const FIXTURE = join(ROOT, 'checkup-50-test-results.csv');
const TODAY = '2026-08-08';

const CASES = [
  { id: 1, desc: 'Ontario, classic promo cliff', postal: 'M5V 2T6', mbps: 100, currentPrice: 120, discount: 80, termMonths: 24, contractStart: '2026-01-15', promoEnd: '2027-01-15' },
  { id: 2, desc: 'BC, mild overpay, no promo', postal: 'V6B 1A1', mbps: 50, currentPrice: 55, discount: 0, termMonths: 12, contractStart: '2026-06-01', promoEnd: null },
  { id: 3, desc: 'Alberta, big overpay, promo active', postal: 'T2P 3G7', mbps: 100, currentPrice: 95, discount: 30, termMonths: 24, contractStart: '2025-09-01', promoEnd: '2026-09-01' },
  { id: 4, desc: 'Quebec, cheap indie plan holder', postal: 'H2X 1Y4', mbps: 100, currentPrice: 42, discount: 0, termMonths: 12, contractStart: '2026-03-01', promoEnd: null },
  { id: 5, desc: 'Nova Scotia, gigabit household', postal: 'B3H 4R2', mbps: 1000, currentPrice: 110, discount: 20, termMonths: 24, contractStart: '2026-02-10', promoEnd: '2026-08-10' },
  { id: 6, desc: 'Saskatchewan, average bill', postal: 'S7K 0J5', mbps: 100, currentPrice: 85, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 7, desc: 'Manitoba, promo just ended', postal: 'R3C 4T3', mbps: 50, currentPrice: 90, discount: 25, termMonths: 24, contractStart: '2025-07-01', promoEnd: '2026-07-01' },
  { id: 8, desc: 'New Brunswick, Bell Fibe typical', postal: 'E1C 8L3', mbps: 150, currentPrice: 105, discount: 30, termMonths: 24, contractStart: '2026-04-01', promoEnd: '2027-04-01' },
  { id: 9, desc: 'PEI, modest bill', postal: 'C1A 7N8', mbps: 100, currentPrice: 70, discount: 10, termMonths: 12, contractStart: '2026-05-01', promoEnd: '2026-11-01' },
  { id: 10, desc: 'Newfoundland, rural cable', postal: 'A1C 5S7', mbps: 30, currentPrice: 65, discount: 0, termMonths: 12, contractStart: '2026-01-20', promoEnd: null },
  { id: 11, desc: 'NWT (Yellowknife), Northwestel 50', postal: 'X1A 2P8', mbps: 50, currentPrice: 129.95, discount: 0, termMonths: 12, contractStart: '2026-02-01', promoEnd: null },
  { id: 12, desc: 'Nunavut (X0A), satellite household', postal: 'X0A 0H0', mbps: 100, currentPrice: 180, discount: 0, termMonths: 24, contractStart: '2025-12-01', promoEnd: null },
  { id: 13, desc: 'Yukon, gigabit Northwestel', postal: 'Y1A 5X9', mbps: 1000, currentPrice: 219.95, discount: 0, termMonths: 12, contractStart: '2026-03-15', promoEnd: null },
  { id: 14, desc: 'NWT, Starlink-level price', postal: 'X1A 1A1', mbps: 200, currentPrice: 140, discount: 25, termMonths: 12, contractStart: '2026-06-01', promoEnd: '2026-12-01' },
  { id: 15, desc: 'Nunavut, speed above anything (fallback)', postal: 'X0B 1B0', mbps: 1500, currentPrice: 250, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 16, desc: 'Promo end unknown -> assume 12mo', postal: 'M4C 1B5', mbps: 100, currentPrice: 100, discount: 40, termMonths: 24, contractStart: '2026-07-01', promoEnd: null },
  { id: 17, desc: 'Promo expired long ago', postal: 'L4C 9T3', mbps: 100, currentPrice: 140, discount: 50, termMonths: 24, contractStart: '2024-08-01', promoEnd: '2025-08-01' },
  { id: 18, desc: 'No discount but promo date given (warning)', postal: 'K1A 0B1', mbps: 50, currentPrice: 80, discount: 0, termMonths: 12, contractStart: '2026-05-01', promoEnd: '2027-05-01' },
  { id: 19, desc: 'Discount larger than price (warning)', postal: 'N2L 3G1', mbps: 100, currentPrice: 60, discount: 90, termMonths: 24, contractStart: '2026-06-01', promoEnd: '2027-06-01' },
  { id: 20, desc: 'Start withheld, promo end known (anchor=today)', postal: 'M6G 1A1', mbps: 100, currentPrice: 110, discount: 45, termMonths: 24, contractStart: null, promoEnd: '2027-02-08' },
  { id: 21, desc: 'Exactly at benchmark (no_saving)', postal: 'M5A 1A1', mbps: 100, currentPrice: 38.95, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 22, desc: 'Just under 2% over (no_saving band)', postal: 'M5A 1A1', mbps: 100, currentPrice: 39.6, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 23, desc: '~10% over (small_saving band)', postal: 'M5A 1A1', mbps: 100, currentPrice: 42.85, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 24, desc: '~30% over (moderate band)', postal: 'M5A 1A1', mbps: 100, currentPrice: 50.64, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 25, desc: '3x benchmark (big_saving band)', postal: 'M5A 1A1', mbps: 100, currentPrice: 116.85, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 26, desc: 'Speed 25 exact match plan', postal: 'T5J 0N3', mbps: 25, currentPrice: 70, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 27, desc: 'Speed 1 Mbps (everything qualifies)', postal: 'V5K 0A1', mbps: 1, currentPrice: 60, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 28, desc: 'Speed 500 in Ontario (Carrytel hit)', postal: 'M9W 1R3', mbps: 500, currentPrice: 95, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 29, desc: 'Speed 2000 in Ontario (fallback flag)', postal: 'M5H 2N2', mbps: 2000, currentPrice: 150, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 30, desc: 'Speed 101 (just above 100 tier)', postal: 'M5J 2R8', mbps: 101, currentPrice: 80, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 31, desc: '1-month term', postal: 'M5V 1J2', mbps: 100, currentPrice: 90, discount: 0, termMonths: 1, contractStart: '2026-08-01', promoEnd: null },
  { id: 32, desc: '6-month term', postal: 'M5V 1J2', mbps: 100, currentPrice: 90, discount: 0, termMonths: 6, contractStart: '2026-08-01', promoEnd: null },
  { id: 33, desc: '12-month term with 6mo promo', postal: 'M5V 1J2', mbps: 100, currentPrice: 70, discount: 20, termMonths: 12, contractStart: '2026-06-01', promoEnd: '2026-12-01' },
  { id: 34, desc: '36-month term', postal: 'M5V 1J2', mbps: 100, currentPrice: 100, discount: 35, termMonths: 36, contractStart: '2026-01-01', promoEnd: '2027-01-01' },
  { id: 35, desc: '60-month term (long haul)', postal: 'M5V 1J2', mbps: 100, currentPrice: 85, discount: 0, termMonths: 60, contractStart: '2024-01-01', promoEnd: null },
  { id: 36, desc: 'Stepped promo 6mo@60 + 6mo@80', postal: 'H3B 4W8', mbps: 100, currentPrice: 60, discount: 40, termMonths: 24, contractStart: '2026-01-01', promoEnd: '2027-01-01',
    promoPeriods: [{ monthlyAmount: 60, months: 6 }, { monthlyAmount: 80, months: 6 }] },
  { id: 37, desc: 'Periods cover partial term (warning)', postal: 'H3B 4W8', mbps: 100, currentPrice: 55, discount: 45, termMonths: 24, contractStart: '2026-01-01', promoEnd: '2026-07-01',
    promoPeriods: [{ monthlyAmount: 55, months: 6 }] },
  { id: 38, desc: 'Periods overflow the term (clamped)', postal: 'H3B 4W8', mbps: 100, currentPrice: 50, discount: 30, termMonths: 12, contractStart: '2026-01-01', promoEnd: '2027-06-01',
    promoPeriods: [{ monthlyAmount: 50, months: 20 }] },
  { id: 39, desc: 'Zero-month period filtered out', postal: 'H3B 4W8', mbps: 100, currentPrice: 65, discount: 15, termMonths: 12, contractStart: '2026-01-01', promoEnd: '2026-07-01',
    promoPeriods: [{ monthlyAmount: 65, months: 6 }, { monthlyAmount: 90, months: 0 }] },
  { id: 40, desc: 'Three-step ramp 40/60/80', postal: 'H2Y 1C6', mbps: 50, currentPrice: 40, discount: 40, termMonths: 18, contractStart: '2026-01-01', promoEnd: '2027-01-01',
    promoPeriods: [{ monthlyAmount: 40, months: 4 }, { monthlyAmount: 60, months: 4 }, { monthlyAmount: 80, months: 4 }] },
  { id: 41, desc: 'Paying below benchmark (clamp to 0)', postal: 'M5V 3L9', mbps: 100, currentPrice: 25, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 42, desc: 'Zero current price (free internet)', postal: 'M5V 3L9', mbps: 100, currentPrice: 0, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 43, desc: 'Negative discount (warning path)', postal: 'M5V 3L9', mbps: 100, currentPrice: 80, discount: -10, termMonths: 12, contractStart: '2026-01-01', promoEnd: '2027-01-01' },
  { id: 44, desc: 'Huge bill $999.99', postal: 'M5V 3L9', mbps: 100, currentPrice: 999.99, discount: 0, termMonths: 12, contractStart: '2026-01-01', promoEnd: null },
  { id: 45, desc: 'Cents precision 67.43 - 12.07 promo', postal: 'M5V 3L9', mbps: 100, currentPrice: 67.43, discount: 12.07, termMonths: 12, contractStart: '2026-02-01', promoEnd: '2026-10-01' },
  { id: 46, desc: 'Jan 31 start (month-end clamp)', postal: 'M5V 3L9', mbps: 100, currentPrice: 100, discount: 40, termMonths: 12, contractStart: '2026-01-31', promoEnd: '2026-07-31' },
  { id: 47, desc: 'Promo ends exactly today', postal: 'M5V 3L9', mbps: 100, currentPrice: 95, discount: 35, termMonths: 24, contractStart: '2025-08-08', promoEnd: '2026-08-08' },
  { id: 48, desc: 'Promo end before contract start', postal: 'M5V 3L9', mbps: 100, currentPrice: 90, discount: 20, termMonths: 12, contractStart: '2026-06-01', promoEnd: '2026-05-01' },
  { id: 49, desc: 'Promo ends tomorrow (cliff imminent)', postal: 'M5V 3L9', mbps: 100, currentPrice: 85, discount: 50, termMonths: 24, contractStart: '2025-08-09', promoEnd: '2026-08-09' },
  { id: 50, desc: 'Promo runs entire contract (no cliff)', postal: 'M5V 3L9', mbps: 100, currentPrice: 75, discount: 30, termMonths: 12, contractStart: '2026-01-01', promoEnd: '2027-06-01' }
];

const HEADER = ['id', 'desc', 'postal', 'province', 'mbps', 'currentPrice', 'discount', 'termMonths',
  'contractStart', 'promoEnd', 'promoMonths', 'promoActive', 'postPromoPrice', 'benchProvider',
  'benchPlan', 'benchMbps', 'benchMonthly', 'benchMatched', 'totalPaid', 'totalBenchmark',
  'totalSavings', 'overPct', 'card', 'cliffDate', 'cliffTo', 'warnings', 'checks', 'error'];

const VALID_CASES = new Set(['no_saving', 'small_saving', 'moderate_saving', 'big_saving']);

/** Sanity checks a fresh CSV run is expected to satisfy. Not a redundant copy
 *  of scripts/test-checkup-savings.mjs's assertions — those pin exact
 *  numbers per scenario; these are invariants any row must hold regardless
 *  of scenario, so a new bad case added here is still caught. */
function sanityIssues(r, card) {
  const issues = [];
  if (!Number.isFinite(r.totalPaid) || !Number.isFinite(r.totalBenchmark) || !Number.isFinite(r.totalSavings)) {
    issues.push('non-finite totals');
  }
  if (r.totalSavings < 0) issues.push('negative totalSavings');
  if (r.promoMonths > r.termMonths) issues.push('promoMonths exceeds termMonths');
  if (!(r.benchmarkMonthly > 0)) issues.push('benchmarkMonthly not positive');
  if (!VALID_CASES.has(card.case)) issues.push(`unknown card case "${card.case}"`);
  return issues;
}

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function runCase(c) {
  const row = {
    id: c.id, desc: c.desc, postal: c.postal, province: provinceFromPostalCode(c.postal),
    mbps: c.mbps, currentPrice: c.currentPrice, discount: c.discount, termMonths: c.termMonths,
    contractStart: c.contractStart || '', promoEnd: c.promoEnd || '',
    promoMonths: '', promoActive: '', postPromoPrice: '', benchProvider: '', benchPlan: '',
    benchMbps: '', benchMonthly: '', benchMatched: '', totalPaid: '', totalBenchmark: '',
    totalSavings: '', overPct: '', card: '', cliffDate: '', cliffTo: '', warnings: '',
    checks: 'PASS', error: ''
  };
  try {
    const r = calculateCheckup({
      postalCode: c.postal, downloadMbps: c.mbps, currentPrice: c.currentPrice,
      discountAmount: c.discount, contractLengthMonths: c.termMonths,
      contractStartDate: c.contractStart || undefined, promoEndDate: c.promoEnd, today: TODAY,
      promoPeriods: c.promoPeriods
    });
    const card = buildCard(r, c.postal.slice(0, 3));
    const issues = sanityIssues(r, card);

    Object.assign(row, {
      promoMonths: r.promoMonths, promoActive: r.promoActive, postPromoPrice: r.postPromoPrice,
      benchProvider: r.benchmark.provider || '', benchPlan: r.benchmark.plan || '',
      benchMbps: r.benchmark.mbps, benchMonthly: r.benchmark.monthly, benchMatched: r.benchmark.matched,
      totalPaid: r.totalPaid, totalBenchmark: r.totalBenchmark, totalSavings: r.totalSavings,
      overPct: r.totalBenchmark > 0 ? Math.round((r.totalSavings / r.totalBenchmark) * 1000) / 10 : 0,
      card: card.case, cliffDate: r.cliff ? r.cliff.date : '', cliffTo: r.cliff ? r.cliff.to : '',
      warnings: r.warnings.join('; '),
      checks: issues.length ? 'FAIL' : 'PASS', error: issues.join('; ')
    });
  } catch (e) {
    row.checks = 'FAIL';
    row.error = e.message;
  }
  return row;
}

const rows = CASES.map(runCase);
const csv = [HEADER.join(',')]
  .concat(rows.map(r => HEADER.map(h => csvField(r[h])).join(',')))
  .join('\n') + '\n';

if (CHECK) {
  const prev = existsSync(FIXTURE) ? readFileSync(FIXTURE, 'utf8') : null;
  if (prev === csv) { console.log(`ok      ${FIXTURE.replace(ROOT + '/', '')}`); process.exit(0); }
  console.error(`STALE   ${FIXTURE.replace(ROOT + '/', '')} — regenerate with: node scripts/test-checkup-50-cases.mjs\n`);
  const prevRows = prev ? prev.trim().split('\n').slice(1) : [];
  const nextRows = csv.trim().split('\n').slice(1);
  for (let i = 0; i < Math.max(prevRows.length, nextRows.length); i++) {
    if (prevRows[i] !== nextRows[i]) {
      console.error(`row ${i + 1}:`);
      console.error(`  fixture: ${prevRows[i] ?? '(missing)'}`);
      console.error(`  fresh:   ${nextRows[i] ?? '(missing)'}`);
    }
  }
  process.exit(1);
}

const failed = rows.filter(r => r.checks === 'FAIL');
writeFileSync(FIXTURE, csv);
console.log(`written ${FIXTURE.replace(ROOT + '/', '')}  (${rows.length} cases, ${failed.length} failed sanity checks)`);
if (failed.length) {
  for (const r of failed) console.log(`  FAIL #${r.id} ${r.desc}: ${r.error}`);
  process.exitCode = 1;
}
