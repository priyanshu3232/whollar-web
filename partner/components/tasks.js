/* The five-task checklist, in its two modes.
 *
 * The prototype declared renderTasks twice; the live one (v9, line 2445) is
 * dual mode: application tasks while pending, activation steps once approved.
 * That is ported. What is added is per-task check state.
 *
 * WHY PER-TASK STATE MATTERS. The application copy says "each piece starts its
 * own check the moment it lands". With one boolean per task that sentence is
 * decoration: a submitted document and a cleared one look identical. With
 * application_tasks.state it is literally true, and a partner can see that
 * their coverage cleared while their registration is still with the register.
 */

import { esc } from '../core/format.js';
import { APP_TASK, APP_TASK_COPY } from '../core/contract.js';

/* How each check state reads, and whether the row still offers an action.
   'flagged' is not a failure of the application, it is one piece needing
   another look, so it keeps its action. */
var CHECK = {
  empty: { mark: '', cls: '', note: null, actionable: true },
  submitted: { mark: '✓', cls: 'dn', note: 'In the queue', actionable: false },
  verifying: { mark: '✓', cls: 'dn', note: 'Checking now', actionable: false },
  cleared: { mark: '✓', cls: 'dn', note: 'Cleared', actionable: false },
  flagged: { mark: '!', cls: 'flag', note: 'Needs another look', actionable: true }
};

/* Where each task's action goes. Coverage is a view; the other four are
   modals, because they are four fields each and a view per field would make a
   ten minute application feel like an afternoon. */
var TASK_ACTION = {
  coverage: ['nav', 'coverage', 'Declare'],
  registration: ['app:modal', 'registration', 'Open'],
  documents: ['app:modal', 'documents', 'Upload'],
  agreement: ['app:modal', 'agreement', 'Review'],
  reference: ['app:modal', 'reference', 'Add']
};

/** The application checklist. `tasks` is { key: APP_TASK_STATE }. */
export function applicationTasks(tasks) {
  var done = 0;
  var rows = APP_TASK.map(function (key) {
    var st = CHECK[tasks[key]] || CHECK.empty;
    if (tasks[key] && tasks[key] !== 'empty' && tasks[key] !== 'flagged') done++;
    var copy = APP_TASK_COPY[key];
    var act = TASK_ACTION[key];
    return '<div class="task ' + st.cls + '">'
      + '<i>' + st.mark + '</i>'
      + '<div><b>' + esc(copy[0]) + '</b><small>' + esc(copy[1]) + '</small></div>'
      + (st.actionable
        ? '<button class="tlink" type="button" data-action="' + act[0] + '"'
          + (act[0] === 'nav' ? ' data-view="' + act[1] + '"' : ' data-kind="' + act[1] + '"')
          + '>' + esc(act[2]) + ' →</button>'
        : '<span class="taskstate">' + esc(st.note) + '</span>')
      + '</div>';
  }).join('');

  return {
    html: rows,
    done: done,
    total: APP_TASK.length,
    label: done === APP_TASK.length
      ? done + ' of ' + APP_TASK.length + ' · review is running'
      : done + ' of ' + APP_TASK.length
  };
}

/* The activation checklist, for an approved partner. Five steps to a first
   sealed bid. Each is derived from real state, never from a stored flag: a
   checklist that can disagree with the console is worse than no checklist. */
var ACTIVATION = [
  ['coverage', 'Declare your coverage', 'State where you will bid and the services you can render there', 'coverage', 'Declare'],
  ['terms', 'Accept the standard cohort terms', 'One agreement covers every auction, so every sealed bid is comparable', 'contracts', 'Review'],
  ['pay', 'Add a payment method', 'Nothing bills until a switch completes, but be ready', 'billing', 'Add'],
  ['brief', 'Review your first auction brief', 'Open the closest deadline on the bid desk', 'desk', 'Open'],
  ['bid', 'Place your first sealed bid', 'Sealed, binding, improvable until close', 'desk', 'Bid']
];

/** @param {Object} done { coverage:bool, terms:bool, pay:bool, brief:bool, bid:bool } */
export function activationTasks(done) {
  var n = 0;
  var rows = ACTIVATION.map(function (t) {
    var d = !!done[t[0]];
    if (d) n++;
    return '<div class="task' + (d ? ' dn' : '') + '">'
      + '<i>' + (d ? '✓' : '') + '</i>'
      + '<div><b>' + esc(t[1]) + '</b><small>' + esc(t[2]) + '</small></div>'
      + (d ? '' : '<button class="tlink" type="button" data-action="nav" data-view="' + t[3] + '">' + esc(t[4]) + ' →</button>')
      + '</div>';
  }).join('');

  return {
    html: rows,
    done: n,
    total: ACTIVATION.length,
    label: n === ACTIVATION.length
      ? n + ' of ' + ACTIVATION.length + ' · you are live'
      : n + ' of ' + ACTIVATION.length
  };
}

/** The progress bar the checklist sits above. */
export function progress(done, total) {
  return '<div class="pbar"><i style="width:' + Math.round(done / total * 100) + '%"></i></div>';
}
