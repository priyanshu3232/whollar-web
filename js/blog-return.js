/* Whollar blog return lane.

   A member who opened an article from the dashboard's Knowledge centre hit a
   one-way door. The article's "All articles" link points at /blog/, the public
   resources index, and that page has no route back into a signed-in surface:
   the reader was out of the product with nothing to click, and had to find the
   dashboard again by typing its URL.

   The dashboard now stamps the article links it renders with ?from=dashboard.
   This script reads that stamp and repoints the article's back link at the
   Knowledge centre, so "All articles" still means all articles and the reader
   never leaves the dashboard. On the resources index itself it puts the same
   link into the masthead, so the door swings both ways however the reader got
   there.

   Three details, each earned:

   1. The stamp is remembered in sessionStorage. Articles cross-link to each
      other, and a lane that survived one hop and not the next would be worse
      than no lane at all. Article links on the page are re-stamped for the
      same reason, so the chain holds where storage is blocked.

   2. The stamp is then wiped from the visible URL with replaceState. A reader
      who copies the address bar to send an article to a neighbour must not
      hand them a link whose back button leads to a login screen for an account
      they do not have.

   3. Nothing is touched for a reader who did not arrive from the dashboard,
      and the footer, the brand mark and the join CTA are never touched for
      anyone. Those are a reader leaving on purpose. */
(function () {
  'use strict';
  if (window.__whlBlogReturn) return;
  window.__whlBlogReturn = true;

  var STAMP = 'from=dashboard';
  var KEY = 'whollar.blogfrom';
  var BACK = '/dashboard#knowledge';
  var LABEL = 'Back to all articles in your dashboard';

  /* An exact key=value match on one parameter, not indexOf over the whole
     query string: "?utm_source=from=dashboard" is not this stamp. */
  function stamped() {
    var q = window.location.search;
    if (!q) return false;
    var parts = q.slice(1).split('&');
    for (var i = 0; i < parts.length; i++) if (parts[i] === STAMP) return true;
    return false;
  }

  function remembered() {
    try { return window.sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function remember() {
    try { window.sessionStorage.setItem(KEY, '1'); } catch (e) { /* private mode */ }
  }

  var arrived = stamped();
  if (arrived) remember();
  else if (!remembered()) return;

  /* Desktop articles live at /blog/<slug>, their mobile copies at
     /MobileVersion/blog/<slug>. Both namespaces appear here because the device
     router carries the query string across when it swaps one for the other. */
  function isArticle(path) {
    return /^\/blog\/[a-z0-9-]+\/?$/.test(path) ||
           /^\/MobileVersion\/blog\/[a-z0-9-]+(\.html)?$/i.test(path);
  }
  function isIndex(path) {
    var p = path.replace(/index\.html?$/i, '');
    return p === '/blog/' || p === '/blog' ||
           /^\/MobileVersion\/resources-mobile(\.html)?$/i.test(p);
  }

  function stampHref(a) {
    if (a.search) {
      if (a.search.slice(1).split('&').indexOf(STAMP) > -1) return;
      a.setAttribute('href', a.pathname + a.search + '&' + STAMP + a.hash);
    } else {
      a.setAttribute('href', a.pathname + '?' + STAMP + a.hash);
    }
  }

  /* The chevron the articles already use, so an injected link on the index is
     the same object the reader met on the article. */
  var CHEVRON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
    ' aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg><span>All articles</span>';

  function apply() {
    var back = document.querySelector('.mast a.back');
    if (back) {
      back.setAttribute('href', BACK);
      back.setAttribute('aria-label', LABEL);
    } else if (isIndex(window.location.pathname)) {
      /* The resources index carries no back link of its own: it is the top of
         the public reading lane. Give it one, inside the .left slot the
         articles already reserve. */
      var slot = document.querySelector('.mast .in .left') || document.querySelector('.mast .in');
      if (slot) {
        var a = document.createElement('a');
        a.className = 'back';
        a.setAttribute('href', BACK);
        a.setAttribute('aria-label', LABEL);
        a.innerHTML = CHEVRON;
        slot.insertBefore(a, slot.firstChild);
      }
    }

    var links = document.getElementsByTagName('a');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (link.host && link.host !== window.location.host) continue;
      if (isArticle(link.pathname || '')) stampHref(link);
    }
  }

  /* Wipe the stamp from the address bar, never from history: replaceState so
     the reader's back button still lands where they came from. */
  function clean() {
    if (!arrived || !window.history || !window.history.replaceState) return;
    var kept = window.location.search.slice(1).split('&').filter(function (p) {
      return p && p !== STAMP;
    });
    var url = window.location.pathname + (kept.length ? '?' + kept.join('&') : '') +
      window.location.hash;
    try { window.history.replaceState(window.history.state, '', url); } catch (e) { /* opaque origin */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(); clean(); });
  } else {
    apply();
    clean();
  }
})();
