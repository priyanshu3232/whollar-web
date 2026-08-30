/* The auction brief: one cohort's facts, aggregates only.
 *
 * Ported from the prototype's live briefHTML (provider-console-v12.html
 * 2157-2184, the v7 declaration; the three earlier ones are dead, see
 * docs/console/render-inventory.md). Renders inside the desk's expanded row,
 * next to the ticket, so it has no view host of its own.
 *
 * DEVIATIONS FROM THE PROTOTYPE, both deliberate:
 *   1. The "Declared plant reaches an estimated N of M households" line is
 *      NOT ported. The prototype invents that figure (hh minus three); the
 *      server computes no such estimate yet, and an invented number on an
 *      auction brief is exactly what the house rules forbid. The line returns
 *      when serviceability data actually produces it.
 *   2. Mixes the server has not recorded render as "Cohort profile to come"
 *      rather than as bars over made-up percentages.
 */

import { esc } from '../core/format.js';

/** Percentage bars plus their label, from [['1 Gig', 42], ...]. */
function mix(arr) {
  var tot = arr.reduce(function (t, x) { return t + x[1]; }, 0) || 1;
  var bars = arr.map(function (x) {
    return '<i style="width:' + Math.round(x[1] / tot * 88) + 'px"></i>';
  }).join('');
  var lab = arr.map(function (x) { return esc(x[0]) + ' ' + x[1] + '%'; }).join(' · ');
  return '<span class="mixin">' + bars + '<em>' + lab + '</em></span>';
}

/**
 * The measured speed demand: households at each tier, from the speed on their
 * bills, as "100 Mbps · 20 · 300 Mbps · 45". Counts, not percentages, because
 * a partner sizing a commitment wants to know how many households want 1 Gig
 * and not what share of a number it then has to look up.
 */
function demand(arr, known, other) {
  var line = arr.map(function (x) { return esc(x[0]) + ' · ' + x[1]; }).join(' · ');
  if (other) line += (line ? ' · ' : '') + 'other speeds · ' + other;
  return '<b>' + line + '</b>'
    + (known ? ' <small class="capnote">of ' + known + ' with a bill on file</small>' : '');
}

var TO_COME = '<b style="color:var(--sub);font-weight:600">Cohort profile to come</b>';

/**
 * The brief panel.
 * @param a       the campaign row (desk shape)
 * @param data    state.briefs[id]: undefined | 'loading' | {failed} | payload
 * @param mine    the org's own bid or null
 * @param showScn whether the scenario table renders (form open, nothing sealed)
 */
export function briefHTML(a, data, mine, showScn) {
  if (!data || data === 'loading') {
    return '<div class="brief"><div class="dh">The auction brief</div>'
      + '<p class="fnote">Fetching the brief…</p></div>';
  }
  if (data.failed) {
    return '<div class="brief"><div class="dh">The auction brief</div>'
      + '<p class="fnote">We could not read the brief just now. This is on our side; reload in a moment.</p></div>';
  }

  var b = data.brief || {};
  var cov = data.coverage || { declared: false };

  var covline = cov.declared
    ? '<b>' + esc((cov.techs || []).map(cap).join(' · ')
        + (cov.speed ? ' · up to ' + cov.speed : '')) + '</b>'
      + (cov.status !== 'active'
        ? ' <span class="lockedtag">' + esc(cov.status === 'verifying' ? 'Verifying' : cov.status) + '</span>'
        : '')
    : '<b style="color:#8C3B1B">Not declared</b> '
      + '<button class="tlink" type="button" data-action="nav" data-view="coverage">Declare →</button>';

  var scn = showScn
    ? '<div class="scnwrap"><h4>What this bid could return</h4>'
      + '<div class="scnchip">at your commitment of <b class="scommit">'
      + esc(String(a.households != null ? a.households : '·')) + '</b> households</div>'
      + (b.speedDemand || b.speedMix
        ? '<table class="scn"><thead><tr><th>Confirmed</th><th>Serve</th><th>Monthly</th><th>Fees</th></tr></thead><tbody class="scnbody"></tbody></table>'
          + '<p class="fnote" style="margin-top:8px">Blends your tier prices by the cohort’s speed demand, capped at your commitment. Updates as you type.</p>'
        : '<p class="fnote">Scenario math arrives with the cohort profile.</p>')
      + '</div>'
    : '';

  return '<div class="brief"><div class="dh">The auction brief</div><div class="dl">'
    + '<div class="r"><span>Households</span><b>' + esc(String(b.households != null ? b.households : (a.households != null ? a.households : '·'))) + '</b></div>'
    + '<div class="r"><span>Renewal window</span>' + (b.renewalWindow ? '<b>' + esc(b.renewalWindow) + '</b>' : TO_COME) + '</div>'
    + '<div class="r"><span>Speed demand</span>'
    + (b.speedDemand ? demand(b.speedDemand, b.speedDemandKnown, b.speedDemandOther) : (b.speedMix ? mix(b.speedMix) : TO_COME)) + '</div>'
    + '<div class="r"><span>Plant mix</span>' + (b.plantMix ? mix(b.plantMix) : TO_COME) + '</div>'
    + '<div class="r"><span>Your coverage here</span>' + covline + '</div>'
    + '</div>'
    + scn
    + '<p class="fnote">Aggregates only.</p></div>';
}

/** 'fibre' -> 'Fibre', for coverage tech codes on the facts list. */
function cap(s) {
  s = String(s || '');
  return s === 'fwa' ? 'Fixed wireless' : s.charAt(0).toUpperCase() + s.slice(1);
}
