/* Boot, the render cycle, and nothing else.
 *
 * THE RENDER CYCLE. One subscription to the store, painting every view that is
 * mounted. The prototype had two competing cycles: renderAll(), which was
 * itself a decorator over an earlier renderAll(), and a one-second tick() that
 * compared a stage signature and re-rendered everything when it changed.
 * renderAcq() was in neither, so the acquisition section went stale after any
 * clock or scenario change and nobody noticed for four versions (§4.4.2).
 *
 * Here every view renders from state, every state change repaints, and there
 * is no second path. A view that is not repainted is a view that is not in
 * this list, which is a one-line bug rather than an archaeology problem.
 */

import { get, set, subscribe, refresh } from './core/state.js';
import { api } from './core/api.js';
import { check, setStrict } from './core/contract.js';
import { revalidate, mount as mountSession, authFailed } from './core/session.js';
import { on, mount as mountActions, registered } from './core/actions.js';
import { mount as mountModal } from './core/modal.js';
import { VIEWS, go, current, onChange, mount as mountRouter, setGated } from './core/router.js';
import { startTicker } from './core/time.js';

import { render as renderBanner } from './components/banner.js';
import { render as renderOverview } from './views/overview.js';
import { render as renderDesk, mount as mountDesk } from './views/desk.js';
import { mount as mountTicket } from './views/ticket.js';
import { render as renderBids, mount as mountBids } from './views/bids.js';
import { render as renderCoverage, mount as mountCoverage } from './views/coverage.js';
import { render as renderApplication, mount as mountApplication, load as loadApplication } from './views/application.js';
import { render as renderAccount, mount as mountAccount, paintChrome } from './views/account.js';
import { render as renderPerformance } from './views/performance.js';
import { render as renderContracts, mount as mountContracts, load as loadContracts } from './views/contracts.js';
import { render as renderDelivery, mount as mountDelivery, load as loadDelivery } from './views/delivery.js';
import { render as renderBilling, mount as mountBilling, load as loadBilling } from './views/billing.js';
import { render as renderPlaceholders } from './views/placeholders.js';

/* ------------------------------------------------------------------ *
 * render
 * ------------------------------------------------------------------ */

function renderAll() {
  paintChrome();
  renderBanner();
  renderOverview();
  renderDesk();
  renderBids();
  renderCoverage();
  renderApplication();
  renderAccount();
  renderDelivery();
  renderBilling();
  renderPerformance();
  renderContracts();
  renderPlaceholders();

  /* Under review the console is one centred card: no nav pane, no search.
     Driven from the server's application state, so it cannot disagree with
     what the frame itself is saying.

     Not gated on submittedAt. The frame is the whole account until a human
     approves the org, and that includes the days before the fifth task lands:
     an application in progress and an application under review are the same
     screen with a different row lit, which is what the card already renders.
     A null application is the one exception, because "reading your
     application" is not a screen to lock anyone into. */
  var S = get();
  setGated(!S.approved && !!S.application && current() === 'pending');
}

/* ------------------------------------------------------------------ *
 * loading
 * ------------------------------------------------------------------ */

/* Each job settles on its own. A partner with coverage but an unreadable
   cohort list still gets the parts that answered, because Promise.all over
   already-caught promises cannot reject. The `live` flag these routes carry
   means "the table was readable" rather than "there is data", and a false
   there is worth saying out loud rather than rendering as an empty desk. */
function loadAll() {
  var jobs = [
    api.coverage().then(function (r) {
      set({ coverage: (r && r.coverage) || [], coverageLive: !!r && r.live !== false });
    }, function (err) { authFailed(err); set('coverageLive', false); }),

    /* NOTE the null check. whollar-core.js splits its methods deliberately:
       button paths reject with the server's message, boot-path reads resolve
       null so a failure degrades instead of blanking a page. providerCampaigns
       is a boot-path read, so "could not tell" arrives as null, not as a
       rejection, and treating null as an object is our contract error rather
       than the server's. */
    api.campaigns().then(function (r) {
      if (!r) { set({ campaignsLive: false, campaigns: [] }); return; }
      check('campaignList', r);
      (r.campaigns || []).forEach(function (c) { check('campaign', c); });
      set({
        campaigns: r.campaigns || [],
        campaignsLive: r.live !== false,
        biddingPaused: !!(r.bidding && r.bidding.enabled === false),
        biddingNotice: (r.bidding && r.bidding.notice) || null
      });
    }, function (err) { authFailed(err); set('campaignsLive', false); }),

    /* An unapproved org may read its own bids, so this is not gated on
       approval. It can 501 while the register is still stubbed. */
    api.bids().then(function (r) {
      var byId = {};
      ((r && r.bids) || []).forEach(function (b) { byId[b.campaignId || b.campaign] = b; });
      set('bids', byId);
    }, function () { set('bids', {}); }),

    api.prefs().then(function (p) { set('prefs', p || {}); }, function () { set('prefs', {}); }),

    /* The application. A 501 here is not an error to show anyone: it means the
       route is not deployed yet, and the view already renders that honestly. */
    loadApplication(),

    /* The contracts registry. It also carries the terms acceptance, which is
       what the bid ticket reads to know whether to send a partner to Contracts
       before bidding, so it loads on boot rather than on first view of the
       Contracts page. */
    loadContracts(),

    /* Statements, on boot rather than on view-open. Two other surfaces read
       the same payload: the overview checklist ticks its billing step from the
       method on file, and the roster gate is refused without one, so a partner
       who never opens Billing still needs it read. It carries no household
       identity and is not audited, which is what makes that safe.

       The delivery board is the opposite and is NOT loaded here: a released
       roster carries addresses and every read writes an audit row, so it is
       fetched when the view opens and on explicit refresh. See onChange below. */
    loadBilling()
  ];
  return Promise.all(jobs).then(function () { startTicker(); });
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

/* Fixture mode, and the three things gating it. partner/demo/ is listed in
   .vercelignore, so it does not exist in any deployed environment and this
   request 404s there. These checks are a second belt, and they are cheap. */
function loadFixtures() {
  var q;
  try { q = new URLSearchParams(location.search).get('fixture'); } catch (e) { q = null; }
  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!q || !local) return Promise.resolve();
  return new Promise(function (done) {
    var s = document.createElement('script');
    s.src = '/partner/demo/fixtures.js';
    /* Resolve either way. A missing fixture file must not stop the console
       booting; it should boot against the real API, which is exactly what
       happens on a preview deploy where the file is absent by design. */
    s.onload = function () { done(); };
    s.onerror = function () {
      if (typeof console !== 'undefined') console.warn('[whollar] no fixture file here; booting against the real API');
      done();
    };
    document.head.appendChild(s);
  });
}

function start(partner) {
  set({
    partner: partner || {},
    user: {
      firstName: (partner || {}).firstName,
      lastName: (partner || {}).lastName,
      email: (partner || {}).email
    },
    org: (partner || {}).org ? { name: partner.org, role: partner.role } : null,
    /* Assume NOT approved until the server says otherwise. The opposite
       default flashes a full console at a partner who is still under review. */
    approved: false
  });

  /* Strict contract checking is a local development tool. In production a
     shape mismatch is reported once and the view degrades. */
  setStrict(location.hostname === 'localhost' || location.hostname === '127.0.0.1');

  mountActions();
  mountModal();
  mountRouter();
  mountSession();
  mountDesk();
  mountTicket();
  mountBids();
  mountCoverage();
  mountApplication();
  mountAccount();
  mountContracts();
  mountDelivery();
  mountBilling();

  on('click', 'nav', function (el) { go(el.getAttribute('data-view')); });

  document.getElementById('pnav').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || b.classList.contains('soon')) return;
    go(b.getAttribute('data-view'));
  });

  var app = document.getElementById('app');
  document.getElementById('burger').addEventListener('click', function () {
    if (window.innerWidth <= 940) app.classList.toggle('paneopen');
    else app.classList.toggle('collapsed');
    this.setAttribute('aria-expanded', app.classList.contains('collapsed') ? 'false' : 'true');
  });
  document.getElementById('overlay').addEventListener('click', function () {
    app.classList.remove('paneopen');
  });

  subscribe(renderAll);
  onChange(renderAll);

  /* The delivery board reads on view-open, once. Re-entering the view does not
     re-read: the board's own writes refresh it, and a partner flipping between
     tabs must not each time append a row to the audit trail that says they
     read forty households' addresses. */
  onChange(function (view) {
    if (view === 'delivery' && get().delivery == null) loadDelivery();
  });

  /* Paint from the local record first so the chrome is never empty, then
     correct it from the server. */
  refresh();

  /* WHERE A NEW PARTNER LANDS. An account created a minute ago has no
     coverage, no cohorts and no bids, so the full console is eleven views of
     nothing. The review card is the entire state of that account, so it is the
     landing view until the org is approved, both while the application is
     being filled in and while it sits under review.

     A hash always wins. Someone following a link to #coverage gets #coverage,
     and approval is not known yet anyway: it arrives with GET /provider/me
     one round trip later, and is corrected below. */
  var chose = !!location.hash;
  go(fixtureView() || (chose ? current() : (get().approved ? 'overview' : 'pending')));
  onChange(function () { chose = true; });

  revalidate().then(function (r) {
    /* Approved after all: hand back the console, unless they navigated during
       the round trip, in which case leave them where they went. */
    if (r && r.approved === true && !chose && current() === 'pending') go('overview');
    return loadAll();
  }).then(function () {
    /* The application route can 501 while it is still being deployed. If it
       did, the frame has nothing to show, so hand back the console rather than
       park a new partner on a card that says "reading your application". */
    if (!chose && current() === 'pending' && !get().application) go('overview');
  });
}

/* A fixture states which view it is about, so a run lands on the screen the
   state is for rather than on the overview every time. */
function fixtureView() {
  var W = window.WHOLLAR;
  var f = W && W.console && W.console.fixture;
  return f && VIEWS.indexOf(f.view) >= 0 && !location.hash ? f.view : null;
}

/* Fixtures install before anything renders. Rendering first and swapping after
   would show one frame of real data inside a fixture run, which is the kind of
   thing that makes a demo look flaky and a bug look intermittent. */
var W = window.WHOLLAR;
if (W) {
  W.console = W.console || {};
  W.console.boot = function (partner) {
    return loadFixtures().then(function () { start(partner); });
  };
  /* Exposed for the QA harness and for the fixture layer to swap. `nav` keeps
     the name the harness has always used: renaming a test surface to match an
     internal rename buys nothing and breaks every check that used it. */
  W.console.api = api;
  W.console.nav = go;
  /* Every registered action name, so the harness can assert that a control
     carrying data-action has something listening for it. */
  W.console.actions = registered;
  W.console.state = get;
}
