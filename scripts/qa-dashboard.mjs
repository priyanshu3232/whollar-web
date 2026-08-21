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
 * THE REGRESSION THIS FILE EXISTS FOR. CAMPS is seeded with london-east marked
 * `you:'joined'` so the demo tour has a cohort to show. GET /campaigns returns
 * `visible(cat.list)`, a SUBSET: archived cohorts are dropped. Any seeded
 * campaign the server does not name keeps its seeded standing, so once
 * london-east archives, every member on the site was shown "Your campaign ·
 * London East · Autumn cohort" with a forming rail, a dated calendar and an
 * activity feed, none of it theirs. Groups 3 and 4 are that bug.
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
function camp(id, region, sub, { you = null, kind = 'forming', stage = 'forming', members = 44,
  joinable = true } = {}) {
  const t = Date.now();
  return {
    id, region, sub, kind, target: 100, members, households: members, watching: 0,
    joinable, you, stage, stageLabel: stage, next: null,
    dates: {
      announce_at: t - 9 * DAY, bidding_opens_at: t + 9 * DAY,
      bidding_closes_at: t + 11 * DAY, decision_at: t + 18 * DAY, switch_window_at: t + 30 * DAY,
    },
  };
}

async function ctx(browser, { record = REC, campaigns = [], live = true, sessionAuthed = true, bill = null } = {}) {
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
    body: JSON.stringify({ ok: true, live, serverTime: Date.now(), campaigns }),
  }));
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

console.log('\n6. a degraded read keeps the seeds rather than blanking the page');
{
  const c = await ctx(browser, { campaigns: [], live: false });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const s = await snapshot(p);
  ok(s.lane === 'visitor', 'live:false does not fabricate a cohort either');
  ok((s.regmono || '').length > 0, 'and the region row still says something');
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
  /* The offer the panel is about. Sealed is false because the cohort closed. */
  await c.route('**/api/auth/campaigns/*/offer', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true, sealed: false, live: true, closesAt: t - 20 * MIN, bidCount: 1,
      offer: {
        partner: 'Northline', price: '43', speed: '100 Mbps', technology: 'cable',
        guaranteeMonths: 24, afterLine: 'no scheduled change', equipment: 'byo',
        rentalMonthly: null, committedHouseholds: 4, reference: 'WB-1', tiers: [],
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

console.log(`\n${pass} passed, ${fail} failed, ${new Set(errors).size} distinct console error(s)`);
for (const e of new Set(errors)) console.log('  console: ' + e);
await browser.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
