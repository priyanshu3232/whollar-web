/* The one view this increment does not build, saying so honestly.
 *
 * WHY THIS FILE STILL EXISTS. A stub renders nothing and looks like a bug. A
 * demo renders invented numbers and looks like a lie. This says what the
 * surface will hold, what has to happen first, and where to go meanwhile,
 * which is the only honest third option.
 *
 * Billing and delivery used to live here and now have their own modules
 * (views/billing.js, views/delivery.js), as bids, performance and contracts
 * did before them. The campaign plan is what is left: it is a per-cohort
 * timeline view, endpoint 26, and there is no route behind it yet.
 */

import { empty, goTo } from '../components/emptystate.js';

export function render() {
  put('plan-body', empty('Pick a cohort to see its plan',
    'Every cohort has one timeline: announced, open, closed, offers out, decision, switching window, reconciliation. Open one from the bid desk.',
    goTo('desk', 'Open the bid desk', 'btn ghost')));
}

function put(id, html) {
  var el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
