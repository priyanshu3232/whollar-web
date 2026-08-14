/* One click handler, one change handler, one input handler, one registry.
 *
 * WHY THIS EXISTS. The prototype registered eight separate document-level
 * click listeners across its override layers, and by v10 they had begun to
 * collide: a capture-phase handler called stopPropagation specifically to stop
 * the v6 handler it had replaced from also firing. That is not a style
 * problem. It means the behaviour of a click depended on the order the layers
 * happened to be pasted in, and nothing in the file said so.
 *
 * Here there is exactly one listener per event type. Handlers are looked up by
 * data-action, so adding a control cannot change what an existing one does,
 * and every action in the console can be enumerated.
 *
 *   <button data-action="coverage:save" data-region="north-york">
 *
 * The handler receives (element, event) and reads its own data attributes.
 */

var handlers = { click: {}, change: {}, input: {}, submit: {} };
var mounted = false;

/**
 * Register a handler. Re-registering the same name is a programming error, not
 * an override: two modules claiming one action is the bug the prototype had.
 */
export function on(type, name, fn) {
  if (!handlers[type]) throw new Error('actions: no such event type "' + type + '"');
  if (handlers[type][name]) throw new Error('actions: "' + name + '" is already registered for ' + type);
  handlers[type][name] = fn;
}

/** Every registered action, for the QA harness and for a quick audit. */
export function registered() {
  var out = {};
  Object.keys(handlers).forEach(function (t) { out[t] = Object.keys(handlers[t]).sort(); });
  return out;
}

function dispatch(type, e) {
  var el = e.target.closest ? e.target.closest('[data-action]') : null;
  if (!el) return;
  var name = el.getAttribute('data-action');
  var fn = handlers[type][name];
  if (!fn) return;
  if (type === 'submit') e.preventDefault();
  try {
    fn(el, e);
  } catch (err) {
    /* A handler that throws must not take the console down with it. */
    if (typeof console !== 'undefined' && console.error) console.error('[whollar] action "' + name + '" failed:', err);
  }
}

export function mount() {
  if (mounted) return;
  mounted = true;
  document.addEventListener('click', function (e) { dispatch('click', e); });
  document.addEventListener('change', function (e) { dispatch('change', e); });
  document.addEventListener('input', function (e) { dispatch('input', e); });
  document.addEventListener('submit', function (e) { dispatch('submit', e); });

  /* Enter on a role="button" element. Native buttons already do this; the
     agenda rows and desk cohort rows are divs with tabindex, and a keyboard
     user must be able to open them. */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var el = e.target.closest ? e.target.closest('[data-action][role="button"]') : null;
    if (!el) return;
    e.preventDefault();
    dispatch('click', e);
  });
}
