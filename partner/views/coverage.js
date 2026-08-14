/* Coverage: the gate on everything else.
 *
 * A cohort only reaches a partner's desk from inside a region they have
 * declared AND that has verified. So this is not a settings page, it is the
 * thing that makes the desk non-empty, and the empty state says exactly that
 * rather than "no coverage".
 *
 * Four states per region, and they are not interchangeable:
 *
 *   verifying   declared, being checked against facilities data
 *   active      checked and open. Only these produce a biddable cohort.
 *   rejected    checked and refused, WITH a reason and a route back
 *   soon        a platform state, not a partner one: the region exists but
 *               Whollar has not opened it. No edit affordance, because there
 *               is nothing the partner can do about it.
 *
 * Until the admin verify route shipped alongside this, `active` was
 * unreachable: every declared region sat in 'verifying' forever and no cohort
 * ever reached any desk. That was the single blocker under the whole console.
 */

import { get, set } from '../core/state.js';
import { api } from '../core/api.js';
import { esc, regionSlug } from '../core/format.js';
import { toast, failed } from '../core/toast.js';
import { on, onAnyClick } from '../core/actions.js';
import { authFailed } from '../core/session.js';
import { byId, byName, search, grouped } from '../core/districts.js';

/* The technologies desk.js accepts, in its own spelling. The console shows the
   label; the wire carries the value. Getting this wrong is a 400. */
var TECHS = [['fibre', 'Fibre'], ['cable', 'Cable'], ['dsl', 'DSL'], ['fwa', 'Fixed wireless']];
var SPEEDS = ['500 Mbps', '1 Gig', '2.5 Gig'];
var LEAD_TIMES = ['5 business days', '7 business days', '10 business days'];

var STATE_UI = {
  active: ['', 'Active'],
  verifying: ['pend', 'Verifying'],
  soon: ['soon', 'Coming soon'],
  rejected: ['rej', 'Not serviceable']
};

function techLabel(v) {
  for (var i = 0; i < TECHS.length; i++) if (TECHS[i][0] === v) return TECHS[i][1];
  return v;
}

function services(c) {
  var t = (c.techs || []).map(techLabel).join(' · ');
  return t + (c.speed ? (t ? ' · ' : '') + 'up to ' + c.speed : '');
}

function find(slug) {
  var rows = get().coverage;
  for (var i = 0; i < rows.length; i++) if (regionSlug(rows[i].region) === slug) return rows[i];
  return null;
}

/* ------------------------------------------------------------------ *
 * render
 * ------------------------------------------------------------------ */

/**
 * Paint, and hand the caret back.
 *
 * A refresh anywhere in the console repaints this view, which replaces the
 * picker's input node. Mid-search that reads as the field going dead under
 * your hands, so if the picker had focus it gets it back with the caret at the
 * end of what was typed.
 */
function paint(host, html) {
  var live = document.activeElement && document.activeElement.id === 'regin';
  host.innerHTML = html;
  if (!live) return;
  var input = document.getElementById('regin');
  if (!input) return;
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* not all inputs allow it */ }
}

export function render() {
  var host = document.getElementById('cov-body');
  if (!host) return;
  var S = get();

  if (!S.coverageLive) {
    host.innerHTML = '<section class="card"><div class="empty">'
      + '<h3>We could not read your coverage just now</h3>'
      + '<p>This is on our side, not yours. Nothing you have declared is lost. Reload in a moment, and if it keeps happening email partners@whollar.ca.</p>'
      + '</div></section>';
    return;
  }

  if (!S.coverage.length) {
    paint(host, '<section class="card"><div class="empty">'
      + '<h3>Nothing declared yet, so nothing reaches your desk</h3>'
      + '<p>Auctions are matched to partners by coverage. Pick a district and the services you can render there, and cohorts forming inside it start appearing on your bid desk. Serviceability is checked against facilities data; you do not have to wait for that to declare more.</p>'
      + '</div>' + addRow(true) + '</section>');
    return;
  }

  var rows = S.coverage.map(function (c) { return regionRow(c, S); }).join('');

  paint(host, '<section class="card" style="padding-top:14px" aria-label="Your regions">'
    + '<div class="twrap"><table class="tbl">'
    + '<thead><tr><th>Region</th><th>Status</th><th>Services declared</th><th class="num">Open</th><th></th></tr></thead>'
    + '<tbody>' + rows + addRow(false) + '</tbody></table></div>'
    + '<p class="fnote">Pick the districts you want to bid in and the services you can render there. A district is roughly 25k to 40k households, and a new one verifies against serviceability before auctions appear.</p>'
    + '</section>');
}

function regionRow(c, S) {
  var slug = regionSlug(c.region);
  var ui = STATE_UI[c.status] || STATE_UI.verifying;
  var openN = S.campaigns.filter(function (a) {
    return regionSlug(a.coverageRegion || a.region) === slug && (a.stage === 'open' || a.stage === 'closing');
  }).length;

  var main = '<tr><td><span class="rg" style="font-size:13.5px">' + esc(c.region) + '</span></td>'
    + '<td><span class="covdot ' + ui[0] + '"></span>' + ui[1] + '</td>'
    + '<td class="covsvc">' + esc(services(c)) + '</td>'
    + '<td class="num">' + (openN || '·') + '</td>'
    + '<td style="white-space:nowrap">'
    + (c.status === 'soon'
      ? '<span class="mono" style="font-size:11px;color:var(--sub)">Queued for launch</span>'
      : '<button class="tlink" type="button" data-action="coverage:edit" data-region="' + esc(slug) + '">Edit services</button>')
    + '</td></tr>';

  /* A rejected region has to say why and leave a route forward, or a partner
     has nothing to act on. The reason is an enum server side (it feeds the
     serviceability figure); the sentence is written here. */
  if (c.status === 'rejected') {
    main += '<tr><td colspan="5" style="padding-top:0">'
      + '<p class="fnote covwhy"><b>Why:</b> ' + esc(c.rejectionReason || 'We could not confirm facilities for this footprint.')
      + ' If that is wrong, email partners@whollar.ca with the detail and we will re-check it.</p></td></tr>';
  }

  /* Verifying says how long, because silence on a check with no ETA reads as a
     check that is not running. */
  if (c.status === 'verifying') {
    main += '<tr><td colspan="5" style="padding-top:0">'
      + '<p class="fnote covwhy">Checking this footprint against facilities data. Most clear within two business days, and you can declare more regions while it runs.</p></td></tr>';
  }

  if (get().covEdit === slug) main += editRow(c, slug);
  return main;
}

function editRow(c, slug) {
  var chosen = get().covDraft || (c.techs || []).slice();
  return '<tr class="covedit"><td colspan="5"><div class="dh">Services in ' + esc(c.region) + '</div>'
    + '<div class="cechips" data-ce="' + esc(slug) + '">'
    + TECHS.map(function (t) {
      return '<button type="button" data-action="coverage:chip" data-t="' + t[0] + '" class="'
        + (chosen.indexOf(t[0]) > -1 ? 'on' : '') + '">' + t[1] + '</button>';
    }).join('')
    + '</div>'
    + '<div class="ceform"><div><label>Top speed offered</label><select id="ce-speed">'
    + SPEEDS.map(function (s) { return '<option' + (c.speed === s ? ' selected' : '') + '>' + s + '</option>'; }).join('')
    + '</select></div>'
    + '<div><label>Install lead time</label><select id="ce-lead">'
    + LEAD_TIMES.map(function (s) { return '<option' + (c.lead === s ? ' selected' : '') + '>' + s + '</option>'; }).join('')
    + '</select></div>'
    + '<div><button class="btn forest" type="button" data-action="coverage:save" data-region="' + esc(slug) + '">Save</button></div>'
    + '</div></td></tr>';
}

/* ------------------------------------------------------------------ *
 * the district picker
 *
 * Free text used to write straight into coverage, and a declared region IS the
 * bid unit, so "downtown-ish" was a region no cohort could ever match. The
 * field now only yields districts from core/districts.js.
 *
 * WHY THE PICKER STATE IS MODULE LOCAL AND NOT IN THE STORE. Every set() in
 * this console repaints every view, so a query in the store would rebuild the
 * table on each keystroke and take the caret with it. These three live here,
 * render() paints from them, and typing repaints the results panel only. A
 * background refresh still restores the typed text and the open panel, which
 * is the property the store was giving us, without the repaint.
 * ------------------------------------------------------------------ */

var pQuery = '';    /* what is typed */
var pPick = null;   /* district id chosen from the list, or null */
var pOpen = false;  /* is the results panel showing */
var pActive = -1;   /* index into the selectable rows, for up and down */

/** Districts already declared cannot be declared twice. */
function declaredSlugs() {
  var out = {};
  get().coverage.forEach(function (c) { out[regionSlug(c.region)] = true; });
  return out;
}

/**
 * Every row the panel will draw, in order, each labelled with why it is or is
 * not selectable. One pass so the keyboard and the mouse cannot disagree about
 * which rows are pickable.
 */
function results() {
  var taken = declaredSlugs();
  return search(pQuery).map(function (d) {
    var why = d.tier !== 'launch' ? 'Queued for launch'
      : (taken[regionSlug(d.name)] ? 'Already declared' : '');
    return { d: d, tag: why, pickable: !why };
  });
}

function pickable(rows) { return rows.filter(function (r) { return r.pickable; }); }

function panelHtml() {
  var rows = results();
  if (!rows.length) {
    return '<p class="dnone">No district by that name yet. Try a municipality, like Brampton or Vaughan.</p>';
  }
  var order = pickable(rows);
  return grouped(rows.map(function (r) { return r.d; })).map(function (g) {
    var body = rows.filter(function (r) { return r.d.muni === g.muni; }).map(function (r) {
      var i = order.indexOf(r);
      if (!r.pickable) {
        return '<div class="dopt off" role="option" aria-disabled="true" aria-selected="false">'
          + '<span>' + esc(r.d.name) + '</span><span class="dtag">' + r.tag + '</span></div>';
      }
      return '<div class="dopt' + (i === pActive ? ' act' : '') + '" role="option" id="dopt-' + esc(r.d.id) + '"'
        + ' aria-selected="' + (i === pActive ? 'true' : 'false') + '"'
        + ' data-action="coverage:pick" data-id="' + esc(r.d.id) + '">'
        + '<span>' + esc(r.d.name) + '</span></div>';
    }).join('');
    return '<div class="dgrp">' + esc(g.muni) + '</div>' + body;
  }).join('');
}

function picker() {
  return '<div class="dsel" id="regsel">'
    + '<input id="regin" type="text" role="combobox" aria-expanded="' + (pOpen ? 'true' : 'false') + '"'
    + ' aria-controls="regpanel" aria-autocomplete="list" autocomplete="off" spellcheck="false"'
    + ' placeholder="Choose a district you want to bid in" aria-label="Choose a district"'
    + ' data-action="coverage:query" value="' + esc(pQuery) + '">'
    + '<div class="dpanel" id="regpanel" role="listbox" aria-label="Districts"' + (pOpen ? '' : ' hidden') + '>'
    + (pOpen ? panelHtml() : '') + '</div></div>';
}

/** Repaint the panel alone, so the input keeps focus and caret while typing. */
function paintPanel() {
  var input = document.getElementById('regin');
  var panel = document.getElementById('regpanel');
  if (!panel || !input) return;
  panel.innerHTML = pOpen ? panelHtml() : '';
  if (pOpen) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
  input.setAttribute('aria-expanded', pOpen ? 'true' : 'false');
  var act = panel.querySelector('.dopt.act');
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
}

function closePanel() {
  if (!pOpen) return;
  pOpen = false;
  pActive = -1;
  paintPanel();
}

function choose(id) {
  var d = byId(id);
  if (!d) return;
  pPick = d.id;
  pQuery = d.name;
  var input = document.getElementById('regin');
  if (input) { input.value = d.name; input.focus(); }
  closePanel();
}

function addRow(standalone) {
  var inner = '<td colspan="2">' + picker() + '</td>'
    + '<td><div class="cechips" id="addtech" style="margin:0">'
    + TECHS.map(function (t) { return '<button type="button" data-action="coverage:chip" data-t="' + t[0] + '">' + t[1] + '</button>'; }).join('')
    + '</div></td>'
    + '<td><select id="addspeed" class="covspeed">'
    + SPEEDS.map(function (s) { return '<option>' + s + '</option>'; }).join('')
    + '</select></td>'
    + '<td><button class="btn forest" type="button" data-action="coverage:add" style="width:100%;justify-content:center">Declare</button></td>';
  if (!standalone) return '<tr class="addrow">' + inner + '</tr>';
  return '<div class="twrap" style="margin-top:14px"><table class="tbl"><tbody><tr class="addrow">' + inner + '</tr></tbody></table></div>';
}

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

export function mount() {
  on('click', 'coverage:edit', function (el) {
    var slug = el.getAttribute('data-region');
    set({ covEdit: get().covEdit === slug ? null : slug, covDraft: null });
  });

  /* Chip toggles are local until Save, and the draft lives in the store rather
     than in the DOM so a background refresh cannot silently discard a
     half-made edit. */
  on('click', 'coverage:chip', function (el) {
    el.classList.toggle('on');
    var wrap = el.closest('.cechips');
    if (wrap && wrap.getAttribute('data-ce')) {
      set('covDraft', Array.prototype.slice.call(wrap.querySelectorAll('button.on'))
        .map(function (b) { return b.getAttribute('data-t'); }));
    }
  });

  on('click', 'coverage:save', function (el) {
    var slug = el.getAttribute('data-region');
    var c = find(slug);
    if (!c) return;
    var techs = get().covDraft || (c.techs || []);
    if (!techs.length) { toast('Pick at least one technology you serve there.'); return; }

    var W = window.WHOLLAR;
    if (!W.busy(el, true, 'Saving')) return;
    var speedEl = document.getElementById('ce-speed');
    var leadEl = document.getElementById('ce-lead');

    api.coverageUpdate({
      region: c.region,
      techs: techs,
      speed: speedEl ? speedEl.value : c.speed,
      lead: leadEl ? leadEl.value : c.lead
    }).then(function (r) {
      W.busy(el, false);
      set({ coverage: (r && r.coverage) || get().coverage, covEdit: null, covDraft: null });
      toast('Services updated for ' + c.region + '.');
    }, function (err) {
      W.busy(el, false);
      failed(err);
      authFailed(err);
    });
  });

  /* ---- the district picker ---- */

  /* Typing filters. A keystroke invalidates any earlier pick: the pick is what
     Declare trusts, so leaving it set while the text says something else is
     how a partner declares a district they are no longer looking at. */
  on('input', 'coverage:query', function (el) {
    pQuery = el.value;
    pPick = null;
    pOpen = true;
    pActive = -1;
    paintPanel();
  });

  on('click', 'coverage:query', function () {
    if (pOpen) return;
    pOpen = true;
    pActive = -1;
    paintPanel();
  });

  on('keydown', 'coverage:query', function (el, e) {
    var rows = pickable(results());
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!pOpen) { pOpen = true; pActive = -1; }
      if (rows.length) {
        pActive = e.key === 'ArrowDown'
          ? Math.min(pActive + 1, rows.length - 1)
          : Math.max(pActive - 1, 0);
      }
      paintPanel();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (pOpen && pActive > -1 && rows[pActive]) choose(rows[pActive].d.id);
      /* One exact-match convenience, and only that: typing a full district
         name and pressing Enter picks it. Anything else leaves the pick unset,
         and Declare refuses. */
      else if (byName(el.value)) choose(byName(el.value).id);
      return;
    }
    if (e.key === 'Escape') { closePanel(); return; }
  });

  on('click', 'coverage:pick', function (el) { choose(el.getAttribute('data-id')); });

  /* Attention moved elsewhere: close, rather than leaving a listbox floating
     over the chips a partner is now clicking. */
  onAnyClick(function (e) {
    if (!pOpen) return;
    if (e.target.closest && e.target.closest('#regsel')) return;
    closePanel();
  });

  on('click', 'coverage:add', function (el) {
    /* The vocabulary is the whole point: nothing but a launch district can be
       declared, so this resolves the field back to one and refuses otherwise.
       An unresolvable field is a typo, not a new region. */
    var input = document.getElementById('regin');
    var typed = input ? input.value.trim() : '';
    var d = pPick ? byId(pPick) : byName(typed);
    if (!d) { toast('Pick a district from the list.'); return; }
    if (d.tier !== 'launch') { toast(d.name + ' is queued for launch. Pick a district that is open.'); return; }
    if (declaredSlugs()[regionSlug(d.name)]) { toast('You have already declared ' + d.name + '.'); return; }

    var techs = Array.prototype.slice.call(document.querySelectorAll('#addtech button.on'))
      .map(function (b) { return b.getAttribute('data-t'); });
    if (!techs.length) { toast('Pick at least one technology you serve there.'); return; }

    var W = window.WHOLLAR;
    if (!W.busy(el, true, 'Declaring')) return;
    var speedEl = document.getElementById('addspeed');

    api.coverageDeclare({ region: d.name, techs: techs, speed: speedEl ? speedEl.value : SPEEDS[0] })
      .then(function (r) {
        W.busy(el, false);
        pQuery = ''; pPick = null; pOpen = false; pActive = -1;
        set({ coverage: (r && r.coverage) || get().coverage, covEdit: null, covDraft: null });
        toast(d.name + ' declared. Verifying serviceability against facilities data.');
      }, function (err) {
        W.busy(el, false);
        failed(err);
        authFailed(err);
      });
  });
}
