#!/usr/bin/env node
/* The auth function's CRM enqueue helper, checked against its own three rules.
 *
 *   node scripts/test-crmqueue.mjs
 *
 * No Catalyst, no network: `insertRow` goes through a fake datastore that
 * records the row it was handed, which is the only thing worth asserting here.
 * The rules under test are the ones stated at the top of lib/crmqueue.js, and
 * each is a rule precisely because breaking it is invisible in production: a
 * throw from a marketing queue fails a signup, a leaked address is only found
 * by whoever reads the CRM, and an unparked note ships before anyone meant it.
 */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const LIB = join(ROOT, 'catalyst-backend/functions/auth/src/lib');

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

/* A datastore that records instead of storing, and can be told to explode. */
let inserted = [];
let explode = false;
require.cache[require.resolve(join(LIB, 'datastore.js'))] = {
  id: 'datastore', filename: 'datastore', loaded: true,
  exports: {
    insertRow: async (_app, table, row) => {
      if (explode) throw new Error('data store unreachable');
      inserted.push({ table, row });
    },
  },
};

const crm = require(join(LIB, 'crmqueue.js'));
const REQ = { id: 'req-test' };
const quiet = (fn) => { const e = console.error; console.error = () => {}; return fn().finally(() => { console.error = e; }); };
const reset = () => { inserted = []; explode = false; };

console.log('\ncrmqueue');

/* ---- rule 3: parked until an operator says otherwise ---- */
reset();
delete process.env.CRM_NEW_SOURCES;
await crm.enqueue({}, REQ, { source: crm.SOURCES.MEMBER_SIGNUP, email: 'a@b.ca', rowId: 'u1' });
ok(inserted.length === 1, 'writes a row');
ok(inserted[0].table === 'CrmSyncQueue', 'writes to CrmSyncQueue');
ok(inserted[0].row.Status === 'PARKED', 'defaults to PARKED, invisible to the drain');

reset();
process.env.CRM_NEW_SOURCES = 'true';
await crm.enqueue({}, REQ, { source: crm.SOURCES.MEMBER_SIGNUP, email: 'a@b.ca' });
ok(inserted[0].row.Status === 'PENDING', 'CRM_NEW_SOURCES=true releases new notes');

reset();
process.env.CRM_NEW_SOURCES = 'TRUE';
await crm.enqueue({}, REQ, { source: crm.SOURCES.MEMBER_SIGNUP, email: 'a@b.ca' });
ok(inserted[0].row.Status === 'PARKED', 'the flag is exact: TRUE is not true');
delete process.env.CRM_NEW_SOURCES;

/* ---- rule 2: the install address never leaves ---- */
reset();
await crm.enqueue({}, REQ, {
  source: crm.SOURCES.HOUSEHOLD_ORDER, email: 'c@d.ca', leadType: 'consumer',
  data: { campaign: 'toronto-west', tier: '500 Mbps', price: '65.00',
    address_line: '12 Elm St, Apt 4', unit: '4', install_phone: '+14165550134',
    nested: { address: '12 Elm St', slot_at: '2026-09-14 09:00' } },
});
const p = JSON.parse(inserted[0].row.Payload);
ok(!('address_line' in p), 'address_line is stripped');
ok(!('unit' in p), 'unit is stripped');
ok(!('install_phone' in p), 'install_phone is stripped');
ok(!('address' in p.nested), 'a nested address is stripped too');
ok(p.nested.slot_at === '2026-09-14 09:00', 'the appointment time survives');
ok(p.tier === '500 Mbps' && p.price === '65.00', 'what CRM is for survives');

/* ---- rule 1: never throw into the request path ---- */
reset();
let threw = false;
await quiet(() => crm.enqueue({}, REQ, { source: 'NotARealSource', email: 'a@b.ca' })).catch(() => { threw = true; });
ok(!threw && inserted.length === 0, 'an unknown source is refused without throwing');

reset();
threw = false;
await quiet(() => crm.enqueue({}, REQ, { source: crm.SOURCES.MEMBER_SIGNUP })).catch(() => { threw = true; });
ok(!threw && inserted.length === 0, 'a missing email is refused without throwing');

reset(); explode = true; threw = false;
await quiet(() => crm.enqueue({}, REQ, { source: crm.SOURCES.MEMBER_SIGNUP, email: 'a@b.ca' })).catch(() => { threw = true; });
ok(!threw, 'a dead data store does not reach the caller');

reset(); explode = true;
let asyncThrew = false;
process.on('unhandledRejection', () => { asyncThrew = true; });
crm.enqueueAsync({}, REQ, { source: crm.SOURCES.MEMBER_SIGNUP, email: 'a@b.ca' });
await new Promise((r) => setTimeout(r, 20));
ok(!asyncThrew, 'enqueueAsync leaves no unhandled rejection');

/* ---- payload discipline ---- */
reset();
await crm.enqueue({}, REQ, { source: crm.SOURCES.SEALED_BID, email: 'e@f.ca', leadType: 'partner',
  /* Many small values rather than one long run: audit.scrub treats a 40+
     character unbroken token as a secret and redacts it, so a single huge
     string never reaches the size check at all. */
  data: { rows: Array.from({ length: 900 }, (_, i) => ({ tier: `tier ${i}`, price: '65.00' })) } });
ok(JSON.parse(inserted[0].row.Payload).oversize === true, 'an oversize payload is a marker, not a truncated string');
ok(inserted[0].row.Payload.length < 200, 'and the marker is small');

reset();
await crm.enqueue({}, REQ, { source: crm.SOURCES.SEALED_BID, email: 'e@f.ca', leadType: 'partner',
  data: { receipt: 'WHL-123', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
const bid = JSON.parse(inserted[0].row.Payload);
ok(bid.receipt === 'WHL-123', 'a receipt number is kept');
ok(bid.token === '[redacted]', 'a secret is redacted, by key name');
ok(inserted[0].row.LeadType === 'partner', 'partner rows are marked partner');

reset();
await crm.enqueue({}, REQ, { source: crm.SOURCES.MEMBER_SIGNUP, email: 'a@b.ca', leadType: 'nonsense' });
ok(inserted[0].row.LeadType === 'consumer', 'an unknown lead type falls back to consumer');
ok(inserted[0].row.Attempts === 0, 'Attempts starts at 0');

/* ---- lists arrive whole: the reason this file does not use audit.scrub ---- */
reset();
await crm.enqueue({}, REQ, { source: crm.SOURCES.COHORT_AWARD, email: 'g@h.ca', leadType: 'partner',
  data: { tiers: Array.from({ length: 30 }, (_, i) => `tier ${i}`),
    /* Real prose, not a run of one letter: an unbroken 40+ character
       alphanumeric string is a base64url token by shape and is redacted, which
       is the intended behaviour and makes filler a bad fixture. */
    note: 'the partner asked to move the install window. '.repeat(14),
    deep: { a: { b: { c: { d: { e: 'still here' } } } } } } });
const award = JSON.parse(inserted[0].row.Payload);
ok(award.tiers.length === 30, 'a 30 item list is not cut to 20');
ok(award.note.length > 500, 'a long note is not cut to 500 characters');
ok(award.deep.a.b.c.d.e === 'still here', 'five levels down is not flattened to [deep]');

/* ---- the two source lists are one list ---- */
const worker = require('node:fs').readFileSync(
  join(ROOT, 'catalyst-backend/functions/crmSync/index.js'), 'utf8');
/* A descriptor is a bare object key (`MemberSignups: {`), not a quoted
   string, so look for the key form as well or this reports every source
   missing while all twelve are present. */
const hasDescriptor = (name) =>
  new RegExp(`(^|[\\s,{])${name}\\s*:`, 'm').test(worker) || worker.includes(`'${name}'`);
const known = crm.SOURCE_VALUES.filter(hasDescriptor);
const unknown = crm.SOURCE_VALUES.filter((s) => !hasDescriptor(s));
/* Inert before the worker has any descriptor for these sources, strict from the
   first one onward. Half a list is the dangerous state, not an empty one: an
   empty crmSync means the parked lane is still holding everything, whereas a
   worker that knows four of twelve will deliver eight notes under a label
   nobody chose. */
if (known.length === 0) {
  console.log(`  pend  crmSync has no descriptors for the new sources yet (step 3), ${unknown.length} waiting`);
} else {
  ok(unknown.length === 0,
    `every source has a descriptor in crmSync${unknown.length ? `: missing ${unknown.join(', ')}` : ''}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
