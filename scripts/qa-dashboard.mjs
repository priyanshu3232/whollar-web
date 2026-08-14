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

/* A member record shaped like the one whollar-login-consumer.html writes. */
const REC = { emailKey: 'ada@example.com', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };

const DAY = 86400000;
/* A campaign shaped like publicCampaign() in routes/campaigns.js. */
function camp(id, region, sub, { you = null, kind = 'forming', stage = 'forming', members = 44 } = {}) {
  const t = Date.now();
  return {
    id, region, sub, kind, target: 100, members, households: members, watching: 0,
    joinable: true, you, stage, stageLabel: stage, next: null,
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
  ok(/44 of 100/.test(s.panel) && /44 of 100/.test(s.hist),
    'and the panel and the history agree on the count');
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
  ok(/44 of 100/.test(s.regmono || ''), `the region row shows the live count (${s.regmono})`);
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
