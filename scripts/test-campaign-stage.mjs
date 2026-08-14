#!/usr/bin/env node
/* Unit tests for the derived campaign stage.
 *
 *   node --test scripts/test-campaign-stage.mjs
 *
 * Wired into CI, and cheap to keep there, because catalog.stageOf() is a pure
 * function of (campaign, now): no database, no clock, no network. That purity
 * is the reason stage is derived on read instead of written by a scheduler,
 * so it is worth a test that proves it.
 *
 * Same idiom as scripts/test-select-band.mjs, which loads a browser module in
 * Node. This one loads a CommonJS backend module, so it uses createRequire.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { backend } from './backend-module.mjs';

const catalog = backend('lib/catalog.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T = 1_800_000_000_000;   // a fixed "now"; nothing here reads the clock

/** A campaign with an auction calendar, offsets in ms from T. */
const auction = (dates = {}, over = {}) => ({
  id: 'kw', region: 'Scarborough', kind: 'auction', biddingOpen: true,
  dates: Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, v === null ? null : T + v])),
  ...over,
});

const FULL = {
  announce_at: -21 * DAY,
  bidding_opens_at: -14 * DAY,
  bidding_closes_at: 2 * DAY,
  offers_at: 4 * DAY,
  decision_at: 9 * DAY,
  switch_window_at: 23 * DAY,
  reconcile_at: 37 * DAY,
};

test('walks the calendar in order', () => {
  const c = auction(FULL);
  assert.equal(catalog.stageOf(c, T - 30 * DAY), 'planned', 'before the announcement');
  assert.equal(catalog.stageOf(c, T - 20 * DAY), 'announced', 'announced, bidding not open');
  assert.equal(catalog.stageOf(c, T - 10 * DAY), 'open', 'bidding open, close distant');
  assert.equal(catalog.stageOf(c, T + 1 * DAY + 12 * HOUR), 'closing', 'inside the last 24h');
  assert.equal(catalog.stageOf(c, T + 3 * DAY), 'offers_out', 'bids closed');
  assert.equal(catalog.stageOf(c, T + 10 * DAY), 'decided', 'past the decision');
});

test('the closing window is exactly 24 hours, and is a boundary not a guess', () => {
  const c = auction(FULL);
  const close = T + 2 * DAY;
  assert.equal(catalog.stageOf(c, close - 24 * HOUR - MIN), 'open', 'a minute before the window');
  assert.equal(catalog.stageOf(c, close - 24 * HOUR), 'closing', 'exactly 24h out');
  assert.equal(catalog.stageOf(c, close - 1), 'closing', 'a millisecond before close');
  assert.equal(catalog.stageOf(c, close), 'offers_out', 'exactly at close, the window is shut');
  assert.equal(catalog.CLOSING_WINDOW_MS, 24 * HOUR);
});

test('closing requires bidding to have opened', () => {
  /* A cohort announced with a close date inside 24h but no open date yet must
     not claim to be closing: there is nothing to close. */
  const c = auction({ announce_at: -2 * DAY, bidding_opens_at: 6 * HOUR, bidding_closes_at: 12 * HOUR });
  assert.equal(catalog.stageOf(c, T), 'announced');
  assert.equal(catalog.stageOf(c, T + 7 * HOUR), 'closing', 'once it opens, inside 24h, it is closing');
});

test('an admin decision outranks the calendar, in both directions', () => {
  /* Closed early: the calendar still says bidding is open, the decision wins. */
  const closed = auction(FULL, { kind: 'closed' });
  assert.equal(catalog.stageOf(closed, T - 10 * DAY), 'decided');

  /* Not an auction: dates in the past do not make it one. */
  const forming = auction(FULL, { kind: 'forming' });
  assert.equal(catalog.stageOf(forming, T - 10 * DAY), 'announced', 'past its announce date');
  assert.equal(catalog.stageOf(forming, T - 30 * DAY), 'planned', 'before it');

  const archived = auction(FULL, { kind: 'archived' });
  assert.equal(catalog.stageOf(archived, T), 'decided');
});

test('a campaign with no calendar behaves exactly as it did before dates existed', () => {
  /* This is the whole code-fallback path and the state of every row today. */
  const open = { id: 'x', kind: 'auction', biddingOpen: true, dates: {} };
  const shut = { id: 'y', kind: 'auction', biddingOpen: false, dates: {} };
  assert.equal(catalog.stageOf(open, T), 'open');
  assert.equal(catalog.stageOf(shut, T), 'announced');

  /* And with no `dates` key at all, which is what the code catalog looked like
     before this commit. Must not throw. */
  assert.equal(catalog.stageOf({ id: 'z', kind: 'auction', biddingOpen: true }, T), 'open');
  assert.doesNotThrow(() => catalog.stageOf(undefined, T));
});

test('a partial calendar degrades rather than lying', () => {
  const onlyClose = auction({ bidding_closes_at: 3 * DAY });
  assert.equal(catalog.stageOf(onlyClose, T), 'open', 'no open date, but bidding_open is true');
  assert.equal(catalog.stageOf(onlyClose, T + 4 * DAY), 'offers_out');

  const onlyAnnounce = auction({ announce_at: -1 * DAY });
  assert.equal(catalog.stageOf(onlyAnnounce, T), 'announced');
});

test('nextTransition finds the next moment a partner is waiting on', () => {
  const c = auction(FULL);
  assert.equal(catalog.nextTransition(c, T).what, 'bidding_closes_at');
  assert.equal(catalog.nextTransition(c, T).at, T + 2 * DAY);
  assert.equal(catalog.nextTransition(c, T + 3 * DAY).what, 'offers_at');
  assert.equal(catalog.nextTransition(c, T + 100 * DAY), null, 'nothing left');
});

test('publicStage is what a route sends, and every stage has a label', () => {
  const p = catalog.publicStage(auction(FULL), T - 10 * DAY);
  assert.equal(p.stage, 'open');
  assert.equal(p.stageLabel, 'Open');
  assert.equal(p.next.what, 'bidding_closes_at');

  for (const s of catalog.STAGES) {
    assert.ok(catalog.STAGE_LABEL[s], `stage ${s} has no label`);
  }
});

test('stage is pure: same inputs, same answer, and no clock of its own', () => {
  const c = auction(FULL);
  assert.equal(catalog.stageOf(c, T), catalog.stageOf(c, T));
  /* Called with no `now`, it uses Date.now(). Everything else must not. */
  assert.doesNotThrow(() => catalog.stageOf(c));
});

test('the six stages are the ones the console knows about', () => {
  /* Mirrors C.STAGE in js/whollar-console-contract.js. There is no shared code
     across the Vercel and Catalyst boundary, so this is the seam where the two
     lists can silently diverge. */
  assert.deepEqual(
    [...catalog.STAGES],
    ['planned', 'announced', 'open', 'closing', 'offers_out', 'decided']
  );
});
