/* The overview, which is a different screen depending on where the partner is.
 *
 * The prototype built this as five stacked decorator layers on one function
 * (docs/console/render-inventory.md table B), and two of them wrote the same
 * four DOM nodes. Layer 2's "declare your coverage first" copy was written and
 * then immediately overwritten by layer 3 for every pending partner, so it
 * never shipped for the case it was written for. Flattened here into one
 * function with the precedence made explicit, which is the whole point of
 * flattening: the reachable combinations are pending, approved-without-
 * coverage, and approved-with-coverage, and each gets its own branch rather
 * than its own layer.
 *
 * §8.7, the rule that survives from all of it: never render a wall of zeros.
 * When a surface would show only zeros or only dashes, show what is coming and
 * when instead.
 */

import { get } from '../core/state.js';
import { esc, plural } from '../core/format.js';
import { fmtDate, until, DAY } from '../core/time.js';
import { checklistHTML } from './application.js';
import { empty, goTo } from '../components/emptystate.js';

export function render() {
  var host = document.getElementById('ov-body');
  if (!host) return;
  var S = get();

  var aside = howItWorks();

  /* Pending: the application checklist is the console. Precedence over the
     no-coverage branch, which is exactly the ordering the prototype had and
     could not express. */
  if (!S.approved) {
    host.innerHTML = '<div class="grid2"><div>' + checklistHTML() + reviewCard(S) + '</div>'
      + '<aside class="aside">' + aside + '</aside></div>';
    return;
  }

  /* Approved, nothing declared. */
  if (!S.coverage.length) {
    host.innerHTML = '<div class="grid2"><div>'
      + empty('Declare your coverage first',
        'Auctions only reach your desk from inside it. Name the regions you want to bid in and the services you can render there, and cohorts forming inside them appear the moment a region verifies.',
        goTo('coverage', 'Declare your coverage'))
      + '</div><aside class="aside">' + aside + '</aside></div>';
    return;
  }

  host.innerHTML = '<div class="grid2"><div>' + desk(S) + '</div>'
    + '<aside class="aside">' + aside + '</aside></div>';
}

/* The review card next to the checklist, with the one link into the frame. */
function reviewCard(S) {
  var app = S.application;
  var tasks = (app && app.tasks) || {};
  var running = Object.keys(tasks).filter(function (k) { return tasks[k] === 'verifying'; });
  var waiting = Object.keys(tasks).filter(function (k) { return !tasks[k] || tasks[k] === 'empty'; });

  var line = app && app.submittedAt && !waiting.length
    ? 'Everything is in. Serviceability is running on your declared regions, the register check is underway, and your reference gets one short email.'
    : 'Application received. '
      + (running.length ? plural(running.length, 'check') + ' running now. ' : '')
      + (waiting.length ? plural(waiting.length, 'piece') + ' still to come.' : '');

  return '<section class="card" style="margin-top:16px" aria-label="Your application">'
    + '<span class="eyebrow gld">Your application</span>'
    + '<h3>' + (app && app.decisionDueAt
      ? 'Under review · decision by ' + esc(fmtDate(app.decisionDueAt))
      : 'Review runs as you complete') + '</h3>'
    + '<p class="cardnote">' + esc(line)
    + ' <button class="tlink" type="button" data-action="nav" data-view="pending">See the review timeline →</button></p>'
    + '</section>';
}

/* Approved with coverage. Two shapes: the desk at a glance when something is
   happening, and demand approaching when nothing is. */
function desk(S) {
  var open = S.campaigns.filter(function (c) { return c.stage === 'open' || c.stage === 'closing'; });
  var approaching = S.campaigns.filter(function (c) { return c.stage === 'planned' || c.stage === 'announced'; });
  var sealed = Object.keys(S.bids).length;
  var pending = S.campaigns.filter(function (c) { return c.stage === 'offers_out' && S.bids[c.id]; }).length;

  if (!open.length && !sealed && !pending) return demandApproaching(approaching);

  var next = open.slice().sort(function (a, b) {
    return ((a.dates || {}).bidding_closes_at || Infinity) - ((b.dates || {}).bidding_closes_at || Infinity);
  })[0];

  return '<section class="card" aria-label="Right now">'
    + '<span class="eyebrow gld">Right now</span><h3>Your desk at a glance</h3>'
    + '<div class="ovstats">'
    + stat(open.length, 'open in your coverage')
    + stat(sealed, 'your sealed bids')
    + stat(pending, 'results pending')
    + stat(next ? fmtDate((next.dates || {}).bidding_closes_at) : '·',
      next ? 'next close · ' + next.region : 'no close scheduled')
    + '</div>'
    + upcoming(S)
    + goTo('desk', 'Open the bid desk', 'btn forest')
    + '</section>';
}

/* §8.7's reference implementation. Every figure here is a real campaign in the
   partner's coverage; if there are none, it says there are none. */
function demandApproaching(approaching) {
  if (!approaching.length) {
    return empty('Nothing is forming in your coverage yet',
      'Cohorts form when enough households in one area reach their promo cliff together. When one forms inside a region you have declared, it appears here and on your bid desk, and you get an email.',
      goTo('coverage', 'Add another region', 'btn ghost'));
  }

  var households = approaching.reduce(function (t, c) { return t + (c.households || 0); }, 0);
  var first = approaching.slice().sort(function (a, b) {
    return ((a.dates || {}).bidding_opens_at || Infinity) - ((b.dates || {}).bidding_opens_at || Infinity);
  })[0];
  var opensAt = (first.dates || {}).bidding_opens_at;
  var days = opensAt ? Math.max(1, Math.round(until(opensAt) / DAY)) : null;

  return '<section class="card" aria-label="Demand approaching">'
    + '<span class="eyebrow gld">Demand approaching</span>'
    + '<h3>Stop chasing demand. It is on its way to you.</h3>'
    + '<div class="ovstats">'
    + stat(plural(approaching.length, 'cohort'), households
      ? households + ' households combined, forming in your coverage'
      : 'forming in your coverage')
    + stat(first.region, opensAt ? 'first to open · ' + fmtDate(opensAt) + (days ? ', in ' + plural(days, 'day') : '') : 'first to open')
    + '</div>'
    + '<p class="cardnote" style="margin-top:12px">Every household arrives bill-verified, address-validated, serviceability-checked, with a known promo cliff and a declared intent to switch. Known volume and known timing means you price to win a whole cohort instead of gambling one subscriber at a time.</p>'
    + goTo('desk', 'Open the bid desk', 'btn forest')
    + '</section>';
}

function stat(value, label) {
  return '<div class="ovstat"><b>' + esc(String(value)) + '</b><span>' + esc(label) + '</span></div>';
}

/* The next four dated things, from campaign timestamps. Not a separate feed:
   one source means the calendar, the alerts and this list cannot disagree. */
function upcoming(S) {
  var events = [];
  S.campaigns.forEach(function (c) {
    var d = c.dates || {};
    if (c.stage === 'open' || c.stage === 'closing') events.push(['Bidding closes', c, d.bidding_closes_at]);
    else if (c.stage === 'planned' || c.stage === 'announced') events.push(['Bidding opens', c, d.bidding_opens_at]);
    else if (c.stage === 'offers_out') events.push(['Decisions lock', c, d.decision_at]);
  });
  events = events.filter(function (e) { return !!e[2]; }).sort(function (a, b) { return a[2] - b[2]; }).slice(0, 4);
  if (!events.length) return '';

  return '<div class="uplist">' + events.map(function (e) {
    return '<div class="uprow"><span>' + esc(e[0]) + '</span><b>' + esc(e[1].region) + '</b>'
      + '<em>' + esc(fmtDate(e[2])) + '</em></div>';
  }).join('') + '</div>';
}

function howItWorks() {
  return '<section class="card" aria-label="How auctions work">'
    + '<span class="eyebrow">How auctions work</span><h3>Three rules, no surprises</h3><div class="how">'
    + '<div class="h"><i>1</i><span><b>Sealed.</b> One best number by the deadline. Nobody sees yours, and you see nobody else’s.</span></div>'
    + '<div class="h"><i>2</i><span><b>Binding until the deadline.</b> Improve any time before close. No withdrawals after sealing.</span></div>'
    + '<div class="h"><i>3</i><span><b>Pay on completion.</b> Confirmed households cost nothing. The fee is the activation with a clean line test.</span></div>'
    + '</div></section>';
}
