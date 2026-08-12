'use strict';

/**
 * Money, as a canonical string.
 *
 * WHY STRINGS. The Catalyst console's Int column has no cents and nothing is
 * summed server side in ZCQL, so every amount in this system is stored in a
 * varchar. That is a real constraint, recorded in scripts/create-tables.md,
 * and it means the one thing that must not drift is how a number becomes that
 * string. This was previously a private helper inside routes/desk.js; bids,
 * statements and delivery fees all need it, and three copies of a rounding
 * rule is three chances to round differently.
 *
 * Lifted verbatim from desk.js so bid parsing is unchanged.
 */

/**
 * A dollar amount as a canonical string, or null if it is not one.
 * Rejects zero and negatives: every amount in this system is a price or a fee,
 * and "free" is expressed by the absence of a line, not by a zero on one.
 */
function money(value, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return String(Math.round(n * 100) / 100);
}

/**
 * Sum canonical strings and return one. In JS, not ZCQL, because the datastore
 * cannot sum a varchar. Cents are summed as integers so 0.1 + 0.2 cannot
 * appear on an invoice.
 */
function sum(values) {
  const cents = (values || []).reduce((t, v) => {
    const n = Number(v);
    return Number.isFinite(n) ? t + Math.round(n * 100) : t;
  }, 0);
  return String(cents / 100);
}

/** Multiply a canonical amount by a whole count. Same integer-cents rule. */
function times(value, count) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isFinite(count)) return null;
  return String(Math.round(n * 100) * Math.trunc(count) / 100);
}

module.exports = { money, sum, times };
