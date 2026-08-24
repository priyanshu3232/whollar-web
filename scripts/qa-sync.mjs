#!/usr/bin/env node
/* Side-by-side sync check: the member dashboard and the partner console,
 * loaded from the SAME campaign state, at the four standard widths.
 *
 *   node scripts/dev-server.mjs      # in another shell, port 3000
 *   node scripts/qa-sync.mjs [base]
 *
 * Sibling of qa-dashboard.mjs and qa-console.mjs, same iron rule: every
 * Catalyst call is stubbed through a catch-all, because dev-server.mjs
 * proxies /api/auth/* to the live Development backend.
 *
 * WHAT MAKES THIS A SYNC CHECK AND NOT TWO SMOKE TESTS. The two payloads are
 * not hand-written fixtures: they are produced by calling the real
 * lib/cohorts.js `state()`, `forMember()` and `forPartner()` over one set of
 * campaigns and one set of counts, exactly as GET /campaigns and
 * GET /provider/campaigns do on the server. So what this asserts is that the
 * two pages, handed the two projections of one state, render the same
 * region set and the same household numbers. If a projection drifts, or a
 * page stops reading its projection, the two columns stop agreeing here.
 */

import { chromium } from 'playwright-core';
import { backend } from './backend-module.mjs';

const cohorts = backend('lib/cohorts.js');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };
const ours = (m) => { const u = (m.location && m.location().url) || ''; return !u || u.startsWith(BASE); };
const collect = (page, sink) => {
  page.on('console', m => { if (m.type() === 'error' && ours(m)) sink.push(m.text()); });
  page.on('pageerror', e => sink.push(String(e)));
};

/* ------------------------------------------------------------------ *
 * One state, two projections
 * ------------------------------------------------------------------ */

const NOW = Date.now();
const DAY = 86400000;
const H = 3600000;

/* Catalog-shaped rows, as catalog.fromRow() hands them to cohorts.state().
   Seed baselines are set ON PURPOSE: they must reach no rendered number. */
const CATALOG = [
  { id: 'etobicoke-centre', region: 'Etobicoke Centre', sub: 'Autumn cohort', kind: 'auction', target: null,
    seedMembers: 64, seedHouseholds: 112, biddingOpen: true, sortOrder: 1,
    dates: { announce_at: NOW - 3 * DAY, bidding_opens_at: NOW - 2 * H, bidding_closes_at: NOW + 2 * DAY, offers_at: NOW + 3 * DAY, decision_at: NOW + 9 * DAY, switch_window_at: NOW + 12 * DAY, reconcile_at: NOW + 26 * DAY } },
  { id: 'kleinburg', region: 'Kleinburg', sub: 'Winter cohort', kind: 'forming', target: 100,
    seedMembers: 61, seedHouseholds: 100, biddingOpen: false, sortOrder: 2,
    dates: { announce_at: NOW + 9 * DAY, bidding_opens_at: NOW + 11 * DAY, bidding_closes_at: NOW + 13 * DAY } },
  { id: 'vaughan-woodbridge', region: 'Vaughan Woodbridge', sub: 'First cohort', kind: 'planned', target: 100,
    seedMembers: 58, seedHouseholds: 58, biddingOpen: false, sortOrder: 3, dates: {} },
];
const COUNTS = {
  'etobicoke-centre': { seats: 12, waitlist: 0, watching: 2, live: true },
  'kleinburg': { seats: 7, waitlist: 0, watching: 0, live: true },
  'vaughan-woodbridge': { seats: 0, waitlist: 3, watching: 1, live: true },
};
/* This member holds a seat in Kleinburg. */
const MINE = { 'kleinburg': { status: 'joined' } };

const STATES = CATALOG.map(c => cohorts.state(c, COUNTS[c.id], NOW));
const MEMBER_PAYLOAD = { ok: true, live: true, source: 'table', serverTime: NOW, campaigns: STATES.map(s => cohorts.forMember(s, MINE[s.id])) };
const PARTNER_PAYLOAD = { ok: true, live: true, source: 'table', serverTime: NOW, bidding: { enabled: true, notice: null }, campaigns: STATES.map(s => cohorts.forPartner(s, true)) };

console.log('\n0. the two projections agree at the data level');
{
  for (const s of STATES) {
    const m = MEMBER_PAYLOAD.campaigns.find(c => c.id === s.id);
    const p = PARTNER_PAYLOAD.campaigns.find(c => c.id === s.id);
    ok(m.households === p.households && m.households === COUNTS[s.id].seats,
      `${s.id}: member ${m.households} = partner ${p.households} = seats ${COUNTS[s.id].seats}, seed ${s.campaign.seedHouseholds} ignored`);
  }
  ok(PARTNER_PAYLOAD.campaigns.filter(c => c.bidding_open).map(c => c.id).join() === 'etobicoke-centre', 'exactly one cohort is open for sealed bidding');
  ok(MEMBER_PAYLOAD.campaigns.find(c => c.id === 'kleinburg').you === 'joined', 'the member\'s own standing is per campaign');
}

/* ------------------------------------------------------------------ *
 * Contexts
 * ------------------------------------------------------------------ */

const MEMBER_REC = { emailKey: 'ada@example.com', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', phone: '(416) 555 0134', postal: 'L0J 1C0', fsa: 'L0J', provinceCode: 'ON' };
const PARTNER_REC = { emailKey: 'sam@northline.ca', email: 'sam@northline.ca', firstName: 'Sam', lastName: 'Kaur' };
const APPROVED = { ok: true, approved: true, user: { firstName: 'Sam', lastName: 'Kaur', email: 'sam@northline.ca' }, org: { orgId: 'org-nl', orgName: 'Northline Internet', role: 'admin', approvalStatus: 'approved', approved: true } };
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function memberCtx(browser, width) {
  const c = await browser.newContext({ viewport: { width, height: 900 } });
  await c.route('**/api/auth/**', r => r.fulfill(json({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [], coverage: [] })));
  await c.route('**/api/auth/campaigns', r => r.fulfill(json(MEMBER_PAYLOAD)));
  await c.route('**/api/auth/me/bill', r => r.fulfill(json({ ok: true, bill: null })));
  await c.route('**/api/auth/me/seat*', r => r.fulfill(json({
    ok: true, serverTime: Date.now(),
    claim: { address_id: 'u1/1', vertical: 'internet', cohort_id: 'kleinburg', status: 'active', version: 1, claimed_at: NOW - DAY, released_at: null },
    cohort: { id: 'kleinburg', region: 'Kleinburg', stage: 'forming', join_close_at: NOW + 9 * DAY, roster_count: COUNTS.kleinburg.seats, target: 100, dates: CATALOG[1].dates, closing: false },
    affordance: 'leave', rejoin_until: null,
  })));
  await c.route('**/api/auth/session', r => r.fulfill(json({ authenticated: true, user: { ...MEMBER_REC, userType: 'member' } })));
  await c.addInitScript(rec => {
    if (sessionStorage.getItem('whl-seeded')) return;
    sessionStorage.setItem('whl-seeded', '1');
    localStorage.setItem('whollar.member', JSON.stringify(rec));
  }, MEMBER_REC);
  return c;
}

async function partnerCtx(browser, width) {
  const c = await browser.newContext({ viewport: { width, height: 900 } });
  await c.route('**/api/auth/**', r => r.fulfill(json({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [], coverage: [] })));
  await c.route('**/api/auth/provider/me', r => r.fulfill(json(APPROVED)));
  await c.route('**/api/auth/provider/campaigns', r => r.fulfill(json(PARTNER_PAYLOAD)));
  await c.route('**/api/auth/provider/coverage', r => r.fulfill(json({
    ok: true, live: true, serverTime: Date.now(),
    coverage: CATALOG.map(k => ({ region: k.region, status: 'active', techs: ['fibre'], speed: '1 Gbps', lead: '5 business days' })),
  })));
  await c.route('**/api/auth/provider/bids', r => r.fulfill(json({ ok: true, live: true, serverTime: Date.now(), bids: [] })));
  await c.route('**/api/auth/me/prefs', r => r.fulfill(json({ ok: true, prefs: {} })));
  await c.route('**/api/auth/session', r => r.fulfill(json({ authenticated: true, user: { ...PARTNER_REC, userType: 'provider' } })));
  await c.addInitScript(rec => {
    if (sessionStorage.getItem('whl-seeded')) return;
    sessionStorage.setItem('whl-seeded', '1');
    localStorage.setItem('whollar.partner', JSON.stringify(rec));
  }, PARTNER_REC);
  return c;
}

const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

const browser = await chromium.launch();
const errors = [];

for (const w of [1280, 940, 768, 390]) {
  console.log(`\n${w}px: both surfaces, one state`);

  const mc = await memberCtx(browser, w);
  const mp = await mc.newPage();
  collect(mp, errors);
  await mp.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await mp.waitForTimeout(1000);
  const member = await mp.evaluate(() => {
    const regions = Array.from(document.querySelectorAll('#cgrid .cc .cc__b b, #crow .cc .cc__b b')).map(b => b.textContent.trim());
    const ledger = (document.querySelector('#seatledger') || {}).innerText || '';
    const campname = (document.querySelector('#campname') || {}).textContent || '';
    return { regions: Array.from(new Set(regions)).sort(), ledger: ledger.replace(/\s+/g, ' ').trim(), campname: campname.trim() };
  });
  ok((await overflow(mp)) <= 0, 'member: no horizontal overflow');
  await mc.close();

  const pc = await partnerCtx(browser, w);
  const pp = await pc.newPage();
  collect(pp, errors);
  await pp.goto(`${BASE}/partner#desk`, { waitUntil: 'networkidle' });
  await pp.waitForTimeout(1200);
  const partner = await pp.evaluate(() => {
    const view = document.querySelector('.view.on') || document;
    const regions = Array.from(view.querySelectorAll('.rg')).map(r => (r.childNodes[0] && r.childNodes[0].textContent || r.textContent).trim());
    const rows = {};
    view.querySelectorAll('tr[data-row]').forEach(tr => {
      const num = tr.querySelector('td.num');
      rows[tr.getAttribute('data-row')] = num ? num.textContent.trim() : null;
    });
    const text = (view.innerText || '').replace(/\s+/g, ' ');
    return { regions: Array.from(new Set(regions)).sort(), rows, text };
  });
  ok((await overflow(pp)) <= 0, 'partner: no horizontal overflow');
  await pc.close();

  const expectRegions = CATALOG.map(c => c.region).sort();
  ok(JSON.stringify(member.regions) === JSON.stringify(expectRegions), `member sees ${member.regions.join(', ') || 'nothing'}`);
  ok(JSON.stringify(partner.regions) === JSON.stringify(expectRegions), `partner sees ${partner.regions.join(', ') || 'nothing'}`);
  ok(JSON.stringify(member.regions) === JSON.stringify(partner.regions), 'the same region set on both surfaces');

  ok(partner.rows['etobicoke-centre'] === String(COUNTS['etobicoke-centre'].seats), `partner desk: Etobicoke Centre households = ${partner.rows['etobicoke-centre']} (12 seats, seed 112 ignored)`);
  ok(new RegExp(`Kleinburg.{0,80}${COUNTS.kleinburg.seats} households so far`).test(partner.text), 'partner desk: Kleinburg "7 households so far"');
  ok(/Vaughan Woodbridge.{0,80}Gathering · 3 on the list/.test(partner.text), 'partner desk: Vaughan Woodbridge "Gathering · 3 on the list", not households');
  ok(new RegExp(`${COUNTS.kleinburg.seats} of 100 households`).test(member.ledger), `member seat ledger: "${member.ledger.slice(0, 40)}"`);
  ok(/Kleinburg/.test(member.campname), `member's own cohort is Kleinburg ("${member.campname}")`);
}

await browser.close();
const distinct = Array.from(new Set(errors));
if (distinct.length) { console.log('\nconsole errors:'); distinct.forEach(e => console.log('  ' + e.slice(0, 200))); }
console.log(`\n${pass} passed, ${fail} failed, ${distinct.length} distinct console error(s)`);
process.exit(fail || distinct.length ? 1 : 0);
