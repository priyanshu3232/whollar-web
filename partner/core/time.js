/* One clock for the whole console, offset from the server's.
 *
 * The prototype ran a virtual clock (NOW0, NOWOFF, now(), snap()) that demo
 * buttons could advance. None of it is ported. In the real console every
 * deadline belongs to the server, and the only honest thing a browser can do
 * is measure how far its own clock has drifted and correct for it.
 *
 * WHY EPOCH MILLISECONDS, not the datastore's string. Catalyst returns
 * "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker, and lib/datastore.js
 * documents at length that new Date() on it shifts by the reader's offset.
 * Handing that string to a browser reproduces, in every client, the bug the
 * server already fixed. An integer cannot be misread.
 */

var skew = 0;
var synced = false;

/** Record the gap between the server's clock and this browser's. */
export function sync(serverTime) {
  if (typeof serverTime !== 'number' || !isFinite(serverTime)) return;
  skew = serverTime - Date.now();
  synced = true;
}

/** Now, as the server would report it. */
export function now() { return Date.now() + skew; }

export function isSynced() { return synced; }
export function skewMs() { return skew; }

/** Milliseconds until a server timestamp, never negative. */
export function until(ts) { return Math.max(0, ts - now()); }

export var DAY = 86400000;
export var HOUR = 3600000;

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 14". Rendered in the reader's zone, which for the GTA pilot is the
    cohort's zone. When cohorts open outside America/Toronto this needs the
    campaign's zone passed in, and that is a real change, not a formatting
    tweak: a deadline shown in the wrong zone is a missed auction. */
export function fmtDate(ts) {
  var d = new Date(ts);
  return MONTHS[d.getMonth()] + ' ' + d.getDate();
}

/**
 * "Aug 14" from a datastore stamp, "YYYY-MM-DD HH:MM:SS".
 *
 * Only the calendar date is read, deliberately. That string is UTC with no
 * zone marker, so handing the whole thing to new Date() shifts it by the
 * reader's offset and can move the day, which is the bug the file header is
 * about. Soft dates ("signed up", "member since") are the only callers: a
 * deadline still comes through as an integer and goes through fmtDate.
 */
export function fmtStamp(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return '';
  return MONTHS[+m[2] - 1] + ' ' + +m[3];
}

/** "5 PM", "5:30 PM". */
export function fmtTime(ts) {
  var d = new Date(ts);
  var h = d.getHours(), m = d.getMinutes();
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ' ' + ap;
}

/** "02:14:09". Countdown inside the last 24 hours. */
export function fmtCountdown(ms) {
  if (ms < 0) ms = 0;
  var t = Math.floor(ms / 1000);
  var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(h) + ':' + p(m) + ':' + p(s);
}

/** "in 3 days", "today", "2 days ago". For soft dates only, never a deadline. */
export function relativeDays(ts) {
  var d = Math.round((ts - now()) / DAY);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? 'in ' + d + ' days' : Math.abs(d) + ' days ago';
}

export function sameDay(a, b) {
  var x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/* ------------------------------------------------------------------ *
 * the ticker
 *
 * One interval for every countdown on the page, and it stops itself when
 * nothing is counting. The prototype polled once a second forever and
 * re-rendered the whole console whenever a stage signature changed; that is
 * why its clock buttons worked and also why it burned a render per second.
 * ------------------------------------------------------------------ */

var timer = null;

export function startTicker() {
  if (timer) return;
  if (typeof document === 'undefined') return;
  /* prefers-reduced-motion suppresses the ticker entirely. The countdown is
     decoration on top of a date that is already rendered in full. */
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  timer = setInterval(function () {
    var els = Array.prototype.slice.call(document.querySelectorAll('[data-until]'));
    if (!els.length) { clearInterval(timer); timer = null; return; }
    els.forEach(function (el) {
      el.textContent = fmtCountdown(until(+el.getAttribute('data-until')));
    });
  }, 1000);
}

export function stopTicker() {
  if (timer) { clearInterval(timer); timer = null; }
}
