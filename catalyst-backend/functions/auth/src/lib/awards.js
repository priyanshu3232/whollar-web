'use strict';

/**
 * The award: which sealed bid won a cohort, recorded once, read everywhere.
 *
 * WHY THIS TABLE EXISTS. Before it, the winner was a derivation living inside
 * the member offer route: lowest headline price among the bids on a closed
 * campaign, recomputed on every read. That was correct and it was invisible.
 * Nothing on the partner side could see it, `provider_bids.status` was never
 * written, and two readers a second apart could disagree the moment a late
 * write or a price correction landed. A cohort can only be won once, so the
 * winner is a record, not an opinion.
 *
 * THE SAME RULE, NOW WRITTEN DOWN. The winner is still the lowest headline
 * price, `provider_bids.price`, which is the lowest tier's effective price
 * written at seal. `routes/campaigns.js` reads the award instead of deciding
 * again, so the household and the partner are told the same thing by the same
 * row.
 *
 * SEALED AT CLOSE, BY WHOEVER ASKS FIRST. There is no cron in this stack, so
 * nothing can be scheduled for the moment a cohort closes. Instead the first
 * read after the close seals the award, idempotently: `award_key` is the
 * campaign id and is unique, so two concurrent readers race and the loser
 * reads the winner's row. That makes the award self-healing rather than
 * dependent on a job that can fire late, twice, or never.
 *
 * A CLOSE IS NOT AN AWARD. Sealing only ever happens for a campaign the
 * catalog says has closed, and only when at least one readable priced bid
 * exists. A closed cohort nobody bid on gets no row, and no row is a fact the
 * console renders as itself rather than as a loss.
 *
 * THE ROSTER GATE LIVES ON THIS ROW, and not in its own table, because it is
 * one-to-one with the award: the same partner, the same cohort, the same act.
 * Three things have to be true before a household's address reaches a partner:
 * a billing method on file, a stated install capacity, and an explicit consent
 * acknowledgement. All three are checked server side in routes/delivery.js;
 * the fields here are the record of them.
 *
 * NO PARTNER LEARNS ANOTHER PARTNER'S RESULT. `bid_count` is how many sealed
 * bids the cohort drew, which is the winner's own competitive context and is
 * already public to the household as `bidCount`. No losing org, price or
 * reference is stored here or returned anywhere.
 */

const datastore = require('./datastore');
const { ms } = require('./envelope');

const AWARDS = 'campaign_awards';

/* Two lists, the pattern lib/bids.js established: tables are created by hand,
   so code and schema deploy separately and in either order. The base list is
   what an award cannot be read without; the extended list carries the roster
   gate and is tried first. */
const AWARD_COLS = Object.freeze(['award_key', 'campaign_id', 'org_id', 'bid_key',
  'price', 'bid_count', 'method', 'awarded_by', 'awarded_at']);
const AWARD_COLS_V2 = Object.freeze(AWARD_COLS.concat(['gate_at', 'gate_by',
  'install_capacity_weekly', 'consent_ack', 'settled_at']));

/* How the winner was picked. 'lowest_headline' is the rule; 'admin' exists so
   a corrected award is distinguishable from a computed one, in the record and
   not only in an audit line. */
const METHODS = Object.freeze(['lowest_headline', 'admin']);

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** The award row for one campaign, or null. Null also means unreadable: every
    caller treats "no award" as "nothing has been won here", which is the safe
    reading in both cases, and never as "you lost". */
async function findByCampaign(catalystApp, campaignId) {
  try {
    return await datastore.findBy(catalystApp, AWARDS, 'award_key', campaignId,
      ['ROWID'].concat(AWARD_COLS_V2));
  } catch {
    try {
      return await datastore.findBy(catalystApp, AWARDS, 'award_key', campaignId,
        ['ROWID'].concat(AWARD_COLS));
    } catch {
      return null;
    }
  }
}

/** Every award held by one org, or null when the table is unreadable. */
async function rowsForOrg(catalystApp, orgId) {
  const where = `org_id = ${datastore.lit(orgId)}`;
  try {
    return await datastore.queryAll(catalystApp, AWARDS, AWARD_COLS_V2, where);
  } catch {
    try {
      return await datastore.queryAll(catalystApp, AWARDS, AWARD_COLS, where);
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Sealing
 * ------------------------------------------------------------------ */

/**
 * Has this cohort closed? The same test the member offer route applies: the
 * calendar says so, or an admin moved the cohort past the auction. An auction
 * with no close date has NOT closed. Absent a date the seal holds rather than
 * falling open, which is the rule everywhere else in this system.
 */
function isClosed(campaign, now = Date.now()) {
  if (!campaign) return false;
  if (campaign.kind === 'closed' || campaign.kind === 'archived') return true;
  const closesAt = (campaign.dates || {}).bidding_closes_at || null;
  return Boolean(closesAt && now >= closesAt);
}

/**
 * Pick the winner from head rows: lowest headline price, ties broken by bid
 * key so the answer is stable across readers and across restarts.
 *
 * A row with an unreadable price cannot win, rather than sorting to the front
 * as NaN. Returns null when no row carries a price.
 */
function pickWinner(rows) {
  const priced = (rows || [])
    .map((r) => ({ row: r, n: Number(r.price) }))
    .filter((x) => Number.isFinite(x.n));
  if (!priced.length) return null;
  priced.sort((a, b) => (a.n - b.n) || String(a.row.bid_key).localeCompare(String(b.row.bid_key)));
  return priced[0].row;
}

/**
 * Read the award for a closed campaign, sealing it first if it has never been
 * sealed. Returns the row, or null when there is nothing to award.
 *
 * `bidRows` is passed in rather than fetched here: the two callers already
 * hold it, and lib/bids.js is emphatic that the all-orgs read is safe in
 * exactly one place. Keeping the fetch at the call site keeps that visible.
 *
 * A failed insert is not an error to the caller. Either another reader won the
 * race, in which case the row is there and re-reading finds it, or the table
 * does not exist yet, in which case nothing about the cohort has changed and
 * the console renders the unsealed state.
 */
async function seal(catalystApp, campaign, bidRows, now = Date.now()) {
  const existing = await findByCampaign(catalystApp, campaign.id);
  if (existing) return existing;
  if (!isClosed(campaign, now)) return null;

  const win = pickWinner(bidRows);
  if (!win) return null;

  try {
    await datastore.insertRow(catalystApp, AWARDS, {
      award_key: campaign.id,
      campaign_id: campaign.id,
      org_id: win.org_id,
      bid_key: win.bid_key,
      price: win.price,
      bid_count: (bidRows || []).length,
      method: 'lowest_headline',
      awarded_by: 'auto',
      awarded_at: datastore.toDb(new Date(now)),
    });
  } catch {
    /* Raced, or the table is not created yet. Re-read: if somebody else won
       the race their row is the award, and if the table is missing this
       returns null and the caller renders the unsealed state. */
    return findByCampaign(catalystApp, campaign.id);
  }
  return findByCampaign(catalystApp, campaign.id);
}

/* ------------------------------------------------------------------ *
 * The roster gate
 * ------------------------------------------------------------------ */

/** Which of the three gate conditions this award has met. Pure. */
function gateState(row, billing) {
  const capacity = toInt(row && row.install_capacity_weekly);
  return {
    billing: Boolean(billing && billing.onFile),
    capacity: Boolean(capacity && capacity > 0),
    consent: Boolean(row && String(row.consent_ack || '') === 'yes'),
    releasedAt: ms(row && row.gate_at),
  };
}

/** True when all three have been met and the roster has been released. */
function gatePassed(row, billing) {
  const g = gateState(row, billing);
  return g.billing && g.capacity && g.consent && Boolean(g.releasedAt);
}

/** Record the release. The caller has already checked all three conditions. */
function release(catalystApp, row, { capacity, userId, at }) {
  return datastore.updateRow(catalystApp, AWARDS, {
    ROWID: row.ROWID,
    install_capacity_weekly: capacity,
    consent_ack: 'yes',
    gate_by: userId,
    gate_at: datastore.toDb(new Date(at || Date.now())),
  });
}

/** Update the stated install capacity on an already released roster. */
function setCapacity(catalystApp, row, capacity) {
  return datastore.updateRow(catalystApp, AWARDS, {
    ROWID: row.ROWID,
    install_capacity_weekly: capacity,
  });
}

/* ------------------------------------------------------------------ *
 * Wire shape
 * ------------------------------------------------------------------ */

/**
 * The award as the winning partner's console reads it. Never sent to anyone
 * else: the org that holds the row is the only org this shape is for.
 */
function publicAward(row, billing) {
  return {
    campaignId: row.campaign_id,
    reference: row.bid_key || null,
    price: row.price || null,
    bidCount: toInt(row.bid_count),
    method: METHODS.indexOf(row.method) >= 0 ? row.method : 'lowest_headline',
    awardedAt: ms(row.awarded_at),
    capacityWeekly: toInt(row.install_capacity_weekly),
    settledAt: ms(row.settled_at),
    gate: gateState(row, billing),
  };
}

module.exports = {
  AWARDS, AWARD_COLS, AWARD_COLS_V2, METHODS,
  findByCampaign, rowsForOrg,
  isClosed, pickWinner, seal,
  gateState, gatePassed, release, setCapacity,
  publicAward,
};
