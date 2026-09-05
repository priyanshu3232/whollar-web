/* The waitlist popup: one card, two asks, three hosts.
 *
 *   www.whollar.ca      tires.whollar.ca      internet.whollar.ca
 *
 * ONE FILE, HELD BYTE IDENTICAL IN THREE REPOS, and it takes no per-repo
 * configuration: the product is read from the hostname. That is the whole
 * reason there is no mount element to keep in step. A repo adds one <script>
 * tag and is done, and the only way the three copies can disagree is if
 * somebody edits one of them, which js/referral-popup.sha256 is here to
 * catch. `cmp` cannot reach across repos since the September 2026 split, so
 * the checksum file is the record; see CLAUDE.md.
 *
 * WHAT IT DOES NOT DO, and why each one is deliberate.
 *
 * It does not mint a referral code. A code in this system belongs to a
 * MEMBER: lib/referral.js resolves `referral_token` rows whose owner_type is
 * 'member' and returns null for everything else, so a code handed to an
 * unverified email address would resolve to nobody and every referral made
 * with it would count zero. An email in a popup is not an account. The done
 * state therefore confirms and points at /join, which is where signup mints
 * a real token that actually resolves.
 *
 * It does not normalise the referral code it carries. whollar-core.js and the
 * backend's lib/token.js already hold two mirrored copies of the check-digit
 * algorithm, and a third copy here would be a third thing to keep in step for
 * no gain: this lane stores the code for reporting, and the lane that decides
 * attribution is signup writing users.referral_code, which normalises server
 * side. The column is "as typed", the same contract as
 * TireWaitlistSignups.ReferralCode.
 *
 * It does not log a visit. GET /r/:token already writes invite_click for
 * every click on a share link, which is the link the dashboard hands out. A
 * hand-edited ?ref= URL is not worth a second public write endpoint.
 *
 * It does not trap focus. This is a corner card with aria-modal="false", not
 * a dialog over the page: trapping Tab inside something the reader can see
 * around is how a popup becomes a cage. Escape closes it, Tab leaves it, and
 * focus goes back where it came from on close.
 *
 * STORAGE. A cookie, not localStorage: the step has to survive a reload, and
 * `whl_cta` is the only thing this file persists. Host-only on purpose, no
 * Domain attribute, because dismissing the winter tire ask is not a statement
 * about the internet one.
 */
(function (window, document) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. WHERE ARE WE, AND WHERE DOES THE EMAIL GO
   * ------------------------------------------------------------------ */

  /* ⚠ THIS IS THE DEVELOPMENT ENVIRONMENT, the same one every other form on
     every host posts to. When a production Catalyst environment exists, this
     constant changes alongside W.CATALYST_HOST in whollar-core.js. Two of the
     three hosts load that module and hand us W.API, so on those the change is
     already made for us; tires.whollar.ca does not, which is what the
     fallback is for. */
  var API_FALLBACK = 'https://whollar-110003037934.development.catalystserverless.ca/server/formSubmit';

  var W = window.WHOLLAR;
  var API = (W && W.API) || API_FALLBACK;

  /* The product is the host. An override attribute exists for the preview
     builds and for a page that wants to ask a different question, but no
     shipped page sets it, and that is the point. */
  function productOf() {
    var el = document.querySelector('[data-whl-product]');
    if (el) return el.getAttribute('data-whl-product');
    var h = String(window.location.hostname || '').toLowerCase();
    if (h.indexOf('tires.') === 0 || h.indexOf('tyres.') === 0) return 'tires';
    if (h.indexOf('internet.') === 0) return 'internet';
    return 'home';
  }

  /* ------------------------------------------------------------------ *
   * 2. COPY
   * ------------------------------------------------------------------
   * Step 1 is the same on all three hosts: the ask is to join Whollar, not to
   * buy the thing this page is about. Step 2 is where they differ, because
   * step 2 only ever runs after somebody has closed step 1, and the only
   * honest thing to say then is "then this page is not for you today, here is
   * what else there is".
   *
   * No counts. Not members, not cities, not positions. The one promise made
   * anywhere in this file is procedural: the place is held from now, and the
   * confirmation arrives by email.
   */
  var COPY = {
    home: {
      step1: {
        title: 'Join the waitlist',
        body: 'The Whollar community grows every day. Join us and stay connected with what is coming next.'
      },
      step2: {
        title: 'Nothing you need right now?',
        body: 'New products are on the way, and members hear about them first. Leave your email and we will tell you what opens next.'
      }
    },
    tires: {
      step1: {
        title: 'Join the waitlist',
        body: 'The Whollar community grows every day. Join us and stay connected with what is coming next.'
      },
      step2: {
        title: 'Not buying winter tires right now?',
        body: 'We still have you covered on the other things a household pays too much for. Leave your email and we will tell you what opens next.'
      }
    },
    internet: {
      step1: {
        title: 'Join the waitlist',
        body: 'The Whollar community grows every day. Join us and stay connected with what is coming next.'
      },
      step2: {
        title: 'Not switching internet right now?',
        body: 'We still have you covered on the other things a household pays too much for. Leave your email and we will tell you what opens next.'
      }
    }
  };

  var REFERRED_LINE = 'A friend sent you this link.';
  var FINE = 'One email to confirm, then updates only. Unsubscribe any time.';

  /* The exact sentence agreed to, sent with the submission and stored beside
     it. CASL needs what, when and where a year later, and a checkbox state
     proves none of the three. The server stamps the when and the where; this
     is the what. */
  var CONSENT_TEXT =
    'I am joining the Whollar waitlist and agree to receive email updates about ' +
    'Whollar products. One email to confirm, then updates only. Unsubscribe any time.';

  /* ------------------------------------------------------------------ *
   * 3. WHEN NOT TO ASK
   * ------------------------------------------------------------------
   * Paths that already put the full form in front of somebody. Asking for an
   * email in the corner of a page whose whole job is to collect one is how a
   * popup earns the reputation popups have.
   *
   * Matched as a prefix on the pathname with any trailing slash removed, so
   * /join, /join/ and /join-welcome all match the /join entry. That is
   * intended: every page in the join flow is a page where the ask is already
   * on screen.
   */
  var QUIET_PATHS = ['/join', '/waitlist', '/thank-you', '/welcome-member', '/welcome-partner', '/contact'];

  function isQuietPath() {
    var p = String(window.location.pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';
    for (var i = 0; i < QUIET_PATHS.length; i++) {
      if (p === QUIET_PATHS[i] || p.indexOf(QUIET_PATHS[i]) === 0) return true;
    }
    return false;
  }

  /* Any page can opt out with one attribute, which is what a new full-form
     page should use rather than growing the list above. */
  function isOptedOut() {
    return !!document.querySelector('[data-whl-cta="off"]');
  }

  /* ------------------------------------------------------------------ *
   * 4. THE COOKIE
   * ------------------------------------------------------------------
   * `whl_cta` holds one of three words and nothing else:
   *
   *   step2   step 1 was closed without an email. Show step 2 next time.
   *   off     step 2 was closed too. Ask nothing for 7 days.
   *   joined  an email was given. Ask nothing for 180 days.
   *
   * No identifiers, no timestamps, nothing that says who. Disclosed in the
   * privacy policy under the cookies we set ourselves.
   */
  var COOKIE = 'whl_cta';
  var DAYS = { step2: 7, off: 7, joined: 180 };

  function readCookie() {
    var raw = document.cookie || '';
    var parts = raw.split(';');
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i];
      var eq = pair.indexOf('=');
      if (eq < 0) continue;
      if (pair.slice(0, eq).trim() !== COOKIE) continue;
      var v = pair.slice(eq + 1).trim();
      return DAYS.hasOwnProperty(v) ? v : null;
    }
    return null;
  }

  function writeCookie(value) {
    if (!DAYS.hasOwnProperty(value)) return;
    var maxAge = DAYS[value] * 24 * 60 * 60;
    var parts = [COOKIE + '=' + value, 'Max-Age=' + maxAge, 'Path=/', 'SameSite=Lax'];
    if (window.location.protocol === 'https:') parts.push('Secure');
    try { document.cookie = parts.join('; '); } catch (e) { /* nothing to do */ }
  }

  /* ------------------------------------------------------------------ *
   * 5. THE REFERRAL CODE THIS PAGE LOAD CARRIES
   * ------------------------------------------------------------------
   * Read, never validated. A loose shape check keeps the "a friend sent you"
   * strip off the card when the parameter is obvious junk, and that is all it
   * is for: whether the code belongs to anybody is the server's question, and
   * it is asked at signup, not here.
   *
   * whollar-core.js banks the same parameter into localStorage for signup to
   * spend, and GET /r/:token banks it into a server-set cookie. Both lanes
   * already ran by the time this file looks; nothing here disturbs either.
   */
  var REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{5,63}$/;

  function refCode() {
    var v = null;
    try {
      var q = new URLSearchParams(window.location.search);
      v = q.get('ref') || q.get('referral');
    } catch (e) { v = null; }
    if (!v) {
      /* No parameter on this load, but the module that banked one on an
         earlier page is right here. Only read when it exists. */
      try { v = (W && W.referral && W.referral.pending && W.referral.pending()) || null; } catch (e2) { v = null; }
    }
    if (!v) return null;
    v = String(v).trim().slice(0, 64);
    return REF_SHAPE.test(v) ? v : null;
  }

  /* ------------------------------------------------------------------ *
   * 6. STYLE
   * ------------------------------------------------------------------
   * Injected rather than shipped in a stylesheet so that adding the widget to
   * a repo is one script tag and nothing else.
   *
   * EVERY SELECTOR IS SCOPED UNDER `.whl-cta`, the root element, and the only
   * global thing touched is a keyframes name carrying the same prefix. The
   * prefix alone was not enough and the claim that it was cost the internet
   * host a visible bug: internet.whollar.ca has its own design system on the
   * same `whl-` prefix, `.whl-btn` and `.whl-card` among it, and this style
   * block is appended to <head> after the page's own, so on the tie it won.
   * Eight seconds into a visit, or at forty percent scrolled, every button on
   * that landing page went from 50px tall and forest green to 46px and this
   * widget's green, and every card lost 8px of padding. Scoping also raises
   * these rules to two classes, so the card keeps its own look regardless of
   * which stylesheet a host loads last.
   *
   * Two designs, chosen with data-whl-design on any element: `note` (the
   * default, a cream card) and `ticket` (dark, with a torn stub). They differ
   * only in colour and one border, so a third is a block of CSS rather than a
   * second state machine.
   */
  var CSS = [
    '.whl-cta{position:fixed;right:20px;bottom:20px;z-index:9000;width:360px;',
    'max-width:calc(100vw - 40px);font:400 15px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    'color:#0E2A20}',
    '.whl-cta[hidden]{display:none}',
    '.whl-cta .whl-card{position:relative;background:#FFFEFB;border:1px solid rgba(14,42,32,.1);border-radius:22px;',
    'padding:24px 22px 20px;box-shadow:0 18px 40px -22px rgba(14,42,32,.35);animation:whl-cta-in .28s ease-out both}',
    '.whl-cta h2{font-family:inherit;font-weight:700;font-size:22px;line-height:1.15;',
    'letter-spacing:-.01em;margin:0 0 8px;padding-right:34px;color:inherit}',
    '.whl-cta p{margin:0 0 14px;font-size:14px}',
    '.whl-cta .whl-close{position:absolute;top:10px;right:10px;width:32px;height:32px;border:0;border-radius:50%;',
    'background:transparent;color:inherit;opacity:.6;cursor:pointer;padding:0;',
    'font-family:inherit;font-weight:400;font-size:20px;line-height:1}',
    '.whl-cta .whl-close:hover,.whl-cta .whl-close:focus-visible{opacity:1}',
    '.whl-cta .whl-ref{display:flex;gap:8px;align-items:center;font-size:13px;margin:0 0 12px}',
    '.whl-cta .whl-ref::before{content:"";width:8px;height:8px;border-radius:50%;background:#1E9E63;flex:none}',
    '.whl-cta .whl-lab{display:block;font-size:13px;font-weight:600;margin:0 0 6px}',
    '.whl-cta .whl-row{display:flex;gap:8px}',
    '.whl-cta input[type=email]{flex:1;min-width:0;height:46px;border-radius:12px;padding:0 14px;',
    'border:1.5px solid rgba(14,42,32,.18);background:#FFFEFB;color:#0E2A20;font:inherit;outline:0}',
    '.whl-cta input[type=email]:focus-visible{border-color:#1E9E63;box-shadow:0 0 0 3px rgba(30,158,99,.2)}',
    '.whl-cta .whl-btn{height:46px;padding:0 16px;border:0;border-radius:12px;background:#1E9E63;color:#fff;',
    'font-family:inherit;font-weight:600;font-size:15px;line-height:1;white-space:nowrap;cursor:pointer;',
    'text-align:center;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;',
    'vertical-align:top}',
    '.whl-cta .whl-btn:hover{background:#1A8A56}',
    '.whl-cta .whl-btn:focus-visible{outline:3px solid #7FE3B0;outline-offset:2px}',
    '.whl-cta .whl-btn[disabled]{opacity:.6;cursor:default}',
    '.whl-cta .whl-err{color:#C2643B;font-size:13px;margin:8px 0 0}',
    '.whl-cta .whl-err:empty{display:none}',
    '.whl-cta .whl-fine{font-size:12px;opacity:.7;margin:12px 0 0}',
    '.whl-cta .whl-done,.whl-cta[data-state="done"] .whl-ask{display:none}',
    '.whl-cta[data-state="done"] .whl-done{display:block}',
    '.whl-cta[data-state="done"] .whl-btn{width:100%;display:flex}',
    /* ticket */
    '.whl-cta[data-design="ticket"] .whl-card{background:#0E2A20;color:#FAF8F3;border-color:transparent}',
    '.whl-cta[data-design="ticket"] h2{color:#7FE3B0}',
    '.whl-cta[data-design="ticket"] .whl-lab{color:#7FE3B0}',
    '.whl-cta[data-design="ticket"] .whl-ref::before{background:#7FE3B0}',
    '.whl-cta[data-design="ticket"] input[type=email]{background:rgba(255,255,255,.07);',
    'border-color:rgba(250,248,243,.28);color:#FAF8F3}',
    '.whl-cta[data-design="ticket"] .whl-btn{background:#7FE3B0;color:#0E2A20}',
    '.whl-cta[data-design="ticket"] .whl-btn:hover{background:#94EBBE}',
    '.whl-cta[data-design="ticket"] .whl-err{color:#F0A98A}',
    /* the announcement, offscreen but read */
    '.whl-cta .whl-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '@keyframes whl-cta-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion:reduce){.whl-cta .whl-card{animation:none}}',
    /* Under 600px it stops being a corner card and becomes a sheet on the
       bottom edge, with a grab bar, because 360px in a corner on a phone is
       a card with no corner to sit in. */
    '@media (max-width:600px){',
    '.whl-cta{right:0;left:0;bottom:0;width:auto;max-width:none}',
    '.whl-cta .whl-card{border-radius:22px 22px 0 0;padding-top:20px}',
    '.whl-cta .whl-card::before{content:"";display:block;width:40px;height:4px;border-radius:2px;',
    'background:currentColor;opacity:.25;margin:0 auto 14px}',
    '}'
  ].join('');

  function injectStyle() {
    if (document.getElementById('whl-cta-style')) return;
    var s = document.createElement('style');
    s.id = 'whl-cta-style';
    s.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * 7. THE CARD
   * ------------------------------------------------------------------
   * Built with createElement and textContent throughout. Not innerHTML: the
   * copy above is ours today, but the referral code is not, and one lane that
   * takes a string from a query parameter into markup is one lane too many.
   */
  var product = productOf();
  var copy = COPY[product] || COPY.home;
  var ref = null;
  var step = 1;
  var root = null;
  var fired = false;      /* one trigger per page view, ever */
  var lastFocus = null;
  var timers = [];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    var st = step === 2 ? copy.step2 : copy.step1;

    root = el('div', 'whl-cta');
    root.id = 'whl-cta';
    root.hidden = true;
    root.setAttribute('data-state', 'ask');
    var designEl = document.querySelector('[data-whl-design]');
    root.setAttribute('data-design', (designEl && designEl.getAttribute('data-whl-design')) === 'ticket' ? 'ticket' : 'note');

    var card = el('div', 'whl-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', 'whl-cta-h');

    var close = el('button', 'whl-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { dismiss(); });
    card.appendChild(close);

    /* --- ask --- */
    var ask = el('div', 'whl-ask');
    if (ref) ask.appendChild(el('p', 'whl-ref', REFERRED_LINE));

    var h = el('h2', null, st.title);
    h.id = 'whl-cta-h';
    ask.appendChild(h);
    ask.appendChild(el('p', null, st.body));

    var form = document.createElement('form');
    form.noValidate = true;

    var lab = el('label', 'whl-lab', 'Share your email:');
    lab.setAttribute('for', 'whl-cta-email');
    form.appendChild(lab);

    var row = el('div', 'whl-row');
    var input = document.createElement('input');
    input.type = 'email';
    input.id = 'whl-cta-email';
    input.name = 'email';
    input.autocomplete = 'email';
    input.placeholder = 'you@example.com';
    input.setAttribute('aria-describedby', 'whl-cta-fine');
    row.appendChild(input);

    var submit = el('button', 'whl-btn', 'Hold my spot');
    submit.type = 'submit';
    row.appendChild(submit);
    form.appendChild(row);
    ask.appendChild(form);

    var err = el('p', 'whl-err');
    err.setAttribute('role', 'alert');
    ask.appendChild(err);

    var fine = el('p', 'whl-fine', FINE);
    fine.id = 'whl-cta-fine';
    ask.appendChild(fine);
    card.appendChild(ask);

    /* --- done --- */
    var done = el('div', 'whl-done');
    done.appendChild(el('h2', null, 'You are in.'));
    done.appendChild(el('p', null,
      'Your place is held from now, and a confirmation is on its way to your email.'));
    var join = el('a', 'whl-btn', 'Finish joining');
    join.href = '/join';
    done.appendChild(join);
    done.appendChild(el('p', 'whl-fine',
      'Finishing your account is what gets you a share link of your own. ' +
      'Friends who join through it count for you.'));
    card.appendChild(done);

    var live = el('span', 'whl-live');
    live.setAttribute('aria-live', 'polite');
    card.appendChild(live);

    root.appendChild(card);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      send(input, err, submit, live);
    });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') { e.stopPropagation(); dismiss(); }
    });

    document.body.appendChild(root);
    return input;
  }

  /* ------------------------------------------------------------------ *
   * 8. OPEN, CLOSE, SEND
   * ------------------------------------------------------------------ */

  function open() {
    if (fired || root) return;
    fired = true;
    clearTimers();
    injectStyle();
    var input = build();
    root.hidden = false;
    lastFocus = document.activeElement;
    /* Focus the field, not the card. On step 2 especially, the reader was
       already reading; moving the caret into the one thing they might type in
       is the least disruptive place to land. */
    try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
  }

  function teardown() {
    if (!root) return;
    if (root.parentNode) root.parentNode.removeChild(root);
    root = null;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    lastFocus = null;
  }

  /* Closing step 1 without an email is not a refusal, it is a "not this".
     Step 2 asks the other question, once, thirty seconds later. Closing that
     one IS a refusal and is honoured for a week.
  
     Closing the card AFTER joining is neither. It used to fall through to the
     step 1 branch, which re-armed the second ask and wrote `step2` over the
     `joined` cookie, so somebody who joined and then tidied the card away was
     asked again thirty seconds later, on every page, for a week. The done
     state is a finished conversation: take the card away and change nothing.
  */
  function dismiss() {
    var wasStep = step;
    var wasDone = !!(root && root.getAttribute('data-state') === 'done');
    teardown();
    if (wasDone) return;
    if (wasStep === 1) {
      writeCookie('step2');
      step = 2;
      fired = false;
      timers.push(window.setTimeout(open, 30000));
    } else {
      writeCookie('off');
    }
  }

  function send(input, err, submit, live) {
    /* The card this submission belongs to. `root` is reassigned by open and
       nulled by teardown, so comparing the two on the way back is how a
       response knows whether the card it was typed into is still on screen. */
    var card = root;
    var email = String(input.value || '').trim().toLowerCase();

    /* Byte-identical to EMAIL_RE in whollar-core.js and in the route. The
       pages used to carry a looser variant that accepted a@b.c, which the
       server then refused with a 400 nobody could act on. */
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
      err.textContent = 'That email does not look complete. Check the address and try again.';
      input.focus();
      return;
    }

    err.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Holding';

    var body = {
      email: email,
      product: product,
      ctaStep: step,
      referral: ref || '',
      sourcePage: String(window.location.pathname || '').slice(0, 120),
      consentGranted: true,
      consentKind: 'waitlist-email',
      consentText: CONSENT_TEXT,
      consentSource: 'referral-popup'
    };

    /* NO Content-Type HEADER, AND THAT IS LOAD BEARING. Setting
       application/json makes this a preflighted request, and the Catalyst
       gateway answers OPTIONS itself, with no CORS headers on anything but the
       one origin named in the console rule. Verified on 2026-09-05: the
       preflight from tires.whollar.ca and internet.whollar.ca comes back 200
       with no Access-Control-Allow-Origin at all, so the browser never sends
       the POST and the popup reports a failure the server never saw. curl
       cannot catch this, because curl does not preflight.

       A string body with no content type is sent as text/plain, which is
       CORS-safelisted, and the route's express.json is configured to parse
       text/plain for exactly this reason. Same shape as W.submitForm. */
    fetch(API + '/waitlist-email', {
      method: 'POST',
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (b) {
        if (!r.ok) {
          var e = new Error('waitlist-email ' + r.status);
          e.status = r.status;
          e.body = b;
          throw e;
        }
        return b || {};
      });
    }).then(function () {
      /* The cookie is written whatever happened to the card: the submission
         landed, so the ask is answered even if the reader closed the card
         while it was in flight. Everything below it touches the card, and the
         card may be gone, which is what `card` being detached means. */
      writeCookie('joined');
      if (!card || card !== root) return;
      root.setAttribute('data-state', 'done');
      live.textContent = 'You are in. Your place is held.';
      var join = root.querySelector('.whl-done .whl-btn');
      if (join) { try { join.focus({ preventScroll: true }); } catch (e) { join.focus(); } }
    }, function (e) {
      if (!card || card !== root) return;
      submit.disabled = false;
      submit.textContent = 'Hold my spot';
      err.textContent = (e && e.status === 429)
        ? 'Too many attempts from your network right now. Please try again in a little while.'
        : 'That did not go through. Please try again in a moment.';
      input.focus();
    });
  }

  /* ------------------------------------------------------------------ *
   * 9. TRIGGERS
   * ------------------------------------------------------------------
   * Eight seconds, or forty percent scrolled, or the pointer leaving through
   * the top edge on a device that has a pointer. Whichever happens first, and
   * only one of them ever happens, because `open` sets `fired` and clears the
   * rest.
   */
  function clearTimers() {
    for (var i = 0; i < timers.length; i++) window.clearTimeout(timers[i]);
    timers = [];
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('mouseout', onExit);
  }

  function onScroll() {
    var doc = document.documentElement;
    var scrollable = (doc.scrollHeight || 0) - (window.innerHeight || 0);
    if (scrollable <= 0) return;
    if ((window.pageYOffset || doc.scrollTop || 0) / scrollable >= 0.4) open();
  }

  function onExit(e) {
    /* relatedTarget null and clientY at or above the top edge is the mouse
       leaving through the top of the viewport rather than crossing between
       two elements inside it. */
    if (e.relatedTarget || e.toElement) return;
    if ((e.clientY || 0) > 4) return;
    open();
  }

  function arm() {
    timers.push(window.setTimeout(open, 8000));
    window.addEventListener('scroll', onScroll, { passive: true });
    if (window.matchMedia && window.matchMedia('(pointer:fine)').matches) {
      document.addEventListener('mouseout', onExit);
    }
    /* Already past the mark when the page settles, on a short page or a
       restored scroll position. */
    onScroll();
  }

  /* ------------------------------------------------------------------ *
   * 10. BOOT
   * ------------------------------------------------------------------ */
  function boot() {
    if (isQuietPath() || isOptedOut()) return;

    var seen = readCookie();
    if (seen === 'joined' || seen === 'off') return;
    if (seen === 'step2') step = 2;

    ref = refCode();
    arm();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* The harness reaches in here, and so does anybody debugging a live page.
     Nothing on a page calls it. */
  window.WHOLLAR_CTA = {
    open: function () { fired = false; open(); },
    dismiss: dismiss,
    product: function () { return product; },
    step: function () { return step; },
    cookie: readCookie
  };
})(window, document);
