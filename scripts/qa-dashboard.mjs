#!/usr/bin/env node
/* Browser checks for the member dashboard (/dashboard).
 *
 *   node scripts/dev-server.mjs          # in another shell, port 3000
 *   node scripts/qa-dashboard.mjs
 *   node scripts/qa-dashboard.mjs http://localhost:4173
 *
 * The sibling of scripts/qa-console.mjs, and not wired into CI for the same
 * reason: provisioning Playwright's browser binary costs real time on every
 * run, and check-frontend.yml is deliberately install-free. Run it by hand
 * after touching dashboard.html.
 *
 * Every Catalyst call is intercepted through a CATCH-ALL, so this never
 * reaches the live Development backend and never writes a row. That is not
 * belt and braces: scripts/dev-server.mjs proxies /api/auth/* to the real
 * Development environment, there is no local emulator, and an un-stubbed
 * endpoint is a test writing to live data. qa-console.mjs learned this the
 * expensive way, in a group that named two routes and let four onto the wire.
 *
 * COVERS: the boot guard's three paths, the state the member is put in for a
 * given server answer (which is where the interesting bugs live), the demo
 * tour across all 13 states, four widths, and every link resolving.
 *
 * THE REGRESSION THIS FILE EXISTS FOR. CAMPS used to be seeded with six
 * invented regions, london-east marked `you:'joined'`, so the demo tour had a
 * cohort to show. Any seeded campaign the server did not name kept its seeded
 * standing, so once london-east archived, every member on the site was shown
 * "Your campaign · London East · Autumn cohort" with a forming rail, a dated
 * calendar and an activity feed, none of it theirs. The seeds are gone (CAMPS
 * boots empty and only GET /campaigns fills it); groups 3, 4 and 6 are what
 * keeps them gone.
 */

import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

/* Only OUR errors count: Google Fonts intermittently 404s a woff2, which has
   nothing to do with this code. Same rule, and same reasoning, as qa-console. */
const ours = (m) => { const u = (m.location && m.location().url) || ''; return !u || u.startsWith(BASE); };
const collect = (page, sink) => {
  page.on('console', m => { if (m.type() === 'error' && ours(m)) sink.push(m.text()); });
  page.on('pageerror', e => sink.push(String(e)));
};

/* A member record shaped like the one whollar-login-consumer.html writes. A
   BRAND NEW ACCOUNT: a name and an address and nothing else, which is what
   signup lands. It has no postal code and no number, so it is on the wrong side
   of the profile gate, which is the point of group 6o. */
const REC = { emailKey: 'ada@example.com', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
/* The same account after the profile gate: an FSA to file a membership under
   and a number to text. Every group whose subject is NOT the profile gate uses
   this, because a fixture that trips an unrelated gate tests the gate. */
const RECFULL = { ...REC, phone: '(416) 555 0134', postal: 'M5S 2J7', fsa: 'M5S', provinceCode: 'ON' };

const DAY = 86400000;
/* A campaign shaped like publicCampaign() in routes/campaigns.js. */
/* `eligibility` and `nearbyTier` are OMITTED by default, on purpose. Every
   fixture above this line was written before cohorts had postal code areas,
   and a default here would quietly change what all of them assert. Absent is
   also a real wire state: a page running against a function deployed before
   eligibility existed gets exactly this, and has to behave as it did then. The
   eligibility group passes them explicitly. */
function camp(id, region, sub, { you = null, kind = 'forming', stage = 'forming', members = 44,
  joinable = true, eligibility, nearbyTier } = {}) {
  const t = Date.now();
  return {
    id, region, sub, kind, target: 100, members, households: members, watching: 0,
    joinable, you, stage, stageLabel: stage, next: null,
    ...(eligibility === undefined ? {} : { eligibility }),
    ...(nearbyTier === undefined ? {} : { nearbyTier }),
    dates: {
      announce_at: t - 9 * DAY, bidding_opens_at: t + 9 * DAY,
      bidding_closes_at: t + 11 * DAY, decision_at: t + 18 * DAY, switch_window_at: t + 30 * DAY,
    },
  };
}

async function ctx(browser, { record = REC, campaigns = [], live = true, sessionAuthed = true, bill = null,
  memberFsa, postalCodeState, profileSave } = {}) {
  const c = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  /* CATCH-ALL FIRST. Playwright matches most-recently-registered first, so the
     named handlers below still win and everything else lands here rather than
     on the network. It answers in the shape the server answers in, because the
     page's own null checks distinguish "unreadable" from "empty". */
  await c.route('**/api/auth/**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [], coverage: [] }),
  }));
  await c.route('**/api/auth/campaigns', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true, live, serverTime: Date.now(), campaigns,
      /* Same rule as `camp` above: absent unless a test says otherwise, so the
         older fixtures keep asserting what they asserted. */
      ...(memberFsa === undefined ? {} : { memberFsa }),
      ...(postalCodeState === undefined ? {} : { postalCodeState }),
    }),
  }));
  if (profileSave) {
    await c.route('**/api/auth/me/profile', r => r.fulfill({
      status: profileSave.status || 200, contentType: 'application/json',
      body: JSON.stringify(profileSave.body),
    }));
  }
  await c.route('**/api/auth/me/bill', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, bill }),
  }));
  await c.route('**/api/auth/session', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(sessionAuthed
      ? { authenticated: true, user: { ...REC, userType: 'member' } }
      : { authenticated: false }),
  }));
  await c.route('**/api/auth/logout', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  /* Seed ONCE, on the first document only. addInitScript runs on every
     navigation, so an unguarded seed re-writes the record on the sign-in page
     too, which then sees a signed-in member and bounces straight back. */
  if (record) {
    await c.addInitScript(rec => {
      if (sessionStorage.getItem('whl-seeded')) return;
      sessionStorage.setItem('whl-seeded', '1');
      localStorage.setItem('whollar.member', JSON.stringify(rec));
    }, record);
  }
  return c;
}

/* What the page is showing, read the way a member reads it. */
const snapshot = (p) => p.evaluate(() => {
  const q = s => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
  const vh = document.querySelector('#visitor-home');
  return {
    lane: vh && !vh.hidden ? 'visitor' : 'member',
    campname: q('#campname'),
    regmono: q('#regmono'),
    histHidden: !!(document.querySelector('#hist-live') || {}).hidden,
    hist: (document.querySelector('#hist-live-rows') || {}).innerText || '',
    panel: (document.querySelector('#panel') || {}).innerText || '',
  };
});

const browser = await chromium.launch();
const errors = [];

console.log('\n1. signed out: no flash, redirected to sign-in with ?next');
{
  const c = await ctx(browser, { record: null, sessionAuthed: false });
  /* Hold the session answer open so the hidden state is observable. Without the
     delay the redirect wins the race, which is the guard behaving well but
     makes the flash assertion untestable. Registered after ctx(), so it wins. */
  await c.route('**/api/auth/session', async r => {
    await new Promise(res => setTimeout(res, 900));
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }) });
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  ok(await p.evaluate(() => document.documentElement.style.visibility) === 'hidden',
    'document hidden while the server is asked');
  await p.waitForURL(/whollar-login-consumer/, { timeout: 8000 }).catch(() => {});
  ok(/whollar-login-consumer/.test(p.url()), `redirected to sign-in (${p.url().replace(BASE, '')})`);
  ok(/next=%2Fdashboard/.test(p.url()), 'carries ?next=/dashboard');
  await c.close();
}

console.log('\n2. signed in, nothing on file: the checkup offer, not a cohort');
{
  const c = await ctx(browser, { campaigns: [] });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const s = await snapshot(p);
  ok(s.lane === 'visitor', 'a member with no bill and no cohort is on the visitor lane');
  ok(await p.locator('#visitor-home a[href^="/bill-checkup"]').count() > 0, 'and is offered the checkup');
  ok(s.histHidden, 'campaign history shows the empty state, not a joined row');
  await c.close();
}

console.log('\n3. REGRESSION: a live answer that omits london-east must not join anyone');
{
  /* The catalog has archived the seeded cohort, so the server never names it.
     Before the fix, joinedCamp() answered from the seed and this member was
     shown a forming London East cohort they had never joined. */
  const c = await ctx(browser, { campaigns: [], live: true });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const s = await snapshot(p);
  ok(s.lane === 'visitor', 'not put into a cohort the server never mentioned');
  ok(s.histHidden, 'and not listed as a member of one');
  await c.close();
}

console.log('\n4. the cohort on screen is the one they actually joined');
{
  const c = await ctx(browser, { campaigns: [camp('windsor-core', 'Windsor', 'Winter cohort', { you: 'joined', members: 44 })] });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const s = await snapshot(p);
  ok(s.lane === 'member', 'a joined member is on the member lane');
  ok(s.campname === 'Windsor · Winter cohort', `the panel names their cohort (${s.campname})`);
  ok(/Windsor/.test(s.hist), 'campaign history names it too');
  /* No surface quotes a cohort's fill against its target any more: the tiles,
     the forming panel and this history row all used to, and a count of nought
     against a hundred is what four newly opened cohorts all read. */
  ok(!/of 100/.test(s.panel) && !/of 100/.test(s.hist),
    'and neither the panel nor the history quotes the fill against the target');
  ok(!/undefined/.test(s.hist), 'no undefined standing in the history row');
  await c.close();
}

console.log('\n5. the join card counts what the server says, on the visitor lane too');
{
  const c = await ctx(browser, { campaigns: [camp('london-east', 'London East', 'Autumn cohort', { members: 44 })] });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const s = await snapshot(p);
  ok(s.lane === 'visitor', 'still a visitor: reported, but not joined');
  ok(/London East/.test(s.regmono || ''), `the region row shows the server's cohort (${s.regmono})`);
  ok(!/of 100/.test(s.regmono || ''), 'and no fill count with it');
  await c.close();
}

console.log('\n6. a degraded read paints the server\'s list and fabricates nothing');
{
  /* THERE ARE NO SEEDS ANY MORE. A degraded answer (live:false) with an empty
     list is an empty row that says so; a degraded answer WITH cohorts paints
     them, because the list is the catalog's and only the counts are in doubt.
     Neither invents a membership. */
  const c = await ctx(browser, { campaigns: [], live: false });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const s = await snapshot(p);
  ok(s.lane === 'visitor', 'live:false does not fabricate a cohort either');
  const row = await p.evaluate(() => (document.querySelector('#crow') || {}).innerText || '');
  /* An empty catalog is four LABELLED, EMPTY slots. Owner's call 2026-08-27:
     the row holds its spaces open rather than collapsing, and a cohort the
     server sends takes one. The slot carries no id, no region, no count and
     no join, so this assertion is still the same one it always was: whatever
     paints here when the server sent nothing, it is not a cohort. */
  ok(/Area 2/.test(row), `and an empty list paints labelled empty slots, not four invented regions (${row.replace(/\s+/g, ' ').slice(0, 60)})`);
  ok(!/London East|Windsor|Kingston|Chatham/.test(row), 'none of the old seed regions appear');
  await c.close();
  const c2 = await ctx(browser, { campaigns: [camp('kleinburg', 'Kleinburg', 'Autumn cohort', { members: 2 })], live: false });
  const p2 = await c2.newPage();
  collect(p2, errors);
  await p2.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(900);
  const row2 = await p2.evaluate(() => (document.querySelector('#crow') || {}).innerText || '');
  ok(/Kleinburg/.test(row2), 'a degraded answer that names a cohort still paints it');
  await c2.close();
}

console.log('\n6a. before the first answer the row is a skeleton, not "no cohorts"');
{
  const c = await ctx(browser, { campaigns: [camp('kleinburg', 'Kleinburg', 'Autumn cohort')] });
  /* Hold the campaigns answer so the pre-answer paint is observable. */
  await c.route('**/api/auth/campaigns', async r => {
    await new Promise(res => setTimeout(res, 1500));
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [camp('kleinburg', 'Kleinburg', 'Autumn cohort')] }) });
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(500);
  const early = await p.evaluate(() => (document.querySelector('#crow') || {}).innerText || '');
  ok(/Finding cohorts near you/.test(early) && !/No cohorts open yet/.test(early), 'skeleton while the server is asked');
  ok(await p.locator('#crow .cc--wait[aria-busy="true"]').count() > 0, 'and it is marked busy for assistive tech');
  await p.waitForTimeout(2000);
  const late = await p.evaluate(() => (document.querySelector('#crow') || {}).innerText || '');
  ok(/Kleinburg/.test(late) && !/Finding cohorts/.test(late), 'then the server\'s cohort replaces it');
  await c.close();
}

console.log('\n6c. a member holding a waitlist place, not a seat, can press any open cohort');
{
  /* The state a waitlist standing derives is `forming`, which is not a
     visitor state, and no seat means heldElsewhere is false: before the gate
     widened, every other joinable cohort was an inert tile with a hover lift. */
  const c = await ctx(browser, { record: RECFULL, campaigns: [
    camp('brampton-east', 'Brampton East', 'Winter cohort', { kind: 'waitlist', you: 'waitlist', members: 0 }),
    camp('kleinburg', 'Kleinburg', 'Autumn cohort', { members: 3 }),
    camp('etobicoke-centre', 'Etobicoke Centre', 'Winter cohort', { members: 0 }),
  ] });
  await c.route('**/api/auth/me/seat*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, serverTime: Date.now(), claim: null, cohort: null, affordance: 'none', rejoin_until: null }) }));
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const pressable = await p.evaluate(() => Array.from(document.querySelectorAll('#crow button.cc[data-choose]')).map(b => b.getAttribute('data-choose')));
  ok(pressable.includes('kleinburg') && pressable.includes('etobicoke-centre'), `both open cohorts are buttons (${pressable.join(', ')})`);
  ok(!pressable.includes('brampton-east'), 'their own waitlist cohort is not offered as a join');
  /* A real hover, not a synthetic event: :hover only follows the pointer.
     The rise animation leaves an identity matrix behind, so the lift is read
     as the translateY component and the shadow, not as "transform is none". */
  await p.hover('#crow div.cc');
  await p.waitForTimeout(250);
  const inert = await p.evaluate(() => {
    const d = document.querySelector('#crow div.cc'); if (!d) return null;
    const cs = getComputedStyle(d);
    const m = cs.transform.match(/matrix\(([^)]+)\)/);
    const ty = m ? Number(m[1].split(',')[5]) : 0;
    return { ty, shadow: cs.boxShadow };
  });
  ok(inert && inert.ty === 0 && inert.shadow === 'none', `an inert tile carries no hover lift (${inert && inert.ty}px, ${inert && inert.shadow})`);
  await p.hover('#crow button.cc');
  await p.waitForTimeout(250);
  const live = await p.evaluate(() => {
    const b = document.querySelector('#crow button.cc'); if (!b) return null;
    return getComputedStyle(b).boxShadow;
  });
  ok(live && live !== 'none', 'a pressable card still lifts');
  await c.close();
}

/* THE SECOND REGRESSION THIS FILE EXISTS FOR. applyCampaign() used to return
   early when the server named an id that was not one of the six seeded in
   CAMPS, and the region row was four hardcoded cards. So every cohort created
   in the Data Store after dashboard.html was written arrived on the wire and
   was discarded: absent here, live on the partner desk, with nothing anywhere
   saying why. The catalog was promoted out of code so a new cohort needs no
   deploy; a local allowlist of ids put the deploy back. */
console.log('\n6b. a cohort the page has never heard of renders anyway');
{
  const c = await ctx(browser, { campaigns: [
    camp('kitchener-central', 'Kitchener', 'Autumn cohort', { members: 7 }),
    camp('scarborough-east', 'Scarborough', 'Autumn cohort', { kind: 'auction', stage: 'bidding', members: 64 }),
  ] });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const row = await p.evaluate(() => (document.querySelector('#crow') || {}).innerText || '');
  const s = await snapshot(p);
  ok(/Kitchener/.test(row), 'an unseeded cohort is on the region row');
  ok(/Scarborough/.test(row), 'and so is the second one');
  ok(/Kitchener/.test(s.regmono || ''), `and the featured tile is the server's, not a seeded one (${s.regmono})`);
  /* The seeds are demo scaffolding. Once a live answer names two cohorts, four
     invented regions must not still be sitting on the row beside them. */
  ok(!/London East|Chatham-Kent|Windsor/.test(row), 'and no seeded region survives a live answer');
  await c.close();
}

/* The bidding countdown read `26*3600+14*60+9`, a literal, so it showed the
   same 26:14:09 on every cohort on every visit. A cohort whose sealed window
   closed in three minutes still read 26 hours, and no change to the campaign's
   calendar moved it. It must measure the joined cohort's own bidding_closes_at,
   against the server clock rather than this browser's. */
console.log('\n6c. the bidding countdown is the cohort\'s own close date');
{
  const t = Date.now(), MIN = 60000;
  const mine = {
    id: 'kitchener-central', region: 'Kitchener', sub: 'Autumn cohort', kind: 'auction',
    target: 100, members: 1, households: 1, watching: 0, joinable: false, you: 'joined',
    stage: 'bidding', stageLabel: 'Bidding', next: null,
    dates: {
      announce_at: t - 4 * MIN, bidding_opens_at: t - 2 * MIN, bidding_closes_at: t + 3 * MIN,
      offers_at: t + 5 * MIN, decision_at: t + 7 * MIN, switch_window_at: t + 9 * MIN,
    },
  };
  const c = await ctx(browser, { campaigns: [mine] });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const cd = () => p.evaluate(() => {
    const e = document.querySelector('#cd');
    return e ? e.textContent.trim() : null;
  });
  const first = await cd();
  ok(/^00:0[0-3]:/.test(first || ''), `a close 3 minutes out reads as minutes, not hours (${first})`);
  ok(!/^26:/.test(first || ''), 'and not the old hardcoded 26:14:09');
  await p.waitForTimeout(2200);
  ok((await cd()) !== first, 'and it ticks');
  await c.close();
}

/* The offer panel read WIN and OFFERS, two constants: Northline Internet at
   $54.50 and "3 partners bid", printed on every cohort. A Kitchener auction
   whose only sealed bid was $50 still showed $54.50 from a provider that does
   not exist. GET /campaigns/:id/offer is what makes it the cohort's own bid. */
console.log('\n6d. the offer panel shows the real winning bid');
{
  const t = Date.now(), MIN = 60000;
  const mine = {
    id: 'kitchener-central', region: 'Kitchener', sub: 'Autumn cohort', kind: 'auction',
    target: 100, members: 1, households: 1, watching: 0, joinable: false, you: 'joined',
    stage: 'offers', stageLabel: 'Offer in', next: null,
    dates: {
      announce_at: t - 9 * MIN, bidding_opens_at: t - 7 * MIN, bidding_closes_at: t - 5 * MIN,
      offers_at: t - 3 * MIN, decision_at: t + 60 * MIN, switch_window_at: t + 120 * MIN,
    },
  };
  const c = await ctx(browser, { campaigns: [mine] });
  /* Registered after ctx's catch-all, so it wins: Playwright matches the most
     recently registered route first. */
  await c.route('**/api/auth/campaigns/*/offer', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true, sealed: false, live: true, closesAt: t - 5 * MIN, bidCount: 1,
      book: [
        { tier: '500 Mbps', price: '50', partner: 'Testline Fibre', guaranteeMonths: 24,
          afterPrice: null, equipment: 'inc', rentalMonthly: null, technology: 'fibre',
          uploadMbps: '500', mix: null, reference: 'WR-TEST' },
      ],
      offer: {
        partner: 'Testline Fibre', price: '50', speed: '500 Mbps', technology: 'fibre',
        guaranteeMonths: 24, afterLine: 'no scheduled change', equipment: 'inc',
        rentalMonthly: null, committedHouseholds: 40, reference: 'WR-TEST',
        tiers: [{ name: '500 Mbps', technology: 'fibre', uploadMbps: '500', stickerPrice: '65', effectivePrice: '50', afterPrice: null }],
      },
    }),
  }));
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1400);
  const panel = await p.evaluate(() => (document.querySelector('#panel') || {}).innerText || '');
  ok(/\$50\b/.test(panel), 'the winning price is the bid that was placed');
  ok(!/54\.50|54\.5/.test(panel), 'and not the hardcoded $54.50');
  ok(/Testline Fibre/.test(panel), 'the partner is the org that bid');
  ok(!/Northline/.test(panel), 'and not the hardcoded Northline Internet');
  /* The count itself is off the panel now (it invited the household to weigh
     the offer by it), but the singular still has to be the truth, and it is
     still what catches the demo constant: bidCount 3 would read "Multiple". */
  ok(/One partner bid/.test(panel), `one bid reads as "One partner bid", singular`);
  ok(!/Multiple partners/.test(panel), 'and does not overclaim a field of bidders');
  ok(!/\d+ partners? bid/.test(panel), 'and no bid count is printed at all');
  await c.close();
}

/* The seal. Nothing about a bid may cross to a household before the window
   closes, including the count: a member who could watch it climb could tell a
   partner how much competition it has, which is the same leak as the price. */
console.log('\n6e. a sealed window reveals nothing, and the panel does not invent one');
{
  const t = Date.now(), MIN = 60000;
  const mine = {
    id: 'kitchener-central', region: 'Kitchener', sub: 'Autumn cohort', kind: 'auction',
    target: 100, members: 1, households: 1, watching: 0, joinable: false, you: 'joined',
    stage: 'bidding', stageLabel: 'Bidding', next: null,
    dates: { announce_at: t - 4 * MIN, bidding_opens_at: t - 2 * MIN, bidding_closes_at: t + 30 * MIN },
  };
  const c = await ctx(browser, { campaigns: [mine] });
  let asked = 0;
  await c.route('**/api/auth/campaigns/*/offer', r => {
    asked += 1;
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, sealed: true, closesAt: t + 30 * MIN, bidCount: null, offer: null }),
    });
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1400);
  ok(asked === 0, `the offer is not even requested while bidding is live (${asked} requests)`);
  const panel = await p.evaluate(() => (document.querySelector('#panel') || {}).innerText || '');
  ok(!/\$54\.50|Northline/.test(panel), 'and no fixture price or partner leaks into the bidding panel');
  await c.close();
}

/* THE OPERATOR'S QUESTION, ANSWERED AS A TEST. A cohort created straight at
   `auction` has to be two things at once: the FEATURED card for a household
   that has joined nothing, and open to bid on the partner desk. Those are
   different files, and the consumer half is the half that can silently not
   happen, because featuredCamp() prefers a JOINABLE cohort and an auction is
   never joinable. It falls through to CAMPS[0], which is the server's own
   order, which is sort_order ascending.

   So the newest auction cohort is featured only while nothing joinable is in
   the catalog. That is a real constraint on how a launch table is filled, not
   a detail, and it is asserted here in both directions: all auctions, then the
   same list with one forming cohort added. */
console.log('\n6f. an all-auction catalog features the newest cohort');
{
  const auction = (id, region) => camp(id, region, 'Autumn cohort',
    { kind: 'auction', stage: 'bidding', joinable: false, members: 0 });
  /* Server order IS sort_order ascending, so the newest cohort, carrying the
     lowest sort_order, arrives first. */
  const c = await ctx(browser, { campaigns: [
    auction('north-york-central', 'North York Central'),   // sort_order 99, created second
    auction('scarborough-centre', 'Scarborough Centre'),   // sort_order 100, created first
  ] });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const s = await snapshot(p);
  const cards = await p.evaluate(() => Array.from(document.querySelectorAll('#crow .cc'))
    .map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  ok(/North York Central/.test(s.regmono || ''),
    `the newest auction cohort is the featured tile (${s.regmono})`);
  ok(/North York Central/.test(cards[0] || ''), 'and it is the first card on the row');
  ok(/Scarborough Centre/.test(cards[1] || ''), 'and the older one shifted to position 1');
  ok(/Sealed bidding/.test(cards[0] || ''), 'the featured card reads Sealed bidding');
  ok(await p.evaluate(() => !document.querySelector('#crow [data-choose]')),
    'and carries no join button, because an auction is never joinable');
  await c.close();
}

console.log('\n6g. one forming cohort takes the featured slot back');
{
  /* A bill on file. The CTA no longer NEEDS one (see 6l: a member with nothing
     on file gets the same button and the checkup gate behind it), so this
     fixture is here to keep the group about what it is about, which is which
     cohort is featured, with the state held at 'result' and out of the way. */
  const c = await ctx(browser, {
    bill: { provider: 'Rogers', monthly: 92, promoEnd: '2026-11-01' },
    campaigns: [
      camp('north-york-central', 'North York Central', 'Autumn cohort',
        { kind: 'auction', stage: 'bidding', joinable: false, members: 0 }),
      camp('etobicoke-centre', 'Etobicoke Centre', 'Winter cohort', { members: 0 }),
    ],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const s = await snapshot(p);
  /* Second in the server's order, first on the row: ccRank reads `kind` before
     it reads sort_order, so a joinable cohort outranks every auction whatever
     its number. An operator who wants the newest cohort featured has to keep
     the catalog to one kind. */
  ok(/Etobicoke Centre/.test(s.regmono || ''),
    `the joinable cohort is featured even though it sorts last (${s.regmono})`);
  ok(await p.evaluate(() => !!document.querySelector('#crow [data-choose]')),
    'and it is the one carrying the join button');
  await c.close();
}

/* The join dialog's button used to read "Join London East · free" as a literal,
   whichever card was pressed. The join itself was already correct, which is
   what made it worth a test rather than a fix and a shrug: the only wrong
   thing on screen was the sentence the member was consenting to, and there is
   nothing afterwards to notice it by. `?cohorts=all` is used so both cards
   carry the CTA; it relaxes which cohorts are choosable and leaves the join
   itself real. */
console.log('\n6h. the join button names the cohort that was pressed');
{
  const c = await ctx(browser, {
    record: RECFULL,
    bill: { provider: 'Rogers', monthly: 92, promoEnd: '2026-11-01' },
    campaigns: [
      camp('etobicoke-centre', 'Etobicoke Centre', 'Winter cohort', { members: 0 }),
      camp('kleinburg', 'Kleinburg', 'Autumn cohort', { members: 0 }),
    ],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard?cohorts=all`, { waitUntil: 'networkidle' });
  /* WAIT FOR THE BILL, not for a stopwatch. ?cohorts=all puts the CTA on every
     tile from the first paint, and GET /me/bill lands after it, so a click on a
     fixed timer could fall in the window where the page correctly does not know
     this member has a bill yet and opens the checkup gate instead of the join.
     That window is real and the gate is right to be in it; what was wrong was a
     test racing it. */
  await p.waitForFunction(() => {
    try { return !!(JSON.parse(localStorage.getItem('whollar.member') || '{}').bill); }
    catch { return false; }
  }, null, { timeout: 6000 });
  await p.waitForTimeout(300);

  /* The second card, which is NOT the featured one. */
  await p.click('#crow [data-choose="kleinburg"]');
  await p.waitForSelector('#pf-save', { timeout: 4000 });
  const second = (await p.locator('#pf-save').innerText()).trim();
  ok(/Kleinburg/.test(second), `pressing Kleinburg asks to join Kleinburg (${second})`);
  ok(!/London East/.test(second), 'and no hardcoded region survives');

  await p.click('[data-mclose]');
  await p.waitForTimeout(200);
  await p.click('#crow [data-choose="etobicoke-centre"]');
  await p.waitForSelector('#pf-save', { timeout: 4000 });
  const first = (await p.locator('#pf-save').innerText()).trim();
  ok(/Etobicoke Centre/.test(first), `and pressing the other one follows it (${first})`);
  await c.close();
}

/* THE FABRICATED CALENDAR. The date tiles carried Sep 12 / Sep 15 to 17 / Sep 24
   / October in the markup, and paintDates left them alone for any column the
   cohort had no date in. The locked panel read "Bidding opens September 15" as
   a literal. A cohort one rung into its ladder has exactly one date, so a
   member was shown one real deadline and four invented ones, on the screen
   whose only job is telling them when to expect something. Fixture dates that
   look like data are worse than a blank: there is nothing to notice. */
console.log('\n6i. a cohort shows its own dates, and nothing where it has none');
{
  const t = Date.now(), MIN = 60000;
  /* announce_at only, which is what rung 1 of the ladder leaves behind. */
  const mine = {
    id: 'kleinburg', region: 'Kleinburg', sub: 'Autumn cohort', kind: 'forming',
    target: 100, members: 3, households: 3, watching: 0, joinable: false, you: 'joined',
    stage: 'locked', stageLabel: 'Locked', next: null,
    dates: { announce_at: t - 2 * MIN },
  };
  const c = await ctx(browser, { campaigns: [mine] });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const tiles = await p.evaluate(() => {
    const out = {};
    document.querySelectorAll('.tn2[data-t]').forEach(e => {
      out[e.getAttribute('data-t')] = (e.querySelector('span') || {}).textContent;
    });
    return out;
  });
  const panel = await p.locator('#panel').innerText();
  ok(!/Sep 15|Sep 24|Sep 12|October/.test(Object.values(tiles).join(' ')),
    `no fabricated date survives on the tiles (${JSON.stringify(tiles)})`);
  ok(/To come/.test(tiles.bid || ''), 'a column the cohort has no date in reads "To come"');
  ok(/^(Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul)/.test(tiles.close || ''),
    `and the one date it does carry is shown (${tiles.close})`);
  ok(!/September 15/.test(panel), 'the locked panel no longer invents a bidding date');
  ok(/text you the day bidding opens/.test(panel),
    'and says what it actually knows instead');
  await c.close();
}

/* And the same panel WITH a date has to show that date, or the fix above would
   pass by saying nothing on every cohort. */
console.log('\n6j. the locked panel shows a real bidding date when there is one');
{
  const t = Date.now(), DAYMS = 86400000;
  const at = t + 9 * DAYMS;
  const mine = {
    id: 'kleinburg', region: 'Kleinburg', sub: 'Autumn cohort', kind: 'forming',
    target: 100, members: 3, households: 3, watching: 0, joinable: false, you: 'joined',
    stage: 'locked', stageLabel: 'Locked', next: null,
    dates: { announce_at: t - 2 * DAYMS, bidding_opens_at: at, bidding_closes_at: at + 2 * DAYMS },
  };
  const c = await ctx(browser, { campaigns: [mine] });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const panel = await p.locator('#panel').innerText();
  const MONFULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const want = `${MONFULL[new Date(at).getMonth()]} ${new Date(at).getDate()}`;
  ok(panel.includes(want), `the panel names the cohort's own open date (${want})`);
  await c.close();
}

/* THE LOOP. memberStageOf answers from the cohort's seven dates and nothing
   else, so a household that has taken its offer is still `offers` to the
   server. The dashboard repolls every 15 seconds on a short calendar and
   re-derived the state from that answer, which put the Offers panel back on
   screen with the take button live again, forever. The member's own click has
   to outrank a server stage that is BEHIND it, and only ever behind it. */
console.log('\n6k. taking the offer is not undone by the next poll');
{
  const t = Date.now(), MIN = 60000;
  const mine = {
    id: 'kleinburg', region: 'Kleinburg', sub: 'Autumn cohort', kind: 'auction',
    target: null, members: 4, households: 4, watching: 0, joinable: false, you: 'joined',
    stage: 'offers', stageLabel: 'Offer in', next: null,
    dates: {
      announce_at: t - 40 * MIN, bidding_opens_at: t - 30 * MIN,
      bidding_closes_at: t - 20 * MIN, offers_at: t - 10 * MIN,
    },
  };
  const c = await ctx(browser, { campaigns: [mine] });
  /* The offer the panel is about. Sealed is false because the cohort closed.
     `book` is the cards; `offer` is the entry the server centres on and is
     kept beside it. A cohort with one bidder still has a book, it is just one
     partner's name on every entry. See scripts/qa-offers.mjs for the window
     rules themselves; this group is only about the advance/repoll race. */
  await c.route('**/api/auth/campaigns/*/offer', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true, sealed: false, live: true, closesAt: t - 20 * MIN, bidCount: 1,
      book: [
        { tier: '100 Mbps', price: '43', partner: 'Northline', guaranteeMonths: 24,
          afterPrice: null, equipment: 'byod', rentalMonthly: null, mix: null, reference: 'WB-1' },
        { tier: '300 Mbps', price: '51', partner: 'Northline', guaranteeMonths: 24,
          afterPrice: null, equipment: 'byod', rentalMonthly: null, mix: null, reference: 'WB-1' },
        { tier: '500 Mbps', price: '58', partner: 'Northline', guaranteeMonths: 24,
          afterPrice: null, equipment: 'byod', rentalMonthly: null, mix: null, reference: 'WB-1' },
      ],
      offer: {
        partner: 'Northline', price: '43', speed: '100 Mbps', technology: 'cable',
        guaranteeMonths: 24, afterLine: 'no scheduled change', equipment: 'byod',
        rentalMonthly: null, reference: 'WB-1',
      },
    }),
  }));
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);

  const pill = () => p.locator('#statepill, .statepill').first().innerText();
  ok(/Offer/.test(await pill()), `starts on the server's stage (${await pill()})`);

  await p.click('#panel [data-take]');
  await p.waitForTimeout(300);
  ok(/Confirm/.test(await pill()), `taking the offer moves to Confirm (${await pill()})`);

  /* Force the repoll the page does on returning to a visible tab. The server
     still says `offers`, which is exactly the answer that used to win. */
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(1200);
  ok(/Confirm/.test(await pill()), `and a poll answering "offers" does not undo it (${await pill()})`);
  ok(await p.evaluate(() => !document.querySelector('#panel [data-take]')),
    'the take button is not live again');

  /* Back to offers is the member saying they did not mean it, and that must
     stick too, or the panel would bounce the other way. */
  await p.click('#panel [data-act="backoffers"]');
  await p.waitForTimeout(300);
  ok(/Offer/.test(await pill()), `"Back to offers" returns, and stays (${await pill()})`);
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(1200);
  ok(/Offer/.test(await pill()), 'after a poll as well');
  await c.close();
}

/* THE COHORT WAS REAL, OPEN, JOINABLE AND INVISIBLE. Every join surface was
   gated on state 'result', so an account created ten seconds ago saw a checkup
   offer and a row of inert tiles, and nothing it could press. The gate moved:
   the cohort card and the featured tile are on screen from the first load, and
   the numbers are asked for on the click instead of before it. */
console.log('\n6l. a member with no bill sees the cohort, and is asked for their numbers');
{
  const c = await ctx(browser, {
    /* Profile on file, bill missing: the subject here is the CHECKUP gate, and
       a fixture short of a postal code would open the profile gate in front of
       it and test that instead. Group 6o owns the case where both are missing. */
    record: RECFULL,
    bill: null,
    campaigns: [
      camp('etobicoke-centre', 'Etobicoke Centre', 'Winter cohort', { members: 0 }),
      /* NOT the featured one. Before the gate existed this tile was an inert
         div, so a member who lives in Kleinburg pressed their own region and
         the page did nothing at all. */
      camp('kleinburg', 'Kleinburg', 'Autumn cohort', { members: 0 }),
      /* Joinable by nobody, so it stays inert and keeps its bell. */
      camp('scarborough-centre', 'Scarborough Centre', 'Spring cohort',
        { kind: 'planned', joinable: false, members: 0 }),
    ],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const s = await snapshot(p);
  ok(s.lane === 'visitor', 'still the visitor lane: no bill is no cohort joined');
  const lane = await p.locator('#visitor-home').innerText();
  /* The eyebrow is text-transform:uppercase and innerText reports what is
     rendered, so this reads it case-insensitively rather than asserting the
     stylesheet. */
  ok(/open in your area/i.test(lane), 'the arrive lane carries the cohort card');
  ok(/Etobicoke Centre/.test(lane), 'and it names the server\'s cohort');
  ok(await p.locator('#visitor-home a[href^="/bill-checkup"]').count() > 0,
    'the checkup is still offered alongside it');
  ok(await p.locator('#visitor-home [data-choose="etobicoke-centre"]').count() > 0,
    'the card is pressable');
  ok(await p.locator('#crow [data-choose="etobicoke-centre"]').count() > 0,
    'and so is the featured tile on the row');
  ok(await p.locator('#crow [data-choose="kleinburg"]').count() > 0,
    'and so is every OTHER joinable tile, not just the featured one');
  ok(await p.locator('#crow [data-choose="scarborough-centre"]').count() === 0,
    'a cohort nobody can join stays inert, and keeps its bell instead');
  ok(await p.locator('#crow [data-bell="Scarborough Centre"]').count() > 0,
    'the bell is still there');

  await p.click('#visitor-home [data-choose="etobicoke-centre"]');
  await p.waitForSelector('#modal:not([hidden])', { timeout: 4000 });
  const box = await p.locator('#mbody').innerText();
  ok(/Your numbers first/.test(box), 'pressing it opens the gate, not the six questions');
  ok(/Etobicoke Centre/.test(box), `and the gate names the cohort they pressed`);
  ok(await p.locator('#pf-save').count() === 0, 'the join dialog is NOT behind it');
  ok(await p.locator('#mbody a[href^="/bill-checkup"]').count() > 0, 'the way out is the checkup');
  /* HARD GATE: the checkup and the close box, and nothing that joins anyway. */
  ok(await p.locator('#mbody [data-choose], #mbody [data-join]').count() === 0,
    'and there is no join-anyway escape');
  const intent = await p.evaluate(() => localStorage.getItem('whollar.cohort.intent'));
  ok(/etobicoke-centre/.test(intent || ''), `the cohort is stashed for the trip (${intent})`);

  /* And the tile that was inert before this: same gate, its OWN region named,
     and the stash follows the press rather than the featured cohort. */
  await p.click('[data-mclose]');
  await p.waitForTimeout(200);
  await p.click('#crow [data-choose="kleinburg"]');
  await p.waitForSelector('#modal:not([hidden])', { timeout: 4000 });
  const box2 = await p.locator('#mbody').innerText();
  ok(/Your numbers first/.test(box2), 'a non-featured tile opens the same gate');
  ok(/Kleinburg/.test(box2) && !/Etobicoke/.test(box2),
    'and it names the region that was pressed, not the featured one');
  const intent2 = await p.evaluate(() => localStorage.getItem('whollar.cohort.intent'));
  ok(/kleinburg/.test(intent2 || ''), `and the stash follows the press (${intent2})`);
  await c.close();
}

console.log('\n6m. the cohort survives the round trip to the checkup');
{
  const c = await ctx(browser, {
    record: RECFULL,
    bill: { provider: 'Rogers', monthly: 92, promoEnd: '2026-11-01' },
    campaigns: [
      camp('etobicoke-centre', 'Etobicoke Centre', 'Winter cohort', { members: 0 }),
      camp('kleinburg', 'Kleinburg', 'Autumn cohort', { members: 0 }),
    ],
  });
  /* What the gate wrote before sending them to /bill-checkup. The SECOND
     cohort, so a resume that quietly falls back to the featured one fails. */
  await c.addInitScript(() => {
    localStorage.setItem('whollar.cohort.intent', JSON.stringify({ id: 'kleinburg', at: Date.now() }));
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#pf-save', { timeout: 6000 });
  const label = (await p.locator('#pf-save').innerText()).trim();
  ok(/Kleinburg/.test(label), `coming back with a bill reopens the join on the cohort they chose (${label})`);
  ok(await p.evaluate(() => localStorage.getItem('whollar.cohort.intent')) === null,
    'and the stash is spent, so a later visit is not ambushed by it');
  await c.close();
}

console.log('\n6n. a stale intent is dropped rather than acted on');
{
  const c = await ctx(browser, {
    bill: { provider: 'Rogers', monthly: 92, promoEnd: '2026-11-01' },
    /* Gone to auction while they were away: not joinable any more. */
    campaigns: [camp('kleinburg', 'Kleinburg', 'Autumn cohort',
      { kind: 'auction', stage: 'bidding', joinable: false, members: 0 })],
  });
  await c.addInitScript(() => {
    localStorage.setItem('whollar.cohort.intent', JSON.stringify({ id: 'kleinburg', at: Date.now() }));
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  ok(await p.locator('#pf-save').count() === 0, 'no dialog offering a cohort that has closed to joins');
  ok(await p.evaluate(() => localStorage.getItem('whollar.cohort.intent')) === null,
    'and it is cleared, not left to fire on the next load');
  await c.close();
}

/* THE PROFILE GATE. A cohort is shown to an account created a minute ago, which
   is the point: hiding the product from the person it was built for was the old
   behaviour and it is not coming back. What the account cannot do yet is JOIN,
   because a membership row carries the FSA and every join confirmation on the
   page promises a text, and a brand new account has neither a postal code nor a
   number. The gate is on the one click that reaches a join.

   The two halves are tested separately on purpose. A gate that never opens and
   a gate that never closes are the same bug from opposite ends, and only the
   first one looks broken. */
console.log('\n6o. a new account sees the cohorts and is asked for two details to join');
{
  const c = await ctx(browser, {
    campaigns: [camp('kleinburg', 'Kleinburg', 'Autumn cohort', { members: 0 })],
  });
  /* The route the gate saves through, answering in the shape /me/profile
     answers in, and holding what it was sent so this can assert the fields
     actually left the page. */
  const sent = [];
  await c.route('**/api/auth/me/profile', r => {
    sent.push(JSON.parse(r.request().postData() || '{}'));
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, user: { ...REC, userType: 'member', phone: '(416) 555 0134', postal: 'M5S 2J7', fsa: 'M5S' } }),
    });
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);

  const cards = await p.locator('#crow .cc').count();
  ok(cards > 0, `the cohort row is painted for an account with no bill and no profile (${cards} card(s))`);

  await p.click('#crow [data-choose="kleinburg"]');
  await p.waitForSelector('#pg-save', { timeout: 4000 });
  const gate = await p.locator('#mbody').innerText();
  ok(/Two details first/.test(gate), 'pressing a cohort opens the profile gate');
  ok(/Kleinburg/.test(gate), 'and it names the cohort that was pressed');
  ok(!/Your numbers first/.test(gate), 'the checkup gate does not jump the queue');

  /* An incomplete postal code is refused in place: the gate exists to collect a
     usable FSA, and a gate that accepts "M5S" has collected nothing. */
  await p.fill('#pg-region', 'M5S');
  await p.fill('#pg-mobile', '4165550134');
  await p.click('#pg-save');
  await p.waitForTimeout(250);
  ok(await p.locator('#pg-err').isVisible(), 'a half-typed postal code is refused, in the dialog');
  ok(sent.length === 0, 'and nothing was sent');

  await p.fill('#pg-region', 'M5S 2J7');
  await p.click('#pg-save');
  await p.waitForSelector('#gate-go', { timeout: 4000 });
  ok(sent.length === 1, 'a complete answer posts once');
  ok(sent[0] && sent[0].postalCode === 'M5S 2J7' && /4165550134/.test(String(sent[0].phone).replace(/[^\d]/g, '')),
    `and sends the postal code and the number (${JSON.stringify(sent[0])})`);
  const next = await p.locator('#mbody').innerText();
  ok(/Your numbers first/.test(next), 'then hands straight on to the checkup gate, with no second press');
  await c.close();
}

/* And the gate has to stay shut for a member who has already answered, or every
   join on the site grows a dialog in front of it. */
console.log('\n6p. a member with a profile and a bill goes straight to the six questions');
{
  const c = await ctx(browser, {
    record: { ...REC, phone: '(416) 555 0134', postal: 'M5S 2J7', fsa: 'M5S' },
    bill: { provider: 'Rogers', monthly: 92, promoEnd: '2026-11-01' },
    campaigns: [camp('kleinburg', 'Kleinburg', 'Autumn cohort', { members: 0 })],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard?cohorts=all`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.click('#crow [data-choose="kleinburg"]');
  await p.waitForSelector('#pf-save', { timeout: 4000 });
  const body = await p.locator('#mbody').innerText();
  ok(!/Two details first/.test(body), 'no profile gate for a member who has both');
  ok(/Kleinburg/.test(await p.locator('#pf-save').innerText()), 'and the join button names the cohort');
  await c.close();
}

console.log('\n7. the demo tour renders all 13 states with no console error');
{
  const c = await ctx(browser, { campaigns: [] });
  const p = await c.newPage();
  const tourErrors = [];
  collect(p, tourErrors);
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.click('#ctl-toggle');
  await p.waitForTimeout(300);
  const states = await p.$$eval('#sts button', bs => bs.map(b => b.getAttribute('data-goto')));
  ok(states.length === 13, `demo states present (${states.length})`);
  let painted = 0;
  for (const st of states) {
    await p.click(`#sts button[data-goto="${st}"]`);
    await p.waitForTimeout(180);
    const s = await snapshot(p);
    const body = s.lane === 'visitor' ? await p.evaluate(() => document.querySelector('#visitor-home').innerText) : s.panel;
    if (body.trim().length > 80) painted++;
  }
  ok(painted === states.length, `every state renders real content (${painted}/${states.length})`);
  ok(tourErrors.length === 0, `no console error across the tour (${tourErrors.length})`);
  await c.close();
}

console.log('\n8. the demo controls exist only with ?demo=1');
{
  const c = await ctx(browser, { campaigns: [] });
  const p = await c.newPage();
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  ok(await p.locator('#ctl-toggle').count() === 0, 'no prototype controls on a plain visit');
  ok(await p.locator('#ctl').count() === 0, 'and no control panel left in the DOM');
  await c.close();
}

console.log('\n9. four widths, zero horizontal overflow');
{
  const c = await ctx(browser, { campaigns: [camp('london-east', 'London East', 'Autumn cohort', { you: 'joined' })] });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  for (const w of [1360, 940, 768, 390]) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.waitForTimeout(320);
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 0, `${w}px: no horizontal overflow (worst ${Math.max(0, over)}px)`);
  }
  await c.close();
}

console.log('\n10. every view renders, and every link on them resolves');
{
  const c = await ctx(browser, { campaigns: [camp('london-east', 'London East', 'Autumn cohort', { you: 'joined' })] });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  const views = await p.$$eval('#pnav button', bs => bs.map(b => b.getAttribute('data-view')));
  let filled = 0;
  const hrefs = new Set();
  for (const v of views) {
    await p.click(`#pnav button[data-view="${v}"]`);
    await p.waitForTimeout(220);
    const len = await p.evaluate(v => {
      const el = document.querySelector(`.view[data-v="${v}"]`);
      return el && el.classList.contains('on') ? el.innerText.trim().length : 0;
    }, v);
    if (len > 120) filled++;
    for (const h of await p.$$eval('a[href]', as => as.map(a => a.getAttribute('href')))) {
      if (h && h.startsWith('/')) hrefs.add(h.split('#')[0]);
    }
  }
  ok(filled === views.length, `every nav view has real content (${filled}/${views.length})`);
  const dead = [];
  for (const h of hrefs) {
    const r = await fetch(BASE + h, { redirect: 'manual' }).catch(() => null);
    if (!r || r.status >= 400) dead.push(`${h} -> ${r ? r.status : 'ERR'}`);
  }
  ok(dead.length === 0, `every internal link resolves (${hrefs.size} checked${dead.length ? ': ' + dead.join(', ') : ''})`);
  await c.close();
}

console.log('\n11. the retired discount field is gone, and historical values survive a save');
{
  /* create-tables.md retired DiscountAmount with the v17 checkup: the monthly
     charge is the price paid today with the promo already applied, so asking
     for the discount on top double counts. The column stays nullable for
     historical rows, so the save has to carry an old value through rather than
     erase it: POST /me/bill replaces the whole row. */
  const bill = { provider: 'Rogers', monthly: 92, speed: '500', discount: 15, source: 'bill-checkup' };
  const c = await ctx(browser, { campaigns: [], bill });
  let posted = null;
  await c.route('**/api/auth/me/bill', async r => {
    if (r.request().method() === 'POST') {
      posted = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, bill: posted }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, bill }) });
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  ok(await p.locator('#bu-disc').count() === 0, 'no discount input on the bill form');
  ok(await p.locator('[data-fld="discount"]').count() === 0, 'no discount row in the switch file');
  ok(!/Monthly discount/.test(await p.locator('.view[data-v="bills"]').innerText()), 'and the label is gone with it');

  await p.click('#pnav button[data-view="bills"]');
  await p.waitForTimeout(250);
  await p.fill('#bu-cost', '88');
  await p.click('#bu-save');
  await p.waitForTimeout(700);
  ok(posted !== null, 'the form still saves');
  ok(posted && posted.monthly === 88, `and sends the edited charge (${posted && posted.monthly})`);
  ok(posted && posted.discount === 15, `and carries the historical discount through untouched (${posted && posted.discount})`);
  await c.close();
}

/* THE DECISION IS A RECORD. Taking the offer posts the accept, with the
   address and the consent the server requires, and a reload restores the
   answer from `yourOrder` on the campaigns payload. Passing posts the leave,
   and the passed panel neither promises the demo's fictions nor gets yanked
   away by the next poll. A refresh used to land every decided household back
   on the Offers panel, take button live, as if it had never answered. */
const OFFERCAMP = (t => ({
  id: 'kleinburg', region: 'Kleinburg', sub: 'Autumn cohort', kind: 'auction',
  target: null, members: 4, households: 4, watching: 0, joinable: false, you: 'joined',
  stage: 'offers', stageLabel: 'Offer in', next: null,
  dates: {
    announce_at: t - 40 * 60000, bidding_opens_at: t - 30 * 60000,
    bidding_closes_at: t - 20 * 60000, offers_at: t - 10 * 60000,
  },
}))(Date.now());
const OFFERBODY = {
  ok: true, sealed: false, live: true, closesAt: Date.now() - 20 * 60000, bidCount: 1,
  /* One bidder, so every entry of the book carries the same name. It is still
     a book: the cards render from it, and `offer` beside it is only the entry
     the server centres on. */
  book: [
    { tier: '100 Mbps', price: '43', partner: 'Northline', guaranteeMonths: 24,
      afterPrice: null, equipment: 'byod', rentalMonthly: null, mix: null, reference: 'WB-1' },
    { tier: '300 Mbps', price: '52', partner: 'Northline', guaranteeMonths: 24,
      afterPrice: null, equipment: 'byod', rentalMonthly: null, mix: null, reference: 'WB-1' },
  ],
  offer: {
    partner: 'Northline', price: '43', speed: '100 Mbps', technology: 'cable',
    guaranteeMonths: 24, afterLine: 'no scheduled change', equipment: 'byo',
    rentalMonthly: null, committedHouseholds: 4, reference: 'WB-1', tiers: [],
  },
};

console.log('\n12. taking the offer posts the accept, and a reload restores it');
{
  const c = await ctx(browser, { campaigns: [OFFERCAMP] });
  await c.route('**/api/auth/campaigns/*/offer', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(OFFERBODY),
  }));
  let accepted = null;
  await c.route('**/api/auth/campaigns/*/offer/accept', r => {
    accepted = JSON.parse(r.request().postData() || '{}');
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, accepted: true, orderNo: 'WHL-77AB-C', note: 'Accepted. Nothing is charged for switching, and your installer books the visit from here.' }),
    });
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);

  await p.click('#panel [data-take]');
  await p.waitForTimeout(300);
  ok(await p.locator('#svcaddr').count() === 1, 'the live confirm screen asks for the service address');
  ok(await p.evaluate(() => document.querySelector('#paydep').disabled), 'the confirm button starts disarmed');
  await p.fill('#svcaddr', '12 Maple Street, Kleinburg');
  await p.click('#consent');
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => !document.querySelector('#paydep').disabled), 'address plus consent arms it');
  await p.click('#paydep');
  await p.waitForTimeout(700);
  ok(accepted !== null, 'the accept reaches the server');
  ok(accepted && accepted.consent === true, 'with the consent tick');
  ok(accepted && accepted.address === '12 Maple Street, Kleinburg', `and the address (${accepted && accepted.address})`);
  const panel = (await p.locator('#panel').innerText());
  ok(/concierge has it from here/i.test(panel), 'the panel moves to switching');
  ok(panel.includes('WHL-77AB-C'), 'and names the order');
  await c.close();
}
{
  const c = await ctx(browser, {
    campaigns: [{ ...OFFERCAMP, yourOrder: { orderNo: 'WHL-77AB-C', state: 'acc' } }],
  });
  await c.route('**/api/auth/campaigns/*/offer', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(OFFERBODY),
  }));
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const panel = (await p.locator('#panel').innerText());
  ok(/concierge has it from here/i.test(panel), 'a fresh load lands on switching, not Offers');
  ok(panel.includes('WHL-77AB-C'), 'still naming the order');
  ok(await p.evaluate(() => !document.querySelector('#panel [data-take]')), 'and the take button is gone');
  await c.close();
}

console.log('\n12b. passing posts the leave, survives the poll, and a failure reverts honestly');
{
  const c = await ctx(browser, { campaigns: [OFFERCAMP] });
  await c.route('**/api/auth/campaigns/*/offer', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(OFFERBODY),
  }));
  let left = null;
  await c.route('**/api/auth/campaigns/leave', r => {
    left = JSON.parse(r.request().postData() || '{}');
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, campaign: { ...OFFERCAMP, you: null } }) });
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);

  await p.click('#panel [data-act="pass"]');
  await p.waitForTimeout(300);
  await p.click('#ps-go');
  await p.waitForTimeout(700);
  ok(left !== null && left.campaign === 'kleinburg', `the leave reaches the server (${left && left.campaign})`);
  let panel = (await p.locator('#panel').innerText());
  ok(/address is freed today/i.test(panel), 'the persisted pass says what is true');
  ok(await p.evaluate(() => !document.querySelector('#panel [data-act="backoffers"]')),
    'and offers no reconsider over a membership that is gone');
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(1200);
  panel = (await p.locator('#panel').innerText());
  ok(/Passed\./.test(panel), 'the next poll does not yank the panel away');
  await c.close();
}
{
  const c = await ctx(browser, { campaigns: [OFFERCAMP] });
  await c.route('**/api/auth/campaigns/*/offer', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(OFFERBODY),
  }));
  await c.route('**/api/auth/campaigns/leave', r => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { code: 'SERVER_ERROR', message: 'Campaign sign-ups are not available right now. Please try again shortly.' } }),
  }));
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.click('#panel [data-act="pass"]');
  await p.waitForTimeout(300);
  await p.click('#ps-go');
  await p.waitForTimeout(900);
  ok(await p.evaluate(() => !!document.querySelector('#panel [data-take]')),
    'a pass the server never heard reverts to the offer, take button live');
  /* The 500 above is the fixture, not a finding: the browser logs every non-2xx
     resource, and this group exists to provoke exactly one. Drain that one line
     so the zero-console-error contract keeps meaning something. */
  const expected = errors.findIndex(t => /500/.test(t));
  ok(expected >= 0, 'and the browser logged the provoked 500, nothing else new');
  if (expected >= 0) errors.splice(expected, 1);
  await c.close();
}

/* ------------------------------------------------------------------ *
 * 13. Eligibility: which cohort is offered, and to whom
 *
 * The rule can fail silently in BOTH directions and neither failure looks
 * broken from this page: too tight and a live cohort quietly stops taking the
 * households it was built for, too loose and the wrong end of the province
 * lands on a partner's desk. So what is asserted here is not "the right thing
 * renders" but "the wrong thing cannot be pressed": the featured tile, the one
 * green pill, and above all which cards carry a join target.
 *
 * Server-side enforcement is NOT tested here and cannot be: this harness
 * fulfils the routes itself. guards.requireEligible is held by
 * scripts/test-geo.mjs, and it is the authority in any case.
 * ------------------------------------------------------------------ */
const elig = (id, region, e, extra = {}) => camp(id, region, 'Autumn cohort',
  { eligibility: e, joinable: e === 'eligible' || e === 'unscoped', ...extra });

console.log('\n13a. a cohort open to this postal code is the featured tile');
{
  const c = await ctx(browser, {
    memberFsa: 'M2N', postalCodeState: 'present',
    campaigns: [
      /* Sorts first and is somewhere else: under the old rule it was featured. */
      elig('downtown-core', 'Downtown Core', 'not_in_area', { nearbyTier: 1 }),
      elig('north-york-central', 'North York Central', 'eligible', { nearbyTier: 0 }),
    ],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const s = await snapshot(p);
  ok(/North York Central/.test(s.regmono || ''),
    `the eligible cohort is featured over the one that sorts first (${s.regmono})`);
  const pills = await p.evaluate(() => Array.from(document.querySelectorAll('#crow .badge'))
    .map(e => e.innerText.trim()));
  ok(pills.filter(t => /Open to you/.test(t)).length === 1,
    `exactly one card claims Open to you (${pills.join(' | ')})`);
  ok(await p.evaluate(() => document.querySelectorAll('#crow [data-choose]').length === 1),
    'and exactly one card carries a join target');
  ok(await p.evaluate(() => !!document.querySelector('#crow [data-away]')),
    'the cohort somewhere else is still a card, and still pressable');
  await c.close();
}

console.log('\n13b. a cohort somewhere else can be read and cannot be joined');
{
  const c = await ctx(browser, {
    memberFsa: 'M2N', postalCodeState: 'present',
    campaigns: [elig('scarborough-east', 'Scarborough East', 'not_in_area', { nearbyTier: 1 })],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  ok(await p.evaluate(() => !document.querySelector('#crow [data-choose]')),
    'no join target anywhere on the row');
  ok(await p.evaluate(() => !Array.from(document.querySelectorAll('#crow .badge'))
    .some(e => /Open to you/.test(e.innerText))), 'and nothing claims Open to you');
  const tile = await p.evaluate(() => (document.querySelector('.is-main') || {}).innerText || '');
  ok(/Nothing open near you yet/.test(tile),
    'the tile says nothing is open rather than offering a cohort elsewhere');
  /* THE PRESS IS NOT DEAD. A card with no reason on it is the worse lie. */
  await p.click('#crow [data-away]');
  await p.waitForTimeout(300);
  const modal = await p.evaluate(() => (document.querySelector('#mbody') || {}).innerText || '');
  ok(/isn.t in your area/i.test(modal), 'pressing it explains why, in its own words');
  ok(/Change my postal code/.test(modal), 'and offers the one thing that can change the answer');
  ok(!/M2N|M4C|FSA/.test(modal), 'without naming a postal code area anywhere');
  await c.close();
}

console.log('\n13c. no postal code on file is its own card, not "nothing open"');
{
  const c = await ctx(browser, {
    memberFsa: null, postalCodeState: 'missing',
    campaigns: [elig('north-york-central', 'North York Central', 'not_in_area')],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const tile = await p.evaluate(() => (document.querySelector('.is-main') || {}).innerText || '');
  ok(/Add your postal code to see cohorts/.test(tile),
    'the tile asks for the postal code');
  ok(!/Nothing open near you yet/.test(tile),
    'and does not claim to know what is open near somebody it cannot place');
  await p.click('.is-main [data-act="setpostal"]');
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => !!document.querySelector('#pe-in')),
    'and the button opens the field');
  await c.close();
}

console.log('\n13d. a stored postal code this stack can no longer parse says so');
{
  const c = await ctx(browser, {
    memberFsa: null, postalCodeState: 'invalid',
    campaigns: [elig('north-york-central', 'North York Central', 'not_in_area')],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const tile = await p.evaluate(() => (document.querySelector('.is-main') || {}).innerText || '');
  ok(/Add your postal code to see cohorts/.test(tile),
    'the same prompt, rather than an empty dashboard with no explanation');
  await c.close();
}

console.log('\n13e. a cohort in your area that has closed beats "nothing open"');
{
  const c = await ctx(browser, {
    memberFsa: 'M2N', postalCodeState: 'present',
    campaigns: [camp('north-york-central', 'North York Central', 'Autumn cohort',
      { kind: 'auction', stage: 'bidding', stageLabel: 'Sealed bidding',
        joinable: false, eligibility: 'joins_closed', nearbyTier: 0 })],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const tile = await p.evaluate(() => (document.querySelector('.is-main') || {}).innerText || '');
  ok(/past its join window/.test(tile),
    'the tile names the cohort and the fact that this round has shut');
  ok(!/Nothing open near you yet/.test(tile),
    'rather than telling a member with a live region that we have never heard of it');
  ok(await p.evaluate(() => !document.querySelector('.is-main [data-choose][data-join]')),
    'and offers no join');
  await c.close();
}

console.log('\n13f. an unscoped cohort behaves exactly as it did before coverage');
{
  /* The migration state: a campaign written before postal code areas existed.
     It is open to everyone, which is what was true yesterday, and the card
     must not claim a match nothing computed. */
  const c = await ctx(browser, {
    memberFsa: 'M2N', postalCodeState: 'present',
    campaigns: [elig('north-york-central', 'North York Central', 'unscoped')],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  ok(await p.evaluate(() => !!document.querySelector('#crow [data-choose]')),
    'it can still be joined');
  ok(await p.evaluate(() => !Array.from(document.querySelectorAll('#crow .badge'))
    .some(e => /Open to you/.test(e.innerText))),
    'and does not claim to be open to this postal code in particular');
  await c.close();
}

console.log('\n13g. two eligible cohorts: one featured, the other first in the rail');
{
  const c = await ctx(browser, {
    memberFsa: 'M2N', postalCodeState: 'present',
    campaigns: [
      elig('north-york-central', 'North York Central', 'eligible', { nearbyTier: 0 }),
      elig('north-york-east', 'North York East', 'eligible', { nearbyTier: 0 }),
      elig('scarborough-east', 'Scarborough East', 'not_in_area', { nearbyTier: 1 }),
    ],
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const cards = await p.evaluate(() => Array.from(document.querySelectorAll('#crow .cc'))
    .map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  ok(/North York Central/.test(cards[0] || ''), 'the featured cohort leads the row');
  ok(/North York East/.test(cards[1] || ''),
    'the second eligible one is next, not buried under the one nearby');
  /* Reads the card's own NAME, which is the assertion that caught a <button>
     inside a <button>: the bell and the not-in-area target both rendered, the
     parser closed the outer one early, and this card's name and subtitle ended
     up outside the card as an empty pill. */
  ok(/Scarborough East/.test(cards[2] || ''),
    `and the one elsewhere follows both, whole (${cards[2]})`);
  ok(await p.evaluate(() => Array.from(document.querySelectorAll('#crow .badge'))
    .filter(e => /Open to you/.test(e.innerText)).length === 2),
    'both eligible cards carry the pill');
  await c.close();
}

console.log('\n13h. a change of postal code that costs a cohort asks first');
{
  const c = await ctx(browser, {
    memberFsa: 'M2N', postalCodeState: 'present',
    campaigns: [elig('scarborough-east', 'Scarborough East', 'not_in_area', { nearbyTier: 1 })],
    profileSave: {
      status: 409,
      body: { error: { code: 'CONFLICT',
        message: 'North York Central covers your current postal code, not the new one. Save the change and you’ll leave the cohort.',
        reason: 'leave_cohort_required',
        cohort: { id: 'north-york-central', region: 'North York Central', sub: 'Autumn cohort' } } },
    },
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.click('#crow [data-away]');
  await p.waitForTimeout(250);
  await p.click('[data-postal]');
  await p.waitForTimeout(250);
  await p.fill('#pe-in', 'M1B 2C3');
  await p.click('#pe-save');
  await p.waitForTimeout(600);
  const modal = await p.evaluate(() => (document.querySelector('#mbody') || {}).innerText || '');
  ok(/leaves your cohort/i.test(modal),
    'the server names the consequence and the dialog reopens carrying it');
  ok(/Save and leave cohort/.test(modal) && /Keep my postal code/.test(modal),
    'with both answers on it');
  /* The typed value survives the second dialog: a member who has to confirm
     should not have to retype what they confirmed. */
  ok(/M1B ?2C3/.test(await p.inputValue('#pe-in')), 'and the value they typed is still in the field');
  /* The 409 is the fixture, not a finding. */
  const provoked = errors.findIndex(t => /409/.test(t));
  if (provoked >= 0) errors.splice(provoked, 1);
  await c.close();
}

console.log('\n13i. an invalid postal code is refused in the field, without a round trip');
{
  let posted = 0;
  const c = await ctx(browser, {
    memberFsa: 'M2N', postalCodeState: 'present',
    campaigns: [elig('north-york-central', 'North York Central', 'eligible')],
  });
  await c.route('**/api/auth/me/profile', r => { posted += 1; r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: {} }) }); });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  /* Opened through the document listener rather than through whichever tile
     happens to be showing, so this group is about the field and not about the
     route to it. Dispatched rather than clicked: the handle is appended with
     no box of its own and Playwright will not click something invisible. */
  await p.evaluate(() => {
    const b = document.createElement('button');
    b.setAttribute('data-postal', 'north-york-central');
    document.body.appendChild(b);
    b.click();
  });
  await p.waitForTimeout(250);
  for (const bad of ['D1A 1A1', 'M2N4K', '12345']) {
    await p.fill('#pe-in', bad);
    await p.click('#pe-save');
    await p.waitForTimeout(200);
    ok(await p.evaluate(() => { const e = document.querySelector('#pe-err'); return e && !e.hidden; }),
      `${bad} is refused in the field`);
  }
  ok(posted === 0, `and nothing was posted while it was wrong (${posted} requests)`);
  await c.close();
}

console.log(`\n${pass} passed, ${fail} failed, ${new Set(errors).size} distinct console error(s)`);
for (const e of new Set(errors)) console.log('  console: ' + e);
await browser.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
