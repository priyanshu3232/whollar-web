'use strict';

/**
 * The canonical brand registry: the one list of consumer-facing names a
 * household could be offered service under, and the one place a flanker brand
 * is tied to the company that operates it.
 *
 * WHY A REGISTRY AND NOT A TEXT FIELD. A member who excludes Bell has to be
 * excluding Virgin Plus as well, or the exclusion is theatre: the same
 * company bids again under a second name and the offer lands anyway. That
 * only works if "Virgin Plus belongs to Bell" is a fact the server owns.
 * Nothing on either side of the market free-types a brand name into matching
 * logic: a member picks a `brand_id` from this table, a partner declares a
 * `brand_id` from this table, and a bid names a `brand_id` from this table.
 * Three writers, one vocabulary, and no string comparison anywhere.
 *
 * ONE LEVEL OF NESTING, DELIBERATELY. A brand is either a parent
 * (`parent_brand_id` null) or a flanker of a parent that is itself a parent.
 * A chain deeper than that is rejected on read rather than followed, because
 * "who owns this brand" has to be answerable in one hop for the exclusion
 * screen to be able to tell a member what it is about to exclude on their
 * behalf. A registry row whose parent is itself a flanker is a data error,
 * and `familyOf` reports it as one instead of quietly resolving a grandparent
 * the member was never shown.
 *
 * `pending_review` IS NOT A BRAND YET. A partner can ask for a listing, and
 * asking creates a row so the request is a record rather than an email. That
 * row is invisible to members, unselectable on a roster, and refused on a
 * bid: an unverified name must not become a way to reach households under
 * something nobody checked. `retired` is the mirror image, and the asymmetry
 * is on purpose: a retired brand is refused on new bids and rosters, but it
 * still renders in a member's exclusion chips and stays removable, because
 * the member chose it and a list that silently drops choices reads as a bug.
 *
 * OWNER NAMES DO NOT CROSS TO A MEMBER. `owner_org_name` exists for operator
 * review, and `publicBrand` is the only shape that leaves this module toward
 * a member surface. The corporate name behind a flanker is frequently the
 * thing the flanker exists to obscure, and repeating it on a join screen
 * would be this system volunteering a fact the household did not ask for.
 */

const datastore = require('./datastore');

const TABLE = 'brand_registry';

/* create-tables.md section 34a. One list today; a wider list joins in front
   of it when a column is added, the ladder every table here carries because
   tables are created by hand and code and schema deploy in either order. */
const BRAND_COLS = Object.freeze(['brand_id', 'display_name', 'parent_brand_id',
  'owner_org_name', 'status', 'created_at', 'updated_at']);
const BRAND_COL_LISTS = Object.freeze([BRAND_COLS]);

const STATUS = Object.freeze(['active', 'retired', 'pending_review']);

/* A slug, and one that survives datastore.lit(): the registry is read by
   brand_id in a WHERE clause, so the charset is the literal charset narrowed
   to what a slug may contain. */
const BRAND_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const MEMO_MS = 60 * 1000;
let memo = { at: 0, rows: null };

/** Drop the memo. Called by every write path in routes/brands.js. */
function invalidate() { memo = { at: 0, rows: null }; }

/** Is this a well-formed brand id? Shape only, says nothing about existence. */
function isBrandId(value) {
  return BRAND_ID_RE.test(String(value || ''));
}

/**
 * Fold a display name for searching: case and accents both removed.
 *
 * Vidéotron has to be findable by typing "videotron", because that is what a
 * member with an English keyboard types, and a search that returns nothing
 * reads as "we do not carry them" rather than "your keyboard lacks an é".
 */
function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

async function firstReadable(read) {
  for (const cols of BRAND_COL_LISTS) {
    try {
      /* eslint-disable-next-line no-await-in-loop */
      return await read(cols);
    } catch {
      /* try the next narrower projection */
    }
  }
  return null;
}

/**
 * Every registry row, memoized for a minute. Null when the table cannot be
 * read, which above all means it has not been created yet.
 *
 * Null is not an empty registry and no caller may treat it as one: an empty
 * registry means "there are no brands to exclude", which would render the
 * join step as a working screen with nothing in it. Callers render the
 * absence instead.
 */
async function all(catalystApp, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && memo.rows && now - memo.at < MEMO_MS) return memo.rows;

  const rows = await firstReadable((cols) => datastore.queryAll(
    catalystApp, TABLE, cols, 'ROWID > 0'
  ));
  if (rows === null) return null;

  memo = { at: now, rows };
  return rows;
}

/** One row by brand id, or null. Reads the memoized list, not the table. */
async function find(catalystApp, brandId) {
  if (!isBrandId(brandId)) return null;
  const rows = await all(catalystApp);
  if (!rows) return null;
  return rows.filter((r) => r.brand_id === brandId)[0] || null;
}

/** The active rows, alphabetical by display name. Null when unreadable. */
async function active(catalystApp) {
  const rows = await all(catalystApp);
  if (!rows) return null;
  return rows
    .filter((r) => r && r.status === 'active')
    .sort((a, b) => fold(a.display_name).localeCompare(fold(b.display_name)));
}

/**
 * The active rows matching `query`, alphabetical.
 *
 * A query shorter than two characters returns the whole alphabetical list
 * rather than a prefix match on one letter: the picker fires this per
 * keystroke, and "B" narrowing to nothing useful is worse than not narrowing.
 */
function search(rows, query) {
  const q = fold(query);
  const list = (rows || []).filter((r) => r && r.status === 'active');
  if (q.length < 2) return list;
  return list.filter((r) => fold(r.display_name).indexOf(q) >= 0);
}

/* ------------------------------------------------------------------ *
 * Families. Pure over a row list, so they are testable without a store.
 * ------------------------------------------------------------------ */

/** Is this row a parent, i.e. the top of its own family? */
function isParent(row) {
  return Boolean(row) && !row.parent_brand_id;
}

/**
 * The family a brand belongs to, over an already-read row list.
 *
 *   -> { parent, flankers: [row], depthError: boolean }
 *
 * `parent` is the row itself when it is a parent. `flankers` are the ACTIVE
 * children of that parent, alphabetical, excluding the parent. `depthError`
 * is true when the row's parent is itself a flanker, which is the data error
 * the one-level rule exists to catch: reported rather than followed, so a
 * caller can refuse the write instead of expanding a family the member was
 * never shown.
 *
 * A brand whose `parent_brand_id` names a row that is not in the registry is
 * treated as independent. A dangling parent pointer must not make a brand
 * unexcludable.
 */
function familyOf(rows, brandId) {
  const list = rows || [];
  const byId = new Map(list.filter((r) => r && r.brand_id).map((r) => [r.brand_id, r]));
  const row = byId.get(String(brandId || ''));
  if (!row) return { parent: null, flankers: [], depthError: false };

  let parent = row;
  let depthError = false;
  if (row.parent_brand_id) {
    const up = byId.get(row.parent_brand_id);
    if (up) {
      parent = up;
      /* One hop only. A parent with a parent is the error, not a chain. */
      if (up.parent_brand_id) depthError = true;
    }
  }

  const flankers = list
    .filter((r) => r && r.status === 'active'
      && r.parent_brand_id === parent.brand_id
      && r.brand_id !== parent.brand_id)
    .sort((a, b) => fold(a.display_name).localeCompare(fold(b.display_name)));

  return { parent, flankers, depthError };
}

/**
 * Every brand id in the same family as `brandId`, the parent included.
 *
 * This is what the retention lane asks (section 11.1: does this member's
 * exclusion cover their own incumbent's family?) and what the roster suggester
 * asks. It is NOT what the exclusion writer uses: an exclusion is stored as
 * explicit rows, one per brand, so a later registry edit cannot widen or
 * narrow a set the member already agreed to. See lib/exclusions.js.
 */
function familyIds(rows, brandId) {
  const fam = familyOf(rows, brandId);
  if (!fam.parent) return [];
  return [fam.parent.brand_id].concat(fam.flankers.map((r) => r.brand_id));
}

/**
 * The family expansion the join screen shows when a member picks one brand.
 *
 *   -> { picked, parent, siblings: [row], mode }
 *
 * mode is 'parent' when the member picked the top of a family, in which case
 * the flankers are checked for them and named so they can untick any; and
 * 'flanker' when they picked a child, in which case the parent is offered
 * checked by default and the siblings listed unchecked. That split is
 * CONFIRM-EXCL-01, shipped on the brief's default.
 *
 * A brand with no family at all returns mode 'single' and empty siblings, and
 * the screen renders no disclosure block.
 */
function expansionFor(rows, brandId) {
  const fam = familyOf(rows, brandId);
  if (!fam.parent) return { picked: null, parent: null, siblings: [], mode: 'single' };

  const picked = (rows || []).filter((r) => r && r.brand_id === brandId)[0] || null;
  if (!fam.flankers.length && fam.parent.brand_id === brandId) {
    return { picked, parent: fam.parent, siblings: [], mode: 'single' };
  }

  if (fam.parent.brand_id === brandId) {
    return { picked, parent: fam.parent, siblings: fam.flankers, mode: 'parent' };
  }
  return {
    picked,
    parent: fam.parent,
    siblings: fam.flankers.filter((r) => r.brand_id !== brandId),
    mode: 'flanker',
  };
}

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

/**
 * The member-safe shape. `owner_org_name` is absent by construction rather
 * than by deletion: this function names the three fields that may cross, so a
 * column added to the table later cannot leak by being spread.
 */
function publicBrand(row) {
  if (!row) return null;
  return {
    brand_id: row.brand_id,
    display_name: row.display_name || row.brand_id,
    parent_brand_id: row.parent_brand_id || null,
  };
}

/** The operator shape, for /admin only. Carries the owner name and status. */
function adminBrand(row) {
  if (!row) return null;
  return Object.assign(publicBrand(row), {
    owner_org_name: row.owner_org_name || null,
    status: row.status || null,
  });
}

module.exports = {
  TABLE, BRAND_COLS, STATUS, BRAND_ID_RE, MEMO_MS,
  isBrandId, fold, invalidate,
  all, find, active, search,
  isParent, familyOf, familyIds, expansionFor,
  publicBrand, adminBrand,
};
