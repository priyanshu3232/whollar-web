'use strict';

/**
 * Two attested declarations, and the one question they exist to answer:
 * MAY THIS BID BE MADE UNDER THIS BRAND?
 *
 *   `provider_brands`       the brands a founding partner owns or operates
 *   `distributor_providers` the providers a distributor serves
 *
 * WHY BOTH ARE ATTESTED RATHER THAN MERELY STORED. A member's exclusion is
 * only as good as the market's answer to "who is Virgin Plus". If a partner
 * can bid under a brand it never declared, the exclusion is bypassed by
 * omission rather than by intent, and nobody involved needs to have done
 * anything dishonest for the household to receive the offer it refused. So a
 * roster is a claim someone signs: a named user, a timestamp, and the
 * sentence "this is the complete list". Any change re-opens the attestation,
 * because a list that was complete in August is a different claim in November.
 *
 * A DISTRIBUTOR ROUTE IS NOT A SECOND DOOR. Section 6.3: a bid arriving
 * through a distributor is validated on the brand exactly as a direct bid is,
 * and additionally on whether the distributor serves the provider whose
 * roster carries that brand. It is then RECORDED AGAINST THE PROVIDER'S
 * BRAND, so everything downstream (the price book, the exclusion filter, the
 * reach count) sees one kind of bid and cannot be made to treat the two
 * differently. `canBidAs` is the single gate, and it is deliberately the only
 * exported way to ask.
 *
 * SOFT REMOVAL, NEVER DELETION. A brand leaving a roster is a fact with a
 * date, because a bid sealed last month was made under the roster as it stood
 * then and a dispute about that bid is answered by the roster's history. The
 * flattened `roster_key` holds (org, brand) so the active row is a constraint
 * rather than a convention, and a brand re-added after removal revives its
 * row, the same shape lib/exclusions.js uses and for the same reason.
 *
 * NOTE ON WHAT IS NOT HERE. The distributor CONSOLE is not built: there is no
 * authenticated distributor role in this system yet, only a radio button on
 * the public application form. What is built is the serving-map TABLE, its
 * read and write layer, and the validation branch in `canBidAs`, so the
 * moment that role exists a distributor cannot bid past an exclusion. Wiring
 * a surface to it is a second pass; leaving the gate for later would mean
 * building the door after the room.
 */

const datastore = require('./datastore');
const brands = require('./brands');
const { AppError, badRequest } = require('./errors');

const ROSTER = 'provider_brands';
const SERVING = 'distributor_providers';

/* create-tables.md sections 34b and 34c. */
const ROSTER_COLS = Object.freeze(['roster_key', 'provider_id', 'brand_id',
  'declared_at', 'attested_by', 'removed_at']);
const SERVING_COLS = Object.freeze(['serving_key', 'distributor_id', 'provider_id',
  'declared_at', 'attested_by', 'removed_at']);

const MAX_PER_WRITE = 200;

/* The two attestations, section 13, as the one place each sentence lives.
 *
 * A partner and a distributor are each signing a claim about completeness, and
 * the exact words are what they signed: `scripts/check-exclusion-copy.mjs`
 * holds them to the brief so a reword cannot quietly change the claim under an
 * attestation already on file. The roster copy is rendered by
 * partner/views/roster.js; the serving-map copy has no surface yet and lives
 * here so the string exists once when one is built, rather than being invented
 * a second time next to it. */
const ROSTER_ATTEST = 'We confirm this is the complete list of consumer brands '
  + 'our organization owns or operates. Bids and offers we submit are made on '
  + 'behalf of these brands only.';
const SERVING_ATTEST = 'We confirm this is the complete list of providers we serve. '
  + 'Bids we submit or manage are made only on behalf of these providers and '
  + 'their attested brands.';

const isActive = (row) => Boolean(row) && !row.removed_at;

const rosterKey = (providerId, brandId) => `${providerId}:${brandId}`.slice(0, 160);
const servingKey = (distributorId, providerId) => `${distributorId}:${providerId}`.slice(0, 160);

/* ------------------------------------------------------------------ *
 * Reads. Null means unreadable, which above all means not created yet, and
 * every caller distinguishes that from an empty declaration.
 * ------------------------------------------------------------------ */

async function readAll(catalystApp, table, cols, where) {
  try {
    return await datastore.queryAll(catalystApp, table, cols, where);
  } catch {
    return null;
  }
}

/** Every roster row for one provider, removed rows included. */
function rosterRows(catalystApp, providerId) {
  return readAll(catalystApp, ROSTER, ROSTER_COLS,
    `provider_id = ${datastore.lit(providerId)}`);
}

/** Every serving-map row for one distributor, removed rows included. */
function servingRows(catalystApp, distributorId) {
  return readAll(catalystApp, SERVING, SERVING_COLS,
    `distributor_id = ${datastore.lit(distributorId)}`);
}

/**
 * The brands this provider has attested to, as a Set. Null when unreadable.
 *
 * Null is NOT an empty roster: an empty roster means "this partner has
 * declared no brands and may bid under none", which is a refusal, while
 * unreadable means the table is missing and the roster gate cannot be
 * enforced at all. `canBidAs` decides what to do with each; nothing else may.
 */
async function rosterFor(catalystApp, providerId) {
  const rows = await rosterRows(catalystApp, providerId);
  if (rows === null) return null;
  return new Set(rows.filter(isActive).map((r) => r.brand_id));
}

/** The providers this distributor has attested to serving. Null when unreadable. */
async function servingMapFor(catalystApp, distributorId) {
  const rows = await servingRows(catalystApp, distributorId);
  if (rows === null) return null;
  return new Set(rows.filter(isActive).map((r) => r.provider_id));
}

/**
 * Who has attested this brand, as a Set of provider ids. Null when unreadable.
 *
 * Two providers claiming one brand is a data problem for an operator, not an
 * error here: both are returned and `canBidAs` is satisfied if the bidding
 * org is either of them. Refusing both would let one partner's bad
 * declaration block another partner's legitimate bid.
 */
async function providersForBrand(catalystApp, brandId) {
  if (!brands.isBrandId(brandId)) return new Set();
  const rows = await readAll(catalystApp, ROSTER, ROSTER_COLS,
    `brand_id = ${datastore.lit(brandId)}`);
  if (rows === null) return null;
  return new Set(rows.filter(isActive).map((r) => r.provider_id));
}

/**
 * Every brand attested by any provider, as a Map of brand id to provider id.
 *
 * The reach count (section 5.4) and the per-member book filter both need to
 * turn a bid into a brand, and a bid carries its own `brand_id` once section
 * 34e lands. This map is the fallback for bids sealed BEFORE that column
 * existed: a bid with no brand of its own is attributed to its org's primary
 * declared brand, so an exclusion still bites on historical bids instead of
 * silently ignoring them. See lib/awards.js brandOfBid.
 */
const OWNERS_MEMO_MS = 60 * 1000;
let ownersMemo = { at: 0, map: null };

/** Drop the owner-map memo. Called by every roster write. */
function invalidateOwners() { ownersMemo = { at: 0, map: null }; }

async function brandOwners(catalystApp, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && ownersMemo.map && now - ownersMemo.at < OWNERS_MEMO_MS) {
    return ownersMemo.map;
  }
  /* MEMOIZED FOR A MINUTE, and it has to be. This is a whole-table read, and
     it is now on the path of every member's offer read rather than only those
     holding exclusions, because the brand-status filter applies to everyone
     (lib/awards.js eligibleRows). Unmemoized that is one full scan of
     provider_brands per household per page load, on a store metered per fetch.
     A minute stale is harmless here: the map answers "which org declared this
     brand", which changes when a partner edits a roster, and a roster write
     invalidates this. */
  const rows = await readAll(catalystApp, ROSTER, ROSTER_COLS, 'ROWID > 0');
  if (rows === null) return null;
  const map = new Map();
  rows.filter(isActive).forEach((r) => {
    if (!map.has(r.brand_id)) map.set(r.brand_id, r.provider_id);
  });
  ownersMemo = { at: now, map };
  return map;
}

/**
 * The brands this org may bid under, oldest declaration first. Used as the
 * fallback attribution for a bid that predates the `brand_id` column: the
 * first brand a partner declared is its primary, which for a single-brand
 * partner (the overwhelming majority) is exactly right, and for a
 * multi-brand partner is the best available guess about a bid that never
 * recorded one.
 */
async function primaryBrandFor(catalystApp, providerId) {
  const rows = await rosterRows(catalystApp, providerId);
  if (!rows || !rows.length) return null;
  const active = rows.filter(isActive)
    .sort((a, b) => String(a.declared_at || '').localeCompare(String(b.declared_at || '')));
  return active.length ? active[0].brand_id : null;
}

/* ------------------------------------------------------------------ *
 * The attestation gate
 * ------------------------------------------------------------------ */

/**
 * Has this provider a complete, attested roster?
 *
 *   -> { attested, brands: Set, at, by, reason }
 *
 * `reason` names why not, for the console's own copy: 'no_table',
 * 'empty' (section 14.17: an empty roster is refused, minimum one entry), or
 * null when it passed. Section 5.1 makes this the gate on entering
 * sealed_bidding, and routes/desk.js consults it before accepting a bid.
 */
async function attestationFor(catalystApp, providerId) {
  const rows = await rosterRows(catalystApp, providerId);
  if (rows === null) {
    return { attested: false, brands: new Set(), at: null, by: null, reason: 'no_table' };
  }
  const active = rows.filter(isActive);
  if (!active.length) {
    return { attested: false, brands: new Set(), at: null, by: null, reason: 'empty' };
  }
  /* The latest declaration is the standing attestation: any roster change
     re-attests, so the newest row's stamp is the date of the current claim. */
  const newest = active.slice().sort((a, b) =>
    String(b.declared_at || '').localeCompare(String(a.declared_at || '')))[0];
  return {
    attested: true,
    brands: new Set(active.map((r) => r.brand_id)),
    at: newest.declared_at || null,
    by: newest.attested_by || null,
    reason: null,
  };
}

/* ------------------------------------------------------------------ *
 * The one gate: may this bid be made under this brand?
 * ------------------------------------------------------------------ */

/**
 * Decide whether a bid may name `brandId`.
 *
 *   canBidAs(app, { orgId, brandId })                    a direct provider bid
 *   canBidAs(app, { orgId, brandId, distributorId })     via a distributor
 *
 * Throws the section 13 copy on refusal, returns
 * `{ brandId, providerId, viaDistributorId }` on success. The returned
 * `providerId` is who the bid is RECORDED against, which for a distributor
 * submission is the served provider and never the distributor: everything
 * downstream must see one kind of bid.
 *
 * A missing roster table does not silently pass. It cannot fail the bid
 * either, or creating the tables would become a prerequisite for the auction
 * that already runs, so it degrades to "no brand may be named": a bid that
 * names no brand is accepted exactly as it is today, and a bid that names one
 * is refused with a message an operator can act on. That keeps the live
 * auction working while making the new path impossible to half-enable.
 */
async function canBidAs(catalystApp, { orgId, brandId, distributorId = null } = {}) {
  const brand = String(brandId || '');
  if (!brand) {
    throw badRequest('Name the brand this bid is made under.', {
      logDetail: 'bid with no brand_id',
    });
  }
  if (!brands.isBrandId(brand)) {
    throw badRequest('That brand is not one we list.', {
      logDetail: `bid with malformed brand_id len=${brand.length}`,
    });
  }

  /* 1. The brand must exist and be active. A `pending_review` listing is not
        a brand yet, and a `retired` one may not take new bids. */
  const row = await brands.find(catalystApp, brand);
  if (!row) {
    throw new AppError('VALIDATION_ERROR', 'That brand is not one we list.', {
      logDetail: `unknown brand_id=${brand}`,
      extra: { error_key: 'brand_not_active' },
    });
  }
  if (row.status !== 'active') {
    throw new AppError('VALIDATION_ERROR', row.status === 'pending_review'
      ? 'That brand is still awaiting verification. You cannot bid under it yet.'
      : 'That brand is retired and cannot take new bids.', {
      logDetail: `inactive brand_id=${brand} status=${row.status}`,
      extra: { error_key: 'brand_not_active' },
    });
  }

  /* 2. Somebody must have attested it. */
  const owners = await providersForBrand(catalystApp, brand);
  if (owners === null) {
    throw new AppError('VALIDATION_ERROR',
      'Brand rosters are not available yet, so a bid cannot name a brand.', {
        logDetail: `roster table unreadable, brand named brand_id=${brand}`,
        extra: { error_key: 'brand_not_on_roster' },
      });
  }

  /* 3a. Direct submission: the bidding org must be the one that attested it. */
  if (!distributorId) {
    if (!owners.has(orgId)) {
      throw new AppError('VALIDATION_ERROR',
        'This brand is not on your attested roster. Update your roster in settings, then resubmit.', {
          logDetail: `brand not on roster org=${orgId} brand=${brand}`,
          extra: { error_key: 'brand_not_on_roster' },
        });
    }
    return { brandId: brand, providerId: orgId, viaDistributorId: null };
  }

  /* 3b. Distributor submission: the brand belongs to some provider, and that
         provider must be on this distributor's attested serving map. The
         distributor's own id is never the provider the bid is recorded
         against. */
  const served = await servingMapFor(catalystApp, distributorId);
  if (served === null) {
    throw new AppError('VALIDATION_ERROR',
      'Serving maps are not available yet, so a bid cannot be submitted on a provider\'s behalf.', {
        logDetail: `serving table unreadable distributor=${distributorId}`,
        extra: { error_key: 'brand_not_on_roster' },
      });
  }
  const match = Array.from(owners).filter((p) => served.has(p));
  if (!match.length) {
    throw new AppError('VALIDATION_ERROR',
      'This provider is not on your attested serving map. Update your serving map in settings, then resubmit.', {
        logDetail: `brand outside serving map distributor=${distributorId} brand=${brand}`,
        extra: { error_key: 'brand_not_on_roster' },
      });
  }
  return { brandId: brand, providerId: match[0], viaDistributorId: distributorId };
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/** What `declare` would do. Pure, so the decision is testable. */
function planFor(rows, wanted, idOf) {
  const want = new Set(wanted || []);
  const byId = new Map((rows || []).filter((r) => r && idOf(r)).map((r) => [idOf(r), r]));

  const insert = [];
  const revive = [];
  const unchanged = [];
  want.forEach((id) => {
    const row = byId.get(id);
    if (!row) insert.push(id);
    else if (isActive(row)) unchanged.push(id);
    else revive.push(row);
  });
  const remove = (rows || []).filter((r) => isActive(r) && !want.has(idOf(r)));
  return { insert, revive, remove, unchanged };
}

/**
 * Replace a declaration and stamp the attestation.
 *
 * Shared by the roster and the serving map because the two are the same
 * operation over different columns, and two copies of a soft-remove ladder is
 * two chances to forget the removal half.
 *
 * REMOVALS LAND FIRST HERE, the opposite of lib/exclusions.js, and for the
 * mirror-image reason. An interrupted roster write must leave the partner
 * able to bid under FEWER brands than it claims, never more: a stale extra
 * brand on a roster is a brand an exclusion may not have been able to
 * anticipate, which is the failure that matters on this side of the market.
 */
async function declare(catalystApp, {
  table, cols, keyCol, ownerCol, itemCol, ownerId, items, userId, at = Date.now(),
}) {
  const wanted = Array.from(new Set((items || []).map((s) => String(s))));
  if (!wanted.length) {
    throw badRequest('Name at least one entry before you attest.');
  }
  if (wanted.length > MAX_PER_WRITE) {
    throw new AppError('VALIDATION_ERROR', 'That is more entries than one save can hold.');
  }

  const rows = await readAll(catalystApp, table, cols,
    `${datastore.ident(ownerCol)} = ${datastore.lit(ownerId)}`);
  if (rows === null) {
    throw new AppError('SERVER_ERROR',
      'That declaration cannot be saved right now. Nothing was changed.', {
        logDetail: `${table} unreadable owner=${ownerId}`,
      });
  }

  const plan = planFor(rows, wanted, (r) => r[itemCol]);
  const nowDb = datastore.toDb(new Date(at));

  for (const row of plan.remove) {
    /* eslint-disable-next-line no-await-in-loop */
    await datastore.updateRow(catalystApp, table, { ROWID: row.ROWID, removed_at: nowDb });
  }
  for (const id of plan.insert) {
    /* eslint-disable-next-line no-await-in-loop */
    await datastore.insertRow(catalystApp, table, {
      [keyCol]: `${ownerId}:${id}`.slice(0, 160),
      [ownerCol]: ownerId,
      [itemCol]: id,
      declared_at: nowDb,
      attested_by: userId,
      removed_at: null,
    });
  }
  /* A revived row is a NEW declaration, so it takes a fresh stamp and a fresh
     attester: the partner is claiming this brand again, today, and the date
     of the claim is the date it can be held to. */
  for (const row of plan.revive) {
    /* eslint-disable-next-line no-await-in-loop */
    await datastore.updateRow(catalystApp, table, {
      ROWID: row.ROWID, removed_at: null, declared_at: nowDb, attested_by: userId,
    });
  }
  /* Every unchanged row is re-stamped too, because the attestation covers the
     WHOLE list and its date is the date the list was last sworn to. Without
     this, `attestationFor` would report the age of the oldest untouched entry
     as the age of the current claim. */
  for (const row of rows.filter((r) => isActive(r) && plan.unchanged.indexOf(r[itemCol]) >= 0)) {
    /* eslint-disable-next-line no-await-in-loop */
    await datastore.updateRow(catalystApp, table, {
      ROWID: row.ROWID, declared_at: nowDb, attested_by: userId,
    });
  }

  invalidateOwners();
  return {
    added: plan.insert.concat(plan.revive.map((r) => r[itemCol])),
    removed: plan.remove.map((r) => r[itemCol]),
    active: wanted,
    attestedAt: nowDb,
    attestedBy: userId,
  };
}

/** Declare a provider's brand roster. Section 5.1. */
function declareRoster(catalystApp, providerId, brandIds, { userId, at } = {}) {
  return declare(catalystApp, {
    table: ROSTER, cols: ROSTER_COLS, keyCol: 'roster_key',
    ownerCol: 'provider_id', itemCol: 'brand_id',
    ownerId: providerId, items: brandIds, userId, at,
  });
}

/** Declare a distributor's serving map. Section 6.1. */
function declareServingMap(catalystApp, distributorId, providerIds, { userId, at } = {}) {
  return declare(catalystApp, {
    table: SERVING, cols: SERVING_COLS, keyCol: 'serving_key',
    ownerCol: 'distributor_id', itemCol: 'provider_id',
    ownerId: distributorId, items: providerIds, userId, at,
  });
}

module.exports = {
  ROSTER, SERVING, ROSTER_COLS, SERVING_COLS, MAX_PER_WRITE,
  ROSTER_ATTEST, SERVING_ATTEST,
  rosterKey, servingKey, isActive,
  rosterRows, servingRows, rosterFor, servingMapFor,
  providersForBrand, brandOwners, invalidateOwners, primaryBrandFor,
  attestationFor, canBidAs,
  planFor, declare, declareRoster, declareServingMap,
};
