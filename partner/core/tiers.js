/* The standard speed ladder, and the one place a speed becomes a tier.
 *
 * ONE SOURCE, THREE RUNTIMES. A sealed bid names its tiers from this ladder,
 * the price book is keyed on it, a household's window centres on it, and the
 * cohort's speed demand is counted against it. Until this file existed the
 * ladder lived in lib/bids.js, partner/core/contract.js and dashboard.html as
 * three hand-kept mirrors, and the coverage view carried a fourth that did not
 * agree. scripts/build-tiers.mjs emits the CommonJS copy the Catalyst
 * function requires, and its --check gate keeps the two identical; the copy in
 * dashboard.html is still kept by hand, and scripts/test-tiers.mjs fails when
 * it drifts. No imports here, on purpose: the generator is a text transform
 * and the module has to stand alone.
 *
 * THE TIER ID IS THE LABEL. "1 Gig" is what a bid stores, what a book entry
 * carries and what an order records, validated against TIER_NAMES on every
 * write. The Mbps figure is derived from it here and never stored beside it,
 * so the two cannot disagree on a row.
 */

export var TIER_LADDER = Object.freeze([
  [50, '50 Mbps'],
  [100, '100 Mbps'],
  [300, '300 Mbps'],
  [500, '500 Mbps'],
  [1000, '1 Gig'],
  [1500, '1.5 Gig'],
  [2500, '2.5 Gig']
]);

export var TIER_NAMES = Object.freeze(TIER_LADDER.map(function (t) { return t[1]; }));

/** The Mbps behind a ladder label, or null for anything not on the ladder. */
export function tierMbps(label) {
  var s = String(label == null ? '' : label).trim();
  for (var i = 0; i < TIER_LADDER.length; i++) {
    if (TIER_LADDER[i][1] === s) return TIER_LADDER[i][0];
  }
  return null;
}

/** The ladder label for an exact rung, or null between rungs. */
export function tierLabel(mbps) {
  var n = Number(mbps);
  for (var i = 0; i < TIER_LADDER.length; i++) {
    if (TIER_LADDER[i][0] === n) return TIER_LADDER[i][1];
  }
  return null;
}

/** Position on the ladder, or -1. */
export function tierIndex(label) {
  return TIER_NAMES.indexOf(String(label == null ? '' : label).trim());
}

/**
 * Mbps behind a speed as written anywhere in this system: a bare number
 * ("500", the checkup's value), "500 Mbps", "1 Gbps", "1 Gig", "1.5 Gig".
 * Null for nothing, "Not sure" (the checkup sends "0"), or a figure that is
 * not positive: an unknown speed is null, never a small number.
 */
export function speedMbps(value) {
  if (value == null || value === '') return null;
  var s = String(value).trim();
  var m = s.match(/^\$?([\d.]+)\s*(g|m)?/i);
  if (!m) return null;
  var n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  return m[2] && /^g/i.test(m[2]) ? n * 1000 : n;
}

/**
 * The ladder tier a speed sits at: the highest rung at or below it. NULL
 * below the lowest rung, and null for an unknown speed. The earlier version
 * answered the lowest rung for both, which turned "Not sure" into a confident
 * claim to want 50 Mbps; a household whose speed is not known gets no tier
 * here and the window rule decides what to show instead.
 */
export function tierForSpeed(value) {
  var n = speedMbps(value);
  if (n === null) return null;
  var best = null;
  for (var i = 0; i < TIER_LADDER.length; i++) {
    if (TIER_LADDER[i][0] <= n) best = TIER_LADDER[i][1];
  }
  return best;
}
