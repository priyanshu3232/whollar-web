/* Hash routing over the eleven views.
 *
 * Hash rather than path, deliberately. The site is static HTML on Vercel with
 * cleanUrls, so /partner/desk would need a rewrite per view and would 404 on a
 * hard refresh the moment someone added a twelfth. A hash is deep-linkable,
 * survives reload, and costs nothing.
 */

export var VIEWS = ['overview', 'desk', 'plan', 'bids', 'billing', 'coverage',
  'delivery', 'perf', 'contracts', 'pending', 'account'];

var listeners = [];

function mobile() { return window.innerWidth <= 940; }

export function current() {
  var h = String(location.hash || '').replace(/^#/, '');
  return VIEWS.indexOf(h) >= 0 ? h : 'overview';
}

export function go(v) {
  if (VIEWS.indexOf(v) < 0) return;
  paint(v);
  /* replaceState, not pushState, on the first paint: a bare /partner in
     history that renders nothing is worse than no entry at all. */
  try { history.replaceState({ v: v }, '', '#' + v); } catch (e) { /* file:// */ }
  listeners.forEach(function (fn) { fn(v); });
}

function paint(v) {
  Array.prototype.forEach.call(document.querySelectorAll('.view'), function (x) {
    x.classList.toggle('on', x.getAttribute('data-v') === v);
  });
  Array.prototype.forEach.call(document.querySelectorAll('#pnav button'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-view') === v);
  });
  var prof = document.getElementById('paneprof');
  if (prof) prof.classList.toggle('on', v === 'account');
  var app = document.getElementById('app');
  if (app && mobile()) app.classList.remove('paneopen');
  window.scrollTo(0, 0);
}

/** Called when the view changes, so a view can load its own detail on open. */
export function onChange(fn) { listeners.push(fn); }

export function mount() {
  window.addEventListener('hashchange', function () { go(current()); });
}

/* ------------------------------------------------------------------ *
 * the gated frame
 *
 * Under review the console is one centred card: no nav pane, no search. The
 * partner is not being kept out of a working console, there is no working
 * console for them yet, and pretending otherwise is what makes an empty desk
 * read as a broken one.
 * ------------------------------------------------------------------ */

export function setGated(on) {
  document.body.classList.toggle('gated', !!on);
}
