/* The five-position stage rail on each bid desk row.
 *
 * The rail shows the five auction stages. The server's sixth, 'planned', sits
 * before the rail starts and renders as a label with no rail at all, because a
 * rail with nothing lit reads as broken rather than as early.
 *
 * The stage is whatever the server sent. There is no stageOf() on this side
 * and there must not be: a browser clock a few minutes fast would show a
 * closed auction as open, and the partner would write a bid the server then
 * refuses.
 */

import { esc } from '../core/format.js';
import { STAGE_LABEL } from '../core/contract.js';

var RAIL = ['announced', 'open', 'closing', 'offers_out', 'decided'];

export function stageRail(stage) {
  var idx = RAIL.indexOf(stage);
  if (idx < 0) return '<div class="stlbl">' + esc(STAGE_LABEL[stage] || 'Planned') + '</div>';

  var out = '<div class="minirail">';
  for (var i = 0; i < 5; i++) {
    out += '<span class="mr' + (i < idx ? ' past' : (i === idx ? ' now' : '')) + '"></span>';
    if (i < 4) out += '<span class="mrl' + (i < idx ? ' past' : '') + '"></span>';
  }
  return out + '</div><div class="stlbl' + (stage === 'closing' ? ' hot' : '') + '">'
    + esc(STAGE_LABEL[stage] || stage) + '</div>';
}
