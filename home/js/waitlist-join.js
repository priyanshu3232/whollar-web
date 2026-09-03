/* The /join waitlist: the scene animation and the form.
 *
 * This is the classic-script reimplementation of the waitlist design canvas's
 * React component (see scripts/port-waitlist.mjs for why that component cannot
 * ship). The canvas's submit() validated and then only set a flag, so as drawn
 * the page told someone they were on the list and sent nothing. This posts.
 *
 * WHICH LANE, AND WHY. One submit, POST /waitlist-join, the same route the
 * older /waitlist/ page uses: it writes the WaitlistSignups row and queues the
 * CRM lead, and it needs neither a session nor an emailed code. The form ends
 * at the welcome screen, which is what was asked for.
 *
 * WHAT THAT COSTS, SO NOBODY REDISCOVERS IT: no code means no proven address,
 * and this backend mints an account only behind a code (/signup/verify and
 * otpVerify are the only two doors). So a household joining here is on the
 * list and in the CRM, but has no account, no session and no referral code,
 * and the welcome screen degrades accordingly. Restoring accounts means either
 * putting a code step back or a new backend route, not a change in this file.
 *
 * TWO FIELDS ARE COLLECTED AND NOT SENT, deliberately and not silently: the
 * full street address and the preferred language have no column on this route.
 * Both are marked below. Wiring them is backend work, not a line in this file.
 * "Pooling for" IS sent: /waitlist-join keeps it on the row and puts it on the
 * CRM lead, and it also decides which welcome screen this form ends on.
 */
(function () {
  'use strict';

  var W = window.WHOLLAR;
  var root = document.querySelector('[data-wl-root]');

  function show(name, on) {
    var els = document.querySelectorAll('[data-wl-when="' + name + '"]');
    for (var i = 0; i < els.length; i++) els[i].hidden = !on;
  }
  function setText(sel, text) {
    var el = document.querySelector(sel);
    if (el) el.textContent = text;
  }
  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
  }
  function radio(name) {
    var el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }
  /* Byte for byte what normalizePhone() accepts in
     catalyst-backend/functions/formSubmit/index.js: ten digits, or eleven
     starting with the country code. */
  function phoneOk(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    return d.length === 10 || (d.length === 11 && d.charAt(0) === '1');
  }

  /* ---- the three-scene animation ----
   * One JS clock owns the cycle; every 400ms each scene animation is corrected
   * back onto that phase, so a suspended tab cannot strand it on scene one.
   * Thresholds are the canvas's. */
  var SCENE_SECONDS = 6;
  var cycle = SCENE_SECONDS * 3000;
  var t0 = null;

  function syncAnims() {
    if (!root) return;
    if (t0 == null) t0 = performance.now();
    var phase = (performance.now() - t0) % cycle;
    var nodes = root.querySelectorAll('[data-anim]');
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].getAnimations) continue;
      var list;
      try { list = nodes[i].getAnimations(); } catch (e) { continue; }
      list.forEach(function (a) {
        try {
          if (a.playState !== 'running') a.play();
          var ct = ((Number(a.currentTime) || 0) % cycle + cycle) % cycle;
          var d = Math.abs(ct - phase);
          if (Math.min(d, cycle - d) > 260) a.currentTime = phase;
        } catch (e) { /* a finished animation can throw on currentTime */ }
      });
    }
  }

  if (root) {
    var anims = root.querySelectorAll('[data-anim]');
    for (var i = 0; i < anims.length; i++) {
      anims[i].style.animationDuration = (SCENE_SECONDS * 3) + 's';
    }
    t0 = performance.now();
    setInterval(syncAnims, 400);
    document.addEventListener('visibilitychange', syncAnims);
  }

  /* ---- the referral field reveal ---- */

  var openRef = document.querySelector('[data-wl-action="open-ref"]');
  if (openRef) {
    openRef.addEventListener('click', function () {
      show('ref-closed', false);
      show('ref-open', true);
      var el = document.getElementById('wref');
      if (el) el.focus();
    });
  }

  /* ---- arriving from the landing page ----
   * /landing's inline box collects an address and hands it over rather than
   * pretending to sign anyone up, so honour it and skip a retype. */

  try {
    var handoff = new URLSearchParams(window.location.search).get('email');
    if (handoff && handoff.indexOf('@') > 0) {
      var pre = document.getElementById('wemail');
      if (pre) pre.value = handoff;
    }
  } catch (e) { /* an unparseable query string is not a reason to break the form */ }

  /* ---- the form ---- */

  var form = document.querySelector('[data-wl-form]');
  var pending = null;

  function fail(msg, el) {
    setText('[data-wl-error]', msg);
    show('error', true);
    if (el) el.focus();
  }

  function busy(on, label) {
    var btn = form && form.querySelector('button[type="submit"]');
    if (!btn) return;
    btn.disabled = on;
    btn.style.opacity = on ? '0.65' : '';
    if (label) btn.textContent = label;
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      show('error', false);

      var first = document.getElementById('wfirst');
      var last = document.getElementById('wlast');
      var email = document.getElementById('wemail');
      var addr = document.getElementById('waddr');
      var postal = document.getElementById('wpostal');
      var terms = document.getElementById('wterms');
      var cohort = document.getElementById('wcohort');

      var phone = document.getElementById('wphone');

      /* Two boxes, because the record has two columns and /waitlist-join
         enforces both at two characters each. One box split on the first
         space guessed wrong for anyone whose given name is two words, and it
         had no way to ask which half was which. These mirror the route, so a
         form that would 400 says which field and why, here, in the page's own
         words rather than as a bare server message. */
      if (first.value.trim().length < 2) return fail('Add your first name.', first);
      if (last.value.trim().length < 2) return fail('Add your last name.', last);
      if (!email.value || !email.checkValidity()) return fail('Enter an email we can reach you at.', email);
      if (!phoneOk(phone && phone.value)) {
        return fail('Add a mobile number we can text when a bid lands.', phone);
      }
      /* The address is not checked, because it is not required and not sent:
         see unsentAddress below. Blocking the form on a value the route has
         nowhere to put cost joins and bought nothing. */
      /* W.parsePostal rather than a fresh regex: it already encodes which
         letters are real, canonicalises the spacing, and derives the province
         the profile write wants, which a bare shape test cannot. */
      var pc = W.parsePostal(postal.value);
      if (!pc || !pc.complete) return fail('Postal code should look like M1B 2K3.', postal);
      if (!terms.checked) return fail('Accept the Terms and Privacy Policy to continue.', terms);
      if (cohort && !cohort.checked) return fail('We need to be able to email you about your cohort and your offer.', cohort);

      pending = {
        email: email.value.trim(),
        firstName: first.value.trim().replace(/\s+/g, ' '),
        lastName: last.value.trim().replace(/\s+/g, ' '),
        phone: val('wphone').trim() || null,
        postalCode: pc.full,
        provinceCode: pc.provinceCode,
        fsa: pc.fsa,
        referralCode: val('wref').trim() || null,
        marketing: !!(cohort && cohort.checked),
        pool: radio('pool'),
        /* COLLECTED, NOT SENT. Neither has anywhere to go on this route: it
           stores a name, an email, a phone, an FSA, a referral code and the
           product. Kept here so the day a column exists this is a one-line
           change, and so nobody reads the form and assumes they are stored. */
        unsentAddress: addr ? addr.value.trim() : null,
        unsentLang: radio('lang')
      };

      var fields = {
        firstName: pending.firstName,
        lastName: pending.lastName,
        email: pending.email,
        phone: pending.phone,
        postalFull: pending.postalCode,
        fsa: pending.fsa,
        province: pending.provinceCode,
        provinceCode: pending.provinceCode,
        referral: pending.referralCode,
        poolingFor: pending.pool
      };
      /* CASL: what was agreed to, when, and on which page. The checkbox state
         alone proves nothing a year from now, and the route carries these
         through to the CRM payload. */
      var consent = W.consentPayload('waitlist', pending.marketing);
      for (var k in consent) {
        if (Object.prototype.hasOwnProperty.call(consent, k)) fields[k] = consent[k];
      }

      busy(true, 'Adding you...');
      W.submitForm('/waitlist-join', fields).then(function () {
        finish();
      }).catch(function (err) {
        busy(false, 'Become a founding member');
        /* The server's messages are written to be shown, so show them. */
        fail(err.message || 'Something went wrong. Please try again.', email);
      });
    });
  }

  /* ---- handing over to the welcome screen ---- */

  /* WHY sessionStorage AND NOT THE URL. The welcome screen names the person
     and their area, and it used to read both from the session. There is no
     session on this path, and a query string is the one place on a shared
     machine that keeps a name and a postal code after the tab is closed, in
     history and in any link that gets pasted. sessionStorage dies with the
     tab, so the screen stays personal and nothing outlives the visit. The
     product is still a query parameter: it is not personal, and it is what
     makes the page shareable as a preview. */
  var HANDOFF = 'whollar.join.welcome';

  function finish() {
    /* The welcome screen owns everything past this point: it names the person
       and tells them what happens next for the product they picked. The
       success panel the canvas drew stays in the markup as the fallback for a
       redirect that cannot happen. */
    var pool = pending.pool;
    try {
      window.sessionStorage.setItem(HANDOFF, JSON.stringify({
        firstName: pending.firstName,
        lastName: pending.lastName,
        postal: pending.postalCode,
        fsa: pending.fsa
      }));
    } catch (e) { /* a blocked store costs a name on the next screen, nothing more */ }

    /* Two destinations, not one screen with swapped copy. A tire household
       goes to its own page, which a separate build of the tire journey owns;
       internet and both go to the internet screen, where "both" keeps its
       two-cohort copy, since the internet cohort is the one live today. */
    var target = pool === 'tires'
      ? '/join-welcome-tires'
      : '/join-welcome' + (pool ? '?pool=' + encodeURIComponent(pool) : '');
    try {
      window.location.assign(target);
      return;
    } catch (e) { /* fall through to the inline panel */ }

    setText('[data-wl-donearea]', pending.postalCode);
    var label = { internet: 'Internet', tires: 'Winter tires', both: 'Internet and winter tires' };
    setText('[data-wl-donepool]', label[pool] || 'Internet');
    /* No account on this lane, so there is no member number to print. */
    setText('[data-wl-donenumber]', 'Pending');
    show('joined', true);
  }

  /* ---- start over from the success panel ---- */

  var reset = document.querySelector('[data-wl-action="reset"]');
  if (reset) {
    reset.addEventListener('click', function () {
      if (form) form.reset();
      pending = null;
      show('joined', false);
      show('error', false);
      show('not-joined', true);
    });
  }
})();
