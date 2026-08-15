/* Delivery: won cohorts become rosters, and only a live connection bills.
 *
 * Ported from the prototype's renderDelivery (line 2884) and openGate (1544).
 * The prototype's five stage-aware empty states are ported; its seeded roster,
 * its logistics and RMA cards, and its settled-cohort branch are not. Those
 * read from `P.rosters`, a client-side array `seedRoster` filled with random
 * street names, and there is no batch, waybill or RMA record anywhere in this
 * system to replace them with. A card that invents three gateway shipments is
 * worse than no card: a partner would go looking for the tracking numbers.
 *
 * WHAT THE SERVER OWNS, AND WHY THIS FILE CANNOT CHEAT. The roster response
 * carries counts always and the `orders` key only once the gate has passed.
 * Before the gate the key is ABSENT, not empty, so there is nothing here to
 * render and nothing to accidentally reveal: the addresses were never
 * transmitted. core/contract.js asserts both shapes on arrival, which is the
 * point of asserting them a second time on this side.
 *
 * THE GATE IS NOT A FORM. Its three rows are the three checks routes/delivery.js
 * makes server side, in the same order, with the same words. If this view let
 * someone past, the route would still refuse, and the partner would be looking
 * at a board the server had already decided they could not have.
 */

import { get, set } from '../core/state.js';
import { api } from '../core/api.js';
import { esc, plural } from '../core/format.js';
import { fmtDate, fmtTime } from '../core/time.js';
import { on } from '../core/actions.js';
import { open as openModal, close as closeModal } from '../core/modal.js';
import { toast, failed } from '../core/toast.js';
import { bounce } from '../core/session.js';
import { empty, goTo } from '../components/emptystate.js';
import { gateRow } from '../components/gate.js';
import { ORDER_LABEL, RELEASE_REASON, RELEASE_LABEL, ORDER_EXCEPTION } from '../core/contract.js';

/* Which pill each state wears. The three exceptions share one, because they
   share a meaning to the person reading the board: this one needs you. */
var PILL = {
  acc: 'pending', bkd: 'sealed', act: 'won', rel: 'lost',
  noshow: 'lost', access: 'lost', linefail: 'lost'
};

export function render() {
  var host = document.getElementById('del-body');
  if (!host) return;
  var S = get();

  if (!S.approved) {
    host.innerHTML = empty('Delivery opens at approval',
      'Win a cohort and every household that accepted your offer lands here with an install slot and a state. Nothing reaches this board before your application clears.',
      goTo('pending', 'See where the review stands', 'btn ghost'));
    return;
  }

  var D = S.delivery;
  if (D === 'loading') { host.innerHTML = card('Reading your delivery board.'); return; }
  if (!D) { host.innerHTML = waiting(S); return; }
  if (!D.live) {
    host.innerHTML = card('Your delivery board could not be read just now. Nothing about your cohorts has changed, and nothing bills from a board we cannot read.');
    return;
  }
  if (!D.cohorts.length) { host.innerHTML = waiting(S); return; }

  var chosen = D.cohorts.filter(function (c) { return c.campaignId === S.deliveryCohort; })[0] || D.cohorts[0];
  host.innerHTML = picker(S, D, chosen)
    + (chosen.orders ? board(S, chosen) : gated(S, chosen));
}

function card(note) {
  return '<section class="card"><span class="eyebrow">Delivery</span>'
    + '<h3>Won cohorts become rosters</h3><p class="cardnote">' + esc(note) + '</p></section>';
}

/* ------------------------------------------------------------------ *
 * before there is anything to deliver
 *
 * Four states, each naming what fills this page next. The prototype's version
 * of this is the best thing in it: a partner mid-auction opens Delivery and
 * learns what day one looks like, rather than reading "no data".
 * ------------------------------------------------------------------ */

function waiting(S) {
  var mine = S.campaigns.filter(function (c) { return S.bids[c.id]; });
  var offers = mine.filter(function (c) { return c.stage === 'offers_out'; })[0];
  if (offers) {
    return '<section class="card"><span class="eyebrow gld">Decisions are live</span>'
      + '<h3>' + esc(offers.region) + ' households are deciding</h3>'
      + '<p class="cardnote">Bids are closed and your offer is with the cohort. Every household that accepts lands here with an address and an install slot, the moment the result is in.</p>'
      + '<p class="fnote">Confirmations cost nothing. Your first statement line is your first clean activation.</p></section>';
  }

  var sealed = mine.filter(function (c) { return c.stage === 'open' || c.stage === 'closing'; })[0];
  if (sealed) {
    return '<section class="card"><span class="eyebrow">If ' + esc(sealed.region) + ' confirms you</span>'
      + '<h3>Day one looks like this</h3>'
      + '<p class="cardnote">Every household that accepted, with an order number, the install slot they picked, and a state that becomes a statement line only when the line tests clean.</p>'
      + '<div class="ghostwrap"><div class="twrap ghost"><table class="tbl rtbl">'
      + '<thead><tr><th>Order</th><th>Install</th><th>State</th><th>Next</th></tr></thead><tbody>'
      + '<tr><td class="mono">WHL-••••-C</td><td>Household picks</td><td>To book</td><td>Awaiting slot</td></tr>'
      + '<tr><td class="mono">WHL-••••-C</td><td>Household picks</td><td>Booked</td><td>On track</td></tr>'
      + '<tr><td class="mono">WHL-••••-C</td><td>·</td><td>Activated</td><td>Fee accrues</td></tr>'
      + '</tbody></table></div><div class="ghostlbl"><span>Sample · not your data</span></div></div>'
      + '</section>';
  }

  var open = S.campaigns.filter(function (c) {
    return (c.stage === 'open' || c.stage === 'closing') && !S.bids[c.id];
  })[0];
  if (open) {
    return empty('Delivery starts with a win, and a win starts with one sealed number',
      esc(open.region) + ' is open in your coverage. Sealed both ways: your bid stands on its own merits, and only completed switches ever bill.',
      goTo('desk', 'Review the brief and bid', 'btn'));
  }

  return empty('Your first delivery board builds itself',
    'Win a cohort and every household that accepted your offer lands here with an order number, the install slot they picked, and a state that becomes a statement line only when the line tests clean. Addresses release at acceptance, under each household’s consent, and to nobody else.',
    goTo('desk', 'Open the bid desk', 'btn'));
}

/* ------------------------------------------------------------------ *
 * the cohort picker, and the capacity control beside it
 * ------------------------------------------------------------------ */

function picker(S, D, chosen) {
  var opts = D.cohorts.map(function (c) {
    var name = regionOf(S, c.campaignId);
    var tail = c.orders ? plural(c.counts.total, 'household') : 'roster gated';
    return '<option value="' + esc(c.campaignId) + '"' + (c === chosen ? ' selected' : '') + '>'
      + esc(name + ' · ' + tail) + '</option>';
  }).join('');

  var cap = chosen.award && chosen.award.capacityWeekly;
  return '<div class="omhead">'
    + '<div><label class="omlab">Cohort</label>'
    + '<select class="cselect" style="max-width:340px" data-action="del:cohort">' + opts + '</select></div>'
    + (chosen.orders
      ? '<span class="omcap"><label class="omlab">Install appointments per week</label>'
        + '<input class="capin" type="number" min="1" max="500" inputmode="numeric" value="' + esc(String(cap || '')) + '" '
        + 'data-action="del:capacity" data-id="' + esc(chosen.campaignId) + '" style="margin-left:0"> '
        + '<small>shown to households when they book a slot</small></span>'
      : '')
    + '</div>';
}

function regionOf(S, id) {
  var c = S.campaigns.filter(function (x) { return x.id === id; })[0];
  return c ? (c.region + (c.sub ? ' · ' + c.sub : '')) : id;
}

/* ------------------------------------------------------------------ *
 * gated: counts, and the one step that releases the rest
 * ------------------------------------------------------------------ */

function gated(S, c) {
  var g = (c.award && c.award.gate) || {};
  var n = c.counts.total;
  return '<section class="card"><span class="eyebrow gld">Won, roster gated</span>'
    + '<h3>' + esc(regionOf(S, c.campaignId)) + ' is yours. One step before the roster releases.</h3>'
    + '<p class="cardnote">'
    + (n ? esc(plural(n, 'household') + ' accepted your offer.') : 'Households are accepting your offer now.')
    + ' Complete billing setup and state your install capacity, then their addresses release to you, and only you.</p>'
    + '<div style="margin-top:12px">'
    + gateRow(g.billing ? 'dn' : 'now', 1, 'Billing method on file',
      'Nothing charges now. A statement is only ever activated households, and it settles per cohort, net-15.',
      g.billing ? '' : '<button class="tlink" type="button" data-action="nav" data-view="billing">Add a method</button>')
    + gateRow(g.capacity ? 'dn' : (g.billing ? 'now' : ''), 2, 'Install capacity',
      'How many installs you can run per week in this region. It plans the switch window and it does not change your bid.')
    + gateRow(g.consent ? 'dn' : '', 3, 'Confidentiality acknowledgement',
      'Household details are released under each household’s consent, for delivering this cohort only.')
    + '</div>'
    + '<button class="btn" type="button" style="margin-top:14px" data-action="del:gate" data-id="' + esc(c.campaignId) + '">Release my roster</button>'
    + '<p class="fnote">Counts are visible before the gate; addresses are not, and were never sent to this page.</p>'
    + '</section>';
}

/* ------------------------------------------------------------------ *
 * the board
 * ------------------------------------------------------------------ */

function tile(label, n, sub, cls) {
  return '<div class="card mt"><span class="l">' + esc(label) + '</span>'
    + '<span class="n' + (cls ? ' ' + cls : '') + '">' + n + '</span>'
    + '<span class="s">' + esc(sub) + '</span></div>';
}

function board(S, c) {
  var k = c.counts;
  var tiles = '<div class="tiles om4">'
    + tile('Accepted', k.total, 'addresses released to you at acceptance')
    + tile('Booked', k.booked, k.acc ? k.acc + ' awaiting a slot' : 'every household has a date')
    + tile('Activated', k.act, 'line test clean, the fee accrues here', k.act ? 'hotn' : '')
    + tile('Exceptions', k.exceptions,
      k.noshow + ' no-show, ' + k.access + ' access denied, ' + k.linefail + ' line test failed',
      k.exceptions ? 'excn' : '')
    + '</div>';

  var rows = c.orders.map(function (o) { return row(o); }).join('');

  return tiles
    + '<section class="card" style="margin-top:16px">'
    + '<span class="eyebrow">' + esc(regionOf(S, c.campaignId)) + '</span><h3>Order management</h3>'
    + '<p class="cardnote">' + esc(k.exceptions
      ? 'Exceptions first: each one cleared is a fee unlocked and a point on your record.'
      : 'Every accepted household to a clean activation. Released households cost nothing on either side.') + '</p>'
    + '<div class="twrap"><table class="tbl rtbl"><thead><tr>'
    + '<th>Order</th><th>Install</th><th>State</th><th>Next</th><th></th></tr></thead><tbody>'
    + rows
    + '</tbody></table></div>'
    + '<p class="fnote">Addresses were released at acceptance under each household’s consent, for delivering this cohort only. '
    + 'A failed line test holds the fee, it never bills it. Every read of this board is logged.</p>'
    + '</section>';
}

function row(o) {
  var id = esc(o.key);
  var actions = [];
  if (o.state === 'acc' || o.state === 'bkd' || ORDER_EXCEPTION.indexOf(o.state) >= 0) {
    actions.push(btn('del:slot', id, o.state === 'acc' ? 'Book' : 'Rebook'));
  }
  if (o.state === 'bkd' || o.state === 'linefail') {
    actions.push(btn('del:activate', id, 'Activate'));
  }
  if (o.state === 'bkd') {
    actions.push(btn('del:exception', id, 'Log an exception'));
  }
  if (o.state !== 'act' && o.state !== 'rel') {
    actions.push(btn('del:release', id, 'Cannot serve'));
  }

  return '<tr>'
    + '<td class="mono" style="font-size:12px">' + esc(o.orderNo || '·')
    + '<small style="display:block;font-family:var(--body);font-size:11px;color:var(--sub)">'
    + esc([o.fsa, o.address].filter(Boolean).join(' · ')) + '</small></td>'
    + '<td style="font-size:12.5px;white-space:nowrap">'
    + (o.slotAt ? esc(fmtDate(o.slotAt) + ', ' + fmtTime(o.slotAt)) : '·') + '</td>'
    + '<td><span class="pill ' + PILL[o.state] + '">' + esc(ORDER_LABEL[o.state] || o.state) + '</span>'
    + (o.note ? '<small style="display:block;font-size:11px;color:var(--sub);margin-top:3px;max-width:34ch">' + esc(o.note) + '</small>' : '')
    + '</td>'
    + '<td style="font-size:12px;font-weight:650;white-space:nowrap">' + esc(next(o)) + '</td>'
    + '<td style="text-align:right;white-space:nowrap">' + actions.join(' ') + '</td>'
    + '</tr>';
}

function btn(action, id, label) {
  return '<button class="tlink" type="button" data-action="' + action + '" data-id="' + id + '">' + esc(label) + '</button>';
}

/* What this order is waiting on, in the partner's terms. Never a countdown:
   there is no SLA record in this build, and a clock with nothing behind it is
   the kind of number that ends up in a contract argument. */
function next(o) {
  if (o.state === 'act') return 'Fee accrues';
  if (o.state === 'rel') return RELEASE_LABEL[o.releaseReason] || 'Released';
  if (o.state === 'acc') return 'Awaiting a slot';
  if (o.state === 'bkd') return 'Install booked';
  if (o.state === 'noshow') return 'Offer three slots';
  if (o.state === 'access') return 'Building access';
  if (o.state === 'linefail') return 'Retest, fee held';
  return '·';
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

/** Fetched on view-open and explicit refresh, never polled: every read of a
    released roster writes an audit row naming the count. */
export function load() {
  set('delivery', 'loading');
  return api.orders().then(function (r) {
    set('delivery', {
      cohorts: (r && r.cohorts) || [],
      live: !!r && r.live !== false
    });
  }, function (err) {
    signedOut(err);
    set('delivery', { cohorts: [], live: false });
  });
}

function refresh() { return load(); }

export function mount() {
  on('change', 'del:cohort', function (el) { set('deliveryCohort', el.value); });

  on('change', 'del:capacity', function (el) {
    var n = parseInt(el.value, 10);
    if (!n || n < 1) { toast('State how many installs you can run per week here.'); return; }
    api.capacitySave(el.getAttribute('data-id'), n).then(function () {
      toast('Capacity updated. Households see ' + n + ' slots a week when they book.');
      refresh();
    }, function (err) { failed(err); signedOut(err); });
  });

  /* The gate. Three checks, and the button sends the two this page collects;
     the third, billing, is read from the server's own answer. */
  on('click', 'del:gate', function (el) {
    var id = el.getAttribute('data-id');
    var S = get();
    var c = ((S.delivery || {}).cohorts || []).filter(function (x) { return x.campaignId === id; })[0];
    if (!c) return;
    openModal(gateModal(S, c));
  });

  on('change', 'del:gate:ok', function () { syncGate(); });
  on('input', 'del:gate:cap', function () { syncGate(); });

  on('click', 'del:gate:go', function (el) {
    var id = el.getAttribute('data-id');
    var cap = parseInt((document.getElementById('gate-cap') || {}).value, 10);
    var W = window.WHOLLAR;
    if (!W.busy(el, true, 'Releasing')) return;
    api.rosterGate(id, { capacityWeekly: cap, consent: true }).then(function () {
      W.busy(el, false);
      closeModal();
      return refresh().then(function () {
        toast('Roster released. The addresses are on your delivery board.');
      });
    }, function (err) {
      W.busy(el, false);
      failed(err);
      signedOut(err);
      /* A refusal here is almost always the billing row: re-read, so the gate
         redraws against what the server actually holds. */
      refresh();
    });
  });

  on('click', 'del:slot', function (el) { openModal(slotModal(el.getAttribute('data-id'))); });
  on('click', 'del:slot:go', function (el) {
    var date = (document.getElementById('slot-date') || {}).value;
    var time = (document.getElementById('slot-time') || {}).value || '09:00';
    if (!date) { toast('Pick an install date.'); return; }
    var at = new Date(date + 'T' + time).getTime();
    act(el, api.orderSlot(el.getAttribute('data-id'), at), 'Booked. The household has the date.');
  });

  on('click', 'del:activate', function (el) { openModal(activateModal(el.getAttribute('data-id'))); });
  on('change', 'del:act:ok', function () {
    var go = document.getElementById('act-go');
    var a = document.getElementById('act-line');
    var b = document.getElementById('act-inc');
    if (go) go.disabled = !(a && a.checked && b && b.checked);
  });
  on('click', 'del:act:go', function (el) {
    act(el, api.orderActivate(el.getAttribute('data-id'), {
      lineTestClean: true, incumbentCancelled: true
    }), 'Activated. One statement line, at your contracted fee.');
  });

  on('click', 'del:exception', function (el) { openModal(exceptionModal(el.getAttribute('data-id'))); });
  on('click', 'del:exc:go', function (el) {
    var kind = (document.querySelector('input[name=exc]:checked') || {}).value;
    if (!kind) { toast('Say which exception this was.'); return; }
    act(el, api.orderException(el.getAttribute('data-id'), kind), 'Logged. Nothing bills while it is open.');
  });

  on('click', 'del:release', function (el) { openModal(releaseModal(el.getAttribute('data-id'))); });
  on('click', 'del:rel:go', function (el) {
    var reason = (document.getElementById('rel-reason') || {}).value;
    act(el, api.orderRelease(el.getAttribute('data-id'), reason),
      'Released. Nothing bills, on either side.');
  });
}

/** Every board write ends the same way: close, re-read, say what happened. */
function act(el, promise, msg) {
  var W = window.WHOLLAR;
  if (!W.busy(el, true, 'Saving')) return;
  promise.then(function () {
    W.busy(el, false);
    closeModal();
    return refresh().then(function () { toast(msg); });
  }, function (err) {
    W.busy(el, false);
    failed(err);
    signedOut(err);
  });
}

function syncGate() {
  var go = document.getElementById('gate-go');
  var ok = document.getElementById('gate-ok');
  var cap = parseInt((document.getElementById('gate-cap') || {}).value, 10);
  if (go) go.disabled = !(ok && ok.checked && cap > 0);
}

/* ------------------------------------------------------------------ *
 * the modals
 * ------------------------------------------------------------------ */

function head(title) {
  return '<div class="mhead"><h3>' + esc(title) + '</h3>'
    + '<button class="mx" type="button" data-mclose aria-label="Close">×</button></div>';
}

function gateModal(S, c) {
  var g = (c.award && c.award.gate) || {};
  var n = c.counts.total;
  return head(regionOf(S, c.campaignId) + ': release your roster')
    + '<p class="msub">'
    + (n ? esc(plural(n, 'household') + ' accepted your offer.') : 'Households are accepting your offer.')
    + ' Two checks, then their details release to you.</p>'
    + gateRow(g.billing ? 'dn' : 'now', 1, 'Billing method on file',
      'Nothing charges now. A statement is only ever activated households, and it settles per cohort, net-15.',
      g.billing ? '' : '<button class="tlink" type="button" data-action="nav" data-view="billing">Add a method</button>')
    + gateRow('now', 2, 'Install capacity',
      'How many installs can you run per week in this region? This plans the switch window; it does not change your bid.',
      '<input id="gate-cap" class="capin" type="number" min="1" max="500" inputmode="numeric" '
      + 'value="' + esc(String((c.award && c.award.capacityWeekly) || '')) + '" data-action="del:gate:cap">')
    + '<label class="consent" style="margin-top:12px">'
    + '<input type="checkbox" id="gate-ok" data-action="del:gate:ok">'
    + '<span>I understand household details are confidential, released under each household’s consent, '
    + 'for delivering this cohort only.</span></label>'
    + '<button class="btn" type="button" id="gate-go" data-action="del:gate:go" data-id="' + esc(c.campaignId) + '" '
    + 'disabled'
    + ' style="width:100%;justify-content:center;margin-top:12px">Release my roster</button>'
    + (g.billing ? '' : '<p class="fnote">The billing method is checked again by the server when you press this.</p>');
}

function slotModal(key) {
  return head('Book the install')
    + '<p class="msub">The date the household agreed to. They see it on their side the moment you save it.</p>'
    + '<label class="clabel" for="slot-date">Install date</label>'
    + '<input class="cselect" type="date" id="slot-date">'
    + '<label class="clabel" for="slot-time">Arrival window starts</label>'
    + '<input class="cselect" type="time" id="slot-time" value="09:00">'
    + '<button class="btn" type="button" data-action="del:slot:go" data-id="' + esc(key) + '" '
    + 'style="width:100%;justify-content:center;margin-top:14px">Save the slot</button>';
}

function activateModal(key) {
  return head('Activate this switch')
    + '<p class="msub">This is the only event that creates a statement line, so both of these are recorded with it.</p>'
    + '<label class="consent"><input type="checkbox" id="act-line" data-action="del:act:ok">'
    + '<span>The line tested clean at or above the tier this cohort was bid at.</span></label>'
    + '<label class="consent"><input type="checkbox" id="act-inc" data-action="del:act:ok">'
    + '<span>The household’s incumbent service is confirmed cancelled, so nobody is paying twice.</span></label>'
    + '<button class="btn" type="button" id="act-go" data-action="del:act:go" data-id="' + esc(key) + '" disabled '
    + 'style="width:100%;justify-content:center;margin-top:12px">Activate</button>'
    + '<p class="fnote">If the line came up short, log a line-test exception instead. The fee holds rather than billing, and a clean retest releases it.</p>';
}

function exceptionModal(key) {
  var opts = [
    ['noshow', ORDER_LABEL.noshow, 'Nobody home. A missed-visit credit goes to the household and comes off your statement.'],
    ['access', ORDER_LABEL.access, 'The building or the utility room was not open to you.'],
    ['linefail', ORDER_LABEL.linefail, 'The line tested below the tier. The fee holds until a clean retest.']
  ].map(function (o) {
    return '<label class="consent"><input type="radio" name="exc" value="' + o[0] + '">'
      + '<span><b>' + esc(o[1]) + '</b><br>' + esc(o[2]) + '</span></label>';
  }).join('');

  return head('Log an exception')
    + '<p class="msub">You were there and we were not, so this is your call rather than a guess from the data.</p>'
    + opts
    + '<button class="btn" type="button" data-action="del:exc:go" data-id="' + esc(key) + '" '
    + 'style="width:100%;justify-content:center;margin-top:12px">Log it</button>';
}

function releaseModal(key) {
  var opts = RELEASE_REASON.map(function (r) {
    return '<option value="' + r + '">' + esc(RELEASE_LABEL[r]) + '</option>';
  }).join('');
  return head('Release this household')
    + '<p class="msub">Nothing bills on either side, and nothing about your standing changes. '
    + 'The reason is a fixed list because it feeds the serviceability figure future briefs carry beside your bid.</p>'
    + '<label class="clabel" for="rel-reason">Why can this address not be served?</label>'
    + '<select class="cselect" id="rel-reason">' + opts + '</select>'
    + '<button class="btn ghost" type="button" data-action="del:rel:go" data-id="' + esc(key) + '" '
    + 'style="width:100%;justify-content:center;margin-top:14px">Release, and tell the household</button>';
}
