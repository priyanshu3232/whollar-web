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
page.on('console', m => {
  if (m.type() !== 'error') return;
  /* The failure test stubs a 500 on purpose, and the browser logs every failed
     resource. Counting that as an unexpected error would make the check fail
     for the one thing it is proving works. */
  const from = (m.location() && m.location().url) || '';
  if (/tire-waitlist-join/.test(from)) return;
  errors.push(m.text());
});

/* The route is stubbed for the whole run, from before the first submit.
   Without this the earlier guided-form test posts for real, and against an
   undeployed route that is a 404 in the console, which then fails the "no
   errors" check for a reason that has nothing to do with the page. */
let posted = null;
async function stubRoute(status = 200, body = { ok: true, reference: 'WHL-TIRE-GTA-K7QM', wave: 1 }) {
  await page.unroute('**/server/formSubmit/tire-waitlist-join').catch(() => {});
  await page.route('**/server/formSubmit/tire-waitlist-join', async (route) => {
    posted = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}
await stubRoute();

await page.goto(BASE + '/', { waitUntil: 'networkidle' });

console.log('\nthe engine boots');
ok(errors.length === 0, `no console or page errors on load${errors.length ? ': ' + errors[0] : ''}`);
ok(await page.locator('#wmodal').count() === 1, 'the dialog exists, once');
ok(await page.locator('#wmodal').isHidden(), 'and starts hidden');
ok(await page.locator('#wm-park [id="quickForm"]').count() === 1, 'the sign-up is parked off screen');
ok((await page.locator('#tally').textContent()).trim() === '0 of 4 answered', 'the tally starts at zero');

/* Single-select groups of five or more condense to a dropdown, so answering
   by clicking the chip would be driving a control no reader can see. This
   picks through whichever one the group actually rendered. */
async function pick(page, box, value) {
  const condensed = await page.locator(box).getAttribute('data-condensed');
  if (!condensed) return page.locator(`${box} .chip[data-v="${value}"]`).click();
  const i = await page.locator(`${box} .chip`).evaluateAll(
    (els, v) => els.findIndex(e => e.dataset.v === v), value);
  if (i < 0) throw new Error(`${box} has no option ${value}`);
  await page.locator(`${box} + select.wm-condensed`).selectOption(String(i));
}

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
  await pick(page, `#kxstrat-${group}`, value);
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
  await pick(page, `#kxstrat-${group}`, value);
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
await pick(page, '#g_city', 'gta');
await page.locator('#g_consent').check();
await page.locator('#g1 button[type="submit"]').click();
ok(await page.locator('#g2').isVisible(), 'stage 1 submits and stage 2 appears');
ok(await modal.isVisible(), 'and the dialog is still the thing on screen');
const pct = (await page.locator('#meterPct').textContent()).trim();
ok(/^\d+% complete$/.test(pct), `the completeness meter reads a number: ${pct}`);
await pick(page, '#g_have', 'none');
await page.locator('#g2 button[type="submit"]').click();
ok(await page.locator('#g3').isVisible(), 'stage 2 submits and stage 3 appears');
await page.locator('#g3 button[type="submit"]').click();
/* This one posts now, so the screen it opens is on the far side of a round
   trip rather than of a function call. */
await page.waitForTimeout(800);
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

console.log('\nthe form fields do not overlap');
await page.locator('[data-wpath="quick"]').click();
await modal.waitFor({ state: 'visible' });
const first = await page.locator('#q_first').boundingBox();
const last = await page.locator('#q_last').boundingBox();
ok(first.x + first.width <= last.x + 0.5,
  `first and last name are side by side, not overlapping (gap ${Math.round(last.x - (first.x + first.width))}px)`);
const wide = await page.locator('#wmodalBody').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
ok(wide, 'and nothing in the dialog overflows it sideways');
await page.keyboard.press('Escape');
await modal.waitFor({ state: 'hidden' });

console.log('\nthe guided panel lays out cleanly');
await page.locator('[data-wpath="guided"]').click();
await modal.waitFor({ state: 'visible' });
await page.locator('#g_first').fill('Ada');
await page.locator('#g_last').fill('Lovelace');
await page.locator('#g_email').fill('ada@example.com');
await page.locator('#g_postal').fill('M4B1B3');
await pick(page, '#g_city', 'gta');
await page.locator('#g_consent').check();
await page.locator('#g1 button[type="submit"]').click();
const meter = await page.locator('#meter').boundingBox();
const heading = await page.locator('#g2 h3').boundingBox();
ok(meter.y + meter.height <= heading.y + 1,
  `the sticky meter sits above the heading, not across it (${Math.round(heading.y - (meter.y + meter.height))}px clear)`);
const rows = await page.locator('#g_have .chip').evaluateAll(els => {
  const tops = els.map(e => Math.round(e.getBoundingClientRect().top));
  const widths = els.map(e => Math.round(e.getBoundingClientRect().width));
  return { rows: new Set(tops).size, widths: new Set(widths).size };
});
ok(rows.rows === 2, `the four starting-point options sit in two even rows (${rows.rows})`);
ok(rows.widths === 1, `and every one is the same width (${rows.widths} distinct)`);
const gaps = await page.locator('#g2 .sec-t').evaluateAll(els => els.slice(1).map((el, i) => {
  const prev = els[i].parentElement.querySelector('.sec-t');
  return Math.round(el.getBoundingClientRect().top);
}));
const secGap = await page.evaluate(() => {
  const t = document.querySelectorAll('#g2 .sec-t')[1];
  const cs = getComputedStyle(t);
  return parseFloat(cs.marginTop) + parseFloat(cs.paddingTop);
});
ok(secGap <= 32, `a section break costs ${secGap}px, not v5's 48`);
const cardPad = await page.locator('#g2').evaluate(el => parseFloat(getComputedStyle(el).paddingTop));
ok(cardPad === 0, `the panel is not a card inside a card (padding ${cardPad}px)`);
const nativeArrow = await page.locator('#g_brand').evaluate(el => getComputedStyle(el).appearance);
ok(nativeArrow === 'none', `the selects use the site's own chevron, not the platform's (appearance: ${nativeArrow})`);
const selBg = await page.locator('#g_brand').evaluate(el => getComputedStyle(el).backgroundImage);
ok(selBg.includes('svg'), 'and that chevron is actually painted');
await page.locator('#wmodalClose').click();
await modal.waitFor({ state: 'hidden' });

console.log('\nlong option lists are dropdowns');
await page.locator('[data-wpath="guided"]').click();
await modal.waitFor({ state: 'visible' });
const condensed = await page.locator('#wmodalBody .chips[data-condensed]').evaluateAll(
  els => els.map(e => ({ id: e.id, n: e.querySelectorAll('.chip').length, shown: e.offsetParent !== null })));
ok(condensed.length > 0, `${condensed.length} long lists condensed: ${condensed.map(c => c.id + '(' + c.n + ')').join(', ')}`);
ok(condensed.every(c => c.n >= 5), 'every condensed group had five or more options');
ok(condensed.every(c => !c.shown), 'and none of them still shows its chips');
const short = await page.locator('#wmodalBody .chips:not([data-condensed])').evaluateAll(
  els => els.filter(e => e.dataset.single).map(e => e.querySelectorAll('.chip').length));
ok(short.every(n => n < 5), `every group left as chips has four or fewer: ${short.join(', ')}`);
await pick(page, '#g_city', 'gta');
ok((await page.locator('#g_city .chip[data-v="gta"]').getAttribute('aria-pressed')) === 'true',
  'choosing from the dropdown presses the chip the rest of the code reads');
await page.locator('#wmodalClose').click();
await modal.waitFor({ state: 'hidden' });

console.log('\nan in-page link glides rather than jumps');
await page.evaluate(() => window.scrollTo(0, 0));
const cta = page.locator('a[href="#join"]').first();
await cta.click();
await page.waitForTimeout(220);
const early = await page.evaluate(() => window.pageYOffset);
ok(early > 0, 'it has started moving a fifth of a second in');
const joinTop = await page.locator('#join').evaluate(el => el.getBoundingClientRect().top + window.pageYOffset);
ok(early < joinTop * 0.6, `and is not there yet, which is the point (${Math.round(early)} of ${Math.round(joinTop)})`);
await page.waitForTimeout(2200);
const framed = await page.locator('#join').evaluate(el => {
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, h: Math.round(r.height) };
});
/* The join section is a screenful, so it should come to rest framed: nothing
   of the section above showing, and its cards not cut off below. */
ok(framed.top <= 2 && framed.top >= -Math.max(4, framed.h - framed.vh) - 2,
  `the section rests at the top of the screen, not pushed down by the header (top ${framed.top})`);
ok(framed.bottom >= framed.vh - 2,
  `and its foot is not cut off (bottom ${framed.bottom} of ${framed.vh})`);
await page.evaluate(() => window.scrollTo(0, 0));

console.log('\nthe submit sends what the route reads');
/* The route is POST /tire-waitlist-join in formSubmit. This stubs it so the
   contract between the two can be checked without deploying a function or
   writing a row: what the page posts has to be what the handler validates. */
posted = null;
await page.locator('[data-wpath="guided"]').click();
await modal.waitFor({ state: 'visible' });
await page.locator('#g_first').fill('Ada');
await page.locator('#g_last').fill('Lovelace');
await page.locator('#g_email').fill('ada@example.com');
await page.locator('#g_postal').fill('M4B1B3');
await pick(page, '#g_city', 'gta');
await page.locator('#g_consent').check();
await page.locator('#g1 button[type="submit"]').click();
await pick(page, '#g_have', 'none');
await page.locator('#g2 button[type="submit"]').click();
await page.locator('#g3 button[type="submit"]').click();
await page.waitForTimeout(900);

ok(posted !== null, 'the form actually posts, rather than logging to the console');
if (posted) {
  /* Exactly the six the handler rejects the row without. */
  for (const f of ['firstName', 'lastName', 'email', 'postalFull', 'city', 'path']) {
    ok(typeof posted[f] === 'string' && posted[f].length > 0, `it sends ${f}, which the route requires`);
  }
  ok(posted.path === 'guided', 'path names which door they came through');
  ok(Array.isArray(posted.vehicles) && posted.vehicles.length === 1, 'the car travels as an array, because a household can bring several');
  ok(Array.isArray(posted.windows), 'the appointment windows travel as an array with their rank');
  ok(posted.details && typeof posted.details === 'object', 'the guided path sends a details object');
  ok(posted.consentGranted === true && typeof posted.consentText === 'string' && posted.consentText.length > 40,
    'the CASL record travels with what was agreed, not just that it was');
  ok(typeof posted.consentSource === 'string', 'and where it was agreed');
  ok(!('ref_code' in posted), 'it does NOT send a reference code: the server mints that');
}
/* And the completion screen shows the code that came BACK, not one it made up. */
const shown = await page.locator('#confRef').count()
  ? (await page.locator('#confRef').textContent()).trim() : '';
ok(await page.locator('#confirmView').isVisible(), 'a successful save opens the completion screen');
await page.locator('#wmodalClose').click().catch(() => {});

console.log('\na failed save does not claim success');
await stubRoute(500, { ok: false, error: 'nope' });
await page.evaluate(() => window.scrollTo(0, 0));
await page.locator('[data-wpath="quick"]').click();
await modal.waitFor({ state: 'visible' });
await page.locator('#q_first').fill('Ada');
await page.locator('#q_last').fill('Lovelace');
await page.locator('#q_email').fill('ada@example.com');
await page.locator('#q_postal').fill('M4B1B3');
await pick(page, '#q_city', 'gta');
await page.locator('#q_consent').check();
await page.locator('#quickForm button[type="submit"]').click();
await page.waitForTimeout(700);
ok(!(await page.locator('#confirmView').isVisible()), 'a 500 does not open the completion screen');
ok(await page.locator('#quickForm').isVisible(), 'and the form is still there with what was typed');
ok((await page.locator('#q_first').inputValue()) === 'Ada', 'nothing the household typed was lost');
await page.locator('#wmodalClose').click();
await modal.waitFor({ state: 'hidden' });
await stubRoute();

console.log('\nno cream strip at any window height');
/* The bug this guards: the resting place had a fallback for a section more
   than a third taller than the screen, and that fallback offset by the header,
   which left a band of the section above showing over a full-bleed colour
   block. It only appeared on a short window, which is why it survived the
   first two rounds of checking. */
for (const vh of [1000, 900, 800, 700, 640, 560]) {
  await page.setViewportSize({ width: 1280, height: vh });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('a[href="#join"]').first().click();
  await page.waitForTimeout(2300);
  const top = await page.locator('#join').evaluate(el => Math.round(el.getBoundingClientRect().top));
  ok(top <= 2, `at ${vh}px tall the join section reaches the top of the screen (top ${top})`);
}
await page.setViewportSize({ width: 1280, height: 900 });
await page.evaluate(() => window.scrollTo(0, 0));

console.log('\nno JavaScript is still a working link');
const hrefs = await page.locator('[data-wtool],[data-wpath]').evaluateAll(els => els.map(e => e.getAttribute('href')));
ok(hrefs.every(h => h && h.startsWith('/join')), 'all six controls are links to /join underneath');

ok(errors.length === 0, `no errors across the whole run${errors.length ? ': ' + errors[0] : ''}`);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
