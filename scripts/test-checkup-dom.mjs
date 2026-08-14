#!/usr/bin/env node
/* DOM and layout acceptance tests for the v17 checkup (spec sections 9.1,
 * 9.2, 9.4, 9.5, 9.6), including the rail clipping regression guard.
 *
 * Run: node --test scripts/test-checkup-dom.mjs
 *
 * Drives the real page in headless Chrome via playwright-core (a
 * devDependency; no browser download, the system Chrome is used). The repo's
 * own dev server serves the page; every external host is blocked and the
 * backend endpoints are stubbed, so this runs offline and writes nothing.
 * The page clock is virtual: the 5.6s loading sequence fast-forwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4319;
const BASE = `http://localhost:${PORT}`;
const NOW = new Date('2026-08-13T10:00:00');

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
];

let server, browser, consoleErrors = [];

function isoDaysFromNow(days) {
  const d = new Date(NOW.getTime() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

async function newPage(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: opts.reducedMotion || 'no-preference'
  });
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (url.includes('/bill-checkup-join')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"id":"test"}' });
    }
    if (url.includes('/deep-read')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"id":"test"}' });
    }
    if (url.includes('/api/auth/') || url.includes('catalystserverless')) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' });
    }
    return route.abort(); /* fonts, clarity, everything third-party */
  });
  const page = await ctx.newPage();
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    /* Blocked third-party resources and the stubbed 401s are ours; real page
       errors are not. */
    if (/net::|Failed to load resource|ERR_FAILED|status of 401/.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', e => consoleErrors.push(String(e)));
  await page.clock.install({ time: NOW });
  await page.goto(BASE + '/bill-checkup', { waitUntil: 'domcontentloaded' });
  return page;
}

/* Fill the form completely and submit; fast-forward the loading sequence. */
async function fillAndSubmit(page, o = {}) {
  await page.fill('#pc', o.pc ?? 'L5V 2C9');
  await page.selectOption('#prov', o.prov ?? 'Rogers');
  await page.selectOption('#spd', o.spd ?? '500');
  await page.selectOption('#tech', o.tech ?? 'Cable (TV coax jack)');
  if (o.startd) await page.fill('#startd', o.startd);
  await page.selectOption('#len', o.len ?? '24');
  if (o.pend) await page.fill('#pend', o.pend);
  if (!o.multi) {
    if (o.cost !== null) await page.fill('#cost', String(o.cost ?? '90'));
    if (o.stick != null) await page.fill('#stick', String(o.stick));
  }
  await page.fill('#email', o.email ?? 'test@example.com');
  await page.click('#check');
  /* five 1150ms phases plus the 1000ms handoff */
  for (let i = 0; i < 8; i++) await page.clock.fastForward(1000);
  await page.waitForSelector('#res.on', { timeout: 5000 });
}

async function screenState(page) {
  return page.evaluate(() => ({
    form: document.getElementById('form-card').offsetParent !== null,
    loading: document.getElementById('loading').classList.contains('on'),
    res: document.getElementById('res').classList.contains('on'),
    railForm: document.getElementById('rail-form').offsetParent !== null,
    railLevers: document.getElementById('rail-levers').offsetParent !== null
  }));
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => {
    const el = document.scrollingElement;
    return el.scrollWidth - el.clientWidth <= 1;
  });
}

async function railNotClipped(page) {
  return page.evaluate(() => {
    const a = document.querySelector('aside');
    return a.scrollHeight - a.clientHeight <= 1;
  });
}

test.before(async () => {
  server = spawn(process.execPath, [join(ROOT, 'scripts/dev-server.mjs')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/bill-checkup'); if (r.ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  const exe = CHROME_PATHS.find(p => existsSync(p));
  browser = await chromium.launch(exe ? { executablePath: exe } : { channel: 'chrome' });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

/* ---------------- 9.1 field and layout ---------------- */
test('1: field order and badges 01 to 09', async () => {
  const page = await newPage();
  const got = await page.evaluate(() => [...document.querySelectorAll('#checkup-form .fld')].map(f => ({
    n: f.querySelector('.fld__n').textContent,
    l: f.querySelector('.fld__l').textContent
  })));
  assert.deepEqual(got, [
    { n: '01', l: 'Postal code' },
    { n: '02', l: 'Current provider' },
    { n: '03', l: 'Download speed' },
    { n: '04', l: 'How it reaches your house' },
    { n: '05', l: 'Contract start date' },
    { n: '06', l: 'Length of contract' },
    { n: '07', l: 'Promo end date' },
    { n: '08', l: 'Price paid during promo period' },
    { n: '09', l: 'Price paid after promo ends' }
  ]);
  await page.context().close();
});

test('2: postal input renders inline beside its label', async () => {
  const page = await newPage();
  const { label, input } = await page.evaluate(() => {
    const l = document.querySelector('#f-pc .fld__l').getBoundingClientRect();
    const i = document.querySelector('#pc').getBoundingClientRect();
    return { label: { x: l.x, y: l.y, h: l.height }, input: { x: i.x, y: i.y, h: i.height } };
  });
  assert.ok(input.x > label.x, 'input sits to the right of the label');
  const lMid = label.y + label.h / 2, iTop = input.y, iBot = input.y + input.h;
  assert.ok(lMid > iTop && lMid < iBot, 'label and input share a row');
  await page.context().close();
});

test('3: no discount or waiver field anywhere in the DOM', async () => {
  const page = await newPage();
  const found = await page.evaluate(() =>
    !!document.getElementById('disc') || /Discount\/waiver|Discount \/ waiver/.test(document.body.innerText));
  assert.equal(found, false);
  await page.context().close();
});

test('4: speed select has no 3 Gig and has 1.5 Gig and faster', async () => {
  const page = await newPage();
  const opts = await page.evaluate(() => [...document.querySelectorAll('#spd option')].map(o => o.textContent));
  assert.ok(!opts.some(o => o.includes('3 Gig')));
  assert.ok(opts.includes('1.5 Gig and faster'));
  await page.context().close();
});

test('5: hero headline is one line at 880px and above', async () => {
  const page = await newPage();
  for (const width of [880, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const one = await page.evaluate(() => {
      const h = document.querySelector('.hero h1');
      const lh = parseFloat(getComputedStyle(h).lineHeight) || parseFloat(getComputedStyle(h).fontSize) * 1.2;
      return h.getClientRects().length >= 1 && h.getBoundingClientRect().height < lh * 1.5
        && h.scrollWidth <= h.clientWidth + 1;
    });
    assert.ok(one, `one line at ${width}px`);
  }
  await page.context().close();
});

/* ---------------- 9.2 conditional behaviour ---------------- */
test('6+7: multi promo tick disables and clears prices, reveals two rows; untick restores', async () => {
  const page = await newPage();
  await page.fill('#cost', '80');
  await page.fill('#stick', '120');
  await page.click('#mp-toggle');
  let st = await page.evaluate(() => ({
    cd: document.getElementById('cost').disabled, cv: document.getElementById('cost').value,
    sd: document.getElementById('stick').disabled, sv: document.getElementById('stick').value,
    on: document.getElementById('mbm').classList.contains('on'),
    rows: document.querySelectorAll('#prows .prow').length
  }));
  assert.deepEqual(st, { cd: true, cv: '', sd: true, sv: '', on: true, rows: 2 });
  await page.click('#mp-toggle');
  st = await page.evaluate(() => ({
    cd: document.getElementById('cost').disabled,
    sd: document.getElementById('stick').disabled,
    on: document.getElementById('mbm').classList.contains('on')
  }));
  assert.deepEqual(st, { cd: false, sd: false, on: false });
  await page.context().close();
});

test('8+9: coverage chip counts against the contract and the fallback panel names the gap', async () => {
  const page = await newPage();
  await page.selectOption('#len', '24');
  await page.click('#mp-toggle');
  const rows = page.locator('#prows .prow');
  await rows.nth(0).locator('.p-amt').fill('50');
  await rows.nth(0).locator('.p-mon').fill('6');
  await rows.nth(1).locator('.p-amt').fill('80');
  await rows.nth(1).locator('.p-mon').fill('6');
  let chip = await page.evaluate(() => ({
    t: document.getElementById('mbm-st').textContent,
    c: document.getElementById('mbm-st').className,
    fb: document.getElementById('fallback').classList.contains('on'),
    msg: document.getElementById('fb-msg').textContent
  }));
  assert.equal(chip.t, '12 of 24 months covered');
  assert.ok(chip.c.includes('warn'), 'amber while partial');
  assert.equal(chip.fb, true);
  assert.ok(chip.msg.includes('12 of 24 months') && chip.msg.includes('remaining 12'));
  await page.click('#addp');
  await rows.nth(2).locator('.p-amt').fill('120');
  await rows.nth(2).locator('.p-mon').fill('12');
  chip = await page.evaluate(() => ({
    t: document.getElementById('mbm-st').textContent,
    c: document.getElementById('mbm-st').className,
    fb: document.getElementById('fallback').classList.contains('on')
  }));
  assert.equal(chip.t, '24 of 24 months covered');
  assert.ok(chip.c.includes('good'), 'green when complete');
  assert.equal(chip.fb, false);
  await page.context().close();
});

test('10: I don\'t know pills disable dates and drive the shared guidance panel', async () => {
  const page = await newPage();
  const nudge = () => page.evaluate(() => ({
    on: document.getElementById('nudge').classList.contains('on'),
    t: document.getElementById('nudge-t').textContent,
    sd: document.getElementById('startd').disabled,
    pd: document.getElementById('pend').disabled
  }));
  await page.click('#idk-start');
  let n = await nudge();
  assert.deepEqual([n.on, n.sd, n.t], [true, true, 'Your start date is worth finding']);
  await page.click('#idk-pend');
  n = await nudge();
  assert.deepEqual([n.on, n.pd, n.t], [true, true, 'Two dates decide your number']);
  await page.click('#idk-start');
  n = await nudge();
  assert.deepEqual([n.on, n.sd, n.t], [true, false, 'Your promo end date is the one that matters']);
  await page.click('#idk-pend');
  n = await nudge();
  assert.equal(n.on, false);
  await page.context().close();
});

test('11: price hints follow the dates and hide when both are unknown', async () => {
  const page = await newPage();
  await page.fill('#startd', '2026-03-15');
  await page.fill('#pend', '2026-12-15');
  let h = await page.evaluate(() => ({
    a: document.getElementById('hint-cost').textContent,
    b: document.getElementById('hint-stick').textContent,
    aOn: document.getElementById('hint-cost').classList.contains('on'),
    bOn: document.getElementById('hint-stick').classList.contains('on')
  }));
  assert.equal(h.a, 'Between Mar 2026 and Dec 2026.');
  assert.equal(h.b, 'After Dec 2026.');
  assert.ok(h.aOn && h.bOn);
  await page.click('#idk-start');
  await page.click('#idk-pend');
  h = await page.evaluate(() => ({
    aOn: document.getElementById('hint-cost').classList.contains('on'),
    bOn: document.getElementById('hint-stick').classList.contains('on')
  }));
  assert.deepEqual(h, { aOn: false, bOn: false });
  await page.context().close();
});

/* ---------------- 9.4 results presentation ---------------- */
test('14+20+21+22+24: high tone card, post-promo now label, no assumptions, no benchmark source', async () => {
  const page = await newPage();
  /* ON at 500: benchmark 44.99. Lapsed promo: during 60, after 150.
     Cost 12*150=1800, savings 1260.12, pct .70: high. All inputs supplied. */
  await fillAndSubmit(page, {
    startd: isoDaysFromNow(-400), pend: isoDaysFromNow(-60), cost: '60', stick: '150'
  });
  const r = await page.evaluate(() => ({
    cls: document.getElementById('vcard').className,
    head: document.getElementById('v-head').textContent,
    nowk: document.getElementById('f-nowk').textContent,
    now: document.getElementById('f-now').textContent,
    info: document.getElementById('v-info').classList.contains('on'),
    cardText: document.getElementById('vcard').innerText,
    resText: document.getElementById('res').innerText,
    ctaInCard: document.querySelectorAll('#vcard button:not(.vinfo), #vcard a').length
  }));
  assert.ok(r.cls.includes('warn'), 'high tone card treatment');
  assert.equal(r.head, 'Your loyalty is costing you a fortune.');
  assert.equal(r.nowk, 'You pay now, post promo');
  assert.ok(r.now.includes('$150'));
  assert.equal(r.info, false, 'no assumption tooltip when everything was supplied');
  assert.equal(r.ctaInCard, 0, 'no CTA inside the verdict card');
  assert.ok(!/compared against/i.test(r.resText), 'never says compared against');
  for (const name of ['Carrytel', 'TekSavvy', 'Internet 500', 'Purple Cow', 'plansavvy', 'PlanSavvy']) {
    assert.ok(!r.resText.includes(name), `benchmark source "${name}" never on the results screen`);
  }
  assert.ok(!r.cardText.includes('Rogers'), 'their own provider stays out of the verdict card too');
  await page.context().close();
});

test('21+25: moderate card bolds You just checked inline, assumption tooltip on midpoint basis', async () => {
  const page = await newPage();
  /* ON at 500, no promo end date, sticker known: midpoint-estimate.
     during 55, after 75: cost 780, bench 539.88, pct .308: moderate. */
  await fillAndSubmit(page, { cost: '55', stick: '75' });
  const r = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#v-body b')].find(x => x.textContent === 'You just checked.');
    return {
      cls: document.getElementById('vcard').className,
      info: document.getElementById('v-info').classList.contains('on'),
      tip: document.getElementById('v-tip').textContent,
      inline: b ? getComputedStyle(b).display : null
    };
  });
  assert.ok(r.cls.includes('mid'), 'moderate treatment');
  assert.equal(r.info, true, 'assumption tooltip present for midpoint estimate');
  assert.ok(r.tip.includes('We estimated the timing.'));
  assert.ok(!/compared against/i.test(r.tip));
  assert.equal(r.inline, 'inline', 'You just checked. is bold inline text');
  await page.context().close();
});

test('23: cliff pill at 75 days, absent at 400 days, absent when ended', async () => {
  for (const [days, expect] of [[75, true], [400, false], [-30, false]]) {
    const page = await newPage();
    await fillAndSubmit(page, { pend: isoDaysFromNow(days), cost: '90', stick: '140' });
    const has = await page.evaluate(() => !!document.querySelector('#v-strip .vcliff'));
    assert.equal(has, expect, `${days} days out`);
    await page.context().close();
  }
});

/* ---------------- 9.5 rail ---------------- */
test('26+27+28+29: rail contents per screen, loading centred at 780 with no rail', async () => {
  const page = await newPage();
  let s = await screenState(page);
  assert.deepEqual([s.form, s.railForm, s.railLevers], [true, true, false], 'form screen rail');

  await page.fill('#pc', 'L5V 2C9');
  await page.selectOption('#prov', 'Bell');
  await page.selectOption('#spd', '100');
  await page.selectOption('#tech', 'Fibre to the home');
  await page.selectOption('#len', '12');
  await page.fill('#cost', '90');
  await page.fill('#email', 'test@example.com');
  await page.click('#check');
  const mid = await page.evaluate(() => ({
    aside: document.querySelector('aside').offsetParent !== null,
    solo: document.getElementById('grid').classList.contains('solo'),
    w: document.getElementById('loading').getBoundingClientRect().width,
    max: getComputedStyle(document.getElementById('loading')).maxWidth
  }));
  assert.equal(mid.aside, false, 'rail not rendered while loading');
  assert.ok(mid.solo && mid.max === '780px' && mid.w <= 781, 'loading column capped at 780');
  for (let i = 0; i < 8; i++) await page.clock.fastForward(1000);
  await page.waitForSelector('#res.on');
  s = await screenState(page);
  assert.deepEqual([s.res, s.railForm, s.railLevers], [true, false, true], 'results screen rail');
  await page.click('#edit-all');
  s = await screenState(page);
  assert.deepEqual([s.form, s.railForm, s.railLevers], [true, true, false], 'edit restores the form rail');
  await page.context().close();
});

test('30+31+32: no rail clipping, eleven levers under three dividers, no horizontal overflow', async () => {
  const page = await newPage();
  const widths = [1280, 940, 768, 390];
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 800 });
    assert.ok(await railNotClipped(page), `form rail not clipped at ${w}`);
    assert.ok(await noHorizontalOverflow(page), `no overflow on form at ${w}`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await fillAndSubmit(page, { cost: '90', stick: '150', pend: isoDaysFromNow(60) });
  const lev = await page.evaluate(() => ({
    levers: document.querySelectorAll('#lev-list .lev').length,
    dividers: document.querySelectorAll('#lev-list .secdiv').length,
    eleventh: (() => {
      const l = [...document.querySelectorAll('#lev-list .lev')].pop();
      return l && l.getBoundingClientRect().height > 0;
    })()
  }));
  assert.equal(lev.levers, 11);
  assert.equal(lev.dividers, 3);
  assert.ok(lev.eleventh, 'eleventh lever reachable');
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 800 });
    assert.ok(await railNotClipped(page), `results rail not clipped at ${w}`);
    assert.ok(await noHorizontalOverflow(page), `no overflow on results at ${w}`);
  }
  await page.context().close();
});

/* ---------------- 9.6 general ---------------- */
test('34: every validation message fires in order and scrolls to its field', async () => {
  const page = await newPage();
  const ferr = () => page.evaluate(() => document.getElementById('ferr').textContent);
  const submit = () => page.click('#check');
  await submit();
  assert.equal(await ferr(), 'Enter a full postal code, like L5V 2C9, so we can find your cohort.');
  await page.fill('#pc', 'L5V 2C9');
  await submit();
  assert.equal(await ferr(), 'Choose your current provider.');
  await page.selectOption('#prov', 'Telus');
  await submit();
  assert.equal(await ferr(), 'Choose your download speed.');
  await page.selectOption('#spd', '100');
  await submit();
  assert.equal(await ferr(), 'Tell us how the internet reaches your house.');
  await page.selectOption('#tech', 'DSL (phone jack)');
  await submit();
  assert.equal(await ferr(), 'Choose your contract length.');
  await page.selectOption('#len', '0');
  await submit();
  assert.equal(await ferr(), 'Enter the price you pay during your promo period.');
  await page.fill('#cost', '85');
  await submit();
  assert.equal(await ferr(), 'Enter a valid email address so we can send your results.');
  /* multi promo branch */
  await page.click('#mp-toggle');
  await submit();
  assert.equal(await ferr(), 'Add at least one amount and how many months you pay it for.');
  await page.locator('#prows .prow').nth(0).locator('.p-amt').fill('60');
  await page.locator('#prows .prow').nth(0).locator('.p-mon').fill('5');
  await submit();
  assert.equal(await ferr(), 'Add the price you pay for the remaining months, usually the sticker price.');
  const scrolled = await page.evaluate(() => {
    const r = document.getElementById('fallback').getBoundingClientRect();
    return r.top >= -r.height && r.top < innerHeight;
  });
  assert.ok(scrolled, 'page scrolled to the offending field');
  await page.context().close();
});

test('35: prefers-reduced-motion keeps the layout intact', async () => {
  const page = await newPage({ reducedMotion: 'reduce' });
  assert.ok(await noHorizontalOverflow(page));
  await fillAndSubmit(page, { cost: '90', stick: '140', pend: isoDaysFromNow(80) });
  assert.ok(await page.evaluate(() => document.getElementById('res').classList.contains('on')));
  assert.ok(await noHorizontalOverflow(page));
  await page.context().close();
});

test('33: no console errors across the whole run', () => {
  assert.deepEqual(consoleErrors, []);
});
