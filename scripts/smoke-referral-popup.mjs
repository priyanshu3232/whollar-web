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

let doc, win, cookieJar, fetchCalls, fetchImpl, timers, now;

function reset({ path = '/', search = '', cookie = '', host = 'www.whollar.ca' } = {}) {
  cookieJar = cookie;
  fetchCalls = [];
  timers = [];
  now = 0;
  fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: '1' }) });

  const head = new El('head');
  const body = new El('body');
  const html = new El('html');

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
const textOf = () => { const c = card(); return c ? c.textContent : ''; };
const flush = () => new Promise(r => setImmediate(r));

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */
console.log('waitlist popup');

/* 1 */
reset();
ok(card() === null, 'nothing is on the page before a trigger fires');
tick(8000);
ok(card() !== null, 'the eight second timer opens it');
ok(textOf().includes('Join the waitlist'), 'step 1 is the community ask');
ok(!textOf().includes('A friend sent you this link.'), 'no referral strip without ?ref=');

/* 2 */
reset({ path: '/join' });
tick(60000);
ok(card() === null, 'silent on /join, where the full form already is');
reset({ path: '/join-welcome' });
tick(60000);
ok(card() === null, 'silent on /join-welcome too, matched as a prefix');

/* 3 */
reset({ cookie: 'whl_cta=joined' });
tick(60000);
ok(card() === null, 'silent once somebody has joined');
reset({ cookie: 'whl_cta=off' });
tick(60000);
ok(card() === null, 'silent for the seven days after a second close');

/* 4 */
reset({ search: '?ref=K7MQT4WB' });
tick(8000);
ok(textOf().includes('A friend sent you this link.'), 'the referral strip appears with ?ref=');
reset({ search: '?ref=x' });
tick(8000);
ok(!textOf().includes('A friend sent you this link.'), 'junk in ?ref= shows no strip');

/* the second ask carries the host's own copy */
reset({ host: 'tires.whollar.ca', cookie: 'whl_cta=step2' });
tick(8000);
ok(textOf().includes('Not buying winter tires right now?'), 'step 2 on the tire host is the tire question');
reset({ host: 'internet.whollar.ca', cookie: 'whl_cta=step2' });
tick(8000);
ok(textOf().includes('Not switching internet right now?'), 'step 2 on the internet host is the internet question');

/* 5 */
reset();
tick(8000);
let input = card().find(n => n.tagName === 'INPUT');
let form = card().find(n => n.tagName === 'FORM');
input.value = 'a@b';
form.dispatch('submit', { preventDefault() {} });
await flush();
ok(fetchCalls.length === 0, 'an incomplete address never reaches the network');
ok(card().find(n => n.className === 'whl-err').textContent.length > 0, 'and it says what to change');

/* 6 */
input.value = '  Someone@Example.COM  ';
form.dispatch('submit', { preventDefault() {} });
await flush();
ok(fetchCalls.length === 1, 'a good address posts once');
const [url, opts] = fetchCalls[0];
ok(url.endsWith('/waitlist-email'), 'to /waitlist-email');
const sent = JSON.parse(opts.body);
ok(sent.email === 'someone@example.com', 'lowercased and trimmed on the way out');
ok(sent.product === 'home' && sent.ctaStep === 1, 'carrying the product and which ask converted');
ok(typeof sent.consentText === 'string' && sent.consentText.length > 20, 'and the sentence agreed to');
ok(card().getAttribute('data-state') === 'done', 'the card turns over only after the post came back');
ok(textOf().includes('You are in.'), 'and says so');
ok(/whl_cta=joined/.test(doc.cookie), 'the joined cookie is written on success');

/* 7 */
reset();
tick(8000);
fetchImpl = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
input = card().find(n => n.tagName === 'INPUT');
form = card().find(n => n.tagName === 'FORM');
input.value = 'someone@example.com';
form.dispatch('submit', { preventDefault() {} });
await flush(); await flush();
ok(card().getAttribute('data-state') === 'ask', 'a dropped submission does not thank anybody');
ok(!/whl_cta=joined/.test(doc.cookie), 'and writes no joined cookie');
const btn = card().find(n => n.tagName === 'BUTTON' && n.className === 'whl-btn');
ok(btn.disabled === false && btn.textContent === 'Hold my spot', 'the button is usable again');

/* closing the card after joining is a finished conversation, not a refusal */
reset();
tick(8000);
input = card().find(n => n.tagName === 'INPUT');
form = card().find(n => n.tagName === 'FORM');
input.value = 'someone@example.com';
form.dispatch('submit', { preventDefault() {} });
await flush();
ok(/whl_cta=joined/.test(doc.cookie), 'joined, before the card is closed');
card().find(n => n.className === 'whl-close').dispatch('click', {});
ok(/whl_cta=joined/.test(doc.cookie), 'closing the done card leaves the joined cookie alone');
ok(!/whl_cta=step2/.test(doc.cookie), 'and does not re-arm the second ask');
tick(60000);
ok(card() === null, 'so nobody who joined is asked again thirty seconds later');

/* a response that arrives after the card is gone must not reach for it */
reset();
tick(8000);
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

/* 8 and 9 */
reset();
tick(8000);
card().find(n => n.className === 'whl-close').dispatch('click', {});
ok(card() === null, 'closing step 1 takes the card off the page');
ok(/whl_cta=step2/.test(doc.cookie), 'and remembers that step 2 is next');
tick(30000);
ok(card() !== null, 'step 2 opens thirty seconds later');
ok(textOf().includes('Nothing you need right now?'), 'and it is the second ask');
card().find(n => n.className === 'whl-close').dispatch('click', {});
ok(/whl_cta=off/.test(doc.cookie), 'closing step 2 ends the sequence for a week');
tick(120000);
ok(card() === null, 'and nothing opens again');

/* the scroll trigger, on its own */
reset();
win.pageYOffset = 2000; /* 2000 / (4000 - 800) is over 40 percent */
win.dispatch('scroll', {});
ok(card() !== null, 'forty percent scrolled opens it without waiting eight seconds');
tick(60000);
ok(doc.body.children.filter(n => n.id === 'whl-cta').length === 1, 'and the timer does not open a second one');

console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
