'use strict';

/**
 * The campaign catalog, promoted from a code constant to a table — with the
 * code constant kept as the fallback.
 *
 * `routes/campaigns.js` used to hold the catalog as `const CATALOG`, which was
 * right while campaigns changed only by deploy. The admin console exists to
 * make "open bidding on Windsor" an ops decision *without* a deploy, so the
 * catalog now lives in the `campaigns` table — read here, memoized for 60
 * seconds, and **falling back to the code catalog whenever the table is
 * missing or unreadable**. Day one before the table exists, the site behaves
 * exactly as it did yesterday; the console's "import defaults" seeds the
 * table with these same rows.
 *
 * `kind` is the lifecycle:
 *
 *   planned → waitlist → forming → auction → closed → archived
 *
 * Members may join while forming/waitlist/planned (JOIN_STATUS, unchanged);
 * `auction` locks joins and — with `bidding_open` and the global
 * `bidding_enabled` flag — opens the partner bid window; `closed` shows
 * results; `archived` disappears from every non-admin surface.
 */

const datastore = require('./datastore');

const TABLE = 'campaigns';
const COLUMNS = ['campaign_id', 'region', 'sub', 'kind', 'target',
  'seed_members', 'seed_households', 'bidding_open', 'sort_order',
  'updated_by', 'updated_at',
  /* The auction calendar. See STAGES below. */
  'announce_at', 'bidding_opens_at', 'bidding_closes_at', 'offers_at',
  'decision_at', 'switch_window_at', 'reconcile_at'];

const KINDS = Object.freeze(['planned', 'waitlist', 'forming', 'auction', 'closed', 'archived']);

/** The seven dates that make up a cohort's calendar, in order. */
const DATE_COLUMNS = Object.freeze(['announce_at', 'bidding_opens_at', 'bidding_closes_at',
  'offers_at', 'decision_at', 'switch_window_at', 'reconcile_at']);

/** What joining each kind means. Absent = not joinable. Unchanged semantics. */
const JOIN_STATUS = Object.freeze({ forming: 'joined', waitlist: 'waitlist', planned: 'waitlist' });

/** Slug charset: campaign ids travel in URLs and ZCQL literals. */
const ID_RE = /^[a-z0-9-]{3,64}$/;

/**
 * Legal lifecycle moves. Forward along the line, plus the two operational
 * reversals that real life needs: reopening a closed auction that was closed
 * by mistake, and pulling an auction back to forming if it went up early.
 * `archived` is terminal except for un-archiving back to `closed`.
 */
const TRANSITIONS = Object.freeze({
  planned:  ['waitlist', 'forming', 'archived'],
  waitlist: ['forming', 'planned', 'archived'],
  forming:  ['auction', 'waitlist', 'archived'],
  auction:  ['closed', 'forming'],
  closed:   ['archived', 'auction'],
  archived: ['closed'],
});

/** The pre-table catalog, verbatim from routes/campaigns.js. The fallback. */
const CODE_CATALOG = Object.freeze([
  { id: 'kingston-west',     region: 'Kingston West',     sub: 'Autumn cohort', kind: 'auction',  target: null, seedMembers: 64, seedHouseholds: 64,  biddingOpen: true,  sortOrder: 1 },
  { id: 'london-east',       region: 'London East',       sub: 'Autumn cohort', kind: 'forming',  target: 100,  seedMembers: 61, seedHouseholds: 112, biddingOpen: false, sortOrder: 2 },
  { id: 'london-north',      region: 'London North',      sub: 'Winter cohort', kind: 'planned',  target: 100,  seedMembers: 61, seedHouseholds: 100, biddingOpen: false, sortOrder: 3 },
  { id: 'chatham-kent',      region: 'Chatham-Kent',      sub: 'First cohort',  kind: 'waitlist', target: 100,  seedMembers: 37, seedHouseholds: 100, biddingOpen: false, sortOrder: 4 },
  { id: 'windsor-core',      region: 'Windsor',           sub: 'Winter cohort', kind: 'waitlist', target: 100,  seedMembers: 52, seedHouseholds: 87,  biddingOpen: false, sortOrder: 5 },
  { id: 'hamilton-mountain', region: 'Hamilton Mountain', sub: 'Winter cohort', kind: 'auction',  target: null, seedMembers: 58, seedHouseholds: 58,  biddingOpen: true,  sortOrder: 6 },
]);

/** Catalyst booleans come back in several spellings; read them all. */
const isTruthyDb = (v) => v === true || v === 'true' || v === 1 || v === '1';

const toInt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** Table row -> the shape routes have always consumed. */
function fromRow(row) {
  return {
    id: row.campaign_id,
    region: row.region,
    sub: row.sub || '',
    kind: KINDS.includes(row.kind) ? row.kind : 'planned',
    target: toInt(row.target),
    seedMembers: toInt(row.seed_members) || 0,
    seedHouseholds: toInt(row.seed_households) || 0,
    biddingOpen: isTruthyDb(row.bidding_open),
    sortOrder: toInt(row.sort_order) || 0,
    /* Epoch ms, converted here so nothing downstream ever meets Catalyst's
       zone-less date string. Null where the column is absent, which is the
       normal state for a campaign whose calendar has not been set. */
    dates: DATE_COLUMNS.reduce((o, c) => {
      const d = datastore.fromDb(row[c]);
      o[c] = d ? d.getTime() : null;
      return o;
    }, {}),
    ROWID: row.ROWID,
  };
}

/* ------------------------------------------------------------------ *
 * Stage: derived on read, never stored, never computed by a browser
 * ------------------------------------------------------------------ */

/**
 * The partner-facing stage of a cohort auction.
 *
 * DERIVED, NOT STORED, AND NOT SCHEDULED. There is no cron in this stack, and
 * a serverless schedule can fire late, fire twice, or not fire. A pure
 * function of (campaign, now) cannot be any of those: the answer is correct
 * the instant it is asked, and it is testable without a database.
 *
 * DISPLAY ONLY. This does NOT authorise anything. `kind` and `bidding_open`
 * remain the gate, checked in requireBiddingOpen. Keeping the two apart is
 * deliberate: if wall-clock drift or a mistyped date could open bidding, then
 * a clock problem becomes a security problem. The worst a wrong date can do
 * here is show the wrong label.
 *
 * The client is sent this value and must not recompute it. A browser clock a
 * few minutes fast would otherwise disagree with the server about whether a
 * bid window is open, which is the one thing a sealed auction cannot afford.
 */
const STAGES = Object.freeze(['planned', 'announced', 'open', 'closing', 'offers_out', 'decided']);

/** How close to the close a cohort is called 'closing' and shows a countdown. */
const CLOSING_WINDOW_MS = 24 * 60 * 60 * 1000;

function stageOf(campaign, now = Date.now()) {
  const d = (campaign && campaign.dates) || {};

  /* An admin decision outranks the calendar in both directions. A campaign
     that is not an auction is not in an auction stage, whatever its dates
     say, and a closed one is decided even if its decision date is ahead. */
  if (campaign && (campaign.kind === 'closed' || campaign.kind === 'archived')) return 'decided';
  if (campaign && campaign.kind !== 'auction') {
    return d.announce_at && now >= d.announce_at ? 'announced' : 'planned';
  }

  if (d.decision_at && now >= d.decision_at) return 'decided';
  if (d.bidding_closes_at && now >= d.bidding_closes_at) return 'offers_out';
  if (d.bidding_closes_at && d.bidding_closes_at - now <= CLOSING_WINDOW_MS) {
    /* Inside the last day, but only once bidding has actually opened. */
    if (!d.bidding_opens_at || now >= d.bidding_opens_at) return 'closing';
  }
  if (d.bidding_opens_at && now >= d.bidding_opens_at) return 'open';
  if (d.announce_at && now >= d.announce_at) return 'announced';

  /* No date has placed us yet. Decide from whatever evidence exists, and be
     careful about the difference between "we know bidding has not started"
     and "we have no date that says either way".

     Only a date in the FUTURE is evidence of not having started. A partial
     calendar carrying just a close date says nothing about opening, and
     falling through to 'planned' there would label a cohort planned while its
     own admin flag has bidding open, which is the one combination a partner
     would reasonably read as "nothing to do here". */
  const notStartedYet = (d.bidding_opens_at && now < d.bidding_opens_at)
                     || (d.announce_at && now < d.announce_at);
  if (notStartedYet) return 'planned';

  /* Nothing dated the opening. bidding_open is the authority in any case. */
  return campaign && campaign.biddingOpen ? 'open' : 'announced';
}

const STAGE_LABEL = Object.freeze({
  planned: 'Planned', announced: 'Announced', open: 'Open',
  closing: 'Closing', offers_out: 'Offers out', decided: 'Decided',
});

/** The next calendar moment a partner is waiting on, for the countdown. */
function nextTransition(campaign, now = Date.now()) {
  const d = (campaign && campaign.dates) || {};
  for (const c of DATE_COLUMNS) {
    if (d[c] && d[c] > now) return { at: d[c], what: c };
  }
  return null;
}

/** What a route sends. Stage, its label, and the next moment. */
function publicStage(campaign, now = Date.now()) {
  const stage = stageOf(campaign, now);
  return { stage, stageLabel: STAGE_LABEL[stage], next: nextTransition(campaign, now) };
}

/* ------------------------------------------------------------------ *
 * Load (memoized, code fallback)
 * ------------------------------------------------------------------ */

const MEMO_MS = 60 * 1000;
let memo = { at: 0, result: null };

function invalidate() { memo = { at: 0, result: null }; }

/**
 * The catalog every route reads. -> { list, byId, source: 'table' | 'code' }
 *
 * An EMPTY table also falls back to code: an operator who created the table
 * but has not imported or created any campaign has not yet said "the table
 * is now the truth", and an empty member dashboard would say it for them.
 *
 * NOTE FOR ANYONE ADDING TO THIS: the ROWS are memoized for 60 seconds, the
 * STAGE is not, and it must stay that way. stageOf() is a pure function that
 * routes call per request. Moving it into fromRow() would look tidier and
 * would make a cohort's stage up to a minute stale, which is wrong in exactly
 * the minute that matters, the one before bidding closes.
 */
async function load(catalystApp, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && memo.result && now - memo.at < MEMO_MS) return memo.result;

  let list = null;
  try {
    const rows = await datastore.queryAll(catalystApp, TABLE, COLUMNS, 'ROWID > 0');
    if (rows && rows.length) {
      list = rows.map(fromRow).sort((a, b) =>
        (a.sortOrder - b.sortOrder) || String(a.id).localeCompare(String(b.id)));
    }
  } catch {
    list = null;
  }

  const source = list ? 'table' : 'code';
  /* The code fallback carries an empty calendar so every consumer sees the
     same shape. stageOf() then answers from `kind` and `bidding_open` alone,
     which is exactly the pre-calendar behaviour. */
  const effective = list || CODE_CATALOG.map((c) => ({ ...c, dates: {} }));
  const result = {
    list: effective,
    byId: new Map(effective.map((c) => [c.id, c])),
    source,
  };
  memo = { at: now, result };
  return result;
}

module.exports = {
  TABLE, COLUMNS, DATE_COLUMNS, KINDS, JOIN_STATUS, ID_RE, TRANSITIONS, CODE_CATALOG,
  STAGES, STAGE_LABEL, CLOSING_WINDOW_MS,
  load, invalidate, fromRow, isTruthyDb,
  stageOf, nextTransition, publicStage,
};
