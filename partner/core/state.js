/* One store. Views subscribe; nothing reads the DOM to decide what to draw.
 *
 * The prototype kept two globals, S and P, and mutated them from inside render
 * functions: expandRow() set S.tasks.brief as a side effect of drawing a row.
 * That is why its render order mattered and why a clock tick could change what
 * the checklist said. Here a render is pure from state, and state changes only
 * through set().
 *
 * SLICES, NOT A MERGE. set('coverage', rows) replaces the slice outright. A
 * deep merge would leave a deleted region on screen after the server stopped
 * sending it, which is the exact class of bug that makes a console look stale
 * rather than broken.
 */

var state = {
  /* who */
  partner: null,        /* the local record from whollar-login-provider */
  user: null,           /* GET /provider/me */
  org: null,
  approved: false,
  role: null,

  /* application */
  application: null,    /* GET /provider/application, null until it answers */
  /* Whether that read has SETTLED, which is not the same question. Null means
     both "still in flight" and "the route answered with nothing", and the
     gated frame needs to tell those apart: gating on the record alone left the
     full console, pane and search and all, painted around a loading card for
     as long as the round trip took. */
  applicationLoaded: false,
  documents: null,

  /* what they can bid on */
  coverage: [],
  coverageLive: true,
  campaigns: [],
  campaignsLive: true,
  bids: {},             /* keyed by campaign id */
  briefs: {},           /* GET .../brief payloads keyed by campaign id;
                           'loading' while in flight, { failed: true } on error */

  /* what binds them */
  contracts: null,      /* GET /provider/contracts, null until it answers */
  contractsError: null, /* why it did not answer: { status, code, message }.
                           Kept because "refused" and "still loading" are the
                           same blank card otherwise, and only one of them is
                           something a partner can act on. */

  /* what they have won, and what it is worth */
  delivery: null,       /* GET /provider/orders; 'loading' while in flight.
                           Fetched on view-open and explicit refresh only: a
                           released roster carries addresses and every read of
                           one is audited server side, so polling it would
                           write an audit row a minute, forever. */
  deliveryCohort: null, /* which won cohort the board is showing */
  billing: null,        /* GET /provider/statements; 'loading' while in flight */

  /* health */
  biddingPaused: false,
  biddingNotice: null,
  billing: null,

  /* view-local, deliberately in the store so a re-render cannot lose it */
  covEdit: null,        /* region slug being edited inline */
  covDraft: null,       /* chip state while editing */
  openCampaign: null,   /* the desk row currently expanded */
  ticketDraft: null,    /* the in-progress bid ticket, so a repaint cannot eat
                           a half-typed bid; the prototype's expandRow-mutates-
                           state bug is the cautionary tale above */

  prefs: null,
  fixture: null         /* { name, label, view } under fixture mode */
};

var subs = [];

/** Read the whole state. Treat it as read-only; write through set(). */
export function get() { return state; }

/**
 * Replace one or more slices and notify subscribers once.
 * set('coverage', rows) or set({ coverage: rows, coverageLive: true }).
 */
export function set(slice, value) {
  var changed = [];
  if (typeof slice === 'string') {
    if (state[slice] !== value) { state[slice] = value; changed.push(slice); }
  } else {
    for (var k in slice) {
      if (!Object.prototype.hasOwnProperty.call(slice, k)) continue;
      if (state[k] !== slice[k]) { state[k] = slice[k]; changed.push(k); }
    }
  }
  if (changed.length) notify(changed);
  return state;
}

/**
 * Subscribe to any change. The callback receives the changed slice names, so a
 * view can skip work it does not care about without needing per-key channels.
 */
export function subscribe(fn) {
  subs.push(fn);
  return function () {
    var i = subs.indexOf(fn);
    if (i >= 0) subs.splice(i, 1);
  };
}

/* A subscriber that throws must not stop the others rendering. A half-painted
   console is recoverable; a console where view three broke views four through
   eleven is not diagnosable from a screenshot. */
function notify(changed) {
  subs.slice().forEach(function (fn) {
    try { fn(state, changed); } catch (e) {
      if (typeof console !== 'undefined' && console.error) console.error('[whollar] subscriber failed:', e);
    }
  });
}

/** Force a full repaint, for the boot path and after a wholesale reload. */
export function refresh() { notify(Object.keys(state)); }

/* ------------------------------------------------------------------ *
 * derived reads
 *
 * Kept here rather than in views so that two views cannot answer the same
 * question differently. Every one of these is a pure function of state.
 * ------------------------------------------------------------------ */

/** Regions that verified. Only these produce a biddable cohort. */
export function activeCoverage() {
  return state.coverage.filter(function (c) { return c.status === 'active'; });
}

/** Cohorts whose region has verified. A cohort in a 'verifying' region is
    visible but locked, which is the state a new partner meets most. */
export function biddableCampaigns() {
  var active = {};
  activeCoverage().forEach(function (c) { active[slug(c.region)] = true; });
  return state.campaigns.filter(function (a) { return active[slug(a.coverageRegion || a.region)]; });
}

function slug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Where the org stands on the standard cohort terms, in three states rather
 * than two.
 *
 * 'unknown' is the one that matters. Between boot and the contracts payload
 * arriving, `contracts` is null, and collapsing that to "not accepted" would
 * flash "accept the standard terms to bid" at a partner who accepted months
 * ago, every single load. The bid ticket therefore prompts only on 'pending'
 * and leaves its button alone on 'unknown': the server refuses the bid either
 * way, so guessing buys nothing and costs a lie.
 */
export function termsState() {
  var t = state.contracts && state.contracts.terms;
  if (!t) return 'unknown';
  return t.current ? 'accepted' : 'pending';
}

/** How many of the five application tasks have cleared or been submitted. */
export function applicationProgress() {
  var tasks = (state.application && state.application.tasks) || {};
  var keys = Object.keys(tasks);
  var done = keys.filter(function (k) { return tasks[k] !== 'empty'; });
  return { done: done.length, total: keys.length || 5, tasks: tasks };
}

/** True when every task has left 'empty'. The 48 hour clock starts here. */
export function applicationComplete() {
  var p = applicationProgress();
  return p.total > 0 && p.done === p.total;
}
