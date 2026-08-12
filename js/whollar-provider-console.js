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
  /* Every server call goes through the register, never through W.session
     directly. One path means the fixture layer can replace all 67 at once,
     and a view can never half-mock. */
  var api = W.console.api;

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var mobile = function () { return root.innerWidth <= 940; };
  var esc = W.escapeHtml;

  /* Live partner context, filled by boot() and refreshed by revalidate(). */
  var P = {
    partner: null, org: null, user: null, approved: false, prefs: null,
    coverage: [],      /* GET /provider/coverage */
    campaigns: [],     /* GET /provider/campaigns, stage included, server derived */
    bids: {},          /* GET /provider/bids, keyed by campaign id */
    intent: {}         /* "plan to bid", local until the endpoint exists */
  };

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

    $('#bids-body').innerHTML = soon(
      'Your first bid lands here',
      'Every bid you place sits on this record with everything it turned into: result, confirmed households, completed switches, fees.');

    $('#billing-body').innerHTML = soon(
      'No statements yet, by design',
      'Bids are free. Winning is free. Confirmed households are free. The first line is the first activation with a clean line test.');


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

  /* ================================================================== *
   * coverage
   *
   * Coverage is the gate on everything else: a cohort only reaches a partner's
   * desk from inside a region they have declared and that has verified. So
   * this view is not a settings page, it is the thing that makes the desk
   * non-empty, and it says so.
   * ================================================================== */

  /* The technologies desk.js accepts, in its own spelling. The console shows
     the label; the wire carries the value. Getting this wrong is a 400. */
  var TECHS = [['fibre', 'Fibre'], ['cable', 'Cable'], ['dsl', 'DSL'], ['fwa', 'Fixed wireless']];
  var SPEEDS = ['500 Mbps', '1 Gig', '2.5 Gig'];
  var LEAD_TIMES = ['5 business days', '7 business days', '10 business days'];

  var covEdit = null;      /* region slug being edited inline, or null */
  var covDraft = null;     /* chip state while editing, so a re-render keeps it */

  function regionKey(s) {
    return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function covOf(region) {
    var k = regionKey(region);
    for (var i = 0; i < P.coverage.length; i++) if (regionKey(P.coverage[i].region) === k) return P.coverage[i];
    return null;
  }
  function techLabel(v) {
    for (var i = 0; i < TECHS.length; i++) if (TECHS[i][0] === v) return TECHS[i][1];
    return v;
  }
  function svcStr(c) {
    var t = (c.techs || []).map(techLabel).join(' · ');
    return t + (c.speed ? (t ? ' · ' : '') + 'up to ' + c.speed : '');
  }

  var COV_STATE = {
    active: ['', 'Active'],
    verifying: ['pend', 'Verifying'],
    soon: ['soon', 'Coming soon'],
    rejected: ['pend', 'Not serviceable']
  };

  function renderCov() {
    var host = $('#cov-body');
    if (!host) return;

    if (!P.coverage.length) {
      host.innerHTML = '<section class="card"><div class="empty">'
        + '<h3>Nothing declared yet, so nothing reaches your desk</h3>'
        + '<p>Auctions are matched to partners by coverage. Name a region and the services you can render there, and cohorts forming inside it start appearing on your bid desk. Serviceability is checked against facilities data; you do not have to wait for that to declare more.</p>'
        + '</div>' + covAddRow(true) + '</section>';
      return;
    }

    var rows = P.coverage.map(function (c) {
      var slug = regionKey(c.region);
      var st = COV_STATE[c.status] || COV_STATE.verifying;
      var openN = P.campaigns.filter(function (a) {
        return regionKey(a.coverageRegion || a.region) === slug && (a.stage === 'open' || a.stage === 'closing');
      }).length;

      var main = '<tr><td><span class="rg" style="font-size:13.5px">' + esc(c.region) + '</span></td>'
        + '<td><span class="covdot ' + st[0] + '"></span>' + st[1] + '</td>'
        + '<td class="covsvc">' + esc(svcStr(c)) + '</td>'
        + '<td class="num">' + (openN || '·') + '</td>'
        + '<td style="white-space:nowrap">'
        + (c.status === 'soon'
          ? '<span class="mono" style="font-size:11px;color:var(--sub)">Queued for launch</span>'
          : '<button class="tlink" type="button" data-covedit="' + esc(slug) + '">Edit services</button>')
        + '</td></tr>';

      /* A rejected region has to say why, or a partner has no way to act on
         it. The prototype has no such state; the backend will carry a reason. */
      if (c.status === 'rejected' && c.rejectionReason) {
        main += '<tr><td colspan="5" style="padding-top:0">'
          + '<p class="fnote" style="margin:0 0 10px;max-width:70ch"><b>Why:</b> ' + esc(c.rejectionReason) + '</p></td></tr>';
      }

      if (covEdit === slug) {
        var chosen = covDraft || (c.techs || []).slice();
        main += '<tr class="covedit"><td colspan="5"><div class="dh">Services in ' + esc(c.region) + '</div>'
          + '<div class="cechips" data-ce="' + esc(slug) + '">'
          + TECHS.map(function (t) {
            return '<button type="button" data-t="' + t[0] + '" class="' + (chosen.indexOf(t[0]) > -1 ? 'on' : '') + '">' + t[1] + '</button>';
          }).join('')
          + '</div>'
          + '<div class="ceform"><div><label>Top speed offered</label><select id="ce-speed">'
          + SPEEDS.map(function (s) { return '<option' + (c.speed === s ? ' selected' : '') + '>' + s + '</option>'; }).join('')
          + '</select></div>'
          + '<div><label>Install lead time</label><select id="ce-lead">'
          + LEAD_TIMES.map(function (s) { return '<option' + (c.lead === s ? ' selected' : '') + '>' + s + '</option>'; }).join('')
          + '</select></div>'
          + '<div><button class="btn forest" type="button" data-covsave="' + esc(slug) + '">Save</button></div></div></td></tr>';
      }
      return main;
    }).join('');

    host.innerHTML = '<section class="card" style="padding-top:14px" aria-label="Your regions">'
      + '<div class="twrap"><table class="tbl">'
      + '<thead><tr><th>Region</th><th>Status</th><th>Services declared</th><th class="num">Open</th><th></th></tr></thead>'
      + '<tbody>' + rows + covAddRow(false) + '</tbody></table></div>'
      + '<p class="fnote">State the areas you want to bid in and the services you can render there. New regions verify against serviceability before auctions appear.</p>'
      + '</section>';
  }

  function covAddRow(standalone) {
    var inner = '<td colspan="2"><input id="regin" type="text" placeholder="Add a region you want to bid in" aria-label="Add a region"></td>'
      + '<td><div class="cechips" id="addtech" style="margin:0">'
      + TECHS.map(function (t) { return '<button type="button" data-t="' + t[0] + '">' + t[1] + '</button>'; }).join('')
      + '</div></td>'
      + '<td><select id="addspeed" style="width:100%;font:inherit;font-size:12.5px;border:1.5px solid var(--line);border-radius:9px;padding:7px 9px;background:#fff">'
      + SPEEDS.map(function (s) { return '<option>' + s + '</option>'; }).join('')
      + '</select></td>'
      + '<td><button class="btn forest" type="button" id="regadd" style="width:100%;justify-content:center">Declare</button></td>';
    if (!standalone) return '<tr class="addrow">' + inner + '</tr>';
    return '<div class="twrap" style="margin-top:14px"><table class="tbl"><tbody><tr class="addrow">' + inner + '</tr></tbody></table></div>';
  }

  function wireCoverage() {
    document.addEventListener('click', function (e) {
      var ed = e.target.closest('[data-covedit]');
      if (ed) {
        var slug = ed.getAttribute('data-covedit');
        covEdit = covEdit === slug ? null : slug;
        covDraft = null;
        renderCov();
        return;
      }
      /* Chip toggles are local until Save, and the draft is held outside the
         DOM so a background refresh cannot silently discard a half-made edit. */
      var chip = e.target.closest('.cechips button');
      if (chip) {
        chip.classList.toggle('on');
        var wrap = chip.closest('.cechips');
        if (wrap && wrap.getAttribute('data-ce')) {
          covDraft = $$('button.on', wrap).map(function (b) { return b.getAttribute('data-t'); });
        }
        return;
      }
      var sv = e.target.closest('[data-covsave]');
      if (sv) { saveCoverage(sv, sv.getAttribute('data-covsave')); return; }
      if (e.target.closest('#regadd')) { addRegion(e.target.closest('#regadd')); }
    });
  }

  function saveCoverage(btn, slug) {
    var c = null;
    for (var i = 0; i < P.coverage.length; i++) if (regionKey(P.coverage[i].region) === slug) c = P.coverage[i];
    if (!c) return;
    var techs = covDraft || (c.techs || []);
    if (!techs.length) { toast('Pick at least one technology you serve there.'); return; }
    if (!W.busy(btn, true, 'Saving')) return;
    api.coverageUpdate({
      region: c.region, techs: techs,
      speed: $('#ce-speed') ? $('#ce-speed').value : c.speed,
      lead: $('#ce-lead') ? $('#ce-lead').value : c.lead
    }).then(function (r) {
      P.coverage = r.coverage || P.coverage;
      covEdit = null; covDraft = null;
      W.busy(btn, false);
      renderCov(); renderDesk();
      toast('Services updated for ' + c.region + '.');
    }, function (err) { W.busy(btn, false); failed(err); });
  }

  function addRegion(btn) {
    var input = $('#regin');
    var region = input ? input.value.trim() : '';
    if (!region) { toast('Name the region first.'); return; }
    var techs = $$('#addtech button.on').map(function (b) { return b.getAttribute('data-t'); });
    if (!techs.length) { toast('Pick at least one technology you serve there.'); return; }
    if (!W.busy(btn, true, 'Declaring')) return;
    api.coverageDeclare({ region: region, techs: techs, speed: $('#addspeed').value })
      .then(function (r) {
        P.coverage = r.coverage || P.coverage;
        W.busy(btn, false);
        renderCov(); renderDesk();
        toast(region + ' declared. Verifying serviceability against facilities data.');
      }, function (err) { W.busy(btn, false); failed(err); });
  }

  /* Server messages are shown verbatim. lib/errors.js composes them on the
     explicit assumption that pages do not rewrite them, and a 403 there says
     "still under review", which is the real answer. */
  function failed(err) {
    toast((err && err.message) || 'That did not work. Try again.');
    if (isAuthError(err)) bounce();
  }

  /* ================================================================== *
   * bid desk
   * ================================================================== */

  /* The five rail positions. The server's sixth stage, 'planned', sits before
     the rail starts and renders as a label with no rail at all. */
  var RAIL = ['announced', 'open', 'closing', 'offers_out', 'decided'];

  function railHTML(stage) {
    var idx = RAIL.indexOf(stage);
    var hot = stage === 'closing';
    if (idx < 0) return '<div class="stlbl">Planned</div>';
    var out = '<div class="minirail">';
    for (var i = 0; i < 5; i++) {
      out += '<span class="mr' + (i < idx ? ' past' : (i === idx ? ' now' : '')) + '"></span>';
      if (i < 4) out += '<span class="mrl' + (i < idx ? ' past' : '') + '"></span>';
    }
    return out + '</div><div class="stlbl' + (hot ? ' hot' : '') + '">'
      + esc(C.STAGE_LABEL[stage] || stage) + '</div>';
  }

  var MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtD(ts) { var d = new Date(ts); return MN[d.getMonth()] + ' ' + d.getDate(); }
  function cdFmt(ms) {
    if (ms < 0) ms = 0;
    var t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(h) + ':' + p(m) + ':' + p(s);
  }

  var DAY = 86400000;

  function renderDesk() {
    var host = $('#desk-body');
    if (!host) return;

    var list = P.campaigns.slice().sort(function (a, b) {
      return (a.closesAt || a.nextAt || Infinity) - (b.closesAt || b.nextAt || Infinity);
    });

    if (!list.length) {
      /* Three different reasons a desk is empty, and they are not
         interchangeable. Telling a partner whose application is still open
         that no cohorts are forming would be false and would leave them with
         nothing to do about it. */
      if (!P.approved) {
        host.innerHTML = soon(
          'Cohorts open when your application clears',
          'Auctions reach this desk from inside your declared coverage, once your application is approved. Declaring coverage now is what queues you for the first one.',
          '<button class="btn" type="button" data-nav="coverage">Declare your coverage</button>');
      } else if (!P.coverage.length) {
        host.innerHTML = soon(
          'Declare coverage and cohorts appear here',
          'Auctions are matched to partners by coverage. Nothing reaches this desk until you have declared where you serve.',
          '<button class="btn" type="button" data-nav="coverage">Declare your coverage</button>');
      } else {
        host.innerHTML = soon(
          'No cohorts open in your coverage yet',
          'A cohort appears the moment one forms inside a region you have declared. You will get an email too; nothing here needs watching.');
      }
      return;
    }

    var rows = list.map(function (a) {
      var cov = covOf(a.coverageRegion || a.region);
      var locked = !cov || cov.status !== 'active';
      var st = a.stage;
      var hot = st === 'closing';
      var mine = P.bids[a.id];

      var yours = mine
        ? (st === 'decided'
          ? '<span class="pill won">Won · ' + (a.confirmed || 0) + ' confirmed</span>'
          : '<span class="pill sealed">Sealed</span>')
        : '<span class="mono" style="color:#949E95">·</span>';

      var closes = a.dates ? a.dates.bidding_closes_at : null;
      var opens = a.dates ? a.dates.bidding_opens_at : null;
      var decides = a.dates ? a.dates.decision_at : null;
      var win;
      if (st === 'planned' || st === 'announced') win = opens ? 'Opens ' + fmtD(opens) : 'Date to come';
      else if (st === 'open' || st === 'closing') {
        win = closes ? 'Closes ' + fmtD(closes) : 'Open now';
        /* The countdown offsets from the server clock, never from this one. */
        if (closes && W.console.clock.until(closes) <= DAY) {
          win += ' · <span data-until="' + closes + '">' + cdFmt(W.console.clock.until(closes)) + '</span>';
        }
      } else if (st === 'offers_out') win = decides ? 'Decides ' + fmtD(decides) : 'With households';
      else win = decides ? 'Closed ' + fmtD(decides) : 'Closed';

      var act;
      if (locked) {
        act = '<span class="lockedtag">Verifies with ' + esc(a.coverageRegion || a.region) + ' coverage</span>';
      } else if (st === 'planned' || st === 'announced') {
        act = '<button class="btn ghost" type="button" data-intent="' + esc(a.id) + '">'
          + (P.intent[a.id] ? 'On your slate ✓' : 'Plan to bid') + '</button>';
      } else if (st === 'open' || st === 'closing') {
        act = '<button class="btn' + (mine ? ' ghost' : '') + '" type="button" data-open="' + esc(a.id) + '">'
          + (mine ? 'View' : 'Review and bid') + '</button>';
      } else {
        act = '<button class="btn ghost" type="button" data-open="' + esc(a.id) + '">View</button>';
      }

      return '<tr data-row="' + esc(a.id) + '"' + (locked ? ' class="locked"' : '') + '>'
        + '<td><span class="rg">' + esc(a.region) + '<small>' + esc(a.sub || '') + '</small></span></td>'
        + '<td class="num">' + (a.households != null ? a.households : '·') + '</td>'
        + '<td>' + railHTML(st) + '</td>'
        + '<td><span class="closecell' + (hot ? ' hot' : '') + '">' + win + '</span></td>'
        + '<td>' + yours + '</td>'
        + '<td style="text-align:right">' + act + '</td></tr>'
        + '<tr class="dwr" data-dwr="' + esc(a.id) + '"><td colspan="6"><div class="dgrid">'
        + briefHTML(a, cov) + ticketHTML(a) + '</div></td></tr>';
    }).join('');

    host.innerHTML = '<section class="card" style="padding-top:14px" aria-label="Open auctions">'
      + '<div class="twrap"><table class="tbl">'
      + '<thead><tr><th>Cohort</th><th class="num">Households</th><th>Stage</th><th>Window</th><th>Your bid</th><th></th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>'
      + '<p class="fnote">You see an auction because it sits inside your declared coverage.</p>'
      + '</section>';
  }

  /* The brief. Aggregates only: no household is identifiable from anything
     here, and nothing on this panel crosses the intimation boundary. */
  function briefHTML(a, cov) {
    function mix(arr) {
      if (!arr || !arr.length) return '<b class="mono" style="color:var(--sub)">not yet published</b>';
      var tot = arr.reduce(function (t, x) { return t + x[1]; }, 0) || 1;
      var bars = arr.map(function (x) { return '<i style="width:' + Math.round(x[1] / tot * 88) + 'px"></i>'; }).join('');
      var lab = arr.map(function (x) { return esc(x[0]) + ' ' + x[1] + '%'; }).join(' · ');
      return '<span class="mixin">' + bars + '<em>' + lab + '</em></span>';
    }
    var covline = cov
      ? '<b>' + esc(svcStr(cov)) + '</b>'
      : '<b style="color:#8C3B1B">Not declared</b> <button class="tlink" type="button" data-nav="coverage">Declare →</button>';

    return '<div class="brief"><div class="dh">The auction brief</div><div class="dl">'
      + '<div class="r"><span>Households</span><b>' + (a.households != null ? a.households : '·') + '</b></div>'
      + '<div class="r"><span>Renewal window</span><b>' + esc(a.renewalWindow || 'not yet published') + '</b></div>'
      + '<div class="r"><span>Speed demand</span>' + mix(a.speedDemand) + '</div>'
      + '<div class="r"><span>Plant mix</span>' + mix(a.plantMix) + '</div>'
      + '<div class="r"><span>Your coverage here</span>' + covline + '</div>'
      + '</div>'
      + '<p class="fnote">Aggregates only.</p></div>';
  }

  /* The ticket arrives with the bid form. Until then the drawer still opens,
     because the brief is worth reading on its own. */
  function ticketHTML(a) {
    var mine = P.bids[a.id];
    if (mine) {
      return '<div class="tkt"><div class="dh">Your sealed bid</div>'
        + '<div class="receipt"><b>Sealed.</b> Improvable until close. No withdrawals.</div></div>';
    }
    if (a.stage === 'offers_out') {
      return '<div class="tkt"><div class="dh">Bids closed</div><div class="receipt">'
        + 'Offers are out to every household, individually. There is nothing for you to do, and no way to see another partner’s bid.'
        + '</div></div>';
    }
    return '<div class="tkt"><div class="dh">Set terms</div><div class="receipt">'
      + 'The sealed bid form is the next thing being built here. The brief beside this is live.'
      + '</div></div>';
  }

  function wireDesk() {
    document.addEventListener('click', function (e) {
      var o = e.target.closest('[data-open]');
      if (o) {
        var row = $('tr[data-row="' + o.getAttribute('data-open') + '"]');
        if (row) row.classList.toggle('exp');
        return;
      }
      var it = e.target.closest('[data-intent]');
      if (it) {
        var id = it.getAttribute('data-intent');
        P.intent[id] = !P.intent[id];
        renderDesk();
        toast(P.intent[id]
          ? 'On your slate. The brief and every date land on your calendar.'
          : 'Taken off your slate.');
      }
    });
  }

  /* One ticking clock for every countdown on the page, offset from the
     server's. Only runs while something is actually counting down. */
  var tickTimer = null;
  function startTicking() {
    if (tickTimer) return;
    tickTimer = setInterval(function () {
      var els = $$('[data-until]');
      if (!els.length) { clearInterval(tickTimer); tickTimer = null; return; }
      els.forEach(function (el) {
        el.textContent = cdFmt(W.console.clock.until(+el.getAttribute('data-until')));
      });
    }, 1000);
  }

  /* ---------- account ---------- */

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
      api.prefsSave({ notify: next }).then(function () {
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
      api.signOut().then(done, done);
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
    return api.me().then(function (r) {
      C.check('providerMe', r);
      P.user = r.user || P.user;
      P.org = r.org || P.org;
      P.approved = r.approved === true;
      paintChrome();
      paintBanner();
      renderPlaceholders();
      renderCov();
      renderDesk();
      renderAccount();
    }, function (err) {
      if (isAuthError(err)) { bounce(); return; }
      /* Offline or backend down. The chrome already has the local record, so
         leave it up rather than blanking a console over one failed poll. */
      if (root.console && root.console.warn) root.console.warn('[whollar] provider/me failed:', err && err.message);
    });
  }

  function loadPrefs() {
    return api.prefs().then(function (p) {
      P.prefs = p || {};
      renderAccount();
    }, function () { P.prefs = {}; });
  }

  /**
   * Coverage, cohorts and this org's own bids.
   *
   * Each settles on its own: a partner with coverage but no cohorts, or
   * cohorts but an unreadable bids table, still gets the parts that answered.
   * The `live` flag these routes carry means "the table was readable" rather
   * than "there is data", and a false there is worth saying out loud rather
   * than rendering as an empty desk.
   */
  function loadDesk() {
    var jobs = [
      api.coverage().then(function (r) {
        P.coverage = (r && r.coverage) || [];
        P.coverageLive = !!r && r.live !== false;
      }, function (err) { if (isAuthError(err)) bounce(); P.coverageLive = false; }),

      /* NOTE the null. whollar-core.js splits its methods in two on purpose:
         button paths reject with the server's message, boot-path reads resolve
         null so a failure degrades instead of blanking a page. providerCampaigns
         is a boot-path read, so "could not tell" arrives as null, not as a
         rejection, and checking it as an object is a contract error of ours
         rather than the server's. */
      api.campaigns().then(function (r) {
        if (!r) { P.campaignsLive = false; P.campaigns = []; return; }
        P.campaignsLive = r.live !== false;
        C.check('campaignList', r);
        /* Per row, because a payload can be the right shape overall and carry
           one campaign the server built differently. */
        (r.campaigns || []).forEach(function (c) { C.check('campaign', c); });
        P.campaigns = r.campaigns || [];
        P.biddingPaused = !!(r.bidding && r.bidding.enabled === false);
        P.biddingNotice = (r.bidding && r.bidding.notice) || null;
      }, function (err) { if (isAuthError(err)) bounce(); P.campaignsLive = false; }),

      /* An unapproved org may read its own bids, so this is not gated on
         approval. It can 501 while the register is still stubbed. */
      api.bids().then(function (r) {
        P.bids = {};
        ((r && r.bids) || []).forEach(function (b) { P.bids[b.campaign || b.campaignId] = b; });
      }, function () { P.bids = {}; })
    ];

    return Promise.all(jobs).then(function () {
      renderPlaceholders();
      renderCov();
      renderDesk();
      startTicking();
    });
  }

  /* ================================================================== *
   * boot
   * ================================================================== */

  /* Fixture mode, and the three conditions on it.
     The file itself is in .vercelignore, so it does not exist in any deployed
     environment and this request 404s there. These checks are a second belt,
     and they are cheap. */
  function loadFixtures() {
    var q;
    try { q = new URLSearchParams(location.search).get('fixture'); } catch (e) { q = null; }
    var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!q || !local) return Promise.resolve();
    return new Promise(function (done) {
      var s = document.createElement('script');
      s.src = '/js/console-fixtures.js';
      /* Resolve either way. A missing fixture file must not stop the console
         booting; it should boot against the real API, which is exactly what
         happens on a preview deploy where the file is absent by design. */
      s.onload = function () { done(); };
      s.onerror = function () {
        if (root.console) root.console.warn('[whollar] no fixture file here; booting against the real API');
        done();
      };
      document.head.appendChild(s);
    });
  }

  function start(partner) {
    P.partner = partner || {};
    P.user = {
      firstName: P.partner.firstName, lastName: P.partner.lastName, email: P.partner.email
    };
    P.org = P.partner.org ? { name: P.partner.org, role: P.partner.role } : null;
    /* Assume NOT approved until the server says otherwise. The opposite default
       flashes a full console at a partner who is still under review. */
    P.approved = false;

    /* Re-read the register: under fixtures every one of the 67 was replaced,
       and this module captured the object at load time. */
    api = W.console.api;

    /* Strict contract checking is a local-development tool. In production a
       shape mismatch is reported and the view degrades. */
    C.strict = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

    wireNav();
    wireAccount();
    wireCoverage();
    wireDesk();
    paintChrome();
    paintBanner();
    renderPlaceholders();
    renderCov();
    renderDesk();
    renderAccount();
    nav(viewFromHash());

    revalidate().then(loadPrefs).then(loadDesk);

    /* Re-check when the tab comes back, so a session that expired while the
       partner was elsewhere is caught on return rather than on next click.
       The provider session is 12 hours and does not roll. */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') revalidate();
    });
  }

  /* Fixtures install before anything renders. Rendering first and swapping
     after would show one frame of real data inside a fixture run, which is the
     kind of thing that makes a demo look flaky and a bug look intermittent. */
  W.console.boot = function (partner) {
    return loadFixtures().then(function () { start(partner); });
  };

  /* Exposed for the QA harness and for the fixture layer to swap. */
  W.console.nav = nav;
  W.console.toast = toast;
  W.console.openModal = openModal;
  W.console.closeModal = closeModal;
})(typeof window !== 'undefined' ? window : globalThis);
