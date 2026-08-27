#!/usr/bin/env node
/* Drive a cohort from ZCQL, and know what both dashboards will do with it
 * before you paste anything.
 *
 *   node scripts/cohort.mjs new scarborough-east --region "Scarborough East" --sub "Autumn cohort"
 *   node scripts/cohort.mjs move scarborough-east --from forming --to auction
 *   node scripts/cohort.mjs bidding scarborough-east --on
 *   node scripts/cohort.mjs calendar scarborough-east --minutes 3
 *   node scripts/cohort.mjs step scarborough-east --list
 *   node scripts/cohort.mjs step scarborough-east --to bidding
 *   node scripts/cohort.mjs seed scarborough-east etobicoke-centre north-york-central
 *   node scripts/cohort.mjs seed scarborough-east --minutes 5   # a test rail, biddable now
 *   node scripts/cohort.mjs coverage org_7f2a --region "Scarborough East"
 *   node scripts/cohort.mjs regions
 *   node scripts/cohort.mjs verify scarborough-east
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
const places = backend('lib/places.js');
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
  lines.push('    appears on EVERY approved partner\'s desk. views/desk.js renders the whole payload:');
  lines.push('    planned and announced under "Coming cohorts", everything else under "Open auctions".');
  lines.push(`    BIDDABLE only where that org's provider_coverage row for "${c.region || '(region)'}" is`);
  lines.push('    status=active. Without it the row still renders, locked, tagged "Verifies with');
  lines.push('    <region> coverage", and the bid write is refused server side either way.');
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

/**
 * A region name the vocabulary actually has, canonically spelled.
 *
 * THIS IS THE CHECK ZCQL CANNOT DO FOR YOU. The region is the entire join
 * between a cohort and a partner: requireActiveCoverage() compares
 * slug(coverage.region) to slug(campaign.region) exactly, server side. Paste an
 * INSERT naming "Vaughan West" and every dashboard renders it, households join
 * it, the clock runs down, and not one partner can bid because not one of them
 * can declare coverage under that name. Nothing errors. It reads as a market
 * that did not bite.
 *
 * `launch` is the stricter half: the coverage picker offers only launch-city
 * regions as selectable, so a cohort in a queued city is unreachable too.
 * Declaring coverage does not need it, because a partner may register interest
 * in a queued city and an operator leaves that row 'soon'.
 */
function region(raw, { what = '--region', launch = true } = {}) {
  if (!raw || raw === true) die(`${what} is required, and it is what provider_coverage matches on`);
  const name = String(raw).trim();
  const known = launch ? places.isLaunchRegion(name) : places.isRegion(name);
  if (!known) {
    const near = places.suggest(name);
    const why = places.isRegion(name)
      ? `"${name}" is a real region, but its city has not launched, so no partner can declare it`
      : `"${name}" is not a region any partner can declare`;
    die(`${why}.\n\n  ${near.length ? 'Did you mean: ' + near.join(', ') : 'Nothing close matched'}\n`
      + `  Full list:   node scripts/cohort.mjs regions`);
  }
  return places.canonical(name);
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/** Every declarable region, so nobody has to open places.js to spell one. */
function cmdRegions() {
  const names = places.launchRegions();
  console.log(`\n${names.length} regions a partner can declare today:\n`);
  const byCity = new Map();
  places.PLACES.filter((p) => p.launch).forEach((p) => byCity.set(p.city, p.regions));
  for (const [city, regions] of byCity) {
    console.log(`  ${city}`);
    regions.forEach((r) => console.log(`    ${r}`));
  }
  console.log('\n  A cohort outside this list can never be bid on. See lib/places.js.\n');
}

function cmdNew() {
  const id = cohortId(POSITIONAL[0]);
  const region_ = region(flag('region'));
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
    lit(region_, { max: 100, what: '--region' }),
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
  ], campaignFrom({ id, region: region_, kind: k }), [
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

/* THE TEST SCHEDULE, in multiples of --minutes rather than days.
 *
 * Two dates are deliberately BEHIND: a cohort has to be biddable the moment the
 * row lands, and both halves of that are gated on it. bidAction() in
 * partner/views/desk.js only draws "Review and bid" at stage open or closing,
 * and stageOf only reaches those once bidding_opens_at has passed. A rail that
 * starts in the future reads Announced, with no button, which is the one state
 * a tester reads as broken code.
 *
 * The bid window is therefore TWO intervals wide, from one interval ago to one
 * ahead, so --minutes 5 leaves ten minutes to fill a ticket in and --minutes 10
 * leaves twenty. Everything after the close runs at one interval per stage.
 */
const FAST_OFFSETS = Object.freeze({
  announce_at: -2, bidding_opens_at: -1, bidding_closes_at: 1,
  offers_at: 2, decision_at: 3, switch_window_at: 4, reconcile_at: 5,
});

/* Deadlines land at --hour, everything else at 13:00 UTC, which is 9 AM
   Eastern. Two times of day rather than one because a cohort that opens and
   closes at the same minute reads as a scheduling accident. */
const SEED_MORNING = 13;

/** Title case a slug, so `scarborough-east` gives `Scarborough East`. The
    region has to slug back to the same string for coverage to match it.

    A GUESS, and checked as one. `mississauga-core` title-cases into
    "Mississauga Core", which is not a region anybody can declare, and
    `maple-and-vmc` into "Maple And Vmc" rather than "Maple and VMC". Every
    result goes through region() before it reaches a statement; pass --regions
    when the guess is wrong. This is how three unbiddable cohorts reached the
    live campaigns table. */
function regionFromId(id) {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/* Every seed flag takes a value, and POSITIONAL only drops the flags
   themselves, so `--seed 87` would otherwise offer 87 as a campaign_id. */
const SEED_FLAGS = new Set(['regions', 'first', 'every', 'hour', 'sub', 'seed', 'sort', 'minutes']);

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
  const given = regionsFlag && regionsFlag !== true
    ? String(regionsFlag).split(',').map((r) => r.trim())
    : ids.map(regionFromId);
  if (given.length !== ids.length) {
    die(`--regions has ${given.length} entries for ${ids.length} cohorts`);
  }
  /* Checked here and not only in `new`, because seeding is the command that
     creates cohorts in bulk, and one unreachable name among six is the
     one nobody notices. Title-casing an id is a guess, and 'mississauga-core'
     guesses 'Mississauga Core', which is not a region anyone can declare. */
  const regions = given.map((r) => region(r, { what: '--regions' }));

  /* --minutes switches the whole batch from a calendar measured in days to one
     measured in minutes, for a test run rather than a launch. It replaces the
     three day flags rather than combining with them: a batch cannot be spaced
     both a week and five minutes apart, and silently ignoring one of them is
     how a tester ends up watching a cohort that was never going to move. */
  const fastFlag = flag('minutes');
  const fast = fastFlag === undefined ? null : Number(fastFlag === true ? NaN : fastFlag);
  if (fast !== null) {
    if (!Number.isFinite(fast) || fast < 2) {
      die('--minutes must be a number of at least 2. catalog.load() memoizes the table for 60\n'
        + '  seconds, so a faster rail moves through stages no dashboard gets to render.');
    }
    for (const f of ['first', 'every', 'hour']) {
      if (has(f)) die(`--minutes replaces --${f}: it dates the batch from now, not from a day`);
    }
  }

  const first = num(flag('first', '1'), 'first');
  const every = num(flag('every', '7'), 'every');
  if (every < 1) die('--every must be at least 1 day, or two cohorts close on the same date');
  const hour = num(flag('hour', '21'), 'hour');
  if (hour > 23) die('--hour is a UTC hour, 0 to 23');
  const sub = flag('sub', '') === true ? '' : flag('sub', '');
  const seed = num(flag('seed', '0'), 'seed');
  /* THE FEATURED COHORT IS THE LOWEST sort_order, so a new one has to sort
     BELOW the rows already there, and the only way to do that without
     rewriting them is to count down. catalog.load() sorts ascending, the
     member row's ccRank breaks its ties on that order, and featuredCamp()
     takes the first card, so "newest is featured" is one descending number and
     no UPDATE to any existing cohort. Start a store at --sort 100 and take one
     off per batch; within a batch the ids stay in the order given, which is
     closing order. */
  const sortBase = num(flag('sort', '0'), 'sort');
  /* A duplicate-key refusal means the row is already there. Rescheduling it is
     an UPDATE: DELETE is never the answer, because there are no foreign keys
     and any campaign_members row would survive pointing at nothing. */
  const update = has('update');

  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const DAY_MS = 86400000;

  const rows = ids.map((id, i) => {
    const close = midnight + (first + i * every) * DAY_MS + hour * 3600000;
    const dates = {};
    if (fast !== null) {
      /* Every cohort in the batch runs the same rail. Staggering them would
         put each one in a different stage, and the reason to seed several at
         once is to look at a row of cards, which wants them comparable. */
      for (const [col, mult] of Object.entries(FAST_OFFSETS)) {
        dates[col] = now.getTime() + mult * fast * 60000;
      }
    } else {
      for (const [col, off] of Object.entries(SEED_OFFSETS)) {
        const deadline = col === 'bidding_closes_at' || col === 'decision_at';
        dates[col] = close + off * DAY_MS + (deadline ? 0 : (SEED_MORNING - hour) * 3600000);
      }
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

  console.log(fast !== null
    ? `\nSEED: ${rows.length} auction cohorts on a ${fast} minute rail, biddable now`
    : `\nSEED: ${rows.length} auction cohorts, one closing every ${every} day(s)`);
  console.log(update
    ? '  --update: these RESCHEDULE rows that already exist. Nothing is created.\n'
    : '');
  console.log('  ZCQL runs ONE statement per submission. Paste these one at a time: a block of');
  console.log(`  ${rows.length} is a syntax error, and so is the second one in any pair.`);
  if (!update) {
    console.log('  A duplicate-key refusal means that cohort already exists. Do NOT delete it:');
    console.log('  there are no foreign keys, so its campaign_members rows would survive pointing');
    console.log('  at nothing. Re-run with --update and paste that statement instead.');
  }
  console.log('');

  rows.forEach((r, i) => {
    /* A column is omitted rather than written NULL or ''. Both are legal SQL
       and neither is worth finding out about in a console with write access:
       an absent column reads back as an absent value, which is what target and
       an unset sub mean anyway. target is absent on every auction because the
       household count is the join count, not a goal. */
    const pairs = [
      ['campaign_id', lit(r.id, { max: 64, what: 'campaign_id' })],
      ['region', lit(r.region, { max: 100, what: 'region' })],
      ['sub', sub ? lit(sub, { max: 100, what: '--sub' }) : null],
      ['kind', lit('auction')],
      ['seed_members', lit(seed)],
      ['seed_households', lit(seed)],
      ['bidding_open', lit(r.biddingOpen)],
      ['sort_order', lit(sortBase + i)],
      ['updated_by', lit('manual', { max: 64 })],
      ['updated_at', lit(utc(new Date()))],
      ...DATE_COLUMNS.map((c) => [c, lit(utc(new Date(r.dates[c])))]),
    ].filter(([, v]) => v !== null);

    console.log(`  ${i + 1} of ${rows.length}: ${r.id}`);
    if (update) {
      /* campaign_id is the key, so it moves from the SET list to the WHERE.
         It is also immutable by design: both dashboards and every bid_key are
         built from it, so a row is rescheduled, never renamed. */
      const sets = pairs.filter(([c]) => c !== 'campaign_id')
        .map(([c, v]) => `${c} = ${v}`);
      console.log(`  UPDATE campaigns SET ${sets.join(', ')}`);
      console.log(`  WHERE campaign_id = ${lit(r.id, { max: 64 })};\n`);
    } else {
      console.log(`  INSERT INTO campaigns (${pairs.map(([c]) => c).join(', ')})`);
      console.log(`  VALUES (${pairs.map(([, v]) => v).join(', ')});\n`);
    }
  });

  /* The console reports a parse failure as one unhelpful line, so the two
     things it is most often actually objecting to are named here rather than
     found by bisecting a statement in a window with write access. */
  console.log('  If a single statement still reports a syntax error:\n');
  console.log('    - drop the trailing semicolon. The console submits one statement and some');
  console.log('      builds treat the terminator as a second, empty one.');
  console.log(`    - quote the boolean: bidding_open = 'true' rather than true.`);
  console.log('    Neither changes what is written. Tell me which one it was and this stops');
  console.log('    guessing: the tool should emit the dialect the console actually parses.\n');

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
  if (fast !== null) {
    const r = rows[0];
    console.log('    rail        every cohort in the batch runs this, from the moment you paste it:\n');
    const w2 = Math.max(...DATE_COLUMNS.map((c) => c.length));
    for (const col of DATE_COLUMNS) {
      const at = new Date(r.dates[col]);
      const away = Math.round((r.dates[col] - Date.now()) / 60000);
      const when = away === 0 ? 'now' : (away < 0 ? `${-away} min ago` : `in ${away} min`);
      console.log(`                  ${col.padEnd(w2)}  ${localTime(at)}  ${when.padEnd(11)}  ${OPENS[col]}`);
    }
    console.log(`\n                The bid window is open NOW and closes in ${fast} minute(s): stage is`);
    console.log('                closing, so the desk draws "Review and bid" rather than a locked row.');
    console.log(`                The whole rail finishes ${fast * 5} minutes from now.\n`);
  }
  console.log(`    featured    sort_order runs ${sortBase} to ${sortBase + rows.length - 1}, and the LOWEST is the featured`);
  console.log('                cohort on /dashboard. Next batch takes a LOWER --sort than this one, or');
  console.log('                the newest cohort lands last. Nothing already written has to move.');
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
  const status = flag('status', 'active');
  if (!['verifying', 'active', 'soon', 'rejected'].includes(status)) {
    die('--status must be one of: verifying | active | soon | rejected');
  }
  /* Known is enough here, not launched, which is exactly what POST
     /provider/coverage enforces. A partner may declare into a queued city and
     an operator leaves that row 'soon'. What is never legitimate is a name in
     no list at all, because no cohort can ever match it. This tool and the
     running site have to agree on that or one of them is wrong. */
  const region_ = region(flag('region'), { launch: false });
  const techs = flag('techs', 'cable,fibre');
  const slug = String(region_).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const key = `${org}:${slug}`.slice(0, 200);
  console.log(`\nCOVERAGE: ${org} serves ${region_}\n`);
  console.log(`  INSERT INTO provider_coverage (coverage_key, org_id, region, techs, status, updated_at)`);
  console.log(`  VALUES (${lit(key, { max: 200 })}, ${lit(org, { max: 64 })}, ${lit(region_, { max: 100 })}, ${lit(techs, { max: 64 })}, ${lit(status)}, ${lit(utc(new Date()))});`);
  console.log('\n  If the row already exists, set its status instead:\n');
  console.log(`  UPDATE provider_coverage SET status = ${lit(status)}, updated_at = ${lit(utc(new Date()))} WHERE coverage_key = ${lit(key, { max: 200 })};`);
  console.log('\n  Why this is needed:\n');
  console.log('    Coverage decides whether a cohort can be BID ON, not whether it is seen.');
  console.log('    views/desk.js renders every campaign in the payload and passes each row an');
  console.log('    `unlocked` flag: without active coverage for that region the action cell is a');
  console.log('    "Verifies with <region> coverage" tag instead of the bid button, and the row');
  console.log('    carries .locked. biddableCampaigns() (core/state.js) IS the coverage filter,');
  console.log('    and only views/bids.js calls it, for the ticket list. requireActiveCoverage()');
  console.log('    on the write path is what actually refuses the bid.');
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
  /* NOT added to a seed. lib/cohorts.js counts the two membership tables at
     read time and adds no baseline, so this query IS the number both surfaces
     show. seed_members survives as a column and is read by nothing. */
  console.log('\n  Real joins, which ARE the count both surfaces show:\n');
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
    id: flag('id', 'preview'), region: flag('region', 'Scarborough Centre'),
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
    step <id> --to <rung> | --list          (drive it by hand, one UPDATE per rung)
    seed <id> [<id>...] [--regions "A,B"] [--first N] [--every N] [--hour UTC]
                            [--sort N] [--seed N] [--update]
    seed <id> [<id>...] --minutes N [--regions "A,B"] [--sort N] [--seed N]
    coverage <org_id> --region R [--techs cable,fibre] [--status active]
    verify [<id>]
    regions
    preview [--kind K] [--bidding-open] [--region R]

  kinds: ${KINDS.join(' | ')}

  Joins are open on ${Object.keys(JOIN_STATUS).join(', ')}; bidding is open on auction
  with bidding_open. No cohort is ever both, which is what a sealed auction against
  a locked household count means.
`);
}


/* ------------------------------------------------------------------ *
 * step: drive a cohort one rung at a time, by hand
 *
 * `calendar` sets all seven dates at once and lets a clock walk the cohort
 * through them. That is the right shape for watching the rail move on its own
 * and the wrong shape for a test you are working through: the window closes
 * while you are filling in a bid ticket, and every rung has a deadline you did
 * not ask for.
 *
 * This is the other shape. One UPDATE per rung, each stamping ONE date with
 * "now", and every later date left NULL. A stage engine reading only the dates
 * it has been given cannot expire anything, so
 *
 *   - a bid window opened here stays open until you close it. requireBiddingOpen
 *     only refuses past `bidding_closes_at`, and there is no such date yet.
 *   - the cohort cannot skip a rung, because a stage is derived from the dates
 *     that exist, not from a counter someone has to keep.
 *   - the ladder is resumable. The row says where it is; nothing here does.
 *
 * The prediction under each rung assumes the rungs above it have been run,
 * which is what makes it a ladder. Run them out of order and the row is still
 * legal, the label is just no longer the one printed here.
 * ------------------------------------------------------------------ */

/* Each rung: the flag it sets, the date it stamps, and what a person does at
   that point. `dates` accumulates down the list, so the prediction for rung N
   is the row after rungs 1..N. */
const LADDER = Object.freeze([
  {
    key: 'announce', date: 'announce_at', kind: null, open: null,
    title: 'the brief is fixed, joining shuts',
    doing: 'Nothing to click. The member rail moves to Locked on its next poll.',
  },
  {
    key: 'auction', date: null, kind: 'auction', open: true,
    title: 'the cohort becomes an auction, and the window opens',
    doing: 'Reload /partner. The desk row is still not biddable: the stage needs the next rung.',
  },
  {
    key: 'bidding', date: 'bidding_opens_at', kind: null, open: null,
    title: 'sealed bidding is live',
    doing: 'Reload /partner. The row now reads Open and draws "Review and bid". Place the bid.',
  },
  {
    key: 'close', date: 'bidding_closes_at', kind: null, open: null,
    title: 'bids close, and the seal opens',
    doing: 'The member can now read the winning offer. Every further bid is refused from here.',
  },
  {
    key: 'offers', date: 'offers_at', kind: null, open: null,
    title: 'the offer has reached the household',
    doing: 'On /dashboard, accept the offer. That is what creates the switch order.',
  },
  {
    key: 'decide', date: 'decision_at', kind: null, open: null,
    title: 'confirmations lock',
    doing: 'Nothing to click. The partner desk reads Decided from here on.',
  },
  {
    key: 'switch', date: 'switch_window_at', kind: null, open: null,
    title: 'installs and transfers run',
    doing: 'On /partner, mark the activation. Only a clean line test creates a fee.',
  },
  {
    key: 'reconcile', date: 'reconcile_at', kind: null, open: null,
    title: 'final counts settle',
    doing: 'Nothing to click. The member rail reads Done.',
  },
  {
    key: 'done', date: null, kind: 'closed', open: false,
    title: 'the cohort is closed',
    doing: 'Optional. Archive it later with `move <id> --to archived` to take it off every surface.',
  },
]);

const LADDER_KEYS = LADDER.map((r) => r.key);

/** The statement for one rung. */
function rungSql(rung, id, stamp) {
  const sets = [];
  if (rung.kind) sets.push(`kind = ${lit(rung.kind)}`);
  if (rung.open !== null) sets.push(`bidding_open = ${rung.open}`);
  if (rung.date) sets.push(`${rung.date} = ${lit(stamp)}`);
  sets.push(`updated_at = ${lit(stamp)}`);
  return `UPDATE campaigns SET ${sets.join(', ')} WHERE campaign_id = ${lit(id, { max: 64 })};`;
}

/** The row as it stands after rungs 0..i, for the stage functions to read. */
function rungState(i, id, stamp) {
  const dates = {};
  let kind = 'forming';
  let biddingOpen = false;
  for (let n = 0; n <= i; n += 1) {
    const r = LADDER[n];
    if (r.date) dates[r.date] = new Date(`${stamp.replace(' ', 'T')}Z`).getTime() - (i - n) * 1000;
    if (r.kind) kind = r.kind;
    if (r.open !== null) biddingOpen = r.open;
  }
  return { id, region: '', kind, biddingOpen, dates };
}

function cmdStep() {
  const id = cohortId(POSITIONAL[0]);
  const stamp = utc(new Date());
  const to = flag('to');
  const all = has('list') || to === undefined;

  if (!all) {
    if (to === true || !LADDER_KEYS.includes(String(to))) {
      die(`--to must be one of: ${LADDER_KEYS.join(' | ')}\n\n  The whole ladder:  node scripts/cohort.mjs step ${id} --list`);
    }
    const i = LADDER_KEYS.indexOf(String(to));
    const rung = LADDER[i];
    emit(`RUNG ${i + 1} of ${LADDER.length}, ${rung.key}: ${rung.title}`,
      [rungSql(rung, id, stamp)], rungState(i, id, stamp), [
        `You do: ${rung.doing}`,
        i + 1 < LADDER.length
          ? `Next:   node scripts/cohort.mjs step ${id} --to ${LADDER[i + 1].key}`
          : 'That is the last rung.',
      ]);
    return;
  }

  console.log(`\nTHE LADDER: ${LADDER.length} rungs, one statement each, ${id}\n`);
  console.log('  Every rung stamps its date with the moment you run it, and leaves every later');
  console.log('  date NULL. Nothing expires while you work: a window opened at rung 3 stays open');
  console.log('  until rung 4 closes it, because there is no close date until then.\n');
  console.log(`  Start from a cohort created at kind = 'forming' with NO dates:`);
  console.log(`    node scripts/cohort.mjs new ${id} --region "<REGION>"\n`);

  LADDER.forEach((rung, i) => {
    const st = rungState(i, id, stamp);
    const m = catalog.publicMemberStage(st);
    const pa = catalog.publicStage(st);
    const biddable = pa.stage === 'open' || pa.stage === 'closing';
    console.log(`  ${String(i + 1).padStart(2)}. ${rung.key.padEnd(10)} ${rung.title}`);
    console.log(`      ${rungSql(rung, id, stamp)}`);
    console.log(`      consumer: ${m.stage.padEnd(9)} partner: ${pa.stage.padEnd(10)} bid button: ${biddable ? 'yes' : 'no'}`);
    console.log(`      you do:   ${rung.doing}\n`);
  });

  console.log('  One statement per submission: the ZCQL console takes one, and a block of nine');
  console.log('  is a syntax error. Allow 60 seconds after each for the catalog memo, and reload');
  console.log('  /partner every time: the console fetches campaigns once at boot and never polls.\n');
  console.log('  Timestamps above were generated once. Re-run this per rung, or read the clock:');
  console.log(`  every date is simply the current UTC minute in '${'YYYY-MM-DD HH:MM:SS'}'.\n`);
}

const COMMANDS = {
  new: cmdNew, move: cmdMove, bidding: cmdBidding, calendar: cmdCalendar,
  step: cmdStep,
  seed: cmdSeed, coverage: cmdCoverage, verify: cmdVerify, preview: cmdPreview,
  regions: cmdRegions,
};

const run = COMMANDS[CMD];
if (!run) { usage(); process.exit(CMD ? 1 : 0); }
run();
