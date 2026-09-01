/* Whollar select: the console's dropdown, everywhere else on the site.
 *
 * WHY THIS FILE EXISTS
 * The partner console's coverage picker grew a real dropdown (partner/app.css
 * `.msel`): a bordered trigger that reads the whole selection back, and a
 * panel of stacked rows that a partner can see all of at once. Every other
 * dropdown on the site was a bare native <select>, so the same site had two
 * unrelated dropdowns depending on which door you came in by, and the native
 * one cannot be styled below its own border: the option list is drawn by the
 * operating system.
 *
 * So the native control stays and stops being the thing you look at. This
 * enhances each <select> into the console's markup, keeps the real <select>
 * in the DOM as the value holder, and mirrors every pick back into it. That
 * matters more than it sounds: page code all over the site reads
 * `$('#prov').value`, sets it, and listens for 'change' on it. None of that
 * changes here. The select is still the answer; it is just no longer the
 * picture.
 *
 * MULTI VS SINGLE. `<select multiple>` gets checkboxes and a panel that stays
 * open across picks, exactly like the speed-tier control. A single select
 * gets the same trigger, the same panel, the same rows, and NO checkbox: a box
 * you can only ever tick one of is a radio pretending to be a checkbox. The
 * chosen row is marked with a trailing check and the accent weight instead,
 * and the panel closes on the pick, because there is nothing left to say.
 *
 * Loaded as a classic script, like everything else outside partner/. Exposes
 * window.WHOLLAR.select. The CSS ships inside this file rather than in each
 * page's <style> block, so a page opts in by loading the script and nothing
 * else; the global CSP grants style-src 'unsafe-inline', which is what makes
 * that legal.
 */
(function (root, doc) {
  'use strict';

  var W = root.WHOLLAR || (root.WHOLLAR = {});
  if (W.select && W.select.__init) return;

  /* ================================================================== *
   * 1. THE LOOK
   * ------------------------------------------------------------------
   * A transcription of partner/app.css `.msel` / `.cechips`, with the
   * colours read from whichever tokens the host page happens to define.
   * The console names its green --forest2 and the static pages name theirs
   * --accent, so every colour falls through a chain: the component's own
   * override first, then the console token, then the site token, then a
   * literal. A page that defines neither still gets the console's palette.
   * ================================================================== */

  var CSS = [
    '.wsel{position:relative;min-width:0;text-align:left}',
    /* The native control is the value, so it must stay in the DOM and stay
       in the form. Hidden by clip rather than display:none, which would take
       it out of form submission in older engines, and pointer-events:none so
       a click can never land on the thing nobody can see. */
    '.wsel>select.wselnative{position:absolute;width:1px;height:1px;margin:0;',
    'padding:0;border:0;opacity:0;overflow:hidden;pointer-events:none;',
    'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}',

    '.wseltrig{display:flex;align-items:center;gap:8px;width:100%;',
    'background:var(--wsel-bg,#fff);',
    'border:1.5px solid var(--wsel-line,var(--line,#E1DBCB));',
    'border-radius:var(--wsel-radius,10px);padding:9px 11px;font:inherit;',
    'font-size:var(--wsel-size,13.5px);line-height:1.35;',
    'color:var(--wsel-ink,var(--ink,#2B3A33));text-align:left;cursor:pointer}',
    '.wseltrig:hover{border-color:var(--wsel-accent,var(--forest2,var(--accent,#1E5741)))}',
    '.wseltrig[aria-expanded="true"]{border-color:var(--wsel-open,var(--gold,#C29B3C))}',
    '.wseltrig:focus-visible{outline:2px solid var(--wsel-accent,var(--forest2,var(--accent,#1E5741)));outline-offset:2px}',
    '.wsel.wsel-off .wseltrig{cursor:not-allowed;opacity:.55}',
    /* Pages mark a bad answer by putting .err on the field, and some of them
       put it on the control itself, which is now the invisible one. */
    '.wsel:has(>select.err) .wseltrig{border-color:var(--wsel-err,var(--warn,var(--terra,#C2643B)))}',
    '.wseltxt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;',
    'white-space:nowrap;font-weight:600}',
    '.wseltxt.ph{color:var(--wsel-ph,#8A968F);font-weight:400}',
    '.wselcar{flex:none;width:0;height:0;border-left:4.5px solid transparent;',
    'border-right:4.5px solid transparent;border-top:5px solid #8B958D;',
    'transition:transform .12s ease}',
    '.wseltrig[aria-expanded="true"] .wselcar{transform:rotate(180deg)}',

    /* FIXED, and placed by place() below rather than by `top:100%`. Out of the
       flow entirely, like the console's `.mselmenu`, and for the same reason it
       is: an absolutely positioned panel is clipped by any scrolling ancestor,
       and it is stretched to the trigger's own width by `left:0;right:0`. In a
       form grid neither shows. In a dense table cell both do, and together they
       are a dropdown you cannot read: the dashboard's survey tables scroll
       horizontally, so a carrier list opened in a 76px cell was drawn 76px wide
       and then cut off at the cell's edge. Viewport coordinates escape every
       overflow on the way up, and a min-width rather than a stretch lets an
       11-name list hang off a narrow cell at its own width.

       It stays a child of .wsel and does NOT move to <body>. Fixed already
       defeats overflow; what it must not defeat is the host's stacking context,
       because a dialog draws its own dropdown above itself only while the panel
       is inside it. A body-level panel would have to outrank every overlay on
       the site by z-index to do the same, and then it would outrank them all
       when it should not. */
    '.wselpanel{position:fixed;z-index:60;',
    'background:#fff;border:1.5px solid var(--wsel-line,var(--line,#E1DBCB));',
    'border-radius:10px;box-shadow:0 6px 18px rgba(31,45,38,.08);',
    'overflow:hidden auto}',
    '.wselpanel[hidden]{display:none}',

    '.wselhead{display:flex;align-items:baseline;justify-content:space-between;',
    'gap:10px;padding:7px 11px;background:#F8F5EC;',
    'border-bottom:1px solid var(--wsel-line,var(--line,#E1DBCB));font-size:10px;',
    'font-weight:700;letter-spacing:.08em;text-transform:uppercase;',
    'color:var(--wsel-sub,var(--sub,var(--ink-2,#5B655C)))}',
    '.wselall{border:0;background:none;padding:0;font:inherit;font-size:10px;',
    'font-weight:700;letter-spacing:0;text-transform:none;cursor:pointer;',
    'color:var(--wsel-accent,var(--forest2,var(--accent,#1E5741)))}',
    '.wselall:hover{text-decoration:underline}',

    '.wselgrp{padding:8px 11px 4px;font-size:10px;font-weight:700;',
    'letter-spacing:.08em;text-transform:uppercase;',
    'color:var(--wsel-sub,var(--sub,var(--ink-2,#5B655C)))}',

    '.wselopt{display:flex;align-items:center;gap:9px;width:100%;text-align:left;',
    'border:0;border-bottom:1px solid var(--wsel-line,var(--line,#E1DBCB));',
    'border-radius:0;padding:10px 11px;font:inherit;',
    'font-size:var(--wsel-size,13.5px);font-weight:400;background:#fff;',
    'color:var(--wsel-ink,var(--ink,#2B3A33));cursor:pointer}',
    '.wselopt:last-child{border-bottom:0}',
    /* focus-visible, not focus: opening with the mouse must not paint a row as
       though it were already the answer. */
    '.wselopt:hover,.wselopt:focus-visible{background:var(--wsel-tint,var(--tint,var(--mint,#E4F4EC)));outline:none}',
    '.wselopt[disabled]{opacity:.45;cursor:not-allowed}',
    '.wselopt.on{color:var(--wsel-accent,var(--forest2,var(--accent,#1E5741)));font-weight:600}',
    /* The checkbox is the multi-select's alone. */
    '.wsel-multi .wselopt::before{content:"";flex:none;width:15px;height:15px;',
    'border:1.5px solid var(--wsel-line,var(--line,#E1DBCB));border-radius:4px;background:#fff}',
    '.wsel-multi .wselopt.on::before{content:"\\2713";display:grid;place-items:center;',
    'font-size:10px;font-weight:800;color:#fff;',
    'background:var(--wsel-accent,var(--forest2,var(--accent,#1E5741)));',
    'border-color:var(--wsel-accent,var(--forest2,var(--accent,#1E5741)))}',
    /* One answer, so no box: a trailing check says which row it is. */
    '.wsel-one .wselopt.on::after{content:"\\2713";margin-left:auto;flex:none;',
    'font-size:11px;font-weight:800}',

    /* Thumbs are wider than pointers. */
    '@media (max-width:640px){.wselopt{padding:12px 12px}',
    '.wseltrig{padding:11px 12px}}'
  ].join('');

  function injectCss() {
    if (doc.getElementById('wsel-css')) return;
    var s = doc.createElement('style');
    s.id = 'wsel-css';
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  /* ================================================================== *
   * 2. READING THE NATIVE CONTROL
   * ================================================================== */

  var seq = 0;

  function opts(sel) {
    return Array.prototype.slice.call(sel.options);
  }

  /* A leading valueless option is a placeholder ("Choose…"), not an answer.
     It becomes the trigger's empty wording and is left out of the panel: a
     row that means "nothing" reads as a choice, and this control already
     starts on nothing. Any LATER valueless option is a real answer (some
     forms carry a "Not sure" with no value) and stays in the list. */
  function placeholder(sel) {
    var first = sel.options[0];
    return (first && first.value === '' && !first.disabled) ? first : null;
  }

  function chosen(sel) {
    return opts(sel).filter(function (o) { return o.selected && !isPlaceholder(sel, o); });
  }

  function isPlaceholder(sel, o) {
    return placeholder(sel) === o;
  }

  /** What the trigger says: nothing, the answer, the answers, or the lot. */
  function triggerText(sel, ui) {
    var on = chosen(sel);
    if (!on.length) return { text: ui.empty, ph: true };
    if (sel.multiple && on.length === ui.count && ui.all) return { text: ui.all, ph: false };
    return { text: on.map(function (o) { return o.text; }).join(', '), ph: false };
  }

  /* ================================================================== *
   * 3. BUILDING AND SYNCING ONE CONTROL
   * ================================================================== */

  function build(sel) {
    if (sel.__wsel || sel.getAttribute('data-wsel') === 'off') return null;
    if (sel.closest && sel.closest('.wsel')) return null;

    injectCss();

    var multi = !!sel.multiple;
    var ph = placeholder(sel);
    var ui = {
      empty: sel.getAttribute('data-wsel-empty')
        || (ph ? ph.text : (multi ? 'Choose' : 'Choose\u2026')),
      all: sel.getAttribute('data-wsel-all') || (multi ? 'All selected' : ''),
      count: 0
    };

    var id = sel.id || ('wsel' + (++seq));
    var panelId = id + '-wselp';

    /* Whatever the page reserved around this control, it reserved for the box
       on screen, and that box is about to be the wrapper. Margins and a
       max-width therefore move across; everything else (border, padding,
       background) is the component's own and is deliberately dropped. Read
       before anything is hidden, so these are the values the page meant. */
    var cs = root.getComputedStyle(sel);
    var box = {
      marginTop: cs.marginTop, marginRight: cs.marginRight,
      marginBottom: cs.marginBottom, marginLeft: cs.marginLeft,
      maxWidth: cs.maxWidth === 'none' ? '' : cs.maxWidth
    };

    var wrap = doc.createElement('div');
    wrap.className = 'wsel ' + (multi ? 'wsel-multi' : 'wsel-one');
    /* An inline style on a <select> is layout intent ("max-width:340px"), so
       it moves across whole. Class-based rules stay where they are: they
       describe a control that is still in the DOM and still the value. */
    if (sel.getAttribute('style')) {
      wrap.setAttribute('style', sel.getAttribute('style'));
      sel.removeAttribute('style');
    }
    Object.keys(box).forEach(function (k) { if (box[k]) wrap.style[k] = box[k]; });
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('wselnative');
    sel.setAttribute('tabindex', '-1');
    sel.setAttribute('aria-hidden', 'true');

    var trig = doc.createElement('button');
    trig.type = 'button';
    trig.className = 'wseltrig';
    trig.setAttribute('aria-haspopup', 'listbox');
    trig.setAttribute('aria-expanded', 'false');
    trig.setAttribute('aria-controls', panelId);
    var lbl = labelFor(sel);
    if (lbl) trig.setAttribute('aria-label', lbl);
    trig.innerHTML = '<span class="wseltxt"></span><i class="wselcar" aria-hidden="true"></i>';
    wrap.appendChild(trig);

    var panel = doc.createElement('div');
    panel.className = 'wselpanel';
    panel.id = panelId;
    panel.hidden = true;
    wrap.appendChild(panel);

    /* The multi-select's panel chrome: the group's name, which is no longer on
       screen once the panel covers the label, and select-all, because "all of
       them" is the commonest multi answer there is. */
    var allBtn = null;
    if (multi) {
      var head = doc.createElement('div');
      head.className = 'wselhead';
      head.innerHTML = '<span></span>';
      head.firstChild.textContent = lbl || ui.empty;
      allBtn = doc.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'wselall';
      head.appendChild(allBtn);
      panel.appendChild(head);
    }

    var list = doc.createElement('div');
    list.className = 'wsellist';
    list.setAttribute('role', 'listbox');
    if (multi) list.setAttribute('aria-multiselectable', 'true');
    panel.appendChild(list);

    var ctl = {
      sel: sel, wrap: wrap, trig: trig, panel: panel, list: list,
      all: allBtn, multi: multi, ui: ui
    };
    sel.__wsel = ctl;
    render(ctl);
    wire(ctl);
    watchValue(ctl);
    return ctl;
  }

  /** The visible text of the <label> pointing at this select, if there is one. */
  function labelFor(sel) {
    var l = (sel.id && doc.querySelector('label[for="' + cssEsc(sel.id) + '"]'))
      || (sel.closest && sel.closest('label'));
    if (!l) return '';
    /* A wrapping label holds the control itself; take only its own text. */
    var t = Array.prototype.slice.call(l.childNodes)
      .filter(function (n) { return n.nodeType === 3 || (n.nodeType === 1 && !n.querySelector('select')); })
      .map(function (n) { return n.textContent; }).join(' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  function cssEsc(s) {
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  /** Rebuild the option rows from the native control. */
  function render(ctl) {
    var sel = ctl.sel, ph = placeholder(sel), n = 0, html = [];
    var kids = Array.prototype.slice.call(sel.children);
    kids.forEach(function (node) {
      if (node.tagName === 'OPTGROUP') {
        html.push('<div class="wselgrp"></div>');
        Array.prototype.slice.call(node.children).forEach(function (o) {
          if (o !== ph) { html.push(row(o)); n++; }
        });
      } else if (node.tagName === 'OPTION' && node !== ph) {
        html.push(row(node));
        n++;
      }
    });
    ctl.ui.count = n;
    ctl.sig = signature(sel);
    ctl.list.innerHTML = html.join('');

    /* Text is set as text, never as markup: an option label is content, and
       these lists carry provider names that arrive from a bill reader. */
    var i = 0, gi = 0;
    var rows = ctl.list.querySelectorAll('.wselopt');
    var grps = ctl.list.querySelectorAll('.wselgrp');
    kids.forEach(function (node) {
      if (node.tagName === 'OPTGROUP') {
        if (grps[gi]) grps[gi].textContent = node.label || '';
        gi++;
        Array.prototype.slice.call(node.children).forEach(function (o) {
          if (o !== ph) { fill(rows[i++], o); }
        });
      } else if (node.tagName === 'OPTION' && node !== ph) {
        fill(rows[i++], node);
      }
    });
    sync(ctl);

    function row(o) {
      return '<button type="button" class="wselopt" role="option"'
        + (o.disabled ? ' disabled' : '') + ' aria-selected="false"></button>';
    }
    function fill(el, o) {
      if (!el) return;
      el.textContent = o.text;
      el.__opt = o;
    }
  }

  /**
   * Read the native control back into the trigger and the rows.
   *
   * The panel is where the answer is made and the trigger is the only part of
   * it still on screen once it closes, so a pick that does not reach the
   * trigger is an answer the visitor cannot see.
   */
  function sync(ctl) {
    var t = triggerText(ctl.sel, ctl.ui);
    var span = ctl.trig.querySelector('.wseltxt');
    span.textContent = t.text;
    span.classList.toggle('ph', t.ph);
    ctl.wrap.classList.toggle('wsel-off', !!ctl.sel.disabled);
    ctl.trig.disabled = !!ctl.sel.disabled;

    var on = 0;
    Array.prototype.slice.call(ctl.list.querySelectorAll('.wselopt')).forEach(function (el) {
      var picked = !!(el.__opt && el.__opt.selected);
      el.classList.toggle('on', picked);
      el.setAttribute('aria-selected', picked ? 'true' : 'false');
      if (picked) on++;
    });
    if (ctl.all) ctl.all.textContent = (on === ctl.ui.count && on) ? 'Clear all' : 'Select all';
  }

  /** Push a change made in the panel back out to whoever is listening. */
  function emit(sel) {
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ================================================================== *
   * 4. BEHAVIOUR
   * ================================================================== */

  /* The gap between trigger and panel, and the margin the panel keeps off
     every edge of the window. */
  var GAP = 6, EDGE = 8;
  /* The panel's own ceiling, unchanged from the `max-height:min(320px,58vh)`
     this replaced. It is applied in place() now because the height decides
     which side the panel opens on, and a rule in the stylesheet cannot be read
     back before it has been laid out. */
  function cap() { return Math.min(320, root.innerHeight * 0.58); }

  /**
   * Put the panel where it fits, in viewport coordinates.
   *
   * Below the trigger unless the list does not fit there AND there is more room
   * above, which is the whole of the flip rule: a panel flipped onto a side
   * with even less space is two bugs rather than one. Whichever side wins, the
   * height is then capped to what that side actually has, so the panel scrolls
   * internally instead of running off the screen, and the top is clamped so a
   * trigger squeezed against an edge still gets a panel that is fully on it.
   */
  function place(ctl) {
    var panel = ctl.panel, t = ctl.trig.getBoundingClientRect();
    var vw = root.innerWidth, vh = root.innerHeight;
    /* Anchored before it is measured. A fixed box with `left:auto` falls back
       to its static position, and measuring it there means measuring a panel
       that may be wrapping against the window's right edge rather than the one
       we are about to place. Nothing paints between here and the final values
       below, so this costs a reflow and not a flicker. */
    panel.style.left = Math.max(EDGE, Math.round(t.left)) + 'px';
    panel.style.top = Math.round(t.bottom + GAP) + 'px';
    /* Measured with the cap lifted, so "does it fit below" is asked of the
       list's real height and not of the height it was last squeezed into. */
    panel.style.maxHeight = '';
    panel.style.minWidth = Math.round(t.width) + 'px';
    panel.style.maxWidth = Math.max(160, vw - 2 * EDGE) + 'px';
    var want = panel.offsetHeight;
    var below = vh - t.bottom - GAP - EDGE, above = t.top - GAP - EDGE;
    var up = want > below && above > below;
    var h = Math.min(want, Math.max(96, Math.min(cap(), up ? above : below)));
    panel.style.maxHeight = h + 'px';
    var top = up ? t.top - GAP - h : t.bottom + GAP;
    panel.style.top = Math.max(EDGE, Math.min(top, vh - EDGE - h)) + 'px';
    panel.style.left = Math.max(EDGE, Math.min(t.left, vw - EDGE - panel.offsetWidth)) + 'px';
    /* Kept as a class as well, so a host page can still tell the two
       directions apart, even though placement no longer depends on it. */
    ctl.wrap.classList.toggle('wsel-up', up);
  }

  /* A fixed panel does not travel with the thing it is anchored to, so anything
     that moves the trigger has to move the panel too: the page scrolls, dialogs
     scroll, and the survey's tables scroll inside the dialog. Capture phase,
     because a scroll on an ancestor does not bubble. */
  function track(ctl) {
    if (ctl.onmove) return;
    ctl.onmove = function () {
      if (ctl.panel.hidden) return;
      /* The anchor has left the window entirely. A panel pointing at nothing is
         worse than no panel, the same call `.mselmenu` makes. */
      var t = ctl.trig.getBoundingClientRect();
      if (!doc.contains(ctl.trig) || t.bottom < 0 || t.top > root.innerHeight) { close(ctl, false); return; }
      place(ctl);
    };
    root.addEventListener('scroll', ctl.onmove, true);
    root.addEventListener('resize', ctl.onmove);
  }
  function untrack(ctl) {
    if (!ctl.onmove) return;
    root.removeEventListener('scroll', ctl.onmove, true);
    root.removeEventListener('resize', ctl.onmove);
    ctl.onmove = null;
  }

  /**
   * A signature of the option list, so open() can tell whether the page has
   * REPLACED the options since this panel was built.
   *
   * The observer at the foot of this file enhances a select when one is ADDED,
   * which is the wrong event for a list rewritten in place: the dashboard's
   * survey fills its model column once a make is picked, and that panel went on
   * offering "Pick make first" for the rest of the session. Re-reading on open
   * makes it every caller's default rather than something each one has to
   * remember, and refresh() stays for the trigger text, which is on screen
   * before anybody opens anything.
   */
  function signature(sel) {
    var out = sel.options.length + '|';
    for (var i = 0; i < sel.options.length; i++) out += sel.options[i].text + '';
    return out;
  }

  /* `toRow` is true only when the panel was opened from the keyboard. A mouse
     open leaves focus on the trigger, because moving it into the list would
     mark the first row and a marked row reads as a pick already made. */
  function open(ctl, toRow) {
    closeAll(ctl);
    if (ctl.sel.disabled) return;
    if (signature(ctl.sel) !== ctl.sig) render(ctl); else sync(ctl);
    ctl.trig.setAttribute('aria-expanded', 'true');
    ctl.panel.hidden = false;
    place(ctl);
    track(ctl);
    if (!toRow) return;
    var first = ctl.list.querySelector('.wselopt.on') || ctl.list.querySelector('.wselopt:not([disabled])');
    if (first) first.focus();
  }

  function close(ctl, refocus) {
    if (ctl.panel.hidden) return;
    untrack(ctl);
    ctl.trig.setAttribute('aria-expanded', 'false');
    ctl.panel.hidden = true;
    ctl.wrap.classList.remove('wsel-up');
    /* Cleared rather than left behind: the next open measures the list before
       it places it, and last time's height would be the thing it measured. */
    ctl.panel.style.cssText = '';
    if (refocus) ctl.trig.focus();
  }

  function closeAll(except) {
    Array.prototype.slice.call(doc.querySelectorAll('.wsel')).forEach(function (w) {
      var s = w.querySelector('select.wselnative');
      if (s && s.__wsel && s.__wsel !== except) close(s.__wsel, false);
    });
  }

  function wire(ctl) {
    ctl.trig.addEventListener('click', function () {
      if (ctl.panel.hidden) open(ctl); else close(ctl, true);
    });

    ctl.trig.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(ctl, true); }
      /* Escape dismisses the PANEL and stops there. The innermost thing open is
         the thing Escape closes, and the host page above this one is usually a
         dialog with an Escape handler of its own: the survey's is on `document`,
         so without this a member who opened a carrier list and thought better of
         it lost the whole form and everything typed into it. Only swallowed when
         a panel was actually open, so Escape on a closed dropdown still reaches
         the dialog that should handle it. */
      else if (e.key === 'Escape' && !ctl.panel.hidden) { e.stopPropagation(); close(ctl, true); }
    });

    ctl.list.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('.wselopt') : null;
      if (!el || !el.__opt || el.disabled) return;
      pick(ctl, el.__opt);
    });

    ctl.list.addEventListener('keydown', function (e) {
      var rows = Array.prototype.slice.call(ctl.list.querySelectorAll('.wselopt:not([disabled])'));
      var i = rows.indexOf(doc.activeElement);
      /* Same rule as the trigger's Escape above: the panel is the innermost
         overlay, so it consumes the key rather than letting a dialog behind it
         close too. Reached only while the panel is open, since that is the only
         time a row can hold focus. */
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(ctl, true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); step(rows, i, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(rows, i, -1); }
      else if (e.key === 'Home') { e.preventDefault(); if (rows[0]) rows[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); if (rows.length) rows[rows.length - 1].focus(); }
      else if (e.key === 'Tab') close(ctl, false);
    });

    if (ctl.all) {
      ctl.all.addEventListener('click', function () {
        var turnOn = ctl.all.textContent === 'Select all';
        Array.prototype.slice.call(ctl.list.querySelectorAll('.wselopt')).forEach(function (el) {
          if (el.__opt && !el.__opt.disabled) el.__opt.selected = turnOn;
        });
        sync(ctl);
        emit(ctl.sel);
      });
    }

    /* Focus must never come to rest on the clipped control. Two things send
       it there and neither goes through a JS call this file could wrap: a
       click on `label for=`, which the browser resolves internally, and the
       checkup's fail(), which focuses the field it is complaining about. Both
       would leave the visitor staring at a page that looks like it ignored
       them, so the trigger takes the focus instead. */
    ctl.sel.addEventListener('focus', function () { ctl.trig.focus(); });

    /* Whoever else moved the value, the panel is now wrong. Page code that
       prefills a form dispatches 'change' after setting .value, and the ones
       that do not are covered by watchValue below. */
    ctl.sel.addEventListener('change', function () { sync(ctl); });

    var form = ctl.sel.form;
    if (form) form.addEventListener('reset', function () {
      root.setTimeout(function () { sync(ctl); }, 0);
    });
  }

  function step(rows, i, d) {
    if (!rows.length) return;
    var n = i < 0 ? (d > 0 ? 0 : rows.length - 1) : (i + d + rows.length) % rows.length;
    rows[n].focus();
  }

  function pick(ctl, opt) {
    if (ctl.multi) {
      opt.selected = !opt.selected;
      sync(ctl);
      emit(ctl.sel);
      return;
    }
    /* One answer: setting it unsets the last one, and there is nothing more to
       choose, so the panel closes and hands focus back to the trigger. */
    ctl.sel.selectedIndex = Array.prototype.indexOf.call(ctl.sel.options, opt);
    sync(ctl);
    close(ctl, true);
    emit(ctl.sel);
  }

  /**
   * Follow a value set in code.
   *
   * `$('#bu-prov').value = bill.provider` is how half the prefills on this
   * site work, and an assignment fires no event, so without this the native
   * control and the trigger disagree the moment a saved bill loads. The
   * prototype's own accessors still do the work; this only listens.
   */
  function watchValue(ctl) {
    var proto = root.HTMLSelectElement && root.HTMLSelectElement.prototype;
    if (!proto) return;
    ['value', 'selectedIndex'].forEach(function (prop) {
      var d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      try {
        Object.defineProperty(ctl.sel, prop, {
          configurable: true,
          enumerable: d.enumerable,
          get: function () { return d.get.call(this); },
          set: function (v) { d.set.call(this, v); sync(ctl); }
        });
      } catch (e) { /* a sealed element keeps the native accessor: no harm */ }
    });
  }

  /* ================================================================== *
   * 5. THE DOOR
   * ================================================================== */

  /** Enhance every select under `node` that has not opted out. */
  function enhance(node) {
    var scope = node || doc;
    var list = (scope.querySelectorAll ? scope.querySelectorAll('select') : []);
    Array.prototype.slice.call(list).forEach(build);
    if (scope.tagName === 'SELECT') build(scope);
  }

  /** Re-read one control, or all of them, after code changed the selection. */
  function refresh(node) {
    if (node && node.__wsel) { render(node.__wsel); return; }
    Array.prototype.slice.call(doc.querySelectorAll('select.wselnative')).forEach(function (s) {
      if (s.__wsel) render(s.__wsel);
    });
  }

  W.select = { __init: true, enhance: enhance, refresh: refresh, close: closeAll };

  doc.addEventListener('click', function (e) {
    if (!(e.target.closest && e.target.closest('.wsel'))) closeAll(null);
  });
  doc.addEventListener('focusin', function (e) {
    if (!(e.target.closest && e.target.closest('.wsel'))) closeAll(null);
  });

  /* Half these forms are rendered into the page after load, so enhancing once
     at DOMContentLoaded would leave every later dropdown native. The observer
     is what makes this a site-wide rule rather than a per-page call. */
  function start() {
    enhance(doc);
    if (!root.MutationObserver) return;
    var pending = false;
    new root.MutationObserver(function (recs) {
      if (pending) return;
      /* Only a <select> is worth a pass. The partner console ticks a countdown
         into a text node once a second, and each of those is a childList
         record too: without this test the observer would sweep the whole
         document every second for the rest of the session. */
      for (var i = 0; i < recs.length; i++) {
        var added = recs[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'SELECT' || (n.querySelector && n.querySelector('select'))) {
            pending = true;
            root.setTimeout(function () { pending = false; enhance(doc); }, 0);
            return;
          }
        }
      }
    }).observe(doc.documentElement, { childList: true, subtree: true });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(window, document);
