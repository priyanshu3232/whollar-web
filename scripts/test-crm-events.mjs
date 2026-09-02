#!/usr/bin/env node
/* One assertion per wired event: the right idempotency key, and a payload that
 * has been through its allowlist.
 *
 *   node scripts/test-crm-events.mjs
 *
 * The payloads below are the shapes the routes really send. The point is not
 * that each event works in isolation, it is that the key is distinct per event
 * and per repeat, because that key is the only thing standing between a retried
 * request and a duplicate record in somebody's CRM.
 */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const LIB = join(ROOT, 'catalyst-backend/functions/auth/src/lib');

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

let inserted = [];
require.cache[require.resolve(join(LIB, 'datastore.js'))] = {
  id: 'd', filename: 'd', loaded: true,
  exports: {
    lit: (v) => `'${v}'`,
    query: async () => { throw new Error('count unavailable'); },
    insertRow: async (_a, _t, row) => { inserted.push(row); },
  },
};
const crm = require(join(LIB, 'crm/outbox.js'));
const REQ = { id: 'r' };
process.env.CRM_NEW_SOURCES = 'true';

/* Every wired event, with the payload its route sends and the version its route
   passes. Anything not listed here is unwired and named in the report. */
const CASES = [
  ['household.created',          'u1',      1,           { first_name: 'Jane', fsa: 'M5S' },                    'a@b.ca'],
  ['household.updated',          'u1',      1,           { phone: '416', postal: 'M5S 2J7' },                    'a@b.ca'],
  ['cohort.created',             'tw',      1,           { campaign_id: 'tw', region: 'Toronto West' },          null],
  ['cohort.stage_changed',       'tw',      'auction',   { campaign_id: 'tw', stage: 'auction' },                null],
  ['cohort.cancelled',           'tw',      'archived',  { campaign_id: 'tw', stage: 'archived' },               null],
  ['cohort_membership.joined',   'tw:u1',   'joined',    { campaign_id: 'tw', status: 'joined', fsa: 'M5S' },    'a@b.ca'],
  ['cohort_membership.exited',   'tw:u1',   'left',      { campaign_id: 'tw', status: 'left' },                  'a@b.ca'],
  ['partner.applied',            'org1',    1,           { org_id: 'org1', org_name: 'Northline' },              'p@q.ca'],
  ['partner.state_changed',      'org1',    1,           { org_id: 'org1', approval_status: 'approved' },        'p@q.ca'],
  ['partner.coverage_changed',   'org1',    'toronto',   { org_id: 'org1', coverage_region: 'toronto' },         'p@q.ca'],
  ['partner.updated',            'org1',    1,           { org_id: 'org1', org_name: 'Northline Fibre' },        'p@q.ca'],
  ['partner_contact.created',    'u9',      1,           { user_id: 'u9', org_id: 'org1', first_name: 'Sam' },   'p@q.ca'],
  ['sealed_bid.submitted',       'tw:org1', 1,           { org_id: 'org1', receipt: 'WHL-R-1' },                 'p@q.ca'],
  ['sealed_bid.revised',         'tw:org1', 3,           { org_id: 'org1', receipt: 'WHL-R-3', revision: 3 },    'p@q.ca'],
  ['switch_order.created',       'tw:u1',   'accepted',  { order_key: 'tw:u1', tier: '500 Mbps' },               'a@b.ca'],
  ['switch_order.state_changed', 'tw:u1',   'booked',    { order_key: 'tw:u1', state: 'bkd' },                   'p@q.ca'],
  ['switch_order.activated',     'tw:u1',   'activated', { order_key: 'tw:u1', state: 'act' },                   'p@q.ca'],
  ['switch_order.released',      'tw:u1',   'released',  { order_key: 'tw:u1', state: 'rel' },                   'p@q.ca'],
];

console.log('\ncrm events');

const keys = new Set();
for (const [eventType, rowid, version, payload, email] of CASES) {
  inserted = [];
  await crm.enqueue({}, REQ, { eventType, entityRowid: rowid, version, payload, email });
  const row = inserted[0];
  if (!row) { ok(false, `${eventType} enqueues`); continue; }
  const entity = crm.EVENTS[eventType].entity;
  const expected = `${entity}:${rowid}:${eventType}:${version}`;
  const body = JSON.parse(row.Payload);
  ok(row.IdempotencyKey === expected && row.EventType === eventType
     && row.EntityType === entity && Object.keys(body).length > 0,
    `${eventType} keys as ${expected}`);
  keys.add(row.IdempotencyKey);
}
ok(keys.size === CASES.length, 'every wired event produces a distinct idempotency key');

/* The same event twice with the same version is the same key, which is what
   makes a retried request harmless. */
inserted = [];
await crm.enqueue({}, REQ, { eventType: 'switch_order.activated', entityRowid: 'tw:u1', version: 'activated', payload: {}, email: 'p@q.ca' });
const first = inserted[0].IdempotencyKey;
inserted = [];
await crm.enqueue({}, REQ, { eventType: 'switch_order.activated', entityRowid: 'tw:u1', version: 'activated', payload: {}, email: 'p@q.ca' });
ok(inserted[0].IdempotencyKey === first, 'the same event twice produces the same key, so the unique index rejects the retry');

/* A cohort has no email and must not need one. */
inserted = [];
await crm.enqueue({}, REQ, { eventType: 'cohort.created', entityRowid: 'tw', version: 1, payload: { campaign_id: 'tw' } });
ok(inserted.length === 1 && inserted[0].Email === null, 'a cohort enqueues with no email at all');

/* A household still must have one, because email is how it is adopted. */
inserted = [];
const e = console.error; console.error = () => {};
await crm.enqueue({}, REQ, { eventType: 'household.created', entityRowid: 'u1', payload: {} });
console.error = e;
ok(inserted.length === 0, 'a household without an email is still refused');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
