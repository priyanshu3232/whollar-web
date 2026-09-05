/* The brands you operate, and the attestation that they are all of them.
 *
 * WHY A PARTNER IS ASKED THIS AT ALL. A household can name providers it will
 * not hear from, and that promise is only as good as this system's answer to
 * "who is Virgin Plus". If a partner can bid under a brand it never declared,
 * an exclusion is bypassed by omission rather than by intent, and nobody has
 * to have done anything dishonest for the household to receive the offer it
 * refused. So the roster is a claim someone signs, and any change re-opens it:
 * a list that was complete in August is a different claim in November.
 *
 * WHAT THIS SCREEN NEVER SHOWS. Not how many households excluded a brand, not
 * which ones, not whether an exclusion cost this partner a specific cohort.
 * The reach line on the desk is one aggregate number and this panel carries
 * none at all: the numbers are on the surfaces where a partner is deciding
 * what to bid, and a settings screen is not one of them.
 *
 * The pending state is real rather than optimistic. A requested brand sits at
 * "Awaiting verification" and cannot be bid under until an operator promotes
 * it, because the whole point of the review is that the request is not the
 * answer.
 */

import { get, set } from '../core/state.js';
import { api } from '../core/api.js';
import { esc } from '../core/format.js';
import { fmtDate } from '../core/time.js';
import { on } from '../core/actions.js';
import { open as openModal, close as closeModal } from '../core/modal.js';
import { toast, failed } from '../core/toast.js';
import { authFailed } from '../core/session.js';

/* Section 13, verbatim. Changing a word here changes what a partner attested
   to, so scripts/check-exclusion-copy.mjs holds these to the brief. */
export var ATTEST = 'We confirm this is the complete list of consumer brands '
  + 'our organization owns or operates. Bids and offers we submit are made on '
  + 'behalf of these brands only.';

export var HEADING = 'Brands you operate';
export var PENDING_LABEL = 'Awaiting verification';

/** The draft selection while the picker is open, brand ids. Null when closed. */
var draft = null;

export function load() {
  return api.brandRoster().then(function (r) {
    set({ roster: r, rosterLoaded: true });
  }).catch(function (e) {
    if (authFailed(e)) return;
    set({ roster: null, rosterLoaded: true });
  });
}

function chip(b, extra) {
  return '<span class="chip' + (extra ? ' ' + extra : '') + '">' + esc(b.display_name || b.brand_id) + '</span>';
}

export function render() {
  var host = document.getElementById('roster-body');
  if (!host) return;
  var S = get();
  var r = S.roster;

  /* Not loaded, or the route refused. "We could not read your roster" is a
     different sentence from "you have declared nothing", and the second would
     be a lie that invites a partner to re-declare a list already on file. */
  if (!S.rosterLoaded) {
    host.innerHTML = '<section class="card"><span class="eyebrow">Brands</span>'
      + '<h3>' + esc(HEADING) + '</h3><p class="cardnote">Reading your roster…</p></section>';
    return;
  }
  if (!r) {
    host.innerHTML = '<section class="card"><span class="eyebrow">Brands</span>'
      + '<h3>' + esc(HEADING) + '</h3>'
      + '<p class="cardnote">We could not read your roster just now. Reload, and tell us if it keeps happening.</p>'
      + '</section>';
    return;
  }
  if (r.available === false) {
    host.innerHTML = '<section class="card"><span class="eyebrow">Brands</span>'
      + '<h3>' + esc(HEADING) + '</h3>'
      + '<p class="cardnote">Brand declarations open shortly. Nothing is needed from you yet.</p>'
      + '</section>';
    return;
  }

  var mine = r.brands || [];
  var pending = (r.registry || []).filter(function (b) { return b.status === 'pending_review'; });

  host.innerHTML = '<div class="grid2">'
    + '<section class="card" aria-label="' + esc(HEADING) + '">'
    + '<span class="eyebrow">Brands</span><h3>' + esc(HEADING) + '</h3>'
    + (mine.length
      ? '<p class="cardnote">Every bid you place names one of these. A household that has excluded one of them will not be sent your offer under it.</p>'
        + '<div class="chips" data-testid="prov-roster-list">'
        + mine.map(function (b) { return chip(b); }).join('') + '</div>'
      : '<p class="cardnote">You have not declared the brands you operate. Until you do, a bid cannot name a brand, and you cannot be matched against a household\'s exclusions.</p>')
    + (r.attested
      ? '<p class="fnote">Attested ' + esc(fmtDate(r.attestedAt) || 'on file')
        + '. Any change to this list asks you to confirm it again.</p>'
      : '<p class="fnote">Not yet attested.</p>')
    + '<button class="tlink" type="button" data-action="roster:edit" data-testid="prov-roster-edit" style="margin-top:12px">'
    + (mine.length ? 'Update your brands' : 'Declare your brands') + ' →</button>'
    + '</section>'
    + '<aside class="aside">'
    + '<section class="card" aria-label="A brand we do not list">'
    + '<span class="eyebrow">Missing a brand</span><h3>Ask us to list it</h3>'
    + '<p class="cardnote">If you operate a brand that is not in our list, tell us and we will verify it. You cannot bid under it until we have.</p>'
    + (pending.length
      ? '<div class="chips">' + pending.map(function (b) {
        return chip(b, 'chip-wait') + '<span class="fnote">' + esc(PENDING_LABEL) + '</span>';
      }).join('') + '</div>'
      : '')
    + '<button class="tlink" type="button" data-action="roster:request" style="margin-top:12px">Request a brand listing →</button>'
    + '</section></aside></div>';
}

/* ------------------------------------------------------------------ *
 * The picker
 * ------------------------------------------------------------------ */

function pickerBody() {
  var S = get();
  var r = S.roster || {};
  var registry = (r.registry || []).filter(function (b) { return b.status !== 'pending_review'; });
  var chosen = draft || (r.brands || []).map(function (b) { return b.brand_id; });

  /* Parents first, each with its flankers indented under it, so a partner
     declaring Bell can see what else it is being asked about. The registry
     is one level deep by construction (lib/brands.js), so this needs no
     recursion and must not grow any. */
  var parents = registry.filter(function (b) { return !b.parent_brand_id; });
  var kids = {};
  registry.forEach(function (b) {
    if (!b.parent_brand_id) return;
    (kids[b.parent_brand_id] = kids[b.parent_brand_id] || []).push(b);
  });

  function line(b, indent) {
    var on = chosen.indexOf(b.brand_id) >= 0;
    return '<label class="optrow' + (indent ? ' optrow-sub' : '') + '">'
      + '<input type="checkbox" data-brand="' + esc(b.brand_id) + '"'
      + ' data-testid="prov-roster-check-' + esc(b.brand_id) + '"'
      + (on ? ' checked' : '') + '>'
      + '<span>' + esc(b.display_name || b.brand_id) + '</span></label>';
  }

  return '<h3>' + esc(HEADING) + '</h3>'
    + '<p class="cardnote">Tick every consumer brand your organization owns or operates.</p>'
    + '<div class="optlist" data-testid="prov-roster-section">'
    + parents.map(function (p) {
      return line(p, false)
        + (kids[p.brand_id] || []).map(function (k) { return line(k, true); }).join('');
    }).join('')
    + '</div>'
    + '<label class="optrow" style="margin-top:14px">'
    + '<input type="checkbox" id="roster-attest" data-testid="prov-roster-attest">'
    + '<span>' + esc(ATTEST) + '</span></label>'
    + '<div class="mrow" style="margin-top:16px">'
    + '<button class="btn" type="button" data-action="roster:save" data-testid="prov-roster-save">Save and attest</button>'
    + '<button class="tlink" type="button" data-action="modal:close">Cancel</button>'
    + '</div>'
    + '<p class="fnote" id="roster-err" hidden></p>';
}

function showError(message) {
  var el = document.getElementById('roster-err');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

export function mount() {
  on('click', 'roster:edit', function () {
    var S = get();
    draft = ((S.roster || {}).brands || []).map(function (b) { return b.brand_id; });
    openModal(pickerBody());
  });

  on('click', 'roster:save', function () {
    var box = document.getElementById('roster-attest');
    var picked = Array.prototype.slice.call(
      document.querySelectorAll('.optlist input[data-brand]:checked')
    ).map(function (i) { return i.getAttribute('data-brand'); });

    /* Both refusals are the server's rules, stated here before the round trip
       so the partner is not told "422" for something the screen could see.
       The server enforces them regardless: this is a courtesy, not the gate. */
    if (!picked.length) {
      showError('Tick at least one brand you operate.');
      return;
    }
    if (!box || !box.checked) {
      showError('Confirm the list is complete before you save it.');
      return;
    }

    api.brandRosterDeclare({ brand_ids: picked, attestation: true }).then(function () {
      draft = null;
      closeModal();
      toast('Brands saved and attested.');
      return load();
    }).catch(function (e) {
      if (authFailed(e)) return;
      showError((e && e.message) || 'That could not be saved. Try again shortly.');
    });
  });

  on('click', 'roster:request', function () {
    openModal('<h3>Request a brand listing</h3>'
      + '<p class="cardnote">We verify the brand is yours before it can be bid under.</p>'
      + '<label class="flab">Brand name, as a household sees it'
      + '<input class="fin" id="br-name" maxlength="120" autocomplete="off"></label>'
      + '<label class="flab">A link that shows it is yours'
      + '<input class="fin" id="br-url" maxlength="500" placeholder="https://" autocomplete="off"></label>'
      + '<label class="flab">Anything we should know (optional)'
      + '<textarea class="fin" id="br-note" maxlength="1000" rows="3"></textarea></label>'
      + '<div class="mrow" style="margin-top:16px">'
      + '<button class="btn" type="button" data-action="roster:request:send">Send request</button>'
      + '<button class="tlink" type="button" data-action="modal:close">Cancel</button>'
      + '</div><p class="fnote" id="roster-err" hidden></p>');
  });

  on('click', 'roster:request:send', function () {
    var name = (document.getElementById('br-name') || {}).value || '';
    var url = (document.getElementById('br-url') || {}).value || '';
    var note = (document.getElementById('br-note') || {}).value || '';
    if (String(name).trim().length < 2) {
      showError('Give the brand name as it appears to a household.');
      return;
    }
    if (!/^https?:\/\//i.test(String(url).trim())) {
      showError('Give a link that shows the brand is yours.');
      return;
    }
    api.brandRequest({ name: name, evidence_url: url, note: note }).then(function () {
      closeModal();
      toast('Request sent. We will verify it and let you know.');
      return load();
    }).catch(function (e) {
      if (authFailed(e)) return;
      showError((e && e.message) || 'That could not be sent. Try again shortly.');
    });
  });
}
