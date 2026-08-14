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
 *   9. no horizontal scroll, at ten widths
 *  10. tab order runs in DOM order, which here is visual reading order
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

/* THE TWO STATED EXCEPTIONS.
   "Your campaign" is a composite: the seven-stop journey rail, the stage
   panel, five date tiles and the activity feed, in one card. It runs 780 to
   1180px depending on stage. Nothing about the grid changes that, and the
   only thing that would is deleting content, which this pass is fenced off
   from. It is the main column's whole first screen by design.
   The visitor lane's main sequence is one or two cards against a two-card
   rail, so an 8/4 split leaves the rail hanging below the main column. That
   is a shape problem in the visitor lane's content, not a track problem: the
   tracks, gutters and edges all hold in those states. */
const TALL_OK = /Your campaign/i;
const VOID_CAP = 500;
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
const CAMPS = [
  camp('london-east', 'London East', 'Autumn cohort', { you: 'joined', members: 61 }),
  camp('riverdale', 'Riverdale', 'M4K', { kind: 'planned', stage: 'waitlist', members: 22 }),
  camp('the-annex', 'The Annex', 'M5R', { members: 38 }),
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
  const cards = [...document.querySelectorAll('.home > .cliff, .home > .crowband')]
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
    focusables: [document.querySelector('.home > .cliff'), laneEl, document.querySelector('.home > .crowband')]
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
    /* 5: height ceilings. */
    for (const card of m.cards) {
      const cap = /member room/i.test(card.name) ? 520 : /Worth a read/i.test(card.name) ? 420 : 560;
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
for (const w of [1600, 1440, 1280, 1100, 1024, 834, 768, 430, 390, 360]) {
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
  for (const v of ['bills', 'knowledge', 'history', 'profile', 'contact']) {
    await p.evaluate(view => {
      const b = document.querySelector(`#pnav button[data-view="${view}"]`) || document.querySelector('.ava');
      b.click();
    }, v);
    await p.waitForTimeout(240);
    const m = await p.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      view: (document.querySelector('.view.on') || {}).dataset?.v,
      blocks: document.querySelectorAll('.view.on .card, .view.on .ktile').length,
    }));
    ok(m.view === v && m.sw <= m.cw && m.blocks > 0, `${v}: renders (${m.blocks} blocks), no horizontal scroll`);
  }
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
    return { room: y(document.querySelector('.mroom')), band: y(document.querySelector('.crowband')), reads: y(document.querySelector('#member-home .rcard')) };
  });
  await p.waitForLoadState('networkidle');
  await p.waitForTimeout(600);
  const after = await p.evaluate(() => {
    const y = el => el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
    return { room: y(document.querySelector('.mroom')), band: y(document.querySelector('.crowband')), reads: y(document.querySelector('#member-home .rcard')) };
  });
  const moved = Object.keys(before).filter(k => Math.abs(before[k] - after[k]) > 1);
  ok(moved.length === 0, `nothing shifts when the thumbnails, region art and mockup land${moved.length ? ' :: ' + moved.map(k => `${k} ${before[k]}->${after[k]}`).join(', ') : ''}`);
  await c.close();
}

ok(errors.length === 0, `no console errors${errors.length ? ' :: ' + [...new Set(errors)].slice(0, 3).join(' | ') : ''}`);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed, ${notes.length} noted${SHOTS ? `, screenshots in ${SHOTDIR}/` : ''}\n`);
process.exit(fail ? 1 : 0);
