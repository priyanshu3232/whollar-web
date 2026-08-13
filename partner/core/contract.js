/* The contract: enums the server mirrors, and a runtime validator.
 *
 * WHAT THIS IS FOR. The console talks to a Zoho Catalyst backend whose tables
 * are created BY HAND in a web console (there is no DDL API, see
 * catalyst-backend/scripts/create-tables.md). There is no shared code across
 * that boundary, so a compile-time contract would check this file against
 * itself and prove nothing. What actually breaks is the seam: a column typed
 * Int where the client expects a string, a status that came back as
 * 'verifying ' with a trailing space, a table that exists in Development and
 * not in Production. So the contract is checked at RUNTIME, against the real
 * response, which is the only place those show up.
 */

/* ------------------------------------------------------------------
   ENUMS

   Every list below becomes a database column value. Because Catalyst has no
   DDL API these columns are typed by hand, so the value that ships and the
   value the table accepts can drift silently. Each list names the server-side
   declaration it mirrors. If you change one, change both.
   ------------------------------------------------------------------ */

/* Partner lifecycle. Mirrors provider_orgs.approval_status
   (catalyst-backend/functions/auth/src/lib/orgs.js APPROVAL) plus the two
   states the console adds: an org can be approved and still be unable to bid,
   either because billing failed or because an admin paused it. */
export var PARTNER_STATE = Object.freeze([
  'applicant', 'approved', 'active', 'bidding_paused', 'suspended', 'rejected'
]);

/* The five application tracks. Each runs its OWN verification, starting the
   moment that piece lands: the copy on the application screen says "each piece
   starts its own check the moment it lands", so batching verification at
   submission would make that sentence false. */
export var APP_TASK = Object.freeze(['coverage', 'registration', 'documents', 'agreement', 'reference']);
export var APP_TASK_STATE = Object.freeze(['empty', 'submitted', 'verifying', 'cleared', 'flagged']);
export var APP_STATE = Object.freeze([
  'draft', 'submitted', 'under_review', 'info_needed', 'approved', 'rejected'
]);

/* What each task is called, and what it asks for. One declaration, read by the
   checklist, the modals, and the review frame, so the three cannot drift. */
export var APP_TASK_COPY = Object.freeze({
  coverage: ['Declare your coverage', 'The regions you want to bid in and the services you can render there. Serviceability checks start the moment a region lands.'],
  registration: ['Add registration details', 'Legal entity, CRTC registration, business number.'],
  documents: ['Upload documents', 'CRTC registration confirmation and proof of business registration.'],
  agreement: ['Sign the application agreement', 'Accuracy of declarations, consent to verification, confidentiality of briefs.'],
  reference: ['One operating reference', 'Someone who has seen you deliver: a wholesale manager, a landlord, a peer.']
});

/* Cohort auction stage. DISPLAY ONLY. The server derives this from the
   campaign's timestamps and sends it; the client never computes it, because a
   client clock a few minutes fast would let a partner bid after close.
   Authorisation stays with campaigns.kind + bidding_open server side
   (mirrors lib/catalog.js KINDS and requireBiddingOpen). */
export var STAGE = Object.freeze([
  'planned', 'announced', 'open', 'closing', 'offers_out', 'decided'
]);
export var STAGE_LABEL = Object.freeze({
  planned: 'Planned', announced: 'Announced', open: 'Open',
  closing: 'Closing', offers_out: 'Offers out', decided: 'Decided'
});

/* Coverage. A declared region lands in 'verifying' and is checked against
   facilities data. 'active' became reachable when the admin verify route
   shipped; before that every declared region sat in 'verifying' forever and no
   cohort ever reached a desk. */
export var COVERAGE_STATE = Object.freeze(['verifying', 'active', 'soon', 'rejected']);

/* Bids are append-only. There is no 'withdrawn': a sealed bid is binding until
   its deadline, improvable and never removable, so no value here and no
   endpoint anywhere may retire one. */
export var BID_STATE = Object.freeze(['sealed', 'improved', 'locked', 'won', 'not_selected']);

/* How the gap between sticker and effective price is described to a household.
   'custom' reveals a free-text field, which is why it is validated rather than
   merely stored: the standard terms forbid deadline language, manufactured
   scarcity, and bundle or autopay conditions, and a free-text label is the
   obvious way around them. */
export var REDUCTION = Object.freeze(['member', 'promo', 'cash', 'none', 'custom']);
export var REDUCTION_LABEL = Object.freeze({
  member: 'a Whollar member discount',
  promo: 'a promotional credit, expiry stated',
  cash: 'monthly cashback',
  none: 'effective price only, no breakdown',
  custom: ''
});
export var EQUIPMENT = Object.freeze(['inc', 'rent', 'byod']);
export var AFTER_MODE = Object.freeze(['none', 'new']);
export var GUARANTEE_MONTHS = Object.freeze([12, 24, 36]);

/* The standard tier ladder and the technologies a bid names. Mirrors
   lib/bids.js TIER_NAMES / TECHS: tiers come from one server-owned list so two
   partners' offers on a cohort are comparable line by line. Wire values are
   the canonical lowercase codes; TECH_LABEL is how the console displays them. */
export var TIER_NAMES = Object.freeze(['100 Mbps', '300 Mbps', '500 Mbps', '1 Gig', '1.5 Gig', '2.5 Gig']);
export var TECH = Object.freeze(['cable', 'fibre', 'dsl', 'fwa']);
export var TECH_LABEL = Object.freeze({
  cable: 'Cable', fibre: 'Fibre', dsl: 'DSL', fwa: 'Fixed wireless'
});

/* Switch order state. THIS list is canonical. The prototype also carries a
   dead earlier vocabulary (ins, sch, to) from a superseded seedRoster; it is
   not ported and must not reappear.
   'act' is the ONLY state that creates a billable line. */
export var ORDER_STATE = Object.freeze(['acc', 'bkd', 'act', 'rel', 'noshow', 'access', 'linefail']);
export var ORDER_LABEL = Object.freeze({
  acc: 'To book', bkd: 'Booked', act: 'Activated', rel: 'Released',
  noshow: 'No-show', access: 'Access denied', linefail: 'Line test failed'
});
export var ORDER_EXCEPTION = Object.freeze(['noshow', 'access', 'linefail']);

/* Exception-first ordering. Deliberate: the board opens on what needs a
   decision, not on what is going well. Lower sorts first. */
export var ORDER_RANK = Object.freeze({
  noshow: 0, access: 0, linefail: 0, acc: 1, bkd: 2, act: 3, rel: 4
});

/* Release reasons are an enum, not free text, because they feed the
   serviceability accuracy figure on the performance page, which feeds future
   briefs. Free text would make that number unbuildable. */
export var RELEASE_REASON = Object.freeze([
  'no_plant', 'building_access', 'speed_tier_unavailable', 'household_cancelled'
]);
export var RELEASE_LABEL = Object.freeze({
  no_plant: 'No plant at address',
  building_access: 'Building access not in place',
  speed_tier_unavailable: 'Speed tier not available here',
  household_cancelled: 'Household cancelled the install'
});

/* Why a declared region failed serviceability. Same reasoning as the release
   reasons: this feeds a figure, so it cannot be prose. */
export var COVERAGE_REJECT_REASON = Object.freeze([
  'no_facilities', 'outside_footprint', 'tech_unsupported', 'needs_evidence'
]);

export var STATEMENT_STATE = Object.freeze(['accruing', 'issued', 'paid', 'disputed']);
export var LINE_STATE = Object.freeze(['accrued', 'held', 'disputed', 'upheld', 'credited']);

/* Seat roles. Mirrors lib/orgs.js ROLES. Flagged, not fixed: nothing in the
   backend ever WRITES 'bidder' (addMember gives the first seat 'admin' and
   everyone after 'viewer'), and desk.js refuses only 'viewer', so a second
   person at a partner cannot place a bid today. */
export var ROLE = Object.freeze(['admin', 'bidder', 'viewer']);

/* Every figure shown to a partner is one of these, and none ship unlabelled.
   Directional means an estimate and must render as one. */
export var CLAIM = Object.freeze(['direct', 'derived', 'directional']);

/* ------------------------------------------------------------------
   THE VALIDATOR

   Specs are deliberately small. This is not a schema language; it is a
   tripwire on the handful of fields whose type actually changes behaviour.

   Spec value syntax:
     'str' 'num' 'int' 'bool' 'arr' 'obj'   type
     'str?'                                  same, but null/undefined allowed
     ['enum', LIST]                          membership
     ['absent']                              the key must NOT be present
   ------------------------------------------------------------------ */

export var SPECS = {
  /* serverTime is epoch MILLISECONDS, not the datastore's date string. The
     datastore returns UTC with no zone marker, and lib/datastore.js documents
     at length that new Date() on it shifts by the reader's offset. Handing
     that string to a browser reproduces, in every client, the bug the server
     already fixed. An integer cannot be misread. */
  envelope: { ok: 'bool', serverTime: 'int' },

  providerMe: { ok: 'bool', user: 'obj', org: 'obj?', approved: 'bool' },

  campaignList: { ok: 'bool', campaigns: 'arr', serverTime: 'int' },

  /* One campaign, checked per row. This spec exists because it was missing
     once and cost a silent bug: the fixtures carried a flat `closesAt` while
     routes/campaigns.js sends a nested `dates` object keyed by column name, so
     every countdown rendered as nothing at all and nothing complained. A shape
     that two sides build independently needs an assertion, not a convention. */
  campaign: {
    id: 'str', region: 'str',
    stage: ['enum', ['planned', 'announced', 'open', 'closing', 'offers_out', 'decided']],
    stageLabel: 'str',
    dates: 'obj'
  },

  /* The application. `tasks` is an object keyed by APP_TASK, each value an
     APP_TASK_STATE, because per-task status is what makes "each piece starts
     its own check" true rather than decorative. */
  application: {
    ok: 'bool', state: ['enum', ['draft', 'submitted', 'under_review', 'info_needed', 'approved', 'rejected']],
    tasks: 'obj'
  },

  /* The brief: aggregates only. `bid` is the org's OWN bid or null; no other
     partner's anything is in this shape, which is the assertion. */
  brief: { ok: 'bool', serverTime: 'int', campaign: 'obj', brief: 'obj', coverage: 'obj', bid: 'obj?' },

  /* One sealed bid, the org's own. The shape the fixtures' SEALED_BID and the
     server's publicBid() both build; this spec is what keeps them agreeing. */
  bid: {
    campaignId: 'str',
    state: ['enum', ['sealed', 'improved', 'locked', 'won', 'not_selected']],
    tiers: 'arr'
  },

  /* What a place or improve returns: the new head and the sealed receipt. */
  bidReceipt: { ok: 'bool', serverTime: 'int', bid: 'obj', receipt: 'obj' },

  /* The intimation boundary, asserted from the client side as well.
     Before the roster gate the response carries counts and the orders key is
     ABSENT, not an empty array: absent is unambiguous, whereas [] cannot be
     told apart from "the gate passed and nobody signed up", and a client
     cannot render rows that were never transmitted. */
  rosterGated: { ok: 'bool', counts: 'obj', orders: ['absent'] },
  rosterReleased: { ok: 'bool', counts: 'obj', orders: 'arr' }
};

var TYPE = {
  str: function (v) { return typeof v === 'string'; },
  num: function (v) { return typeof v === 'number' && isFinite(v); },
  int: function (v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; },
  bool: function (v) { return typeof v === 'boolean'; },
  arr: function (v) { return Object.prototype.toString.call(v) === '[object Array]'; },
  obj: function (v) { return v !== null && typeof v === 'object' && !TYPE.arr(v); }
};

/* Report each distinct drift once per session. A console polling every 45
   seconds against a backend whose column type is wrong would otherwise
   generate a request per poll, which is how you turn a display bug into a
   billing event on someone's serverless account. */
var reported = {};

/* Strict throws; loose warns once and lets the view degrade. Set by the boot
   path on localhost and by the fixture layer. A module-level `let` cannot be
   exported through this build (imported bindings are copies), so the flag
   lives behind a pair of functions, which is clearer anyway. */
var strict = false;
export function setStrict(on) { strict = !!on; }
export function isStrict() { return strict; }

function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (TYPE.arr(v)) return 'array(' + v.length + ')';
  return typeof v;
}

/**
 * Validate a payload against a named spec.
 * Returns the payload either way, so it can wrap a call inline.
 */
export function check(name, value) {
  var spec = SPECS[name];
  if (!spec) return value;

  var problems = [];
  if (!TYPE.obj(value)) {
    problems.push('payload is ' + describe(value) + ', expected an object');
  } else {
    for (var key in spec) {
      if (!Object.prototype.hasOwnProperty.call(spec, key)) continue;
      var rule = spec[key];
      var got = value[key];
      var present = Object.prototype.hasOwnProperty.call(value, key);

      if (TYPE.arr(rule) && rule[0] === 'absent') {
        if (present) problems.push(key + ' must be absent, got ' + describe(got));
        continue;
      }
      if (TYPE.arr(rule) && rule[0] === 'enum') {
        if (rule[1].indexOf(got) < 0) problems.push(key + ' = ' + JSON.stringify(got) + ', not one of ' + rule[1].join('|'));
        continue;
      }
      var optional = rule.charAt(rule.length - 1) === '?';
      var base = optional ? rule.slice(0, -1) : rule;
      if (optional && (got === null || got === undefined)) continue;
      if (!TYPE[base] || !TYPE[base](got)) {
        problems.push(key + ' is ' + describe(got) + ', expected ' + base);
      }
    }
  }
  if (!problems.length) return value;

  var msg = 'contract drift on ' + name + ': ' + problems.join('; ');

  /* Locally, and under fixtures, this is a bug in code being written right now
     and should stop the developer. In production the partner is not helped by
     a blank screen, so record it and let the view degrade. */
  if (strict) throw new Error(msg);

  if (!reported[name]) {
    reported[name] = true;
    try {
      var W = (typeof window !== 'undefined' ? window : globalThis).WHOLLAR;
      if (W && W.session && W.session.event) W.session.event('console.contract.drift', { shape: name, problems: problems.slice(0, 5) });
    } catch (e) { /* telemetry must never break a render */ }
    if (typeof console !== 'undefined' && console.warn) console.warn('[whollar] ' + msg);
  }
  return value;
}
