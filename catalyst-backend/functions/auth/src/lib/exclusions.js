'use strict';

/**
 * A member's provider exclusions: the brands whose offers must never reach
 * this household.
 *
 * THE PROMISE IS ABSOLUTE, so this module is the one place that decides what
 * "excluded" means and every other layer asks it. The member is told plainly
 * that an excluded provider will never be able to send them an offer, and a
 * promise phrased that way cannot be a rendering convenience: it has to hold
 * in the award, in the accept, and in the payload. lib/awards.js filters the
 * price book with the set this module returns, and routes/campaigns.js never
 * builds a member's book without asking first.
 *
 * THE SET IS MATERIALISED AT WRITE TIME, one row per brand, never "the parent
 * plus whatever the registry says its children are today". A member who
 * excludes Bell is shown Virgin Plus and oxio being excluded on their behalf
 * and may untick either, so what they agreed to is a specific list of names.
 * Storing the parent and expanding on read would let a registry edit widen
 * that list, or narrow it, months later and without asking: a brand added to
 * the Bell family in November would silently become excluded for everyone who
 * ticked Bell in August, and a brand moved out would silently become
 * reachable. Section 10.4 is the only path allowed to change a stored set
 * after a registry edit, and it still asks the member first.
 *
 * ONE ROW PER (MEMBER, BRAND), EVER. `excl_key` flattens the composite the
 * way every table in this stack does, because the Data Store has no composite
 * keys and no partial unique index, so "at most one ACTIVE row per member per
 * brand" cannot be expressed as a constraint. A member who excludes a brand,
 * un-excludes it and excludes it again reuses the row and bumps `cycles`
 * rather than inserting a second one: the alternative is a key with a
 * generation counter in it, which makes the active-row lookup a scan and the
 * uniqueness guarantee a convention rather than a constraint.
 *
 * THE HISTORY LIVES IN `auth_events`, NOT HERE. Reviving a row loses the shape
 * of the previous cycle, and the brief wants a dispute answerable. Every
 * create and every remove writes an audit row carrying actor, timestamp and
 * the cohort state at the time, which section 10.6 requires anyway. Keeping a
 * second copy of that history in this table would be two records of one fact,
 * free to disagree, and `auth_events` is where every other trail in this
 * system already is.
 *
 * A MISSING TABLE IS NOT AN EMPTY SET, EXCEPT ONCE. See `probe`.
 */

const datastore = require('./datastore');
const { AppError } = require('./errors');

const TABLE = 'member_provider_exclusions';

/* create-tables.md section 34d. */
const EXCL_COLS = Object.freeze(['excl_key', 'member_id', 'brand_id', 'source',
  'created_at', 'removed_at', 'cycles']);
const EXCL_COLS_V1 = Object.freeze(['excl_key', 'member_id', 'brand_id', 'source',
  'created_at', 'removed_at']);
const EXCL_COL_LISTS = Object.freeze([EXCL_COLS, EXCL_COLS_V1]);

/** Picked by the member, or accepted as part of a family default. */
const SOURCES = Object.freeze(['direct', 'family_default']);

/* A member may exclude the whole registry, which section 7.1 allows on
   purpose. This bound is a write-size guard, not a policy: it exists so one
   request cannot try to insert an unbounded number of rows. */
const MAX_PER_WRITE = 200;

function keyFor(memberId, brandId) {
  return `${memberId}:${brandId}`.slice(0, 160);
}

async function firstReadable(read) {
  for (const cols of EXCL_COL_LISTS) {
    try {
      /* eslint-disable-next-line no-await-in-loop */
      return await read(cols);
    } catch {
      /* try the next narrower projection */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Presence, and why it is separate from a read
 * ------------------------------------------------------------------ */

const PROBE_MS = 60 * 1000;
let probeMemo = { at: 0, present: null };

/**
 * Does this table exist and answer?
 *
 * This distinction carries the whole safety argument of the feature, so it is
 * worth being explicit about. There are two reasons a member's exclusion read
 * can come back empty-handed, and they demand opposite behaviour:
 *
 *   1. THE TABLE IS NOT CREATED YET. Nobody anywhere has an exclusion,
 *      because there is nowhere to put one. The correct behaviour is to route
 *      offers exactly as this system did before the feature existed. Failing
 *      closed here would empty the offer panel for every household on every
 *      cohort, which is the failure mode lib/catalog.js's column ladder was
 *      written to prevent.
 *
 *   2. THE TABLE EXISTS AND THIS MEMBER'S READ FAILED. Now an empty set is a
 *      guess, and the guess routes an offer from a provider a household
 *      explicitly refused. That is the one outcome this feature exists to make
 *      impossible, so the caller must be told it does not know rather than
 *      handed an empty set.
 *
 * Catalyst reports both as a thrown read, so presence is probed once and
 * memoized, and `setFor` returns null in case 2 while returning an empty set
 * in case 1. Every caller that routes an offer must handle null as "do not
 * route", never as "nothing excluded".
 */
async function probe(catalystApp, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && probeMemo.present !== null && now - probeMemo.at < PROBE_MS) {
    return probeMemo.present;
  }
  let present = false;
  try {
    /* A bounded read that touches the table without depending on any row. */
    await datastore.query(catalystApp, TABLE,
      `SELECT ROWID FROM ${datastore.ident(TABLE)} WHERE ROWID > 0 LIMIT 1`);
    present = true;
  } catch {
    present = false;
  }
  probeMemo = { at: now, present };
  return present;
}

/** Drop the presence memo. Called after a successful write. */
function invalidate() { probeMemo = { at: 0, present: null }; }

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** Every row for one member, active and removed alike. Null when unreadable. */
function rowsFor(catalystApp, memberId) {
  return firstReadable((cols) => datastore.queryAll(
    catalystApp, TABLE, cols, `member_id = ${datastore.lit(memberId)}`
  ));
}

const isActive = (row) => Boolean(row) && !row.removed_at;

/**
 * The member's effective exclusion set as a Set of brand ids.
 *
 *   -> Set        the brands whose offers must not reach this member
 *   -> new Set()  the table does not exist: the feature is not deployed
 *   -> null       the table exists and this read failed: NOT an empty set
 *
 * The null case is the important one and every award path handles it: see the
 * note on `probe`.
 */
async function setFor(catalystApp, memberId) {
  if (!memberId) return new Set();
  const rows = await rowsFor(catalystApp, memberId);
  if (rows === null) {
    /* Unreadable. Which of the two cases is it? */
    const present = await probe(catalystApp);
    if (!present) return new Set();
    console.warn(JSON.stringify({
      at: 'exclusions.setFor', member: String(memberId).slice(0, 40),
      note: 'table present but member read failed; refusing to route offers',
    }));
    return null;
  }
  return new Set(rows.filter(isActive).map((r) => r.brand_id));
}

/**
 * The member's active exclusions as wire rows, newest first, with display
 * names resolved from the registry.
 *
 * A retired brand still appears: the member chose it, and a list that
 * silently drops a choice reads as a bug rather than as housekeeping. A brand
 * that has vanished from the registry entirely falls back to its id, so the
 * chip is still removable.
 */
function listFrom(rows, registryRows) {
  const byId = new Map((registryRows || [])
    .filter((r) => r && r.brand_id).map((r) => [r.brand_id, r]));
  return (rows || [])
    .filter(isActive)
    .map((r) => ({
      brand_id: r.brand_id,
      display_name: (byId.get(r.brand_id) || {}).display_name || r.brand_id,
      parent_brand_id: (byId.get(r.brand_id) || {}).parent_brand_id || null,
      source: SOURCES.indexOf(r.source) >= 0 ? r.source : 'direct',
      created_at: r.created_at || null,
    }))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))
      || a.display_name.localeCompare(b.display_name));
}

/* ------------------------------------------------------------------ *
 * The write
 * ------------------------------------------------------------------ */

/**
 * What `replace` would do, computed against the rows already stored. Pure, so
 * the whole decision is testable without a store.
 *
 *   -> { insert: [brandId], revive: [row], remove: [row], unchanged: [brandId] }
 */
function planFor(rows, wanted) {
  const want = new Set(wanted || []);
  const byBrand = new Map((rows || [])
    .filter((r) => r && r.brand_id).map((r) => [r.brand_id, r]));

  const insert = [];
  const revive = [];
  const unchanged = [];
  want.forEach((brandId) => {
    const row = byBrand.get(brandId);
    if (!row) insert.push(brandId);
    else if (isActive(row)) unchanged.push(brandId);
    else revive.push(row);
  });

  const remove = (rows || [])
    .filter((r) => isActive(r) && !want.has(r.brand_id));

  return { insert, revive, remove, unchanged };
}

/**
 * Replace the member's active set with `brandIds`, atomically as this store
 * permits: soft-remove what is missing, insert or revive what is new.
 *
 * "Atomically as this store permits" is doing real work in that sentence.
 * There are no transactions here, so a request that dies halfway leaves a
 * partially applied set. The order below is chosen so that the halfway state
 * is the SAFER one: additions land before removals, so an interrupted write
 * leaves a member over-excluded rather than under-excluded. Over-excluded
 * costs the member an offer they might have wanted and is visible to them on
 * the very next screen; under-excluded delivers an offer they refused, which
 * is the failure this feature exists to prevent and which they may never
 * connect to a half-finished save.
 *
 * `sources` maps brand id to 'direct' or 'family_default' for rows being
 * created. A revived row keeps whatever source it was first given, because
 * how the member originally arrived at that brand is the fact worth keeping.
 *
 * Throws when the table is missing. A picker that says "saved" over a write
 * that went nowhere is the precise lie this feature cannot afford.
 */
async function replace(catalystApp, memberId, brandIds, { sources = {}, at = Date.now() } = {}) {
  const wanted = Array.from(new Set((brandIds || []).map((b) => String(b))));
  if (wanted.length > MAX_PER_WRITE) {
    throw new AppError('VALIDATION_ERROR', 'That is more providers than one save can hold.');
  }

  const rows = await rowsFor(catalystApp, memberId);
  if (rows === null) {
    throw new AppError('SERVER_ERROR',
      'Excluded providers are not available right now. Nothing was changed.', {
      logDetail: `exclusions table unreadable member=${String(memberId).slice(0, 40)}`,
    });
  }

  const plan = planFor(rows, wanted);
  const nowDb = datastore.toDb(new Date(at));

  /* Additions first. See the ordering argument above. */
  for (const brandId of plan.insert) {
    /* eslint-disable-next-line no-await-in-loop */
    await datastore.insertRow(catalystApp, TABLE, {
      excl_key: keyFor(memberId, brandId),
      member_id: memberId,
      brand_id: brandId,
      source: SOURCES.indexOf(sources[brandId]) >= 0 ? sources[brandId] : 'direct',
      created_at: nowDb,
      removed_at: null,
      cycles: 1,
    });
  }
  for (const row of plan.revive) {
    /* eslint-disable-next-line no-await-in-loop */
    await datastore.updateRow(catalystApp, TABLE, {
      ROWID: row.ROWID,
      removed_at: null,
      created_at: nowDb,
      cycles: (parseInt(row.cycles, 10) || 1) + 1,
    });
  }
  for (const row of plan.remove) {
    /* eslint-disable-next-line no-await-in-loop */
    await datastore.updateRow(catalystApp, TABLE, {
      ROWID: row.ROWID,
      removed_at: nowDb,
    });
  }

  invalidate();
  return {
    added: plan.insert.concat(plan.revive.map((r) => r.brand_id)),
    removed: plan.remove.map((r) => r.brand_id),
    unchanged: plan.unchanged,
    active: wanted,
  };
}

/**
 * Does this member's set cover every brand that could serve them, i.e. every
 * brand with a bid on this cohort?
 *
 * The full-coverage warning (CONFIRM-EXCL-03, warn and do not block) is shown
 * only when this returns true, and never speculatively. "You may receive no
 * offers" said to a member whose exclusions happen to miss two active bidders
 * is a false alarm that teaches them to ignore the next one.
 *
 * `bidBrandIds` is the set of brands actually holding a bid, so a cohort
 * nobody has bid yet returns false: there is nothing to be covered.
 */
function coversAll(excluded, bidBrandIds) {
  const bids = Array.from(new Set(bidBrandIds || [])).filter(Boolean);
  if (!bids.length) return false;
  const set = excluded instanceof Set ? excluded : new Set(excluded || []);
  return bids.every((b) => set.has(b));
}

module.exports = {
  TABLE, EXCL_COLS, SOURCES, MAX_PER_WRITE,
  keyFor, probe, invalidate,
  rowsFor, isActive, setFor, listFrom,
  planFor, replace, coversAll,
};
