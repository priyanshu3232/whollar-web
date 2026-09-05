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
/* Which member stage each affordance implies, so the stubbed cohort shape
   agrees with the affordance beside it. The page must never derive one from
   the other, but a fixture that disagreed with itself would test nothing. */
const STAGE_OF = { leave: 'forming', locked: 'locked', pass: 'offers', cancel: 'confirm', concierge: 'switching' };
const seatBody = (affordance, cohortId = HELD.id, count = 61, order = null) => JSON.stringify({
  ok: true, serverTime: Date.now(),
  claim: affordance === 'none' ? claim(null, 'released') : claim(cohortId),
  cohort: affordance === 'none' ? null : {
    id: cohortId, region: HELD.region, stage: STAGE_OF[affordance] || 'forming',
    join_close_at: NOW + 9 * DAY,
    roster_count: count, target: 100, dates: HELD.dates, closing: false,
  },
  affordance, rejoin_until: NOW + 9 * DAY,
  /* What a pass would give up, as GET /me/seat reports it. Null means nothing
     was accepted, which the warning copy reads as the milder sentence. */
  standing_order: order,
});

async function ctx(browser, { affordance = 'leave', onMutate = null, order = null, camps = CAMPS } = {}) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const hits = [];
  await c.route('**/api/auth/**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [] }),
  }));
  await c.route('**/api/auth/campaigns', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: camps }),
  }));
  await c.route('**/api/auth/me/seat*', r => r.fulfill({
    status: 200, contentType: 'application/json', body: seatBody(affordance, HELD.id, 61, order),
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

/* Playwright's own chromium is not installed on every machine that runs this
   (it needs `npx playwright install`), while a system Chrome usually is. Try
   the bundled build first so CI behaviour is unchanged, then fall back. */
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));

/* 1. The ledger renders the affordance it is told, and only that. AC 1, 2. */
console.log('ledger follows the server affordance');
/* The exit is deliberately present at EVERY affordance now. It used to be
   painted only while the cohort was forming, which left the later stages with
   no control carrying the word "leave" even though each one has a real way out.
   What the button opens is still stage-specific - that is asserted in 1b. */
for (const [aff, expectLeave, expectText] of [
  ['leave', true, 'Your seat is held in'],
  ['locked', true, 'You are still not committed to switch'],
  ['pass', true, 'Pass on this round'],
  ['concierge', true, 'Message my concierge'],
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

/* 1b. The always-present exit must not be a dead button: at each stage it has
   to open a sheet that names that stage's real way out. A button that opens
   nothing, or that opens the forming-stage copy after the seal, would be worse
   than the old behaviour of hiding it. */
console.log('the exit opens the right room at each stage');
for (const [aff, expectTitle, expectAction] of [
  ['locked', 'Leave the', 'Tell me when I can leave'],
  ['pass', 'Leave the', 'Pass on this round'],
  ['cancel', 'Back out of the switch?', 'Take me to the controls'],
  ['concierge', 'Leave while the switch is in motion?', 'Message my concierge'],
]) {
  const c = await ctx(browser, { affordance: aff });
  const p = await boot(c);
  await p.click('[data-seatleave-link]');
  await p.waitForTimeout(400);
  const sheet = await p.evaluate(() => {
    const t = document.querySelector('#sxs-title');
    const a = document.querySelector('[data-seatstageact]');
    return { title: t ? t.textContent.trim() : null, act: a ? a.textContent.trim() : null,
             kind: a ? a.getAttribute('data-seatstageact') : null };
  });
  ok(sheet.title !== null, `${aff}: exit sheet opens`);
  ok(sheet.title && sheet.title.includes(expectTitle), `${aff}: titled for the stage`);
  ok(sheet.act === expectAction, `${aff}: offers "${expectAction}"`);
  ok(p._errors.length === 0, `${aff}: zero page errors opening the exit`);
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
  ok(/Leave this cohort/.test(st.ledger), 'exit link still offered after the swap');
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

/* ------------------------------------------------------------------ *
 * Leaving a cohort at the offers stage to join another one.
 *
 * The release itself is not new: POST /cohorts/:id/pass has always been the
 * exit at this stage, and it releases the claim, the membership row and any
 * accepted order in one call. What was missing was the ROUTE INTO IT from the
 * intent that actually reaches for it, which is "I want that other cohort".
 * The conflict sheet used to fold this stage into "locked" and answer with a
 * bell, on a date that had already passed. These checks own that branch.
 * ------------------------------------------------------------------ */

const ORDER = { state: 'acc', tier: '500 Mbps', price: '70.00' };

/* 8. The conflict sheet at the offers stage offers the exit, not a bell. */
console.log('conflict sheet: the offers-stage branch');
{
  const c = await ctx(browser, { affordance: 'pass', order: ORDER });
  const p = await boot(c);
  await p.evaluate(() => document.querySelector('[data-choose="north-york-central"]').click());
  await p.waitForTimeout(180);
  const st = await p.evaluate(() => {
    const s = document.querySelector('.sxs');
    const q = sel => s.querySelector(sel);
    return {
      open: s.classList.contains('is-open'),
      modal: !!q('[data-testid="leave-confirm-modal"]'),
      cta: (q('[data-testid="leave-and-join-cta"]') || {}).textContent || '',
      warn: (q('[data-testid="leave-offer-warning"]') || {}).textContent || '',
      confirmHidden: (q('[data-stsstep]') || {}).hidden,
      confirmBtn: !!q('[data-testid="leave-confirm-button"]'),
      bell: !!q('[data-stshold]'),
      lede: (q('.sxs__lede') || {}).textContent || '',
    };
  });
  ok(st.open, 'sheet opens on the other cohort card');
  ok(st.modal, 'data-testid="leave-confirm-modal" on the dialog');
  ok(/Leave and join North York Central/.test(st.cta), 'the CTA names leaving and joining, not moving');
  ok(!st.bell, 'no bell: the exit exists today, so nothing is offered for later');
  ok(/frees your address the same day|frees up the same day/.test(st.lede), 'lede says the address frees the same day');
  ok(st.confirmBtn, 'step two is in the markup');
  ok(st.confirmHidden === true, 'step two is hidden until the first press');
  ok(/500 Mbps/.test(st.warn) && /\$70/.test(st.warn), 'warning names the accepted tier and price from the server');
  ok(/does not come back/.test(st.warn), 'warning says the offer does not return');
  ok(!/\bcannot be undone\b.*\bdollar\b/i.test(st.warn), 'warning names no saving being given up');
  ok(c._hits.length === 0, 'opening the sheet writes nothing');
  ok(p._errors.length === 0, 'zero page errors');
  await closeCtx(c);
}

/* 9. With nothing accepted the warning is the milder, truer sentence. */
{
  const c = await ctx(browser, { affordance: 'pass', order: null });
  const p = await boot(c);
  await p.evaluate(() => document.querySelector('[data-choose="north-york-central"]').click());
  await p.waitForTimeout(180);
  const warn = await p.evaluate(() =>
    (document.querySelector('[data-testid="leave-offer-warning"]') || {}).textContent || '');
  ok(/Nothing is charged and nothing is owed/.test(warn), 'no order: nothing-charged wording');
  ok(!/You accepted/.test(warn), 'no order: never claims an acceptance');
  await closeCtx(c);
}

/* 10. Two steps, and the first one writes nothing. Brief section 5.1. */
{
  const c = await ctx(browser, { affordance: 'pass', order: ORDER });
  const p = await boot(c);
  await p.evaluate(() => document.querySelector('[data-choose="north-york-central"]').click());
  await p.waitForTimeout(150);
  await p.click('[data-testid="leave-and-join-cta"]');
  await p.waitForTimeout(150);
  const armed = await p.evaluate(() => {
    const s = document.querySelector('.sxs');
    return {
      stepShown: s.querySelector('[data-stsstep]').hidden === false,
      firstHidden: s.querySelector('[data-stsactions]').hidden === true,
      focusOnConfirm: document.activeElement === s.querySelector('[data-testid="leave-confirm-button"]'),
      text: s.querySelector('[data-stsstep]').textContent,
    };
  });
  ok(armed.stepShown, 'first press reveals step two');
  ok(armed.firstHidden, 'first press hides the first pair, so there is one live decision');
  ok(armed.focusOnConfirm, 'focus lands on the confirm button');
  ok(/no undo/i.test(armed.text), 'step two says there is no undo');
  ok(c._hits.length === 0, 'the arming press sent no request');
  /* And the way back out of step two. */
  await p.click('[data-stsdisarm]');
  await p.waitForTimeout(120);
  const back = await p.evaluate(() => {
    const s = document.querySelector('.sxs');
    return { step: s.querySelector('[data-stsstep]').hidden, first: s.querySelector('[data-stsactions]').hidden };
  });
  ok(back.step === true && back.first === false, '"Keep my offer" returns to step one');
  ok(c._hits.length === 0, 'backing out of step two wrote nothing');
  await closeCtx(c);
}

/* 11. The round trip: pass on A, land in the join flow of B, join B. */
console.log('leave and join, end to end');
{
  const seen = [];
  const c = await ctx(browser, {
    affordance: 'pass', order: ORDER,
    onMutate: (r, hits) => {
      const url = r.request().url();
      seen.push(url.replace(/^.*\/api\/auth/, ''));
      if (/\/pass$/.test(url)) {
        return r.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, claim: claim(null, 'released'), released: true,
            cohort: null, open_alternatives: [] }) });
      }
      /* The join answers late on purpose: the landing surface exists between
         the pass resolving and the join landing, and a test that could not
         see it could not tell a round trip from a leave. */
      return new Promise(res => setTimeout(() => res(r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, claim: claim(OTHER.id),
          cohort: { id: OTHER.id, region: OTHER.region, stage: 'forming',
            join_close_at: NOW + 9 * DAY, roster_count: 39, target: 100, dates: OTHER.dates, closing: false } }),
      })), 500));
    },
  });
  const p = await boot(c);
  await p.evaluate(() => document.querySelector('[data-choose="north-york-central"]').click());
  await p.waitForTimeout(150);
  await p.click('[data-testid="leave-and-join-cta"]');
  await p.waitForTimeout(120);
  await p.click('[data-testid="leave-confirm-button"]');
  await p.waitForTimeout(260);
  const mid = await p.evaluate(() => ({
    sheet: document.querySelector('.sxs').classList.contains('is-open'),
    landing: !!document.querySelector('[data-testid="join-after-leave-flow"]'),
    toast: document.getElementById('toast').textContent,
    ledger: document.getElementById('seatledger').hidden,
  }));
  ok(!mid.sheet, 'the sheet closes on commit');
  ok(mid.landing, 'the target card is the landing surface of the round trip');
  ok(/offer is released/.test(mid.toast), 'the toast says the offer was released');
  ok(/Joining North York Central/.test(mid.toast), 'the toast says where the member is being taken');
  ok(mid.ledger, 'the seat ledger clears the moment the seat is released');
  await p.waitForTimeout(700);
  ok(seen.filter(u => /\/pass$/.test(u)).length === 1, 'exactly one pass');
  ok(seen.filter(u => /\/join$/.test(u)).length === 1, 'exactly one join');
  ok(seen.findIndex(u => /\/pass$/.test(u)) < seen.findIndex(u => /\/join$/.test(u)),
    'the pass is sent BEFORE the join, so the claim is free when the join lands');
  const after = await p.evaluate(() => ({
    landing: !!document.querySelector('[data-testid="join-after-leave-flow"]'),
    ledger: document.getElementById('seatledger').innerHTML,
    toast: document.getElementById('toast').textContent,
  }));
  ok(!after.landing, 'the landing marker clears once the member has arrived');
  ok(/North York Central/.test(after.ledger), 'the ledger now describes the new cohort');
  ok(/Seat held/.test(after.toast), 'the join confirms with a held seat');
  ok(p._errors.length === 0, 'zero page errors');
  await closeCtx(c);
}

/* 12. Edge case 3: the pass applies even when the target refuses. */
{
  let left = false;
  const c = await ctx(browser, {
    affordance: 'pass', order: ORDER,
    onMutate: (r) => {
      const url = r.request().url();
      if (/\/pass$/.test(url)) {
        left = true;
        return r.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, claim: claim(null, 'released'), released: true, cohort: null }) });
      }
      return r.fulfill({ status: 409, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ROSTER_FULL', message: 'North York Central is full for this round.' } }) });
    },
  });
  /* The refusal path re-reads GET /me/seat, and it must read the truth: the
     pass landed, so the claim is released. A fixture that kept answering
     "seat held" would be testing a server that cannot exist. */
  await c.route('**/api/auth/me/seat*', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: seatBody(left ? 'none' : 'pass', HELD.id, 61, left ? null : ORDER),
  }));
  const p = await boot(c);
  await p.evaluate(() => document.querySelector('[data-choose="north-york-central"]').click());
  await p.waitForTimeout(150);
  await p.click('[data-testid="leave-and-join-cta"]');
  await p.waitForTimeout(120);
  await p.click('[data-testid="leave-confirm-button"]');
  await p.waitForTimeout(600);
  const st = await p.evaluate(() => ({
    toast: document.getElementById('toast').textContent,
    ledger: document.getElementById('seatledger').hidden,
  }));
  ok(/full for this round/.test(st.toast), 'the target refusal is reported honestly');
  ok(st.ledger, 'the leave still stands: no seat, and the ledger says so');
  ok(p._errors.length === 0, 'zero page errors');
  await closeCtx(c);
}

/* 13. Edge case 7 / the rate limit: a refused pass changes nothing. */
{
  const c = await ctx(browser, {
    affordance: 'pass', order: ORDER,
    onMutate: (r) => r.fulfill({
      status: 429, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'RATE_LIMITED',
        message: 'That is three cohort changes today. Your seat stays in Etobicoke Centre and you can leave again tomorrow.' } }),
    }),
  });
  const p = await boot(c);
  await p.evaluate(() => document.querySelector('[data-choose="north-york-central"]').click());
  await p.waitForTimeout(150);
  await p.click('[data-testid="leave-and-join-cta"]');
  await p.waitForTimeout(120);
  await p.click('[data-testid="leave-confirm-button"]');
  await p.waitForTimeout(400);
  const st = await p.evaluate(() => ({
    toast: document.getElementById('toast').textContent,
    ledger: document.getElementById('seatledger').innerHTML,
    confirm: (document.querySelector('[data-testid="leave-confirm-button"]') || {}).disabled,
  }));
  ok(/three cohort changes today/.test(st.toast), 'the limit is explained, with when they can act again');
  ok(/The offer is in for Etobicoke Centre/.test(st.ledger), 'the seat is untouched');
  ok(st.confirm === false, 'the confirm button is live again for a retry');
  ok(!c._hits.some(h => /\/join$/.test(h.url)), 'no join was attempted after the refused leave');
  await closeCtx(c);
}

/* 14. Locked and bidding still refuse, and say so without promising an exit. */
{
  const c = await ctx(browser, { affordance: 'locked' });
  const p = await boot(c);
  await p.evaluate(() => document.querySelector('[data-choose="north-york-central"]').click());
  await p.waitForTimeout(180);
  const st = await p.evaluate(() => {
    const s = document.querySelector('.sxs');
    return {
      open: s.classList.contains('is-open'),
      cta: !!s.querySelector('[data-testid="leave-and-join-cta"]'),
      bell: !!s.querySelector('[data-stshold]'),
      warn: !!s.querySelector('[data-testid="leave-offer-warning"]'),
    };
  });
  ok(st.open, 'the sheet still opens while the roster is sealed');
  ok(!st.cta, 'no leave CTA: there is no exit at this stage and the sheet does not invent one');
  ok(st.bell, 'the bell is still offered for the day the address frees');
  ok(!st.warn, 'no offer warning where there is no offer');
  await closeCtx(c);
}

/* 15. The tile badge promises what the sheet will offer. */
console.log('tile badge follows the affordance');
for (const [aff, label] of [['leave', 'Move here'], ['pass', 'Leave and join'], ['locked', 'Sealed until the offer']]) {
  const c = await ctx(browser, { affordance: aff });
  const p = await boot(c);
  const txt = await p.evaluate(() => {
    const card = document.querySelector('[data-choose="north-york-central"]');
    const b = card && card.querySelector('.badge');
    return b ? b.textContent : '';
  });
  ok(txt.includes(label), `${aff}: badge reads "${label}"`);
  ok(txt.includes('You hold another seat'), `${aff}: badge still names the held seat`);
  await closeCtx(c);
}

/* 16. The sheet at 390px: nothing clipped, both steps reachable. */
{
  const c = await ctx(browser, { affordance: 'pass', order: ORDER });
  const p = await c.newPage();
  await p.setViewportSize({ width: 390, height: 780 });
  p._errors = [];
  p.on('pageerror', e => p._errors.push(String(e)));
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelector('[data-choose="north-york-central"]').click());
  await p.waitForTimeout(180);
  await p.click('[data-testid="leave-and-join-cta"]');
  await p.waitForTimeout(180);
  const st = await p.evaluate(() => {
    const box = document.querySelector('.sxs__box');
    const btn = document.querySelector('[data-testid="leave-confirm-button"]');
    const r = btn.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      inside: r.right <= box.getBoundingClientRect().right + 1,
      tall: r.height >= 34,
      warn: !!document.querySelector('[data-testid="leave-offer-warning"]'),
    };
  });
  ok(st.overflow <= 0, '390px: no horizontal overflow with the sheet open');
  ok(st.inside, '390px: the confirm button is inside the dialog');
  ok(st.tall, '390px: the confirm button is a real tap target');
  ok(st.warn, '390px: the warning is not dropped on the narrow layout');
  ok(p._errors.length === 0, '390px: zero page errors');
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
  - leave rate limit (3/day, its own budget) -> 429; the fourth leave refuses
    and the third still succeeds
  - a pass is NOT rate limited: four passes across four cohorts all succeed
  - accept in one tab, leave in another -> the claim_event unique key decides,
    and the loser never lands an accepted order under a released claim
  - deep link into /cohorts/:id/join while holding a seat -> 409 SEAT_HELD
  - after a pass, provider_orders.release_reason reads household_passed and the
    partner board shows the line as released`);
process.exit(fail ? 1 : 0);
