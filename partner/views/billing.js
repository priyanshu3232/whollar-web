/* Billing: a success fee when a switch completes, and only then.
 *
 * Ported from the prototype's renderBilling (1949), stmtLive (1899) and
 * stmtSettled (1930). What changed, and why:
 *
 *   stmtSettled is not ported. It is a constant: 59 activations, three
 *   no-shows, two clawbacks, $6,141.55, none of which came from anywhere. A
 *   settled statement renders here the same way a live one does, from the same
 *   payload, with its settlement dates filled in.
 *
 *   The early-churn clawback line is not ported either. There is no churn
 *   record in this system: nothing tracks a household cancelling inside ninety
 *   days, so a line claiming to have measured it would be the invoice
 *   equivalent of a made-up number. When that record exists the line is one
 *   entry in the server's line list and this view needs no change, which is
 *   the point of the server owning the lines.
 *
 *   The card on file is not ported. There is no payment service provider in
 *   this stack, so "•••• 4189 · expires 04/28" would be a fiction on the one
 *   page where a fiction costs money. What a partner puts on file is the
 *   invoicing arrangement the server actually stores.
 *
 * EVERY FIGURE COMES FROM THE SERVER. Not one total is added up here. The
 * statement is derived server side from the delivery board, so this page and
 * that board cannot disagree, and a partner can check any line against the
 * orders it names.
 */

import { get, set } from '../core/state.js';
import { api } from '../core/api.js';
import { esc, money, plural } from '../core/format.js';
import { fmtDate } from '../core/time.js';
import { on } from '../core/actions.js';
import { open as openModal, close as closeModal } from '../core/modal.js';
import { toast, failed } from '../core/toast.js';
import { bounce } from '../core/session.js';
import { goTo } from '../components/emptystate.js';

export function render() {
  var host = document.getElementById('billing-body');
  if (!host) return;

  /* The prototype's billing screen is three hosts inside a two-column grid
     (#b-cycle, #invcard, #paycard). The console's markup gives every view one
     host, so the grid is built here instead of in index.html: the layout is
     part of what this view renders, and splitting it across two files is how
     the prototype ended up with a render function per div. */
  host.innerHTML = '<div class="grid2"><div>'
    + model()
    + '<div style="margin-top:16px">' + statements() + '</div>'
    + '</div><aside class="aside">'
    + '<section class="card">' + method() + '</section>'
    + reconciliation()
    + '</aside></div>';
}

function model() {
  return '<section class="card" aria-label="How billing works">'
    + '<span class="eyebrow">The model</span>'
    + '<h3>Pay per delivered household</h3>'
    /* The prototype's paragraph, with one clause corrected. It said fees
       "invoice monthly", and the cycle line directly under it says statements
       settle per campaign, not per month. Both cannot be true and the second
       one is: statements are issued per cohort, which is what the server
       does. */
    + '<p class="cardnote">Confirmed counts set your volume tiers and sharpen your bids. '
    + 'The invoice line is the completed switch: a live connection at the cohort rate. '
    + 'Fees accrue at completion and settle per campaign, net-15, with a 14 day '
    + 'reconciliation window.</p>'
    + '<div class="receipt" style="margin-top:12px">' + cycle() + '</div>'
    + '</section>';
}

function reconciliation() {
  return '<section class="card" aria-label="Reconciliation">'
    + '<span class="eyebrow">Reconciliation</span>'
    + '<h3>Dispute a line, keep it simple</h3>'
    + '<p class="cardnote">Every invoice line names a completion date and an anonymized '
    + 'household reference. Flag any line within 14 days and it holds out of the total '
    + 'until resolved.</p>'
    + '</section>';
}

/* ------------------------------------------------------------------ *
 * the cycle line
 * ------------------------------------------------------------------ */

function cycle() {
  var S = get();
  var B = S.billing;

  if (!B || B === 'loading') return '<b>Current cycle:</b> reading your statements.';

  var c = B.cycle || {};
  if (!c.activated) {
    /* The fee is configuration on the agreement record and arrives with the
       statements payload. When it has not, the sentence drops the figure
       rather than printing whatever money() makes of undefined: a billing
       page is the last surface that should show a placeholder where a price
       goes. */
    var each = c.feeEach != null ? money(c.feeEach) : '';
    return '<b>Current cycle:</b> nothing owed. Your first statement generates from your first '
      + 'activated household' + (each ? ', at ' + esc(each) + ' each' : ' at the fee on your agreement')
      + ', per campaign.';
  }
  return '<b>Current cycle:</b> <span class="mono">'
    + esc(c.activated + ' activated · ' + money(c.feeEach) + ' each · ' + money(c.accruing) + ' accruing across '
      + plural(c.cohorts, 'cohort') + ' · net-' + c.netDays) + '</span>';
}

/* ------------------------------------------------------------------ *
 * the statements, one per cohort
 * ------------------------------------------------------------------ */

function statements() {
  var S = get();
  var B = S.billing;

  if (B === 'loading' || (B && B.partial)) return '';
  if (!B) {
    return none(S.approved ? '' : ' Nothing is owed at any point before approval either.', '');
  }
  if (!B.live) {
    return '<section class="card"><span class="eyebrow">Statements</span>'
      + '<h3>Your statements could not be read just now</h3>'
      + '<p class="cardnote">Nothing has changed about what you owe, and nothing settles from a statement we cannot read. '
      + 'Every line is derived from your delivery board, so it can be checked there in the meantime.</p></section>';
  }
  if (!B.statements.length) {
    return none('', goTo('delivery', 'Open the delivery board', 'btn ghost'));
  }
  return B.statements.map(statement).join('');
}

/* Nothing to settle, said as a property of the model rather than as an absence.
   The eyebrow is what makes the card legible before the sentence is read: this
   is the statements slot, and it is empty on purpose. */
function none(extra, cta) {
  return '<section class="card"><span class="eyebrow">Statements</span>'
    + '<div class="empty" style="padding:26px 20px 14px">'
    + '<h3 style="font-size:16.5px">No statements yet, by design</h3>'
    + '<p>Bids are free. Winning is free. Confirmed households are free. The first statement line '
    + 'is the first activation with a clean line test, and statements settle per campaign, not per month.'
    + extra + '</p>' + cta + '</div></section>';
}

var STATE_PILL = { accruing: 'pending', issued: 'due', paid: 'paid', disputed: 'lost' };
var STATE_WORD = { accruing: 'Accruing', issued: 'Issued', paid: 'Paid', disputed: 'In dispute' };

function statement(s) {
  var head = '<div class="sthead"><span class="eyebrow">Statement · '
    + esc(s.region + (s.sub ? ' · ' + s.sub : '')) + '</span>'
    + '<span class="pill ' + (STATE_PILL[s.state] || 'pending') + '" style="margin-left:auto">'
    + esc(STATE_WORD[s.state] || s.state) + '</span></div>';

  var when = s.state === 'paid'
    ? 'Paid ' + (s.paidAt ? fmtDate(s.paidAt) : '')
    : (s.state === 'issued'
      ? 'Issued ' + (s.issuedAt ? fmtDate(s.issuedAt) : '') + ', due ' + (s.dueAt ? fmtDate(s.dueAt) : 'net-15')
      : (s.cycleEndsAt ? 'Cycle ends ' + fmtDate(s.cycleEndsAt) + ', fees accrue on activation and never before'
        : 'Fees accrue on activation, and never before'));

  var lines = s.lines.map(function (l) {
    return line(l.title, l.detail, l.count, amount(l), l.state === 'credited' ? 'neg' : (l.state === 'held' ? 'held' : ''));
  }).join('');

  var tax = line('Sales tax, ' + s.taxPct + '%',
    s.taxRegistration ? 'Registration ' + s.taxRegistration : '', null, money(s.tax), '');

  return '<section class="card" aria-label="Statement">'
    + head
    + '<p class="cardnote" style="margin-top:2px">' + esc(when) + '</p>'
    + '<div class="stls">'
    + lines
    + line('Subtotal', '', null, money(s.subtotal), '')
    + tax
    + '</div>'
    + '<div class="sttot"><span>' + esc(s.state === 'paid' ? 'Paid' : 'Total, net-15') + '</span><b>'
    + esc(money(s.total)) + '</b></div>'
    + (s.held
      ? '<p class="fnote">' + esc(money(s.held)) + ' is held out of that total on '
        + esc(plural(s.counts.linefail, 'line test')) + ' still open. A clean retest releases it; nothing bills while it fails.</p>'
      : '')
    + '<p class="fnote">Every line is an order on your delivery board. '
    + '<button class="tlink" type="button" data-action="bill:lines" data-id="' + esc(s.campaignId) + '">See the lines</button>'
    + (s.disputedLines ? ' · ' + esc(plural(s.disputedLines, 'line')) + ' in dispute, frozen out of the total' : '')
    + '</p></section>';
}

/* A credit is shown as a negative and a held amount in brackets, which is what
   an accountant expects to see and what the prototype did. */
function amount(l) {
  var v = String(l.amount || '0');
  if (v.charAt(0) === '-') return '−' + money(v.slice(1));
  if (l.state === 'held') return '(' + money(v) + ')';
  return money(v);
}

function line(title, detail, count, amt, cls) {
  return '<div class="strow' + (cls ? ' ' + cls : '') + '">'
    + '<span><b>' + esc(title) + '</b>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</span>'
    + '<span class="stn">' + (count == null ? '' : esc(String(count))) + '</span>'
    + '<span class="stamt">' + esc(amt) + '</span></div>';
}

/* ------------------------------------------------------------------ *
 * the method on file
 * ------------------------------------------------------------------ */

function method() {
  var B = get().billing;
  var m = (B && B !== 'loading' && B.method) || null;

  if (m && m.onFile) {
    return '<span class="eyebrow">Payment method</span><h3>Statements go out by invoice</h3>'
      + '<p class="cardnote mono">' + esc(m.email) + '</p>'
      + '<p class="cardnote" style="font-size:12px">Addressed to ' + esc(m.contact || 'your billing contact')
      + '. Settlement is net-15 from each cohort statement, and nothing is ever charged before an activation.</p>'
      + '<button class="tlink" type="button" data-action="bill:method">Update the method →</button>';
  }
  return '<span class="eyebrow">Payment method</span><h3>Nothing on file yet</h3>'
    + '<p class="cardnote">Add one now so your first activation bills cleanly. Nothing is charged '
    + 'until then, and a method on file is one of the two checks that release a won roster.</p>'
    + '<button class="btn forest" type="button" data-action="bill:method" style="margin-top:12px">Add payment method</button>';
}

/* ------------------------------------------------------------------ *
 * load and actions
 * ------------------------------------------------------------------ */


/* A 403 is not a signed-out session, and this page must not treat it as one.
 *
 * core/session.js authFailed() bounces on 401 AND 403, which is right for a
 * read only a signed-in partner can make at all. It is wrong for this one:
 * these routes sit behind requireApproved, so an org still under review, or an
 * account with no org membership, answers 403 on every boot, and bouncing on
 * that signs the partner straight back out of the console they just signed
 * into. Only a 401 means the session is gone.
 */
function signedOut(err) {
  if (err && err.status === 401) bounce();
  return !!(err && err.status === 401);
}

/**
 * The method on file, and nothing else.
 *
 * One row, one read. The overview checklist ticks its billing step from this
 * and the roster gate is refused without it, so it is the one part of billing
 * a partner who never opens this page still needs. The statements are four
 * reads (awards, orders, settlements, config) and they wait for the view.
 *
 * That split is not only tidiness. The Data Store is metered, and this used to
 * pull the whole statement set on every console boot to decide whether to draw
 * one tick.
 */
export function loadMethod() {
  return api.paymentMethod().then(function (r) {
    var B = get().billing;
    var base = (B && B !== 'loading') ? B : { statements: [], cycle: {}, live: true, partial: true };
    set('billing', Object.assign({}, base, { method: (r && r.method) || null }));
  }, function (err) {
    signedOut(err);
  });
}

export function load() {
  set('billing', 'loading');
  return api.statements().then(function (r) {
    set('billing', {
      statements: (r && r.statements) || [],
      cycle: (r && r.cycle) || {},
      method: (r && r.method) || null,
      live: !!r && r.live !== false
    });
  }, function (err) {
    signedOut(err);
    /* 403 before approval is not a failure to report: there is nothing to bill
       and the empty state already says so. */
    set('billing', err && err.status === 403 ? null : { statements: [], cycle: {}, method: null, live: false });
  });
}

export function mount() {
  on('click', 'bill:method', function () { openModal(methodModal()); });

  on('input', 'bill:method:field', function () {
    var go = document.getElementById('pm-go');
    var email = (document.getElementById('pm-email') || {}).value || '';
    var contact = (document.getElementById('pm-contact') || {}).value || '';
    var ok = document.getElementById('pm-ok');
    if (go) go.disabled = !(email.indexOf('@') > 0 && contact.trim().length > 1 && ok && ok.checked);
  });
  on('change', 'bill:method:ok', function () {
    var go = document.getElementById('pm-go');
    var email = (document.getElementById('pm-email') || {}).value || '';
    var contact = (document.getElementById('pm-contact') || {}).value || '';
    var ok = document.getElementById('pm-ok');
    if (go) go.disabled = !(email.indexOf('@') > 0 && contact.trim().length > 1 && ok && ok.checked);
  });

  on('click', 'bill:method:go', function (el) {
    var W = window.WHOLLAR;
    if (!W.busy(el, true, 'Saving')) return;
    api.paymentMethodSave({
      email: (document.getElementById('pm-email') || {}).value,
      contact: (document.getElementById('pm-contact') || {}).value,
      acceptsNet15: true
    }).then(function () {
      W.busy(el, false);
      closeModal();
      return load().then(function () { toast('Billing method on file. Nothing is charged until a switch completes.'); });
    }, function (err) {
      W.busy(el, false);
      failed(err);
      signedOut(err);
    });
  });

  on('click', 'bill:method:remove', function (el) {
    var W = window.WHOLLAR;
    if (!W.busy(el, true, 'Removing')) return;
    api.paymentMethodRemove().then(function () {
      W.busy(el, false);
      closeModal();
      return load().then(function () {
        toast('Method taken off file. Rosters you have not released stay gated until a new one is added.');
      });
    }, function (err) {
      W.busy(el, false);
      failed(err);
      signedOut(err);
    });
  });

  on('click', 'bill:lines', function (el) {
    var id = el.getAttribute('data-id');
    api.statement(id).then(function (r) { openModal(linesModal(r)); },
      function (err) { failed(err); signedOut(err); });
  });

  on('click', 'bill:dispute', function (el) { openModal(disputeModal(el.getAttribute('data-id'))); });
  on('input', 'bill:dispute:field', function (el) {
    var go = document.getElementById('dis-go');
    if (go) go.disabled = String(el.value || '').trim().length < 10;
  });
  on('click', 'bill:dispute:go', function (el) {
    var W = window.WHOLLAR;
    var note = (document.getElementById('dis-note') || {}).value;
    if (!W.busy(el, true, 'Flagging')) return;
    api.lineDispute(el.getAttribute('data-id'), note).then(function () {
      W.busy(el, false);
      closeModal();
      return load().then(function () {
        toast('Flagged. That line is frozen out of the total; the rest of the statement is untouched.');
      });
    }, function (err) {
      W.busy(el, false);
      failed(err);
      signedOut(err);
    });
  });
}

/* ------------------------------------------------------------------ *
 * modals
 * ------------------------------------------------------------------ */

function head(title) {
  return '<div class="mhead"><h3>' + esc(title) + '</h3>'
    + '<button class="mx" type="button" data-mclose aria-label="Close">×</button></div>';
}

function methodModal() {
  var m = ((get().billing || {}).method) || {};
  return head('Billing method')
    + '<p class="msub">Statements are issued per cohort and settle net-15. There is no card to add: '
    + 'Whollar invoices you for activated households, and nothing else has ever been billable.</p>'
    + '<label class="clabel" for="pm-email">Where statements go</label>'
    + '<input class="cselect" id="pm-email" type="email" inputmode="email" autocomplete="email" '
    + 'value="' + esc(m.email || '') + '" data-action="bill:method:field" placeholder="accounts@yourcompany.ca">'
    + '<label class="clabel" for="pm-contact">Addressed to</label>'
    + '<input class="cselect" id="pm-contact" type="text" value="' + esc(m.contact || '') + '" '
    + 'data-action="bill:method:field" placeholder="Accounts payable">'
    + '<label class="consent"><input type="checkbox" id="pm-ok" data-action="bill:method:ok">'
    + '<span>We accept net-15 settlement on activated households, at the success fee on our agreement.</span></label>'
    + '<button class="btn" type="button" id="pm-go" data-action="bill:method:go" disabled '
    + 'style="width:100%;justify-content:center;margin-top:12px">Save the method</button>'
    + (m.onFile
      ? '<button class="tlink" type="button" data-action="bill:method:remove" style="margin-top:10px">Take it off file</button>'
      : '');
}

function linesModal(r) {
  var s = (r && r.statement) || {};
  var lines = (r && r.lines) || [];
  var rows = lines.map(function (l) {
    var what = l.state === 'act' ? 'Success fee'
      : (l.state === 'noshow' ? 'Missed-visit credit' : 'Held, line test open');
    return '<tr><td class="mono" style="font-size:12px">' + esc(l.orderNo || '·') + '</td>'
      + '<td style="font-size:12.5px">' + esc(what) + '</td>'
      + '<td style="font-size:12px">' + esc(l.activatedAt ? fmtDate(l.activatedAt) : '·') + '</td>'
      + '<td style="text-align:right">'
      + (l.disputeState === 'open'
        ? '<span class="pill pending">Flagged</span>'
        : '<button class="tlink" type="button" data-action="bill:dispute" data-id="' + esc(l.key) + '">Dispute</button>')
      + '</td></tr>';
  }).join('');

  return head('Lines on this statement')
    + '<p class="msub">Every line is one order on your delivery board. No address appears here: '
    + 'reconciling a fee does not need one.</p>'
    + (rows
      ? '<div class="twrap"><table class="tbl"><thead><tr><th>Order</th><th>Line</th><th>Activated</th><th></th></tr></thead>'
        + '<tbody>' + rows + '</tbody></table></div>'
      : '<p class="cardnote">No billable line yet on ' + esc(s.region || 'this cohort') + '. '
        + 'The first one is the first activation with a clean line test.</p>');
}

function disputeModal(key) {
  return head('Dispute one line')
    + '<p class="msub">This freezes the line and nothing else. The rest of the statement stands, '
    + 'and the order on your board is untouched: a dispute is a claim about a fee, not about whether the install happened.</p>'
    + '<label class="clabel" for="dis-note">What is wrong with it?</label>'
    + '<textarea class="cselect" id="dis-note" rows="3" data-action="bill:dispute:field" '
    + 'placeholder="The line test failed on the day and the retest is booked."></textarea>'
    + '<button class="btn" type="button" id="dis-go" data-action="bill:dispute:go" data-id="' + esc(key) + '" disabled '
    + 'style="width:100%;justify-content:center;margin-top:12px">Flag this line</button>';
}
