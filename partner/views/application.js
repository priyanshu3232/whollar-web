/* The founding partner application: the checklist, four modals, and the frame.
 *
 * TWO SURFACES, ONE RECORD. §8.4 and §8.5:
 *
 *   tasks   the normal console overview, carrying a five-row checklist. The
 *           partner can look around the console while they fill it in.
 *   frame   the gated review screen: nav hidden, search hidden, one centred
 *           card with four numbered rows and the decision clock.
 *
 * WHICH ONE SHOWS is derived from the server's application state, not from a
 * client flag. The prototype guarded this transition TWICE, with two different
 * flags, two different toasts, and two different claimed timelines ("four
 * business days" and "48 hours"). docs/console/render-inventory.md Hazard 2
 * records the porting decision taken there and kept here: layer 5's behaviour
 * and wording win, layer 4's duplicate transition is dropped. The server makes
 * it moot anyway, because POST /application/submit stamps submittedAt only if
 * unset, so two calls cannot start two clocks.
 *
 * THE CLOCK STARTS AT COMPLETION, NOT AT PICKUP. decision_due_at is stamped
 * when the fifth task lands, which is what makes "the clock starts when your
 * application completes, not when we get around to it" a true sentence rather
 * than a promise.
 */

import { get, set, applicationComplete } from '../core/state.js';
import { api } from '../core/api.js';
import { esc } from '../core/format.js';
import { fmtDate, fmtStamp } from '../core/time.js';
import { toast, failed } from '../core/toast.js';
import { on, onAnyClick } from '../core/actions.js';
import { go } from '../core/router.js';
import { open as openModal, close as closeModal } from '../core/modal.js';
import { authFailed } from '../core/session.js';
import { APP_TASK } from '../core/contract.js';
import { gateRow } from '../components/gate.js';
import { applicationTasks, progress } from '../components/tasks.js';

/* ------------------------------------------------------------------ *
 * the frame
 * ------------------------------------------------------------------ */

export function render() {
  var host = document.getElementById('pend-body');
  if (!host) return;
  var app = get().application;

  /* Not reached on a normal boot: load() seeds the record before the read
     starts, so the frame paints the review card straight away. Kept for the
     one path that empties it, a boot read that failed, which app.js hands to
     the console a moment later anyway. */
  if (!app) {
    host.innerHTML = '<section class="card" style="max-width:640px;margin:0 auto">'
      + '<div class="empty"><h3>Reading your application</h3>'
      + '<p>One moment. If this does not clear, reload the page, and email partners@whollar.ca if it still will not.</p></div></section>';
    return;
  }

  if (app.state === 'rejected') { host.innerHTML = declined(app); return; }
  if (app.state === 'info_needed') { host.innerHTML = infoNeeded(app); return; }
  host.innerHTML = underReview(app);
}

/* Under review. Four rows, each state read from application_tasks rather than
   from a counter, so "coverage cleared, registration still with the register"
   renders as itself instead of as "2 of 5". */
function underReview(app) {
  var t = app.tasks || {};
  var complete = applicationComplete();
  var org = (get().org && get().org.orgName) || (app.operatingName) || 'Your company';
  var regions = get().coverage.filter(function (c) { return c.status !== 'soon'; }).length;

  function anyOf(keys, states) {
    return keys.some(function (k) { return states.indexOf(t[k]) > -1; });
  }
  function allOf(keys, states) {
    return keys.every(function (k) { return states.indexOf(t[k]) > -1; });
  }

  var covState = t.coverage === 'cleared' ? 'dn' : (t.coverage && t.coverage !== 'empty' ? 'now' : '');
  var paperKeys = ['registration', 'documents', 'agreement', 'reference'];
  var paperState = allOf(paperKeys, ['cleared']) ? 'dn'
    : (anyOf(paperKeys, ['submitted', 'verifying', 'flagged']) ? 'now' : '');
  var decisionState = complete ? 'now' : '';
  var done = countDone(t);

  return '<section class="card" style="max-width:640px;margin:0 auto">'
    + '<span class="eyebrow">Founding partner application</span>'
    + '<h3>' + (complete ? 'Received. The clock is running.' : 'Received. The rest is yours to start.') + '</h3>'

    /* "signed up", and the date is the ACCOUNT's, not the application's. The
       application row is created on the first task write, so its own stamp
       would date a partner's signup to whenever they first touched the form,
       which for anyone who read the card and came back tomorrow is wrong by a
       day. publicUser.memberSince is the account's creation stamp, so it is
       the one that matches the sentence. */
    + gateRow('dn', '', 'Application received',
      esc(org) + (signedUp() ? ' · signed up ' + esc(signedUp()) : ''))

    /* One button in all three states. Complete is not the same as done with
       us: the partner still wants to see what they sent while the clock runs,
       and a card with no way back into the file reads as a dead end. Nothing
       started gets the plain invitation rather than a score of zero, which is
       the first thing a new partner reads. */
    + '<div class="pendcta">'
    + '<button class="btn" type="button" data-action="app:tasks" style="width:100%;justify-content:center">'
    + (complete ? 'Review your application'
      : (done === 0 ? 'Complete your application' : 'Continue your application · ' + done + ' of 5 done'))
    + '</button>'
    + '<small>' + (complete
      ? 'Nothing further is needed. Everything you sent stays readable while the review runs.'
      : 'Five short pieces: coverage, registration, documents, one agreement, one reference. '
        + 'About ten minutes, in any order, and each piece starts its own check the moment it lands.')
    + '</small></div>'

    + gateRow(covState, 2, 'Serviceability check',
      t.coverage && t.coverage !== 'empty'
        ? 'Running on your ' + regions + ' declared region' + (regions === 1 ? '' : 's') + ' against real plant data.'
        : 'Starts the moment your coverage lands, against real plant data.')

    + gateRow(paperState, 3, 'Registration and agreements',
      anyOf(paperKeys, ['submitted', 'verifying', 'cleared'])
        ? 'Registration with the reviewer, agreement on file, reference contacted once.'
        : 'CRTC registration, two documents read by a person, one agreement, one reference contacted once.')

    + gateRow(decisionState, 4, 'Decision · within 48 hours of completion',
      complete && app.decisionDueAt
        ? 'Everything is in. Your decision lands by ' + esc(fmtDate(app.decisionDueAt)) + '.'
        : 'The clock starts when your application completes, not when we get around to it.')

    + '<p class="fnote">Nothing is owed at any point in this process. Questions: partners@whollar.ca</p>'
    + '</section>';
}

/* info_needed. The prototype has no such state, and without it a flagged check
   is a silent stall: the partner sees "under review" forever and never learns
   that one number did not match. The flagged task is reopened, and only that
   one. */
function infoNeeded(app) {
  var t = app.tasks || {};
  var flagged = Object.keys(t).filter(function (k) { return t[k] === 'flagged'; });
  return '<section class="card" style="max-width:640px;margin:0 auto">'
    + '<span class="eyebrow gld">One thing to fix</span>'
    + '<h3>We need another look at ' + esc(flagged.length === 1 ? oneName(flagged[0]) : 'two pieces') + '</h3>'
    + '<p class="cardnote">' + esc(app.reviewNote || 'A reviewer could not confirm one part of your application.')
    + '</p>'
    + '<div class="pendcta"><button class="btn" type="button" data-action="app:tasks" style="width:100%;justify-content:center">'
    + 'Open the piece that needs you</button>'
    + '<small>Only the flagged piece is reopened. Everything else stays cleared, and the 48 hour clock restarts when you resubmit.</small></div>'
    + '<p class="fnote">Questions: partners@whollar.ca</p></section>';
}

/* declined. A terminal state with a reason and one route forward. A dead end
   with no explanation is the worst screen in any console, and it is the one
   most likely to be built last and least. */
function declined(app) {
  var again = app.reapplyAfter ? fmtDate(app.reapplyAfter) : null;
  return '<section class="card" style="max-width:640px;margin:0 auto">'
    + '<span class="eyebrow">Founding partner application</span>'
    + '<h3>We could not approve this application</h3>'
    + '<p class="cardnote">' + esc(app.decisionNote || 'A reviewer could not confirm the details on file.') + '</p>'
    + (again
      ? '<p class="cardnote">You can apply again from ' + esc(again) + '. If something here is wrong, tell us before then and we will look again sooner.</p>'
      : '<p class="cardnote">If something here is wrong, reply and we will look again. This is a decision on the information we could confirm, not a permanent one.</p>')
    + '<a class="btn" href="mailto:partners@whollar.ca?subject=Founding%20partner%20application">Email partners@whollar.ca</a>'
    + '<p class="fnote">Nothing is owed, and nothing you sent us is kept beyond our retention window.</p></section>';
}

function oneName(key) {
  return { coverage: 'your coverage', registration: 'your registration', documents: 'your documents', agreement: 'the agreement', reference: 'your reference' }[key] || 'one piece';
}
function countDone(t) {
  return Object.keys(t).filter(function (k) { return t[k] && t[k] !== 'empty'; }).length;
}

/** When this account was created, as "Aug 14", or '' if the server has not
    answered yet. It arrives on GET /provider/me, one round trip after boot. */
function signedUp() {
  var u = get().user || {};
  return u.memberSince ? fmtStamp(u.memberSince) : '';
}

/* ------------------------------------------------------------------ *
 * the checklist, on the overview
 * ------------------------------------------------------------------ */

export function checklistHTML() {
  var app = get().application;
  var t = (app && app.tasks) || {};
  var built = applicationTasks(t);
  return '<section class="card" aria-label="Application">'
    + '<span class="eyebrow gld">Getting started</span>'
    + '<h3>Finish these, review runs as they land</h3>'
    + '<div class="tasks">' + built.html + '</div>'
    + progress(built.done, built.total)
    + '<div class="pline"><span>Setup progress</span><b>' + esc(built.label) + '</b></div>'
    + '</section>';
}

/* ------------------------------------------------------------------ *
 * the four modals
 *
 * Save on blur, with a visible saved indicator. §8.4 requires it, and the
 * reason is plain: losing a half-filled application to a closed tab is the
 * kind of thing a partner does not come back from.
 * ------------------------------------------------------------------ */

/**
 * One field.
 *
 * The label is a block above its input and the input fills its column, which
 * sounds like a truism and was not the case: nothing in app.css matched a bare
 * `label` or a bare `input`, so both took browser defaults and the modal
 * rendered as an inline label jammed against a 20-character box. The classes
 * here (.mfield, .fhint, .req) are new and carry those rules.
 *
 * The hint is behind an "i" control beside the title, not printed under the
 * input: four fields with four lines of small print under them read as a form
 * with eight fields. The `.fhint` line under the input still exists, empty and
 * hidden, and is what markField() writes a validation message into, so a
 * problem still lands under the input it belongs to.
 *
 * @param {string} id
 * @param {string} label
 * @param {string} value
 * @param {{hint?:string, required?:boolean, mono?:boolean, wide?:boolean,
 *          placeholder?:string, autocomplete?:string, type?:string,
 *          action?:string}} [o]
 *   `action` is the change handler, `app:blur` unless told otherwise. That
 *   default is the registration autosave, so a field in any other modal must
 *   pass its own or pass '' to carry none.
 */
function field(id, label, value, o) {
  o = o || {};
  var action = o.action == null ? 'app:blur' : o.action;
  var hintId = id + '-hint';
  return '<div class="mfield' + (o.wide ? ' wide' : '') + '">'
    + '<div class="flab">'
    + '<label for="' + id + '">' + esc(label) + '</label>'
    + (o.hint
      ? '<button class="ihint" type="button" data-action="app:hint" data-for="' + hintId + '"'
        + ' aria-expanded="false" aria-controls="' + hintId + '" aria-label="About ' + esc(label) + '">i</button>'
      : '')
    + (o.required ? '<span class="req">required</span>' : '<span class="opt2">optional now</span>')
    + (o.hint ? '<div class="ipop" id="' + hintId + '" hidden>' + esc(o.hint) + '</div>' : '')
    + '</div>'
    + '<input type="' + esc(o.type || 'text') + '" id="' + id + '"' + (o.mono ? ' class="mono"' : '')
    + ' value="' + esc(value || '') + '"'
    + ' placeholder="' + esc(o.placeholder || '') + '"'
    + ' autocomplete="' + esc(o.autocomplete || 'off') + '" spellcheck="false"'
    + (o.required ? ' aria-required="true"' : '')
    + (o.hint ? ' aria-describedby="' + hintId + '"' : '')
    + (action ? ' data-action="' + esc(action) + '"' : '') + '>'
    + '<small class="fhint" hidden></small>'
    + '</div>';
}

/** Open one hint, or close it if it is the one open. Only one is ever open:
    two popovers on a two-column form overlap each other. */
function toggleHint(btn) {
  var pop = document.getElementById(btn.getAttribute('data-for'));
  if (!pop) return;
  var wasOpen = !pop.hidden;
  closeHints();
  if (!wasOpen) {
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }
}

function closeHints() {
  var open = document.querySelectorAll('.ipop:not([hidden])');
  for (var i = 0; i < open.length; i++) open[i].hidden = true;
  var btns = document.querySelectorAll('.ihint[aria-expanded="true"]');
  for (var j = 0; j < btns.length; j++) btns[j].setAttribute('aria-expanded', 'false');
}

function registrationModal() {
  var app = get().application || {};
  return '<div class="mhead"><h3>Registration details</h3>'
    + '<button class="mx" type="button" data-mclose aria-label="Close">×</button></div>'
    + '<div class="mform">'
    + field('ap-legal', 'Legal entity', app.legalName, {
      required: true, autocomplete: 'organization',
      placeholder: 'Northline Communications Inc.',
      hint: 'Exactly as it appears on the register, including Inc. or Ltd.'
    })
    + field('ap-oper', 'Operating name', app.operatingName, {
      autocomplete: 'organization', placeholder: 'Northline Internet',
      hint: 'Only if households would know you by a different name.'
    })
    + field('ap-crtc', 'CRTC registration number', app.crtcRegistration, {
      required: true, mono: true, placeholder: '1234567890',
      hint: 'From your registration confirmation.'
    })
    + field('ap-bn', 'Business number', app.businessNumber, {
      mono: true, placeholder: '123456789RC0001',
      hint: 'Needed before your first statement, not before your first bid.'
    })
    + '</div>'
    + '<div class="mfoot">'
    + '<p class="savedot" id="ap-saved" hidden>Saved</p>'
    + '<button class="btn" type="button" data-action="app:reg-save">Save details</button>'
    + '</div>';
}

/* ---- documents ---- */

/** The two required documents, in the order a reviewer reads them. */
var DOC_KINDS = [
  ['crtc_registration', 'CRTC registration confirmation',
    'The confirmation letter or email carrying your registration number.'],
  ['business_registration', 'Proof of business registration',
    'Articles of incorporation, a master business licence, or the provincial equivalent.']
];

var DOC_MAX_BYTES = 10 * 1024 * 1024;
var DOC_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/heif', 'image/webp'];
var DOC_ACCEPT = DOC_TYPES.join(',');

/** Transient per-row state: uploading fraction, or an error message. Not in
    the store, because it is neither the server's answer nor worth surviving a
    re-render of anything but this modal. */
var docWork = {};

var ICO_DOC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
var ICO_TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
var ICO_WARN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

function bytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

var REVIEW_WORD = {
  pending: 'With a reviewer',
  accepted: 'Accepted',
  rejected: 'Not accepted, please replace'
};

/** One document row, in whichever of its four states it is in. */
function docRow(kind, title, hint) {
  var docs = get().documents || {};
  var d = docs[kind];
  var work = docWork[kind] || {};
  var cls = 'docup', ico = ICO_DOC, body, actions;

  if (work.uploading) {
    body = '<small>Uploading ' + Math.round((work.progress || 0) * 100) + '%</small>'
      + '<div class="dbar"><i style="width:' + Math.round((work.progress || 0) * 100) + '%"></i></div>';
    actions = '';
  } else if (work.error) {
    cls += ' bad';
    ico = ICO_WARN;
    body = '<small>' + esc(work.error) + '</small>';
    actions = '<button class="tlink" type="button" data-action="app:doc-pick" data-kind="' + kind + '">Try again</button>';
  } else if (d) {
    cls += ' on';
    ico = ICO_TICK;
    body = '<small>' + esc(d.filename || 'On file')
      + (d.bytes ? ' · ' + bytes(d.bytes) : '')
      + ' · ' + esc(REVIEW_WORD[d.reviewState] || 'On file') + '</small>';
    actions = '<button class="tlink" type="button" data-action="app:doc-pick" data-kind="' + kind + '">Replace</button>'
      + '<button class="tlink warn" type="button" data-action="app:doc-remove" data-kind="' + kind + '">Remove</button>';
  } else {
    body = '<small>' + esc(hint) + '</small>';
    actions = '<button class="tlink" type="button" data-action="app:doc-pick" data-kind="' + kind + '">Choose file</button>';
  }

  /* The row is the drop target. A separate dropzone above a list of two named
     documents makes the partner decide which document a drop belongs to after
     they have already dropped it. */
  return '<div class="' + cls + '" data-doc="' + kind + '">'
    + '<span class="dico">' + ico + '</span>'
    + '<span class="dtxt"><b>' + esc(title) + '</b>' + body + '</span>'
    + (actions ? '<span class="dact">' + actions + '</span>' : '')
    + '</div>';
}

function docListHTML() {
  return DOC_KINDS.map(function (k) { return docRow(k[0], k[1], k[2]); }).join('');
}

function documentsModal() {
  return '<div class="mhead"><h3>Documents</h3>'
    + '<button class="mx" type="button" data-mclose aria-label="Close">×</button></div>'
    + '<p class="msub">Two documents, read by a person, kept under the same confidentiality as everything else in your file and deleted on our retention schedule.</p>'
    + '<div class="docls" id="ap-docls">' + docListHTML() + '</div>'
    /* One input, reused by both rows, because two inputs is two places for a
       stale data-kind to hide. */
    + '<input type="file" id="ap-docfile" accept="' + DOC_ACCEPT + '" hidden'
    + ' data-action="app:doc-file">'
    + '<p class="docnote">PDF or image, up to 10 MB each. Drag a file onto a row, or choose one. '
    + 'Nothing is sent to a household or to another partner, ever.</p>';
}

/** Repaint the list in place. Re-opening the modal would work and would also
    throw focus back to the close button on every progress tick. */
function paintDocs() {
  var host = document.getElementById('ap-docls');
  if (host) host.innerHTML = docListHTML();
}

function agreementModal() {
  var org = (get().org && get().org.orgName) || 'Your company';
  return '<div class="mhead"><h3>Application agreement</h3>'
    + '<button class="mx" type="button" data-mclose aria-label="Close">×</button></div>'
    + '<p class="msub">The application-stage agreement only. The partner agreement signs at approval, and the standard cohort terms accept before your first bid.</p>'
    + '<ul class="termls">'
    + '<li>My declarations, coverage included, are accurate to the best of my knowledge</li>'
    + '<li>I consent to registration and serviceability verification of what I have declared</li>'
    + '<li>Auction briefs and cohort data I see are confidential, before and after any approval</li>'
    + '<li>Nothing is owed by either side at the application stage</li>'
    + '</ul>'
    + '<label class="consent"><input type="checkbox" id="ap-agrok" data-action="app:agr-toggle">'
    + '<span>' + esc(org) + ' agrees to the application terms above.</span></label>'
    + '<button class="btn" type="button" id="ap-agrgo" data-action="app:agr-save" disabled style="width:100%;justify-content:center;margin-top:12px">Sign</button>';
}

/* Same form system as registration, so the two modals a reviewer opens back
   to back read as one surface. The saved reference is never on the wire (the
   server keeps it off the application record on purpose), so the fields open
   empty every time; when one is already on file the footer says so, and that
   saving again replaces it. */
function referenceModal() {
  var app = get().application || {};
  var onFile = !!(app.tasks && app.tasks.reference === 'submitted');
  return '<div class="mhead"><h3>One operating reference</h3>'
    + '<button class="mx" type="button" data-mclose aria-label="Close">×</button></div>'
    + '<div class="mform">'
    + field('ap-refn', 'Name and role', '', {
      required: true, action: '', autocomplete: 'name',
      placeholder: 'Jordan Lee, account manager',
      hint: 'Their name, then how they know your work.'
    })
    + field('ap-refe', 'Email', '', {
      required: true, action: '', type: 'email', autocomplete: 'email',
      placeholder: 'jordan@company.ca',
      hint: 'A work address, where one exists.'
    })
    + '</div>'
    + '<div class="mfoot">'
    + (onFile ? '<span class="mfnote">A reference is already on file. Saving another replaces it.</span>' : '')
    + '<button class="btn" type="button" data-action="app:ref-save">Save reference</button>'
    + '</div>';
}

/* Documents is deliberately absent: it needs its drop listeners wired and its
   state fetched on open, so it goes through openDocuments() below rather than
   through this map. */
var MODALS = {
  registration: registrationModal,
  agreement: agreementModal,
  reference: referenceModal
};

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

/** Re-read the application after any write, so task state comes from the
    server rather than from an optimistic guess made here.

    `boot` marks the first read. A failure there clears the hinted record as
    well, because a guess the server has just declined to confirm is not
    something to leave on screen; a failure after a write leaves the last
    confirmed record where it is. */
function reload(boot) {
  return api.application().then(function (r) {
    set({ application: r, applicationLoaded: true });
    rememberHint(r);
    maybeSubmit();
    return r;
  }, function (err) {
    authFailed(err);
    /* Settled, with nothing. The frame reads this to stop gating, which is
       what hands a partner the console when the route is not deployed yet. */
    set(boot ? { application: null, applicationLoaded: true } : { applicationLoaded: true });
    return null;
  });
}

/* THE FIRST PAINT. The read is one round trip, and on a cold Catalyst function
   that is seconds, during which the frame showed a card that said "reading
   your application" and then swapped it for the real one in front of the
   partner. A new account meets this on its very first visit, one click after
   the welcome screen.

   Same treatment as approvedHint in core/session.js: the server's last answer
   is remembered on the local record, the frame paints from it at boot, and the
   read corrects it one round trip later. A brand new account has no answer to
   remember and does not need one: nothing is done, which is exactly what the
   server is about to say, so the blank draft record paints and the correction
   changes nothing visible. A hint, not a permission: every write still goes
   through a session-gated route, and the server derives state either way.

   Only what the card reads is kept. The registration fields stay off the local
   record; the modal that needs them opens well after the read has answered. */
var HINT_KEYS = ['state', 'tasks', 'operatingName', 'submittedAt', 'decisionDueAt',
  'reapplyAfter', 'decisionNote', 'reviewNote'];

function blankApplication() {
  var tasks = {};
  APP_TASK.forEach(function (k) { tasks[k] = 'empty'; });
  return { state: 'draft', tasks: tasks };
}

function rememberHint(r) {
  var W = window.WHOLLAR;
  if (!W || !W.partner || !r || !r.tasks) return;
  var hint = {};
  HINT_KEYS.forEach(function (k) { if (r[k] != null) hint[k] = r[k]; });
  W.partner.patch({ applicationHint: hint });
}

function hintedApplication() {
  var W = window.WHOLLAR;
  var rec = W && W.partner ? W.partner.read() : null;
  var h = rec && rec.applicationHint;
  return h && h.tasks && typeof h.tasks === 'object' ? h : blankApplication();
}

/* The single most important transition in the pending experience: the moment
   the fifth task lands. Idempotent on both sides. The server stamps
   submittedAt only if unset; this guard stops a second call being made at all,
   so the toast fires once. */
var submitting = false;
function maybeSubmit() {
  var app = get().application;
  if (!app || submitting) return;
  if (app.submittedAt) return;
  if (!applicationComplete()) return;
  submitting = true;
  api.applicationSubmit().then(function (r) {
    set('application', r && r.state ? r : get().application);
    toast('Everything is in. Your 48 hour clock is running.');
  }, function () {
    submitting = false;   /* let a retry happen on the next task write */
  });
}

/* ---- documents: load, upload, remove ---- *
 *
 * The bar is driven by XMLHttpRequest upload progress (core/api.js endpoint 9
 * says why), and progress repaints ONE bar rather than re-rendering the list:
 * innerHTML on every tick of a 10 MB upload is a lot of DOM for a number.
 */

function loadDocuments() {
  return api.documents().then(function (r) {
    set('documents', (r && r.documents) || {});
    paintDocs();
  }, function (err) {
    /* Not a failure worth a red row: the rows already say "choose file", which
       is the right thing to do next whether or not the read answered. */
    authFailed(err);
  });
}

function openDocuments() {
  docWork = {};
  openModal(documentsModal());
  wireDrop();
  loadDocuments();
}

/** Scoped to the list, which is rebuilt on every open, so nothing accumulates.
    Drag events fire on every mouse move; delegating them from the document,
    the way every other action here is delegated, would put that traffic
    through the shared dispatcher for one modal. */
function wireDrop() {
  var host = document.getElementById('ap-docls');
  if (!host) return;
  function rowOf(e) { return e.target.closest ? e.target.closest('[data-doc]') : null; }

  host.addEventListener('dragover', function (e) {
    var row = rowOf(e);
    if (!row) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    row.classList.add('over');
  });
  host.addEventListener('dragleave', function (e) {
    var row = rowOf(e);
    if (row) row.classList.remove('over');
  });
  host.addEventListener('drop', function (e) {
    var row = rowOf(e);
    if (!row) return;
    e.preventDefault();
    row.classList.remove('over');
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) uploadDoc(row.getAttribute('data-doc'), files[0]);
  });
}

/** Refused here as well as on the server, because a 10 MB round trip that ends
    in "too big" is ten megabytes of someone's tether. */
function refuse(file) {
  if (!file) return 'No file was picked.';
  if (file.size > DOC_MAX_BYTES) {
    return 'That file is ' + bytes(file.size) + '. The limit is 10 MB.';
  }
  if (!file.size) return 'That file is empty.';
  /* An exact match against the list, not indexOf on the joined string: a file
     the OS could not type arrives with type '', and ''.indexOf on any string
     is 0, which would wave through every unknown file there is. */
  if (DOC_TYPES.indexOf(file.type) < 0) {
    return 'PDF or image only. That one is ' + (file.type || 'a type your browser could not name') + '.';
  }
  return null;
}

function paintProgress(kind, p) {
  var row = document.querySelector('[data-doc="' + kind + '"]');
  if (!row) return;
  var pct = Math.round(p * 100);
  var bar = row.querySelector('.dbar i');
  var label = row.querySelector('.dtxt small');
  if (bar) bar.style.width = pct + '%';
  if (label) label.textContent = 'Uploading ' + pct + '%';
}

function uploadDoc(kind, file) {
  var bad = refuse(file);
  if (bad) { docWork[kind] = { error: bad }; paintDocs(); return; }

  docWork[kind] = { uploading: true, progress: 0 };
  paintDocs();

  api.documentUpload(kind, file, function (p) {
    var w = docWork[kind];
    if (w && w.uploading) { w.progress = p; paintProgress(kind, p); }
  }).then(function (r) {
    delete docWork[kind];
    if (r && r.documents) set('documents', r.documents);
    paintDocs();
    toast('Attached. Read by a person, and shown to nobody else.');
    reload();
  }, function (err) {
    docWork[kind] = { error: err && err.code === 'NOT_IMPLEMENTED'
      ? 'Uploads are not switched on in this environment yet. Email partners@whollar.ca.'
      : ((err && err.message) || 'That upload did not go through. Please try again.') };
    paintDocs();
    authFailed(err);
  });
}

export function mount() {
  on('click', 'app:modal', function (el) {
    var kind = el.getAttribute('data-kind');
    if (kind === 'documents') { openDocuments(); return; }
    var build = MODALS[kind];
    if (build) openModal(build());
  });

  /* Out of the gated frame and into the console. setGated() is derived in
     renderAll() from current(), and go() runs its listeners synchronously, so
     the frame drops and the nav pane comes back in the same paint rather than
     one hashchange later. */
  on('click', 'app:tasks', function () {
    go('overview');
    if (!applicationComplete()) toast('Pick any order. Each piece starts its own check as it lands.');
  });

  /* Save on blur. The indicator is deliberately quiet and deliberately
     present: silent autosave is indistinguishable from lost work. */
  on('change', 'app:blur', function () {
    saveRegistration(null, true);
  });

  on('click', 'app:hint', function (el) { toggleHint(el); });
  /* A hint closes when attention moves anywhere but its own control or its
     own text, the same rule the coverage combobox follows. */
  onAnyClick(function (e) {
    if (!e.target.closest) return;
    if (!e.target.closest('.ihint') && !e.target.closest('.ipop')) closeHints();
  });

  on('click', 'app:reg-save', function (el) { saveRegistration(el, false); });

  on('change', 'app:agr-toggle', function (el) {
    var btn = document.getElementById('ap-agrgo');
    if (btn) btn.disabled = !el.checked;
  });

  on('click', 'app:agr-save', function (el) {
    var W = window.WHOLLAR;
    if (!W.busy(el, true, 'Signing')) return;
    api.applicationAgreement({ agreement: 'application_terms', accepted: true })
      .then(function () {
        W.busy(el, false);
        closeModal();
        toast('Signed. It is versioned in Contracts the moment you are approved.');
        reload();
      }, function (err) { W.busy(el, false); failed(err); authFailed(err); });
  });

  on('click', 'app:ref-save', function (el) {
    var name = valueOf('ap-refn'), email = valueOf('ap-refe');
    var bad = [];
    if (!name) bad.push('ap-refn');
    if (!email || !EMAIL_SHAPE.test(email)) bad.push('ap-refe');
    markBad(['ap-refn', 'ap-refe'], bad);
    if (bad.length) {
      toast(email && bad.length === 1 && bad[0] === 'ap-refe'
        ? 'That email does not look complete.'
        : 'Name and email, then we are set.');
      return;
    }
    var W = window.WHOLLAR;
    if (!W.busy(el, true, 'Saving')) return;
    api.applicationReference({ nameRole: name, email: email })
      .then(function () {
        W.busy(el, false);
        closeModal();
        toast('Reference saved. Contacted once, and told exactly why.');
        reload();
      }, function (err) { W.busy(el, false); failed(err); authFailed(err); });
  });

  /* One input, reused. The kind rides on the input rather than on a closure,
     so a cancelled pick followed by a second pick on the other row cannot send
     a file to the row it was not dropped on. */
  on('click', 'app:doc-pick', function (el) {
    var input = document.getElementById('ap-docfile');
    if (!input) return;
    input.setAttribute('data-kind', el.getAttribute('data-kind'));
    input.value = '';        /* or picking the same file twice fires no change */
    input.click();
  });

  on('change', 'app:doc-file', function (el) {
    var kind = el.getAttribute('data-kind');
    var file = el.files && el.files[0];
    if (kind && file) uploadDoc(kind, file);
  });

  on('click', 'app:doc-remove', function (el) {
    var kind = el.getAttribute('data-kind');
    docWork[kind] = { uploading: true, progress: 1 };
    paintDocs();
    api.documentDelete(kind).then(function (r) {
      delete docWork[kind];
      if (r && r.documents) set('documents', r.documents);
      paintDocs();
      toast('Removed, and the file with it.');
      reload();
    }, function (err) {
      docWork[kind] = { error: (err && err.message) || 'That did not remove. Please try again.' };
      paintDocs();
      authFailed(err);
    });
  });
}

function valueOf(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

/* Loose on purpose: one @, something either side, a dot after it. The server
   validates for real; this only stops a partner saving a name in the email box
   and finding out later. */
var EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Set .bad on the fields in `bad`, clear it on the rest of `ids`, and put
    focus on the first bad one so the correction is one keystroke away. */
function markBad(ids, bad) {
  ids.forEach(function (id) {
    var el = document.getElementById(id);
    var wrap = el && el.closest('.mfield');
    if (wrap) wrap.classList.toggle('bad', bad.indexOf(id) !== -1);
  });
  var first = bad.length && document.getElementById(bad[0]);
  if (first) first.focus();
}

/** Mark or clear one field. The message goes under the input it belongs to,
    which a toast cannot do: a toast that says "one field is missing" makes the
    partner hunt for which. */
function markField(id, message) {
  var input = document.getElementById(id);
  var wrap = input && input.closest ? input.closest('.mfield') : null;
  if (!wrap) return;
  wrap.classList.toggle('bad', !!message);
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  var hint = wrap.querySelector('.fhint');
  if (!hint) return;
  hint.textContent = message || '';
  hint.hidden = !message;
}

function saveRegistration(btn, quiet) {
  var legal = valueOf('ap-legal'), crtc = valueOf('ap-crtc');
  if (!quiet) {
    markField('ap-legal', legal ? null : 'We need the legal entity as registered.');
    markField('ap-crtc', crtc ? null : 'We need the registration number to run the check.');
  }
  if (!legal || !crtc) {
    if (!quiet) toast('Legal entity and CRTC registration are the two we need.');
    return;
  }
  var W = window.WHOLLAR;
  if (btn && !W.busy(btn, true, 'Saving')) return;

  api.applicationRegistration({
    legalName: legal,
    operatingName: valueOf('ap-oper'),
    crtcRegistration: crtc,
    businessNumber: valueOf('ap-bn')
  }).then(function () {
    if (btn) { W.busy(btn, false); closeModal(); toast('Registration details saved. The register check starts now.'); }
    else {
      var dot = document.getElementById('ap-saved');
      if (dot) {
        dot.hidden = false;
        setTimeout(function () { dot.hidden = true; }, 2000);
      }
    }
    reload();
  }, function (err) {
    if (btn) W.busy(btn, false);
    if (!quiet) failed(err);
    authFailed(err);
  });
}

/** Called by the boot path once. Paints from the hinted record first, so the
    frame never opens on a loading card, then reads. */
export function load() {
  if (!get().application) set('application', hintedApplication());
  return reload(true);
}
