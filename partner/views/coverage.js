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
 * A REGION IS PICKED, NEVER TYPED. The declarable list is core/places.js: a
 * city, then a region inside it. That file explains at length why only the
 * region name goes on the wire, and why city and province are read back out
 * of the list rather than stored.
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
import { cityKey, findCity, isWholeCity, placeOf, readsAs, isLaunchRegion, searchCities } from '../core/places.js';

/* The technologies desk.js accepts, in its own spelling. The console shows the
   label; the wire carries the value. Getting this wrong is a 400. */
var TECHS = [['fibre', 'Fibre'], ['cable', 'Cable'], ['dsl', 'DSL'], ['fwa', 'Fixed wireless']];

/* The speed ladder, ascending, as [Mbps, label]. Mbps is what goes on the wire
   and Mbps is what the desk compares, so the label can be reworded without
   invalidating a single declared row.

   THIS IS A SET, NOT A CEILING. It used to be "Top speed offered", one value
   from three, and a top speed cannot say that a partner sells 500 Mbps and 1
   Gig on the same street but nothing under it. Cohorts are matched on the tier
   a household actually wants, so declaring the ceiling made every partner look
   serviceable at every tier beneath it.

   ON THE WIRE it is a CSV of Mbps in ascending order, the same shape `techs`
   already uses: "500,1000". That needs provider_coverage.speed at 64
   characters, not the original 16; see create-tables.md. All six selected is
   "50,100,200,500,1000,2500", 24 characters, so 64 has room for the ladder to
   grow twice over. */
var SPEEDS = [
  [50, '50 Mbps'], [100, '100 Mbps'], [200, '200 Mbps'],
  [500, '500 Mbps'], [1000, '1 Gig'], [2500, '2.5 Gig']
];
var LEAD_TIMES = ['5 business days', '7 business days', '10 business days'];

/* Read whatever is on the record into an array of Mbps numbers.
   Tolerates all three shapes that can arrive: the new CSV ("500,1000"), an
   array, and the single legacy label ("1 Gig") written before this was a set.
   A row declared under the old field keeps meaning what it meant. */
function speedList(v) {
  if (v === null || v === undefined || v === '') return [];
  var parts = Array.isArray(v) ? v : String(v).split(',');
  var out = [];
  parts.forEach(function (p) {
    var s = String(p).trim();
    if (!s) return;
    var n = parseInt(s, 10);
    if (!isFinite(n) || n <= 0) return;
    /* "1 Gig" and "2.5 Gig" parse to 1 and 2, so the legacy labels are matched
       whole before the bare number is trusted. */
    for (var i = 0; i < SPEEDS.length; i++) {
      if (SPEEDS[i][1] === s) { n = SPEEDS[i][0]; break; }
    }
    if (out.indexOf(n) < 0) out.push(n);
  });
  return out.sort(function (a, b) { return a - b; });
}
function speedLabel(mbps) {
  for (var i = 0; i < SPEEDS.length; i++) if (SPEEDS[i][0] === mbps) return SPEEDS[i][1];
  return mbps + ' Mbps';
}
/** Ascending CSV of Mbps: what the record stores and the desk compares. */
function speedWire(list) {
  return speedList(list).join(',');
}
/** "500 Mbps, 1 Gig", or "every tier" once the whole ladder is on. */
function speedText(v) {
  var list = speedList(v);
  if (!list.length) return '';
  if (list.length === SPEEDS.length) return 'every tier';
  return list.map(speedLabel).join(', ');
}

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
  /* "up to X" was true of a ceiling and is false of a set: a partner offering
     500 Mbps and 1 Gig is not offering everything up to 1 Gig. */
  var s = speedText(c.speed);
  return t + (s ? (t ? ' · ' : '') + s : '');
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
 * open panel's search field. Mid-search that reads as the field going dead
 * under your hands, so if one had focus it gets it back with its text and the
 * caret at the end.
 */
function paint(host, html) {
  var live = document.activeElement;
  var id = live && live.className === 'cvsearch' ? live.id : null;
  var text = id ? live.value : '';
  host.innerHTML = html;
  if (!id) return;
  var input = document.getElementById(id);
  if (!input) return;
  input.value = text;
  paintList(id === 'cv-city-q' ? 'city' : 'region', text);
  input.focus();
  try { input.setSelectionRange(text.length, text.length); } catch (e) { /* not all inputs allow it */ }
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

  paint(host, pickerCard() + declaredCard(S));
}

/* The picker, as one card. Its own heading rather than the view's, because the
   view header has to keep saying what Coverage is for to a partner who already
   has ten regions on file and is not declaring anything today. */
function pickerCard() {
  return '<section class="card" aria-label="Declare a region">'
    + '<span class="eyebrow gld">Where do you serve?</span>'
    + '<h3>Pick your city, then the region inside it</h3>'
    + '<p class="cardnote">A region is the unit a cohort runs in, so it is the unit you bid in. '
    + 'Declare as many as you serve; each one starts its own serviceability check.</p>'
    + picker()
    + '</section>';
}

function declaredCard(S) {
  var n = S.coverage.length;
  var body = n
    ? '<div class="twrap"><table class="tbl">'
      + '<thead><tr><th>Region</th><th>Status</th><th>Services declared</th><th class="num">Open</th><th></th></tr></thead>'
      + '<tbody>' + S.coverage.map(function (c) { return regionRow(c, S); }).join('') + '</tbody></table></div>'
    : '<div class="cvnone">Pick a city, then a region, then Declare. Auctions only reach your desk from inside your declared coverage.</div>';

  return '<section class="card" style="margin-top:16px" aria-label="Declared coverage">'
    + '<span class="eyebrow">Declared coverage</span>'
    + '<h3>' + (n ? n + ' region' + (n === 1 ? '' : 's') + ' on file' : 'Nothing declared yet') + '</h3>'
    + '<p class="cardnote">Each row is one region you will receive cohorts from, read back as '
    + 'Region, City, Province. A new one verifies against serviceability before auctions appear.</p>'
    + body + '</section>';
}

function regionRow(c, S) {
  var slug = regionSlug(c.region);
  var ui = STATE_UI[c.status] || STATE_UI.verifying;
  var openN = S.campaigns.filter(function (a) {
    return regionSlug(a.coverageRegion || a.region) === slug && (a.stage === 'open' || a.stage === 'closing');
  }).length;

  /* The row reads back exactly what the picker promised: Region, City,
     Province. The city half is derived from core/places.js, because the record
     does not carry it; a region we do not recognise shows its name alone
     rather than an invented city. */
  var place = placeOf(c.region);
  var main = '<tr><td><span class="rg" style="font-size:13.5px">' + esc(c.region)
    + (place ? '<small>' + esc(readsAs(c.region)) + '</small>' : '') + '</span></td>'
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
    + '<div class="cerow">'
    + '<div><label class="celab">Services</label>' + techSelect('ce-tech', chosen, slug) + '</div>'
    + '<div><label class="celab">Speed tiers offered</label>' + speedSelect('ce-speed', c.speed) + '</div>'
    + '</div>'
    + '<div class="ceform"><div><label>Install lead time</label><select id="ce-lead">'
    + LEAD_TIMES.map(function (s) { return '<option' + (c.lead === s ? ' selected' : '') + '>' + s + '</option>'; }).join('')
    + '</select></div>'
    + '<div><button class="btn forest" type="button" data-action="coverage:save" data-region="' + esc(slug) + '">Save</button></div>'
    + '</div></td></tr>';
}

/* ------------------------------------------------------------------ *
 * the city and region picker
 *
 * TWO STEPS, because a region name alone is not an address. "Downtown" and
 * "West End" mean different places in Toronto and Vancouver, and a partner
 * scanning one flat list of 251 names has no way to tell which one they are
 * about to declare. City first narrows it to a handful and makes the answer
 * readable back: Region, City, Province.
 *
 * ONLY THE REGION NAME GOES ON THE WIRE. core/places.js explains why at
 * length: the server matches a bid to coverage on the region slug alone, so a
 * composite value would refuse every bid. City and province are read back out
 * of the list for display.
 *
 * WHY THIS STATE IS MODULE LOCAL AND NOT IN THE STORE. Every set() in this
 * console repaints every view, so a query in the store would rebuild the whole
 * page on each keystroke and take the caret with it. These live here, render()
 * paints from them, and typing repaints one list.
 * ------------------------------------------------------------------ */

var cvCity = null;      /* chosen city name */
var cvProv = null;      /* chosen province */
var cvRegion = null;    /* chosen region, the bid unit */
var cvOpen = null;      /* 'city' | 'region' | null: which panel is showing */

function cvPlace() { return findCity(cvCity, cvProv); }

/** Regions already declared cannot be declared twice. */
function declaredSlugs() {
  var out = {};
  get().coverage.forEach(function (c) { out[regionSlug(c.region)] = true; });
  return out;
}

function cvDuplicate() {
  return !!(cvRegion && declaredSlugs()[regionSlug(cvRegion)]);
}

/* ---- the city list ---- */

function cityListHtml(q) {
  var rows = searchCities(q);
  if (!rows.length) return '<div class="cvempty">No city by that name yet.</div>';
  var lastGroup = null;
  return rows.map(function (p) {
    var head = p.province !== lastGroup
      ? '<div class="cvgroup">' + esc(p.province) + '</div>'
      : '';
    lastGroup = p.province;
    var on = cvCity === p.city && cvProv === p.province;
    var tail = on
      ? '<span class="cvchk" aria-hidden="true">✓</span>'
      : '<span class="cvtag' + (p.launch ? '' : ' soon') + '">' + (p.launch ? 'Launch' : 'Soon') + '</span>';
    return head
      + '<button type="button" class="cvitem" role="option" aria-selected="' + (on ? 'true' : 'false') + '"'
      + ' data-action="coverage:city" data-key="' + esc(cityKey(p.city, p.province)) + '">'
      + esc(p.city) + ' <span class="cvsub">· ' + esc(p.province) + '</span>' + tail + '</button>';
  }).join('');
}

/* ---- the region list ----
 *
 * A region inside a city we have not opened renders and does not pick, which
 * is what the lede promises. The row says which city is holding it rather than
 * going grey with no reason: "queued" beside a name a partner just searched
 * for is a dead end they cannot act on. */

function regionListHtml(q) {
  var p = cvPlace();
  if (!p) return '<div class="cvempty">Choose a city first.</div>';
  var k = String(q || '').trim().toLowerCase();
  var taken = declaredSlugs();
  var whole = isWholeCity(p);
  var rows = p.regions.filter(function (r) {
    return !k || r.toLowerCase().indexOf(k) > -1;
  });
  if (!rows.length) return '<div class="cvempty">No region by that name in ' + esc(p.city) + '.</div>';

  return rows.map(function (r) {
    var why = !p.launch ? 'Soon' : (taken[regionSlug(r)] ? 'Declared' : '');
    if (why) {
      return '<div class="cvitem is-disabled" role="option" aria-disabled="true" aria-selected="false">'
        + esc(r) + '<span class="cvtag' + (why === 'Soon' ? ' soon' : '') + '">' + why + '</span></div>';
    }
    return '<button type="button" class="cvitem" role="option" aria-selected="' + (cvRegion === r ? 'true' : 'false') + '"'
      + ' data-action="coverage:region" data-region="' + esc(r) + '">'
      + esc(r) + (whole ? ' <span class="cvsub">· whole city</span>' : '')
      + (cvRegion === r ? '<span class="cvchk" aria-hidden="true">✓</span>' : '') + '</button>';
  }).join('');
}

/* ---- the two combos ---- */

function cityLabel() { return cvCity ? cvCity + ', ' + cvProv : 'Search a city'; }

function regionLabel() {
  if (!cvCity) return 'Choose a city first';
  if (isWholeCity(cvPlace())) return 'Whole city (' + cvCity + ')';
  return cvRegion || 'Choose a region';
}

/**
 * @param {string} id        'city' or 'region'
 * @param {string} label     what the trigger reads
 * @param {boolean} filled   false renders it as a placeholder
 * @param {boolean} enabled
 * @param {string} placeholder  the search field's own prompt
 * @param {string} list      trusted HTML
 */
function combo(id, label, filled, enabled, placeholder, list) {
  var open = cvOpen === id;
  return '<div class="cvcombo' + (open ? ' open' : '') + (enabled ? '' : ' off') + '" data-combo="' + id + '">'
    + '<button type="button" class="cvbtn" data-action="coverage:combo" data-combo="' + id + '"'
    + (enabled ? '' : ' disabled') + ' aria-expanded="' + (open ? 'true' : 'false') + '" aria-haspopup="listbox">'
    + '<span class="cvlab' + (filled ? '' : ' ph') + '">' + esc(label) + '</span>'
    + '<i class="cvcar" aria-hidden="true"></i></button>'
    + '<div class="cvpanel"' + (open ? '' : ' hidden') + '>'
    + '<input type="text" class="cvsearch" id="cv-' + id + '-q" autocomplete="off" spellcheck="false"'
    + ' placeholder="' + esc(placeholder) + '" aria-label="' + esc(placeholder) + '"'
    + ' data-action="coverage:filter" data-combo="' + id + '">'
    + '<div class="cvlist" id="cv-' + id + '-list" role="listbox">' + list + '</div>'
    + '</div></div>';
}

/** Repaint one list alone, so the search field keeps focus and caret. */
function paintList(id, q) {
  var el = document.getElementById('cv-' + id + '-list');
  if (!el) return;
  el.innerHTML = id === 'city' ? cityListHtml(q) : regionListHtml(q);
}

function closeCombos() {
  if (!cvOpen) return;
  cvOpen = null;
  Array.prototype.slice.call(document.querySelectorAll('.cvcombo')).forEach(function (c) {
    c.classList.remove('open');
    var b = c.querySelector('.cvbtn'), p = c.querySelector('.cvpanel');
    if (b) b.setAttribute('aria-expanded', 'false');
    if (p) p.setAttribute('hidden', '');
  });
}

/* ------------------------------------------------------------------ *
 * the two multi-selects
 *
 * Technologies and speed tiers are the same kind of answer: several true at
 * once. They used to be two rows of always-visible chips, which was honest but
 * ten controls wide, and the edit row could not hold them alongside the two
 * region fields without the table scrolling sideways. They are now one dropdown each.
 *
 * NOT a native <select multiple>: that hides every unselected option behind a
 * scroll, needs a modifier key nobody discovers, and closes on the first pick,
 * which is exactly how the original "top speed" control ended up reading as a
 * one-of-three. These panels stay open across picks, mark what is on with a
 * check, and the trigger reads back the whole selection.
 *
 * UNDERNEATH, NOTHING CHANGED. The options are still buttons carrying data-t /
 * data-s and toggling class `on` inside a `.cechips` group, so the chip
 * handler, `chosenSpeeds`, and both save paths read the DOM exactly as before.
 * `data-sp` still marks the speed group so the one chip handler can tell the
 * two apart.
 * ------------------------------------------------------------------ */

/** What the trigger says for a set of labels: none, some, or the lot. */
function summary(labels, total, empty, all) {
  if (!labels.length) return empty;
  if (labels.length === total) return all;
  return labels.join(', ');
}

/**
 * One dropdown. `head` is optional panel chrome (the speed group's select-all).
 * The trigger carries its own empty/all wording in data attributes so the sync
 * after a toggle can rebuild the text without knowing which group it is in.
 */
function dropdown(id, group, text, empty, all, head) {
  return '<div class="msel">'
    + '<button type="button" class="mseltrig" data-action="coverage:mopen"'
    + ' data-for="' + id + '" data-empty="' + esc(empty) + '" data-all="' + esc(all) + '"'
    + ' aria-expanded="false" aria-haspopup="listbox">'
    + '<span class="mseltxt' + (text === empty ? ' ph' : '') + '">' + esc(text) + '</span>'
    + '<i class="mselcar" aria-hidden="true"></i></button>'
    + '<div class="mselpanel" id="' + id + '-p" role="listbox" aria-multiselectable="true" hidden>'
    + (head || '') + group + '</div></div>';
}

function techSelect(id, chosen, ce) {
  var labels = TECHS.filter(function (t) { return chosen.indexOf(t[0]) > -1; })
    .map(function (t) { return t[1]; });
  var group = '<div class="cechips" id="' + id + '"' + (ce ? ' data-ce="' + esc(ce) + '"' : '') + '>'
    + TECHS.map(function (t) {
      return '<button type="button" data-action="coverage:chip" data-t="' + t[0] + '" class="'
        + (chosen.indexOf(t[0]) > -1 ? 'on' : '') + '">' + t[1] + '</button>';
    }).join('')
    + '</div>';
  return dropdown(id, group, summary(labels, TECHS.length, 'Services offered', 'All services'),
    'Services offered', 'All services', null);
}

function speedSelect(id, value) {
  var on = speedList(value);
  var all = on.length === SPEEDS.length;
  var group = '<div class="cechips" id="' + id + '" data-sp="1">'
    + SPEEDS.map(function (s) {
      return '<button type="button" data-action="coverage:chip" data-s="' + s[0] + '" class="'
        + (on.indexOf(s[0]) > -1 ? 'on' : '') + '">' + s[1] + '</button>';
    }).join('')
    + '</div>';
  /* Select all lives inside the panel now rather than beside a label, because
     the label is no longer always on screen. Declaring the whole ladder is the
     commonest answer there is, so it stays one click. */
  var head = '<div class="mselhead"><span>Speed tiers offered</span>'
    + '<button type="button" class="tlink" data-action="coverage:allspeeds" data-sp-all="' + id + '">'
    + (all ? 'Clear all' : 'Select all') + '</button></div>';
  return dropdown(id, group, speedText(value) || 'Speed tiers',
    'Speed tiers', 'Every tier', head);
}

/** Close every open dropdown. */
function closeMsel(except) {
  Array.prototype.slice.call(document.querySelectorAll('.mseltrig[aria-expanded="true"]'))
    .forEach(function (t) {
      if (t === except) return;
      t.setAttribute('aria-expanded', 'false');
      var p = document.getElementById(t.getAttribute('data-for') + '-p');
      if (p) p.setAttribute('hidden', '');
    });
}

/**
 * Read the group back into its trigger.
 *
 * The panel is where the answer is made and the trigger is the only part of it
 * still on screen once it closes, so a toggle that does not reach the trigger
 * is a selection the partner cannot see.
 */
function syncTrig(wrap) {
  if (!wrap || !wrap.id) return;
  var trig = document.querySelector('.mseltrig[data-for="' + wrap.id + '"]');
  if (!trig) return;
  var opts = Array.prototype.slice.call(wrap.querySelectorAll('button[data-t],button[data-s]'));
  var labels = opts.filter(function (b) { return b.className.indexOf('on') > -1; })
    .map(function (b) { return b.textContent; });
  var txt = summary(labels, opts.length, trig.getAttribute('data-empty'), trig.getAttribute('data-all'));
  var span = trig.querySelector('.mseltxt');
  if (!span) return;
  span.textContent = txt;
  span.classList.toggle('ph', !labels.length);
}

/** The Mbps currently toggled on inside one chip group. */
function chosenSpeeds(id) {
  var wrap = document.getElementById(id);
  if (!wrap) return [];
  return Array.prototype.slice.call(wrap.querySelectorAll('button.on'))
    .map(function (b) { return parseInt(b.getAttribute('data-s'), 10); })
    .filter(function (n) { return isFinite(n); })
    .sort(function (a, b) { return a - b; });
}

/* The picker body: two combos, the resolved line, then what is rendered there.
   Technology stays as visible chips rather than a dropdown: there are four,
   they fit, and the commonest edit is toggling one. Speeds keep the dropdown,
   because there are six and the trigger reads the whole set back. */
function picker() {
  var p = cvPlace();
  var dup = cvDuplicate();
  /* A whole-city entry resolves the region the moment the city is picked, so
     "a region is chosen" is not the same question as "this can be declared".
     Oshawa picks itself and is still closed. The button has to ask both, or it
     goes live on a city we have not opened and the only thing standing between
     the partner and a pointless write is a toast. */
  var open = !!(cvRegion && isLaunchRegion(cvRegion));
  var ready = !!(cvCity && cvRegion && open && !dup);

  return '<div class="cvgrid">'
    + '<div class="cvfield"><label class="celab">City and province</label>'
    + combo('city', cityLabel(), !!cvCity, true, 'Type a city or province', cityListHtml('')) + '</div>'
    + '<div class="cvfield"><label class="celab">Region <em>the bid unit</em></label>'
    + combo('region', regionLabel(), !!cvRegion, !!p, 'Type a region', regionListHtml('')) + '</div>'
    + '</div>'

    + '<div class="cvresolved"><span>Your selection will read as</span> <b>'
    + esc(ready ? readsAs(cvRegion) : 'Region, City, Province') + '</b></div>'

    + '<div class="cvrow2">'
    + '<div class="cvfield"><label class="celab">Technology you render there</label>'
    + '<div class="cechips cvchips" id="addtech">'
    + TECHS.map(function (t) {
      return '<button type="button" data-action="coverage:chip" data-t="' + t[0] + '">'
        + t[1] + '</button>';
    }).join('')
    + '</div></div>'
    + '<div class="cvfield"><label class="celab">Speeds you offer there <em>pick all that apply</em></label>'
    + speedSelect('addspeed', '') + '</div>'
    + '<button class="btn forest" type="button" data-action="coverage:add"'
    + (ready ? '' : ' disabled') + '>'
    + (dup ? 'Already declared' : (cvRegion && !open ? 'Not open yet' : 'Declare region')) + '</button>'
    + '</div>'

    + '<small class="cvsmall">Regions inside a launch city start their serviceability check the moment '
    + 'you declare them, against facilities data. You do not have to wait for one to clear before '
    + 'declaring the next.</small>';
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
  /* Select all / Clear all. Toggling six chips one at a time to say "I serve
     everything here" is the commonest declaration there is. */
  on('click', 'coverage:allspeeds', function (el) {
    var id = el.getAttribute('data-sp-all');
    var wrap = document.getElementById(id);
    if (!wrap) return;
    var btns = Array.prototype.slice.call(wrap.querySelectorAll('button[data-s]'));
    var turnOn = btns.some(function (b) { return b.className.indexOf('on') < 0; });
    btns.forEach(function (b) { b.classList.toggle('on', turnOn); });
    el.textContent = turnOn ? 'Clear all' : 'Select all';
    syncTrig(wrap);
  });

  /* Open one dropdown, and only one: two panels overlapping in the same table
     row is how a partner ends up toggling a speed they cannot see. */
  on('click', 'coverage:mopen', function (el) {
    var panel = document.getElementById(el.getAttribute('data-for') + '-p');
    if (!panel) return;
    var open = el.getAttribute('aria-expanded') === 'true';
    closeMsel(el);
    el.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (open) panel.setAttribute('hidden', ''); else panel.removeAttribute('hidden');
  });

  /* Escape closes from wherever focus is inside the control. Both actions get
     it, because focus sits on the trigger before the first pick and on an
     option after it. */
  on('keydown', 'coverage:mopen', function (el, e) { if (e.key === 'Escape') closeMsel(null); });
  on('keydown', 'coverage:chip', function (el, e) {
    if (e.key !== 'Escape') return;
    var trig = document.querySelector('.mseltrig[aria-expanded="true"]');
    closeMsel(null);
    if (trig) trig.focus();
  });

  on('click', 'coverage:chip', function (el) {
    el.classList.toggle('on');
    var wrap = el.closest('.cechips');
    /* The panel stays open. Picking a second tier is the normal case, not the
       exception, so a click that closed the list would cost a reopen every
       time. Attention leaving the control is what closes it. */
    syncTrig(wrap);
    /* A speed chip carries no draft: its group is read from the DOM at save
       time, and it lives in the same row as its Save button, so a background
       refresh cannot land between the toggle and the write. */
    if (wrap && wrap.getAttribute('data-sp')) {
      var link = document.querySelector('[data-sp-all="' + wrap.id + '"]');
      if (link) {
        var total = wrap.querySelectorAll('button[data-s]').length;
        link.textContent = wrap.querySelectorAll('button.on').length === total ? 'Clear all' : 'Select all';
      }
      return;
    }
    if (wrap && wrap.getAttribute('data-ce')) {
      set('covDraft', Array.prototype.slice.call(wrap.querySelectorAll('button.on'))
        .map(function (b) { return b.getAttribute('data-t'); }));
    }
  });

  /* Attention moved elsewhere: close, rather than leaving a listbox floating
     over the chips a partner is now clicking. This runs before the data-action
     lookup, so a click on a trigger or an option is excluded by containment
     rather than by ordering. Both control families close the same way. */
  onAnyClick(function (e) {
    if (!e.target.closest) return;
    if (!e.target.closest('.msel')) closeMsel(null);
    if (cvOpen && !e.target.closest('.cvcombo')) closeCombos();
  });

  on('click', 'coverage:save', function (el) {
    var slug = el.getAttribute('data-region');
    var c = find(slug);
    if (!c) return;
    var techs = get().covDraft || (c.techs || []);
    if (!techs.length) { toast('Pick at least one technology you serve there.'); return; }

    var speeds = chosenSpeeds('ce-speed');
    if (!speeds.length) { toast('Pick at least one speed tier you can render there.'); return; }

    var W = window.WHOLLAR;
    if (!W.busy(el, true, 'Saving')) return;
    var leadEl = document.getElementById('ce-lead');

    api.coverageUpdate({
      region: c.region,
      techs: techs,
      speed: speedWire(speeds),
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

  /* ---- the city and region picker ---- */

  /* Open one panel, and only one. Two listboxes overlapping is how a partner
     picks a region belonging to a city they cannot see. */
  on('click', 'coverage:combo', function (el) {
    var which = el.getAttribute('data-combo');
    if (which === 'region' && !cvPlace()) return;
    var wasOpen = cvOpen === which;
    closeCombos();
    if (wasOpen) return;
    cvOpen = which;
    var wrap = document.querySelector('.cvcombo[data-combo="' + which + '"]');
    if (!wrap) return;
    wrap.classList.add('open');
    el.setAttribute('aria-expanded', 'true');
    var panel = wrap.querySelector('.cvpanel');
    if (panel) panel.removeAttribute('hidden');
    var q = document.getElementById('cv-' + which + '-q');
    if (q) { q.value = ''; paintList(which, ''); q.focus(); }
  });

  /* Typing repaints one list, never the view: a set() here would rebuild the
     card and take the caret with it. */
  on('input', 'coverage:filter', function (el) {
    paintList(el.getAttribute('data-combo'), el.value);
  });

  on('keydown', 'coverage:filter', function (el, e) {
    if (e.key !== 'Escape') return;
    var which = el.getAttribute('data-combo');
    closeCombos();
    var trig = document.querySelector('.cvbtn[data-combo="' + which + '"]');
    if (trig) trig.focus();
  });

  /* Choosing a city clears the region under it. Keeping the old one would let
     a partner declare "Kitsilano, Toronto, Ontario", which is not a place. A
     whole-city entry resolves to itself, so one pick is the whole answer. */
  on('click', 'coverage:city', function (el) {
    var parts = String(el.getAttribute('data-key') || '').split('|');
    var p = findCity(parts[0], parts[1]);
    if (!p) return;
    cvCity = p.city;
    cvProv = p.province;
    cvRegion = isWholeCity(p) ? p.city : null;
    closeCombos();
    render();
  });

  on('click', 'coverage:region', function (el) {
    cvRegion = el.getAttribute('data-region');
    closeCombos();
    render();
  });

  on('click', 'coverage:add', function (el) {
    /* The vocabulary is the whole point. Both halves have to resolve back to
       a real place, and a region in a city we have not opened is refused here
       as well as greyed in the list: the server would write it 'verifying'
       and an operator would have to reject it by hand. */
    if (!cvCity || !cvRegion) { toast('Pick a city, then a region inside it.'); return; }
    var region = cvRegion;
    if (!isLaunchRegion(region)) {
      toast(cvCity + ' has not opened yet. Pick a city tagged Launch.');
      return;
    }
    if (declaredSlugs()[regionSlug(region)]) { toast('You have already declared ' + region + '.'); return; }

    var techs = Array.prototype.slice.call(document.querySelectorAll('#addtech button.on'))
      .map(function (b) { return b.getAttribute('data-t'); });
    if (!techs.length) { toast('Pick at least one technology you serve there.'); return; }

    var speeds = chosenSpeeds('addspeed');
    if (!speeds.length) { toast('Pick at least one speed tier you can render there.'); return; }

    var W = window.WHOLLAR;
    if (!W.busy(el, true, 'Declaring')) return;

    /* Region alone on the wire. core/places.js says why: the server matches a
       bid on the region slug, so a composite would refuse every bid. */
    api.coverageDeclare({ region: region, techs: techs, speed: speedWire(speeds) })
      .then(function (r) {
        W.busy(el, false);
        /* The city stays, the region clears. Declaring a second region in the
           same city is the commonest next act, and re-picking Toronto to do it
           is a step nobody needs. */
        var p = cvPlace();
        cvRegion = p && isWholeCity(p) ? p.city : null;
        cvOpen = null;
        set({ coverage: (r && r.coverage) || get().coverage, covEdit: null, covDraft: null });
        toast(readsAs(region) + ' declared. Verifying serviceability against facilities data.');
      }, function (err) {
        W.busy(el, false);
        failed(err);
        authFailed(err);
      });
  });
}
