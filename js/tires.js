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
