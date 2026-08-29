'use strict';

/**
 * Switch orders: one row per household that accepted a winning offer, and the
 * seven states one can be in.
 *
 * THIS IS THE INTIMATION BOUNDARY'S FAR SIDE. routes/campaigns.js states in
 * code that no member identity crosses the campaigns route. It crosses here,
 * and only here, and only after three server-side checks: an award row, a
 * completed roster gate, and the household's own consent recorded at
 * acceptance. `publicOrder` is the only function in this file that emits an
 * address, and routes/delivery.js is the only caller.
 *
 * THE SEVEN STATES ARE THE CONTRACT. partner/core/contract.js ORDER_STATE
 * declares them and this list mirrors it, wire value for wire value. The
 * prototype also carries a dead earlier vocabulary (ins, sch, to) from a
 * superseded seedRoster: it is not ported, and must never appear as a column
 * value. If you change one list, change both.
 *
 * ONE STATE BILLS. 'act' is the only state that creates a billable line, and
 * it requires a clean line test and a confirmed incumbent cancellation, both
 * asserted by the partner at the moment of activation and both recorded. A
 * confirmation does not bill. A booking does not bill. A released household
 * costs nothing on either side, which is what makes releasing one an honest
 * act rather than a loss to be avoided.
 *
 * NOTHING IS DELETED. An order that will never be served is released with a
 * reason from the enum, and it stays on the board. The reasons feed the
 * serviceability figure on the performance page, which feeds future briefs,
 * which is why the reason is an enum and not prose.
 */

const crypto = require('crypto');
const datastore = require('./datastore');
const { ms } = require('./envelope');
const { badRequest } = require('./errors');

const ORDERS = 'provider_orders';

/* Mirrors partner/core/contract.js ORDER_STATE. */
const STATES = Object.freeze(['acc', 'bkd', 'act', 'rel', 'noshow', 'access', 'linefail']);
const EXCEPTIONS = Object.freeze(['noshow', 'access', 'linefail']);

/* Mirrors RELEASE_REASON. An enum because it feeds a figure. */
const RELEASE_REASONS = Object.freeze([
  'no_plant', 'building_access', 'speed_tier_unavailable', 'household_cancelled',
]);

/**
 * Legal moves, as a map from state to the states it may become.
 *
 * 'act' is terminal in both directions: there is no un-activation, because an
 * activation is a billable line and a line that can vanish is a line nobody
 * can reconcile. A wrongly activated order is corrected by a credit on the
 * statement, which leaves a record, rather than by an edit, which does not.
 *
 * 'rel' is terminal too. A released household that later wants service starts
 * a new order in a new cohort; reviving this one would put a household back on
 * a board it had been told it was off.
 */
const TRANSITIONS = Object.freeze({
  acc: ['bkd', 'rel'],
  bkd: ['act', 'rel', 'noshow', 'access', 'linefail'],
  noshow: ['bkd', 'rel'],
  access: ['bkd', 'rel'],
  linefail: ['bkd', 'act', 'rel'],
  act: [],
  rel: [],
});

/* Exception first. The board opens on what needs a decision, not on what is
   going well. Mirrors partner/core/contract.js ORDER_RANK. */
const RANK = Object.freeze({ noshow: 0, access: 0, linefail: 0, acc: 1, bkd: 2, act: 3, rel: 4 });

const ORDER_COLS = Object.freeze(['order_key', 'order_no', 'campaign_id', 'org_id',
  'member_user_id', 'state', 'fsa', 'address_line', 'slot_at', 'note',
  'release_reason', 'activated_at', 'created_at', 'updated_at']);
/* The statement side. Tried first, and absent on a table created before
   billing shipped, which reads as "no line has ever been disputed". */
const ORDER_COLS_V2 = Object.freeze(ORDER_COLS.concat(['dispute_state', 'dispute_note', 'disputed_at']));
/* WHICH SPEED WAS ACCEPTED, and the book price it was accepted at
   (create-tables.md section 30c). Mandatory to the partner, who cannot book an
   install without knowing what to install, and absent on an order created
   before the price book, which reads as the cohort's single winner. Widest
   first, same fallback ladder as everything else here. */
const ORDER_COLS_V3 = Object.freeze(ORDER_COLS_V2.concat(['tier', 'price']));
const ORDER_COL_LISTS = Object.freeze([ORDER_COLS_V3, ORDER_COLS_V2, ORDER_COLS]);

/** The first column list this table can answer, or null when none can. */
async function firstReadable(read) {
  for (const cols of ORDER_COL_LISTS) {
    try {
      /* eslint-disable-next-line no-await-in-loop */
      return await read(cols);
    } catch {
      /* try the next narrower projection */
    }
  }
  return null;
}

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * An order number a household and a partner can both quote.
 *
 * Random, not sequential, for the reason lib/bids.js gives about receipts: a
 * sequence tells every partner how many switches the platform has run. The
 * trailing C is the prototype's shape, kept because it is on screenshots that
 * households have seen.
 */
const orderNo = () => 'WHL-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-C';

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/** A postal FSA, uppercased, or null. The first half of a Canadian postcode. */
function readFsa(value) {
  const s = String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z][0-9][A-Z]$/.test(s) ? s : null;
}

/**
 * A service address, as the household typed it.
 *
 * Free text, so it never reaches lib/datastore.js lit(): it is written through
 * the object API and read back by key. Length capped, control characters
 * refused, and that is the whole validation. An address rejected for failing a
 * format guess is a household that cannot switch.
 */
function readAddress(value) {
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  if (s.length < 6) throw badRequest('Enter the address the service goes to.');
  return s.slice(0, 180);
}

/** A slot the household picked, as epoch ms. Must be in the future. */
function readSlot(value, now) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw badRequest('Pick an install date.');
  if (n < now) throw badRequest('That install slot is in the past.');
  /* A year out is not a booking, it is a typo. */
  if (n > now + 365 * 24 * 60 * 60 * 1000) throw badRequest('Pick an install date within the next year.');
  return n;
}

/** The move, checked against TRANSITIONS. Throws a 400 that names both ends. */
function requireTransition(from, to) {
  if (STATES.indexOf(to) < 0) throw badRequest('Unknown order state.');
  const legal = TRANSITIONS[from] || [];
  if (legal.indexOf(to) < 0) {
    if (from === 'act') throw badRequest('An activated order is settled. Correct it with a credit on the statement, not an edit.');
    if (from === 'rel') throw badRequest('A released household is off this cohort. Nothing moves it back.');
    throw badRequest(`An order cannot go from ${from} to ${to}.`);
  }
  return to;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

function rowsWhere(catalystApp, where) {
  return firstReadable((cols) => datastore.queryAll(catalystApp, ORDERS, cols, where));
}

/** Every order on one cohort for one org. Null when unreadable. */
function rowsForCampaign(catalystApp, orgId, campaignId) {
  return rowsWhere(catalystApp,
    `org_id = ${datastore.lit(orgId)} AND campaign_id = ${datastore.lit(campaignId)}`);
}

/** Every order an org holds, across cohorts. Null when unreadable. */
function rowsForOrg(catalystApp, orgId) {
  return rowsWhere(catalystApp, `org_id = ${datastore.lit(orgId)}`);
}

/** One order by its key, scoped to the org that holds it. */
async function findByKey(catalystApp, orgId, key) {
  const row = await firstReadable((cols) => datastore.findBy(catalystApp, ORDERS,
    'order_key', key, ['ROWID'].concat(cols)));
  /* Another org's order answers exactly like an order that does not exist.
     The route turns this into a 404, never a 403: a 403 confirms there is
     something there. */
  if (!row || row.org_id !== orgId) return null;
  return row;
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Create the order a household's acceptance implies. Idempotent on
 * `order_key`, which is campaign and member: accepting twice is one order, and
 * a retried request is not a second household.
 */
async function create(catalystApp, { campaignId, orgId, memberUserId, fsa, address, tier, price, at }) {
  const key = `${campaignId}:${memberUserId}`.slice(0, 200);
  const existing = await findAnyByKey(catalystApp, key);
  if (existing) return existing;

  const stamp = datastore.toDb(new Date(at || Date.now()));
  const base = {
    order_key: key,
    order_no: orderNo(),
    campaign_id: campaignId,
    org_id: orgId,
    member_user_id: memberUserId,
    state: 'acc',
    fsa: fsa || null,
    address_line: address,
    created_at: stamp,
    updated_at: stamp,
  };
  try {
    await datastore.insertRow(catalystApp, ORDERS, Object.assign({
      tier: tier || null,
      price: price || null,
    }, base));
  } catch (err) {
    /* The two price-book columns may not exist yet. An order without them is
       far better than a household whose acceptance failed, so the row still
       goes in: the partner is told which cohort and which household, and the
       speed is recoverable from the sealed book until the columns land.
       Logged, because the other cause of a refused insert here is a real one. */
    console.warn(JSON.stringify({
      at: 'orders.create', campaign: campaignId,
      error: String((err && err.message) || err).slice(0, 200),
    }));
    await datastore.insertRow(catalystApp, ORDERS, base);
  }
  return findAnyByKey(catalystApp, key);
}

/** The org-blind read, for the creation path, which knows the org already. */
function findAnyByKey(catalystApp, key) {
  return firstReadable((cols) => datastore.findBy(catalystApp, ORDERS, 'order_key', key,
    ['ROWID'].concat(cols)));
}

/** Apply a checked move. `patch` carries only the columns that state needs. */
function move(catalystApp, row, to, patch, at) {
  return datastore.updateRow(catalystApp, ORDERS, Object.assign({
    ROWID: row.ROWID,
    state: to,
    updated_at: datastore.toDb(new Date(at || Date.now())),
  }, patch || {}));
}

/* ------------------------------------------------------------------ *
 * Counts and wire shapes
 * ------------------------------------------------------------------ */

/**
 * The counts the console draws its four tiles from.
 *
 * These are also what a GATED roster returns, on its own, with no `orders`
 * key at all. A partner who has won a cohort may know how many households
 * accepted before the gate passes; they may not know who they are.
 */
function counts(rows) {
  const c = { total: 0, acc: 0, bkd: 0, act: 0, rel: 0, noshow: 0, access: 0, linefail: 0 };
  (rows || []).forEach((r) => {
    const s = STATES.indexOf(r.state) >= 0 ? r.state : 'acc';
    c.total += 1;
    c[s] += 1;
  });
  c.exceptions = c.noshow + c.access + c.linefail;
  /* Booked in the sense the tile means it: a slot exists or the visit already
     happened. An activated order was booked first. */
  c.booked = c.bkd + c.act;
  return c;
}

/**
 * One order, as the partner who is delivering it reads it.
 *
 * IDENTITY IS HERE. Address and FSA are in this shape and in no other. The
 * member's user id is not: the partner delivers to an address under a consent,
 * and has no business holding a platform identifier for the household.
 */
function publicOrder(row) {
  return {
    key: row.order_key,
    orderNo: row.order_no || null,
    campaignId: row.campaign_id,
    state: STATES.indexOf(row.state) >= 0 ? row.state : 'acc',
    fsa: row.fsa || null,
    address: row.address_line || null,
    slotAt: ms(row.slot_at),
    note: row.note || null,
    releaseReason: row.release_reason || null,
    /* The speed this household accepted, and the book price it accepted at.
       Without the tier the partner books a visit without knowing what to
       install. Null on an order that predates the price book. */
    tier: row.tier || null,
    price: row.price || null,
    activatedAt: ms(row.activated_at),
    disputeState: row.dispute_state || null,
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
  };
}

/** Exception first, then oldest first inside a state. Stable. */
function sortForBoard(rows) {
  return (rows || []).slice().sort((a, b) => {
    const ra = RANK[a.state] == null ? 9 : RANK[a.state];
    const rb = RANK[b.state] == null ? 9 : RANK[b.state];
    if (ra !== rb) return ra - rb;
    return (toInt(a.ROWID) || 0) - (toInt(b.ROWID) || 0);
  });
}

module.exports = {
  ORDERS, ORDER_COLS, ORDER_COLS_V2, ORDER_COLS_V3,
  STATES, EXCEPTIONS, RELEASE_REASONS, TRANSITIONS, RANK,
  orderNo, readFsa, readAddress, readSlot, requireTransition,
  rowsForCampaign, rowsForOrg, findByKey, findAnyByKey,
  create, move,
  counts, publicOrder, sortForBoard,
};
