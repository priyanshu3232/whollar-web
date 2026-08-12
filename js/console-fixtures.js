/* Whollar partner console: the 17 fixture states.
 *
 * SEVENTEEN, not the brief's sixteen. Fourteen are the prototype's SCEN array
 * (docs/prototype/provider-console-v12.html:1656-1671) and two are the brief's
 * additions (rejected application, coverage rejected). The seventeenth is
 * `open`, and it exists because the prototype had no fixture for it: its own
 * `open` scenario resets the clock while its first cohort closes 2h14m later,
 * so what that scenario actually renders is the CLOSING state, with the
 * countdown running and the row hot. A genuinely open cohort with a distant
 * close is a different render path and had no coverage. Splitting them is the
 * point of doing this from the data rather than from the scenario names.
 *
 * NOT SHIPPED. This file is listed in .vercelignore, so it is never uploaded
 * to Vercel and the request 404s in every deployed environment regardless of
 * flags, hostname, or a bug in the gate below. That is the guarantee; the
 * runtime checks are a second belt, not the first.
 *
 * Consequence, accepted deliberately: fixture mode works on localhost only,
 * through scripts/dev-server.mjs. That is the right place for it anyway. The
 * dev server proxies /api/auth/* to the LIVE Development Catalyst environment
 * because there is no local emulator, so local runs otherwise write real rows
 * into the same data store the staging site reads.
 *
 *   node scripts/dev-server.mjs
 *   http://localhost:3000/provider-console?fixture=won
 *   http://localhost:3000/provider-console?fixture=won#delivery
 *
 * WHAT A FIXTURE IS. Real-shaped data on the real payload types, not the
 * prototype's demo constants. CAMPAIGNS, COVER, HBIDS, MONTHS and STREETS are
 * deliberately not ported: they encode the prototype's virtual clock and its
 * client-derived stage, and copying them would carry both into the real
 * console. Every timestamp here is relative to a server-supplied `serverTime`,
 * exactly as the API will deliver it.
 *
 * The api object is replaced WHOLESALE. There is no code path where a fixture
 * and a real call interleave, because partial mocking is how you get a demo
 * that passes and a production that does not.
 */
(function (root) {
  "use strict";

  var W = root.WHOLLAR;
  if (!W || !W.console || !W.console.api) return;

  /* Belt two: refuse to install anywhere but a local machine, even if the file
     somehow got served. */
  var host = root.location && root.location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    if (root.console) root.console.warn('[whollar] fixtures refused to install on ' + host);
    return;
  }

  var D = 86400000, H = 3600000;
  var NOW = Date.now();
  var at = function (days, hours) { return NOW + days * D + (hours || 0) * H; };

  /* ---------------------------------------------------------------- *
   * building blocks, on the real payload shapes
   * ---------------------------------------------------------------- */

  function user() {
    return { firstName: 'Sam', lastName: 'Kaur', email: 'sam@northline.ca', userType: 'provider' };
  }
  function org(over) {
    var o = { orgId: 'org-nl', name: 'Northline Internet', role: 'admin', emailDomain: 'northline.ca' };
    for (var k in (over || {})) o[k] = over[k];
    return o;
  }

  /* Stage is SERVER DERIVED. Fixtures state it outright rather than computing
     it from timestamps, because a fixture that computed stage would let the
     client learn to compute stage. */
  /* The shape must match routes/campaigns.js exactly, including the nested
     `dates` object keyed by the real column names. An earlier version of this
     builder used flat closesAt/opensAt, which rendered fine and silently
     killed every countdown, because the view reads dates.bidding_closes_at.
     That is the whole failure mode fixtures exist to prevent, so the campaign
     list now also has a C.check spec: see SPECS.campaignList. */
  function campaign(id, region, stage, over) {
    var dates = {
      announce_at: at(-21), bidding_opens_at: at(-14), bidding_closes_at: at(2),
      offers_at: at(4), decision_at: at(9), switch_window_at: at(23), reconcile_at: at(37)
    };
    for (var k in (over || {})) if (k in dates) { dates[k] = over[k]; delete over[k]; }

    var c = {
      id: id, region: region, sub: 'Autumn cohort', coverageRegion: region,
      kind: stage === 'decided' ? 'closed' : 'auction',
      stage: stage, stageLabel: (W.console.C.STAGE_LABEL[stage] || stage),
      households: 64, members: 64, confirmed: 0,
      bidding_open: stage === 'open' || stage === 'closing',
      dates: dates
    };
    for (var k2 in (over || {})) c[k2] = over[k2];

    /* nextAt is what the server computes with catalog.nextTransition. */
    var order = ['announce_at', 'bidding_opens_at', 'bidding_closes_at', 'offers_at',
      'decision_at', 'switch_window_at', 'reconcile_at'];
    c.nextAt = null; c.nextWhat = null;
    for (var i = 0; i < order.length; i++) {
      if (c.dates[order[i]] && c.dates[order[i]] > NOW) { c.nextAt = c.dates[order[i]]; c.nextWhat = order[i]; break; }
    }
    return c;
  }

  function coverage(rows) {
    return { ok: true, live: true, serverTime: NOW, coverage: rows };
  }
  var COV_ACTIVE = [
    { region: 'North York', slug: 'north-york', status: 'active', techs: ['fibre', 'cable'], topSpeed: '1 Gig', leadTime: '5 business days' },
    { region: 'Scarborough', slug: 'scarborough', status: 'active', techs: ['fibre', 'cable'], topSpeed: '1 Gig', leadTime: '5 business days' },
    { region: 'Markham', slug: 'markham', status: 'verifying', techs: ['fibre'], topSpeed: '1 Gig', leadTime: '5 business days' }
  ];

  /* One order row. `addressLine` is present ONLY after the gate; the fixture
     for a gated roster omits it, so a view can never be written against data
     the server would not have sent. */
  function order(i, state, over) {
    var o = {
      key: 'kw:hh-' + (1041 + i),
      ref: 'WHL-' + (8771 + i * 3) + '-C',
      state: state,
      fsa: 'M1V',
      slotAt: state === 'acc' ? null : at(3 + (i % 3)),
      feeAmount: '95.00'
    };
    for (var k in (over || {})) o[k] = over[k];
    return o;
  }
  function roster(n, mix) {
    var out = [], i = 0, counts = mix || {};
    ['act', 'noshow', 'access', 'linefail', 'rel', 'bkd'].forEach(function (st) {
      for (var j = 0; j < (counts[st] || 0); j++) out.push(order(i++, st, { addressLine: (12 + i * 3) + ' Maple St' }));
    });
    while (out.length < n) out.push(order(i++, 'acc', { addressLine: (12 + i * 3) + ' Maple St' }));
    return out;
  }
  function counts(rows, total) {
    var c = { total: total != null ? total : rows.length };
    W.console.C.ORDER_STATE.forEach(function (s) { c[s] = 0; });
    rows.forEach(function (r) { c[r.state]++; });
    c.exceptions = c.noshow + c.access + c.linefail;
    c.withheld = c.total - rows.length;
    return c;
  }

  var appTasks = function (o) {
    var t = { coverage: 'empty', registration: 'empty', documents: 'empty', agreement: 'empty', reference: 'empty' };
    for (var k in (o || {})) t[k] = o[k];
    return t;
  };

  /* ---------------------------------------------------------------- *
   * the states
   *
   * Fourteen are the prototype's SCEN array (lines 1656-1671), carried over as
   * data rather than as state mutations. Two are the brief's additions, which
   * the prototype has no way to reach.
   * ---------------------------------------------------------------- */

  var S = {};

  S.pending = {
    label: 'Application in progress',
    view: 'pending',
    me: { ok: true, serverTime: NOW, user: user(), org: org({ role: 'admin' }), approved: false },
    application: { ok: true, serverTime: NOW, state: 'draft', tasks: appTasks(), submittedAt: null, decisionDueAt: null },
    coverage: coverage([]),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] }
  };

  S.review = {
    label: 'Under review',
    view: 'pending',
    me: S.pending.me,
    application: {
      ok: true, serverTime: NOW, state: 'under_review',
      tasks: appTasks({ coverage: 'cleared', registration: 'verifying', documents: 'verifying', agreement: 'cleared', reference: 'submitted' }),
      submittedAt: NOW - 6 * H,
      /* 48 hours from SUBMISSION, not from review pickup. */
      decisionDueAt: NOW - 6 * H + 2 * D
    },
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] }
  };

  /* NEW, not reachable in the prototype. A rejection has to say why, and has
     to leave a route forward, or the console is a dead end. */
  S.rejected = {
    label: 'Application rejected',
    view: 'pending',
    me: { ok: true, serverTime: NOW, user: user(), org: org(), approved: false, state: 'rejected' },
    application: {
      ok: true, serverTime: NOW, state: 'rejected',
      tasks: appTasks({ coverage: 'cleared', registration: 'flagged', documents: 'cleared', agreement: 'cleared', reference: 'cleared' }),
      submittedAt: NOW - 3 * D, decidedAt: NOW - 1 * D,
      rejectionReason: 'We could not confirm the CRTC registration number against the public register. If that number is wrong, reply to this and we will reopen the application.'
    },
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] }
  };

  S.first = {
    label: 'First login, no coverage yet',
    view: 'overview',
    me: { ok: true, serverTime: NOW, user: user(), org: org(), approved: true },
    coverage: coverage([]),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] }
  };

  /* NEW. A declared region that failed serviceability. The prototype cannot
     reach this because nothing in the backend moves a region off 'verifying'. */
  S.covrejected = {
    label: 'Coverage rejected',
    view: 'coverage',
    me: S.first.me,
    coverage: coverage([
      COV_ACTIVE[0],
      {
        region: 'Hamilton', slug: 'hamilton', status: 'rejected', techs: ['fibre'], topSpeed: '1 Gig',
        rejectionReason: 'No facilities record for this footprint. If you serve it through a wholesale agreement, send us the agreement reference and we will re-check.'
      }
    ]),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] }
  };

  S.ready = {
    label: 'Ready, nothing open',
    view: 'desk',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough', 'planned', { bidding_opens_at: at(19), bidding_closes_at: at(33), bidding_open: false })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] }
  };

  S.announced = {
    label: 'Cohort announced',
    view: 'desk',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough', 'announced', { bidding_opens_at: at(2), bidding_closes_at: at(16), bidding_open: false })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] }
  };

  S.open = {
    label: 'Bidding open',
    view: 'desk',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [campaign('kw', 'Scarborough', 'open')] },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] }
  };

  /* 'closing' is the last 24 hours: the countdown renders and the row goes
     hot. Server derived, so the fixture states it. */
  S.closing = {
    label: 'Closing inside 24 hours',
    view: 'desk',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough', 'closing', { bidding_closes_at: NOW + 2 * H + 14 * 60000 })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] }
  };

  var SEALED_BID = {
    campaignId: 'kw', version: 1, state: 'sealed', placedAt: NOW - 2 * H,
    reference: 'WB-4368',
    tiers: [
      { name: '500 Mbps', uploadMbps: '50', technology: 'Cable', stickerPrice: '86.00', effectivePrice: '56.00', afterPrice: '69.00' },
      { name: '1 Gig', uploadMbps: '100', technology: 'Cable', stickerPrice: '99.00', effectivePrice: '64.00', afterPrice: '79.00' }
    ],
    reductionPresentation: 'member', guaranteeMonths: 24, afterMode: 'new',
    equipment: 'inc', extraPodMonthly: '0.00', committedHouseholds: 64
  };

  S.sealed = {
    label: 'Bid sealed',
    view: 'desk',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [campaign('kw', 'Scarborough', 'closing', { bidding_closes_at: at(1) })] },
    bids: { ok: true, serverTime: NOW, live: true, bids: [SEALED_BID] }
  };

  S.offersout = {
    label: 'Offers out, nothing to do',
    view: 'desk',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough', 'offers_out', { bidding_closes_at: at(-1), decision_at: at(6), confirmed: 27, bidding_open: false })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [{ ...SEALED_BID, state: 'locked' }] }
  };

  S.won = {
    label: 'Won, roster gated',
    view: 'delivery',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough', 'decided', { confirmed: 41, bidding_open: false, decision_at: at(-1) })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [{ ...SEALED_BID, state: 'won' }] },
    /* THE INTIMATION BOUNDARY. Counts, and no `orders` key at all. Not an
       empty array: absent is unambiguous, and a client cannot render rows that
       were never transmitted. */
    roster: {
      ok: true, serverTime: NOW,
      gate: { passed: false, blocking: 'billing_ready', checks: { award: true, billingReady: false, capacity: false, consent: true } },
      counts: { total: 41, acc: 41, bkd: 0, act: 0, rel: 0, noshow: 0, access: 0, linefail: 0, exceptions: 0, withheld: 41 }
    }
  };

  S.lost = {
    label: 'Not selected',
    view: 'desk',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough', 'decided', { bidding_open: false, decision_at: at(-1) })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [{ ...SEALED_BID, state: 'not_selected' }] }
  };

  var DELIVERY_ROWS = roster(41, { act: 9, rel: 1, bkd: 14, noshow: 1, access: 1, linefail: 1 });
  S.delivery = {
    label: 'Delivery window',
    view: 'delivery',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough', 'decided', { confirmed: 41, bidding_open: false, switch_window_at: at(11) })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [{ ...SEALED_BID, state: 'won' }] },
    roster: {
      ok: true, serverTime: NOW,
      gate: { passed: true, checks: { award: true, billingReady: true, capacity: true, consent: true } },
      counts: counts(DELIVERY_ROWS),
      orders: DELIVERY_ROWS
    }
  };

  var RECON_ROWS = roster(41, { act: 38, rel: 2, bkd: 1 });
  S.reconcile = {
    label: 'Reconciliation',
    view: 'billing',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough', 'decided', { confirmed: 41, bidding_open: false, reconcile_at: at(2) })]
    },
    roster: { ok: true, serverTime: NOW, gate: { passed: true }, counts: counts(RECON_ROWS), orders: RECON_ROWS },
    /* Lines are DERIVED server side from activated orders, and arrive as data.
       The statement holds the frozen total at issue, so the reconciliation
       window can show the delta against the live derivation. */
    statement: {
      ok: true, serverTime: NOW, period: '2026-07', state: 'accruing',
      lines: [
        { id: 'l1', kind: 'success_fee', label: 'Success fees', detail: '$95 x 38 activated households, line test clean', count: 38, amount: '3610.00', state: 'accrued' },
        { id: 'l2', kind: 'credit', label: 'Missed-visit credits', detail: 'pass-through, $25 to each household', count: 0, amount: '0.00', state: 'accrued' }
      ],
      subtotal: '3610.00', tax: { label: 'HST (Ontario, 13%)', registration: '84722 1911 RT0001', amount: '469.30' },
      total: '4079.30', dueAt: at(17)
    }
  };

  S.motion = {
    label: 'Long-running partner',
    view: 'perf',
    me: S.first.me,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [
        campaign('kw', 'Scarborough', 'decided', { confirmed: 41, bidding_open: false }),
        campaign('le', 'North York', 'open', { households: 112, bidding_closes_at: at(18) }),
        /* Markham is 'verifying', not active, so this row renders LOCKED with
           "Verifies with Markham coverage" and no bid control. Without a case
           like this the locked path ships untested, and it is the path a new
           partner meets most: declare a region, see the cohort, cannot bid on
           it yet, and need to be told why. */
        campaign('mk', 'Markham', 'open', { households: 58, bidding_closes_at: at(9) })
      ]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [{ ...SEALED_BID, state: 'won' }] },
    /* Every figure carries its claim class. Nothing renders unlabelled. */
    performance: {
      ok: true, serverTime: NOW,
      metrics: [
        { key: 'winRate', label: 'Win rate', value: '3 of 6', claim: 'direct', note: 'sealed bids to wins, all time' },
        { key: 'completion', label: 'Completion', value: '87%', claim: 'derived', note: 'activated of confirmed' },
        { key: 'serviceability', label: 'Serviceability', value: '96%', claim: 'derived', note: 'declared coverage that proved real at install' },
        { key: 'asBid', label: 'Delivered as bid', value: '100%', claim: 'direct', note: 'day-30 bill checks matched the offer' }
      ],
      ratings: { responses: 18, threshold: 25, published: false }
    }
  };

  S.payfail = {
    label: 'Payment issue, bidding paused',
    view: 'billing',
    me: { ok: true, serverTime: NOW, user: user(), org: org(), approved: true, state: 'bidding_paused' },
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [campaign('kw', 'Scarborough', 'open')] },
    billingStatus: {
      ok: true, serverTime: NOW, state: 'failed', biddingPaused: true,
      invoice: 'WH-2026-07', failedAt: at(-3), pausesAt: at(11),
      message: 'Invoice WH-2026-07 payment failed. Bidding pauses 14 days after a failed invoice.'
    }
  };

  /* ---------------------------------------------------------------- *
   * install
   * ---------------------------------------------------------------- */

  /* Which fixture key answers which api function. Anything a fixture does not
     define answers NOT_IMPLEMENTED, exactly as the real stub would, so a view
     built against fixtures cannot come to rely on data the server will not
     send. */
  var ROUTE = {
    me: 'me', application: 'application', applicationTimeline: 'application',
    coverage: 'coverage', serviceability: 'coverage',
    campaigns: 'campaigns', campaign: 'campaigns', campaignsPlanned: 'campaigns',
    bids: 'bids', bid: 'bids',
    roster: 'roster', orders: 'roster',
    statement: 'statement', statements: 'statement', billingCycle: 'statement',
    performance: 'performance', ratings: 'performance',
    billingStatus: 'billingStatus'
  };

  function install(name) {
    var f = S[name];
    if (!f) {
      if (root.console) root.console.warn('[whollar] unknown fixture "' + name + '". Known: ' + Object.keys(S).join(', '));
      return null;
    }
    var api = W.console.api;
    var live = { prefs: { ok: true, prefs: { notify: {} } }, prefsSave: { ok: true }, team: { ok: true, team: [] }, signOut: { ok: true } };

    Object.keys(api).forEach(function (k) {
      if (typeof api[k] !== 'function' || k.indexOf('__') === 0) return;
      var key = ROUTE[k];
      var data = key && f[key];
      if (!data && Object.prototype.hasOwnProperty.call(live, k)) data = live[k];
      api[k] = data
        ? function () { return Promise.resolve(JSON.parse(JSON.stringify(data))); }
        : (function (path) {
          return function () {
            var e = new Error('That part of the console is not built yet.');
            e.code = 'NOT_IMPLEMENTED'; e.status = 501; e.path = path;
            return Promise.reject(e);
          };
        })(k);
    });

    /* Strict contract checking: under fixtures a shape mismatch is a bug in
       code being written right now and should stop the developer. */
    W.console.C.strict = true;
    W.console.fixture = { name: name, label: f.label, view: f.view };
    if (root.console) root.console.info('[whollar] fixture "' + name + '": ' + f.label);
    return f;
  }

  W.console.fixtures = {
    names: Object.keys(S),
    states: S,
    install: install
  };

  /* Auto-install from ?fixture=, before boot runs. */
  var q = new URLSearchParams(root.location.search).get('fixture');
  if (q) {
    var f = install(q);
    /* Land on the view the state is about, unless the URL already says. */
    if (f && f.view && !root.location.hash) root.location.hash = '#' + f.view;
  }
})(typeof window !== 'undefined' ? window : globalThis);
