#!/usr/bin/env node
/* Share sheet checks for the member dashboard campaign card (/dashboard).
 *
 *   node scripts/dev-server.mjs      # in another shell, port 3000
 *   node scripts/qa-share.mjs [base] [--shots]
 *
 * Sibling of qa-dashboard.mjs (what the page says) and qa-dashboard-layout.mjs
 * (where it says it): this one walks the share control through every stage.
 * Same rule as both: EVERY Catalyst call is stubbed through a catch-all,
 * because dev-server.mjs proxies /api/auth/* to the live Development backend
 * and an un-stubbed endpoint is a test writing to live data.
 *
 * Numbers in the labels are the edge case register in the build brief; the
 * cases that need a real handset, a real inbox or the live backend are listed
 * at the end as deferred, with reasons, rather than silently skipped. */

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const SHOTS = argv.includes('--shots');
const BASE = (argv.find(a => !a.startsWith('--')) || 'http://localhost:3000').replace(/\/+$/, '');
const SHOTDIR = 'private/tmp-shots';
let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

const REC = { emailKey: 'ada@example.com', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };
const DAY = 86400000;
function camp(id, region, sub, { you = null, kind = 'forming', stage = 'forming', members = 44 } = {}) {
  const t = Date.now();
  return {
    id, region, sub, kind, target: 100, members, households: members, watching: 0,
    joinable: true, you, stage, stageLabel: stage, next: null,
    dates: { announce_at: t - 9 * DAY, bidding_opens_at: t + 9 * DAY, bidding_closes_at: t + 11 * DAY, decision_at: t + 18 * DAY, switch_window_at: t + 30 * DAY },
  };
}
/* Two names that stress the URL and channel encoders: a period-and-space name
 * and an accented, hyphenated one (edge 43). The joined cohort is the accented
 * one so the share text has to carry it end to end. */
const CAMPS = [
  camp('st-clair-west', 'St. Clair West', 'First cohort', { members: 38 }),
  camp('cote-des-neiges', 'Côte-des-Neiges', 'Autumn cohort', { you: 'joined', members: 61 }),
  camp('kingston-west', 'Kingston West', '', { kind: 'auction', stage: 'bidding', members: 64 }),
  camp('riverdale', 'Riverdale', 'M4K', { kind: 'planned', stage: 'waitlist', members: 22 }),
];
const BILL = { provider: 'Rogers', monthly: 92, promoEnd: '2026-11-01', source: 'bill-checkup', speed: '500 Mbps' };
const TOKEN = 'K7MQT4WS';

async function ctx(browser, viewport, { referral = 'token' } = {}) {
  const c = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const events = [];
  await c.route('**/api/auth/**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [], coverage: [] }),
  }));
  await c.route('**/api/auth/share/event', r => {
    try { events.push(JSON.parse(r.request().postData() || '{}')); } catch { events.push({}); }
    r.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' });
  });
  await c.route('**/api/auth/campaigns', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: CAMPS }),
  }));
  await c.route('**/api/auth/me/bill', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, bill: BILL }),
  }));
  await c.route('**/api/auth/me/referral', r => {
    /* Three postures: the token lane, the legacy-code lane (mint failed or the
     * table is not provisioned), and total failure (edge 12). */
    if (referral === 'fail') return r.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
    const body = referral === 'token'
      ? { ok: true, code: 'WHL-1A2B3C4D', token: TOKEN, joined: 2, pending: 0 }
      : { ok: true, code: 'WHL-1A2B3C4D', token: null, joined: 2, pending: 0 };
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await c.route('**/api/auth/session', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, user: { ...REC, userType: 'member' } }),
  }));
  await c.addInitScript(rec => {
    localStorage.setItem('whollar.member', JSON.stringify(rec));
  }, REC);
  c._events = events;
  return c;
}

/* context.close() can hang forever when a page fired keepalive fetches
 * through an intercepted route (the share sheet's telemetry does exactly
 * that), so every close is raced against a short clock. A leaked context is
 * cleaned up by browser.close() at the end; a hung run is a harness that
 * never reports. */
const closeCtx = (c) => Promise.race([c.close().catch(() => {}), new Promise(r => setTimeout(r, 4000))]);

const goState = async (p, s) => {
  await p.evaluate(st => {
    const b = [...document.querySelectorAll('#sts button')].find(x => x.getAttribute('data-goto') === st);
    if (b) b.click();
  }, s);
  await p.waitForTimeout(180);
};

const boot = async (c) => {
  const p = await c.newPage();
  p._errors = [];
  p.on('pageerror', e => p._errors.push(String(e)));
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  return p;
};

const openSheet = async (p, via = 'icon') => {
  if (via === 'icon') await p.click('#campshare');
  else await p.click('#panel [data-act="invite"]');
  await p.waitForTimeout(120);
};
const sheetState = (p) => p.evaluate(() => {
  const s = document.getElementById('sharesheet');
  if (!s || s.hidden) return null;
  const prev = s.querySelector('#shs-prev');
  const url = prev.querySelector('.u');
  const codeRow = s.querySelector('#shs-codewrap');
  return {
    eyebrow: s.querySelector('#shs-eyebrow').textContent,
    name: s.querySelector('#shs-name').textContent,
    prose: prev.childNodes[0] ? prev.childNodes[0].textContent : '',
    url: url ? url.textContent : '',
    code: codeRow && !codeRow.hidden ? s.querySelector('#shs-code').textContent : null,
    channels: [...s.querySelectorAll('[data-shch]')].map(el => ({
      kind: el.getAttribute('data-shch'), tag: el.tagName, href: el.getAttribute('href') || null,
      h: Math.round(el.getBoundingClientRect().height),
    })),
    dialog: s.querySelector('.shs__box').getAttribute('role') === 'dialog'
      && s.querySelector('.shs__box').getAttribute('aria-modal') === 'true',
    focusInside: s.contains(document.activeElement),
    contactFields: s.querySelectorAll('input[type="email"], input[type="tel"]').length,
  };
});

const browser = await chromium.launch();
if (SHOTS) mkdirSync(SHOTDIR, { recursive: true });

/* ================= lifecycle: cases 1..10 ================= */
console.log('\n=== lifecycle ===');
{
  const c = await ctx(browser, { width: 1280, height: 900 });
  const p = await boot(c);

  const iconAt = (sel) => p.evaluate(s => {
    const el = document.getElementById('campshare');
    return { present: !!el, inHead: !!(el && el.closest('.camp__head')), open: !!(el && el.classList.contains('open')),
      label: el ? el.getAttribute('aria-label') : null };
  }, sel);

  await goState(p, 'forming');
  let ic = await iconAt();
  ok(ic.present && ic.inHead && ic.open, `1. forming: header icon present, accent state (${JSON.stringify(ic)})`);
  ok(await p.$('#panel .shinvite') !== null, '1. forming: full-width ghost invite in the panel');
  ok(/Côte-des-Neiges/.test(ic.label || ''), `52. aria-label names the cohort (${ic.label})`);

  await openSheet(p, 'icon');
  let sh = await sheetState(p);
  ok(!!sh, '1. header icon opens the sheet');
  ok(sh && /^I joined the Côte-des-Neiges Autumn cohort on Whollar\./.test(sh.prose), '1. forming copy is the join-us line, cohort name unabridged');
  ok(sh && sh.prose.includes(`Use my code K7MQ-T4WS`), '1. line 2 carries the display-form code');
  ok(sh && sh.url === `${BASE}/r/${TOKEN}`, `4.x URL is the short link (${sh && sh.url})`);
  ok(sh && sh.dialog, '53. role=dialog and aria-modal=true');
  ok(sh && sh.focusInside, '54. focus moved into the sheet');
  ok(sh && sh.contactFields === 0, '38. no email or phone field for a third party in the sheet');
  ok(sh && !/\$\d/.test(sh.prose), '42. no dollar figure in the share text');
  ok(sh && sh.code === 'K7MQ-T4WS', '46. the code shown is the member’s own');

  /* 54/55/60: escape closes and focus returns to the trigger */
  await p.keyboard.press('Escape');
  await p.waitForTimeout(80);
  ok(await p.evaluate(() => document.getElementById('sharesheet').hidden), '55. Escape closes the sheet');
  ok(await p.evaluate(() => document.activeElement && document.activeElement.id === 'campshare'), '54. focus returned to the header icon');

  /* panel button opens the same sheet */
  await openSheet(p, 'panel');
  sh = await sheetState(p);
  ok(!!sh, '1. panel invite opens the same sheet');
  await p.evaluate(() => document.querySelector('#sharesheet .shs__scrim').click());
  await p.waitForTimeout(80);
  ok(await p.evaluate(() => document.getElementById('sharesheet').hidden), '55. scrim click closes');

  await goState(p, 'closing');
  ic = await iconAt();
  ok(ic.present && ic.open && await p.$('#panel .shinvite') !== null, '2. join closing: both controls, accent state');

  for (const [n, st] of [[3, 'locked'], [4, 'bidding']]) {
    await goState(p, st);
    ic = await iconAt();
    const inv = await p.$('#panel [data-act="invite"]');
    ok(ic.present && !ic.open && inv === null, `${n}. ${st}: header icon only, quiet colour, no panel invite`);
    await openSheet(p, 'icon');
    sh = await sheetState(p);
    ok(sh && /My cohort in Côte-des-Neiges is closed and founding partners are bidding/.test(sh.prose), `${n}. ${st}: copy pivots to the next round`);
    ok(sh && sh.eyebrow === 'Share the next round', `${n}. ${st}: eyebrow says next round`);
    await p.keyboard.press('Escape'); await p.waitForTimeout(60);
  }

  for (const [n, st] of [[5, 'offers'], [6, 'confirm'], [6, 'switching']]) {
    await goState(p, st);
    ic = await iconAt();
    ok(ic.present && !ic.open && await p.$('#panel [data-act="invite"]') === null, `${n}. ${st}: header icon only`);
    await openSheet(p, 'icon');
    sh = await sheetState(p);
    ok(sh && /got its sealed bid back/.test(sh.prose) && /next round is forming/.test(sh.prose), `${n}. ${st}: result copy, next-round destination framing`);
    ok(sh && !sh.url.includes('campaign') && sh.url === `${BASE}/r/${TOKEN}`, `${n}. ${st}: URL does not point at the closed cohort`);
    await p.keyboard.press('Escape'); await p.waitForTimeout(60);
  }

  for (const [n, st, label] of [[7, 'done', 'archived'], [8, 'passed', 'passed-still-shares']]) {
    await goState(p, st);
    ic = await iconAt();
    ok(ic.present && !ic.open, `${n}. ${st}: header icon present, quiet`);
    ok(await p.$('#panel [data-act="invite"]') === null, `${n}. ${st}: no panel invite`);
    await openSheet(p, 'icon');
    sh = await sheetState(p);
    ok(sh && /I switched through a Whollar cohort/.test(sh.prose), `${n}. ${st}: ${label} copy`);
    await p.keyboard.press('Escape'); await p.waitForTimeout(60);
  }

  await goState(p, 'short');
  ok(await p.evaluate(() => document.getElementById('campshare') === null), '9. short: the control is ABSENT from the DOM, not hidden');
  ok(await p.evaluate(() => document.querySelectorAll('#panel [data-act="invite"], #panel .shinvite').length === 0), '9. short: no invite button in the panel either');

  /* 10. stage advances while the sheet is open */
  await goState(p, 'forming');
  await openSheet(p, 'icon');
  ok(!!(await sheetState(p)), '10. sheet open at forming');
  await goState(p, 'locked');
  ok(await p.evaluate(() => document.getElementById('sharesheet').hidden), '10. stage change closed the sheet');
  ok(await p.evaluate(() => document.getElementById('toast').textContent.includes('moved on')), '10. one quiet line says the cohort moved on');

  /* 60. full keyboard path */
  await goState(p, 'forming');
  await p.focus('#campshare');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(120);
  ok(!!(await sheetState(p)), '60. Enter on the focused icon opens the sheet');
  const cycled = await p.evaluate(() => {
    const box = document.querySelector('#sharesheet .shs__box');
    const f = [...box.querySelectorAll('button,a[href],input:not([type=hidden])')].filter(el => el.offsetParent !== null);
    return f.length >= 5;
  });
  ok(cycled, '60. sheet exposes a tabbable path through the channels');
  await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
  ok(await p.evaluate(() => document.getElementById('sharesheet').contains(document.activeElement)), '54. tab stays inside the sheet');
  await p.keyboard.press('Escape');

  /* analytics whitelist: no "auction" in any event name or prop */
  const evs = c._events;
  ok(evs.length > 0 && evs.every(e => !JSON.stringify(e).toLowerCase().includes('auction')), `8. analytics events fired without the a-word (${evs.length} events)`);
  ok(evs.some(e => e.event === 'share_control_shown') && evs.some(e => e.event === 'share_opened') && evs.some(e => e.event === 'share_dismissed'),
    '8. shown, opened and dismissed all reported');

  ok(p._errors.length === 0, `28. no console errors across the lifecycle walk (${p._errors.join(' | ') || 'none'})`);
  await closeCtx(c);
}

/* ================= identity: cases 11, 12, 44 ================= */
console.log('\n=== identity and attribution ===');
{
  /* Legacy code only: the mint failed or the table is not provisioned. */
  const c = await ctx(browser, { width: 1280, height: 900 }, { referral: 'legacy' });
  const p = await boot(c);
  await goState(p, 'forming');
  await openSheet(p, 'icon');
  const sh = await sheetState(p);
  ok(sh && sh.url === `${BASE}/r/WHL-1A2B3C4D`, `11. legacy code still yields a working short link (${sh && sh.url})`);
  ok(sh && sh.code === 'WHL-1A2B3C4D', '11. legacy code displayed as-is');
  await closeCtx(c);
}
{
  /* Referral endpoint down entirely: the share must still work, cohort-only. */
  const c = await ctx(browser, { width: 1280, height: 900 }, { referral: 'fail' });
  const p = await boot(c);
  await goState(p, 'forming');
  await openSheet(p, 'icon');
  const sh = await sheetState(p);
  ok(!!sh, '12. mint failure does not block the share');
  ok(sh && sh.url === `${BASE}/waitlist/`, `12. cohort-only URL, attribution absent (${sh && sh.url})`);
  ok(sh && sh.code === null && !/Use my code/.test(sh.prose), '12/13. no placeholder token, no fabricated code, no line 2');
  ok(p._errors.length === 0, '12. and no console error while degraded');
  await closeCtx(c);
}

/* ================= channels: cases 29..37, 33..36, 43 ================= */
console.log('\n=== channels and platform ===');
{
  const c = await ctx(browser, { width: 1280, height: 900 });
  const p = await boot(c);
  await goState(p, 'forming');
  await openSheet(p, 'icon');
  const sh = await sheetState(p);
  const by = k => sh.channels.find(x => x.kind === k);
  ok(sh.channels.length === 4, `channel row is Copy, Message, WhatsApp, Email (${sh.channels.map(x => x.kind).join(', ')})`);
  ok(by('sms').tag === 'A' && by('sms').href.startsWith('sms:?&body='), '33. SMS uses the form both platforms tolerate, as a real anchor');
  const smsBody = decodeURIComponent(by('sms').href.slice('sms:?&body='.length));
  ok(smsBody.length <= 140, `33. SMS body is ${smsBody.length} chars including the URL (budget 140)`);
  ok(smsBody.endsWith(`/r/${TOKEN}`), '33. the URL survives the SMS truncation, whole');
  const wa = decodeURIComponent(by('whatsapp').href.replace('https://wa.me/?text=', ''));
  ok(wa.includes('Côte-des-Neiges') && wa.includes(`/r/${TOKEN}`), '34/43. WhatsApp text decodes intact, accents included');
  ok(by('whatsapp').tag === 'A' && by('email').tag === 'A', '36. channels are real anchors, not window.open');
  const mail = by('email').href;
  ok(mail.includes('%0D%0A'), '35. email body carries CRLF as %0D%0A');
  ok(decodeURIComponent(mail).length < 1800, '35. email href under 1800 characters');
  ok(/subject=A%20cohort%20forming%20in%20C%C3%B4te-des-Neiges/.test(mail), '43. accented region correct in the email subject');

  /* 29. native share cancelled: AbortError is swallowed, nothing recorded */
  await p.keyboard.press('Escape'); await p.waitForTimeout(60);
  const before = c._events.filter(e => e.event === 'share_native_completed').length;
  await p.evaluate(() => {
    navigator.share = () => Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' }));
    navigator.canShare = () => true;
  });
  await p.click('#campshare'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => document.getElementById('sharesheet').hidden), '29. AbortError: no fallback UI, no error');
  ok(c._events.filter(e => e.event === 'share_native_completed').length === before, '29. a cancelled share records no completion');
  ok(p._errors.length === 0, '29. and throws nothing to the console');

  /* 30. NotAllowedError falls back to the sheet in the same interaction */
  await p.evaluate(() => {
    navigator.share = () => Promise.reject(Object.assign(new Error('gesture'), { name: 'NotAllowedError' }));
  });
  await p.click('#campshare'); await p.waitForTimeout(200);
  ok(!(await p.evaluate(() => document.getElementById('sharesheet').hidden)), '30. NotAllowedError: the sheet opened instead');

  /* native completion */
  await p.keyboard.press('Escape'); await p.waitForTimeout(60);
  await p.evaluate(() => { navigator.share = () => Promise.resolve(); });
  await p.click('#campshare'); await p.waitForTimeout(200);
  ok(c._events.some(e => e.event === 'share_native_completed'), '8. share_native_completed fires only on a resolved promise');

  /* 31/32. clipboard denied: the manual lane */
  await p.evaluate(() => {
    delete navigator.share;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });
  await p.click('#campshare'); await p.waitForTimeout(120);
  await p.click('[data-shch="copy"]'); await p.waitForTimeout(120);
  const man = await p.evaluate(() => {
    const m = document.getElementById('shs-man');
    const i = document.getElementById('shs-manurl');
    return { shown: !m.hidden, value: i.value, selected: i.selectionEnd - i.selectionStart === i.value.length, focused: document.activeElement === i };
  });
  ok(man.shown && man.value.endsWith(`/r/${TOKEN}`), '31/32. tier 3: read-only input carries the link');
  ok(man.selected && man.focused, '31. auto-selected and focused for a manual copy');

  /* 37. event endpoint down: the sheet still works */
  await c.unroute('**/api/auth/share/event');
  await c.route('**/api/auth/share/event', r => r.abort());
  await p.keyboard.press('Escape'); await p.waitForTimeout(60);
  await p.click('#campshare'); await p.waitForTimeout(200);
  ok(!(await p.evaluate(() => document.getElementById('sharesheet').hidden)), '37. telemetry failure does not block the sheet');
  ok(p._errors.length === 0, '37. and fails quietly');
  await closeCtx(c);
}

/* ================= geography: case 27, the regression test ================= */
console.log('\n=== the FSA rule ===');
{
  /* The recipient side: land with a ref parameter the way /r/:token delivers
   * it, then assert the sender's region reaches NOTHING in the form state.
   * Asserted on rendered form values, not the URL. */
  const c = await ctx(browser, { width: 1280, height: 900 });
  const p = await c.newPage();
  p.on('pageerror', e => (p._errors ||= []).push(String(e)));
  await p.goto(`${BASE}/waitlist/?ref=${TOKEN}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  const leak = await p.evaluate(() => {
    const banked = (() => { try { return JSON.parse(localStorage.getItem('whollar.ref')); } catch { return null; } })();
    /* The rule is about the recipient's ADDRESS: the referral code field MAY
     * carry the code (that is the attribution working, and the recipient can
     * see and remove it); nothing may carry a region, city, FSA or postal
     * code. Checkboxes report value "on" whether checked or not, so only
     * checked ones count as carrying anything. */
    const values = [...document.querySelectorAll('input, select, textarea')]
      .filter(el => el.type !== 'checkbox' || el.checked)
      .filter(el => !/ref/i.test(el.id || el.name || ''))
      .map(el => String(el.value || '')).filter(Boolean);
    const postal = [...document.querySelectorAll('input')]
      .filter(el => /postal|fsa|zip/i.test((el.id || '') + (el.name || '') + (el.autocomplete || '')))
      .map(el => el.value);
    return { banked: banked && banked.code, values, postal };
  });
  ok(leak.banked === TOKEN, `27. the token was banked on arrival (${leak.banked})`);
  ok(!leak.values.some(v => /M4K|M5R|Côte|Clair|London|Kingston|Riverdale/i.test(v)), `27. no sender region or FSA pre-fills any field (${leak.values.length} non-ref fields carry values)`);
  ok(leak.postal.every(v => !v), `27. every postal field is empty: the recipient enters their own address (${leak.postal.length} postal fields)`);
  await closeCtx(c);
}

/* ================= responsive + shots: cases 57, 61..64 ================= */
console.log('\n=== responsive ===');
for (const vw of [1280, 940, 768, 390]) {
  const c = await ctx(browser, { width: vw, height: 900 });
  const p = await boot(c);
  await goState(p, 'forming');
  if (SHOTS) await p.screenshot({ path: `${SHOTDIR}/share-${vw}-forming.png`, fullPage: false });
  const icon = await p.evaluate(() => {
    const el = document.getElementById('campshare');
    const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) };
  });
  if (vw <= 768) ok(icon.w >= 44 && icon.h >= 44, `57. ${vw}px: icon touch target ${icon.w}x${icon.h}`);
  else ok(icon.w === 36 && icon.h === 36, `61/62. ${vw}px: icon at its drawn 36px`);

  await openSheet(p, 'icon');
  const sh = await sheetState(p);
  const geom = await p.evaluate(() => {
    const box = document.querySelector('#sharesheet .shs__box');
    const b = box.getBoundingClientRect();
    const row = document.getElementById('shs-row');
    const cols = getComputedStyle(row).gridTemplateColumns.split(' ').length;
    const name = document.getElementById('shs-name');
    return { w: Math.round(b.width), bottom: Math.round(b.bottom), vh: innerHeight, cols,
      radius: getComputedStyle(box).borderRadius, nameLines: Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight || 24)) };
  });
  if (vw >= 940) ok(geom.cols === 4 && geom.w <= 480, `61/62. ${vw}px: centred modal, four channels one row (${geom.cols} cols, ${geom.w}px)`);
  if (vw === 768) ok(geom.cols === 2, `63. 768px: channels 2 x 2 (${geom.cols} cols)`);
  if (vw === 768) ok(sh.channels.every(x => x.h >= 44), `63. 768px: channel targets at least 44px (${sh.channels.map(x => x.h).join(',')})`);
  if (vw === 390) {
    ok(geom.bottom >= geom.vh - 1, '64. 390px: bottom sheet sits on the bottom edge');
    ok(geom.cols === 2, '64. 390px: channels 2 x 2');
    ok(geom.nameLines <= 1, '64. 390px: cohort chip does not wrap (one line, ellipsis)');
    if (SHOTS) await p.screenshot({ path: `${SHOTDIR}/share-390-sheet.png` });
  }
  if (vw === 1280 && SHOTS) await p.screenshot({ path: `${SHOTDIR}/share-1280-modal.png` });
  await p.keyboard.press('Escape');

  if (vw === 1280) {
    await goState(p, 'offers');
    if (SHOTS) await p.screenshot({ path: `${SHOTDIR}/share-1280-offers.png` });
    await goState(p, 'short');
    if (SHOTS) await p.screenshot({ path: `${SHOTDIR}/share-1280-short.png` });
  }
  ok(p._errors.length === 0, `${vw}px: no console errors`);
  await closeCtx(c);
}

/* ================= 58: icon contrast, computed not eyeballed ================= */
{
  const lum = (hex) => {
    const c = hex.match(/[0-9a-f]{2}/gi).map(x => parseInt(x, 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const rSub = ratio('5B655C', 'FCFAF5'), rAcc = ratio('2C6A4E', 'FCFAF5');
  ok(rSub >= 3, `58. quiet glyph on card: ${rSub.toFixed(2)}:1 (needs 3:1)`);
  ok(rAcc >= 3, `58. accent glyph on card: ${rAcc.toFixed(2)}:1 (needs 3:1)`);
}

/* ================= 59: reduced motion ================= */
{
  const c = await ctx(browser, { width: 1280, height: 900 });
  const p = await c.newPage();
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await p.goto(`${BASE}/dashboard?demo=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await goState(p, 'forming');
  await openSheet(p, 'icon');
  const t = await p.evaluate(() => {
    const s = getComputedStyle(document.querySelector('#sharesheet .shs__box'));
    return { transition: s.transitionProperty, transform: s.transform };
  });
  ok(!t.transition.includes('transform'), `59. reduced motion: fade only, no transform transition (${t.transition})`);
  await closeCtx(c);
}

await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
