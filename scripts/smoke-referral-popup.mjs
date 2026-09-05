#!/usr/bin/env node
/* The waitlist popup, run for real against a DOM stub.
 *
 *   node scripts/smoke-referral-popup.mjs
 *
 * WHY A STUB AND NOT JSDOM. Every gate in this repo runs without an install,
 * which is the property that makes them get run. jsdom is 60 packages, and
 * what it would buy here is layout and CSS cascade, neither of which this
 * widget depends on: it is a state machine over four elements, a cookie and a
 * fetch. So the stub below implements exactly the DOM this file touches, and
 * anything it reaches for that the stub lacks throws, which is itself the
 * test: an unimplemented property is a line of the widget nobody thought
 * about.
 *
 * What is asserted, and why each one has a way of breaking:
 *
 *   1. It boots on an ordinary page and arms, without opening at once.
 *   2. It stays silent on /join, where the full form already is.
 *   3. It stays silent when the cookie says joined or off.
 *   4. Step 1 renders step 1 copy; the referral strip appears only with ?ref=.
 *   5. A bad address is refused in the browser and never reaches the network.
 *   6. A good one posts the shape the route parses, and only then does the
 *      card say "You are in" and only then is the joined cookie written.
 *   7. A failed post leaves the card asking, with the button usable again and
 *      no joined cookie, which is the rule that stops the popup thanking
 *      somebody for a submission the store dropped.
 *   8. Closing step 1 writes step2 and the next open is the second ask.
 *   9. Closing step 2 writes off.
 *  10. The launcher keeps to the middle of the page: away on the first screen
 *      where the hero's own join button is, away on the last where the join
 *      section and the footer are, there for everything in between.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'js', 'referral-popup.js'), 'utf8');

let failures = 0;
const ok = (cond, what) => {
  if (cond) console.log(`  ok    ${what}`);
  else { console.error(`  FAIL  ${what}`); failures++; }
};

/* ------------------------------------------------------------------ *
 * The stub. Only what the widget touches.
 * ------------------------------------------------------------------ */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.style = {};
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.id = '';
  }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const l = this.listeners[t] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatch(t, ev) { for (const fn of (this.listeners[t] || []).slice()) fn(ev || { type: t, preventDefault() {}, stopPropagation() {} }); }
  focus() { doc.activeElement = this; }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children.length = 0; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  /* Enough of a selector engine for `.class`, `tag.class` and `[attr="v"]`. */
  matches(sel) {
    const m = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (m) return m[2] === undefined ? this.getAttribute(m[1]) !== null : this.getAttribute(m[1]) === m[2];
    const parts = sel.split(' ');
    const last = parts[parts.length - 1];
    const [tag, ...classes] = last.split('.');
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    return classes.every(c => String(this.className).split(/\s+/).includes(c));
  }
  querySelector(sel) {
    for (const c of this.children) {
      if (c.matches(sel)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  /* The widget only ever asks for the FIRST match of the compound selectors it
     uses, so a descendant search that checks the last simple selector against
     any node under this one is the same answer for every call it makes. */
  find(pred) {
    for (const c of this.children) {
      if (pred(c)) return c;
      const deep = c.find(pred);
      if (deep) return deep;
    }
    return null;
  }
}

let doc, win, html, cookieJar, fetchCalls, fetchImpl, timers, now;

/* What the server answers with when it has a code for this address. The card
   must never assemble a link itself, so the test hands it one and then asserts
   that exact string came out the other side. */
const SHARE_URL = 'https://www.whollar.ca/join?ref=WS7KMQT4WB';

function reset({ path = '/', search = '', cookie = '', host = 'www.whollar.ca' } = {}) {
  cookieJar = cookie;
  fetchCalls = [];
  timers = [];
  now = 0;
  fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: '1', shareCode: 'WS7KMQT4WB', shareUrl: SHARE_URL }) });

  const head = new El('head');
  const body = new El('body');
  html = new El('html');

  doc = {
    readyState: 'complete',
    head,
    body,
    documentElement: html,
    activeElement: null,
    listeners: {},
    createElement: (t) => new El(t),
    createTextNode: (t) => { const n = new El('#text'); n.textContent = t; return n; },
    getElementById: (id) => body.find(n => n.id === id) || head.find(n => n.id === id),
    querySelector: (sel) => head.find(n => n.matches(sel)) || body.find(n => n.matches(sel)),
    addEventListener: (t, fn) => { (doc.listeners[t] = doc.listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => {
      const l = doc.listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    },
    dispatch: (t, ev) => { for (const fn of (doc.listeners[t] || []).slice()) fn(ev); },
    get cookie() { return cookieJar; },
    set cookie(v) {
      const [pair] = String(v).split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      cookieJar = cookieJar.split(';').map(s => s.trim()).filter(s => s && s.split('=')[0].trim() !== name)
        .concat(pair.trim()).join('; ');
    }
  };
  html.appendChild(head); html.appendChild(body);

  win = {
    document: doc,
    location: { hostname: host, pathname: path, search, protocol: 'https:' },
    pageYOffset: 0,
    innerHeight: 800,
    listeners: {},
    URLSearchParams,
    matchMedia: () => ({ matches: false }),
    fetch: (...a) => { fetchCalls.push(a); return fetchImpl(...a); },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    addEventListener: (t, fn) => { (win.listeners[t] = win.listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => {
      const l = win.listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    },
    dispatch: (t, ev) => { for (const fn of (win.listeners[t] || []).slice()) fn(ev); }
  };
  html.scrollHeight = 4000;
  html.scrollTop = 0;

  /* Run the widget exactly as a browser would: one classic script, two
     globals in scope, nothing else reachable. */
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'URLSearchParams', 'fetch', SRC);
  run(win, doc, URLSearchParams, win.fetch);
  return win.WHOLLAR_CTA;
}

const tick = (ms) => {
  now += ms;
  for (const t of timers.slice()) {
    if (t.fn && t.at <= now) { const fn = t.fn; t.fn = null; fn(); }
  }
};
const card = () => doc.body.find(n => n.id === 'whl-cta');
const launchBtn = () => doc.body.find(n => n.id === 'whl-cta-launch');
const textOf = () => { const c = card(); return c ? c.textContent : ''; };
const flush = () => new Promise(r => setImmediate(r));

/* The two doors, as a reader uses them. */
/* 3200 is scrollHeight 4000 less innerHeight 800, so this is the bottom. */
const scrollToFoot = () => { win.pageYOffset = 3200; win.dispatch('scroll', {}); };
/* 1600 is halfway, which is the band the launcher lives in: a screen clear of
   the top and a screen clear of the 3200 bottom. */
const scrollToMiddle = () => { win.pageYOffset = 1600; win.dispatch('scroll', {}); };
/* A reader presses the button where the button is, so every press in this file
   goes through the middle of the page and the checks that only care what the
   card does next do not each have to say so. */
const press = () => { scrollToMiddle(); launchBtn().dispatch('click', {}); };

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */
console.log('waitlist popup');

/* 1: the card no longer arrives on its own, and the button is how it does */
reset();
ok(card() === null, 'nothing is on the page on load');
ok(launchBtn() !== null, 'the launcher is');
ok(launchBtn().hidden === true, 'and it keeps off the first screen, where the hero already asks');
ok(launchBtn().textContent === 'Hold my spot', 'labelled Hold my spot');
scrollToMiddle();
ok(launchBtn().hidden === false, 'it arrives once the hero has scrolled away');
/* The other end of the band is checked further down, on the reader whose
   cookie says `off`. Reaching the foot here would fire the second ask, and
   what is being checked next is that nothing opens on its own. */
tick(600000);
ok(card() === null, 'ten minutes pass and no card opens by itself');
press();
ok(card() !== null, 'pressing the launcher opens the card');
ok(textOf().includes('Join the waitlist'), 'on step 1, the community ask');
ok(launchBtn().hidden === true, 'and the launcher gets out of its way');
ok(!textOf().includes('A friend sent you this link.'), 'no referral strip without ?ref=');

/* 2 */
reset({ path: '/join' });
tick(60000);
ok(card() === null && launchBtn() === null, 'silent on /join, where the full form already is');
reset({ path: '/join-welcome' });
tick(60000);
ok(card() === null && launchBtn() === null, 'silent on /join-welcome too, matched as a prefix');

/* 3: the cookie governs the automatic ask, and only `joined` takes the button */
reset({ cookie: 'whl_cta=joined' });
scrollToFoot();
ok(card() === null, 'silent once somebody has joined');
ok(launchBtn().hidden === true, 'and the launcher is put away for them');
reset({ cookie: 'whl_cta=off' });
scrollToFoot();
ok(card() === null, 'the second ask stays shut for the seven days after a close');
ok(launchBtn().hidden === true, 'and the foot is no more the button\'s place for them than for anybody');
scrollToMiddle();
ok(launchBtn().hidden === false, 'but the button is still there for anybody who wants it');
press();
ok(card() !== null, 'and it still works: `off` silenced the ask, not the door');

/* 4 */
reset({ search: '?ref=K7MQT4WB' });
press();
ok(textOf().includes('A friend sent you this link.'), 'the referral strip appears with ?ref=');
reset({ search: '?ref=x' });
press();
ok(!textOf().includes('A friend sent you this link.'), 'junk in ?ref= shows no strip');

/* 5: the foot of the page is the second ask, and it carries the host's copy */
reset({ host: 'tires.whollar.ca' });
win.pageYOffset = 1000; /* 1000 / 3200 is under 90 percent */
win.dispatch('scroll', {});
ok(card() === null, 'a third of the way down asks nothing');
scrollToFoot();
ok(card() !== null, 'reaching the foot of the page opens the second ask');
ok(textOf().includes('Do not need winter tires right now?'), 'and on tires it is the tire question');
reset({ host: 'internet.whollar.ca' });
scrollToFoot();
ok(textOf().includes('Do not need to switch internet right now?'), 'on internet it is the internet one');
reset();
scrollToFoot();
ok(textOf().includes('Nothing you need right now?'), 'and on the umbrella it names no product');

/* the launcher always asks the joining question, whatever the foot did */
reset();
scrollToFoot();
card().find(n => n.className === 'whl-close').dispatch('click', {});
press();
ok(textOf().includes('Join the waitlist'), 'the launcher asks step 1 even after step 2 was shown');

/* a page with nothing to scroll has no foot to reach */
reset();
html.scrollHeight = 700; /* shorter than innerHeight */
win.pageYOffset = 0;
win.dispatch('scroll', {});
ok(card() === null, 'a page that does not scroll never opens the second ask');

/* 6 */
reset();
press();
let input = card().find(n => n.tagName === 'INPUT');
let form = card().find(n => n.tagName === 'FORM');
input.value = 'a@b';
form.dispatch('submit', { preventDefault() {} });
await flush();
ok(fetchCalls.length === 0, 'an incomplete address never reaches the network');
ok(card().find(n => n.className === 'whl-err').textContent.length > 0, 'and it says what to change');

/* 7 */
input.value = '  Someone@Example.COM  ';
form.dispatch('submit', { preventDefault() {} });
await flush();
ok(fetchCalls.length === 1, 'a good address posts once');
const [url, opts] = fetchCalls[0];
ok(url.endsWith('/waitlist-email'), 'to /waitlist-email');
/* The Catalyst gateway answers OPTIONS itself and puts CORS headers on only
   one origin, so a preflighted request is a request the browser never sends.
   A Content-Type header here is what makes it preflighted. */
ok(!opts.headers, 'with no Content-Type header, so the request is never preflighted');
const sent = JSON.parse(opts.body);
ok(sent.email === 'someone@example.com', 'lowercased and trimmed on the way out');
ok(sent.product === 'home' && sent.ctaStep === 1, 'carrying the product and which ask converted');
ok(typeof sent.consentText === 'string' && sent.consentText.length > 20, 'and the sentence agreed to');
ok(card().getAttribute('data-state') === 'done', 'the card turns over only after the post came back');
ok(textOf().includes('Welcome to Whollar.'), 'and welcomes them');
ok(/whl_cta=joined/.test(doc.cookie), 'the joined cookie is written on success');

/* 8: the share sheet, built from the server's answer and nothing else */
ok(textOf().includes(SHARE_URL), 'the link the server minted is on the card, in full');
const linkEl = card().find(n => n.className === 'whl-link');
ok(linkEl && linkEl.href === SHARE_URL, 'and it is a real link, not just text');
const chips = [];
(function walk(n) { for (const c of n.children) { if (c.className === 'whl-chip') chips.push(c); walk(c); } })(card());
const labels = chips.map(c => c.textContent);
ok(labels.includes('WhatsApp') && labels.includes('Email') && labels.includes('Text'),
  'WhatsApp, Email and Text are offered');
ok(chips.every(c => c.tagName === 'A' && c.href), 'all three are plain links, so they need no browser API');
ok(chips.find(c => c.textContent === 'WhatsApp').href.includes(encodeURIComponent(SHARE_URL)),
  'and each one carries the link');
/* There is no navigator in this stub, exactly as there is none in a mail
   client preview or an old browser. Copy and native share must simply not be
   offered rather than throwing on the way past. */
ok(!labels.includes('Copy link'), 'no copy button where there is no clipboard to copy to');

/* 9: a server that could not mint one still confirms */
reset();
fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: '1' }) });
press();
input = card().find(n => n.tagName === 'INPUT');
form = card().find(n => n.tagName === 'FORM');
input.value = 'someone@example.com';
form.dispatch('submit', { preventDefault() {} });
await flush();
ok(card().getAttribute('data-state') === 'done', 'a response with no share code still turns the card over');
ok(textOf().includes('Welcome to Whollar.'), 'and still welcomes them');
ok(!card().find(n => n.className === 'whl-link'), 'with no link on it');
ok(!textOf().includes('share link of your own'),
  'and no promise that finishing an account earns one, which is no longer how it works');

/* 10 */
reset();
fetchImpl = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
press();
input = card().find(n => n.tagName === 'INPUT');
form = card().find(n => n.tagName === 'FORM');
input.value = 'someone@example.com';
form.dispatch('submit', { preventDefault() {} });
await flush(); await flush();
ok(card().getAttribute('data-state') === 'ask', 'a dropped submission does not thank anybody');
ok(!/whl_cta=joined/.test(doc.cookie), 'and writes no joined cookie');
const btn = card().find(n => n.tagName === 'BUTTON' && n.className === 'whl-btn');
ok(btn.disabled === false && btn.textContent === 'Hold my spot', 'the button is usable again');

/* 11: closing the card after joining is a finished conversation */
reset();
press();
input = card().find(n => n.tagName === 'INPUT');
form = card().find(n => n.tagName === 'FORM');
input.value = 'someone@example.com';
form.dispatch('submit', { preventDefault() {} });
await flush();
ok(/whl_cta=joined/.test(doc.cookie), 'joined, before the card is closed');
card().find(n => n.className === 'whl-close').dispatch('click', {});
ok(/whl_cta=joined/.test(doc.cookie), 'closing the done card leaves the joined cookie alone');
ok(!/whl_cta=step2/.test(doc.cookie), 'and does not re-arm the second ask');
ok(launchBtn().hidden === true, 'and the launcher stays away from somebody who has joined');
scrollToFoot();
ok(card() === null, 'so reaching the foot does not ask them again');

/* 12: a response that arrives after the card is gone must not reach for it */
reset();
press();
let release;
fetchImpl = () => new Promise(r => { release = () => r({ ok: true, json: () => Promise.resolve({ ok: true }) }); });
input = card().find(n => n.tagName === 'INPUT');
form = card().find(n => n.tagName === 'FORM');
input.value = 'someone@example.com';
form.dispatch('submit', { preventDefault() {} });
card().find(n => n.className === 'whl-close').dispatch('click', {});
ok(card() === null, 'the card is closed while the post is still in flight');
release();
await flush(); await flush();
ok(/whl_cta=joined/.test(doc.cookie), 'the submission still counts as answered');

/* 13: the two closes mean different things */
reset();
press();
card().find(n => n.className === 'whl-close').dispatch('click', {});
ok(card() === null, 'closing step 1 takes the card off the page');
ok(/whl_cta=step2/.test(doc.cookie), 'and remembers that step 2 is next');
ok(launchBtn().hidden === false, 'the launcher comes back');
tick(600000);
ok(card() === null, 'and no clock reopens anything, which is what the thirty second timer used to do');
scrollToFoot();
ok(card() !== null, 'the foot of the page is what opens the second ask now');
ok(textOf().includes('Nothing you need right now?'), 'and it is the second ask');
card().find(n => n.className === 'whl-close').dispatch('click', {});
ok(/whl_cta=off/.test(doc.cookie), 'closing step 2 ends the sequence for a week');
win.pageYOffset = 0; win.dispatch('scroll', {});
scrollToFoot();
ok(card() === null, 'and the foot asks nothing more');

/* 14: the foot asks once, however much somebody scrolls */
reset();
scrollToFoot();
card().find(n => n.className === 'whl-close').dispatch('click', {});
win.pageYOffset = 0; win.dispatch('scroll', {});
scrollToFoot();
ok(card() === null, 'reaching the foot twice in one page view asks once');
ok(doc.body.children.filter(n => n.id === 'whl-cta').length === 0, 'and leaves nothing behind');

console.log(failures ? `\n${failures} failed` : `\nall checks passed`);
process.exit(failures ? 1 : 0);
