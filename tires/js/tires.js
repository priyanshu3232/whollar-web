/* The winter tire landing page's only behaviour: the scroll reveal.
 *
 * The canvas in WhollarTireLandingPage/ carried far more than this, but all of
 * it drove the signup flow and the four tool modals, which live at /join on
 * this host now (see scripts/port-tires.mjs). What is left is sixteen elements
 * carrying data-reveal="<delay in ms>", written by the port where the canvas
 * had its reveal directive.
 *
 * The hidden state is set HERE, never in the stylesheet. A CSS rule that
 * starts an element at opacity 0 hides it permanently for a reader whose
 * JavaScript did not run, and for a crawler that renders but does not scroll.
 * Setting it from script means no-JS shows the finished page immediately,
 * which is the correct fallback for a page whose content is the product.
 */
(function () {
  'use strict';

  /* ---- where an in-page link stops ----
   * The header is sticky, so a link to #join lands with the section title
   * behind the bar unless scroll-padding-top accounts for it. The bar is not a
   * constant height: it is taller once the nav wraps on a narrow screen. Measure
   * it and hand the number to CSS, which carries a 92px fallback for the
   * no-JS case. */

  var head = document.querySelector('header');
  if (head) {
    var syncHead = function () {
      var h = Math.round(head.getBoundingClientRect().height) + 16;
      document.documentElement.style.setProperty('--wh-head', h + 'px');
    };
    syncHead();
    window.addEventListener('resize', syncHead);
    if (window.ResizeObserver) new window.ResizeObserver(syncHead).observe(head);
  }

  /* ---- how fast an in-page link travels ----
   * CSS scroll-behavior:smooth hands the duration to the browser, and Chrome
   * picks something brisk enough that the sections in between are a blur. The
   * owner wants it slower, so the travel is driven here instead: a fixed floor
   * so a short hop is still a glide, scaled with distance, and capped so the
   * longest jump on the page does not become a wait.
   *
   * The CSS rule stays as the fallback for anything this does not intercept,
   * including a page opened on a #hash. It never fights this handler, because
   * an intercepted click has its default prevented. */
  var TRAVEL_MIN = 900, TRAVEL_MAX = 1900, TRAVEL_PER_PX = 0.85;

  function easeInOut(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }

  function headOffset(){
    var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wh-head'));
    return isNaN(v) ? 92 : v;
  }

  function glideTo(target){
    var start = window.pageYOffset;
    var end = Math.max(0, Math.min(
      target.getBoundingClientRect().top + start - headOffset(),
      document.documentElement.scrollHeight - window.innerHeight));
    var dist = Math.abs(end - start);
    if (dist < 2) return;
    var ms = Math.min(TRAVEL_MAX, Math.max(TRAVEL_MIN, dist * TRAVEL_PER_PX));
    var t0 = null, cancelled = false;

    /* The CSS rule has to be off while this runs. With scroll-behavior:smooth
       in force, every scrollTo below starts a browser animation of its own
       that the next frame interrupts, and the page crawls a couple of pixels
       and stops. Restored in done(), so anything this handler does not
       intercept still gets the CSS behaviour. */
    var root = document.documentElement;
    var hadBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';

    /* Any deliberate scroll of their own wins immediately. Without this the
       page fights the wheel for up to two seconds, which feels broken. */
    var stop = function(){ cancelled = true; };
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('keydown', stop);
    var done = function(){
      root.style.scrollBehavior = hadBehavior;
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    };

    (function step(now){
      if (cancelled) return done();
      if (t0 === null) t0 = now;
      var p = Math.min(1, (now - t0) / ms);
      window.scrollTo(0, start + (end - start) * easeInOut(p));
      if (p < 1) window.requestAnimationFrame(step); else done();
    })(performance.now());
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a || a.getAttribute('href') === '#') return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    var target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target) return;
    /* Reduced motion keeps the instant jump, which is what the CSS rule
       already does for those readers. */
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    e.preventDefault();
    glideTo(target);
    if (window.history && history.replaceState) history.replaceState(null, '', a.getAttribute('href'));
  });

  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if (!nodes.length) return;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* No observer, or the reader asked for less motion: leave everything as
     drawn. The reveal is decoration, and the page reads the same without it. */
  if (reduced || !('IntersectionObserver' in window)) return;

  function paint(el) {
    el.style.opacity = '1';
    el.style.transform = 'none';
  }

  nodes.forEach(function (el) {
    el.style.opacity = '0';
    el.style.transform = 'translateY(18px)';
    el.style.transition = 'opacity 620ms cubic-bezier(.22,.9,.3,1), transform 620ms cubic-bezier(.22,.9,.3,1)';
    el.style.willChange = 'opacity, transform';
  });

  var seen = new window.IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      seen.unobserve(el);
      var delay = parseInt(el.getAttribute('data-reveal'), 10);
      if (!(delay > 0)) { paint(el); return; }
      window.setTimeout(function () { paint(el); }, delay);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

  nodes.forEach(function (el) { seen.observe(el); });

  /* Anything already on screen at load reveals on its own timer rather than
     waiting for a scroll that may never come on a short viewport. */
  window.setTimeout(function () {
    nodes.forEach(function (el) {
      var box = el.getBoundingClientRect();
      if (box.top < window.innerHeight && box.bottom > 0) {
        seen.unobserve(el);
        var delay = parseInt(el.getAttribute('data-reveal'), 10) || 0;
        window.setTimeout(function () { paint(el); }, delay);
      }
    });
  }, 60);
})();
