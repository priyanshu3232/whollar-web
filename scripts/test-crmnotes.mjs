#!/usr/bin/env node
/* What each CRM note actually says, for the twelve sources the auth function
 * enqueues.
 *
 *   node scripts/test-crmnotes.mjs
 *
 * These are pure functions with an ugly failure mode: a note that renders
 * wrongly is not an error anywhere, it is a line somebody reads in Zoho weeks
 * later and believes. So every source is rendered here against the payload its
 * route really sends, and the payloads below are copied from the enqueue calls
 * in routes/, which is the only thing that makes this a test rather than a
 * demonstration.
 *
 * Two of the assertions are refusals rather than checks, and they are the point
 * of the file: a sealed bid's note must never carry a price, and an activation
 * must never carry a fee amount.
 */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { __test: t } = require(join(ROOT, 'catalyst-backend/functions/crmSync/index.js'));

let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };
const note = (source, data) => t.noteFor(source, 'jane@example.com', data, true, null, '2026-09-01 10:00:00');

/* The payloads, copied from the enqueue calls in catalyst-backend/.../routes/. */
const CASES = {
  MemberSignups:        { user_type: 'member', first_name: 'Jane', last_name: 'Roy', fsa: 'M5S', province: 'ON', referred_by: 'WHL-1a2b3c4d' },
  PartnerSignups:       { first_name: 'Sam', last_name: 'Okafor', org_id: 'org-1', org_name: 'Northline', approval_status: 'pending' },
  PartnerOrgs:          { org_id: 'org-1', org_name: 'Northline Fibre', previous_name: 'Northline' },
  ProviderApplications: { org_id: 'org-1', org_name: 'Northline Fibre' },
  PartnerApprovals:     { org_id: 'org-1', org_name: 'Northline Fibre', decision: 'approved', reason: null },
  PartnerTerms:         { org_id: 'org-1', org_name: 'Northline Fibre', doc_type: 'cohort_terms', doc_version: 'v2' },
  PartnerBilling:       { org_id: 'org-1', org_name: 'Northline Fibre', method: 'invoice', billing_email: 'ap@northline.ca', billing_contact: 'Accounts' },
  CohortSeats:          { event: 'joined', cohort: 'toronto-west', region: 'Toronto West', fsa: 'M5S' },
  SealedBids:           { event: 'improved', org_id: 'org-1', org_name: 'Northline Fibre', cohort: 'toronto-west', region: 'Toronto West', revision: 3, receipt: 'WHL-R-8891' },
  CohortAwards:         { org_id: 'org-1', org_name: 'Northline Fibre', cohort: 'toronto-west', region: 'Toronto West', tiers_won: ['500 Mbps', '1 Gbps'] },
  HouseholdOrders:      { event: 'activated', org_id: 'org-1', cohort: 'toronto-west', region: 'Toronto West', order_no: 'ORD-4417', tier: '500 Mbps', fsa: 'M5S', billable: true },
  EmailSuppressions:    { reason: 'unsubscribed', scope: 'marketing' },
};

console.log('\ncrm notes');

/* Every source renders, titles itself, and says something. */
for (const [source, data] of Object.entries(CASES)) {
  let n = null, threw = null;
  try { n = note(source, data); } catch (err) { threw = err; }
  ok(!threw && n && n.title && n.content, `${source} renders`);
  if (!n) continue;
  ok(n.title.includes('jane@example.com'), `${source} title names the person`);
  ok(n.content.includes('Submitted: 2026-09-01'), `${source} carries the submission date`);
}

/* A garbage payload still produces a note rather than losing the event. */
let broke = false;
let bad = null;
try { bad = note('CohortAwards', { tiers_won: 'not-an-array' }); } catch { broke = true; }
ok(!broke && bad && bad.content.length > 0, 'a malformed payload still renders a note');

/* ---- the two refusals ---- */
const bid = note('SealedBids', { ...CASES.SealedBids, price: '58.00', tiers: [{ price: '58.00' }] });
ok(!/58\.00/.test(bid.content), 'a sealed bid note carries NO price, even when one is in the payload');
ok(/WHL-R-8891/.test(bid.content), 'and it does carry the receipt');

const act = note('HouseholdOrders', { ...CASES.HouseholdOrders, fee: '95', success_fee: '95.00' });
ok(!/\$?95/.test(act.content), 'an activation note carries NO fee amount, even when one is in the payload');
ok(/success fee/i.test(act.content), 'but it does say a fee is earned');
ok(/LINE ACTIVATED/.test(act.content), 'and the activation is unmistakable');

/* ---- what each note is actually for ---- */
ok(/Toronto West/.test(note('CohortSeats', CASES.CohortSeats).content), 'a seat note names the cohort by region');
ok(/Joined the cohort/.test(note('CohortSeats', CASES.CohortSeats).content), 'and says what happened');
ok(/Passed on this round/.test(note('CohortSeats', { ...CASES.CohortSeats, event: 'passed' }).content), 'a pass reads as a pass');
ok(/APPROVED/.test(note('PartnerApprovals', CASES.PartnerApprovals).content), 'an approval is unmistakable');
ok(/DECLINED/.test(note('PartnerApprovals', { ...CASES.PartnerApprovals, decision: 'rejected', reason: 'No CRTC registration' }).content), 'so is a decline');
ok(/No CRTC registration/.test(note('PartnerApprovals', { ...CASES.PartnerApprovals, decision: 'rejected', reason: 'No CRTC registration' }).content), 'and it carries the reason');
ok(/renamed from Northline to Northline Fibre/.test(note('PartnerOrgs', CASES.PartnerOrgs).content), 'a rename reads as a rename');
ok(/registered as/.test(note('PartnerOrgs', { org_name: 'Northline' }).content), 'a first registration does not');
ok(/UNSUBSCRIBED/.test(note('EmailSuppressions', CASES.EmailSuppressions).content), 'a suppression shouts');

/* ---- the record each source lands on ---- */
const cfg = { partnerModule: 'Vendors' };
ok(t.moduleFor('SealedBids', cfg) === 'Vendors', 'a bid goes to the partner module');
ok(t.moduleFor('PartnerApprovals', cfg) === 'Vendors', 'so does a decision');
ok(t.moduleFor('CohortSeats', cfg) === 'Leads', 'a household seat does not');
ok(t.moduleFor('HouseholdOrders', cfg) === 'Leads', 'nor does an order');

/* ---- names arrive whichever half of the system sent them ---- */
const f = t.insertFields('MemberSignups', 'jane@example.com', CASES.MemberSignups, true);
ok(f.Last_Name === 'Roy' && f.First_Name === 'Jane', 'snake_case names from the auth function are read');
const g = t.insertFields('WaitlistSignups', 'jane@example.com', { firstName: 'Jane', lastName: 'Roy' }, true);
ok(g.Last_Name === 'Roy' && g.First_Name === 'Jane', 'camelCase names from the forms still are');
const h = t.insertFields('ProviderApplications', 'ops@northline.ca', CASES.ProviderApplications, true);
ok(h.Company === 'Northline Fibre', 'org_name becomes the company');
ok(!/\[dev\]/.test(f.Lead_Source), 'production leads carry no dev tag');
ok(/\[dev\]/.test(t.insertFields('MemberSignups', 'a@b.ca', {}, false).Lead_Source), 'and non-production ones do');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
