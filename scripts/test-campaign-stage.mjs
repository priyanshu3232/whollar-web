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

/* ------------------------------------------------------------------ *
 * The member's stage
 *
 * Same seven date columns, a different seven steps, because a household is
 * still confirming and switching long after a partner is done. These pin the
 * mapping the dashboard rail renders, which used to be guessed from `kind`
 * in the browser.
 * ------------------------------------------------------------------ */

test('member stage walks the calendar in order', () => {
  const c = auction(FULL);
  assert.equal(catalog.memberStageOf(c, T - 30 * DAY), 'forming', 'joining still open');
  assert.equal(catalog.memberStageOf(c, T - 20 * DAY), 'locked', 'announced, bidding not open');
  assert.equal(catalog.memberStageOf(c, T - 10 * DAY), 'bidding', 'bidding open');
  assert.equal(catalog.memberStageOf(c, T + 3 * DAY), 'bidding', 'closed, offer not out yet');
  assert.equal(catalog.memberStageOf(c, T + 5 * DAY), 'offers', 'offer with the household');
  assert.equal(catalog.memberStageOf(c, T + 10 * DAY), 'confirm', 'confirmations locked');
  assert.equal(catalog.memberStageOf(c, T + 25 * DAY), 'switching', 'install window');
  assert.equal(catalog.memberStageOf(c, T + 40 * DAY), 'done', 'reconciled');
});

test('member stage boundaries are inclusive at the date itself', () => {
  const c = auction(FULL);
  assert.equal(catalog.memberStageOf(c, T + 4 * DAY - 1), 'bidding', 'a ms before offers_at');
  assert.equal(catalog.memberStageOf(c, T + 4 * DAY), 'offers', 'exactly at offers_at');
  assert.equal(catalog.memberStageOf(c, T + 9 * DAY), 'confirm', 'exactly at decision_at');
  assert.equal(catalog.memberStageOf(c, T + 37 * DAY), 'done', 'exactly at reconcile_at');
});

test('member stage: a two minute calendar advances every step', () => {
  /* The shape used to prove the pipeline end to end on a live dashboard:
     seven columns two minutes apart. Every step must be reachable, or the
     rail would skip one on a real cohort too. */
  const MIN2 = 2 * MIN;
  const c = auction({
    announce_at: MIN2, bidding_opens_at: 2 * MIN2, bidding_closes_at: 3 * MIN2,
    offers_at: 4 * MIN2, decision_at: 5 * MIN2, switch_window_at: 6 * MIN2,
    reconcile_at: 7 * MIN2,
  });
  const seen = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => catalog.memberStageOf(c, T + i * MIN2 + 1000));
  assert.deepEqual(seen,
    ['forming', 'locked', 'bidding', 'bidding', 'offers', 'confirm', 'switching', 'done']);
});

test('member stage without a calendar falls back to kind, never to a guess', () => {
  assert.equal(catalog.memberStageOf({ kind: 'forming', dates: {} }, T), 'forming');
  assert.equal(catalog.memberStageOf({ kind: 'planned', dates: {} }, T), 'forming');
  /* An undated auction reads its own window flag, and BOTH stage functions
     read it the same way. The pair below is the real assertion: this case used
     to answer 'bidding' unconditionally, so a cohort whose window had never
     been opened told the household sealed bidding was under way while the
     partner desk filed the very same row under Coming cohorts. */
  assert.equal(catalog.memberStageOf({ kind: 'auction', biddingOpen: true, dates: {} }, T), 'bidding');
  assert.equal(catalog.stageOf({ kind: 'auction', biddingOpen: true, dates: {} }, T), 'open');
  assert.equal(catalog.memberStageOf({ kind: 'auction', biddingOpen: false, dates: {} }, T), 'locked',
    'joining has shut and bidding has not started: neither surface may say bidding');
  assert.equal(catalog.stageOf({ kind: 'auction', biddingOpen: false, dates: {} }, T), 'announced');
  assert.equal(catalog.memberStageOf({ kind: 'closed', dates: FULL }, T), 'done',
    'an admin close outranks the calendar');
  assert.equal(catalog.memberStageOf({ kind: 'archived', dates: {} }, T), 'done');
});

test('member stage is pure and every stage carries a label', () => {
  const c = auction(FULL);
  assert.equal(catalog.memberStageOf(c, T), catalog.memberStageOf(c, T));
  assert.doesNotThrow(() => catalog.memberStageOf(c));
  for (const s of catalog.MEMBER_STAGES) {
    assert.ok(catalog.MEMBER_STAGE_LABEL[s], `member stage ${s} has no label`);
  }
});

test('the seven member stages are the ones the dashboard rail renders', () => {
  /* Mirrors STATES in dashboard.html. Same seam as the console list above:
     no shared code across the Vercel/Catalyst boundary. */
  assert.deepEqual(
    [...catalog.MEMBER_STAGES],
    ['forming', 'locked', 'bidding', 'offers', 'confirm', 'switching', 'done']
  );
});

/* ------------------------------------------------------------------ *
 * standingOf: the membership row, read as what it means now
 * ------------------------------------------------------------------ */

test('a waitlist place becomes a join the moment the region stops gathering', () => {
  /* The bug this exists for: campaign_members.status is a snapshot of
     JOIN_STATUS at click time, and nothing rewrites it when a cohort moves.
     A household that joined a `planned` region stayed `waitlist` through
     forming, auction and close, and the dashboard reads `waitlist` as a
     visitor state, so it never saw a rail at all. */
  const kindOf = (kind) => catalog.standingOf('waitlist', { kind });
  assert.equal(kindOf('planned'), 'waitlist', 'still gathering');
  assert.equal(kindOf('waitlist'), 'waitlist', 'still gathering');
  assert.equal(kindOf('forming'), 'joined');
  assert.equal(kindOf('auction'), 'joined');
  assert.equal(kindOf('closed'), 'joined');
  assert.equal(kindOf('archived'), 'joined');
});

test('standingOf promotes nothing but a waitlist place', () => {
  for (const kind of catalog.KINDS) {
    assert.equal(catalog.standingOf('joined', { kind }), 'joined');
    /* A bell is not a join and is never promoted into one. */
    assert.equal(catalog.standingOf('alert', { kind }), 'alert',
      `a bell was promoted on a ${kind} cohort`);
  }
});

test('standingOf answers null for no membership, and never undefined', () => {
  /* publicCampaign sends this straight onto the wire as `you`, where the
     dashboard tests it against three strings. undefined would drop the key
     from the JSON and applyCampaign would leave a stale value in place. */
  for (const v of [null, undefined, '']) {
    assert.equal(catalog.standingOf(v, { kind: 'forming' }), null);
  }
  assert.equal(catalog.standingOf('waitlist', undefined), 'joined',
    'no campaign is not a gathering campaign');
});

test('standingOf is pure, and GATHERING is the kinds that take a list', () => {
  const c = { kind: 'auction' };
  assert.equal(catalog.standingOf('waitlist', c), catalog.standingOf('waitlist', c));
  assert.deepEqual([...catalog.GATHERING], ['planned', 'waitlist']);
  /* Every gathering kind must be one JOIN_STATUS writes `waitlist` for, or a
     join would land as `joined` and then be demoted on the next read. */
  for (const k of catalog.GATHERING) {
    assert.equal(catalog.JOIN_STATUS[k], 'waitlist', `${k} gathers but does not list`);
  }
});
