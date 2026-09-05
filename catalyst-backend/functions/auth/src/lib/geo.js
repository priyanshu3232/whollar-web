'use strict';

/**
 * Postal codes and FSAs: the member half of a cohort's geography.
 *
 * A cohort has TWO geographic keys and they answer two different questions.
 *
 *   region   the name. The PARTNER key. requireActiveCoverage() in
 *            routes/desk.js matches a bid to declared coverage with
 *            slug(coverage.region) === slug(campaign.region), exactly, and
 *            lib/places.js is the vocabulary both sides are held to. Nothing
 *            in this file touches it, and nothing here may ever be allowed to
 *            replace it: a campaign whose name leaves that vocabulary is a
 *            campaign no partner can bid on, and it looks like a quiet market
 *            rather than a typo for as long as it runs.
 *
 *   fsas     the set of forward sortation areas the cohort covers. The MEMBER
 *            key, added here. It decides which households may join, and it
 *            never crosses to a partner.
 *
 * Two keys, two audiences, one row. Neither derives the other: an FSA does not
 * know which of Toronto's twenty region names it sits inside, and a region
 * name is a label an operator chose. Both are set on the campaign by hand and
 * both are validated on the write path.
 *
 * WHY THE FSA AND NOT THE POSTAL CODE. The LDU (the last three characters)
 * identifies a delivery point, sometimes a single building. Eligibility keyed
 * on it would be a map of who lives where held in the campaigns table. The FSA
 * is the coarsest unit that still means "my area" to a household, so it is the
 * only geography that ever leaves this file.
 *
 * PURE. No Data Store, no clock, no request. Unit-tested from scripts/ through
 * backend-module.mjs.
 */

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/**
 * Canada Post never issues these as the first character: D, F, I, O, Q, U
 * are excluded across the whole code because they are read as digits or as
 * each other by sorting equipment, and W and Z are additionally excluded from
 * the leading position (no province was ever assigned them).
 */
const FIRST_BANNED = 'DFIOQUWZ';

/** The same six, excluded from the two inner letter positions. */
const INNER_BANNED = 'DFIOQU';

const SHAPE = /^[A-Z]\d[A-Z]\d[A-Z]\d$/;

/**
 * A postal code as typed -> the three forms the rest of the stack uses, or an
 * error. THE SERVER RESULT ALWAYS WINS: js/whollar-postal.js is the same
 * algorithm in the browser and it exists to save a round trip, never to decide
 * anything. lib/users.js has derived the FSA server side since the first
 * signup for the reason stated there, and this only makes the derivation
 * shared and testable rather than three regexes in three routes.
 *
 * Rural codes (second character 0) are valid here and treated identically. An
 * FSA like P0T covers thousands of square kilometres, so a rural cohort scoped
 * to one is a cohort scoped to a region larger than the GTA. That is a
 * campaign-design problem for the operator, not a validation problem: refusing
 * the code would refuse the household.
 *
 * @returns {{postal_code:string, fsa:string, display:string}|{error:string}}
 */
function normalizePostalCode(raw) {
  const s = String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[\s -]+/g, '');
  if (s.length !== 6 || !SHAPE.test(s)) return { error: 'invalid_postal_code' };
  if (FIRST_BANNED.includes(s[0])) return { error: 'invalid_postal_code' };
  if (INNER_BANNED.includes(s[2]) || INNER_BANNED.includes(s[4])) {
    return { error: 'invalid_postal_code' };
  }
  return { postal_code: s, fsa: s.slice(0, 3), display: `${s.slice(0, 3)} ${s.slice(3)}` };
}

/** The FSA of a normalized code. Never taken from a separate input. */
const fsaOf = (postal) => {
  const r = normalizePostalCode(postal);
  return r.error ? null : r.fsa;
};

/** Is this string shaped like an FSA on its own? Same letter rules. */
function isFsa(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[\s -]+/g, '');
  if (!/^[A-Z]\d[A-Z]$/.test(s)) return false;
  return !FIRST_BANNED.includes(s[0]) && !INNER_BANNED.includes(s[2]);
}

/* ------------------------------------------------------------------ *
 * A campaign's FSA set
 * ------------------------------------------------------------------ */

/**
 * The stored `campaigns.fsas` string -> a sorted, deduplicated array.
 *
 * ONE COLUMN, NOT A TABLE. A campaign holds between one and a couple of dozen
 * FSAs and the set changes when an operator decides it does. A campaign_fsas
 * table would buy a per-FSA audit trail at the cost of a second read inside
 * the one read layer, a uniqueness constraint the Data Store cannot express,
 * and the constraint-insert re-query on every save. The audit trail already
 * exists in auth_events, which records the before and after of every campaign
 * write, and grandfathering (an FSA removed from a cohort a household already
 * joined) is answered by the seat claim's own fsa_at_join snapshot rather than
 * by a removed_at column.
 *
 * Anything unparseable is DROPPED rather than throwing: this runs on the read
 * path, and a hand-edited row with one bad entry must not take the whole
 * catalog down. The write path (routes/admin.js) refuses the bad entry loudly,
 * which is where a human is present to fix it.
 */
function parseFsaList(raw) {
  if (!raw) return [];
  const seen = new Set();
  for (const part of String(raw).split(/[^A-Za-z0-9]+/)) {
    const s = part.toUpperCase();
    if (isFsa(s)) seen.add(s);
  }
  return Array.from(seen).sort();
}

/** The array -> the stored string. Sorted, so a diff of two saves reads. */
const formatFsaList = (list) => parseFsaList((list || []).join(',')).join(',');

/* ------------------------------------------------------------------ *
 * Eligibility
 * ------------------------------------------------------------------ */

/**
 * The four answers, and what each one means to a household.
 *
 *   eligible       your postal code is in this cohort and it is taking joins
 *   already_joined you are in it (or on its list); nothing to decide
 *   joins_closed   your postal code is in it, and it has moved past joining
 *   not_in_area    it covers somewhere else
 *
 * And a fifth that is not a member-facing answer at all:
 *
 *   unscoped       this campaign has no FSA set yet
 *
 * UNSCOPED IS THE MIGRATION, AND IT IS DELIBERATELY PERMISSIVE. Every campaign
 * that existed before this file had no FSA set, and reading an empty set as
 * "nobody is eligible" would, on the deploy that shipped it, close every live
 * cohort to every household at once with no error anywhere: the dashboards
 * would render, the counts would hold, and joining would simply stop working.
 * That is the exact failure this codebase refuses elsewhere (a cohort named
 * outside the coverage vocabulary, a seed count nobody can cash), so an empty
 * set means what it has always meant, which is that this cohort is not scoped
 * and anyone may join it.
 *
 * It is not a resting state. routes/admin.js refuses to move a campaign into a
 * joinable kind with no FSA set, so no NEW unscoped cohort can be created, and
 * /admin/campaigns/reconcile lists every existing one until an operator scopes
 * it. The permissiveness is a ramp, and the ramp is visible.
 *
 * @param {object} campaign   catalog row: { fsas: string[], ... }
 * @param {string|null} memberFsa
 * @param {boolean} acceptsJoins  catalog.JOIN_STATUS plus the join window
 * @param {boolean} mine          this member already has a standing on it
 */
function eligibilityOf(campaign, memberFsa, acceptsJoins, mine) {
  if (mine) return 'already_joined';
  const fsas = (campaign && campaign.fsas) || [];
  if (!fsas.length) return acceptsJoins ? 'unscoped' : 'joins_closed';
  if (!memberFsa) return 'not_in_area';
  if (!fsas.includes(memberFsa)) return 'not_in_area';
  return acceptsJoins ? 'eligible' : 'joins_closed';
}

/** May a household with this answer take a seat? The join guard's whole test. */
const JOINABLE_ELIGIBILITY = Object.freeze(['eligible', 'already_joined', 'unscoped']);
const canJoin = (eligibility) => JOINABLE_ELIGIBILITY.includes(eligibility);

/* ------------------------------------------------------------------ *
 * Nearby: the rail's ORDER, and never a permission
 * ------------------------------------------------------------------ */

/**
 * Which tier a campaign lands in for a member, lowest first. Ordering only:
 * tier 5 and tier 1 are equally joinable or equally not, and the answer to
 * that is eligibilityOf() alone.
 *
 *   0  eligible or joins-closed in the member's own FSA
 *   1  shares the member FSA's city
 *   2  shares the member FSA's province
 *   3  everything else
 *
 * The brief's distance tier sits between 1 and 2 and is not implemented: the
 * FSA reference this ships with (GeoNames, via js/whollar-fsa-cities.js) has
 * no centroids, and a great-circle distance computed from a city name would be
 * a number with no measurement behind it. The tiers degrade in exactly the
 * order the brief specifies, so adding centroids later inserts a tier without
 * moving anything else.
 *
 * @param {object} ref  lib/fsaref.js, or any { lookup(fsa) } shape
 */
function nearbyTier(campaign, memberFsa, eligibility, ref) {
  if (eligibility === 'eligible' || eligibility === 'joins_closed'
      || eligibility === 'already_joined' || eligibility === 'unscoped') {
    if (((campaign && campaign.fsas) || []).includes(memberFsa)) return 0;
  }
  const home = memberFsa && ref ? ref.lookup(memberFsa) : null;
  if (!home) return 3;
  const theirs = ((campaign && campaign.fsas) || [])
    .map((f) => ref.lookup(f)).filter(Boolean);
  if (!theirs.length) return 3;
  if (theirs.some((p) => p.city === home.city && p.province === home.province)) return 1;
  if (theirs.some((p) => p.province === home.province)) return 2;
  return 3;
}

module.exports = {
  FIRST_BANNED, INNER_BANNED,
  normalizePostalCode, fsaOf, isFsa,
  parseFsaList, formatFsaList,
  eligibilityOf, canJoin, JOINABLE_ELIGIBILITY,
  nearbyTier,
};
