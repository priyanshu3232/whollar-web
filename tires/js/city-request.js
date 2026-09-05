/* "Don't see your city?": the four tiles and the button under them.
 *
 * WHAT WAS THERE. Four divs with cursor:pointer and no handler, so they looked
 * like buttons, took a hover style, and did nothing. The button under them was
 * an anchor to #join, which scrolls to the GTA form: the one place a driver in
 * Calgary cannot be helped, offered to them because they said they are in
 * Calgary.
 *
 * WHAT THEY DO NOW. Open one modal and record the answer to the only question
 * this card asks, which is where the next cohort should be. A tile fills the
 * city and its province in; the button opens the same form empty.
 *
 * WHERE IT GOES. POST /city-request on the formSubmit function, writing
 * CityRequests (create-tables.md section 37 in the backend repo). poolingFor
 * is fixed to `tires` here, because this host has one product and asking would
 * be a question with one answer.
 *
 * Until that table exists the route errors, and this form says so and keeps
 * what was typed on screen. It never shows the thank-you for a submission that
 * did not save.
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
     here and named rather than coming back as a bare server message. */
  var CITY_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ '.\-]{1,59}$/;

  var LABEL = 'display:block;font-size:13px;font-weight:600;color:#17231D;margin-bottom:5px';
  var FIELD = 'width:100%;background:#FFFEFB;border:1px solid #E6D6C6;border-radius:12px;' +
    'padding:11px 13px;font-size:15px;font-family:inherit;color:#17231D;' +
    'transition:border-color .15s';

  var root = null;
  var lastFocus = null;

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
    var overlay = el('div', 'position:fixed;inset:0;z-index:300;display:flex;' +
      'align-items:center;justify-content:center;padding:20px;' +
      'background:rgba(14,42,32,.58);overflow-y:auto');
    overlay.hidden = true;

    var card = el('div', 'width:100%;max-width:440px;background:#FAF8F3;border-radius:22px;' +
      'padding:clamp(22px,4vw,32px);box-shadow:0 24px 60px rgba(14,42,32,.3);' +
      'font-family:Inter,system-ui,-apple-system,sans-serif');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tcr-title');

    var close = el('button', 'position:absolute;top:-4px;right:-4px;width:40px;height:40px;' +
      'border:0;background:none;color:#5A665D;font-size:24px;line-height:1;cursor:pointer', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');

    var head = el('div', 'position:relative;padding-right:36px;margin-bottom:18px');
    head.appendChild(el('div', 'font-size:12.5px;letter-spacing:0.14em;color:#B0512B;font-weight:700', 'COMING NEXT'));
    var title = el('h2', 'font-family:\'Bricolage Grotesque\',Inter,sans-serif;font-weight:600;' +
      'font-size:26px;letter-spacing:-0.022em;color:#17231D;margin:12px 0 8px', 'Bring Whollar to your city');
    title.id = 'tcr-title';
    head.appendChild(title);
    var sub = el('p', 'font-size:14.5px;line-height:1.55;color:#5A665D;margin:0',
      'The next cohort goes where enough drivers want to buy together. Tell us where you are.');
    head.appendChild(sub);
    head.appendChild(close);

    var form = el('form', 'display:flex;flex-direction:column;gap:14px');
    form.noValidate = true;

    var city = el('input');
    city.type = 'text';
    city.placeholder = 'Halifax';
    city.autocomplete = 'address-level2';
    city.maxLength = 60;

    var prov = el('select');
    prov.appendChild(new Option('Choose one', ''));
    PROVINCES.forEach(function (p) { prov.appendChild(new Option(p[1], p[0])); });

    var row = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px');
    row.appendChild(field('tcr-city', 'City', city));
    row.appendChild(field('tcr-prov', 'Province', prov));
    form.appendChild(row);

    var email = el('input');
    email.type = 'email';
    email.placeholder = 'you@email.com';
    email.autocomplete = 'email';
    form.appendChild(field('tcr-email', 'Email', email));

    var postal = el('input');
    postal.type = 'text';
    postal.placeholder = 'B3H 2Y9';
    postal.autocomplete = 'postal-code';
    postal.maxLength = 7;
    form.appendChild(field('tcr-postal', 'Postal code (optional)', postal));

    var mkWrap = el('label', 'display:flex;align-items:flex-start;gap:10px;font-size:14px;' +
      'line-height:1.5;color:#3B4740;cursor:pointer');
    var mk = el('input', 'margin-top:3px');
    mk.type = 'checkbox';
    mk.checked = true;
    mkWrap.appendChild(mk);
    mkWrap.appendChild(el('span', null, 'Email me when a tire cohort opens there.'));
    form.appendChild(mkWrap);

    var err = el('p', 'margin:0;font-size:14px;line-height:1.45;color:#B0512B;font-weight:600');
    err.hidden = true;
    err.setAttribute('role', 'alert');
    form.appendChild(err);

    var submit = el('button', 'height:50px;border:0;border-radius:12px;background:#1E9E63;' +
      'color:#fff;font-size:15.5px;font-weight:650;font-family:inherit;cursor:pointer;' +
      'transition:background .15s', 'Add my city');
    submit.type = 'submit';
    form.appendChild(submit);

    form.appendChild(el('p', 'margin:0;font-size:13px;line-height:1.5;color:#5A665D',
      'This is not a sign-up and nothing is charged. It is a vote for where the next cohort opens.'));

    var done = el('div', 'text-align:center;padding:6px 0');
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
      if (!CITY_RE.test(cityValue)) return fail('Add the city you would like a cohort in.', city);
      if (!prov.value) return fail('Choose the province it is in.', prov);
      if (!email.value || email.value.indexOf('@') < 1) {
        return fail('Add an email so we can tell you when it opens.', email);
      }

      submit.disabled = true;
      submit.textContent = 'Adding…';

      W.submitForm('/city-request', {
        city: cityValue,
        province: prov.value,
        email: email.value.trim(),
        postal: postal.value.trim(),
        poolingFor: 'tires',
        marketing: mk.checked ? 'yes' : ''
      }).then(function () {
        form.hidden = true;
        title.textContent = 'Your city is counted';
        sub.textContent = '';
        done.textContent = '';
        done.appendChild(el('p', 'font-size:15px;line-height:1.6;color:#3B4740;margin:0 0 18px',
          'Thanks. We have added ' + cityValue + ' to the list, and we will write to you if a ' +
          'tire cohort opens there.'));
        var back = el('button', 'height:48px;padding:0 24px;border:0;border-radius:12px;' +
          'background:#1E9E63;color:#fff;font-size:15px;font-weight:650;font-family:inherit;' +
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

    root = { overlay: overlay, city: city, prov: prov, email: email };
    return root;
  }

  /* A tile knows its own city and province; the button under them knows
     neither and opens the form empty. Either way the reader lands on the
     first field they still have to fill. */
  function show(e) {
    if (e) e.preventDefault();
    var t = e && e.currentTarget;
    lastFocus = t || document.activeElement;
    var r = root || build();
    var preCity = t ? (t.getAttribute('data-city-request') || '') : '';
    var preProv = t ? (t.getAttribute('data-province') || '') : '';
    if (preCity) { r.city.value = preCity; r.prov.value = preProv; }
    r.overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    (preCity ? r.email : r.city).focus();
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
