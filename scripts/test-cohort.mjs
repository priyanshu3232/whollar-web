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
  const { out, code } = run('new', 'kitchener-central', '--region', 'Kitchener', '--sub', 'Autumn cohort');
  assert.equal(code, 0);
  assert.match(out, /INSERT INTO campaigns/);
  /* Not a hand-kept list: every non-date column the catalog selects has to be
     in the statement, or the row reads back with a hole in it. */
  const skip = new Set([...catalog.DATE_COLUMNS, 'updated_by', 'updated_at']);
  for (const col of catalog.COLUMNS) {
    if (skip.has(col)) continue;
    assert.ok(out.includes(col), `INSERT is missing ${col}`);
  }
  assert.match(out, /'kitchener-central', 'Kitchener', 'Autumn cohort', 'forming'/);
});

test('seeds default to zero, because they are added to real joins on both surfaces', () => {
  const { out } = run('new', 'kitchener-central', '--region', 'Kitchener');
  assert.match(out, /'forming', 100, 0, 0, false/);
});

test('an auction is created with a null target, as the code catalog does', () => {
  const { out } = run('new', 'scarborough-east', '--region', 'Scarborough', '--kind', 'auction');
  assert.match(out, /'auction', NULL/);
});

test('a slug that ID_RE would reject is refused, not emitted', () => {
  for (const bad of ['Bad ID', 'no', 'UPPER', 'has_underscore', 'x'.repeat(65)]) {
    const { out, code } = run('new', bad, '--region', 'Kitchener');
    assert.equal(code, 1, `${bad} was accepted`);
    assert.doesNotMatch(out, /INSERT INTO/);
  }
});

test('every kind catalog declares is accepted, and nothing else is', () => {
  for (const k of catalog.KINDS) {
    assert.equal(run('new', 'test-cohort', '--region', 'K', '--kind', k).code, 0, `${k} was refused`);
  }
  for (const k of ['Forming', 'open', 'live', '']) {
    assert.equal(run('new', 'test-cohort', '--region', 'K', '--kind', k).code, 1, `${k} was accepted`);
  }
});

test('a quote in a value is refused rather than escaped', () => {
  /* ZCQL has no parameter binding. Escaping here would be a habit; refusing is
     a typo the operator fixes before pasting into a console with write access. */
  const { out, code } = run('new', 'ok-id', '--region', "O'Brien");
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
