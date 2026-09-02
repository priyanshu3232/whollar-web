/* The /join waitlist: the scene animation, the form, and the code step.
 *
 * This is the classic-script reimplementation of the waitlist design canvas's
 * React component (see scripts/port-waitlist.mjs for why that component cannot
 * ship). The canvas's submit() validated and then only set a flag, so as drawn
 * the page told someone they were on the list and sent nothing. This posts.
 *
 * WHICH LANE, AND WHY. The design asks for no password, so this uses the
 * passwordless OTP lane rather than /signup: `otpStart` mails a code and
 * `otpVerify` creates the account and opens the session. The account is minted
 * from an email, a code and a first name, so the rest of what the form
 * collects is written straight after with /me/profile, which is the endpoint
 * that owns a member's details.
 *
 * TWO FIELDS ARE COLLECTED AND NOT SENT, deliberately and not silently:
 * the full street address has no column on the user record anywhere in this
 * backend, and "pooling for" has no home either, since /me/product-interest
 * only knows mobile, streaming and tires and this asks about internet. Both
 * are marked below. Wiring them is backend work, not a line in this file.
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

      var name = document.getElementById('wname');
      var email = document.getElementById('wemail');
      var addr = document.getElementById('waddr');
      var postal = document.getElementById('wpostal');
      var terms = document.getElementById('wterms');
      var cohort = document.getElementById('wcohort');

      if (!name.value.trim()) return fail('Add a name so we know who is in the cohort.', name);
      if (!email.value || !email.checkValidity()) return fail('Enter an email we can reach you at.', email);
      if (addr && !addr.value.trim()) return fail('Add the address the offer would be installed at.', addr);
      /* W.parsePostal rather than a fresh regex: it already encodes which
         letters are real, canonicalises the spacing, and derives the province
         the profile write wants, which a bare shape test cannot. */
      var pc = W.parsePostal(postal.value);
      if (!pc || !pc.complete) return fail('Postal code should look like M1B 2K3.', postal);
      if (!terms.checked) return fail('Accept the Terms and Privacy Policy to continue.', terms);
      if (cohort && !cohort.checked) return fail('We need to be able to email you about your cohort and your offer.', cohort);

      /* One field on the form, two on the record: everything after the first
         space is the last name, so "Priya Raman Singh" keeps all of itself. */
      var whole = name.value.trim().replace(/\s+/g, ' ');
      var cut = whole.indexOf(' ');

      pending = {
        email: email.value.trim(),
        firstName: cut < 0 ? whole : whole.slice(0, cut),
        lastName: cut < 0 ? null : whole.slice(cut + 1),
        phone: val('wphone').trim() || null,
        postalCode: pc.full,
        provinceCode: pc.provinceCode,
        fsa: pc.fsa,
        referralCode: val('wref').trim() || null,
        marketing: !!(cohort && cohort.checked),
        /* COLLECTED, NOT SENT. Neither has anywhere to go in the backend yet:
           there is no address column on the user record, and
           /me/product-interest knows mobile, streaming and tires only. Kept
           here so the day a column exists this is a one-line change, and so
           nobody reads the form and assumes they are already stored. */
        unsentAddress: addr ? addr.value.trim() : null,
        unsentPool: radio('pool'),
        unsentLang: radio('lang')
      };

      busy(true, 'Sending your code...');
      W.session.otpStart(pending.email).then(function (r) {
        busy(false, 'Become a founding member');
        setText('[data-wl-echo]', pending.email);
        if (r && r.ttlMinutes) setText('[data-wl-ttl]', String(r.ttlMinutes));
        show('not-joined', false);
        show('code', true);
        var code = document.getElementById('wcode');
        if (code) code.focus();
      }).catch(function (err) {
        busy(false, 'Become a founding member');
        /* The server's messages are written to be shown, so show them. */
        fail(err.message || 'Something went wrong. Please try again.', email);
      });
    });
  }

  /* ---- the code step ---- */

  function codeFail(msg) {
    setText('[data-wl-codeerror]', msg);
    show('code-error', true);
  }

  function finish() {
    setText('[data-wl-donearea]', pending.postalCode);
    var pool = { internet: 'Internet', tires: 'Winter tires', both: 'Internet and winter tires' };
    setText('[data-wl-donepool]', pool[pending.unsentPool] || 'Internet');
    show('code', false);
    show('joined', true);

    /* The member number tile. This backend has no member number, so it shows
       the one identifier a member actually owns: their referral code, which is
       also the thing worth handing to a neighbour. `referral` resolves null
       rather than rejecting when it cannot be read, so the tile says pending
       instead of the panel failing over an ornament. */
    W.session.referral().then(function (r) {
      setText('[data-wl-donenumber]', (r && (r.code || r.referralCode)) || 'pending');
    });
  }

  var verify = document.querySelector('[data-wl-action="verify"]');
  if (verify) {
    verify.addEventListener('click', function () {
      show('code-error', false);
      var code = (val('wcode') || '').trim();
      if (!/^\d{6}$/.test(code)) return codeFail('Enter the 6-digit code from your email.');

      verify.disabled = true;
      verify.textContent = 'Checking...';
      W.session.otpVerify({
        email: pending.email,
        code: code,
        firstName: pending.firstName,
        referralCode: pending.referralCode,
        marketing: pending.marketing
      }).then(function () {
        /* The account exists now but knows only an email and a first name.
           The rest of the form is written here, which is the endpoint that
           owns a member's details. A failure past this point must NOT read as
           a failed signup: they are on the list either way. */
        return W.session.profileSave ? W.session.profileSave({
          lastName: pending.lastName,
          phone: pending.phone,
          postalCode: pending.postalCode,
          provinceCode: pending.provinceCode
        }).catch(function () { return null; }) : null;
      }).then(function () {
        finish();
      }).catch(function (err) {
        verify.disabled = false;
        verify.textContent = 'Verify and continue';
        codeFail(err.message || 'That code did not work. Try again.');
      });
    });
  }

  var resend = document.querySelector('[data-wl-action="resend"]');
  if (resend) {
    resend.addEventListener('click', function () {
      if (!pending) return;
      resend.disabled = true;
      resend.textContent = 'Sending...';
      W.session.otpStart(pending.email).then(function () {
        resend.disabled = false;
        resend.textContent = 'Send a new code';
        show('code-error', false);
      }).catch(function (err) {
        resend.disabled = false;
        resend.textContent = 'Send a new code';
        codeFail(err.message || 'Could not send another code just yet.');
      });
    });
  }

  /* ---- start over from the success panel ---- */

  var reset = document.querySelector('[data-wl-action="reset"]');
  if (reset) {
    reset.addEventListener('click', function () {
      if (form) form.reset();
      pending = null;
      show('joined', false);
      show('code', false);
      show('error', false);
      show('not-joined', true);
    });
  }
})();
