/* Whollar shared core: validators, parsers, benchmark, scoring, form plumbing.
 *
 * WHY THIS FILE EXISTS
 * Before this, every one of these helpers was copy-pasted into 7 pages
 * (bill-checkup ×3, waitlist ×2, become-a-partner ×2) and the copies had
 * already diverged: two different email regexes, two different postal
 * validators, and a scoring engine duplicated three times. A fix applied to
 * one copy silently missed the others. Everything shared now lives here.
 *
 * Loaded as a classic script (no modules: these are plain static pages served
 * from Vercel, and the bundled pages re-run head scripts after unpacking).
 * Exposes a single global: window.WHOLLAR.
 */
(function (root) {
  'use strict';

  /* Bundled pages (index.html, partners.html and their mobile builds) re-run
     head scripts after the template unpacks. Never initialise twice, the same
     guard device-router.js uses. */
  if (root.WHOLLAR && root.WHOLLAR.__init) return;

  var W = root.WHOLLAR || (root.WHOLLAR = {});
  W.__init = true;

  /* ================================================================== *
   * 1. BACKEND
   * ------------------------------------------------------------------
   * Single source of truth for the Catalyst base URL. Every page reads
   * WHOLLAR.API instead of hardcoding it, so promoting the site to a
   * production Catalyst environment is a ONE-LINE change here.
   *
   * ⚠ THIS IS THE DEVELOPMENT ENVIRONMENT. catalyst-backend/.catalystrc
   * declares exactly one environment (id 110003037934, type 3 =
   * Development). There is no production environment to point at yet.
   * Every live lead currently lands in the dev Data Store. Create the
   * production environment in the Catalyst console, then change the two
   * constants below and redeploy the frontend.
   * ================================================================== */

  W.CATALYST_HOST = 'https://whollar-110003037934.development.catalystserverless.ca';
  W.API = W.CATALYST_HOST + '/server/formSubmit';
  W.OCR_API = W.CATALYST_HOST + '/server/billOcr';

  /* The auth function is reached SAME-ORIGIN, through the /api/auth rewrite in
     vercel.json, not on W.CATALYST_HOST like the two above. That is not a
     style choice, it is what makes session cookies possible at all:
     catalystserverless.ca cannot set a cookie for whollar.ca, and a third-party
     cookie would be blocked by Safari ITP anyway. Proxying through Vercel makes
     the browser see one origin, so the cookie is plain first-party.

     Being same-origin also means: no CORS, no preflight, no `credentials`
     juggling, and `connect-src 'self'` in the CSP already covers it.

     Catalyst Domain Mappings, which would let api.whollar.ca front the
     function directly and remove the proxy hop, are PRODUCTION-ONLY, and this
     project has no production environment yet. When one exists, this becomes
     'https://api.whollar.ca/auth' and the rewrite in vercel.json is deleted. */
  W.AUTH_API = '/api/auth';

  /* ================================================================== *
   * 2. VALIDATORS
   * ================================================================== */

  /* One email pattern, byte-identical to EMAIL_RE in
     catalyst-backend/functions/formSubmit/index.js. The pages used to carry
     two variants and the looser one accepted `a@b.c`, which the server then
     rejected with a 400 the user could not act on. */
  W.EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  W.isEmail = function (v) {
    return typeof v === 'string' && v.length <= 254 && W.EMAIL_RE.test(v.trim());
  };

  /* ---- Canadian postal codes ----
     Canada Post never uses D, F, I, O, Q or U anywhere in a postal code, and
     additionally never uses W or Z as the FIRST letter. The old validator
     only checked the first letter against a province table, so "K1D 0B1"
     passed. These character classes encode the real rule. */
  var PC_A = 'ABCEGHJKLMNPRSTVXY';   /* valid first letter  */
  var PC_L = 'ABCEGHJKLMNPRSTVWXYZ'; /* valid other letters */
  var RE_FSA = new RegExp('^[' + PC_A + ']\\d[' + PC_L + ']$');
  var RE_FULL = new RegExp('^[' + PC_A + ']\\d[' + PC_L + ']\\d[' + PC_L + ']\\d$');

  var PROVINCE_NAME = {
    A: 'Newfoundland & Labrador', B: 'Nova Scotia', C: 'PEI', E: 'New Brunswick',
    G: 'Quebec', H: 'Quebec', J: 'Quebec',
    K: 'Ontario', L: 'Ontario', M: 'Ontario', N: 'Ontario', P: 'Ontario',
    R: 'Manitoba', S: 'Saskatchewan', T: 'Alberta', V: 'British Columbia',
    X: 'the North', Y: 'Yukon'
  };
  var PROVINCE_CODE = {
    A: 'NL', B: 'NS', C: 'PE', E: 'NB', G: 'QC', H: 'QC', J: 'QC',
    K: 'ON', L: 'ON', M: 'ON', N: 'ON', P: 'ON', R: 'MB', S: 'SK',
    T: 'AB', V: 'BC', Y: 'YT'
    /* X deliberately absent: resolved by FSA below. */
  };
  /* X is the only prefix shared by two territories, so the first letter alone
     cannot resolve it. Canada Post splits it by FSA. */
  var X_FSA = {
    X0A: 'NU', X0B: 'NU', X0C: 'NU',
    X0E: 'NT', X0G: 'NT', X1A: 'NT'
  };
  var TERRITORY_NAME = { NU: 'Nunavut', NT: 'Northwest Territories', YT: 'Yukon' };

  /* Returns null for anything that is not a real Canadian FSA, otherwise
     { fsa, full, complete, province, provinceCode }. `full` is null until all
     six characters are present and valid. */
  W.parsePostal = function (raw) {
    var s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    var fsa = s.slice(0, 3);
    if (!RE_FSA.test(fsa)) return null;

    var code = fsa.charAt(0) === 'X' ? (X_FSA[fsa] || null) : (PROVINCE_CODE[fsa.charAt(0)] || null);
    var name = code && TERRITORY_NAME[code] ? TERRITORY_NAME[code] : PROVINCE_NAME[fsa.charAt(0)];
    var complete = s.length === 6 && RE_FULL.test(s);

    return {
      fsa: fsa,
      full: complete ? fsa + ' ' + s.slice(3, 6) : null,
      complete: complete,
      province: name || null,
      provinceCode: code
    };
  };

  /* Display formatter for a postal-code input: uppercase, strip junk, insert
     the single space after the FSA. Safe to call on every keystroke. */
  W.formatPostal = function (raw) {
    var s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    return s.length > 3 ? s.slice(0, 3) + ' ' + s.slice(3) : s;
  };

  /* ---- Money ----
     The old parser was `parseFloat(v.replace(/[^0-9.]/g,''))||0`, which turned
     the fr-CA form "85,00" into 8500 and "-50" into 50. Canada is officially
     bilingual and Quebec is a target market, so the comma decimal separator is
     a first-class input, not an edge case.

     Separator disambiguation:
       both , and .  → whichever comes LAST is the decimal separator
       only ,        → 1-2 trailing digits = decimal ("85,00"); otherwise
                       thousands ("1,200")
       only .        → decimal, as normal
     Returns null (not 0) when there is no number, so callers can tell
     "empty" apart from "zero". */
  W.parseMoney = function (raw) {
    var s = String(raw == null ? '' : raw);
    s = s.replace(/[\s   ]/g, '');       /* incl. nbsp / narrow nbsp */
    var negative = /^\s*[-−]/.test(s);

    /* Reject anything containing letters instead of salvaging digits out of it.
       Blind stripping turned "1e9" into 19, a plausible-looking bill the user
       never typed, which then scored as a confident "Strong deal". A leading
       currency code is the only allowed alphabetic prefix. */
    if (/[A-Za-z]/.test(s.replace(/^(CAD|CA|USD|US)/i, ''))) return null;

    s = s.replace(/[^0-9.,]/g, '');
    if (!s) return null;

    var lastComma = s.lastIndexOf(',');
    var lastDot = s.lastIndexOf('.');

    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(/,/g, '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma > -1) {
      var tail = s.slice(lastComma + 1);
      var oneComma = s.indexOf(',') === lastComma;
      if (oneComma && /^\d{1,2}$/.test(tail)) s = s.slice(0, lastComma) + '.' + tail;
      else s = s.replace(/,/g, '');
    }

    /* Truncate at a second decimal point rather than splicing the digits
       together: "85.5.5" is 85.5, not 85.55. */
    var first = s.indexOf('.');
    if (first > -1) {
      var second = s.indexOf('.', first + 1);
      if (second > -1) s = s.slice(0, second);
    }

    var n = parseFloat(s);
    if (!isFinite(n)) return null;
    return negative ? -n : n;
  };

  /* Parse + range check in one call. Returns
     { value, ok, reason }; reason is 'empty' | 'nan' | 'low' | 'high'. */
  W.parseMoneyInRange = function (raw, min, max) {
    var n = W.parseMoney(raw);
    if (n === null) return { value: null, ok: false, reason: String(raw || '').trim() ? 'nan' : 'empty' };
    if (n < min) return { value: n, ok: false, reason: 'low' };
    if (n > max) return { value: n, ok: false, reason: 'high' };
    return { value: n, ok: true, reason: null };
  };

  /* Plausible monthly home-internet bill. The floor was already 15; the
     ceiling is new: there was none, so "999999" scored and rendered. */
  W.BILL_MIN = 15;
  W.BILL_MAX = 500;

  /* ================================================================== *
   * 3. FORMATTING
   * ================================================================== */

  /* One currency formatter. The recap grid used to mix `money()` (which
     produced "$54.5") with raw string concatenation (which produced "$90"),
     so two formats appeared side by side in the same table. Always two
     decimals unless the value is whole. */
  W.money = function (n, opts) {
    var v = Number(n);
    if (!isFinite(v)) return 'n/a';
    var whole = Math.abs(v % 1) < 0.005;
    var forceCents = opts && opts.cents;
    return '$' + (whole && !forceCents
      ? Math.round(v).toLocaleString('en-CA')
      : v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  };

  W.escapeHtml = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* Parses a <input type="date"> value as a LOCAL calendar date at midnight.
     The old code appended 'T12:00:00' to dodge timezone drift, which meant a
     promo ending *today* read as already expired for anyone using the page
     after noon, mislabelling the single most urgent case as "Expired". */
  W.parseDateLocal = function (v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
    return d;
  };

  /* Whole days from today (local midnight) to the given date. 0 = today,
     negative = past. */
  W.daysUntil = function (dateStr) {
    var d = W.parseDateLocal(dateStr);
    if (!d) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  };

  W.monthName = function (v, fallback) {
    var d = W.parseDateLocal(v);
    if (!d) return fallback || 'renewal';
    return d.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  };

  /* ================================================================== *
   * 4. BENCHMARK
   * ------------------------------------------------------------------
   * The reference prices come from the PlanSavvy list ("PlanSavvy-Pricing
   * .xlsx", the twelve lowest-priced advertised plans per province,
   * source: plansavvy.ai), aggregated at build time into
   * js/whollar-base-pricing.js by scripts/build-base-pricing.mjs. That file
   * must be loaded BEFORE this one; if it is missing, benchmarkFor() returns
   * null and every result renders the "not enough to score" state rather
   * than inventing a number.
   *
   * js/whollar-benchmarks.js (the old scraped-market aggregate) still ships
   * because it defines SPEED_TIERS / SPEED_EDGES, but its price tables are
   * no longer consulted anywhere: PlanSavvy is the one price reference.
   *
   * Lookup: province + speed tier first ('E'), then the tier pooled across
   * every province ('F'). The level travels with the result so the UI can
   * say what the comparison was actually against.
   * ================================================================== */

  /* Bucket a raw Mbps figure to one of the eight tiers the form offers. Used
     for values that don't come from the <select> (e.g. bill OCR). */
  W.speedTier = function (mbps) {
    var v = Number(mbps);
    if (!isFinite(v) || v <= 0) return null;
    var tiers = W.SPEED_TIERS || [], edges = W.SPEED_EDGES || [];
    for (var i = 0; i < edges.length; i++) if (v < edges[i]) return tiers[i];
    return tiers[tiers.length - 1] || null;
  };

  /* input: { provinceCode, provider, tech, speed }
     - provider / tech are accepted for compatibility but no longer keyed on:
       the PlanSavvy sheet has no provider/tech granularity worth using.
     - speed is the #spd value ('25'…'1500', or '0' meaning "not sure")
     returns { price, sample, level, scope, tier, … } or null.

     SOURCE: the PlanSavvy list (js/whollar-base-pricing.js, built from
     "PlanSavvy-Pricing.xlsx" — the twelve lowest-priced advertised plans per
     province). This is the ONE price reference the site scores against; the
     old scraped-market table in js/whollar-benchmarks.js is no longer
     consulted for prices (that file still ships for its SPEED_TIERS/EDGES
     constants). Cascade: province + tier, then the tier pooled nationally.
     A tier the sheet has no rows for returns null — "not enough to score"
     beats inventing a number.

     '0' is not a tier. It used to map to an invented $60 benchmark and produce
     a confident verdict for someone who had just said they didn't know their
     speed; it returns null instead. */
  /* Direct advertised quotes for tiers the PlanSavvy sheet has no rows for.
     Source: Bell Pure Fibre offer, Aug 2026 — 1.5 Gbps $60/mo and 3 Gbps
     $65/mo (both plus tax, 2-year price guarantee; $55 with a Rogers/Fido
     mobile plan). The form buckets everything ≥1.22 Gbps into the 1500
     tier, so the two quotes pool into one mean. Replace with sheet rows
     the moment PlanSavvy lists these tiers. */
  W.BASE_TIER_QUOTES = { '1500': [62.5, 2] };

  W.benchmarkFor = function (input) {
    var opts = input || {};
    var tier = W.speedTier(opts.speed === '0' ? null : opts.speed);
    if (!tier) return null;

    var pv = opts.provinceCode || null;
    var hit = (pv && W.BASE_BY_PROVINCE_TIER) ? W.BASE_BY_PROVINCE_TIER[pv + '|' + tier] : null;
    var level = 'E', scope = 'province';
    if (!hit || !(hit[0] > 0)) {
      hit = W.BASE_BY_TIER ? W.BASE_BY_TIER[String(tier)] : null;
      level = 'F'; scope = 'national';
    }
    if (!hit || !(hit[0] > 0)) {
      hit = W.BASE_TIER_QUOTES ? W.BASE_TIER_QUOTES[String(tier)] : null;
      level = 'G'; scope = 'national';
    }
    if (!hit || !(hit[0] > 0)) return null;

    return {
      price: hit[0],
      sample: hit[1],
      level: level,
      scope: scope,
      tier: tier,
      provinceCode: scope === 'province' ? pv : null,
      providerGroup: null,
      techGroup: null,
      providerFellBack: false
    };
  };

  /* Northern internet pricing bears no relation to the southern market
     (satellite/microwave backhaul, no cable overbuild), and the dataset holds
     only 138 territory rows. A territory household scored against a national
     fallback is the least supportable comparison this engine can make, so it
     is flagged rather than hidden. */
  W.TERRITORIES = ['NU', 'NT', 'YT'];
  W.isTerritory = function (provinceCode) {
    return W.TERRITORIES.indexOf(provinceCode) > -1;
  };

  /* ------------------------------------------------------------------ *
   * Bottom-decile reference, for the homepage estimator
   *
   * The estimator asks for two things only: a monthly bill and a postal code.
   * With no speed, tech or provider it cannot use benchmarkFor()'s keyed
   * levels at all, so it compares against the mean of the province's cheapest
   * advertised decile — W.P10_BY_PROVINCE, built by scripts/build-benchmarks.mjs.
   *
   * Falls back to the national pool when a province has none. NT, NU and YT are
   * satellite-only in the sheet, and satellite is excluded from every
   * tech-blind aggregate, so those three always take the fallback.
   * ------------------------------------------------------------------ */
  W.p10For = function (provinceCode) {
    /* Now answered from the PlanSavvy list too (mean of the province's twelve
       cheapest advertised plans), so the homepage estimator and the checkup
       score against the same sheet. Field names kept for callers. */
    var byProv = W.BASE_BY_PROVINCE || null;
    var hit = (byProv && provinceCode) ? byProv[provinceCode] : null;
    if (hit && hit[0] > 0) {
      return { monthly: hit[0], decileRows: hit[1], poolRows: hit[1], scope: 'province', provinceCode: provinceCode };
    }
    var nat = W.BASE_NATIONAL || null;
    if (nat && nat[0] > 0) {
      return { monthly: nat[0], decileRows: nat[1], poolRows: nat[1], scope: 'national', provinceCode: null };
    }
    return null;
  };

  /* Annual saving = twelve months of the household's bill, minus twelve months
     at the province's bottom-decile price.

     Returns null when no reference exists, so a caller shows nothing rather
     than a number it cannot support. `saving` is clamped at zero and
     `atOrBelow` says why: a bill under the local floor is a real outcome (the
     slider reaches $40 while NB's decile sits at $75), and it must not be
     rendered as a negative saving. */
  W.estimateAnnualSavings = function (monthlyBill, provinceCode) {
    var bill = Number(monthlyBill);
    if (!isFinite(bill) || bill <= 0) return null;
    var ref = W.p10For(provinceCode);
    if (!ref) return null;

    var annualBill = bill * 12;
    var annualFloor = ref.monthly * 12;
    var raw = annualBill - annualFloor;
    return {
      saving: Math.max(0, raw),
      atOrBelow: raw <= 0,
      annualBill: annualBill,
      annualFloor: annualFloor,
      referenceMonthly: ref.monthly,
      scope: ref.scope,
      provinceCode: ref.provinceCode,
      decileRows: ref.decileRows,
      poolRows: ref.poolRows
    };
  };

  /* ------------------------------------------------------------------ *
   * Base price (floor reference for the "you could save" projection)
   *
   * Source: "PlanSavvy-Pricing.xlsx" (Internet Plans sheet — the dozen
   * lowest-priced advertised plans per province), aggregated at build time
   * into js/whollar-base-pricing.js by scripts/build-base-pricing.mjs.
   *
   * This is a SEPARATE reference from benchmarkFor(): benchmarkFor answers
   * "what does the market typically charge for this exact tier/tech/
   * provider" (what decides the weak/fair/strong verdict — unchanged).
   * basePriceFor answers "what is the cheapest advertised floor in this
   * household's area" — the number a cohort is actually bidding toward —
   * and unlike benchmarkFor it is always available: a cliff verdict carries
   * no benchmark at all (score() returns early on the date check, before any
   * benchmark lookup), so it is what the savings projection uses instead.
   *
   * Cascade, most to least specific:
   *   province + speed tier   → that province's plans at this tier
   *   province                → every plan listed for that province
   *   speed tier (national)   → this tier pooled across every province
   *   national                → every plan in the sheet
   * ------------------------------------------------------------------ */
  W.basePriceFor = function (provinceCode, speedRaw) {
    var byPT = W.BASE_BY_PROVINCE_TIER, byProv = W.BASE_BY_PROVINCE,
      byTier = W.BASE_BY_TIER, nat = W.BASE_NATIONAL;
    if (!byPT && !byProv && !byTier && !nat) return null;

    var tier = W.speedTier(speedRaw === '0' ? null : speedRaw);
    var pv = provinceCode || null;

    if (pv && tier && byPT) {
      var hitPT = byPT[pv + '|' + tier];
      if (hitPT && hitPT[0] > 0) return { price: hitPT[0], sample: hitPT[1], level: 'province-tier', provinceCode: pv, tier: tier };
    }
    if (pv && byProv) {
      var hitP = byProv[pv];
      if (hitP && hitP[0] > 0) return { price: hitP[0], sample: hitP[1], level: 'province', provinceCode: pv, tier: tier };
    }
    if (tier && byTier) {
      var hitT = byTier[String(tier)];
      if (hitT && hitT[0] > 0) return { price: hitT[0], sample: hitT[1], level: 'tier', provinceCode: null, tier: tier };
    }
    if (nat && nat[0] > 0) return { price: nat[0], sample: nat[1], level: 'national', provinceCode: null, tier: tier };
    return null;
  };

  /* ================================================================== *
   * 5. SCORING
   * ------------------------------------------------------------------
   * Customer amount = the monthly charge before any promo, minus the promo
   * discount. Compared against the benchmark price:
   *
   *   customer >  1.20 × benchmark   → weak
   *   customer <  0.95 × benchmark   → strong
   *   otherwise (inclusive both ends) → fair
   *
   * Both comparisons are STRICT, so a customer sitting exactly on 0.95× or
   * exactly on 1.20× is "fair". That is deliberate: the band is defined as
   * everything between the two lines, and the lines belong to it.
   * ================================================================== */

  W.STRONG_BELOW = 0.95;  /* strictly below this multiple of the benchmark */
  W.WEAK_ABOVE = 1.20;    /* strictly above this multiple of the benchmark */
  W.CLIFF_DAYS = 60;

  /* Binary floating point cannot represent 0.95 exactly, so a customer sitting
     precisely on the line computes as 0.949999999999999845 and would be graded
     "strong" when the rule says "fair". That is not hypothetical: it happens
     for 21 of the 184 distinct benchmark prices in the current dataset.
     A tolerance of 1e-9 is ~1/10,000,000 of a cent on a $100 bill, far too
     small to reclassify any real amount, and large enough to absorb the
     representation error. */
  var RATIO_EPSILON = 1e-9;

  /* What the household actually pays today. Clamped at zero, and a discount
     that meets or exceeds the charge is flagged as contradictory rather than
     silently producing an effective cost of $0 (which used to score as a
     "Strong deal: you pay $0/mo"). */
  W.effectiveCost = function (input) {
    var charge = Number(input.cost) || 0;
    var disc = Number(input.discount) || 0;
    if (input.promoExpired || disc <= 0) return { value: charge, contradictory: false };
    if (disc >= charge) return { value: charge, contradictory: true };
    return { value: charge - disc, contradictory: false };
  };

  /* input: { cost, discount, speed, tech, provider, promoEnd, promoExpired,
              provinceCode }
     returns: { state, ratio, benchmark, effective, days, reason, caveat }
       state ∈ 'cliff' | 'strong' | 'fair' | 'weak' | 'unknown'
       reason (only when 'unknown') ∈ 'no-cost' | 'no-speed' | 'no-benchmark'
                                    | 'discount-exceeds-charge' */
  W.score = function (input) {
    var eff = W.effectiveCost(input);
    var days = input.promoEnd ? W.daysUntil(input.promoEnd) : null;

    /* Cliff is date-driven and does not need a benchmark, so it is checked
       first: a household with an unknown speed can still be warned. */
    if (days !== null && days >= 0 && days <= W.CLIFF_DAYS) {
      return { state: 'cliff', ratio: null, benchmark: null, effective: eff.value, days: days, reason: null, caveat: null };
    }

    if (!(Number(input.cost) > 0)) {
      return { state: 'unknown', ratio: null, benchmark: null, effective: null, days: days, reason: 'no-cost', caveat: null };
    }
    if (eff.contradictory) {
      return { state: 'unknown', ratio: null, benchmark: null, effective: eff.value, days: days, reason: 'discount-exceeds-charge', caveat: null };
    }
    if (input.speed == null || input.speed === '' || input.speed === '0') {
      return { state: 'unknown', ratio: null, benchmark: null, effective: eff.value, days: days, reason: 'no-speed', caveat: null };
    }

    var bench = W.benchmarkFor({
      provinceCode: input.provinceCode,
      provider: input.provider,
      tech: input.tech,
      speed: input.speed
    });
    if (!bench || !(bench.price > 0)) {
      return { state: 'unknown', ratio: null, benchmark: null, effective: eff.value, days: days, reason: 'no-benchmark', caveat: null };
    }

    /* Strictly outside the band, per the rule above: landing exactly on a
       line is "fair". The epsilon keeps that true in floating point. */
    var r = eff.value / bench.price;
    var state = r > W.WEAK_ABOVE + RATIO_EPSILON ? 'weak'
      : (r < W.STRONG_BELOW - RATIO_EPSILON ? 'strong' : 'fair');

    /* Flags for comparisons that are materially weaker than the verdict looks,
       so the UI can qualify rather than state flat. */
    var caveat = null;
    /* The PlanSavvy sheet carries real NT/NU/YT rows, so a province-level hit
       for a territory is a genuine northern comparison; only the national
       fallback still deserves the flag. */
    if (W.isTerritory(input.provinceCode) && bench.scope !== 'province') caveat = 'territory';
    else if (bench.sample < 3) caveat = 'thin-sample';

    return {
      state: state, ratio: r, benchmark: bench, effective: eff.value,
      days: days, reason: null, caveat: caveat
    };
  };

  /* ================================================================== *
   * 6. CONSENT
   * ------------------------------------------------------------------
   * CASL requires that consent be provable: what was agreed to, when, and
   * where. Previously a checkbox gated the submit button and its state was
   * then thrown away: nothing about the consent reached the backend.
   * ================================================================== */

  W.CONSENT_TEXT = {
    waitlist: 'I accept the Terms and the Privacy Policy, and agree to receive email about my cohort and offers. I can unsubscribe at any time.',
    partner: 'I accept the Partner Terms and the Privacy Policy, and agree to be contacted about this application.',
    checkup: 'I agree to receive email about my cohort and offers, and accept the Privacy Policy. I can unsubscribe at any time.'
  };

  /* Attach to any payload that carries an opt-in. `kind` keys CONSENT_TEXT. */
  W.consentPayload = function (kind, granted) {
    if (!granted) return { consentGranted: false };
    return {
      consentGranted: true,
      consentKind: kind,
      consentText: W.CONSENT_TEXT[kind] || '',
      consentAt: new Date().toISOString(),
      consentSource: (root.location && root.location.pathname) || ''
    };
  };

  /* ================================================================== *
   * 7. TRANSPORT
   * ================================================================== */

  /* POSTs to a formSubmit route. JSON goes out as text/plain on purpose:
     the Catalyst gateway answers CORS preflight itself with no CORS headers,
     so browser requests have to stay preflight-free and text/plain is
     CORS-safelisted. The server parses both types. */
  W.submitForm = function (path, fields, files) {
    var hasFiles = files && Object.keys(files).some(function (k) {
      var f = files[k];
      return Array.isArray(f) ? f.length : !!f;
    });

    var opts;
    if (hasFiles) {
      var fd = new FormData();
      Object.keys(fields).forEach(function (k) {
        var v = fields[k];
        fd.append(k, v && typeof v === 'object' ? JSON.stringify(v) : (v == null ? '' : v));
      });
      Object.keys(files).forEach(function (k) {
        var f = files[k];
        if (!f) return;
        (Array.isArray(f) ? f : [f]).forEach(function (file) { fd.append(k, file, file.name); });
      });
      opts = { method: 'POST', body: fd };
    } else {
      opts = { method: 'POST', body: JSON.stringify(fields) };
    }

    return fetch(W.API + path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (body) {
        if (!r.ok) {
          var e = new Error('submit failed: ' + r.status);
          e.status = r.status;
          e.body = body;
          throw e;
        }
        return body || {};
      });
    });
  };

  /* One wording for every transport failure, everywhere. A failed submit must
     never look like success. */
  W.submitErrorMessage = function (err) {
    /* An error that already carries wording written for a person is shown as
       it is. Two kinds qualify: auth-layer errors, which errors.js composes on
       the stated assumption they will be shown verbatim and which always carry
       a `code`; and the ones a page builds itself for its own rules, which
       carry neither `code` nor `status`.

       Only a transport failure has no message worth showing, and that is what
       the table below is for. Before this, every case fell through to it, so a
       password one character too short, a six-digit box left half filled and a
       rejected postal code all read as "check your connection", sending people
       to debug their wifi over a typo, and hiding the one sentence that said
       what to change. `submitForm` always sets `status`, and a failed fetch
       rejects with a TypeError, so neither can reach this branch. */
    if (err && err.message && !(err instanceof TypeError)) {
      if (err.code) return err.message;
      if (err.status === undefined) return err.message;
    }
    var s = err && err.status;
    if (s === 429) return 'Too many attempts from your network right now. Please try again in a little while.';
    if (s === 413) return 'That file is too large. Please attach a smaller one and try again.';
    if (s === 415) return 'We can’t accept that file type. A PDF, JPG or PNG works.';
    if (s === 400 && err.body && err.body.error) return err.body.error;
    if (s >= 500) return 'Our server had a problem, so this wasn’t saved. Please try again in a moment.';
    return 'We couldn’t reach our servers, so this wasn’t saved. Please check your connection and try again.';
  };

  /* Disable + relabel a button for the duration of a request. Guards against
     the double-tap that would otherwise create two records. */
  W.busy = function (btn, on, label) {
    if (!btn) return;
    if (on) {
      if (btn.dataset.whlBusy === '1') return false;
      btn.dataset.whlBusy = '1';
      btn.dataset.whlLabel = btn.textContent;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.style.opacity = '.6';
      if (label) btn.textContent = label;
      return true;
    }
    delete btn.dataset.whlBusy;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.style.opacity = '';
    if (btn.dataset.whlLabel) btn.textContent = btn.dataset.whlLabel;
    return true;
  };

  /* ================================================================== *
   * 8. ACCESSIBLE FIELD ERRORS
   * ------------------------------------------------------------------
   * Errors used to be a red border and nothing else on 4 of 7 forms: no
   * live region, no association with the input, so screen-reader users got
   * a silent failure. These two helpers wire aria-describedby + role=alert
   * and move focus, from one place.
   * ================================================================== */

  /* Where a generated error message can safely be inserted. Several inputs sit
     directly inside a `display:flex` row (the join rails), and a <p> dropped in
     there becomes a flex item squeezed next to the button. Walk out to the
     first non-flex ancestor and insert after the row instead. */
  function errorAnchor(input) {
    var node = input, hops = 0;
    while (node.parentNode && node.parentNode.nodeType === 1 && hops < 4) {
      var parent = node.parentNode;
      var display = '';
      try { display = window.getComputedStyle(parent).display; } catch (e) { display = ''; }
      if (display.indexOf('flex') === -1 && display.indexOf('grid') === -1) {
        return { parent: parent, before: node.nextSibling };
      }
      node = parent;
      hops++;
    }
    return { parent: input.parentNode || document.body, before: input.nextSibling };
  }

  W.fieldError = function (input, message) {
    if (!input) return;
    var id = input.id ? input.id + '-err' : null;
    var el = id && document.getElementById(id);
    if (!el && id) {
      el = document.createElement('p');
      el.id = id;
      el.className = 'whl-fielderr';
      el.setAttribute('role', 'alert');
      var at = errorAnchor(input);
      at.parent.insertBefore(el, at.before);
    }
    if (el) {
      el.textContent = message;
      el.style.display = 'block';
      input.setAttribute('aria-describedby', el.id);
    }
    input.setAttribute('aria-invalid', 'true');
    input.classList.add('err');
    var f = input.closest && input.closest('.f');
    if (f) f.classList.add('err');
    try { input.focus({ preventScroll: false }); } catch (e) { input.focus(); }
  };

  W.clearFieldError = function (input) {
    if (!input) return;
    var el = input.id && document.getElementById(input.id + '-err');
    if (el) { el.textContent = ''; el.style.display = 'none'; }
    input.removeAttribute('aria-invalid');
    input.classList.remove('err');
    var f = input.closest && input.closest('.f');
    if (f) f.classList.remove('err');
  };

  /* ================================================================== *
   * 9. UPLOADS
   * ================================================================== */

  /* Mirrors ACCEPTED_UPLOAD_TYPES in catalyst-backend/functions/formSubmit. */
  W.UPLOAD_TYPES = [
    'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'
  ];

  /* HEIC/HEIF is the iPhone camera default, so it is the most likely upload we
     get. formSubmit stores it happily; the Claude vision API cannot read it,
     so we attach it and skip the auto-fill rather than rejecting the file. */
  W.HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];
  W.isHeic = function (file) {
    if (!file) return false;
    return W.HEIC_TYPES.indexOf((file.type || '').toLowerCase()) > -1 || /\.hei[cf]$/i.test(file.name || '');
  };

  W.MAX_ATTACH = 20 * 1024 * 1024;  /* formSubmit multer cap */
  W.MAX_OCR_PDF = 15 * 1024 * 1024; /* billOcr multer cap */
  W.MAX_OCR_IMAGE = 7 * 1024 * 1024;/* Claude caps images at ~10MB base64 ≈ 7.5MB raw */

  /* Returns { ok, code, message }.
     ok:false  → the file cannot be used at all (code 'empty' | 'type' | 'size')
     ok:true   → attach it; `code:'heic'` additionally means "storable but not
                 machine-readable", so the caller should say so and skip OCR. */
  W.checkUpload = function (file) {
    if (!file) return { ok: false, code: 'empty', message: 'Choose a file to attach.' };
    var type = (file.type || '').toLowerCase();

    if (file.size === 0) {
      return { ok: false, code: 'size', message: 'That file is empty. Please attach the bill itself.' };
    }
    if (file.size > W.MAX_ATTACH) {
      return { ok: false, code: 'size', message: 'That file is over 20 MB. A photo of the first page works too.' };
    }
    if (W.isHeic(file)) {
      return {
        ok: true, code: 'heic',
        message: 'Attached. It’s an iPhone HEIC photo, so we can’t auto-read it. Please fill in the fields below and we’ll open it by hand.'
      };
    }
    if (type && W.UPLOAD_TYPES.indexOf(type) === -1) {
      return { ok: false, code: 'type', message: 'We can’t take that file type. A PDF, JPG, PNG, WebP or GIF works.' };
    }
    return { ok: true, code: null, message: null };
  };

  /* True when the bill reader can actually attempt this file. HEIC is excluded
     because the Claude vision API cannot decode it; oversized files are
     excluded so we don't burn rate-limit budget on a request that will be
     refused. Both are still perfectly fine as attachments. */
  W.canAutoRead = function (file) {
    if (!file || file.size === 0) return false;
    if (W.isHeic(file)) return false;
    var cap = (file.type || '').toLowerCase() === 'application/pdf' ? W.MAX_OCR_PDF : W.MAX_OCR_IMAGE;
    return file.size <= cap;
  };

  W.formatSize = function (n) {
    return n < 1024 ? n + ' B'
      : n < 1048576 ? (n / 1024).toFixed(0) + ' KB'
        : (n / 1048576).toFixed(1) + ' MB';
  };

  /* ================================================================== *
   * 10. DRAFT PERSISTENCE
   * ------------------------------------------------------------------
   * A refresh mid-form used to dump everything: state lived only in a
   * module-scoped object. sessionStorage keeps it for the tab's lifetime
   * without persisting bill details past the visit.
   * ================================================================== */

  W.draft = {
    save: function (key, obj) {
      try { sessionStorage.setItem('whollar.draft.' + key, JSON.stringify(obj)); } catch (e) { /* private mode */ }
    },
    load: function (key) {
      try {
        var raw = sessionStorage.getItem('whollar.draft.' + key);
        if (!raw) return null;
        var v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
      } catch (e) { return null; }
    },
    clear: function (key) {
      try { sessionStorage.removeItem('whollar.draft.' + key); } catch (e) { /* ignore */ }
    }
  };

  /* ================================================================== *
   * 11. SIGNED-IN RECORDS (household member, partner staff)
   * ------------------------------------------------------------------
   * Two independent sessions, two keys. 'whollar.member' is written by the
   * consumer sign-in and read by /dashboard, which derives the promo-cliff
   * countdown from it. 'whollar.partner' is written by the partner sign-in
   * and read by /provider-dashboard.
   *
   * They must NOT share a key: a household signing in would otherwise open
   * the partner console (competitor pricing, cohort internals) and a partner
   * would land on a member dashboard with no bill.
   *
   * patch() is deliberately a no-op for signed-out visitors: the public
   * bill checkup must never create a member record as a side effect of
   * someone running the numbers.
   *
   * ⚠ NOT AUTHORISATION. Anyone can write either key from a console. These
   * records keep honest visitors on the right page; the real gate belongs in
   * a Catalyst function once partner/member auth ships.
   * ================================================================== */

  function sessionStore(key) {
    return {
      KEY: key,
      read: function () {
        try {
          var r = JSON.parse(localStorage.getItem(key));
          return r && typeof r === 'object' && r.email ? r : null;
        } catch (e) { return null; }
      },
      write: function (record) {
        if (!record || typeof record !== 'object' || !record.email) return null;
        try { localStorage.setItem(key, JSON.stringify(record)); } catch (e) { return null; }
        return record;
      },
      patch: function (fields) {
        var r = this.read();
        if (!r || !fields || typeof fields !== 'object') return null;
        Object.keys(fields).forEach(function (k) { r[k] = fields[k]; });
        try { localStorage.setItem(key, JSON.stringify(r)); } catch (e) { return null; }
        return r;
      },
      clear: function () {
        try { localStorage.removeItem(key); } catch (e) { /* private mode */ }
      }
    };
  }

  W.MEMBER_KEY = 'whollar.member';
  W.PARTNER_KEY = 'whollar.partner';

  W.member = sessionStore(W.MEMBER_KEY);
  W.partner = sessionStore(W.PARTNER_KEY);

  /* ------------------------------------------------------------------
   * Pending checkup handoff.
   *
   * A completed public checkup is the single richest thing a visitor tells
   * us, and most of them are signed out when they do it. This key holds that
   * result so the sign-in that happens LATER (minutes or days, same browser)
   * can attach it to the account: session 12's sync POSTs it to /me/bill
   * and clears it.
   *
   * localStorage, not sessionStorage, on purpose: the whole point is to
   * outlive the visit ("run the numbers today, sign up tomorrow"). That is a
   * deliberate exception to the draft rule above, so it is bounded: synced
   * copies are cleared immediately, and an unclaimed one expires on read
   * after 14 days rather than sitting there indefinitely.
   *
   * `email` is who the checkup SAID they were (the waitlist box), lowercased.
   * The sync uses it as a same-person check on shared devices: a handoff that
   * names one address is never attached to an account with another.
   * ------------------------------------------------------------------ */

  W.CHECKUP_KEY = 'whollar.checkup.pending';
  W.CHECKUP_TTL_MS = 14 * 24 * 60 * 60 * 1000;

  W.checkup = {
    save: function (bill, email) {
      if (!bill || typeof bill !== 'object') return;
      try {
        localStorage.setItem(W.CHECKUP_KEY, JSON.stringify({
          bill: bill,
          email: email ? String(email).trim().toLowerCase() : null,
          savedAt: Date.now()
        }));
      } catch (e) { /* private mode */ }
    },
    load: function () {
      try {
        var v = JSON.parse(localStorage.getItem(W.CHECKUP_KEY));
        if (!v || typeof v !== 'object' || !v.bill) return null;
        if (!v.savedAt || Date.now() - v.savedAt > W.CHECKUP_TTL_MS) {
          W.checkup.clear();
          return null;
        }
        return v;
      } catch (e) { return null; }
    },
    clear: function () {
      try { localStorage.removeItem(W.CHECKUP_KEY); } catch (e) { /* ignore */ }
    }
  };

  /* ================================================================== *
   * 12. SERVER SESSION (the authority behind section 11)
   * ------------------------------------------------------------------
   * Section 11 keeps a record in localStorage. This section is what makes
   * that record true: an HttpOnly session cookie set by the auth function,
   * which script cannot read, forge or extend.
   *
   * The two have to be reconciled somewhere, because a sign-in that
   * completes on the SERVER (Google, and the emailed code) hands the
   * browser a cookie and writes nothing to localStorage. A page that trusts
   * the local record alone would bounce a genuinely signed-in visitor back
   * to the form they just finished. adopt() closes that gap: ask the server
   * who this is, then write the local record from the answer.
   *
   * Failure is deliberately quiet. If the function is down or the /api/auth
   * rewrite is misconfigured, read() resolves to signed-out instead of
   * rejecting, so a page degrades to its local record rather than throwing
   * inside a boot path and rendering nothing at all.
   * ================================================================== */

  /**
   * POST JSON to the auth function and unwrap its one error shape.
   *
   * A JSON body would normally trigger a CORS preflight, and the Catalyst
   * gateway answers preflight itself without CORS headers, which is why the
   * lead and OCR endpoints stay form-encoded. It is safe HERE and only here
   * because /api/auth is a same-origin Vercel rewrite, so no preflight is
   * issued at all. Point this at the Catalyst host directly and it breaks.
   *
   * Rejects with an Error carrying `.code` (VALIDATION_ERROR, RATE_LIMITED,
   * UNAUTHENTICATED …) so a caller can react to the kind of failure, and
   * `.message` already written for a human: errors.js composes those on the
   * assumption they will be shown verbatim, so pages should show them rather
   * than substituting their own guess at what went wrong.
   */
  function authPost(path, body) {
    return fetch(W.AUTH_API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (b) {
        if (r.ok) return b || {};
        var e = new Error((b && b.error && b.error.message) ||
          'Something went wrong. Please try again.');
        e.code = (b && b.error && b.error.code) || 'SERVER_ERROR';
        e.status = r.status;
        throw e;
      });
    }, function () {
      /* Transport-level failure: offline, DNS, the rewrite misconfigured. The
         message has to be about the connection, not about the code they typed. */
      var e = new Error('We couldn’t reach Whollar. Check your connection and try again.');
      e.code = 'NETWORK';
      throw e;
    });
  }

  /**
   * Reconcile the member's bill between this browser and the server.
   * Resolves with the (possibly patched) member record, or null when there is
   * no local member record to sync into. Never rejects: this runs inside
   * boot paths (adopt, the dashboard's load) where a flaky network must
   * degrade to "render what we have", not to a blank page.
   *
   * Order matters: the pending handoff is PUSHED first, so the GET that
   * follows returns the checkup the visitor just ran rather than an older
   * server copy overwriting it.
   */
  function syncMemberBill() {
    var rec = W.member.read();
    if (!rec) return Promise.resolve(null);

    var pending = W.checkup.load();
    /* A handoff that named an email belongs to that person only. One with no
       email was made on this browser moments-to-days ago; attaching it to
       whoever signs in here is the best link available. */
    var foreign = pending && pending.email && rec.emailKey && pending.email !== rec.emailKey;

    var push = (pending && pending.bill && !foreign)
      ? W.session.billSave(pending.bill).then(
        function () { W.checkup.clear(); },
        function () { /* kept for the next attempt */ })
      : Promise.resolve();

    return push
      .then(function () { return W.session.billGet(); })
      .then(function (bill) {
        return (bill && W.member.patch({ bill: bill })) || W.member.read();
      });
  }

  W.session = {

    /* Never rejects. -> { authenticated, user } ; user is null when signed out. */
    read: function () {
      return fetch(W.AUTH_API + '/session', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (b) {
        return {
          authenticated: Boolean(b && b.authenticated && b.user),
          user: (b && b.user) || null
        };
      }).catch(function () {
        return { authenticated: false, user: null };
      });
    },

    /**
     * Reconcile the cookie into the local record.
     * Resolves with the record when a session exists, null when it does not.
     *
     * `expect` is the user type the CALLING PAGE serves: 'member' or
     * 'provider'. Pass it. A partner session is not a member session, and a
     * page that treats "some session exists" as "the right session exists"
     * ping-pongs: the consumer sign-in would adopt the partner's session, send
     * them to /dashboard, which finds no member record and sends them back,
     * forever. On a mismatch this resolves null and writes nothing.
     *
     * A member session writes the member key and a partner session the partner
     * key, never the other way round. Section 11 explains what crossing them
     * would open up.
     *
     * Fields the session payload has never carried (postal code, province) are
     * preserved from the existing local record, but ONLY when it belongs to the
     * same person: on a shared device the previous record is someone else's,
     * and merging their postal code in would put this visitor in the wrong
     * cohort.
     */
    adopt: function (expect) {
      return W.session.read().then(function (s) {
        if (!s.authenticated) return null;
        if (expect && s.user.userType !== expect) return null;

        var store = s.user.userType === 'member' ? W.member : W.partner;
        var email = String(s.user.email || '');
        if (!email) return null;
        var emailKey = email.toLowerCase();

        var prior = store.read() || {};
        var keep = (prior.emailKey === emailKey) ? prior : {};

        /* The session payload now carries the whole public profile, so the
           server is the source of truth for every field it answers with; the
           prior record only fills gaps the server has never known. */
        var record = store.write({
          firstName: s.user.firstName || W.firstNameFrom(email, keep.firstName),
          lastName: s.user.lastName || keep.lastName || null,
          email: email,
          emailKey: emailKey,
          phone: s.user.phone || keep.phone || null,
          fsa: s.user.fsa || keep.fsa || null,
          postal: s.user.postal || keep.postal || null,
          province: keep.province || null,
          provinceCode: s.user.provinceCode || keep.provinceCode || null,
          memberSince: s.user.memberSince || keep.memberSince || null
        });

        /* A member's bill lives on the server, keyed by their account, not
           in this record. Reconcile it here so every sign-in path (password,
           code, Google) lands on a dashboard that already shows their own
           checkup: push the pending handoff, pull the server copy. */
        if (!record || s.user.userType !== 'member') return record;
        return syncMemberBill().then(function (synced) { return synced || record; });
      });
    },

    /**
     * The bill the server holds for the signed-in member, or null: for a
     * signed-out visitor, a partner session, and every failure alike. The
     * first call for a member who ran the public checkup with the same email
     * is the one that links the two: the server copies that submission onto
     * their account before answering.
     */
    billGet: function () {
      return fetch(W.AUTH_API + '/me/bill', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.bill) || null;
      }).catch(function () {
        return null;
      });
    },

    /**
     * Replace the signed-in member's bill on the server. -> { ok, bill }
     * REJECTS on failure (same contract as the other button-path calls):
     * `bill` is { provider, monthly, speed, tech, promoEnd, promoExpired,
     * discount, threshold }.
     */
    billSave: function (bill) {
      return authPost('/me/bill', bill);
    },

    /* See syncMemberBill above. Exposed for pages that are already signed in
       when they load: their boot skips adopt(), so they call this instead. */
    syncBill: syncMemberBill,

    /**
     * The rating this member has already given their provider, or null:
     * for a signed-out visitor, a partner session, and every failure alike.
     * Never rejects: the dashboard's rating card degrades to "show the form"
     * on any network hiccup rather than blocking on it.
     */
    ratingGet: function () {
      return fetch(W.AUTH_API + '/me/rating', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.rating) || null;
      }).catch(function () {
        return null;
      });
    },

    /**
     * Record the signed-in member's rating. -> { ok, rating }
     * REJECTS on failure (same contract as billSave): the caller shows the
     * error rather than silently discarding it, since this is a one-time ask
     * and the .code is what tells a repeat submission (CONFLICT) apart from
     * a real failure. `rating` is { provider, price, reliability, support, speed }.
     */
    ratingSave: function (rating) {
      return authPost('/me/rating', rating);
    },

    /**
     * The campaigns near the signed-in member: live counts plus their own
     * standing in each (`you`: 'joined' | 'waitlist' | 'alert' | null).
     * Never rejects: this runs in the dashboard's boot path, where a missing
     * endpoint or a flaky network must degrade to the page's built-in demo
     * data, not to a blank section. Resolves { live, campaigns } or null.
     * `live:false` means the server answered but counts are seed baselines
     * (the membership table isn't provisioned yet).
     */
    campaignsList: function () {
      return fetch(W.AUTH_API + '/campaigns', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.ok && b.campaigns) ? b : null;
      }).catch(function () {
        return null;
      });
    },

    /**
     * Join a forming cohort or a region's waitlist / leave one / ask for the
     * opening-day text. Button paths, so these REJECT on failure with the
     * server's message: show it, the copy is written to be shown. Each
     * resolves { ok, campaign } with the campaign's updated counts.
     */
    campaignJoin: function (id) { return authPost('/campaigns/join', { campaign: id }); },
    campaignLeave: function (id) { return authPost('/campaigns/leave', { campaign: id }); },
    campaignNotify: function (id) { return authPost('/campaigns/notify', { campaign: id }); },

    /**
     * The partner console's view of the same campaigns: counts only, no
     * member identity. Never rejects: resolves { live, campaigns } or null,
     * and the console keeps its demo numbers on null.
     */
    providerCampaigns: function () {
      return fetch(W.AUTH_API + '/provider/campaigns', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.ok && b.campaigns) ? b : null;
      }).catch(function () {
        return null;
      });
    },

    /**
     * Ask for an emailed code. -> { ok, ttlMinutes, dev? }
     *
     * REJECTS on failure, unlike read() above. The difference is deliberate:
     * read() runs in boot paths where "we couldn't tell" has to degrade to
     * "signed out", but these two run from a button the visitor just pressed,
     * and a swallowed failure there is a form that silently does nothing.
     *
     * The server answers 200 with the same body whether or not an account
     * exists. Do not add anything here that treats those cases differently,
     * it is the whole reason the endpoint is not an enumeration oracle.
     *
     * `dev.code` comes back ONLY in non-production with no mail provider
     * configured (routes/otp.js decides; two conditions, not one). It is the
     * intended way to exercise this flow before ZeptoMail is verified.
     */
    otpStart: function (email) {
      return authPost('/otp/start', { email: email });
    },

    /**
     * Check the code and take the session the server hands back.
     * -> { ok, created, user, expiresAt }
     *
     * `firstName` is passed through so the account is created with it in the
     * same request. Collecting a name on the form and then writing it only
     * to localStorage is how the server ends up not knowing who anyone is.
     */
    otpVerify: function (o) {
      return authPost('/otp/verify', {
        email: o.email,
        code: o.code,
        firstName: o.firstName || null,
        marketing: Boolean(o.marketing)
      });
    },

    /**
     * Create an account. -> { ok, ttlMinutes, dev? }
     *
     * Answers identically whether or not the address already has an account.
     * The owner is told by email instead. Nothing here may branch on the
     * response to guess which happened; that symmetry is the only thing
     * stopping the signup form being used to ask who has an account.
     *
     * The account exists after this call but is inert until `signupVerify`:
     * `status` is 'pending' and the password opens nothing.
     *
     * Re-posting for an address still pending is also the resend: it replaces
     * the password with the same one and issues a fresh code.
     */
    signup: function (o) {
      return authPost('/signup', {
        email: o.email,
        password: o.password,
        firstName: o.firstName || null,
        lastName: o.lastName || null,
        phone: o.phone || null,
        postalCode: o.postalCode || null,
        provinceCode: o.provinceCode || null,
        referralCode: o.referralCode || null,
        marketing: Boolean(o.marketing)
      });
    },

    /**
     * Prove the address and take the session. -> { ok, created, user, expiresAt }
     *
     * Authenticates with the emailed code alone: the password set at signup is
     * deliberately not re-sent, so no page needs to hold it between the two
     * requests.
     *
     * `marketing` travels HERE and not with /signup, because the server writes
     * the consent rows at the moment the account becomes real. Sending it at
     * signup instead, which this function used to do by omission, meant the
     * marketing consent row was silently never written for anyone, which is a
     * CASL problem rather than a missing field.
     */
    signupVerify: function (o) {
      return authPost('/signup/verify', {
        email: o.email,
        code: o.code,
        marketing: Boolean(o.marketing)
      });
    },

    /**
     * Sign in, step one. -> { ok, mfaRequired: true, ttlMinutes, dev? }
     *
     * RESOLVING DOES NOT MEAN SIGNED IN. A correct password gets a code emailed
     * and nothing else — no cookie, no session. `loginVerify` below is what
     * finishes it, and that is true on every sign-in, not only the first after
     * signup. A caller that treats this resolution as success sends people to a
     * dashboard that will bounce them straight back out.
     *
     * A rejected call carries `.code === 'EMAIL_UNVERIFIED'` when the password
     * was RIGHT but the address was never confirmed; the server has sent a
     * SIGNUP code, so the caller should show the code step wired to
     * `signupVerify` rather than an error. Branch on that code, never on the
     * message text.
     *
     * Re-posting this IS the resend: the server retires the outstanding code
     * and issues a fresh one, which is why callers hold the password until the
     * code step is done with.
     */
    login: function (o) {
      return authPost('/login', { email: o.email, password: o.password });
    },

    /**
     * Sign in, step two: the emailed code, exchanged for the session.
     * -> { ok, user, expiresAt }
     *
     * The password is deliberately not re-sent — the server already checked it
     * before the code existed, so no page needs to hold it across the wire a
     * second time.
     */
    loginVerify: function (o) {
      return authPost('/login/verify', { email: o.email, code: o.code });
    },

    /**
     * Ask for a password-reset code. -> { ok, ttlMinutes, dev? }
     *
     * Resolves identically whether or not the address has an account. That is
     * the server refusing to be an oracle for who is registered, so a caller
     * must NOT try to infer anything from it: show "check your email" and
     * nothing more.
     */
    forgotPassword: function (o) {
      return authPost('/password/forgot', { email: o.email });
    },

    /**
     * Set a new password with the emailed code. -> { ok, user, expiresAt }
     *
     * Succeeds straight into a session, so no second sign-in is needed. Every
     * other live session is revoked server-side first: the point of resetting
     * a password after a compromise is that the other party stops being signed
     * in, which does not happen if their session survives the change.
     */
    resetPassword: function (o) {
      return authPost('/password/reset', {
        email: o.email,
        code: o.code,
        password: o.password
      });
    },

    /**
     * Register a partner. -> { ok, ttlMinutes, dev? }
     *
     * Same opacity contract as signup() above: the response never says
     * whether the address already had an account. The ONE exception the
     * server makes is a free-mailbox address (gmail, outlook …): that comes
     * back as a VALIDATION_ERROR telling them to use their work email,
     * because the email domain is what the partner org is derived from.
     * Show that message on the email field, not as a generic failure.
     *
     * Everything the account needs travels in this single request: the
     * code that follows only proves the address, it carries no fields.
     */
    providerSignup: function (o) {
      return authPost('/provider/signup', {
        email: o.email,
        password: o.password,
        firstName: o.firstName || null,
        lastName: o.lastName || null,
        phone: o.phone || null,
        orgName: o.orgName || null
      });
    },

    /**
     * Prove the address and take the session. -> { ok, user, org, approved }
     *
     * `approved` is the org's approval, decided by a human, and is FALSE for
     * a brand-new company. The session is real either way: an unapproved
     * partner lands on a "we're reviewing your application" state, not a
     * login form that rejects them. Every surface showing real data must
     * check `approved`, not just "signed in".
     */
    providerSignupVerify: function (o) {
      return authPost('/provider/signup/verify', {
        email: o.email,
        code: o.code,
        marketing: Boolean(o.marketing)
      });
    },

    /**
     * Partner sign-in, step one. -> { ok, mfaRequired: true, ttlMinutes, dev? }
     *
     * Like the member login above, resolving means "we emailed a code", not
     * "signed in": no session exists until `providerLoginVerify`. Nothing about
     * the org — its name, its approval — comes back here, because none of it
     * has been earned at this point.
     *
     * One opaque message for every failure, including a correct password on
     * a never-verified address. Unlike the member login there is no
     * EMAIL_UNVERIFIED branch to recover into a code step; the caller shows
     * the message and stops.
     *
     * Re-posting this is the resend.
     */
    providerLogin: function (o) {
      return authPost('/provider/login', { email: o.email, password: o.password });
    },

    /**
     * Partner sign-in, step two. -> { ok, user, org, approved }
     *
     * `approved` matters as much here as it does after signup: an approved
     * session and a session pending review look identical apart from this flag,
     * and every surface showing real data has to check it.
     */
    providerLoginVerify: function (o) {
      return authPost('/provider/login/verify', { email: o.email, code: o.code });
    },

    /**
     * What the signed-in partner may see about themselves.
     * -> { ok, user, org, approved } ; rejects when not a partner session.
     *
     * This is where a page gets the real org name and approval state.
     * Deriving either from the email address is a guess the server does not
     * have to make.
     */
    providerMe: function () {
      return fetch(W.AUTH_API + '/provider/me', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (b) {
          if (r.ok) return b || {};
          var e = new Error((b && b.error && b.error.message) || 'Please sign in again.');
          e.code = (b && b.error && b.error.code) || 'SERVER_ERROR';
          e.status = r.status;
          throw e;
        });
      }, function () {
        var e = new Error('We couldn’t reach Whollar. Check your connection and try again.');
        e.code = 'NETWORK';
        throw e;
      });
    },

    /* ---- account & preferences (both dashboards) --------------------
       Button paths REJECT with the server's message; boot-path reads
       resolve null/{} instead, the same split as everything above. */

    /** Update profile fields. Send only the keys being changed.
        -> { ok, user } with the fresh public profile. */
    profileSave: function (fields) { return authPost('/me/profile', fields); },

    /** The stored preference blob, or {}: signed out and failures alike. */
    prefsGet: function () {
      return fetch(W.AUTH_API + '/me/prefs', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.prefs) || {};
      }).catch(function () { return {}; });
    },

    /** Merge preference keys ('alerts', 'interests', 'notify'). -> { ok, prefs } */
    prefsSave: function (patch) { return authPost('/me/prefs', patch); },

    /** Record feedback: { kind: 'rating'|'outage'|'interest'|'provider-notify',
        payload: {...} }. -> { ok } */
    event: function (kind, payload) {
      return authPost('/me/event', { kind: kind, payload: payload || {} });
    },

    /** The member's share code and how many joined with it, or null. */
    referral: function () {
      return fetch(W.AUTH_API + '/me/referral', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.ok) ? b : null;
      }).catch(function () { return null; });
    },

    /** Everything the account owns, as one JSON document. REJECTS on failure:
        this runs from a button whose whole job is producing the file. */
    exportData: function () {
      return fetch(W.AUTH_API + '/me/export', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (b) {
          if (r.ok && b && b.ok) return b.data;
          var e = new Error((b && b.error && b.error.message) ||
            'Your export could not be prepared. Please try again.');
          e.code = (b && b.error && b.error.code) || 'SERVER_ERROR';
          throw e;
        });
      }, function () {
        var e = new Error('We couldn’t reach Whollar. Check your connection and try again.');
        e.code = 'NETWORK';
        throw e;
      });
    },

    /** Delete the account. `confirmEmail` must match the account's address.
        The server refuses anything else. -> { ok } */
    deleteAccount: function (confirmEmail) {
      return authPost('/me/delete', { confirmEmail: confirmEmail });
    },

    /* ---- partner desk ------------------------------------------------ */

    /** Rename the org (org admins only). -> { ok, org } */
    providerOrgSave: function (legalName) {
      return authPost('/provider/org', { legalName: legalName });
    },

    /** The org's team list, or null. -> { team, emailDomain } */
    providerTeam: function () {
      return fetch(W.AUTH_API + '/provider/team', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.ok) ? b : null;
      }).catch(function () { return null; });
    },

    /** The org's live sealed bids, or null. -> { live, bids } */
    providerBids: function () {
      return fetch(W.AUTH_API + '/provider/bids', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.ok) ? b : null;
      }).catch(function () { return null; });
    },

    /** Place or improve a sealed bid. The server is the gate: approval,
        the bidding window, and the kill switch are all enforced there.
        -> { ok, bid, improved } */
    providerBidSave: function (bid) { return authPost('/provider/bids', bid); },

    /** The org's coverage rows, or null. -> { live, coverage } */
    providerCoverage: function () {
      return fetch(W.AUTH_API + '/provider/coverage', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.ok) ? b : null;
      }).catch(function () { return null; });
    },

    /** Update a region's services / declare a new region.
        -> { ok, live, coverage } with the full refreshed list. */
    providerCoverageSave: function (row) { return authPost('/provider/coverage', row); },

    /**
     * Sign out on the server first, then locally.
     *
     * Clearing only localStorage is not a sign-out: the cookie survives, and
     * the next page load would adopt() it and sign the visitor straight back
     * in. The local clear happens either way: a failed request must not
     * leave someone looking at a dashboard they pressed "sign out" on.
     */
    end: function (which) {
      var store = which === 'partner' ? W.partner : W.member;
      return fetch(W.AUTH_API + '/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).catch(function () { /* offline; the local clear below still has to run */ })
        .then(function () { store.clear(); });
    }
  };

  /* ================================================================== *
   * 13. POST-SIGN-IN REDIRECT TARGET
   * ------------------------------------------------------------------
   * Both sign-in pages carry the page the visitor was trying to reach in
   * ?next=. Validating it here is what stops that parameter becoming an
   * open redirect: only a same-origin path is ever returned, and //evil.com
   * and \\evil.com are rejected before they can be treated as one.
   * ================================================================== */

  W.safeNext = function (raw, fallback) {
    if (!raw) return fallback;
    try {
      var u = new URL(raw, location.origin);
      if (u.origin !== location.origin) return fallback;
      if (!/^\/[^/\\]/.test(u.pathname)) return fallback;
      return u.pathname + u.search + u.hash;
    } catch (e) { return fallback; }
  };

  /* Display helpers shared by the two signed-in surfaces: a name and an
     avatar monogram have to be derived somewhere, and both dashboards were
     deriving them differently. */
  W.titleCase = function (s) {
    return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1).toLowerCase();
  };

  /* "sam.kaur@northline.ca" → "Sam". A given name always wins over the guess. */
  W.firstNameFrom = function (email, given) {
    if (given && given.trim()) return W.titleCase(given.trim());
    var local = (String(email).split('@')[0] || '').split(/[._\-+0-9]/)[0] || '';
    return local ? W.titleCase(local) : '';
  };

  /* Monogram for an avatar chip: initials of the first two words. A single word
     gives a single letter on purpose: two letters of "Northline" is "NO",
     which reads as the word rather than as initials. Never empty. */
  W.monogram = function (text) {
    var words = String(text || '').trim().split(/[\s.\-_]+/).filter(Boolean);
    if (!words.length) return 'W';
    if (words.length === 1) return words[0].charAt(0).toUpperCase();
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  };
})(window);
