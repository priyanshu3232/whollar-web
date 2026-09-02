#!/usr/bin/env node
/* The allowlist, one entity at a time.
 *
 *   node scripts/test-crm-serialisers.mjs
 *
 * D2 as amended makes these serialisers THE control on what leaves Catalyst, so
 * they are tested by FIELD LIST EQUALITY, not by spot check. Asserting that a
 * price is absent catches the price; asserting the whole key set catches the
 * field nobody thought to look for, which is the one that gets you.
 */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { serialise, ENTITY_TYPES } = require(
  join(ROOT, 'catalyst-backend/functions/auth/src/lib/crm/serialisers'));

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };
const keys = (o) => Object.keys(o).sort().join(',');

console.log('\ncrm serialisers');

ok(ENTITY_TYPES.length === 8, 'eight entity types, one serialiser each');

/* An unknown entity is refused, never passed through. Passing a payload through
   because nobody wrote a serialiser yet is the exact failure this prevents. */
ok(serialise('not_an_entity', { anything: 1 }) === null, 'an unknown entity serialises to null, not to the payload');

/* ---- D3: a sealed bid, by field list equality ---- */
const bid = serialise('sealed_bid', {
  org_id: 'org1', org_name: 'Northline', campaign_id: 'tw', region: 'Toronto West',
  event: 'revised', revision: 3, receipt: 'WHL-R-1', tier_count: 4, submitted_at: '2026-09-01',
  /* Everything below is real data the call site has in hand and must never send. */
  price: '58.00', tiers: [{ tier: '500', price: '58.00' }], discount_mix: '{}',
  guarantee_months: 24, equipment: 'inc', commitment_cap: 400, payload_hash: 'abc',
  rental_monthly: '9.99', after_line: 'x', mechanism_label: 'y',
});
ok(keys(bid) === 'campaign_id,event,org_id,org_name,receipt,region,revision,submitted_at,tier_count',
  'a sealed bid is exactly the nine permitted fields, no more');
ok(!JSON.stringify(bid).includes('58.00'), 'and no price survives anywhere in it');

/* ---- D2: a household ---- */
const hh = serialise('household', {
  first_name: 'Jane', last_name: 'Roy', email: 'j@e.ca', phone: '416', postal: 'M5S 2J7',
  fsa: 'M5S', province: 'ON', city: 'Toronto', provider: 'Bell', speed_tier: '500',
  cohort_status: 'joined', user_type: 'member', referred_by: 'WHL-1a2b3c4d', pooling_for: 'tires',
  street_address: '12 Elm St', unit: '4', bill_url: 'x', password_hash: 'y', internal_score: 9,
});
ok(keys(hh) === 'city,cohort_status,email,first_name,fsa,has_referral,last_name,'
  + 'phone,pooling_for,postal,provider,province,speed_tier,user_type',
  'a household is exactly the D2 allowlist, plus the product asked for on /join');
ok(hh.pooling_for === 'tires', 'the product asked for on /join leaves as itself');
ok(hh.has_referral === true, 'a referral becomes presence');
ok(!('referred_by' in hh), 'and the token itself does not leave');
ok(serialise('household', {}).has_referral === false, 'no referral is false, not absent');

/* Amendment 1's named case: a column added tomorrow. */
const later = serialise('household', { first_name: 'Jane', newly_added_column: 'anything at all' });
ok(!('newly_added_column' in later), 'a field added to households later cannot reach CRM until it is named here');

/* ---- a switch order carries no money and no address ---- */
const so = serialise('switch_order', {
  order_key: 'tw:u1', order_no: 'ORD-1', campaign_id: 'tw', org_id: 'org1', state: 'act',
  tier: '500 Mbps', fsa: 'M5S', activated_at: '2026-09-01',
  price: '65.00', amount: 95, address_line: '12 Elm St', phone: '+14165550134',
});
ok(!('price' in so) && !('amount' in so), 'a switch order carries no money, per D1 as amended');
ok(!('address_line' in so) && !('phone' in so), 'and neither the install address nor the mobile');
ok(so.tier === '500 Mbps' && so.state === 'act', 'while keeping the pipeline facts');

/* ---- a settlement carries no amounts either ---- */
const st = serialise('settlement', { statement_key: 's1', org_id: 'org1', state: 'issued',
  amount: 4750, amount_cents: 475000, total: '4750.00' });
ok(!Object.keys(st).some((k) => /amount|total|cents/i.test(k)),
  'a settlement carries no amounts: deferred to the billing build');

/* ---- a partner carries no rate ---- */
const pr = serialise('partner', { org_id: 'o', org_name: 'N', approval_status: 'approved',
  lead_rate: 120, success_fee: 95 });
ok(!('lead_rate' in pr) && !('success_fee' in pr), 'a partner carries no rate and no fee');

/* ---- undefined is dropped, null is an answer ---- */
const cm = serialise('cohort_membership', { campaign_id: 'tw', status: 'joined' });
ok(!Object.values(cm).includes(undefined), 'no undefined reaches the wire');
ok(cm.exit_at === null, 'but a known-empty field stays as null');

/* ---- every serialiser is total: no input makes one throw ---- */
let threw = null;
for (const e of ENTITY_TYPES) {
  for (const input of [{}, { a: 1 }, { nested: { deep: { deeper: 1 } } }]) {
    try { serialise(e, input); } catch (err) { threw = `${e}: ${err.message}`; }
  }
}
ok(threw === null, `no serialiser throws on odd input${threw ? `: ${threw}` : ''}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
