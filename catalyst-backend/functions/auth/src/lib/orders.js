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
const { badRequest, AppError } = require('./errors');

const ORDERS = 'provider_orders';

/* Mirrors partner/core/contract.js ORDER_STATE. */
const STATES = Object.freeze(['acc', 'bkd', 'act', 'rel', 'noshow', 'access', 'linefail']);
const EXCEPTIONS = Object.freeze(['noshow', 'access', 'linefail']);

/* Mirrors RELEASE_REASON. An enum because it feeds a figure. */
const RELEASE_REASONS = Object.freeze([
  'no_plant', 'building_access', 'speed_tier_unavailable', 'household_cancelled',
  /* Written by the household's own pass before confirmations locked (the
     dashboard, never a partner): accepted, then withdrawn. */
  'household_passed',
]);
/* What a PARTNER may release with. The household's own reason is written by
   the pass route alone; a partner picking it would file its own inability to
   serve as the household's withdrawal, on the figure that exists to catch
   exactly that. */
const PARTNER_RELEASE_REASONS = Object.freeze(RELEASE_REASONS.filter((r) => r !== 'household_passed'));

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
  /* 'bkd' to 'bkd' is a rebook. Every accept now lands booked with the day
     the household picked, and the partner's crew has to be able to move it
     without logging a visit that never happened. */
  bkd: ['bkd', 'act', 'rel', 'noshow', 'access', 'linefail'],
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
/* THE HOUSEHOLD'S MOBILE NUMBER (create-tables.md section 31). Given at
   acceptance so the installer can reach the household on the day, and given
   for that and nothing else. Absent on a table created before the booking
   step, which reads as "reach them through the concierge". */
const ORDER_COLS_V4 = Object.freeze(ORDER_COLS_V3.concat(['phone']));
const ORDER_COL_LISTS = Object.freeze([ORDER_COLS_V4, ORDER_COLS_V3, ORDER_COLS_V2, ORDER_COLS]);

/**
 * THE BOOKING WINDOW. A household books its install at the moment it accepts,
 * on any day from tomorrow through the fifteenth day out, in one of three
 * arrival windows. The dashboard draws the same fifteen days from the
 * serverTime it captured, never from a bare Date.now(), and this file is what
 * refuses a day outside them. dashboard.html SLOTDAYS / SLOTWINS mirror these
 * two constants, wire value for wire value: if you change one, change both.
 */
const SLOT_WINDOW_DAYS = 15;
const SLOT_WINDOWS = Object.freeze({
  am: Object.freeze({ label: 'Morning, 8am to 12pm', hour: 8 }),
  pm: Object.freeze({ label: 'Afternoon, 12pm to 4pm', hour: 12 }),
  eve: Object.freeze({ label: 'Evening, 4pm to 7pm', hour: 16 }),
});
const DAY_MS = 24 * 60 * 60 * 1000;

/* The states in which an order holds an appointment. A released household
   gives its slot back; an exception keeps the date it was booked for, which is
   the date the crew went out on. */
const HOLDS_SLOT = Object.freeze(['bkd', 'act', 'noshow', 'access', 'linefail']);

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

/**
 * A mobile number the installer can reach the household on, normalised to +1
 * and ten digits. North American numbers only: this service installs lines in
 * Canadian postal areas, and a number the crew cannot dial on the day is a
 * no-show waiting to happen. Free text never reaches lib/datastore.js lit():
 * it is written through the object API and read back by key.
 */
function readPhone(value) {
  const digits = String(value == null ? '' : value).replace(/\D+/g, '');
  const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (ten.length !== 10 || !/^[2-9]/.test(ten) || !/^[2-9]/.test(ten.slice(3))) {
    throw badRequest('Enter the mobile number your installer can reach you on, ten digits.');
  }
  return '+1' + ten;
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

/**
 * A slot picked by a household at acceptance: readSlot, then inside the
 * fifteen-day booking window. One day of slack past the fifteenth so a
 * household on the west coast booking the last evening window is not refused
 * by a clock that runs in UTC.
 */
function readBookingSlot(value, now) {
  const n = readSlot(value, now);
  if (n > now + (SLOT_WINDOW_DAYS + 1) * DAY_MS) {
    throw badRequest(`Pick an install day within the next ${SLOT_WINDOW_DAYS} days.`);
  }
  return n;
}

/** One of the three arrival windows, by key. */
function readSlotWindow(value) {
  const k = String(value == null ? '' : value).trim();
  if (!SLOT_WINDOWS[k]) throw badRequest('Pick a morning, afternoon or evening arrival window.');
  return k;
}

/* ------------------------------------------------------------------ *
 * Weekly capacity
 *
 * A partner states installs per week at the roster gate, and the console has
 * always told them it is "shown to households when they book a slot". These
 * three functions are what make that sentence true: a week is a Monday to
 * Sunday bucket in UTC, an appointment in any HOLDS_SLOT state counts against
 * it, and a week at capacity is refused at accept and greyed on the picker.
 * UTC on purpose: the bucket only has to be the same on both ends. A slot is
 * a local morning, noon or afternoon, which is the same UTC date in every
 * zone within twelve hours, and the dashboard keys each day on local noon
 * for the same reason.
 * ------------------------------------------------------------------ */

/** Monday 00:00 UTC of the week holding `at`. */
function weekStart(at) {
  const d = new Date(at);
  const back = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}

/* A slot is a LOCAL morning, noon or 4pm, stored as the instant. Every
   Canadian zone sits between UTC-2:30 and UTC-8, so a 4pm Pacific slot is
   midnight UTC the next day and would fall in the wrong week bucket. Taking
   nine hours off before bucketing puts every local slot hour (8, 12, 16) back
   on its local calendar day in every zone, which is the day the household
   picked and the day the dashboard greys. */
const LOCAL_DAY_SLACK_MS = 9 * 60 * 60 * 1000;
const slotWeek = (slot) => weekStart(slot - LOCAL_DAY_SLACK_MS);

/** How many of these orders hold an appointment in the week starting `w`. */
function bookedInWeekStart(rows, w) {
  return (rows || []).filter((r) => {
    if (HOLDS_SLOT.indexOf(r.state) < 0) return false;
    const slot = ms(r.slot_at);
    return Boolean(slot) && slotWeek(slot) === w;
  }).length;
}

/** How many of these orders hold an appointment in the week of slot `at`. */
function bookedInWeek(rows, at) {
  return bookedInWeekStart(rows, slotWeek(at));
}

/** The week starts inside the booking window from `now` that are at capacity. */
function fullWeeks(rows, capacity, now) {
  const cap = toInt(capacity);
  if (!cap || cap < 1) return [];
  const out = [];
  const end = now + (SLOT_WINDOW_DAYS + 1) * DAY_MS;
  for (let w = weekStart(now); w <= end; w += 7 * DAY_MS) {
    if (bookedInWeekStart(rows, w) >= cap) out.push(w);
  }
  return out;
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
 *
 * AN ACCEPT WITH A SLOT IS A BOOKING. The household picks its install day and
 * arrival window on the confirm screen, so the order lands on the partner's
 * board already `bkd`, with the slot and the mobile number the crew will need.
 * An accept without a slot (an older client) lands as `acc`, exactly as
 * before, and the partner books it by phone.
 */
async function create(catalystApp, {
  campaignId, orgId, memberUserId, fsa, address, phone, slotAt, slotWindow, tier, price, at,
}) {
  const key = `${campaignId}:${memberUserId}`.slice(0, 200);
  const existing = await findAnyByKey(catalystApp, key);
  if (existing) return existing;

  const stamp = datastore.toDb(new Date(at || Date.now()));
  const booked = Boolean(slotAt);
  const win = SLOT_WINDOWS[slotWindow];
  const base = {
    order_key: key,
    order_no: orderNo(),
    campaign_id: campaignId,
    org_id: orgId,
    member_user_id: memberUserId,
    state: booked ? 'bkd' : 'acc',
    fsa: fsa || null,
    address_line: address,
    slot_at: booked ? datastore.toDb(new Date(slotAt)) : null,
    note: booked ? `Booked by the household at acceptance: ${win ? win.label.toLowerCase() : 'arrival window'}.` : null,
    created_at: stamp,
    updated_at: stamp,
  };
  const priced = { tier: tier || null, price: price || null };
  /* Widest first, same fallback ladder as the reads. A column may not exist
     yet, and an order without it is far better than a household whose
     acceptance failed: the partner is told which cohort and which household,
     and the rest is recoverable. WHEN THE PHONE COLUMN IS MISSING THE NUMBER
     RIDES IN THE NOTE, which the same partner reads on the same row: losing
     it silently would put a crew at a door with no way to call ahead. Each
     fall is logged, because the other cause of a refused insert is a real one. */
  const attempts = [
    Object.assign({ phone: phone || null }, priced, base),
    Object.assign({}, priced, base, phone && booked
      ? { note: `${base.note} Mobile ${phone}.`.slice(0, 200) } : {}),
    Object.assign({}, base, phone && booked
      ? { note: `${base.note} Mobile ${phone}.`.slice(0, 200) } : {}),
  ];
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      /* eslint-disable-next-line no-await-in-loop */
      await datastore.insertRow(catalystApp, ORDERS, attempts[i]);
      break;
    } catch (err) {
      console.warn(JSON.stringify({
        at: 'orders.create', campaign: campaignId, attempt: i + 1,
        error: String((err && err.message) || err).slice(0, 200),
      }));
      if (i === attempts.length - 1) throw err;
    }
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
  invalidateConfirmed(row.campaign_id, row.org_id);
  const p = Object.assign({}, patch || {});
  /* Until the phone column exists the household's number rides in the note
     (see create). A move that rewrites the note must carry it forward, or
     the first rebook leaves a crew at a door with no way to call ahead. */
  const riding = String(row.note || '').match(/Mobile \+1\d{10}\./);
  if (p.note && riding && !row.phone && !/Mobile \+1\d{10}/.test(p.note)) {
    p.note = `${p.note} ${riding[0]}`.slice(0, 200);
  }
  return datastore.updateRow(catalystApp, ORDERS, Object.assign({
    ROWID: row.ROWID,
    state: to,
    updated_at: datastore.toDb(new Date(at || Date.now())),
  }, p));
}

/**
 * The household changed its pick before confirmations locked: the ONE order
 * row moves to the new tier, price and partner, by ROWID. Never a second row
 * (order_key is the household on the cohort, and two rows would be two
 * households to two partners) and never past 'acc': a booked install is a
 * partner's calendar, and moving the org under it strands the booking. The
 * route decides the deadline; this checks the state and writes.
 */
async function changePick(catalystApp, row, { orgId, tier, price, phone, slotAt, slotWindow, at }) {
  /* 'acc' and 'bkd' are both the household's own doing: an accept books its
     slot at the same moment, so a fresh order sits in 'bkd' with the day the
     household picked. Anything past that is the partner's calendar. */
  if (!row || (row.state !== 'acc' && row.state !== 'bkd')) {
    throw new AppError('CONFLICT', 'Your installer has already been out for this. Changes now go through your concierge.', {
      logDetail: `changePick refused state=${row && row.state}`,
    });
  }
  const before = { orgId: row.org_id, tier: row.tier || null, price: row.price || null };
  invalidateConfirmed(row.campaign_id, row.org_id);
  invalidateConfirmed(row.campaign_id, orgId);
  /* THE NEW APPOINTMENT TRAVELS WITH THE NEW PARTNER. The household picked a
     day, a window and gave a number for THIS partner; leaving the old
     partner's day on the row would hand the new one a visit nobody chose.
     Same column ladder as create: phone column first, number in the note
     when it is missing. */
  const booked = Boolean(slotAt);
  const win = SLOT_WINDOWS[slotWindow];
  const base = {
    ROWID: row.ROWID,
    org_id: orgId,
    tier: tier || null,
    price: price || null,
    state: booked ? 'bkd' : row.state,
    slot_at: booked ? datastore.toDb(new Date(slotAt)) : (row.slot_at || null),
    note: booked ? `Booked by the household at acceptance: ${win ? win.label.toLowerCase() : 'arrival window'}.` : (row.note || null),
    updated_at: datastore.toDb(new Date(at || Date.now())),
  };
  const attempts = phone
    ? [Object.assign({ phone }, base), Object.assign({}, base, { note: `${base.note} Mobile ${phone}.`.slice(0, 200) })]
    : [base];
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      /* eslint-disable-next-line no-await-in-loop */
      await datastore.updateRow(catalystApp, ORDERS, attempts[i]);
      break;
    } catch (err) {
      console.warn(JSON.stringify({
        at: 'orders.changePick', key: row.order_key, attempt: i + 1,
        error: String((err && err.message) || err).slice(0, 200),
      }));
      if (i === attempts.length - 1) throw err;
    }
  }
  const after = await findAnyByKey(catalystApp, row.order_key);
  if (!after || String(after.org_id) !== String(orgId) || (after.tier || null) !== (tier || null)) {
    throw new AppError('SERVER_ERROR', 'The change did not record. Nothing has moved; try again.', {
      logDetail: `changePick readback mismatch key=${row.order_key}`,
    });
  }
  return { row: after, before };
}

/**
 * The household passed after accepting, before confirmations locked. The
 * order releases with a reason the partner can read; the row is kept, as
 * every order is, because a partner's board and statement are built from it.
 */
function releaseByHousehold(catalystApp, row, at) {
  requireTransition(row.state, 'rel');
  return move(catalystApp, row, 'rel', { release_reason: 'household_passed' }, at);
}

/* ------------------------------------------------------------------ *
 * The confirmed count
 * ------------------------------------------------------------------ */

/* Same shape as lib/cohorts.js seatCount: a Map memo, 60 seconds, keyed on
   the pair, invalidated by every write to that pair on this instance. The
   count is JS over this org's rows on this cohort, the read every board
   already does, and never a stored counter. */
const CONFIRMED_MS = 60 * 1000;
const confirmedMemo = new Map();

function invalidateConfirmed(campaignId, orgId) {
  if (campaignId && orgId) confirmedMemo.delete(`${campaignId}:${orgId}`);
  else if (campaignId) {
    for (const k of Array.from(confirmedMemo.keys())) {
      if (k.startsWith(`${campaignId}:`)) confirmedMemo.delete(k);
    }
  } else confirmedMemo.clear();
}

/**
 * Households confirmed to one partner on one cohort: every order not
 * released, by tier. -> { confirmed, byTier: {tier: n}, live }
 */
async function confirmedCount(catalystApp, campaignId, orgId) {
  const key = `${campaignId}:${orgId}`;
  const hit = confirmedMemo.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CONFIRMED_MS) return hit.count;
  const rows = await rowsForCampaign(catalystApp, orgId, campaignId);
  const count = { confirmed: 0, byTier: {}, live: rows !== null };
  (rows || []).forEach((r) => {
    if (r.state === 'rel') return;
    count.confirmed += 1;
    const t = r.tier || '';
    count.byTier[t] = (count.byTier[t] || 0) + 1;
  });
  confirmedMemo.set(key, { at: now, count });
  return count;
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
    /* The number the household gave for the install, in the same shape and
       to the same reader as the address, and to nobody else. */
    phone: row.phone || null,
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
  ORDERS, ORDER_COLS, ORDER_COLS_V2, ORDER_COLS_V3, ORDER_COLS_V4,
  STATES, EXCEPTIONS, RELEASE_REASONS, PARTNER_RELEASE_REASONS, TRANSITIONS, RANK,
  SLOT_WINDOW_DAYS, SLOT_WINDOWS, HOLDS_SLOT,
  orderNo, readFsa, readAddress, readPhone, readSlot, readBookingSlot, readSlotWindow,
  requireTransition,
  weekStart, bookedInWeek, fullWeeks,
  rowsForCampaign, rowsForOrg, findByKey, findAnyByKey,
  create, move, changePick, releaseByHousehold,
  confirmedCount, invalidateConfirmed,
  counts, publicOrder, sortForBoard,
};
