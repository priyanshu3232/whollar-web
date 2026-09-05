'use strict';

/**
 * The price book: which sealed bid won each SPEED TIER of a cohort, recorded
 * once, read everywhere. And the award: one row per partner that won at least
 * one tier, carrying that partner's roster gate.
 *
 * WHY A BOOK AND NOT A WINNER. The cohort used to have one winner: the lowest
 * headline price, which is the lowest tier the winning bid quoted. Every
 * household was then shown that partner's price at that one speed, whatever
 * speed the household actually wanted. A cohort where partner A is cheapest at
 * 100 Mbps and partner B is cheapest at 1 Gig had one of those two facts
 * thrown away, and the household that wanted the other one was quoted a number
 * nobody had bid for it.
 *
 * So bids are compared PER TIER. For each tier on the standard ladder, the
 * winner is the lowest effective price among the bids that quoted it. The
 * result is a book, ascending by tier, and a household sees the winner at its
 * own tier plus its two neighbours. Three offers on one cohort can come from
 * three partners, and every household picking the same speed still pays the
 * same price, which is the property that makes a cohort a cohort.
 *
 * A TIER NOBODY BID IS ABSENT, not null and not zero. The household's window
 * is three consecutive entries OF THE BOOK, so a missing tier is skipped over
 * rather than shown as an empty card. Nothing here invents a price for a speed
 * no partner offered.
 *
 * THE BOOK IS A RECORD, NOT A DERIVATION, for the reason the single award was
 * one: recomputing on every read means two readers a second apart can
 * disagree the moment a late write or a price correction lands, and a
 * household must never be shown a tier price that then changes under it. The
 * unique `book_key` is what makes two concurrent readers produce one book.
 *
 * SEALED AT CLOSE, BY WHOEVER ASKS FIRST. There is no cron in this stack, so
 * nothing can be scheduled for the moment a cohort closes. The first read
 * after the close seals the book and derives the awards, idempotently.
 *
 * A CLOSE IS NOT AN AWARD. Sealing only ever happens for a campaign the
 * catalog says has closed, and only when at least one readable bid quoted at
 * least one tier at a readable price. A closed cohort nobody bid on gets no
 * book, and no book is a fact the console renders as itself rather than as a
 * loss.
 *
 * ONE EXCEPTION TO THE EQUAL-PRICE PROPERTY, ADDED WITH MEMBER EXCLUSIONS.
 * "Every household picking the same speed pays the same price" now holds for
 * every household that did not exclude the partner holding that price. A
 * member who names a provider they will not hear from has their book rebuilt
 * from their eligible bids only (`bookForMember`), so two households at 500
 * Mbps can be shown different prices, and the one with the exclusion may be
 * shown the higher. That is the member's own instruction being honoured at its
 * real cost, not a defect, and it is confined to members who asked: a member
 * with no exclusions is not filtered at all and reads the sealed cohort book
 * unchanged.
 *
 * ONE PARTNER, ONE COHORT, ONE GATE. The award row's grain is (cohort, org),
 * not (cohort, tier): a partner that won four tiers has one roster to release
 * and one confidentiality acknowledgement to give, not four. `award_key` is
 * `${campaign_id}:${org_id}` and the roster gate columns sit on it unchanged.
 *
 * NO PARTNER LEARNS ANOTHER PARTNER'S RESULT. A partner may be told which
 * tiers it won and how many sealed bids the cohort drew, which is its own
 * competitive context and already public to households as `bidCount`. The book
 * itself never leaves this module toward a /provider route: no losing org,
 * price, tier or reference, not even as a redacted row.
 */

const datastore = require('./datastore');
const bids = require('./bids');
const cohorts = require('./cohorts');
const { ms } = require('./envelope');

const AWARDS = 'campaign_awards';
const BOOKS = 'campaign_price_books';

/* Two lists, the pattern lib/bids.js established: tables are created by hand,
   so code and schema deploy separately and in either order. The base list is
   what an award cannot be read without; the wider lists carry the roster gate
   and the won-tier record, and the widest readable one wins. */
const AWARD_COLS = Object.freeze(['award_key', 'campaign_id', 'org_id', 'bid_key',
  'price', 'bid_count', 'method', 'awarded_by', 'awarded_at']);
const AWARD_COLS_V2 = Object.freeze(AWARD_COLS.concat(['gate_at', 'gate_by',
  'install_capacity_weekly', 'consent_ack', 'settled_at']));
/* create-tables.md section 30b. Absent on a table created before the price
   book, which reads as an award with one unnamed tier. */
const AWARD_COLS_V3 = Object.freeze(AWARD_COLS_V2.concat(['tiers_won']));
const AWARD_COL_LISTS = Object.freeze([AWARD_COLS_V3, AWARD_COLS_V2, AWARD_COLS]);

const BOOK_COLS = Object.freeze(['book_key', 'campaign_id', 'book_json',
  'bid_count', 'method', 'sealed_at']);

/* How the book was picked. 'lowest_per_tier' is the rule; 'admin' exists so a
   corrected book is distinguishable from a computed one, in the record and not
   only in an audit line. */
const METHODS = Object.freeze(['lowest_per_tier', 'admin']);

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/** The first column list this table can answer, or null when none can. */
async function firstReadable(read) {
  for (const cols of AWARD_COL_LISTS) {
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
 * Building the book. Pure, and the one unit worth testing on its own.
 * ------------------------------------------------------------------ */

/**
 * The named parts of the reduction on one tier of one bid, or null.
 *
 * Labels and money only. A household reads what a step is called and what it
 * is worth, never the share arithmetic behind it, and nothing here works a
 * figure out for itself: the cents are the ones the seal recorded.
 */
function mixForTier(discountMix, tierName) {
  if (!discountMix || !Array.isArray(discountMix.tiers)) return null;
  const t = discountMix.tiers.filter((x) => x && x.tier === tierName)[0];
  if (!t || !Array.isArray(t.mix) || !t.mix.length) return null;
  return {
    reductionCents: t.gapCents,
    rows: t.mix.map((r) => ({
      label: r.label,
      amountCents: r.amountCents,
      periodStartMo: r.periodStartMo,
      periodEndMo: r.periodEndMo,
    })),
  };
}

/**
 * Where a tier's after-rate sorts when two bids tie on price.
 *
 * A tier with no after-price is a bid whose effective price never changes
 * (`after_mode = 'none'`), which is strictly better for the household than any
 * scheduled rise, so it sorts ahead of every number rather than behind them.
 */
function afterRank(afterPrice) {
  const n = Number(afterPrice);
  return Number.isFinite(n) && n > 0 ? n : -Infinity;
}

/**
 * The price book implied by a cohort's sealed bids: ascending by tier, one
 * entry per tier at least one bid quoted at a readable price.
 *
 * THE TIE RULES, in order, and all four are needed for the answer to be the
 * same for two readers and across restarts:
 *   1. lowest effective price
 *   2. then the lower after-guarantee rate (no rise at all beats any rise)
 *   3. then the higher household commitment, which is the partner promising to
 *      serve more of the cohort at that price
 *   4. then the earlier seal, and finally the bid key, which is arbitrary but
 *      total: without a last resort two equal bids can swap places between
 *      reads and a household can watch its offer change partner.
 *
 * A BID THAT NAMED NO TIER CANNOT WIN ONE. `publicBid` degrades a row that
 * predates the tier record to a single synthesized tier with an empty name;
 * it fails the ladder check below and is skipped. Placing it in the book would
 * mean inventing which speed its flat price was for, and the whole point of
 * the book is that the price at a speed is the price a partner bid for that
 * speed.
 *
 * `demand` is the cohort's speed demand profile (lib/cohorts.js speedDemand),
 * optional. Each entry records how many households sat at its tier at the
 * seal (`demandCount`, null when the profile was under the privacy floor),
 * how many partners bid it (`bidCount`) and which tie rule decided it
 * (`tieRule`, null when the price alone did). Demand is RECORDED, NOT A GATE:
 * a tier somebody bid and nobody asked for stays in the book, because a
 * household stepping up may still take it, and the partner who won it is
 * told plainly that no household sat there.
 */
function buildBook(rows, demand) {
  const byTier = new Map();
  const demandMap = cohorts.demandByTier(demand);

  (rows || []).forEach((row) => {
    const pub = bids.publicBid(row);
    /* bid_key is campaign:org, so the org is recoverable even from a row read
       with an older projection that lacked org_id. */
    const orgId = row.org_id
      || String(row.bid_key || '').split(':').slice(1).join(':')
      || null;
    if (!orgId) return;
    const placedAt = ms(row.submitted_at) || ms(row.updated_at) || 0;
    const commitment = toInt(row.commitment_cap);

    (pub.tiers || []).forEach((t) => {
      const tier = String((t && t.name) || '');
      if (bids.TIER_NAMES.indexOf(tier) < 0) return;
      const price = Number(t.effectivePrice);
      if (!Number.isFinite(price) || price <= 0) return;

      const list = byTier.get(tier) || [];
      list.push({
        price,
        after: afterRank(t.afterPrice),
        commitment: commitment || 0,
        placedAt,
        bidKey: String(row.bid_key || ''),
        entry: {
          tier,
          /* Money is a string everywhere in this stack. The Number above is
             for sorting and never for the record. */
          price: String(t.effectivePrice),
          orgId,
          bidKey: row.bid_key || null,
          afterPrice: t.afterPrice || null,
          afterLine: pub.afterLine || null,
          guaranteeMonths: pub.guaranteeMonths,
          equipment: pub.equipment || null,
          rentalMonthly: pub.rentalMonthly || null,
          technology: t.technology || null,
          uploadMbps: t.uploadMbps || null,
          commitment,
          mix: mixForTier(pub.discountMix, tier),
          reference: pub.reference || null,
        },
      });
      byTier.set(tier, list);
    });
  });

  return bids.TIER_NAMES
    .filter((tier) => byTier.has(tier))
    .map((tier) => {
      const list = byTier.get(tier);
      list.sort((a, b) => (a.price - b.price)
        || (a.after - b.after)
        || (b.commitment - a.commitment)
        || (a.placedAt - b.placedAt)
        || a.bidKey.localeCompare(b.bidKey));
      return Object.assign(list[0].entry, {
        bidCount: list.length,
        tieRule: tieRuleFor(list[0], list[1]),
        demandCount: demandMap ? (demandMap[tier] || 0) : null,
      });
    });
}

/**
 * Which step of the tie order separated the winner from the runner-up, or
 * null when the price alone did (including a tier with one bidder). Recorded
 * on the entry so a tie is auditable from the book rather than re-derived.
 */
function tieRuleFor(first, second) {
  if (!second || first.price !== second.price) return null;
  if (first.after !== second.after) return 'after_rate';
  if (first.commitment !== second.commitment) return 'commitment';
  if (first.placedAt !== second.placedAt) return 'earlier_seal';
  return 'bid_key';
}

/* ------------------------------------------------------------------ *
 * The per-member filter: where a member's exclusions become binding
 * ------------------------------------------------------------------ */

/**
 * A bid's brand, or null when it cannot be established.
 *
 * Two sources, in order. A bid sealed after create-tables.md section 34e
 * carries its own `brand_id`, which is the brand the partner named at
 * submission and the only fully trustworthy answer. A bid sealed BEFORE that
 * column existed carries none, and is attributed to its org's primary
 * declared brand from `brandMap`.
 *
 * The fallback exists so an exclusion bites on historical bids too. Without
 * it, every bid predating the column would be brandless, and a brandless bid
 * cannot be checked against an exclusion: the household that excluded Bell in
 * September would receive Bell's August bid on the next cohort to close,
 * which is precisely the promise this feature makes.
 */
function brandOfBid(row, brandMap) {
  if (!row) return null;
  if (row.brand_id) return String(row.brand_id);
  const orgId = row.org_id
    || String(row.bid_key || '').split(':').slice(1).join(':')
    || null;
  if (!orgId || !brandMap) return null;
  return brandMap.get(String(orgId)) || null;
}

/** The audit statuses one bid can carry in a member's resolution. */
const BID_STATUS = Object.freeze(['eligible', 'skipped_excluded_brand',
  'invalidated_brand_inactive', 'skipped_unresolved_brand']);

/**
 * Split a cohort's bids into the ones eligible for ONE member and the ones
 * that are not, with the reason recorded for each.
 *
 *   eligibleRows(rows, { excluded, brandMap, statusOf })
 *     -> { eligible: [row], audit: [{ bidKey, orgId, brandId, status }] }
 *
 * `excluded` is the member's effective exclusion set (lib/exclusions.js).
 * `brandMap` attributes brandless historical bids. `statusOf` answers the
 * registry status of a brand id, for edge case 13.
 *
 * TWO FILTERS WITH DIFFERENT REACH, and the split is the whole safety
 * argument, so it is worth stating plainly.
 *
 *   THE BRAND-STATUS FILTER RUNS FOR EVERY MEMBER. Edge case 13: a brand
 *   retired between submission and resolution is skipped for everyone, not
 *   only for members holding exclusions. An operator retiring a brand is
 *   saying it must not reach households any more, and honouring that for some
 *   households and not others would make what a member is shown depend on
 *   whether they happen to have excluded something unrelated.
 *
 *   THE EXCLUSION FILTER RUNS ONLY FOR A MEMBER WHO HOLDS EXCLUSIONS, which
 *   is a shortcut but not merely an optimisation: it means this feature cannot
 *   cost an offer to a member who never asked for anything.
 *
 * AN UNRESOLVABLE BRAND IS TREATED DIFFERENTLY BY THE TWO, for the same
 * reason. If the brand behind a bid cannot be established:
 *
 *   for a member WITH exclusions it is skipped, because whether it is excluded
 *   cannot be established either, and the two mistakes are not symmetric.
 *   Passing it through may deliver an offer the household explicitly refused,
 *   which is the one outcome they were promised is impossible; skipping it
 *   costs an offer they may have wanted. The reversible mistake is the one to
 *   make.
 *
 *   for a member with NO exclusions it is kept, because there is no promise to
 *   keep and dropping it would cost an offer to protect nobody. Only a brand
 *   POSITIVELY known to be inactive is skipped for them.
 *
 * NOTE ON WHAT THIS DOES NOT DO. It does not invalidate the bid, and it does
 * not touch the sealed cohort book. A sealed bid is binding and there is no
 * withdraw path at any layer (CLAUDE.md), so a retired brand's bid stays in
 * the record and stays in the partner-facing book; what changes is only which
 * bids a member's own book is cut from. "Invalidated" in the audit means
 * invalidated for routing, never unsealed.
 */
function eligibleRows(rows, { excluded, brandMap = null, statusOf = null } = {}) {
  const list = rows || [];
  const set = excluded instanceof Set ? excluded : new Set(excluded || []);
  const filtering = set.size > 0;

  const eligible = [];
  const audit = [];
  list.forEach((row) => {
    /* Resolution is skipped entirely when there is nothing to resolve for: no
       exclusions to check and no status filter possible without a registry. */
    const brandId = (filtering || statusOf) ? brandOfBid(row, brandMap) : null;
    const record = {
      bidKey: row.bid_key || null,
      orgId: row.org_id || null,
      brandId: brandId || null,
      status: 'eligible',
    };

    const known = brandId && statusOf ? statusOf(brandId) : null;
    if (known && known !== 'active') {
      record.status = 'invalidated_brand_inactive';
    } else if (filtering && !brandId) {
      record.status = 'skipped_unresolved_brand';
    } else if (filtering && set.has(brandId)) {
      record.status = 'skipped_excluded_brand';
    }

    audit.push(record);
    if (record.status === 'eligible') eligible.push(row);
  });

  return { eligible, audit };
}

/**
 * The price book as ONE MEMBER sees it: built from that member's eligible
 * bids only.
 *
 *   -> { book, audit, filtered }
 *
 * THIS IS THE WHOLE OF SECTION 9, and it is a different shape from the one
 * the brief describes, deliberately. The brief ranks a cohort's bids by price
 * and awards a member the top eligible one. This cohort's result is not a
 * winner but a BOOK: for each speed tier, the lowest effective price among
 * the bids that quoted it, so three tiers can belong to three partners and a
 * household is shown its own tier and its two neighbours. Ranking flat by
 * price would throw that away and quote a household a speed it did not ask
 * for, which is the failure the book was built to fix.
 *
 * Filtering the member's bid set and REBUILDING the book preserves both: the
 * brief's canonical scenario holds exactly (a member who excluded the cheapest
 * brand at their tier is shown the next eligible bid at that tier, at its own
 * price and never re-priced), and it generalises across tiers, which a flat
 * ranking cannot.
 *
 * The tiebreak is `buildBook`'s existing ladder (after-rate, then commitment,
 * then earlier seal, then bid key) and NOT the brief's "earliest submission".
 * CONFIRM-EXCL-08 asks for one tiebreak rule system-wide; there already is
 * one, it is richer, it is shipped, and adopting the brief's default would
 * silently change which partner wins live cohorts that have nothing to do
 * with exclusions.
 *
 * THE COHORT PRICE CAN NOW DIVERGE BETWEEN TWO HOUSEHOLDS AT ONE SPEED. That
 * is a real departure from the invariant recorded at the top of this file, and
 * it is intended: an exclusion is the member's own instruction, and honouring
 * it may cost them the cheapest price on their tier. The cohort price remains
 * the price for every household that did not exclude the partner holding it.
 */
function bookForMember(bidRows, demand, opts = {}) {
  const split = eligibleRows(bidRows, opts);
  const filtered = split.eligible.length !== (bidRows || []).length;
  return {
    book: buildBook(split.eligible, demand),
    audit: split.audit,
    filtered,
  };
}

/**
 * Mark up a member's audit with what the rebuilt book actually did with each
 * eligible bid: `awarded` when it holds a tier of the member's book,
 * `outranked` when it was eligible and holds none.
 *
 * Section 9.2 wants an ordered ranked list per member. A book has no single
 * winner, so "awarded" here means "won at least one tier of this member's
 * book", which is the honest translation and the one the console can explain.
 */
function auditWithOutcome(audit, book) {
  const won = new Set((book || []).map((e) => e && e.bidKey).filter(Boolean));
  return (audit || []).map((r) => Object.assign({}, r, {
    status: r.status === 'eligible'
      ? (won.has(r.bidKey) ? 'awarded' : 'outranked')
      : r.status,
  }));
}

/** One tier's entry from a book, or null. The accept path's only lookup. */
function entryFor(book, tier) {
  return (book || []).filter((e) => e && e.tier === String(tier || ''))[0] || null;
}

/** The book a stored row carries, or [] when it is unreadable. */
function parseBook(row) {
  if (!row || !row.book_json) return [];
  try {
    const b = JSON.parse(row.book_json);
    return Array.isArray(b) ? b : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** The sealed book row for one campaign, or null. Null also means unreadable:
    every caller treats "no book" as "nothing has been won here", which is the
    safe reading in both cases, and never as "you lost". */
async function bookRowFor(catalystApp, campaignId) {
  try {
    return await datastore.findBy(catalystApp, BOOKS, 'book_key', campaignId,
      ['ROWID'].concat(BOOK_COLS));
  } catch {
    return null;
  }
}

/** The sealed book for one campaign as an array, or null when unsealed. */
async function bookFor(catalystApp, campaignId) {
  const row = await bookRowFor(catalystApp, campaignId);
  return row ? parseBook(row) : null;
}

/** One award row by its key, widest readable projection. */
function readAward(catalystApp, key) {
  return firstReadable((cols) => datastore.findBy(catalystApp, AWARDS, 'award_key', key,
    ['ROWID'].concat(cols)));
}

/**
 * This org's award on this cohort, or null.
 *
 * THE LEGACY KEY IS READ TOO. Awards sealed before the price book are keyed on
 * the campaign id alone, because a cohort had one winner. Looking only at the
 * composite key would make every one of them invisible the moment this code
 * deployed: the partner's board would empty, `requireWon` would 404, and the
 * cohort's statement would vanish, all without anything being deleted. So the
 * old key is tried second and the row is repaired in place on the way past.
 * That makes the console backfill a tidy-up rather than a prerequisite, which
 * is the right shape for a migration nobody can run inside a transaction.
 */
async function findForOrg(catalystApp, campaignId, orgId) {
  const key = `${campaignId}:${orgId}`;
  const row = await readAward(catalystApp, key);
  if (row) return row;

  const legacy = await readAward(catalystApp, campaignId);
  if (!legacy || String(legacy.org_id) !== String(orgId)) return null;
  /* Best effort, and its failure changes nothing: the fallback above finds the
     row again on the next read. Not awaited into the answer for that reason. */
  datastore.updateRow(catalystApp, AWARDS, { ROWID: legacy.ROWID, award_key: key })
    .then(() => { legacy.award_key = key; }, () => {});
  return legacy;
}

/** Every award held by one org, or null when the table is unreadable. Works
    on both key shapes: the query is on org_id, which never moved. */
async function rowsForOrg(catalystApp, orgId) {
  const where = `org_id = ${datastore.lit(orgId)}`;
  return firstReadable((cols) => datastore.queryAll(catalystApp, AWARDS, cols, where));
}

/** The tier names an award row records, or [] on a row that predates them. */
function tiersWon(row) {
  if (!row || !row.tiers_won) return [];
  try {
    const t = JSON.parse(row.tiers_won);
    return Array.isArray(t) ? t.filter((n) => typeof n === 'string') : [];
  } catch {
    return [];
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
 * One award row per org holding at least one tier of a sealed book.
 *
 * Idempotent by the unique `award_key`, so re-running it is how a book whose
 * awards never landed heals itself. An insert that fails means the row is
 * already there or the table is not created yet, and neither is an error to
 * the caller: the read that follows finds what exists.
 *
 * A LEGACY ROW IS UPGRADED, NOT DUPLICATED. An award sealed under the old
 * one-winner rule is keyed on the campaign alone; inserting the composite key
 * beside it would give that org two award rows on one cohort, which
 * `buildStatements` would bill as two statements. So it is rewritten in place,
 * keeping its roster gate, its capacity and its consent.
 */
async function sealAwards(catalystApp, campaign, book, bidCount, now) {
  const byOrg = new Map();
  (book || []).forEach((e) => {
    if (!e || !e.orgId) return;
    const held = byOrg.get(e.orgId) || { tiers: [], price: null, bidKey: e.bidKey };
    held.tiers.push(e.tier);
    const n = Number(e.price);
    if (held.price === null || (Number.isFinite(n) && n < Number(held.price))) {
      held.price = e.price;
      held.bidKey = e.bidKey;
    }
    byOrg.set(e.orgId, held);
  });
  if (!byOrg.size) return;

  const legacy = await readAward(catalystApp, campaign.id);

  /* A GRANDFATHERED AWARD IS NOT REVOKED. The old rule awarded the lowest
     headline price, which is the lowest tier of the cheapest bid; under the
     per-tier rule another partner may be cheaper at that very tier, so the old
     winner can win nothing. That partner may already have released a roster
     and be serving households. Taking the cohort off their board would strand
     real orders in the name of a rule that changed after the fact, so the row
     is kept and only re-keyed, with an empty tier list saying plainly that it
     holds no tier of the current book. Loud in the log, because it is the one
     case a human should look at. */
  if (legacy && !byOrg.has(String(legacy.org_id))) {
    console.warn(JSON.stringify({
      at: 'awards.sealAwards', campaign: campaign.id, org: legacy.org_id,
      note: 'legacy award holds no tier of the price book, kept and re-keyed',
    }));
    try {
      await datastore.updateRow(catalystApp, AWARDS, {
        ROWID: legacy.ROWID,
        award_key: `${campaign.id}:${legacy.org_id}`,
        tiers_won: '[]',
      });
    } catch {
      /* `tiers_won` may not exist yet. The key is the part that matters. */
      try {
        await datastore.updateRow(catalystApp, AWARDS, {
          ROWID: legacy.ROWID, award_key: `${campaign.id}:${legacy.org_id}`,
        });
      } catch { /* left on the old key; findForOrg still reads it */ }
    }
  }

  for (const [orgId, held] of byOrg) {
    const key = `${campaign.id}:${orgId}`;
    const shared = {
      price: held.price,
      tiers_won: JSON.stringify(held.tiers),
    };
    try {
      if (legacy && String(legacy.org_id) === String(orgId)) {
        /* eslint-disable-next-line no-await-in-loop */
        await datastore.updateRow(catalystApp, AWARDS, {
          ROWID: legacy.ROWID, award_key: key, ...shared,
        });
      } else {
        /* eslint-disable-next-line no-await-in-loop */
        await datastore.insertRow(catalystApp, AWARDS, {
          award_key: key,
          campaign_id: campaign.id,
          org_id: orgId,
          bid_key: held.bidKey,
          bid_count: bidCount,
          method: 'lowest_per_tier',
          awarded_by: 'auto',
          awarded_at: datastore.toDb(new Date(now)),
          ...shared,
        });
      }
    } catch (err) {
      /* Three things can land here, and only the last is a real failure.

         1. A row already sits on this key. Either another reader won the race,
            or findForOrg self-healed a legacy row onto the composite key
            before this ran, which is the ordinary case when the console
            backfill was skipped. Either way the row must be UPDATED, not
            inserted again: an insert-only retry leaves that row without its
            `tiers_won`, and a partner who won four tiers then reads as
            "not selected" on their own desk while still holding the roster.
         2. `tiers_won` does not exist yet. Then the same write without it is
            worth far more than no award at all.
         3. Something else, which is what the log line is for. */
      let healed = false;
      const base = {
        campaign_id: campaign.id,
        org_id: orgId,
        bid_key: held.bidKey,
        price: held.price,
        bid_count: bidCount,
        method: 'lowest_per_tier',
        awarded_by: 'auto',
        awarded_at: datastore.toDb(new Date(now)),
      };
      /* eslint-disable no-await-in-loop */
      const held_row = await readAward(catalystApp, key);
      if (held_row) {
        try {
          await datastore.updateRow(catalystApp, AWARDS, {
            ROWID: held_row.ROWID, ...base, ...shared,
          });
          healed = true;
        } catch {
          try {
            await datastore.updateRow(catalystApp, AWARDS, { ROWID: held_row.ROWID, ...base });
            healed = true;
          } catch {
            healed = false;
          }
        }
      } else {
        try {
          await datastore.insertRow(catalystApp, AWARDS, { award_key: key, ...base });
          healed = true;
        } catch {
          healed = false;
        }
      }
      /* eslint-enable no-await-in-loop */
      if (!healed) {
        console.warn(JSON.stringify({
          at: 'awards.sealAwards', campaign: campaign.id, org: orgId,
          error: String((err && err.message) || err).slice(0, 200),
        }));
      }
    }
  }
}

/**
 * Read the book for a closed campaign, sealing it first if it has never been
 * sealed. Returns the book array, or null when there is nothing to award.
 *
 * `bidRows` is passed in rather than fetched here: the callers already hold
 * it, and lib/bids.js is emphatic that the all-orgs read is safe in exactly
 * one place. Keeping the fetch at the call site keeps that visible.
 *
 * A failed insert is not an error to the caller. Either another reader won the
 * race, in which case the row is there and re-reading finds it, or the table
 * does not exist yet, in which case nothing about the cohort has changed and
 * every surface renders the unsealed state.
 */
async function sealBook(catalystApp, campaign, bidRows, now = Date.now()) {
  const existing = await bookRowFor(catalystApp, campaign.id);
  if (existing) return parseBook(existing);
  if (!isClosed(campaign, now)) return null;

  /* The demand profile at the seal, recorded per tier. Read here and not
     passed in: it is needed once in the life of a cohort, and every caller
     would otherwise fetch it on every read to hand it to a seal that has
     nothing left to do. An unreadable profile seals as null counts. */
  let demand = null;
  try {
    demand = await cohorts.speedDemand(catalystApp, campaign);
  } catch {
    demand = null;
  }
  const book = buildBook(bidRows, demand);
  if (!book.length) return null;
  const bidCount = (bidRows || []).length;
  const bookJson = JSON.stringify(book);

  try {
    await datastore.insertRow(catalystApp, BOOKS, {
      book_key: campaign.id,
      campaign_id: campaign.id,
      book_json: bookJson,
      bid_count: bidCount,
      method: 'lowest_per_tier',
      sealed_at: datastore.toDb(new Date(now)),
    });
  } catch (err) {
    /* Raced, or the table is not created yet. Logged because a third cause, a
       bad column value, once hid here for a month. Re-read: if somebody else
       won the race their row is the book, and the awards below are idempotent
       so running them again costs a read and changes nothing. A second seal
       attempt on a sealed cohort lands here too, and refuses: the record
       already on the row is the book, whatever this reader computed. */
    const raced = await bookRowFor(catalystApp, campaign.id);
    console.warn(JSON.stringify({
      at: 'awards.sealBook', campaign: campaign.id,
      note: raced ? 'second seal attempt refused, book already sealed' : 'insert failed, no book',
      error: String((err && err.message) || err).slice(0, 200),
    }));
    if (!raced) return null;
    const racedBook = parseBook(raced);
    await sealAwards(catalystApp, campaign, racedBook, toInt(raced.bid_count), now);
    return racedBook;
  }

  /* Read back and assert. The record is what every household will be shown,
     so the record wins over what was computed: a row that came back different
     (a column truncation, say) is logged and served as written. */
  const back = await bookRowFor(catalystApp, campaign.id);
  const stored = back ? parseBook(back) : [];
  if (!back || back.book_json !== bookJson) {
    console.warn(JSON.stringify({
      at: 'awards.sealBook', campaign: campaign.id,
      note: stored.length ? 'readback mismatch after insert' : 'readback unreadable after insert, serving the computed book',
      storedLength: back ? String(back.book_json || '').length : 0, computedLength: bookJson.length,
    }));
  }
  /* The record wins when it is a record. A row that came back unparseable
     (a clipped book_json, say) must not seal the cohort as "nobody won":
     the computed book stands for this read, loudly, and the row is the
     thing a human has to look at. */
  const sealed = stored.length ? stored : book;
  await sealAwards(catalystApp, campaign, sealed, bidCount, now);
  return sealed;
}

/**
 * This org's result on one cohort: whether the cohort is decided at all, and
 * what this org holds if it is. Seals the book first when the close has passed
 * and nobody sealed yet.
 *
 * WON NOTHING AND NOT DECIDED YET ARE DIFFERENT ANSWERS, and a null award
 * cannot tell them apart. A desk that renders both as "not selected" tells a
 * partner it lost a cohort whose book has not been sealed, which is a
 * falsehood arriving before the truth does. So the result is a shape, not a
 * row: `decided` false means nothing has been sealed, including when the
 * tables are unreadable, and the caller leaves the bid as it found it.
 *
 * This is the ONLY sanctioned way for a /provider route to reach a seal: the
 * all-orgs bid read happens inside this module and only this org's own award
 * row leaves it, so competitors' sealed rows never sit in a partner request's
 * scope (sealed-bid privacy).
 *
 * Award first, then book, then bids: the read that runs every time is the
 * cheap one. The middle step is what makes "this org won nothing" cost a
 * lookup on a unique key instead of the whole bid table on every board render,
 * and it doubles as the repair for a book whose award rows never landed.
 */
async function resultForOrg(catalystApp, campaign, orgId, now = Date.now()) {
  const existing = await findForOrg(catalystApp, campaign.id, orgId);
  if (existing) {
    const bookRow = await bookRowFor(catalystApp, campaign.id);
    return {
      decided: true, award: existing, tiersWon: tiersWon(existing),
      wonEntries: wonEntriesFor(parseBook(bookRow), orgId),
    };
  }

  const none = { decided: false, award: null, tiersWon: [], wonEntries: [] };
  let bookRow = await bookRowFor(catalystApp, campaign.id);
  if (!bookRow) {
    if (!isClosed(campaign, now)) return none;
    const bidRows = await bids.campaignBidRows(catalystApp, campaign.id);
    await sealBook(catalystApp, campaign, bidRows, now);
    bookRow = await bookRowFor(catalystApp, campaign.id);
    if (!bookRow) return none;
  }

  const book = parseBook(bookRow);
  /* Decided, and this org holds none of it. A definite answer, and the
     cheapest one: no bid read, and none needed. */
  if (!book.some((e) => e && String(e.orgId) === String(orgId))) {
    return { decided: true, award: null, tiersWon: [], wonEntries: [] };
  }

  /* Sealed, but this org's award row is missing. Heal it rather than leave a
     partner locked out of a cohort the book says they won. */
  await sealAwards(catalystApp, campaign, book, toInt(bookRow.bid_count), now);
  const healed = await findForOrg(catalystApp, campaign.id, orgId);
  return {
    decided: true, award: healed, tiersWon: tiersWon(healed),
    wonEntries: wonEntriesFor(book, orgId),
  };
}

/**
 * This org's own entries of a book, and nothing of anyone else's: the tier,
 * its own price, and how many households sat there. The one slice of the
 * book a /provider route may carry, cut here so no caller holds the whole
 * book in a partner's scope.
 */
function wonEntriesFor(book, orgId) {
  /* `bidCount` and `tieRule` stay in the book. How many partners bid a tier,
     and that a rival matched this price to the cent, are facts about other
     partners' bids, which no /provider route may carry (CLAUDE.md). The
     demand count is about households and crosses. */
  return (book || [])
    .filter((e) => e && String(e.orgId) === String(orgId))
    .map((e) => ({
      tier: e.tier,
      price: e.price,
      demandCount: e.demandCount == null ? null : toInt(e.demandCount),
    }));
}

/** This org's award row on one cohort, or null. The row-only door, for the
    callers that need the roster gate rather than the won/lost distinction. */
function sealFromCampaign(catalystApp, campaign, orgId, now = Date.now()) {
  return resultForOrg(catalystApp, campaign, orgId, now).then((r) => r.award);
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
 *
 * `tiersWon` is this partner's own result and nothing more. It is deliberately
 * the only tier fact that crosses to a /provider route: which speeds this
 * partner won says nothing about what anybody else bid, while the book says
 * everything, and the book is why that distinction has to be kept by hand.
 */
function publicAward(row, billing) {
  return {
    campaignId: row.campaign_id,
    reference: row.bid_key || null,
    price: row.price || null,
    tiersWon: tiersWon(row),
    bidCount: toInt(row.bid_count),
    method: METHODS.indexOf(row.method) >= 0 ? row.method : 'lowest_per_tier',
    awardedAt: ms(row.awarded_at),
    capacityWeekly: toInt(row.install_capacity_weekly),
    settledAt: ms(row.settled_at),
    gate: gateState(row, billing),
  };
}

module.exports = {
  AWARDS, BOOKS, AWARD_COLS, AWARD_COLS_V2, AWARD_COLS_V3, BOOK_COLS, METHODS,
  buildBook, tieRuleFor, entryFor, parseBook, mixForTier, wonEntriesFor,
  BID_STATUS, brandOfBid, eligibleRows, bookForMember, auditWithOutcome,
  bookFor, bookRowFor, findForOrg, rowsForOrg, tiersWon,
  isClosed, sealBook, sealAwards, sealFromCampaign, resultForOrg,
  gateState, gatePassed, release, setCapacity,
  publicAward,
};
