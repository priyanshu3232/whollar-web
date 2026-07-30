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
  'updated_by', 'updated_at'];

const KINDS = Object.freeze(['planned', 'waitlist', 'forming', 'auction', 'closed', 'archived']);

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
    ROWID: row.ROWID,
  };
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
  const effective = list || CODE_CATALOG.map((c) => ({ ...c }));
  const result = {
    list: effective,
    byId: new Map(effective.map((c) => [c.id, c])),
    source,
  };
  memo = { at: now, result };
  return result;
}

module.exports = {
  TABLE, COLUMNS, KINDS, JOIN_STATUS, ID_RE, TRANSITIONS, CODE_CATALOG,
  load, invalidate, fromRow, isTruthyDb,
};
