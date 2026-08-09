/* Whollar checkup savings engine.
 *
 * FIELD SEMANTICS (the 2026-08-08 fix, see the savings-logic spec):
 *   currentPrice   = what the household pays TODAY, while the promo runs
 *   discountAmount = the monthly amount being taken OFF the bill
 *   postPromoPrice = currentPrice + discountAmount   (DERIVED, not entered)
 * A household paying 120 with an 80 discount jumps UP to 200 when the promo
 * dies. The previous engine treated 120 as the rack rate and 80 as the promo
 * price; both readings were wrong.
 *
 * If the promo has already expired, today's price IS the rack rate and the
 * derivation flips:
 *   promo running -> promoPrice = current,             postPromo = current + discount
 *   promo ended   -> promoPrice = current - discount,  postPromo = current
 *
 * Benchmark: cheapest plan in the household's PROVINCE that delivers at least
 * the requested speed. The dataset is the 12 cheapest plans per province from
 * PlanSavvy-Pricing.xlsx > "Internet Plans" (Aug 2026, plansavvy.ai), so it is
 * "best available price", never "typical". There is NO city or FSA pricing in
 * the source; anything finer than province would be invented.
 *
 * Loaded by bill-checkup.html as window.WhollarSavings, and by the node test
 * runner (scripts/test-checkup-savings.mjs) via require().
 */
(function () {
'use strict';

/* ------------------------------------------------------------------ *
 * Plans data
 * AUTO-GENERATED from PlanSavvy-Pricing.xlsx > 'Internet Plans'.
 * 12 lowest-priced internet plans per province, August 2026.
 * Regenerate with: node scripts/build-plan-pool.mjs
 * Do NOT hand-edit the block between the markers below — it will be
 * overwritten. Edit the workbook instead, then re-run the script.
 * ------------------------------------------------------------------ */
/* GENERATED:PLANS start */
var INTERNET_PLANS = {
  'British Columbia': [
    { provider: 'TekSavvy', plan: 'Cable 30', mbps: 30, price: 32.95 },
    { provider: 'TekSavvy', plan: 'Cable 100', mbps: 100, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 30', mbps: 30, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 100', mbps: 100, price: 44.95 },
    { provider: 'VMedia', plan: 'FTTN 50', mbps: 50, price: 47.95 },
    { provider: 'Oxio', plan: 'Internet 30', mbps: 30, price: 48.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Novus', plan: 'Internet 100', mbps: 100, price: 50.0 },
    { provider: 'Oxio', plan: 'Internet 100', mbps: 100, price: 52.0 },
    { provider: 'Novus', plan: 'Internet 1000', mbps: 1000, price: 55.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Oxio', plan: 'Internet 120', mbps: 120, price: 63.0 }
  ],
  'Alberta': [
    { provider: 'TekSavvy', plan: 'Cable 30', mbps: 30, price: 32.95 },
    { provider: 'TekSavvy', plan: 'Cable 100', mbps: 100, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 30', mbps: 30, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 100', mbps: 100, price: 44.95 },
    { provider: 'VMedia', plan: 'FTTN 50', mbps: 50, price: 47.95 },
    { provider: 'Oxio', plan: 'Internet 30', mbps: 30, price: 48.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Oxio', plan: 'Internet 100', mbps: 100, price: 52.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Oxio', plan: 'Internet 120', mbps: 120, price: 63.0 },
    { provider: 'Eastlink', plan: 'Internet 150', mbps: 150, price: 65.0 },
    { provider: 'TekSavvy', plan: 'Cable 1 Gig', mbps: 1000, price: 68.95 }
  ],
  'Saskatchewan': [
    { provider: 'TekSavvy', plan: 'Cable 30', mbps: 30, price: 32.95 },
    { provider: 'TekSavvy', plan: 'Cable 100', mbps: 100, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 30', mbps: 30, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 100', mbps: 100, price: 44.95 },
    { provider: 'VMedia', plan: 'FTTN 50', mbps: 50, price: 47.95 },
    { provider: 'Oxio', plan: 'Internet 30', mbps: 30, price: 48.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Oxio', plan: 'Internet 100', mbps: 100, price: 52.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Oxio', plan: 'Internet 120', mbps: 120, price: 63.0 },
    { provider: 'TekSavvy', plan: 'Cable 1 Gig', mbps: 1000, price: 68.95 },
    { provider: 'Shaw / Rogers', plan: 'Xfinity Starter 100 (West)', mbps: 100, price: 70.0 }
  ],
  'Manitoba': [
    { provider: 'TekSavvy', plan: 'Cable 30', mbps: 30, price: 32.95 },
    { provider: 'TekSavvy', plan: 'Cable 100', mbps: 100, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 30', mbps: 30, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 100', mbps: 100, price: 44.95 },
    { provider: 'VMedia', plan: 'FTTN 50', mbps: 50, price: 47.95 },
    { provider: 'Oxio', plan: 'Internet 30', mbps: 30, price: 48.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Oxio', plan: 'Internet 100', mbps: 100, price: 52.0 },
    { provider: 'Bell MTS', plan: 'Fibe 50', mbps: 50, price: 60.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Oxio', plan: 'Internet 120', mbps: 120, price: 63.0 },
    { provider: 'TekSavvy', plan: 'Cable 1 Gig', mbps: 1000, price: 68.95 }
  ],
  'Ontario': [
    { provider: 'TekSavvy', plan: 'Cable 30', mbps: 30, price: 32.95 },
    { provider: 'TekSavvy', plan: 'Cable 100', mbps: 100, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 30', mbps: 30, price: 38.95 },
    { provider: 'Start.ca', plan: 'Home Fibre 50', mbps: 50, price: 39.0 },
    { provider: 'Carrytel', plan: 'Internet 100', mbps: 100, price: 39.99 },
    { provider: 'VMedia', plan: 'Cable 100', mbps: 100, price: 44.95 },
    { provider: 'Carrytel', plan: 'Internet 500', mbps: 500, price: 44.99 },
    { provider: 'Fizz', plan: 'Internet 100', mbps: 100, price: 45.0 },
    { provider: 'Start.ca', plan: 'Home Fibre 100', mbps: 100, price: 45.0 },
    { provider: 'VMedia', plan: 'FTTN 50', mbps: 50, price: 47.95 },
    { provider: 'Oxio', plan: 'Internet 30', mbps: 30, price: 48.0 },
    { provider: 'Bell', plan: 'Fibe 1.5 Gig (w/ Rogers or Fido mobile)', mbps: 1500, price: 55.0 }
  ],
  'Quebec': [
    { provider: 'TekSavvy', plan: 'Cable 30', mbps: 30, price: 32.95 },
    { provider: 'Bravo Telecom', plan: 'Internet 10', mbps: 10, price: 36.0 },
    { provider: 'TekSavvy', plan: 'Cable 100', mbps: 100, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 30', mbps: 30, price: 38.95 },
    { provider: 'Carrytel', plan: 'Internet 100', mbps: 100, price: 39.99 },
    { provider: 'VMedia', plan: 'Cable 100', mbps: 100, price: 44.95 },
    { provider: 'Carrytel', plan: 'Internet 500', mbps: 500, price: 44.99 },
    { provider: 'Fizz', plan: 'Internet 100', mbps: 100, price: 45.0 },
    { provider: 'Bravo Telecom', plan: 'Internet 60', mbps: 60, price: 46.0 },
    { provider: 'VMedia', plan: 'FTTN 50', mbps: 50, price: 47.95 },
    { provider: 'Oxio', plan: 'Internet 30', mbps: 30, price: 48.0 },
    { provider: 'EBOX', plan: 'FTTN 50', mbps: 50, price: 49.95 }
  ],
  'New Brunswick': [
    { provider: 'TekSavvy', plan: 'Cable 30', mbps: 30, price: 32.95 },
    { provider: 'TekSavvy', plan: 'Cable 100', mbps: 100, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 30', mbps: 30, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 100', mbps: 100, price: 44.95 },
    { provider: 'VMedia', plan: 'FTTN 50', mbps: 50, price: 47.95 },
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Bell', plan: 'Fibe 50', mbps: 50, price: 60.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Eastlink', plan: 'Internet 150', mbps: 150, price: 65.0 },
    { provider: 'TekSavvy', plan: 'Cable 1 Gig', mbps: 1000, price: 68.95 },
    { provider: 'TekSavvy', plan: 'Fibre 500', mbps: 500, price: 74.95 },
    { provider: 'Bell', plan: 'Fibe 150', mbps: 150, price: 75.0 }
  ],
  'Nova Scotia': [
    { provider: 'TekSavvy', plan: 'Cable 30', mbps: 30, price: 32.95 },
    { provider: 'TekSavvy', plan: 'Cable 100', mbps: 100, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 30', mbps: 30, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 100', mbps: 100, price: 44.95 },
    { provider: 'VMedia', plan: 'FTTN 50', mbps: 50, price: 47.95 },
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Bell', plan: 'Fibe 50', mbps: 50, price: 60.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Purple Cow', plan: 'Internet 100', mbps: 100, price: 60.0 },
    { provider: 'Purple Cow', plan: 'Purple Fibre 500', mbps: 500, price: 60.0 },
    { provider: 'Eastlink', plan: 'Internet 150', mbps: 150, price: 65.0 },
    { provider: 'TekSavvy', plan: 'Cable 1 Gig', mbps: 1000, price: 68.95 }
  ],
  'Prince Edward Island': [
    { provider: 'TekSavvy', plan: 'Cable 30', mbps: 30, price: 32.95 },
    { provider: 'TekSavvy', plan: 'Cable 100', mbps: 100, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 30', mbps: 30, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 100', mbps: 100, price: 44.95 },
    { provider: 'VMedia', plan: 'FTTN 50', mbps: 50, price: 47.95 },
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Bell', plan: 'Fibe 50', mbps: 50, price: 60.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Purple Cow', plan: 'Internet 100', mbps: 100, price: 60.0 },
    { provider: 'Purple Cow', plan: 'Purple Fibre 500', mbps: 500, price: 60.0 },
    { provider: 'Eastlink', plan: 'Internet 150', mbps: 150, price: 65.0 },
    { provider: 'TekSavvy', plan: 'Cable 1 Gig', mbps: 1000, price: 68.95 }
  ],
  'Newfoundland and Labrador': [
    { provider: 'TekSavvy', plan: 'Cable 30', mbps: 30, price: 32.95 },
    { provider: 'TekSavvy', plan: 'Cable 100', mbps: 100, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 30', mbps: 30, price: 38.95 },
    { provider: 'VMedia', plan: 'Cable 100', mbps: 100, price: 44.95 },
    { provider: 'VMedia', plan: 'FTTN 50', mbps: 50, price: 47.95 },
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Bell', plan: 'Fibe 50', mbps: 50, price: 60.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Purple Cow', plan: 'Internet 100', mbps: 100, price: 60.0 },
    { provider: 'Purple Cow', plan: 'Purple Fibre 500', mbps: 500, price: 60.0 },
    { provider: 'Eastlink', plan: 'Internet 150', mbps: 150, price: 65.0 },
    { provider: 'TekSavvy', plan: 'Cable 1 Gig', mbps: 1000, price: 68.95 }
  ],
  'Northwest Territories': [
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Starlink', plan: 'Residential 100', mbps: 100, price: 75.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 100', mbps: 100, price: 80.0 },
    { provider: 'Xplore', plan: 'Satellite 50 (350 GB)', mbps: 50, price: 100.0 },
    { provider: 'Starlink', plan: 'Roam Unlimited', mbps: 150, price: 110.0 },
    { provider: 'Starlink', plan: 'Residential 200', mbps: 200, price: 115.0 },
    { provider: 'Northwestel', plan: 'Unlimited Internet 50', mbps: 50, price: 129.95 },
    { provider: 'Xplore', plan: 'Satellite 100 (500 GB)', mbps: 100, price: 130.0 },
    { provider: 'Starlink', plan: 'Residential Max', mbps: 400, price: 150.0 },
    { provider: 'Northwestel', plan: 'Unlimited Internet 300', mbps: 300, price: 199.95 },
    { provider: 'Northwestel', plan: '1 Gigabit', mbps: 1000, price: 219.95 }
  ],
  'Yukon': [
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Starlink', plan: 'Residential 100', mbps: 100, price: 75.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 100', mbps: 100, price: 80.0 },
    { provider: 'Xplore', plan: 'Satellite 50 (350 GB)', mbps: 50, price: 100.0 },
    { provider: 'Starlink', plan: 'Roam Unlimited', mbps: 150, price: 110.0 },
    { provider: 'Starlink', plan: 'Residential 200', mbps: 200, price: 115.0 },
    { provider: 'Northwestel', plan: 'Unlimited Internet 50', mbps: 50, price: 129.95 },
    { provider: 'Xplore', plan: 'Satellite 100 (500 GB)', mbps: 100, price: 130.0 },
    { provider: 'Starlink', plan: 'Residential Max', mbps: 400, price: 150.0 },
    { provider: 'Northwestel', plan: 'Unlimited Internet 300', mbps: 300, price: 199.95 },
    { provider: 'Northwestel', plan: '1 Gigabit', mbps: 1000, price: 219.95 }
  ],
  'Nunavut': [
    { provider: 'Xplore', plan: 'Fixed Wireless LTE 25', mbps: 25, price: 50.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 50', mbps: 50, price: 60.0 },
    { provider: 'Starlink', plan: 'Residential 100', mbps: 100, price: 75.0 },
    { provider: 'Xplore', plan: 'Fixed Wireless 5G 100', mbps: 100, price: 80.0 },
    { provider: 'Xplore', plan: 'Satellite 50 (350 GB)', mbps: 50, price: 100.0 },
    { provider: 'Starlink', plan: 'Roam Unlimited', mbps: 150, price: 110.0 },
    { provider: 'Starlink', plan: 'Residential 200', mbps: 200, price: 115.0 },
    { provider: 'Northwestel', plan: 'Unlimited Internet 50', mbps: 50, price: 129.95 },
    { provider: 'Xplore', plan: 'Satellite 100 (500 GB)', mbps: 100, price: 130.0 },
    { provider: 'Starlink', plan: 'Residential Max', mbps: 400, price: 150.0 },
    { provider: 'Northwestel', plan: 'Unlimited Internet 300', mbps: 300, price: 199.95 },
    { provider: 'Northwestel', plan: '1 Gigabit', mbps: 1000, price: 219.95 }
  ]
};
/* GENERATED:PLANS end */

/* ------------------------------------------------------------------ *
 * High-speed tiers the workbook does not price
 *
 * PlanSavvy-Pricing.xlsx tops out at 1 Gbps in most provinces and carries no
 * 1.5 Gbps or 3 Gbps row anywhere. Without these, a household on one of those
 * speeds fell straight through to `below_requested_speed` and got measured
 * against a slower, pricier plan — a gigabit household in NT was benchmarked
 * at $219.95 when 1.5 Gbps sells for $55.
 *
 * These are reference monthly rates for the two tiers, applied ONLY when the
 * province pool cannot reach the requested speed. They never compete with a
 * real provincial plan that already qualifies, so nothing below 1 Gbps moves.
 * Update alongside the workbook.
 * ------------------------------------------------------------------ */
var HIGH_SPEED_TIERS = [
  { mbps: 1500, price: 55.0 },
  { mbps: 3000, price: 65.0 }
];

/* ------------------------------------------------------------------ *
 * Benchmark lookup
 * ------------------------------------------------------------------ */

/* FSA first letter -> province. Canada Post allocation. */
var FSA_PROVINCE = {
  A: 'Newfoundland and Labrador',
  B: 'Nova Scotia',
  C: 'Prince Edward Island',
  E: 'New Brunswick',
  G: 'Quebec', H: 'Quebec', J: 'Quebec',
  K: 'Ontario', L: 'Ontario', M: 'Ontario', N: 'Ontario', P: 'Ontario',
  R: 'Manitoba',
  S: 'Saskatchewan',
  T: 'Alberta',
  V: 'British Columbia',
  X: 'Northwest Territories', // also Nunavut, see below
  Y: 'Yukon'
};

/* X is shared by NT and NU. These NU prefixes disambiguate. */
var NUNAVUT_FSAS = { X0A: 1, X0B: 1, X0C: 1 };

function provinceFromPostalCode(postal) {
  var fsa = String(postal || '').replace(/\s+/g, '').toUpperCase().slice(0, 3);
  if (fsa.length < 3) return null;
  if (NUNAVUT_FSAS[fsa]) return 'Nunavut';
  return FSA_PROVINCE[fsa[0]] || null;
}

function toBenchmark(p, province) {
  return { monthly: p.price, provider: p.provider, plan: p.plan, mbps: p.mbps, province: province };
}

/**
 * Rule: cheapest plan in the province that delivers AT LEAST the requested
 * speed. The >= is required; a saving must never come from a speed downgrade.
 * Fallback when nothing in the province reaches the speed: cheapest plan at
 * the highest speed available, flagged so the UI can caveat.
 */
function lookupBenchmark(postal, downloadMbps) {
  var province = provinceFromPostalCode(postal);
  if (!province) return null;

  var pool = INTERNET_PLANS[province];
  if (!pool || !pool.length) return null;

  var atOrAbove = pool.filter(function (p) { return p.mbps >= downloadMbps; });
  if (atOrAbove.length) {
    var best = atOrAbove.reduce(function (a, b) { return b.price < a.price ? b : a; });
    var out = toBenchmark(best, province);
    out.matched = 'at_or_above_speed';
    return out;
  }

  /* Nothing in the province reaches the speed. Before degrading to a slower
     plan, take the cheapest 1.5/3 Gbps tier that does — those speeds are real
     and purchasable, the workbook just doesn't carry a row for them. */
  var tier = HIGH_SPEED_TIERS
    .filter(function (t) { return t.mbps >= downloadMbps; })
    .reduce(function (a, t) { return !a || t.price < a.price ? t : a; }, null);
  if (tier) {
    return {
      monthly: tier.price,
      /* A reference rate, not a named plan. Null on purpose: there is no
         provider to leak, and the card must never name one anyway. */
      provider: null,
      plan: null,
      mbps: tier.mbps,
      province: province,
      matched: 'high_speed_tier'
    };
  }

  var topSpeed = Math.max.apply(null, pool.map(function (p) { return p.mbps; }));
  var fb = pool
    .filter(function (p) { return p.mbps === topSpeed; })
    .reduce(function (a, b) { return b.price < a.price ? b : a; });
  var out2 = toBenchmark(fb, province);
  out2.matched = 'below_requested_speed';
  return out2;
}

/* ------------------------------------------------------------------ *
 * Savings math
 * ------------------------------------------------------------------ */

/** Whole billing cycles from start to end, anchored on the start day-of-month.
 *  A cycle counts if it BEGINS before `end`. Month-end starts (Jan 31) clamp
 *  naturally: the day-of-month comparison is all the anchor needs. */
function monthsBetween(startISO, endISO) {
  var s = new Date(startISO + 'T00:00:00Z');
  var e = new Date(endISO + 'T00:00:00Z');
  var n = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  if (e.getUTCDate() <= s.getUTCDate()) n -= 1;
  return Math.max(0, n + 1);
}

var r2 = function (n) { return Math.round(n * 100) / 100; };

/** Add n months to an ISO date, clamping the day (Jan 31 + 1mo -> Feb 28/29). */
function addMonths(iso, n) {
  var d = new Date(iso + 'T00:00:00Z');
  var day = d.getUTCDate();
  var target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  var last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

function calculateCheckup(input) {
  var T = input.contractLengthMonths;
  var today = input.today || new Date().toISOString().slice(0, 10);
  var warnings = [];

  var benchmark = lookupBenchmark(input.postalCode, input.downloadMbps);
  if (!benchmark) throw new Error('No benchmark plan for that postal code and speed');
  var b = benchmark.monthly;

  var discount = Number(input.discountAmount) || 0;

  /* --- Resolve promo window ---------------------------------------- */
  var promoMonths = 0;
  if (input.contractStartDate && input.promoEndDate) {
    promoMonths = Math.min(T, monthsBetween(input.contractStartDate, input.promoEndDate));
  } else if (!input.contractStartDate && input.promoEndDate) {
    /* Start withheld but the end is known: anchor cycles to today, so the
       schedule is a forward projection that still lands the cliff. */
    promoMonths = Math.min(T, monthsBetween(today, input.promoEndDate));
  } else if (input.promoEndDate === null && discount > 0) {
    promoMonths = Math.min(T, 12);
    warnings.push('Promo length unknown, assumed 12 months.');
  }

  var promoActive = input.promoEndDate ? input.promoEndDate > today : promoMonths > 0;

  /* --- Resolve the two price levels ---------------------------------
     ONE rule, promo dead or alive: Q03 is the price WITH the discount
     applied, Q09 is the amount taken off, so the post-promo price is
     always Q03 + Q09. There used to be an expired-promo branch here that
     read Q03 as the rack rate and back-derived the promo price — so a
     household that typed $120 with a $90 discount was told they pay
     $30/mo and that the bill "goes to $120", when the truth is they paid
     $120 and the bill went to $210. Whether the promo is over changes
     which of these two numbers is on this month's bill (see the schedule
     and currentMonthly below), never how they are derived. */
  var promoPrice, postPromoPrice;
  if (input.postPromoPrice != null) {
    postPromoPrice = input.postPromoPrice;  // preferred: asked directly
    promoPrice = input.currentPrice;
  } else {
    promoPrice = input.currentPrice;                       // e.g. 120
    postPromoPrice = input.currentPrice + discount;        // 120 + 90 = 210
  }

  if (discount < 0) warnings.push('Discount amount cannot be negative.');
  if (discount === 0 && promoMonths > 0 && input.promoEndDate)
    warnings.push('A promo end date was given but the discount is $0.');
  if (discount > input.currentPrice)
    warnings.push('The discount is larger than what you pay. Did you enter the post-promo price by mistake?');

  /* --- Build the schedule ------------------------------------------ */
  var schedule = [];
  var periods =
    input.promoPeriods && input.promoPeriods.length > 0
      ? input.promoPeriods.filter(function (p) { return p.months > 0; })
      : promoMonths > 0
        ? [{ monthlyAmount: promoPrice, months: promoMonths }]
        : [];

  for (var i = 0; i < periods.length; i++) {
    for (var k = 0; k < periods[i].months && schedule.length < T; k++) {
      schedule.push(periods[i].monthlyAmount);
    }
  }
  var covered = schedule.length;
  while (schedule.length < T) schedule.push(postPromoPrice);

  if (input.promoPeriods && input.promoPeriods.length > 0 && covered < T)
    warnings.push(covered + ' of ' + T + ' months entered, remainder assumed at $' + postPromoPrice + '.');

  /* --- Math ---------------------------------------------------------
     Clamp at zero, never abs(): a month priced below the benchmark must
     REDUCE the total, not add to it. */
  var totalPaid = schedule.reduce(function (a, x) { return a + x; }, 0);
  var totalBenchmark = b * T;
  var totalSavings = Math.max(0, totalPaid - totalBenchmark);

  /* The cliff's calendar date follows the same anchor the schedule was built
     on: the contract start when it was given, today otherwise. */
  var anchor = input.contractStartDate || today;
  var cliff = null;
  for (var m = 1; m < T; m++) {
    if (schedule[m] > schedule[m - 1]) {
      var date = anchor ? addMonths(anchor, m) : null;
      var monthsAway = date ? monthsBetween(today, date) - 1 : null;
      cliff = { month: m, date: date, monthsAway: monthsAway, from: schedule[m - 1], to: schedule[m] };
      break;
    }
  }

  /* "You pay now" is the price at TODAY'S month of the schedule, not the
     schedule's first month. With a contract start those differ the moment
     the promo has expired: month 1 was the promo price, this month is the
     rack rate. Clamped into the term so a contract that has already run
     out reads its final price rather than off the end of the array. */
  var elapsed = 0;
  if (input.contractStartDate) {
    elapsed = Math.min(T - 1, Math.max(0, monthsBetween(input.contractStartDate, today) - 1));
  }

  return {
    currentMonthly: schedule[elapsed],
    postPromoPrice: postPromoPrice,
    benchmarkMonthly: b,
    downloadMbps: input.downloadMbps,
    benchmark: benchmark,
    termMonths: T,
    promoMonths: covered,
    promoActive: promoActive,
    totalPaid: r2(totalPaid),
    totalBenchmark: r2(totalBenchmark),
    totalSavings: r2(totalSavings),
    cliff: cliff,
    schedule: schedule,
    warnings: warnings
  };
}

/* ------------------------------------------------------------------ *
 * Result card content layer
 *
 * One function turns a CheckupResult into everything the card says; the
 * component renders it and branches on nothing. The case is chosen on ONE
 * number, overPct = totalSavings / totalBenchmark -- a ratio, not dollars,
 * because dollars scale with the term ($400 over 12 months and $400 over 36
 * are different situations that would otherwise grade the same).
 *
 * Hard rules, enforced by tests:
 *   - NEVER name the benchmark provider or plan. That is the lead: naming it
 *     hands the household the answer and they leave without joining.
 *   - Never "typical", never "list price" -- the sheet is the 12 cheapest
 *     plans per province, so "best rate" / "advertised plans" is the only
 *     defensible phrasing.
 *   - Never tie price to cohort size. The price is settled at the bid.
 *   - Never $0 in a savings slot; drop the stat instead.
 *   - The promo cliff is a note, the speed-data gap is a caveat. Neither is
 *     a case and neither changes which case fires.
 * ------------------------------------------------------------------ */

/** "$4,140.36", "$50" -- decimals only when the amount has cents. */
function money(n) {
  return '$' + n.toLocaleString('en-CA', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  });
}

/** "Dec 2026". UTC on purpose: the ISO date is calendar data, not a moment. */
function shortDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-CA', {
    month: 'short', year: 'numeric', timeZone: 'UTC'
  });
}

/** Case chosen on one number: overPct = totalSavings / totalBenchmark. */
function buildCard(r, fsa) {
  var overPct = r.totalBenchmark > 0 ? r.totalSavings / r.totalBenchmark : 0;
  var cta = 'Join your ' + fsa + ' cohort';

  /* Shown on every case. The savings figure is measured against the cheapest
     advertised plans we hold, NOT Whollar's own price, which lands lower and
     is settled later. Without this line the card implies the number on screen
     is the best available outcome, when it is the starting point. It is also
     the only conversion argument on no_saving.

     A high_speed_tier match is a reference rate, not an advertised plan we
     actually track — the workbook carries no 1.5/3 Gbps row for this
     province, so the standard "lowest prices we track" phrasing would claim
     a plan that isn't there. */
  var basis = r.benchmark.matched === 'high_speed_tier'
    ? "Measured against a reference rate for this speed — we don't track an advertised plan this fast in your area."
    : 'Measured against the lowest prices we track in your area.';

  /* Tense follows promoActive: a cliff that already happened is a fact on
     their statements ("ended … is"), not a forecast — the old copy told a
     household in August that their promo "ends" the previous May. */
  var note;
  if (r.cliff) {
    note = r.promoActive
      ? 'Your promotion ends ' + (r.cliff.date ? shortDate(r.cliff.date) : 'soon') + '. '
        + 'The rate goes to ' + money(r.cliff.to) + '/mo.'
      : 'Your promotion ended' + (r.cliff.date ? ' ' + shortDate(r.cliff.date) : '') + '. '
        + 'The rate is ' + money(r.cliff.to) + '/mo and stays there.';
  }

  var caveat = r.benchmark.matched === 'below_requested_speed'
    ? 'Speed note. No plan we track in ' + r.benchmark.province + ' reaches ' + r.downloadMbps
      + ' Mbps. This compares a slower plan, so the real gap is likely smaller.'
    : undefined;

  var payNow = { label: 'You pay now', value: money(r.currentMonthly) + '/mo' };
  var couldSave = {
    label: 'You could save',
    value: money(r.totalSavings),
    sub: 'over ' + r.termMonths + ' months'
  };

  if (r.totalSavings <= 0 || overPct < 0.02) {
    return {
      case: 'no_saving',
      tone: 'good',
      headline: 'This is a decent price. A cohort goes lower.',
      stats: [payNow],
      body: 'You are doing decently on what you pay now. Once you join, providers bid for the whole of '
        + fsa + ' at once, and that price may take you further than where you are today.',
      basis: basis, note: note, caveat: caveat,
      cta: cta
    };
  }

  if (overPct < 0.15) {
    return {
      case: 'small_saving',
      tone: 'neutral',
      headline: 'There is more room here than your bill suggests.',
      stats: [payNow, couldSave],
      body: 'A gap this small survives because nobody changes providers over it, and providers count on that. '
        + 'In a cohort nobody has to. The price is settled at the bid, and a bid has to beat what every household in '
        + fsa + ' could already get on its own.',
      basis: basis, note: note, caveat: caveat,
      cta: cta
    };
  }

  if (overPct < 0.5) {
    return {
      case: 'moderate_saving',
      tone: 'warn',
      headline: 'You are paying more than you need to, and it will not correct itself.',
      stats: [payNow, couldSave],
      body: 'On your own the call ends at a retention desk, where the script is written to hold you with the '
        + 'smallest discount that works. A cohort is not offered a script. It is offered a bid, because every '
        + fsa + ' household is on the table at once.',
      basis: basis, note: note, caveat: caveat,
      cta: cta
    };
  }

  return {
    case: 'big_saving',
    tone: 'alert',
    headline: 'Your speed does not cost this much.',
    stats: [payNow, couldSave],
    body: 'No one chose this price for you. A promotion ended, the number moved up, and nothing on the bill '
      + 'announced it. Left alone, a gap this size simply continues. In a cohort it gets challenged, and a bid '
      + 'that does not beat what you pay now does not win.',
    basis: basis, note: note, caveat: caveat,
    cta: cta
  };
}

var API = {
  INTERNET_PLANS: INTERNET_PLANS,
  HIGH_SPEED_TIERS: HIGH_SPEED_TIERS,
  provinceFromPostalCode: provinceFromPostalCode,
  lookupBenchmark: lookupBenchmark,
  monthsBetween: monthsBetween,
  addMonths: addMonths,
  calculateCheckup: calculateCheckup,
  buildCard: buildCard,
  money: money,
  shortDate: shortDate
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.WhollarSavings = API;
})();
