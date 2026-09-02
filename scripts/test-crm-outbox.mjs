#!/usr/bin/env node
/* The CRM outbox, checked against its four rules.
 *
 *   node scripts/test-crm-outbox.mjs
 *
 * No Catalyst, no network: insertRow goes through a fake datastore that records
 * the row it was handed, which is the only thing worth asserting here.
 *
 * The rules are stated at the top of lib/crm/outbox.js, and each is a rule
 * because breaking it is invisible in production: a throw from a mirror fails a
 * signup, a field that escapes the allowlist is only found by whoever reads the
 * CRM, an unparked row ships before anyone decided it should, and a typo'd event
 * name inserts perfectly happily.
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
let explode = false;
let failNewColumns = false;
require.cache[require.resolve(join(LIB, 'datastore.js'))] = {
  id: 'datastore', filename: 'datastore', loaded: true,
  exports: {
    lit: (v) => `'${String(v).replace(/'/g, "''")}'`,
    query: async () => { throw new Error('no such column'); },
    insertRow: async (_app, table, row) => {
      if (explode) throw new Error('data store unreachable');
      /* Simulates the console not having the new columns yet, which is the
         state every deployment is in until someone adds them by hand. */
      if (failNewColumns && 'EntityType' in row) throw new Error('unknown column EntityType');
      inserted.push({ table, row });
    },
  },
};

const crm = require(join(LIB, 'crm/outbox.js'));
const REQ = { id: 'req-test' };
const quiet = (fn) => { const e = console.error; console.error = () => {}; return fn().finally(() => { console.error = e; }); };
const reset = () => { inserted = []; explode = false; failNewColumns = false; };
const row = () => inserted[0].row;
const payload = () => JSON.parse(inserted[0].row.Payload);

console.log('\ncrm outbox');

/* ---- rule 3: parked until an operator says otherwise ---- */
reset();
delete process.env.CRM_NEW_SOURCES;
await crm.enqueue({}, REQ, { eventType: 'household.created', entityRowid: 'u1', email: 'a@b.ca' });
ok(inserted.length === 1, 'writes a row');
ok(row().Status === 'PARKED', 'defaults to PARKED, invisible to the drain');
process.env.CRM_NEW_SOURCES = 'true';
reset();
await crm.enqueue({}, REQ, { eventType: 'household.created', entityRowid: 'u1', email: 'a@b.ca' });
ok(row().Status === 'PENDING', 'CRM_NEW_SOURCES=true releases new rows');
reset();
process.env.CRM_NEW_SOURCES = 'TRUE';
await crm.enqueue({}, REQ, { eventType: 'household.created', entityRowid: 'u1', email: 'a@b.ca' });
ok(row().Status === 'PARKED', 'the flag is exact: TRUE is not true');
delete process.env.CRM_NEW_SOURCES;

/* ---- the event catalogue and the columns it fills ---- */
reset();
await crm.enqueue({}, REQ, { eventType: 'sealed_bid.revised', entityRowid: 'tw:org1',
  version: 3, email: 'p@q.ca', leadType: 'partner', payload: { org_id: 'org1', revision: 3 } });
ok(row().EventType === 'sealed_bid.revised', 'EventType carries the catalogue name');
ok(row().EntityType === 'sealed_bid', 'EntityType comes from the catalogue, not the caller');
ok(row().Source === 'SealedBids', 'Source still carries the legacy routing key');
ok(row().IdempotencyKey === 'sealed_bid:tw:org1:sealed_bid.revised:3', 'the idempotency key is entity, row, event, version');
ok(row().LeadType === 'partner', 'partner rows are marked partner');
ok(row().Attempts === 0, 'Attempts starts at 0');

/* Two revisions a second apart must not collide on the key. */
reset();
await crm.enqueue({}, REQ, { eventType: 'sealed_bid.revised', entityRowid: 'tw:org1', version: 4, email: 'p@q.ca' });
ok(row().IdempotencyKey.endsWith(':4'), 'an explicit version distinguishes a genuine second event');

/* ---- rule 2: the allowlist is the control ---- */
reset();
await crm.enqueue({}, REQ, {
  eventType: 'household.updated', entityRowid: 'u1', email: 'c@d.ca',
  payload: {
    first_name: 'Jane', postal: 'M5S 2J7', fsa: 'M5S',
    /* Amendment 1: a column a developer adds tomorrow and spreads into a
       payload without thinking. It is on no allowlist, so it does not exist. */
    street_address: '12 Elm St',
    secret_internal_score: 91,
    bill_upload_url: 'https://example.invalid/bill.pdf',
    referred_by: 'WHL-1a2b3c4d',
  },
});
const p = payload();
ok(p.first_name === 'Jane' && p.postal === 'M5S 2J7', 'allowlisted fields survive');
ok(!('street_address' in p), 'a fake column never reaches the outbox row');
ok(!('secret_internal_score' in p), 'nor does an unnamed internal field');
ok(!('bill_upload_url' in p), 'nor does a document link');
ok(!('referred_by' in p), 'the referral code stops at the allowlist');
ok(p.has_referral === true, 'and becomes a boolean, per D2');

/* The backstop still bites on the serialiser's own output. */
ok(!('address' in crm.scrub({ address: '12 Elm St', keep: 1 })), 'the scrub drops an address a serialiser wrongly named');
ok(crm.scrub({ token: 'x' }).token === '[redacted]', 'and redacts a secret by key name');
ok(crm.scrub({ note: 'the partner asked to move the window' }).note.length > 10, 'while leaving prose alone');

/* A sealed bid carries no price, whatever the call site sends. D3. */
reset();
await crm.enqueue({}, REQ, { eventType: 'sealed_bid.submitted', entityRowid: 'tw:org1', version: 1,
  email: 'p@q.ca', payload: { org_id: 'org1', receipt: 'WHL-R-1', price: '58.00', tiers: [{ price: '58.00' }] } });
ok(!/58\.00/.test(inserted[0].row.Payload), 'a sealed bid payload carries NO price, even when one is passed');
ok(payload().receipt === 'WHL-R-1', 'but it does carry the receipt');

/* A switch order carries no price and no address either. */
reset();
await crm.enqueue({}, REQ, { eventType: 'switch_order.activated', entityRowid: 'tw:u1', version: 'activated',
  email: 'p@q.ca', payload: { order_key: 'tw:u1', tier: '500 Mbps', price: '65.00', address_line: '12 Elm St', fsa: 'M5S' } });
ok(!('price' in payload()), 'a switch order carries no price');
ok(!('address_line' in payload()), 'and no address');
ok(payload().tier === '500 Mbps' && payload().fsa === 'M5S', 'while keeping what CRM is for');

/* ---- rule 4: an unknown event is refused, not written ---- */
reset();
let threw = false;
await quiet(() => crm.enqueue({}, REQ, { eventType: 'not.a.real.event', email: 'a@b.ca' })).catch(() => { threw = true; });
ok(!threw && inserted.length === 0, 'an unknown event type is refused without throwing');

reset(); threw = false;
await quiet(() => crm.enqueue({}, REQ, { eventType: 'household.created' })).catch(() => { threw = true; });
ok(!threw && inserted.length === 0, 'a missing email is refused without throwing');

/* ---- rule 1: never throw into the request path ---- */
reset(); explode = true; threw = false;
await quiet(() => crm.enqueue({}, REQ, { eventType: 'household.created', email: 'a@b.ca' })).catch(() => { threw = true; });
ok(!threw, 'a dead data store does not reach the caller');

reset(); explode = true;
let asyncThrew = false;
process.on('unhandledRejection', () => { asyncThrew = true; });
crm.enqueueAsync({}, REQ, { eventType: 'household.created', email: 'a@b.ca' });
await new Promise((r) => setTimeout(r, 20));
ok(!asyncThrew, 'enqueueAsync leaves no unhandled rejection');

/* ---- the column ladder ---- */
reset(); failNewColumns = true;
await quiet(() => crm.enqueue({}, REQ, { eventType: 'household.created', entityRowid: 'u1', email: 'a@b.ca' }));
ok(inserted.length === 1, 'a console without the new columns still gets the row');
ok(!('EntityType' in row()), 'written in the legacy shape');
ok(row().Source === 'MemberSignups' && row().Status === 'PARKED', 'with everything the deployed drainer needs');

/* ---- payload size ---- */
reset();
await crm.enqueue({}, REQ, { eventType: 'cohort_membership.joined', entityRowid: 'x', version: 1, email: 'a@b.ca',
  payload: { region: 'r'.repeat(30000) } });
ok(JSON.parse(row().Payload).oversize === true || row().Payload.length < 25000,
  'an oversize payload becomes a marker, never a truncated JSON string');

/* ---- the two lists are one list ---- */
const worker = require('node:fs').readFileSync(
  join(ROOT, 'catalyst-backend/functions/crmSync/index.js'), 'utf8');
const sources = [...new Set(Object.values(crm.EVENTS).map((e) => e.source))];
const hasDescriptor = (name) =>
  new RegExp(`(^|[\\s,{])${name}\\s*:`, 'm').test(worker) || worker.includes(`'${name}'`);
const missing = sources.filter((x) => !hasDescriptor(x));
ok(missing.length === 0,
  `every Source in the catalogue has a descriptor in crmSync${missing.length ? `: missing ${missing.join(', ')}` : ''}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
