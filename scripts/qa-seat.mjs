#!/usr/bin/env node
/* Cohort seat checks for the member dashboard (/dashboard): the exit window,
 * the ledger, the conflict sheet and the seal race.
 *
 *   node scripts/dev-server.mjs      # in another shell, port 3000
 *   node scripts/qa-seat.mjs [base]
 *
 * Sibling of qa-share.mjs and qa-dashboard.mjs, same iron rule: EVERY
 * Catalyst call is stubbed through a catch-all, because dev-server.mjs
 * proxies /api/auth/* to the live Development backend and an un-stubbed
 * endpoint is a test writing to live data.
 *
 * What this harness owns is the render contract: GET /me/seat names an
 * affordance and the page renders exactly that, nothing else. The server-side
 * rules (one claim per address, the event-key race, the move compensation)
 * are exercised against ZCQL by hand per create-tables.md section 26. */

import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const BASE = (argv.find(a => !a.startsWith('--')) || 'http://localhost:3000').replace(/\/+$/, '');
let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

const REC = { emailKey: 'ada@example.com', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const DAY = 86400000;
const NOW = Date.now();
function camp(id, region, { you = null, kind = 'forming', stage = 'forming', members = 44, closeIn = 9 * DAY } = {}) {
  return {
    id, region, sub: 'Autumn cohort', kind, target: 100, members, households: members, watching: 0,
    joinable: kind === 'forming', you, stage, stageLabel: stage, next: null,
    dates: { announce_at: NOW + closeIn, bidding_opens_at: NOW + closeIn + 2 * DAY, offers_at: NOW + closeIn + 9 * DAY },
  };
}
const HELD = camp('etobicoke-centre', 'Etobicoke Centre', { you: 'joined', members: 61 });
const OTHER = camp('north-york-central', 'North York Central', { members: 38 });
const CAMPS = [HELD, OTHER];

const claim = (cohort, status = 'active') => ({
  address_id: 'u1/1', vertical: 'internet', cohort_id: status === 'active' ? cohort : null,
  status, version: 3, claimed_at: NOW - DAY, released_at: null,
});
const seatBody = (affordance, cohortId = HELD.id, count = 61) => JSON.stringify({
  ok: true, serverTime: Date.now(),
  claim: affordance === 'none' ? claim(null, 'released') : claim(cohortId),
  cohort: affordance === 'none' ? null : {
    id: cohortId, region: HELD.region, stage: 'forming', join_close_at: NOW + 9 * DAY,
    roster_count: count, target: 100, dates: HELD.dates, closing: false,
  },
  affordance, rejoin_until: NOW + 9 * DAY,
});

async function ctx(browser, { affordance = 'leave', onMutate = null } = {}) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const hits = [];
  await c.route('**/api/auth/**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [] }),
  }));
  await c.route('**/api/auth/campaigns', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: CAMPS }),
  }));
  await c.route('**/api/auth/me/seat*', r => r.fulfill({
    status: 200, contentType: 'application/json', body: seatBody(affordance),
  }));
  await c.route('**/api/auth/cohorts/**', r => {
    hits.push({ url: r.request().url(), body: r.request().postData(), idem: r.request().headers()['idempotency-key'] || null });
    if (onMutate) return onMutate(r, hits);
    r.fulfill({ status: 200, contentType: 'application/json', body: seatBody('none') });
  });
  await c.route('**/api/auth/session', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, user: { ...REC, userType: 'member' } }),
  }));
  await c.addInitScript(rec => { localStorage.setItem('whollar.member', JSON.stringify(rec)); }, REC);
  c._hits = hits;
  return c;
}
const closeCtx = (c) => Promise.race([c.close().catch(() => {}), new Promise(r => setTimeout(r, 4000))]);
const boot = async (c) => {
  const p = await c.newPage();
  p._errors = [];
  p.on('pageerror', e => p._errors.push(String(e)));
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  return p;
};

const browser = await chromium.launch();

/* 1. The ledger renders the affordance it is told, and only that. AC 1, 2. */
console.log('ledger follows the server affordance');
for (const [aff, expectLeave, expectText] of [
  ['leave', true, 'Your seat is held in'],
  ['locked', false, 'You are still not committed to switch'],
  ['pass', false, 'Pass on this round'],
  ['concierge', false, 'Message my concierge'],
]) {
  const c = await ctx(browser, { affordance: aff });
  const p = await boot(c);
  const state = await p.evaluate(() => {
    const el = document.getElementById('seatledger');
    return { hidden: el.hidden, html: el.innerHTML, leave: !!el.querySelector('[data-seatleave-link]'), disabled: !!el.querySelector('[disabled]') };
  });
  ok(!state.hidden, `${aff}: ledger visible`);
  ok(state.leave === expectLeave, `${aff}: exit link ${expectLeave ? 'present' : 'absent'}`);
  ok(state.html.includes(expectText), `${aff}: says "${expectText}"`);
  ok(!state.disabled, `${aff}: no disabled control rendered`);
  ok(p._errors.length === 0, `${aff}: zero page errors`);
  await closeCtx(c);
}

/* 2. Exit sheet: consequences, reasons, focus trap, commit. AC 8, 10. */
console.log('exit sheet');
{
  const c = await ctx(browser, { affordance: 'leave' });
  const p = await boot(c);
  await p.click('[data-seatleave-link]');
  await p.waitForTimeout(150);
  const sheet = await p.evaluate(() => {
    const s = document.querySelector('.sxs');
    return {
      open: s && s.classList.contains('is-open'),
      dialog: s.querySelector('.sxs__box').getAttribute('role') === 'dialog'
        && s.querySelector('.sxs__box').getAttribute('aria-modal') === 'true',
      title: s.querySelector('#sxs-title').textContent,
      items: s.querySelectorAll('.sxs__list li').length,
      chips: s.querySelectorAll('[data-stsreason]').length,
      focusInside: s.contains(document.activeElement),
      confirm: (s.querySelector('[data-stsleave]') || {}).textContent || '',
    };
  });
  ok(sheet.open, 'opens from the ledger link');
  ok(sheet.dialog, 'role=dialog aria-modal=true');
  ok(/Leave the Etobicoke Centre cohort\?/.test(sheet.title), 'title names the cohort');
  ok(sheet.items === 4, 'four consequences listed');
  ok(sheet.chips === 5, 'five optional reason chips');
  ok(sheet.focusInside, 'focus moved inside');
  ok(/Leave Etobicoke Centre/.test(sheet.confirm), 'destructive button carries the cohort name');
  /* Tab wraps inside the sheet. */
  for (let i = 0; i < 25; i++) await p.keyboard.press('Tab');
  ok(await p.evaluate(() => document.querySelector('.sxs').contains(document.activeElement)), 'focus never escapes (25 tabs)');
  await p.click('[data-stsreason="timing"]');
  await p.click('[data-stsleave]');
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => ({
    open: document.querySelector('.sxs').classList.contains('is-open'),
    notice: !document.getElementById('seatnotice').hidden,
    noticeText: document.getElementById('seatnotice').textContent,
    toast: document.getElementById('toast').textContent,
  }));
  const hit = c._hits.find(h => h.url.includes('/leave'));
  ok(!!hit, 'POST /cohorts/:id/leave sent');
  ok(hit && JSON.parse(hit.body || '{}').reason === 'timing', 'reason chip travels');
  ok(hit && !!hit.idem, 'Idempotency-Key header present');
  ok(!after.open, 'sheet closes on commit');
  ok(after.notice && /You left Etobicoke Centre/.test(after.noticeText), 'notice band with the way back');
  ok(/Rejoin any time/.test(after.toast), 'toast confirms with the rejoin window');
  ok(p._errors.length === 0, 'zero page errors');
  await closeCtx(c);
}

/* 3. Escape closes and counts as abandon; focus returns. AC 10. */
{
  const c = await ctx(browser, { affordance: 'leave' });
  const p = await boot(c);
  await p.click('[data-seatleave-link]');
  await p.waitForTimeout(120);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(120);
  const st = await p.evaluate(() => ({
    open: document.querySelector('.sxs').classList.contains('is-open'),
    focusOnTrigger: document.activeElement && !!document.activeElement.closest('[data-seatleave-link]'),
  }));
  ok(!st.open, 'Escape closes the sheet');
  ok(st.focusOnTrigger, 'focus returns to the trigger');
  ok(!c._hits.some(h => h.url.includes('/leave')), 'no write on abandon');
  await closeCtx(c);
}

/* 4. Conflict sheet on tapping another cohort while holding a seat. AC 6. */
{
  const c = await ctx(browser, { affordance: 'leave' });
  const p = await boot(c);
  const clicked = await p.evaluate(() => {
    const b = document.querySelector(`[data-choose="north-york-central"]`);
    if (b) b.click();
    return !!b;
  });
  await p.waitForTimeout(150);
  const st = await p.evaluate(() => {
    const s = document.querySelector('.sxs');
    return {
      open: s && s.classList.contains('is-open'),
      title: s ? s.querySelector('#sxs-title').textContent : '',
      seats: s ? s.querySelectorAll('.sxs__seat').length : 0,
      move: s ? !!s.querySelector('[data-stsmove]') : false,
      twostep: s ? !!s.querySelector('[data-ststwostep]') : false,
    };
  });
  ok(clicked, 'the other cohort card is pressable');
  ok(st.open, 'conflict sheet opens instead of a silent join');
  ok(/You are already in Etobicoke Centre/.test(st.title), 'title names the held cohort');
  ok(st.seats === 2, 'two-card swap visual');
  ok(st.move, 'one-step move offered while forming');
  ok(st.twostep, 'two-step path preserved underneath');
  await p.click('[data-stsmove]');
  await p.waitForTimeout(250);
  const hit = c._hits.find(h => h.url.includes('/move'));
  ok(!!hit, 'POST /cohorts/:id/move sent');
  ok(hit && JSON.parse(hit.body || '{}').from_cohort_id === 'etobicoke-centre', 'move carries from_cohort_id');
  await closeCtx(c);
}

/* 5. Seal race: a leave answered 409 SEAL_RACE swaps the ledger in place. AC 8. */
{
  const c = await ctx(browser, {
    affordance: 'leave',
    onMutate: (r) => r.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: {
        code: 'SEAL_RACE',
        message: 'Etobicoke Centre sealed while this page was open. Nothing is owed and you are not committed to switch.',
        serverTime: Date.now(),
      } }),
    }),
  });
  const p = await boot(c);
  /* After the first read, the re-read the race triggers must say locked. */
  await c.route('**/api/auth/me/seat*', r => r.fulfill({
    status: 200, contentType: 'application/json', body: seatBody('locked'),
  }));
  await p.click('[data-seatleave-link]');
  await p.waitForTimeout(120);
  await p.click('[data-stsleave]');
  await p.waitForTimeout(400);
  const st = await p.evaluate(() => ({
    open: document.querySelector('.sxs').classList.contains('is-open'),
    toast: document.getElementById('toast').textContent,
    ledger: document.getElementById('seatledger').innerHTML,
  }));
  ok(!st.open, 'sheet closes on the race');
  ok(/sealed while this page was open/.test(st.toast), 'the honest message, not a generic error');
  ok(/not committed to switch/.test(st.ledger), 'ledger swapped to the locked state in place');
  ok(!/Leave this cohort/.test(st.ledger), 'exit link gone after the swap');
  ok(p._errors.length === 0, 'zero page errors');
  await closeCtx(c);
}

/* 6. No seat held: no conflict sheet, the normal join gate runs. E13. */
{
  const c = await ctx(browser, { affordance: 'none' });
  const p = await boot(c);
  await p.evaluate(() => { const b = document.querySelector('[data-choose]'); if (b) b.click(); });
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => {
    const s = document.querySelector('.sxs');
    return !s || !s.classList.contains('is-open');
  }), 'free address: no conflict sheet on choose');
  await closeCtx(c);
}

/* 7. Overflow: 1280 / 940 / 768 / 390, ledger visible, no sideways scroll. AC 11. */
console.log('widths');
for (const w of [1280, 940, 768, 390]) {
  const c = await ctx(browser, { affordance: 'leave' });
  const p = await c.newPage();
  await p.setViewportSize({ width: w, height: 900 });
  p._errors = [];
  p.on('pageerror', e => p._errors.push(String(e)));
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  const st = await p.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ledger: !document.getElementById('seatledger').hidden,
  }));
  ok(st.overflow <= 0, `${w}px: no horizontal overflow`);
  ok(st.ledger, `${w}px: ledger renders`);
  ok(p._errors.length === 0, `${w}px: zero console errors`);
  await closeCtx(c);
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(`\nDeferred to hand checks against the Development backend:
  - two concurrent leaves -> one write and one 409 (needs the real event-key
    unique constraint; see create-tables.md 26d)
  - kill between the claim swap and the membership write -> compensating swap
  - move rate limit (3/day) -> 429 with the copy-deck message
  - deep link into /cohorts/:id/join while holding a seat -> 409 SEAT_HELD`);
process.exit(fail ? 1 : 0);
