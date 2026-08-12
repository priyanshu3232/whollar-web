/* Whollar partner console.
 *
 * Classic script, no ESM (see js/whollar-console-contract.js for why).
 * Loaded deferred by provider-console.html; the page's boot guard calls
 * WHOLLAR.console.boot(partner) on DOMContentLoaded, and only if the guard
 * passed. Nothing here runs on load beyond defining things.
 *
 * SCOPE, this commit: the shell. Navigation, the chrome, and the account view
 * on real data. The other nine views render an honest empty state rather than
 * the prototype's demo data, because a console that invents a bid desk is
 * worse than one that admits it has not built it yet.
 *
 * ------------------------------------------------------------------
 * HELPERS: what came from the prototype and what now comes from core.
 *
 * The prototype was written standalone and never loaded whollar-core.js, so it
 * declares its own money(), esc(), toast() and date formatters. Two of those
 * have core equivalents that behave DIFFERENTLY, so the swap is a real change
 * and is made deliberately here rather than by accident later:
 *
 *   esc()   ->  W.escapeHtml.  The prototype escaped & < > " ; core also
 *               escapes the single quote. Strictly safer, and this file
 *               interpolates into single-quoted attributes, so it matters.
 *
 *   money() ->  W.money.  The prototype rendered $95.5 for a half dollar;
 *               core renders $95.50, and still renders $95 for a whole one.
 *               Money on this surface is invoiced, so cents are not optional.
 *
 *   toast(), and the modal host, have NO core equivalent and stay local. They
 *   are not promoted into core: core loads on all 40 footer-registered pages
 *   including the marketing site, and the bar for adding weight there is a
 *   second calling page.
 * ------------------------------------------------------------------ */
(function (root) {
  "use strict";

  var W = root.WHOLLAR;
  if (!W) return;
  W.console = W.console || {};
  if (W.console.boot) return;

  var C = W.console.C;

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var mobile = function () { return root.innerWidth <= 940; };
  var esc = W.escapeHtml;

  /* Live partner context, filled by boot() and refreshed by revalidate(). */
  var P = { partner: null, org: null, user: null, approved: false, prefs: null };

  /* ================================================================== *
   * chrome: toast, modal
   * ================================================================== */

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  var lastFocus = null;
  function openModal(html) {
    var m = $('#modal');
    if (!m) return;
    lastFocus = document.activeElement;
    $('#mbody').innerHTML = html;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
    /* Move focus in, or a keyboard user is left behind the overlay. */
    var first = m.querySelector('button, [href], input, select, textarea');
    if (first) first.focus();
  }
  function closeModal() {
    var m = $('#modal');
    if (!m || m.hidden) return;
    m.hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  /* ================================================================== *
   * navigation
   * ================================================================== */

  var VIEWS = ['overview', 'desk', 'plan', 'bids', 'billing', 'coverage',
    'delivery', 'perf', 'contracts', 'pending', 'account'];

  function nav(v) {
    if (VIEWS.indexOf(v) < 0) return;
    $$('.view').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-v') === v); });
    $$('#pnav button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-view') === v); });
    var prof = $('#paneprof');
    if (prof) prof.classList.toggle('on', v === 'account');
    if (mobile()) $('#app').classList.remove('paneopen');
    root.scrollTo(0, 0);
    /* Deep-linkable, and the back button works. replaceState on the first
       paint would otherwise leave a bare /provider-console in history. */
    try { history.replaceState({ v: v }, '', '#' + v); } catch (e) { /* file:// */ }
  }

  function viewFromHash() {
    var h = String(location.hash || '').replace(/^#/, '');
    return VIEWS.indexOf(h) >= 0 ? h : 'overview';
  }

  function wireNav() {
    var app = $('#app');

    $('#pnav').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.classList.contains('soon')) return;
      nav(b.getAttribute('data-view'));
    });

    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-nav]');
      if (t) { nav(t.getAttribute('data-nav')); return; }
      if (e.target.closest('[data-mclose]')) closeModal();
    });

    $('#modal').addEventListener('click', function (e) {
      if (e.target === this) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });

    $('#burger').addEventListener('click', function () {
      if (mobile()) app.classList.toggle('paneopen');
      else app.classList.toggle('collapsed');
      this.setAttribute('aria-expanded', app.classList.contains('collapsed') ? 'false' : 'true');
    });
    $('#overlay').addEventListener('click', function () { app.classList.remove('paneopen'); });

    root.addEventListener('hashchange', function () { nav(viewFromHash()); });
  }

  /* ================================================================== *
   * header and pane, from the real partner record
   * ================================================================== */

  function greeting() {
    var h = new Date().getHours();
    return h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
  }

  function paintChrome() {
    var first = String((P.user && P.user.firstName) || P.partner.firstName || '').trim();
    var org = String((P.org && P.org.name) || P.partner.org || '').trim();
    var role = String((P.org && P.org.role) || P.partner.role || '').trim();

    $('#greetline').textContent = greeting() + (first ? ', ' + first : '');
    /* No org yet is a real state (the record is written from the session, which
       does not carry org context). Say nothing rather than guess a name from
       the email domain the way the v3 console does. */
    $('#greetsub').textContent = org;

    $('#paneorg').textContent = org || 'Your company';
    $('#panerole').textContent = P.approved ? (role ? titleRole(role) : 'Partner') : 'Under review';

    var mono = W.monogram ? W.monogram(org || first || '?') : '';
    $('#paneava').textContent = mono;
    $('#topava').textContent = W.monogram ? W.monogram([first, P.user && P.user.lastName].filter(Boolean).join(' ') || org || '?') : '';
  }

  function titleRole(r) {
    if (r === 'admin') return 'Account admin';
    if (r === 'bidder') return 'Bid authority';
    if (r === 'viewer') return 'Viewer';
    return W.titleCase ? W.titleCase(r) : r;
  }

  /* The approval banner. An org is pending until a human approves it, and the
     partner keeps a full session throughout, so this is the only thing telling
     them why the desk is quiet. Rendered into the same host renderBanner() will
     later use for the billing-failure banner. */
  function paintBanner() {
    var host = $('#mainbanner');
    if (!host) return;
    if (P.approved) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="alertbar" style="margin:0 clamp(16px,3vw,30px);margin-top:14px">'
      + '<b>Your application is with our team.</b> You can look around, and set up your account, '
      + 'but cohorts and bidding open when you are approved. Nothing is owed at any point. '
      + '<button class="tlink" type="button" data-nav="pending" style="color:#fff;text-decoration:underline">See where it stands</button>'
      + '</div>';
  }

  /* ================================================================== *
   * views
   * ================================================================== */

  /* An empty state that does not pretend. Each names what will fill it and
     what has to happen first, because "no data" and "not built" look identical
     to a partner and only one of them is worth waiting for. */
  function soon(title, body, cta) {
    return '<section class="card"><div class="empty">'
      + '<h3>' + esc(title) + '</h3>'
      + '<p>' + body + '</p>'
      + (cta || '')
      + '</div></section>';
  }

  function renderPlaceholders() {
    var gated = !P.approved;

    $('#desk-body').innerHTML = soon(
      gated ? 'Cohorts open when your application clears' : 'No cohorts open in your coverage yet',
      gated
        ? 'Auctions reach this desk from inside your declared coverage, once your application is approved. Declaring coverage now is what queues you for the first one.'
        : 'An auction appears here the moment a cohort forms inside a region you have declared. You will get an email as well; nothing needs watching.',
      '<button class="btn" type="button" data-nav="coverage">Declare your coverage</button>');

    $('#bids-body').innerHTML = soon(
      'Your first bid lands here',
      'Every bid you place sits on this record with everything it turned into: result, confirmed households, completed switches, fees.');

    $('#billing-body').innerHTML = soon(
      'No statements yet, by design',
      'Bids are free. Winning is free. Confirmed households are free. The first line is the first activation with a clean line test.');

    $('#cov-body').innerHTML = soon(
      'Coverage is the next thing to build here',
      'Declaring a region and the services you can render there is what makes cohorts visible to you. This view is being wired to the live coverage record now.');

    $('#del-body').innerHTML = soon(
      'Your first delivery board builds itself',
      'Win a cohort and every confirmed household lands here with an install slot and a state that becomes a statement line only when the line tests clean.');

    $('#perf-body').innerHTML = soon(
      'Four numbers, none of them written yet',
      'Win rate, completion, serviceability, and delivered as bid. All four are recorded from what you deliver, and future briefs carry them beside your bid. The record starts at your first sealed number.');

    $('#con-body').innerHTML = soon(
      'Agreements appear here as they are signed',
      'Everything binding lives here, versioned: the partner agreement, the standard cohort terms, your regional schedule, and every sealed bid receipt.');

    $('#pend-body').innerHTML = soon(
      P.approved ? 'Your application is approved' : 'Your application is with our team',
      P.approved
        ? 'Nothing outstanding. Your regional schedule and agreements live in Contracts.'
        : 'The full application view, with each of the five checks and its own clock, is being wired to the live application record. In the meantime, questions go to partners@whollar.ca.');

    $('#ov-body').innerHTML = '<div class="grid2"><div>'
      + soon(
        gated ? 'Welcome. Here is what happens next.' : 'Nothing needs you right now',
        gated
          ? 'Your account is live and your application is with our team. Setting up your account details now means nothing is in the way when a cohort opens in your coverage.'
          : 'No cohort in your coverage is open for bids. When one opens you will see it here and on the bid desk, and you will get an email.',
        '<button class="btn" type="button" data-nav="account">Open your account</button>')
      + '</div><aside class="aside">'
      + '<section class="card" aria-label="How auctions work">'
      + '<span class="eyebrow">How auctions work</span><h3>Three rules, no surprises</h3><div class="how">'
      + '<div class="h"><i>1</i><span><b>Sealed.</b> One best number by the deadline.</span></div>'
      + '<div class="h"><i>2</i><span><b>Binding until the deadline.</b> Improve any time before close; no withdrawals after sealing.</span></div>'
      + '<div class="h"><i>3</i><span><b>Pay on completion.</b> Confirmed households set your volume tiers; the invoice is live connections only.</span></div>'
      + '</div></section></aside></div>';

    $('#plan-body').innerHTML = soon(
      'Pick a cohort to see its plan',
      'Every cohort has one timeline: announced, open, closed, offers out, decision, switching window, reconciliation. Open one from the bid desk.');
  }

  /* ---------- account: the one view on real data this commit ---------- */

  var NOTIFY = [
    ['forming', 'New cohort forming in my coverage'],
    ['opens', 'Bidding opens'],
    ['closing', 'Closing in 24 hours and I have not bid'],
    ['results', 'Results, win or lose']
  ];

  function renderAccount() {
    var org = P.org || {};
    var user = P.user || {};
    var notify = (P.prefs && P.prefs.notify) || {};
    var sub = $('#acct-sub');
    if (sub) sub.textContent = [org.name, P.approved ? 'Founding partner' : 'Application under review']
      .filter(Boolean).join(' · ');

    $('#acct-body').innerHTML = '<div class="grid2">'
      + '<section class="card" aria-label="Organisation">'
      + '<span class="eyebrow">Organisation</span><h3>Who we have on file</h3>'
      + '<ul class="pi">'
      + row('Company', org.name)
      + row('Approval', P.approved ? 'Approved' : 'Under review')
      + row('Signed in as', [user.firstName, user.lastName].filter(Boolean).join(' '))
      + row('Email', user.email)
      + row('Your role', org.role ? titleRole(org.role) : null)
      + '</ul>'
      /* Editing is not wired yet, and a field that silently does nothing is
         worse than one that is honestly read-only. */
      + '<p class="fnote">To change any of this, email partners@whollar.ca and we will update it. '
      + 'Editing from this page is coming with the application view.</p>'
      + '<button class="tlink" type="button" id="signout" style="margin-top:12px">Sign out</button>'
      + '</section>'
      + '<aside class="aside">'
      + '<section class="card" aria-label="Auction alerts">'
      + '<span class="eyebrow">Auction alerts</span><h3>When cohorts move</h3>'
      + NOTIFY.map(function (n) {
        return '<label class="tog"><input type="checkbox" data-notify="' + n[0] + '"'
          + (notify[n[0]] === false ? '' : ' checked') + '><i></i><span>' + esc(n[1]) + '</span></label>';
      }).join('')
      + '<p class="fnote">Saved to your account, not to this browser.</p>'
      + '</section>'
      + '<section class="card" aria-label="Your Whollar contact">'
      + '<span class="eyebrow">Your Whollar contact</span><h3>Talk to someone who can act</h3>'
      + '<p class="cardnote">Auction briefs, coverage verification, invoice questions: your message lands with the team running your cohorts. Weekdays, usually within the hour.</p>'
      + '<a class="tlink" href="mailto:partners@whollar.ca">Email partners@whollar.ca &rarr;</a>'
      + '</section></aside></div>';
  }

  function row(label, value) {
    return '<li><span>' + esc(label) + '</span><b>' + (value ? esc(value) : '<span style="color:var(--sub)">Not on file</span>') + '</b></li>';
  }

  function wireAccount() {
    document.addEventListener('change', function (e) {
      var box = e.target.closest('[data-notify]');
      if (!box) return;
      var key = box.getAttribute('data-notify');
      var next = {};
      NOTIFY.forEach(function (n) {
        var el = $('[data-notify="' + n[0] + '"]');
        next[n[0]] = el ? el.checked : true;
      });
      W.session.prefsSave({ notify: next }).then(function () {
        P.prefs = P.prefs || {};
        P.prefs.notify = next;
        toast('Preference saved.');
      }, function (err) {
        box.checked = !box.checked;          /* put the switch back, it did not take */
        toast(err && err.message ? err.message : 'That did not save. Try again.');
        if (isAuthError(err)) bounce();
      });
      void key;
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('#signout')) return;
      /* End the SERVER session, not just the local record. Clearing
         localStorage alone leaves the cookie alive, and the boot guard would
         adopt() it on the next visit and sign the visitor straight back in. */
      var done = function () { location.replace('/whollar-login-provider'); };
      W.session.end('partner').then(done, done);
    });
  }

  /* ================================================================== *
   * session revalidation
   * ================================================================== */

  function isAuthError(err) {
    return !!err && (err.status === 401 || err.status === 403 || err.code === 'UNAUTHENTICATED');
  }

  function bounce() {
    W.partner.clear();
    location.replace('/whollar-login-provider?next=' + encodeURIComponent(location.pathname));
  }

  /* The local record proves nothing: it is writable from a console and it can
     outlive the cookie. A definite 401 or 403 means the session is gone or now
     belongs to someone else, and the console must not keep painting. A network
     failure is NOT that, and must not sign anyone out. */
  function revalidate() {
    return W.session.providerMe().then(function (r) {
      C.check('providerMe', r);
      P.user = r.user || P.user;
      P.org = r.org || P.org;
      P.approved = r.approved === true;
      paintChrome();
      paintBanner();
      renderPlaceholders();
      renderAccount();
    }, function (err) {
      if (isAuthError(err)) { bounce(); return; }
      /* Offline or backend down. The chrome already has the local record, so
         leave it up rather than blanking a console over one failed poll. */
      if (root.console && root.console.warn) root.console.warn('[whollar] provider/me failed:', err && err.message);
    });
  }

  function loadPrefs() {
    return W.session.prefsGet().then(function (p) {
      P.prefs = p || {};
      renderAccount();
    }, function () { P.prefs = {}; });
  }

  /* ================================================================== *
   * boot
   * ================================================================== */

  W.console.boot = function (partner) {
    P.partner = partner || {};
    P.user = {
      firstName: P.partner.firstName, lastName: P.partner.lastName, email: P.partner.email
    };
    P.org = P.partner.org ? { name: P.partner.org, role: P.partner.role } : null;
    /* Assume NOT approved until the server says otherwise. The opposite default
       flashes a full console at a partner who is still under review. */
    P.approved = false;

    /* Strict contract checking is a local-development tool. In production a
       shape mismatch is reported and the view degrades. */
    C.strict = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

    wireNav();
    wireAccount();
    paintChrome();
    paintBanner();
    renderPlaceholders();
    renderAccount();
    nav(viewFromHash());

    revalidate().then(loadPrefs);

    /* Re-check when the tab comes back, so a session that expired while the
       partner was elsewhere is caught on return rather than on next click.
       The provider session is 12 hours and does not roll. */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') revalidate();
    });
  };

  /* Exposed for the QA harness and for the fixture layer to swap. */
  W.console.nav = nav;
  W.console.toast = toast;
  W.console.openModal = openModal;
  W.console.closeModal = closeModal;
})(typeof window !== 'undefined' ? window : globalThis);
