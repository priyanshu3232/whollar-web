/* Whollar partner console: the contract.
 *
 * Classic script, no ESM. scripts/check-inline-scripts.mjs parses browser
 * scripts with `node --check` as classic scripts, so an `import` here turns CI
 * red; and nothing in this repo has a bundler to resolve one anyway.
 *
 * WHAT THIS IS FOR. The console talks to a Zoho Catalyst backend whose tables
 * are created BY HAND in a web console (there is no DDL API, see
 * catalyst-backend/scripts/create-tables.md). There is no shared code across
 * that boundary and no build step on this side, so a TypeScript-style contract
 * would check this file against itself and prove nothing. What actually breaks
 * here is the seam: a column typed Int where the client expects a string, a
 * status value that came back as 'verifying ' with a trailing space, a table
 * that exists in Development and not in Production. So the contract is checked
 * at RUNTIME, against the real response, which is the only place those show up.
 *
 * Three parts:
 *   C.<ENUM>   frozen value lists, one declaration each, mirrored server side
 *   @typedef   payload shapes, for the editor; free, and expected to rot
 *   C.check()  the runtime validator, loud locally and quiet in production
 */
(function (root) {
  "use strict";

  var W = root.WHOLLAR;
  if (!W) return;                       /* core failed to load; the page's boot guard reports it */
  W.console = W.console || {};
  if (W.console.C) return;              /* double-include guard, same idiom as whollar-core.js */

  var C = {};

  /* ------------------------------------------------------------------
     ENUMS

     Every list below becomes a database column value. Because Catalyst has no
     DDL API these columns are typed by hand, so the value that ships and the
     value the table accepts can drift silently. Each list therefore names the
     server-side declaration it mirrors. If you change one, change both.
     ------------------------------------------------------------------ */

  /* Partner lifecycle. Mirrors provider_orgs.approval_status
     (catalyst-backend/functions/auth/src/lib/orgs.js APPROVAL) plus the two
     states the console adds: an org can be approved and still be unable to
     bid, either because billing failed or because an admin paused it. */
  C.PARTNER_STATE = Object.freeze([
    'applicant', 'approved', 'active', 'bidding_paused', 'suspended', 'rejected'
  ]);

  /* The five application tracks. Each runs its OWN verification, starting the
     moment that piece lands: the copy on the application screen says "each
     piece starts its own check the moment it lands", so batching verification
     at submission would make that sentence false. */
  C.APP_TASK = Object.freeze(['coverage', 'registration', 'documents', 'agreement', 'reference']);
  C.APP_TASK_STATE = Object.freeze(['empty', 'submitted', 'verifying', 'cleared', 'flagged']);
  C.APP_STATE = Object.freeze([
    'draft', 'submitted', 'under_review', 'info_needed', 'approved', 'rejected'
  ]);

  /* Cohort auction stage. DISPLAY ONLY. The server derives this from the
     campaign's timestamps and sends it; the client never computes it, because
     a client clock a few minutes fast would let a partner bid after close.
     Authorisation stays with campaigns.kind + bidding_open server side
     (mirrors lib/catalog.js KINDS and requireBiddingOpen). */
  C.STAGE = Object.freeze([
    'planned', 'announced', 'open', 'closing', 'offers_out', 'decided'
  ]);
  C.STAGE_LABEL = Object.freeze({
    planned: 'Planned', announced: 'Announced', open: 'Open',
    closing: 'Closing', offers_out: 'Offers out', decided: 'Decided'
  });

  /* Coverage. A declared region lands in 'verifying' and is checked against
     facilities data. Note 'rejected' does not exist server side yet: today
     desk.js writes 'verifying' and nothing anywhere moves it on. */
  C.COVERAGE_STATE = Object.freeze(['verifying', 'active', 'soon', 'rejected']);

  /* Bids are append-only. There is no 'withdrawn': a sealed bid is binding
     until its deadline, improvable and never removable, so no value here and
     no endpoint anywhere may retire one. */
  C.BID_STATE = Object.freeze(['sealed', 'improved', 'locked', 'won', 'not_selected']);

  /* How the gap between sticker and effective price is described to a
     household. 'custom' reveals a free-text field, which is why it is
     validated rather than merely stored: the standard terms forbid deadline
     language, manufactured scarcity, and bundle or autopay conditions, and a
     free-text label is the obvious way around them. */
  C.REDUCTION = Object.freeze(['member', 'promo', 'cash', 'none', 'custom']);
  C.REDUCTION_LABEL = Object.freeze({
    member: 'a Whollar member discount',
    promo: 'a promotional credit, expiry stated',
    cash: 'monthly cashback',
    none: 'effective price only, no breakdown',
    custom: ''
  });
  C.EQUIPMENT = Object.freeze(['inc', 'rent', 'byod']);
  C.AFTER_MODE = Object.freeze(['none', 'new']);
  C.GUARANTEE_MONTHS = Object.freeze([12, 24, 36]);

  /* Switch order state. THIS list is canonical. The prototype also carries a
     dead earlier vocabulary (ins, sch, to) from a superseded seedRoster; it is
     not ported and must not reappear.
     'act' is the ONLY state that creates a billable line. */
  C.ORDER_STATE = Object.freeze(['acc', 'bkd', 'act', 'rel', 'noshow', 'access', 'linefail']);
  C.ORDER_LABEL = Object.freeze({
    acc: 'To book', bkd: 'Booked', act: 'Activated', rel: 'Released',
    noshow: 'No-show', access: 'Access denied', linefail: 'Line test failed'
  });
  C.ORDER_EXCEPTION = Object.freeze(['noshow', 'access', 'linefail']);

  /* Exception-first ordering. Deliberate: the board opens on what needs a
     decision, not on what is going well. Lower sorts first. */
  C.ORDER_RANK = Object.freeze({
    noshow: 0, access: 0, linefail: 0, acc: 1, bkd: 2, act: 3, rel: 4
  });

  /* Release reasons are an enum, not free text, because they feed the
     serviceability accuracy figure on the performance page, which feeds future
     briefs. Free text would make that number unbuildable. */
  C.RELEASE_REASON = Object.freeze([
    'no_plant', 'building_access', 'speed_tier_unavailable', 'household_cancelled'
  ]);
  C.RELEASE_LABEL = Object.freeze({
    no_plant: 'No plant at address',
    building_access: 'Building access not in place',
    speed_tier_unavailable: 'Speed tier not available here',
    household_cancelled: 'Household cancelled the install'
  });

  C.STATEMENT_STATE = Object.freeze(['accruing', 'issued', 'paid', 'disputed']);
  C.LINE_STATE = Object.freeze(['accrued', 'held', 'disputed', 'upheld', 'credited']);

  /* Seat roles. Mirrors lib/orgs.js ROLES. Flagged, not fixed: nothing in the
     backend ever WRITES 'bidder' (addMember gives the first seat 'admin' and
     everyone after 'viewer'), and desk.js refuses only 'viewer', so a second
     person at a partner cannot place a bid today. */
  C.ROLE = Object.freeze(['admin', 'bidder', 'viewer']);

  /* Every figure shown to a partner is one of these, and none ship unlabelled.
     Directional means an estimate and must render as one. */
  C.CLAIM = Object.freeze(['direct', 'derived', 'directional']);

  /* ------------------------------------------------------------------
     TYPEDEFS  (editor only, no runtime cost)
     ------------------------------------------------------------------ */

  /**
   * @typedef {Object} Partner
   * @property {string} orgId
   * @property {string} orgName
   * @property {string} role            one of C.ROLE
   * @property {string} state           one of C.PARTNER_STATE
   * @property {boolean} approved
   * @property {number} serverTime      epoch ms, see C.check note below
   */

  /**
   * @typedef {Object} Campaign
   * @property {string} id
   * @property {string} region
   * @property {string} stage           one of C.STAGE, SERVER DERIVED
   * @property {number} households
   * @property {boolean} biddingOpen
   * @property {number|null} closesAt   epoch ms
   */

  /**
   * @typedef {Object} OrderCounts
   * @property {number} total
   * @property {number} withheld        rows the gate is holding back
   */

  /* ------------------------------------------------------------------
     THE VALIDATOR

     Specs are deliberately small. This is not a schema language; it is a
     tripwire on the handful of fields whose type actually changes behaviour.

     Spec value syntax:
       'str' 'num' 'int' 'bool' 'arr' 'obj'   type
       'str?'                                  same, but null/undefined allowed
       ['enum', C.SOME_LIST]                   membership
       ['absent']                              the key must NOT be present
     ------------------------------------------------------------------ */

  C.SPECS = {
    /* serverTime is epoch MILLISECONDS, not the datastore's date string. The
       datastore returns UTC with no zone marker, and lib/datastore.js documents
       at length that new Date() on it shifts by the reader's offset. Handing
       that string to a browser reproduces, in every client, the bug the server
       already fixed. An integer cannot be misread. */
    envelope: { ok: 'bool', serverTime: 'int' },

    providerMe: { ok: 'bool', user: 'obj', org: 'obj?', approved: 'bool' },

    campaignList: { ok: 'bool', campaigns: 'arr' },

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

  C.strict = false;   /* set true by the fixture layer and on localhost */

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
  C.check = function (name, value) {
    var spec = C.SPECS[name];
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

    /* Locally, and under fixtures, this is a bug in code being written right
       now and should stop the developer. In production the partner is not
       helped by a blank screen, so record it and let the view degrade. */
    if (C.strict) throw new Error(msg);

    if (!reported[name]) {
      reported[name] = true;
      try {
        if (W.session && W.session.event) W.session.event('console.contract.drift', { shape: name, problems: problems.slice(0, 5) });
      } catch (e) { /* telemetry must never break a render */ }
      if (root.console && root.console.warn) root.console.warn('[whollar] ' + msg);
    }
    return value;
  };

  W.console.C = C;
})(typeof window !== 'undefined' ? window : globalThis);
