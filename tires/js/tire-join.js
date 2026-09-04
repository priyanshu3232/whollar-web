/* The winter tire waitlist: two paths, four calculators, one submit.
 *
 * This is the inline <script> from whollar-waitlist-tyre.html, lifted out and
 * made real. The prototype was honest about being one, and three things in it
 * were drawn rather than true (docs/TIRE_VERTICAL_BUILD.md, section 8):
 *
 *   the rank        "You're #1,848 in the GTA cohort" was GTA_BASE + Math.random.
 *                   A claim about how many people joined. It is now whatever
 *                   the server returns, and the honest line when it returns
 *                   nothing, which is the case until TireCohortCounter exists.
 *   the reference   minted in the browser from Math.random, so two people could
 *                   hold the same one and nothing could be looked up by it.
 *                   The server mints it and the page prints what came back.
 *   the submit      finish() showed the confirm screen and posted nothing,
 *                   while the screen said "we just emailed it to you".
 *
 * The four calculators are unchanged. They run entirely on the client, they
 * are the reason someone picks the guided path, and their disclaimers were
 * already written honestly. What is new is that each run is kept and sent, so
 * TireToolRuns records what we told someone, on a date, about money.
 */
(function () {
  'use strict';

  var W = window.WHOLLAR || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var F = {
    path: null,
    stage: 1,
    strategy: '',      /* '' until the strategy tool has actually run */
    fields: {},
    tools: [],
    reference: null,
    email: null,
    addingCar: false
  };

  function show(id) {
    $$('.screen').forEach(function (s) { s.classList.toggle('on', s.id === id); });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- path choice, and the deep links the landing page uses ---------- */

  $$('.pathcard').forEach(function (b) {
    b.addEventListener('click', function () {
      F.path = b.dataset.go;
      if (F.path === 'quick') show('s-quick'); else { gStage(1); show('s-guided'); }
    });
  });
  $$('[data-back]').forEach(function (b) {
    b.addEventListener('click', function () { show('s-' + b.dataset.back); });
  });

  /* tires/index.html links straight at a path, and at a named tool, so a
     reader who came to answer one question ("do I need two sets of rims?")
     lands on it rather than on the choice of paths again. The tool links open
     the guided path, because the guided path is where the tools live. */
  (function deepLink() {
    var q = new URLSearchParams(window.location.search);
    var tool = q.get('tool');
    var path = q.get('path');
    if (tool && ['strategy', 'size', 'rims', 'insurance'].indexOf(tool) < 0) tool = null;
    if (!path && !tool) return;
    if (path === 'quick' && !tool) { F.path = 'quick'; show('s-quick'); return; }
    if (path !== 'guided' && !tool) return;
    F.path = 'guided';
    /* Every tool sits on stage 2 or 3, and stage 1 is the step that actually
       holds the spot, so a tool link opens stage 2 and the panel with it. The
       reader can walk back to stage 1 with the Back button; they cannot
       submit without it, because g1form validates on the way forward.

       A bare ?path=guided is not a tool link. It is Build my profile on the
       landing page, which is the start of the sign-up, so it opens stage 1
       exactly as the pathcard on this page does. Sending it to stage 2 would
       open the guided path on the step after the one that holds the spot. */
    gStage(!tool ? 1 : tool === 'insurance' ? 3 : 2);
    show('s-guided');
    if (!tool) return;
    var panel = $('#h-' + (tool === 'insurance' ? 'ins' : tool === 'rims' ? 'rimcalc' : tool));
    if (panel) {
      panel.hidden = false;
      window.setTimeout(function () { panel.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 260);
    }
  })();

  /* ---------- vehicle selects ---------- */

  function fillVeh(ySel, mSel) {
    for (var y = 2026; y >= 2008; y--) {
      var o = document.createElement('option');
      o.value = y; o.textContent = y; ySel.appendChild(o);
    }
    ['Toyota', 'Honda', 'Ford', 'Chevrolet', 'Hyundai', 'Kia', 'Nissan', 'Mazda', 'Volkswagen',
     'Subaru', 'BMW', 'Mercedes-Benz', 'Audi', 'Jeep', 'Ram', 'GMC', 'Dodge', 'Tesla', 'Lexus',
     'Acura', 'Volvo', 'Mitsubishi', 'Chrysler', 'Buick', 'Cadillac', 'Land Rover', 'Porsche',
     'Other'].forEach(function (m) {
      var o = document.createElement('option');
      o.value = m; o.textContent = m; mSel.appendChild(o);
    });
  }
  $$('.qyear').forEach(function (y) { fillVeh(y, $('.qmake')); });
  $$('.gyear').forEach(function (y) { fillVeh(y, $('.gmake')); });

  /* ---------- segmented toggles ---------- */

  $$('[data-seg]').forEach(function (seg) {
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
      var scope = seg.closest('.field');
      scope.querySelectorAll('[data-pane]').forEach(function (p) { p.hidden = p.dataset.pane !== b.dataset.mode; });
    });
  });
  function segMode(name) {
    var on = $('[data-seg="' + name + '"] button.on');
    return on ? on.dataset.mode : 'unsure';
  }

  /* ---------- chips ----------
     `chipSet`, not `group`: CLAUDE.md's vocabulary rule covers variable names,
     and this codebase's word for a set of households is cohort. */

  $$('[data-chips]').forEach(function (chipSet) {
    var multi = chipSet.dataset.multi === '1';
    chipSet.addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      if (multi) { b.classList.toggle('on'); }
      else { chipSet.querySelectorAll('.chip').forEach(function (x) { x.classList.toggle('on', x === b); }); }
      F.fields[chipSet.dataset.chips] = $$('.chip.on', chipSet).map(function (x) { return x.dataset.v; });
    });
  });
  function chosen(name) { return F.fields[name] || []; }
  function one(name) { return chosen(name)[0] || ''; }

  /* ---------- helper panels ---------- */

  $$('[data-helper]').forEach(function (b) {
    b.addEventListener('click', function () {
      var el = $('#h-' + b.dataset.helper);
      if (el) {
        el.hidden = !el.hidden;
        if (!el.hidden) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  });

  /* ---------- calculators ---------- */

  function money(n) { return '$' + Math.round(n).toLocaleString(); }

  /* One row per run, last run per tool wins. What we said, and what they told
     us to say it from, both kept: the answers are about money. */
  function recordTool(tool, input, output) {
    F.tools = F.tools.filter(function (t) { return t.tool !== tool; });
    F.tools.push({ tool: tool, input: input, output: output, ranAt: new Date().toISOString() });
  }

  /* Helper A: insurance */
  $('#ins-run').addEventListener('click', function () {
    var prem = parseFloat($('#ins-prem').value) || 0, co = $('#ins-co').value;
    if (!prem) { $('#ins-prem').focus(); return; }
    var lo = 0.02, hi = 0.05, note = 'Range shown because insurers differ.';
    if (co === 'caa') { lo = 0.05; hi = 0.05; note = 'CAA states all four snowflake-marked tires qualify for their 5% discount.'; }
    var yrs = 6, set = 900;
    var aLo = prem * lo, aHi = prem * hi, lLo = aLo * yrs, lHi = aHi * yrs;
    var offLo = Math.round(lLo / set * 100), offHi = Math.round(lHi / set * 100);
    var out = $('#ins-out');
    out.innerHTML = '<div class="big">' + money(aLo) + (aHi > aLo ? ' to ' + money(aHi) : '') + ' / year</div>'
      + 'About ' + money(lLo) + (lHi > lLo ? ' to ' + money(lHi) : '') + ' over the 6-year life of a set. '
      + 'That offsets roughly ' + offLo + (offHi > offLo ? ' to ' + offHi : '') + '% of a typical set.'
      + '<div class="caveat">' + note + ' Estimate only. Qualifying needs four 3PMSF winter tires, usually on by Nov 1, and you must tell your insurer. Some insurers do not grant the discount for all-weather tires, so confirm with yours.</div>';
    out.hidden = false;
    recordTool('insurance', { premium: prem, insurer: co || null },
      { annualLow: Math.round(aLo), annualHigh: Math.round(aHi), lifetimeLow: Math.round(lLo), lifetimeHigh: Math.round(lHi) });
  });

  /* Helper B: size options */
  function parseSize(s) {
    var m = (s || '').replace(/\s/g, '').match(/(\d{3})\/(\d{2})R?(\d{2})/i);
    if (!m) return null;
    return { w: +m[1], a: +m[2], r: +m[3] };
  }
  function od(w, a, r) { return r * 25.4 + 2 * (w * a / 100); }
  function bestAspect(targetOD, w, r) { return Math.round(((targetOD - r * 25.4) / 2 / w * 100) / 5) * 5; }
  $('#sz-run').addEventListener('click', function () {
    var typed = $('#sz-in').value;
    var p = parseSize(typed);
    var out = $('#sz-out');
    if (!p) {
      out.innerHTML = '<b>Hmm, that does not look like a tire size.</b><div class="caveat">Try the format 225/45R17.</div>';
      out.hidden = false;
      return;
    }
    var base = od(p.w, p.a, p.r);
    var options = [];
    function row(w, r, tag, dir) {
      var a = bestAspect(base, w, r); if (a < 25) a = 25; if (a > 80) a = 80;
      var newOD = od(w, a, r); var delta = (newOD / base - 1) * 100;
      var actual = (100 * newOD / base);
      var within = Math.abs(delta) <= 3;
      options.push({ size: w + '/' + a + 'R' + r, tag: tag, deltaPct: +delta.toFixed(1), within: within });
      return '<button type="button" class="alt' + (tag === 'OE' ? ' on' : '') + '"><span><span class="sz">' + w + '/' + a + 'R' + r + '</span>' + (tag ? ' <span class="tag">' + tag + '</span>' : '') + '</span>'
        + '<span class="meta">' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + '% diameter · at 100 shown, really ~' + actual.toFixed(0) + ' km/h'
        + '<br>' + dir + (within ? '' : ' · outside ±3%') + '</span></button>';
    }
    out.innerHTML = '<div style="font-weight:750;margin-bottom:8px">Options that keep your speedometer close:</div><div class="altsizes">'
      + row(p.w, p.r, 'Your size (OE)', 'same price baseline')
      + row(p.w - 10, p.r - 1, 'Winter downsize', 'usually cheaper, better in snow')
      + row(p.w + 10, p.r + 1, 'Upsize', 'usually pricier, not ideal for winter')
      + '</div><div class="caveat">Winter downsizing uses a smaller wheel and a narrower, taller tire: it bites through snow better and usually costs less. Keep load rating at or above your original. Final fitment is confirmed against your exact car and by your installer.</div>';
    out.hidden = false;
    /* The size they typed here is the best answer the page has to what the
       car actually runs, so it seeds the vehicle field if that is still
       empty. A cohort is sized on tire size, not on households. */
    var gsize = $('[data-f="g.size"]');
    if (gsize && !gsize.value.trim()) gsize.value = typed.trim();
    recordTool('size', { current: typed.trim() }, { options: options });
  });

  /* Helper C: rims */
  $('#rc-run').addEventListener('click', function () {
    var tpms = (one('rc-tpms') || 'na'), years = +(one('rc-years') || 6), diy = (one('rc-diy') === 'diy');
    var rims = 360, sensors = (tpms === 'yes' ? 280 : (tpms === 'na' ? 280 : 0));
    var upfront = rims + sensors;
    var annualA = 160, annualB = diy ? 0 : 80;
    var save = annualA - annualB, be = save > 0 ? upfront / save : 99, net6 = annualA * 6 - (upfront + annualB * 6);
    var twoWins = diy || years >= Math.ceil(be);
    var out = $('#rc-out');
    out.innerHTML = '<div class="big">' + money(upfront) + ' upfront</div>'
      + 'for a second set of steel rims' + (sensors ? ' plus TPMS sensors' : '') + '. It saves about ' + money(save) + ' a year in changeover fees' + (diy ? ' (you swap them yourself)' : '') + '.'
      + '<br>Break-even in about ' + (save > 0 ? be.toFixed(1) + ' years' : 'n/a') + '. Over 6 years you would ' + (net6 >= 0 ? 'save ' + money(net6) : 'spend ' + money(-net6) + ' more') + ' with two sets.'
      + '<div class="rec">' + (twoWins ? 'Suggestion: two sets. Faster swaps, less tire wear, and it pays off over the time you will keep them.' : 'Suggestion: one set is fine for your situation. Keep it simple and swap seasonally.') + '</div>'
      + '<div class="caveat">GTA ballpark costs, refined by your cohort’s real quotes. A second set on a TPMS car needs its own sensors, which is the main upfront cost.</div>';
    out.hidden = false;
    recordTool('rims', { tpms: tpms, years: years, whoSwaps: diy ? 'diy' : 'shop' },
      { upfront: upfront, annualSaving: save, breakEvenYears: +be.toFixed(1), suggestion: twoWins ? 'two-sets' : 'one-set' });
  });

  /* Helper D: strategy */
  $('#sd-run').addEventListener('click', function () {
    var life = one('sd-life'), own = +(one('sd-own') || 6), drive = one('sd-drive'), store = one('sd-store');
    var score = 0; /* + toward all-weather */
    if (life === 'end') score += 2; if (life === 'mid') score += 1;
    if (own <= 4) score += 2; else if (own <= 5) score += 1; else score -= 1;
    if (drive === 'city') score += 2; else if (drive === 'heavy') score -= 2;
    if (store === 'no') score += 1;
    var allw = score >= 3;
    F.strategy = allw ? 'allweather' : 'winter';
    applyStrategy();
    var out = $('#sd-out');
    if (allw) {
      out.innerHTML = '<div class="big">All-weather looks smart for you</div>'
        + 'One year-round set, no second rims, no seasonal swaps, no storage. It costs a bit more per set and will not match a dedicated winter tire in deep snow, but for your driving and how long you will keep the car, it is the simpler, often cheaper path.'
        + '<div class="caveat">Insurance: all-weather tires carry the snowflake, but only some insurers grant the discount for them, many require a dedicated set. Confirm with your insurer before relying on it.</div>';
    } else {
      out.innerHTML = '<div class="big">Dedicated winter tires look right</div>'
        + 'Best grip when it counts, and over the time you will keep the car the second set of rims and the longer life of tires that only run half the year pay off. The insurance discount is reliably available.'
        + '<div class="caveat">You can still switch to all-weather anytime, this is only a suggestion.</div>';
    }
    out.hidden = false;
    recordTool('strategy', { tireLife: life || null, ownYears: own, driving: drive || null, storage: store || null },
      { strategy: F.strategy, score: score });
  });

  function applyStrategy() {
    var allw = F.strategy === 'allweather';
    $$('.wblock').forEach(function (el) { el.hidden = allw; });
    var banner = $('#strategy-banner');
    banner.hidden = false;
    banner.className = 'reco-banner ' + (allw ? 'allw' : 'winter');
    banner.innerHTML = allw
      ? '<b>Going with all-weather.</b> We have hidden the rims, swap, and storage questions since a single set does not need them.'
      : '<b>Going with dedicated winters.</b> The rims and storage questions below apply to you.';
  }

  /* ---------- install dates ---------- */

  var DATES = ['Sat Oct 4', 'Wed Oct 8', 'Sat Oct 18', 'Tue Oct 21', 'Sat Nov 1', 'Thu Nov 6', 'Sat Nov 15', 'Wed Nov 19'];
  var dp = $('#datepick');
  DATES.forEach(function (d) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'datechip'; b.textContent = d;
    b.addEventListener('click', function () { b.classList.toggle('on'); });
    dp.appendChild(b);
  });

  /* ---------- the guided stage machine ---------- */

  function gStage(n) {
    F.stage = n;
    $$('.gstage').forEach(function (s) { s.hidden = +s.dataset.stage !== n; });
    $$('.prog .seg').forEach(function (s) { s.classList.toggle('on', +s.dataset.s <= n); });
    $('#proglbl').textContent = 'Step ' + n + ' of 3';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $$('[data-stage-back]').forEach(function (b) {
    b.addEventListener('click', function () { gStage(+b.dataset.stageBack); });
  });

  /* ---------- validation, in the page, in the page's own words ----------
     Mirrors what POST /tire-waitlist-join enforces. A 400 that reaches the
     reader as raw server wording is a bug in this function, not on the
     server: the two lists are meant to agree. */

  function mark(el, bad) {
    el.style.borderColor = bad ? '#B0512B' : '';
  }
  function validate(form, errEl) {
    var problems = [];
    var focus = null;
    function fail(el, msg) { problems.push(msg); mark(el, true); if (!focus) focus = el; }

    $$('[required]', form).forEach(function (el) { mark(el, false); });

    var fn = form.querySelector('[name=fn]'), ln = form.querySelector('[name=ln]');
    var em = form.querySelector('[name=email]'), pc = form.querySelector('[name=postal]');
    var mob = form.querySelector('[name=mobile]'), city = form.querySelector('[name=city]');
    var consent = form.querySelector('[name=consent]');

    if (fn.value.trim().length < 2) fail(fn, 'a first name');
    if (ln.value.trim().length < 2) fail(ln, 'a last name');
    if (!W.isEmail(em.value.trim())) fail(em, 'an email address we can reach you at');
    if (!W.parsePostal(pc.value)) fail(pc, 'a Canadian postal code');
    if (!city.value) fail(city, 'your city');
    /* Mobile is optional on this form by design, and the route matches that.
       Validated only when something was typed, so a half-typed number is
       caught here rather than saved as digits nobody can call. */
    if (mob.value.trim() && String(mob.value).replace(/\D/g, '').replace(/^1/, '').length !== 10) {
      fail(mob, 'a 10-digit mobile number, or nothing at all');
    }
    if (!consent.checked) { mark(consent, true); problems.push('your agreement to be emailed about your cohort'); if (!focus) focus = consent; }

    if (!problems.length) { errEl.hidden = true; return true; }
    errEl.textContent = 'We still need ' + (problems.length > 1
      ? problems.slice(0, -1).join(', ') + ' and ' + problems[problems.length - 1]
      : problems[0]) + '.';
    errEl.hidden = false;
    if (focus) focus.focus();
    return false;
  }

  /* ---------- what goes on the wire ---------- */

  function val(sel) { var el = $(sel); return el ? String(el.value || '').trim() : ''; }

  function consentRecord(box, kind) {
    /* CASL wants what was agreed to, not that something was. The sentence is
       read off the label the reader actually ticked, so a copy edit to that
       label cannot silently change what the stored consent says. */
    if (!box) return null;
    var label = box.closest('label');
    return {
      granted: !!box.checked,
      kind: kind,
      text: label ? label.textContent.replace(/\s+/g, ' ').trim() : '',
      at: new Date().toISOString(),
      source: window.location.pathname
    };
  }

  function vehicleFrom(prefix) {
    var mode = segMode(prefix === 'q' ? 'qveh' : 'gveh');
    return {
      inputMode: mode,
      year: val('[data-f="' + prefix + '.year"]'),
      make: val('[data-f="' + prefix + '.make"]'),
      model: val('[data-f="' + prefix + '.model"]'),
      vin: prefix === 'g' ? val('[data-f="g.vin"]') : '',
      size: val('[data-f="' + prefix + '.size"]'),
      strategy: F.strategy,
      runsWinterNow: prefix === 'g' ? one('run') : '',
      ownsRims: prefix === 'g' ? one('rims') : ''
    };
  }

  function installWindows() {
    if ($('#dates-any') && $('#dates-any').checked) return ['any'];
    return $$('#datepick .datechip.on').map(function (b) { return b.textContent; });
  }

  function quickPayload(form) {
    var postal = W.parsePostal(form.querySelector('[name=postal]').value);
    return {
      path: 'quick',
      source: 'tires-site',
      firstName: form.querySelector('[name=fn]').value.trim(),
      lastName: form.querySelector('[name=ln]').value.trim(),
      email: form.querySelector('[name=email]').value.trim(),
      phone: form.querySelector('[name=mobile]').value.trim(),
      fsa: postal.fsa,
      postalFull: postal.full,
      city: form.querySelector('[name=city]').value,
      language: 'en',
      consent: consentRecord(form.querySelector('[name=consent]'), 'tire-waitlist'),
      consentShare: !!form.querySelector('[name=share]').checked,
      consentSms: false,
      alsoInternet: false,
      vehicles: [vehicleFrom('q')],
      details: {
        needs: chosen('qneed'),
        tier: one('qtier'),
        installerType: one('qinst'),
        mustBeOnBy: form.querySelector('[name=by]').value || ''
      },
      tools: F.tools
    };
  }

  function guidedPayload(form) {
    var postal = W.parsePostal(form.querySelector('[name=postal]').value);
    return {
      path: 'guided',
      source: 'tires-site',
      firstName: form.querySelector('[name=fn]').value.trim(),
      lastName: form.querySelector('[name=ln]').value.trim(),
      email: form.querySelector('[name=email]').value.trim(),
      phone: form.querySelector('[name=mobile]').value.trim(),
      fsa: postal.fsa,
      postalFull: postal.full,
      city: form.querySelector('[name=city]').value,
      language: one('lang') || 'en',
      consent: consentRecord(form.querySelector('[name=consent]'), 'tire-waitlist'),
      consentSms: !!form.querySelector('[name=sms]').checked,
      consentShare: !!($('#g-share') && $('#g-share').checked),
      alsoInternet: !!($('#g-internet') && $('#g-internet').checked),
      vehicles: [vehicleFrom('g')],
      details: {
        needs: chosen('need'),
        tier: one('tier'),
        brand: one('brand'),
        budget: one('budget'),
        financing: one('finance'),
        installerType: one('inst'),
        anchor: one('anchor'),
        splitPreference: one('split'),
        installWindows: installWindows(),
        notBefore: val('[data-f="g.notBefore"]'),
        mustBeOnBy: val('[data-f="g.mustBy"]'),
        memberships: chosen('mem'),
        priorities: chosen('prio'),
        readiness: one('ready'),
        notes: val('[data-f="g.notes"]')
      },
      tools: F.tools
    };
  }

  /* ---------- the submit ---------- */

  function post(payload, btn, errEl) {
    if (W.busy(btn, true, 'Saving…') === false) return;
    errEl.hidden = true;
    W.submitForm('/tire-waitlist-join', payload).then(function (res) {
      F.reference = res.reference || null;
      F.email = payload.email;
      finish(res);
    }).catch(function (err) {
      W.busy(btn, false);
      errEl.textContent = W.submitErrorMessage(err);
      errEl.hidden = false;
      errEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function finish(res) {
    /* Both submit buttons come back out of their busy state: the confirm
       screen can be left again (Add another car), and a button left disabled
       behind it is a dead end on the way back. */
    W.busy($('#qsubmit'), false);
    W.busy($('#g3submit'), false);
    if (res.reference) $('#c-ref').textContent = res.reference;
    else if (!F.reference) $('#c-ref').textContent = '…';
    /* The rank is printed only when the server sent a number. Until
       TireCohortCounter exists it sends none, and the pill keeps the line the
       confirm screen was already drawn with. A number nobody counted is worse
       than no number. */
    if (typeof res.rank === 'number' && res.rank > 0) {
      $('#c-rank').innerHTML = 'You are <span>#' + res.rank.toLocaleString() + '</span> in the '
        + (res.cohort || 'GTA') + ' cohort';
    }
    show('s-confirm');
  }

  /* One handler, two jobs. A second listener could not do the second job:
     both would be at-target on the same form, so they fire in registration
     order and stopImmediatePropagation from the later one arrives after the
     earlier one has already validated identity fields that are hidden. */
  $('#quickform').addEventListener('submit', function (e) {
    e.preventDefault();
    if (F.addingCar) {
      post({
        mode: 'vehicle',
        source: 'tires-site',
        reference: F.reference,
        email: F.email,
        vehicles: [vehicleFrom('q')]
      }, $('#qsubmit'), $('#q-err'));
      return;
    }
    if (!validate(this, $('#q-err'))) return;
    post(quickPayload(this), $('#qsubmit'), $('#q-err'));
  });

  /* Stage 1 holds the spot, so it is where the identity rules are enforced;
     stage 3 submits what stage 1 already validated. */
  var g1 = $('#g1form');
  g1.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validate(this, ensureG1Err())) return;
    gStage(2);
  });
  function ensureG1Err() {
    var el = $('#g1-err');
    if (el) return el;
    el = document.createElement('p');
    el.className = 'formerr';
    el.id = 'g1-err';
    el.setAttribute('role', 'alert');
    el.hidden = true;
    g1.querySelector('.nav').insertAdjacentElement('beforebegin', el);
    return el;
  }
  $('#g2next').addEventListener('click', function () { gStage(3); });
  $('#g3submit').addEventListener('click', function () {
    /* Walk back to stage 1 if anything there was undone since, rather than
       posting a payload the server will refuse. */
    if (!validate(g1, ensureG1Err())) { gStage(1); return; }
    post(guidedPayload(g1), $('#g3submit'), $('#g-err'));
  });

  /* ---------- a second car on the same signup ----------
     The confirm screen offers it, and TireWaitlistVehicles is keyed
     <reference>:<n> so that adding one is idempotent and does not create a
     second household. The identity is not asked again: the reference and the
     email that just came back are what the row is attached to. */

  $('#addcar').addEventListener('click', function (e) {
    e.preventDefault();
    if (!F.reference) { show('s-intro'); return; }
    F.addingCar = true;
    F.path = 'quick';
    /* Reuse the quick screen's vehicle card and nothing else. */
    $('#s-quick').querySelectorAll('.fcard').forEach(function (card, i) { card.hidden = i !== 1; });
    $('#qsubmit').textContent = 'Add this car';
    show('s-quick');
  });

})();
