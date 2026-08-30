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
 */

const datastore = require('./datastore');
const tiers = require('./tiers');
const { ms } = require('./envelope');

const OFFERS = 'household_offers';

const OFFER_COLS = Object.freeze(['offer_key', 'campaign_id', 'user_id', 'speed_mbps',
  'centre_tier', 'window_rule', 'cards_json', 'offered_at']);
/* One list today; the next column joins as a wider list in front of it. */
const OFFER_COL_LISTS = Object.freeze([OFFER_COLS]);

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

function keyFor(campaignId, userId) {
  return `${campaignId}:${userId}`.slice(0, 130);
}

/** This household's recorded window on one cohort, or null. Null also means
    unreadable, which above all means the table is not created yet. */
function findFor(catalystApp, campaignId, userId) {
  return firstReadable((cols) => datastore.findBy(catalystApp, OFFERS, 'offer_key',
    keyFor(campaignId, userId), ['ROWID'].concat(cols)));
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

function fromRow(row) {
  const cards = parseCards(row);
  return {
    cards,
    centre: row.centre_tier || null,
    nearest: /:nearest:/.test(String(row.window_rule || '')) ? row.centre_tier || null : null,
    rule: row.window_rule || null,
    offeredAt: ms(row.offered_at),
    recorded: true,
  };
}

/**
 * The window for one household, recording it on first read.
 *
 * Idempotent on the unique `offer_key`: a lost insert race re-reads the
 * winner's row, and that row is the answer. A table that cannot be read or
 * written degrades to the computed window with `recorded:false`, so the
 * household still sees its cards and the dashboard can say the record is
 * pending; nothing is invented and nothing is lost but the audit line.
 */
async function materialise(catalystApp, campaign, userId, book, { speed, pref }, now = Date.now()) {
  const existing = await findFor(catalystApp, campaign.id, userId);
  if (existing) return fromRow(existing);

  const w = compute({ speed, pref, book });
  const cardsJson = JSON.stringify(w.cards);
  try {
    await datastore.insertRow(catalystApp, OFFERS, {
      offer_key: keyFor(campaign.id, userId),
      campaign_id: campaign.id,
      user_id: userId,
      speed_mbps: speed == null || speed === '' ? null : String(speed).slice(0, 16),
      centre_tier: w.centre,
      window_rule: w.rule,
      cards_json: cardsJson,
      offered_at: datastore.toDb(new Date(now)),
    });
  } catch (err) {
    const raced = await findFor(catalystApp, campaign.id, userId);
    if (raced) return fromRow(raced);
    console.warn(JSON.stringify({
      at: 'offers.materialise', campaign: campaign.id,
      error: String((err && err.message) || err).slice(0, 200),
    }));
    return Object.assign({ offeredAt: now, recorded: false }, w);
  }

  const back = await findFor(catalystApp, campaign.id, userId);
  if (!back) return Object.assign({ offeredAt: now, recorded: false }, w);
  if (back.cards_json !== cardsJson) {
    console.warn(JSON.stringify({
      at: 'offers.materialise', campaign: campaign.id, note: 'readback mismatch after insert',
    }));
  }
  return fromRow(back);
}

module.exports = {
  OFFERS, OFFER_COLS, POSITIONS,
  centreFor, windowFor, compute, ruleOf,
  findFor, parseCards, materialise,
};
