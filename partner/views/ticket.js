/* The bid ticket: set terms, seal, improve. The one write surface of the desk.
 *
 * Ported from the prototype's LIVE spans only (docs/console/render-inventory.md
 * table A): ticketHTML 2578-2619 (the v10 declaration, seven-column tier table,
 * five-option reduction select), tierRowHTML 2566-2576, readTicket 2621-2660,
 * scnCalc 2258-2269, bidLine 2060-2066. The four dead earlier declarations are
 * not here and must not come back.
 *
 * DEVIATIONS FROM THE PROTOTYPE, all deliberate:
 *   1. Improve does NOT delete the bid and reopen the form. It renders the
 *      form prefilled from the sealed head and posts to the improve route,
 *      which seals a new version; nothing anywhere removes a bid. The
 *      prototype's delete-and-reopen was convenience and did not ship.
 *   2. The terms-gate button branch sends a partner to Contracts rather than
 *      disabling: there is somewhere to go, and a dead button teaches nothing.
 *      It renders only when the registry has answered and says the terms are
 *      unaccepted, never while that is still unknown (core/state.js
 *      termsState explains why the third state exists). The server refuses the
 *      bid either way, so this branch is a courtesy, not the gate.
 *   3. The fee in the scenario table is brief.successFee from config, never a
 *      constant.
 *   4. In-progress form state lives in state.ticketDraft, so a repaint cannot
 *      eat a half-typed bid.
 *   5. The close boundary belongs to the server. At zero the button disables
 *      and says so, but the server's 409, with its own clock in the body, is
 *      the authority and its message renders verbatim.
 */

import { get, set, termsState } from '../core/state.js';
import { api } from '../core/api.js';
import { esc, money } from '../core/format.js';
import { fmtDate, until } from '../core/time.js';
import { on } from '../core/actions.js';
import { toast, failed } from '../core/toast.js';
import { TIER_NAMES, TECH, TECH_LABEL, REDUCTION_LABEL } from '../core/contract.js';

/* Suggested prices per tier, from the prototype (SUGG / SUGGUP / SUGGSTICKER,
   lines 2142-2143 and 2563). Suggestions only: everything is editable and the
   server validates whatever arrives. */
var SUGG = { '100 Mbps': 44, '300 Mbps': 49, '500 Mbps': 56, '1 Gig': 64, '1.5 Gig': 74, '2.5 Gig': 84 };
var SUGGUP = { '100 Mbps': '20', '300 Mbps': '30', '500 Mbps': '50', '1 Gig': '100', '1.5 Gig': '150', '2.5 Gig': '250' };
var SUGGSTICKER = { '100 Mbps': 65, '300 Mbps': 75, '500 Mbps': 86, '1 Gig': 99, '1.5 Gig': 115, '2.5 Gig': 135 };

/* ------------------------------------------------------------------ *
 * small builders
 * ------------------------------------------------------------------ */

/** "$56 · 500 Mbps · $64 · 1 Gig" from a bid's tiers. */
export function bidLine(m) {
  if (m && m.tiers && m.tiers.length) {
    return m.tiers.map(function (t) { return money(t.effectivePrice) + ' · ' + t.name; }).join(' · ');
  }
  return '';
}

function stickerLine(m) {
  if (!m || !m.tiers || !m.tiers.length) return '';
  return m.tiers.map(function (t) { return money(t.stickerPrice) + ' / ' + t.name; }).join(' · ');
}

function equipLine(m) {
  var base = m.equipment === 'inc' ? 'included'
    : (m.equipment === 'byod' ? 'BYOD, no charge'
      : ('rental ' + money(m.rentalMonthly || '0') + '/mo, stated'));
  return base + (m.extraPodMonthly ? ' · extra pod ' + money(m.extraPodMonthly) + '/mo' : ' · pods included');
}

function mechLabel(m) {
  if (m.reductionPresentation === 'custom') return m.mechanismLabel || 'a custom reduction';
  return REDUCTION_LABEL[m.reductionPresentation] || REDUCTION_LABEL.member;
}

function tierRowHTML(t, i) {
  var opts = TIER_NAMES.map(function (n) {
    return '<option' + (n === t.name ? ' selected' : '') + '>' + n + '</option>';
  }).join('');
  var topts = TECH.map(function (c) {
    return '<option value="' + c + '"' + (c === (t.technology || 'cable') ? ' selected' : '') + '>' + TECH_LABEL[c] + '</option>';
  }).join('');
  return '<tr class="trow" data-i="' + i + '">'
    + '<td><select class="tname" data-action="ticket:field">' + opts + '</select></td>'
    + '<td><input type="text" class="tup" data-action="ticket:field" value="' + esc(t.uploadMbps || '') + '"></td>'
    + '<td><select class="ttech" data-action="ticket:field">' + topts + '</select></td>'
    + '<td><input type="number" class="tsticker" data-action="ticket:field" value="' + esc(t.stickerPrice || '') + '" min="1" step="0.5"></td>'
    + '<td><input type="number" class="teff" data-action="ticket:field" value="' + esc(t.effectivePrice || '') + '" min="1" step="0.5"></td>'
    + '<td class="tac"><input type="number" class="tafter" data-action="ticket:field" value="' + esc(t.afterPrice || '') + '" min="1" step="0.5"></td>'
    + '<td>' + (i > 0 ? '<button type="button" class="trm" data-action="ticket:rm" data-i="' + i + '" aria-label="Remove tier">×</button>' : '') + '</td></tr>';
}

/** The default draft for a cohort: one 500 Mbps row at the suggested prices. */
function defaultDraft(a) {
  return {
    campaignId: a.id,
    improve: false,
    consent: false,
    error: null,
    tiers: [{ name: '500 Mbps', uploadMbps: '50', technology: 'cable', stickerPrice: '86', effectivePrice: '56', afterPrice: '69' }],
    reductionPresentation: 'member',
    mechanismLabel: '',
    guaranteeMonths: 24,
    afterMode: 'none',
    equipment: 'inc',
    rentalMonthly: '7',
    extraPodMonthly: '0',
    committedHouseholds: a.households || 1
  };
}

/** A draft prefilled from the sealed head, for the improve form. */
function draftFromBid(a, m) {
  return {
    campaignId: a.id,
    improve: true,
    consent: false,
    error: null,
    tiers: (m.tiers || []).map(function (t) {
      return {
        name: t.name, uploadMbps: t.uploadMbps || '', technology: (t.technology || 'cable').toLowerCase(),
        stickerPrice: String(t.stickerPrice || ''), effectivePrice: String(t.effectivePrice || ''),
        afterPrice: t.afterPrice ? String(t.afterPrice) : ''
      };
    }),
    reductionPresentation: m.reductionPresentation || 'member',
    mechanismLabel: m.mechanismLabel || '',
    guaranteeMonths: m.guaranteeMonths || 24,
    afterMode: m.afterMode || 'none',
    equipment: m.equipment || 'inc',
    rentalMonthly: m.rentalMonthly || '7',
    extraPodMonthly: m.extraPodMonthly || '0',
    committedHouseholds: m.committedHouseholds || a.households || 1
  };
}

/* ------------------------------------------------------------------ *
 * the panel
 * ------------------------------------------------------------------ */

/**
 * The ticket panel for one cohort. Four states, in the prototype's order:
 * result (decided with a bid), closed (offers out), the sealed receipt, and
 * the form.
 */
export function ticketHTML(a, data, mine) {
  var S = get();
  var d = a.dates || {};
  var draft = S.ticketDraft && S.ticketDraft.campaignId === a.id ? S.ticketDraft : null;

  /* Result states. */
  if (a.stage === 'decided' && mine) {
    if (mine.state === 'not_selected') {
      return '<div class="tkt"><div class="dh">Result</div><div class="receipt">'
        + '<b>Not selected.</b> The cohort went to another sealed bid on the same standard terms. '
        + 'Your bid stays on your record, your standing is untouched, and cohorts in your coverage keep opening.</div>'
        + '<button class="btn ghost" type="button" data-action="nav" data-view="desk" style="margin-top:12px">See what’s coming</button></div>';
    }
    var fee = data && data.brief && data.brief.successFee;
    var conf = a.confirmed;
    var wonLine = conf
      ? conf + ' households confirmed you. That’s ' + conf + ' installs to plan'
        + (fee ? ' and, at your fee, up to ' + money(String(conf * Number(fee))) + ' in success fees, billed per completed switch only' : '')
        + '.'
      : 'Household confirmations route to your delivery board.';
    return '<div class="tkt"><div class="dh">Result</div><div class="receipt">'
      + '<b>Won.</b> ' + wonLine
      + ' Complete billing setup and confirm capacity, and the roster releases to you.</div>'
      + '<button class="btn" type="button" data-action="nav" data-view="delivery" style="margin-top:12px">Open the delivery board</button></div>';
  }

  /* Bids closed, offers with households. */
  if (a.stage === 'offers_out') {
    return '<div class="tkt"><div class="dh">Bids closed</div><div class="receipt">'
      + (mine ? '<b>Your bid is in:</b> ' + bidLine(mine) + (mine.reference ? ' · Receipt ' + esc(mine.reference) : '') + '. ' : '')
      + 'Offers are out to every household, individually. '
      + (a.confirmed != null ? 'Confirmed so far: <b>' + a.confirmed + ' of ' + esc(String(a.households)) + '</b>. ' : '')
      + (d.decision_at ? 'Decisions lock ' + fmtDate(d.decision_at) + '; there' : 'There')
      + ' is nothing for you to do, and no way to see other bids.</div></div>';
  }

  /* The sealed receipt, unless the improve form is open. */
  if (mine && !(draft && draft.improve)) {
    return '<div class="tkt"><div class="dh">Your sealed bid</div>'
      + '<div class="receipt"><b>Sealed · ' + bidLine(mine) + ' effective</b><br>'
      + (stickerLine(mine) ? 'Sticker ' + esc(stickerLine(mine)) + ' · reduction reads as ' + esc(mechLabel(mine)) + '.<br>' : '')
      + (mine.reference ? 'Receipt ' + esc(mine.reference) + ' · version ' + esc(String(mine.version || 1)) + ' · ' : '')
      + (mine.guaranteeMonths ? 'guaranteed ' + mine.guaranteeMonths + ' months · ' : '')
      + 'after: ' + esc(mine.afterLine || 'no scheduled change')
      + ' · equipment: ' + esc(equipLine(mine))
      + (mine.committedHouseholds ? ' · committed to ' + mine.committedHouseholds + ' households' : '') + '.'
      + (d.bidding_closes_at ? '<br>Improvable until close on ' + fmtDate(d.bidding_closes_at) + '. No withdrawals.' : '<br>No withdrawals.')
      + '</div>'
      + '<button class="btn ghost" type="button" data-action="ticket:improve" data-id="' + esc(a.id) + '" style="margin-top:12px">Improve bid</button></div>';
  }

  /* The form: place, or improve when a draft says so. */
  return formHTML(a, data, draft || defaultDraft(a), Boolean(mine));
}

function formHTML(a, data, t, improving) {
  var S = get();
  var d = a.dates || {};
  var closed = d.bidding_closes_at ? until(d.bidding_closes_at) === 0 : false;

  var rows = t.tiers.map(tierRowHTML).join('');

  var mechOpts = [
    ['member', 'A Whollar member discount'],
    ['promo', 'A promotional credit, expiry stated'],
    ['cash', 'Monthly cashback'],
    ['none', 'Effective price only, no breakdown'],
    ['custom', 'Custom, your wording']
  ].map(function (o) {
    return '<option value="' + o[0] + '"' + (t.reductionPresentation === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
  }).join('');

  var button;
  if (!S.approved) {
    button = '<button class="btn" type="button" disabled>Bidding unlocks at approval</button>';
  } else if (S.biddingPaused) {
    button = '<button class="btn" type="button" disabled>Bidding paused</button>';
  } else if (termsState() === 'pending') {
    /* Not disabled: there is somewhere to go, and a dead button teaches
       nothing. Only on 'pending', never on 'unknown': see core/state.js for
       why the third state exists. The server refuses the bid regardless. */
    button = '<button class="btn ghost" type="button" data-action="nav" data-view="contracts">'
      + 'Accept the standard terms to bid</button>';
  } else if (closed) {
    button = '<button class="btn" type="button" disabled>Bidding closed</button>';
  } else {
    button = '<button class="btn" type="button" data-action="ticket:place" data-id="' + esc(a.id) + '"'
      + (t.consent ? '' : ' disabled') + '>'
      + (improving ? 'Seal the improvement' : 'Place sealed bid') + '</button>';
  }

  return '<div class="tkt"><div class="steps"><span class="on">1 · Set terms</span><i></i><span>2 · Seal</span></div>'
    + '<div class="bidform' + (t.afterMode === 'new' ? ' aftnew' : '') + '" data-bid="' + esc(a.id) + '">'
    + (improving
      ? '<div class="receipt" style="margin-bottom:12px"><b>Improving version ' + esc(String((S.bids[a.id] || {}).version || 1)) + '.</b> '
        + 'Every tier must stay at least as good: no raised effective price, no shortened guarantee, no worsened after-rate, no reduced commitment. '
        + '<button class="tlink" type="button" data-action="ticket:cancel">Keep the sealed version</button></div>'
      : '')
    + '<label class="blk">Price by service <small class="lsub">sticker is your rate card; effective is what the cohort pays</small></label>'
    + '<table class="tiert t7"><thead><tr><th>Tier</th><th>Upload, Mbps</th><th>Technology</th><th>Sticker /mo</th><th>Effective /mo</th><th class="tac">After</th><th></th></tr></thead><tbody class="tierbody">'
    + rows
    + '</tbody></table>'
    + '<button type="button" class="taddrow" data-action="ticket:add">+ Add another service</button>'
    + '<div class="two"><div><label>How the reduction reads to households</label><select class="bmech" data-action="ticket:field">' + mechOpts + '</select>'
    + '<div class="mechtxtw"' + (t.reductionPresentation === 'custom' ? '' : ' hidden') + ' style="margin-top:8px"><input type="text" class="bmechtxt" data-action="ticket:field" placeholder="e.g. Neighbourhood build rate" maxlength="40" value="' + esc(t.mechanismLabel || '') + '"></div></div>'
    + '<div class="mechnote"><small class="hint">Your rate card stays intact either way. Households always see the effective price and the after-rate; this only sets whether the math between sticker and effective is shown, and under what name.</small></div></div>'
    + '<div class="two"><div><label>Price guaranteed for</label><select class="bguar" data-action="ticket:field">'
    + [24, 12, 36].map(function (g) { return '<option value="' + g + '"' + (t.guaranteeMonths === g ? ' selected' : '') + '>' + g + ' months</option>'; }).join('')
    + '</select></div>'
    + '<div><label>After the guarantee</label><select class="bafter" data-action="ticket:field">'
    + '<option value="none"' + (t.afterMode === 'none' ? ' selected' : '') + '>No scheduled change</option>'
    + '<option value="new"' + (t.afterMode === 'new' ? ' selected' : '') + '>New price, stated per tier</option>'
    + '</select></div></div>'
    + '<label class="blk" style="margin-top:14px">Equipment <small class="lsub">every dollar of it on the face of the bid</small></label>'
    + '<div class="eqgrid"><div><label>Modem and in-home WiFi</label><select class="bequip" data-action="ticket:field">'
    + '<option value="inc"' + (t.equipment === 'inc' ? ' selected' : '') + '>Included in the price</option>'
    + '<option value="rent"' + (t.equipment === 'rent' ? ' selected' : '') + '>Monthly rental, stated now</option>'
    + '<option value="byod"' + (t.equipment === 'byod' ? ' selected' : '') + '>BYOD allowed, no charge</option>'
    + '</select></div>'
    + '<div class="rentw"' + (t.equipment === 'rent' ? '' : ' hidden') + '><label>Rental ($ /mo)</label><input type="number" class="brent" data-action="ticket:field" value="' + esc(t.rentalMonthly || '7') + '" min="0" step="0.5"></div>'
    + '<div class="podcell"><label>Extra pod, $ /mo</label><input type="number" class="bpods" data-action="ticket:field" value="' + esc(t.extraPodMonthly || '0') + '" min="0" step="0.5"><small class="hint">0 means included</small></div></div>'
    + '<div class="two" style="margin-top:14px"><div><label>Service commitment</label><input type="number" class="bcommit" data-action="ticket:field" value="' + esc(String(t.committedHouseholds || '')) + '" min="1" max="' + esc(String(a.households || 9999)) + '" step="1"><small class="hint">households you can serve at these prices</small></div><div></div></div>'
    + '<label class="consent"><input type="checkbox" class="bconsent" data-action="ticket:field"' + (t.consent ? ' checked' : '') + '><span>I understand this bid is sealed and binding until the offer deadline, on the standard cohort terms, for up to my committed household count, with the effective prices above shown to households exactly as entered. I can improve it before close; I cannot withdraw it.</span></label>'
    + (t.error ? '<p class="fnote" style="color:#8C3B1B">' + esc(t.error) + '</p>' : '')
    + button
    + '</div></div>';
}

/* ------------------------------------------------------------------ *
 * reading the form
 * ------------------------------------------------------------------ */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

/**
 * DOM to draft. The DOM is the source of truth at submit time; the store's
 * copy exists so repaints between edits restore what was typed.
 */
function readTicket(form, a) {
  var bad = null;
  var tiers = $$('.trow', form).map(function (tr) {
    var stk = $('.tsticker', tr).value;
    var eff = $('.teff', tr).value;
    if (Number(eff) > Number(stk) && Number(stk) > 0) {
      bad = 'Effective price cannot sit above sticker on ' + $('.tname', tr).value + '.';
    }
    return {
      name: $('.tname', tr).value,
      uploadMbps: String($('.tup', tr).value || '').trim(),
      technology: $('.ttech', tr).value,
      stickerPrice: String(stk || '').trim(),
      effectivePrice: String(eff || '').trim(),
      afterPrice: String($('.tafter', tr).value || '').trim()
    };
  }).filter(function (t) { return Number(t.effectivePrice) > 0; });
  if (!tiers.length) bad = bad || 'Add at least one tier to the bid.';

  var mech = $('.bmech', form) ? $('.bmech', form).value : 'member';
  var commitMax = a && a.households ? a.households : Infinity;
  var commit = parseInt($('.bcommit', form).value, 10) || 0;
  if (commit > commitMax) commit = commitMax;

  return {
    campaignId: a ? a.id : null,
    tiers: tiers,
    reductionPresentation: mech,
    mechanismLabel: mech === 'custom' ? String(($('.bmechtxt', form) || {}).value || '').trim() : '',
    guaranteeMonths: parseInt($('.bguar', form).value, 10),
    afterMode: $('.bafter', form).value,
    equipment: $('.bequip', form).value,
    rentalMonthly: String($('.brent', form) ? $('.brent', form).value : '').trim(),
    extraPodMonthly: String($('.bpods', form) ? $('.bpods', form).value : '').trim(),
    committedHouseholds: commit,
    consent: Boolean($('.bconsent', form) && $('.bconsent', form).checked),
    bad: bad
  };
}

/* ------------------------------------------------------------------ *
 * the scenario table (in the brief, fed by the form)
 * ------------------------------------------------------------------ */

/**
 * Recompute "What this bid could return" from the open form. Ported from
 * scnCalc (2258-2269) and readTicket's blend (2640-2652): tier prices blended
 * by the cohort's speed demand, capped at the commitment, fee from config.
 */
export function refreshScn() {
  var S = get();
  var form = $('.bidform');
  if (!form) return;
  var id = form.getAttribute('data-bid');
  var a = null;
  S.campaigns.forEach(function (c) { if (c.id === id) a = c; });
  var data = S.briefs[id];
  if (!a || !data || data === 'loading' || data.failed) return;
  var b = data.brief || {};
  if (!b.speedMix) return;

  var grid = form.closest('.dgrid');
  if (!grid) return;
  var sb = $('.brief .scnbody', grid);
  var chip = $('.brief .scommit', grid);

  var d = readTicket(form, a);
  if (chip) chip.textContent = d.committedHouseholds || (a.households || 0);
  if (!sb) return;

  function effOf(name) {
    for (var i = 0; i < d.tiers.length; i++) if (d.tiers[i].name === name) return Number(d.tiers[i].effectivePrice);
    return null;
  }
  function subGig() {
    var c = null;
    ['100 Mbps', '300 Mbps'].forEach(function (n) {
      var p = effOf(n);
      if (p != null && (c == null || p < c)) c = p;
    });
    return c;
  }
  var blend = 0, tot = 0;
  b.speedMix.forEach(function (sx) {
    var share = sx[1];
    tot += share;
    var p;
    if (sx[0] === '1 Gig') p = effOf('1 Gig');
    else if (sx[0] === 'Under 500') p = subGig();
    else p = effOf('500 Mbps');
    if (p == null) p = d.tiers.length ? Number(d.tiers[0].effectivePrice) : 0;
    blend += share * p;
  });
  blend = tot ? blend / tot : 0;

  var fee = Number(b.successFee || 0);
  var hh = a.households || 0;
  var commit = d.committedHouseholds || hh;
  sb.innerHTML = [0.6, 0.8, 1].map(function (f, i) {
    var conf = Math.round(hh * f);
    var served = Math.min(conf, commit);
    var mrev = Math.round(served * blend);
    return '<tr' + (i === 1 ? ' class="likely"' : '') + '><td>' + conf + ' (' + Math.round(f * 100) + '%)</td>'
      + '<td>' + served + (served < conf ? '<small class="capnote"> cap</small>' : '') + '</td>'
      + '<td>' + money(String(mrev)) + '</td>'
      + '<td>' + (fee ? money(String(served * fee)) : '·') + '</td></tr>';
  }).join('');
}

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

function campaignById(id) {
  var found = null;
  get().campaigns.forEach(function (c) { if (c.id === id) found = c; });
  return found;
}

/** The current draft for the open form, reading the DOM so edits survive. */
function draftFromForm(el) {
  var form = el.closest('.bidform') || $('.bidform');
  if (!form) return null;
  var a = campaignById(form.getAttribute('data-bid'));
  if (!a) return null;
  var S = get();
  var d = readTicket(form, a);
  d.improve = Boolean(S.ticketDraft && S.ticketDraft.campaignId === a.id && S.ticketDraft.improve);
  d.error = null;
  delete d.bad;
  return d;
}

export function mount() {
  /* Any form control changed: capture the whole form into the draft, which
     repaints the ticket from it. Selects re-render their reveals (after
     column, rental cell, custom label) this way, with no direct DOM toggles. */
  on('change', 'ticket:field', function (el) {
    var d = draftFromForm(el);
    if (d) set('ticketDraft', d);
    refreshScn();
  });

  /* Keystrokes update only the scenario table. Writing the store here would
     repaint the form under the cursor mid-word. */
  on('input', 'ticket:field', function () { refreshScn(); });

  on('click', 'ticket:add', function (el) {
    var d = draftFromForm(el);
    if (!d) return;
    var used = {};
    d.tiers.forEach(function (t) { used[t.name] = true; });
    var next = null;
    TIER_NAMES.forEach(function (n) { if (!next && !used[n]) next = n; });
    if (!next) return;
    d.tiers.push({
      name: next, uploadMbps: SUGGUP[next] || '', technology: 'cable',
      stickerPrice: String(SUGGSTICKER[next] || ''), effectivePrice: String(SUGG[next] || ''),
      afterPrice: String(Math.round(((SUGG[next] || 0) + 13) * 2) / 2)
    });
    set('ticketDraft', d);
    refreshScn();
  });

  on('click', 'ticket:rm', function (el) {
    var d = draftFromForm(el);
    if (!d) return;
    var i = parseInt(el.getAttribute('data-i'), 10);
    /* The draft was read from the CURRENT DOM, where zero-priced rows are
       filtered out; remove by matching the row's tier name instead of index
       arithmetic over a filtered list. */
    var tr = el.closest('.trow');
    var name = tr ? $('.tname', tr).value : null;
    d.tiers = d.tiers.filter(function (t, j) { return name ? t.name !== name : j !== i; });
    if (!d.tiers.length) return;
    set('ticketDraft', d);
    refreshScn();
  });

  on('click', 'ticket:improve', function (el) {
    var id = el.getAttribute('data-id');
    var a = campaignById(id);
    var mine = get().bids[id];
    if (!a || !mine) return;
    set('ticketDraft', draftFromBid(a, mine));
  });

  on('click', 'ticket:cancel', function () { set('ticketDraft', null); });

  on('click', 'ticket:place', function (el) {
    var S = get();
    var form = el.closest('.bidform');
    var id = form && form.getAttribute('data-bid');
    var a = id && campaignById(id);
    if (!form || !a) return;

    var d = readTicket(form, a);
    var improve = Boolean(S.ticketDraft && S.ticketDraft.campaignId === id && S.ticketDraft.improve);
    if (d.bad) {
      d.improve = improve;
      d.error = d.bad;
      delete d.bad;
      set('ticketDraft', d);
      return;
    }
    if (!d.consent) return;

    var body = {
      campaign: id,
      tiers: d.tiers,
      reductionPresentation: d.reductionPresentation,
      mechanismLabel: d.mechanismLabel || undefined,
      guaranteeMonths: d.guaranteeMonths,
      afterMode: d.afterMode,
      equipment: d.equipment,
      rentalMonthly: d.equipment === 'rent' ? d.rentalMonthly : undefined,
      extraPodMonthly: d.extraPodMonthly,
      committedHouseholds: d.committedHouseholds
    };

    el.disabled = true;
    (improve ? api.bidImprove(id, body) : api.bidPlace(body)).then(function (r) {
      var bids = {};
      var cur = get().bids;
      for (var k in cur) { if (Object.prototype.hasOwnProperty.call(cur, k)) bids[k] = cur[k]; }
      if (r && r.bid) bids[id] = r.bid;
      set({ bids: bids, ticketDraft: null });
      var no = r && r.receipt && r.receipt.no;
      toast(improve
        ? 'Improved to version ' + ((r && r.receipt && r.receipt.revision) || '') + '. Receipt ' + no + '.'
        : 'Bid sealed. Receipt ' + no + '.');
    }, function (err) {
      /* The server's refusal renders verbatim, in the ticket and as a toast.
         On the close boundary its body carried the server clock, which
         request() already synced, so the countdowns agree with the refusal. */
      d.improve = improve;
      d.error = (err && err.message) || 'That did not work. Try again.';
      delete d.bad;
      set('ticketDraft', d);
      failed(err);
    });
  });
}
