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
 * THE DAY ONE COMPOSITION. The prototype's #ov-day1 block is four things at
 * once, and porting only the middle one loses the screen a new partner
 * actually meets: a heading that says where they are going, the five step
 * activation checklist with its progress bar, the auction calendar under it,
 * and an aside carrying the three rules, the one next step, and the alert
 * switches. All four are here, every one driven from state rather than from
 * the prototype's demo flags.
 *
 * §8.7, the rule that survives from all of it: never render a wall of zeros.
 * When a surface would show only zeros or only dashes, show what is coming and
 * when instead.
 */

import { get, biddableCampaigns, termsState } from '../core/state.js';
import { esc, plural } from '../core/format.js';
import { fmtDate, fmtTime, fmtCountdown, until, sameDay, now, DAY } from '../core/time.js';
import { checklistHTML } from './application.js';
import { alertsHTML } from './account.js';
import { activationTasks, progress } from '../components/tasks.js';
import { empty, goTo } from '../components/emptystate.js';

export function render() {
  var host = document.getElementById('ov-body');
  if (!host) return;
  var S = get();

  /* Pending: the application checklist is the console. Precedence over the
     no-coverage branch, which is exactly the ordering the prototype had and
     could not express. */
  if (!S.approved) {
    /* The review card sits in the ASIDE, in the slot the approved console
       gives to nextStep(): it is the same kind of thing, the one card that
       says what happens next, and the left column stays the work itself.
       That is also the prototype's layout, where #cs-title is a static card
       between "How auctions work" and the alert switches. */
    host.innerHTML = head('Let’s get you to your first cohort.',
      'Fill these at your pace: each piece starts its own check the moment it lands.')
      + '<div class="grid2"><div>' + checklistHTML() + calendar(S) + '</div>'
      + '<aside class="aside">' + howItWorks() + reviewCard(S) + alertsHTML() + '</aside></div>';
    return;
  }

  var act = activation(S);

  /* The checklist is the left column until a first sealed bid exists, which is
     the prototype's renderOvLive swap with a condition the console can
     actually answer. The stats card joins it only when it has something to
     say, so a first day is not two cards deep in the same sentence. */
  var left = act.bid ? '' : tasks(act);
  if (deskWorthShowing(S)) left += left ? '<div style="margin-top:16px">' + desk(S) + '</div>' : desk(S);
  left += calendar(S);

  host.innerHTML = head(act.bid ? 'Your cohorts, at a glance' : 'Let’s get you to your first cohort.', subline(S, act))
    + '<div class="grid2"><div>' + left + '</div>'
    + '<aside class="aside">' + howItWorks() + nextStep(S) + alertsHTML() + '</aside></div>';
}

function head(title, sub) {
  return '<div class="vhead"><h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p></div>';
}

/* The one line under the heading: the prototype's #ov-sub with its precedence
   flattened. No coverage wins over the open count, because a partner with
   nothing declared has nothing open for a reason, and the reason is the line. */
function subline(S, act) {
  if (!act.coverage) return 'Declare your coverage first: auctions only reach your desk from inside it.';

  var open = openCampaigns(S);
  if (!open.length) {
    return agendaEvents(S).length
      ? 'Nothing is open for bids right now. The calendar below shows what is coming.'
      : 'Nothing is open for bids right now, and nothing is scheduled yet in the regions you have declared.';
  }

  var closesToday = sameDay(closeAt(open[0]), now());
  return open.length + (open.length === 1 ? ' auction is' : ' auctions are')
    + ' open in your coverage right now' + (closesToday ? ', one closes today.' : '.');
}

/* ------------------------------------------------------------------ *
 * activation
 *
 * Five steps, each derived from real state rather than from a stored flag,
 * because a checklist that can disagree with the console is worse than no
 * checklist. Two of them read fields no endpoint writes yet (endpoint 39,
 * POST /provider/contracts/terms/accept, and endpoint 58, GET
 * /provider/billing/method), so those two rows stay open until those routes
 * land. That is the honest state rather than a defect: a partner cannot accept
 * the standard terms or add a card from this console today, and each row links
 * to the view that says so.
 * ------------------------------------------------------------------ */

function activation(S) {
  var sealed = Object.keys(S.bids).length > 0;
  return {
    coverage: S.coverage.length > 0,
    /* The same fact the bid ticket gates on, read from the same place
       (contracts.terms), so the checklist and the ticket cannot disagree
       after a version bump. The application field remains the fallback only
       while the contracts payload has not answered yet. */
    terms: termsState() === 'accepted'
      || (termsState() === 'unknown' && !!(S.application && S.application.cohortTermsAcceptedAt)),
    pay: !!(S.billing && S.billing.method && S.billing.method.onFile),
    brief: sealed || Object.keys(S.briefs).length > 0,
    bid: sealed
  };
}

function tasks(act) {
  var built = activationTasks(act);
  return '<section class="card" aria-label="Activation">'
    + '<span class="eyebrow gld">Getting started</span>'
    + '<h3>Five steps to your first sealed bid</h3>'
    + '<div class="tasks">' + built.html + '</div>'
    + progress(built.done, built.total)
    + '<div class="pline"><span>Setup progress</span><b>' + esc(built.label) + '</b></div>'
    + '</section>';
}

/* The review card next to the checklist, with the one link into the frame.
 *
 * The line names each track by what is happening to it rather than counting
 * them. "2 pieces still to come" tells a partner how much is left and nothing
 * about which; "registration details and documents still to come" is the same
 * length and is the answer. Ported from the prototype's v9 #cs-line, with the
 * per-track states read from application_tasks instead of its five booleans.
 */
function reviewCard(S) {
  var app = S.application;
  var t = (app && app.tasks) || {};
  var waiting = Object.keys(t).filter(function (k) { return !t[k] || t[k] === 'empty'; });
  var done = function (k) { return t[k] && t[k] !== 'empty'; };

  var line = app && app.submittedAt && !waiting.length
    ? 'Everything is in. Serviceability is running on your declared regions, the register check is underway, and your reference gets one short email. Approved partners land on the bid desk the same day.'
    : 'Application received. '
      + 'Serviceability ' + (done('coverage') ? 'is checking your declared regions' : 'starts when coverage lands') + '. '
      + 'Registration ' + (done('registration') && done('documents') ? 'and documents are in review' : 'details and documents still to come') + '. '
      + (done('agreement') ? 'Agreement signed.' : 'Agreement not yet signed.');

  return '<section class="card" aria-label="Your application">'
    + '<span class="eyebrow gld">Your application</span>'
    + '<h3>' + (app && app.decisionDueAt
      ? 'Under review · decision by ' + esc(fmtDate(app.decisionDueAt))
      : 'Review runs as you complete') + '</h3>'
    + '<p class="cardnote">' + esc(line)
    + ' <button class="tlink" type="button" data-action="nav" data-view="pending">See the review timeline →</button></p>'
    /* The desk is not empty of information for a partner under review: it says
       what reaches it and when, and links back here. This is the prototype's
       button, kept in the pending branch for that reason. */
    + '<div style="margin-top:12px">' + goTo('desk', 'Open the bid desk') + '</div>'
    + '</section>';
}

/* ------------------------------------------------------------------ *
 * the desk at a glance
 * ------------------------------------------------------------------ */

function closeAt(c) { return ((c.dates || {}).bidding_closes_at) || Infinity; }
function openAt(c) { return ((c.dates || {}).bidding_opens_at) || Infinity; }

/* Every figure under these two says "in your coverage", so they count the
   coverage-matched subset, not the whole platform payload: the campaigns list
   arrives unfiltered by design (the desk shows locked rows), and counting it
   here told a one-region partner that every open auction in Canada was
   theirs. Pending results and sealed bids stay unfiltered on purpose: a bid
   already placed outlives a coverage edit (a coverage change applies to
   future matching only). */
function openCampaigns(S) {
  return biddableCampaigns().filter(function (c) { return c.stage === 'open' || c.stage === 'closing'; })
    .sort(function (a, b) { return closeAt(a) - closeAt(b); });
}

function approachingCampaigns(S) {
  return biddableCampaigns().filter(function (c) { return c.stage === 'planned' || c.stage === 'announced'; })
    .sort(function (a, b) { return openAt(a) - openAt(b); });
}

/* Whether the stats card has anything to say. Without this a partner on their
   first day gets the activation checklist and, directly under it, a card
   explaining that nothing is forming yet, which is the sentence the aside is
   already carrying. */
function deskWorthShowing(S) {
  if (!S.coverage.length) return false;
  return openCampaigns(S).length > 0
    || approachingCampaigns(S).length > 0
    || Object.keys(S.bids).length > 0;
}

function desk(S) {
  var open = openCampaigns(S);
  var sealed = Object.keys(S.bids).length;
  var pending = S.campaigns.filter(function (c) { return c.stage === 'offers_out' && S.bids[c.id]; }).length;

  if (!open.length && !sealed && !pending) return demandApproaching(approachingCampaigns(S));

  var next = open[0];

  return '<section class="card" aria-label="Right now">'
    + '<span class="eyebrow gld">Right now</span><h3>Your desk at a glance</h3>'
    + '<div class="ovstats">'
    + stat(open.length, 'open in your coverage')
    + stat(sealed, 'your sealed bids')
    + stat(pending, 'results pending')
    + stat(next ? fmtDate(closeAt(next)) : '·',
      next ? 'next close · ' + next.region : 'no close scheduled')
    + '</div>'
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
  var first = approaching[0];
  var opensAt = openAt(first);
  var days = isFinite(opensAt) ? Math.max(1, Math.round(until(opensAt) / DAY)) : null;

  return '<section class="card" aria-label="Demand approaching">'
    + '<span class="eyebrow gld">Demand approaching</span>'
    + '<h3>Stop chasing demand. It is on its way to you.</h3>'
    + '<div class="ovstats">'
    + stat(plural(approaching.length, 'cohort'), households
      ? households + ' households combined, forming in your coverage'
      : 'forming in your coverage')
    + stat(first.region, days
      ? 'first to open · ' + fmtDate(opensAt) + ', in ' + plural(days, 'day')
      : 'first to open')
    + '</div>'
    + '<p class="cardnote" style="margin-top:12px">Every household arrives bill-verified, address-validated, serviceability-checked, with a known promo cliff and a declared intent to switch. Known volume and known timing means you price to win a whole cohort instead of gambling one subscriber at a time.</p>'
    + goTo('desk', 'Open the bid desk', 'btn forest')
    + '</section>';
}

function stat(value, label) {
  return '<div class="ovstat"><b>' + esc(String(value)) + '</b><span>' + esc(label) + '</span></div>';
}

/* ------------------------------------------------------------------ *
 * the calendar
 *
 * The next dated things, from campaign timestamps. Not a separate feed: one
 * source means the calendar, the aside and the desk cannot disagree, which is
 * also why the prototype's #agenda1 and #agenda2 are one function here.
 * ------------------------------------------------------------------ */

function agendaEvents(S) {
  var events = [];
  S.campaigns.forEach(function (c) {
    var d = c.dates || {};
    if (c.stage === 'planned' || c.stage === 'announced') {
      events.push({ at: d.bidding_opens_at, title: c.region + ' · bidding opens', note: householdLine(c) });
    } else if (c.stage === 'open' || c.stage === 'closing') {
      events.push({ at: d.bidding_closes_at, title: c.region + ' · bids close', note: 'Improve your bid until this moment' });
    } else if (c.stage === 'offers_out') {
      events.push({ at: d.decision_at, title: c.region + ' · decisions lock', note: householdLine(c) });
    }
  });
  return events.filter(function (e) { return !!e.at && e.at >= now(); })
    .sort(function (a, b) { return a.at - b.at; })
    .slice(0, 5);
}

function householdLine(c) {
  return c.households ? c.households + ' households' : 'A cohort in your coverage';
}

function calendar(S) {
  var events = agendaEvents(S);
  return '<section class="card" style="margin-top:16px" aria-label="This week">'
    + '<span class="eyebrow">This week</span><h3>Auction calendar</h3>'
    + (events.length
      ? '<div class="agenda">' + events.map(agendaRow).join('') + '</div>'
      : '<p class="cardnote">Nothing scheduled in the next while.</p>')
    + '</section>';
}

var MONTH = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function agendaRow(e) {
  var d = new Date(e.at);
  return '<div class="ag" role="button" tabindex="0" data-action="nav" data-view="desk">'
    + '<span class="d' + (sameDay(e.at, now()) ? ' today' : '') + '">'
    + '<b>' + d.getDate() + '</b><span>' + MONTH[d.getMonth()] + '</span></span>'
    + '<span class="t"><b>' + esc(e.title) + '</b><small>' + esc(e.note) + '</small></span>'
    + chip(e.at) + '</div>';
}

/* The chip the one ticker in time.js drives, inside the last day only. A
   countdown on something eight days out is noise, and the date is already
   rendered beside it. */
function chip(ts) {
  if (until(ts) > DAY || until(ts) <= 0) return '';
  return '<span class="cdchip" data-until="' + ts + '">' + fmtCountdown(until(ts)) + '</span>';
}

/* ------------------------------------------------------------------ *
 * the aside
 * ------------------------------------------------------------------ */

function howItWorks() {
  return '<section class="card" aria-label="How auctions work">'
    + '<span class="eyebrow">How auctions work</span><h3>Three rules, no surprises</h3><div class="how">'
    + '<div class="h"><i>1</i><span><b>Sealed.</b> One best number by the deadline.</span></div>'
    + '<div class="h"><i>2</i><span><b>Binding until the deadline.</b> Improve any time before close; no withdrawals after sealing.</span></div>'
    + '<div class="h"><i>3</i><span><b>Pay on completion.</b> Confirmed households set your volume tiers; the invoice is live connections only.</span></div>'
    + '</div></section>';
}

/* The prototype's closing-soon card, carrying layer 2's first-step copy when
   nothing is declared. Its button went to the bid desk in every branch, which
   for a partner with no coverage is a click into an empty table; the
   first-step branch sends them where the step actually is. */
function nextStep(S) {
  var eyebrow, title, line, cta;

  if (!S.coverage.length) {
    eyebrow = 'First step';
    title = 'No coverage declared yet';
    line = 'State the areas you want to bid in and the services you can render there. Auctions appear the moment a region verifies.';
    cta = goTo('coverage', 'Declare your coverage');
  } else {
    var next = openCampaigns(S)[0];
    if (next) {
      var at = closeAt(next);
      eyebrow = sameDay(at, now()) ? 'Closing today' : 'Closing next';
      title = next.region + (next.households ? ' · ' + next.households + ' households' : '');
      line = until(at) <= DAY
        ? 'Sealed bidding closes in <span class="cdchip" data-until="' + at + '">' + fmtCountdown(until(at)) + '</span>'
        : esc('Sealed bidding closes ' + fmtDate(at) + ' at ' + fmtTime(at) + '.');
    } else {
      var soon = approachingCampaigns(S)[0];
      eyebrow = 'Up next';
      title = 'Nothing closing right now';
      line = soon && isFinite(openAt(soon))
        ? esc('Bidding opens on ' + soon.region + ' ' + fmtDate(openAt(soon)) + '. It is on your calendar below.')
        : 'When a cohort forms inside a region you have declared, it lands on your desk and in your inbox.';
    }
    cta = goTo('desk', 'Open the bid desk');
  }

  return '<section class="card" aria-label="Next step">'
    + '<span class="eyebrow gld">' + esc(eyebrow) + '</span>'
    + '<h3>' + esc(title) + '</h3>'
    + '<p class="cardnote">' + line + '</p>'
    + '<div style="margin-top:12px">' + cta + '</div>'
    + '</section>';
}
