#!/usr/bin/env node
/* Print a compressed auction calendar for the `campaigns` table, so a cohort
 * can be watched moving through all seven member stages in a few minutes
 * instead of a few weeks.
 *
 *   node scripts/seed-test-campaign.mjs               # 2 minutes per stage
 *   node scripts/seed-test-campaign.mjs --minutes 5
 *   node scripts/seed-test-campaign.mjs --start 3     # first step 3 min out
 *   node scripts/seed-test-campaign.mjs --id london-east
 *
 * It prints values, it does not write anything: the Data Store has no DDL or
 * write API from here, so the seven DateTime cells go in by hand in the
 * Catalyst console (Data Store -> campaigns -> the row -> edit), exactly like
 * every other schema change in this repo.
 *
 * For the same calendar as a single ZCQL UPDATE, plus what each date does to
 * both dashboards, see `node scripts/cohort.mjs calendar <id>`. This file stays
 * for its stage-by-stage table, which is the clearer thing to read while you
 * are watching a cohort move.
 *
 * Catalyst wants 'YYYY-MM-DD HH:MM:SS' in **UTC**, which is not ISO-8601 and
 * is not local time. Both are printed: paste the UTC one, read the local one.
 *
 * Nothing here is a fixture the site can read. It only tells you what to type,
 * so a "working" dashboard is still being driven by the real table, the real
 * stage engine and the real endpoint.
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};

const STEP = Number(flag('minutes', 2));
const LEAD = Number(flag('start', 2));
const ID = flag('id', 'london-east');

if (!Number.isFinite(STEP) || STEP <= 0) {
  console.error('--minutes must be a positive number');
  process.exit(1);
}

/* The seven columns, in the order the calendar runs, paired with the member
   stage each one opens. Mirrors MEMBER_GATES in
   catalyst-backend/functions/auth/src/lib/catalog.js. */
const CALENDAR = [
  ['announce_at', 'locked', 'joining shuts, the brief is fixed'],
  ['bidding_opens_at', 'bidding', 'sealed bidding opens'],
  ['bidding_closes_at', '(bidding)', 'bids close, offer being prepared'],
  ['offers_at', 'offers', 'the winning offer reaches the household'],
  ['decision_at', 'confirm', 'confirmations lock'],
  ['switch_window_at', 'switching', 'installs and transfers run'],
  ['reconcile_at', 'done', 'final counts settle'],
];

const pad = (n) => String(n).padStart(2, '0');
const utc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
  + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const local = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const now = new Date();
const rows = CALENDAR.map(([col, stage, what], i) => {
  const at = new Date(now.getTime() + (LEAD + i * STEP) * 60000);
  return { col, stage, what, at };
});

const w = Math.max(...CALENDAR.map(([c]) => c.length));
console.log(`\ncampaign_id  ${ID}`);
console.log(`kind         auction        <- the calendar only runs for an auction`);
console.log(`bidding_open true           <- dates may close a bid window, never open one`);
console.log(`\nSeven DateTime cells, ${STEP} minute(s) apart, generated ${local(now)} local:\n`);
console.log(`  ${'column'.padEnd(w)}  ${'UTC (paste this)'.padEnd(21)}  ${'local'.padEnd(9)}  member stage`);
console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(21)}  ${'-'.repeat(9)}  ------------`);
for (const r of rows) {
  console.log(`  ${r.col.padEnd(w)}  ${utc(r.at).padEnd(21)}  ${local(r.at).padEnd(9)}  ${r.stage}  (${r.what})`);
}

const last = rows[rows.length - 1].at;
console.log(`\nBefore ${local(rows[0].at)} the cohort reads "Forming"; after ${local(last)} it reads "Done".`);
console.log(`Whole run: ${LEAD}..${LEAD + (CALENDAR.length - 1) * STEP} minutes from now.\n`);
console.log('Then, signed in as a member who has JOINED that cohort, open /dashboard.');
console.log('The rail advances on its own: the page repolls GET /campaigns and the');
console.log('server restages the calendar on every read. Nothing is derived in the');
console.log('browser, so what you are watching is the real engine.\n');
console.log('Note: catalog.load() memoizes the table for 60s, so an edit can take up');
console.log('to a minute to be visible. Keep --minutes at 2 or more for that reason.\n');
