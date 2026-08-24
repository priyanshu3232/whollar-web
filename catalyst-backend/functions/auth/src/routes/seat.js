'use strict';

/**
 * Cohort seats: join, leave, move, pass, and the one truth read.
 *
 * The product rules these routes own, stated once:
 *
 *  R1  One seat per address per vertical. Enforced by the single seat_claim
 *      row per (address, vertical); see lib/seats.js.
 *  R2  Leaving is permitted while the cohort is still forming and joining has
 *      not closed, and under no other condition. No fee, no penalty.
 *  R3  After the roster seals there is nothing to leave. These routes refuse
 *      with SEAL_RACE and the dashboard renders the true protection instead:
 *      the member is not committed to switch.
 *  R4  Passing at the offers stage releases the seat the same day.
 *  R6  A move swaps the one claim row in place, so the address is never
 *      seatless mid-flight. Follow-up bookkeeping that fails triggers a
 *      compensating swap back.
 *  R7  Every mutation re-reads stage and timing here, never trusting the
 *      client. The race between "page open" and "roster sealed" is a 409
 *      SEAL_RACE carrying the state the page should swap to.
 *
 * SEALED IS DERIVED, NOT WRITTEN. There is no scheduler in this stack, and
 * stage is already derived on read everywhere (lib/catalog.js). So a claim is
 * "sealed" when it is active and its cohort's member stage has passed
 * forming: no system write flips claim rows at lock time, and there is no
 * row for a lock-time job to miss. The claim status only changes when the
 * member acts (leave, move, pass) or joins.
 *
 * JOINING CLOSES AT announce_at. That column is already the gate that flips
 * the member stage from forming to locked (catalog.MEMBER_GATES), so it is
 * this feature's join_close_at. No new date column, no second clock to drift.
 *
 * The affordance field is computed here and the dashboard renders whatever it
 * is told, which is what stops an exit link reappearing through a stale
 * bundle.
 */

const catalog = require('../lib/catalog');
const datastore = require('../lib/datastore');
const seats = require('../lib/seats');
const cohorts = require('../lib/cohorts');
const guards = require('../lib/guards');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');
const campaigns = require('./campaigns');
const { ok } = require('../lib/envelope');
const { AppError, wrap, badRequest } = require('../lib/errors');

const requireMember = (req) => guards.requireMember(req, '/cohorts');

const MOVE_MAX = 3;              // moves per address per rolling day
const MOVE_WINDOW_SEC = 86400;
const CLOSING_WINDOW_MS = 48 * 3600 * 1000; // the "closing" chip, presentational

/* ------------------------------------------------------------------ *
 * Shapes and windows
 * ------------------------------------------------------------------ */

/** The cohort as these routes describe it: stage, clock, and the count.
    `count` is a cohorts.seatCount() answer, or null when the caller did not
    fetch one, in which case roster_count is null ("not read"), never a seed. */
function cohortShape(c, now, count) {
  const s = catalog.publicMemberStage(c, now);
  const joinCloseAt = (c.dates && c.dates.announce_at) || null;
  return {
    id: c.id,
    region: c.region,
    sub: c.sub,
    kind: c.kind,
    stage: s.stage,
    stageLabel: s.stageLabel,
    next: s.next,
    dates: c.dates || {},
    join_close_at: joinCloseAt,
    closing: Boolean(joinCloseAt && now < joinCloseAt && (joinCloseAt - now) <= CLOSING_WINDOW_MS),
    target: c.target,
    roster_count: count ? count.seats : null,
  };
}

/** True while a seat in this cohort can still be claimed or given up. */
function joinWindowOpen(c, now) {
  if (!c || c.kind !== 'forming') return false;
  const closeAt = c.dates && c.dates.announce_at;
  return !closeAt || now < closeAt;
}

/** True when the roster cannot take one more household. */
function rosterFull(c, count) {
  if (!c.target) return false;
  return (count ? count.seats : 0) >= c.target;
}

/**
 * What the member can do with this claim right now. The stage map from the
 * product rules, collapsed to the strings the dashboard switches on.
 */
function affordanceFor(claim, cohort, now) {
  if (!claim || claim.status !== 'active' || !cohort) return 'none';
  const stage = catalog.memberStageOf(cohort, now);
  if (stage === 'forming') return joinWindowOpen(cohort, now) ? 'leave' : 'locked';
  if (stage === 'locked' || stage === 'bidding') return 'locked';
  if (stage === 'offers') return 'pass';
  if (stage === 'confirm') return 'cancel';
  if (stage === 'switching') return 'concierge';
  return 'none';
}

/** The SEAL_RACE refusal, built one way for every route that can hit it. */
function sealRace(c, now, count) {
  return new AppError('SEAL_RACE',
    `${c.region} sealed while this page was open. Nothing is owed and you are not committed to switch.`, {
      logDetail: `seat mutation refused: ${c.id} past join window`,
      extra: {
        cohort: cohortShape(c, now, count),
        sealed_at: (c.dates && c.dates.announce_at) || null,
        next_decision_at: (c.dates && c.dates.offers_at) || null,
      },
    });
}

function cohortById(cat, id) {
  const c = cat.byId.get(String(id || '').trim());
  if (!c || c.kind === 'archived') {
    throw badRequest('That cohort does not exist.', {
      logDetail: `unknown cohort id, length ${String(id || '').length}`,
    });
  }
  return c;
}

/** Drop the click-time snapshot row so the dashboard's standing clears. */
async function dropMembershipRow(catalystApp, cohortId, userId) {
  try {
    const existing = await datastore.findBy(
      catalystApp, campaigns.TABLE, 'membership_key', `${cohortId}:${userId}`, ['ROWID']);
    if (existing) await datastore.deleteRow(catalystApp, campaigns.TABLE, existing.ROWID);
  } catch {
    // Snapshot table missing: nothing to drop. The claim row is the truth.
  }
  cohorts.invalidate(cohortId);
}

/** Forming cohorts still open, for "here is what you can join instead". */
function openAlternatives(cat, now, exceptId) {
  return cat.list
    .filter((c) => c.id !== exceptId && joinWindowOpen(c, now))
    .slice(0, 4)
    .map((c) => cohortShape(c, now, null));
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

function mount(router) {
  /**
   * The truth read. { claim, cohort, affordance, rejoin_until }
   * The dashboard renders the affordance it is told, nothing else.
   */
  router.get('/me/seat', wrap(async (req, res) => {
    const user = requireMember(req);
    const vertical = String(req.query.vertical || seats.VERTICAL_DEFAULT);
    const addressId = seats.addressIdFor(user);
    const now = Date.now();

    const row = await seats.getClaim(req.catalyst, addressId, vertical);
    const claim = seats.publicClaim(row);
    let c = null;
    let cohort = null;
    if (claim && claim.cohort_id) {
      const cat = await catalog.load(req.catalyst);
      c = cat.byId.get(claim.cohort_id) || null;
      if (c) cohort = cohortShape(c, now, await cohorts.seatCount(req.catalyst, c.id));
    }
    return ok(res, {
      claim,
      cohort,
      affordance: affordanceFor(claim, c, now),
      rejoin_until: cohort ? cohort.join_close_at : null,
    });
  }));

  /**
   * Claim a seat. 200 { claim, cohort } or the specific 409 the situation
   * deserves: SEAT_HELD with the held cohort so any surface, including a
   * deep link from email, can render the conflict without a dashboard modal.
   */
  router.post('/cohorts/:id/join', wrap(async (req, res) => {
    const user = requireMember(req);
    const cat = await catalog.load(req.catalyst);
    const target = cohortById(cat, req.params.id);
    const vertical = seats.VERTICAL_DEFAULT;
    const addressId = seats.addressIdFor(user);
    const now = Date.now();
    const requestId = seats.cleanRequestId(req.get('Idempotency-Key'));

    if (!joinWindowOpen(target, now)) {
      throw new AppError('JOIN_CLOSED', 'Joining has closed on this cohort.', {
        logDetail: `join refused: ${target.id} kind=${target.kind} window shut`,
        extra: { cohort: cohortShape(target, now, null) },
      });
    }

    const existingRow = await seats.getClaim(req.catalyst, addressId, vertical);
    const existing = seats.publicClaim(existingRow);

    if (existing && existing.status === 'active') {
      if (existing.cohort_id === target.id) {
        const counter = await cohorts.seatCount(req.catalyst, target.id);
        return ok(res, { claim: existing, cohort: cohortShape(target, now, counter), already: true });
      }
      const held = cat.byId.get(existing.cohort_id);
      const canMove = held ? joinWindowOpen(held, now) : false;
      audit.recordAsync(req.catalyst, req, {
        type: 'seat.move.blocked', outcome: 'success', userId: user.user_id,
        email: user.email_normalized,
        detail: { from_cohort: existing.cohort_id, to_cohort: target.id, movable: canMove },
      });
      throw new AppError('SEAT_HELD',
        held ? `You are already in ${held.region}.` : 'This address already holds a cohort seat.', {
          logDetail: `join refused: ${addressId} holds ${existing.cohort_id}`,
          extra: {
            held_cohort: held ? cohortShape(held, now, await cohorts.seatCount(req.catalyst, held.id)) : null,
            can_move: canMove,
          },
        });
    }

    const counter = await cohorts.seatCount(req.catalyst, target.id);
    if (rosterFull(target, counter)) {
      throw new AppError('ROSTER_FULL', `${target.region} is full for this round.`, {
        logDetail: `join refused: ${target.id} at target`,
        extra: { cohort: cohortShape(target, now, counter), waitlist_position: null },
      });
    }

    const rejoin = Boolean(existing && existingRow.cohort_id === target.id);
    const { claim } = await seats.transition(req.catalyst, {
      user, addressId, vertical,
      action: rejoin ? 'rejoin' : 'join',
      fromCohortId: null, toCohortId: target.id,
      reason: null, requestId,
    });

    await campaigns.upsert(req.catalyst, target, user, 'joined');
    await seats.recount(req.catalyst, target.id);

    audit.recordAsync(req.catalyst, req, {
      type: rejoin ? 'seat.rejoin' : 'seat.join', outcome: 'success',
      userId: user.user_id, email: user.email_normalized,
      detail: { cohort: target.id, source: String((req.body || {}).source || 'direct') },
    });

    const after = await cohorts.seatCount(req.catalyst, target.id);
    return ok(res, { claim, cohort: cohortShape(target, now, after) });
  }));

  /**
   * Give the seat back. Permitted while forming and open, refused with
   * SEAL_RACE after, exactly R2. 200 { claim, cohort, rejoin_until }.
   */
  router.post('/cohorts/:id/leave', wrap(async (req, res) => {
    const user = requireMember(req);
    const cat = await catalog.load(req.catalyst);
    const cohort = cohortById(cat, req.params.id);
    const vertical = seats.VERTICAL_DEFAULT;
    const addressId = seats.addressIdFor(user);
    const now = Date.now();
    const requestId = seats.cleanRequestId(req.get('Idempotency-Key'));

    const row = await seats.getClaim(req.catalyst, addressId, vertical);
    const claim = seats.publicClaim(row);
    if (!claim || claim.status !== 'active' || claim.cohort_id !== cohort.id) {
      /* Idempotent: leaving a seat you do not hold succeeds with the truth. */
      const counter = await cohorts.seatCount(req.catalyst, cohort.id);
      return ok(res, {
        claim, cohort: cohortShape(cohort, now, counter),
        rejoin_until: (cohort.dates && cohort.dates.announce_at) || null,
      });
    }

    if (!joinWindowOpen(cohort, now)) {
      audit.recordAsync(req.catalyst, req, {
        type: 'seat.sealrace', outcome: 'failure', userId: user.user_id,
        email: user.email_normalized, detail: { route: 'leave', cohort: cohort.id },
      });
      throw sealRace(cohort, now, await cohorts.seatCount(req.catalyst, cohort.id));
    }

    const { claim: fresh } = await seats.transition(req.catalyst, {
      user, addressId, vertical,
      action: 'leave', fromCohortId: cohort.id, toCohortId: null,
      reason: (req.body || {}).reason, requestId,
    });

    await dropMembershipRow(req.catalyst, cohort.id, user.user_id);
    await seats.recount(req.catalyst, cohort.id);
    await seats.applyHysteresis(req.catalyst, cohort.id);

    audit.recordAsync(req.catalyst, req, {
      type: 'seat.leave', outcome: 'success', userId: user.user_id,
      email: user.email_normalized,
      detail: { cohort: cohort.id, reason: seats.cleanReason((req.body || {}).reason) },
    });

    const counter = await cohorts.seatCount(req.catalyst, cohort.id);
    return ok(res, {
      claim: fresh,
      cohort: cohortShape(cohort, now, counter),
      rejoin_until: (cohort.dates && cohort.dates.announce_at) || null,
    });
  }));

  /**
   * Move: leave A and join B as one swap on the one claim row. The address
   * is never seatless; a failed follow-up write swaps back. R6.
   */
  router.post('/cohorts/:id/move', wrap(async (req, res) => {
    const user = requireMember(req);
    const cat = await catalog.load(req.catalyst);
    const to = cohortById(cat, req.params.id);
    const from = cohortById(cat, (req.body || {}).from_cohort_id);
    const vertical = seats.VERTICAL_DEFAULT;
    const addressId = seats.addressIdFor(user);
    const now = Date.now();
    const requestId = seats.cleanRequestId(req.get('Idempotency-Key'));

    /* Roster stability, not punishment: three moves a day per address. */
    if (!await ratelimit.withinLimitFor(req.catalyst, req, addressId,
      { key: 'seat.move', max: MOVE_MAX, windowSec: MOVE_WINDOW_SEC })) {
      throw new AppError('RATE_LIMITED',
        `That is three moves today. Your seat stays in ${from.region} and you can move again tomorrow.`, {
          logDetail: `seat.move rate limit for ${addressId}`,
          headers: { 'Retry-After': String(MOVE_WINDOW_SEC) },
        });
    }

    const row = await seats.getClaim(req.catalyst, addressId, vertical);
    const claim = seats.publicClaim(row);
    if (!claim || claim.status !== 'active' || claim.cohort_id !== from.id) {
      throw badRequest('Your seat is not where this page thought it was. Reload and try again.', {
        logDetail: `move refused: claim holds ${claim && claim.cohort_id}, body said ${from.id}`,
      });
    }
    if (!joinWindowOpen(from, now)) {
      audit.recordAsync(req.catalyst, req, {
        type: 'seat.sealrace', outcome: 'failure', userId: user.user_id,
        email: user.email_normalized, detail: { route: 'move', cohort: from.id },
      });
      throw sealRace(from, now, await cohorts.seatCount(req.catalyst, from.id));
    }
    if (!joinWindowOpen(to, now)) {
      throw new AppError('JOIN_CLOSED', `Joining has closed on ${to.region}.`, {
        logDetail: `move refused: target ${to.id} window shut`,
        extra: { cohort: cohortShape(to, now, null) },
      });
    }
    const toCounter = await cohorts.seatCount(req.catalyst, to.id);
    if (rosterFull(to, toCounter)) {
      throw new AppError('ROSTER_FULL', `${to.region} is full for this round.`, {
        logDetail: `move refused: target ${to.id} at target`,
        extra: { cohort: cohortShape(to, now, toCounter), waitlist_position: null },
      });
    }

    const { claim: fresh } = await seats.transition(req.catalyst, {
      user, addressId, vertical,
      action: 'move', fromCohortId: from.id, toCohortId: to.id,
      reason: (req.body || {}).reason, requestId,
    });

    /* Follow-up bookkeeping. If any of it throws, put the seat back. */
    try {
      await dropMembershipRow(req.catalyst, from.id, user.user_id);
      await campaigns.upsert(req.catalyst, to, user, 'joined');
      await seats.recount(req.catalyst, from.id);
      await seats.recount(req.catalyst, to.id);
      await seats.applyHysteresis(req.catalyst, from.id);
    } catch (err) {
      await seats.compensate(req.catalyst, {
        user, addressId, vertical, fromCohortId: from.id, toCohortId: to.id, requestId,
      });
      /* The compensation swaps the CLAIM back; the snapshot row dropped at
         the top of the try has to come back too, or the member holds a seat
         in a cohort whose ledger says they left (INV-3: both campaigns'
         ledgers must land consistent, win or lose). Best effort like
         compensate itself: the claim row is the truth either way. */
      try {
        await campaigns.upsert(req.catalyst, from, user, 'joined');
        await seats.recount(req.catalyst, from.id);
        await seats.recount(req.catalyst, to.id);
      } catch (restoreErr) {
        console.error(JSON.stringify({
          at: 'seat.move.restore', from: from.id, to: to.id,
          error: String((restoreErr && restoreErr.message) || restoreErr).slice(0, 200),
        }));
      }
      throw new AppError('SERVER_ERROR',
        `The move did not complete and your seat stays in ${from.region}. Reference: ${req.id}`, {
          logDetail: `move bookkeeping failed, compensated: ${String((err && err.message) || err).slice(0, 200)}`,
        });
    }

    audit.recordAsync(req.catalyst, req, {
      type: 'seat.move', outcome: 'success', userId: user.user_id,
      email: user.email_normalized,
      detail: {
        from_cohort: from.id, to_cohort: to.id,
        path: String((req.body || {}).path) === 'two_step' ? 'two_step' : 'one_step',
        reason: seats.cleanReason((req.body || {}).reason),
      },
    });

    return ok(res, {
      claim: fresh,
      from_cohort: cohortShape(from, now, await cohorts.seatCount(req.catalyst, from.id)),
      to_cohort: cohortShape(to, now, await cohorts.seatCount(req.catalyst, to.id)),
    });
  }));

  /**
   * Pass on the round. The honest exit at the offers stage: releases the
   * claim the same day and says what is still forming. R4.
   */
  router.post('/cohorts/:id/pass', wrap(async (req, res) => {
    const user = requireMember(req);
    const cat = await catalog.load(req.catalyst);
    const cohort = cohortById(cat, req.params.id);
    const vertical = seats.VERTICAL_DEFAULT;
    const addressId = seats.addressIdFor(user);
    const now = Date.now();
    const requestId = seats.cleanRequestId(req.get('Idempotency-Key'));

    const row = await seats.getClaim(req.catalyst, addressId, vertical);
    const claim = seats.publicClaim(row);
    if (!claim || claim.status !== 'active' || claim.cohort_id !== cohort.id) {
      return ok(res, {
        claim, cohort: cohortShape(cohort, now, null),
        open_alternatives: openAlternatives(cat, now, cohort.id),
      });
    }
    const stage = catalog.memberStageOf(cohort, now);
    if (stage !== 'offers') {
      throw new AppError('CONFLICT', 'There is no offer on the table to pass on yet.', {
        logDetail: `pass refused: ${cohort.id} stage=${stage}`,
      });
    }

    const { claim: fresh } = await seats.transition(req.catalyst, {
      user, addressId, vertical,
      action: 'pass', fromCohortId: cohort.id, toCohortId: null,
      reason: (req.body || {}).reason, requestId,
    });

    await dropMembershipRow(req.catalyst, cohort.id, user.user_id);
    await seats.recount(req.catalyst, cohort.id);

    audit.recordAsync(req.catalyst, req, {
      type: 'seat.pass', outcome: 'success', userId: user.user_id,
      email: user.email_normalized,
      detail: { cohort: cohort.id, reason: seats.cleanReason((req.body || {}).reason) },
    });

    return ok(res, {
      claim: fresh,
      cohort: cohortShape(cohort, now, await cohorts.seatCount(req.catalyst, cohort.id)),
      open_alternatives: openAlternatives(cat, now, cohort.id),
    });
  }));
}

module.exports = { mount, affordanceFor, joinWindowOpen, cohortShape };
