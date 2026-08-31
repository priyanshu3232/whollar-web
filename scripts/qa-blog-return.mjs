#!/usr/bin/env node
/* Browser checks for the dashboard -> article -> dashboard lane.
 *
 *   node scripts/dev-server.mjs          # in another shell, port 3000
 *   node scripts/qa-blog-return.mjs
 *   node scripts/qa-blog-return.mjs http://localhost:4173
 *
 * A sibling of qa-dashboard.mjs and qa-console.mjs, and not wired into CI for
 * the same reason: Playwright's browser binary costs real time on every run
 * and check-frontend.yml is deliberately install-free. Run it by hand after
 * touching js/blog-return.js, the article masthead, or the dashboard's
 * Knowledge centre.
 *
 * THE BUG THIS FILE EXISTS FOR. The dashboard's Knowledge centre links out to
 * /blog/<slug>, static pages on the public marketing site. Their masthead says
 * "All articles" and pointed at /blog/, the public resources index, which has
 * no route back into a signed-in surface. A member who opened a read was
 * dropped out of the product with nothing to click and had to type the
 * dashboard URL again. Every check below is one link in the chain that now
 * carries them back.
 *
 * Every Catalyst call is intercepted through a CATCH-ALL, for the reason
 * qa-console.mjs learned the expensive way: scripts/dev-server.mjs proxies
 * /api/auth/* to the real Development environment, there is no local emulator,
 * and an un-stubbed endpoint is a test writing to live data.
 */

import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

const ART = '/blog/overpaying-internet-canada';
const ART2 = '/blog/internet-price-increase-promo-cliff';
const MOBART = '/MobileVersion/blog/overpaying-internet-canada';
const BACK = '/dashboard#knowledge';

const ours = (m) => { const u = (m.location && m.location().url) || ''; return !u || u.startsWith(BASE); };
const errors = [];
const collect = (page) => {
  page.on('console', m => { if (m.type() === 'error' && ours(m)) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
};

const REC = {
  emailKey: 'ada@example.com', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace',
  phone: '(416) 555 0134', postal: 'M5S 2J7', fsa: 'M5S', provinceCode: 'ON',
};

/* Read the back link the way a reader meets it: the one in the masthead. */
const backHref = (p) => p.evaluate(() => {
  const a = document.querySelector('.mast a.back');
  return a ? a.getAttribute('href') : null;
});

/* A plain browsing context. The articles are static pages: nothing to stub. */
async function blogCtx(browser, opts) {
  const c = await browser.newContext(opts || {});
  await c.route('**/clarity.ms/**', r => r.abort());
  return c;
}

/* The dashboard's context, with the whole backend answered locally. */
async function dashCtx(browser) {
  const c = await browser.newContext();
  await c.route('**/clarity.ms/**', r => r.abort());
  await c.route('**/api/auth/**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [], coverage: [] }),
  }));
  await c.route('**/api/auth/session', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, user: { ...REC, userType: 'member' } }),
  }));
  await c.addInitScript(rec => {
    localStorage.setItem('whollar.member', JSON.stringify(rec));
  }, REC);
  return c;
}

const browser = await chromium.launch();

console.log('\n1. the public article is untouched');
{
  const c = await blogCtx(browser);
  const p = await c.newPage();
  collect(p);
  await p.goto(`${BASE}${ART}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(200);
  ok(await backHref(p) === '/blog/', 'a reader off Google still goes to the public index');
  ok(await p.locator(`a[href*="from=dashboard"]`).count() === 0, 'and no link on the page is stamped');
  await c.close();
}

console.log('\n2. an article opened from the dashboard sends the reader back to it');
{
  const c = await blogCtx(browser);
  const p = await c.newPage();
  collect(p);
  await p.goto(`${BASE}${ART}?from=dashboard`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(200);
  ok(await backHref(p) === BACK, `"All articles" points at the Knowledge centre (${await backHref(p)})`);
  ok(!/from=dashboard/.test(p.url()), `the stamp is wiped from the address bar (${p.url().replace(BASE, '')})`);
  ok(await p.locator('.mast a.back span').innerText() === 'All articles', 'and the label is unchanged');
  const rel = await p.locator(`a[href^="${ART2}"]`).first().getAttribute('href');
  ok(/from=dashboard/.test(rel || ''), `cross-links carry the lane on (${rel})`);
  await c.close();
}

console.log('\n3. the lane survives a hop between articles, stamp or no stamp');
{
  const c = await blogCtx(browser);
  const p = await c.newPage();
  collect(p);
  await p.goto(`${BASE}${ART}?from=dashboard`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(200);
  /* A BARE url, no stamp: this is what sessionStorage is for, and the only
     check that fails if it is dropped. */
  await p.goto(`${BASE}${ART2}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(200);
  ok(await backHref(p) === BACK, 'the second article still knows which lane it is in');
  await c.close();
}

console.log('\n4. the public resources index is no longer a dead end');
{
  const c = await blogCtx(browser);
  const p = await c.newPage();
  collect(p);
  await p.goto(`${BASE}/blog/?from=dashboard`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(200);
  ok(await backHref(p) === BACK, 'a back link is put into the masthead');
  ok(await p.locator('.mast .left a.brand').count() === 1, 'beside the wordmark, not on top of it');

  const c2 = await blogCtx(browser);
  const p2 = await c2.newPage();
  collect(p2);
  await p2.goto(`${BASE}/blog/`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(200);
  ok(await backHref(p2) === null, 'and a visitor who never saw the dashboard gets no such link');
  await c.close(); await c2.close();
}

console.log('\n5. the phone copy of the article, whose back link is a different page');
{
  const c = await blogCtx(browser, { viewport: { width: 390, height: 844 } });
  const p = await c.newPage();
  collect(p);
  await p.goto(`${BASE}${MOBART}?from=dashboard`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(300);
  ok(!/resources-mobile/.test(p.url()), 'the device router leaves the mobile copy alone on a phone');
  ok(await backHref(p) === BACK, `and /MobileVersion/resources-mobile is replaced too (${await backHref(p)})`);
  await c.close();
}

console.log('\n6. the desktop article on a phone carries the stamp through the router');
{
  const c = await blogCtx(browser, { viewport: { width: 390, height: 844 } });
  const p = await c.newPage();
  collect(p);
  await p.goto(`${BASE}${ART}?from=dashboard`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(400);
  ok(/MobileVersion\/blog/.test(p.url()), `routed to the mobile copy (${p.url().replace(BASE, '')})`);
  ok(await backHref(p) === BACK, 'and the lane survived the redirect');
  await c.close();
}

console.log('\n7. the dashboard stamps what it links to');
{
  const c = await dashCtx(browser);
  const p = await c.newPage();
  collect(p);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  const tiles = await p.locator('#klist a.ktile').count();
  const stamped = await p.locator('#klist a.ktile[href*="?from=dashboard"]').count();
  ok(tiles === 16, `the Knowledge centre renders all sixteen articles (${tiles})`);
  ok(stamped === tiles, `and every tile is stamped (${stamped}/${tiles})`);
  const reads = await p.locator('#reads a').count();
  const readsStamped = await p.locator('#reads a[href*="?from=dashboard"]').count();
  ok(reads > 0 && readsStamped === reads, `Worth a read is stamped too (${readsStamped}/${reads})`);
  await c.close();
}

console.log('\n8. /dashboard#knowledge opens on the Knowledge centre');
{
  const c = await dashCtx(browser);
  const p = await c.newPage();
  collect(p);
  await p.goto(`${BASE}/dashboard#knowledge`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  ok(await p.locator('.view[data-v="knowledge"].on').count() === 1, 'the reading list is the view on screen');
  ok(await p.locator('.view[data-v="dashboard"].on').count() === 0, 'and Home is not');
  ok(await p.locator('#pnav button[data-view="knowledge"].on').count() === 1, 'the rail marks where the reader is');

  /* An unknown hash must not blank the pane: nav() with a name no section
     carries turns every view off. */
  const p2 = await c.newPage();
  collect(p2);
  await p2.goto(`${BASE}/dashboard#nonsense`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(600);
  ok(await p2.locator('.view.on').count() === 1, 'a hash naming no view leaves the default one alone');
  await c.close();
}

console.log('\n9. the round trip, clicked rather than typed');
{
  const c = await dashCtx(browser);
  const p = await c.newPage();
  collect(p);
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  await p.locator('#pnav button[data-view="knowledge"]').click();
  await p.locator('#klist a.ktile').first().click();
  await p.waitForURL(/\/blog\//, { timeout: 8000 });
  await p.waitForTimeout(300);
  ok(/\/blog\//.test(p.url()), `the article opens (${p.url().replace(BASE, '')})`);
  await p.locator('.mast a.back').click();
  await p.waitForURL(/\/dashboard/, { timeout: 8000 });
  await p.waitForTimeout(700);
  ok(/#knowledge$/.test(p.url()), `"All articles" lands back on the dashboard (${p.url().replace(BASE, '')})`);
  ok(await p.locator('.view[data-v="knowledge"].on').count() === 1, 'on the reading list they left, not on Home');
  await c.close();
}

await browser.close();

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of [...new Set(errors)]) console.log(`  ${e}`);
}
console.log(`\n${pass}/${pass + fail} checks passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail || errors.length ? 1 : 0);
