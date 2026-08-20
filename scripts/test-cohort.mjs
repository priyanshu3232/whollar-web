#!/usr/bin/env node
/* Tests for scripts/cohort.mjs, the ZCQL cohort tool.
 *
 *   node --test scripts/test-cohort.mjs
 *
 * The tool's whole claim is that it cannot emit a statement the server will
 * silently misread, and that its prediction of both dashboards is the running
 * site's own opinion rather than a second implementation. Neither claim is
 * worth anything unstated, so this asserts both against lib/catalog.js.
 *
 * The tool prints and exits, so these run it as a child process and read what
 * an operator would paste. That is the interface under test: a unit test of
 * its internals would pass while the printed statement was wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backend } from './backend-module.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'cohort.mjs');
const catalog = backend('lib/catalog.js');

/** Run the tool. Returns { out, code }; a refusal is a non-zero exit. */
function run(...args) {
  try {
    return { out: execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' }), code: 0 };
  } catch (err) {
    return { out: String(err.stdout || '') + String(err.stderr || ''), code: err.status };
  }
}

test('new emits an INSERT carrying every column catalog.js reads', () => {
  const { out, code } = run('new', 'north-york-central', '--region', 'North York Central', '--sub', 'Autumn cohort');
  assert.equal(code, 0);
  assert.match(out, /INSERT INTO campaigns/);
  /* Not a hand-kept list: every non-date column the catalog selects has to be
     in the statement, or the row reads back with a hole in it. */
  const skip = new Set([...catalog.DATE_COLUMNS, 'updated_by', 'updated_at']);
  for (const col of catalog.COLUMNS) {
    if (skip.has(col)) continue;
    assert.ok(out.includes(col), `INSERT is missing ${col}`);
  }
  assert.match(out, /'north-york-central', 'North York Central', 'Autumn cohort', 'forming'/);
});

test('seeds default to zero, because they are added to real joins on both surfaces', () => {
  const { out } = run('new', 'north-york-central', '--region', 'North York Central');
  assert.match(out, /'forming', 100, 0, 0, false/);
});

test('an auction is created with a null target, as the code catalog does', () => {
  const { out } = run('new', 'scarborough-east', '--region', 'Scarborough East', '--kind', 'auction');
  assert.match(out, /'auction', NULL/);
});

test('a slug that ID_RE would reject is refused, not emitted', () => {
  for (const bad of ['Bad ID', 'no', 'UPPER', 'has_underscore', 'x'.repeat(65)]) {
    const { out, code } = run('new', bad, '--region', 'North York Central');
    assert.equal(code, 1, `${bad} was accepted`);
    assert.doesNotMatch(out, /INSERT INTO/);
  }
});

test('every kind catalog declares is accepted, and nothing else is', () => {
  for (const k of catalog.KINDS) {
    assert.equal(run('new', 'test-cohort', '--region', 'York', '--kind', k).code, 0, `${k} was refused`);
  }
  for (const k of ['Forming', 'open', 'live', '']) {
    assert.equal(run('new', 'test-cohort', '--region', 'York', '--kind', k).code, 1, `${k} was accepted`);
  }
});

test('a quote in a value is refused rather than escaped', () => {
  /* ZCQL has no parameter binding. Escaping here would be a habit; refusing is
     a typo the operator fixes before pasting into a console with write access.
     Carried on --sub rather than --region: the region is a closed vocabulary
     now and no name in it contains a quote, so the only way to reach lit() with
     one is a free-text field. */
  const { out, code } = run('new', 'ok-id', '--region', 'York', '--sub', "O'Brien");
  assert.equal(code, 1);
  assert.doesNotMatch(out, /INSERT INTO/);
});

test('the lifecycle is validated against TRANSITIONS, in both directions', () => {
  for (const [from, tos] of Object.entries(catalog.TRANSITIONS)) {
    for (const to of catalog.KINDS) {
      const { code } = run('move', 'test-cohort', '--from', from, '--to', to);
      assert.equal(code, tos.includes(to) ? 0 : 1, `${from} -> ${to} disagreed with TRANSITIONS`);
    }
  }
});

test('leaving auction closes the bid window, as the admin route does', () => {
  const { out } = run('move', 'test-cohort', '--from', 'auction', '--to', 'closed');
  assert.match(out, /SET bidding_open = false/);
});

test('entering auction never opens bidding implicitly', () => {
  const { out } = run('move', 'test-cohort', '--from', 'forming', '--to', 'auction');
  assert.doesNotMatch(out, /SET bidding_open = true/);
  assert.match(out, /never opens bidding on its own/);
});

test('the calendar writes every date column catalog derives stage from', () => {
  const { out, code } = run('calendar', 'test-cohort', '--minutes', '3');
  assert.equal(code, 0);
  for (const col of catalog.DATE_COLUMNS) assert.ok(out.includes(col), `calendar is missing ${col}`);
  /* Catalyst's format, which is neither ISO-8601 nor local time. */
  assert.match(out, /'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'/);
  assert.doesNotMatch(out, /\dT\d/);
});

test('the calendar runs in DATE_COLUMNS order, so the stages cannot invert', () => {
  const { out } = run('calendar', 'test-cohort', '--minutes', '3');
  const at = catalog.DATE_COLUMNS.map((c) => {
    const m = out.match(new RegExp(`${c} = '([^']+)'`));
    assert.ok(m, `${c} not in the UPDATE`);
    return Date.parse(`${m[1].replace(' ', 'T')}Z`);
  });
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i] > at[i - 1], `${catalog.DATE_COLUMNS[i]} is not after its predecessor`);
});

test('the prediction agrees with catalog.js about who may join', () => {
  for (const k of catalog.KINDS) {
    const { out } = run('preview', '--kind', k);
    const joinable = Boolean(catalog.JOIN_STATUS[k]);
    assert.equal(/joinable: yes/.test(out), joinable, `preview disagreed about ${k}`);
  }
});

test('the prediction agrees with catalog.js about the member stage', () => {
  for (const k of catalog.KINDS) {
    const { out } = run('preview', '--kind', k);
    const expected = catalog.memberStageOf({ kind: k, dates: {} });
    assert.match(out, new RegExp(`member stage: ${expected}\\b`), `preview disagreed about ${k}`);
  }
});

test('a bid window is reported open only for an auction with the flag set', () => {
  assert.match(run('preview', '--kind', 'auction', '--bidding-open').out, /bid window: OPEN/);
  assert.match(run('preview', '--kind', 'auction').out, /bid window: closed/);
  /* The flag is inert on any other kind, and publicPartnerCampaign says so too. */
  assert.match(run('preview', '--kind', 'forming', '--bidding-open').out, /bid window: closed/);
});

test('a past bidding_closes_at is called out, because bidding_open does not override it', () => {
  /* The calendar's own close date has passed by the time the run ends, which is
     the one combination that reads as open on inspection and refuses every bid. */
  const { out } = run('calendar', 'test-cohort', '--minutes', '3');
  assert.match(out, /bidding_closes_at has passed/);
  assert.match(out, /dates may close a window, never open one/);
});

test('coverage flattens the composite key the way the write path does', () => {
  const { out } = run('coverage', 'org_7f2a', '--region', 'Chatham-Kent');
  assert.match(out, /'org_7f2a:chatham-kent'/);
  assert.match(out, /INSERT INTO provider_coverage/);
});

test('every surface the tool names is named in both predictions', () => {
  const { out } = run('preview', '--kind', 'forming');
  assert.match(out, /CONSUMER/);
  assert.match(out, /PARTNER/);
  assert.match(out, /provider_coverage/);
});

/* ------------------------------------------------------------------ *
 * step: the hand-driven ladder
 *
 * The claim is narrower than "it prints UPDATEs". Each rung stamps ONE date and
 * leaves every later one NULL, and the reason that matters is that nothing can
 * then expire while an operator works: the only rung whose row draws a bid
 * button is the one that opened the window, and it keeps drawing it until the
 * next rung closes it. If a rung ever emitted a close date early, a test run
 * would refuse the bid it exists to place, and the tool would still look right.
 * ------------------------------------------------------------------ */

test('step --list prints one statement per rung, all against the same id', () => {
  const { out, code } = run('step', 'scarborough-east', '--list');
  assert.equal(code, 0);
  const sql = out.match(/UPDATE campaigns SET [^\n]+;/g) || [];
  assert.equal(sql.length, 9, `expected 9 rungs, got ${sql.length}`);
  for (const st of sql) {
    assert.match(st, /WHERE campaign_id = 'scarborough-east';$/);
    /* campaign_id is immutable: both dashboards and every bid_key are built
       from it, so a rung reschedules a row and never renames one. Checked on
       the SET clause alone, since the WHERE clause names it by design. */
    const setClause = st.slice(st.indexOf('SET '), st.indexOf(' WHERE '));
    assert.doesNotMatch(setClause, /campaign_id/);
    assert.match(st, /updated_at = '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'/);
  }
});

test('step stamps one date per rung and no rung sets a date it does not own', () => {
  const { out } = run('step', 'scarborough-east', '--list');
  const sql = out.match(/UPDATE campaigns SET [^\n]+;/g) || [];
  const seen = [];
  for (const st of sql) {
    const dates = catalog.DATE_COLUMNS.filter((c) => st.includes(`${c} = '`));
    assert.ok(dates.length <= 1, `a rung stamped ${dates.length} dates: ${dates.join(', ')}`);
    seen.push(...dates);
  }
  /* All seven, in DATE_COLUMNS order: the ladder is the calendar, one rung at a
     time, so a missing or reordered date is a rung that cannot be reached. */
  assert.deepEqual(seen, [...catalog.DATE_COLUMNS]);
});

test('only the bidding rung leaves a window a partner can bid into', () => {
  const { out } = run('step', 'scarborough-east', '--list');
  const lines = out.split('\n').filter((l) => l.includes('bid button:'));
  assert.equal(lines.length, 9);
  const yes = lines.filter((l) => /bid button: yes/.test(l));
  assert.equal(yes.length, 1, `${yes.length} rungs claim a bid button`);
  /* And it is rung 3, the one that stamps bidding_opens_at: the desk draws its
     button on stage open or closing and nothing else. */
  assert.match(lines[2], /partner: open\s+bid button: yes/);
  /* The rung that closes bidding must take the button away again. */
  assert.match(lines[3], /bid button: no/);
});

test('step --to prints exactly that rung, and names the next one', () => {
  const { out, code } = run('step', 'scarborough-east', '--to', 'bidding');
  assert.equal(code, 0);
  assert.equal((out.match(/UPDATE campaigns SET/g) || []).length, 1);
  assert.match(out, /bidding_opens_at = '/);
  assert.match(out, /step scarborough-east --to close/);
});

test('step refuses a rung that is not on the ladder', () => {
  assert.equal(run('step', 'scarborough-east', '--to', 'switching').code, 1);
  assert.equal(run('step', 'scarborough-east', '--to').code, 1);
  assert.equal(run('step', 'not_a_slug', '--to', 'bidding').code, 1);
});

/* ------------------------------------------------------------------ *
 * seed
 *
 * The claim being tested is narrower than "it emits SQL": every row it prints
 * has to land on the overview's Auction calendar, which takes one dated event
 * per campaign chosen by the partner stage and keeps only the future ones. A
 * row with the wrong stage, or a date already behind, is a cohort the operator
 * seeded and then cannot see.
 * ------------------------------------------------------------------ */

/* Five ids that title-case back into REAL regions. The set here used to be
   scarborough-east, mississauga-core, north-york-central, etobicoke-south,
   vaughan-west, and three of those five are not names any partner can declare
   coverage under. Seeding them produced cohorts that rendered on both
   dashboards and could never take a bid, which is exactly what happened in the
   live campaigns table. */
const IDS = ['scarborough-east', 'mississauga-city-centre', 'north-york-central',
  'etobicoke-centre', 'vaughan-woodbridge'];

/** Parse the printed INSERTs back into the shape catalog.js consumes. */
function seededRows(out) {
  const rows = [];
  const re = /INSERT INTO campaigns \(([^)]+)\)\n\s*VALUES \(([^;]+)\);/g;
  let m = re.exec(out);
  while (m) {
    const cols = m[1].split(/,\s*/);
    const vals = m[2].split(/,\s*/).map((v) => v.replace(/^'|'$/g, ''));
    const row = {};
    cols.forEach((c, i) => { row[c] = vals[i]; });
    const dates = {};
    for (const c of catalog.DATE_COLUMNS) dates[c] = Date.parse(`${row[c].replace(' ', 'T')}Z`);
    rows.push({
      id: row.campaign_id,
      region: row.region,
      kind: row.kind,
      biddingOpen: row.bidding_open === 'true',
      dates,
    });
    m = re.exec(out);
  }
  return rows;
}

/* The mapping in agendaEvents, partner/views/overview.js. Restated here on
   purpose: if the console's mapping changes and this is not changed with it,
   this test still asserts the dates are future, and the seed tool's own copy
   is what goes stale visibly. */
const CALENDAR_DATE = {
  planned: 'bidding_opens_at', announced: 'bidding_opens_at',
  open: 'bidding_closes_at', closing: 'bidding_closes_at',
  offers_out: 'decision_at',
};

test('seed emits one INSERT per cohort, carrying every column catalog reads', () => {
  const { out, code } = run('seed', ...IDS);
  assert.equal(code, 0);
  const rows = seededRows(out);
  assert.equal(rows.length, IDS.length);
  assert.deepEqual(rows.map((r) => r.id), IDS);
  /* `target` and an unset `sub` are omitted, not written NULL or '': the row
     reads back the same either way, and the console has write access, so the
     statement pasted into it should carry nothing it does not need. Every
     other column the catalog reads has to be there. */
  const omitted = new Set(['target', 'sub', 'updated_by', 'updated_at']);
  for (const col of catalog.COLUMNS) {
    if (omitted.has(col)) continue;
    assert.ok(out.includes(col), `seed INSERT is missing ${col}`);
  }
  assert.doesNotMatch(out, /NULL/, 'seed emitted a NULL, which it omits the column for instead');
  assert.doesNotMatch(out, /''/, "seed emitted an empty literal, which it omits the column for instead");
});

/* The featured cohort on /dashboard is the LOWEST sort_order: catalog.load()
   sorts ascending, ccRank breaks its ties on that order, and featuredCamp()
   takes the first card. So a batch has to be able to sort BELOW the rows
   already in the table, and it must do that without touching them: rewriting
   an existing cohort's sort_order to make room is an UPDATE per row, and the
   one that gets missed is the one that stays featured. */
test('seed counts sort_order up from --sort, so a newer batch can sort below an older one', () => {
  const orders = (out) => out.match(/'auction', 0, 0, (?:true|false), (\d+)/g)
    .map((m) => Number(m.split(', ').pop()));
  assert.deepEqual(orders(run('seed', ...IDS).out), [0, 1, 2, 3, 4]);
  assert.deepEqual(orders(run('seed', ...IDS, '--sort', '100').out), [100, 101, 102, 103, 104]);
  /* And --sort takes a value, so its argument is never read as a campaign_id. */
  assert.equal(seededRows(run('seed', 'scarborough-east', '--sort', '99').out).length, 1);
});

/* --minutes is the test-run schedule, and its whole claim is that the cohort is
   biddable the moment the row lands. Two things have to hold for that, and
   neither is visible in the SQL: bidding_open must be written true, and the
   stage the server derives must be open or closing, because bidAction() in
   partner/views/desk.js draws "Review and bid" on those two stages and nothing
   else. A rail that starts in the future satisfies the first and fails the
   second, which reads to a tester as broken code rather than as a date. */
test('seed --minutes lands a cohort that is biddable now, not announced', () => {
  const { out, code } = run('seed', ...IDS, '--minutes', '5');
  assert.equal(code, 0);
  const rows = seededRows(out);
  assert.equal(rows.length, IDS.length);
  for (const r of rows) {
    assert.equal(r.biddingOpen, true, `${r.id} was written closed`);
    const stage = catalog.publicStage({ ...r, biddingOpen: true }).stage;
    assert.ok(stage === 'open' || stage === 'closing',
      `${r.id} derives stage ${stage}, so the desk would draw no bid button`);
    /* Two dates behind, five ahead, in DATE_COLUMNS order. */
    assert.ok(r.dates.announce_at < Date.now(), 'announce_at is not behind');
    assert.ok(r.dates.bidding_opens_at < Date.now(), 'bidding_opens_at is not behind');
    assert.ok(r.dates.bidding_closes_at > Date.now(), 'bidding_closes_at is not ahead');
    const at = catalog.DATE_COLUMNS.map((c) => r.dates[c]);
    for (let i = 1; i < at.length; i += 1) {
      assert.ok(at[i] > at[i - 1], `${catalog.DATE_COLUMNS[i]} is out of order on ${r.id}`);
    }
  }
});

test('seed --minutes refuses a rail the 60 second memo would swallow', () => {
  assert.equal(run('seed', 'scarborough-east', '--minutes', '1').code, 1);
  assert.equal(run('seed', 'scarborough-east', '--minutes', '0').code, 1);
  assert.equal(run('seed', 'scarborough-east', '--minutes').code, 1);
});

test('seed --minutes refuses the day flags rather than ignoring one', () => {
  for (const f of ['first', 'every', 'hour']) {
    const { code, out } = run('seed', 'scarborough-east', '--minutes', '5', `--${f}`, '3');
    assert.equal(code, 1, `--${f} was accepted alongside --minutes`);
    assert.match(out, /replaces/);
  }
});

test('seed writes sub only when it is given', () => {
  assert.doesNotMatch(run('seed', 'scarborough-east').out, /\bsub\b/);
  const { out } = run('seed', 'scarborough-east', '--sub', 'Winter cohort');
  assert.match(out, /\bsub\b/);
  assert.match(out, /'Winter cohort'/);
});

test('seed says the console takes one statement at a time', () => {
  /* Five INSERTs pasted as a block is a syntax error, and the tool prints five
     of them, so it has to say so where they are. */
  const { out } = run('seed', ...IDS);
  assert.match(out, /ONE statement per submission/);
  assert.match(out, /1 of 5: scarborough-east/);
  assert.match(out, /5 of 5: vaughan-woodbridge/);
});

test('every seeded cohort lands on the calendar, with its event still ahead', () => {
  const { out } = run('seed', ...IDS);
  for (const row of seededRows(out)) {
    const stage = catalog.publicStage(row).stage;
    const col = CALENDAR_DATE[stage];
    assert.ok(col, `${row.id} is ${stage}, which agendaEvents draws no event from`);
    assert.ok(row.dates[col] > Date.now(), `${row.id}: ${col} has already passed`);
  }
});

test('seeded dates run in DATE_COLUMNS order at any --hour', () => {
  for (const hour of ['0', '13', '21', '23']) {
    const { out, code } = run('seed', ...IDS, '--hour', hour);
    assert.equal(code, 0, `--hour ${hour} was refused`);
    for (const row of seededRows(out)) {
      const at = catalog.DATE_COLUMNS.map((c) => row.dates[c]);
      for (let i = 1; i < at.length; i += 1) {
        assert.ok(at[i] > at[i - 1], `${row.id}: ${catalog.DATE_COLUMNS[i]} is not after its predecessor at --hour ${hour}`);
      }
    }
  }
});

test('one cohort closes per --every days, in the order given', () => {
  const { out } = run('seed', ...IDS, '--first', '2', '--every', '3');
  const closes = seededRows(out).map((r) => r.dates.bidding_closes_at);
  for (let i = 1; i < closes.length; i += 1) {
    assert.equal(closes[i] - closes[i - 1], 3 * 86400000, 'closes are not --every days apart');
  }
});

test('a seeded region slugs back to its own id, so coverage can match it', () => {
  const { out } = run('seed', ...IDS);
  for (const row of seededRows(out)) {
    const slug = row.region.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    assert.equal(slug, row.id, 'the derived region does not slug back to the campaign_id');
  }
});

test('bidding_open is set only where the window is genuinely open', () => {
  const { out } = run('seed', ...IDS);
  for (const row of seededRows(out)) {
    const open = Date.now() >= row.dates.bidding_opens_at && Date.now() < row.dates.bidding_closes_at;
    assert.equal(row.biddingOpen, open, `${row.id}: bidding_open disagrees with its own dates`);
  }
});

test('a flag value is never mistaken for a campaign_id', () => {
  const { out, code } = run('seed', 'scarborough-east', '--seed', '87', '--every', '5');
  assert.equal(code, 0);
  assert.equal(seededRows(out).length, 1);
  assert.match(out, /, 87, 87, /);
});

test('seed refuses a repeated id, which ZCQL would take as a second row', () => {
  const { code } = run('seed', 'scarborough-east', 'scarborough-east');
  assert.equal(code, 1);
});

test('seed says what else the rows need before a partner can see them', () => {
  const { out } = run('seed', ...IDS);
  assert.match(out, /provider_coverage row at status=active/);
  assert.match(out, /cohort.mjs verify/);
});

test('--update rewrites the same row instead of creating a second one', () => {
  const { out, code } = run('seed', ...IDS, '--update');
  assert.equal(code, 0);
  assert.doesNotMatch(out, /INSERT INTO/);
  assert.equal((out.match(/UPDATE campaigns SET/g) || []).length, IDS.length);
  for (const id of IDS) {
    assert.match(out, new RegExp(`WHERE campaign_id = '${id}';`), `${id} has no WHERE clause`);
  }
});

test('--update never sets campaign_id, which is the key and is immutable', () => {
  const { out } = run('seed', ...IDS, '--update');
  for (const stmt of out.match(/UPDATE campaigns SET [^;]+;/g)) {
    const set = stmt.slice(0, stmt.indexOf('WHERE'));
    assert.doesNotMatch(set, /campaign_id/, 'campaign_id is in the SET list');
  }
});

test('--update writes the same values the INSERT would have', () => {
  /* The two modes differing would mean a rescheduled cohort is not the cohort
     a fresh one would have been, which is the whole point of the flag. */
  const ins = seededRows(run('seed', ...IDS, '--seed', '40').out);
  const upd = run('seed', ...IDS, '--seed', '40', '--update').out;
  for (const row of ins) {
    for (const col of catalog.DATE_COLUMNS) {
      const m = upd.match(new RegExp(`${col} = '([^']+)'`, 'g'));
      assert.ok(m && m.length === IDS.length, `${col} is not set on every UPDATE`);
    }
    assert.match(upd, new RegExp(`region = '${row.region}'`), `${row.id}: region differs from the INSERT`);
  }
  assert.equal((upd.match(/seed_households = 40/g) || []).length, IDS.length);
});

test('the INSERT path says what a duplicate key means, and that deleting is wrong', () => {
  const { out } = run('seed', ...IDS);
  assert.match(out, /duplicate-key refusal/);
  assert.match(out, /Do NOT delete it/);
  assert.match(out, /--update/);
});
