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
     "PlanSavvy-Pricing.xlsx": the twelve lowest-priced advertised plans per
     province). This is the ONE price reference the site scores against; the
     old scraped-market table in js/whollar-benchmarks.js is no longer
     consulted for prices (that file still ships for its SPEED_TIERS/EDGES
     constants). Cascade: province + tier, then the tier pooled nationally.
     A tier the sheet has no rows for returns null: "not enough to score"
     beats inventing a number.

     '0' is not a tier. It used to map to an invented $60 benchmark and produce
     a confident verdict for someone who had just said they didn't know their
     speed; it returns null instead. */
  /* Direct advertised quotes for tiers the PlanSavvy sheet has no rows for.
     Source: Bell Pure Fibre offer, Aug 2026: 1.5 Gbps $60/mo and 3 Gbps
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

  /* ------------------------------------------------------------------ *
   * Cheapest-plan-in-area reference, for the homepage estimator
   *
   * The estimator asks for two things only: a monthly bill and a postal
   * code: no speed or tech, so it cannot use benchmarkFor()'s tier-keyed
   * levels. It compares against the single cheapest advertised plan in the
   * household's province (W.BASE_MIN_BY_PROVINCE, built by
   * scripts/build-base-pricing.mjs from PlanSavvy-Pricing.xlsx): the
   * lowest a household in that area could actually pay, not an average.
   * That makes the resulting number a MAXIMUM possible saving, not a
   * typical one; the widget's own copy says so.
   *
   * Falls back to the national floor when a province has none (should not
   * happen, PlanSavvy lists all thirteen, but a missing data file must
   * not throw).
   * ------------------------------------------------------------------ */
  W.minBasePriceFor = function (provinceCode) {
    var byProv = W.BASE_MIN_BY_PROVINCE || null;
    var hit = (byProv && provinceCode) ? byProv[provinceCode] : null;
    if (hit && hit[0] > 0) {
      return { monthly: hit[0], sample: hit[1], scope: 'province', provinceCode: provinceCode };
    }
    var nat = W.BASE_MIN_NATIONAL || null;
    if (nat && nat[0] > 0) {
      return { monthly: nat[0], sample: nat[1], scope: 'national', provinceCode: null };
    }
    return null;
  };

  /* Annual saving = twelve months of the household's bill, minus twelve
     months at the cheapest advertised plan in their province:
     12 * (monthlyBill - minBasePriceFor(provinceCode).monthly).

     Returns null when no reference exists, so a caller shows nothing rather
     than a number it cannot support. `saving` is clamped at zero and
     `atOrBelow` says why: a bill under the local floor is a real outcome,
     and it must not be rendered as a negative saving. */
  W.estimateAnnualSavings = function (monthlyBill, provinceCode) {
    var bill = Number(monthlyBill);
    if (!isFinite(bill) || bill <= 0) return null;

    var ref = W.minBasePriceFor(provinceCode);
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
      sample: ref.sample
    };
  };

  /* ------------------------------------------------------------------ *
   * Quick estimate (homepage "What could you save?")
   *
   * Supersedes minBasePriceFor/estimateAnnualSavings above for the homepage
   * widget. Both are kept because they are a DIFFERENT reference and are
   * still the province-floor answer; the quick estimate below is the
   * city-level one, and the two must not be blended:
   *
   *   estimateAnnualSavings  cheapest plan at ANY speed, province only,
   *                          provider not named. A 15 Mbps DSL line can set
   *                          that floor, so the comparison is not like for
   *                          like and the number cannot be attributed.
   *   quickEstimate          cheapest plan at >=100 Mbps in the household's
   *                          CITY, provider named, province as the fallback.
   *
   * Data: js/whollar-estimate-bench.js (scripts/build-estimate-bench.mjs,
   * from the "Internet Pricing" sheet). Records are
   * { p: displayed monthly, eff: monthly + upfront/24, mb: Mbps, who: provider }.
   * Ranking used eff; `p` is what the card shows, because `p` is the number
   * a household compares against their own bill.
   *
   * These are ADVERTISED RESELLER prices. They are not offers Whollar can
   * make, and the copy that renders them has to say so.
   * ------------------------------------------------------------------ */

  /* A bill outside this range is a typo or a bundle total, not a monthly
     internet bill, and extrapolating from it produces a headline number the
     full checkup will contradict. */
  W.ESTIMATE_BILL_MIN = 20;
  W.ESTIMATE_BILL_MAX = 400;

  /* Resolve a postal code to the cheapest tracked >=100 Mbps plan near it.
     Returns null when the postal code is not a real Canadian one or no
     reference exists at all, so a caller renders nothing rather than a
     number it cannot support.

     `basis` is 'city' or 'province' and MUST reach the copy: a province
     number may not be presented as a local one. Deliberately reuses
     W.parsePostal rather than a fresh regex: parsePostal already encodes
     that Canada Post uses no D/F/I/O/Q/U anywhere and no W/Z leading, which
     a plain [A-Z] class in positions 3 and 5 would wave through.

     A COMPLETE six-character code is required even though only the FSA is
     used to resolve. A bare "M5V" is far more often a half-typed entry than
     a deliberate one, and accepting it would fire the estimate mid-keystroke.
     The FSA is all that is kept or sent onward. */
  W.estimateBenchFor = function (rawPostal) {
    var parsed = W.parsePostal(rawPostal);
    if (!parsed || !parsed.complete) return null;

    var byCity = W.ESTIMATE_BY_CITY || null;
    var byFsa = W.ESTIMATE_FSA_CITY || null;
    var byProv = W.ESTIMATE_BY_PROVINCE || null;

    var cityKey = (byFsa && byCity) ? byFsa[parsed.fsa] : null;
    var hit = cityKey ? byCity[cityKey] : null;
    if (hit && hit.p > 0) {
      return {
        p: hit.p, mb: hit.mb, who: hit.who,
        basis: 'city',
        city: cityKey.slice(cityKey.indexOf('|') + 1),
        fsa: parsed.fsa,
        provinceCode: parsed.provinceCode,
        province: parsed.province
      };
    }

    var pv = (byProv && parsed.provinceCode) ? byProv[parsed.provinceCode] : null;
    if (pv && pv.p > 0) {
      return {
        p: pv.p, mb: pv.mb, who: pv.who,
        basis: 'province',
        city: null,
        fsa: parsed.fsa,
        provinceCode: parsed.provinceCode,
        province: parsed.province
      };
    }
    return null;
  };

  /* The estimate itself.

     annual = delta > 0 ? Math.floor(delta) * 12 : 0

     Math.floor on the MONTHLY delta before multiplying, not on the annual
     product: it rounds the headline down, so the figure shown is one the
     household can reach rather than one they might fall short of by cents.

     A bill at or below the tracked benchmark returns atOrBelow with a zero
     annual. That is a real, reportable outcome, not an error and not a
     negative saving, and the caller must render it as its own path.

     Returned `reason` on failure lets the caller say which input was wrong:
     'bill' (outside the accepted range or not a number), 'postal' (not a
     valid Canadian postal code), 'no-reference' (valid inputs, no data). */
  W.quickEstimate = function (monthlyBill, rawPostal) {
    var bill = Number(monthlyBill);
    if (!isFinite(bill) || bill < W.ESTIMATE_BILL_MIN || bill > W.ESTIMATE_BILL_MAX) {
      return { ok: false, reason: 'bill' };
    }
    var pc = W.parsePostal(rawPostal);
    if (!pc || !pc.complete) return { ok: false, reason: 'postal' };

    var ref = W.estimateBenchFor(rawPostal);
    if (!ref) return { ok: false, reason: 'no-reference' };

    var delta = bill - ref.p;
    var annual = delta > 0 ? Math.floor(delta) * 12 : 0;

    return {
      ok: true,
      annual: annual,
      monthlyDelta: delta,
      atOrBelow: delta <= 0,
      bill: bill,
      benchmark: ref.p,
      mbps: ref.mb,
      provider: ref.who,
      basis: ref.basis,
      city: ref.city,
      fsa: ref.fsa,
      province: ref.province,
      provinceCode: ref.provinceCode
    };
  };

  /* "in Toronto" / "across Ontario". The province wording is deliberately
     broad: a province-basis number must not read as a local one. */
  W.estimateAreaLabel = function (est) {
    if (!est) return '';
    if (est.basis === 'city' && est.city) return 'in ' + est.city;
    return est.province ? 'across ' + est.province : '';
  };

  /* ================================================================== *
   * 5. SIGNAL BANDS (bill-checkup result card)
   * ------------------------------------------------------------------
   * Replaces the old weak/fair/strong/cliff verdict (W.score/effectiveCost/
   * basePriceFor, retired 2026-08-07: nothing but bill-checkup.html ever
   * called them, confirmed by repo-wide grep before deleting). The lookup
   * this scores against is js/whollar-signal-lookup.js (built from the full
   * "Whollar Pricing Model.xlsx" sheet, FSA-level, median-based) via
   * W.signalBaseFor() below: a different reference from W.benchmarkFor()/
   * W.p10For() above, which are UNCHANGED and still power the homepage
   * estimator.
   *
   * W.selectBand is a pure function: no DOM, no globals read besides its
   * own arguments, integer cents in and out. Unit-tested in
   * scripts/test-select-band.mjs.
   * ================================================================== */

  /* Threshold table (bandId, condition on deltaRatio = (userPriceCents -
     basePriceCents) / basePriceCents):
       1  ratio >= +0.15
       2  +0.05 <= ratio <  +0.15
       3  -0.05 <  ratio <  +0.05
       4  -0.20 <  ratio <= -0.05
       5  ratio <= -0.20
     This partitions the number line with no gap and no overlap: every
     boundary value belongs to exactly one band. NOTE: the spec this was
     built from also said in prose "exactly -0.05 is band 3", which
     contradicts its own table (where band 3 is -0.05 < ratio, open, and
     band 4 is ratio <= -0.05, closed). Implemented per the table, since
     it is the only one of the two that is internally consistent across
     all five bands: flagging this rather than silently picking a side. */
  W.selectBand = function (input) {
    var opts = input || {};
    var userPriceCents = Math.round(Number(opts.userPriceCents) || 0);
    var basePriceCents = (opts.basePriceCents == null || opts.basePriceCents === '')
      ? null : Math.round(Number(opts.basePriceCents));
    var periodMonths = Number(opts.periodMonths) > 0 ? Number(opts.periodMonths) : 24;
    var onPromo = opts.onPromo === true;
    var promoEndDate = opts.promoEndDate || null;
    /* Term-aware savings from W.contractQuote(), when the household gave
       enough of a contract to build a schedule. periodMonths * today's delta
       is the fallback, and it is wrong the moment a price change sits inside
       the window: see the contract schedule engine's note above. Band
       SELECTION is unaffected either way: the verdict is about the price
       being paid today, not about the total. */
    var scheduleSavingsCents = (opts.scheduleSavingsCents == null || opts.scheduleSavingsCents === '')
      ? null : Math.round(Number(opts.scheduleSavingsCents));
    if (!isFinite(scheduleSavingsCents)) scheduleSavingsCents = null;

    /* Guardrail 1: a lookup miss must never masquerade as a confident
       verdict. Render band 3 with both the benchmark row and the savings
       row suppressed rather than substituting any other reference. */
    if (basePriceCents == null || !(basePriceCents > 0)) {
      return {
        bandId: 3, deltaRatio: null, deltaCents: null, savingsCents: 0,
        showBenchmarkRow: false, showSavingsRow: false, showPromoDateRow: false
      };
    }

    var deltaCents = userPriceCents - basePriceCents;
    var deltaRatio = deltaCents / basePriceCents;

    var bandId;
    if (deltaRatio >= 0.15) bandId = 1;
    else if (deltaRatio >= 0.05) bandId = 2;
    else if (deltaRatio > -0.05) bandId = 3;
    else if (deltaRatio > -0.20) bandId = 4;
    else bandId = 5;

    /* Guardrail 2: band 5 asserts promo pricing. Without confirmation, the
       same ratio reads as band 4 at the household's actual (non-promo)
       price instead. */
    if (bandId === 5 && !onPromo) bandId = 4;
    /* Guardrail 3: band 5's CTA and body both name a real date. */
    if (bandId === 5 && !promoEndDate) bandId = 4;

    var showPromoDateRow = bandId === 5;
    /* savingsCents is never negative, the schedule figure arrives already
       floored at zero (W.contractQuote's forward.savingsCents), and the
       fallback floors the per-month gap before the multiply, so bands 3/4,
       negative or near-zero ratios, compute to exactly 0 rather than merely
       displaying as $0. */
    var savingsCents = scheduleSavingsCents !== null
      ? Math.max(0, scheduleSavingsCents)
      : Math.round(periodMonths * Math.max(0, deltaCents));

    return {
      bandId: bandId,
      deltaRatio: deltaRatio,
      deltaCents: deltaCents,
      savingsCents: showPromoDateRow ? null : savingsCents,
      showBenchmarkRow: true,
      showSavingsRow: !showPromoDateRow,
      showPromoDateRow: showPromoDateRow
    };
  };

  /* Cascade for the new FSA-level lookup: FSA → city → province, and within
     each geography, the household's exact connection type before falling
     back to every terrestrial type pooled together (js/whollar-signal-
     lookup.js only ever emits a bucket once it has >=5 samples, so any key
     present here already clears that bar: a miss just means "try the next,
     coarser key").
     input: { fsa, provinceCode, speedMbps, connectionType } (connectionType
     is one of 'fibre'|'cable'|'dsl'|null; null skips straight to the
     terrestrial-pooled key at each geography)
     returns: { basePriceCents, sample, confidence } or null. */
  W.signalBaseFor = function (input) {
    var opts = input || {};
    var byFsa = W.SIGNAL_BY_FSA, byCity = W.SIGNAL_BY_CITY, byProv = W.SIGNAL_BY_PROVINCE;
    if (!byFsa && !byCity && !byProv) return null;

    var tier = W.signalSpeedTier(opts.speedMbps);
    if (!tier) return null;

    var fsa = (opts.fsa || '').toUpperCase();
    var loc = fsa && W.FSA_CITY ? W.FSA_CITY[fsa] : null;
    var city = loc ? loc.city : null;
    var pv = opts.provinceCode || (loc ? loc.province : null);
    var type = opts.connectionType || null;

    /* Must exactly mirror scripts/build-signal-lookup.mjs's normCity(): same
       cleanup on both sides of the join, or a real match silently misses. */
    var cityKey = city && pv
      ? city.toLowerCase().trim().replace(/[.''’]/g, '').replace(/\s+\d+$/, '').replace(/\s+/g, ' ') + '|' + pv
      : null;

    var tries = [];
    if (fsa) { if (type) tries.push(['fsa', byFsa, fsa + '|' + tier + '|' + type]); tries.push(['fsa', byFsa, fsa + '|' + tier + '|terrestrial']); }
    if (cityKey) { if (type) tries.push(['city', byCity, cityKey + '|' + tier + '|' + type]); tries.push(['city', byCity, cityKey + '|' + tier + '|terrestrial']); }
    if (pv) { if (type) tries.push(['province', byProv, pv + '|' + tier + '|' + type]); tries.push(['province', byProv, pv + '|' + tier + '|terrestrial']); }

    for (var i = 0; i < tries.length; i++) {
      var table = tries[i][1];
      var hit = table ? table[tries[i][2]] : null;
      if (hit && hit[0] > 0) {
        return { basePriceCents: hit[0], sample: hit[1], confidence: tries[i][0] };
      }
    }
    return null;
  };

  /* Nearest-tier bucketing (not floor/ceiling): the tier with the smallest
     absolute distance from the raw Mbps value wins. Ties (equidistant
     between two tiers) resolve to the lower tier, matching Math.round's own
     .5-rounds-up-toward-the-first-comparison behaviour is NOT what this
     does: ties are decided explicitly below so the rule is legible
     without working out floating-point argmin by hand. */
  W.signalSpeedTier = function (mbps) {
    var v = Number(mbps);
    if (!isFinite(v) || v <= 0) return null;
    var tiers = W.SIGNAL_META ? W.SIGNAL_META.speedTiers : null;
    if (!tiers || !tiers.length) return null;
    var best = tiers[0], bestDist = Math.abs(v - tiers[0]);
    for (var i = 1; i < tiers.length; i++) {
      var d = Math.abs(v - tiers[i]);
      if (d < bestDist) { best = tiers[i]; bestDist = d; }
    }
    return best;
  };

  /* ------------------------------------------------------------------ *
   * Contract schedule engine
   * ------------------------------------------------------------------
   * The savings row used to be periodMonths * (today's price - benchmark).
   * That is only right for a household whose price never changes, which is
   * exactly the household this page does NOT exist for: a promo that ends in
   * November means the next twelve bills are not twelve of the bill sitting
   * on the table today.
   *
   * One model covers every case: a contract is a series of monthly BILLING
   * CYCLES. Cycle k bills on (contractStart + k months), k = 0..term-1. Each
   * cycle has the price actually paid that month; the benchmark is what the
   * market charges for that speed in that area. Savings over any window =
   * sum(paid - benchmark) across the cycles in it.
   *
   * Promo rules:
   *  - Single promo: a cycle is promo-priced iff its bill date falls on or
   *    before the promo end date. After that, the regular price applies.
   *  - Stacked promos: the month-by-month rows ARE the schedule, consumed in
   *    order from contract start; months they don't cover bill at the regular
   *    price. When rows are present they override the single-promo fields.
   *
   * Field mapping from the checkup form (both in cents here):
   *   regularPriceCents  = Q03 "Current price you pay", the gross monthly
   *                        charge, which is also the post-promo price
   *   discountPriceCents = that charge minus Q09's discount, what is paid
   *                        while the promo runs
   * The form collects the discount as an amount off (so does the bill OCR);
   * the conversion to a promo PRICE happens at the call site.
   *
   * The benchmark is passed in, never looked up here: W.signalBaseFor() is
   * the one price reference and its cascade already decided the number.
   * ------------------------------------------------------------------ */

  /* Typical Canadian ISP promo length, used only when a discount is stated
     but its end date is not. Always reported back in flags.assumedPromoMonths
     so the card can say the number rests on an assumption. */
  W.ASSUMED_PROMO_MONTHS = 12;

  /* Add n months, clamping the day: Jan 31 + 1mo is Feb 28, not Mar 3. */
  W.addMonths = function (date, n) {
    var day = date.getDate();
    var d = new Date(date.getFullYear(), date.getMonth() + n, 1);
    var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d;
  };

  /* Accepts a Date, a 'YYYY-MM-DD' string (what <input type="date"> gives),
     or null. Anchored to LOCAL midnight: see W.parseDateLocal's note. */
  function asDate(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    return W.parseDateLocal(v);
  }

  /* input: { termMonths, regularPriceCents, discountPriceCents?,
              contractStart?, promoEnd?, periods?: [{priceCents, months}],
              today? }
     returns { term, anchor, elapsed, prices (cents, one per cycle), flags } */
  W.buildSchedule = function (input) {
    var opts = input || {};
    var term = Math.max(1, Math.round(Number(opts.termMonths) || 0));
    /* A blank field is "not given", not zero: Number('') is 0, so without
       this an empty monthly charge would schedule a free contract and every
       downstream figure would be a confident lie. A real numeric 0 is still
       allowed through. */
    var raw = opts.regularPriceCents;
    if (raw === null || raw === undefined || raw === '') return null;
    var regular = Math.round(Number(raw));
    if (!isFinite(regular) || regular < 0) return null;

    var flags = { assumedStart: false, assumedPromoMonths: null };
    var anchor = asDate(opts.contractStart);
    if (!anchor) {
      anchor = asDate(opts.today) || new Date();
      anchor.setHours(0, 0, 0, 0);
      flags.assumedStart = true;
    }

    /* Cycles already billed: bill date on or before today. If the start date
       had to be assumed, nothing counts as elapsed: every figure is then a
       forward projection, which is the only claim the data supports. */
    var today = asDate(opts.today) || new Date();
    today.setHours(0, 0, 0, 0);
    var elapsed = 0;
    if (!flags.assumedStart) {
      for (var e = 0; e < term; e++) {
        if (W.addMonths(anchor, e) <= today) elapsed++;
        else break;
      }
    }

    /* Stacked promos: the rows win over the single-promo fields. */
    var rows = (opts.periods || []).map(function (p) {
      return {
        priceCents: Math.round(Number(p.priceCents)),
        months: Math.floor(Number(p.months) || 0)
      };
    }).filter(function (p) {
      return p.months > 0 && isFinite(p.priceCents) && p.priceCents >= 0;
    });

    var prices = [], k;
    if (rows.length) {
      for (var i = 0; i < rows.length; i++) {
        for (var j = 0; j < rows[i].months && prices.length < term; j++) {
          prices.push(rows[i].priceCents);
        }
      }
      while (prices.length < term) prices.push(regular);
    } else {
      var dRaw = opts.discountPriceCents;
      var hasDiscount = dRaw !== null && dRaw !== undefined && dRaw !== '' && isFinite(Number(dRaw));
      var discount = hasDiscount ? Math.round(Number(dRaw)) : null;
      var promoEnd = asDate(opts.promoEnd);

      var promoCycles = 0;
      if (discount !== null) {
        if (promoEnd) {
          for (k = 0; k < term; k++) {
            if (W.addMonths(anchor, k) <= promoEnd) promoCycles++;
            else break;
          }
        } else {
          /* No end date, but a discount IS on the bill. Anchoring the assumed
             twelve months at the contract start would put the promo in the
             past for anyone more than a year in, and then the schedule would
             price today's cycle at the full rate while the card's own "you
             pay now" row shows the discounted one: the same household told
             two different things on one card. So the assumed window runs
             twelve months FORWARD from the cycle they are in now.

             That also errs the safe way. Assuming the promo ends sooner
             raises the projected gap against the market, i.e. promises more
             saving; assuming it runs on lowers it. When the household has
             told us they don't know, the number that under-promises is the
             only one worth showing. flags.assumedPromoMonths carries it to
             the card, which says so in as many words. */
          promoCycles = Math.min(elapsed + W.ASSUMED_PROMO_MONTHS, term);
          flags.assumedPromoMonths = W.ASSUMED_PROMO_MONTHS;
        }
      }
      for (k = 0; k < term; k++) prices.push(k < promoCycles ? discount : regular);
    }

    return { term: term, anchor: anchor, elapsed: elapsed, prices: prices, flags: flags };
  };

  /* Everything buildSchedule takes, plus:
       basePriceCents   the benchmark from W.signalBaseFor(), or null
       horizonMonths    how many UNBILLED cycles the forward figure covers;
                        defaults to (and is capped at) the whole remainder

     returns null when there is nothing to schedule. Otherwise:
       months   { term, elapsed, remaining, horizon }
       nowCents price of the cycle the household is in today
       schedule per-cycle rows, for anyone who wants to show the ladder
       toDate / forward / total   { payCents, atMarketCents, differenceCents }
                                  null when there is no benchmark
       flags    assumedStart, assumedPromoMonths, atOrBelowMarket,
                noBenchmark, priceChangesInHorizon

     forward.differenceCents is the honest signed number. The card shows
     forward.savingsCents, which is that floored at zero: a household paying
     under the local median is a real outcome and must never render as a
     negative saving. flags.atOrBelowMarket says which case it is. */
  W.contractQuote = function (input) {
    var opts = input || {};
    var built = W.buildSchedule(opts);
    if (!built) return null;

    var term = built.term, prices = built.prices, anchor = built.anchor;
    var elapsed = built.elapsed, remaining = term - elapsed;
    var k;

    var horizon = remaining;
    if (opts.horizonMonths != null && Number(opts.horizonMonths) >= 0) {
      horizon = Math.min(remaining, Math.round(Number(opts.horizonMonths)));
    }

    var base = (opts.basePriceCents == null || opts.basePriceCents === '')
      ? null : Math.round(Number(opts.basePriceCents));
    if (!(base > 0)) base = null;

    var sum = function (a) {
      return a.reduce(function (x, y) { return x + y; }, 0);
    };
    var window_ = function (payCents, months) {
      if (base === null) return null;
      return {
        payCents: payCents,
        atMarketCents: base * months,
        differenceCents: payCents - base * months
      };
    };

    var forwardPrices = prices.slice(elapsed, elapsed + horizon);
    var forward = window_(sum(forwardPrices), horizon);
    if (forward) forward.savingsCents = Math.max(0, forward.differenceCents);

    /* The cycle being lived through right now: the last one billed, or the
       first one if none has billed yet. */
    var nowCents = prices[Math.min(term - 1, Math.max(0, elapsed - 1))];
    if (elapsed === 0) nowCents = prices[0];

    var changes = false;
    for (k = 1; k < forwardPrices.length; k++) {
      if (forwardPrices[k] !== forwardPrices[k - 1]) { changes = true; break; }
    }

    return {
      months: { term: term, elapsed: elapsed, remaining: remaining, horizon: horizon },
      nowCents: nowCents,
      schedule: prices.map(function (price, idx) {
        return {
          cycle: idx + 1,
          billDate: W.addMonths(anchor, idx),
          payCents: price,
          marketCents: base,
          deltaCents: base === null ? null : price - base,
          billed: idx < elapsed
        };
      }),
      toDate: window_(sum(prices.slice(0, elapsed)), elapsed),
      forward: forward,
      total: window_(sum(prices), term),
      flags: {
        assumedStart: built.flags.assumedStart,
        assumedPromoMonths: built.flags.assumedPromoMonths,
        noBenchmark: base === null,
        atOrBelowMarket: !!(forward && forward.differenceCents <= 0),
        priceChangesInHorizon: changes
      }
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

  /* ------------------------------------------------------------------
   * Referral capture.
   *
   * A share link is `?ref=WHL-XXXXXXXX` on any page of the site, and the page
   * it lands on is almost never the page where an account gets created: a
   * neighbour follows the link to the home page, reads for a while, runs the
   * checkup, and signs up two clicks later. Anything that reads the parameter
   * only at the signup form loses every one of those.
   *
   * So the parameter is banked on arrival, on whatever page arrives, and spent
   * later by `session.signup` / `session.otpVerify`, which fall back to it when
   * no code was passed. That fallback is why a page needs no referral code of
   * its own to attribute one.
   *
   * Bounded like the checkup handoff and for the same reason: 60 days, cleared
   * the moment a signup completes. Only the shape is validated here, never the
   * ownership: the server decides whether a code belongs to anybody, and this
   * one is stored exactly as the server would normalise it so the two agree.
   * ------------------------------------------------------------------ */

  W.REF_KEY = 'whollar.ref';
  W.REF_TTL_MS = 60 * 24 * 60 * 60 * 1000;

  /** `WHL-3F9A2C1D` from any form a link or a human produces, or null. */
  function normalizeRef(input) {
    var flat = String(input == null ? '' : input).toLowerCase().replace(/[^0-9a-z]/g, '');
    if (flat.length < 8) return null;
    var tail = flat.slice(-8);
    return /^[0-9a-f]{8}$/.test(tail) ? 'WHL-' + tail.toUpperCase() : null;
  }

  W.referral = {
    normalize: normalizeRef,

    /** The share link for a code, on whatever host this page is served from. */
    link: function (code) {
      var c = normalizeRef(code);
      return location.origin + '/waitlist/' + (c ? '?ref=' + encodeURIComponent(c) : '');
    },

    /**
     * Bank `?ref=` if this page load carries one. Called once at load; safe to
     * call again. A later link overwrites an earlier one, which is the honest
     * reading of "the last neighbour who sent them".
     */
    capture: function () {
      var code = null;
      try {
        var q = new URLSearchParams(location.search);
        code = normalizeRef(q.get('ref') || q.get('referral'));
      } catch (e) { code = null; }
      if (!code) return null;
      try {
        localStorage.setItem(W.REF_KEY, JSON.stringify({ code: code, savedAt: Date.now() }));
      } catch (e) { /* private mode: the code still works if typed */ }
      return code;
    },

    /** The banked code, or null once it is older than the TTL. */
    pending: function () {
      try {
        var v = JSON.parse(localStorage.getItem(W.REF_KEY));
        if (!v || !v.code) return null;
        if (!v.savedAt || Date.now() - v.savedAt > W.REF_TTL_MS) {
          W.referral.clear();
          return null;
        }
        return normalizeRef(v.code);
      } catch (e) { return null; }
    },

    clear: function () {
      try { localStorage.removeItem(W.REF_KEY); } catch (e) { /* ignore */ }
    }
  };

  W.referral.capture();

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
    /**
     * The winning offer on a cohort this member joined, once its sealed window
     * has closed. Resolves { sealed, closesAt, bidCount, offer } or null.
     *
     * `sealed:true` means the window is still open and the server told us
     * nothing else: no price, no count, not even whether anyone has bid. Do
     * not treat that as "no offer yet" in a way that leaks a guess, and do not
     * poll it hoping the count appears; it does not exist before the close.
     *
     * Boot-path read, so it never rejects: a missing endpoint or a flaky
     * network resolves null and the panel keeps its own empty state.
     */
    campaignOffer: function (id) {
      return fetch(W.AUTH_API + '/campaigns/' + encodeURIComponent(id) + '/offer', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.ok) ? b : null;
      }).catch(function () {
        return null;
      });
    },

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
        referralCode: o.referralCode || W.referral.pending(),
        marketing: Boolean(o.marketing)
      }).then(function (b) {
        // This call creates the account when the address is new, so the banked
        // code is spent here for the same reason signupVerify spends it.
        if (b && b.created) W.referral.clear();
        return b;
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
        // Falls back to the code this browser arrived with, so a page that
        // never grew a referral field still attributes the neighbour who sent
        // them. A page passing one explicitly always wins.
        referralCode: o.referralCode || W.referral.pending(),
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
      }).then(function (b) {
        // Spent. Leaving it banked would re-attribute the next person to sign
        // up in this browser, which on a shared laptop is somebody else.
        W.referral.clear();
        return b;
      });
    },

    /**
     * Sign in, step one. -> { ok, mfaRequired: true, ttlMinutes, dev? }
     *
     * RESOLVING DOES NOT MEAN SIGNED IN. A correct password gets a code emailed
     * and nothing else: no cookie, no session. `loginVerify` below is what
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
     * The password is deliberately not re-sent: the server already checked it
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
     * the org, its name, its approval, comes back here, because none of it
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

    /** Merge preference keys ('alerts', 'interests', 'notify', 'services'). -> { ok, prefs } */
    prefsSave: function (patch) { return authPost('/me/prefs', patch); },

    /** Record feedback: { kind: 'rating'|'outage'|'interest'|'provider-notify',
        payload: {...} }. -> { ok } */
    event: function (kind, payload) {
      return authPost('/me/event', { kind: kind, payload: payload || {} });
    },

    /**
     * Does a referral code belong to anyone. -> { valid, code, firstName }
     *
     * Public: the people who need the answer are on the join form and have no
     * session yet. Resolves to `{ valid: false }` on any failure, so a field
     * checking a code never blocks a signup that would otherwise work.
     */
    referralCheck: function (code) {
      var c = W.referral.normalize(code);
      var miss = { valid: false, code: null, firstName: null };
      if (!c) return Promise.resolve(miss);
      return fetch(W.AUTH_API + '/public/referral?code=' + encodeURIComponent(c), {
        method: 'GET',
        headers: { Accept: 'application/json' }
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (b) {
        return (b && b.ok) ? b : miss;
      }).catch(function () { return miss; });
    },

    /**
     * The member's share code and what it has brought in, or null.
     * -> { code, joined, pending }
     *
     * `joined` is verified accounts. `pending` is people who used the code and
     * have not proved their address yet, kept apart so the number shown to a
     * member is one nobody else can move.
     */
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
