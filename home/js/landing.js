/* Landing page behaviour: the product picker with its vote, the email join
 * form, the hero crowd video, and the scroll-driven word reveal.
 *
 * This is the classic-script reimplementation of the React component that the
 * landing design canvas carried (see scripts/port-landing.mjs for why that
 * component cannot ship: its runtime compiles itself with new Function, which
 * the site CSP forbids). Same states, same copy, same thresholds. The markup
 * hooks are data-lp-* attributes the port script wrote where the canvas had
 * refs and sc-if conditions.
 */
(function () {
  'use strict';

  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  /* ----- where a nav click stops -----
   * The header is sticky and it wraps on narrow screens, so its height is not
   * a constant and a hardcoded scroll-padding-top either hides the top of a
   * section behind the bar or leaves a gap above it. Measure the bar and hand
   * the number to CSS; landing.html's scroll-padding-top reads --wh-head with
   * a 92px fallback for the no-JS case.
   */

  var head = document.querySelector('header');
  if (head) {
    var syncHead = function () {
      var h = Math.round(head.getBoundingClientRect().height) + 14;
      document.documentElement.style.setProperty('--wh-head', h + 'px');
    };
    syncHead();
    window.addEventListener('resize', syncHead);
    if (window.ResizeObserver) new window.ResizeObserver(syncHead).observe(head);
  }

  /* ----- the picker and its vote ----- */

  var sel = [false, false, false, false, false, false, false, false];

  function setWhen(name, on) {
    all('[data-lp-when="' + name + '"]').forEach(function (el) { el.hidden = !on; });
  }

  function paintPicker() {
    all('[data-lp-dot]').forEach(function (el) {
      el.hidden = !sel[Number(el.getAttribute('data-lp-dot'))];
    });
  }

  all('[data-lp-pick]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var i = Number(btn.getAttribute('data-lp-pick'));
      sel[i] = !sel[i];
      /* Changing the picks reopens the vote, exactly as the canvas did. */
      setWhen('not-voted', true);
      setWhen('voted', false);
      paintPicker();
    });
  });

  /* The vote is SAVED, and the page only says so afterwards.
   *
   * It used to flip two hidden attributes and print "Thanks, your vote is in",
   * which was the page telling someone their answer had been recorded when
   * nothing had been sent anywhere. It posts to POST /product-vote on
   * formSubmit now, which writes one ProductVotes row per pick
   * (catalyst-backend/scripts/create-tables.md section 38).
   *
   * The keys travel, not the labels: the wire carries "car-maintenance", so
   * renaming the button to "Car servicing" does not open a second bucket in
   * the table. */
  all('[data-lp-action="vote"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var picks = [];
      all('[data-lp-pick]').forEach(function (el) {
        if (sel[Number(el.getAttribute('data-lp-pick'))]) picks.push(el.getAttribute('data-lp-key'));
      });
      picks = picks.filter(Boolean);
      if (!picks.length) return;

      var W = window.WHOLLAR;
      var err = document.querySelector('[data-lp-voteerr]');
      var msg = document.querySelector('[data-lp-votemsg]');
      var said = btn.textContent;

      function thanks() {
        if (msg) msg.textContent = picks.length === 1 ? 'Thanks, your vote is in.' : 'Thanks, ' + picks.length + ' votes are in.';
        setWhen('not-voted', false);
        setWhen('voted', true);
      }
      function failed() {
        btn.disabled = false;
        btn.textContent = said;
        if (err) err.hidden = false;
      }

      if (!W || !W.submitForm) return failed();
      if (err) err.hidden = true;
      btn.disabled = true;
      btn.textContent = 'Sending your vote...';
      W.submitForm('/product-vote', {
        products: picks,
        sourcePage: window.location.pathname
      }).then(thanks, failed);
    });
  });

  /* ----- the inline email box -----
   * It does not sign anyone up: signup lives on /join, which needs a password
   * and a postal code this box does not ask for. So it carries the address
   * across rather than collecting one here and claiming a confirmation was
   * sent, which is what the canvas did. */

  all('[data-lp-action="join-go"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var el = document.getElementById('wh-email');
      var v = el && el.value ? el.value.trim() : '';
      if (!v || v.indexOf('@') < 1) { if (el) el.focus(); return; }
      window.location.href = '/join?email=' + encodeURIComponent(v);
    });
  });

  /* ----- the crowd video ----- */

  all('[data-lp-crowd]').forEach(function (el) {
    el.loop = true; el.muted = true; el.defaultMuted = true; el.playsInline = true;
    var go = function () { el.play().catch(function () {}); };
    go();
    el.addEventListener('ended', function () { el.currentTime = 0; go(); });
  });

  /* ----- the scroll reveal -----
   * The section is 260vh tall; its first child is a 100vh panel that pins
   * while the section scrolls through, and each word sharpens on its own
   * slice of that travel. Thresholds are the canvas's: 6% lead-in, words
   * spread over the next 80%, each fading across 7.5% of the travel. */

  var root = document.querySelector('[data-lp-reveal]');
  if (root && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    var words = all('[data-lp-reveal] [data-w]');
    var queued = false;

    var paint = function () {
      if (!words.length) return;
      var travel = root.offsetHeight - window.innerHeight;
      if (travel <= 0) return;
      var rectTop = root.getBoundingClientRect().top;
      var panel = root.firstElementChild;
      if (rectTop > 0) {
        panel.style.position = 'absolute'; panel.style.top = '0px';
      } else if (rectTop < -travel) {
        panel.style.position = 'absolute'; panel.style.top = travel + 'px';
      } else {
        panel.style.position = 'fixed'; panel.style.top = '0px';
      }
      var p = Math.max(0, Math.min(1, -rectTop / travel));
      var n = words.length, lead = 0.06, tail = 0.80, dur = 0.075;
      for (var i = 0; i < n; i++) {
        var k = (p - (lead + (i / n) * tail)) / dur;
        k = k < 0 ? 0 : k > 1 ? 1 : k;
        k = k * k * (3 - 2 * k);
        var el = words[i];
        el.style.opacity = (0.32 + 0.68 * k).toFixed(3);
        el.style.filter = k > 0.995 ? 'none' : 'blur(' + ((1 - k) * 2.6).toFixed(2) + 'px)';
      }
    };

    var tick = function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; paint(); });
    };

    window.addEventListener('scroll', tick, { passive: true });
    window.addEventListener('resize', tick);
    paint();
  }
})();
