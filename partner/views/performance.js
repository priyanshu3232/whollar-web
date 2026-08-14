/* Performance: the four numbers future briefs carry beside a bid.
 *
 * Ported from the prototype's SECOND renderPerf (line 2805, the one that wins
 * by hoisting) rather than the first at 1566, per render-inventory.md. The
 * prototype's history branch is not ported at all: it renders 3 of 6, 87%,
 * 96%, 100% and a four-row region table, none of which came from anywhere.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. Only two of the four numbers have a
 * source in this build:
 *
 *   Win rate        wins over decided bids, from the bid record. REAL.
 *   Completion      activated over serviceable, from a delivery board.
 *   Serviceability  declared coverage that proved real at install, from the
 *                   release reasons on that same board (contract.js
 *                   RELEASE_REASON says so, which is why that enum exists).
 *   Delivered as bid  households' day-30 bill checks.
 *
 * The last three need an orders table that no route writes yet, so they render
 * the centred dot and name what writes them. The dot is load-bearing: a 0% on
 * completion is a claim about delivery this partner has not been given the
 * chance to make, and it would follow them into every brief.
 *
 * The region table is built from the real bid record joined to campaigns, so
 * it grows a row per region bid in and never carries a figure the store does
 * not hold.
 */

import { get } from '../core/state.js';
import { esc, plural } from '../core/format.js';
import { fmtDate } from '../core/time.js';
import { goTo } from '../components/emptystate.js';

export function render() {
  var host = document.getElementById('perf-body');
  if (!host) return;
  var S = get();
  var r = record(S);

  host.innerHTML = tiles(r) + band(S, r) + (r.rows.length ? regions(S, r) : '');
}

/* ------------------------------------------------------------------ *
 * the record, derived once
 * ------------------------------------------------------------------ */

/* One pass over the bid store, so the tiles, the band and the table cannot
   disagree about how many bids there are. A bid is decided when it came back
   won or not_selected; sealed, improved and locked are all still in flight. */
function record(S) {
  var byCampaign = {};
  S.campaigns.forEach(function (c) { byCampaign[c.id] = c; });

  var r = { bids: 0, sealed: 0, won: 0, decided: 0, confirmed: 0, rows: [], byRegion: {} };

  Object.keys(S.bids).forEach(function (k) {
    var b = S.bids[k];
    var c = byCampaign[b.campaignId || k] || {};
    var region = c.region || b.campaignId || k;
    var won = b.state === 'won';
    var decided = won || b.state === 'not_selected';

    r.bids += 1;
    if (!decided) r.sealed += 1;
    if (decided) r.decided += 1;
    if (won) r.won += 1;

    var row = r.byRegion[region];
    if (!row) { row = r.byRegion[region] = { region: region, bids: 0, won: 0, confirmed: null }; r.rows.push(row); }
    row.bids += 1;
    if (won) {
      row.won += 1;
      if (c.confirmed != null) {
        row.confirmed = (row.confirmed || 0) + c.confirmed;
        r.confirmed += c.confirmed;
      }
    }
  });

  r.rows.sort(function (a, b) { return b.won - a.won || b.bids - a.bids; });

  /* Districts, not households: this is the verification pass rate on declared
     coverage, which is a different figure from the serviceability accuracy the
     tile will eventually carry. It is reported as districts, in words, for
     exactly that reason. */
  r.covActive = 0;
  r.covRejected = 0;
  r.covVerifying = 0;
  S.coverage.forEach(function (c) {
    if (c.status === 'active') r.covActive += 1;
    else if (c.status === 'rejected') r.covRejected += 1;
    else r.covVerifying += 1;
  });

  return r;
}

/* ------------------------------------------------------------------ *
 * the four tiles
 * ------------------------------------------------------------------ */

function tile(label, n, sub, cls) {
  return '<div class="card mt"><span class="l">' + esc(label) + '</span>'
    + '<span class="n' + (cls ? ' ' + cls : '') + '">' + n + '</span>'
    + '<span class="s">' + sub + '</span></div>';
}

var DOT = '·';

function tiles(r) {
  return '<div class="tiles">'
    + tile('Win rate',
      r.decided ? esc(r.won + ' of ' + r.decided) : DOT,
      r.decided
        ? 'your record so far'
        : (r.sealed ? 'your first result writes the first number' : 'sealed bids to wins, beside your bid in every brief'),
      '')
    + tile('Completion', DOT, 'activated of serviceable, written by your delivery board')
    + tile('Serviceability', DOT, 'declared coverage proving real at install')
    + tile('Delivered as bid', DOT, 'records at households’ day-30 bill checks')
    + '</div>';
}

/* ------------------------------------------------------------------ *
 * the band: one card, saying what the next number depends on
 * ------------------------------------------------------------------ */

function card(eyebrow, title, note, cta, foot) {
  return '<section class="card" style="margin-top:16px">'
    + '<span class="eyebrow' + (eyebrow.gold ? ' gld' : '') + '">' + esc(eyebrow.text) + '</span>'
    + '<h3>' + esc(title) + '</h3>'
    + '<p class="cardnote">' + note + '</p>'
    + (cta || '')
    + (foot ? '<p class="fnote">' + foot + '</p>' : '')
    + '</section>';
}

function band(S, r) {
  /* Still under review. Nothing on this page can start until an application
     clears, so the page says that rather than showing four dots and no path. */
  if (!S.approved) {
    var submitted = S.application && S.application.submittedAt;
    return card({ text: 'Before the record starts' },
      submitted ? 'Your record starts at approval' : 'Your record starts at your first sealed number',
      'None of the four is bought and none is written by marketing: all four are recorded from what you deliver, and future auction briefs carry them beside your bid.'
      + (submitted ? ' Approved partners reach the bid desk the same day.' : ''),
      goTo(submitted ? 'pending' : 'application', submitted ? 'See where the review stands' : 'Finish your application', 'btn forest'));
  }

  /* Won something. This is the state the screenshot is about: the win is on
     the board, and the three numbers still on a dot are the ones the delivery
     board writes. Point at it, and do not pretend it is running yet. */
  if (r.won) {
    return card({ text: 'The whole gap', gold: true },
      'A clean sheet is in reach',
      'You are ' + esc(r.won + ' of ' + r.decided) + ' on decided cohorts'
      + (r.confirmed ? ', with ' + esc(plural(r.confirmed, 'household')) + ' confirmed' : '')
      + '. Completion, serviceability and delivered-as-bid start at the delivery board: every confirmed household lands there, and what happens to it becomes the record every future brief quotes.',
      goTo('delivery', 'Open the delivery board', 'btn forest'),
      'Ratings unlock at 25 responses. Nothing bills before an activation with a clean line test.');
  }

  /* Bids in flight, nothing decided. */
  if (r.sealed) {
    return card({ text: 'Results pending', gold: true },
      esc(plural(r.sealed, 'sealed bid') + ' waiting on a result'),
      'Each result writes the win rate above, win or lose. A loss on the same standard terms costs you nothing here: standing is untouched, and the next cohorts in your coverage are already forming.',
      goTo('bids', 'See your bid record', 'btn forest'));
  }

  /* Decided, none won. Said plainly, because the alternative reads as a
     scoreboard and this page is a record. */
  if (r.decided) {
    return card({ text: 'The record starts here' },
      esc('0 of ' + r.decided),
      'The record starts here, not ends here. Nothing about a result changes your standing, your terms, or which cohorts reach your desk.',
      goTo('desk', 'See what is open now', 'btn forest'));
  }

  var next = nextOpen(S);
  return card({ text: 'Why these four' },
    'The numbers that will win you auctions',
    'Nothing here is bought and nothing is written by marketing: all four are recorded from what you deliver, and future auction briefs carry them beside your bid. The record starts at your first sealed number.',
    next
      ? goTo('desk', next.region + ' · closes ' + fmtDate(next.close), 'btn forest')
      : goTo('desk', 'Open the bid desk', 'btn forest'),
    coverageNote(r));
}

/* The verification pass rate on declared districts. Deliberately a sentence
   and not the serviceability tile: that tile is written by install outcomes,
   and putting this number in it would ship a figure into future briefs that
   measured something else. */
function coverageNote(r) {
  if (!r.covActive && !r.covVerifying && !r.covRejected) return '';
  var parts = [];
  if (r.covActive) parts.push(r.covActive + ' verified');
  if (r.covVerifying) parts.push(r.covVerifying + ' still checking');
  if (r.covRejected) parts.push(r.covRejected + ' not serviceable');
  return 'Declared coverage: ' + esc(parts.join(', ')) + '. Serviceability above is a different number, written at install.';
}

function nextOpen(S) {
  var best = null;
  S.campaigns.forEach(function (c) {
    if (c.stage !== 'open' && c.stage !== 'closing') return;
    var close = (c.dates || {}).bidding_closes_at;
    if (!close) return;
    if (!best || close < best.close) best = { region: c.region, close: close };
  });
  return best;
}

/* ------------------------------------------------------------------ *
 * region by region, from the bid record
 * ------------------------------------------------------------------ */

function regions(S, r) {
  var rows = r.rows.map(function (row) {
    return '<tr><td>' + esc(row.region) + '</td>'
      + '<td class="num">' + row.bids + '</td>'
      + '<td class="num">' + (row.won || DOT) + '</td>'
      + '<td class="num">' + (row.confirmed == null ? DOT : row.confirmed) + '</td>'
      + '<td class="num">' + DOT + '</td></tr>';
  }).join('');

  return '<section class="card" style="margin-top:16px"><span class="eyebrow">Region by region</span>'
    + '<h3>What the auctions have delivered</h3>'
    + '<div class="twrap"><table class="tbl"><thead><tr><th>Region</th>'
    + '<th class="num">Bids</th><th class="num">Won</th>'
    + '<th class="num">Confirmed</th><th class="num">Completed</th></tr></thead><tbody>'
    + rows
    + '</tbody></table></div>'
    + '<p class="fnote">Confirmed is households who accepted your offer. Completed is live connections, the only column that ever bills, and it fills from the delivery board.</p>'
    + '</section>';
}
