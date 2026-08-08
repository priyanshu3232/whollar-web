#!/usr/bin/env node
/* Playwright DOM checks for the bill-checkup signal card (five-band engine).
 *
 *   node scripts/test-signal-card.mjs
 *
 * Not wired into CI: this repo has no browser-test infrastructure today
 * (check-frontend.yml only runs `node --check`-style static checks), and
 * adding one is a bigger call than this script's own scope — provisioning
 * Playwright's browser binary in CI costs real time on every run. Run this
 * by hand after touching the signal card; scripts/test-select-band.mjs (the
 * pure band-selection logic) IS wired into CI and needs no browser.
 *
 * Starts its own static server on a free-ish port, drives real form fills
 * through the actual submit flow with the network POST intercepted (so no
 * test lead is ever written to the live backend), and asserts the rendered
 * copy/DOM against the signal-card spec.
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const PORT = 4319;
const BASE = `http://localhost:${PORT}`;

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(url).then(() => resolve()).catch(() => {
        if (Date.now() > deadline) return reject(new Error('server did not come up'));
        setTimeout(poll, 300);
      });
    })();
  });
}

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

async function fillAndSubmit(page, fields) {
  await page.route('**/bill-checkup-join', route => route.abort('failed'));
  await page.route('**/me/bill', route => route.abort('failed'));
  await page.goto(`${BASE}/bill-checkup`, { waitUntil: 'networkidle' });
  for (const [sel, val] of Object.entries(fields)) {
    if (sel === '#tech' || sel === '#spd' || sel === '#prov') await page.selectOption(sel, val);
    else await page.fill(sel, val);
  }
  await page.fill('#email', 'test@example.com');
  await page.click('#check');
  await page.waitForTimeout(11000); // the loading interstitial runs ~9s regardless of network speed
}

const server = spawn('npx', ['serve', '-l', String(PORT), '.'], { stdio: 'ignore' });
try {
  await waitForServer(BASE, 20000);
  const browser = await chromium.launch();

  console.log('Band 1 (above typical for speed):');
  {
    const page = await browser.newPage({ viewport: { width: 1300, height: 2000 } });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    await fillAndSubmit(page, { '#pc': 'L4G 1A1', '#prov': 'Rogers', '#cost': '200', '#spd': '100', '#tech': 'Cable (TV coax jack)' });
    ok((await page.locator('#sig .hv-badge').textContent()) === 'ABOVE TYPICAL FOR YOUR SPEED', 'pill text');
    ok((await page.locator('#sig h3').textContent()) === 'You’re paying well over what this speed goes for near you.', 'headline text');
    ok((await page.locator('#sig-savings').textContent()) === '$3,600', 'savings = (200-50)*24');
    ok((await page.locator('#sig-cta').textContent()) === 'Join your L4G cohort', 'CTA text');
    /* ERR_FAILED/"Failed to fetch" are this test's own intercepted routes;
       the 404 is an unrelated pre-existing local-dev artifact (present on
       every page load in this environment, e.g. a missing analytics/
       favicon resource) -- confirmed by running the same check with no
       form interaction at all and seeing it appear identically. */
    ok(errs.filter(e => !/ERR_FAILED|Failed to fetch|status of 404/.test(e)).length === 0, 'no unexpected console errors');
    await page.close();
  }

  console.log('Band 5 (promo, gated on onPromo + date):');
  {
    const page = await browser.newPage({ viewport: { width: 1300, height: 2000 } });
    await fillAndSubmit(page, { '#pc': 'L4G 1A1', '#prov': 'Rogers', '#cost': '30', '#spd': '100', '#tech': 'Cable (TV coax jack)', '#pdate': '2027-06-01' });
    ok((await page.locator('#sig .hv-badge').textContent()) === 'WELL BELOW TYPICAL · FOR NOW', 'pill text');
    ok((await page.locator('#sig-period').count()) === 0, 'no period selector (savings row replaced by promo date)');
    ok((await page.locator('#sig').innerText()).includes('WHEN IT ENDS'), 'promo-date row present');
    ok((await page.locator('#sig-cta').textContent()) === 'Hold my spot for June 2027', 'CTA names the real date');
    await page.close();
  }

  console.log('Lookup miss (guardrail 1 — band 3 copy, rows suppressed, not merely hidden):');
  {
    const page = await browser.newPage({ viewport: { width: 1300, height: 2000 } });
    await fillAndSubmit(page, { '#pc': 'X0X 0X0', '#prov': 'Other / not sure', '#cost': '90', '#spd': '1500', '#tech': 'Satellite (dish)' });
    ok((await page.locator('#sig .hv-badge').textContent()) === 'RIGHT AT TYPICAL', 'band 3 pill shown on miss');
    const rows = await page.locator('#sig .hv-stats > div').count();
    ok(rows === 1, 'only the YOU PAY NOW row is in the DOM (benchmark + savings absent, not display:none)');
    ok((await page.locator('#sig-savings').count()) === 0, 'savings element absent from the DOM');
    await page.close();
  }

  console.log('Period selector isolation (changing it touches only the savings figure):');
  {
    const page = await browser.newPage({ viewport: { width: 1300, height: 2000 } });
    await fillAndSubmit(page, { '#pc': 'L4G 1A1', '#prov': 'Rogers', '#cost': '200', '#spd': '100', '#tech': 'Cable (TV coax jack)' });
    const headBefore = await page.locator('#sig h3').textContent();
    const pillBefore = await page.locator('#sig .hv-badge').textContent();
    const benchBefore = await page.locator('#sig .hv-stats').innerText();
    await page.selectOption('#sig-period', '36');
    ok((await page.locator('#sig-savings').textContent()) === '$5,400', 'savings recomputed for the new period (150*36)');
    ok((await page.locator('#sig h3').textContent()) === headBefore, 'headline unchanged');
    ok((await page.locator('#sig .hv-badge').textContent()) === pillBefore, 'pill unchanged');
    ok((await page.locator('#sig .hv-stats').innerText()).split('\n')[0] === benchBefore.split('\n')[0], 'YOU PAY NOW row unchanged');
    await page.close();
  }

  await browser.close();
} finally {
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
