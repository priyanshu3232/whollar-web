/* /join-welcome: the screen a household lands on the moment its code is
 * checked on /join.
 *
 * The design is the welcome stage from welcomewhollar.html, which ships two
 * audiences behind a Member/Partner toggle. This is neither of those: it is
 * the same stage told per PRODUCT, because /join asks what you are pooling for
 * and a winter tire cohort and an internet cohort do not do the same things
 * next. Which one is in the `pool` query parameter, put there by /join.
 *
 * Everything else is read from the session where there is one, and from a
 * sessionStorage handoff where there is not. /join no longer mints an account
 * (see js/waitlist-join.js for why the code step went and what it cost), so on
 * that path there is nothing to read a name out of. What there is never goes
 * in the URL: a query string is the one place on a shared machine that keeps a
 * name and a postal code after the tab is closed, in history and in any link
 * that gets pasted. The handoff dies with the tab.
 */
(function () {
  'use strict';

  var W = window.WHOLLAR;
  var $ = function (id) { return document.getElementById(id); };

  /* ---- copy, per product ---- */

  var COMMON_FOOT = 'Bids are sealed. You see your own before and after, and nobody else does.';

  var STATES = {
    internet: {
      label: 'Internet',
      sub: 'Your spot in <b>{area}</b> is held. Here is what your membership sets in motion.',
      steps: [
        { k: 'STEP 1', h: 'Build the bid on your real bill',
          p: 'The two minute checkup is what the bid for your cohort gets built on. Nine questions and your actual bill.',
          link: 'Run the checkup', href: '/bill-checkup' },
        { k: 'STEP 2', h: 'Your cohort forms',
          p: 'Households near you, timed to renewal windows like yours, are gathered into one cohort with real weight.' },
        { k: 'STEP 3', h: 'Bids land sealed',
          p: 'Verified providers bid for the whole cohort. <b>We text you the moment one lands in your area.</b>' }
      ],
      share: 'Every neighbour who joins through your link strengthens the bid you will all get.'
    },

    tires: {
      label: 'Winter tires',
      sub: 'Your spot in the <b>Winter 2026</b> tire cohort is held. Here is what happens between now and first snow.',
      steps: [
        { k: 'STEP 1', h: 'Tell us what your car needs',
          p: 'Make, model and year decide your tire size, and size decides who can bid for you. It takes a minute.',
          link: 'Add my vehicle', href: '/dashboard' },
        { k: 'STEP 2', h: 'Your cohort fills before the season',
          p: 'Drivers near you who need the same sizes are gathered into one cohort. A fitter quotes a whole street more sharply than one car.' },
        { k: 'STEP 3', h: 'One price, fitting included',
          p: 'Verified installers bid on the tires and the fitting together. <b>We text you the moment a bid lands for your sizes.</b>' }
      ],
      share: 'Every driver near you who joins through your link makes the cohort worth bidding harder for.'
    },

    both: {
      label: 'Internet and winter tires',
      sub: 'Your spot is held in <b>{area}</b> for internet and for winter tires. Two cohorts, one account.',
      steps: [
        { k: 'STEP 1', h: 'Start with your internet bill',
          p: 'The two minute checkup is what your internet bid gets built on. Your tire cohort needs your vehicle, which is a minute more.',
          link: 'Run the checkup', href: '/bill-checkup' },
        { k: 'STEP 2', h: 'Two cohorts, filling separately',
          p: 'Internet is timed to renewal windows near you. Tires are timed to first snow. You are counted in both, and neither waits on the other.' },
        { k: 'STEP 3', h: 'Bids land sealed, per cohort',
          p: 'Verified providers bid for each cohort on its own terms. <b>We text you the moment either one lands.</b>' }
      ],
      share: 'Every neighbour who joins through your link strengthens both cohorts you are counted in.'
    }
  };

  function chosen() {
    /* The page says first: /join-welcome-tires carries data-pool on <body>,
       so a tire household cannot be shown internet copy by a stripped query
       string. The URL decides only between internet and both on the internet
       screen. */
    var pool = document.body.getAttribute('data-pool');
    if (!pool) {
      try { pool = new URLSearchParams(window.location.search).get('pool'); } catch (e) { pool = null; }
    }
    return Object.prototype.hasOwnProperty.call(STATES, pool) ? pool : 'internet';
  }

  /* ---- the reveal ----
   * The prototype's timeline, unchanged: three chips ticking on, then the
   * headline, the card with its sheen, the buttons, the steps, the share
   * panel. The reduced-motion branch sets every class at once. */

  /* Two chips, not three. The first said "Email verified" and nothing on this
     path verifies an email: the form posts, the row is written, and the page
     loads. A tick beside a claim we have not checked is the kind of thing a
     member believes. */
  function playAnim() {
    var chips = ['chip2', 'chip3'];
    var blocks = ['hd', 'cardwrap', 'ctas', 'step1', 'step2', 'step3', 'share'];

    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      chips.forEach(function (id) { $(id).classList.add('on'); });
      blocks.forEach(function (id) { $(id).classList.add('play'); });
      return;
    }
    var at = function (fn, ms) { setTimeout(fn, ms); };
    at(function () { $('chip2').classList.add('on'); }, 250);
    at(function () { $('chip3').classList.add('on'); }, 620);
    at(function () { $('hd').classList.add('play'); }, 1150);
    at(function () {
      $('cardwrap').classList.add('play');
      $('fcard').classList.add('sheen');
    }, 1350);
    at(function () { $('ctas').classList.add('play'); }, 1750);
    at(function () { $('step1').classList.add('play'); }, 1950);
    at(function () { $('step2').classList.add('play'); }, 2080);
    at(function () { $('step3').classList.add('play'); }, 2210);
    at(function () { $('share').classList.add('play'); }, 2400);
  }

  /* ---- writing the copy in ---- */

  function monthYear(stamp) {
    /* Catalyst hands back 'YYYY-MM-DD HH:MM:SS'. Parsed by parts rather than
       by Date(), which reads that string as UTC in some browsers and local in
       others, and can therefore print the previous month. */
    var m = /^(\d{4})-(\d{2})/.exec(String(stamp || ''));
    if (!m) return null;
    var names = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    var name = names[Number(m[2]) - 1];
    return name ? name + ' ' + m[1] : null;
  }

  function apply(key, user) {
    var s = STATES[key];
    var area = (user && (user.postal || user.fsa)) || 'your area';
    var first = (user && user.firstName) || null;

    $('hd-h1').textContent = first ? 'Welcome in, ' + first + '.' : 'Welcome in.';
    $('hd-sub').innerHTML = s.sub.replace('{area}', area);

    var name = first
      ? (first + ((user && user.lastName) ? ' ' + String(user.lastName).charAt(0) + '.' : ''))
      : 'Founding member';
    $('card-name').textContent = name;
    var since = monthYear(user && user.memberSince);
    $('card-namesub').textContent = since ? 'Founding member since ' + since : 'Founding member';

    $('m1-l').textContent = 'Area';
    $('m1-v').textContent = area;
    $('m2-l').textContent = 'Pooling for';
    $('m2-v').textContent = s.label;
    $('card-foot').textContent = COMMON_FOOT;

    for (var i = 0; i < 3; i++) {
      var n = i + 1, step = s.steps[i];
      $('s' + n + '-k').textContent = step.k;
      $('s' + n + '-h').textContent = step.h;
      $('s' + n + '-p').innerHTML = step.p;
    }

    var link = $('s1-link');
    if (s.steps[0].link) {
      link.hidden = false;
      link.setAttribute('href', s.steps[0].href);
      link.firstChild.nodeValue = s.steps[0].link + ' ';
    } else {
      link.hidden = true;
    }

    $('share-p').textContent = s.share;
    playAnim();
  }

  /* ---- the share link ----
   * The opaque token where one exists, the legacy code otherwise, which is
   * what the dashboard does. Neither is worth failing the page over, so a
   * refusal leaves the placeholder in place. */

  function fillShareLink() {
    if (!W.session || !W.session.referral) return;
    W.session.referral().then(function (r) {
      var raw = r && (r.token || r.code);
      if (!raw) return;
      $('share-lnk').textContent =
        window.location.origin.replace(/^https?:\/\//, '') + '/r/' + encodeURIComponent(raw);
    /* A signed-out reader is the normal case now, and this endpoint refuses
       them. Swallowed rather than left to reject: the placeholder link is a
       real one, it just attributes nobody. */
    }).catch(function () { /* placeholder stands */ });
  }

  $('share-cp').addEventListener('click', function () {
    var btn = this;
    var text = $('share-lnk').textContent;
    var done = function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else { done(); }
  });

  /* ---- start ----
   * `read` never rejects and answers { authenticated, user }. A signed-out
   * reader still gets the screen, just without a name on it: they arrived
   * here from a verified code, and an empty stage would be worse than a
   * slightly less personal one. */

  /* What /join left in the tab when it had no session to leave. Read once and
     cleared, so a reload of this URL on a shared machine shows the generic
     screen rather than somebody's name. */
  function handoff() {
    try {
      var raw = window.sessionStorage.getItem('whollar.join.welcome');
      if (!raw) return null;
      window.sessionStorage.removeItem('whollar.join.welcome');
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  var key = chosen();
  var carried = handoff();
  if (W.session && W.session.read) {
    W.session.read().then(function (r) {
      /* The session wins where there is one: it is the record, the handoff is
         only what the previous page happened to know. */
      apply(key, (r && r.user) || carried);
    });
  } else {
    apply(key, carried);
  }
  fillShareLink();
})();
