/* The views this increment does not build, each saying so honestly.
 *
 * WHY ONE FILE, AND WHY THEY ARE NOT STUBS. A stub renders nothing and looks
 * like a bug. A demo renders invented numbers and looks like a lie. These say
 * what the surface will hold, what has to happen first, and where to go
 * meanwhile, which is the only honest third option.
 *
 * Each becomes its own module under views/ when it is built, as the bids
 * record now has (views/bids.js). Splitting the rest out now would create
 * files whose entire content is a paragraph, and the build refuses
 * unreferenced modules, so they would have to be wired up twice.
 */

import { get } from '../core/state.js';
import { esc } from '../core/format.js';
import { fmtDate } from '../core/time.js';
import { empty, goTo } from '../components/emptystate.js';

export function render() {
  var S = get();

  put('billing-body', billing(S));
  put('del-body', delivery(S));
  put('perf-body', performance(S));
  put('con-body', contracts(S));
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
    goTo('desk', 'Open the bid desk', 'btn ghost'));
}

function performance() {
  return empty('Four numbers, none of them written yet',
    'Win rate, completion, serviceability, and delivered as bid. None is bought and none is written by marketing: all four are recorded from what you deliver, and future auction briefs carry them beside your bid. The record starts at your first sealed number.');
}

function contracts(S) {
  var app = S.application;
  if (app && app.agreementAcceptedAt) {
    return empty('Your agreements are on file',
      'The application agreement is signed and versioned, dated ' + esc(fmtDate(app.agreementAcceptedAt)) + '. '
      + 'The partner agreement signs at approval, and the standard cohort terms accept before your first bid. Both appear here when they do.');
  }
  return empty('Agreements appear here as they are signed',
    'Everything binding lives here, versioned: the partner agreement, the standard cohort terms, your regional schedule, and every sealed bid receipt. If the standard terms change, bidding pauses until the new version is accepted.');
}
