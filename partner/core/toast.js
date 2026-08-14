/* One toast at a time, 2.4 seconds, replacing the previous.
 *
 * Not promoted into whollar-core.js: core loads on all 40 footer-registered
 * pages including the marketing site, and the bar for adding weight there is a
 * second calling page. This has one.
 */

var timer = null;

export function toast(msg) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(function () { el.classList.remove('show'); }, 2400);
}

/**
 * Show a server error verbatim.
 *
 * lib/errors.js composes its messages on the explicit assumption that pages do
 * not rewrite them: a 403 there says "still under review", which is the real
 * answer and better than any guess made here. Only a missing message gets a
 * substitute.
 */
export function failed(err) {
  toast((err && err.message) || 'That did not work. Try again.');
}
