#!/usr/bin/env node
/* The field-mapping layer, and the three defects it exists to fix.
 *
 *   node scripts/test-crm-fieldmap.mjs
 *
 * Each defect gets a test that would have failed before Phase 3c, because each
 * was invisible in a different way: a postal code silently dropped, a cohort
 * record that looked created and held nothing, and a Deal that failed on
 * mandatory fields and was dead after two attempts.
 */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const fm = require(join(ROOT, 'catalyst-backend/functions/crmSync/fieldmap.js'));
const { __test: t } = require(join(ROOT, 'catalyst-backend/functions/crmSync/index.js'));

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

console.log('\ncrm field map');

/* ---- DEFECT 1: Contacts use Mailing_*, never the Lead names ---- */
const hh = fm.mapFor('household', {
  first_name: 'Jane', last_name: 'Roy', email: 'j@e.ca', phone: '416',
  postal: 'M5S 2J7', province: 'ON', city: 'Toronto', fsa: 'M5S', has_referral: true,
}, 'u1');
ok(hh.fields.Mailing_Zip === 'M5S 2J7', 'the full postal code lands in Mailing_Zip');
ok(hh.fields.Mailing_State === 'ON', 'the province lands in Mailing_State');
ok(!('Zip_Code' in hh.fields) && !('State' in hh.fields),
  'the Lead field names are never sent to a Contact: this is what was silently losing the postal code');
ok(hh.fields.Whollar_Has_Referral === true, 'a checkbox is written even though false is falsy');
ok(fm.mapFor('household', {}, 'u2').fields.Whollar_Has_Referral === false, 'and false is written, not omitted');
ok(fm.mapFor('household', { email: 'a@b.ca' }, 'u3').fields.Last_Name === 'a@b.ca',
  'Last_Name is mandatory on Contacts and falls back to the email');

/* ---- DEFECT 2: a cohort is a populated record ---- */
const co = fm.mapFor('cohort', {
  campaign_id: 'toronto-west', region: 'Toronto West', sub: 'East end',
  stage: 'auction', target: 100, households: 44, fsas: 'M4C,M4E',
}, 'toronto-west');
ok(Object.keys(co.fields).length >= 7, 'a cohort maps to a populated record, not an id and a note');
ok(co.fields.Name === 'Toronto West', 'the mandatory Name is the region');
ok(co.fields.Whollar_Stage === 'auction' && co.fields.Whollar_Target === 100
   && co.fields.Whollar_FSAs === 'M4C,M4E', 'stage, target and the FSA list all land');
ok(typeof co.fields.Whollar_Target === 'number', 'a number field gets a number');

/* ---- DEFECT 3: Deals satisfy Zoho's mandatory fields on the first try ---- */
const created = fm.mapFor('switch_order', {
  order_key: 'tw:u1', order_no: 'ORD-1', state: 'acc', slot_at: '2026-09-14 09:00:00',
  tier: '500 Mbps', org_id: 'org1', campaign_id: 'tw',
}, 'tw:u1');
ok(created.fields.Deal_Name === 'ORD-1', 'a created order has Deal_Name');
ok(created.fields.Stage === 'Accepted', 'and a Stage');
ok(created.fields.Closing_Date === '2026-09-14', 'and a Closing_Date from the slot');

const activated = fm.mapFor('switch_order', {
  order_key: 'tw:u1', order_no: 'ORD-1', state: 'act',
  slot_at: '2026-09-14 09:00:00', activated_at: '2026-09-15 11:30:00', org_id: 'org1',
}, 'tw:u1');
ok(activated.fields.Stage === 'Closed Won', 'an activated order is Closed Won');
ok(activated.fields.Closing_Date === '2026-09-15', 'and closes on the activation date, not the slot');

const bare = fm.mapFor('switch_order', { order_key: 'tw:u1', state: 'rel' }, 'tw:u1');
ok(bare.fields.Deal_Name && bare.fields.Stage === 'Closed Lost' && /^\d{4}-\d{2}-\d{2}$/.test(bare.fields.Closing_Date),
  'an order with no dates at all still satisfies all three mandatory fields');
for (const [state, stage] of Object.entries(fm.STAGE)) {
  const m = fm.mapFor('switch_order', { order_key: 'k', state }, 'k');
  if (m.fields.Stage !== stage) ok(false, `state ${state} maps to ${stage}`);
}
ok(true, 'every one of the seven order states maps to a Deal stage');

/* ---- money never reaches a field ---- */
ok(!('Amount' in activated.fields), 'a Deal never carries an Amount, per D1 as amended');
const bid = fm.mapFor('sealed_bid', {
  org_id: 'org1', campaign_id: 'tw', event: 'revised', revision: 3, receipt: 'WHL-R-3',
  price: '58.00', tiers: [{ price: '58.00' }], discount_mix: '{}', commitment_cap: 400,
}, 'tw:org1');
ok(!JSON.stringify(bid.fields).includes('58.00'), 'a sealed bid map produces no price field, even when passed one');
ok(!Object.keys(bid.fields).some((k) => /price|amount|mix|cap/i.test(k)), 'and no money-shaped field name at all');

/* ---- the eight lookups ---- */
const mem = fm.mapFor('cohort_membership', {
  campaign_id: 'tw', status: 'joined', fsa: 'M5S', from_cohort: 'te',
}, 'tw:u1');
ok(mem.lookups.Whollar_Cohort.entity === 'cohort', 'a membership looks up its cohort');
ok(mem.lookups.Whollar_Household.id === 'u1', 'and derives the household from the membership key');
ok(mem.lookups.Whollar_From_Cohort.id === 'te', 'and carries the cohort it moved from');
ok(created.lookups.Contact_Name.id === 'u1', 'a Deal derives the household from the order key');
ok(created.lookups.Account_Name.entity === 'partner', 'and links the partner');
ok(fm.mapFor('partner_contact', { org_id: 'org1' }, 'u9').lookups.Account_Name.entity === 'partner',
  'a partner contact links to its Account');
ok(fm.householdIdFrom('tw:u1') === 'u1' && fm.householdIdFrom('nocolon') === null,
  'the key parser handles both shapes');

/* ---- lookups resolve to CRM record ids, not text ---- */
const cfg = t.config();
globalThis.fetch = async (url) => {
  const u = String(url);
  const found = { Cohorts: 'crm-cohort-9', Contacts: 'crm-contact-7' };
  const mod = Object.keys(found).find((m) => u.includes(`/${m}/search`));
  return {
    ok: true, status: mod ? 200 : 204,
    json: async () => (mod ? { data: [{ id: found[mod] }] } : {}),
    text: async () => '', headers: { get: () => null },
  };
};
const ctx = { cfg, token: 'x', apiDomain: 'https://www.zohoapis.ca', refresh: async () => {} };
const links = await t.resolveLookups(ctx, {
  Whollar_Cohort: { entity: 'cohort', id: 'tw' },
  Whollar_Household: { entity: 'household', id: 'u1' },
});
ok(links.Whollar_Cohort === 'crm-cohort-9' && links.Whollar_Household === 'crm-contact-7',
  'a membership links to real CRM record ids, not to text');

/* A parent that is not there yet waits rather than writing an orphan. */
globalThis.fetch = async () => ({ ok: true, status: 204, json: async () => ({}), text: async () => '', headers: { get: () => null } });
let threw = null;
try { await t.resolveLookups(ctx, { Whollar_Cohort: { entity: 'cohort', id: 'missing' } }); } catch (e) { threw = e; }
ok(threw && threw.missingParent === true, 'a parent not in CRM throws missingParent rather than writing unattached');
ok(t.classify(threw).kind === 'parent', 'which classifies as a parent wait, capped at three');

/* ---- undroppable ---- */
ok(fm.undroppable('switch_order').includes('Deal_Name'), 'Deal_Name cannot be dropped');
ok(fm.undroppable('switch_order').includes('Contact_Name'), 'nor can a lookup: dropping one writes an orphan');
ok(!fm.undroppable('household').includes('Mailing_Zip'), 'while a postal code is still droppable');
/* The locked list is declared, not probed: every lookup is conditional on the
   payload, so an empty probe reports none of them and would protect nothing.
   This asserts the declaration has not drifted from the maps.
 
   LOOKUPS ONLY, deliberately. `always` means "written even when the value is
   falsy", which is why a checkbox lives there, and that is a different property
   from "may not be dropped". Conflating them locks a referral flag for no
   reason and teaches the next reader the wrong rule. */
for (const [entity, locked] of Object.entries(fm.LOCKED)) {
  const shape = fm.MAPS[entity]({ org_id: 'x', campaign_id: 'x', from_cohort: 'x',
    winning_partner: 'x', order_key: 'a:b' }, 'a:b');
  const missed = Object.keys(shape.lookups || {}).filter((f) => !locked.includes(f));
  if (missed.length) ok(false, `${entity} has unlocked lookups: ${missed.join(', ')}`);
}
ok(true, 'every lookup in every map is on the locked list');
for (const f of ['Deal_Name', 'Stage', 'Closing_Date']) {
  if (!fm.LOCKED.switch_order.includes(f)) ok(false, `${f} must be locked: Zoho refuses a Deal without it`);
}
ok(true, "Zoho's three mandatory Deal fields are locked");
ok(t.isRequired('Deal_Name', cfg, 'switch_order'), 'and the worker agrees');
ok(!t.isRequired('Whollar_FSA', cfg, 'switch_order'), 'for the fields that matter only');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
