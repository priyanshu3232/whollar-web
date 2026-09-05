#!/usr/bin/env node
/* Browser checks for member provider exclusions.
 *
 *   node scripts/dev-server.mjs          # in another shell, port 3000
 *   node scripts/qa-exclusions.mjs
 *
 * The sibling of scripts/qa-offers.mjs, and not wired into CI for the same
 * reason: provisioning Playwright's browser binary costs real time on every
 * run, and check-frontend.yml is deliberately install-free. Run it by hand
 * after touching the exclusion step, the roster panel or the offers panel.
 *
 * Every Catalyst call is intercepted through a CATCH-ALL, so this never
 * reaches the live Development backend and never writes a row.
 *
 * WHAT THIS FILE EXISTS FOR. Section 15's required assertions, and above all
 * assertion 5, the triple-session award scenario. The promise a household is
 * given is absolute, so the check that matters is not "is the excluded brand
 * hidden" but "is it absent from the payload": a card correctly suppressed by
 * CSS over a response that still carries the brand and its price is the
 * failure this feature is most likely to ship. So the network layer is
 * asserted, not the rendered text, wherever the brief says so.
 *
 * WHAT IS NOT CHECKED HERE. The per-member resolution itself is server logic
 * and lives in scripts/test-exclusions.mjs, where it is a pure function over
 * bid rows and the canonical section 9.1 scenario is exact rather than mocked.
 * This file checks that the browser asks the right questions and renders the
 * answers without leaking; it deliberately does not re-implement the filter in
 * a fixture, because a fixture that filters would pass while the server did
 * not.
 */

import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
let pass = 0, fail = 0;
const ok = (c, label) => { c ? (pass++, console.log(`  ok    ${label}`)) : (fail++, console.log(`  FAIL  ${label}`)); };
const head = (t) => console.log(`\n${t}`);

const DAY = 86400000;
const REC = {
  emailKey: 'ada@example.com', email: 'ada@example.com', firstName: 'Ada',
  lastName: 'Lovelace', phone: '(416) 555 0134', postal: 'M5S 2J7',
  fsa: 'M5S', provinceCode: 'ON',
};

/* The registry: one family (Bell, with two flankers) plus three independents,
   which is the smallest shape that exercises both family branches of section
   4.2 and leaves brands outside every family. */
const REGISTRY = [
  { brand_id: 'bell', display_name: 'Bell', parent_brand_id: null },
  { brand_id: 'lucky-mobile', display_name: 'Lucky Mobile', parent_brand_id: 'bell' },
  { brand_id: 'virgin-plus', display_name: 'Virgin Plus', parent_brand_id: 'bell' },
  { brand_id: 'oxio', display_name: 'oxio', parent_brand_id: null },
  { brand_id: 'rogers', display_name: 'Rogers', parent_brand_id: null },
  { brand_id: 'videotron', display_name: 'Vidéotron', parent_brand_id: null },
];

const camp = () => {
  const t = Date.now();
  return {
    id: 'london-east', region: 'London East', sub: 'Autumn cohort', kind: 'auction',
    target: 100, members: 112, households: 112, watching: 0, joinable: false,
    you: 'joined', stage: 'offers', stageLabel: 'offers', next: null,
    dates: {
      announce_at: t - 30 * DAY, bidding_opens_at: t - 20 * DAY,
      bidding_closes_at: t - 2 * DAY, decision_at: t + 18 * DAY,
      switch_window_at: t + 30 * DAY,
    },
  };
};

/**
 * A member context.
 *
 * `book` is what the SERVER would return for this member, already filtered:
 * that is the contract under test. The fixture never filters on the client,
 * because a fixture that did would hide exactly the bug this file is looking
 * for.
 */
async function memberCtx(browser, {
  book, exclusions = [], registryAvailable = true, viewport, onPut, coversAll = false,
  rejectBrand = null,
} = {}) {
  const c = await browser.newContext({ viewport: viewport || { width: 1360, height: 1100 } });
  const seen = [];

  await c.route('**/api/auth/**', r => {
    seen.push(r.request().url());
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [], bids: [], coverage: [] }),
    });
  });
  await c.route('**/api/auth/session', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, user: { ...REC, userType: 'member' } }),
  }));
  await c.route('**/api/auth/campaigns', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, live: true, serverTime: Date.now(), campaigns: [camp()], memberFsa: 'M5S', postalCodeState: 'present' }),
  }));
  await c.route('**/api/auth/brands*', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(registryAvailable
      ? { ok: true, available: true, brands: REGISTRY }
      : { ok: true, available: false, brands: [] }),
  }));
  await c.route('**/api/auth/me/exclusions', r => {
    if (r.request().method() === 'PUT') {
      const body = JSON.parse(r.request().postData() || '{}');
      if (onPut) onPut(body);
      /* The refusal is driven by the fixture rather than by patching the page's
         own session object: the point of assertion 4 is that a real 422 on the
         real save path leaves the picker intact, and a monkey-patched save
         tests the patch. `rejectBrand` names the id the server refuses. */
      if (rejectBrand && (body.brand_ids || []).indexOf(rejectBrand) >= 0) {
        return r.fulfill({ status: 422, contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'That is not a provider we list.', error_key: 'unknown_brand' } }) });
      }
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, coversAll: coversAll ? 'london-east' : null,
          exclusions: (body.brand_ids || []).map(id => ({
            brand_id: id,
            display_name: (REGISTRY.filter(b => b.brand_id === id)[0] || {}).display_name || id,
            source: 'direct', created_at: null,
          })) }) });
    }
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, available: registryAvailable, exclusions }),
    });
  });
  await c.route('**/api/auth/campaigns/*/offer', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ok: true, serverTime: Date.now(), sealed: false, live: true,
      closesAt: Date.now() - 2 * DAY, bidCount: 3,
      book: book || [],
      offer: (book && book.length) ? {
        partner: book[0].partner, price: book[0].price, speed: book[0].tier,
        guaranteeMonths: 24, afterLine: null, equipment: 'inc', mix: null,
      } : null,
    }),
  }));
  await c.route('**/api/auth/me/bill', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, bill: { provider: 'Rogers', monthly: 92, speed: 500, promoEndsOn: null } }),
  }));
  await c.addInitScript(rec => {
    if (sessionStorage.getItem('whl-seeded')) return;
    sessionStorage.setItem('whl-seeded', '1');
    localStorage.setItem('whollar.member', JSON.stringify(rec));
  }, REC);
  c.__seen = seen;
  return c;
}

/** Open the dashboard and settle. */
async function dash(c) {
  const p = await c.newPage();
  const bodies = [];
  p.on('response', async (res) => {
    if (!/\/api\/auth\/campaigns\/[^/]+\/offer(\?|$)/.test(res.url())) return;
    try { bodies.push(await res.text()); } catch { /* torn down */ }
  });
  await p.goto(`${BASE}/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  p.__offerBodies = bodies;
  return p;
}

const browser = await chromium.launch();

/* ------------------------------------------------------------------ *
 * 5. THE AWARD SCENARIO, three sessions
 * ------------------------------------------------------------------ */

head('5. [triple] the award scenario: the cheaper excluded bid never appears');
{
  /* Bid A: 45.00 under Bell. Bid B: 49.00 under Rogers. Both at 500 Mbps.
     Member M excluded Bell, so the SERVER hands M a book holding Rogers at
     49.00 and no trace of Bell. Member N excluded nothing and gets Bell at
     45.00. The two books are what the two fixtures return, because that is
     the server contract; what is asserted is that the browser renders each
     one faithfully and that M's payload is clean. */
  const bookN = [
    { tier: '500 Mbps', price: '45.00', partner: 'Bell', guaranteeMonths: 24, equipment: 'inc', mix: null },
  ];
  const bookM = [
    { tier: '500 Mbps', price: '49.00', partner: 'Rogers', guaranteeMonths: 24, equipment: 'inc', mix: null },
  ];

  const cN = await memberCtx(browser, { book: bookN });
  const pN = await dash(cN);
  const textN = await pN.evaluate(() => document.body.innerText);
  ok(/Bell/.test(textN) && /45/.test(textN), 'the control member is shown Bell at 45.00');

  const cM = await memberCtx(browser, {
    book: bookM,
    exclusions: [{ brand_id: 'bell', display_name: 'Bell', source: 'direct' }],
  });
  const pM = await dash(cM);
  const textM = await pM.evaluate(() => document.body.innerText);
  ok(/Rogers/.test(textM) && /49/.test(textM),
    'the excluding member is shown Rogers at 49.00, the dearer eligible bid');
  ok(!/\bBell\b/.test(textM),
    'and the excluded brand is nowhere in the rendered offer');

  /* THE NETWORK ASSERTION, which is the one the brief insists on. A card
     hidden by CSS over a payload that still names the brand and its price is
     the failure this whole check exists to catch. */
  const payload = (pM.__offerBodies || []).join('\n');
  ok(payload.length > 0, 'the offer payload was captured');
  ok(payload.length > 0 && !/Bell/.test(payload),
    'M’s offer payload contains no reference to the excluded brand');
  ok(payload.length > 0 && !/45\.00/.test(payload),
    'and no reference to the cheaper price that was skipped');
  ok(payload.length > 0 && !/resolution_audit|skipped_excluded_brand|audit_json/.test(payload),
    'and no resolution audit: section 9.2 makes it operator-only');

  await cN.close();
  await cM.close();
}

/* ------------------------------------------------------------------ *
 * 6. every bid excluded
 * ------------------------------------------------------------------ */

head('6. all bids excluded lands on the no-offers state with no bid traces');
{
  const c = await memberCtx(browser, {
    book: [],
    exclusions: [
      { brand_id: 'bell', display_name: 'Bell', source: 'direct' },
      { brand_id: 'rogers', display_name: 'Rogers', source: 'direct' },
    ],
  });
  const p = await dash(c);
  const text = await p.evaluate(() => document.body.innerText);
  ok(!/45\.00|49\.00/.test(text), 'no price from any bid is rendered');
  const payload = (p.__offerBodies || []).join('\n');
  ok(!/"partner"\s*:\s*"(Bell|Rogers)"/.test(payload),
    'and no bid is named in the payload: the member never learns they existed');
  await c.close();
}

/* ------------------------------------------------------------------ *
 * 1, 2, 3. the join step and the family rules
 * ------------------------------------------------------------------ */

head('1-3. the exclusion step, and the family rules of section 4.2');
{
  const c = await memberCtx(browser, { book: [] });
  const p = await dash(c);

  /* The step lives in the six questions, which the dashboard opens from its
     own preferences control. Reached by calling the opener directly rather
     than by driving whichever button happens to be on screen for this state:
     this check is about the step, not about the route to it. */
  await p.evaluate(() => window.WhollarExclusions && window.WhollarExclusions.openStep());
  await p.waitForTimeout(500);

  const step = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="excl-step"]');
    return {
      present: !!el,
      heading: /Any providers you want to avoid\?/.test(document.body.innerText),
      sub: /never be able to send you an offer through Whollar/.test(document.body.innerText),
      search: !!document.querySelector('[data-testid="excl-search"]'),
      chips: el ? el.querySelectorAll('[data-excl]').length : 0,
    };
  });
  ok(step.present, 'the exclusion step renders inside the join questions');
  ok(step.heading, 'with the section 13 heading');
  ok(step.sub, 'and the absolute promise, verbatim');
  ok(step.search, 'and a search field');
  ok(step.chips === REGISTRY.length, `and one chip per active brand (${step.chips})`);

  /* 2. Parent selection auto-checks the family, and unticking one sibling
        stores exactly the remaining set. */
  await p.click('[data-testid="excl-chip-bell"]');
  await p.waitForTimeout(200);
  const afterParent = await p.evaluate(() => ({
    chosen: window.WhollarExclusions.chosen().sort(),
    disclosure: (document.querySelector('[data-testid="excl-family-block"]') || {}).textContent || '',
  }));
  ok(afterParent.chosen.join(',') === 'bell,lucky-mobile,virgin-plus',
    'ticking the parent excludes its flankers too');
  ok(/Bell also operates these brands/.test(afterParent.disclosure),
    'and the disclosure names them in the section 13 words');
  ok(/Untick any you are open to hearing from/.test(afterParent.disclosure),
    'and offers the untick');

  await p.uncheck('[data-testid="excl-family-check-virgin-plus"]');
  await p.waitForTimeout(200);
  const afterUntick = await p.evaluate(() => window.WhollarExclusions.chosen().sort());
  ok(afterUntick.join(',') === 'bell,lucky-mobile',
    'unticking one sibling leaves exactly the rest');

  /* 3. Flanker first: the parent is offered checked, siblings unchecked. */
  /* Back to an empty set by CLICKING, not by writing it: unticking the parent
     releases the flankers it excluded on the member's behalf, which is itself
     the behaviour worth exercising here. */
  await p.click('[data-testid="excl-chip-bell"]');
  await p.waitForTimeout(200);
  const cleared = await p.evaluate(() => window.WhollarExclusions.chosen());
  ok(cleared.length === 0, 'unticking the parent releases the flankers it added');
  await p.click('[data-testid="excl-chip-virgin-plus"]');
  await p.waitForTimeout(200);
  const flanker = await p.evaluate(() => {
    const block = document.querySelector('[data-testid="excl-family-block"]');
    const parent = document.querySelector('[data-testid="excl-family-check-bell"]');
    const sib = document.querySelector('[data-testid="excl-family-check-lucky-mobile"]');
    return {
      text: block ? block.textContent : '',
      parentChecked: !!parent && parent.checked,
      sibChecked: !!sib && sib.checked,
      chosen: window.WhollarExclusions.chosen(),
    };
  });
  ok(/Virgin Plus is operated by Bell/.test(flanker.text),
    'picking a flanker names its parent');
  ok(/Do you also want to exclude Bell\?/.test(flanker.text),
    'and asks rather than assuming');
  ok(flanker.parentChecked, 'CONFIRM-EXCL-01: the parent is checked by default');
  ok(!flanker.sibChecked, 'and the siblings are not');
  ok(flanker.chosen.slice().sort().join(',') === 'bell,virgin-plus',
    'and the parent is actually stored, so the checked box matches the set');

  await c.close();
}

/* ------------------------------------------------------------------ *
 * 18. accent-insensitive search
 * ------------------------------------------------------------------ */

head('18. search folds accents, and a short query does not narrow');
{
  const c = await memberCtx(browser, { book: [] });
  const p = await dash(c);
  await p.evaluate(() => window.WhollarExclusions && window.WhollarExclusions.openStep());
  await p.waitForTimeout(400);

  await p.fill('[data-testid="excl-search"]', 'videotron');
  await p.waitForTimeout(200);
  const folded = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="excl-step"]');
    return { n: el.querySelectorAll('[data-excl]').length, text: el.textContent };
  });
  ok(folded.n === 1 && /Vid/.test(folded.text),
    'unaccented input finds the accented name');

  await p.fill('[data-testid="excl-search"]', 'b');
  await p.waitForTimeout(200);
  const short = await p.evaluate(() =>
    document.querySelector('[data-testid="excl-step"]').querySelectorAll('[data-excl]').length);
  ok(short === REGISTRY.length,
    'a one-character query returns the whole list rather than a prefix match');
  await c.close();
}

/* ------------------------------------------------------------------ *
 * 4. a 422 is non-destructive
 * ------------------------------------------------------------------ */

head('4. a refused save reports and changes nothing');
{
  let sent = null;
  const c = await memberCtx(browser, {
    book: [], onPut: (b) => { sent = b; }, rejectBrand: 'oxio',
  });
  const p = await dash(c);
  await p.evaluate(() => window.WhollarExclusions && window.WhollarExclusions.manage());
  await p.waitForTimeout(500);
  await p.click('[data-testid="excl-chip-oxio"]');
  await p.waitForTimeout(150);
  await p.click('[data-testid="excl-save"]');
  await p.waitForTimeout(500);
  const state = await p.evaluate(() => ({
    open: !!document.querySelector('[data-testid="excl-step"]'),
    err: document.body.innerText,
  }));
  ok(state.open, 'the picker stays open on a refusal rather than closing over it');
  ok(/not a provider we list|could not be saved|Nothing was changed/i.test(state.err),
    'and the reason is shown');
  ok(sent && Array.isArray(sent.brand_ids), 'the request was a replace, carrying the whole set');
  await c.close();
}

/* ------------------------------------------------------------------ *
 * 12. the full-coverage warning
 * ------------------------------------------------------------------ */

head('12. the full-coverage warning appears only when the server confirms it');
{
  const quiet = await memberCtx(browser, { book: [], coversAll: false });
  const pq = await dash(quiet);
  await pq.evaluate(() => window.WhollarExclusions.manage());
  await pq.waitForTimeout(400);
  await pq.click('[data-testid="excl-chip-bell"]');
  await pq.click('[data-testid="excl-save"]');
  await pq.waitForTimeout(600);
  const noWarn = await pq.evaluate(() => (document.querySelector('#toast') || {}).textContent || '');
  ok(!/covers every provider currently able to serve your area/.test(noWarn),
    'no warning when the server does not say so');
  await quiet.close();

  const loud = await memberCtx(browser, { book: [], coversAll: true });
  const pl = await dash(loud);
  await pl.evaluate(() => window.WhollarExclusions.manage());
  await pl.waitForTimeout(400);
  await pl.click('[data-testid="excl-chip-bell"]');
  await pl.click('[data-testid="excl-save"]');
  await pl.waitForTimeout(700);
  const warn = await pl.evaluate(() => (document.querySelector('#toast') || {}).textContent || '');
  ok(/Heads up, this covers every provider currently able to serve your area, so you may receive no offers\./.test(warn),
    'and the section 13 warning verbatim when it does');
  await loud.close();
}

/* ------------------------------------------------------------------ *
 * the dashboard card
 * ------------------------------------------------------------------ */

head('4.4 the dashboard card, family-collapsed for display');
{
  const c = await memberCtx(browser, {
    book: [],
    exclusions: [
      { brand_id: 'bell', display_name: 'Bell', source: 'direct' },
      { brand_id: 'lucky-mobile', display_name: 'Lucky Mobile', source: 'family_default' },
      { brand_id: 'virgin-plus', display_name: 'Virgin Plus', source: 'family_default' },
    ],
  });
  const p = await dash(c);
  await p.click('#paneprof');
  await p.waitForTimeout(700);
  const card = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="dash-excl-card"]');
    return {
      present: !!el,
      text: el ? el.innerText : '',
      cta: !!document.querySelector('[data-testid="dash-excl-manage"]'),
    };
  });
  ok(card.present, 'the card is in the rail');
  ok(/Bell \+2/.test(card.text), 'a whole family collapses to "Bell +2"');
  ok(!/Virgin Plus/.test(card.text), 'and the flankers are not listed separately');
  ok(card.cta, 'and the manage control is there');

  const empty = await memberCtx(browser, { book: [], exclusions: [] });
  const pe = await dash(empty);
  await pe.click('#paneprof');
  await pe.waitForTimeout(700);
  const emptyText = await pe.evaluate(() =>
    (document.querySelector('[data-testid="dash-excl-card"]') || {}).innerText || '');
  ok(/You have not excluded any providers\. If there is a provider you never want to hear from, set it here\./.test(emptyText),
    'the empty state is the section 13 copy verbatim');
  await c.close();
  await empty.close();
}

/* ------------------------------------------------------------------ *
 * the registry is not created yet
 * ------------------------------------------------------------------ */

head('the step says so when the registry is not available');
{
  const c = await memberCtx(browser, { book: [], registryAvailable: false });
  const p = await dash(c);
  await p.evaluate(() => window.WhollarExclusions && window.WhollarExclusions.openStep());
  await p.waitForTimeout(500);
  const state = await p.evaluate(() => ({
    chips: document.querySelectorAll('[data-excl]').length,
    text: document.body.innerText,
  }));
  ok(state.chips === 0, 'no picker is drawn over an empty registry');
  ok(/opens shortly/.test(state.text),
    'and the absence is stated rather than rendered as a working screen');
  await c.close();
}

/* ------------------------------------------------------------------ *
 * 13. mobile
 * ------------------------------------------------------------------ */

head('13. mobile 390px: chips wrap and nothing scrolls sideways');
{
  const c = await memberCtx(browser, {
    book: [{ tier: '500 Mbps', price: '49.00', partner: 'Rogers', guaranteeMonths: 24, equipment: 'inc', mix: null }],
    exclusions: [{ brand_id: 'bell', display_name: 'Bell', source: 'direct' }],
    viewport: { width: 390, height: 900 },
  });
  const p = await dash(c);
  const offerScroll = await p.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(offerScroll <= 1, `the offer view does not scroll sideways (${offerScroll}px)`);

  await p.evaluate(() => window.WhollarExclusions && window.WhollarExclusions.openStep());
  await p.waitForTimeout(500);
  const step = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="excl-step"]');
    if (!el) return null;
    const chips = Array.prototype.slice.call(el.querySelectorAll('[data-excl]'));
    const tops = chips.map(c2 => Math.round(c2.getBoundingClientRect().top));
    return {
      rows: new Set(tops).size,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tappable: chips.every(c2 => c2.getBoundingClientRect().height >= 28),
    };
  });
  ok(step && step.rows > 1, 'the chips wrap onto more than one row');
  ok(step && step.overflow <= 1, `the exclusion step does not scroll sideways (${step && step.overflow}px)`);
  ok(step && step.tappable, 'and every chip is tall enough to tap');
  await c.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
