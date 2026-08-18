#!/usr/bin/env node
/* Acceptance tests for js/whollar-select.js, the site-wide dropdown.
 *
 * Run: node --test scripts/test-select-dom.mjs
 *
 * Drives the real bill-checkup page in headless Chrome via playwright-core
 * (a devDependency; no browser download, the system Chrome is used). The
 * repo's own dev server serves the page and every external host is blocked,
 * so this runs offline and writes nothing.
 *
 * WHAT IS ACTUALLY BEING GUARDED. The component hides the native <select> and
 * puts a button and a panel in front of it, but page code all over this site
 * reads and writes `select.value` and listens for 'change' on it. Every test
 * below is a version of the same question: is the native control still the
 * answer? A regression here does not look like a broken dropdown, it looks
 * like a form that submits the wrong provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4327;
const BASE = `http://localhost:${PORT}`;

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
];

let server, browser, page, consoleErrors = [];

test.before(async () => {
  const exe = CHROME_PATHS.find(p => existsSync(p));
  if (!exe) throw new Error('no system Chrome found');
  server = spawn(process.execPath, [join(ROOT, 'scripts/dev-server.mjs')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/bill-checkup'); if (r.ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: exe });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', route =>
    route.request().url().startsWith(BASE) ? route.continue() : route.abort());
  page = await ctx.newPage();
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/net::|Failed to load resource|ERR_FAILED/.test(t)) return;
    consoleErrors.push(t);
  });
  page.on('pageerror', e => consoleErrors.push(String(e)));
  await page.goto(`${BASE}/bill-checkup.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.WHOLLAR && window.WHOLLAR.select));
  await page.waitForSelector('#prov.wselnative');
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

test('1: every select on the page is enhanced and none is left native', async () => {
  const bare = await page.$$eval('select', els =>
    els.filter(e => !e.classList.contains('wselnative')).map(e => e.id));
  assert.deepEqual(bare, []);
  const count = await page.$$eval('.wsel', els => els.length);
  assert.ok(count >= 4, `expected the four checkup dropdowns, saw ${count}`);
});

test('2: the trigger starts on the placeholder wording, and the placeholder is not a row', async () => {
  const txt = await page.textContent('#prov ~ .wseltrig .wseltxt');
  assert.equal(txt.trim(), 'Choose…');
  const isPh = await page.$eval('#prov ~ .wseltrig .wseltxt', e => e.classList.contains('ph'));
  assert.equal(isPh, true);
  const rows = await page.$$eval('#prov-wselp .wselopt', els => els.map(e => e.textContent));
  assert.equal(rows.includes('Choose…'), false);
  assert.equal(rows[0], 'Rogers');
});

test('3: a pick writes through to the native select, fires change, and closes the panel', async () => {
  await page.evaluate(() => {
    window.__fired = 0;
    document.getElementById('prov').addEventListener('change', () => { window.__fired++; });
  });
  await page.click('#prov ~ .wseltrig');
  assert.equal(await page.isVisible('#prov-wselp'), true);
  await page.click('#prov-wselp .wselopt >> text="Bell"');
  assert.equal(await page.inputValue('#prov'), 'Bell');
  assert.equal(await page.evaluate(() => window.__fired), 1);
  assert.equal(await page.isVisible('#prov-wselp'), false);
  assert.equal((await page.textContent('#prov ~ .wseltrig .wseltxt')).trim(), 'Bell');
});

test('4: a single select shows no checkbox, and marks its one answer', async () => {
  const box = await page.$eval('#prov-wselp .wselopt',
    e => getComputedStyle(e, '::before').content);
  assert.ok(box === 'none' || box === 'normal', `single select drew a checkbox: ${box}`);
  const on = await page.$$eval('#prov-wselp .wselopt.on', els => els.map(e => e.textContent));
  assert.deepEqual(on, ['Bell']);
});

test('5: a value set in code with no event still reaches the trigger', async () => {
  await page.evaluate(() => { document.getElementById('tech').value = 'Satellite'; });
  assert.equal((await page.textContent('#tech ~ .wseltrig .wseltxt')).trim(), 'Satellite');
  assert.equal(await page.inputValue('#tech'), 'Satellite');
});

test('6: the value survives a round trip through the page own prefill path', async () => {
  /* setFieldValue() is what the bill reader uses: assign, then dispatch. */
  await page.evaluate(() => {
    const el = document.getElementById('spd');
    el.value = '500';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal((await page.textContent('#spd ~ .wseltrig .wseltxt')).trim(), '500 Mbps');
});

test('7: opening one dropdown closes the other', async () => {
  await page.click('#prov ~ .wseltrig');
  await page.click('#tech ~ .wseltrig');
  assert.equal(await page.isVisible('#prov-wselp'), false);
  assert.equal(await page.isVisible('#tech-wselp'), true);
});

test('8: Escape closes and hands focus back to the trigger', async () => {
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#tech-wselp'), false);
  const focused = await page.evaluate(() => document.activeElement.className);
  assert.ok(focused.includes('wseltrig'), `focus went to ${focused}`);
});

test('9: a click outside closes an open panel', async () => {
  await page.click('#prov ~ .wseltrig');
  await page.mouse.click(5, 5);
  assert.equal(await page.isVisible('#prov-wselp'), false);
});

test('10: a mouse open leaves focus on the trigger, and arrow keys walk the rows', async () => {
  /* A row that takes focus the instant the panel opens paints itself as the
     answer, which is a pick nobody made. Only the keyboard enters the list. */
  await page.click('#len ~ .wseltrig');
  assert.equal(await page.evaluate(() =>
    document.activeElement.classList.contains('wseltrig')), true);
  assert.equal(await page.$$eval('#len-wselp .wselopt',
    els => els.filter(e => e === document.activeElement).length), 0);

  await page.keyboard.press('ArrowDown');   /* into the list, first row */
  await page.keyboard.press('ArrowDown');   /* second row: 12 months */
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#len'), '12');
});

test('11: label for= focuses the trigger, not the control nobody can see', async () => {
  await page.click('label[for="tech"]');
  const cls = await page.evaluate(() => document.activeElement.className);
  assert.ok(cls.includes('wseltrig'), `focus went to ${cls}`);
});

test('12: a multi select keeps its checkboxes, stays open, and select-all works', async () => {
  await page.evaluate(() => {
    const s = document.createElement('select');
    s.id = 'multitest';
    s.multiple = true;
    ['A', 'B', 'C'].forEach(t => { const o = document.createElement('option'); o.textContent = t; s.appendChild(o); });
    document.body.appendChild(s);
  });
  await page.waitForSelector('#multitest.wselnative');
  const box = await page.$eval('#multitest-wselp .wselopt',
    e => getComputedStyle(e, '::before').content);
  assert.ok(box !== 'none' && box !== 'normal', 'multi select drew no checkbox');
  await page.click('#multitest ~ .wseltrig');
  await page.click('#multitest-wselp .wselopt >> text="A"');
  await page.click('#multitest-wselp .wselopt >> text="C"');
  assert.equal(await page.isVisible('#multitest-wselp'), true, 'multi panel closed on a pick');
  const on = await page.$eval('#multitest',
    s => Array.from(s.selectedOptions).map(o => o.text).join(','));
  assert.equal(on, 'A,C');
  assert.equal((await page.textContent('#multitest ~ .wseltrig .wseltxt')).trim(), 'A, C');
  await page.click('#multitest-wselp .wselall');
  assert.equal(await page.$eval('#multitest',
    s => Array.from(s.selectedOptions).map(o => o.text).join(',')), 'A,B,C');
});

test('13: no console errors across the whole run', () => {
  assert.deepEqual(consoleErrors, []);
});
