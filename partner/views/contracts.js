/* Contracts: everything binding, versioned, in one place.
 *
 * Ported from the prototype's renderContracts, and specifically from the
 * SECOND declaration (provider-console-v12.html:1966, "contracts: full
 * registry"), which is a full replacement rather than a decorator: the v5
 * override at 1588 is the one hoisting discards, and it is two rows shorter.
 * See docs/console/render-inventory.md. openTerms() is declared once and is
 * ported as it stands, minus its prototype-only side effects.
 *
 * WHAT CHANGED IN THE PORT, and why:
 *
 *   The prototype's rows are constants. Every row here is a real record or it
 *   says it could not be read. `S.tasks.terms` was a client boolean anyone
 *   could flip in a console; acceptance is now a server record, keyed on the
 *   version in force, and the SERVER refuses a bid without it. This view can
 *   only ever be wrong about it, never permissive.
 *
 *   The prototype's "Cohort delivery agreement" rows are not ported. They came
 *   from a demo array of won campaigns; there is no award record yet, so
 *   inventing the row would be inventing the win. The line that says where
 *   they will appear is in the footnote instead.
 *
 *   "6 on record" in the receipts row was a literal +6. It is the org's own
 *   sealed revision count, or a dash.
 */

import { get, set } from '../core/state.js';
import { api } from '../core/api.js';
import { esc } from '../core/format.js';
import { fmtDate } from '../core/time.js';
import { on } from '../core/actions.js';
import { open as openModal, close as closeModal } from '../core/modal.js';
import { toast, failed } from '../core/toast.js';
import { authFailed } from '../core/session.js';

/* The terms, as one declaration.
 *
 * The modal renders these and the acceptance hash is taken over them, so the
 * text that was agreed to is provable rather than inferred from a version
 * label. Editing this list without publishing a new `cohort_terms_version`
 * would leave old acceptances pointing at text that has since changed, which
 * is the whole failure mode the hash exists to catch: change both. */
export var TERMS = Object.freeze([
  'Unlimited data, no deprioritization, on every bid',
  'Modem and in-home WiFi included in the bid price, no equipment line items',
  'The price is guaranteed for the stated window, and the after-rate is stated on the face of the bid',
  'No bundle-conditional, autopay-conditional, or cash-incentive structures',
  'Bids are sealed and binding until the deadline, improvable, never withdrawable',
  'You are invoiced per completed switch only, confirmed households are never billed'
]);

export function render() {
  var host = document.getElementById('con-body');
  if (!host) return;
  var S = get();
  var c = S.contracts;

  /* Not loaded, or the whole route refused. The registry is a read over five
     other records, so "we could not reach it" is a different sentence from
     "you have nothing on file", and the second one would be a lie here.
     Three different sentences, though, and not one: this card spent a while
     saying "loading, or could not be read" at an account that was simply not
     attached to an organisation, which is a fact the server states outright
     and the page had no business paraphrasing as a maybe. */
  if (!c) {
    host.innerHTML = '<section class="card"><span class="eyebrow">On file</span>'
      + '<h3>Agreements and records</h3>'
      + '<p class="cardnote">' + unreadable(S) + '</p>'
      + (S.contractsError && S.contractsError.status === 403
        ? '<p class="fnote">Nothing is wrong with your agreements. This account cannot read them, which is a different thing.</p>'
        : '')
      + '</section>';
    return;
  }

  var rows = [
    msaRow(c),
    termsRow(c),
    scheduleRow(c),
    registrationRow(c),
    receiptsRow(c),
    ['Campaign statements',
      'Generated per campaign from activations only, net-15, line-level disputes.',
      link('billing', 'Open billing')]
  ];

  host.innerHTML = '<section class="card"><span class="eyebrow">On file</span>'
    + '<h3>Agreements and records</h3>'
    + '<div class="conls">'
    + rows.map(function (r) {
      return '<div class="conrow"><span><b>' + r[0] + '</b><small>' + r[1] + '</small></span>'
        + '<span class="conact">' + (r[2] || '') + '</span></div>';
    }).join('')
    + '</div>'
    + '<p class="fnote">Everything binding lives here, versioned. If the standard terms change, bidding pauses '
    + 'until you have accepted the new version. A cohort delivery agreement joins this list for each cohort you win, '
    + 'holding your offer as the households accepted it.'
    + (c.live ? '' : ' One or more records could not be read just now, so this list may be short.')
    + '</p></section>';
}

/**
 * Why the registry is not on screen, in the server's terms rather than ours.
 *
 * A refusal, a transport failure and a read still in flight look identical to
 * a partner and are three different things to act on: the first is an account
 * problem somebody has to fix, the second usually fixes itself, the third
 * needs nothing at all. Naming them is the difference between a screenshot
 * that says what is wrong and a screenshot that has to be diagnosed.
 */
function unreadable(S) {
  var e = S.contractsError;
  if (!e) {
    return 'Everything binding lives here, versioned: the master services agreement, '
      + 'the standard cohort terms, your regional schedule, your registration, and every '
      + 'sealed bid receipt. Reading them now.';
  }
  if (e.status === 403) {
    return esc(e.message || 'This account is not attached to a partner organisation.')
      + ' Your agreements are read against an organisation, so this list stays empty until '
      + 'this account is a seat on one. An organisation admin can add it, and nothing about '
      + 'the records themselves has changed.';
  }
  if (e.status === 401) {
    return 'Your session ended while this page was open. Sign in again and the registry comes back with it.';
  }
  if (e.code === 'NETWORK') {
    return 'We could not reach Whollar to read your agreements. Nothing has changed about them, '
      + 'and this page will fill in as soon as the connection does.';
  }
  return 'Your agreements could not be read just now. They are not gone, nothing about them has '
    + 'changed, and bidding is held rather than opened while the standard terms cannot be confirmed.';
}

/* ------------------------------------------------------------------ *
 * the rows
 *
 * Each returns [title, description, action], and each says "could not read"
 * rather than reporting a zero. A registry that renders 0 for an unreadable
 * table is worse than one that renders nothing: a partner acts on it.
 * ------------------------------------------------------------------ */

function msaRow(c) {
  var m = c.msa;
  if (!m) return ['Master services agreement', unread(), ''];
  if (m.state === 'signed') {
    return ['Master services agreement',
      'The relationship itself: sealed auctions, delivery obligations, settlement, exit. Signed at approval'
      + (m.signedAt ? ' on ' + esc(fmtDate(m.signedAt)) : '') + '.',
      '<span class="pill won">Signed</span>'];
  }
  return ['Master services agreement',
    'The relationship itself: sealed auctions, delivery obligations, settlement, exit. It signs at approval, and nothing is owed before then.',
    '<span class="pill pending">Signs at approval</span>'];
}

function termsRow(c) {
  var t = c.terms || {};
  var title = 'Standard cohort terms · ' + esc(t.version || 'v1');
  var body = 'Unlimited data, equipment stated on the face of the bid, the after-rate stated, no teaser structures.';

  /* The title itself opens the terms, accepted or not: the six lines are what
     every bid runs on, and a partner rereading them should not have to press a
     button labelled "accept" to do it. Unreadable is the one case with nothing
     to open, since the modal would render a version it could not confirm. */
  if (t.live) {
    /* A distinct action from the accept button, and deliberately so: this one
       only ever opens the text. The QA harness asserts that an org already on
       the version in force is offered no `terms:open` anywhere in the
       registry, which is the right assertion, and a reread affordance sharing
       that name would quietly make it false. */
    title = '<button class="rowopen" type="button" data-action="terms:read">' + title + '</button>';
  }

  if (t.current) {
    return [title,
      body + (t.acceptedAt ? ' Accepted ' + esc(fmtDate(t.acceptedAt)) : '')
      + (t.acceptedBy ? ' by ' + esc(t.acceptedBy) : '') + '.',
      '<span class="pill won">Accepted</span>'];
  }
  if (!t.live) return [title, unread() + ' Bidding is held until it can be.', ''];
  if (t.acceptedVersion) {
    return [title,
      body + ' You accepted ' + esc(t.acceptedVersion) + '. Bidding is paused until you accept ' + esc(t.version) + '.',
      button('Review and accept')];
  }
  return [title, body, button('Review and accept')];
}

function scheduleRow(c) {
  var s = c.schedule;
  if (!s) return ['Regional schedule', unread(), link('coverage', 'Open coverage')];
  var named = (s.regions || []).slice(0, 2).map(esc).join(', ');
  var rest = (s.declared || 0) - Math.min(2, (s.regions || []).length);
  var where = named ? (named + (rest > 0 ? ' and ' + rest + ' more' : '')) : null;
  return ['Regional schedule' + (where ? ' · ' + where : ''),
    s.declared
      ? 'Your regions, declared services, and install capacity as an appendix to the agreement. '
        + s.active + ' of ' + s.declared + ' verified. Updates when coverage does.'
      : 'Your regions and declared services become an appendix to the agreement the moment you declare them.',
    link('coverage', s.declared ? 'Open coverage' : 'Declare coverage')];
}

function registrationRow(c) {
  var r = c.registration;
  if (!r) return ['CRTC registration', unread(), ''];
  if (!r.crtc) {
    return ['CRTC registration',
      'Your registration number goes on the application, and is verified before approval.',
      '<span class="pill pending">Not on file</span>'];
  }
  var pill = r.state === 'cleared'
    ? '<span class="pill won">Verified</span>'
    : (r.state === 'flagged'
      ? '<span class="pill lost">Needs another look</span>'
      : '<span class="pill pending">With the reviewer</span>');
  return ['CRTC registration', 'Registration ' + esc(r.crtc) + ' on file.', pill];
}

function receiptsRow(c) {
  var r = c.receipts;
  if (!r) return ['Sealed bid receipts', unread(), link('bids', 'Open record')];
  if (!r.sealed) {
    return ['Sealed bid receipts',
      'Every bid you place is binding until its deadline, and lands here as a sealed receipt. None yet.',
      link('desk', 'Open the bid desk')];
  }
  return ['Sealed bid receipts',
    'Every bid you place is binding until its deadline. ' + r.sealed + ' on record across '
    + r.cohorts + ' cohort' + (r.cohorts === 1 ? '' : 's') + '. An improvement is a new sealed record, never an edit.',
    link('bids', 'Open record')];
}

function unread() {
  return 'This record could not be read just now. It is not gone, and nothing has changed about it.';
}

function link(view, label) {
  return '<button class="tlink" type="button" data-action="nav" data-view="' + esc(view) + '">'
    + esc(label) + ' →</button>';
}

function button(label) {
  return '<button class="btn ghost" type="button" data-action="terms:open">' + esc(label) + '</button>';
}

/* ------------------------------------------------------------------ *
 * the modal
 * ------------------------------------------------------------------ */

function termsModal() {
  var S = get();
  var t = (S.contracts && S.contracts.terms) || {};
  var org = (S.org && S.org.name) || 'Your company';
  return '<div class="mhead"><h3>Standard cohort terms · ' + esc(t.version || 'v1') + '</h3>'
    + '<button class="mx" type="button" data-mclose aria-label="Close">×</button></div>'
    + '<p class="msub">One agreement covers every auction, so every sealed bid is comparable and every household reads one page.</p>'
    + '<ul class="termls">'
    + TERMS.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('')
    + '</ul>'
    + (t.acceptedVersion && t.acceptedVersion !== t.version
      ? '<p class="cardnote">You accepted ' + esc(t.acceptedVersion) + '. That acceptance stays on record; this is a new version, and bidding resumes once it is accepted.</p>'
      : '')
    /* Already on the version in force: this is a reread, not a second signing.
       Offering the checkbox again would suggest the acceptance had lapsed, and
       the route is idempotent anyway, so there is nothing to press. */
    + (t.current
      ? '<div class="receipt" style="margin-top:12px"><b>Accepted</b>'
        + (t.acceptedAt ? ' on ' + esc(fmtDate(t.acceptedAt)) : '')
        + (t.acceptedBy ? ' by ' + esc(t.acceptedBy) : '')
        + '. Every auction on your desk runs on these terms.</div>'
      : consent(t, org));
}

function consent(t, org) {
  return '<label class="consent"><input type="checkbox" id="terms-ok" data-action="terms:toggle">'
    + '<span>' + esc(org) + ' accepts the standard cohort terms, ' + esc(t.version || 'v1') + '.</span></label>'
    + '<button class="btn" type="button" id="terms-go" data-action="terms:accept" disabled '
    + 'style="width:100%;justify-content:center;margin-top:12px">Accept</button>';
}

/**
 * A stable hash of the text that was on screen, sent with the acceptance.
 *
 * NOT a security control and not pretending to be one: it is a fingerprint, so
 * an operator settling a dispute can tell whether the six lines this org saw
 * are the six lines in force today. It is computed over the same TERMS array
 * the modal renders, so the two cannot drift. No crypto API is used because
 * none is needed, and because SubtleCrypto is async and unavailable on
 * insecure origins, which would make the button fail on a dev machine.
 */
function consentHash(version) {
  var s = String(version || '') + '\n' + TERMS.join('\n');
  var h1 = 0x811c9dc5, h2 = 0x01000193;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charCodeAt(i);
    h1 = (h1 ^ ch) >>> 0; h1 = (h1 * 16777619) >>> 0;
    h2 = (h2 + ch * (i + 1)) >>> 0; h2 = (h2 ^ (h2 << 5)) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}

/* ------------------------------------------------------------------ *
 * load and actions
 * ------------------------------------------------------------------ */

/** Boot-path read: a failure degrades the view rather than blanking it, and
    never signs anyone out on its own. */
export function load() {
  return api.contracts().then(function (r) {
    set({ contracts: r || null, contractsError: r ? null : { status: 0, code: 'EMPTY' } });
  }, function (err) {
    authFailed(err);
    /* Keep the refusal, not just the absence. The card renders the reason, and
       a 403 here is the single most common one: a provider account with no org
       membership can read nothing that is scoped to an org. */
    set({
      contracts: null,
      contractsError: {
        status: (err && err.status) || 0,
        code: (err && err.code) || 'SERVER_ERROR',
        message: (err && err.message) || null
      }
    });
  });
}

export function mount() {
  on('click', 'terms:open', function () { openModal(termsModal()); });
  on('click', 'terms:read', function () { openModal(termsModal()); });

  on('change', 'terms:toggle', function (el) {
    var go = document.getElementById('terms-go');
    if (go) go.disabled = !el.checked;
  });

  on('click', 'terms:accept', function (el) {
    var S = get();
    var t = (S.contracts && S.contracts.terms) || {};
    var W = window.WHOLLAR;
    if (!W.busy(el, true, 'Accepting')) return;
    api.termsAccept({
      accepted: true,
      /* The version that was on screen, so a page that went stale is refused
         rather than recorded against text nobody displayed. */
      version: t.version || null,
      consentHash: consentHash(t.version)
    }).then(function (r) {
      W.busy(el, false);
      closeModal();
      /* Take the server's terms object, not an optimistic local flip: the
         acceptance that counts is the row, and the desk unlocks from the same
         fact the server will check on the next bid. */
      if (r && r.terms) set('contracts', Object.assign({}, S.contracts, { terms: r.terms }));
      else load();
      toast('Standard terms accepted. Every auction on your desk runs on them.');
    }, function (err) {
      W.busy(el, false);
      failed(err);
      authFailed(err);
      /* A refusal here is usually a version bump between the page load and the
         click, and the fix is to re-read rather than to leave a stale modal
         claiming a version that is no longer in force. */
      load();
    });
  });
}
