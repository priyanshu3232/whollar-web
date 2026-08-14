#!/usr/bin/env node
/* Drive a cohort from ZCQL, and know what both dashboards will do with it
 * before you paste anything.
 *
 *   node scripts/cohort.mjs new kitchener-central --region Kitchener --sub "Autumn cohort"
 *   node scripts/cohort.mjs move kitchener-central --from forming --to auction
 *   node scripts/cohort.mjs bidding kitchener-central --on
 *   node scripts/cohort.mjs calendar kitchener-central --minutes 3
 *   node scripts/cohort.mjs seed scarborough-east mississauga-core north-york-central
 *   node scripts/cohort.mjs coverage org_7f2a --region Kitchener
 *   node scripts/cohort.mjs verify kitchener-central
 *   node scripts/cohort.mjs preview --kind auction --bidding-open
 *
 * WHY THIS EXISTS. The `campaigns` table already is the control surface: the
 * catalog was promoted out of code so that opening a cohort is an ops decision
 * rather than a deploy, and both dashboards read it. What ZCQL does not give
 * you is any of the checking the admin routes do on the way in. Type `Forming`
 * instead of `forming` and catalog.fromRow silently reads it back as `planned`.
 * Move an archived cohort to auction and no state machine objects. Set
 * bidding_closes_at to a date that has passed and bidding_open stays true while
 * every bid is refused. None of that surfaces as an error anywhere: it surfaces
 * as a quiet week.
 *
 * So this validates against the SAME constants the server uses, imported from
 * lib/catalog.js rather than restated here, and then predicts both dashboards
 * by calling the SAME stage functions the routes call. If this tool and the
 * running site ever disagree, that is a bug in one of them, not a drift between
 * two copies of the rules.
 *
 * IT PRINTS, IT DOES NOT WRITE. There is no DDL or write path from a laptop to
 * the Data Store, which is the same reason every schema change in this repo is
 * a document rather than a migration. Paste into Catalyst console -> Data Store
 * -> ZCQL. A "working" dashboard afterwards is still being driven by the real
 * table, the real stage engine and the real endpoint.
 */

import { backend } from './backend-module.mjs';

const catalog = backend('lib/catalog.js');
const { KINDS, JOIN_STATUS, ID_RE, TRANSITIONS, DATE_COLUMNS } = catalog;

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const CMD = argv[0] || '';
/* The first non-flag argument after the command. */
const POSITIONAL = argv.slice(1).filter((a) => !a.startsWith('--'));

function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}
const has = (name) => argv.indexOf(`--${name}`) > -1;

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * ZCQL literals
 *
 * Validate rather than escape, for the reason lib/datastore.js gives at
 * length: a quote inside a value that this tool cheerfully backslashed would
 * be a statement the operator did not read carefully, pasted into a console
 * with full write access. A rejected value is a typo you fix; an escaped one
 * is a habit.
 * ------------------------------------------------------------------ */

const BAD_LITERAL = /['\\\r\n\0]/;

function lit(value, { max = 320, what = 'value' } = {}) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) die(`${what} is not a finite number`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value);
  if (BAD_LITERAL.test(s)) {
    die(`${what} contains a quote, backslash or newline. ZCQL has no parameter binding here, so this tool refuses to escape it for you. Use plain text.`);
  }
  if (s.length > max) die(`${what} is ${s.length} characters, over the column's ${max}`);
  return `'${s}'`;
}

const num = (v, what) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) die(`--${what} must be a whole number, got ${v}`);
  return n;
};

/* Catalyst wants 'YYYY-MM-DD HH:MM:SS' in UTC, which is neither ISO-8601 nor
   local time. One formatter, as in lib/datastore.js. */
const pad = (n) => String(n).padStart(2, '0');
const utc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
  + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const cohortId = (id) => {
  if (!id) die('a campaign_id is required');
  if (!ID_RE.test(id)) die(`"${id}" is not a slug: 3 to 64 characters of a-z, 0-9 and hyphen`);
  return id;
};

const kind = (k, what = '--kind') => {
  if (!KINDS.includes(k)) die(`${what} must be one of: ${KINDS.join(' | ')}`);
  return k;
};

/* ------------------------------------------------------------------ *
 * Prediction: what each surface does with a row
 *
 * Both answers come from lib/catalog.js, so this is the running site's own
 * opinion rather than a second implementation of it.
 * ------------------------------------------------------------------ */

function predict(c, now = Date.now()) {
  const member = catalog.publicMemberStage(c, now);
  const partner = catalog.publicStage(c, now);
  const joinAs = JOIN_STATUS[c.kind] || null;
  const closes = c.dates && c.dates.bidding_closes_at;
  const lines = [];

  lines.push('  CONSUMER  /dashboard, GET /campaigns');
  lines.push(`    on the "Campaigns near you" row as "${c.region || '(region)'}"`);
  lines.push(joinAs === 'joined'
    ? '    joinable: yes, and joining makes the household a member of the cohort'
    : joinAs === 'waitlist'
      ? '    joinable: yes, as a waitlist spot rather than a place in the cohort'
      : `    joinable: NO. kind=${c.kind} is not in JOIN_STATUS, so the join route refuses`);
  if (joinAs === 'joined') {
    lines.push('    eligible to be the "Open in your area" card, if it sorts first among joinable cohorts');
  }
  lines.push(`    member stage: ${member.stage} (${member.stageLabel})`);

  lines.push('');
  lines.push('  PARTNER   /partner, GET /provider/campaigns');
  lines.push(`    partner stage: ${partner.stage} (${partner.stageLabel})`);
  const windowOpen = c.kind === 'auction' && Boolean(c.biddingOpen);
  lines.push(windowOpen
    ? '    bid window: OPEN'
    : `    bid window: closed (kind=${c.kind}, bidding_open=${Boolean(c.biddingOpen)})`);
  if (windowOpen && closes && closes <= now) {
    lines.push('    BUT bidding_closes_at has passed, so requireBiddingOpen refuses every bid.');
    lines.push('    bidding_open being true does not override it: dates may close a window, never open one.');
  }
  lines.push(`    reaches a desk only where that org's provider_coverage row for "${c.region || '(region)'}"`);
  lines.push('    is status=active. A cohort with no matching coverage is invisible to that partner.');
  if (c.kind === 'auction') {
    lines.push('    a bid write also needs bid_revisions and the 15 extra provider_bids columns (create-tables.md 18)');
  }
  return lines.join('\n');
}

/** The shape catalog's stage functions consume. */
function campaignFrom(opts) {
  return {
    id: opts.id || 'preview',
    region: opts.region || '',
    kind: opts.kind || 'planned',
    biddingOpen: Boolean(opts.biddingOpen),
    dates: opts.dates || {},
  };
}

function emit(title, statements, campaign, notes = []) {
  console.log(`\n${title}\n`);
  for (const s of statements) console.log(`  ${s}`);
  console.log('\n  What this makes true, from lib/catalog.js:\n');
  console.log(predict(campaign));
  if (notes.length) {
    console.log('');
    for (const n of notes) console.log(`  ${n}`);
  }
  console.log('\n  Paste into Catalyst console -> Data Store -> ZCQL, Development environment.');
  console.log('  catalog.load() memoizes for 60 seconds, so allow a minute before judging a dashboard.\n');
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

function cmdNew() {
  const id = cohortId(POSITIONAL[0]);
  const region = flag('region');
  if (!region || region === true) die('--region is required, and it is what provider_coverage matches on');
  const sub = flag('sub', '') === true ? '' : flag('sub', '');
  const k = kind(flag('kind', 'forming'));
  const target = num(flag('target', '100'), 'target');
  const sort = num(flag('sort', '0'), 'sort');
  /* Seeds default to zero on purpose. They are added to real joins on both
     surfaces, so a non-zero seed is padding a partner will eventually bid
     against. Opt in with --seed if you are staging a demo. */
  const seed = num(flag('seed', '0'), 'seed');
  const cols = ['campaign_id', 'region', 'sub', 'kind', 'target', 'seed_members',
    'seed_households', 'bidding_open', 'sort_order', 'updated_by', 'updated_at'];
  const vals = [
    lit(id, { max: 64, what: 'campaign_id' }),
    lit(region, { max: 100, what: '--region' }),
    lit(sub, { max: 100, what: '--sub' }),
    lit(k),
    k === 'auction' ? 'NULL' : lit(target),
    lit(seed), lit(seed),
    'false',
    lit(sort),
    lit('manual', { max: 64 }),
    lit(utc(new Date())),
  ];
  emit(`INSERT: a new cohort, ${id}`, [
    `INSERT INTO campaigns (${cols.join(', ')})`,
    `VALUES (${vals.join(', ')});`,
  ], campaignFrom({ id, region, kind: k }), [
    'The slug is permanent: it is the id both dashboards key on and every bid_key is built from.',
    'No calendar is set. That is the normal state of a new cohort, and stage falls back to kind alone.',
    `Set one with:  node scripts/cohort.mjs calendar ${id}`,
  ]);
}

function cmdMove() {
  const id = cohortId(POSITIONAL[0]);
  const to = kind(flag('to'), '--to');
  const from = flag('from');
  const notes = [];
  if (from && from !== true) {
    kind(from, '--from');
    const legal = TRANSITIONS[from] || [];
    if (!legal.includes(to)) {
      die(`a ${from} cohort cannot move to ${to}. Legal moves from ${from}: ${legal.join(', ') || 'none'}`);
    }
  } else {
    notes.push('No --from given, so the lifecycle could not be validated. ZCQL enforces nothing here:');
    notes.push('the state machine lives in the admin route, which you are going around.');
    notes.push(`Legal moves: ${Object.entries(TRANSITIONS).map(([f, t]) => `${f} -> ${t.join('/')}`).join(', ')}`);
  }
  const st = [`UPDATE campaigns SET kind = ${lit(to)}, updated_at = ${lit(utc(new Date()))} WHERE campaign_id = ${lit(id, { max: 64 })};`];
  /* The admin route closes the window on the way out of auction, and this has
     to match it: a cohort left at bidding_open=true after moving to closed is a
     row that reads as open on inspection and refuses every bid in practice. */
  if (from && from === 'auction' && to !== 'auction') {
    st.push(`UPDATE campaigns SET bidding_open = false WHERE campaign_id = ${lit(id, { max: 64 })};`);
    notes.push('Leaving auction always closes the bid window, which is what the admin route does.');
  }
  if (to === 'auction') {
    notes.push('Entering auction locks member joins immediately and never opens bidding on its own.');
    notes.push(`Open the window deliberately:  node scripts/cohort.mjs bidding ${id} --on`);
  }
  emit(`MOVE: ${id} -> ${to}`, st,
    campaignFrom({ id, region: flag('region', '') === true ? '' : flag('region', ''), kind: to }), notes);
}

function cmdBidding() {
  const id = cohortId(POSITIONAL[0]);
  if (has('on') === has('off')) die('pass exactly one of --on or --off');
  const on = has('on');
  emit(`BID WINDOW: ${id} ${on ? 'open' : 'closed'}`, [
    `UPDATE campaigns SET bidding_open = ${on}, updated_at = ${lit(utc(new Date()))} WHERE campaign_id = ${lit(id, { max: 64 })};`,
  ], campaignFrom({ id, region: '', kind: 'auction', biddingOpen: on }), on ? [
    'This only has effect while kind = auction. On any other kind the flag is inert,',
    'and publicPartnerCampaign reports bidding_open false regardless of the column.',
    'site_config.bidding_enabled = false still overrides it globally.',
  ] : []);
}

/* The seven dates, evenly spaced, so a cohort can be watched through every
   member stage in minutes rather than weeks. The stage each column opens
   mirrors MEMBER_GATES in lib/catalog.js; DATE_COLUMNS is imported so the
   order can never drift from the server's. */
const OPENS = {
  announce_at: 'locked, joining shuts and the brief is fixed',
  bidding_opens_at: 'bidding, the sealed window opens',
  bidding_closes_at: 'bids close, and past this every bid is refused',
  offers_at: 'offers, the winning offer reaches the household',
  decision_at: 'confirm, confirmations lock',
  switch_window_at: 'switching, installs and transfers run',
  reconcile_at: 'done, final counts settle',
};

function cmdCalendar() {
  const id = cohortId(POSITIONAL[0]);
  const step = Number(flag('minutes', '3'));
  const lead = Number(flag('start', '3'));
  if (!Number.isFinite(step) || step <= 0) die('--minutes must be a positive number');
  const now = new Date();
  const at = {};
  DATE_COLUMNS.forEach((col, i) => { at[col] = new Date(now.getTime() + (lead + i * step) * 60000); });
  const sets = DATE_COLUMNS.map((c) => `${c} = ${lit(utc(at[c]))}`);
  const dates = {};
  DATE_COLUMNS.forEach((c) => { dates[c] = at[c].getTime(); });

  console.log(`\nCALENDAR: ${id}, ${step} minute(s) per stage\n`);
  console.log(`  UPDATE campaigns SET\n    ${sets.join(',\n    ')}\n  WHERE campaign_id = ${lit(id, { max: 64 })};`);
  console.log('\n  Local clock, and the member stage each column opens:\n');
  const w = Math.max(...DATE_COLUMNS.map((c) => c.length));
  for (const c of DATE_COLUMNS) {
    console.log(`    ${c.padEnd(w)}  ${localTime(at[c])}  ${OPENS[c]}`);
  }
  console.log('\n  What this makes true, at the moment the last date passes:\n');
  console.log(predict(campaignFrom({ id, kind: 'auction', biddingOpen: true, dates }),
    at.reconcile_at.getTime() + 1000));
  console.log('\n  Keep --minutes at 2 or more: catalog.load() memoizes for 60 seconds, so a');
  console.log('  faster calendar moves through stages the dashboard never gets to show.');
  console.log('  The rail advances on its own, because the server restages on every read.');
  console.log('  Nothing is derived in the browser, so this is the real engine.\n');
}

/* ------------------------------------------------------------------ *
 * seed: several cohorts at once, dated so the calendar has something in it
 *
 * `new` plus `calendar` gets one cohort onto a desk, but the overview's
 * "Auction calendar" card is a different thing: agendaEvents in
 * partner/views/overview.js takes ONE dated event per campaign, decided by the
 * partner stage, keeps only the ones still ahead, and shows the first five. So
 * a calendar with five rows in it needs five campaigns, each in a stage whose
 * event date is in the future, and the minute-spaced calendar `calendar`
 * prints is the wrong shape for that: it runs a single cohort through every
 * stage inside a quarter of an hour.
 *
 * This spaces them in DAYS instead, one close per --every days, so the five
 * rows arrive in the order an operator would actually schedule them.
 * ------------------------------------------------------------------ */

/* Days from each cohort's bid close. Negative is before it. The close is the
   anchor because it is the date the calendar shows for an open cohort and the
   one requireBiddingOpen enforces. */
const SEED_OFFSETS = Object.freeze({
  announce_at: -10, bidding_opens_at: -7, bidding_closes_at: 0,
  offers_at: 2, decision_at: 9, switch_window_at: 12, reconcile_at: 26,
});

/* Deadlines land at --hour, everything else at 13:00 UTC, which is 9 AM
   Eastern. Two times of day rather than one because a cohort that opens and
   closes at the same minute reads as a scheduling accident. */
const SEED_MORNING = 13;

/** Title case a slug, so `scarborough-east` gives `Scarborough East`. The
    region has to slug back to the same string for coverage to match it. */
function regionFromId(id) {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/* Every seed flag takes a value, and POSITIONAL only drops the flags
   themselves, so `--seed 87` would otherwise offer 87 as a campaign_id. */
const SEED_FLAGS = new Set(['regions', 'first', 'every', 'hour', 'sub', 'seed']);

function seedIds() {
  const out = [];
  const tokens = argv.slice(1);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      if (SEED_FLAGS.has(t.slice(2))) i += 1;
      continue;
    }
    out.push(t);
  }
  return out;
}

function cmdSeed() {
  const ids = seedIds().map((p) => cohortId(p));
  if (!ids.length) die('at least one campaign_id is required: seed <id> [<id>...]');
  if (new Set(ids).size !== ids.length) die('the same campaign_id was given twice');
  if (ids.length > 12) die('12 cohorts is already more than the calendar can show; it takes the first five');

  const regionsFlag = flag('regions');
  const regions = regionsFlag && regionsFlag !== true
    ? String(regionsFlag).split(',').map((r) => r.trim())
    : ids.map(regionFromId);
  if (regions.length !== ids.length) {
    die(`--regions has ${regions.length} entries for ${ids.length} cohorts`);
  }

  const first = num(flag('first', '1'), 'first');
  const every = num(flag('every', '7'), 'every');
  if (every < 1) die('--every must be at least 1 day, or two cohorts close on the same date');
  const hour = num(flag('hour', '21'), 'hour');
  if (hour > 23) die('--hour is a UTC hour, 0 to 23');
  const sub = flag('sub', '') === true ? '' : flag('sub', '');
  const seed = num(flag('seed', '0'), 'seed');

  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const DAY_MS = 86400000;

  const rows = ids.map((id, i) => {
    const close = midnight + (first + i * every) * DAY_MS + hour * 3600000;
    const dates = {};
    for (const [col, off] of Object.entries(SEED_OFFSETS)) {
      const deadline = col === 'bidding_closes_at' || col === 'decision_at';
      dates[col] = close + off * DAY_MS + (deadline ? 0 : (SEED_MORNING - hour) * 3600000);
    }
    const biddingOpen = now.getTime() >= dates.bidding_opens_at
      && now.getTime() < dates.bidding_closes_at;
    return { id, region: regions[i], dates, biddingOpen };
  });

  /* Monotonic by construction, but --hour moves two of the seven and nothing
     else, so assert it rather than reason about it. A calendar out of order is
     a stage engine reading dates it was never given in that sequence. */
  for (const r of rows) {
    const at = DATE_COLUMNS.map((c) => r.dates[c]);
    for (let i = 1; i < at.length; i += 1) {
      if (at[i] <= at[i - 1]) die(`--hour ${hour} puts ${DATE_COLUMNS[i]} before ${DATE_COLUMNS[i - 1]} on ${r.id}`);
    }
  }

  const cols = ['campaign_id', 'region', 'sub', 'kind', 'target', 'seed_members',
    'seed_households', 'bidding_open', 'sort_order', 'updated_by', 'updated_at',
    ...DATE_COLUMNS];

  console.log(`\nSEED: ${rows.length} auction cohorts, one closing every ${every} day(s)\n`);
  rows.forEach((r, i) => {
    const vals = [
      lit(r.id, { max: 64, what: 'campaign_id' }),
      lit(r.region, { max: 100, what: 'region' }),
      lit(sub, { max: 100, what: '--sub' }),
      lit('auction'),
      'NULL',
      lit(seed), lit(seed),
      lit(r.biddingOpen),
      lit(i),
      lit('manual', { max: 64 }),
      lit(utc(new Date())),
      ...DATE_COLUMNS.map((c) => lit(utc(new Date(r.dates[c])))),
    ];
    console.log(`  INSERT INTO campaigns (${cols.join(', ')})`);
    console.log(`  VALUES (${vals.join(', ')});\n`);
  });

  console.log(`  The calendar these ${rows.length} rows make, from the same stage function the server uses.`);
  console.log('  The overview card shows the first five, soonest first:\n');
  const w = Math.max(...rows.map((r) => r.id.length));
  rows.forEach((r) => {
    const c = campaignFrom({ id: r.id, region: r.region, kind: 'auction', biddingOpen: r.biddingOpen, dates: r.dates });
    const stage = catalog.publicStage(c).stage;
    const ev = calendarEvent(r, stage);
    console.log(`    ${r.id.padEnd(w)}  ${stage.padEnd(10)}  ${ev
      ? `${ev.on.toDateString()} · ${r.region} · ${ev.title}`
      : 'NOT on the calendar: no future dated event in this stage'}`);
  });

  console.log('\n  Then, so the rows can actually be reached:\n');
  console.log('    coverage    each region needs a provider_coverage row at status=active for the org,');
  console.log('                or the cohort is on nobody\'s desk. One per region:');
  rows.forEach((r) => {
    console.log(`                  node scripts/cohort.mjs coverage <org_id> --region "${r.region}"`);
  });
  console.log(seed
    ? `    households  seed_households is ${seed} on every row, and a seed is ADDED to real joins on\n`
      + '                both surfaces. Fine for a demo, padding on anything a partner bids into.'
    : '    households  seed_households is 0, so a calendar row reads "A cohort in your coverage"\n'
      + '                rather than a count. Pass --seed N to stage a demo, and remember a seed\n'
      + '                is added to real joins on both surfaces.');
  console.log('    check       node scripts/cohort.mjs verify\n');
  console.log('  Paste into Catalyst console -> Data Store -> ZCQL, Development environment.');
  console.log('  catalog.load() memoizes for 60 seconds, so allow a minute before judging a dashboard.\n');
}

/* What agendaEvents in partner/views/overview.js will take from a row. Kept
   here so `seed` can say whether a cohort lands on the calendar at all rather
   than leaving that to be discovered in a browser. The stage-to-date mapping
   is the console's, and this is the second copy of it: change one, change
   both, and test-cohort.mjs asserts the dates are future either way. */
function calendarEvent(row, stage) {
  const pick = (col, title) => (row.dates[col] > Date.now() ? { on: new Date(row.dates[col]), title } : null);
  if (stage === 'planned' || stage === 'announced') return pick('bidding_opens_at', 'bidding opens');
  if (stage === 'open' || stage === 'closing') return pick('bidding_closes_at', 'bids close');
  if (stage === 'offers_out') return pick('decision_at', 'decisions lock');
  return null;
}

function cmdCoverage() {
  const org = POSITIONAL[0];
  if (!org) die('an org_id is required. It is the partner org the cohort should reach.');
  const region = flag('region');
  if (!region || region === true) die('--region is required, and must equal the cohort\'s region');
  const techs = flag('techs', 'cable,fibre');
  const status = flag('status', 'active');
  if (!['verifying', 'active', 'soon', 'rejected'].includes(status)) {
    die('--status must be one of: verifying | active | soon | rejected');
  }
  const slug = String(region).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const key = `${org}:${slug}`.slice(0, 200);
  console.log(`\nCOVERAGE: ${org} serves ${region}\n`);
  console.log(`  INSERT INTO provider_coverage (coverage_key, org_id, region, techs, status, updated_at)`);
  console.log(`  VALUES (${lit(key, { max: 200 })}, ${lit(org, { max: 64 })}, ${lit(region, { max: 100 })}, ${lit(techs, { max: 64 })}, ${lit(status)}, ${lit(utc(new Date()))});`);
  console.log('\n  If the row already exists, set its status instead:\n');
  console.log(`  UPDATE provider_coverage SET status = ${lit(status)}, updated_at = ${lit(utc(new Date()))} WHERE coverage_key = ${lit(key, { max: 200 })};`);
  console.log('\n  Why this is needed:\n');
  console.log('    biddableCampaigns() in partner/core/state.js filters the desk to regions where');
  console.log('    this org\'s coverage is status=active. A campaigns row alone does not reach a');
  console.log('    partner: it reaches every partner whose coverage matches, and nobody else.');
  console.log('    New rows normally land "verifying" and are moved on by the admin verify route.');
  console.log('    Writing active here goes around that check, which is fine for a test org and');
  console.log('    is not fine for a real one: serviceability accuracy is what the figure beside');
  console.log('    a partner\'s bid is built from.\n');
}

function cmdVerify() {
  const id = POSITIONAL[0];
  const where = id ? ` WHERE campaign_id = ${lit(cohortId(id), { max: 64 })}` : '';
  console.log('\nVERIFY\n');
  console.log('  The row, as both dashboards will read it:\n');
  console.log(`  SELECT campaign_id, region, sub, kind, target, seed_members, seed_households,`);
  console.log(`         bidding_open, sort_order FROM campaigns${where};`);
  console.log('\n  The calendar, which changes the stage label and can close a bid window:\n');
  console.log(`  SELECT campaign_id, announce_at, bidding_opens_at, bidding_closes_at, offers_at,`);
  console.log(`         decision_at, switch_window_at, reconcile_at FROM campaigns${where};`);
  console.log('\n  Real joins, which are added to seed_members on both surfaces:\n');
  console.log(`  SELECT campaign_id, status FROM campaign_members${where};`);
  console.log('\n  Which partners the cohort can reach:\n');
  console.log('  SELECT org_id, region, status FROM provider_coverage;');
  console.log('\n  The global bidding kill switch, which overrides every bidding_open:\n');
  console.log("  SELECT config_key, value FROM site_config WHERE config_key = 'bidding_enabled';");
  console.log('\n  Then, in a browser:\n');
  console.log('    member  GET /api/auth/campaigns           joinable, members, stage');
  console.log('    partner GET /api/auth/provider/campaigns  bidding_open, stage, households');
  console.log('\n  Both carry `live`. live:false means campaign_members was unreadable and every');
  console.log('  count is a seed, which looks exactly like a cohort nobody has joined.\n');
}

function cmdPreview() {
  const k = kind(flag('kind', 'forming'));
  const c = campaignFrom({
    id: flag('id', 'preview'), region: flag('region', 'Kitchener'),
    kind: k, biddingOpen: has('bidding-open'),
  });
  console.log(`\nPREVIEW: kind=${k}, bidding_open=${has('bidding-open')}, no calendar\n`);
  console.log(predict(c));
  console.log('');
}

function usage() {
  console.log(`
  cohort.mjs: drive a cohort from ZCQL, and see both dashboards before you paste.

    new <id> --region R [--sub S] [--kind K] [--target N] [--sort N] [--seed N]
    move <id> --to <kind> [--from <kind>]
    bidding <id> --on | --off
    calendar <id> [--minutes N] [--start N]
    seed <id> [<id>...] [--regions "A,B"] [--first N] [--every N] [--hour UTC] [--seed N]
    coverage <org_id> --region R [--techs cable,fibre] [--status active]
    verify [<id>]
    preview [--kind K] [--bidding-open] [--region R]

  kinds: ${KINDS.join(' | ')}

  Joins are open on ${Object.keys(JOIN_STATUS).join(', ')}; bidding is open on auction
  with bidding_open. No cohort is ever both, which is what a sealed auction against
  a locked household count means.
`);
}

const COMMANDS = {
  new: cmdNew, move: cmdMove, bidding: cmdBidding, calendar: cmdCalendar,
  seed: cmdSeed, coverage: cmdCoverage, verify: cmdVerify, preview: cmdPreview,
};

const run = COMMANDS[CMD];
if (!run) { usage(); process.exit(CMD ? 1 : 0); }
run();
