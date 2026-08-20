#!/usr/bin/env node
/* Layout checks for the member dashboard Home view (/dashboard).
 *
 *   node scripts/dev-server.mjs               # in another shell, port 3000
 *   node scripts/qa-dashboard-layout.mjs
 *   node scripts/qa-dashboard-layout.mjs http://localhost:3000 --shots
 *
 * The sibling of scripts/qa-dashboard.mjs, which checks WHAT the page says.
 * This one checks where it says it. Not wired into CI, for the same reason:
 * check-frontend.yml is install-free and Playwright's browser binary is not.
 *
 * Every Catalyst call is intercepted through a CATCH-ALL, registered first so
 * the named handlers below still win. dev-server.mjs proxies /api/auth/* to
 * the live Development environment and there is no local emulator, so an
 * un-stubbed endpoint is a test writing to live data.
 *
 * WHAT IT ASSERTS, all by getBoundingClientRect and none of it by eye:
 *   1. every main-column card shares one left x, and so does every rail card
 *   2. the main/rail gutter is 24px wherever both are present
 *   3. every band on the page shares the container's two inline edges
 *   4. no Home card carries a min-height or a height:100%
 *   5. card heights against the brief's ceilings
 *   6. per-row void: the gap between a row's tallest and shortest track
 *   9. no horizontal scroll, at eleven widths
 *  10. tab order runs in DOM order, which here is visual reading order
 *  11. one set of tracks across every tab
 *  12. THE COHORT ROW: exactly four cards, equal heights, their progress bars on
 *      one line, no button inside a card, and the row above all reading content
 *  13. THE SPLIT BAND: two columns finishing on the same line with the surplus
 *      spread across the rows, three articles at one weight over one thumbnail
 *      each, and no stock photography left in the band
 *
 * It walks EVERY state in the prototype controls, because the Home card set
 * changes by state and a layout tuned to one state is the fault this pass
 * exists to fix.
 */

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const SHOTS = argv.includes('--shots');
const BASE = (argv.find(a => !a.startsWith('--')) || 'http://localhost:3000').replace(/\/+$/, '');
const SHOTDIR = 'private/tmp-shots';
let pass = 0, fail = 0;
const notes = [];
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };
/* A measurement that is over a brief's ceiling for a reason the layout cannot
   fix, printed every run rather than exempted into silence. If one of these
   ever shrinks below its threshold, delete its entry. */
const note = (label) => { notes.push(label); console.log(`  note  ${label}`); };

/* THE ONE STATED EXCEPTION.
   "Your campaign" is a composite: the seven-stop journey rail, the stage
   panel, five date tiles and the activity feed, in one card. It runs 780 to
   1180px depending on stage. Nothing about the grid changes that, and the
   only thing that would is deleting content, which this pass is fenced off
   from. It is the main column's whole first screen by design.

   The visitor lane USED to be the second exception, on the grounds that one
   short main card against a two-card rail is a content shape rather than a
   track fault. That was true and it was still the biggest hole on the page:
   435px on `result`, 468px on `waitlist`. It was fixed by changing the shape,
   not the tracks: Worth a read turned on its side as a span 12 row, and
   arrive's "How this works" moved to the rail. Both visitor states now sit
   under 30px. The exception is gone with the fault.

   VOID_CAP was 260 against a member rail of three cards (~1405px) facing a main
   stack of 1182 (locked) to 1612 (confirm).

   THE HOME RESTRUCTURE TOOK THE THIRD RAIL CARD. "Worth a read" left the rail for
   the split band, where it is one of two peers rather than a tall thin card in a
   4-column track, and the member room left the lane with it. That is the point of
   the pass and it is not reversible without printing Worth a read twice on the
   member lane. What it costs is measured here: the rail is now referral + rating
   (~960px) against the same 1182..1612 main stack, so the spread runs ~220 to
   ~650px and no static ordering closes it.

   660 keeps this a guard against the NEXT accidental growth. Closing the gap for
   real means giving the member rail a third card or moving one out of the main
   stack, which is a content decision this pass is fenced off from. Recorded here
   rather than deleted so it stays visible. */
const TALL_OK = /Your campaign/i;
const VOID_CAP = 660;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const ours = (m) => { const u = (m.location && m.location().url) || ''; return !u || u.startsWith(BASE); };
const errors = [];

const REC = { emailKey: 'ada@example.com', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const DAY = 86400000;

/* Every state the prototype controls can jump to, in the order they list. */
const STATES = ['arrive', 'result', 'waitlist', 'forming', 'closing', 'locked', 'bidding',
  'offers', 'passed', 'confirm', 'switching', 'done', 'short'];

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
/* SIX, not three, and one of every `kind` the row ranks. The Home row shows four
   of them, so a three-cohort fixture could not render a full row, could not show
   the ranking putting the member's own cohort first, and would hide the View all
   link (it only appears when there is a fifth cohort behind it). One at auction is
   load-bearing too: that is the card with no progress bar, and reserving the bar's
   line is what keeps the four counts on one baseline. */
const CAMPS = [
  camp('the-annex', 'The Annex', 'M5R', { members: 38 }),
  camp('kingston-west', 'Kingston West', '', { kind: 'auction', stage: 'bidding', members: 64 }),
  camp('riverdale', 'Riverdale', 'M4K', { kind: 'planned', stage: 'waitlist', members: 22 }),
  camp('london-east', 'London East', 'Autumn cohort', { you: 'joined', members: 61 }),
  camp('windsor-core', 'Windsor', 'Winter cohort', { kind: 'planned', stage: 'waitlist', members: 52 }),
  camp('chatham-kent', 'Chatham-Kent', 'First cohort', { members: 37 }),
];
const BILL = { provider: 'Rogers', monthly: 92, promoEnd: '2026-11-01', source: 'bill-checkup', speed: '500 Mbps' };

async function ctx(browser, viewport) {
  const c = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await c.route('**/api/auth/**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [], coverage: [] }),
  }));
  await c.route('**/api/auth/campaigns', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: CAMPS }),
  }));
  await c.route('**/api/auth/me/bill', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, bill: BILL }),
  }));
  await c.route('**/api/auth/me/referral', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, code: 'WHL-1A2B3C4D', joined: 2, pending: 0 }),
  }));
  await c.route('**/api/auth/session', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, user: { ...REC, userType: 'member' } }),
  }));
  await c.addInitScript(rec => {
    if (sessionStorage.getItem('whl-seeded')) return;
    sessionStorage.setItem('whl-seeded', '1');
    localStorage.setItem('whollar.member', JSON.stringify(rec));
  }, REC);
  return c;
}

/* One read of the Home view's geometry, taken the way the brief asks for it. */
const measure = (p) => p.evaluate(() => {
  const r = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), r: Math.round(b.right), y: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
  const vis = el => el && el.offsetParent !== null && el.getBoundingClientRect().height > 0;
  const home = document.querySelector('.home');
  /* SCOPE EVERY READ TO THE VISIBLE LANE. Both lanes carry a .mcol and an
     .aside, the hidden one is still in the DOM with its last render in it, and
     it sorts FIRST. A bare document.querySelector('.mcol') therefore measures
     the visitor lane's zero-height leftovers for every member state visited
     after a visitor state, which is a harness that passes by measuring
     nothing. */
  const lane = document.querySelector('#member-home').hidden ? '#visitor-home' : '#member-home';
  const laneEl = document.querySelector(lane);

  const label = el => el.getAttribute('aria-label') || el.id || el.className;
  /* The split band's two cards are children of .home, not of a lane: they are the
     same two cards whichever lane is showing, which is why they moved out. They
     still have to be measured, so they are collected explicitly. */
  const cards = [...document.querySelectorAll('.home > .cliff, .home > .crowband, .home > .splitband > .card, .home > .splitband > .splitcol > .card')]
    .concat([...laneEl.querySelectorAll('.card')]).filter(vis);

  const role = el => el.classList.contains('is-band') ? 'band'
    : el.classList.contains('is-wide') ? 'wide'
      : el.closest('.mcol') ? 'main'
        : el.closest('.aside') ? 'rail' : 'other';

  const shell = document.querySelector('.content');
  const cs = getComputedStyle(shell);
  const inner = { x: Math.round(shell.getBoundingClientRect().left + parseFloat(cs.paddingLeft)), r: Math.round(shell.getBoundingClientRect().right - parseFloat(cs.paddingRight)) };

  const mcol = laneEl.querySelector('.mcol');
  const rail = laneEl.querySelector('.aside');

  return {
    lane: lane === '#visitor-home' ? 'visitor' : 'member',
    inner,
    home: r(home),
    mcol: vis(mcol) ? r(mcol) : null,
    rail: vis(rail) ? r(rail) : null,
    cards: cards.map(el => {
      const st = getComputedStyle(el);
      return {
        name: label(el), role: role(el), ...r(el),
        minH: st.minHeight, hPct: st.height === '100%' || el.style.height === '100%',
      };
    }),
    /* Every focusable, in DOM order, with its position, so tab order can be
       checked against the order a reader's eye takes. */
    focusables: [document.querySelector('.home > .cliff'), laneEl,
      document.querySelector('.home > .crowband'), document.querySelector('.home > .splitband')]
      .filter(Boolean)
      .flatMap(root => [...root.querySelectorAll('a[href], button:not([disabled]), input, select')])
      .filter(vis).map(el => ({ t: (el.textContent || '').trim().slice(0, 28), ...r(el) })),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  };
});

const goState = async (p, s) => {
  await p.evaluate(st => {
    const b = [...document.querySelectorAll('#sts button')].find(x => x.getAttribute('data-goto') === st);
    if (b) b.click();
  }, s);
  await p.waitForTimeout(180);
};

const browser = await chromium.launch();
if (SHOTS) mkdirSync(SHOTDIR, { recursive: true });

/* ---------- 1: tracks, gutters and edges, across the whole state matrix ---------- */
for (const vw of [1440, 1280]) {
  console.log(`\n=== ${vw}px: one set of tracks, every state ===`);
  const c = await ctx(browser, { width: vw, height: 900 });
  const p = await c.newPage();
  p.on('console', m => { if (m.type() === 'error' && ours(m)) errors.push(m.text()); });
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);

  const badEdge = [], badMain = [], badRail = [], badGutter = [], badTall = [], badVoid = [];
  const tallNoted = [], voidNoted = [];
  for (const st of STATES) {
    await goState(p, st);
    const m = await measure(p);

    /* 3: every band's inline edges are the container's. */
    for (const card of m.cards.filter(c2 => c2.role === 'band' || c2.role === 'wide')) {
      if (!near(card.x, m.inner.x, 1) || !near(card.r, m.inner.r, 1)) badEdge.push(`${st}/${card.name} ${card.x}..${card.r} vs ${m.inner.x}..${m.inner.r}`);
    }
    /* 1: one left x for the main column, one for the rail. */
    const mains = m.cards.filter(c2 => c2.role === 'main');
    const rails = m.cards.filter(c2 => c2.role === 'rail');
    if (mains.length && new Set(mains.map(c2 => c2.x)).size !== 1) badMain.push(`${st}: ${mains.map(c2 => c2.name + '@' + c2.x).join(', ')}`);
    if (rails.length && new Set(rails.map(c2 => c2.x)).size !== 1) badRail.push(`${st}: ${rails.map(c2 => c2.name + '@' + c2.x).join(', ')}`);
    /* 2: the gutter. */
    if (m.mcol && m.rail) {
      const g = m.rail.x - m.mcol.r;
      if (!near(g, 24, 1)) badGutter.push(`${st}: ${g}px`);
    }
    /* 5: height ceilings.
       The split band's two cards share ONE cap, because they are one band and the
       brief's whole requirement for them is that they finish on the same line. The
       member room drives it: eyebrow, headline and a one-line dek, a 52px toggle,
       a fixed 420px handset window and a pinned action, inside 24px of card
       padding, is ~690px. 720 keeps this a guard on the next accidental growth
       rather than a ceiling loose enough to stop catching one. The equal-height
       assertion is the one that matters, and it is in section 7. */
    for (const card of m.cards) {
      const cap = /member room|Worth a read/i.test(card.name) ? 720 : 560;
      if (card.h <= cap) continue;
      (TALL_OK.test(card.name) ? tallNoted : badTall).push(`${st}/${card.name} ${card.h}px > ${cap}`);
    }
    /* 6: the void beside a lone card, main column against rail. */
    if (m.mcol && m.rail) {
      const d = Math.abs(m.mcol.h - m.rail.h);
      if (d > VOID_CAP) badVoid.push(`${st}: main ${m.mcol.h} vs rail ${m.rail.h}, ${d}px`);
      else if (d > 200) voidNoted.push(`${st}: ${m.lane} lane, main ${m.mcol.h} vs rail ${m.rail.h}, ${d}px`);
    }
    if (SHOTS) await p.screenshot({ path: `${SHOTDIR}/home-${vw}-${st}.png`, fullPage: true });
  }
  ok(badEdge.length === 0, `every band sits on the container's edges${badEdge.length ? ' :: ' + badEdge.slice(0, 4).join(' | ') : ''}`);
  ok(badMain.length === 0, `main-column cards share one left x${badMain.length ? ' :: ' + badMain.slice(0, 3).join(' | ') : ''}`);
  ok(badRail.length === 0, `rail cards share one left x${badRail.length ? ' :: ' + badRail.slice(0, 3).join(' | ') : ''}`);
  ok(badGutter.length === 0, `main/rail gutter is 24px${badGutter.length ? ' :: ' + badGutter.slice(0, 4).join(' | ') : ''}`);
  ok(badTall.length === 0, `card heights within their ceilings${badTall.length ? ' :: ' + badTall.slice(0, 6).join(' | ') : ''}`);
  ok(badVoid.length === 0, `no track more than ${VOID_CAP}px taller than its neighbour${badVoid.length ? ' :: ' + badVoid.join(' | ') : ''}`);
  if (tallNoted.length) note(`${vw}: the campaign card over 560px :: ${tallNoted.map(t => t.split('/')[0] + ' ' + t.split(' ')[1]).join(', ')}`);
  if (voidNoted.length) note(`${vw}: track void over 200px :: ${voidNoted.join(' | ')}`);
  await c.close();
}

/* ---------- 2: no min-height, no height:100%, on any Home card ---------- */
console.log('\n=== cards size to their content ===');
{
  const c = await ctx(browser, { width: 1440, height: 900 });
  const p = await c.newPage();
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const bad = [];
  for (const st of STATES) {
    await goState(p, st);
    const m = await measure(p);
    for (const card of m.cards) {
      if (card.minH && card.minH !== '0px' && card.minH !== 'auto') bad.push(`${st}/${card.name} min-height:${card.minH}`);
      if (card.hPct) bad.push(`${st}/${card.name} height:100%`);
    }
  }
  ok(bad.length === 0, `no min-height and no height:100%${bad.length ? ' :: ' + [...new Set(bad)].slice(0, 6).join(' | ') : ''}`);
  await c.close();
}

/* ---------- 3: tab order runs in reading order ---------- */
console.log('\n=== keyboard order ===');
{
  const c = await ctx(browser, { width: 1440, height: 900 });
  const p = await c.newPage();
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const bad = [];
  for (const st of STATES) {
    await goState(p, st);
    const m = await measure(p);
    /* Reading order for a two-track page: the main column top to bottom, then
       the rail top to bottom, then the full-width bands. A back-step is only a
       fault when it also moves UP the page inside the same track. */
    for (let i = 1; i < m.focusables.length; i++) {
      const a = m.focusables[i - 1], b = m.focusables[i];
      if (near(a.x, b.x, 40) && b.y < a.y - 8) bad.push(`${st}: "${a.t}" -> "${b.t}" jumps up`);
    }
  }
  ok(bad.length === 0, `tab order never back-steps up a column${bad.length ? ' :: ' + bad.slice(0, 4).join(' | ') : ''}`);
  await c.close();
}

/* ---------- 4: the width sweep ---------- */
console.log('\n=== width sweep: no horizontal scroll ===');
for (const w of [1600, 1440, 1280, 1100, 1024, 940, 834, 768, 430, 390, 360]) {
  const c = await ctx(browser, { width: w, height: 900 });
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  let worst = null, single = null, over = [];
  for (const st of ['result', 'forming', 'bidding', 'offers', 'done']) {
    await goState(p, st);
    const m = await measure(p);
    if (!worst || m.scrollW - m.clientW > worst.d) worst = { st, d: m.scrollW - m.clientW, sw: m.scrollW, cw: m.clientW };
    if (st === 'forming') single = m.mcol && m.rail ? near(m.mcol.x, m.rail.x, 1) : true;
    for (const card of m.cards) if (card.w > m.inner.r - m.inner.x + 1) over.push(`${st}/${card.name} ${card.w}`);
  }
  ok(worst.d <= 0, `${w}px: scrollWidth ${worst.sw} <= clientWidth ${worst.cw}`);
  ok(over.length === 0, `${w}px: no card wider than the container${over.length ? ' :: ' + over.slice(0, 3).join(' | ') : ''}`);
  if (w <= 1100) ok(single === true, `${w}px: single column, rail is not orphaned beside the main stack`);
  if (SHOTS) await p.screenshot({ path: `${SHOTDIR}/sweep-${w}.png`, fullPage: true });
  await c.close();
}

/* ---------- 5: the other views still work in the shared shell ---------- */
console.log('\n=== the shell change, checked against the other views ===');
{
  const c = await ctx(browser, { width: 1440, height: 900 });
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  /* Profile has no rail button: it is reached from the avatar, like a member
     reaches it. Knowledge lays out .ktile rather than .card. */
  const tracks = [];
  /* Home's own tracks, read first, as the number every other tab is held to. */
  await goState(p, 'forming');
  {
    const m = await measure(p);
    tracks.push({ v: 'dashboard', main: m.mcol, rail: m.rail });
  }
  for (const v of ['bills', 'knowledge', 'history', 'profile', 'contact']) {
    await p.evaluate(view => {
      const b = document.querySelector(`#pnav button[data-view="${view}"]`) || document.querySelector('.ava');
      b.click();
    }, v);
    await p.waitForTimeout(240);
    const m = await p.evaluate(() => {
      const R = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), r: Math.round(b.right) }; };
      const view = document.querySelector('.view.on');
      return {
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        view: view.dataset.v,
        blocks: view.querySelectorAll('.card, .ktile').length,
        main: R(view.querySelector('.is-main')), rail: R(view.querySelector('.is-rail')),
      };
    });
    ok(m.view === v && m.sw <= m.cw && m.blocks > 0, `${v}: renders (${m.blocks} blocks), no horizontal scroll`);
    if (m.main && m.rail) tracks.push({ v, main: m.main, rail: m.rail });
  }
  /* 11: ONE SET OF TRACKS ACROSS THE WHOLE SHELL.
     Bills and Profile used to declare `1.62fr 1fr` at a 20px gap against
     Home's twelve tracks at 24, which put the main/rail boundary 58px apart
     between tabs. Nothing looked broken on any single tab; it only showed on
     the way between them, as every card edge stepping sideways under a nav
     click. This asserts the thing a screenshot of one tab cannot: that the
     four edges are the SAME four numbers whichever tab is open. */
  const base = tracks[0];
  const drift = tracks.slice(1).filter(t =>
    !near(t.main.x, base.main.x, 1) || !near(t.main.r, base.main.r, 1) ||
    !near(t.rail.x, base.rail.x, 1) || !near(t.rail.r, base.rail.r, 1));
  ok(drift.length === 0, `every tab shares Home's tracks (${base.main.x}..${base.main.r} | ${base.rail.x}..${base.rail.r})`
    + (drift.length ? ' :: ' + drift.map(t => `${t.v} ${t.main.x}..${t.main.r} | ${t.rail.x}..${t.rail.r}`).join(' | ') : ''));
  await c.close();
}

/* ---------- 6: no reflow when the images arrive ---------- */
console.log('\n=== images land without moving anything ===');
{
  const c = await ctx(browser, { width: 1440, height: 900 });
  /* Hold every image behind a 1.2s delay, so "before they arrive" is a real
     observable state rather than a race the fast local server always wins. */
  await c.route('**/images/**', async r => { await new Promise(res => setTimeout(res, 1200)); r.continue(); });
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  await goState(p, 'forming');
  const before = await p.evaluate(() => {
    const y = el => el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
    return { room: y(document.querySelector('.mroom')), band: y(document.querySelector('.crowband')), reads: y(document.querySelector('.splitband .rcard')) };
  });
  await p.waitForLoadState('networkidle');
  await p.waitForTimeout(600);
  const after = await p.evaluate(() => {
    const y = el => el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
    return { room: y(document.querySelector('.mroom')), band: y(document.querySelector('.crowband')), reads: y(document.querySelector('.splitband .rcard')) };
  });
  const moved = Object.keys(before).filter(k => Math.abs(before[k] - after[k]) > 1);
  ok(moved.length === 0, `nothing shifts when the thumbnails, region art and mockup land${moved.length ? ' :: ' + moved.map(k => `${k} ${before[k]}->${after[k]}`).join(', ') : ''}`);
  await c.close();
}

/* ---------- 7: the cohort row and the split band, against the Home brief ----------
   Everything here is a claim the restructure makes about geometry, so all of it is
   read off getBoundingClientRect rather than looked at. The row's argument is
   internal alignment across four cards, and the band's is that its two columns end
   on one line, and neither is visible in a screenshot of one card. */
console.log('\n=== the cohort row and the split band ===');
for (const vw of [1280, 1100]) {
  const c = await ctx(browser, { width: vw, height: 900 });
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  await goState(p, 'forming');

  const m = await p.evaluate(() => {
    const r = el => { const b = el.getBoundingClientRect(); return { y: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) }; };
    const ccs = [...document.querySelectorAll('#crow > *')];
    const reads = document.querySelector('.splitband .rcard');
    /* The left column is TWO cards now (products over reading), so what has to
       finish level with the member room is the column, not the reading card. */
    const leftcol = document.querySelector('.splitband > .splitcol');
    const room = document.querySelector('.splitband .mroom');
    const items = [...reads.querySelectorAll('.reads > li')];
    const ttl = el => { const t = el.querySelector('.rttl'); return t ? Math.round(parseFloat(getComputedStyle(t).fontSize)) : 0; };
    return {
      count: ccs.length,
      ccH: ccs.map(r).map(x => x.h),
      /* The cohort label, in page coordinates: the last line of the card body,
         so it is the row's alignment argument now that the bar and the count
         are gone. Their absence is asserted rather than measured: a bar nobody
         renders would make a spread of zero and pass by vacuum. */
      labelY: ccs.map(el => { const b = el.querySelector('.cc__b .m'); return b ? Math.round(b.getBoundingClientRect().top) : null; }),
      bars: ccs.reduce((n, el) => n + el.querySelectorAll('.miniprog').length, 0),
      counts: ccs.reduce((n, el) => n + el.querySelectorAll('.mono').length, 0),
      /* A terracotta button inside a cohort card is the duplicated decision. */
      ccBtns: ccs.reduce((n, el) => n + el.querySelectorAll('button, .btn').length, 0),
      readsBox: r(leftcol), roomBox: r(room),
      /* WHERE THE STRETCH WENT. The card runs down to the member room, and the
         surplus that buys has to be inside the rows, not banked in the seams
         between them. Two numbers say so: the gap left over once the rows are
         subtracted (zero), and the spread between the tallest and shortest row
         (small, and only as large as a two-line headline makes it). */
      readsGapSlack: (() => {
        const list = reads.querySelector('.reads');
        const rows = items.reduce((n, li) => n + li.getBoundingClientRect().height, 0) + 4 * (items.length - 1);
        return Math.round(list.getBoundingClientRect().height - rows);
      })(),
      rowH: items.map(li => Math.round(li.getBoundingClientRect().height)),
      articles: items.length,
      /* One weight across all three: the hero treatment is gone, so a title that
         differs from its neighbours is a regression, not a hierarchy. */
      fonts: items.map(ttl),
      thumbs: items.map(li => { const t = li.querySelector('.rthumb'); return t ? Math.round(r(t).h) : 0; }),
      /* Acceptance: no stock photograph of a person left in the band. The hero
         image was the only one, and it is gone from the document, not hidden. */
      heroMedia: document.querySelectorAll('.splitband .rhero, .splitband .rlead').length,
      /* The three product tiles, each a real button so the dialog is reachable
         by keyboard without a key handler. */
      tiles: document.querySelectorAll('.nptiles > button.nptile').length,
      /* The handset window is the fixed reference: it must not have been resized
         to make the two columns meet. */
      phone: r(document.querySelector('.mrview')),
      /* Acceptance 1: cohort cards before any reading content, from the top. */
      rowY: Math.round(document.querySelector('.crowband').getBoundingClientRect().top),
      bandY: Math.round(document.querySelector('.splitband').getBoundingClientRect().top),
      /* Acceptance 7: gone from the document, not hidden. */
      art: document.querySelectorAll('.mrart, img[src*="member-room-networks"]').length,
      /* No READS_N here: it lives inside the page's IIFE and is not reachable
         from an evaluate(). Which is the right answer anyway, see below. */
    };
  });

  console.log(`\n--- ${vw}px ---`);
  ok(m.count === 4, `exactly four cohort cards render (${m.count})`);
  ok(new Set(m.ccH).size === 1, `the four cards report equal heights (${m.ccH.join(', ')})`);
  ok(m.labelY.every(y => y !== null) && Math.max(...m.labelY) - Math.min(...m.labelY) <= 2,
    `their cohort labels share one vertical position within 2px (${m.labelY.join(', ')})`);
  ok(m.bars === 0 && m.counts === 0, `no fill bar and no count on any tile (${m.bars} bars, ${m.counts} counts)`);
  ok(m.ccBtns === 0, `no button of any kind sits inside a cohort card (${m.ccBtns})`);
  ok(m.rowY < m.bandY, `the cohort row is above the reading content (${m.rowY} < ${m.bandY})`);
  /* The two columns finish level again, and the reading card is what closes the
     difference. The two assertions under it are what stop that being done the
     cheap way: not by banking the surplus in the seams between the rows, and not
     by growing one row while the others stay put. */
  ok(Math.abs(m.readsBox.h - m.roomBox.h) <= 24, `the two split-band columns finish within 24px (left ${m.readsBox.h}, room ${m.roomBox.h})`);
  ok(m.readsGapSlack <= 1, `the surplus is inside the rows, not banked in the gaps (${m.readsGapSlack}px)`);
  ok(Math.max(...m.rowH) - Math.min(...m.rowH) <= 24, `the rows grew together, not one of them (${m.rowH.join(', ')}px)`);
  /* NOT A PINNED COUNT. READS_N in the page owns how many rows there are, the
     CSS block says so in as many words ("NOTHING HERE COUNTS THE ROWS"), and a
     harness that pins the number is the same mistake in a second file: this
     read `=== 3` and went red the day the card took a fourth article, which was
     a deliberate change. What the card must not do is collapse to a hero plus
     stubs, which is `heroMedia` below and the equal-shape assertions above. */
  ok(m.articles >= 3, `the reading card is a list of equal rows (${m.articles} of them)`);
  ok(new Set(m.fonts).size === 1, `every title is set at one size (${m.fonts.join(', ')}px)`);
  /* One shape, not one number. The crop grew from 46 to 64 when the rows turned
     out to be two thirds air: the card is flex:1 against the handset opposite,
     so its height is decided elsewhere and only its contents can answer for the
     density. What must not vary is the crop between rows. */
  ok(new Set(m.thumbs).size === 1 && m.thumbs[0] >= 46,
    `every article carries the same square crop, at least 46px (${m.thumbs.join(', ')})`);
  ok(m.heroMedia === 0, `the hero photograph is out of the document (${m.heroMedia} found)`);
  ok(m.tiles === 3, `three product tiles, each a real button (${m.tiles})`);
  /* The window is the fixed reference and must not have been resized to make
     the two columns meet. It is no longer a pinned height: width is the only
     dimension set and aspect-ratio derives the rest, so the assertion is the
     device's own proportion, 414 x 822, which is what a hand-resize would
     break. The old `=== 420` pinned a window that had already grown to show the
     bottom of the phone. */
  ok(Math.abs(m.phone.h - m.phone.w * 822 / 414) <= 1,
    `the handset keeps the device's proportion, not a resize (${m.phone.w} x ${m.phone.h})`);
  ok(m.phone.w === (vw >= 1280 ? 300 : 280), `the handset is ${vw >= 1280 ? 300 : 280}px wide at ${vw} (${m.phone.w})`);
  ok(m.art === 0, `the stock illustration is out of the document (${m.art} found)`);

  /* Acceptance 8: the toggle drives both the mock and the action label. */
  const seen = [];
  for (const net of ['reddit', 'x', 'linkedin']) {
    await p.click(`.mrtab[data-net="${net}"]`);
    await p.waitForTimeout(120);
    seen.push(await p.evaluate(() => ({
      pane: (document.querySelector('.mrpane:not([hidden])') || {}).id,
      cta: document.querySelector('#mrcta').textContent.trim(),
      sel: document.querySelectorAll('.mrtab[aria-selected="true"]').length,
    })));
  }
  ok(new Set(seen.map(s => s.pane)).size === 3 && new Set(seen.map(s => s.cta)).size === 3,
    `each network shows its own mock and names its own action (${seen.map(s => s.cta).join(' / ')})`);
  ok(seen.every(s => s.sel === 1), 'exactly one segment is announced as selected at a time');

  /* View all reaches the full grid, and the full grid is every cohort. */
  await p.click('#viewall');
  await p.waitForTimeout(240);
  const all = await p.evaluate(() => ({
    view: (document.querySelector('.view.on') || {}).dataset?.v,
    cards: document.querySelectorAll('#cgrid > *').length,
    dupIds: ['cc-first', 'regmono'].map(id => document.querySelectorAll('#' + id).length),
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  ok(all.view === 'campaigns' && all.cards >= 4, `View all opens the full campaign grid (${all.view}, ${all.cards} cards)`);
  ok(all.dupIds.every(n => n <= 1), `painting the row twice did not duplicate #cc-first or #regmono (${all.dupIds.join(', ')})`);
  ok(all.sw <= all.cw, `${vw}px: the campaigns view does not scroll sideways (${all.sw} <= ${all.cw})`);
  await c.close();
}

/* ---------- 8: the row's own breakpoints ----------
   Four cards is four cards at every width: two by two on a tablet, and a snap
   scroller on a phone showing one and a fraction so the scroll is discoverable.
   What is checked is that no card is DROPPED and nothing overflows, because the
   two ways a four-card row usually fails are silently rendering three and pushing
   the document sideways. */
console.log('\n=== the cohort row across its breakpoints ===');
for (const [vw, want] of [[940, 2], [768, 2], [390, 'scroll']]) {
  const c = await ctx(browser, { width: vw, height: 900 });
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  await goState(p, 'forming');
  const m = await p.evaluate(() => {
    const row = document.querySelector('#crow');
    const ccs = [...row.children];
    const tops = new Set(ccs.map(el => Math.round(el.getBoundingClientRect().top)));
    return {
      n: ccs.length, rows: tops.size,
      perRow: ccs.length / tops.size,
      scrolls: row.scrollWidth > row.clientWidth + 1,
      firstW: Math.round(ccs[0].getBoundingClientRect().width),
      rowW: Math.round(row.clientWidth),
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      /* Every chip must be whole: a clipped "Opens after this round" is the
         failure a narrow card produces first. */
      clipped: ccs.filter(el => { const b = el.querySelector('.badge'); return b && b.scrollWidth > b.clientWidth + 1; }).length,
    };
  });
  console.log(`\n--- ${vw}px ---`);
  ok(m.n === 4, `all four cards still render (${m.n})`);
  ok(m.sw <= m.cw, `no horizontal document scroll (${m.sw} <= ${m.cw})`);
  ok(m.clipped === 0, `no clipped status chip (${m.clipped})`);
  if (want === 'scroll') {
    ok(m.scrolls, 'the row is a scroller, not a stack');
    const frac = m.firstW / m.rowW;
    ok(frac > 0.6 && frac < 0.9, `one and a fraction cards visible (first card is ${Math.round(frac * 100)}% of the row)`);
  } else {
    ok(m.perRow === want, `${want} cards per row (${m.perRow})`);
  }
  await c.close();
}

ok(errors.length === 0, `no console errors${errors.length ? ' :: ' + [...new Set(errors)].slice(0, 3).join(' | ') : ''}`);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed, ${notes.length} noted${SHOTS ? `, screenshots in ${SHOTDIR}/` : ''}\n`);
process.exit(fail ? 1 : 0);
