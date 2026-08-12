/* The bid desk: every cohort in your coverage, its stage, and its clock.
 *
 * STAGE COMES FROM THE PAYLOAD. There is no stageOf() here and there must not
 * be. lib/catalog.js derives it server side from the campaign's timestamps and
 * sends it on every read; a browser clock a few minutes fast would otherwise
 * show a closed auction as open and let a partner write a bid the server then
 * refuses, which is a worse experience than the row simply having closed.
 *
 * Countdowns offset from the serverTime captured at fetch, through
 * time.until(), never from a bare Date.now().
 */

import { get } from '../core/state.js';
import { esc, regionSlug } from '../core/format.js';
import { fmtDate, fmtCountdown, until, DAY, startTicker } from '../core/time.js';
import { stageRail } from '../components/rail.js';
import { empty, goTo } from '../components/emptystate.js';

export function render() {
  var host = document.getElementById('desk-body');
  if (!host) return;
  var S = get();

  /* Four empty states, and they are NOT interchangeable. Collapsing them was a
     regression the QA suite caught once already: it told a partner under
     review that no cohorts were forming, which is both false and unactionable.
     ORDER MATTERS, and approval comes FIRST. It is a fact from /provider/me
     and does not depend on the campaigns table being readable, so a pending
     partner gets the answer that is true and actionable rather than a
     technical apology about a table they cannot bid against anyway. */
  if (!S.approved) {
    host.innerHTML = empty('Cohorts appear here once your application clears',
      'Nothing is missing on your side. Bidding opens to approved partners, and cohorts forming in your coverage land on this desk the same day you are approved.',
      goTo('pending', 'See where your application stands'));
    return;
  }

  if (!S.campaignsLive) {
    host.innerHTML = empty('We could not read the cohort list just now',
      'This is on our side. Nothing you have declared or bid is affected. Reload in a moment, and email partners@whollar.ca if it persists.');
    return;
  }

  if (!S.campaigns.length) {
    if (!S.coverage.length) {
      host.innerHTML = empty('Nothing reaches this desk without coverage',
        'Auctions are matched to partners by the regions they have declared. Name one, with the services you can render there, and cohorts forming inside it appear here.',
        goTo('coverage', 'Declare your coverage'));
      return;
    }
    host.innerHTML = empty('Nothing needs you right now',
      'No cohort in your coverage is open for bids. When one opens you will see it here, and you will get an email if that alert is on.',
      goTo('account', 'Check your alerts', 'btn ghost'));
    return;
  }

  var active = {};
  S.coverage.forEach(function (c) { if (c.status === 'active') active[regionSlug(c.region)] = true; });

  var rows = S.campaigns.slice().sort(sortByClock).map(function (a) {
    return row(a, active[regionSlug(a.coverageRegion || a.region)]);
  }).join('');

  host.innerHTML = '<section class="card" style="padding-top:14px">'
    + '<div class="twrap"><table class="tbl" aria-label="Open auctions">'
    + '<thead><tr><th>Cohort</th><th class="num">Households</th><th>Stage</th><th>Window</th><th>Your bid</th><th></th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>'
    + '<p class="fnote">You see a cohort because it sits inside your declared coverage. You never see another partner’s bid, their count, or whether they bid at all.</p>'
    + '</section>';

  startTicker();
}

function closeAt(a) { return (a.dates && a.dates.bidding_closes_at) || a.nextAt || Infinity; }
function sortByClock(a, b) { return closeAt(a) - closeAt(b); }

function row(a, unlocked) {
  var d = a.dates || {};
  var mine = get().bids[a.id];
  var hot = a.stage === 'closing';

  var window_ = a.stage === 'planned' || a.stage === 'announced'
    ? (d.bidding_opens_at ? 'Opens ' + fmtDate(d.bidding_opens_at) : 'Date to come')
    : (a.stage === 'open' || a.stage === 'closing'
      ? 'Closes ' + fmtDate(d.bidding_closes_at) + countdown(d.bidding_closes_at)
      : (a.stage === 'offers_out'
        ? 'Decides ' + fmtDate(d.decision_at)
        : 'Closed ' + fmtDate(d.decision_at)));

  var yours = mine
    ? '<span class="pill ' + (mine.state === 'won' ? 'won' : (mine.state === 'not_selected' ? 'lost' : 'sealed')) + '">'
      + esc({ won: 'Won', not_selected: 'Not selected', locked: 'Sealed', sealed: 'Sealed', improved: 'Sealed' }[mine.state] || 'Sealed')
      + '</span>'
    : '<span class="mono" style="color:#949E95">·</span>';

  /* A cohort in a region that has not verified is visible but locked, and the
     row says which region is holding it. This is the state a new partner meets
     most: see the cohort, cannot bid on it, need to be told why. */
  var action = !unlocked
    ? '<span class="lockedtag">Verifies with ' + esc(a.coverageRegion || a.region) + ' coverage</span>'
    : bidAction(a, mine);

  return '<tr data-row="' + esc(a.id) + '"' + (unlocked ? '' : ' class="locked"') + '>'
    + '<td><span class="rg">' + esc(a.region) + '<small>' + esc(a.sub || '') + '</small></span></td>'
    + '<td class="num">' + esc(String(a.households != null ? a.households : '·')) + '</td>'
    + '<td>' + stageRail(a.stage) + '</td>'
    + '<td><span class="closecell' + (hot ? ' hot' : '') + '">' + window_ + '</span></td>'
    + '<td>' + yours + '</td>'
    + '<td style="text-align:right">' + action + '</td></tr>';
}

function countdown(ts) {
  if (!ts || until(ts) > DAY) return '';
  return ' · <span data-until="' + ts + '">' + fmtCountdown(until(ts)) + '</span>';
}

/* The ticket itself is not built. Rather than an inert "Review and bid" that
   opens nothing, the desk says what the row is waiting on. A button that does
   nothing teaches a partner not to trust the others. */
function bidAction(a, mine) {
  if (a.stage === 'open' || a.stage === 'closing') {
    if (mine) return '<span class="mono" style="font-size:11px;color:var(--sub)">Sealed · improvable until close</span>';
    if (get().biddingPaused) return '<span class="lockedtag">Bidding paused</span>';
    return '<span class="mono" style="font-size:11px;color:var(--sub)">Ticket opens here</span>';
  }
  if (a.stage === 'offers_out') return '<span class="mono" style="font-size:11px;color:var(--sub)">With households</span>';
  return '';
}
