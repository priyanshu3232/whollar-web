/* The 19 fixture states.
 *
 * NINETEEN, not the brief's fourteen. Fourteen are the prototype's SCEN array
 * (docs/prototype/provider-console-v12.html:1656-1671), two are additions the
 * prototype cannot reach (a rejected application, a rejected region), the
 * seventeenth is `open`, which exists because the prototype had no fixture for
 * it: its own `open` scenario resets the clock while its first cohort closes
 * 2h14m later, so what that scenario actually renders is the CLOSING state,
 * with the countdown running and the row hot. A genuinely open cohort with a
 * distant close is a different render path and had no coverage at all.
 * Splitting them is the point of doing this from the data rather than from the
 * scenario names. The eighteenth, `infoneeded`, joined when the flagged-task
 * review state shipped, and the nineteenth, `terms`, when the standard cohort
 * terms became a server record with a gate on it.
 *
 * A CLASSIC SCRIPT, deliberately, and not part of the bundle. It is loaded on
 * demand by app.js and scripts/build-console.mjs skips demo/ entirely, so the
 * fixture code cannot reach production even by accident of import.
 *
 * NOT SHIPPED. partner/demo is listed in .vercelignore, so it is never
 * uploaded and the request 404s in every deployed environment regardless of
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
 *   http://localhost:3000/partner?fixture=won
 *   http://localhost:3000/partner?fixture=won#delivery
 *
 * WHAT A FIXTURE IS. Real-shaped data on the real payload types, not the
 * prototype's demo constants. CAMPAIGNS, COVER, HBIDS, MONTHS and STREETS are
 * deliberately not ported: they encode the prototype's virtual clock and its
 * client-derived stage, and copying them would carry both into the real
 * console.
 *
 * Three rules, each of which is a rule about the real API:
 *
 *   1. Nothing computes a stage. Every fixture states it outright, because the
 *      server derives it. A fixture that computed stage from timestamps would
 *      teach the client to compute stage from timestamps.
 *   2. Timestamps are relative to a supplied serverTime, in epoch
 *      milliseconds, exactly as the API delivers it.
 *   3. The gated roster has no `orders` key at all, rather than an empty
 *      array. See `won` versus `delivery`.
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
    /* orgs.contextFor()'s shape EXACTLY, orgName and not name. The old key
       here agreed with the console's old bug, so the suite went green over an
       Account screen that said "Company: Not on file". contract.js providerOrg
       now refuses `name`, which is what keeps these two honest. */
    var o = { orgId: 'org-nl', orgName: 'Northline Internet', role: 'admin', approvalStatus: 'approved', approved: true };
    for (var k in (over || {})) o[k] = over[k];
    return o;
  }

  /* The shape must match routes/campaigns.js exactly, including the nested
     `dates` object keyed by the real column names. An earlier version of this
     builder used a flat closesAt, which rendered fine and silently killed
     every countdown, because the view reads dates.bidding_closes_at. That is
     the whole failure mode fixtures exist to prevent, which is why the
     campaign list also carries a contract spec. */
  function campaign(id, region, stage, over) {
    var dates = {
      announce_at: at(-21), bidding_opens_at: at(-14), bidding_closes_at: at(2),
      offers_at: at(4), decision_at: at(9), switch_window_at: at(23), reconcile_at: at(37)
    };
    for (var k in (over || {})) if (k in dates) { dates[k] = over[k]; delete over[k]; }

    var LABEL = {
      planned: 'Planned', announced: 'Announced', open: 'Open',
      closing: 'Closing', offers_out: 'Offers out', decided: 'Decided'
    };
    var c = {
      id: id, region: region, sub: 'Autumn cohort', coverageRegion: region,
      kind: stage === 'decided' ? 'closed' : 'auction',
      stage: stage, stageLabel: LABEL[stage] || stage,
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
    { region: 'North York Central', slug: 'north-york-central', status: 'active', techs: ['fibre', 'cable'], speed: '1 Gig', lead: '5 business days' },
    { region: 'Scarborough East', slug: 'scarborough-east', status: 'active', techs: ['fibre', 'cable'], speed: '1 Gig', lead: '5 business days' },
    { region: 'Markham North', slug: 'markham-north', status: 'verifying', techs: ['fibre'], speed: '1 Gig', lead: '5 business days' },
    /* A neighbour, so the desk reads like a real footprint rather than one
       district per demo, and so the picker has an "Already declared" row to
       show inside a municipality that also has free ones. */
    { region: 'Scarborough Centre', slug: 'scarborough-centre', status: 'active', techs: ['fibre'], speed: '500 Mbps', lead: '7 business days' },
    /* The two 'soon' rows. They are a platform state, not a partner one, and
       until this pair existed nothing exercised that branch: no fixture, no
       "Queued for launch" row, and no check that the application counts
       declared regions WITHOUT them.

       Both name a REGION inside a queued city, not the city: since the picker
       became city-then-region a bare "Hamilton" is a city with eight regions
       under it and not something a partner can declare. scripts/test-places.mjs
       is the gate that says so. */
    { region: 'Downtown Hamilton', slug: 'downtown-hamilton', status: 'soon', techs: ['fibre'], speed: '1 Gig', lead: '10 business days' },
    { region: 'Downtown Ottawa', slug: 'downtown-ottawa', status: 'soon', techs: ['fibre'], speed: '1 Gig', lead: '10 business days' }
  ];

  /* One order row. `addressLine` is present ONLY after the gate; the fixture
     for a gated roster omits the rows entirely, so a view can never be written
     against data the server would not have sent. */
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
  var ORDER_STATES = ['acc', 'bkd', 'act', 'rel', 'noshow', 'access', 'linefail'];
  function counts(rows, total) {
    var c = { total: total != null ? total : rows.length };
    ORDER_STATES.forEach(function (s) { c[s] = 0; });
    rows.forEach(function (r) { c[r.state]++; });
    c.exceptions = c.noshow + c.access + c.linefail;
    c.withheld = c.total - rows.length;
    return c;
  }

  function tasks(o) {
    var t = { coverage: 'empty', registration: 'empty', documents: 'empty', agreement: 'empty', reference: 'empty' };
    for (var k in (o || {})) t[k] = o[k];
    return t;
  }

  /* The contracts registry. Derived from the fixture's own me/coverage/bids so
     it cannot say "signed" for an org the same fixture has under review, which
     is the class of drift a hand-written registry payload invites. `terms` is
     the one part a fixture overrides, because the accept path and the ticket's
     terms gate are the two things worth exercising here. */
  function contracts(f, termsOver) {
    var approved = !!(f.me && f.me.approved);
    var cov = (f.coverage && f.coverage.coverage) || [];
    var list = ((f.bids && f.bids.bids) || []);
    var t = { docType: 'cohort_terms', version: 'v1', acceptedVersion: 'v1',
      acceptedAt: NOW - 7 * D, acceptedBy: 'sam@northline.ca', current: true, live: true };
    for (var k in (termsOver || {})) t[k] = termsOver[k];
    return {
      ok: true, serverTime: NOW, live: true,
      terms: t,
      msa: { state: approved ? 'signed' : 'pending', signedAt: approved ? NOW - 7 * D : null },
      registration: { crtc: '8740-N42', state: approved ? 'cleared' : 'verifying' },
      schedule: {
        declared: cov.length,
        active: cov.filter(function (r) { return r.status === 'active'; }).length,
        regions: cov.map(function (r) { return r.region; })
      },
      receipts: {
        cohorts: list.length,
        sealed: list.reduce(function (n, b) { return n + (b.version || 1); }, 0)
      }
    };
  }

  /* ---------------------------------------------------------------- *
   * the states
   * ---------------------------------------------------------------- */

  var S = {};

  S.pending = {
    label: 'Application in progress',
    view: 'overview',
    me: { ok: true, serverTime: NOW, user: user(), org: org({ role: 'admin' }), approved: false },
    application: { ok: true, serverTime: NOW, state: 'draft', tasks: tasks(), submittedAt: null, decisionDueAt: null },
    coverage: coverage([]),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] }
  };

  S.review = {
    label: 'Under review, 48 hour clock running',
    view: 'pending',
    me: S.pending.me,
    application: {
      ok: true, serverTime: NOW, state: 'under_review',
      tasks: tasks({ coverage: 'cleared', registration: 'verifying', documents: 'verifying', agreement: 'cleared', reference: 'submitted' }),
      submittedAt: NOW - 6 * H,
      /* 48 hours from COMPLETION, not from review pickup. */
      decisionDueAt: NOW - 6 * H + 2 * D
    },
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] }
  };

  /* One task flagged. Without this state a failed check is a silent stall: the
     partner sees "under review" forever and never learns which number did not
     match. */
  S.infoneeded = {
    label: 'Information needed',
    view: 'pending',
    me: S.pending.me,
    application: {
      ok: true, serverTime: NOW, state: 'info_needed',
      tasks: tasks({ coverage: 'cleared', registration: 'flagged', documents: 'cleared', agreement: 'cleared', reference: 'cleared' }),
      submittedAt: NOW - 2 * D,
      reviewNote: 'The CRTC registration number did not match the public register. If it is a typo, correct it and we will re-check the same day.'
    },
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] }
  };

  /* A rejection has to say why and leave a route forward, or the console is a
     dead end. The prototype cannot reach this state at all. */
  S.rejected = {
    label: 'Application declined',
    view: 'pending',
    me: { ok: true, serverTime: NOW, user: user(), org: org(), approved: false, state: 'rejected' },
    application: {
      ok: true, serverTime: NOW, state: 'rejected',
      tasks: tasks({ coverage: 'cleared', registration: 'flagged', documents: 'cleared', agreement: 'cleared', reference: 'cleared' }),
      submittedAt: NOW - 3 * D, decidedAt: NOW - 1 * D, reapplyAfter: NOW + 60 * D,
      decisionNote: 'We could not confirm the CRTC registration against the public register, and the operating reference did not respond within our window.'
    },
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] }
  };

  var APPROVED_ME = { ok: true, serverTime: NOW, user: user(), org: org(), approved: true };
  var APPROVED_APP = { ok: true, serverTime: NOW, state: 'approved', tasks: tasks({ coverage: 'cleared', registration: 'cleared', documents: 'cleared', agreement: 'cleared', reference: 'cleared' }), submittedAt: NOW - 9 * D, decidedAt: NOW - 7 * D };

  S.first = {
    label: 'First login, no coverage yet',
    view: 'overview',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage([]),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] }
  };

  /* A declared region that failed serviceability. Unreachable until the admin
     verify and reject routes shipped: before that every region sat in
     'verifying' forever. */
  S.covrejected = {
    label: 'Coverage rejected',
    view: 'coverage',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage([
      COV_ACTIVE[0],
      {
        region: 'Etobicoke North', slug: 'etobicoke-north', status: 'rejected', techs: ['fibre'], speed: '1 Gig',
        rejectionReason: 'No facilities record for this footprint.'
      }
    ]),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [] }
  };

  S.ready = {
    label: 'Ready, nothing open',
    view: 'desk',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough East', 'planned', { bidding_opens_at: at(19), bidding_closes_at: at(33), bidding_open: false })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] }
  };

  S.announced = {
    label: 'Cohort announced',
    view: 'desk',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough East', 'announced', { bidding_opens_at: at(2), bidding_closes_at: at(16), bidding_open: false })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] }
  };

  S.open = {
    label: 'Bidding open, close still distant',
    view: 'desk',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [campaign('kw', 'Scarborough East', 'open')] },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] },
    brief: brief(campaign('kw', 'Scarborough East', 'open'), null),
    bidResult: sealedReceipt('sealed', 1, 'WB-4368')
  };

  /* Approved, a cohort open, and the standard cohort terms not accepted. The
     server refuses a bid in this state, so the desk must not offer one: this
     is the fixture that catches a ticket which renders "Place sealed bid"
     anyway. It also carries an OLDER acceptance, which is the harder half:
     bidding pauses on a version bump, and "you accepted v1, v2 is in force" is
     a different sentence from "you have never accepted". */
  S.terms = {
    label: 'Terms version bumped, bidding paused',
    view: 'contracts',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [campaign('kw', 'Scarborough East', 'open')] },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] },
    brief: brief(campaign('kw', 'Scarborough East', 'open'), null)
  };
  S.terms.contracts = contracts(S.terms, {
    version: 'v2', acceptedVersion: 'v1', acceptedAt: NOW - 40 * D, current: false
  });
  /* Accepting inside the fixture lands on v2, which is what unlocks the desk
     in the same session. */
  S.terms.termsAccepted = {
    ok: true, serverTime: NOW,
    terms: { docType: 'cohort_terms', version: 'v2', acceptedVersion: 'v2', acceptedAt: NOW,
      acceptedBy: 'sam@northline.ca', current: true, live: true }
  };

  /* 'closing' is the last 24 hours: the countdown renders and the row goes
     hot. Server derived, so the fixture states it. */
  S.closing = {
    label: 'Closing inside 24 hours',
    view: 'desk',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough East', 'closing', { bidding_closes_at: NOW + 2 * H + 14 * 60000 })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [] },
    brief: brief(campaign('kw', 'Scarborough East', 'closing', { bidding_closes_at: NOW + 2 * H + 14 * 60000 }), null),
    bidResult: sealedReceipt('sealed', 1, 'WB-4368')
  };

  var SEALED_BID = {
    campaignId: 'kw', version: 1, state: 'sealed', placedAt: NOW - 2 * H,
    reference: 'WB-4368',
    tiers: [
      { name: '500 Mbps', uploadMbps: '50', technology: 'cable', stickerPrice: '86.00', effectivePrice: '56.00', afterPrice: '69.00' },
      { name: '1 Gig', uploadMbps: '100', technology: 'cable', stickerPrice: '99.00', effectivePrice: '64.00', afterPrice: '79.00' }
    ],
    reductionPresentation: 'member', guaranteeMonths: 24, afterMode: 'new',
    afterLine: '$69 / 500 Mbps, $79 / 1 Gig',
    equipment: 'inc', extraPodMonthly: null, committedHouseholds: 64
  };
  function bidIn(state, over) {
    var b = {}; for (var k in SEALED_BID) b[k] = SEALED_BID[k];
    b.state = state;
    /* A decided bid carries its own result the way GET /provider/bids answers
       it: the tiers this bid took, the confirmed count, and the per-tier
       breakdown. Nothing about any other partner. */
    if (state === 'won') {
      b.tiersWon = ['500 Mbps', '1 Gig'];
      b.confirmed = 41;
      b.won = [
        { tier: '500 Mbps', price: '56', demandCount: 26, confirmed: 24 },
        { tier: '1 Gig', price: '64', demandCount: 27, confirmed: 17 }
      ];
    }
    if (state === 'not_selected') b.tiersWon = [];
    for (var k2 in (over || {})) b[k2] = over[k2];
    return b;
  }

  /* The brief payload, shaped exactly as GET /provider/campaigns/:id/brief
     answers: the freshly staged campaign, aggregates only, the org's OWN
     coverage line, the org's OWN bid or null. The fee is config, never a
     client constant, which is why it arrives in the payload. */
  function brief(c, bid) {
    return {
      ok: true, serverTime: NOW,
      campaign: c,
      brief: {
        households: c.households,
        renewalWindow: 'Oct to Dec',
        speedMix: [['1 Gig', 42], ['500 Mbps', 41], ['Under 500', 17]],
        plantMix: [['Cable', 58], ['FTTP', 33], ['FTTN', 9]],
        successFee: '95'
      },
      coverage: { declared: true, region: c.region, status: 'active', techs: ['fibre', 'cable'], speed: '1 Gig', lead: '5 business days' },
      bid: bid || null
    };
  }

  /* What a place or improve answers: the new head and the sealed receipt. */
  function sealedReceipt(state, revision, no, over) {
    return {
      ok: true, serverTime: NOW,
      bid: bidIn(state, over),
      receipt: { no: no, revision: revision, receivedAt: NOW }
    };
  }

  /* The sealed state carries the revision trail: version 2 standing, both
     revisions on record, because append-only is the thing this state exists
     to demonstrate. An improve answers version 3. */
  var SEALED_V2 = bidIn('sealed', { version: 2 });
  S.sealed = {
    label: 'Bid sealed, improvable until close',
    view: 'desk',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [campaign('kw', 'Scarborough East', 'closing', { bidding_closes_at: at(1) })] },
    bids: { ok: true, serverTime: NOW, live: true, bids: [SEALED_V2] },
    brief: brief(campaign('kw', 'Scarborough East', 'closing', { bidding_closes_at: at(1) }), SEALED_V2),
    bidResult: sealedReceipt('improved', 3, 'WB-77AB', { version: 3 }),
    bidVersions: {
      ok: true, serverTime: NOW,
      versions: [
        {
          revision: 1, receipt: 'WB-9E21', receivedAt: NOW - 26 * H,
          payload: { campaignId: 'kw', tiers: [{ name: '500 Mbps', uploadMbps: '50', technology: 'cable', stickerPrice: '86.00', effectivePrice: '59.00', afterPrice: '72.00' }], guaranteeMonths: 24, committedHouseholds: 60 }
        },
        {
          revision: 2, receipt: 'WB-4368', receivedAt: NOW - 2 * H,
          payload: { campaignId: 'kw', tiers: SEALED_BID.tiers, guaranteeMonths: 24, committedHouseholds: 64 }
        }
      ]
    }
  };

  /* A sealed CUSTOM bid with a mix per tier: what the improve form has to
     hydrate from, exactly as sealed. The cents are what lib/mixmath.js lands
     on for these shares (500 Mbps, gap $30.00 at 60/40; 1 Gig, gap $35.00 on
     one row), because the fixture is the executable contract for publicBid()
     and the snapshot is the record households read. */
  var MIXED_BID = bidIn('sealed', {
    reductionPresentation: 'custom', mechanismLabel: 'Member discount, Promotional credit',
    discountMix: {
      applyToAll: false,
      tiers: [
        { tier: '500 Mbps', stickerCents: 8600, effectiveCents: 5600, gapCents: 3000, mix: [
          { type: 'member', label: 'Member discount', sharePct: '60', amountCents: 1800, periodStartMo: 0, periodEndMo: 24 },
          { type: 'promo', label: 'Promotional credit', sharePct: '40', amountCents: 1200, periodStartMo: 0, periodEndMo: 24 }
        ] },
        { tier: '1 Gig', stickerCents: 9900, effectiveCents: 6400, gapCents: 3500, mix: [
          { type: 'own', label: 'Neighbourhood build rate', sharePct: '100', amountCents: 3500, periodStartMo: 0, periodEndMo: 24 }
        ] }
      ]
    }
  });
  S.mixed = {
    label: 'Bid sealed with a custom mix, per tier',
    view: 'desk',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [campaign('kw', 'Scarborough East', 'closing', { bidding_closes_at: at(1) })] },
    bids: { ok: true, serverTime: NOW, live: true, bids: [MIXED_BID] },
    brief: brief(campaign('kw', 'Scarborough East', 'closing', { bidding_closes_at: at(1) }), MIXED_BID),
    bidResult: sealedReceipt('improved', 2, 'WB-77AB', { version: 2 })
  };

  S.offersout = {
    label: 'Offers out, nothing to do',
    view: 'desk',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough East', 'offers_out', { bidding_closes_at: at(-1), decision_at: at(6), confirmed: 27, bidding_open: false })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [bidIn('locked')] },
    brief: brief(campaign('kw', 'Scarborough East', 'offers_out', { bidding_closes_at: at(-1), decision_at: at(6), confirmed: 27, bidding_open: false }), bidIn('locked'))
  };

  S.won = {
    label: 'Won, roster gated',
    view: 'delivery',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough East', 'decided', { confirmed: 41, bidding_open: false, decision_at: at(-1) })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [bidIn('won')] },
    brief: brief(campaign('kw', 'Scarborough East', 'decided', { confirmed: 41, bidding_open: false, decision_at: at(-1) }), bidIn('won')),
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
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough East', 'decided', { bidding_open: false, decision_at: at(-1) })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [bidIn('not_selected')] },
    brief: brief(campaign('kw', 'Scarborough East', 'decided', { bidding_open: false, decision_at: at(-1) }), bidIn('not_selected'))
  };

  /* Decided, and we never bid on it. The state the v12 prototype had no panel
     for: its ticketHTML selected on `st>=4 && mine`, then `st===3`, then
     `mine`, and fell through to the bid form, so this cohort used to open a
     seven-column pricing table for an auction that ended yesterday. There is
     no `bids` key here on purpose, and that absence IS the fixture. */
  S.nobid = {
    label: 'Decided, and we did not bid',
    view: 'desk',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough East', 'decided', { bidding_closes_at: at(-3), bidding_open: false, decision_at: at(-1) })]
    },
    brief: brief(campaign('kw', 'Scarborough East', 'decided', { bidding_closes_at: at(-3), bidding_open: false, decision_at: at(-1) }), null)
  };

  var DELIVERY_ROWS = roster(41, { act: 9, rel: 1, bkd: 14, noshow: 1, access: 1, linefail: 1 });
  S.delivery = {
    label: 'Delivery window, exceptions live',
    view: 'delivery',
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough East', 'decided', { confirmed: 41, bidding_open: false, switch_window_at: at(11) })]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [bidIn('won')] },
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
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [campaign('kw', 'Scarborough East', 'decided', { confirmed: 41, bidding_open: false, reconcile_at: at(2) })]
    },
    roster: { ok: true, serverTime: NOW, gate: { passed: true }, counts: counts(RECON_ROWS), orders: RECON_ROWS },
    /* Lines are DERIVED server side from activated orders and arrive as data.
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
    me: APPROVED_ME, application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: {
      ok: true, serverTime: NOW, live: true,
      campaigns: [
        campaign('kw', 'Scarborough East', 'decided', { confirmed: 41, bidding_open: false }),
        campaign('le', 'North York Central', 'open', { households: 112, bidding_closes_at: at(18) }),
        /* Markham North is 'verifying', not active, so this row renders LOCKED
           with "Verifies with Markham North coverage" and no bid control. Without a case
           like this the locked path ships untested, and it is the path a new
           partner meets most: declare a region, see the cohort, cannot bid on
           it yet, and need to be told why. */
        campaign('mk', 'Markham North', 'open', { households: 58, bidding_closes_at: at(9) })
      ]
    },
    bids: { ok: true, serverTime: NOW, live: true, bids: [bidIn('won')] },
    brief: brief(campaign('kw', 'Scarborough East', 'decided', { confirmed: 41, bidding_open: false }), bidIn('won')),
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
    application: APPROVED_APP,
    coverage: coverage(COV_ACTIVE),
    campaigns: { ok: true, serverTime: NOW, live: true, campaigns: [campaign('kw', 'Scarborough East', 'open')] },
    billingStatus: {
      ok: true, serverTime: NOW, state: 'failed', biddingPaused: true,
      invoice: 'WH-2026-07', failedAt: at(-3), pausesAt: at(11),
      message: 'Statement WH-2026-07 payment failed. Bidding pauses 14 days after a failed statement.'
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
    me: 'me',
    application: 'application', applicationTimeline: 'application',
    applicationRegistration: 'application', applicationAgreement: 'application',
    applicationReference: 'application', applicationSubmit: 'application',
    documents: 'documents',
    coverage: 'coverage', serviceability: 'coverage',
    campaigns: 'campaigns', campaign: 'campaigns', campaignsPlanned: 'campaigns',
    campaignBrief: 'brief',
    bids: 'bids', bid: 'bids',
    bidPlace: 'bidResult', bidImprove: 'bidResult', bidVersions: 'bidVersions',
    /* Two shapes, two keys, and they are NOT interchangeable. GET
       /provider/campaigns/:id/roster answers one cohort, `{ gate, counts,
       orders }`; GET /provider/orders answers every cohort the org holds,
       wrapped as `{ cohorts: [...] }`. Both pointed at 'roster' here, so
       api.orders() handed the delivery board a payload with no `cohorts` key,
       load() read `r.cohorts || []`, and ?fixture=delivery rendered the empty
       "your first delivery board builds itself" state. The sweep in group 11
       only asserts a fixture paints something, so it stayed green for a
       fixture labelled "Delivery window, exceptions live" that showed no
       delivery window at all. ordersList is derived in install(). */
    roster: 'roster', orders: 'ordersList',
    /* The BRAND roster and the reach count, section 10.5: a demo console reads
       fixture rows and never a real exclusion. Unmapped methods reject with
       501 here, so leaving these out would already have been safe; they are
       mapped so the panel shows a plausible declaration instead of "we could
       not read your roster", which reads as broken rather than as a demo. */
    brandRoster: 'brandRoster', reach: 'reach', cohortResults: 'cohortResults',
    statement: 'statement', statements: 'statement', billingCycle: 'statement',
    performance: 'performance', ratings: 'performance',
    billingStatus: 'billingStatus',
    contracts: 'contracts', termsAccept: 'termsAccepted'
  };

  function install(name) {
    var f = S[name];
    if (!f) {
      if (root.console) root.console.warn('[whollar] unknown fixture "' + name + '". Known: ' + Object.keys(S).join(', '));
      return null;
    }
    var api = W.console.api;
    /* Every state gets a registry unless it states its own, so the Contracts
       view and the ticket's terms gate render in all of them rather than only
       in the one written for them. Accepting inside a fixture returns the
       accepted registry, which is what the view sets straight back into the
       store. */
    if (!f.contracts) f.contracts = contracts(f);
    if (!f.termsAccepted) {
      f.termsAccepted = { ok: true, serverTime: NOW, terms: contracts(f).terms };
    }
    /* The board's envelope, derived from the single-cohort roster a fixture
       already declares, so a state describes its roster once. `orders` is
       carried only when the gate passed, ABSENT and not empty otherwise:
       that absence is what the picker and the ticket both read as "still
       gated", and an empty array would read as a released roster of nobody. */
    if (f.roster && !f.ordersList) {
      var rc = (f.campaigns && f.campaigns.campaigns && f.campaigns.campaigns[0]) || null;
      var rg = f.roster.gate || {};
      /* The two routes name the same three checks differently: the per-cohort
         roster route sends `checks.billingReady`, awards.publicAward sends
         `gate.billing`. The board reads the second, so translate rather than
         pass through, or every gate row renders unmet. */
      var chk = rg.checks || {};
      var passed = !!rg.passed;
      var capOk = passed || !!chk.capacity;
      var cohort = {
        campaignId: rc ? rc.id : 'kw',
        counts: f.roster.counts,
        award: {
          campaignId: rc ? rc.id : 'kw',
          capacityWeekly: capOk ? 12 : 0,
          gate: {
            billing: passed || !!chk.billingReady,
            capacity: capOk,
            consent: passed || !!chk.consent,
            releasedAt: passed ? NOW - 2 * H : null
          }
        }
      };
      if (passed) cohort.orders = f.roster.orders;
      f.ordersList = { ok: true, serverTime: NOW, live: true, cohorts: [cohort] };
    }
    var live = {
      prefs: { ok: true, prefs: { notify: {} } },
      prefsSave: { ok: true },
      team: { ok: true, team: [] },
      signOut: { ok: true },
      /* NAMESPACED FIXTURE VALUES, never a real read. The brands are invented
         names, deliberately not real Canadian carriers: a demo that shows
         "Bell" beside a household count invites a screenshot that looks like a
         real partner's real reach. */
      brandRoster: {
        ok: true, available: true, attested: true, attestedAt: null,
        brands: [
          { brand_id: 'demo-fibrelink', display_name: 'FibreLink', parent_brand_id: null },
          { brand_id: 'demo-fibrelink-go', display_name: 'FibreLink Go', parent_brand_id: 'demo-fibrelink' }
        ],
        registry: [
          { brand_id: 'demo-fibrelink', display_name: 'FibreLink', parent_brand_id: null, status: 'active' },
          { brand_id: 'demo-fibrelink-go', display_name: 'FibreLink Go', parent_brand_id: 'demo-fibrelink', status: 'active' },
          { brand_id: 'demo-northline', display_name: 'Northline', parent_brand_id: null, status: 'active' }
        ]
      },
      brandRosterDeclare: { ok: true, brands: [], attestedAt: null },
      brandRequest: { ok: true, brand_id: 'demo-pending', status: 'pending_review' },
      reach: {
        ok: true, available: true,
        total_households: 112, reachable_households: 104, snapshot_at: null
      },
      cohortResults: {
        ok: true, available: true,
        households_won: 61, households_outranked: 43,
        households_unreachable_exclusions: 8
      }
    };

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

    W.console.fixture = { name: name, label: f.label, view: f.view };
    if (root.console) root.console.info('[whollar] fixture "' + name + '": ' + f.label);
    return f;
  }

  W.console.fixtures = { names: Object.keys(S), states: S, install: install };

  /* Auto-install from ?fixture=, before boot runs. */
  var q = new URLSearchParams(root.location.search).get('fixture');
  if (q) install(q);
})(typeof window !== 'undefined' ? window : globalThis);
