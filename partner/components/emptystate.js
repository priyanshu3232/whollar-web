/* Empty states that do not pretend.
 *
 * "No data" and "not built" look identical to a partner, and only one of them
 * is worth waiting for. Every empty state here names what will fill it and
 * what has to happen first, which is also why none of them is reusable as a
 * generic "nothing here" card: the sentence is the point.
 */

import { esc } from '../core/format.js';

/**
 * @param {string} title
 * @param {string} body   trusted HTML, written in this codebase, never a
 *                        server string. Anything from the server goes through
 *                        esc() at the call site.
 * @param {string} [cta]  trusted HTML for a button or link
 * @param {string} [icon] trusted inline SVG, sized by `.empty svg` in app.css
 */
export function empty(title, body, cta, icon) {
  return '<section class="card"><div class="empty">'
    + (icon || '')
    + '<h3>' + esc(title) + '</h3>'
    + '<p>' + body + '</p>'
    + (cta || '')
    + '</div></section>';
}

/* The one illustrated empty state. A waiting clock, not a "no results" glyph:
   the bid record is not missing anything, it has not started yet. Inline
   because the global CSP allows no external assets on this surface and a
   64 pixel icon is not worth a request. */
export var CLOCK = '<svg viewBox="0 0 80 80" fill="none" aria-hidden="true">'
  + '<circle cx="40" cy="40" r="33" stroke="#CBDCCE" stroke-width="3"/>'
  + '<path d="M40 24v16l11 7" stroke="#C29B3C" stroke-width="3.5" stroke-linecap="round"/></svg>';

/**
 * The forward-looking variant. §8.7: when a surface would render only zeros or
 * only dashes, render what is coming and when instead. A stat grid of four
 * zeros is the state most likely to make a new partner close the tab.
 */
export function approaching(eyebrow, title, body, extra) {
  return '<section class="card">'
    + '<span class="eyebrow gld">' + esc(eyebrow) + '</span>'
    + '<h3>' + esc(title) + '</h3>'
    + '<p class="cardnote">' + body + '</p>'
    + (extra || '')
    + '</section>';
}

/** A button that navigates to another view. */
export function goTo(view, label, cls) {
  return '<button class="' + (cls || 'btn') + '" type="button" data-action="nav" data-view="' + esc(view) + '">'
    + esc(label) + '</button>';
}
