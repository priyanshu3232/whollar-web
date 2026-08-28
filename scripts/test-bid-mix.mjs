#!/usr/bin/env node
/* The custom mix through the server's own validation and wire shapes.
 *
 *   node --test scripts/test-bid-mix.mjs
 *
 * lib/bids.js readBid() is the gate every sealed bid passes, and the mix is
 * the one part of a bid whose money is COMPUTED there rather than copied
 * from the body. So this holds the three things a household record depends
 * on: shares in, cents out, the same cents the console showed; a mix that
 * does not total 100% refuses with the sentence the panel shows; and the
 * sealed object survives the head row and comes back out of publicBid()
 * unchanged, which is what lets the ticket hydrate from a seal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { backend } from './backend-module.mjs';

const bids = backend('lib/bids.js');

const TIERS = [
  { name: '300 Mbps', uploadMbps: '50', technology: 'cable', stickerPrice: '100', effectivePrice: '50', afterPrice: '' },
  { name: '100 Mbps', uploadMbps: '20', technology: 'cable', stickerPrice: '65', effectivePrice: '44', afterPrice: '' },
];
const ROWS = [{ type: 'member', label: '', sharePct: '70' }, { type: 'promo', label: '', sharePct: '30' }];

function body(over) {
  return Object.assign({
    tiers: TIERS,
    reductionPresentation: 'custom',
    mechanismLabel: 'Member discount, Promotional credit',
    discountMix: { applyToAll: true, tiers: TIERS.map((t) => ({ tier: t.name, rows: ROWS })) },
    guaranteeMonths: 24,
    afterMode: 'none',
    equipment: 'inc',
    extraPodMonthly: '0',
    committedHouseholds: 20,
  }, over || {});
}

test('a 70/30 mix seals as cents per tier, in ladder order, $35/$15 and $14.70/$6.30', () => {
  const d = bids.readBid(body(), 40);
  assert.equal(d.discountMix.applyToAll, true);
  /* readBid sorts tiers into ladder order; the mix follows the tiers. */
  assert.deepEqual(d.discountMix.tiers.map((t) => t.tier), ['100 Mbps', '300 Mbps']);
  const [t100, t300] = d.discountMix.tiers;
  assert.equal(t300.gapCents, 5000);
  assert.deepEqual(t300.mix.map((r) => r.amountCents), [3500, 1500]);
  assert.equal(t100.gapCents, 2100);
  assert.deepEqual(t100.mix.map((r) => r.amountCents), [1470, 630]);
  assert.deepEqual(t100.mix.map((r) => r.label), ['Member discount', 'Promotional credit']);
  assert.deepEqual(t100.mix.map((r) => [r.periodStartMo, r.periodEndMo]), [[0, 24], [0, 24]]);
  assert.equal(t100.mix.reduce((s, r) => s + r.amountCents, 0), t100.gapCents);
});

test('shares that miss 100% refuse with the panel copy, named to the tier', () => {
  const bad = body({ discountMix: { applyToAll: true, tiers: TIERS.map((t) => ({ tier: t.name, rows: [{ type: 'member', sharePct: '60' }, { type: 'promo', sharePct: '50' }] })) } });
  assert.throws(() => bids.readBid(bad, 40), /100 Mbps: Your mix adds to 110% of the reduction\. Remove 10%\./);
});

test('a custom bid with no mix at all refuses; a non-custom bid ignores any mix sent', () => {
  assert.throws(() => bids.readBid(body({ discountMix: undefined }), 40), /Set the mix/);
  const d = bids.readBid(body({ reductionPresentation: 'member', mechanismLabel: undefined }), 40);
  assert.equal(d.discountMix, null);
  assert.ok(!('discountMix' in JSON.parse(bids.draftPayload('kw', d))), 'and the payload bytes carry no mix key');
});

test('a tier with no reduction seals an empty mix and needs no rows', () => {
  const flat = TIERS.map((t) => (t.name === '100 Mbps' ? Object.assign({}, t, { effectivePrice: '65' }) : t));
  const d = bids.readBid(body({
    tiers: flat,
    discountMix: { applyToAll: false, tiers: [{ tier: '300 Mbps', rows: ROWS }] },
  }), 40);
  const t100 = d.discountMix.tiers.find((t) => t.tier === '100 Mbps');
  assert.equal(t100.gapCents, 0);
  assert.deepEqual(t100.mix, []);
  assert.equal(d.discountMix.applyToAll, false);
});

test('an own-worded row is held to the label rules households are protected by', () => {
  const rows = [{ type: 'member', sharePct: '50' }, { type: 'own', label: 'Expires soon rate', sharePct: '50' }];
  const bad = body({ discountMix: { applyToAll: true, tiers: TIERS.map((t) => ({ tier: t.name, rows })) } });
  assert.throws(() => bids.readBid(bad, 40), /pressure or a condition/);
  const unnamed = [{ type: 'member', sharePct: '50' }, { type: 'own', label: '', sharePct: '50' }];
  assert.throws(() => bids.readBid(body({ discountMix: { applyToAll: true, tiers: TIERS.map((t) => ({ tier: t.name, rows: unnamed })) } }), 40),
    /Give this discount a name households will see/);
});

test('the sealed mix is in the payload and comes back out of the head row through publicBid', () => {
  const d = bids.readBid(body(), 40);
  const payload = JSON.parse(bids.draftPayload('kw', d));
  assert.deepEqual(payload.discountMix, d.discountMix);
  const pub = bids.publicBid({
    campaign_id: 'kw', status: 'sealed', tiers: JSON.stringify(d.tiers),
    reduction_presentation: 'custom', mechanism_label: d.mechanismLabel,
    discount_mix: JSON.stringify(d.discountMix), guarantee_months: 24,
  });
  assert.deepEqual(pub.discountMix, d.discountMix);
  assert.equal(bids.publicBid({ campaign_id: 'kw', status: 'sealed', tiers: '[]' }).discountMix, null);
  assert.equal(bids.parseMix('not json'), null);
});

test('the column lists widen in order and the widest names discount_mix', () => {
  assert.ok(bids.BID_COLS_V3.includes('discount_mix'));
  assert.ok(!bids.BID_COLS_V2.includes('discount_mix'));
  assert.deepEqual(bids.BID_COLS_V3.slice(0, bids.BID_COLS_V2.length), [...bids.BID_COLS_V2]);
});
