#!/usr/bin/env node
/* The tire vertical's six modals: /  on tires.whollar.ca.
 *
 *   npx -y serve tires -l 4173     # or any static server on tires/
 *   node scripts/qa-tire-kit.mjs [base]
 *
 * Sibling of the other qa-*.mjs harnesses, and by hand rather than in CI for
 * the same reason: it needs a browser. What it proves is the thing a static
 * gate cannot, that the ported v5 engine actually boots against this page's
 * markup and that all six buttons open the dialog they should.
 *
 * No network stubs are needed and none are set up: this page calls no backend.
 */
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || 'http://localhost:4173').replace(/\/+$/, '');
let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE + '/', { waitUntil: 'networkidle' });

console.log('\nthe engine boots');
ok(errors.length === 0, `no console or page errors on load${errors.length ? ': ' + errors[0] : ''}`);
ok(await page.locator('#wmodal').count() === 1, 'the dialog exists, once');
ok(await page.locator('#wmodal').isHidden(), 'and starts hidden');
ok(await page.locator('#wm-park [id="quickForm"]').count() === 1, 'the sign-up is parked off screen');
ok((await page.locator('#tally').textContent()).trim() === '0 of 4 answered', 'the tally starts at zero');

const modal = page.locator('#wmodal');
const title = page.locator('#wmodalTitle');
const bodyOverflow = () => page.evaluate(() => document.body.style.overflow);

console.log('\nthe four tools');
const TOOLS = [
  ['strat', 'Winter tires, or all-weather?', 'What is on the car right now?'],
  ['size', 'What size do I actually need?', 'Are you buying a second set of wheels for winter?'],
  ['rims', 'One set of wheels, or two?', 'What is on the car now?'],
  ['ins', 'What does my insurer actually give back?', 'Province'],
];
for (const [key, want, firstQuestion] of TOOLS) {
  await page.locator(`[data-wtool="${key}"]`).click();
  await modal.waitFor({ state: 'visible' });
  ok((await title.textContent()) === want, `${key}: opens with the right title`);
  ok((await page.locator('#wmodalBody').textContent()).includes(firstQuestion), `${key}: its first question is in the dialog`);
  ok(await bodyOverflow() === 'hidden', `${key}: the page behind is scroll locked`);
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  ok(await bodyOverflow() === '', `${key}: Escape closes it and restores the page`);
}

console.log('\nthe strategy tool answers, and the card remembers');
await page.locator('[data-wtool="strat"]').click();
await modal.waitFor({ state: 'visible' });
for (const [group, value] of [['now', 'allseason'], ['work', 'no'], ['usage', 'city'], ['storm', 'yes'],
  ['who', 'solo'], ['drv', 'fwd'], ['fric', 'none']]) {
  await page.locator(`#kxstrat-${group} .chip[data-v="${value}"]`).click();
}
await page.locator('#kxstrat-run').click();
ok((await page.locator('#kxstrat-out').textContent()).length > 80, 'it produces a verdict');
await page.keyboard.press('Escape');
await modal.waitFor({ state: 'hidden' });
const verdict = (await page.locator('#verdict-strat').textContent()).trim();
ok(verdict.length > 0, `the card shows the verdict: ${verdict || '(empty)'}`);
ok((await page.locator('#tally').textContent()).trim() === '1 of 4 answered', 'the tally reads 1 of 4');

console.log('\nall-weather locks the wheels card');
await page.locator('[data-wtool="strat"]').click();
await modal.waitFor({ state: 'visible' });
for (const [group, value] of [['now', 'allseason'], ['work', 'no'], ['usage', 'parkit'], ['storm', 'yes'],
  ['who', 'solo'], ['drv', 'fwd'], ['fric', 'hate']]) {
  await page.locator(`#kxstrat-${group} .chip[data-v="${value}"]`).click();
}
await page.locator('#kxstrat-run').click();
await page.keyboard.press('Escape');
await modal.waitFor({ state: 'hidden' });
const locked = await page.locator('#tool-rims').evaluate(el => el.classList.contains('locked'));
ok(locked, 'the wheels card is locked after an all-weather verdict');
if (locked) {
  await page.locator('[data-wtool="rims"]').click();
  ok(await modal.isHidden(), 'and clicking it does not open the dialog');
}

console.log('\nthe two sign-up paths');
for (const [which, want, field] of [['quick', 'Hold my spot', '#q_first'], ['guided', 'Build my profile', '#g_first']]) {
  await page.locator(`[data-wpath="${which}"]`).click();
  await modal.waitFor({ state: 'visible' });
  ok((await title.textContent()) === want, `${which}: opens with the right title`);
  ok(await page.locator(`#wmodalBody ${field}`).count() === 1, `${which}: its form is in the dialog`);
  await page.locator('#wmodalClose').click();
  await modal.waitFor({ state: 'hidden' });
  ok(await page.locator(`#wm-park ${field}`).count() === 1, `${which}: the form goes back to the park, not the bin`);
}

console.log('\ntyped answers survive a close');
await page.locator('[data-wpath="quick"]').click();
await modal.waitFor({ state: 'visible' });
await page.locator('#q_first').fill('Ada');
await page.locator('#wmodalClose').click();
await modal.waitFor({ state: 'hidden' });
await page.locator('[data-wpath="quick"]').click();
await modal.waitFor({ state: 'visible' });
ok((await page.locator('#q_first').inputValue()) === 'Ada', 'a half typed name is still there on reopen');
await page.keyboard.press('Escape');

console.log('\nthe backdrop closes it');
await page.locator('[data-wtool="ins"]').click();
await modal.waitFor({ state: 'visible' });
await page.mouse.click(12, 12);
await modal.waitFor({ state: 'hidden' });
ok(true, 'a click on the backdrop closes the dialog');

console.log('\nthe guided form walks its three stages inside the dialog');
await page.locator('[data-wpath="guided"]').click();
await modal.waitFor({ state: 'visible' });
await page.locator('#g_first').fill('Ada');
await page.locator('#g_last').fill('Lovelace');
await page.locator('#g_email').fill('ada@example.com');
await page.locator('#g_postal').fill('M4B1B3');
await page.locator('#g_city .chip[data-v="gta"]').click();
await page.locator('#g_consent').check();
await page.locator('#g1 button[type="submit"]').click();
ok(await page.locator('#g2').isVisible(), 'stage 1 submits and stage 2 appears');
ok(await modal.isVisible(), 'and the dialog is still the thing on screen');
const pct = (await page.locator('#meterPct').textContent()).trim();
ok(/^\d+% complete$/.test(pct), `the completeness meter reads a number: ${pct}`);
await page.locator('#g_have .chip[data-v="none"]').click();
await page.locator('#g2 button[type="submit"]').click();
ok(await page.locator('#g3').isVisible(), 'stage 2 submits and stage 3 appears');
await page.locator('#g3 button[type="submit"]').click();
ok(await page.locator('#confirmView').isVisible(), 'stage 3 submits to the completion screen');
const conf = await page.locator('#wmodalBody').textContent();
ok(!/#\s*\d/.test(conf.split('What happens next')[0]), 'the completion screen puts no invented number on the household');
ok(!/emailed it to you|on its way to/i.test(conf), 'and claims no email that was never sent');
await page.locator('#wmodalClose').click();
await modal.waitFor({ state: 'hidden' });

console.log('\nkeyboard and focus');
const opener = page.locator('[data-wtool="size"]');
await opener.click();
await modal.waitFor({ state: 'visible' });
const inside = await page.evaluate(() => !!document.querySelector('#wmodal').contains(document.activeElement));
ok(inside, 'focus moves into the dialog on open');
for (let i = 0; i < 60; i++) await page.keyboard.press('Tab');
const stillInside = await page.evaluate(() => !!document.querySelector('#wmodal').contains(document.activeElement));
ok(stillInside, 'and sixty tabs never escape it');
await page.keyboard.press('Escape');
await modal.waitFor({ state: 'hidden' });
const returned = await page.evaluate(() => document.activeElement.getAttribute('data-wtool'));
ok(returned === 'size', 'focus returns to the control that opened it');

console.log('\non a phone it is a full screen sheet');
await page.setViewportSize({ width: 390, height: 780 });
/* Not the wheels card: the all-weather verdict above locked it, correctly. */
await page.locator('[data-wtool="ins"]').click();
await modal.waitFor({ state: 'visible' });
const box = await page.locator('#wmodal .wmodal').boundingBox();
ok(box.width >= 386, `the sheet fills the width: ${Math.round(box.width)}px of 390`);
ok(box.height >= 700, `and the height: ${Math.round(box.height)}px of 780`);
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1280, height: 900 });

console.log('\nno JavaScript is still a working link');
const hrefs = await page.locator('[data-wtool],[data-wpath]').evaluateAll(els => els.map(e => e.getAttribute('href')));
ok(hrefs.every(h => h && h.startsWith('/join')), 'all six controls are links to /join underneath');

ok(errors.length === 0, `no errors across the whole run${errors.length ? ': ' + errors[0] : ''}`);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
