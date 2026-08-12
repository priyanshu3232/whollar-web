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
import { fmtDate } from '../core/time.js';
import { toast, failed } from '../core/toast.js';
import { on } from '../core/actions.js';
import { open as openModal, close as closeModal } from '../core/modal.js';
import { authFailed } from '../core/session.js';
import { gateRow } from '../components/gate.js';
import { applicationTasks, progress } from '../components/tasks.js';

/* ------------------------------------------------------------------ *
 * the frame
 * ------------------------------------------------------------------ */

export function render() {
  var host = document.getElementById('pend-body');
  if (!host) return;
  var app = get().application;

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
  var org = (get().org && get().org.name) || (app.operatingName) || 'Your company';
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

  return '<section class="card" style="max-width:640px;margin:0 auto">'
    + '<span class="eyebrow">Founding partner application</span>'
    + '<h3>' + (complete ? 'Received. The clock is running.' : 'Received. The rest is yours to start.') + '</h3>'

    + gateRow('dn', '', 'Application received',
      esc(org) + (app.submittedAt ? ' · started ' + esc(fmtDate(app.submittedAt)) : ''))

    + (complete ? '' :
      '<div class="pendcta">'
      + '<button class="btn" type="button" data-action="app:tasks" style="width:100%;justify-content:center">'
      + 'Continue your application · ' + countDone(t) + ' of 5 done</button>'
      + '<small>Five short pieces: coverage, registration, documents, one agreement, one reference. '
      + 'About ten minutes, in any order, and each piece starts its own check the moment it lands.</small></div>')

    + gateRow(covState, 2, 'Serviceability check',
      t.coverage && t.coverage !== 'empty'
        ? 'Running on your ' + regions + ' declared region' + (regions === 1 ? '' : 's') + ' against facilities data.'
        : 'Starts the moment your coverage lands, against facilities data.')

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
    + '<div class="pline"><span>Application progress</span><b>' + esc(built.label) + '</b></div>'
    + '</section>';
}

/* ------------------------------------------------------------------ *
 * the four modals
 *
 * Save on blur, with a visible saved indicator. §8.4 requires it, and the
 * reason is plain: losing a half-filled application to a closed tab is the
 * kind of thing a partner does not come back from.
 * ------------------------------------------------------------------ */

function field(id, label, value, extra) {
  return '<div><label for="' + id + '">' + label + '</label>'
    + '<input type="text" id="' + id + '" value="' + esc(value || '') + '"'
    + ' data-action="app:blur" data-kind="' + (extra || '') + '">'
    + '</div>';
}

function registrationModal() {
  var app = get().application || {};
  return '<div class="mhead"><h3>Registration details</h3>'
    + '<button class="mx" type="button" data-mclose aria-label="Close">×</button></div>'
    + '<p class="msub">Checked once, quietly, against the CRTC register. Nothing here is shown to households or to other partners.</p>'
    + '<div class="two">' + field('ap-legal', 'Legal entity', app.legalName)
    + field('ap-oper', 'Operating name', app.operatingName) + '</div>'
    + '<div class="two">' + field('ap-crtc', 'CRTC registration number', app.crtcRegistration)
    + field('ap-bn', 'Business number <span class="opt2">optional now</span>', app.businessNumber) + '</div>'
    + '<p class="savedot" id="ap-saved" hidden>Saved</p>'
    + '<button class="btn" type="button" data-action="app:reg-save" style="width:100%;justify-content:center;margin-top:14px">Save details</button>';
}

function documentsModal() {
  var docs = get().documents || {};
  function row(kind, label) {
    var d = docs[kind];
    return gateRow(d ? 'dn' : '', '·', label,
      d ? 'On file · ' + esc(d.filename || 'attached') : 'PDF or image, up to 10 MB',
      d ? '' : '<button class="tlink" type="button" data-action="app:doc" data-kind="' + kind + '">Attach</button>');
  }
  return '<div class="mhead"><h3>Documents</h3>'
    + '<button class="mx" type="button" data-mclose aria-label="Close">×</button></div>'
    + '<p class="msub">Two documents, read by a person, kept under the same confidentiality as everything else in your file and deleted on our retention schedule.</p>'
    + row('crtc_registration', 'CRTC registration confirmation')
    + row('business_registration', 'Proof of business registration');
}

function agreementModal() {
  var org = (get().org && get().org.name) || 'Your company';
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

function referenceModal() {
  return '<div class="mhead"><h3>One operating reference</h3>'
    + '<button class="mx" type="button" data-mclose aria-label="Close">×</button></div>'
    + '<p class="msub">Contacted once, told exactly why, never added to any list.</p>'
    + '<div class="two">'
    + '<div><label for="ap-refn">Name and role</label><input type="text" id="ap-refn" placeholder="e.g. wholesale account manager"></div>'
    + '<div><label for="ap-refe">Email</label><input type="text" id="ap-refe" placeholder="name@company.ca"></div>'
    + '</div>'
    + '<button class="btn" type="button" data-action="app:ref-save" style="width:100%;justify-content:center;margin-top:14px">Save reference</button>';
}

var MODALS = {
  registration: registrationModal,
  documents: documentsModal,
  agreement: agreementModal,
  reference: referenceModal
};

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

/** Re-read the application after any write, so task state comes from the
    server rather than from an optimistic guess made here. */
function reload() {
  return api.application().then(function (r) {
    set('application', r);
    maybeSubmit();
    return r;
  }, function (err) { authFailed(err); return null; });
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

export function mount() {
  on('click', 'app:modal', function (el) {
    var kind = el.getAttribute('data-kind');
    var build = MODALS[kind];
    if (build) openModal(build());
  });

  on('click', 'app:tasks', function () {
    location.hash = '#overview';
  });

  /* Save on blur. The indicator is deliberately quiet and deliberately
     present: silent autosave is indistinguishable from lost work. */
  on('change', 'app:blur', function () {
    saveRegistration(null, true);
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
    if (!name || !email) { toast('Name and email, then we are set.'); return; }
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

  /* Uploads go through a presign (endpoints 8 and 9), which is still stubbed.
     Saying so beats a button that appears to work. */
  on('click', 'app:doc', function () {
    toast('Document upload lands with the file store. Email partners@whollar.ca and we will take them by reply.');
  });
}

function valueOf(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function saveRegistration(btn, quiet) {
  var legal = valueOf('ap-legal'), crtc = valueOf('ap-crtc');
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

/** Called by the boot path once, and after approval changes. */
export function load() {
  return reload();
}
