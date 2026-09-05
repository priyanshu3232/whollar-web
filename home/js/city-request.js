/* "Bring Whollar to my city": the modal behind the dashed card and the button
 * under the city row on the home page.
 *
 * WHY A MODAL AND NOT /join. Both triggers used to link to /join, which is the
 * founding member form: it asks for a name, a mobile, an address and a postal
 * code because a household joining a cohort in a place we serve needs all of
 * them. Someone in Halifax has nothing to do on that page. The only thing
 * worth asking them is where they are and what they would pool for, and every
 * field past that is a reason not to answer.
 *
 * WHERE IT GOES. POST /city-request on the formSubmit function, writing
 * CityRequests (create-tables.md section 37). Until that table exists the
 * route errors, and this form says so and keeps what was typed on screen. It
 * never shows the thank-you for a submission that did not save.
 *
 * The markup is built here rather than sitting in index.html because nothing
 * on the page needs it until someone clicks, and a dialog in the source is a
 * dialog every crawler reads as page content.
 */
(function (window, document) {
  'use strict';

  var W = window.WHOLLAR;
  if (!W || !W.submitForm) return;

  var PROVINCES = [
    ['ON', 'Ontario'], ['QC', 'Quebec'], ['BC', 'British Columbia'],
    ['AB', 'Alberta'], ['MB', 'Manitoba'], ['SK', 'Saskatchewan'],
    ['NS', 'Nova Scotia'], ['NB', 'New Brunswick'],
    ['NL', 'Newfoundland and Labrador'], ['PE', 'Prince Edward Island'],
    ['NT', 'Northwest Territories'], ['YT', 'Yukon'], ['NU', 'Nunavut']
  ];

  /* Mirrors CITY_RE in the route, so a submission that would 400 is caught
     here and named, rather than coming back as a bare server message. */
  var CITY_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ '.\-]{1,59}$/;

  var LABEL = 'display:block;font-size:12px;font-weight:650;color:#3A453E;margin-bottom:4px';
  var FIELD = 'width:100%;background:#fff;border:1.5px solid #E1DBCB;border-radius:10px;' +
    'padding:9px 12px;font-size:14px;font-family:inherit;color:#1D3527;' +
    'transition:border-color .15s,box-shadow .15s';

  var root = null;      /* the overlay, built once */
  var lastFocus = null; /* what to give focus back to on close */

  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (text != null) n.textContent = text;
    return n;
  }

  function field(id, labelText, node) {
    var wrap = el('div');
    var lab = el('label', LABEL, labelText);
    lab.setAttribute('for', id);
    node.id = id;
    node.setAttribute('style', FIELD);
    wrap.appendChild(lab);
    wrap.appendChild(node);
    return wrap;
  }

  function build() {
    var overlay = el('div', 'position:fixed;inset:0;z-index:200;display:flex;' +
      'align-items:center;justify-content:center;padding:20px;' +
      'background:rgba(11,32,22,.55);overflow-y:auto');
    overlay.hidden = true;

    var card = el('div', 'width:100%;max-width:440px;background:#FBF7EF;border-radius:18px;' +
      'padding:clamp(20px,4vw,30px);box-shadow:0 24px 60px rgba(11,32,22,.28);' +
      'font-family:Inter,system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'cr-title');

    var close = el('button', 'position:absolute;top:0;right:0;width:40px;height:40px;' +
      'border:0;background:none;color:#68705F;font-size:22px;line-height:1;cursor:pointer', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');

    var head = el('div', 'position:relative;padding-right:36px;margin-bottom:16px');
    var title = el('h2', 'font-family:\'Playfair Display\',Georgia,serif;font-weight:700;' +
      'font-size:24px;line-height:1.15;color:#173B25;margin:0 0 6px', 'Bring Whollar to your city');
    title.id = 'cr-title';
    head.appendChild(title);
    head.appendChild(el('p', 'font-size:14px;line-height:1.5;color:#68705F;margin:0',
      'Tell us where you are. Cities with the most households asking are the ones we open next.'));
    head.appendChild(close);

    var form = el('form', 'display:flex;flex-direction:column;gap:12px');
    form.noValidate = true;

    var city = el('input');
    city.type = 'text';
    city.placeholder = 'Halifax';
    city.autocomplete = 'address-level2';
    city.maxLength = 60;

    var prov = el('select');
    prov.appendChild(new Option('Choose a province', ''));
    PROVINCES.forEach(function (p) { prov.appendChild(new Option(p[1], p[0])); });

    var row = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px');
    row.appendChild(field('cr-city', 'City', city));
    row.appendChild(field('cr-prov', 'Province', prov));
    form.appendChild(row);

    var email = el('input');
    email.type = 'email';
    email.placeholder = 'you@email.com';
    email.autocomplete = 'email';
    form.appendChild(field('cr-email', 'Email', email));

    var postal = el('input');
    postal.type = 'text';
    postal.placeholder = 'B3H 2Y9';
    postal.autocomplete = 'postal-code';
    postal.maxLength = 7;
    form.appendChild(field('cr-postal', 'Postal code (optional)', postal));

    /* The three values the route accepts, and the same three the join form
       offers, so one household answering both questions answers them the
       same way. */
    var poolWrap = el('div');
    poolWrap.appendChild(el('span', LABEL, 'What would you pool for?'));
    var pools = el('div', 'display:flex;flex-wrap:wrap;gap:8px');
    [['internet', 'Internet'], ['tires', 'Winter tires'], ['both', 'Both']].forEach(function (p, i) {
      var lab = el('label', 'display:inline-flex;align-items:center;gap:7px;background:#fff;' +
        'border:1.5px solid #E1DBCB;border-radius:999px;padding:7px 14px;font-size:14px;' +
        'color:#1D3527;cursor:pointer');
      var r = el('input');
      r.type = 'radio';
      r.name = 'cr-pool';
      r.value = p[0];
      if (i === 0) r.checked = true;
      lab.appendChild(r);
      lab.appendChild(el('span', null, p[1]));
      pools.appendChild(lab);
    });
    poolWrap.appendChild(pools);
    form.appendChild(poolWrap);

    var mkWrap = el('label', 'display:flex;align-items:flex-start;gap:9px;font-size:13.5px;' +
      'line-height:1.45;color:#3A453E;cursor:pointer');
    var mk = el('input', 'margin-top:2px');
    mk.type = 'checkbox';
    mk.checked = true;
    mkWrap.appendChild(mk);
    mkWrap.appendChild(el('span', null, 'Email me when Whollar opens there.'));
    form.appendChild(mkWrap);

    var err = el('p', 'margin:0;font-size:13.5px;line-height:1.45;color:#B4442A;font-weight:600');
    err.hidden = true;
    err.setAttribute('role', 'alert');
    form.appendChild(err);

    var submit = el('button', 'height:48px;border:0;border-radius:12px;background:#173B25;' +
      'color:#FBF7EF;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;' +
      'transition:background .15s', 'Add my city');
    submit.type = 'submit';
    form.appendChild(submit);

    var done = el('div', 'text-align:center;padding:8px 0');
    done.hidden = true;

    card.appendChild(head);
    card.appendChild(form);
    card.appendChild(done);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function fail(message, node) {
      err.textContent = message;
      err.hidden = false;
      if (node && node.focus) node.focus();
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.hidden = true;

      var cityValue = city.value.replace(/\s+/g, ' ').trim();
      if (!CITY_RE.test(cityValue)) return fail('Add the city you would like Whollar in.', city);
      if (!prov.value) return fail('Choose the province it is in.', prov);
      if (!email.value || email.value.indexOf('@') < 1) {
        return fail('Add an email so we can tell you when it opens.', email);
      }

      var pool = null;
      Array.prototype.forEach.call(form.querySelectorAll('input[name="cr-pool"]'), function (r) {
        if (r.checked) pool = r.value;
      });

      submit.disabled = true;
      submit.textContent = 'Adding…';

      W.submitForm('/city-request', {
        city: cityValue,
        province: prov.value,
        email: email.value.trim(),
        postal: postal.value.trim(),
        poolingFor: pool,
        marketing: mk.checked ? 'yes' : ''
      }).then(function () {
        form.hidden = true;
        head.querySelector('p').textContent = '';
        title.textContent = 'Your city is counted';
        done.textContent = '';
        done.appendChild(el('p', 'font-size:15px;line-height:1.55;color:#3A453E;margin:0 0 16px',
          'Thanks. We have added ' + cityValue + ' to the list, and we will write to you if a ' +
          'cohort opens there.'));
        var back = el('button', 'height:46px;padding:0 22px;border:0;border-radius:12px;' +
          'background:#173B25;color:#FBF7EF;font-size:15px;font-weight:700;font-family:inherit;' +
          'cursor:pointer', 'Close');
        back.type = 'button';
        back.addEventListener('click', hide);
        done.appendChild(back);
        done.hidden = false;
        back.focus();
      }).catch(function (e2) {
        submit.disabled = false;
        submit.textContent = 'Add my city';
        fail(W.submitErrorMessage ? W.submitErrorMessage(e2) :
          'We could not reach our servers. Please try again.', null);
      });
    });

    close.addEventListener('click', hide);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) hide(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.hidden) hide();
    });

    root = { overlay: overlay, first: city };
    return root;
  }

  function show(e) {
    if (e) e.preventDefault();
    lastFocus = document.activeElement;
    var r = root || build();
    r.overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    r.first.focus();
  }

  function hide() {
    if (!root) return;
    root.overlay.hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-city-request]'), function (t) {
    t.addEventListener('click', show);
  });
})(window, document);
