'use strict';

/**
 * The only place in the auth function that talks to the Catalyst Data Store.
 *
 * It exists to own three things that are each a footgun on their own:
 *
 *  1. DATE FORMAT. Catalyst wants `YYYY-MM-DD HH:MM:SS` in UTC and rejects
 *     ISO-8601, so `new Date().toISOString()`, the thing every hand reaches
 *     for, fails. There is exactly one formatter here and no call site is
 *     allowed its own.
 *
 *  2. ZCQL INJECTION. `executeZCQLQuery` takes a raw string. There is no
 *     parameter binding, no prepared statement, nothing. Auth queries carry
 *     user-supplied emails and tokens, so this is the single highest-risk
 *     surface in the function. See the note on `lit()` for why this module
 *     validates rather than escapes.
 *
 *  3. RESULT SHAPE. ZCQL returns `[{ TableName: {...cols} }]`, not `[{...cols}]`.
 *     Unwrapping it at every call site is how one of them eventually forgets.
 */

const catalyst = require('zcatalyst-sdk-node');

/** Per-request, not per-process: the SDK binds to the request's credentials. */
function app(req) {
  return catalyst.initialize(req);
}

/* ------------------------------------------------------------------ *
 * 1. Dates
 * ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

/** Date -> `YYYY-MM-DD HH:MM:SS` in UTC, the only format Catalyst accepts. */
function toDb(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError('toDb() received an invalid date');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Now, in Catalyst's format. */
const nowDb = () => toDb(new Date());

/** Now + n milliseconds, in Catalyst's format. For every `expires_at`. */
const inMsDb = (ms) => toDb(new Date(Date.now() + ms));

/**
 * `YYYY-MM-DD HH:MM:SS` -> Date. Catalyst hands the value back without a zone
 * marker even though it is UTC, so `new Date(s)` would read it as local time
 * and silently shift every expiry check by the server's offset.
 */
function fromDb(value) {
  if (!value) return null;
  const s = String(value).trim().replace(' ', 'T');
  const d = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Has a stored `expires_at` passed? Absent/unparseable counts as expired. */
const isExpired = (value, at = Date.now()) => {
  const d = fromDb(value);
  return d === null || d.getTime() <= at;
};

/* ------------------------------------------------------------------ *
 * 2. ZCQL literals
 * ------------------------------------------------------------------ */

/**
 * Every value this system puts in a WHERE clause is machine-shaped: a UUID, a
 * hex digest, a base64url token, an email, or a short fixed enum. None of them
 * can legitimately contain a quote, a backslash or a control character.
 *
 * So this VALIDATES instead of escaping, and throws on anything outside the
 * charset. That choice is deliberate. Escaping requires knowing exactly how the
 * far end handles a backslash: SQL-standard doubling of `''` is undone by a
 * MySQL-style `\'`, and ZCQL's dialect is not documented on this point. A
 * whitelist needs no such knowledge to be correct.
 *
 * The consequence is that free-form text (a User-Agent, a JSON `detail` blob)
 * cannot be passed through here. It does not need to be: those values are only
 * ever written, and writes go through `insertRow`/`updateRow`, which take an
 * object and build no SQL at all.
 */
const SAFE_LITERAL = /^[A-Za-z0-9@._:+/=-]{1,320}$/;

function lit(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('lit() received a non-finite number');
    return String(value);
  }
  const s = String(value);
  if (!SAFE_LITERAL.test(s)) {
    // Deliberately does not echo the value: this throws on attacker-controlled
    // input, and the message reaches the logs.
    throw new TypeError(`lit() rejected a value of length ${s.length} outside the safe charset`);
  }
  return `'${s}'`;
}

/** Table and column names are ours, never user input, but assert that. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function ident(name) {
  if (!SAFE_IDENT.test(String(name))) throw new TypeError(`unsafe identifier: ${name}`);
  return String(name);
}

/* ------------------------------------------------------------------ *
 * 3. Queries
 * ------------------------------------------------------------------ */

/**
 * ZCQL refuses any query whose LIMIT exceeds 300, and it refuses with a 400,
 * rather than quietly returning the first 300. Verified against the live
 * environment: `LIMIT 500` errors with "ZCQL CANNOT HAVE MORE THAN 300 ROWS in
 * LIMIT", `LIMIT 300` succeeds.
 *
 * The dangerous version of this is the query with NO limit, which does not
 * error: it just stops at the ceiling. Anything that must see every matching
 * row has to paginate, or it will silently do a partial job. `queryAll` exists
 * so that is not left to each call site to remember.
 */
const MAX_ROWS = 300;

/** Run ZCQL and unwrap `[{ Table: {...} }]` into `[{...}]`. */
async function query(catalystApp, table, sql) {
  const rows = await catalystApp.zcql().executeZCQLQuery(sql);
  return (rows || []).map((r) => r[table] || r);
}

/**
 * Every row matching `where`, paginated past the 300-row ceiling.
 *
 * Pages by ROWID rather than by OFFSET. Offset paging over a table being
 * written to concurrently skips rows when earlier pages shift underneath it;
 * a strictly increasing cursor cannot. `guard` bounds the loop so a malformed
 * predicate degrades into a capped read instead of an infinite one.
 */
async function queryAll(catalystApp, table, columns, where, { pageSize = MAX_ROWS, maxPages = 50 } = {}) {
  const t = ident(table);
  const cols = ['ROWID', ...columns.filter((c) => c !== 'ROWID')].map(ident).join(', ');
  const out = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const cursorClause = cursor ? ` AND ROWID > ${lit(cursor)}` : '';
    const rows = await query(
      catalystApp, t,
      `SELECT ${cols} FROM ${t} WHERE ${where}${cursorClause} ORDER BY ROWID LIMIT ${pageSize}`
    );
    if (!rows.length) break;
    out.push(...rows);
    cursor = rows[rows.length - 1].ROWID;
    if (rows.length < pageSize) break;
  }
  return out;
}

/**
 * One row matching `column = value`, or null.
 *
 * `columns` defaults to `*`. Pass an explicit list on hot paths: a projection
 * is cheaper, and naming the columns means a console-side rename fails loudly
 * here rather than yielding `undefined` three frames away.
 */
async function findBy(catalystApp, table, column, value, columns) {
  const t = ident(table);
  const projection = columns && columns.length ? columns.map(ident).join(', ') : '*';
  const rows = await query(
    catalystApp, t,
    `SELECT ${projection} FROM ${t} WHERE ${ident(column)} = ${lit(value)} LIMIT 1`
  );
  return rows[0] || null;
}

/** Insert. Object API: builds no SQL, so free-form text is safe here. */
function insertRow(catalystApp, table, row) {
  return catalystApp.datastore().table(ident(table)).insertRow(row);
}

/** Update. `row` must carry ROWID. */
function updateRow(catalystApp, table, row) {
  if (!row || !row.ROWID) throw new TypeError('updateRow() requires ROWID');
  return catalystApp.datastore().table(ident(table)).updateRow(row);
}

function deleteRow(catalystApp, table, rowId) {
  return catalystApp.datastore().table(ident(table)).deleteRow(rowId);
}

/**
 * Look up a single-use row and delete it in one call, returning what it held.
 *
 * This is the OAuth `state` check and nothing else should use it casually. The
 * row *is* the CSRF defence, so "found" and "consumed" have to be one step: two
 * steps leave a window in which a replayed callback finds the row still present.
 * A failed delete still returns null: better to reject a legitimate callback
 * than to accept a replayed one.
 */
async function takeOnce(catalystApp, table, column, value, columns) {
  const row = await findBy(catalystApp, table, column, value, columns);
  if (!row) return null;
  try {
    await deleteRow(catalystApp, table, row.ROWID);
  } catch {
    return null;
  }
  return row;
}

module.exports = {
  app,
  toDb, nowDb, inMsDb, fromDb, isExpired,
  lit, ident,
  query, queryAll, findBy, insertRow, updateRow, deleteRow, takeOnce,
  MAX_ROWS,
};
