#!/usr/bin/env node
/* Member provider exclusions: the brand family rules and the per-member price
 * book.
 *
 *   node --test scripts/test-exclusions.mjs
 *
 * WHAT THIS FILE EXISTS FOR. The promise made to a household is absolute:
 * "excluded providers will never be able to send you an offer". That is not a
 * rendering rule, so it cannot be checked by looking at a screen. It is a
 * property of the resolution: for a member holding an exclusion, no bid from
 * that brand may appear in the book their window is cut from, whatever the
 * price, and the next eligible bid at that tier must be there instead at its
 * OWN price.
 *
 * The canonical scenario of the brief's section 9.1 is the first test below,
 * and it is the one that would catch a regression that mattered: bid A cheaper
 * under an excluded brand, bid B dearer under a brand the member is open to,
 * a control member with no exclusions, and both resolved from the same inputs.
 *
 * Everything here is pure. The award filter, the family expansion and the
 * exclusion write plan are all functions over row arrays, which is why they
 * are written that way: the property worth testing is the decision, and a
 * decision that needs a datastore to be tested is a decision nobody tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { backend } from './backend-module.mjs';

const awards = backend('lib/awards.js');
const brands = backend('lib/brands.js');
const exclusions = backend('lib/exclusions.js');
const rosters = backend('lib/rosters.js');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A bid row shaped as lib/bids.js publicBid() reads it. */
function bid({ org, brand = null, tiers, commitment = null, at = 1000 }) {
  return {
    bid_key: `camp-1:${org}`,
    campaign_id: 'camp-1',
    org_id: org,
    brand_id: brand,
    status: 'sealed',
    price: String(tiers[0].effectivePrice),
    tiers: JSON.stringify(tiers),
    guarantee_months: 12,
    after_mode: 'none',
    equipment: 'inc',
    commitment_cap: commitment,
    submitted_at: new Date(at).toISOString().slice(0, 19).replace('T', ' '),
    updated_at: new Date(at).toISOString().slice(0, 19).replace('T', ' '),
  };
}

const tier = (name, price, extra = {}) => Object.assign({
  name, effectivePrice: String(price), technology: 'fibre', uploadMbps: 100,
}, extra);

const REGISTRY = [
  { brand_id: 'bell', display_name: 'Bell', parent_brand_id: null, status: 'active' },
  { brand_id: 'virgin-plus', display_name: 'Virgin Plus', parent_brand_id: 'bell', status: 'active' },
  { brand_id: 'lucky-mobile', display_name: 'Lucky Mobile', parent_brand_id: 'bell', status: 'active' },
  { brand_id: 'rogers', display_name: 'Rogers', parent_brand_id: null, status: 'active' },
  { brand_id: 'fido', display_name: 'Fido', parent_brand_id: 'rogers', status: 'active' },
  { brand_id: 'oxio', display_name: 'oxio', parent_brand_id: null, status: 'active' },
  { brand_id: 'videotron', display_name: 'Vidéotron', parent_brand_id: null, status: 'active' },
  { brand_id: 'ebox', display_name: 'EBOX', parent_brand_id: null, status: 'retired' },
  { brand_id: 'newco', display_name: 'NewCo', parent_brand_id: null, status: 'pending_review' },
];

const statusOf = (id) => (REGISTRY.filter((r) => r.brand_id === id)[0] || {}).status || null;

/* ------------------------------------------------------------------ *
 * The canonical scenario: section 9.1
 * ------------------------------------------------------------------ */

test('section 9.1: the cheaper excluded bid is skipped and the next eligible one wins', () => {
  /* Bid A: 4,500 cents a month under brand X (bell). Bid B: 4,900 under Y
     (rogers). Both quote the same tier, which is what makes them rivals. */
  const rows = [
    bid({ org: 'org-x', brand: 'bell', tiers: [tier('500 Mbps', 45)], at: 1000 }),
    bid({ org: 'org-y', brand: 'rogers', tiers: [tier('500 Mbps', 49)], at: 2000 }),
  ];

  /* Member M excluded brand X. */
  const m = awards.bookForMember(rows, null, {
    excluded: new Set(['bell']), statusOf,
  });
  /* Member N excluded nothing. */
  const n = awards.bookForMember(rows, null, { excluded: new Set(), statusOf });

  assert.equal(m.book.length, 1, 'M still has an offer at the tier');
  assert.equal(m.book[0].orgId, 'org-y', 'M is awarded the dearer eligible bid');
  assert.equal(m.book[0].price, '49', 'and at that bid\'s own price: nothing is re-priced');

  assert.equal(n.book[0].orgId, 'org-x', 'the control member gets the cheaper bid');
  assert.equal(n.book[0].price, '45');

  /* M's audit says why, and the excluded bid is named there and NOWHERE else. */
  const audit = awards.auditWithOutcome(m.audit, m.book);
  const skipped = audit.filter((r) => r.status === 'skipped_excluded_brand');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].brandId, 'bell');
  assert.equal(audit.filter((r) => r.status === 'awarded').length, 1);
});

test('section 9.1 generalises across tiers, which a flat ranking cannot', () => {
  /* The reason the brief's flat model was not implemented as written. Partner
     X is cheapest at 500 Mbps, partner Y at 1 Gig. A member excluding X must
     keep a 1 Gig offer and lose only the 500 Mbps one. */
  const rows = [
    bid({ org: 'org-x', brand: 'bell', tiers: [tier('500 Mbps', 45), tier('1 Gig', 90)] }),
    bid({ org: 'org-y', brand: 'rogers', tiers: [tier('500 Mbps', 49), tier('1 Gig', 80)] }),
  ];

  const n = awards.bookForMember(rows, null, { excluded: new Set(), statusOf });
  assert.deepEqual(n.book.map((e) => [e.tier, e.orgId]),
    [['500 Mbps', 'org-x'], ['1 Gig', 'org-y']],
    'unfiltered, each tier goes to whoever bid it lowest');

  const m = awards.bookForMember(rows, null, { excluded: new Set(['bell']), statusOf });
  assert.deepEqual(m.book.map((e) => [e.tier, e.orgId, e.price]),
    [['500 Mbps', 'org-y', '49'], ['1 Gig', 'org-y', '80']],
    'excluding X moves 500 Mbps to Y and leaves 1 Gig where it was');
});

test('every bid excluded leaves an empty book, not an error', () => {
  const rows = [
    bid({ org: 'org-x', brand: 'bell', tiers: [tier('500 Mbps', 45)] }),
    bid({ org: 'org-v', brand: 'virgin-plus', tiers: [tier('1 Gig', 80)] }),
  ];
  const m = awards.bookForMember(rows, null, {
    excluded: new Set(['bell', 'virgin-plus']), statusOf,
  });
  assert.deepEqual(m.book, [], 'edge case 2: the standard no-offers state');
  assert.equal(m.audit.filter((r) => r.status === 'skipped_excluded_brand').length, 2);
});

/* ------------------------------------------------------------------ *
 * The safety property: what happens when a brand cannot be resolved
 * ------------------------------------------------------------------ */

test('a member with no exclusions keeps every bid, including brandless ones', () => {
  /* Load-bearing rather than an optimisation: this feature must not be able to
     cost an offer to a household that never asked for anything. An
     unresolvable brand is kept for them, because there is no promise to keep
     and dropping it would protect nobody. */
  const rows = [
    bid({ org: 'org-x', brand: null, tiers: [tier('500 Mbps', 45)] }),
    bid({ org: 'org-y', brand: null, tiers: [tier('1 Gig', 80)] }),
  ];
  const out = awards.bookForMember(rows, null, {
    excluded: new Set(), brandMap: null, statusOf,
  });
  assert.equal(out.book.length, 2, 'both brandless bids survive');
  assert.equal(out.filtered, false);
  assert.ok(out.audit.every((r) => r.status === 'eligible'));
});

test('edge case 13 applies to EVERY member, exclusions or not', () => {
  /* The brand-status filter has wider reach than the exclusion filter: an
     operator retiring a brand is saying it must not reach households, and
     honouring that only for members who happen to hold an unrelated exclusion
     would make what a household is shown depend on somebody else's choice. */
  const rows = [
    bid({ org: 'org-e', brand: 'ebox', tiers: [tier('500 Mbps', 40)] }),
    bid({ org: 'org-y', brand: 'rogers', tiers: [tier('500 Mbps', 49)] }),
  ];
  const plain = awards.bookForMember(rows, null, { excluded: new Set(), statusOf });
  assert.equal(plain.book.length, 1, 'a member with no exclusions is still spared it');
  assert.equal(plain.book[0].orgId, 'org-y');
  assert.equal(
    plain.audit.filter((r) => r.status === 'invalidated_brand_inactive').length, 1);

  /* And a pending_review brand, which is not a brand yet, the same way. */
  const pending = awards.bookForMember(
    [bid({ org: 'org-n', brand: 'newco', tiers: [tier('500 Mbps', 30)] })],
    null, { excluded: new Set(), statusOf });
  assert.deepEqual(pending.book, [], 'an unverified listing cannot win a tier');
});

test('a brand whose status is unknown is not treated as retired', () => {
  /* The asymmetry that keeps the status filter safe. A brand missing from the
     registry read is unknown, not inactive, and dropping its bid on that basis
     would let one unreadable row empty a cohort's book. */
  const rows = [bid({ org: 'org-x', brand: 'not-in-registry', tiers: [tier('500 Mbps', 45)] })];
  const out = awards.bookForMember(rows, null, { excluded: new Set(), statusOf });
  assert.equal(out.book.length, 1, 'the bid stands');
  assert.equal(out.audit[0].status, 'eligible');
});

test('a brandless bid is attributed to the org primary brand, so an exclusion still bites', () => {
  /* Every bid sealed before provider_bids.brand_id existed. Without the
     fallback the household that excluded Bell would receive Bell's older bid. */
  const rows = [bid({ org: 'org-x', brand: null, tiers: [tier('500 Mbps', 45)] })];
  const brandMap = new Map([['org-x', 'bell']]);

  assert.equal(awards.brandOfBid(rows[0], brandMap), 'bell');

  const m = awards.bookForMember(rows, null, {
    excluded: new Set(['bell']), brandMap, statusOf,
  });
  assert.deepEqual(m.book, [], 'the historical bid is excluded too');
  assert.equal(m.audit[0].status, 'skipped_excluded_brand');
});

test('an unresolvable brand is skipped for a member holding exclusions, not passed through', () => {
  /* The reversible mistake. Passing it through could deliver an offer the
     household refused, which is the one thing promised impossible; skipping it
     costs an offer they may have wanted, which they can see and undo. */
  const rows = [bid({ org: 'org-unknown', brand: null, tiers: [tier('500 Mbps', 45)] })];
  const m = awards.bookForMember(rows, null, {
    excluded: new Set(['bell']), brandMap: new Map(), statusOf,
  });
  assert.deepEqual(m.book, []);
  assert.equal(m.audit[0].status, 'skipped_unresolved_brand');
});

test('edge case 13 also holds alongside an unrelated exclusion', () => {
  const rows = [
    bid({ org: 'org-e', brand: 'ebox', tiers: [tier('500 Mbps', 40)] }),
    bid({ org: 'org-y', brand: 'rogers', tiers: [tier('500 Mbps', 49)] }),
  ];
  /* The two filters compose: a retired brand goes for the status reason and
     the member's own exclusion is of something else entirely. */
  const m = awards.bookForMember(rows, null, {
    excluded: new Set(['oxio']), statusOf,
  });
  assert.equal(m.book.length, 1);
  assert.equal(m.book[0].orgId, 'org-y', 'the retired brand cannot win a tier');
  const inv = m.audit.filter((r) => r.status === 'invalidated_brand_inactive');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].brandId, 'ebox');
});

/* ------------------------------------------------------------------ *
 * The tiebreak, which must stay the shipped one
 * ------------------------------------------------------------------ */

test('equal prices resolve by the shipped tie ladder, and identically twice', () => {
  /* CONFIRM-EXCL-08 asked for "earliest submission". There is already a
     tiebreak in this system and it is richer: after-rate, then commitment,
     then earlier seal, then bid key. Adopting the brief's default would have
     changed which partner wins live cohorts having nothing to do with
     exclusions, so the shipped ladder stands. This asserts it, so a future
     change to it is a deliberate one. */
  const rows = [
    bid({ org: 'org-a', brand: 'rogers', tiers: [tier('500 Mbps', 45)], commitment: 10, at: 5000 }),
    bid({ org: 'org-b', brand: 'oxio', tiers: [tier('500 Mbps', 45)], commitment: 40, at: 9000 }),
  ];
  const first = awards.bookForMember(rows, null, { excluded: new Set(['bell']), statusOf });
  const second = awards.bookForMember(rows, null, { excluded: new Set(['bell']), statusOf });

  assert.equal(first.book[0].orgId, 'org-b',
    'higher commitment wins the tie, not the earlier submission');
  assert.equal(first.book[0].tieRule, 'commitment');
  assert.deepEqual(first.book, second.book, 'idempotent: two runs, one answer');
});

/* ------------------------------------------------------------------ *
 * Brand families
 * ------------------------------------------------------------------ */

test('a parent expands to its active flankers, a flanker offers its parent', () => {
  const parent = brands.expansionFor(REGISTRY, 'bell');
  assert.equal(parent.mode, 'parent');
  assert.deepEqual(parent.siblings.map((r) => r.brand_id), ['lucky-mobile', 'virgin-plus'],
    'alphabetical by display name');

  const flanker = brands.expansionFor(REGISTRY, 'virgin-plus');
  assert.equal(flanker.mode, 'flanker', 'CONFIRM-EXCL-01: parent offered, siblings listed');
  assert.equal(flanker.parent.brand_id, 'bell');
  assert.deepEqual(flanker.siblings.map((r) => r.brand_id), ['lucky-mobile'],
    'the picked flanker is not listed as its own sibling');

  const single = brands.expansionFor(REGISTRY, 'oxio');
  assert.equal(single.mode, 'single');
  assert.deepEqual(single.siblings, []);
});

test('a two-hop family chain is reported as an error, never resolved', () => {
  const deep = REGISTRY.concat([
    { brand_id: 'sub-flanker', display_name: 'SubFlanker', parent_brand_id: 'virgin-plus', status: 'active' },
  ]);
  const fam = brands.familyOf(deep, 'sub-flanker');
  assert.equal(fam.depthError, true,
    'a parent that is itself a flanker is a data error, not a chain to follow');
});

test('a dangling parent pointer leaves a brand excludable', () => {
  const orphan = [{ brand_id: 'ghost', display_name: 'Ghost', parent_brand_id: 'gone', status: 'active' }];
  const fam = brands.familyOf(orphan, 'ghost');
  assert.equal(fam.parent.brand_id, 'ghost', 'treated as independent, not unreachable');
  assert.equal(fam.depthError, false);
});

test('search folds case and accents, and a short query does not narrow', () => {
  assert.deepEqual(brands.search(REGISTRY, 'videotron').map((r) => r.brand_id), ['videotron'],
    'edge case 18: unaccented input finds an accented name');
  assert.deepEqual(brands.search(REGISTRY, 'VIRGIN').map((r) => r.brand_id), ['virgin-plus']);
  assert.equal(brands.search(REGISTRY, 'b').length, brands.search(REGISTRY, '').length,
    'a one-character query returns the full list rather than a useless prefix match');
  assert.ok(brands.search(REGISTRY, '').every((r) => r.status === 'active'),
    'pending_review and retired brands are never offered for selection');
});

/* ------------------------------------------------------------------ *
 * The exclusion write plan
 * ------------------------------------------------------------------ */

test('replacing a set inserts, revives and soft-removes exactly once each', () => {
  const rows = [
    { ROWID: 1, brand_id: 'bell', removed_at: null },
    { ROWID: 2, brand_id: 'rogers', removed_at: '2026-08-01 00:00:00' },
    { ROWID: 3, brand_id: 'oxio', removed_at: null },
  ];
  const plan = exclusions.planFor(rows, ['bell', 'rogers', 'fido']);

  assert.deepEqual(plan.insert, ['fido'], 'never stored before');
  assert.deepEqual(plan.revive.map((r) => r.ROWID), [2], 'stored and removed: revived, not duplicated');
  assert.deepEqual(plan.unchanged, ['bell'], 'already active: untouched');
  assert.deepEqual(plan.remove.map((r) => r.ROWID), [3], 'active and no longer wanted');
});

test('edge case 5: replacing with the same set is a no-op plan', () => {
  const rows = [{ ROWID: 1, brand_id: 'bell', removed_at: null }];
  const plan = exclusions.planFor(rows, ['bell']);
  assert.deepEqual(plan.insert, []);
  assert.deepEqual(plan.revive, []);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.unchanged, ['bell']);
});

test('the full-coverage warning fires only when every bidding brand is excluded', () => {
  /* Section 7.1: never speculative. A cohort nobody has bid cannot be covered. */
  assert.equal(exclusions.coversAll(new Set(['bell', 'rogers']), ['bell', 'rogers']), true);
  assert.equal(exclusions.coversAll(new Set(['bell']), ['bell', 'rogers']), false,
    'one live bidder left means no warning');
  assert.equal(exclusions.coversAll(new Set(['bell']), []), false,
    'no bids yet: nothing to be covered, so no warning');
  assert.equal(exclusions.coversAll(new Set(), ['bell']), false);
});

/* ------------------------------------------------------------------ *
 * Rosters and serving maps
 * ------------------------------------------------------------------ */

test('a roster declaration plan mirrors the exclusion plan over its own column', () => {
  const rows = [
    { ROWID: 1, brand_id: 'bell', removed_at: null },
    { ROWID: 2, brand_id: 'virgin-plus', removed_at: '2026-08-01 00:00:00' },
  ];
  const plan = rosters.planFor(rows, ['bell', 'virgin-plus', 'lucky-mobile'], (r) => r.brand_id);
  assert.deepEqual(plan.insert, ['lucky-mobile']);
  assert.deepEqual(plan.revive.map((r) => r.ROWID), [2]);
  assert.deepEqual(plan.remove, []);
});

test('brand ids are slug-shaped, because they reach a WHERE clause', () => {
  assert.equal(brands.isBrandId('virgin-plus'), true);
  assert.equal(brands.isBrandId('bell'), true);
  assert.equal(brands.isBrandId("bell' OR 1=1--"), false);
  assert.equal(brands.isBrandId('Bell'), false, 'lowercase only');
  assert.equal(brands.isBrandId('-bell'), false, 'must start alphanumeric');
  assert.equal(brands.isBrandId(''), false);
  assert.equal(brands.isBrandId('a'.repeat(64)), false, 'bounded');
});
