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
import { readSeed, writeSeed } from '../core/bidseed.js';

/* Suggested prices per tier, from the prototype (SUGG / SUGGUP / SUGGSTICKER,
   lines 2142-2143 and 2563). Suggestions only: everything is editable and the
   server validates whatever arrives. */
var SUGG = { '100 Mbps': 44, '300 Mbps': 49, '500 Mbps': 56, '1 Gig': 64, '1.5 Gig': 74, '2.5 Gig': 84 };
var SUGGUP = { '100 Mbps': '20', '300 Mbps': '30', '500 Mbps': '50', '1 Gig': '100', '1.5 Gig': '150', '2.5 Gig': '250' };
var SUGGSTICKER = { '100 Mbps': 65, '300 Mbps': 75, '500 Mbps': 86, '1 Gig': 99, '1.5 Gig': 115, '2.5 Gig': 135 };

/* ------------------------------------------------------------------ *
 * the custom mix
 * ------------------------------------------------------------------ *
 *
 * 'Custom' used to be one free-text label. It is now a schedule: a discount
 * type, a percentage off the sticker price, and the window it runs for, one row
 * per step, so a partner whose reduction changes at month 6 or month 12 can say
 * so on the face of the bid instead of averaging it into a single effective
 * price.
 *
 * THE MIX IS IN PERCENT, NOT DOLLARS. A rate card has several tiers at several
 * sticker prices, and one dollar figure off all of them is a different offer on
 * each: $22 off is 34% of a $65 tier and 16% of a $135 one. A percentage is the
 * one figure that means the same thing on every row, so the schedule carries
 * the percentage and the arithmetic turns it into dollars per tier, against
 * that tier's own sticker.
 *
 * The types are the reduction reads offered above minus 'none', which is the
 * absence of a breakdown and cannot be a line in one, plus a row the partner
 * words themselves.
 *
 * NOT YET SEALED. lib/bids.js readBid() still takes a single mechanismLabel
 * and knows nothing about a schedule, so mixLabel() derives a label the server
 * accepts and the schedule itself does not survive the seal. Persisting it
 * needs a discount_mix column on provider_bids and its validation; until then
 * this is the composer, not the record.
 */
var MIX_TYPES = ['member', 'promo', 'cash', 'own'];
/* Shorter than the reduction select above on purpose: the period column
   already states the expiry, so 'expiry stated' would be the table repeating
   the column beside it. */
var MIX_TYPE_LABEL = {
  member: 'Whollar member discount',
  promo: 'Promotional credit',
  cash: 'Monthly cashback',
  own: 'Other, your wording'
};
/* Short forms, for the label the seal carries. Kept clear of the pressure and
   condition words lib/bids.js LABEL_BANNED refuses. */
var MIX_TYPE_SHORT = {
  member: 'Member discount', promo: 'Promotional credit', cash: 'Monthly cashback', own: ''
};
/* Windows, in months from the start of service. Only those that close inside
   the guarantee are offered: a discount running past the guaranteed price is a
   promise about a price this bid does not make. */
var MIX_PERIODS = [[0, 6], [0, 12], [0, 24], [0, 36], [6, 12], [12, 24], [24, 36]];

function periodLabel(p) { return p[0] + ' to ' + p[1] + ' months'; }

/**
 * The window a row renders on, given the windows a guarantee leaves standing.
 *
 * Shortening the guarantee retires the windows that ran past it, and a select
 * with nothing selected shows its first option, which would silently move
 * every row to the shortest window in the list. So fall back to the widest
 * window that still starts where this row started.
 */
function windowFor(r, fits, guar) {
  var pick = null;
  fits.forEach(function (p) { if (Number(r.from) === p[0] && Number(r.to) === p[1]) pick = p; });
  if (!pick) fits.forEach(function (p) { if (Number(r.from) === p[0]) pick = p; });
  return pick || fits[fits.length - 1] || [0, guar];
}

/** Amount rounded to cents and rendered by the shared money(). */
function cash(n) {
  return money(String(Math.round((Number(n) || 0) * 100) / 100));
}

/** A percentage at one decimal, with a trailing '.0' dropped. */
function pct(n) {
  var v = Math.round((Number(n) || 0) * 10) / 10;
  return (v % 1 === 0 ? String(v) : v.toFixed(1)) + '%';
}

/** What one row takes off a sticker price, in dollars per month. */
function rowOff(r, stk) {
  return (Number(stk) || 0) * (Number(r.percentOff) || 0) / 100;
}

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

/** One row of the mix: type, amount, window. Same table furniture as the tiers. */
function mixRowHTML(r, i, guar) {
  var topts = MIX_TYPES.map(function (k) {
    return '<option value="' + k + '"' + (k === r.type ? ' selected' : '') + '>' + MIX_TYPE_LABEL[k] + '</option>';
  }).join('');
  var fits = MIX_PERIODS.filter(function (p) { return p[1] <= guar; });
  var pick = windowFor(r, fits, guar);
  var popts = fits.map(function (p) {
    var on = pick[0] === p[0] && pick[1] === p[1];
    return '<option value="' + p[0] + '-' + p[1] + '"' + (on ? ' selected' : '') + '>' + periodLabel(p) + '</option>';
  }).join('');
  return '<tr class="mrow" data-i="' + i + '">'
    + '<td><select class="mtype" data-action="ticket:field">' + topts + '</select>'
    + '<input type="text" class="mown" data-action="ticket:field" placeholder="e.g. Neighbourhood build rate" maxlength="40" value="'
    + esc(r.label || '') + '"' + (r.type === 'own' ? '' : ' hidden') + '></td>'
    + '<td><input type="number" class="mamt" data-action="ticket:field" value="' + esc(r.percentOff || '') + '" min="0" max="100" step="1"></td>'
    + '<td><select class="mper" data-action="ticket:field">' + popts + '</select></td>'
    + '<td>' + (i > 0 ? '<button type="button" class="trm" data-action="ticket:mixrm" data-i="' + i + '" aria-label="Remove discount">×</button>' : '') + '</td></tr>';
}

/**
 * What the mix comes to over the whole guarantee, and what that makes the
 * average effective price per tier.
 *
 * The schedule is in percent, so the dollars are per tier: each row takes its
 * percentage off THAT tier's sticker, for the months it runs. The percentage is
 * the one figure common to every tier, so the header states the weighted
 * average percentage and each tier row states the money it comes to.
 *
 * The tier table already carries an effective price, so the two can disagree:
 * a partner can schedule 40% off for six months and still type $56 effective.
 * Neither is wrong on its own, so this states both and names the tiers where
 * they part company. Households are shown the effective price either way,
 * which is why the confirmation below asks about that number specifically.
 */
function mixSummaryHTML(tiers, mix, guar) {
  var months = guar || 24;
  /* Percent-months: the weighted average percentage over the guarantee, which
     comes out the same on every tier and so belongs above the per-tier rows. */
  var pctMonths = 0;
  mix.forEach(function (r) {
    var from = Math.min(Number(r.from) || 0, months);
    var to = Math.min(Number(r.to) || 0, months);
    if (to > from) pctMonths += (Number(r.percentOff) || 0) * (to - from);
  });
  var avgPct = months ? pctMonths / months : 0;

  /* A month where the rows running together come to more than the sticker is
     not a price, so count those months rather than clamping in silence. */
  var over = 0;
  for (var m = 0; m < months; m++) {
    var at = 0;
    mix.forEach(function (r) {
      if (m >= (Number(r.from) || 0) && m < (Number(r.to) || 0)) at += Number(r.percentOff) || 0;
    });
    if (at > 100) over++;
  }

  var off = [];
  var rows = tiers.map(function (t) {
    var stk = Number(t.stickerPrice) || 0;
    var eff = Number(t.effectivePrice) || 0;
    var total = 0;
    mix.forEach(function (r) {
      var from = Math.min(Number(r.from) || 0, months);
      var to = Math.min(Number(r.to) || 0, months);
      if (to > from) total += rowOff(r, stk) * (to - from);
    });
    var avgOff = months ? total / months : 0;
    var avgEff = Math.max(0, stk - avgOff);
    if (stk && Math.abs(avgEff - eff) > 0.5) off.push(t.name);
    return '<div class="mixrow"><span>' + esc(t.name || 'Tier') + '</span>'
      + '<em>sticker ' + cash(stk) + ', less ' + cash(avgOff) + ' /mo, '
      + money(String(Math.round(total))) + ' total</em>'
      + '<b>' + cash(avgEff) + ' /mo</b></div>';
  }).join('');

  return '<h4>Across the ' + months + '-month guarantee</h4>'
    + '<div class="mixrow"><span>Average discount</span><b>' + pct(avgPct) + ' off sticker</b></div>'
    + rows
    + (over
      ? '<p class="mixwarn">The rows running together take more than the sticker price in '
        + over + (over === 1 ? ' month' : ' months') + '. Trim the percentages so no month passes 100%.</p>'
      : '')
    + (off.length
      ? '<p class="mixwarn">The mix averages to a different figure than the effective price entered on '
        + esc(off.join(', ')) + '. Households are shown the effective price.</p>'
      : '');
}

/* ------------------------------------------------------------------ *
 * carrying terms forward
 *
 * A partner bidding on their fifth cohort this week is not retyping six tiers,
 * a guarantee and an equipment line five times. The terms they last sealed
 * open the next form, and every one of them is editable before it is sealed.
 *
 * WHAT IS NOT CARRIED, and why each one:
 *   consent, mixConfirmed   affirmations about THIS cohort's numbers. A bid is
 *                           sealed and binding; a pre-ticked box is a bid
 *                           nobody agreed to. Always false on a seeded form.
 *   committedHouseholds     capped at the new cohort's size. 64 households
 *                           committed on a cohort of 20 is not a preference
 *                           carried forward, it is a wrong number.
 *   campaignId, improve, error   per-form by definition.
 *
 * THREE SOURCES, in order. The session's last seal, then the stored copy from
 * a previous session, then the most recent sealed bid the server returned.
 * The third exists because the first two are local and can be absent on a new
 * machine; it is weaker than the others only in that a sealed head carries no
 * discount schedule, so a custom mix comes back as the one row mixFromBid can
 * reconstruct. See core/bidseed.js.
 * ------------------------------------------------------------------ */

/** The campaign-agnostic half of a draft: what carries to the next cohort. */
function seedFromDraft(d) {
  return {
    tiers: (d.tiers || []).map(function (t) {
      return {
        name: t.name, uploadMbps: t.uploadMbps || '', technology: t.technology || 'cable',
        stickerPrice: String(t.stickerPrice || ''), effectivePrice: String(t.effectivePrice || ''),
        afterPrice: t.afterPrice ? String(t.afterPrice) : ''
      };
    }),
    reductionPresentation: d.reductionPresentation || 'member',
    mechanismLabel: d.mechanismLabel || '',
    discountMix: (d.discountMix || []).map(function (r) {
      return { type: r.type, label: r.label || '', percentOff: String(r.percentOff || ''), from: r.from, to: r.to };
    }),
    guaranteeMonths: d.guaranteeMonths || 24,
    afterMode: d.afterMode || 'none',
    equipment: d.equipment || 'inc',
    rentalMonthly: d.rentalMonthly || '7',
    extraPodMonthly: d.extraPodMonthly || '0',
    committedHouseholds: d.committedHouseholds || 0
  };
}

/** The most recent sealed bid this org holds, as a seed. Null if none. */
function seedFromBids(S) {
  var best = null;
  var bids = S.bids || {};
  for (var k in bids) {
    if (!Object.prototype.hasOwnProperty.call(bids, k)) continue;
    var b = bids[k];
    if (!b || !(b.tiers || []).length) continue;
    var at = b.updatedAt || b.placedAt || 0;
    if (!best || at > best.at) best = { at: at, bid: b, campaignId: k };
  }
  if (!best) return null;
  var m = best.bid;
  var a = campaignById(best.campaignId);
  return {
    draft: seedFromDraft({
      tiers: m.tiers,
      reductionPresentation: m.reductionPresentation || 'member',
      mechanismLabel: m.mechanismLabel || '',
      discountMix: mixFromBid(m),
      guaranteeMonths: m.guaranteeMonths,
      afterMode: m.afterMode,
      equipment: m.equipment,
      rentalMonthly: m.rentalMonthly,
      extraPodMonthly: m.extraPodMonthly,
      committedHouseholds: m.committedHouseholds
    }),
    from: a ? (a.region || null) : null,
    savedAt: best.at || 0
  };
}

/**
 * The seed on offer right now, or null. Pure: it reads state and storage and
 * writes neither, because it is called from a render and a render that mutates
 * state is the bug this codebase was ported away from.
 */
function currentSeed() {
  var S = get();
  if (S.ticketSeed) return S.ticketSeed;
  var stored = readSeed(S.org && S.org.orgId);
  if (stored) return stored;
  return seedFromBids(S);
}

/** What the seeded banner says, or null when nothing is on offer. */
function seedBanner() {
  var seed = currentSeed();
  if (!seed || !seed.draft || !(seed.draft.tiers || []).length) return null;
  return { from: seed.from || null, savedAt: seed.savedAt || 0 };
}

/** The draft a form opens on: the seed where there is one, defaults otherwise. */
function openingDraft(a) {
  var seed = currentSeed();
  var d = defaultDraft(a);
  if (!seed || !seed.draft || !(seed.draft.tiers || []).length) return d;
  var s = seed.draft;
  d.tiers = s.tiers.map(function (t) { return { name: t.name, uploadMbps: t.uploadMbps, technology: t.technology, stickerPrice: t.stickerPrice, effectivePrice: t.effectivePrice, afterPrice: t.afterPrice }; });
  d.reductionPresentation = s.reductionPresentation;
  d.mechanismLabel = s.mechanismLabel;
  if ((s.discountMix || []).length) {
    /* percentOff only. A seed written while the mix was in dollars carries an
       `amount`, and $22 read as 22% is a different offer on every tier, so an
       old row opens with an empty percentage rather than a wrong one. */
    d.discountMix = s.discountMix.map(function (r) {
      return { type: r.type, label: r.label, percentOff: String(r.percentOff || ''), from: r.from, to: r.to };
    });
  }
  d.guaranteeMonths = s.guaranteeMonths;
  d.afterMode = s.afterMode;
  d.equipment = s.equipment;
  d.rentalMonthly = s.rentalMonthly;
  d.extraPodMonthly = s.extraPodMonthly;
  var cap = a.households || 0;
  var want = Number(s.committedHouseholds) || 0;
  d.committedHouseholds = cap ? (want ? Math.min(want, cap) : cap) : (want || 1);
  /* Never carried: see the note above. */
  d.consent = false;
  d.mixConfirmed = false;
  d.seeded = { from: seed.from || null, savedAt: seed.savedAt || 0 };
  return d;
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
    /* One row, running the full guarantee, at the share of sticker the tier
       row above already comes to (86 down to 56 is 35% off), so the mix opens
       agreeing with the prices beside it. */
    discountMix: [{ type: 'member', label: '', percentOff: '35', from: 0, to: 24 }],
    mixConfirmed: false,
    guaranteeMonths: 24,
    afterMode: 'none',
    equipment: 'inc',
    rentalMonthly: '7',
    extraPodMonthly: '0',
    committedHouseholds: a.households || 1
  };
}

function mixFromBid(m) {
  var t0 = (m.tiers || [])[0] || {};
  var stk = Number(t0.stickerPrice) || 0;
  var gap = Math.max(0, stk - (Number(t0.effectivePrice) || 0));
  /* The sealed head is in dollars and the schedule is in percent, so the first
     tier's gap is read back as a share of its own sticker. */
  var share = stk && gap ? Math.round((gap / stk) * 1000) / 10 : 0;
  return [{
    type: m.mechanismLabel ? 'own' : 'member',
    label: m.mechanismLabel || '',
    percentOff: share ? String(share) : '',
    from: 0,
    to: m.guaranteeMonths || 24
  }];
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
    /* A sealed head carries the derived label and no schedule, because the
       server has nowhere to keep one yet. Reconstruct a single row from what
       did survive: the partner's own wording, the gap on the first tier, and
       the whole guarantee. It is a starting point for the improvement, not a
       claim about what was sealed. */
    discountMix: mixFromBid(m),
    mixConfirmed: false,
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
 * Whether this cohort's roster has already released to the org.
 *
 * Three-valued on purpose: true, false, and null for "the delivery board has
 * not been read yet". The board is NOT loaded on boot, because every read of
 * a released roster writes an audit row (app.js loadAll explains it), so on a
 * partner who has not opened Delivery this is genuinely unknown and the won
 * panel must not assert either way.
 */
function rosterReleased(S, campaignId) {
  var D = S.delivery;
  if (!D || D === 'loading' || !D.cohorts) return null;
  var found = null;
  D.cohorts.forEach(function (c) { if (c.campaignId === campaignId) found = c; });
  return found ? !!found.orders : null;
}

/**
 * The ticket panel for one cohort. Six states, the prototype's four plus the
 * two it did not have:
 *
 *   result, won         decided with a winning bid, itself two panels
 *   result, not selected
 *   closed              offers out
 *   over, no bid        decided with no bid of ours   <- NOT in the prototype
 *   sealed receipt
 *   the form
 *
 * THE FIFTH IS A PORT FIX, NOT AN ADDITION. The prototype selected on
 * `st>=4 && mine`, then `st===3`, then `mine`, then fell through to the bid
 * form (v12 line 2578). A partner who did not bid on a cohort that has since
 * decided therefore met a full seven-column pricing form, consent checkbox and
 * all, for an auction that ended days ago. The button read "Bidding closed"
 * and was disabled, so nothing could be written, but the screen was still the
 * wrong screen and the desk's View control reaches it: bidAction() offers View
 * on a decided row whether or not there is a bid behind it.
 *
 * THE WON PANEL IS TWO PANELS, and the port had collapsed them into one. The
 * prototype branched on P.gate[a.id]: a roster still gated says complete the
 * setup, a roster already released says go and schedule it. One copy for both
 * told a partner who had finished the gate to go and finish the gate.
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

    /* The next step, from what is actually known. A released roster is past
       the gate; a card on file means only capacity is left, and that half is
       known on every boot because loadMethod() runs there. Unknown release
       state falls to the capacity wording, which is true in both remaining
       cases and never tells a partner to add a card they already added. */
    var released = rosterReleased(S, a.id);
    var onFile = !!(S.billing && S.billing !== 'loading' && S.billing.method && S.billing.method.onFile);
    var next = released === true
      ? ' Roster released: schedule and activate it from the delivery board, and activations bill themselves.'
      : (onFile
        ? ' Confirm your install capacity and the roster releases to you.'
        : ' Complete billing setup and confirm capacity, and the roster releases to you.');

    return '<div class="tkt"><div class="dh">Result</div><div class="receipt">'
      + '<b>Won.</b> ' + wonLine + next + '</div>'
      + '<button class="btn" type="button" data-action="nav" data-view="delivery" style="margin-top:12px">Open the delivery board</button></div>';
  }

  /* Bids closed, offers with households.
   *
   * The confirmed clause used to read "Confirmed so far: N of M", and no
   * surface quotes a household count against a cohort's size any more: a
   * partner watching confirmations trickle in against the full cohort reads a
   * shortfall, not progress, and there is nothing they can do about it in this
   * window anyway. When a confirmed count returns it returns as a count, not as
   * a fraction, and it stays gated on `mine`: a confirmation count on a cohort
   * another partner won is that partner's count. */
  if (a.stage === 'offers_out') {
    return '<div class="tkt"><div class="dh">Bids closed</div><div class="receipt">'
      + (mine
        ? '<b>Your bid is in:</b> ' + bidLine(mine) + (mine.reference ? ' · Receipt ' + esc(mine.reference) : '') + '. '
        : '<b>You did not bid on this cohort.</b> ')
      + 'Offers are out to every household, individually. '
      + (mine && a.confirmed != null ? 'Confirmed so far: <b>' + a.confirmed + '</b>. ' : '')
      + (d.decision_at ? 'Decisions lock ' + fmtDate(d.decision_at) + '; there' : 'There')
      + ' is nothing for you to do, and no way to see other bids.</div></div>';
  }

  /* Decided, and none of it was ours. The state the prototype dropped into a
     bid form. Says the one true thing and offers the one useful thing, which
     is the alert that stops it happening again. */
  if (a.stage === 'decided') {
    return '<div class="tkt"><div class="dh">Closed</div><div class="receipt">'
      + '<b>You did not bid on this cohort.</b> Bidding closed'
      + (d.bidding_closes_at ? ' ' + fmtDate(d.bidding_closes_at) : '')
      + ' and the cohort is decided. Nothing is owed and nothing is pending on your side. '
      + 'Cohorts keep forming in the regions you have declared, and you can be emailed the day one opens.</div>'
      + '<button class="btn ghost" type="button" data-action="nav" data-view="account" style="margin-top:12px">Check your alerts</button></div>';
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
  return formHTML(a, data, draft || openingDraft(a), Boolean(mine));
}

/**
 * The mix block: the schedule on the left, its arithmetic on the right.
 *
 * Rendered always and hidden unless 'custom' is chosen, the same
 * hidden-attribute reveal the rental cell and the after column already use, so
 * a select change repaints from the draft rather than poking at the DOM.
 */
function mixHTML(t) {
  var guar = t.guaranteeMonths || 24;
  var mix = t.discountMix && t.discountMix.length
    ? t.discountMix
    : [{ type: 'member', label: '', percentOff: '', from: 0, to: guar }];
  return '<div class="mixw"' + (t.reductionPresentation === 'custom' ? '' : ' hidden') + '>'
    + '<label class="blk">Your mix <small class="lsub">one row per step, each a percentage off sticker, so a reduction that changes partway through says so</small></label>'
    + '<div class="mixgrid"><div>'
    + '<table class="tiert mixt"><thead><tr><th>Discount type</th><th>Discount, %</th><th>Valid time period</th><th></th></tr></thead><tbody class="mixbody">'
    + mix.map(function (r, i) { return mixRowHTML(r, i, guar); }).join('')
    + '</tbody></table>'
    + '<button type="button" class="taddrow" data-action="ticket:mixadd">+ Add another discount</button></div>'
    + '<div class="mixcalc"><div class="mixsum">' + mixSummaryHTML(t.tiers || [], mix, guar) + '</div>'
    + '<label class="consent"><input type="checkbox" class="bmixok" data-action="ticket:field"' + (t.mixConfirmed ? ' checked' : '') + '>'
    + '<span>I confirm the effective monthly price each tier reaches under this mix, for the whole guarantee.</span></label>'
    + '</div></div></div>';
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
    ['custom', 'Custom, choose your mix']
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
    /* A custom mix has its own confirmation, because the number it asks about
       (the effective price each tier averages to) is not on the consent line. */
    var ready = t.consent && (t.reductionPresentation !== 'custom' || t.mixConfirmed);
    button = '<button class="btn" type="button" data-action="ticket:place" data-id="' + esc(a.id) + '"'
      + (ready ? '' : ' disabled') + '>'
      + (improving ? 'Seal the improvement' : 'Place sealed bid') + '</button>';
  }

  return '<div class="tkt"><div class="steps"><span class="on">1 · Set terms</span><i></i><span>2 · Seal</span></div>'
    + '<div class="bidform' + (t.afterMode === 'new' ? ' aftnew' : '') + '" data-bid="' + esc(a.id) + '">'
    + (improving
      ? '<div class="receipt" style="margin-bottom:12px"><b>Improving version ' + esc(String((S.bids[a.id] || {}).version || 1)) + '.</b> '
        + 'Every tier must stay at least as good: no raised effective price, no shortened guarantee, no worsened after-rate, no reduced commitment. '
        + '<button class="tlink" type="button" data-action="ticket:cancel">Keep the sealed version</button></div>'
      : (t.seeded
        ? '<div class="receipt" style="margin-bottom:12px"><b>Filled in from the terms you last sealed'
          + (t.seeded.from ? ' on ' + esc(t.seeded.from) : '')
          + (t.seeded.savedAt ? ', ' + fmtDate(t.seeded.savedAt) : '') + '.</b> '
          + 'Nothing is sent until you seal, every field is editable, and your commitment has been set to this cohort\u2019s size. '
          + '<button class="tlink" type="button" data-action="ticket:fresh" data-id="' + esc(a.id) + '">Start from blank terms</button></div>'
        : ''))
    + '<label class="blk">Price by service <small class="lsub">sticker is your rate card; effective is what the cohort pays</small></label>'
    + '<table class="tiert t7"><thead><tr><th>Tier</th><th>Upload, Mbps</th><th>Technology</th><th>Sticker /mo</th><th>Effective /mo</th><th class="tac">After</th><th></th></tr></thead><tbody class="tierbody">'
    + rows
    + '</tbody></table>'
    + '<button type="button" class="taddrow" data-action="ticket:add">+ Add another service</button>'
    + '<div class="two"><div><label>How the reduction reads to households</label><select class="bmech" data-action="ticket:field">' + mechOpts + '</select></div>'
    + '<div class="mechnote"><small class="hint">Your rate card stays intact either way. Households always see the effective price and the after-rate; this only sets whether the math between sticker and effective is shown, and under what name.</small></div></div>'
    + mixHTML(t)
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
    + '<div class="podcell"><label>Extra pod, $ /mo <small class="lsub">0 means included</small></label><input type="number" class="bpods" data-action="ticket:field" value="' + esc(t.extraPodMonthly || '0') + '" min="0" step="0.5"></div></div>'
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

/** The schedule rows, as typed. Order is display order, which is the order
    the windows were laid out in, so it is worth keeping. */
function readMix(form) {
  return $$('.mrow', form).map(function (tr) {
    var per = String($('.mper', tr).value || '0-0').split('-');
    return {
      type: $('.mtype', tr).value,
      label: String(($('.mown', tr) || {}).value || '').trim(),
      percentOff: String($('.mamt', tr).value || '').trim(),
      from: parseInt(per[0], 10) || 0,
      to: parseInt(per[1], 10) || 0
    };
  });
}

/**
 * The one label a sealed custom bid can still carry, derived from the mix.
 *
 * This exists because the server has nowhere to put a schedule: readBid()
 * takes a single mechanismLabel of 3 to 40 plain characters and refuses the
 * pressure language the standard terms forbid. So the distinct type names of
 * the live rows are joined, stripped to the accepted charset, and cut back to
 * the first name if that runs long. When discount_mix lands on provider_bids
 * this becomes a display convenience instead of the whole record.
 */
function mixLabel(mix) {
  var parts = [];
  mix.forEach(function (r) {
    if (!(Number(r.percentOff) > 0 && r.to > r.from)) return;
    var n = String(r.type === 'own' ? r.label : (MIX_TYPE_SHORT[r.type] || ''))
      .replace(/[^A-Za-z0-9 ,.'&-]/g, '').trim();
    if (n && parts.indexOf(n) < 0) parts.push(n);
  });
  var joined = parts.join(', ');
  if (joined.length > 40) joined = parts[0] || '';
  return joined.slice(0, 40).trim();
}

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
  var mix = readMix(form);
  if (mech === 'custom') {
    var live = mix.filter(function (r) { return Number(r.percentOff) > 0 && r.to > r.from; });
    var unnamed = live.filter(function (r) { return r.type === 'own' && r.label.length < 3; });
    var overs = mix.filter(function (r) { return Number(r.percentOff) > 100; });
    if (!live.length) bad = bad || 'Give the mix at least one discount with a percentage and a period.';
    else if (overs.length) bad = bad || 'A discount cannot take more than 100% off the sticker price.';
    else if (unnamed.length) bad = bad || 'Name the discount you worded yourself, in 3 to 40 plain characters.';
  }

  var commitMax = a && a.households ? a.households : Infinity;
  var commit = parseInt($('.bcommit', form).value, 10) || 0;
  if (commit > commitMax) commit = commitMax;

  return {
    campaignId: a ? a.id : null,
    tiers: tiers,
    reductionPresentation: mech,
    mechanismLabel: mech === 'custom' ? mixLabel(mix) : '',
    discountMix: mix,
    mixConfirmed: Boolean($('.bmixok', form) && $('.bmixok', form).checked),
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

/**
 * Recompute the mix arithmetic from the open form, in place.
 *
 * Only the summary block is rewritten, never the schedule table and never the
 * confirmation checkbox: a keystroke in an amount must not repaint the input
 * it was typed into, and it must not quietly clear a box the partner ticked.
 */
export function refreshMix() {
  var form = $('.bidform');
  if (!form) return;
  var sum = $('.mixsum', form);
  if (!sum) return;
  var d = readTicket(form, null);
  sum.innerHTML = mixSummaryHTML(d.tiers, d.discountMix, d.guaranteeMonths);
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
  var prev = S.ticketDraft && S.ticketDraft.campaignId === a.id ? S.ticketDraft : null;
  d.improve = Boolean(prev && prev.improve);
  /* The banner has to survive the first edit, and the first edit is where the
     draft is born: until then the form on screen came from openingDraft(),
     which seeded it exactly when a seed existed. currentSeed() cannot change
     between those two moments, since only a successful seal moves it. */
  d.seeded = prev ? (prev.seeded || null) : seedBanner();
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
    refreshMix();
  });

  /* Keystrokes update only the derived panels. Writing the store here would
     repaint the form under the cursor mid-word. */
  on('input', 'ticket:field', function () { refreshScn(); refreshMix(); });

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

  on('click', 'ticket:mixadd', function (el) {
    var d = draftFromForm(el);
    if (!d) return;
    var guar = d.guaranteeMonths || 24;
    /* The new window starts where the last one ended, so a schedule reads as
       steps. When the last row already runs the whole guarantee there is no
       next step and the row lands on the same window, which is fine: two
       reductions running together is a legitimate mix too. */
    var last = d.discountMix[d.discountMix.length - 1];
    var from = last && last.to < guar ? last.to : 0;
    var fits = MIX_PERIODS.filter(function (p) { return p[0] === from && p[1] <= guar; });
    var win = fits.length ? fits[fits.length - 1] : [0, guar];
    d.discountMix.push({ type: 'promo', label: '', percentOff: '', from: win[0], to: win[1] });
    set('ticketDraft', d);
    refreshMix();
  });

  on('click', 'ticket:mixrm', function (el) {
    var d = draftFromForm(el);
    if (!d) return;
    var i = parseInt(el.getAttribute('data-i'), 10);
    d.discountMix = d.discountMix.filter(function (r, j) { return j !== i; });
    if (!d.discountMix.length) return;
    set('ticketDraft', d);
    refreshMix();
  });

  on('click', 'ticket:improve', function (el) {
    var id = el.getAttribute('data-id');
    var a = campaignById(id);
    var mine = get().bids[id];
    if (!a || !mine) return;
    set('ticketDraft', draftFromBid(a, mine));
  });

  on('click', 'ticket:cancel', function () { set('ticketDraft', null); });

  /* Blank terms on request. The seed itself is left alone: this partner wants
     a different bid on THIS cohort, which says nothing about the next one. */
  on('click', 'ticket:fresh', function (el) {
    var a = campaignById(el.getAttribute('data-id'));
    if (a) set('ticketDraft', defaultDraft(a));
  });

  on('click', 'ticket:place', function (el) {
    var S = get();
    var form = el.closest('.bidform');
    var id = form && form.getAttribute('data-bid');
    var a = id && campaignById(id);
    if (!form || !a) return;

    var d = readTicket(form, a);
    var prev = S.ticketDraft && S.ticketDraft.campaignId === id ? S.ticketDraft : null;
    var improve = Boolean(prev && prev.improve);
    /* Whatever refuses the bid, the banner it was filled in from stays put. */
    d.seeded = prev ? (prev.seeded || null) : seedBanner();
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
      /* Sent, and dropped by readBid() until provider_bids carries a column
         for it. The label above is what the seal keeps today. */
      discountMix: d.reductionPresentation === 'custom' ? d.discountMix : undefined,
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
      /* These terms are now the starting point for the next cohort. Written
         from the draft that was actually sealed, not from the response: the
         response is a head row and drops the discount schedule. */
      var seed = { draft: seedFromDraft(d), from: a.region || null, savedAt: Date.now() };
      writeSeed((S.org && S.org.orgId) || null, seed.draft, seed.from);
      set({ bids: bids, ticketDraft: null, ticketSeed: seed });
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
