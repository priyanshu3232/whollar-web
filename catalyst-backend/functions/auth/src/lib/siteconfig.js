'use strict';

/**
 * Site configuration: the values the admin console edits and the site renders.
 *
 * The `site_config` table is the source of truth; `DEFAULTS` below is what the
 * site believed before the table existed, and what it falls back to whenever
 * the table is missing or unreadable. That fallback is the same contract
 * `campaign_members` set: the console being down must never take the
 * marketing site down.
 *
 * Values are stored JSON-encoded in a Text column, typed by `value_type`, so
 * a boolean is `true`, not `"true"`. The console renders the right editor
 * and the reader gets the right type back without guessing.
 *
 * Reads are memoized in-process for 60 seconds. A config flip propagates in
 * ≤1 minute without adding a ZCQL read to every request that checks a flag.
 */

const datastore = require('./datastore');

const TABLE = 'site_config';
const COLUMNS = ['config_key', 'value', 'value_type', 'published', 'description',
  'updated_by', 'updated_at'];

const TYPES = Object.freeze(['string', 'number', 'boolean', 'json']);

/** Key charset: these travel in URLs and ZCQL literals. */
const KEY_RE = /^[a-z0-9_]{1,64}$/;

/**
 * What the site believed before the table existed. Every key the marketing
 * pages or dashboards read should exist here, so deleting the table (or a
 * row) degrades to yesterday's behaviour rather than to `undefined`.
 */
const DEFAULTS = Object.freeze({
  bidding_enabled: {
    value: true, type: 'boolean', published: true,
    description: 'The global kill switch. When off, no bid can be placed on any campaign.',
  },
  membership_price: {
    value: 149, type: 'number', published: true,
    description: 'Annual membership, rendered on the marketing site and at checkout.',
  },
  default_switch_threshold: {
    value: 60, type: 'number', published: true,
    description: 'Households a forming campaign needs before it can go to auction.',
  },
  banner_notice: {
    value: '', type: 'string', published: true,
    description: 'Site-wide notice strip. Leave empty to hide the strip entirely.',
  },
  waitlist_open: {
    value: true, type: 'boolean', published: true,
    description: 'Whether new households can join a waitlist campaign.',
  },
  provider_signups_open: {
    value: true, type: 'boolean', published: true,
    description: 'Whether new companies can start a partner application.',
  },
});

/* ------------------------------------------------------------------ *
 * Typing
 * ------------------------------------------------------------------ */

/**
 * Validate a raw value against a declared type and return the canonical
 * JS value, or throw a TypeError naming what was wrong. The console calls
 * this before writing, so a typo'd value never lands in the table.
 */
function coerce(valueType, raw) {
  switch (valueType) {
    case 'string': {
      if (typeof raw !== 'string') throw new TypeError('value must be a string');
      return raw.slice(0, 5000);
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw new TypeError('value must be a finite number');
      return n;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new TypeError('value must be true or false');
    }
    case 'json': {
      // Accept an object/array directly, or a JSON string; round-trip either
      // way so what is stored is exactly what parses back.
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (obj === null || typeof obj !== 'object') {
        throw new TypeError('value must be a JSON object or array');
      }
      const s = JSON.stringify(obj);
      if (s.length > 20000) throw new TypeError('value is too large');
      return obj;
    }
    default:
      throw new TypeError(`value_type must be one of ${TYPES.join(' | ')}`);
  }
}

/** Stored string -> typed value. A row that fails to parse yields null. */
function parseStored(row) {
  try { return JSON.parse(row.value); } catch { return undefined; }
}

/* ------------------------------------------------------------------ *
 * Reads (memoized)
 * ------------------------------------------------------------------ */

const MEMO_MS = 60 * 1000;
let memo = { at: 0, rows: undefined }; // rows: array | null (unreadable) | undefined (never read)

function invalidate() { memo = { at: 0, rows: undefined }; }

/**
 * Every config row, or null when the table cannot be read: the same
 * "no rows" vs "no table" distinction routes/campaigns.js draws, for the
 * same reason.
 */
async function allRows(catalystApp, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && memo.rows !== undefined && now - memo.at < MEMO_MS) return memo.rows;
  let rows;
  try {
    rows = await datastore.queryAll(catalystApp, TABLE, COLUMNS, 'ROWID > 0');
  } catch {
    rows = null;
  }
  memo = { at: now, rows };
  return rows;
}

/**
 * The effective value of one key: table row if present and parseable,
 * shipped default otherwise. Unknown keys return undefined.
 */
async function getValue(catalystApp, key) {
  const rows = await allRows(catalystApp);
  const row = rows ? rows.find((r) => r.config_key === key) : null;
  if (row) {
    const v = parseStored(row);
    if (v !== undefined) return v;
  }
  return DEFAULTS[key] ? DEFAULTS[key].value : undefined;
}

/** Catalyst booleans come back in several spellings; read them all. */
const isTruthyDb = (v) => v === true || v === 'true' || v === 1 || v === '1';

/**
 * The published subset, defaults merged underneath: the body of
 * GET /public/config. Safe for anonymous eyes by construction: only keys
 * marked published, values only.
 */
async function publicConfig(catalystApp) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (def.published) out[key] = def.value;
  }
  const rows = await allRows(catalystApp);
  if (rows) {
    for (const row of rows) {
      const v = parseStored(row);
      if (v === undefined) continue;
      if (isTruthyDb(row.published)) out[row.config_key] = v;
      else delete out[row.config_key]; // an unpublished row hides its default too
    }
  }
  return out;
}

/**
 * The console's view: every key, table rows merged over defaults, each entry
 * saying where it came from. `stored:false` entries are the shipped defaults
 * an admin has not yet touched.
 */
async function adminView(catalystApp) {
  const rows = await allRows(catalystApp, { fresh: true });
  const byKey = new Map((rows || []).map((r) => [r.config_key, r]));
  const out = [];

  const keys = new Set([...Object.keys(DEFAULTS), ...byKey.keys()]);
  for (const key of [...keys].sort()) {
    const row = byKey.get(key);
    const def = DEFAULTS[key];
    if (row) {
      out.push({
        key,
        value: parseStored(row),
        value_type: row.value_type,
        published: isTruthyDb(row.published),
        description: row.description || (def ? def.description : ''),
        updated_by: row.updated_by || null,
        updated_at: row.updated_at || null,
        stored: true,
      });
    } else {
      out.push({
        key,
        value: def.value,
        value_type: def.type,
        published: def.published,
        description: def.description,
        updated_by: null,
        updated_at: null,
        stored: false,
      });
    }
  }
  return { live: rows !== null, entries: out };
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Create or update one key. Returns { before, after } for the audit row.
 * Throws TypeError on a bad key/type/value. The route maps that to a 400.
 */
async function setValue(catalystApp, { key, value, valueType, published, description, updatedBy }) {
  if (!KEY_RE.test(String(key || ''))) {
    throw new TypeError('key must be 1-64 chars of a-z, 0-9 and underscore');
  }
  const type = valueType || (DEFAULTS[key] ? DEFAULTS[key].type : 'string');
  if (!TYPES.includes(type)) throw new TypeError(`value_type must be one of ${TYPES.join(' | ')}`);
  const typed = coerce(type, value);

  const existing = await datastore.findBy(catalystApp, TABLE, 'config_key', key,
    ['ROWID', ...COLUMNS]);

  const fields = {
    value: JSON.stringify(typed),
    value_type: type,
    published: published === undefined
      ? (existing ? isTruthyDb(existing.published) : Boolean(DEFAULTS[key] && DEFAULTS[key].published))
      : Boolean(published),
    description: description !== undefined
      ? String(description || '').slice(0, 255)
      : (existing ? existing.description : (DEFAULTS[key] ? DEFAULTS[key].description : '')),
    updated_by: String(updatedBy || '').slice(0, 64),
    updated_at: datastore.nowDb(),
  };

  if (existing) {
    await datastore.updateRow(catalystApp, TABLE, { ROWID: existing.ROWID, config_key: key, ...fields });
  } else {
    await datastore.insertRow(catalystApp, TABLE, { config_key: key, ...fields });
  }
  invalidate();

  return {
    before: existing ? { value: parseStored(existing), published: isTruthyDb(existing.published) } : null,
    after: { value: typed, published: fields.published },
  };
}

module.exports = {
  TABLE, COLUMNS, TYPES, KEY_RE, DEFAULTS,
  coerce, getValue, publicConfig, adminView, setValue, allRows, invalidate,
};
