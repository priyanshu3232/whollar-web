/* Whollar device router — one shared script for every mapped desktop/mobile page.
   Desktop page on a small viewport → its mobile counterpart; mobile page on a
   large viewport → its desktop counterpart. Pages with no mapping entry are
   never redirected — no fallback, no homepage catch-all. location.replace()
   keeps the wrong-device URL out of history so Back never bounces between
   versions.
   INVARIANT: on every page that includes this script, the
   <meta name="viewport" content="width=device-width"...> tag must appear
   BEFORE this include (bundle pages: in the OUTER wrapper head). Without it,
   phones report a ~980px layout viewport here and would misroute. */
(function () {
  'use strict';
  /* Bundled pages re-run head scripts after the template unpacks — never
     initialize twice. */
  if (window.__whlDeviceRouter) return;
  window.__whlDeviceRouter = true;

  var BREAKPOINT = 768; /* ≤768px = mobile (incl. iPad portrait), ≥769px = desktop */

  var PAIRS = [
    ['/',                 '/MobileVersion/consumer-mobile'],
    ['/partners',         '/MobileVersion/provider-mobile'],
    ['/become-a-partner', '/MobileVersion/become-a-partner-mobile'],
    ['/bill-checkup',     '/MobileVersion/bill-checkup-mobile'],
    ['/waitlist',         '/MobileVersion/join-the-first-cohort-mobile'],
    ['/blog',             '/MobileVersion/resources-mobile']
  ];

  /* Blog articles: /blog/<slug> ↔ /MobileVersion/blog/<slug>. Keep this list in
     sync with the SLUGS table in scripts/build-blog.mjs. */
  var BLOG_SLUGS = [
    'overpaying-internet-canada',
    'internet-price-increase-promo-cliff',
    'collective-switching-internet-canada',
    'teksavvy-vs-rogers-same-cable',
    'internet-bill-breakdown-canada',
    'negotiate-internet-bill-canada',
    'internet-retention-offer-win-back',
    'independent-internet-providers-canada',
    'collective-switching-energy-proof',
    'big-three-telecom-canada'
  ];
  for (var s = 0; s < BLOG_SLUGS.length; s++) {
    PAIRS.push(['/blog/' + BLOG_SLUGS[s], '/MobileVersion/blog/' + BLOG_SLUGS[s]]);
  }

  /* Fold prod clean URLs (/bill-checkup), local-dev paths (/bill-checkup.html,
     /waitlist/index.html) and trailing-slash variants onto one table key. */
  function normalize(path) {
    var p = path.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p === '' ? '/' : p.toLowerCase();
  }

  var toMobile = {}, toDesktop = {};
  for (var i = 0; i < PAIRS.length; i++) {
    toMobile[normalize(PAIRS[i][0])] = PAIRS[i][1];
    toDesktop[normalize(PAIRS[i][1])] = PAIRS[i][0];
  }

  function isMobileViewport() {
    if (window.matchMedia) {
      return window.matchMedia('(max-width: ' + BREAKPOINT + 'px)').matches;
    }
    return (window.innerWidth || document.documentElement.clientWidth) <= BREAKPOINT;
  }

  /* The counterpart route when the current page is wrong for the viewport,
     else null. A desktop page only has an entry in toMobile and a mobile page
     only in toDesktop, so a page already matching its viewport — or any
     unmapped page — always resolves to null. That asymmetry is the loop
     guard. */
  function target() {
    var here = normalize(location.pathname);
    return isMobileViewport() ? (toMobile[here] || null) : (toDesktop[here] || null);
  }

  function redirect() {
    var t = target();
    if (!t) return;
    /* Desktop routes served from directories (index.html inside) — a trailing
       slash works on every server. */
    var isDir = t === '/waitlist' || t === '/blog' || t.indexOf('/blog/') === 0;
    if (/\.html?$/i.test(location.pathname)) {
      /* Static servers without clean-URL rewrites — stay in .html style. */
      if (t === '/') t = '/index.html';
      else if (isDir) t = t + '/';
      else t = t + '.html';
    } else if (isDir) {
      t = t + '/';
    }
    location.replace(t + location.search + location.hash);
  }

  redirect();

  /* A bfcache restore skips the load-time check — the viewport may have
     changed (rotation, window resize) while the page was frozen. */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) redirect();
  });

  var timer = null;
  function queue() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(redirect, 250);
  }
  window.addEventListener('resize', queue);
  window.addEventListener('orientationchange', queue);
})();
