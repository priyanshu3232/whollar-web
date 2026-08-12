#!/usr/bin/env node
/* Browser checks for the partner console (/provider-console).
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
 * all 11 views, four widths, and the burger's two behaviours. The 16-fixture
 * matrix arrives with the fixture layer.
 */

import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

/* A partner record shaped like the one whollar-login-provider.html writes. */
const REC = { emailKey: 'sam@northline.ca', email: 'sam@northline.ca', firstName: 'Sam', lastName: 'Kaur' };

async function ctx(browser, { record = null, me = null, meStatus = 200 } = {}) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Never let a test reach the real backend.
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
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${BASE}/provider-console`, { waitUntil: 'domcontentloaded' });
  const hidden = await p.evaluate(() => document.documentElement.style.visibility);
  ok(hidden === 'hidden', 'document hidden while the server is asked');
  const chromePainted = await p.evaluate(() => {
    const el = document.getElementById('app');
    return el ? getComputedStyle(el).visibility : 'none';
  });
  ok(chromePainted === 'hidden', 'the shell chrome is hidden too, so nothing flashes');
  await p.waitForURL(/whollar-login-provider/, { timeout: 8000 }).catch(() => {});
  ok(/whollar-login-provider/.test(p.url()), `redirected to sign-in (${p.url().replace(BASE, '')})`);
  ok(/next=%2Fprovider-console/.test(p.url()), 'carries ?next=/provider-console');
  await c.close();
}

console.log('\n2. signed in, approved: console renders on real payload');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${BASE}/provider-console`, { waitUntil: 'networkidle' });
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
  await p.goto(`${BASE}/provider-console`, { waitUntil: 'networkidle' });
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
  await p.goto(`${BASE}/provider-console`, { waitUntil: 'domcontentloaded' });
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
  await p.goto(`${BASE}/provider-console`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  ok(!/whollar-login-provider/.test(p.url()), 'stayed signed in through a failed poll');
  ok((await p.textContent('#paneorg')).length > 0, 'chrome still painted from the local record');
  await c.close();
}

console.log('\n6. cross-tab sign-out and bfcache');
{
  const c = await ctx(browser, { record: REC, me: APPROVED });
  const p = await c.newPage();
  await p.goto(`${BASE}/provider-console`, { waitUntil: 'networkidle' });
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
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${BASE}/provider-console`, { waitUntil: 'networkidle' });
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
    await p.goto(`${BASE}/provider-console`, { waitUntil: 'networkidle' });
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
  await p.goto(`${BASE}/provider-console`, { waitUntil: 'networkidle' });
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

await browser.close();
const uniq = [...new Set(errors)];
if (uniq.length) { console.log('\nconsole errors:'); uniq.forEach(e => console.log('  ! ' + e.slice(0, 160))); }
console.log(`\n${pass} passed, ${fail} failed, ${uniq.length} distinct console error(s)`);
process.exit(fail || uniq.length ? 1 : 0);
