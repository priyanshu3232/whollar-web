/* The modal host, with the focus handling the prototype lacked.
 *
 * §9.1 G8 asks for Escape, backdrop click, [data-mclose], and a body scroll
 * lock, all of which the prototype had, plus a focus trap and focus return,
 * which it did not. A dialog a keyboard user can tab out of, behind an overlay
 * they cannot see past, is a trap in the other direction.
 */

var lastFocus = null;
var mounted = false;

var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function open(html) {
  var m = document.getElementById('modal');
  var body = document.getElementById('mbody');
  if (!m || !body) return;
  lastFocus = document.activeElement;
  body.innerHTML = html;
  m.hidden = false;
  document.body.style.overflow = 'hidden';
  var first = m.querySelector(FOCUSABLE);
  if (first) first.focus();
}

export function close() {
  var m = document.getElementById('modal');
  if (!m || m.hidden) return;
  m.hidden = true;
  document.body.style.overflow = '';
  /* Return focus to whatever opened it, or a keyboard user lands back at the
     top of the document with no idea where they were. */
  if (lastFocus && lastFocus.focus) lastFocus.focus();
  lastFocus = null;
}

export function isOpen() {
  var m = document.getElementById('modal');
  return !!m && !m.hidden;
}

export function mount() {
  if (mounted) return;
  mounted = true;

  document.addEventListener('click', function (e) {
    var m = document.getElementById('modal');
    if (!m || m.hidden) return;
    if (e.target === m || (e.target.closest && e.target.closest('[data-mclose]'))) close();
  });

  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;

    /* The trap. Without it, tabbing past the last control lands on the page
       behind the overlay, which is unreachable by mouse and invisible. */
    var m = document.getElementById('modal');
    var items = Array.prototype.slice.call(m.querySelectorAll(FOCUSABLE))
      .filter(function (el) { return el.offsetParent !== null; });
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
