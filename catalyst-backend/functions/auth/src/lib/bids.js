'use strict';

/**
 * Sealed bids: validation, the append-only revision record, and wire shapes.
 *
 * SEALED MEANS SEALED. Every read and write in this module resolves through a
 * key built from the session's org context, never from anything in the
 * request. There is no route parameter for an org anywhere on the partner
 * surface, so one partner cannot name another partner's bid even to be told
 * it is forbidden. A campaign that exists but holds no bid for the asking org
 * answers exactly like a campaign that does not exist: 404, same message,
 * because a 403 would confirm there is something there.
 *
 * APPEND-ONLY, AND IN THAT ORDER. A bid's history lives in `bid_revisions`,
 * one immutable row per sealing, and the mutable head in `provider_bids` is a
 * convenience over the latest revision. Writes land revision first, head
 * second: if the second write fails, the sealed record already exists and the
 * next write heals the head, whereas the reverse order could leave a binding
 * bid with no sealed record, which is the one state this table exists to make
 * impossible. Nothing anywhere updates or deletes a revision row, and there
 * is no withdraw path at any layer: no endpoint, no state value, no admin
 * backdoor. The latest revision at close is the binding one.
 *
 * THE CLOSE BOUNDARY IS THE SERVER'S CLOCK. The window is half-open,
 * [opens_at, closes_at): a write received at exactly closes_at is late. The
 * clock reading is captured once per request and used for the gate, the audit
 * row, and `server_received_at`, so the record and the decision cannot
 * disagree.
 */

const crypto = require('crypto');
const datastore = require('./datastore');
const { money } = require('./money');
const mixmath = require('./mixmath');
const { ms } = require('./envelope');
const { badRequest } = require('./errors');

const BIDS = 'provider_bids';
const REVISIONS = 'bid_revisions';

/* The standard tier ladder. Server-owned: a bid names tiers from this list so
   two partners' offers on one cohort are comparable line by line, which is
   what lets households read them side by side. */
const TIER_NAMES = Object.freeze(['100 Mbps', '300 Mbps', '500 Mbps', '1 Gig', '1.5 Gig', '2.5 Gig']);

/* Mirrors partner/core/contract.js. If you change one, change both. */
const TECHS = Object.freeze(['cable', 'fibre', 'dsl', 'fwa']);
const REDUCTION = Object.freeze(['member', 'promo', 'cash', 'none', 'custom']);
const EQUIPMENT = Object.freeze(['inc', 'rent', 'byod']);
const AFTER_MODE = Object.freeze(['none', 'new']);
const GUARANTEE_MONTHS = Object.freeze([12, 24, 36]);

/* A custom reduction label is free text echoed to households, so it is
   validated rather than merely stored: display charset only, and none of the
   pressure or condition language the standard cohort terms forbid. The two
   rules live in lib/mixmath.js (generated from the console's copy) because
   every line item in a custom mix is held to them as well. */
const LABEL_RE = mixmath.LABEL_RE;
const LABEL_BANNED = mixmath.LABEL_BANNED;

/* The head row's columns, in the two-list style desk.js established: tables
   are created by hand, so code and schema deploy separately and in either
   order. The base list is the minimum a bid row cannot be read without; the
   extended list is tried first and the base list is the fallback.

   The original flat shape also carried speed, term, includes and completion.
   Nothing writes them any more (a bid's speeds live in `tiers`, its term in
   `guarantee_months`), and naming a column here is what makes it mandatory to
   create, so they are not named. A table that still has them reads fine; a
   table created today does not need them. */
/* org_id is load-bearing beyond display: awards.seal() writes the winning
   row's org into campaign_awards.org_id, a mandatory column, so a projection
   without it makes every seal insert fail and no award ever exists. */
const BID_COLS = Object.freeze(['bid_key', 'campaign_id', 'org_id', 'price', 'status', 'updated_at']);
const BID_COLS_V2 = Object.freeze(BID_COLS.concat(['tiers', 'guarantee_months',
  'after_mode', 'after_line', 'equipment', 'rental_monthly', 'extra_pod_monthly',
  'reduction_presentation', 'mechanism_label', 'commitment_cap', 'revision_count',
  'receipt_no', 'payload_hash', 'submitted_at', 'last_revised_at']));
/* The sealed custom mix (create-tables.md section 28). One JSON column, read
   ahead of the V2 list and fallen back from, same as V2 is from the base. */
const BID_COLS_V3 = Object.freeze(BID_COLS_V2.concat(['discount_mix']));
/* Widest first. A read tries each until one the table can answer. */
const BID_COL_LISTS = Object.freeze([BID_COLS_V3, BID_COLS_V2, BID_COLS]);

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------------------------------------------ *
 * Validation: request body -> canonical draft
 * ------------------------------------------------------------------ */

/**
 * Validate a bid body and return the canonical draft, or throw a 400 that
 * names the field and the tier. Server-side always, whatever the client
 * allowed: every rule here has a bypass attempt with its name on it.
 *
 * `householdCount` is the cohort's current household figure; the commitment
 * cap may not exceed it, and an oversized cap is a 400, never a silent clamp.
 */
function readBid(body, householdCount) {
  const b = body || {};

  if (!Array.isArray(b.tiers) || b.tiers.length < 1) {
    throw badRequest('Add at least one tier to the bid.');
  }
  if (b.tiers.length > TIER_NAMES.length) {
    throw badRequest('A bid carries at most six tiers, one per standard speed.');
  }

  const afterMode = String(b.afterMode || '').trim();
  if (AFTER_MODE.indexOf(afterMode) < 0) {
    throw badRequest('State what happens after the guarantee: a new rate, or no scheduled change.');
  }

  const seen = new Set();
  const tiers = b.tiers.map((t, i) => {
    const row = t || {};
    const name = String(row.name || '').trim();
    if (TIER_NAMES.indexOf(name) < 0) {
      throw badRequest(`Pick a standard tier for row ${i + 1}.`);
    }
    if (seen.has(name)) {
      throw badRequest(`${name} appears twice. One row per tier.`);
    }
    seen.add(name);

    const technology = String(row.technology || '').trim().toLowerCase();
    if (TECHS.indexOf(technology) < 0) {
      throw badRequest(`Pick the technology serving ${name}.`);
    }
    const uploadMbps = String(row.uploadMbps == null ? '' : row.uploadMbps).trim();
    if (!/^[0-9]{1,5}$/.test(uploadMbps)) {
      throw badRequest(`State the upload speed on ${name}, in Mbps.`);
    }

    const stickerPrice = money(row.stickerPrice, 500);
    if (!stickerPrice) throw badRequest(`Enter the sticker price on ${name}: over $0, at most $500.`);
    const effectivePrice = money(row.effectivePrice, 500);
    if (!effectivePrice) throw badRequest(`Enter the effective price on ${name}: over $0, at most $500.`);
    if (Number(effectivePrice) > Number(stickerPrice)) {
      throw badRequest(`Effective price cannot sit above sticker on ${name}.`);
    }

    let afterPrice = null;
    if (afterMode === 'new') {
      afterPrice = money(row.afterPrice, 500);
      if (!afterPrice) {
        throw badRequest(`State the after-guarantee rate on ${name}, or choose "no scheduled change" for the whole bid.`);
      }
    }

    /* Key order is the canonical payload order; see draftPayload. */
    return { name, uploadMbps, technology, stickerPrice, effectivePrice, afterPrice };
  });

  /* Ladder order, so two revisions of the same offer serialize identically. */
  tiers.sort((a, c) => TIER_NAMES.indexOf(a.name) - TIER_NAMES.indexOf(c.name));

  const guaranteeMonths = toInt(b.guaranteeMonths);
  if (GUARANTEE_MONTHS.indexOf(guaranteeMonths) < 0) {
    throw badRequest('The price guarantee is 12, 24 or 36 months.');
  }

  const committedHouseholds = toInt(b.committedHouseholds);
  if (!committedHouseholds || committedHouseholds < 1) {
    throw badRequest('Commit to at least one household.');
  }
  if (householdCount && committedHouseholds > householdCount) {
    throw badRequest(`This cohort has ${householdCount} households; the commitment cannot exceed that.`);
  }

  const reductionPresentation = String(b.reductionPresentation || '').trim();
  if (REDUCTION.indexOf(reductionPresentation) < 0) {
    throw badRequest('Pick how the reduction reads to households.');
  }
  let mechanismLabel = null;
  if (reductionPresentation === 'custom') {
    mechanismLabel = String(b.mechanismLabel || '').trim();
    if (!LABEL_RE.test(mechanismLabel)) {
      throw badRequest('Describe the reduction in 3 to 40 plain characters.');
    }
    if (LABEL_BANNED.test(mechanismLabel)) {
      throw badRequest('That label reads as pressure or a condition. The standard terms keep reductions unconditional.');
    }
  }
  const discountMix = reductionPresentation === 'custom'
    ? readMix(b.discountMix, tiers, guaranteeMonths)
    : null;

  const equipment = String(b.equipment || '').trim();
  if (EQUIPMENT.indexOf(equipment) < 0) {
    throw badRequest('State the equipment terms: included, rental, or bring your own.');
  }
  let rentalMonthly = null;
  if (equipment === 'rent') {
    rentalMonthly = money(b.rentalMonthly, 50);
    if (!rentalMonthly) throw badRequest('State the monthly gateway rental: over $0, at most $50.');
  }
  /* Zero or absent means included, stored as null: free is the absence of a
     line, the same rule lib/money.js applies everywhere. */
  const extraPodMonthly = money(b.extraPodMonthly, 50);

  const afterLine = afterMode === 'none'
    ? 'no scheduled change'
    : tiers.map((t) => `$${t.afterPrice} / ${t.name}`).join(', ');

  return {
    tiers, reductionPresentation, mechanismLabel, discountMix, guaranteeMonths,
    afterMode, afterLine, equipment, rentalMonthly, extraPodMonthly,
    committedHouseholds,
  };
}

/**
 * The custom mix, validated and sealed as cents.
 *
 * The body carries shares only: `{ applyToAll, tiers: [{ tier, rows: [{ type,
 * label, sharePct }] }] }`. The money is computed HERE, by the same
 * mixmath.tierSnapshot() the console showed the partner, and stored with the
 * bid, so the household surface reads cents it never has to derive. A tier
 * whose sticker equals its effective has no reduction to name and seals an
 * empty mix; every other tier needs rows whose shares total exactly 100%.
 *
 * `applyToAll` is recorded as the partner set it, so reopening the terms
 * restores the editor they used and not merely the numbers.
 */
function readMix(raw, tiers, guaranteeMonths) {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!m || !Array.isArray(m.tiers)) {
    throw badRequest('Set the mix that names this reduction: one row per step, shares totalling 100%.');
  }
  const byTier = new Map();
  m.tiers.forEach((t) => {
    if (t && typeof t.tier === 'string') byTier.set(t.tier.trim(), Array.isArray(t.rows) ? t.rows : []);
  });
  const snapTiers = tiers.map((t) => {
    const gap = mixmath.toCents(t.stickerPrice) - mixmath.toCents(t.effectivePrice);
    if (gap <= 0) return mixmath.tierSnapshot(t, [], guaranteeMonths);
    const rows = byTier.get(t.name);
    if (!rows || !rows.length) {
      throw badRequest(`Set the mix on ${t.name}: the reduction there needs at least one named row.`);
    }
    const clean = rows.map((r) => {
      const row = r || {};
      return {
        type: String(row.type || '').trim(),
        label: String(row.label || '').trim(),
        sharePct: String(row.sharePct === undefined || row.sharePct === null ? '' : row.sharePct).trim(),
      };
    });
    const check = mixmath.checkMix(clean);
    if (!check.ok) throw badRequest(`${t.name}: ${check.problems[0]}`);
    return mixmath.tierSnapshot(t, clean, guaranteeMonths);
  });
  const out = { applyToAll: Boolean(m.applyToAll), tiers: snapTiers };
  /* The column is Text 10000. Six tiers of five rows is under half that;
     anything past it is not a mix a partner typed. */
  if (JSON.stringify(out).length > 10000) throw badRequest('That mix is too long to seal.');
  return out;
}

/** A stored discount_mix JSON as the sealed object, or null. */
function parseMix(raw) {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    return m && typeof m === 'object' && Array.isArray(m.tiers) ? m : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The canonical payload and its hash
 * ------------------------------------------------------------------ */

/**
 * The exact JSON a revision seals. Fixed key order, built from a draft that
 * readBid() constructed in fixed key order, so the same offer always
 * serializes to the same bytes and the hash is a real duplicate detector.
 */
function draftPayload(campaignId, d) {
  return JSON.stringify({
    campaignId,
    tiers: d.tiers,
    reductionPresentation: d.reductionPresentation,
    mechanismLabel: d.mechanismLabel,
    /* Present only on a custom bid, so the bytes of every other bid, and
       therefore its hash, are what they were before the mix could seal. */
    ...(d.discountMix ? { discountMix: d.discountMix } : {}),
    guaranteeMonths: d.guaranteeMonths,
    afterMode: d.afterMode,
    afterLine: d.afterLine,
    equipment: d.equipment,
    rentalMonthly: d.rentalMonthly,
    extraPodMonthly: d.extraPodMonthly,
    committedHouseholds: d.committedHouseholds,
  });
}

const hashPayload = (payload) => crypto.createHash('sha256').update(payload).digest('hex');

/**
 * A sealed receipt number. Random, not sequential: a sequence would let any
 * partner infer how many bids exist across the platform from their own
 * receipt, and bid counts are sealed like everything else. The charset
 * passes datastore.lit() should a receipt ever need to be looked up.
 */
const receiptNo = () => 'WB-' + crypto.randomBytes(4).toString('hex').toUpperCase();

/* ------------------------------------------------------------------ *
 * The improvement rule
 * ------------------------------------------------------------------ */

/**
 * Problems with `next` as an improvement over the head draft, empty when it
 * qualifies. An improvement must be at least as good on every tier present in
 * both: no raised effective price, no worsened after-rate, no shortened
 * guarantee, no reduced commitment. Tiers may be added; a tier already sealed
 * may not be dropped, because dropping is a withdrawal in miniature.
 *
 * A legacy head with no tier record (rows from before the auction core) skips
 * the per-tier comparison; the scalar rules still apply where the head has
 * values.
 */
function improvementProblems(head, next) {
  const problems = [];
  const nextBy = {};
  next.tiers.forEach((t) => { nextBy[t.name] = t; });

  (head.tiers || []).forEach((h) => {
    const n = nextBy[h.name];
    if (!n) {
      problems.push(`${h.name} was sealed and cannot be dropped`);
      return;
    }
    if (Number(n.effectivePrice) > Number(h.effectivePrice)) {
      problems.push(`${h.name} effective price rises from $${h.effectivePrice}`);
    }
    if (h.afterPrice && n.afterPrice && Number(n.afterPrice) > Number(h.afterPrice)) {
      problems.push(`${h.name} after-guarantee rate worsens from $${h.afterPrice}`);
    }
  });

  if (head.guaranteeMonths && next.guaranteeMonths < head.guaranteeMonths) {
    problems.push(`the guarantee shortens from ${head.guaranteeMonths} months`);
  }
  if (head.committedHouseholds && next.committedHouseholds < head.committedHouseholds) {
    problems.push(`the commitment drops from ${head.committedHouseholds} households`);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

function parseTiers(raw) {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw);
    return Array.isArray(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * A head row, wire-shaped. The shape is partner/demo/fixtures.js SEALED_BID:
 * the fixtures are the executable contract, and this function is the server
 * side of it. A legacy row that predates the tier record degrades to a single
 * synthesized tier from its flat price, so nothing renders blank.
 */
function publicBid(row) {
  const tiers = parseTiers(row.tiers) || (row.price ? [{
    name: '', uploadMbps: '', technology: '',
    stickerPrice: row.price, effectivePrice: row.price, afterPrice: null,
  }] : []);
  return {
    campaignId: row.campaign_id,
    version: toInt(row.revision_count) || 1,
    state: row.status,
    placedAt: ms(row.submitted_at) || ms(row.updated_at),
    reference: row.receipt_no || null,
    tiers,
    reductionPresentation: row.reduction_presentation || null,
    mechanismLabel: row.mechanism_label || null,
    discountMix: parseMix(row.discount_mix),
    guaranteeMonths: toInt(row.guarantee_months),
    afterMode: row.after_mode || null,
    afterLine: row.after_line || null,
    equipment: row.equipment || null,
    rentalMonthly: row.rental_monthly || null,
    extraPodMonthly: row.extra_pod_monthly || null,
    committedHouseholds: toInt(row.commitment_cap),
    updatedAt: ms(row.updated_at),
  };
}

/** The comparable draft a head row implies, for the improvement rule. */
function headDraft(row) {
  return {
    tiers: parseTiers(row.tiers),
    guaranteeMonths: toInt(row.guarantee_months),
    committedHouseholds: toInt(row.commitment_cap),
  };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * Try each column list, widest first, until the table answers. Null when
 * none does. Tables are created by hand, so a column named here may not
 * exist yet, and asking for it throws; this is the fallback that turns that
 * into a narrower read rather than an unreadable table.
 */
async function firstReadable(read) {
  for (const cols of BID_COL_LISTS) {
    try {
      return await read(cols);
    } catch {
      /* next, narrower list */
    }
  }
  return null;
}

/** Every head row for an org, or null when the table is unreadable. */
async function bidRows(catalystApp, orgId) {
  const where = `org_id = ${datastore.lit(orgId)}`;
  return firstReadable((cols) => datastore.queryAll(catalystApp, BIDS, cols, where));
}

/**
 * Every head row on ONE campaign, across all orgs. Null when unreadable.
 *
 * Three sanctioned readers and no others: the member-facing offer route, the
 * one place bids from different orgs are compared for a household;
 * awards.sealFromCampaign, which compares them to seal and lets only the
 * award row out; and the admin sealed-bids review, which is staff-only and
 * campaign-scoped. It is safe there and nowhere else: a member sees one
 * winning offer, a partner never sees another partner's bid. Do not reach for
 * this from a /provider route; go through awards.sealFromCampaign.
 */
async function campaignBidRows(catalystApp, campaignId) {
  const where = `campaign_id = ${datastore.lit(campaignId)}`;
  return firstReadable((cols) => datastore.queryAll(catalystApp, BIDS, cols, where));
}

/** The org's head row for one campaign, or null. Extended columns first. */
async function headRow(catalystApp, bidKey) {
  return firstReadable((cols) => datastore.findBy(catalystApp, BIDS, 'bid_key', bidKey, ['ROWID'].concat(cols)));
}

/** All revision rows for a bid key, ascending. Throws if the table is absent. */
async function revisionRows(catalystApp, bidKey) {
  const rows = await datastore.queryAll(
    catalystApp, REVISIONS,
    ['revision_key', 'revision_no', 'payload', 'payload_hash', 'receipt_no', 'server_received_at'],
    `bid_key = ${datastore.lit(bidKey)}`
  );
  return rows.sort((a, b) => (toInt(a.revision_no) || 0) - (toInt(b.revision_no) || 0));
}

/**
 * Seal one revision: the append-only write, revision before head.
 *
 * The revision number is counted from the revisions table, not read from the
 * head: the head is a convenience and can lag a crash, and counting is what
 * heals it. The unique revision_key is the race guard: two concurrent writes
 * computing the same next number collide there, and the loser learns it was
 * behind. Returns { revisionNo, receipt } or throws with `conflict: true` set
 * when the unique key lost a race.
 */
async function sealRevision(catalystApp, { bidKey, campaignId, orgId, userId, payload, payloadHash, receivedAt }) {
  const existing = await revisionRows(catalystApp, bidKey);
  const revisionNo = existing.length + 1;
  const receipt = receiptNo();
  try {
    await datastore.insertRow(catalystApp, REVISIONS, {
      revision_key: `${bidKey}:${revisionNo}`.slice(0, 200),
      bid_key: bidKey,
      campaign_id: campaignId,
      org_id: orgId,
      revision_no: revisionNo,
      payload,
      payload_hash: payloadHash,
      receipt_no: receipt,
      submitted_by: userId,
      server_received_at: datastore.toDb(new Date(receivedAt)),
    });
  } catch (err) {
    /* Distinguish "lost the race" from "table broken" by looking for the row
       that beat us, not by parsing driver messages. */
    let winner = null;
    try {
      winner = await datastore.findBy(catalystApp, REVISIONS, 'revision_key',
        `${bidKey}:${revisionNo}`.slice(0, 200), ['ROWID']);
    } catch { winner = null; }
    const e = new Error(String((err && err.message) || err).slice(0, 200));
    e.conflict = Boolean(winner);
    throw e;
  }
  return { revisionNo, receipt };
}

module.exports = {
  BIDS, REVISIONS, BID_COLS, BID_COLS_V2, BID_COLS_V3, parseMix,
  TIER_NAMES, TECHS, REDUCTION, EQUIPMENT, AFTER_MODE, GUARANTEE_MONTHS,
  readBid, draftPayload, hashPayload, receiptNo,
  improvementProblems, publicBid, headDraft,
  bidRows, campaignBidRows, headRow, revisionRows, sealRevision,
};
