/* Account: what we hold.
 *
 * The four alert toggles live on the overview, where the prototype put them
 * and where a partner is already looking at cohort timing. The markup and the
 * save handler stay here, because the preference is an account record and one
 * module owning `account:notify` is what keeps a second registration from
 * claiming it.
 *
 * Editing is read-only for now and says so. A field that silently does nothing
 * is worse than one that is honestly not editable yet, and the edit path is
 * endpoint 66, which is live for prefs and not for the org record.
 */

import { get, set } from '../core/state.js';
import { api } from '../core/api.js';
import { esc, titleCase, monogram } from '../core/format.js';
import { toast } from '../core/toast.js';
import { on } from '../core/actions.js';
import { authFailed } from '../core/session.js';

var NOTIFY = [
  ['forming', 'New cohort forming in my coverage'],
  ['opens', 'Bidding opens'],
  ['closing', 'Closing in 24 hours and I have not bid'],
  ['results', 'Results, win or lose']
];

export function roleLabel(r) {
  if (r === 'admin') return 'Account admin';
  if (r === 'bidder') return 'Bid authority';
  if (r === 'viewer') return 'Viewer';
  return r ? titleCase(r) : null;
}

/* The alerts card, rendered into the overview aside. Only one copy may exist
   at a time: the change handler reads every box back by data-key, so a second
   copy would save the first one's state over the one just clicked. */
export function alertsHTML() {
  var notify = (get().prefs && get().prefs.notify) || {};
  return '<section class="card" aria-label="Auction alerts">'
    + '<span class="eyebrow">Auction alerts</span><h3>When cohorts move</h3>'
    + NOTIFY.map(function (n) {
      return '<label class="tog"><input type="checkbox" data-action="account:notify" data-key="' + n[0] + '"'
        + (notify[n[0]] === false ? '' : ' checked') + '><i></i><span>' + esc(n[1]) + '</span></label>';
    }).join('')
    + '<p class="fnote">Saved to your account, not to this browser.</p>'
    + '</section>';
}

export function render() {
  var S = get();
  var org = S.org || {};
  var user = S.user || {};

  var sub = document.getElementById('acct-sub');
  if (sub) {
    sub.textContent = [org.name, S.approved ? 'Founding partner' : 'Application under review']
      .filter(Boolean).join(' · ');
  }

  var host = document.getElementById('acct-body');
  if (!host) return;

  host.innerHTML = '<div class="grid2">'
    + '<section class="card" aria-label="Organization">'
    + '<span class="eyebrow">Organization</span><h3>Who we have on file</h3>'
    + '<ul class="pi">'
    + row('Company', org.name)
    + row('Approval', S.approved ? 'Approved' : 'Under review')
    + row('Signed in as', [user.firstName, user.lastName].filter(Boolean).join(' '))
    + row('Email', user.email)
    + row('Your role', roleLabel(org.role))
    + '</ul>'
    + '<p class="fnote">To change any of this, email partners@whollar.ca and we will update it. Editing from this page lands with the account endpoints.</p>'
    + '<button class="tlink" type="button" data-action="account:signout" style="margin-top:12px">Sign out</button>'
    + '</section>'
    + '<aside class="aside">'
    + '<section class="card" aria-label="Your Whollar contact">'
    + '<span class="eyebrow">Your Whollar contact</span><h3>Talk to someone who can act</h3>'
    + '<p class="cardnote">Auction briefs, coverage verification, statement questions: your message lands with the team running your cohorts. Weekdays, usually within the hour.</p>'
    + '<a class="tlink" href="mailto:partners@whollar.ca">Email partners@whollar.ca →</a>'
    + '</section></aside></div>';
}

function row(label, value) {
  return '<li><span>' + esc(label) + '</span><b>'
    + (value ? esc(value) : '<span style="color:var(--sub)">Not on file</span>') + '</b></li>';
}

/** The pane and header chrome, from the real partner record. */
export function paintChrome() {
  var S = get();
  var first = String((S.user && S.user.firstName) || (S.partner && S.partner.firstName) || '').trim();
  var last = String((S.user && S.user.lastName) || '').trim();
  var org = String((S.org && S.org.name) || (S.partner && S.partner.org) || '').trim();
  var role = (S.org && S.org.role) || (S.partner && S.partner.role) || '';

  var h = new Date().getHours();
  var greet = h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');

  text('greetline', greet + (first ? ', ' + first : ''));
  /* No org yet is a real state: the local record is written from the session,
     which does not carry org context. Say nothing rather than guess a name
     from the email domain the way the v3 console did. */
  text('greetsub', org);
  text('paneorg', org || 'Your company');
  text('panerole', S.approved ? (roleLabel(role) || 'Partner') : 'Under review');
  text('paneava', monogram(org || first || '?'));
  text('topava', monogram([first, last].filter(Boolean).join(' ') || org || '?'));
}

function text(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value;
}

export function mount() {
  on('change', 'account:notify', function (el) {
    var next = {};
    NOTIFY.forEach(function (n) {
      var box = document.querySelector('[data-key="' + n[0] + '"]');
      next[n[0]] = box ? box.checked : true;
    });
    api.prefsSave({ notify: next }).then(function () {
      var prefs = get().prefs || {};
      prefs.notify = next;
      set('prefs', prefs);
      toast('Preference saved.');
    }, function (err) {
      el.checked = !el.checked;    /* put the switch back, it did not take */
      toast((err && err.message) || 'That did not save. Try again.');
      authFailed(err);
    });
  });

  on('click', 'account:signout', function () {
    /* End the SERVER session, not just the local record. Clearing localStorage
       alone leaves the cookie alive, and the boot guard would adopt() it on the
       next visit and sign the visitor straight back in. */
    var done = function () { location.replace('/whollar-login-provider'); };
    api.signOut().then(done, done);
  });
}
