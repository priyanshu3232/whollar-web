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

import { get, set } from '../core/state.js';
import { api } from '../core/api.js';
import { esc, regionSlug } from '../core/format.js';
import { fmtDate, fmtCountdown, until, DAY, startTicker } from '../core/time.js';
import { on } from '../core/actions.js';
import { stageRail } from '../components/rail.js';
import { empty, goTo } from '../components/emptystate.js';
import { briefHTML } from './brief.js';
import { ticketHTML, refreshScn } from './ticket.js';

/* The desk is TWO tables, as the prototype's markup is: what is live now, and
   what is coming. A cohort that has not opened yet cannot be bid on and has no
   clock to run, so putting it in the live table gives it five columns of
   dashes and buries the one row that needs a decision today. Split on stage,
   which the server owns.
 *
 * Both shells render even when they are empty, and each carries its own
 * one-line explanation inside the table body rather than a bare header row.
 * §8.7 is why: an empty table with column headings and nothing under them is
 * the screen most likely to read as broken rather than as quiet. */
export function render() {
  var host = document.getElementById('desk-body');
  if (!host) return;
  var S = get();

  if (!S.campaignsLive) {
    host.innerHTML = empty('We could not read the cohort list just now',
      'This is on our side. Nothing you have declared or bid is affected. Reload in a moment, and email partners@whollar.ca if it persists.');
    return;
  }

  var active = {};
  S.coverage.forEach(function (c) { if (c.status === 'active') active[regionSlug(c.region)] = true; });

  var coming = S.campaigns.filter(isComing).sort(sortByOpen);
  var live = S.campaigns.filter(function (a) { return !isComing(a); }).sort(sortByClock);

  var rows = live.map(function (a) {
    return row(a, active[regionSlug(a.coverageRegion || a.region)]);
  }).join('');

  host.innerHTML = '<section class="card" style="padding-top:14px">'
    + '<div class="twrap"><table class="tbl" aria-label="Open auctions">'
    + '<thead><tr><th>Cohort</th><th class="num">Households</th><th>Stage</th><th>Window</th><th>Your bid</th><th></th></tr></thead>'
    + '<tbody>' + rows + areaRows(1, 4, 6, live.length) + '</tbody></table></div>'
    + (live.length ? '' : liveNote(S))
    /* WHAT THIS LINE USED TO CLAIM WAS FALSE. It read "You see a cohort
       because it sits inside your declared coverage", and there is no
       coverage filter anywhere in /provider/campaigns: every partner is sent
       every visible cohort, and coverage decides whether a row can be
       EXPANDED, not whether it is listed. A partner reading the old sentence
       beside a region they had never declared concluded their coverage was
       wrong. Listed against biddable is the true distinction, so it is the
       one the desk states. */
    + '<p class="fnote">Every cohort we are running is listed here. You can bid on the ones inside your declared coverage; the rest stay locked. You never see another partner\u2019s bid, their count, or whether they bid at all.</p>'
    + '</section>'
    + planned(coming);

  /* The scenario table lives in the brief but reads the open form, so it can
     only be computed once both are in the DOM. */
  refreshScn();

  startTicker();
}

/* AREAS: the empty half of a table.
   Owner's call 2026-08-27, kept: a desk with nothing on it holds its spaces
   open and labels them rather than collapsing to a header row. Areas 1 to 4
   are the open-auction slots and 5 to 8 the coming ones, so every space on the
   desk has one number and no two share it.

   A COHORT TAKES A SLOT. `filled` is how many real rows were already written
   above, and only the remainder is drawn grey, so four cohorts leave no boxes
   and one cohort leaves three. An area row carries no campaign id, no region,
   no household count, no stage and no bid control: nothing here can be
   opened, priced or sealed, and no partner reads a number that is not one. */
function areaRows(from, to, cols, filled) {
  var out = '';
  for (var n = from + (filled || 0); n <= to; n++) {
    out += '<tr class="arearow"><td><span class="rg">Area ' + n + '</span></td>';
    for (var c = 1; c < cols; c++) out += '<td>\u00a0</td>';
    out += '</tr>';
  }
  return out;
}

function isComing(a) { return a.stage === 'planned' || a.stage === 'announced'; }
function openAt(a) { return (a.dates && a.dates.bidding_opens_at) || Infinity; }
function sortByOpen(a, b) { return openAt(a) - openAt(b); }

/* Why the live table is empty, in the partner's terms. These four sentences
   are NOT interchangeable and collapsing them was a regression the QA suite
   caught once already: it told a partner under review that no cohorts were
   forming, which is both false and unactionable. ORDER MATTERS, and approval
   comes FIRST: it is a fact from /provider/me and does not depend on the
   campaigns table being readable. */
function liveNote(S) {
  if (!S.approved) {
    return note('Cohorts open to you the day your application clears. Nothing is missing on your side, and anything forming in your coverage before then is listed under Coming cohorts.',
      goTo('pending', 'See where your application stands', 'tlink'));
  }
  if (!S.coverage.length) {
    return note('Nothing reaches this desk without coverage. Auctions are matched to partners by the regions they have declared.',
      goTo('coverage', 'Declare your coverage', 'tlink'));
  }
  return note('No cohort in your coverage is open for bids right now. When one opens it appears here, and you get an email if that alert is on.',
    goTo('account', 'Check your alerts', 'tlink'));
}

function note(text, link) {
  return '<p class="fnote" style="margin:6px 0 2px">' + esc(text) + ' ' + link + '</p>';
}

/* Coming cohorts. Planned and announced only: a cohort here has no bidding
   window yet, which is exactly what its one column says. */
function planned(coming) {
  var rows = coming.map(function (a) {
    return '<tr><td><span class="rg" style="font-size:13.5px">' + esc(a.region)
      + '<small>' + esc(a.sub || '') + '</small></span></td>'
      + '<td class="num">' + (isFinite(openAt(a)) ? esc(fmtDate(openAt(a))) + ' · expected' : 'Date to come') + '</td>'
      + '<td style="font-size:12.5px;color:var(--sub)">'
      + esc(a.stage === 'announced'
        ? 'Announced' + (a.households ? ' · ' + a.households + ' households' : '')
        : (a.kind === 'forming'
          ? 'Still forming' + (a.households ? ' · ' + a.households + ' households so far' : '')
          /* A planned or waitlist region has no seats yet, only a list. The
             number is `waitlist`, and the desk says which it is showing so a
             partner never reads interest as a roster. */
          : 'Gathering' + (a.waitlist ? ' · ' + a.waitlist + ' on the list' : '')))
      + '</td></tr>';
  }).join('');

  return '<section class="card" style="margin-top:16px" aria-label="Planned cohorts">'
    + '<span class="eyebrow">Forming now</span><h3>Coming cohorts</h3>'
    + '<div class="twrap"><table class="tbl">'
    + '<thead><tr><th>Cohort</th><th class="num">Expected bidding</th><th>Status</th></tr></thead>'
    + '<tbody>' + rows + areaRows(5, 8, 3, coming.length) + '</tbody></table></div>'
    + '<p class="fnote">Expected dates are estimates; they firm up the day a cohort locks and is announced.</p>'
    + '</section>';
}

function closeAt(a) { return (a.dates && a.dates.bidding_closes_at) || a.nextAt || Infinity; }
function sortByClock(a, b) { return closeAt(a) - closeAt(b); }

/**
 * The result pill, and what it says beside it. A cohort is won TIER BY TIER,
 * so during Offers the pill reads "Sealed" with the tiers this bid took (or
 * "not selected") and the households confirmed so far; after the decision
 * deadline it reads "Won · N confirmed" or "Not selected". Every figure is
 * this partner's own: `tiersWon` and `confirmed` come from its own bid row
 * and never name another partner, price or household.
 */
export function resultPill(a, mine) {
  var decided = mine.state === 'won' || mine.state === 'not_selected';
  if (!decided) return '<span class="pill sealed">Sealed</span>';
  var won = (mine.tiersWon || []).length > 0;
  var conf = mine.confirmed != null ? Number(mine.confirmed) : null;
  var confLine = conf != null ? conf + ' confirmed' : '';
  if (a.stage === 'decided') {
    return won
      ? '<span class="pill won">Won' + (confLine ? ' · ' + esc(confLine) : '') + '</span>'
      : '<span class="pill lost">Not selected</span>';
  }
  var tiers = won ? 'won ' + esc((mine.tiersWon || []).join(', ')) : 'not selected';
  return '<span class="pill ' + (won ? 'won' : 'lost') + '">Sealed · ' + tiers + '</span>'
    + (won && confLine ? ' <small class="capnote">' + esc(confLine) + '</small>' : '');
}

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
    ? resultPill(a, mine)
    : '<span class="mono" style="color:#949E95">·</span>';

  /* A cohort in a region that has not verified is visible but locked, and the
     row says which region is holding it. This is the state a new partner meets
     most: see the cohort, cannot bid on it, need to be told why. */
  var action = !unlocked
    ? '<span class="lockedtag">Verifies with ' + esc(a.coverageRegion || a.region) + ' coverage</span>'
    : bidAction(a, mine);

  var open = get().openCampaign === a.id;

  return '<tr data-row="' + esc(a.id) + '"' + rowClass(unlocked, open) + '>'
    + '<td><span class="rg">' + esc(a.region) + '<small>' + esc(a.sub || '') + '</small></span></td>'
    + '<td class="num">' + esc(String(a.households != null ? a.households : '·')) + '</td>'
    + '<td>' + stageRail(a.stage) + '</td>'
    + '<td><span class="closecell' + (hot ? ' hot' : '') + '">' + window_ + '</span></td>'
    + '<td>' + yours + '</td>'
    + '<td style="text-align:right">' + action + '</td></tr>'
    /* Locked rows never expand: without the guard a coverage flip mid-session
       left a full pricing form and a live seal button over a cohort the
       server would refuse anyway. */
    + (open && unlocked ? expandedRow(a, mine) : '');
}

function rowClass(unlocked, open) {
  var cls = (unlocked ? '' : 'locked') + (open ? (unlocked ? ' ' : '') + 'exp' : '');
  return cls ? ' class="' + cls + '"' : '';
}

/* The expanded row: the brief and the ticket, side by side, exactly the
   prototype's dgrid composition (line 1152). Rendered only for the open
   cohort; the CSS shows a .dwr only after a row carrying .exp. */
function expandedRow(a, mine) {
  var data = get().briefs[a.id];
  var showScn = (a.stage === 'open' || a.stage === 'closing') && !mine;
  return '<tr class="dwr" data-dwr="' + esc(a.id) + '"><td colspan="6"><div class="dgrid">'
    + briefHTML(a, data, mine, showScn)
    + ticketHTML(a, data, mine)
    + '</div></td></tr>';
}

function countdown(ts) {
  if (!ts || until(ts) > DAY) return '';
  return ' · <span data-until="' + ts + '">' + fmtCountdown(until(ts)) + '</span>';
}

/* The row's control. Open cohorts get the real ticket; the label states what
   the click does. Bidding paused still opens the row: the brief is readable,
   and the ticket itself says why the button is disabled. */
function bidAction(a, mine) {
  var open = get().openCampaign === a.id;
  var biddable = a.stage === 'open' || a.stage === 'closing';
  var label;
  if (biddable) label = mine ? 'View' : 'Review and bid';
  else if (a.stage === 'offers_out' || a.stage === 'decided') label = 'View';
  else return '';
  return '<button class="btn' + (mine || !biddable ? ' ghost' : '') + '" type="button" '
    + 'data-action="desk:open" data-id="' + esc(a.id) + '">'
    + (open ? 'Close' : label) + '</button>';
}

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

export function mount() {
  on('click', 'desk:open', function (el) {
    var id = el.getAttribute('data-id');
    var S = get();
    if (S.openCampaign === id) {
      set({ openCampaign: null, ticketDraft: null });
      return;
    }
    /* Switching cohorts drops the draft: a half-typed ticket for one cohort
       must never prefill another's. */
    set({ openCampaign: id, ticketDraft: null });
    loadBrief(id);
  });
}

/** Fetch the brief on first open, and re-anchor the clock while at it. */
function loadBrief(id) {
  var S = get();
  var have = S.briefs[id];
  if (have && have !== 'loading' && !have.failed) return;
  set('briefs', assign(S.briefs, id, 'loading'));
  api.campaignBrief(id).then(function (r) {
    set('briefs', assign(get().briefs, id, r));
  }, function () {
    set('briefs', assign(get().briefs, id, { failed: true }));
  });
}

function assign(map, key, value) {
  var out = {};
  for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k)) out[k] = map[k]; }
  out[key] = value;
  return out;
}
