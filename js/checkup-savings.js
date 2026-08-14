/* Whollar checkup savings engine, the v17 port (2026-08-13).
 *
 * THE WINDOW IS ALWAYS 12 MONTHS. Exit fees on internet have been zero since
 * CRTC 2026-43 took effect on 12 June 2026, so a household can move in any
 * month. The contract does not gate the decision, therefore it must not
 * truncate the window: a household one month from renewal and one twenty
 * months out both see a comparable twelve month figure. Do not reintroduce
 * term based truncation.
 *
 * FIELD SEMANTICS (v17, replacing the 2026-08-08 pair):
 *   during = the monthly price paid during the promo period, net of discounts
 *   after  = the monthly price once the promo ends (0 or null when not given)
 * The old discount-amount field is gone. Nothing here derives a post-promo
 * price by addition; the household states both prices, or the engine records
 * which assumption it had to make instead (the `basis` tag).
 *
 * Benchmark: the cheapest plan that delivers AT LEAST the household's speed,
 * from the per-province price frontier below plus a small set of published
 * offers. Never a downgrade, never "typical". The benchmark's provider and
 * plan name are deliberately NOT in the computeCheckup result: the results
 * screen must never reveal the comparison source to the household. bestPlan()
 * keeps them for internal callers (tests, CRM notes).
 *
 * Loaded by bill-checkup.html as window.WhollarSavings, and by the node test
 * runner (scripts/test-checkup-savings.mjs) via require().
 */
(function () {
'use strict';

/* ------------------------------------------------------------------ *
 * Price frontier per province.
 * Derived from PlanSavvy-Pricing.xlsx > "Internet Plans" (Aug 2026):
 * only rows that are the cheapest at their speed or above survive,
 * sorted ascending by mb. Keep the shape { Province: [{mb,p,who,plan}] }.
 * Regenerate against the workbook when pricing refreshes.
 * ------------------------------------------------------------------ */
var FRONTIER = {
  'Alberta': [
    { mb: 30, p: 32.95, who: 'TekSavvy', plan: 'Cable 30' },
    { mb: 100, p: 38.95, who: 'TekSavvy', plan: 'Cable 100' },
    { mb: 120, p: 63.0, who: 'Oxio', plan: 'Internet 120' },
    { mb: 150, p: 65.0, who: 'Eastlink', plan: 'Internet 150' },
    { mb: 1000, p: 68.95, who: 'TekSavvy', plan: 'Cable 1 Gig' }
  ],
  'British Columbia': [
    { mb: 30, p: 32.95, who: 'TekSavvy', plan: 'Cable 30' },
    { mb: 100, p: 38.95, who: 'TekSavvy', plan: 'Cable 100' },
    { mb: 1000, p: 55.0, who: 'Novus', plan: 'Internet 1000' }
  ],
  'Manitoba': [
    { mb: 30, p: 32.95, who: 'TekSavvy', plan: 'Cable 30' },
    { mb: 100, p: 38.95, who: 'TekSavvy', plan: 'Cable 100' },
    { mb: 120, p: 63.0, who: 'Oxio', plan: 'Internet 120' },
    { mb: 1000, p: 68.95, who: 'TekSavvy', plan: 'Cable 1 Gig' }
  ],
  'New Brunswick': [
    { mb: 30, p: 32.95, who: 'TekSavvy', plan: 'Cable 30' },
    { mb: 100, p: 38.95, who: 'TekSavvy', plan: 'Cable 100' },
    { mb: 150, p: 65.0, who: 'Eastlink', plan: 'Internet 150' },
    { mb: 1000, p: 68.95, who: 'TekSavvy', plan: 'Cable 1 Gig' }
  ],
  'Newfoundland and Labrador': [
    { mb: 30, p: 32.95, who: 'TekSavvy', plan: 'Cable 30' },
    { mb: 100, p: 38.95, who: 'TekSavvy', plan: 'Cable 100' },
    { mb: 500, p: 60.0, who: 'Purple Cow', plan: 'Purple Fibre 500' },
    { mb: 1000, p: 68.95, who: 'TekSavvy', plan: 'Cable 1 Gig' }
  ],
  'Northwest Territories': [
    { mb: 25, p: 50.0, who: 'Xplore', plan: 'Fixed Wireless LTE 25' },
    { mb: 50, p: 60.0, who: 'Xplore', plan: 'Fixed Wireless 5G 50' },
    { mb: 100, p: 75.0, who: 'Starlink', plan: 'Residential 100' },
    { mb: 150, p: 110.0, who: 'Starlink', plan: 'Roam Unlimited' },
    { mb: 200, p: 115.0, who: 'Starlink', plan: 'Residential 200' },
    { mb: 400, p: 150.0, who: 'Starlink', plan: 'Residential Max' },
    { mb: 1000, p: 219.95, who: 'Northwestel', plan: '1 Gigabit' }
  ],
  'Nova Scotia': [
    { mb: 30, p: 32.95, who: 'TekSavvy', plan: 'Cable 30' },
    { mb: 100, p: 38.95, who: 'TekSavvy', plan: 'Cable 100' },
    { mb: 500, p: 60.0, who: 'Purple Cow', plan: 'Purple Fibre 500' },
    { mb: 1000, p: 68.95, who: 'TekSavvy', plan: 'Cable 1 Gig' }
  ],
  'Nunavut': [
    { mb: 25, p: 50.0, who: 'Xplore', plan: 'Fixed Wireless LTE 25' },
    { mb: 50, p: 60.0, who: 'Xplore', plan: 'Fixed Wireless 5G 50' },
    { mb: 100, p: 75.0, who: 'Starlink', plan: 'Residential 100' },
    { mb: 150, p: 110.0, who: 'Starlink', plan: 'Roam Unlimited' },
    { mb: 200, p: 115.0, who: 'Starlink', plan: 'Residential 200' },
    { mb: 400, p: 150.0, who: 'Starlink', plan: 'Residential Max' },
    { mb: 1000, p: 219.95, who: 'Northwestel', plan: '1 Gigabit' }
  ],
  'Ontario': [
    { mb: 30, p: 32.95, who: 'TekSavvy', plan: 'Cable 30' },
    { mb: 100, p: 38.95, who: 'TekSavvy', plan: 'Cable 100' },
    { mb: 500, p: 44.99, who: 'Carrytel', plan: 'Internet 500' }
  ],
  'Prince Edward Island': [
    { mb: 30, p: 32.95, who: 'TekSavvy', plan: 'Cable 30' },
    { mb: 100, p: 38.95, who: 'TekSavvy', plan: 'Cable 100' },
    { mb: 500, p: 60.0, who: 'Purple Cow', plan: 'Purple Fibre 500' },
    { mb: 1000, p: 68.95, who: 'TekSavvy', plan: 'Cable 1 Gig' }
  ],
  'Quebec': [
    { mb: 30, p: 32.95, who: 'TekSavvy', plan: 'Cable 30' },
    { mb: 100, p: 38.95, who: 'TekSavvy', plan: 'Cable 100' },
    { mb: 500, p: 44.99, who: 'Carrytel', plan: 'Internet 500' }
  ],
  'Saskatchewan': [
    { mb: 30, p: 32.95, who: 'TekSavvy', plan: 'Cable 30' },
    { mb: 100, p: 38.95, who: 'TekSavvy', plan: 'Cable 100' },
    { mb: 120, p: 63.0, who: 'Oxio', plan: 'Internet 120' },
    { mb: 1000, p: 68.95, who: 'TekSavvy', plan: 'Cable 1 Gig' }
  ],
  'Yukon': [
    { mb: 25, p: 50.0, who: 'Xplore', plan: 'Fixed Wireless LTE 25' },
    { mb: 50, p: 60.0, who: 'Xplore', plan: 'Fixed Wireless 5G 50' },
    { mb: 100, p: 75.0, who: 'Starlink', plan: 'Residential 100' },
    { mb: 150, p: 110.0, who: 'Starlink', plan: 'Roam Unlimited' },
    { mb: 200, p: 115.0, who: 'Starlink', plan: 'Residential 200' },
    { mb: 400, p: 150.0, who: 'Starlink', plan: 'Residential Max' },
    { mb: 1000, p: 219.95, who: 'Northwestel', plan: '1 Gigabit' }
  ]
};

/* Published offers supplied by Whollar. mb = minimum download delivered.
 * Ontario/GTA only: outside OFFER_PROVINCE they are used solely as a
 * fallback when the provincial frontier has nothing at or above the
 * household's speed, and that use sets fallbackGeo on the result. The flag
 * drives an assumption note; it is never shown as a comparison source. */
var OFFERS = [
  { who: 'Bell', plan: 'Pure Fibre 150', mb: 150, p: 55, note: '2-year price guarantee, no install, no modem rental' },
  { who: 'Rogers or Fido', plan: '1.5 Gig', mb: 1500, p: 55, note: 'lowest published 1.5 Gig offer' },
  { who: 'Bell', plan: 'Pure Fibre 1.5 Gig', mb: 1500, p: 60, note: '2-year price guarantee, no install, no modem rental' }
];
var OFFER_PROVINCE = 'Ontario';

var WINDOW_MONTHS = 12;

/* ------------------------------------------------------------------ *
 * Dates. Local midnight everywhere: appending T12:00:00 or parsing UTC
 * has already produced same-day off-by-ones on this site twice.
 * ------------------------------------------------------------------ */
function parseLocal(v) {
  if (v instanceof Date) return v;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  return new Date(v.slice(0, 10) + 'T00:00:00');
}

/* Whole months only: subtract one if the day of month has not yet been
 * reached. Negative when dateStr is in the past. */
function monthsUntil(dateStr, today) {
  var d = parseLocal(dateStr);
  if (!d) return null;
  var now = parseLocal(today) || new Date();
  var m = (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth());
  if (d.getDate() < now.getDate()) m -= 1;
  return m;
}

/* Months already elapsed on the current contract. Null when the start date
 * is unknown; never negative. */
function elapsedMonths(input) {
  if (!input.startDate) return null;
  var e = -monthsUntil(input.startDate, input.today);
  return e > 0 ? e : 0;
}

/* ------------------------------------------------------------------ *
 * Benchmark selection: the cheapest plan that delivers at least the
 * speed they already have. Never compare a household against a downgrade.
 * ------------------------------------------------------------------ */
function bestPlan(province, speedMbps) {
  var want = speedMbps || 0;
  var local = [];
  (FRONTIER[province] || []).forEach(function (r) {
    if (r.mb >= want) local.push({ who: r.who, plan: r.plan, mb: r.mb, p: r.p, src: 'plansavvy' });
  });
  var offers = OFFERS.filter(function (o) { return o.mb >= want; }).map(function (o) {
    return { who: o.who, plan: o.plan, mb: o.mb, p: o.p, src: 'offer', note: o.note || null };
  });
  var pool;
  if (province === OFFER_PROVINCE) pool = local.concat(offers);
  else pool = local.length ? local : offers.map(function (o) {
    var c = { who: o.who, plan: o.plan, mb: o.mb, p: o.p, src: o.src, note: o.note };
    c.fallbackGeo = true;
    return c;
  });
  if (!pool.length) return null;
  return pool.reduce(function (a, b) { return b.p < a.p ? b : a; });
}

/* ------------------------------------------------------------------ *
 * Cost of the next 12 months on the household's current arrangement.
 *
 * input = {
 *   province, speedMbps,
 *   during, after,            numbers; 0/null = not given
 *   multi, periods: [{amount, months}], fallback,
 *   startDate, promoEnd,      'YYYY-MM-DD' or null (null covers "I don't know")
 *   today                     'YYYY-MM-DD', injectable for tests
 * }
 * ------------------------------------------------------------------ */
function currentCost(input, N) {
  N = N || WINDOW_MONTHS;
  if (input.multi) {
    var total = 0, filled = 0, skip = elapsedMonths(input) || 0;
    var periods = input.periods || [];
    for (var i = 0; i < periods.length; i++) {
      var avail = periods[i].months || 0;
      if (skip > 0) { var s = Math.min(skip, avail); avail -= s; skip -= s; }
      if (avail <= 0) continue;
      if (filled >= N) break;
      var take = Math.min(avail, N - filled);
      total += take * (periods[i].amount || 0);
      filled += take;
    }
    if (filled < N) {
      var rest = N - filled, rate = input.fallback || input.after || 0;
      total += rest * rate;
      return { basis: 'periods', total: total, monthsPriced: filled, assumedRate: rate || null, uncovered: rate ? 0 : rest };
    }
    return { basis: 'periods', total: total, monthsPriced: N, assumedRate: null, uncovered: 0 };
  }
  var during = input.during || 0;
  var haveEnd = !!input.promoEnd, haveStick = (input.after || 0) > 0;
  /* no end date and no sticker: price what they actually pay today */
  if (!haveEnd && !haveStick) {
    return { basis: 'current-only', total: N * during, monthsAtCurrent: N, monthsAtSticker: 0, assumedRate: null, uncovered: 0 };
  }
  /* sticker known but no end date: assume the cliff lands mid-term */
  if (!haveEnd && haveStick) {
    var half = Math.round(N / 2);
    return { basis: 'midpoint-estimate', total: half * during + (N - half) * input.after,
             monthsAtCurrent: half, monthsAtSticker: N - half, assumedRate: null, uncovered: 0 };
  }
  /* end date known */
  var cliff = Math.max(0, Math.min(N, monthsUntil(input.promoEnd, input.today)));
  var after = N - cliff, rate = haveStick ? input.after : during;
  return { basis: haveStick ? 'dated' : 'dated-no-sticker', total: cliff * during + after * rate,
           monthsAtCurrent: cliff, monthsAtSticker: after, assumedRate: haveStick ? null : during, uncovered: 0 };
}

/* ------------------------------------------------------------------ *
 * What they pay now: the rate they are actually on today, not the promo
 * price by default. A lapsed promo means the after-promo price, and the
 * label above the figure changes to say so.
 * ------------------------------------------------------------------ */
function nowPrice(input) {
  if (input.multi) {
    var periods = input.periods || [];
    if (input.startDate) {
      var elapsed = -monthsUntil(input.startDate, input.today);
      var acc = 0;
      for (var i = 0; i < periods.length; i++) {
        acc += (periods[i].months || 0);
        if (elapsed < acc) return { amount: periods[i].amount || 0, postPromo: false };
      }
      var last = periods[periods.length - 1] || {};
      return { amount: input.fallback || input.after || last.amount || 0, postPromo: false };
    }
    return { amount: (periods[0] || {}).amount || 0, postPromo: false };
  }
  var lapsed = !!input.promoEnd && parseLocal(input.promoEnd) < (parseLocal(input.today) || new Date());
  if (lapsed) return { amount: input.after || input.during || 0, postPromo: true };
  return { amount: input.during || 0, postPromo: false };
}

/* The rate the household was paying in month i of the contract (0-based
 * from the start date). Walks the promo periods for multi promo; for
 * single promo it is the during price before the cliff and the after
 * price on or after it. */
function paidRateAtMonth(input, i) {
  if (input.multi) {
    var acc = 0, periods = input.periods || [];
    for (var k = 0; k < periods.length; k++) {
      acc += (periods[k].months || 0);
      if (i < acc) return periods[k].amount || 0;
    }
    return input.fallback || input.after || 0;
  }
  if (!input.promoEnd) return input.during || 0;
  var promoMonths = (elapsedMonths(input) || 0) + monthsUntil(input.promoEnd, input.today);
  return i < promoMonths ? (input.during || 0) : (input.after || input.during || 0);
}

/* What the gap has already cost them, NETTED: months where the promo beat
 * the benchmark are subtracted, not ignored. Null unless it is worth
 * saying: start date known, at least 3 months elapsed, and at least $60. */
function overpaidToDate(input, benchPerMonth) {
  var el = elapsedMonths(input);
  if (el === null || el < 3 || !benchPerMonth) return null;
  var sum = 0;
  for (var i = 0; i < el; i++) sum += (paidRateAtMonth(input, i) - benchPerMonth);
  return sum >= 60 ? sum : null;
}

/* The cliff pill: promo ends within four months and is still in the future. */
function cliffSoon(input) {
  if (input.multi || !input.promoEnd) return false;
  var m = monthsUntil(input.promoEnd, input.today);
  return m !== null && m >= 0 && m <= 4;
}

/* ------------------------------------------------------------------ *
 * The whole result. benchmark carries no provider or plan name: the
 * results screen must never reveal the comparison source.
 *
 * tone: 'high' | 'moderate' | 'fair' | 'no-benchmark'
 * basis: 'dated' | 'dated-no-sticker' | 'midpoint-estimate' |
 *        'current-only' | 'periods'
 * ------------------------------------------------------------------ */
function computeCheckup(input) {
  var N = WINDOW_MONTHS;
  var cur = currentCost(input, N);
  var now = nowPrice(input);
  var best = bestPlan(input.province, input.speedMbps);
  if (!best) {
    return { ok: false, tone: 'no-benchmark', months: N, basis: cur.basis,
             current: { total: +cur.total.toFixed(2), detail: cur },
             now: now, benchmark: null, savings: null, perMonth: null, overPct: null,
             overpaid: null, cliffSoon: cliffSoon(input),
             assumptions: assumptionTags(cur) };
  }
  var bench = best.p * N;
  var savings = +(cur.total - bench).toFixed(2);
  var overPct = savings / (cur.total || 1);
  var tone = overPct < 0.10 ? 'fair' : (overPct < 0.35 ? 'moderate' : 'high');
  return {
    ok: true, tone: tone, months: N, basis: cur.basis,
    current: { total: +cur.total.toFixed(2), detail: cur },
    now: now,
    benchmark: { perMonth: best.p, total: +bench.toFixed(2), mb: best.mb, src: best.src, fallbackGeo: !!best.fallbackGeo },
    savings: savings,
    perMonth: +((cur.total - bench) / N).toFixed(2),
    overPct: overPct,
    overpaid: overpaidToDate(input, best.p),
    cliffSoon: cliffSoon(input),
    assumptions: assumptionTags(cur)
  };
}

/* Which assumptions the figure rests on. Empty when every input was
 * supplied; drives both the (i) tooltip and checkup_assumption_shown. */
function assumptionTags(cur) {
  var tags = [];
  if (cur.basis === 'midpoint-estimate') tags.push('midpoint-estimate');
  if (cur.basis === 'current-only') tags.push('current-only');
  if (cur.basis === 'dated-no-sticker') tags.push('dated-no-sticker');
  if (cur.uncovered) tags.push('uncovered');
  return tags;
}

var API = {
  WINDOW_MONTHS: WINDOW_MONTHS,
  FRONTIER: FRONTIER,
  OFFERS: OFFERS,
  OFFER_PROVINCE: OFFER_PROVINCE,
  bestPlan: bestPlan,
  monthsUntil: monthsUntil,
  elapsedMonths: elapsedMonths,
  currentCost: currentCost,
  nowPrice: nowPrice,
  paidRateAtMonth: paidRateAtMonth,
  overpaidToDate: overpaidToDate,
  cliffSoon: cliffSoon,
  computeCheckup: computeCheckup
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.WhollarSavings = API;
})();
