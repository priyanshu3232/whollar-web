/* Whollar partner console: the endpoint register.
 *
 * Classic script, no ESM. Loaded after whollar-console-contract.js.
 *
 * ONE FUNCTION PER ENDPOINT, ALL 67, FROM DAY ONE. The ones the backend
 * already serves call it. The ones it does not reject with a correctly shaped
 * NOT_IMPLEMENTED error. That is the point: every view's loading, empty and
 * error path is exercised from the first commit, and turning a stub into a
 * real call is a one-line change with no UI work.
 *
 * WHERE THE NUMBERS COME FROM. Endpoints 1 to 21 are the brief's sections 6.1
 * to 6.3, verbatim. The copy of the brief we hold is truncated mid-6.3, so
 * 22 to 67 are reconstructed from what the eleven views provably read, with
 * one fixed point: the runbook pins section 6.7 at endpoints 40 to 42, which
 * constrains where the earlier groups end. Renumbering is cheap; the register
 * being complete is what matters.
 *
 * PATHS ARE THE BRIEF'S, NOT THE BACKEND'S. The brief says GET /partners/me;
 * this backend serves GET /provider/me. The register keeps the brief's naming
 * as the function name and records the real path next to it, so the two can be
 * compared. Nothing here invents a path the server does not have: a stub
 * carries the path it WILL have, and throws until it does.
 *
 * ERROR CONTRACT. Failures reject with an Error carrying .code, .status and
 * the server's .message, which callers render VERBATIM. catalyst-backend's
 * lib/errors.js composes those messages on the explicit assumption that pages
 * show them unmodified, so client-side error copy would both duplicate and
 * contradict it.
 */
(function (root) {
  "use strict";

  var W = root.WHOLLAR;
  if (!W || !W.console || !W.console.C) return;
  if (W.console.api) return;

  var C = W.console.C;
  var S = W.session;

  /* ---------------------------------------------------------------- *
   * transport
   * ---------------------------------------------------------------- */

  /* Mirrors authPost in whollar-core.js rather than importing it: that one is
     not exported, and duplicating 12 lines is better than widening core's
     surface for a single caller. Keep the two in step. */
  function call(method, path, body, shape) {
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (body !== undefined && body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(W.AUTH_API + path, init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (b) {
        if (!r.ok) {
          var e = new Error((b && b.error && b.error.message) || 'Something went wrong. Try again.');
          e.code = (b && b.error && b.error.code) || 'SERVER_ERROR';
          e.status = r.status;
          throw e;
        }
        var payload = b || {};
        /* Every console GET carries serverTime. Capture the skew here, once,
           so no view is tempted to read the clock itself. */
        if (typeof payload.serverTime === 'number') W.console.clock.sync(payload.serverTime);
        if (shape) C.check(shape, payload);
        return payload;
      });
    }, function () {
      var e = new Error('We could not reach Whollar. Check your connection and try again.');
      e.code = 'NETWORK';
      throw e;
    });
  }

  /* A stub rejects exactly as the server will once it exists, including the
     code, so callers never need a second error path later. NOT_IMPLEMENTED is
     already in the CODES map at catalyst-backend/.../lib/errors.js. */
  function todo(path) {
    var f = function () {
      var e = new Error('That part of the console is not built yet.');
      e.code = 'NOT_IMPLEMENTED';
      e.status = 501;
      e.path = path;
      return Promise.reject(e);
    };
    /* Tagged here rather than sniffed from Function.prototype.toString later:
       a view needs to ask "is this built yet" without calling it, and reading
       function source to answer that is a trick, not an answer. */
    f.__todo = true;
    f.__path = path;
    return f;
  }

  /* ---------------------------------------------------------------- *
   * clock: one skew, captured from the server, read by every countdown
   * ---------------------------------------------------------------- */

  var skew = 0, synced = false;
  W.console.clock = {
    /* serverTime is epoch milliseconds. Deliberately not the datastore's
       "YYYY-MM-DD HH:MM:SS" string: that carries no zone marker, and
       lib/datastore.js documents that new Date() on it shifts by the reader's
       offset. Handing it to a browser reproduces in every client the bug the
       server already fixed. */
    sync: function (serverTime) { skew = serverTime - Date.now(); synced = true; },
    now: function () { return Date.now() + skew; },
    synced: function () { return synced; },
    skew: function () { return skew; },
    /* Milliseconds until a server timestamp, never negative. */
    until: function (ts) { return Math.max(0, ts - W.console.clock.now()); }
  };

  /* ---------------------------------------------------------------- *
   * the register
   * ---------------------------------------------------------------- */

  var api = {};

  /* ---- 6.1 session and bootstrap (1-4) ---- */

  /* 1. POST /auth/session. Owned by whollar-login-provider.html, which runs
        the password plus emailed-code flow. Present so the register is
        complete; the console never calls it. */
  api.signIn = function (creds) { return S.providerLogin(creds); };

  /* 2. DELETE /auth/session -> POST /logout.
        Must end the SERVER session. Clearing localStorage alone leaves the
        cookie alive and the boot guard adopts it straight back. */
  api.signOut = function () { return S.end('partner'); };

  /* 3. GET /partners/me -> GET /provider/me. LIVE. */
  api.me = function () { return S.providerMe().then(function (r) { return C.check('providerMe', r); }); };

  /* 4. GET /time. Stubbed: serverTime rides on every payload instead, which
        removes a round trip and a way for the two to disagree. */
  api.time = todo('GET /time');

  /* ---- 6.2 application (5-16) ---- */

  /* 5. Public intake. Today the marketing form posts to a DIFFERENT Catalyst
        function (formSubmit -> PartnerApplications, PascalCase columns, no
        session), and admin joins it to the org by email-domain suffix match in
        JavaScript. Unifying them is deliberate later work, not a rename. */
  api.applicationCreate = todo('POST /partner-applications');
  /* 6 */ api.application = todo('GET /provider/application');
  /* 7 */ api.applicationRegistration = todo('PATCH /provider/application/registration');
  /* 8 */ api.documentPresign = todo('POST /provider/application/documents/presign');
  /* 9 */ api.documentConfirm = todo('POST /provider/application/documents');
  /* 10 */ api.documents = todo('GET /provider/application/documents');
  /* 11 */ api.documentDelete = todo('DELETE /provider/application/documents/:type');
  /* 12 */ api.applicationAgreement = todo('POST /provider/application/agreement');
  /* 13 */ api.applicationReference = todo('POST /provider/application/reference');
  /* 14. Idempotent by contract: stamps submittedAt only if unset, so the
         auto-submit transition cannot start two 48 hour clocks. */
  /* 14 */ api.applicationSubmit = todo('POST /provider/application/submit');
  /* 15 */ api.applicationTimeline = todo('GET /provider/application/timeline');
  /* 16. Admin, not console. In the register because the brief numbers it. */
  /* 16 */ api.applicationDecision = todo('POST /admin/partner-applications/:id/decision');

  /* ---- 6.3 coverage (17-21) ---- */

  /* 17. LIVE. */
  api.coverage = function () { return S.providerCoverage(); };
  /* 18. LIVE. New regions land 'verifying'. */
  api.coverageDeclare = function (row) { return S.providerCoverageSave(row); };
  /* 19. LIVE as an upsert: the backend keys on `${orgId}:${slug}`, so a patch
         and a create are the same write. */
  api.coverageUpdate = function (row) { return S.providerCoverageSave(row); };
  /* 20 */ api.coverageRemove = todo('DELETE /provider/coverage/:region');
  /* 21. Serviceability is asynchronous and polled. Note nothing in the backend
         currently moves a region off 'verifying', so 'active' is unreachable
         until the admin verify route exists. */
  /* 21 */ api.serviceability = todo('GET /provider/coverage/:region/serviceability');

  /* ---- 6.4 bid desk (22-31) ---- */

  /* 22. LIVE. Counts only, plus bidding_open. Stage must arrive here too. */
  api.campaigns = function () { return S.providerCampaigns(); };
  /* 23 */ api.campaign = todo('GET /provider/campaigns/:id');
  /* 24. Aggregates only: household count, renewal window, speed demand mix,
         plant mix, and the partner's own coverage line. No identities. */
  /* 24 */ api.campaignBrief = todo('GET /provider/campaigns/:id/brief');
  /* 25 */ api.campaignsPlanned = todo('GET /provider/campaigns/planned');
  /* 26 */ api.campaignPlan = todo('GET /provider/campaigns/:id/plan');
  /* 27 */ api.intentAdd = todo('POST /provider/campaigns/:id/intent');
  /* 28 */ api.intentRemove = todo('DELETE /provider/campaigns/:id/intent');
  /* 29 */ api.campaignCalendar = todo('GET /provider/campaigns/:id/calendar');
  /* 30 */ api.agenda = todo('GET /provider/agenda');
  /* 31. Scoped to declared coverage: search must not become a way to enumerate
         cohorts a partner cannot see. */
  /* 31 */ api.search = todo('GET /provider/search');

  /* ---- 6.5 bids (32-37) ---- */

  /* 32. LIVE. */
  api.bids = function () { return S.providerBids(); };
  /* 33. LIVE. One sealed row per campaign and org. */
  api.bidPlace = function (bid) { return S.providerBidSave(bid); };
  /* 34. NOT the same as bidPlace. An improvement is a new VERSION and must be
         at least as good on every tier present in both: no raised effective
         price, no shortened guarantee, no worsened after-rate, no reduced
         commitment. The prototype's improve handler deletes the bid and
         reopens the form; that is prototype convenience and must not ship.
         There is no withdraw, and no endpoint anywhere removes a bid. */
  /* 34 */ api.bidImprove = todo('POST /provider/bids/:campaign/improve');
  /* 35 */ api.bid = todo('GET /provider/bids/:campaign');
  /* 36 */ api.bidVersions = todo('GET /provider/bids/:campaign/versions');
  /* 37 */ api.bidsExport = todo('GET /provider/bids/export');

  /* ---- 6.6 terms and contracts (38-39) ---- */

  /* 38 */ api.contracts = todo('GET /provider/contracts');
  /* 39. Gates bidding. If the standard terms change, bidding pauses until the
         new version is accepted. */
  /* 39 */ api.termsAccept = todo('POST /provider/contracts/terms/accept');

  /* ---- 6.7 roster and delivery (40-52) ----
     THE INTIMATION BOUNDARY. routes/campaigns.js states in code that no member
     identity crosses the campaigns route. It crosses here, and only here, and
     only after three server-side checks: an admin-written award row, a
     completed commercial gate, and per-household consent. Before the gate the
     response carries counts and the `orders` key is ABSENT, not empty: absent
     is unambiguous, whereas [] cannot be told apart from "the gate passed and
     nobody signed up", and a client cannot render rows never transmitted.
     Every read of endpoint 43 is audited, which is why rows are fetched on
     view-open and explicit refresh only, and never polled. */

  /* 40 */ api.roster = todo('GET /provider/campaigns/:id/roster');
  /* 41 */ api.rosterGate = todo('POST /provider/campaigns/:id/roster/gate');
  /* 42 */ api.rosterRelease = todo('POST /provider/campaigns/:id/roster/release');
  /* 43 */ api.orders = todo('GET /provider/campaigns/:id/orders');
  /* 44 */ api.orderSlot = todo('POST /provider/orders/:key/slot');
  /* 45. The ONLY event that creates a billable line. Requires a clean line
         test and a confirmed incumbent cancellation. */
  /* 45 */ api.orderActivate = todo('POST /provider/orders/:key/activate');
  /* 46. Reason comes from C.RELEASE_REASON, never free text: it feeds the
         serviceability figure that feeds future briefs. */
  /* 46 */ api.orderRelease = todo('POST /provider/orders/:key/release');
  /* 47. The partner CHOOSES the exception type. The prototype randomises it. */
  /* 47 */ api.orderException = todo('POST /provider/orders/:key/exception');
  /* 48 */ api.orderRebook = todo('POST /provider/orders/:key/rebook');
  /* 49 */ api.capacity = todo('GET /provider/campaigns/:id/capacity');
  /* 50 */ api.capacitySave = todo('POST /provider/campaigns/:id/capacity');
  /* 51 */ api.logistics = todo('GET /provider/campaigns/:id/logistics');
  /* 52 */ api.rma = todo('GET /provider/campaigns/:id/rma');

  /* ---- 6.8 billing (53-62) ---- */

  /* 53 */ api.billingCycle = todo('GET /provider/billing/cycle');
  /* 54 */ api.statements = todo('GET /provider/statements');
  /* 55. Lines are computed SERVER SIDE and returned as data. They are not
         stored: a line IS a delivery order in state 'act' inside the period,
         and a second table would be a second source of truth for "did this
         switch complete". The statement row holds only the frozen total at
         issue, which is what makes the reconciliation window meaningful. */
  /* 55 */ api.statement = todo('GET /provider/statements/:period');
  /* 56 */ api.statementExport = todo('GET /provider/statements/:period/export');
  /* 57. Freezes ONE line, never the statement. */
  /* 57 */ api.lineDispute = todo('POST /provider/statements/:period/lines/:line/dispute');
  /* 58 */ api.paymentMethod = todo('GET /provider/billing/method');
  /* 59. A hosted flow. The console never handles raw card data. */
  /* 59 */ api.paymentMethodSession = todo('POST /provider/billing/method/session');
  /* 60 */ api.paymentMethodRemove = todo('DELETE /provider/billing/method');
  /* 61. Drives the pause banner and disables every place-bid control. The
         server refuses the bid regardless of what the UI allows. */
  /* 61 */ api.billingStatus = todo('GET /provider/billing/status');
  /* 62. Tax is jurisdiction-driven. The GTA pilot is Ontario; the model must
         not hardcode the pilot. */
  /* 62 */ api.taxProfile = todo('GET /provider/billing/tax');

  /* ---- 6.9 performance (63-64) ---- */

  /* 63. Every figure labelled direct, derived or directional. Nothing
         unlabelled, and nothing that is not a real query. */
  /* 63 */ api.performance = todo('GET /provider/performance');
  /* 64. Publishes only past 25 responses, so one voice cannot be picked out. */
  /* 64 */ api.ratings = todo('GET /provider/performance/ratings');

  /* ---- 6.10 account (65-67) ---- */

  /* 65. LIVE. Session-gated, already provider-usable. */
  api.prefs = function () { return S.prefsGet(); };
  /* 66. LIVE. Merges top-level keys only. */
  api.prefsSave = function (patch) { return S.prefsSave(patch); };
  /* 67. LIVE. Capped at 50 seats server side. */
  api.team = function () { return S.providerTeam(); };

  /* ---------------------------------------------------------------- *
   * self-check
   * ---------------------------------------------------------------- */

  /* The register's completeness is the whole guarantee, so it is counted here
     rather than claimed in a comment. scripts/qa-console.mjs asserts 67. */
  var names = Object.keys(api).filter(function (k) { return typeof api[k] === 'function'; });
  api.__count = names.length;
  api.__implemented = names.filter(function (k) { return !api[k].__todo; }).length;
  api.__pending = names.filter(function (k) { return api[k].__todo; }).map(function (k) { return api[k].__path; });

  api.__call = call;   /* exposed so the fixture layer can replace transport wholesale */

  W.console.api = api;
})(typeof window !== 'undefined' ? window : globalThis);
