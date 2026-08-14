/* Text and money, deferring to whollar-core.js wherever it already decides.
 *
 * The prototype was standalone and never loaded core, so it declared its own
 * esc() and money(). Two of those behave DIFFERENTLY from core's, so the swap
 * is a real change and is recorded here rather than discovered later:
 *
 *   esc()    core also escapes the single quote. Strictly safer, and this
 *            console interpolates into single-quoted attributes constantly.
 *
 *   money()  the prototype rendered $95.5 for a half dollar; core renders
 *            $95.50, and still renders $95 for a whole one. Money on this
 *            surface is invoiced, so cents are not optional.
 *
 * Amounts arrive as canonical STRINGS, not integer cents. That is a platform
 * constraint, not a preference: the Catalyst console's Int column has no cents
 * and ZCQL cannot sum a varchar, so every amount in this system is stored as a
 * string and summed in JavaScript as integer cents. See
 * catalyst-backend/functions/auth/src/lib/money.js, which owns the rounding
 * rule for all of it.
 */

function core() {
  return (typeof window !== 'undefined' ? window : globalThis).WHOLLAR || {};
}

/** Escape for HTML text and attribute contexts. */
export function esc(s) {
  var W = core();
  if (W.escapeHtml) return W.escapeHtml(s);
  return String(s === null || s === undefined ? '' : s)
    .replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

/** "$3,610.00" from the canonical string "3610.00". */
export function money(value) {
  var W = core();
  if (W.money) return W.money(value);
  var n = Number(value);
  if (!isFinite(n)) return '';
  return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/** Initials for an avatar. */
export function monogram(s) {
  var W = core();
  if (W.monogram) return W.monogram(s);
  return String(s || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
}

export function titleCase(s) {
  var W = core();
  if (W.titleCase) return W.titleCase(s);
  return String(s || '').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

/** "1 cohort" / "3 cohorts", without the bare number reading as a label. */
export function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : (many || one + 's'));
}

/** A region name to its slug. Mirrors the backend's coverage_key derivation,
    which is `${org_id}:${region-slug}`; getting this wrong is a silent miss
    rather than an error, because the row simply never matches. */
export function regionSlug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
