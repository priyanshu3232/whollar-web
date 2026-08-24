/* My bids: the record of every sealed bid and what it turned into.
 *
 * Ported from the prototype's renderBids COMPOSITION: the declaration at 1243
 * plus the _rbids11 wrapper at 2988, flattened per render-inventory.md section
 * C. The wrapper's re-entrant insertAdjacentHTML dance for #bidnudge is gone
 * by construction: this render is pure from state and builds the nudge and
 * the table in one pass, so there is nothing stale to remove first.
 *
 * The prototype's HBIDS demo history is not ported: rows here are real sealed
 * bids from the store, and columns with no real figure yet (completed
 * switches, fees to date) render the centred dot rather than an invention.
 * CSV export is client-side from the same rows; the server route (register 37)
 * stays an honest stub until an export needs more than the client holds.
 */

import { get, biddableCampaigns } from '../core/state.js';
import { esc } from '../core/format.js';
import { fmtDate } from '../core/time.js';
import { on } from '../core/actions.js';
import { toast } from '../core/toast.js';
import { empty, goTo, CLOCK } from '../components/emptystate.js';
import { bidLine } from './ticket.js';

export function render() {
  var host = document.getElementById('bids-body');
  if (!host) return;
  var S = get();

  var list = Object.keys(S.bids).map(function (k) { return S.bids[k]; });

  if (!list.length) {
    host.innerHTML = nudge(S) + empty('Your first bid lands here',
      'Every bid you place sits on this record with everything it turns into: result, confirmed households, completed switches, fees.',
      goTo('desk', 'Open the bid desk'), CLOCK);
    return;
  }

  var byId = {};
  S.campaigns.forEach(function (c) { byId[c.id] = c; });

  var rows = list.map(function (b) {
    var c = byId[b.campaignId || b.campaign] || {};
    var confirmed = b.state === 'won' && c.confirmed != null ? String(c.confirmed) : '·';
    return '<tr>'
      + '<td>' + esc(c.region || b.campaignId || b.campaign) + '</td>'
      + '<td class="num">' + (b.placedAt ? esc(fmtDate(b.placedAt)) : '·') + '</td>'
      + '<td class="num">' + bidLine(b) + (b.version > 1 ? ' <small class="capnote">v' + b.version + '</small>' : '') + '</td>'
      + '<td>' + pill(b.state) + '</td>'
      + '<td class="num">' + esc(confirmed) + '</td>'
      + '<td class="num">·</td>'
      + '<td class="num">·</td></tr>';
  }).join('');

  host.innerHTML = nudge(S)
    + '<section class="card">'
    + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><span class="eyebrow">Record</span>'
    + '<button class="tlink" type="button" data-action="bids:csv" style="margin-left:auto">Export CSV →</button></div>'
    + '<div class="twrap"><table class="tbl"><thead><tr><th>Cohort</th><th>Placed</th><th>Your bid</th><th>Result</th><th class="num">Confirmed</th><th class="num">Completed</th><th class="num">Fees to date</th></tr></thead><tbody>'
    + rows
    + '</tbody></table></div>'
    + '<p class="fnote">Confirmed is households who accepted your offer. Completed is live connections, the only column that ever bills.</p>'
    + '</section>';
}

function pill(state) {
  if (state === 'won') return '<span class="pill won">Won</span>';
  if (state === 'not_selected') return '<span class="pill lost">Not selected</span>';
  return '<span class="pill sealed">Sealed</span>';
}

/** Nothing sealed while a cohort in verified coverage is open: say so. */
function nudge(S) {
  if (Object.keys(S.bids).length) return '';
  var ob = null;
  biddableCampaigns().forEach(function (c) {
    if (!ob && (c.stage === 'open' || c.stage === 'closing') && !S.bids[c.id]) ob = c;
  });
  if (!ob) return '';
  var d = ob.dates || {};
  return '<section class="card" id="bidnudge" style="margin-bottom:16px"><span class="eyebrow gld">Open now</span>'
    + '<h3>Nothing sealed yet, and ' + esc(ob.region) + (d.bidding_closes_at ? ' closes ' + esc(fmtDate(d.bidding_closes_at)) : ' is open') + '</h3>'
    + '<p class="cardnote">One number, sealed both ways: your bid stands on its own merits, nobody sees it, and only completed switches ever bill.</p>'
    + '<button class="btn forest" type="button" data-action="nav" data-view="desk">Open the ticket</button></section>';
}

export function mount() {
  on('click', 'bids:csv', function () {
    var S = get();
    var byId = {};
    S.campaigns.forEach(function (c) { byId[c.id] = c; });
    var head = 'Cohort,Placed,Bid,Version,Result,Confirmed\n';
    var lines = Object.keys(S.bids).map(function (k) {
      var b = S.bids[k];
      var c = byId[b.campaignId || b.campaign] || {};
      return [
        csv(c.region || b.campaignId || b.campaign),
        b.placedAt ? new Date(b.placedAt).toISOString().slice(0, 10) : '',
        csv((b.tiers || []).map(function (t) { return '$' + t.effectivePrice + ' ' + t.name; }).join(' | ')),
        b.version || 1,
        b.state,
        b.state === 'won' && c.confirmed != null ? c.confirmed : ''
      ].join(',');
    }).join('\n');
    var blob = new Blob([head + lines], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'whollar-sealed-bids.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Bid record exported.');
  });
}

/** Quote a CSV field that may carry commas. */
function csv(s) {
  s = String(s == null ? '' : s);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
