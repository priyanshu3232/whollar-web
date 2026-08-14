/* The views this increment does not build, each saying so honestly.
 *
 * WHY ONE FILE, AND WHY THEY ARE NOT STUBS. A stub renders nothing and looks
 * like a bug. A demo renders invented numbers and looks like a lie. These say
 * what the surface will hold, what has to happen first, and where to go
 * meanwhile, which is the only honest third option.
 *
 * Each becomes its own module under views/ when it is built, as the bids
 * record, the performance page and the contracts registry now have
 * (views/bids.js, views/performance.js, views/contracts.js). Splitting the
 * rest out now would create files whose entire content is a paragraph, and the
 * build refuses unreferenced modules, so they would have to be wired up twice.
 */

import { get } from '../core/state.js';
import { empty, goTo } from '../components/emptystate.js';

export function render() {
  var S = get();

  put('billing-body', billing(S));
  put('del-body', delivery(S));
  put('plan-body', empty('Pick a cohort to see its plan',
    'Every cohort has one timeline: announced, open, closed, offers out, decision, switching window, reconciliation. Open one from the bid desk.',
    goTo('desk', 'Open the bid desk', 'btn ghost')));
}

function put(id, html) {
  var el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function billing(S) {
  return empty('No statements yet, by design',
    'Bids are free. Winning is free. Confirmed households are free. The first line on the first statement is the first activation with a clean line test, at your contracted success fee, and statements settle per campaign rather than per month.'
    + (S.approved ? '' : ' Nothing is owed at any point before approval either.'));
}

function delivery() {
  return empty('Your first delivery board builds itself',
    'Win a cohort and every confirmed household lands here with an order number, an install slot the member picks, and a state that becomes a statement line only when the line tests clean. Addresses release at confirmation, under each household’s consent, and to nobody else.',
    goTo('desk', 'Open the bid desk', 'btn'));
}
