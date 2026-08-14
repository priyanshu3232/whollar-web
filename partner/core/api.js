/* The register: every server call the console can make, numbered.
 *
 * WHY A REGISTER RATHER THAN CALLS SCATTERED THROUGH VIEWS. Two reasons, and
 * both have already paid for themselves:
 *
 *   1. Completeness is checkable. scripts/qa-console.mjs asserts the count, so
 *      an endpoint cannot quietly go missing and a view cannot quietly invent
 *      a path the server does not have.
 *   2. The fixture layer replaces all of them at once. There is no code path
 *      where a fixture and a real call interleave, because partial mocking is
 *      how you get a demo that passes and a production that does not.
 *
 * Anything not built yet is a todo() that rejects with NOT_IMPLEMENTED and 501,
 * exactly as the server will once the route exists. Every view's loading, empty
 * and error path is therefore exercised from the first commit, and turning a
 * stub into a call changes one line here and nothing in the view.
 */

import { check } from './contract.js';
import { sync } from './time.js';

function core() {
  return (typeof window !== 'undefined' ? window : globalThis).WHOLLAR || {};
}
function session() { return core().session || {}; }

/* ------------------------------------------------------------------ *
 * transport
 *
 * A local mirror of whollar-core.js's authPost, including its error unwrapping,
 * rather than ten new methods on core. Core loads on all 40 footer-registered
 * pages including the marketing site, and the bar for adding weight there is a
 * second calling page. These are partner-console-only.
 *
 * Same-origin through the /api/auth rewrite in vercel.json, which is what makes
 * a JSON body safe: no preflight is issued, and the Catalyst gateway answers
 * preflight itself without CORS headers. Point this at the Catalyst host
 * directly and it breaks.
 * ------------------------------------------------------------------ */

function request(method, path, body) {
  var W = core();
  var opts = {
    method: method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch((W.AUTH_API || '/api/auth') + path, opts).then(function (r) {
    return r.json().catch(function () { return null; }).then(function (b) {
      if (r.ok) {
        /* Every payload carries serverTime. Syncing here rather than in each
           view means there is one skew for the whole console and no way for
           two countdowns to disagree. */
        if (b && typeof b.serverTime === 'number') sync(b.serverTime);
        return b || {};
      }
      /* A refusal can carry the server clock too: the closed-window 409 sends
         serverTime and closedAt in its body so the console can show that the
         server's clock decided, not the partner's machine. Sync from it, and
         keep the whole error object for views that render those fields. */
      if (b && b.error && typeof b.error.serverTime === 'number') sync(b.error.serverTime);
      var e = new Error((b && b.error && b.error.message) || 'Something went wrong. Please try again.');
      e.code = (b && b.error && b.error.code) || 'SERVER_ERROR';
      e.status = r.status;
      e.field = (b && b.error && b.error.field) || null;
      e.detail = (b && b.error) || null;
      throw e;
    });
  }, function () {
    /* Transport-level failure: offline, DNS, the rewrite misconfigured. This
       is NOT an auth failure and must never sign anyone out. */
    var e = new Error('We could not reach Whollar. Check your connection and try again.');
    e.code = 'NETWORK';
    throw e;
  });
}

/* The other half of the serverTime seam. Calls that go through
   whollar-core.js's session methods bypass request() above, so their payloads
   would anchor nothing: the skew would sit at whatever the last local call
   left it, which on a quiet boot is zero, i.e. the browser's own clock. That
   is exactly the clock the desk countdowns must never trust. Wrapping the
   session-proxied reads here gives the console one skew from whichever
   payload arrives first, usually /provider/me. */
function synced(p) {
  return p.then(function (r) {
    if (r && typeof r.serverTime === 'number') sync(r.serverTime);
    return r;
  });
}

/* A stub rejects exactly as the server will once it exists, including the code,
   so callers never need a second error path later. Tagged rather than sniffed
   from Function.prototype.toString: a view needs to ask "is this built yet"
   without calling it, and reading function source to answer that is a trick,
   not an answer. */
function todo(path) {
  var f = function () {
    var e = new Error('That part of the console is not built yet.');
    e.code = 'NOT_IMPLEMENTED';
    e.status = 501;
    e.path = path;
    return Promise.reject(e);
  };
  f.__todo = true;
  f.__path = path;
  return f;
}

var api = {};

/* ---- 7.1 session and bootstrap (1-4) ---- */

/* 1. POST /auth/session. Owned by whollar-login-provider.html, which runs the
      password plus emailed-code flow. Present so the register is complete; the
      console never calls it. */
api.signIn = function (creds) { return session().providerLogin(creds); };

/* 2. DELETE /auth/session -> POST /logout.
      Must end the SERVER session. Clearing localStorage alone leaves the
      cookie alive and the boot guard adopts it straight back. */
api.signOut = function () { return session().end('partner'); };

/* 3. GET /partners/me -> GET /provider/me. LIVE. */
api.me = function () { return synced(session().providerMe()).then(function (r) { return check('providerMe', r); }); };

/* 4. GET /time. Stubbed: serverTime rides on every payload instead, which
      removes a round trip and a way for the two to disagree. */
api.time = todo('GET /time');

/* ---- 7.2 application (5-16) ---- */

/* 5. Public intake. Today the marketing form posts to a DIFFERENT Catalyst
      function (formSubmit -> PartnerApplications, PascalCase columns, no
      session), and admin joins it to the org by email-domain suffix match in
      JavaScript. Unifying them is deliberate later work, not a rename. */
api.applicationCreate = todo('POST /partner-applications');

/* 6. LIVE. The five tasks, their individual check states, and the clock. */
api.application = function () {
  return request('GET', '/provider/application').then(function (r) { return check('application', r); });
};
/* 7. LIVE. */
api.applicationRegistration = function (body) { return request('PATCH', '/provider/application/registration', body); };
/* 8. Documents are PII and go to the file store, never through this JSON
      route. Presign is the shape that keeps them out of the function's memory
      and out of any log. */
api.documentPresign = todo('POST /provider/application/documents/presign');
/* 9 */ api.documentConfirm = todo('POST /provider/application/documents');
/* 10. LIVE, read only: which of the two documents are on file. The upload path
       is still 8 and 9. */
api.documents = function () { return request('GET', '/provider/application/documents'); };
/* 11 */ api.documentDelete = todo('DELETE /provider/application/documents/:type');
/* 12. LIVE. Records the consent text hash, so what was agreed to is provable
       later rather than inferred from a version number. */
api.applicationAgreement = function (body) { return request('POST', '/provider/application/agreement', body); };
/* 13. LIVE. One contact, contacted once, never added to any list. */
api.applicationReference = function (body) { return request('POST', '/provider/application/reference', body); };
/* 14. LIVE, and idempotent by contract: stamps submittedAt only if unset, so
       the auto-submit transition cannot start two 48 hour clocks. */
api.applicationSubmit = function () { return request('POST', '/provider/application/submit', {}); };
/* 15. LIVE. The review frame's four rows, from application_tasks rather than
       from a counter. */
api.applicationTimeline = function () { return request('GET', '/provider/application/timeline'); };
/* 16. Admin, not console. In the register because the contract numbers it. */
api.applicationDecision = todo('POST /admin/partner-applications/:id/decision');

/* ---- 7.3 coverage (17-21) ---- */

/* 17. LIVE. */
api.coverage = function () { return synced(session().providerCoverage()); };
/* 18. LIVE. New regions land 'verifying'. */
api.coverageDeclare = function (row) { return session().providerCoverageSave(row); };
/* 19. LIVE as an upsert: the backend keys on `${orgId}:${slug}`, so a patch and
       a create are the same write. */
api.coverageUpdate = function (row) { return session().providerCoverageSave(row); };
/* 20 */ api.coverageRemove = todo('DELETE /provider/coverage/:region');
/* 21. LIVE. Serviceability is asynchronous: declaring returns 'verifying' and
       an admin verify moves it on. Until that route shipped, 'active' was
       unreachable and no cohort ever reached a desk. */
api.serviceability = function (region) {
  return request('GET', '/provider/coverage/' + encodeURIComponent(region) + '/serviceability');
};

/* ---- 7.4 bid desk (22-31) ---- */

/* 22. LIVE. Counts only, plus bidding_open and the server-derived stage. */
api.campaigns = function () { return synced(session().providerCampaigns()); };
/* 23 */ api.campaign = todo('GET /provider/campaigns/:id');
/* 24. LIVE. Aggregates only: household count, renewal window, speed demand
       mix, plant mix, the success fee from config, and the partner's own
       coverage line and own bid. No identities, no other partner's bid, no
       bid count. Fetched on row expand, which also re-anchors the clock. */
api.campaignBrief = function (id) {
  return request('GET', '/provider/campaigns/' + encodeURIComponent(id) + '/brief')
    .then(function (r) { return check('brief', r); });
};
/* 25 */ api.campaignsPlanned = todo('GET /provider/campaigns/planned');
/* 26 */ api.campaignPlan = todo('GET /provider/campaigns/:id/plan');
/* 27 */ api.intentAdd = todo('POST /provider/campaigns/:id/intent');
/* 28 */ api.intentRemove = todo('DELETE /provider/campaigns/:id/intent');
/* 29. Signed, per org, per campaign: a calendar URL is a bearer token that
       lives in someone's phone for a year. */
/* 29 */ api.campaignCalendar = todo('GET /provider/campaigns/:id/calendar');
/* 30 */ api.agenda = todo('GET /provider/agenda');
/* 31. Scoped to declared coverage: search must not become a way to enumerate
       cohorts a partner cannot see. */
/* 31 */ api.search = todo('GET /provider/search');

/* ---- 7.5 bids (32-37) ---- */

/* 32. LIVE. */
api.bids = function () { return synced(session().providerBids()); };
/* 33. LIVE. Place only: an existing bid answers 409 and the improve route is
       the only way forward. Routed through request(), not the session proxy,
       because a refusal here carries fields the console must render (the
       server clock on a close-boundary 409) and the proxy drops them. */
api.bidPlace = function (bid) {
  return request('POST', '/provider/bids', bid)
    .then(function (r) { return check('bidReceipt', r); });
};
/* 34. LIVE. NOT the same as bidPlace. An improvement is a new VERSION and must
       be at least as good on every tier present in both: no raised effective
       price, no shortened guarantee, no worsened after-rate, no reduced
       commitment. The prototype's improve handler deletes the bid and reopens
       the form; that is prototype convenience and did not ship. There is no
       withdraw, and no endpoint anywhere removes a bid. */
api.bidImprove = function (id, bid) {
  return request('POST', '/provider/bids/' + encodeURIComponent(id) + '/improve', bid)
    .then(function (r) { return check('bidReceipt', r); });
};
/* 35. LIVE. The org's own bid, or a 404 identical to never-existed. */
api.bid = function (id) {
  return request('GET', '/provider/bids/' + encodeURIComponent(id));
};
/* 36. LIVE. The sealed revision trail, payloads verbatim. */
api.bidVersions = function (id) {
  return request('GET', '/provider/bids/' + encodeURIComponent(id) + '/versions');
};
/* 37. The record the client already holds, as a file. Ships client-side from
       views/bids.js for now; the server route stays honestly unbuilt. */
/* 37 */ api.bidsExport = todo('GET /provider/bids/export');

/* ---- 7.6 terms and contracts (38-39) ---- */

/* 38. LIVE. A read over records other routes own: the approval decision, the
       registration on the application, the declared coverage, the sealed bid
       heads, and the terms acceptance. Each section degrades on its own, so a
       nullable section means "could not read", never "you have none". */
api.contracts = function () {
  return request('GET', '/provider/contracts').then(function (r) { return check('contracts', r); });
};
/* 39. LIVE, and it gates bidding. If the standard terms change, every org that
       has not accepted the new version is paused: the server refuses the bid
       whatever this console renders. The version being accepted travels in the
       body, so accepting a page that went stale is refused rather than
       recorded against text nobody displayed. */
api.termsAccept = function (body) {
  return request('POST', '/provider/contracts/terms/accept', body);
};

/* ---- 7.7 roster and delivery (40-52) ----
   THE INTIMATION BOUNDARY. routes/campaigns.js states in code that no member
   identity crosses the campaigns route. It crosses here, and only here, and
   only after three server-side checks: an admin-written award row, a completed
   commercial gate, and per-household consent. Before the gate the response
   carries counts and the `orders` key is ABSENT, not empty: absent is
   unambiguous, whereas [] cannot be told apart from "the gate passed and
   nobody signed up", and a client cannot render rows never transmitted.
   Every read of endpoint 43 is audited, which is why rows are fetched on
   view-open and explicit refresh only, and never polled. */

/* 40 */ api.roster = todo('GET /provider/campaigns/:id/roster');
/* 41 */ api.rosterGate = todo('POST /provider/campaigns/:id/roster/gate');
/* 42 */ api.rosterRelease = todo('POST /provider/campaigns/:id/roster/release');
/* 43 */ api.orders = todo('GET /provider/campaigns/:id/orders');
/* 44 */ api.orderSlot = todo('POST /provider/orders/:key/slot');
/* 45. The ONLY event that creates a billable line. Requires a clean line test
       and a confirmed incumbent cancellation. */
/* 45 */ api.orderActivate = todo('POST /provider/orders/:key/activate');
/* 46. Reason comes from RELEASE_REASON, never free text: it feeds the
       serviceability figure that feeds future briefs. */
/* 46 */ api.orderRelease = todo('POST /provider/orders/:key/release');
/* 47. The partner CHOOSES the exception type. The prototype randomises it. */
/* 47 */ api.orderException = todo('POST /provider/orders/:key/exception');
/* 48 */ api.orderRebook = todo('POST /provider/orders/:key/rebook');
/* 49 */ api.capacity = todo('GET /provider/campaigns/:id/capacity');
/* 50 */ api.capacitySave = todo('POST /provider/campaigns/:id/capacity');
/* 51 */ api.logistics = todo('GET /provider/campaigns/:id/logistics');
/* 52 */ api.rma = todo('GET /provider/campaigns/:id/rma');

/* ---- 7.8 billing (53-62) ---- */

/* 53 */ api.billingCycle = todo('GET /provider/billing/cycle');
/* 54 */ api.statements = todo('GET /provider/statements');
/* 55. Lines are computed SERVER SIDE and returned as data. They are not
       stored: a line IS a delivery order in state 'act' inside the period, and
       a second table would be a second source of truth for "did this switch
       complete". The statement row holds only the frozen total at issue, which
       is what makes the reconciliation window meaningful. */
/* 55 */ api.statement = todo('GET /provider/statements/:period');
/* 56 */ api.statementExport = todo('GET /provider/statements/:period/export');
/* 57. Freezes ONE line, never the statement. */
/* 57 */ api.lineDispute = todo('POST /provider/statements/:period/lines/:line/dispute');
/* 58 */ api.paymentMethod = todo('GET /provider/billing/method');
/* 59. A hosted flow. The console never handles raw card data, and no PAN ever
       reaches our servers. */
/* 59 */ api.paymentMethodSession = todo('POST /provider/billing/method/session');
/* 60 */ api.paymentMethodRemove = todo('DELETE /provider/billing/method');
/* 61. Drives the pause banner and disables every place-bid control. The server
       refuses the bid regardless of what the UI allows. */
/* 61 */ api.billingStatus = todo('GET /provider/billing/status');
/* 62. Tax is jurisdiction-driven, computed from the partner's billing
       province. The GTA pilot is Ontario; the model must not hardcode it. */
/* 62 */ api.taxProfile = todo('GET /provider/billing/tax');

/* ---- 7.9 performance (63-64) ---- */

/* 63. Every figure labelled direct, derived or directional. Nothing
       unlabelled, and nothing that is not a real query. */
/* 63 */ api.performance = todo('GET /provider/performance');
/* 64. Publishes only past 25 responses, so one voice cannot be picked out.
       That threshold is enforced in the query, not in the view. */
/* 64 */ api.ratings = todo('GET /provider/performance/ratings');

/* ---- 7.10 account (65-67) ---- */

/* 65. LIVE. Session-gated, already provider-usable. */
api.prefs = function () { return session().prefsGet(); };
/* 66. LIVE. Merges top-level keys only. */
api.prefsSave = function (patch) { return session().prefsSave(patch); };
/* 67. LIVE. Capped at 50 seats server side. */
api.team = function () { return session().providerTeam(); };

/* ------------------------------------------------------------------ *
 * self-check
 *
 * The register's completeness is the whole guarantee, so it is counted here
 * rather than claimed in a comment. scripts/qa-console.mjs asserts 67.
 * ------------------------------------------------------------------ */

var names = Object.keys(api).filter(function (k) { return typeof api[k] === 'function'; });
api.__count = names.length;
api.__implemented = names.filter(function (k) { return !api[k].__todo; }).length;
api.__pending = names.filter(function (k) { return api[k].__todo; }).map(function (k) { return api[k].__path; });

/* Exposed so the fixture layer can replace transport wholesale. */
api.__request = request;

export { api };

/** True when this call is a tagged stub rather than a real route. */
export function isStub(fn) { return !!(fn && fn.__todo); }
