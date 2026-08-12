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
 */
export function empty(title, body, cta) {
  return '<section class="card"><div class="empty">'
    + '<h3>' + esc(title) + '</h3>'
    + '<p>' + body + '</p>'
    + (cta || '')
    + '</div></section>';
}

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
