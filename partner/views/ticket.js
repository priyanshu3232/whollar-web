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
import { open as openModal, close as closeModal } from '../core/modal.js';
import { MIX_TYPES, MIX_TYPE_LABEL, MIX_MAX_ROWS, checkMix, tierSnapshot, rowLabel, fmtShare, centsStr } from '../core/mixmath.js';

/* Suggested prices per tier, from the prototype (SUGG / SUGGUP / SUGGSTICKER,
   lines 2142-2143 and 2563). Suggestions only: everything is editable and the
   server validates whatever arrives. */
var SUGG = { '50 Mbps': 39, '100 Mbps': 44, '300 Mbps': 49, '500 Mbps': 56, '1 Gig': 64, '1.5 Gig': 74, '2.5 Gig': 84 };
var SUGGUP = { '50 Mbps': '10', '100 Mbps': '20', '300 Mbps': '30', '500 Mbps': '50', '1 Gig': '100', '1.5 Gig': '150', '2.5 Gig': '250' };
var SUGGSTICKER = { '50 Mbps': 55, '100 Mbps': 65, '300 Mbps': 75, '500 Mbps': 86, '1 Gig': 99, '1.5 Gig': 115, '2.5 Gig': 135 };

/* ------------------------------------------------------------------ *
 * the custom mix
 * ------------------------------------------------------------------ *
 *
 * 'Custom' is a mix: the reduction between a tier's sticker and its effective
 * price, split into named parts. Each row claims a SHARE OF THAT REDUCTION,
 * the shares total 100%, and the arithmetic (core/mixmath.js, one source for
 * the console and the server) turns each share into cents per tier. The
 * effective price the partner typed is never recomputed from the mix, so a
 * valid mix reconciles to it by construction, and there is nothing for a
 * partner to confirm about a figure the form did not invent.
 *
 * It used to be a percentage OFF STICKER per row, so two rows of 50%, which is
 * what a partner means by "split it 50/50", came to 100% off and a $0 tier.
 * Shares of the gap are the figure that means the same thing on every tier:
 * the gap differs by tier, so the same shares are different dollars on each
 * tier automatically.
 *
 * ONE MIX, OR ONE PER TIER. The state is { applyToAll, shared, perTier }.
 * With applyToAll on, `shared` is the mix and applies to every tier; off,
 * each tier row has its own list in `perTier`, keyed by the tier row's rid, a
 * client-only id, so a mix follows its row through a dropdown change and two
 * rows that happen to name the same tier stay distinct. Both branches are
 * kept for the session so toggling restores what was typed; only the branch
 * in force is sealed.
 *
 * EVERY ROW RUNS THE WHOLE GUARANTEE. A row that stopped at month 12 of a
 * 24-month guarantee would make the household's price change at month 13,
 * which contradicts the single effective price the consent line promises and
 * the per-tier comparison the improvement rule makes. The sealed record still
 * carries periodStartMo 0 and periodEndMo = guarantee on every row, so the
 * shape is ready if that ever changes.
 *
 * SEALED. The body sends shares; lib/bids.js readBid() recomputes the cents
 * with the same mixmath and stores the snapshot in provider_bids.discount_mix
 * and in the revision payload. The improve form and the next cohort's form
 * hydrate from that snapshot, per-tier or shared exactly as it was set.
 */

function newRid() {
  return 'r' + Math.random().toString(36).slice(2, 8);
}

function defaultRow() { return { type: 'member', label: '', sharePct: '100' }; }
function copyRow(r) {
  var x = r || {};
  return { type: x.type, label: x.label || '', sharePct: String(x.sharePct === undefined || x.sharePct === null ? '' : x.sharePct) };
}
function copyRows(rows) { return (rows || []).map(copyRow); }
function defaultMix() { return { applyToAll: true, shared: [defaultRow()], perTier: {} }; }

/** Every tier row carries a rid; rows read back from a seed or a seal get one here. */
function withRids(tiers) {
  return (tiers || []).map(function (t) {
    if (t.rid) return t;
    var c = {};
    for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) c[k] = t[k];
    c.rid = newRid();
    return c;
  });
}

/** The rows in force for one tier row (rid null reads the shared mix). */
function rowsFor(mix, rid) {
  var m = mix || defaultMix();
  if (m.applyToAll !== false) return m.shared && m.shared.length ? m.shared : [defaultRow()];
  var own = m.perTier && m.perTier[rid];
  return own && own.length ? own : [defaultRow()];
}

function isAll(t) { return !(t.mix && t.mix.applyToAll === false); }

/**
 * Every tier's snapshot and check, and whether the whole mix can seal.
 * -> { ok, problem, tiers: [{ tier, rid, snap, check }] }
 *
 * Computed whether or not custom is the chosen read, because the block is
 * rendered hidden under the other reads and has to be right when it opens.
 * Callers gate on reductionPresentation.
 */
function mixStatus(t) {
  var out = { ok: true, problem: null, tiers: [] };
  var all = isAll(t);
  var any = false;
  (t.tiers || []).forEach(function (tier) {
    var rows = rowsFor(t.mix, tier.rid);
    var snap = tierSnapshot(tier, rows, t.guaranteeMonths || 24);
    var check = snap.gapCents > 0 ? checkMix(rows) : null;
    if (snap.gapCents > 0) any = true;
    if (snap.gapCents < 0) {
      out.ok = false;
      out.problem = out.problem || ('Effective price cannot sit above sticker on ' + tier.name + '.');
    } else if (check && !check.ok) {
      out.ok = false;
      out.problem = out.problem || ((all ? '' : tier.name + ': ') + check.problems[0]);
    }
    out.tiers.push({ tier: tier, rid: tier.rid, snap: snap, check: check });
  });
  if (out.tiers.length && !any && out.ok) {
    out.ok = false;
    out.problem = 'Sticker and effective match on every tier, so there is no reduction to name. Choose "Effective price only, no breakdown".';
  }
  return out;
}

/** Whether the seal may proceed as far as the mix is concerned. */
function mixOk(t) {
  return t.reductionPresentation !== 'custom' || mixStatus(t).ok;
}

/** "$1,470.00", always two decimals: these are line items households read. */
function dollars(c) {
  var s = centsStr(c);
  var neg = s.charAt(0) === '-';
  var parts = (neg ? s.slice(1) : s).split('.');
  return (neg ? '-$' : '$') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
}

/** What each row of an editor comes to, per tier it applies to: "50% · $25.00 /mo". */
function amountTexts(scope, rows, st) {
  var check = checkMix(rows);
  var tiers = st.tiers.filter(function (x) {
    return x.snap.gapCents > 0 && (scope === 'shared' || x.rid === scope);
  });
  return rows.map(function (r, i) {
    var t = check.rows[i] ? check.rows[i].tenths : 0;
    var per = tiers.map(function (x) {
      var row = x.snap.mix[i];
      return (tiers.length > 1 ? x.tier.name + ' ' : '') + dollars(row ? row.amountCents : 0);
    });
    return fmtShare(t) + '%' + (per.length ? ' · ' + per.join(' · ') + ' /mo' : '');
  });
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
  return '<tr class="trow" data-i="' + i + '" data-rid="' + esc(t.rid || '') + '">'
    + '<td><select class="tname" data-action="ticket:field">' + opts + '</select></td>'
    + '<td><input type="text" class="tup" data-action="ticket:field" value="' + esc(t.uploadMbps || '') + '"></td>'
    + '<td><select class="ttech" data-action="ticket:field">' + topts + '</select></td>'
    + '<td><input type="number" class="tsticker" data-action="ticket:field" value="' + esc(t.stickerPrice || '') + '" min="1" step="0.5"></td>'
    + '<td><input type="number" class="teff" data-action="ticket:field" value="' + esc(t.effectivePrice || '') + '" min="1" step="0.5"></td>'
    + '<td class="tac"><input type="number" class="tafter" data-action="ticket:field" value="' + esc(t.afterPrice || '') + '" min="1" step="0.5"></td>'
    + '<td>' + (i > 0 ? '<button type="button" class="trm" data-action="ticket:rm" data-i="' + i + '" aria-label="Remove tier">×</button>' : '') + '</td></tr>';
}

/**
 * One row of the mix: type (with the partner's own wording when chosen), the
 * share, and what that share comes to. Same table furniture as the tiers.
 *
 * A single row carries the whole reduction, so its share is shown as 100 and
 * locked: there is nothing to split. The lock releases the moment a second
 * row exists.
 */
function mixRowHTML(r, i, scope, amountText, problem, single) {
  var topts = MIX_TYPES.map(function (k) {
    return '<option value="' + k + '"' + (k === r.type ? ' selected' : '') + '>' + MIX_TYPE_LABEL[k] + '</option>';
  }).join('');
  return '<tr class="mrow' + (problem ? ' bad' : '') + '" data-i="' + i + '">'
    + '<td><select class="mtype" data-action="ticket:field" aria-label="Discount type">' + topts + '</select>'
    + '<input type="text" class="mown" data-action="ticket:field" placeholder="e.g. Neighbourhood build rate" maxlength="40" aria-label="Discount name households will see" value="'
    + esc(r.label || '') + '"' + (r.type === 'own' ? '' : ' hidden') + '></td>'
    + '<td><input type="number" class="mamt" data-action="ticket:field" value="' + esc(single ? '100' : (r.sharePct || '')) + '" min="0" max="100" step="0.1" inputmode="decimal" aria-label="Share of the reduction, percent"' + (single ? ' readonly' : '') + '>'
    + '<small class="mamtv">' + esc(amountText || '') + '</small>'
    + (single ? '<small class="hint">One row carries the whole reduction.</small>' : '') + '</td>'
    + '<td>' + (single ? '' : '<button type="button" class="trm" data-action="ticket:mixrm" data-scope="' + esc(scope) + '" data-i="' + i + '" aria-label="Remove discount">×</button>') + '</td></tr>';
}

/** One editor: the rows of one mix, shared or for one tier. */
function mixEditorHTML(scope, rows, head, st) {
  var check = checkMix(rows);
  var texts = amountTexts(scope, rows, st);
  var single = rows.length === 1;
  return '<div class="mixed" data-scope="' + esc(scope) + '">'
    + (head ? '<div class="mixhead">' + head + '</div>' : '')
    + '<table class="tiert mixt"><thead><tr><th>Discount type</th><th>Share of reduction, %</th><th></th></tr></thead><tbody class="mixbody">'
    + rows.map(function (r, i) { return mixRowHTML(r, i, scope, texts[i], check.rows[i] && check.rows[i].problem, single); }).join('')
    + '</tbody></table>'
    + (rows.length < MIX_MAX_ROWS
      ? '<button type="button" class="taddrow" data-action="ticket:mixadd" data-scope="' + esc(scope) + '">+ Add another discount</button>'
      : '<small class="hint">A mix carries at most ' + MIX_MAX_ROWS + ' discounts.</small>')
    + '</div>';
}

function noteHTML(cls, text) { return '<p class="' + cls + '">' + esc(text) + '</p>'; }

/**
 * The reachable-household line, section 5.4, or nothing.
 *
 * ONE AGGREGATE AND NOTHING ELSE. Not which households, not how many excluded
 * which brand, not whether a rival is reachable where this partner is not. The
 * number exists because bidding against volume that cannot be won damages
 * partner trust and the fee model both: a partner who prices for 300
 * households and can reach 240 has been quoted the wrong market.
 *
 * Rendered only when the server has answered. An absent or unavailable reach
 * read says nothing at all rather than guessing the cohort's full size, which
 * would be the one wrong number worse than no number.
 */
function reachHTML(a) {
  var S = get();
  var r = (S.reach || {})[a.id];
  if (!r || r.available === false) return '';
  if (r.reachable_households == null || r.total_households == null) return '';
  var line = 'Reachable households in this cohort for your brands: '
    + r.reachable_households + ' of ' + r.total_households;
  return '<p class="cardnote" data-testid="prov-reach-line">' + esc(line)
    + (r.reachable_households < r.total_households
      ? ' <small class="hint">Some households have excluded a brand you operate. Your bid is never shown to them.</small>'
      : '')
    + '</p>';
}


/**
 * The arithmetic on the right: per tier, the prices, the reduction, each named
 * line item in the cents the seal will record, and the total across the
 * guarantee. Validation states live here too, once when one mix applies to
 * every tier and under each tier otherwise.
 *
 * No average, no "% off sticker": the mix is a decomposition of a reduction
 * the tier row already states, so there is nothing to average and nothing
 * that can disagree with the effective price.
 */
function mixSummaryHTML(t, st) {
  var months = t.guaranteeMonths || 24;
  var all = isAll(t);
  var html = '<h4>Across the ' + months + '-month guarantee</h4>';
  if (all) {
    var shared = checkMix(rowsFor(t.mix, null));
    html += shared.problems.map(function (p) { return noteHTML('mixerr', p); }).join('')
      + shared.warnings.map(function (w) { return noteHTML('mixwarn', w); }).join('');
  }
  st.tiers.forEach(function (x) {
    var s = x.snap;
    html += '<div class="mixtier"><div class="mixrow"><span>' + esc(x.tier.name || 'Tier') + '</span>'
      + '<em>sticker ' + dollars(s.stickerCents) + ' · effective ' + dollars(s.effectiveCents) + '</em>'
      + '<b>' + (s.gapCents > 0 ? 'reduction ' + dollars(s.gapCents) + ' /mo' : (s.gapCents === 0 ? 'no reduction' : '')) + '</b></div>';
    if (s.gapCents < 0) {
      html += noteHTML('mixerr', 'Effective price cannot sit above sticker on this tier. Fix the price row first.');
    } else if (s.gapCents === 0) {
      html += noteHTML('mixnote', 'Sticker and effective match on this tier, so there is no reduction to name.');
    } else {
      s.mix.forEach(function (r) {
        html += '<div class="mixrow sub"><span>' + esc(r.label || 'Unnamed discount') + '</span><em>' + esc(r.sharePct) + '%</em><b>' + dollars(r.amountCents) + ' /mo</b></div>';
      });
      s.mix.forEach(function (r) {
        if (r.amountCents === 0) html += noteHTML('mixwarn', (r.label || 'One step') + ' rounds to $0 /mo at this gap.');
      });
      html += '<div class="mixrow tot"><span>Across ' + months + ' months</span><b>' + dollars(s.gapCents) + ' /mo · ' + dollars(s.gapCents * months) + '</b></div>';
      if (!all && x.check) {
        html += x.check.problems.map(function (p) { return noteHTML('mixerr', p); }).join('')
          + x.check.warnings.map(function (w) { return noteHTML('mixwarn', w); }).join('');
      }
    }
    html += '</div>';
  });
  return html;
}


/* ------------------------------------------------------------------ *
 * carrying terms forward
 *
 * A partner bidding on their fifth cohort this week is not retyping six tiers,
 * a guarantee and an equipment line five times. The terms they last sealed
 * open the next form, and every one of them is editable before it is sealed.
 *
 * WHAT IS NOT CARRIED, and why each one:
 *   consent                 an affirmation about THIS cohort's numbers. A bid
 *                           is sealed and binding; a pre-ticked box is a bid
 *                           nobody agreed to. Always false on a seeded form.
 *   committedHouseholds     capped at the new cohort's size. 64 households
 *                           committed on a cohort of 20 is not a preference
 *                           carried forward, it is a wrong number.
 *   campaignId, improve, error   per-form by definition.
 *
 * THREE SOURCES, in order. The session's last seal, then the stored copy from
 * a previous session, then the most recent sealed bid the server returned.
 * The third exists because the first two are local and can be absent on a new
 * machine. All three carry the mix: a seal from before discount_mix existed
 * comes back as one row wearing the sealed label, and a stored seed from
 * before the mix became shares of the gap is not carried at all, because its
 * numbers meant something else. See core/bidseed.js.
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
    mix: seedMix(d),
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
  var a = campaignById(best.campaignId);
  /* The same reading the improve form makes of a sealed head, so a seed from
     the server and a seed from the session agree on what a mix looks like. */
  var d = draftFromBid(a || { id: best.campaignId, households: 0 }, best.bid);
  return {
    draft: seedFromDraft(d),
    from: a ? (a.region || null) : null,
    savedAt: best.at || 0
  };
}

/**
 * The mix as a seed carries it: per-tier lists keyed by TIER NAME, because a
 * rid is a session id and the next form's rows will have new ones.
 */
function seedMix(d) {
  var m = d.mix || defaultMix();
  var byName = {};
  (d.tiers || []).forEach(function (t) {
    if (m.perTier && m.perTier[t.rid] && t.name) byName[t.name] = copyRows(m.perTier[t.rid]);
  });
  return { applyToAll: m.applyToAll !== false, shared: copyRows(m.shared && m.shared.length ? m.shared : [defaultRow()]), perTierByName: byName };
}

/**
 * A seed's mix back onto a draft's tier rows. A seed written while a row was
 * a percentage off sticker (it carried `discountMix` rows with `percentOff`)
 * is not carried: 50 meant something else then, and a form that opened on the
 * old number would be a wrong bid wearing a familiar face. Those open on the
 * default single row.
 */
function mixFromSeed(sm, tiers) {
  var out = defaultMix();
  if (!sm || !sm.shared || !sm.shared.length) return out;
  var legacy = sm.shared.some(function (r) { return r && Object.prototype.hasOwnProperty.call(r, 'percentOff'); });
  if (legacy) return out;
  out.applyToAll = sm.applyToAll !== false;
  out.shared = copyRows(sm.shared);
  var byName = sm.perTierByName || {};
  (tiers || []).forEach(function (t) {
    if (byName[t.name] && byName[t.name].length) out.perTier[t.rid] = copyRows(byName[t.name]);
  });
  return out;
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
  d.tiers = withRids(s.tiers.map(function (t) { return { name: t.name, uploadMbps: t.uploadMbps, technology: t.technology, stickerPrice: t.stickerPrice, effectivePrice: t.effectivePrice, afterPrice: t.afterPrice }; }));
  d.reductionPresentation = s.reductionPresentation;
  d.mechanismLabel = s.mechanismLabel;
  d.mix = mixFromSeed(s.mix, d.tiers);
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
    tiers: [{ rid: newRid(), name: '500 Mbps', uploadMbps: '50', technology: 'cable', stickerPrice: '86', effectivePrice: '56', afterPrice: '69' }],
    reductionPresentation: 'member',
    mechanismLabel: '',
    /* One row carrying the whole reduction, applied to every tier. */
    mix: defaultMix(),
    guaranteeMonths: 24,
    afterMode: 'none',
    equipment: 'inc',
    rentalMonthly: '7',
    extraPodMonthly: '0',
    committedHouseholds: a.households || 1
  };
}

/**
 * The mix a sealed head carries, onto a draft's tier rows.
 *
 * The seal is the record: cents per tier, and whether one mix applied to all.
 * Hydration takes the shares and the mode back, matching tiers by name, so
 * reopening sealed terms shows the editor the partner used. A head from before
 * discount_mix existed carries only the derived label; that comes back as one
 * row wearing the label, a starting point rather than a claim about what was
 * sealed.
 */
function mixFromSealed(snap, tiers, m) {
  var out = defaultMix();
  if (!snap || !snap.tiers || !snap.tiers.length) {
    if (m && m.reductionPresentation === 'custom' && m.mechanismLabel) {
      out.shared = [{ type: 'own', label: m.mechanismLabel, sharePct: '100' }];
    }
    return out;
  }
  out.applyToAll = snap.applyToAll !== false;
  var first = null;
  snap.tiers.forEach(function (ts) {
    var rows = (ts.mix || []).map(function (r) {
      return { type: r.type, label: r.type === 'own' ? (r.label || '') : '', sharePct: String(r.sharePct || '') };
    });
    if (!rows.length) return;
    if (!first) first = rows;
    (tiers || []).forEach(function (t) { if (t.name === ts.tier) out.perTier[t.rid] = copyRows(rows); });
  });
  if (first) out.shared = copyRows(first);
  return out;
}

/** A draft prefilled from the sealed head, for the improve form. */
function draftFromBid(a, m) {
  var tiers = withRids((m.tiers || []).map(function (t) {
    return {
      name: t.name, uploadMbps: t.uploadMbps || '', technology: (t.technology || 'cable').toLowerCase(),
      stickerPrice: String(t.stickerPrice || ''), effectivePrice: String(t.effectivePrice || ''),
      afterPrice: t.afterPrice ? String(t.afterPrice) : ''
    };
  }));
  return {
    campaignId: a.id,
    improve: true,
    consent: false,
    error: null,
    tiers: tiers,
    reductionPresentation: m.reductionPresentation || 'member',
    mechanismLabel: m.mechanismLabel || '',
    mix: mixFromSealed(m.discountMix, tiers, m),
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
/**
 * The per-tier result for the tiers THIS bid won: the tier, this partner's
 * own price, how many households sat at that speed, and how many have
 * confirmed at it. Lost tiers are not listed beyond their absence, and
 * nothing here is another partner's: not how many bid a tier, not that a
 * price was matched.
 *
 * The fee line is N confirmed times the configured fee, capped at the
 * commitment ("your cap"), the same arithmetic the scenario table shows
 * before sealing. Over the commitment the overflow is said, not hidden: the
 * commitment is a soft signal and the partner serves every household that
 * confirmed.
 */
function wonTiersHTML(mine, fee) {
  var rows = mine.won || [];
  if (!rows.length) return '';
  var conf = Number(mine.confirmed || 0);
  var commit = mine.committedHouseholds != null ? Number(mine.committedHouseholds) : null;
  var served = commit != null ? Math.min(conf, commit) : conf;
  var f = Number(fee || 0);
  var body = rows.map(function (t) {
    return '<tr><td>' + esc(t.tier) + '</td>'
      + '<td class="num">' + (t.price != null ? money(String(t.price)) : '·') + '</td>'
      + '<td class="num">' + (t.demandCount != null ? t.demandCount : '·') + '</td>'
      + '<td class="num">' + (t.confirmed != null ? t.confirmed : '·') + '</td></tr>';
  }).join('');
  var feeLine = f
    ? '<p class="fnote" style="margin-top:8px">Success fees at your fee: <b>' + money(String(served * f)) + '</b>'
      + ' (' + served + ' × ' + money(String(f)) + (commit != null && served < conf ? ', your cap of ' + commit : '') + ')'
      + ', billed per completed switch only.'
      + (commit != null && conf > commit ? ' <b>' + conf + ' confirmed, ' + (conf - commit) + ' over your commitment.</b>' : '')
      + '</p>'
    : (commit != null && conf > commit
      ? '<p class="fnote" style="margin-top:8px"><b>' + conf + ' confirmed, ' + (conf - commit) + ' over your commitment of ' + commit + '.</b></p>'
      : '');
  return '<div class="twrap" style="margin-top:12px"><table class="tbl"><thead><tr>'
    + '<th>Speed you won</th><th class="num">Your price</th><th class="num">Households at this speed</th>'
    + '<th class="num">Confirmed</th></tr></thead><tbody>'
    + body + '</tbody></table></div>' + feeLine;
}

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
    /* The count is this org's own orders on this cohort, served on the bid by
       GET /provider/bids and memoized a minute server side. Zero is a real
       answer ("Won · 0 confirmed"), distinct from unknown. */
    var conf = mine.confirmed != null ? Number(mine.confirmed) : null;
    var wonLine = conf
      ? conf + ' households confirmed you. That’s ' + conf + ' installs to plan'
        + (fee ? ' and, at your fee, up to ' + money(String(conf * Number(fee))) + ' in success fees, billed per completed switch only' : '')
        + '.'
      : (conf === 0
        ? 'No household has confirmed you yet. Confirmations route to your delivery board.'
        : 'Household confirmations route to your delivery board.');

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
      + '<b>Won' + (conf != null ? ' · ' + conf + ' confirmed' : '') + '.</b> ' + wonLine + next + '</div>'
      + wonTiersHTML(mine, fee)
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
    var won = mine && (mine.tiersWon || []).length > 0;
    var decidedLine = '';
    if (mine && (mine.state === 'won' || mine.state === 'not_selected')) {
      decidedLine = won
        ? 'The lowest sealed bid won each speed, and yours took <b>' + esc(mine.tiersWon.join(', ')) + '</b>. '
        : 'The lowest sealed bid won each speed, and none of yours was the lowest at its speed. ';
    }
    return '<div class="tkt"><div class="dh">Bids closed</div><div class="receipt">'
      + (mine
        ? '<b>Your bid is in:</b> ' + bidLine(mine) + (mine.reference ? ' · Receipt ' + esc(mine.reference) : '') + '. '
        : '<b>You did not bid on this cohort.</b> ')
      + decidedLine
      + 'Offers are out to every household, individually. '
      + (won && mine.confirmed != null ? 'Confirmed so far: <b>' + Number(mine.confirmed) + '</b>. ' : '')
      + (d.decision_at ? 'Decisions lock ' + fmtDate(d.decision_at) + '; there' : 'There')
      + ' is nothing for you to do, and no way to see other bids.</div>'
      + (won ? wonTiersHTML(mine, data && data.brief && data.brief.successFee) : '')
      + '</div>';
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
 * The mix block: the editors on the left, the arithmetic on the right.
 *
 * Rendered always and hidden unless 'custom' is chosen, the same
 * hidden-attribute reveal the rental cell and the after column already use, so
 * a select change repaints from the draft rather than poking at the DOM, and
 * a mix typed, put away behind another read, and brought back is still there.
 *
 * The apply-to-all box comes first and spans the block: one editor when it is
 * ticked, one per tier row otherwise, in the order of the Price by service
 * table, each headed by its tier and its live reduction.
 */
function mixHTML(t) {
  var st = mixStatus(t);
  var all = isAll(t);
  var editors;
  if (all) {
    editors = mixEditorHTML('shared', rowsFor(t.mix, null), 'Your mix <em>applies to all tiers</em>', st);
  } else {
    editors = st.tiers.map(function (x) {
      var head = esc(x.tier.name || 'Tier') + (x.snap.gapCents > 0 ? ' <em>reduction ' + dollars(x.snap.gapCents) + ' /mo</em>' : '');
      if (x.snap.gapCents === 0) {
        return '<div class="mixed"><div class="mixhead">' + head + '</div>'
          + noteHTML('mixnote', 'Sticker and effective match on this tier, so there is no reduction to name.') + '</div>';
      }
      if (x.snap.gapCents < 0) {
        return '<div class="mixed"><div class="mixhead">' + head + '</div>'
          + noteHTML('mixerr', 'Effective price cannot sit above sticker on this tier. Fix the price row first.') + '</div>';
      }
      return mixEditorHTML(x.rid, rowsFor(t.mix, x.rid), head, st);
    }).join('');
  }
  return '<div class="mixw"' + (t.reductionPresentation === 'custom' ? '' : ' hidden') + '>'
    + '<label class="blk">Your mix <small class="lsub">one row per step, each a percentage of the reduction between sticker and effective</small></label>'
    + '<label class="consent mixall"><input type="checkbox" class="bmixall" data-action="ticket:mixall"' + (all ? ' checked' : '') + '>'
    + '<span>Apply this mix to all tiers</span></label>'
    + '<div class="mixgrid"><div>' + editors + '</div>'
    + '<div class="mixcalc"><div class="mixsum" aria-live="polite">' + mixSummaryHTML(t, st) + '</div></div></div></div>';
}

/** The dialog behind ticking apply-to-all: it replaces what was set per tier. */
function applyAllModalHTML(names) {
  var list = names.length > 1
    ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
    : (names[0] || 'this tier');
  return '<div class="mhead"><h3>Apply one mix to all tiers?</h3></div>'
    + '<p class="msub">This replaces the mix set on ' + esc(list) + ' with the shared mix. What you set per tier stays in this session until you seal, so unticking the box brings it back.</p>'
    + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">'
    + '<button class="btn" type="button" data-action="ticket:mixall-yes">Replace with one mix</button>'
    + '<button class="btn ghost" type="button" data-mclose>Keep per-tier mixes</button></div>';
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
    /* A custom mix seals only when its shares add up on every tier; the
       server refuses it otherwise, so the button says so first. */
    var ready = t.consent && mixOk(t);
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
    + reachHTML(a)
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

/** One editor's rows, as typed. Order is display order. */
function readRows(editor) {
  return $$('.mrow', editor).map(function (tr) {
    return {
      type: $('.mtype', tr).value,
      label: String(($('.mown', tr) || {}).value || '').trim(),
      sharePct: String($('.mamt', tr).value || '').trim()
    };
  });
}

/**
 * The mix state from the DOM, with the branch that is not on screen carried
 * from the previous draft: only the editors in force are rendered, and the
 * other branch is session memory so toggling the box restores it.
 */
function readMixState(form, prev) {
  var pm = prev && prev.mix ? prev.mix : null;
  var box = $('.bmixall', form);
  /* The shared list is carried as stored, not through rowsFor(): in per-tier
     mode rowsFor() answers per tier, and the shared mix has to survive that
     mode untouched so ticking the box brings back what was set. */
  var st = {
    applyToAll: box ? box.checked : (pm ? pm.applyToAll !== false : true),
    shared: pm && pm.shared && pm.shared.length ? copyRows(pm.shared) : [defaultRow()],
    perTier: {}
  };
  if (pm && pm.perTier) {
    for (var k in pm.perTier) {
      if (Object.prototype.hasOwnProperty.call(pm.perTier, k)) st.perTier[k] = copyRows(pm.perTier[k]);
    }
  }
  $$('.mixed[data-scope]', form).forEach(function (ed) {
    var scope = ed.getAttribute('data-scope');
    var rows = readRows(ed);
    if (!rows.length) return;
    if (scope === 'shared') st.shared = rows;
    else st.perTier[scope] = rows;
  });
  return st;
}

/** The rows a bid's single derived label is read from: the shared mix, or the first tier with one. */
function labelRows(tiers, mix) {
  if (!mix || mix.applyToAll !== false) return rowsFor(mix, null);
  for (var i = 0; i < tiers.length; i++) {
    var rows = mix.perTier && mix.perTier[tiers[i].rid];
    if (rows && rows.length) return rows;
  }
  return rowsFor(mix, null);
}

/**
 * The single label a custom bid carries beside its mix: the distinct line-item
 * names joined, stripped to the accepted charset, and cut back to the first
 * name if that runs long. readBid() still validates it as it always did; the
 * mix itself is the record and this is the display convenience.
 */
function mixLabel(rows) {
  var parts = [];
  (rows || []).forEach(function (r) {
    var n = rowLabel(r).replace(/[^A-Za-z0-9 ,.'&-]/g, '').trim();
    if (n && parts.indexOf(n) < 0) parts.push(n);
  });
  var joined = parts.join(', ');
  if (joined.length > 40) joined = parts[0] || '';
  return joined.slice(0, 40).trim();
}

/** The mix as the body sends it: shares per tier, the server does the money. */
function wireMix(d) {
  return {
    applyToAll: isAll(d),
    tiers: (d.tiers || []).map(function (t) {
      return { tier: t.name, rows: copyRows(rowsFor(d.mix, t.rid)) };
    })
  };
}

/**
 * DOM to draft. The DOM is the source of truth at submit time; the store's
 * copy exists so repaints between edits restore what was typed, and `prev`
 * is that copy, read for the mix branch the DOM is not showing.
 */
function readTicket(form, a, prev) {
  var bad = null;
  var tiers = $$('.trow', form).map(function (tr) {
    var stk = $('.tsticker', tr).value;
    var eff = $('.teff', tr).value;
    if (Number(eff) > Number(stk) && Number(stk) > 0) {
      bad = 'Effective price cannot sit above sticker on ' + $('.tname', tr).value + '.';
    }
    return {
      rid: tr.getAttribute('data-rid') || newRid(),
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
  var guar = parseInt($('.bguar', form).value, 10);
  var mix = readMixState(form, prev);
  var mechanismLabel = '';
  if (mech === 'custom') {
    var st = mixStatus({ tiers: tiers, mix: mix, guaranteeMonths: guar });
    if (!st.ok) bad = bad || st.problem;
    mechanismLabel = mixLabel(labelRows(tiers, mix));
  }

  var commitMax = a && a.households ? a.households : Infinity;
  var commit = parseInt($('.bcommit', form).value, 10) || 0;
  if (commit > commitMax) commit = commitMax;

  return {
    campaignId: a ? a.id : null,
    tiers: tiers,
    reductionPresentation: mech,
    mechanismLabel: mechanismLabel,
    mix: mix,
    guaranteeMonths: guar,
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
  if (!b.speedMix && !b.speedDemand) return;

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
    ['50 Mbps', '100 Mbps', '300 Mbps'].forEach(function (n) {
      var p = effOf(n);
      if (p != null && (c == null || p < c)) c = p;
    });
    return c;
  }
  var blend = 0, tot = 0;
  if (b.speedDemand) {
    /* Measured demand is per ladder tier, so the blend is this bid's price at
       each tier the cohort wants, weighted by how many want it. A tier this
       bid does not quote weighs nothing: the households there are not this
       partner's to serve at any price. */
    b.speedDemand.forEach(function (sx) {
      var p = effOf(sx[0]);
      if (p == null) return;
      tot += sx[1];
      blend += sx[1] * p;
    });
    if (!tot && d.tiers.length) { blend = Number(d.tiers[0].effectivePrice); tot = 1; }
  } else {
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
  }
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
 * The summary block is rewritten and each row's inline dollar figure and error
 * state are updated, but never the inputs themselves: a keystroke in a share
 * must not repaint the input it was typed into. The seal button follows the
 * same read, so a share corrected on the keyboard enables it without waiting
 * for a blur.
 */
export function refreshMix() {
  var form = $('.bidform');
  if (!form) return;
  var sum = $('.mixsum', form);
  if (!sum) return;
  var S = get();
  var id = form.getAttribute('data-bid');
  var prev = S.ticketDraft && S.ticketDraft.campaignId === id ? S.ticketDraft : null;
  var d = readTicket(form, campaignById(id), prev);
  var st = mixStatus(d);
  sum.innerHTML = mixSummaryHTML(d, st);
  $$('.mixed[data-scope]', form).forEach(function (ed) {
    var scope = ed.getAttribute('data-scope');
    var rows = scope === 'shared' ? rowsFor(d.mix, null) : rowsFor(d.mix, scope);
    var texts = amountTexts(scope, rows, st);
    var check = checkMix(rows);
    $$('.mrow', ed).forEach(function (tr, i) {
      var v = $('.mamtv', tr);
      if (v) v.textContent = texts[i] || '';
      if (check.rows[i] && check.rows[i].problem) tr.classList.add('bad');
      else tr.classList.remove('bad');
    });
  });
  var btn = $('[data-action="ticket:place"]', form);
  if (btn) btn.disabled = !(d.consent && mixOk(d));
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
  var prev = S.ticketDraft && S.ticketDraft.campaignId === a.id ? S.ticketDraft : null;
  var d = readTicket(form, a, prev);
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
    var rid = newRid();
    d.tiers.push({
      rid: rid,
      name: next, uploadMbps: SUGGUP[next] || '', technology: 'cable',
      stickerPrice: String(SUGGSTICKER[next] || ''), effectivePrice: String(SUGG[next] || ''),
      afterPrice: String(Math.round(((SUGG[next] || 0) + 13) * 2) / 2)
    });
    /* Under one shared mix the new tier inherits it by construction; under
       per-tier mixes it starts on the single row carrying the whole reduction. */
    if (!isAll(d)) d.mix.perTier[rid] = [defaultRow()];
    set('ticketDraft', d);
    refreshScn();
    refreshMix();
  });

  on('click', 'ticket:rm', function (el) {
    var d = draftFromForm(el);
    if (!d) return;
    /* The draft was read from the CURRENT DOM, where zero-priced rows are
       filtered out; remove by the row's rid rather than by index arithmetic
       over a filtered list. Its per-tier mix goes with it, so nothing orphaned
       reaches the seal. */
    var tr = el.closest('.trow');
    var rid = tr ? tr.getAttribute('data-rid') : null;
    var i = parseInt(el.getAttribute('data-i'), 10);
    d.tiers = d.tiers.filter(function (t, j) { return rid ? t.rid !== rid : j !== i; });
    if (!d.tiers.length) return;
    if (rid && d.mix.perTier) delete d.mix.perTier[rid];
    set('ticketDraft', d);
    refreshScn();
    refreshMix();
  });

  /** The list an editor's scope names, created on the draft if it has to be. */
  function scopeRows(d, scope) {
    if (scope === 'shared') {
      if (!d.mix.shared || !d.mix.shared.length) d.mix.shared = [defaultRow()];
      return d.mix.shared;
    }
    if (!d.mix.perTier[scope] || !d.mix.perTier[scope].length) d.mix.perTier[scope] = [defaultRow()];
    return d.mix.perTier[scope];
  }

  on('click', 'ticket:mixadd', function (el) {
    var d = draftFromForm(el);
    if (!d) return;
    var rows = scopeRows(d, el.getAttribute('data-scope') || 'shared');
    if (rows.length >= MIX_MAX_ROWS) return;
    /* The first row was locked at 100 while it stood alone; now both are
       editable and the shares have to be made to add up. */
    rows.push({ type: 'promo', label: '', sharePct: '' });
    set('ticketDraft', d);
    refreshMix();
  });

  on('click', 'ticket:mixrm', function (el) {
    var d = draftFromForm(el);
    if (!d) return;
    var scope = el.getAttribute('data-scope') || 'shared';
    var i = parseInt(el.getAttribute('data-i'), 10);
    var rows = scopeRows(d, scope).filter(function (r, j) { return j !== i; });
    if (!rows.length) return;
    /* Down to one row: it carries the whole reduction again. */
    if (rows.length === 1) rows[0].sharePct = '100';
    if (scope === 'shared') d.mix.shared = rows; else d.mix.perTier[scope] = rows;
    set('ticketDraft', d);
    refreshMix();
  });

  /* The apply-to-all box. Ticking it replaces every per-tier mix with the
     shared one, so it asks first, every time: the box is reverted until the
     dialog answers, and the draft does not move. Unticking needs no dialog,
     because nothing is lost: each tier opens on the mix it had in this
     session, or on a copy of the shared one if it never had its own. */
  on('change', 'ticket:mixall', function (el) {
    if (el.checked) {
      el.checked = false;
      var d = draftFromForm(el);
      if (!d) return;
      openModal(applyAllModalHTML(d.tiers.map(function (t) { return t.name; })));
      return;
    }
    var d2 = draftFromForm(el);
    if (!d2) return;
    d2.mix.applyToAll = false;
    d2.tiers.forEach(function (t) {
      if (!d2.mix.perTier[t.rid] || !d2.mix.perTier[t.rid].length) d2.mix.perTier[t.rid] = copyRows(d2.mix.shared);
    });
    set('ticketDraft', d2);
    refreshMix();
  });

  on('click', 'ticket:mixall-yes', function () {
    var form = $('.bidform');
    closeModal();
    if (!form) return;
    var d = draftFromForm(form);
    if (!d) return;
    d.mix.applyToAll = true;
    if (!d.mix.shared || !d.mix.shared.length) d.mix.shared = copyRows(labelRows(d.tiers, d.mix));
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

    var prev = S.ticketDraft && S.ticketDraft.campaignId === id ? S.ticketDraft : null;
    var d = readTicket(form, a, prev);
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
      /* Shares only. readBid() recomputes the cents with the same arithmetic
         the panel showed and seals the snapshot; nothing here sends money. */
      discountMix: d.reductionPresentation === 'custom' ? wireMix(d) : undefined,
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
         from the draft that was actually sealed, which carries the mix exactly
         as it was set, per tier or shared. */
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
