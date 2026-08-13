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
 * the 67-endpoint register, all 18 fixture states, and the fixture layer
 * declining to install off localhost.
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

async function ctx(browser, { record = null, me = null, meStatus = 200 } = {}) {
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
  await c.route('**/api/auth/provider/me', r => r.abort('failed'));
  await c.route('**/api/auth/me/prefs', r => r.abort('failed'));
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
  /* A stub must fail the way the server will, or views learn the wrong error path. */
  const stub = await p.evaluate(() =>
    window.WHOLLAR.console.api.statements().then(() => null, e => ({ code: e.code, status: e.status })));
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
  ok(names.length >= 18, `fixture states defined (${names.length})`);
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
  ok(/Verifies with Markham coverage/.test(desk), 'a cohort in an unverified region is locked, and names the region');
  await c2.close();
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

await browser.close();
const uniq = [...new Set(errors)];
if (uniq.length) { console.log('\nconsole errors:'); uniq.forEach(e => console.log('  ! ' + e.slice(0, 160))); }
console.log(`\n${pass} passed, ${fail} failed, ${uniq.length} distinct console error(s)`);
process.exit(fail || uniq.length ? 1 : 0);
