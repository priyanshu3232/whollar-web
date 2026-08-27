'use strict';

/**
 * Seat claims: one cohort seat per address per vertical.
 *
 * THE ENFORCEMENT POINT IS ONE ROW. `seat_claim` holds exactly one row per
 * (address_id, vertical), created on the first join and reused forever. The
 * row either points at a cohort (`status='active'`) or it does not
 * (`status='released'`). A move swaps `cohort_id` in place on that one row,
 * so an address is never seatless mid-flight and can never hold two seats:
 * there is no second row to hold one in.
 *
 * WHY THE RACE GUARD IS AN INSERT, NOT A GUARDED UPDATE. The brief for this
 * feature specifies version-guarded UPDATE ... WHERE version = :v with a
 * rowcount assertion. Catalyst's Data Store has no conditional update: writes
 * go through the object API and land unconditionally. The codebase's canonical
 * race guard is a unique-key INSERT (lib/bids.js sealRevision, lib/awards.js
 * seal), and that is what this module uses: every transition first inserts a
 * `claim_event` row whose unique `event_key` is `${claim_key}:${version+1}`.
 * Two writers racing the same claim both read version N and both try to insert
 * event N+1; the unique constraint lets exactly one in. The loser re-reads and
 * reports the conflict. The winner then writes the claim row, which is safe
 * because it owns version N+1 outright. The event log doubles as the audit
 * trail the brief wanted from a separate membership-history table: append
 * only, one row per transition, carrying from/to, action, reason and actor.
 *
 * WHY THERE IS NO `cohort_membership` TABLE. Current membership is the claim
 * row; history is the event log; the click-time snapshot the dashboard already
 * renders from is `campaign_members`. A fourth copy of the same fact is a
 * fourth thing that can disagree with the other three. Same reasoning as the
 * share feature's decision not to add an attribution_edge table.
 *
 * ADDRESSES. Nothing in this codebase has an address identity yet: the member
 * record carries a postal/FSA and nothing else. The uniqueness key the product
 * rule wants is (address_id, vertical), keyed on address rather than member so
 * a genuinely moving household can hold two. Until an address table exists,
 * every member has exactly one address slot and its id is derived:
 * `${user_id}/1`. When real addresses land, new slots get new ids and every
 * row here keys correctly without a rewrite. The slash is deliberate: it is in
 * datastore's SAFE_LITERAL set and cannot collide with a raw user_id.
 *
 * COUNTERS. `cohort_counter.roster_count` is recomputed on every transition by
 * counting active claims for the cohort. It is a SIDECAR for the publish
 * hysteresis flags on the same row: NO read path renders it. Every count a
 * dashboard shows comes from lib/cohorts.js seatCount(), a COUNT at read
 * time over this ledger and the click-time snapshot together, so a counter
 * that drifted (a hand-edited row, a failed sidecar write) can never reach a
 * member or a partner. /admin/campaigns/reconcile reports the drift instead.
 *
 * FAILS CLOSED. If `seat_claim` or `claim_event` cannot be written, no seat
 * moves. Same contract as the terms gate: a feature that silently no-ops on a
 * missing table is a feature that lies.
 */

const datastore = require('./datastore');
const cohorts = require('./cohorts');
const { AppError } = require('./errors');

const CLAIM_TABLE = 'seat_claim';
const EVENT_TABLE = 'claim_event';
const COUNTER_TABLE = 'cohort_counter';

const VERTICAL_DEFAULT = 'internet';

const ACTIONS = Object.freeze(['join', 'leave', 'move', 'rejoin', 'pass', 'cancel', 'seal', 'admin_move']);

/** The five reasons the exit sheet offers. Anything else is stored as null. */
const REASONS = Object.freeze(['timing', 'retention_offer', 'moving', 'other_cohort', 'changed_mind']);

const CLAIM_COLUMNS = ['ROWID', 'claim_key', 'address_id', 'vertical', 'member_id',
  'cohort_id', 'status', 'version', 'claimed_at', 'released_at'];

/** The one address slot a member has until an address table exists. */
function addressIdFor(user) {
  return `${user.user_id}/1`;
}

function claimKeyFor(addressId, vertical) {
  return `${addressId}:${vertical || VERTICAL_DEFAULT}`;
}

function cleanReason(reason) {
  return REASONS.includes(reason) ? reason : null;
}

/** Row -> wire shape. Versions and dates as numbers, never DB strings. */
function publicClaim(row) {
  if (!row) return null;
  const claimed = datastore.fromDb(row.claimed_at);
  const released = datastore.fromDb(row.released_at);
  return {
    address_id: row.address_id,
    vertical: row.vertical,
    cohort_id: row.status === 'active' ? (row.cohort_id || null) : null,
    status: row.status,
    version: Number(row.version) || 0,
    claimed_at: claimed ? claimed.getTime() : null,
    released_at: released ? released.getTime() : null,
  };
}

/**
 * The claim row for an address, or null when it has never joined anything.
 * A missing table throws: this module fails closed, see the header.
 */
async function getClaim(catalystApp, addressId, vertical) {
  const key = claimKeyFor(addressId, vertical);
  try {
    return await datastore.findBy(catalystApp, CLAIM_TABLE, 'claim_key', key, CLAIM_COLUMNS);
  } catch (err) {
    throw new AppError('SERVER_ERROR',
      'Cohort seats are not available right now. Please try again shortly.', {
        logDetail: `seat_claim read failed (table missing?): ${String((err && err.message) || err).slice(0, 200)}`,
      });
  }
}

/**
 * Idempotency by request id: if this exact request already produced an event
 * on this claim, the transition already happened. The caller returns current
 * state instead of writing twice. Header-supplied, so length-capped and
 * charset-checked before it is ever used in a where clause.
 */
function cleanRequestId(raw) {
  const v = String(raw || '').trim();
  return /^[A-Za-z0-9._:-]{8,120}$/.test(v) ? v : null;
}

async function findEventByRequestId(catalystApp, claimKey, requestId) {
  if (!requestId) return null;
  try {
    const rows = await datastore.query(catalystApp, EVENT_TABLE,
      `SELECT ROWID, event_key, action FROM ${datastore.ident(EVENT_TABLE)}
        WHERE claim_key = ${datastore.lit(claimKey)}
          AND request_id = ${datastore.lit(requestId)} LIMIT 1`);
    return rows[0] || null;
  } catch {
    return null; // No event table yet: the insert below will say so loudly.
  }
}

/**
 * The highest version this claim key has ever reached, read from the event
 * table's own keys.
 *
 * WHY THIS EXISTS. `version` is normally read off the claim row, and the
 * claim row is a projection of this table: delete it and the counter restarts
 * at 0 while every `<claim_key>:<n>` it ever wrote is still here, append only
 * and unique. The next join then computes `:1`, collides with the `:1` from
 * months ago, and the catch below reports "Cohort seats are not available
 * right now. Please try again shortly." to a member for whom shortly will
 * never arrive. That is not hypothetical: it is what a campaigns reset did on
 * 2026-08-27, once for every account that had ever held a seat.
 *
 * There is no `version` column to take a MAX of, by design (see
 * create-tables.md 26b): the version IS the event_key suffix, because the
 * unique constraint on that key is the serialization point. So the suffixes
 * are what this reads.
 *
 * CONSULTED ONLY WHEN THE CLAIM ROW IS MISSING, and that restriction is the
 * whole safety argument. Reading it on every transition would let a writer
 * see an event a concurrent writer had inserted but not yet projected onto
 * the claim, jump the sequence past it, and insert a key nobody was
 * contending for: both writers would succeed and the loser would overwrite
 * the winner's claim. With a claim row present the old strict behaviour is
 * unchanged, and two writers still meet on the same key. With no claim row
 * they both read the same maximum here and still meet on the same key. The
 * unique constraint decides in both cases.
 *
 * Returns 0 when the table cannot be read, which restores the previous
 * behaviour exactly: the insert below is what fails loudly, not this.
 */
async function highestEventVersion(catalystApp, claimKey) {
  try {
    const rows = await datastore.queryAll(
      catalystApp, EVENT_TABLE, ['event_key'],
      `claim_key = ${datastore.lit(claimKey)}`
    );
    const prefix = `${claimKey}:`;
    let top = 0;
    for (const r of rows) {
      const k = String((r && r.event_key) || '');
      if (!k.startsWith(prefix)) continue;
      const n = Number(k.slice(prefix.length));
      if (Number.isInteger(n) && n > top) top = n;
    }
    return top;
  } catch {
    return 0;
  }
}

/**
 * One transition, serialized by the event insert.
 *
 * Returns the fresh claim wire shape. Throws AppError('CONFLICT') with
 * `.seatConflict = currentClaimRow` when another writer got there first, so
 * the route can translate it into the specific 409 the situation deserves.
 */
async function transition(catalystApp, {
  user, addressId, vertical, action, fromCohortId, toCohortId, reason, requestId, actor,
}) {
  if (!ACTIONS.includes(action)) {
    throw new AppError('SERVER_ERROR', 'Something went wrong. Please try again.', {
      logDetail: `unknown seat action ${action}`,
    });
  }
  const key = claimKeyFor(addressId, vertical);
  const existing = await getClaim(catalystApp, addressId, vertical);
  /* No claim row is not the same as no history: see highestEventVersion. */
  const version = existing
    ? (Number(existing.version) || 0)
    : await highestEventVersion(catalystApp, key);
  const nextVersion = version + 1;
  const now = datastore.nowDb();

  /* Same request replayed: the work is done, hand back the truth. */
  const replay = await findEventByRequestId(catalystApp, key, requestId);
  if (replay) {
    const fresh = await getClaim(catalystApp, addressId, vertical);
    return { claim: publicClaim(fresh), replayed: true };
  }

  /* The serialization point. Exactly one writer owns version nextVersion. */
  try {
    await datastore.insertRow(catalystApp, EVENT_TABLE, {
      event_key: `${key}:${nextVersion}`,
      claim_key: key,
      address_id: addressId,
      member_id: user.user_id,
      from_cohort_id: fromCohortId || null,
      to_cohort_id: toCohortId || null,
      action,
      reason: cleanReason(reason),
      actor: actor || 'member',
      request_id: requestId || null,
      occurred_at: now,
    });
  } catch (err) {
    const fresh = await getClaim(catalystApp, addressId, vertical);
    if (fresh && (Number(fresh.version) || 0) !== version) {
      const conflict = new AppError('CONFLICT',
        'That seat just changed in another tab. Reloading the latest state.', {
          logDetail: `seat event ${key}:${nextVersion} lost the insert race`,
        });
      conflict.seatConflict = fresh;
      throw conflict;
    }
    throw new AppError('SERVER_ERROR',
      'Cohort seats are not available right now. Please try again shortly.', {
        logDetail: `claim_event insert failed (table missing?): ${String((err && err.message) || err).slice(0, 200)}`,
      });
  }

  /* The claim write. Safe: this writer owns nextVersion outright. */
  const active = (action === 'join' || action === 'move' || action === 'rejoin' || action === 'admin_move');
  const fields = {
    cohort_id: active ? toCohortId : null,
    status: active ? 'active' : 'released',
    version: nextVersion,
  };
  if (active) { fields.claimed_at = now; fields.released_at = null; }
  else { fields.released_at = now; }

  try {
    if (existing) {
      await datastore.updateRow(catalystApp, CLAIM_TABLE, { ROWID: existing.ROWID, ...fields });
    } else {
      await datastore.insertRow(catalystApp, CLAIM_TABLE, {
        claim_key: key,
        address_id: addressId,
        vertical: vertical || VERTICAL_DEFAULT,
        member_id: user.user_id,
        ...fields,
        claimed_at: active ? now : null,
        released_at: active ? null : now,
      });
    }
  } catch (err) {
    throw new AppError('SERVER_ERROR',
      'Cohort seats are not available right now. Please try again shortly.', {
        logDetail: `seat_claim write failed after event ${key}:${nextVersion}: ${String((err && err.message) || err).slice(0, 200)}`,
      });
  }

  /* The read layer's memo for both cohorts this move touched is stale the
     instant the claim row lands. Invalidated here, on the write, so the next
     read on this instance is exact and the 60s memo only ever bounds
     cross-instance staleness. */
  cohorts.invalidate(fromCohortId);
  cohorts.invalidate(toCohortId);

  const fresh = await getClaim(catalystApp, addressId, vertical);
  return { claim: publicClaim(fresh), version: nextVersion, replayed: false };
}

/**
 * Compensate a half-finished move: swap the claim back to the from-cohort.
 * Best effort by design; it appends its own event so the log shows both the
 * attempt and the retreat.
 */
async function compensate(catalystApp, { user, addressId, vertical, fromCohortId, toCohortId, requestId }) {
  try {
    await transition(catalystApp, {
      user, addressId, vertical,
      action: 'admin_move',
      fromCohortId: toCohortId,
      toCohortId: fromCohortId,
      reason: null,
      requestId: requestId ? `${requestId}.compensate` : null,
      actor: 'system',
    });
    return true;
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'seat move compensation failed',
      claim: claimKeyFor(addressId, vertical),
      detail: String((err && err.message) || err).slice(0, 200),
    }));
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Counters and publish hysteresis
 * ------------------------------------------------------------------ */

/**
 * Recount active claims for a cohort and store the number. Runs on
 * transitions only; the read path reads the stored counter. A recount is
 * self-healing where an increment drifts, and cannot go below zero.
 */
async function recount(catalystApp, cohortId) {
  if (!cohortId) return null;
  let count = 0;
  try {
    const rows = await datastore.queryAll(catalystApp, CLAIM_TABLE, ['claim_key'],
      `cohort_id = ${datastore.lit(cohortId)} AND status = 'active'`);
    count = rows.length;
  } catch {
    return null; // Claim table unreadable: the transition already failed loudly.
  }
  try {
    const row = await datastore.findBy(catalystApp, COUNTER_TABLE, 'cohort_id', cohortId,
      ['ROWID', 'roster_count', 'published', 'partner_announced', 'public_threshold', 'min_threshold']);
    if (row) {
      await datastore.updateRow(catalystApp, COUNTER_TABLE, {
        ROWID: row.ROWID, roster_count: count, updated_at: datastore.nowDb(),
      });
      return { count, row };
    }
    await datastore.insertRow(catalystApp, COUNTER_TABLE, {
      cohort_id: cohortId,
      roster_count: count,
      published: false,
      partner_announced: false,
      updated_at: datastore.nowDb(),
    });
    return { count, row: null };
  } catch (err) {
    /* The counter is a display sidecar, not the enforcement row. A missing
       table degrades to seed numbers, logged, exactly like campaign_members. */
    console.error(JSON.stringify({
      level: 'warn',
      message: 'cohort_counter write skipped',
      cohort: cohortId,
      detail: String((err && err.message) || err).slice(0, 200),
    }));
    return null;
  }
}

const isTruthyDb = (v) => v === true || v === 'true' || v === 1 || v === '1';
const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * Publish hysteresis, applied after a leave dropped the count. A cohort that
 * crossed its public threshold does not flicker off the site because one
 * household left: it un-publishes only below (threshold - buffer), and never
 * once founding partners have been told it exists.
 */
async function applyHysteresis(catalystApp, cohortId, buffer = 0.10) {
  try {
    const row = await datastore.findBy(catalystApp, COUNTER_TABLE, 'cohort_id', cohortId,
      ['ROWID', 'roster_count', 'published', 'partner_announced', 'public_threshold']);
    if (!row || !isTruthyDb(row.published) || isTruthyDb(row.partner_announced)) return;
    const threshold = toInt(row.public_threshold);
    if (!threshold) return;
    const floor = Math.floor(threshold * (1 - buffer));
    if ((toInt(row.roster_count) || 0) < floor) {
      await datastore.updateRow(catalystApp, COUNTER_TABLE, {
        ROWID: row.ROWID, published: false, updated_at: datastore.nowDb(),
      });
    }
  } catch {
    /* Sidecar, same contract as recount. */
  }
}

/** The stored roster count for a cohort, or null when no counter row exists. */
async function counterFor(catalystApp, cohortId) {
  try {
    const row = await datastore.findBy(catalystApp, COUNTER_TABLE, 'cohort_id', cohortId,
      ['roster_count', 'published', 'partner_announced', 'public_threshold', 'min_threshold']);
    if (!row) return null;
    return {
      roster_count: toInt(row.roster_count) || 0,
      published: isTruthyDb(row.published),
      partner_announced: isTruthyDb(row.partner_announced),
      public_threshold: toInt(row.public_threshold),
      min_threshold: toInt(row.min_threshold),
    };
  } catch {
    return null;
  }
}

module.exports = {
  CLAIM_TABLE, EVENT_TABLE, COUNTER_TABLE, REASONS, VERTICAL_DEFAULT,
  addressIdFor, claimKeyFor, cleanReason, cleanRequestId,
  getClaim, publicClaim, transition, compensate,
  recount, applyHysteresis, counterFor,
};
