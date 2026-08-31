#!/usr/bin/env node
/* Browser checks for the offers stage: the cohort's PRICE BOOK.
 *
 *   node scripts/dev-server.mjs          # in another shell, port 3000
 *   node scripts/qa-offers.mjs
 *
 * The sibling of scripts/qa-dashboard.mjs, and not wired into CI for the same
 * reason: provisioning Playwright's browser binary costs real time on every
 * run, and check-frontend.yml is deliberately install-free. Run it by hand
 * after touching the offers panel.
 *
 * Every Catalyst call is intercepted through a CATCH-ALL, so this never
 * reaches the live Development backend and never writes a row.
 *
 * WHAT THIS FILE EXISTS FOR. The offers stage used to show one winning bid to
 * every household whatever speed it wanted. It now shows the household's own
 * tier and its two neighbours out of a book whose entries can each belong to a
 * different partner. Everything below is a rule of that window: which three
 * entries, which one carries the tag, what the CTA names, what happens when
 * nobody bid the tier a household wants, and what happens when the server has
 * no book at all. The last one is the important one: a live cohort renders the
 * server's prices or renders none.
 */

import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

const REC = { emailKey: 'ada@example.com', email: 'ada@example.com', firstName: 'Ada',
  lastName: 'Lovelace', phone: '(416) 555 0134', postal: 'M5S 2J7', fsa: 'M5S', provinceCode: 'ON' };
const DAY = 86400000;

/* The worked example from the brief, mapped onto the SEVEN-tier ladder this
   stack actually has (partner/core/tiers.js TIER_NAMES). Partner A is cheapest
   at the bottom four, partner B at 1 Gig and 1.5 Gig, A again at the top: the
   point is that one household's three cards carry two partner names. The
   mocked offer carries no `offers` record, so this drives the dashboard's own
   window slice, which is the demo tour's path and the fallback for a backend
   that predates household_offers. */
const BOOK = [
  { tier: '50 Mbps', price: '45.00', partner: 'Provider A', guaranteeMonths: 24, afterPrice: '60.00', equipment: 'inc', mix: null },
  { tier: '100 Mbps', price: '50.00', partner: 'Provider A', guaranteeMonths: 24, afterPrice: '65.00', equipment: 'inc', mix: null },
  { tier: '300 Mbps', price: '65.00', partner: 'Provider A', guaranteeMonths: 24, afterPrice: '80.00', equipment: 'inc', mix: null },
  { tier: '500 Mbps', price: '70.00', partner: 'Provider A', guaranteeMonths: 24, afterPrice: '85.00', equipment: 'inc', mix: null },
  { tier: '1 Gig', price: '80.00', partner: 'Provider B', guaranteeMonths: 24, afterPrice: '95.00', equipment: 'inc', mix: null },
  { tier: '1.5 Gig', price: '84.00', partner: 'Provider B', guaranteeMonths: 24, afterPrice: '99.00', equipment: 'inc', mix: null },
  { tier: '2.5 Gig', price: '93.00', partner: 'Provider A', guaranteeMonths: 24, afterPrice: '108.00', equipment: 'inc', mix: null },
];

const camp = () => {
  const t = Date.now();
  return {
    id: 'london-east', region: 'London East', sub: 'Autumn cohort', kind: 'auction',
    target: 100, members: 112, households: 112, watching: 0, joinable: false,
    you: 'joined', stage: 'offers', stageLabel: 'offers', next: null,
    dates: {
      announce_at: t - 30 * DAY, bidding_opens_at: t - 20 * DAY,
      bidding_closes_at: t - 2 * DAY, decision_at: t + 18 * DAY, switch_window_at: t + 30 * DAY,
    },
  };
};

const accepts = [];
async function ctx(browser, { book = BOOK, speed = 500, monthly = 92, viewport, seatOrder = null } = {}) {
  const c = await browser.newContext({ viewport: viewport || { width: 1360, height: 1100 } });
  await c.route('**/api/auth/**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [], coverage: [] }),
  }));
  await c.route('**/api/auth/campaigns', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [camp()], memberFsa: 'M5S', postalCodeState: 'present' }),
  }));
  await c.route('**/api/auth/campaigns/*/offer', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true, serverTime: Date.now(), sealed: false, live: true,
      closesAt: Date.now() - 2 * DAY, bidCount: 3,
      book,
      offer: book.length ? {
        partner: book[0].partner, price: book[0].price, speed: book[0].tier,
        guaranteeMonths: 24, afterLine: '$65 / 100 Mbps', equipment: 'inc', mix: null,
      } : null,
    }),
  }));
  await c.route('**/api/auth/campaigns/*/offer/accept', r => {
    accepts.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, accepted: true, orderNo: 'WHL-7Q2M-C', tier: 'x', note: 'Accepted.' }) });
  });
  await c.route('**/api/auth/me/seat*', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true, serverTime: Date.now(),
      claim: { address_id: 'u1/1', vertical: 'internet', cohort_id: 'london-east',
        status: 'active', version: 4, claimed_at: Date.now() - 30 * DAY, released_at: null },
      cohort: { id: 'london-east', region: 'London East', stage: 'offers',
        join_close_at: Date.now() - 30 * DAY, roster_count: 112, target: 100,
        dates: camp().dates, closing: false },
      affordance: 'pass', rejoin_until: null,
      standing_order: seatOrder,
    }),
  }));
  await c.route('**/api/auth/me/bill', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, bill: { provider: 'Rogers', monthly, speed, promoEndsOn: null } }),
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

/* The three cards, read the way a household reads them. */
const cards = (p) => p.evaluate(() => Array.from(document.querySelectorAll('.ocard')).map(el => ({
  tier: el.getAttribute('data-tier'),
  price: (el.querySelector('.price') || {}).textContent || '',
  partner: (el.querySelector('.prov') || {}).textContent || '',
  delta: (el.querySelector('.delta') || {}).textContent || '',
  up: !!(el.querySelector('.delta.up')),
  /* Every card carries a position chip now; the household's own tier is the
     one whose chip is not a step. */
  tagged: !!el.querySelector('.tag:not(.step)'),
  selected: el.getAttribute('aria-checked') === 'true',
  role: el.getAttribute('role'),
})));
const panel = (p) => p.evaluate(() => (document.querySelector('#panel') || {}).innerText || '');
const cta = (p) => p.evaluate(() => {
  const b = document.querySelector('[data-take]');
  const w = Array.from(document.querySelectorAll('.finelink')).filter(x => /Who is/.test(x.textContent))[0];
  return { take: b ? b.textContent.trim() : null, who: w ? w.textContent.trim() : null };
});

async function open(c) {
  const p = await c.newPage();
  await p.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.ocard, #panel', { timeout: 8000 }).catch(() => {});
  return p;
}

const browser = await chromium.launch();

console.log('\n1. the window is three entries of the book, centred on the household tier');
{
  const c = await ctx(browser, { speed: 300 });
  const p = await open(c);
  const cs = await cards(p);
  ok(cs.length === 3, `three cards (${cs.length})`);
  ok(cs.map(x => x.tier).join('|') === '100 Mbps|300 Mbps|500 Mbps', `tiers 100/300/500 (${cs.map(x => x.tier).join('|')})`);
  ok(cs.map(x => x.price.replace('/mo', '')).join('|') === '$50|$65|$70', `prices $50/$65/$70 (${cs.map(x => x.price).join('|')})`);
  ok(cs.filter(x => x.tagged).length === 1 && cs[1].tagged, 'the tag sits on the household tier alone');
  ok(cs[1].selected && cs.filter(x => x.selected).length === 1, 'the household tier opens selected');
  ok(cs.every(x => x.role === 'radio'), 'every card is a radio');
  await c.close();
}

console.log('\n2. the window clamps at both ends');
{
  const c = await ctx(browser, { speed: 50 });
  const p = await open(c);
  const cs = await cards(p);
  ok(cs.map(x => x.tier).join('|') === '50 Mbps|100 Mbps|300 Mbps', `lowest tier shows the first three (${cs.map(x => x.tier).join('|')})`);
  ok(cs[0].tagged, 'and the tag is on the first card, not the middle');
  await c.close();
}
{
  const c = await ctx(browser, { speed: 2500 });
  const p = await open(c);
  const cs = await cards(p);
  ok(cs.map(x => x.tier).join('|') === '1 Gig|1.5 Gig|2.5 Gig', `highest tier shows the last three (${cs.map(x => x.tier).join('|')})`);
  ok(cs[2].tagged, 'and the tag is on the last card');
  await c.close();
}

console.log('\n3. selecting a flank moves the CTA, the partner link and aria-checked');
{
  const c = await ctx(browser, { speed: 500 });
  const p = await open(c);
  const before = await cta(p);
  ok(/500 Mbps/.test(before.take) && /\$70/.test(before.take), `CTA opens on the household tier (${before.take})`);
  await p.click('.ocard[data-tier="1 Gig"]');
  const cs = await cards(p);
  const after = await cta(p);
  ok(/1 Gig/.test(after.take) && /\$80/.test(after.take), `CTA follows the selection (${after.take})`);
  ok(/Provider B/.test(after.who), `the partner link follows the selection (${after.who})`);
  ok(cs.filter(x => x.selected).map(x => x.tier).join('') === '1 Gig', 'aria-checked moved with it');
  ok(cs.filter(x => x.tagged).map(x => x.tier).join('') === '500 Mbps', 'the "your pick" tag stayed on the household tier');
  await c.close();
}

console.log('\n4. the accept posts the tier that was chosen, not the cheapest');
{
  accepts.length = 0;
  const c = await ctx(browser, { speed: 500 });
  const p = await open(c);
  await p.click('.ocard[data-tier="1 Gig"]');
  await p.click('[data-take]');
  await p.fill('#svcaddr', '14 Wellington Street, London');
  await p.fill('#svcphone', '519 555 0142');
  await p.click('.slotday:not([disabled]) >> nth=0');
  await p.click('.slotwin[data-win="am"]');
  await p.check('#consent');
  await p.click('#paydep');
  await p.waitForTimeout(600);
  ok(accepts.length === 1, `one accept posted (${accepts.length})`);
  ok(accepts[0] && accepts[0].tier === '1 Gig', `and it named 1 Gig (${accepts[0] && accepts[0].tier})`);
  const txt = await panel(p);
  ok(/Provider B/.test(txt), 'the screens after the choice name the partner that won that tier');
  await c.close();
}

console.log('\n5. a tier above the bill is said in warn style, never hidden');
{
  const c = await ctx(browser, { speed: 1000, monthly: 75 });
  const p = await open(c);
  const cs = await cards(p);
  const gig = cs.filter(x => x.tier === '1 Gig')[0];
  ok(gig && gig.up, 'the 1 Gig delta carries the warn class');
  ok(gig && /\+ \$5/.test(gig.delta), `and says + $5 plainly (${gig && gig.delta})`);
  const low = cs.filter(x => x.tier === '500 Mbps')[0];
  ok(low && !low.up && /− \$5/.test(low.delta), `while a cheaper tier reads as a reduction (${low && low.delta})`);
  await c.close();
}

console.log('\n6. a tier nobody bid centres on the nearest and says so');
{
  const sparse = BOOK.filter(e => e.tier !== '300 Mbps' && e.tier !== '500 Mbps');
  const c = await ctx(browser, { book: sparse, speed: 300 });
  const p = await open(c);
  const cs = await cards(p);
  const txt = await panel(p);
  ok(!cs.some(x => x.tier === '300 Mbps'), 'no card is painted for a tier nobody bid');
  ok(/Nobody bid/.test(txt), 'and the screen says nobody bid it');
  ok(/100 Mbps/.test(txt), 'naming the closest tier that exists');
  await c.close();
}

console.log('\n7. a live cohort with no book invents nothing');
{
  const c = await ctx(browser, { book: [] });
  const p = await open(c);
  const cs = await cards(p);
  const txt = await panel(p);
  ok(cs.length === 0, `no cards (${cs.length})`);
  ok(/not readable yet/.test(txt), 'and it says the prices are not readable yet');
  ok(!/Northline|Calder/.test(txt), 'and no demo partner name reaches a real cohort');
  await c.close();
}

console.log('\n8. 390px: one column, the household tier first, no sideways scroll');
{
  const c = await ctx(browser, { speed: 500, viewport: { width: 390, height: 900 } });
  const p = await open(c);
  const r = await p.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.ocard'));
    const box = els.map(e => e.getBoundingClientRect());
    return {
      oneCol: box.every((b, i) => i === 0 || Math.abs(b.left - box[0].left) < 2),
      firstTier: els.slice().sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0].getAttribute('data-tier'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  ok(r.oneCol, 'cards stack in one column');
  ok(r.firstTier === '500 Mbps', `the household tier is first (${r.firstTier})`);
  ok(r.overflow <= 0, `no horizontal overflow (${r.overflow}px)`);
  await c.close();
}

/* The way out, on the screen the offer is on. A household is never obligated
   to accept, and the offers panel is where that promise is read, so it is
   where the exit has to be reachable from. Low prominence on purpose: this
   must not compete with the two buttons above it. */
console.log('\n9. the offers panel carries a secondary exit from the cohort');
{
  const c = await ctx(browser, { speed: 500, seatOrder: { state: 'acc', tier: '500 Mbps', price: '70.00' } });
  const p = await open(c);
  const row = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="offers-leave-cohort-row"]');
    if (!el) return null;
    const link = el.querySelector('[data-offersleave]');
    const take = document.querySelector('[data-take]');
    return {
      text: el.textContent,
      isLink: !!link && link.classList.contains('tlink'),
      belowTake: !!take && el.getBoundingClientRect().top > take.getBoundingClientRect().top,
      fontSmaller: parseFloat(getComputedStyle(link).fontSize) < parseFloat(getComputedStyle(take).fontSize) + 0.5,
    };
  });
  ok(!!row, 'the row is on the offers panel');
  ok(row && /Not interested in these offers\?/.test(row.text), 'it asks the household\u2019s own question');
  ok(row && /frees up the same day/.test(row.text), 'it says what leaving actually does');
  ok(row && row.isLink, 'it is a text link, not a third button');
  ok(row && row.belowTake, 'it sits below the take button, never above it');
  ok(row && row.fontSmaller, 'it is set smaller than the primary action');
  await p.click('[data-offersleave]');
  await p.waitForTimeout(250);
  const sheet = await p.evaluate(() => ({
    open: !!document.querySelector('.modal.is-open, #modal:not([hidden])') || /Passing is a fine answer/.test(document.body.innerText),
    warn: (document.querySelector('[data-testid="leave-offer-warning"]') || {}).textContent || '',
  }));
  ok(sheet.open, 'it opens the one exit this stage has, not a fourth one');
  ok(/500 Mbps/.test(sheet.warn) && /\$70/.test(sheet.warn),
    'and that exit names the accepted offer it would decline');
  ok(/does not come back/.test(sheet.warn), 'and says the offer does not return');
  await c.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
