/* The numbered gate row, used by the review frame and by the roster gate.
 *
 * Three states: done, now, and pending. §8.5 requires each row's state to come
 * from application_tasks rather than from a counter, because a counter cannot
 * express "coverage cleared but registration is flagged", which is a real and
 * common shape.
 */

import { esc } from '../core/format.js';

/**
 * @param {'dn'|'now'|''} state
 * @param {string|number} num   shown when the row is not done
 * @param {string} title
 * @param {string} body         trusted HTML
 * @param {string} [action]     trusted HTML
 */
export function gateRow(state, num, title, body, action) {
  return '<div class="gaterow' + (state ? ' ' + state : '') + '">'
    + '<i>' + (state === 'dn' ? '✓' : esc(String(num))) + '</i>'
    + '<span><b>' + esc(title) + '</b><small>' + body + '</small></span>'
    + (action || '')
    + '</div>';
}
