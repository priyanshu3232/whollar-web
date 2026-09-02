#!/usr/bin/env node
/* D4: the external-id upsert, and the one place email is still a key.
 *
 *   node scripts/test-crm-upsert.mjs
 *
 * `fetch` is stubbed, so no request leaves this process. What is being tested is
 * the decision each function makes about which CRM record a row belongs to,
 * which is the decision that produces duplicates when it is wrong. A duplicate
 * is not an error anywhere: both writes succeed, and the founder finds two of
 * the same household weeks later.
 */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { __test: t } = require(join(ROOT, 'catalyst-backend/functions/crmSync/index.js'));

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

const FIELD = 'Whollar_ROWID';
let calls = [];
const reply = (body, status = 200) => ({
  ok: status < 400, status,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: () => null },
});

/* A CRM with whatever records a test puts in it. */
function crmWith(records) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (u.includes('/search?')) {
      const email = decodeURIComponent(u.split('criteria=')[1] || '').match(/Email:equals:([^)]+)/);
      const hit = records.find((r) => email && r.Email === email[1]);
      return hit ? reply({ data: [{ id: hit.id }] }) : reply({}, 204);
    }
    if (u.includes('/upsert')) {
      const sent = JSON.parse(opts.body).data[0];
      const hit = records.find((r) => r[FIELD] === sent[FIELD]);
      return reply({ data: [{ code: 'SUCCESS', action: hit ? 'update' : 'insert', details: { id: hit ? hit.id : 'new-1' } }] });
    }
    if (opts.method === 'PUT') {
      const id = u.split('/').pop();
      const rec = records.find((r) => r.id === id);
      if (rec) Object.assign(rec, JSON.parse(opts.body).data[0]);
      return reply({ data: [{ code: 'SUCCESS', details: { id } }] });
    }
    /* GET one record: used to read back an external id before adopting. */
    const id = u.split('?')[0].split('/').pop();
    const rec = records.find((r) => r.id === id);
    return rec ? reply({ data: [{ [FIELD]: rec[FIELD] || null }] }) : reply({}, 404);
  };
}
const ctx = () => ({ cfg: t.config(), token: 'tok', apiDomain: 'https://www.zohoapis.ca', refresh: async () => {} });

console.log('\ncrm upsert and adoption');

/* ---- adoption: the form sync got there first ---- */
let records = [{ id: 'c-100', Email: 'jane@example.com' }];   // no Whollar_ROWID
crmWith(records); calls = [];
let adopted = await t.adoptContactByEmail(ctx(), 'Contacts', 'jane@example.com', 'u1');
ok(adopted === 'c-100', 'a form-created Contact with a matching email is found');
ok(records[0][FIELD] === 'u1', 'and gains the Whollar_ROWID rather than being duplicated');

/* Once adopted, the upsert matches on the id and updates that same record. */
calls = [];
let res = await t.upsertByExternalId(ctx(), 'Contacts', 'u1', { Last_Name: 'Roy' });
ok(res.id === 'c-100', 'the next write lands on the adopted record, not a new one');
ok(res.action === 'update', 'as an update');
const body = calls.find((c) => c.url.includes('/upsert')).body;
ok(body.duplicate_check_fields[0] === FIELD, 'the upsert names the external id as the dedupe field');
ok(body.data[0][FIELD] === 'u1', 'and carries it on the record');

/* ---- a record already owned by somebody else is never stolen ---- */
records = [{ id: 'c-200', Email: 'shared@example.com', [FIELD]: 'u-other' }];
crmWith(records);
adopted = await t.adoptContactByEmail(ctx(), 'Contacts', 'shared@example.com', 'u1');
ok(adopted === null, 'a Contact already carrying another household id is NOT adopted');
ok(records[0][FIELD] === 'u-other', 'and its id is left alone');

/* ---- adopting the same record twice is a no-op ---- */
records = [{ id: 'c-300', Email: 'same@example.com', [FIELD]: 'u1' }];
crmWith(records); calls = [];
adopted = await t.adoptContactByEmail(ctx(), 'Contacts', 'same@example.com', 'u1');
ok(adopted === 'c-300', 'a record already owned by this household is returned');
ok(!calls.some((c) => c.method === 'PUT'), 'and is not written to again');

/* ---- no email match: the upsert simply inserts ---- */
records = [];
crmWith(records);
adopted = await t.adoptContactByEmail(ctx(), 'Contacts', 'new@example.com', 'u2');
ok(adopted === null, 'no email match means nothing to adopt');
res = await t.upsertByExternalId(ctx(), 'Contacts', 'u2', { Last_Name: 'New' });
ok(res.action === 'insert', 'and the upsert creates the record');

/* ---- an email nobody passed is not searched for ---- */
calls = [];
adopted = await t.adoptContactByEmail(ctx(), 'Contacts', null, 'u3');
ok(adopted === null && calls.length === 0, 'a missing email searches for nothing');

/* ---- the dedupe key can never be dropped ---- */
const cfg = t.config();
ok(t.isRequired(FIELD, cfg), 'the external id is a required field');
ok(t.isRequired('Email', cfg) && t.isRequired('Last_Name', cfg), 'alongside Email and Last_Name');
ok(!t.isRequired('Zip_Code', cfg), 'while a postal code is still droppable');
const refused = { data: [{ code: 'INVALID_DATA', details: { api_name: FIELD } }] };
ok(t.offendingField(refused, { [FIELD]: 'u1' }, cfg) === null,
  'a refused external id is NOT dropped and retried: that would insert a duplicate');

/* ---- a failed upsert carries an HTTP status so it can be classified ---- */
globalThis.fetch = async () => reply({ data: [{ code: 'INVALID_MODULE' }] }, 400);
let threw = null;
try { await t.upsertByExternalId(ctx(), 'Nope', 'u1', {}); } catch (err) { threw = err; }
ok(threw && threw.httpStatus === 400, 'a refused upsert throws with an httpStatus');
ok(t.classify(threw).kind === 'client', 'which classifies as a client error, dead after two attempts');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
