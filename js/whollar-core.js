/* Whollar shared core — validators, parsers, benchmark, scoring, form plumbing.
 *
 * WHY THIS FILE EXISTS
 * Before this, every one of these helpers was copy-pasted into 7 pages
 * (bill-checkup ×3, waitlist ×2, become-a-partner ×2) and the copies had
 * already diverged: two different email regexes, two different postal
 * validators, and a scoring engine duplicated three times. A fix applied to
 * one copy silently missed the others. Everything shared now lives here.
 *
 * Loaded as a classic script (no modules — these are plain static pages served
 * from Vercel, and the bundled pages re-run head scripts after unpacking).
 * Exposes a single global: window.WHOLLAR.
 */
(function (root) {
  'use strict';

  /* Bundled pages (index.html, partners.html and their mobile builds) re-run
     head scripts after the template unpacks. Never initialise twice — the same
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
   * Development) — there is no production environment to point at yet.
   * Every live lead currently lands in the dev Data Store. Create the
   * production environment in the Catalyst console, then change the two
   * constants below and redeploy the frontend.
   * ================================================================== */

  W.CATALYST_HOST = 'https://whollar-110003037934.development.catalystserverless.ca';
  W.API = W.CATALYST_HOST + '/server/formSubmit';
  W.OCR_API = W.CATALYST_HOST + '/server/billOcr';

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
    /* X deliberately absent — resolved by FSA below. */
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
       Blind stripping turned "1e9" into 19 — a plausible-looking bill the user
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
     { value, ok, reason } — reason is 'empty' | 'nan' | 'low' | 'high'. */
  W.parseMoneyInRange = function (raw, min, max) {
    var n = W.parseMoney(raw);
    if (n === null) return { value: null, ok: false, reason: String(raw || '').trim() ? 'nan' : 'empty' };
    if (n < min) return { value: n, ok: false, reason: 'low' };
    if (n > max) return { value: n, ok: false, reason: 'high' };
    return { value: n, ok: true, reason: null };
  };

  /* Plausible monthly home-internet bill. The floor was already 15; the
     ceiling is new — there was none, so "999999" scored and rendered. */
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
    if (!isFinite(v)) return '—';
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
     after noon — mislabelling the single most urgent case as "Expired". */
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
   * ⚠ READ THIS BEFORE CHANGING ANY USER-FACING COMPARISON COPY.
   *
   * These are advertised-price reference points for a national entry-level
   * plan at each download tier. They are EDITORIAL ESTIMATES. They are not
   * sampled, not per-province, and not derived from provider minimums.
   * There is no benchmark dataset in this repository.
   *
   * Because of that, every comparison this file produces is explicitly
   * labelled `scope: 'national'`, and the UI must say "national" — never
   * "your province" or "your market". When a real per-province dataset
   * exists, populate PROVINCE_TIER_PRICE and the scope flips to 'province'
   * automatically with no other code change.
   *
   * benchmarkFor() returns null rather than guessing. A null benchmark must
   * render an "unknown" state, never a confident verdict.
   * ================================================================== */

  var NATIONAL_TIER_PRICE = {
    '25': 40, '50': 50, '100': 55, '150': 58,
    '300': 70, '500': 75, '1000': 85, '1500': 88
  };

  /* Shape: { ON: { '500': 72, … }, QC: { … } }. Empty until real data lands.
     A tier present here wins over the national number for that province. */
  var PROVINCE_TIER_PRICE = {};

  /* speed is the <select> value: '25'…'1500', or '0' meaning "not sure".
     '0' is NOT a tier — it used to map to an invented $60 benchmark and
     produced a confident verdict for a user who had just told us they did
     not know their speed. It now returns null. */
  W.benchmarkFor = function (provinceCode, speed) {
    if (speed == null || speed === '' || speed === '0') return null;
    var key = String(speed);
    var prov = provinceCode && PROVINCE_TIER_PRICE[provinceCode];
    if (prov && prov[key] != null) {
      return { price: prov[key], scope: 'province', provinceCode: provinceCode, tier: key };
    }
    if (NATIONAL_TIER_PRICE[key] != null) {
      return { price: NATIONAL_TIER_PRICE[key], scope: 'national', provinceCode: null, tier: key };
    }
    return null;
  };

  /* Northern internet pricing bears no relation to the national average
     (satellite/microwave backhaul, no cable overbuild). Scoring a territory
     household against a southern reference is the least supportable
     comparison this engine can make, so it is flagged rather than hidden. */
  W.TERRITORIES = ['NU', 'NT', 'YT'];
  W.isTerritory = function (provinceCode) {
    return W.TERRITORIES.indexOf(provinceCode) > -1;
  };

  W.hasProvinceBenchmarks = function () {
    for (var k in PROVINCE_TIER_PRICE) if (Object.prototype.hasOwnProperty.call(PROVINCE_TIER_PRICE, k)) return true;
    return false;
  };

  /* ================================================================== *
   * 5. SCORING
   * ------------------------------------------------------------------
   * Boundaries are inclusive-lower: r <= 0.92 strong, r <= 1.12 fair,
   * else weak. Verified deterministic at every tier — no float flip.
   * ================================================================== */

  W.STRONG_MAX = 0.92;
  W.FAIR_MAX = 1.12;
  W.CLIFF_DAYS = 60;

  /* What the household actually pays today. Clamped at zero, and a discount
     that meets or exceeds the charge is flagged as contradictory rather than
     silently producing an effective cost of $0 (which used to score as a
     "Strong deal — you pay $0/mo"). */
  W.effectiveCost = function (input) {
    var charge = Number(input.cost) || 0;
    var disc = Number(input.discount) || 0;
    if (input.promoExpired || disc <= 0) return { value: charge, contradictory: false };
    if (disc >= charge) return { value: charge, contradictory: true };
    return { value: charge - disc, contradictory: false };
  };

  /* input: { cost, discount, speed, promoEnd, promoExpired, provinceCode }
     returns: { state, ratio, benchmark, effective, reason }
       state ∈ 'cliff' | 'strong' | 'fair' | 'weak' | 'unknown'
       reason (only when 'unknown') ∈ 'no-cost' | 'no-speed' | 'no-benchmark'
                                    | 'discount-exceeds-charge' */
  W.score = function (input) {
    var eff = W.effectiveCost(input);
    var days = input.promoEnd ? W.daysUntil(input.promoEnd) : null;

    /* Cliff is date-driven and does not need a benchmark, so it is checked
       first — a household with an unknown speed can still be warned. */
    if (days !== null && days >= 0 && days <= W.CLIFF_DAYS) {
      return { state: 'cliff', ratio: null, benchmark: null, effective: eff.value, days: days, reason: null };
    }

    if (!(Number(input.cost) > 0)) {
      return { state: 'unknown', ratio: null, benchmark: null, effective: null, days: days, reason: 'no-cost' };
    }
    if (eff.contradictory) {
      return { state: 'unknown', ratio: null, benchmark: null, effective: eff.value, days: days, reason: 'discount-exceeds-charge' };
    }
    if (input.speed == null || input.speed === '' || input.speed === '0') {
      return { state: 'unknown', ratio: null, benchmark: null, effective: eff.value, days: days, reason: 'no-speed' };
    }

    var bench = W.benchmarkFor(input.provinceCode, input.speed);
    if (!bench || !(bench.price > 0)) {
      return { state: 'unknown', ratio: null, benchmark: null, effective: eff.value, days: days, reason: 'no-benchmark' };
    }

    var r = eff.value / bench.price;
    var state = r <= W.STRONG_MAX ? 'strong' : (r <= W.FAIR_MAX ? 'fair' : 'weak');
    return {
      state: state, ratio: r, benchmark: bench, effective: eff.value, days: days, reason: null,
      /* Set when the comparison is materially weaker than it looks, so the UI
         can qualify the verdict instead of stating it flat. */
      caveat: (bench.scope === 'national' && W.isTerritory(input.provinceCode)) ? 'territory' : null
    };
  };

  /* ================================================================== *
   * 6. CONSENT
   * ------------------------------------------------------------------
   * CASL requires that consent be provable: what was agreed to, when, and
   * where. Previously a checkbox gated the submit button and its state was
   * then thrown away — nothing about the consent reached the backend.
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
    var s = err && err.status;
    if (s === 429) return 'Too many attempts from your network right now — please try again in a little while.';
    if (s === 413) return 'That file is too large — please attach a smaller one and try again.';
    if (s === 415) return 'We can’t accept that file type — a PDF, JPG or PNG works.';
    if (s === 400 && err.body && err.body.error) return err.body.error;
    if (s >= 500) return 'Our server had a problem, so this wasn’t saved — please try again in a moment.';
    return 'We couldn’t reach our servers, so this wasn’t saved — please check your connection and try again.';
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
   * Errors used to be a red border and nothing else on 4 of 7 forms — no
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
      return { ok: false, code: 'size', message: 'That file is empty — please attach the bill itself.' };
    }
    if (file.size > W.MAX_ATTACH) {
      return { ok: false, code: 'size', message: 'That file is over 20 MB — a photo of the first page works too.' };
    }
    if (W.isHeic(file)) {
      return {
        ok: true, code: 'heic',
        message: 'Attached. It’s an iPhone HEIC photo, so we can’t auto-read it — please fill in the fields below and we’ll open it by hand.'
      };
    }
    if (type && W.UPLOAD_TYPES.indexOf(type) === -1) {
      return { ok: false, code: 'type', message: 'We can’t take that file type — a PDF, JPG, PNG, WebP or GIF works.' };
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
})(window);
