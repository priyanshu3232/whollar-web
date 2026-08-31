'use strict';

/**
 * The household's window on the price book: which three cards it is shown,
 * chosen once and recorded.
 *
 * WHY A RECORD. The book is sealed per cohort, so every price a household
 * sees is the price everyone sees. Which THREE of those prices a household
 * sees depends on the household: the speed on its bill and its preference
 * chip. Until this module the dashboard sliced that window on every render
 * and nothing wrote it down, so a household that edited its bill after
 * deciding, or a corrected ladder, silently re-centred the cards under a
 * choice already made, and "what did you show me" had no answer. The row here
 * is that answer: one per household per cohort, written on the first read
 * after the seal, never rewritten.
 *
 * THE RULE (the HS-2 decision of 2026-08-29):
 *   centre:  the preference chip when it names a speed ('up' is 1 Gig,
 *            'cheap' is the lowest price), else the ladder tier at or below
 *            the bill speed, else the cheapest entry.
 *   window:  three consecutive entries OF THE BOOK around the centre. A tier
 *            nobody bid is skipped, not shown empty. At the ends the window
 *            slides the other way (the lowest tier shows the first three).
 *            A centre that is not in the book moves to the nearest entry by
 *            ladder distance and says so (`nearest`).
 *   none:    an empty book records one card with position 'none', so the
 *            dashboard can say plainly that no sealed bid landed rather than
 *            render an empty panel.
 *
 * Cards copy the entry's tier, org, bid key and price STRING from the book.
 * No arithmetic, no re-derivation: the price on the card is the seal's.
 *
 * WRITE-ONCE, PER VERSION. Member exclusions gave this record something it did
 * not have before: a reason for a household's window to legitimately change
 * after it was written. Section 11 requires a new exclusion during `offers_out`
 * to withdraw a delivered offer from that brand and promote the next eligible
 * one, which is exactly the re-centring this table exists to prevent.
 *
 * Both hold, by versioning rather than by mutating. A row is still never
 * rewritten: a new exclusion writes version n+1 and stamps `superseded_at` on
 * version n, so "what was this household shown when it decided" still has an
 * answer for every decision, and the current window is simply the highest
 * unsuperseded version. `audit_json` carries that version's per-bid resolution
 * (lib/awards.js auditWithOutcome) and `excluded_json` the exclusion set it
 * was cut against, which is what makes a stale window detectable without
 * recomputing one on every read.
 *
 * VERSION 1 KEEPS THE BARE KEY. Rows written before this change have
 * `offer_key = campaign:user` and no `version` column, so the base key stays
 * version 1 and only version 2 onward carries a `:v{n}` suffix. A table
 * without the new columns degrades to exactly its old single-version
 * behaviour.
 */

const datastore = require('./datastore');
const tiers = require('./tiers');
const { ms } = require('./envelope');

const OFFERS = 'household_offers';

const OFFER_COLS = Object.freeze(['offer_key', 'campaign_id', 'user_id', 'speed_mbps',
  'centre_tier', 'window_rule', 'cards_json', 'offered_at']);
/* create-tables.md section 34f: versioning, the per-member resolution audit,
   and the exclusion set the version was cut against. The widest readable list
   wins; a table without these degrades to one unversioned window per
   household, which is this module's behaviour before exclusions existed. */
const OFFER_COLS_V2 = Object.freeze(OFFER_COLS.concat(['version', 'superseded_at',
  'audit_json', 'excluded_json', 'withdrawn_json']));
const OFFER_COL_LISTS = Object.freeze([OFFER_COLS_V2, OFFER_COLS]);

/* A window that vanished because the member excluded the partner holding it.
   The member-facing state of section 11, and the reason a card can be absent
   from version n+1 that was present in version n. */
const WITHDRAWN = 'withdrawn_by_exclusion';

const POSITIONS = Object.freeze(['below', 'current', 'above', 'none']);

async function firstReadable(read) {
  for (const cols of OFFER_COL_LISTS) {
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
 * The rule. Pure.
 * ------------------------------------------------------------------ */

function cheapest(book) {
  return book.slice().sort((a, b) => Number(a.price) - Number(b.price))[0] || null;
}

/**
 * Where the window centres for one household, and why.
 *   -> { tier, source }  source: pref_up | pref_cheap | bill | unknown | none
 */
function centreFor({ speed, pref, book }) {
  if (!book || !book.length) return { tier: null, source: 'none' };
  /* The chip's own literal is "Move up to 1 Gig", so the tier it names is the
     tier it says. If that copy changes, change this with it, and the
     dashboard's prefTier() too. */
  if (pref === 'up') return { tier: '1 Gig', source: 'pref_up' };
  if (pref === 'cheap') return { tier: cheapest(book).tier, source: 'pref_cheap' };
  const ladder = tiers.tierForSpeed(speed);
  if (ladder) return { tier: ladder, source: 'bill' };
  return { tier: cheapest(book).tier, source: 'unknown' };
}

/**
 * Three consecutive entries of the book around `tier`.
 *   -> { cards: [{...entry, position}], centre, nearest, placement }
 * placement: centred | end_low | end_high | short (fewer than three entries)
 */
function windowFor(book, tier) {
  const bk = book || [];
  if (!bk.length) return { cards: [], centre: null, nearest: null, placement: 'none' };

  let i = bk.findIndex((e) => e && e.tier === tier);
  let nearest = null;
  if (i < 0) {
    const want = tiers.tierIndex(tier);
    let bestd = Infinity;
    if (want > -1) {
      bk.forEach((e, k) => {
        const d = Math.abs(tiers.tierIndex(e.tier) - want);
        if (d < bestd) { bestd = d; i = k; }
      });
    }
    if (i < 0) i = Math.floor((bk.length - 1) / 2);
    nearest = bk[i].tier;
  }

  const lo = Math.max(0, Math.min(i - 1, bk.length - 3));
  const cards = bk.slice(lo, lo + 3).map((e, k) => ({
    tier: e.tier,
    orgId: e.orgId || null,
    bidKey: e.bidKey || null,
    price: e.price,
    position: lo + k < i ? 'below' : (lo + k === i ? 'current' : 'above'),
  }));
  let placement = 'centred';
  if (bk.length < 3) placement = 'short';
  else if (i === 0) placement = 'end_low';
  else if (i === bk.length - 1) placement = 'end_high';
  return { cards, centre: bk[i].tier, nearest, placement };
}

/** The whole rule, as one string for the record: `bill:nearest:end_low`. */
function ruleOf(source, nearest, placement) {
  if (source === 'none') return 'none';
  return [source, nearest ? 'nearest' : null, placement].filter(Boolean).join(':');
}

/** The cards and rule for one household, unrecorded. */
function compute({ speed, pref, book }) {
  const centre = centreFor({ speed, pref, book });
  const w = windowFor(book, centre.tier);
  return {
    cards: w.cards.length ? w.cards : [{ tier: null, orgId: null, bidKey: null, price: null, position: 'none' }],
    centre: w.centre,
    nearest: w.nearest,
    rule: ruleOf(centre.source, w.nearest, w.placement),
  };
}

/* ------------------------------------------------------------------ *
 * The record
 * ------------------------------------------------------------------ */

/**
 * The unique key for one version of one household's window.
 *
 * Version 1 is the BARE key, unchanged from before versioning existed, so
 * every row already in this table is version 1 without being rewritten.
 * Version 2 onward suffixes `:v{n}`.
 */
function keyFor(campaignId, userId, version = 1) {
  const base = `${campaignId}:${userId}`.slice(0, 120);
  return version > 1 ? `${base}:v${version}` : base.slice(0, 130);
}

/** This household's recorded window on one cohort, or null. Null also means
    unreadable, which above all means the table is not created yet. */
function findFor(catalystApp, campaignId, userId) {
  return firstReadable((cols) => datastore.findBy(catalystApp, OFFERS, 'offer_key',
    keyFor(campaignId, userId), ['ROWID'].concat(cols)));
}

const versionOf = (row) => Math.max(1, parseInt((row || {}).version, 10) || 1);

/** Every recorded version for one household on one cohort, oldest first. */
async function versionsFor(catalystApp, campaignId, userId) {
  const rows = await firstReadable((cols) => datastore.queryAll(
    catalystApp, OFFERS, cols,
    `campaign_id = ${datastore.lit(campaignId)} AND user_id = ${datastore.lit(userId)}`
  ));
  if (rows === null) return null;
  return rows.slice().sort((a, b) => versionOf(a) - versionOf(b));
}

/**
 * The household's CURRENT window: the highest version not yet superseded.
 *
 * Falls back to the bare-key read when the table has no `version` column, so
 * a deployment where the columns have not been added behaves exactly as it
 * did before: one window per household, found by its unique key.
 */
async function activeRow(catalystApp, campaignId, userId) {
  const rows = await versionsFor(catalystApp, campaignId, userId);
  if (rows === null) return await findFor(catalystApp, campaignId, userId);
  const live = rows.filter((r) => !r.superseded_at);
  if (live.length) return live[live.length - 1];
  /* Every version superseded is a data error rather than a state: the newest
     one is still what the household was last shown, so it is returned rather
     than treated as no window at all. */
  return rows.length ? rows[rows.length - 1] : null;
}

function parseCards(row) {
  if (!row || !row.cards_json) return [];
  try {
    const c = JSON.parse(row.cards_json);
    return Array.isArray(c) ? c.filter((x) => x && POSITIONS.indexOf(x.position) >= 0) : [];
  } catch {
    return [];
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    const v = JSON.parse(value);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function fromRow(row) {
  const cards = parseCards(row);
  return {
    cards,
    centre: row.centre_tier || null,
    nearest: /:nearest:/.test(String(row.window_rule || '')) ? row.centre_tier || null : null,
    rule: row.window_rule || null,
    offeredAt: ms(row.offered_at),
    recorded: true,
    version: versionOf(row),
    /* The per-bid resolution for this version. OPERATOR-ONLY: section 9.2 is
       explicit that it must never appear in a member or provider payload, so
       it rides on the internal shape and every wire mapping in
       routes/campaigns.js names its fields rather than spreading this object. */
    audit: parseJson(row.audit_json, null),
    excluded: parseJson(row.excluded_json, null),
    withdrawn: parseJson(row.withdrawn_json, null) || [],
  };
}

/**
 * Has this recorded window gone stale against the member's exclusion set?
 *
 * True when the set the version was cut against differs from the set now in
 * force. Compared as a sorted list rather than by size, so swapping one brand
 * for another is caught: a member who un-excludes Bell and excludes Rogers in
 * one save has the same count and a different window.
 *
 * A row with no `excluded_json` (written before the column existed, or by a
 * degraded write) is NOT reported stale, because there is nothing to compare
 * and re-cutting on a guess would re-centre a window under a decision already
 * made. It becomes comparable the next time it is written.
 */
function staleFor(row, excluded) {
  if (!row || !row.excluded_json) return false;
  const was = parseJson(row.excluded_json, null);
  if (!Array.isArray(was)) return false;
  const now = Array.from(excluded instanceof Set ? excluded : new Set(excluded || []));
  return was.slice().sort().join(',') !== now.slice().sort().join(',');
}

/**
 * Which tiers a household held in the previous version and no longer holds.
 *
 * This is the section 11 withdrawal, expressed against a book: a card that was
 * delivered and is now absent was withdrawn because the member excluded the
 * partner holding it. The tier is what the member recognises, so the tier is
 * what is recorded and rendered with `withdrawn_by_exclusion`.
 */
function withdrawnBetween(prevCards, nextCards) {
  const held = new Set((nextCards || []).map((c) => c && c.tier).filter(Boolean));
  return (prevCards || [])
    .filter((c) => c && c.tier && !held.has(c.tier))
    .map((c) => ({ tier: c.tier, price: c.price || null, state: WITHDRAWN }));
}

/**
 * Write one version of a household's window.
 *
 * Shared by the first materialisation and by every supersede, because the two
 * differ only in the version number and in whether a previous row has to be
 * stamped. The extra columns are attempted and, if the table has not got them,
 * the write is retried with the original eight: a household still gets its
 * recorded window on a table that predates versioning, and only the audit line
 * is lost.
 */
async function writeVersion(catalystApp, campaign, userId, w, {
  speed, version, excluded, audit, withdrawn, now,
}) {
  const base = {
    offer_key: keyFor(campaign.id, userId, version),
    campaign_id: campaign.id,
    user_id: userId,
    speed_mbps: speed == null || speed === '' ? null : String(speed).slice(0, 16),
    centre_tier: w.centre,
    window_rule: w.rule,
    cards_json: JSON.stringify(w.cards),
    offered_at: datastore.toDb(new Date(now)),
  };
  const wide = Object.assign({}, base, {
    version,
    superseded_at: null,
    audit_json: audit ? JSON.stringify(audit).slice(0, 20000) : null,
    excluded_json: JSON.stringify(Array.from(excluded || [])).slice(0, 4000),
    withdrawn_json: withdrawn && withdrawn.length ? JSON.stringify(withdrawn).slice(0, 4000) : null,
  });

  try {
    await datastore.insertRow(catalystApp, OFFERS, wide);
    return true;
  } catch (wideErr) {
    try {
      await datastore.insertRow(catalystApp, OFFERS, base);
      return true;
    } catch {
      throw wideErr;
    }
  }
}

/**
 * The window for one household, recording it on first read.
 *
 * Idempotent on the unique `offer_key`: a lost insert race re-reads the
 * winner's row, and that row is the answer. A table that cannot be read or
 * written degrades to the computed window with `recorded:false`, so the
 * household still sees its cards and the dashboard can say the record is
 * pending; nothing is invented and nothing is lost but the audit line.
 *
 * `book` is THIS MEMBER'S book, already filtered by their exclusions
 * (lib/awards.js bookForMember). This module does no filtering of its own and
 * knows nothing about brands: it cuts a window out of whatever book it is
 * handed, which is what keeps the exclusion rule in one place.
 */
async function materialise(catalystApp, campaign, userId, book, {
  speed, pref, excluded = null, audit = null,
} = {}, now = Date.now()) {
  const existing = await activeRow(catalystApp, campaign.id, userId);
  if (existing) return fromRow(existing);

  const w = compute({ speed, pref, book });
  try {
    await writeVersion(catalystApp, campaign, userId, w,
      { speed, version: 1, excluded, audit, withdrawn: null, now });
  } catch (err) {
    const raced = await activeRow(catalystApp, campaign.id, userId);
    if (raced) return fromRow(raced);
    console.warn(JSON.stringify({
      at: 'offers.materialise', campaign: campaign.id,
      error: String((err && err.message) || err).slice(0, 200),
    }));
    return Object.assign({ offeredAt: now, recorded: false, version: 1, withdrawn: [] }, w);
  }

  const back = await activeRow(catalystApp, campaign.id, userId);
  if (!back) return Object.assign({ offeredAt: now, recorded: false, version: 1, withdrawn: [] }, w);
  return fromRow(back);
}

/**
 * Cut a NEW version of a household's window against a changed exclusion set,
 * and stamp the previous one superseded.
 *
 *   -> { ...window, version, withdrawn, promoted, superseded: true }
 *
 * SECTION 11, AND THE ORDER MATTERS. The new version is inserted BEFORE the
 * old one is stamped, so an interrupted supersede leaves two live versions
 * rather than none, and `activeRow` takes the highest, which is the new and
 * correct one. The reverse order could leave a household with every version
 * superseded and no window at all, mid-decision.
 *
 * PROMOTION IS WHAT REBUILDING THE BOOK ALREADY DOES. The brief describes
 * promoting the next-ranked eligible bid when the awarded one is withdrawn.
 * Because the member's book is rebuilt from their eligible bids, the next
 * eligible bid at that tier is already the entry sitting there, at its own
 * price. `promoted` names the tiers whose partner changed between versions, so
 * the dashboard can say what happened rather than silently swapping a card.
 *
 * Idempotent on the version key: a double-tapped save that both reach here
 * writes one version, and the loser re-reads the winner's row.
 */
async function supersede(catalystApp, campaign, userId, book, {
  speed, pref, excluded = null, audit = null,
} = {}, now = Date.now()) {
  const current = await activeRow(catalystApp, campaign.id, userId);
  if (!current) {
    return materialise(catalystApp, campaign, userId, book, { speed, pref, excluded, audit }, now);
  }

  const prevCards = parseCards(current);
  const w = compute({ speed, pref, book });
  const withdrawn = withdrawnBetween(prevCards, w.cards);

  const prevByTier = new Map(prevCards.filter((c) => c && c.tier).map((c) => [c.tier, c]));
  const promoted = w.cards
    .filter((c) => c && c.tier && prevByTier.has(c.tier)
      && String(prevByTier.get(c.tier).orgId || '') !== String(c.orgId || ''))
    .map((c) => c.tier);

  const version = versionOf(current) + 1;
  try {
    await writeVersion(catalystApp, campaign, userId, w,
      { speed, version, excluded, audit, withdrawn, now });
  } catch (err) {
    const raced = await activeRow(catalystApp, campaign.id, userId);
    if (raced && versionOf(raced) >= version) return fromRow(raced);
    console.warn(JSON.stringify({
      at: 'offers.supersede', campaign: campaign.id, version,
      error: String((err && err.message) || err).slice(0, 200),
    }));
    /* The previous version stands. Better a stale window the household has
       already seen than no window, and the next read tries again. */
    return fromRow(current);
  }

  try {
    await datastore.updateRow(catalystApp, OFFERS, {
      ROWID: current.ROWID, superseded_at: datastore.toDb(new Date(now)),
    });
  } catch {
    /* Two live versions. `activeRow` takes the highest, so the household sees
       the right one; the stamp is repaired on the next supersede. */
    console.warn(JSON.stringify({
      at: 'offers.supersede', campaign: campaign.id, version,
      note: 'new version written, previous not stamped superseded',
    }));
  }

  const back = await activeRow(catalystApp, campaign.id, userId);
  const out = back ? fromRow(back) : Object.assign({ offeredAt: now, recorded: false, version }, w);
  return Object.assign(out, { withdrawn, promoted, superseded: true });
}

module.exports = {
  OFFERS, OFFER_COLS, OFFER_COLS_V2, POSITIONS, WITHDRAWN,
  centreFor, windowFor, compute, ruleOf,
  findFor, versionsFor, activeRow, versionOf, parseCards,
  staleFor, withdrawnBetween,
  materialise, supersede,
};
