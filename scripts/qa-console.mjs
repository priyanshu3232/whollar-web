#!/usr/bin/env node
/* Browser checks for the partner console (/partner).
 *
 *   node scripts/dev-server.mjs          # in another shell, port 3000
 *   node scripts/qa-console.mjs
 *   node scripts/qa-console.mjs http://localhost:4173
 *
 * Not wired into CI, for the same reason scripts/test-signal-card.mjs is not:
 * provisioning Playwright's browser binary costs real time on every run, and
 * check-frontend.yml is deliberately install-free. Run it by hand after
 * touching the console.
 *
 * Every Catalyst call is intercepted, so this never reaches the live
 * Development backend and never writes a row. That matters more here than
 * usual: scripts/dev-server.mjs proxies /api/auth/* to the real Development
 * environment, because there is no local emulator.
 *
 * COVERS: the four boot-guard paths (signed out, approved, pending, expired),
 * the one that must NOT sign anyone out (a network failure), the router across
 * all 11 views, four widths, the burger's two behaviours, the completeness of
 * the 67-endpoint register, all 19 fixture states, the fixture layer declining
 * to install off localhost, the bid ticket (seven-column tier table, consent
 * gate, a sealed place round-trip), the sealed receipt with no withdraw path
 * anywhere, the my-bids record with its nudge and result pills, and the
 * contracts registry with its terms gate on the desk, and the landing view an
 * unapproved partner arrives on with no hash.
 */

import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

/**
 * Only OUR errors count.
 *
 * Google Fonts intermittently 404s a woff2 from fonts.gstatic.com, which the
 * browser reports as a console error and which has nothing to do with this
 * code. Counting it made the suite fail about one run in three on a different
 * fixture each time, and a suite that cries wolf is a suite people stop
 * reading. Errors are attributed by the URL they came from, so a genuine
 * failure in our own scripts still fails.
 *
 * Fonts are deliberately NOT blocked outright: the overflow assertions measure
 * real text, and falling back to system metrics would change what they measure.
 */
const ours = (msg) => {
  const url = (msg.location && msg.location().url) || '';
  return !url || url.startsWith(BASE);
};
const collect = (page, sink) => {
  page.on('console', m => { if (m.type() === 'error' && ours(m)) sink.push(m.text()); });
  page.on('pageerror', e => sink.push(String(e)));
};

/* A partner record shaped like the one whollar-login-provider.html writes. */
const REC = { emailKey: 'sam@northline.ca', email: 'sam@northline.ca', firstName: 'Sam', lastName: 'Kaur' };

async function ctx(browser, { record = null, me = null, meStatus = 200, application = null, appStatus = 200 } = {}) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  /* CATCH-ALL FIRST, and it matters that it is a catch-all rather than a list.
     Playwright matches the most recently registered route first, so the
     specific handlers below still win; anything they do not name lands here
     instead of on the network.
     This is not belt and braces. scripts/dev-server.mjs proxies /api/auth/* to
     the real Development Catalyst environment, so an un-stubbed endpoint means
     a test writing to the live data store, and there is no local emulator to
     fall back on. It was also a live bug: the console grew three calls
     (coverage, campaigns, bids) that this file did not know about, and the
     symptom was `networkidle` never settling rather than anything saying so. */
  /* The generic envelope carries the empty collections as well as ok/live.
     Without them the payload is not contract-shaped, and on localhost the
     contract layer is STRICT and throws, so every list route resolved as
     "the table was unreadable" and three views rendered their failure state
     instead of their empty one. The catch-all's job is to keep requests off
     the network; it still has to answer in the shape the server answers in. */
  await c.route('**/api/auth/**', r =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [], coverage: [] }),
    }));

  await c.route('**/api/auth/provider/me', r =>
    r.fulfill({ status: meStatus, contentType: 'application/json', body: JSON.stringify(me || { error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.' } }) }));
  /* The application, when a test cares which one. Group 20 does: the landing
     view is derived from it, so "no application at all" and "five tasks in"
     are two different screens and both need saying. */
  if (application || appStatus !== 200) {
    await c.route('**/api/auth/provider/application', r => r.fulfill({
      status: appStatus,
      contentType: 'application/json',
      body: JSON.stringify(application || { error: { code: 'NOT_IMPLEMENTED', message: 'Not deployed yet.' } }),
    }));
  }
  await c.route('**/api/auth/me/prefs', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, prefs: {} }) }));
  await c.route('**/api/auth/session', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }) }));
  await c.route('**/api/auth/logout', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  /* Seed ONCE, on the first document only. addInitScript runs on every
     navigation, so an unguarded seed re-writes the partner record on the
     sign-in page too, whereupon that page sees a signed-in partner and sends
     the browser straight back. That produced two false failures. */
  if (record) {
    await c.addInitScript(rec => {
      if (sessionStorage.getItem('whl-seeded')) return;
      sessionStorage.setItem('whl-seeded', '1');
      localStorage.setItem('whollar.partner', JSON.stringify(rec));
    }, record);
  }
  return c;
}

const APPROVED = { ok: true, approved: true, user: { firstName: 'Sam', lastName: 'Kaur', email: 'sam@northline.ca' }, org: { name: 'Northline Internet', role: 'admin' } };
const PENDING = { ok: true, approved: false, user: { firstName: 'Sam', lastName: 'Kaur', email: 'sam@northline.ca' }, org: { name: 'Northline Internet', role: 'admin' } };

const browser = await chromium.launch();
const errors = [];

console.log('\n1. signed out: no flash, redirected to sign-in with ?next');
{
  /* Hold the session answer open so the hidden state is observable. Without
     the delay the redirect wins the race, which is the guard behaving well
     but makes the flash assertion untestable. */
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await c.route('**/api/auth/session', async r => {
    await new Promise(res => setTimeout(res, 900));
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }) });
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/partner`, { waitUntil: 'domcontentloaded' });
  const hidden = await p.evaluate(() => document.documentElement.style.visibility);
  ok(hidden === 'hidden', 'document hidden while the server is asked');
  const chromePainted = await p.evaluate(() => {
    const el = document.getElementById('app');
    return el ? getComputedStyle(el).visibility : 'none';
  });
  ok(chromePainted === 'hidden', 'the shell chrome is hidden too, so nothing flashes');
  await p.waitForURL(/whollar-login-provider/, { timeout: 8000 }).catch(() => {});
  ok(/whollar-login-provider/.test(p.url()), `redirected to sign-in (${p.url().replace(BASE, '')})`);
  ok(/next=%2Fpartner/.test(p.url()), 'carries ?next=/partner');
  await c.close();
}

console.log('\n2. signed in, approved: console renders on real payload');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  ok(!/whollar-login-provider/.test(p.url()), 'stayed on the console');
  ok((await p.textContent('#paneorg')) === 'Northline Internet', 'org name from /provider/me, not the email domain');
  ok(/Good (morning|afternoon|evening), Sam/.test(await p.textContent('#greetline')), 'greeting uses the real first name');
  ok((await p.textContent('#panerole')) === 'Account admin', 'role rendered from org.role');
  ok((await p.locator('#mainbanner .alertbar').count()) === 0, 'no under-review banner when approved');
  ok((await p.locator('#bootfail').isHidden()), 'boot-failure card stays hidden');
  await c.close();
}

console.log('\n3. signed in, NOT approved: banner appears, copy is honest');
{
  const c = await ctx(browser, { record: REC, me: PENDING });
  const p = await c.newPage();
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  ok((await p.locator('#mainbanner .alertbar').count()) === 1, 'under-review banner renders');
  ok((await p.textContent('#panerole')) === 'Under review', 'pane role says under review');
  const desk = await p.textContent('#desk-body');
  ok(/application clears/.test(desk), 'desk explains why it is empty for a pending partner');
  await c.close();
}

console.log('\n4. a 401 from /provider/me signs the tab out');
{
  const c = await ctx(browser, { record: REC, meStatus: 401 });
  const p = await c.newPage();
  await p.goto(`${BASE}/partner`, { waitUntil: 'domcontentloaded' });
  await p.waitForURL(/whollar-login-provider/, { timeout: 5000 }).catch(() => {});
  ok(/whollar-login-provider/.test(p.url()), 'bounced to sign-in on a definite 401');
  const left = await p.evaluate(() => localStorage.getItem('whollar.partner'));
  ok(left === null, 'stale local partner record cleared');
  await c.close();
}

console.log('\n5. a NETWORK failure must NOT sign anyone out');
{
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  /* EVERY call, not just the two the console made when this group was written.
     Naming a pair left coverage, campaigns, bids and the application on the
     network, where scripts/dev-server.mjs proxies them to the live Development
     backend. That backend has no session for this context, so it answered 401,
     and a 401 during boot correctly signs the tab out, which meant this group
     was asserting the opposite of what it says on the tin, and failing for a
     reason that had nothing to do with the network.
     Offline is offline: abort the lot, which is also the shape of the outage
     this group exists to describe. */
  await c.route('**/api/auth/**', r => r.abort('failed'));
  await c.addInitScript(rec => {
    if (sessionStorage.getItem('whl-seeded')) return;
    sessionStorage.setItem('whl-seeded', '1');
    localStorage.setItem('whollar.partner', JSON.stringify(rec));
  }, REC);
  const p = await c.newPage();
  await p.goto(`${BASE}/partner`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  ok(!/whollar-login-provider/.test(p.url()), 'stayed signed in through a failed poll');
  ok((await p.textContent('#paneorg')).length > 0, 'chrome still painted from the local record');
  await c.close();
}

console.log('\n6. cross-tab sign-out and bfcache');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  // Simulate another tab clearing the record, which fires `storage` here.
  await p.evaluate(() => {
    localStorage.removeItem('whollar.partner');
    window.dispatchEvent(new StorageEvent('storage', { key: 'whollar.partner', newValue: null }));
  });
  await p.waitForTimeout(800);
  ok(/whollar-login-provider/.test(p.url()) || (await p.evaluate(() => document.documentElement.style.visibility)) === 'hidden',
    'cross-tab sign-out tore the console down');
  await c.close();
}

console.log('\n7. navigation reaches all 11 views');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  const views = ['overview', 'desk', 'plan', 'bids', 'billing', 'coverage', 'delivery', 'perf', 'contracts', 'pending', 'account'];
  let shown = 0;
  for (const v of views) {
    await p.evaluate(x => window.WHOLLAR.console.nav(x), v);
    const on = await p.locator(`section.view[data-v="${v}"].on`).count();
    const only = await p.locator('section.view.on').count();
    if (on === 1 && only === 1) shown++; else console.log(`        ${v}: on=${on} total-on=${only}`);
  }
  ok(shown === 11, `all 11 views render one at a time (${shown}/11)`);
  const nonEmpty = await p.evaluate(() =>
    ['ov-body', 'desk-body', 'bids-body', 'billing-body', 'cov-body', 'del-body', 'perf-body', 'con-body', 'pend-body', 'acct-body', 'plan-body']
      .filter(id => (document.getElementById(id).textContent || '').trim().length > 20).length);
  ok(nonEmpty === 11, `every view has real content, none blank (${nonEmpty}/11)`);
  await c.close();
}

console.log('\n8. four widths, zero horizontal overflow');
{
  for (const w of [1280, 940, 768, 390]) {
    const c = await ctx(browser, { record: REC, me: APPROVED });
    const p = await c.newPage();
    await p.setViewportSize({ width: w, height: 900 });
    await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
    let worst = 0;
    for (const v of ['overview', 'desk', 'billing', 'account', 'perf']) {
      await p.evaluate(x => window.WHOLLAR.console.nav(x), v);
      await p.waitForTimeout(60);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      worst = Math.max(worst, over);
    }
    ok(worst <= 0, `${w}px: no horizontal overflow (worst ${worst}px)`);
    await c.close();
  }
}

console.log('\n9. burger: collapses on desktop, overlays on mobile');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  await p.click('#burger');
  ok(await p.locator('#app.collapsed').count() === 1, 'desktop: pane collapses');
  await p.click('#burger');
  ok(await p.locator('#app.collapsed').count() === 0, 'desktop: pane restores');

  await p.setViewportSize({ width: 390, height: 800 });
  await p.click('#burger');
  ok(await p.locator('#app.paneopen').count() === 1, 'mobile: pane overlays');
  await p.click('#overlay');
  ok(await p.locator('#app.paneopen').count() === 0, 'mobile: overlay tap closes it');
  await c.close();
}

console.log('\n10. the endpoint register is complete');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  const reg = await p.evaluate(() => {
    const a = window.WHOLLAR.console.api;
    return { total: a.__count, live: a.__implemented, pending: a.__pending.length };
  });
  ok(reg.total === 67, `67 endpoints present (${reg.total})`);
  ok(reg.live + reg.pending === reg.total, `every one is either live or a tagged stub (${reg.live} live, ${reg.pending} stubbed)`);
  /* The auction core flipped four stubs live (brief, improve, bid, versions),
     bringing the register to 24, and the contracts registry flipped two more
     (contracts, termsAccept) for 26. Delivery and billing flipped fifteen more
     (the roster, the gate, the five order writes, capacity, and the statement
     and method reads and writes) for 41. A refactor that quietly turns a live
     endpoint back into a stub must fail here, not in production. */
  ok(reg.live >= 41, `at least 41 endpoints are live (${reg.live})`);
  /* A stub must fail the way the server will, or views learn the wrong error path. */
  /* `statements` was the canonical stub here until billing shipped. Proving
     stub behaviour with a live endpoint proves nothing, so this follows the
     frontier: `performance` is endpoint 63 and is still unbuilt. */
  const stub = await p.evaluate(() =>
    window.WHOLLAR.console.api.performance().then(() => null, e => ({ code: e.code, status: e.status })));
  ok(stub && stub.code === 'NOT_IMPLEMENTED' && stub.status === 501, 'a stub rejects as NOT_IMPLEMENTED/501, like the server will');
  await c.close();
}

console.log('\n11. every fixture renders, with no console error');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  const names = await p.evaluate(async () => {
    await new Promise(r => { const s = document.createElement('script'); s.src = '/partner/demo/fixtures.js'; s.onload = r; s.onerror = r; document.head.appendChild(s); });
    return window.WHOLLAR.console.fixtures ? window.WHOLLAR.console.fixtures.names : [];
  });
  ok(names.length >= 19, `fixture states defined (${names.length})`);
  await c.close();

  let clean = 0;
  for (const name of names) {
    const fc = await ctx(browser, { record: REC, me: APPROVED });
    const fp = await fc.newPage();
    const errs = [];
    collect(fp, errs);
    await fp.goto(`${BASE}/partner?fixture=${name}`, { waitUntil: 'networkidle' });
    await fp.waitForTimeout(120);
    const installed = await fp.evaluate(() => window.WHOLLAR.console.fixture && window.WHOLLAR.console.fixture.name);
    const painted = await fp.evaluate(() => (document.querySelector('section.view.on')?.textContent || '').trim().length);
    if (installed === name && painted > 20 && !errs.length) clean++;
    else console.log(`        ${name}: installed=${installed} painted=${painted} errors=${errs.length}${errs[0] ? ' :: ' + errs[0].slice(0, 90) : ''}`);
    await fc.close();
  }
  ok(clean === names.length, `all ${names.length} fixtures install and render clean (${clean}/${names.length})`);
}

console.log('\n12. coverage is the gate, and it explains itself');
{
  /* The blocker this increment cleared. A region only produces a biddable
     cohort once an admin verifies it, so both ends of that decision have to be
     legible to the partner: a verifying region says a check is running, and a
     rejected one says why. Silence on either reads as a broken console. */
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  await p.goto(`${BASE}/partner?fixture=covrejected#coverage`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(120);
  const cov = await p.locator('#cov-body').innerText();
  ok(/Not serviceable/.test(cov), 'a rejected region is labelled, not silently absent');
  ok(/Why:/.test(cov), 'and it says why');
  ok(/partners@whollar\.ca/.test(cov), 'and leaves a route back');
  await c.close();

  const c2 = await ctx(browser, { record: REC, me: APPROVED });
  const p2 = await c2.newPage();
  await p2.goto(`${BASE}/partner?fixture=motion#desk`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(120);
  const desk = await p2.locator('#desk-body').innerText();
  ok(/Verifies with Markham North coverage/.test(desk), 'a cohort in an unverified region is locked, and names the region');
  await c2.close();
}

console.log('\n12b. coverage is declared from a controlled vocabulary');
{
  /* The declared region IS the bid unit. While this was a text box a partner
     could declare "downtown-ish", the row wrote, and no cohort ever matched
     it. These checks are about the one property that fixes: nothing but a
     launch district can leave this field. */
  const c = await ctx(browser, { record: REC, me: APPROVED });
  /* Against the real declare path, not a fixture: the fixture layer has no
     entry for coverageDeclare, so a fixture run would test the 501 branch and
     call it a pass. Registered after ctx's routes, so this one wins. */
  const seeded = [
    { region: 'Scarborough East', slug: 'scarborough-east', status: 'active', techs: ['fibre'], speed: '1 Gig', lead: '5 business days' }
  ];
  let posted = null;
  await c.route('**/api/auth/provider/coverage', r => {
    const body = { ok: true, live: true, serverTime: Date.now(), coverage: seeded };
    if (r.request().method() === 'POST') {
      posted = JSON.parse(r.request().postData() || '{}');
      body.coverage = seeded.concat([{
        region: posted.region, slug: String(posted.region).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        status: 'verifying', techs: posted.techs, speed: posted.speed, lead: '5 business days'
      }]);
    }
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const p = await c.newPage();
  const errs = [];
  collect(p, errs);
  await p.goto(`${BASE}/partner#coverage`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(120);

  const combo = p.locator('#regin');
  ok(await combo.getAttribute('role') === 'combobox', 'the add row carries a combobox, not a free-text region');
  ok(await p.locator('#regpanel').count() === 1, 'and a results panel to filter into');

  await combo.click();
  await combo.fill('scar');
  await p.waitForTimeout(80);
  const opts = await p.locator('#regpanel .dopt').allInnerTexts();
  const heads = await p.locator('#regpanel .dgrp').allInnerTexts();
  ok(opts.length === 4 && opts.every((t) => /Scarborough/.test(t)), `"scar" narrows to the four Scarborough districts (${opts.length})`);
  ok(heads.length === 1 && /Scarborough/i.test(heads[0]), 'grouped under one municipality header');
  ok(/Already declared/.test(opts.join('|')), 'a district already in coverage says so');
  ok(await p.locator('#regpanel .dopt.off[aria-disabled="true"]').count() >= 1, 'and is not selectable');

  /* A queued district is visible and inert: a partner should see the ambition
     without being able to declare into a market that is not open. */
  await combo.fill('oakville');
  await p.waitForTimeout(80);
  const soon = await p.locator('#regpanel .dopt').first();
  ok(/Queued for launch/.test(await soon.innerText()), 'a soon district is tagged, not hidden');
  ok(await soon.getAttribute('aria-disabled') === 'true', 'and cannot be picked');

  await combo.fill('scarberia');
  await p.waitForTimeout(80);
  ok(await p.locator('#regpanel .dnone').count() === 1, 'gibberish matches nothing');
  await p.locator('[data-action="coverage:add"]').first().click();
  await p.waitForTimeout(200);
  ok(posted === null, 'Declare on an invented region sends nothing');
  const said = await p.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
  ok(/Pick a district from the list/.test(said), `and says why (${said})`);
  ok(!(await p.locator('#cov-body').innerText()).includes('scarberia'), 'and no free-text region reaches the table');

  /* Keyboard: down then Enter picks the first selectable row. */
  await combo.fill('scarborough n');
  await p.waitForTimeout(80);
  await combo.press('ArrowDown');
  await combo.press('Enter');
  ok(await combo.inputValue() === 'Scarborough North', 'up, down and Enter drive the list');
  ok(await p.locator('#regpanel').isHidden(), 'and picking closes it');

  /* Both selectors are dropdowns, so the harness opens each one the way a
     partner does. A pick that worked without opening would mean the options
     were reachable while the panel was closed. */
  await p.locator('.mseltrig[data-for="addtech"]').click();
  await p.locator('#addtech button').first().click();
  ok(await p.locator('#addtech').isVisible(), 'the services panel stays open across a pick');
  /* A speed tier is required now that the field is a SET of tiers rather than
     one top speed: declaring without one is refused, so the harness picks one
     the way a partner does. */
  await p.locator('.mseltrig[data-for="addspeed"]').click();
  ok(await p.locator('#addtech').isHidden(), 'and opening the other one closes it');
  await p.locator('#addspeed button[data-s]').first().click();
  await p.locator('#addspeed button[data-s]').nth(1).click();
  ok(/50 Mbps, 100 Mbps/.test(await p.locator('.mseltrig[data-for="addspeed"]').innerText()),
    'two tiers select together and the trigger reads back both');
  /* Only one of the two is wanted here, and the second pick was to prove the
     control is a multi-select, so it comes back off. */
  await p.locator('#addspeed button[data-s]').nth(1).click();
  await p.locator('[data-action="coverage:add"]').first().click();
  await p.waitForTimeout(400);
  const cov = await p.locator('#cov-body').innerText();
  const declared = await p.evaluate(() =>
    window.WHOLLAR.console.state().coverage.filter((c) => c.region === 'Scarborough North').length);
  ok(posted && posted.region === 'Scarborough North', 'Declare sends the district name the vocabulary owns');
  ok(declared === 1, 'and the table gains exactly one row for it');
  ok(/Scarborough North/.test(cov) && /Verifying/.test(cov), 'landing verifying, against facilities data');

  /* Second attempt on the same district: the list says it is taken and the
     button refuses, so a duplicate cannot be declared by either route. */
  posted = null;
  await combo.click();
  await combo.fill('Scarborough North');
  await p.waitForTimeout(80);
  const dup = await p.locator('#regpanel .dopt').first();
  ok(/Already declared/.test(await dup.innerText()), 'a declared district is marked in the list');
  await p.locator('[data-action="coverage:add"]').first().click();
  await p.waitForTimeout(200);
  ok(posted === null, 'and Declare on it sends nothing');

  ok(!errs.length, `no page errors through the picker (${errs.length})`);
  await c.close();

  /* On a phone, with the list open. The panel sits in flow rather than
     absolutely positioned precisely so it cannot be clipped by the table's
     horizontal scroll box or push the page sideways, and that claim is worth
     nothing unmeasured. */
  for (const w of [1280, 390]) {
    const cc = await ctx(browser, { record: REC, me: APPROVED });
    const pp = await cc.newPage();
    await pp.setViewportSize({ width: w, height: 900 });
    await pp.goto(`${BASE}/partner#coverage`, { waitUntil: 'networkidle' });
    await pp.waitForTimeout(120);
    await pp.locator('#regin').click();
    await pp.waitForTimeout(120);
    const m = await pp.evaluate(() => {
      const opt = document.querySelector('#regpanel .dopt');
      return {
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        shown: !document.getElementById('regpanel').hasAttribute('hidden'),
        tap: opt ? Math.round(opt.getBoundingClientRect().height) : 0
      };
    });
    ok(m.shown && m.over <= 0 && m.tap >= 36,
      `${w}px: the open list fits, no sideways scroll, ${m.tap}px rows`);
    await cc.close();
  }
}

console.log('\n13. the application checklist tracks per-task state');
{
  /* Five booleans would make "each piece starts its own check the moment it
     lands" decoration. This asserts the difference is visible: one cleared
     task and one still checking must not render identically. */
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  await p.goto(`${BASE}/partner?fixture=review#pending`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(120);
  const frame = await p.locator('#pend-body').innerText();
  ok(/Serviceability check/.test(frame), 'the review frame lists the serviceability check');
  ok(/decision lands by/i.test(frame), 'and names the decision date from decision_due_at');
  const gated = await p.evaluate(() => document.body.classList.contains('gated'));
  ok(gated, 'the frame is gated: no nav pane, no search');
  await c.close();

  const c2 = await ctx(browser, { record: REC, me: APPROVED });
  const p2 = await c2.newPage();
  await p2.goto(`${BASE}/partner?fixture=rejected#pending`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(120);
  const dec = await p2.locator('#pend-body').innerText();
  ok(/could not approve/i.test(dec), 'a declined application says so');
  ok(/apply again/i.test(dec), 'and leaves a route forward rather than a dead end');
  await c2.close();
}

console.log('\n14. the chrome controls actually navigate, by being clicked');
{
  /* Group 7 walks the views by CALLING console.nav(), which is why it passed
     while the two controls that reach Account did nothing at all: the ported
     markup kept the prototype's data-nav attribute and the action registry
     only listens for data-action. Sign out lives on Account, so the effect was
     a console with no reachable way to sign out.
     A programmatic navigation test cannot catch a dead attribute. This one
     clicks. */
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });

  await p.click('#paneprof');
  ok(await p.locator('section.view[data-v="account"].on').count() === 1, 'the pane profile button opens Account');

  await p.evaluate(() => window.WHOLLAR.console.nav('overview'));
  await p.click('#topava');
  ok(await p.locator('section.view[data-v="account"].on').count() === 1, 'the header avatar opens Account');

  ok(await p.locator('#acct-body [data-action="account:signout"]').count() === 1, 'and Account carries a sign-out control');

  /* Nothing may be left wired to the old attribute. The registry ignores it,
     so a data-nav button is a control that silently does nothing. */
  const dead = await p.evaluate(() => document.querySelectorAll('[data-nav]').length);
  ok(dead === 0, `no dead data-nav controls left in the DOM (${dead})`);

  /* Every data-action in the markup must have a handler, for the same reason. */
  const unhandled = await p.evaluate(() => {
    const reg = window.WHOLLAR.console.actions ? window.WHOLLAR.console.actions() : null;
    if (!reg) return null;
    const known = new Set([].concat(reg.click || [], reg.change || [], reg.input || [], reg.submit || []));
    return [...document.querySelectorAll('[data-action]')]
      .map(el => el.getAttribute('data-action'))
      .filter(a => !known.has(a));
  });
  if (unhandled !== null) ok(unhandled.length === 0, `every data-action in the DOM has a handler (${unhandled.join(', ') || 'all wired'})`);
  await c.close();
}

console.log('\n15. fixture mode cannot escape localhost');
{
  /* The real guarantee is .vercelignore: the file is not uploaded, so it 404s
     in every deployed environment. Assert the SECOND belt here, that the
     module refuses to install when the hostname is not local, by loading it
     under a hostname that is not. */
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  const refused = await p.evaluate(async () => {
    const src = await (await fetch('/partner/demo/fixtures.js')).text();
    // Run it with a non-local hostname and see whether it installs.
    const fake = { WHOLLAR: window.WHOLLAR, location: { hostname: 'www.whollar.ca', search: '?fixture=won', hash: '' }, console: { warn() {} } };
    const before = window.WHOLLAR.console.fixtures;
    new Function('window', 'globalThis', src).call(fake, fake, fake);
    return window.WHOLLAR.console.fixtures === before;
  });
  ok(refused, 'the module declines to install on a non-local hostname');

  const ignored = await fetch(`${BASE}/partner/demo/fixtures.js`).then(r => r.status);
  ok(ignored === 200, 'and it is still served locally, where it is meant to work');
  await c.close();
}

console.log('\n16. the ticket: seven columns, consent gates the seal, place round-trips');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/partner?fixture=open`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(120);

  await p.click('[data-action="desk:open"]');
  await p.waitForTimeout(150);

  /* Case-insensitive: .tiert th renders text-transform: uppercase, and
     innerText reports the rendered casing. */
  const head = await p.locator('.tiert.t7 thead').innerText().catch(() => '');
  ok(/sticker \/mo/i.test(head) && /effective \/mo/i.test(head), 'seven-column tier table: sticker and effective are separate columns');
  ok(await p.locator('.bmech option').count() === 5, 'five reduction presentations, custom included');
  ok(await p.locator('.bmech option[value="custom"]').count() === 1, 'the custom option is present');
  ok(await p.locator('.bconsent').count() === 1, 'the consent sentence is there');
  ok(await p.locator('[data-action="ticket:place"][disabled]').count() === 1, 'the seal button is disabled before consent');

  await p.click('.bconsent');
  await p.waitForTimeout(120);
  ok(await p.locator('[data-action="ticket:place"]:not([disabled])').count() === 1, 'consent enables the seal button');

  /* The brief must never leak another partner's anything. */
  const briefText = await p.locator('.brief').innerText().catch(() => '');
  ok(/Aggregates only\./.test(briefText), 'the brief says, and shows, aggregates only');

  await p.click('[data-action="ticket:place"]');
  await p.waitForTimeout(200);
  const placed = await p.evaluate(() => {
    const s = window.WHOLLAR.console.state();
    return s.bids.kw && s.bids.kw.state;
  });
  ok(placed === 'sealed', `placing writes the sealed bid into state (${placed})`);
  const deskText = await p.locator('#desk-body').innerText();
  ok(/Sealed/.test(deskText), 'and the desk row now shows the sealed pill');
  await c.close();
}

console.log('\n17. sealed means sealed: receipt, improve, and no withdraw path anywhere');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/partner?fixture=sealed`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(120);

  await p.click('[data-action="desk:open"]');
  await p.waitForTimeout(150);

  const receipt = await p.locator('.tkt .receipt').innerText().catch(() => '');
  ok(/Sealed/.test(receipt), 'the receipt opens with Sealed');
  ok(/Sticker/.test(receipt), 'and carries the sticker line');
  ok(/Improvable until close/.test(receipt), 'and says improvable until close');
  ok(/No withdrawals\./.test(receipt), 'and says no withdrawals');
  ok(await p.locator('[data-action="ticket:improve"]').count() === 1, 'the improve control is there');

  /* No withdraw affordance at any layer: no action name carries it, and no
     registered handler answers to it. */
  const withdraw = await p.evaluate(() => {
    const inDom = document.querySelectorAll('[data-action*="withdraw"], [data-action*="cancel-bid"], [data-action*="delete"]').length;
    const reg = window.WHOLLAR.console.actions();
    const inReg = [].concat(reg.click || [], reg.change || [], reg.input || [], reg.submit || [])
      .filter(a => /withdraw|delete/.test(a)).length;
    return inDom + inReg;
  });
  ok(withdraw === 0, 'no withdraw or delete affordance exists in DOM or registry');

  await p.click('[data-action="ticket:improve"]');
  await p.waitForTimeout(150);
  ok(await p.locator('.trow').count() === 2, 'the improve form prefills both sealed tiers');
  const guard = await p.locator('.bidform .receipt').innerText().catch(() => '');
  ok(/at least as good/.test(guard), 'and states the improvement rule');
  ok(await p.locator('[data-action="ticket:cancel"]').count() === 1, 'keeping the sealed version stays one click away');
  await c.close();
}

console.log('\n18. my bids: the record, the nudge, and the result pills');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/partner?fixture=sealed#bids`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(120);
  const rec = await p.locator('#bids-body').innerText();
  ok(/Scarborough/.test(rec), 'a sealed bid renders as a record row');
  ok(/Sealed/.test(rec), 'with the sealed pill');
  ok(await p.locator('#bids-body [data-action="bids:csv"]').count() === 1, 'and the record exports as CSV');
  await c.close();

  const c2 = await ctx(browser, { record: REC, me: APPROVED });
  const p2 = await c2.newPage();
  await p2.goto(`${BASE}/partner?fixture=open#bids`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(120);
  ok(await p2.locator('#bidnudge').count() === 1, 'nothing sealed while a cohort is open: the nudge renders');
  await c2.close();

  const c3 = await ctx(browser, { record: REC, me: APPROVED });
  const p3 = await c3.newPage();
  await p3.goto(`${BASE}/partner?fixture=lost#bids`, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(120);
  const lost = await p3.locator('#bids-body').innerText();
  ok(/Not selected/.test(lost), 'a lost bid says not selected, on the record');
  await c3.close();
}

console.log('\n19. contracts: the registry, the terms gate, and the accept path');
{
  /* Accepted terms: six rows, three pills, no accept button. */
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/partner?fixture=open#contracts`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(120);
  const rows = await p.$$eval('#con-body .conrow b', els => els.map(e => e.textContent.trim()));
  ok(rows.length === 6, `the registry paints six rows (${rows.length})`);
  ok(/Master services agreement/.test(rows[0] || '') && /Standard cohort terms/.test(rows[1] || ''),
    'the agreement rows come first, in the prototype\'s order');
  const pills = await p.$$eval('#con-body .pill', els => els.map(e => e.textContent.trim()));
  ok(pills.includes('Signed') && pills.includes('Accepted') && pills.includes('Verified'), `states render as pills (${pills.join(', ')})`);
  ok(await p.locator('#con-body [data-action="terms:open"]').count() === 0,
    'no accept button when the version in force is already accepted');
  await c.close();

  /* A version bump pauses bidding. The desk must not offer a bid the server
     will refuse, and accepting must unlock it in the same session. */
  const c2 = await ctx(browser, { record: REC, me: APPROVED });
  const p2 = await c2.newPage();
  collect(p2, errors);
  await p2.goto(`${BASE}/partner?fixture=terms#contracts`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(120);
  const bumped = await p2.locator('#con-body').innerText();
  ok(/You accepted v1/.test(bumped) && /accept v2/.test(bumped),
    'a bumped version names both, rather than reading as never accepted');

  await p2.evaluate(() => window.WHOLLAR.console.nav('desk'));
  await p2.waitForTimeout(120);
  await p2.click('[data-action="desk:open"]');
  await p2.waitForTimeout(600);
  const gated = await p2.locator('.tkt').innerText();
  ok(/Accept the standard terms to bid/.test(gated),
    'the ticket sends the partner to Contracts instead of offering a bid');

  await p2.evaluate(() => window.WHOLLAR.console.nav('contracts'));
  await p2.waitForTimeout(120);
  await p2.click('#con-body [data-action="terms:open"]');
  await p2.waitForTimeout(120);
  ok(await p2.locator('#modal .termls li').count() === 6, 'the modal lists the six standard terms');
  ok(await p2.locator('#terms-go').isDisabled(), 'accept is disabled until the box is ticked');
  await p2.click('#terms-ok');
  ok(!(await p2.locator('#terms-go').isDisabled()), 'ticking enables it');
  await p2.click('#terms-go');
  await p2.waitForTimeout(400);
  ok(await p2.locator('#modal').isHidden(), 'the modal closes on accept');
  ok((await p2.locator('#con-body').innerText()).includes('Accepted'), 'the row flips to accepted');

  await p2.evaluate(() => window.WHOLLAR.console.nav('desk'));
  await p2.waitForTimeout(300);
  const open = await p2.locator('.tkt').innerText();
  ok(/Place sealed bid/.test(open) && !/Accept the standard terms/.test(open),
    'and the desk unlocks in the same session');
  await c2.close();

  /* An unreadable registry says so. A zero here would be read as "you have
     never bid", which is a different fact from "we could not tell". */
  const c3 = await ctx(browser, { record: REC, me: APPROVED });
  const p3 = await c3.newPage();
  collect(p3, errors);
  await p3.goto(`${BASE}/partner#contracts`, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(200);
  const bare = await p3.locator('#con-body').innerText();
  ok(/could not be read|loading/.test(bare), 'a registry that did not answer says so');
  ok(!/0 on record/.test(bare), 'and invents no zero');
  await c3.close();
}

console.log('\n20. the landing view: where a partner arrives with no hash');
{
  /* The screen a partner meets the minute after signup. /whollar-login-provider
     sends them to /partner with no hash, and until a human approves the org the
     console has eleven views of nothing to show them, so the review frame is
     the landing view. It stays the landing view while the application is being
     filled in AND while it sits under review: same card, different row lit. */
  const EMPTY = { coverage: 'empty', registration: 'empty', documents: 'empty', agreement: 'empty', reference: 'empty' };
  const FULL = { coverage: 'cleared', registration: 'cleared', documents: 'cleared', agreement: 'cleared', reference: 'cleared' };
  const hash = (p) => new URL(p.url()).hash;

  const c = await ctx(browser, {
    record: REC, me: PENDING,
    application: { ok: true, state: 'draft', tasks: EMPTY, serverTime: Date.now() },
  });
  const p = await c.newPage();
  collect(p, errors);
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(200);
  ok(hash(p) === '#pending', `a new account lands on the review frame (${hash(p)})`);
  ok(await p.evaluate(() => document.body.classList.contains('gated')), 'and it is gated');
  ok(!(await p.locator('.pane').isVisible()), 'the nav pane is hidden, not merely unstyled');
  const draft = await p.innerText('#pend-body');
  ok(/Received. The rest is yours to start/.test(draft), 'the card reads as an application to start');
  ok(/Continue your application · 0 of 5 done/.test(draft), 'the one button counts what is done');

  /* A deep link is still a deep link. */
  await p.evaluate(() => { location.hash = '#coverage'; });
  await p.waitForTimeout(150);
  ok(!(await p.evaluate(() => document.body.classList.contains('gated'))), 'leaving the frame ungates it');
  await c.close();

  const c2 = await ctx(browser, {
    record: REC, me: PENDING,
    application: {
      ok: true, state: 'under_review', tasks: FULL,
      submittedAt: Date.now() - 60000, decisionDueAt: Date.now() + 40 * 3600e3, serverTime: Date.now(),
    },
  });
  const p2 = await c2.newPage();
  collect(p2, errors);
  await p2.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(200);
  ok(hash(p2) === '#pending', `a complete application lands on the same frame (${hash(p2)})`);
  const sent = await p2.innerText('#pend-body');
  ok(/Received. The clock is running/.test(sent), 'the card reads as sent');
  ok(/Review your application/.test(sent), 'and still offers a way back into the file');
  ok(/Your decision lands by/.test(sent), 'the decision row names the date');
  await c2.close();

  /* Approved partners are not sent to a review card about a decision that has
     already been made. */
  const c3 = await ctx(browser, {
    record: REC, me: APPROVED,
    application: { ok: true, state: 'approved', tasks: FULL, serverTime: Date.now() },
  });
  const p3 = await c3.newPage();
  collect(p3, errors);
  await p3.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(200);
  ok(hash(p3) === '#overview', `an approved partner lands on the overview (${hash(p3)})`);
  ok(!(await p3.evaluate(() => document.body.classList.contains('gated'))), 'not gated');
  await c3.close();

  /* The route can 501 while it is still being deployed. Parking a new partner
     on a card that says "reading your application", with the nav hidden, would
     be a locked door. NOTE: no collect() on this page. The 501 is deliberate
     and the browser logs it as a console error. */
  const c4 = await ctx(browser, { record: REC, me: PENDING, appStatus: 501 });
  const p4 = await c4.newPage();
  await p4.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  await p4.waitForTimeout(300);
  ok(hash(p4) === '#overview', `no application to show: the console comes back (${hash(p4)})`);
  ok(!(await p4.evaluate(() => document.body.classList.contains('gated'))), 'and nobody is locked behind it');
  await c4.close();
}

console.log('\n21. a 403 on a boot-path read is not a signed-out session');
{
  /* THE BOUNCE LOOP. Billing loads on boot and /provider/statements sits behind
     requireApproved, so an org under review answers 403 every time. The view
     called session.authFailed(), which bounces on 401 AND 403, so the console
     signed the partner out of the page they had just signed into, they signed
     back in, and it happened again. Delivery had the same shape on view-open.
     Only a 401 may bounce; anything else is a page state. */
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  /* No collect() here, alone among the groups: a refused fetch is logged by the
     browser itself as "Failed to load resource: 403", and this test exists to
     cause exactly that. Counting it would make the suite fail on the behaviour
     it is asserting. */
  await c.route('**/api/auth/provider/statements', r => r.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Your organisation is still under review.' } }),
  }));
  await c.route('**/api/auth/provider/orders', r => r.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Your organisation is still under review.' } }),
  }));
  await p.goto(`${BASE}/partner`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  ok(!/whollar-login-provider/.test(p.url()), `a 403 from statements does not bounce to sign-in (${p.url().split('/').pop()})`);
  await p.evaluate(() => window.WHOLLAR.console.nav('billing'));
  await p.waitForTimeout(150);
  const bill = await p.locator('#billing-body').innerText();
  ok(/statement/i.test(bill), 'billing renders a page rather than an empty host');
  await p.evaluate(() => window.WHOLLAR.console.nav('delivery'));
  await p.waitForTimeout(250);
  ok(!/whollar-login-provider/.test(p.url()), 'and neither does a 403 from the delivery board');
  const del = await p.locator('#del-body').innerText();
  ok(del.trim().length > 20, 'delivery renders a page too');
  await c.close();
}

await browser.close();
const uniq = [...new Set(errors)];
if (uniq.length) { console.log('\nconsole errors:'); uniq.forEach(e => console.log('  ! ' + e.slice(0, 160))); }
console.log(`\n${pass} passed, ${fail} failed, ${uniq.length} distinct console error(s)`);
process.exit(fail || uniq.length ? 1 : 0);
