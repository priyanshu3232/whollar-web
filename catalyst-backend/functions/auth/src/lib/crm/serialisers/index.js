'use strict';

/**
 * The allowlist, one serialiser per entity type.
 *
 * D2 as amended 2026-09-02: this is THE control on what leaves Catalyst. Each
 * serialiser names every field permitted for its entity. A field not named here
 * does not exist as far as CRM is concerned, whatever a call site passes and
 * whatever it happens to be called. The key-name scrub in outbox.js runs after
 * these and is a backstop, not the control: it catches a field a serialiser
 * wrongly named, which is a different failure from a field nobody thought about.
 *
 * WHY A WHITELIST AND NEVER A BLACKLIST. A blacklist is a list of the mistakes
 * somebody has already thought of. The day a developer adds `street_address` to
 * `users` and spreads the row into a payload, a blacklist has to have predicted
 * the column name; a whitelist has already refused it.
 *
 * Each serialiser is `(data) => object`. They are pure, they never read the
 * Data Store, and they never throw: an absent field is absent, not an error.
 */

const household = require('./household');
const cohort = require('./cohort');
const cohortMembership = require('./cohort_membership');
const partner = require('./partner');
const partnerContact = require('./partner_contact');
const sealedBid = require('./sealed_bid');
const switchOrder = require('./switch_order');
const settlement = require('./settlement');

const SERIALISERS = Object.freeze({
  household,
  cohort,
  cohort_membership: cohortMembership,
  partner,
  partner_contact: partnerContact,
  sealed_bid: sealedBid,
  switch_order: switchOrder,
  settlement,
});

const ENTITY_TYPES = Object.freeze(Object.keys(SERIALISERS));

/**
 * Keep only what this entity's serialiser names.
 *
 * An unknown entity type returns `null` rather than the payload: refusing to
 * serialise is the safe direction, and outbox.js turns that into a refusal to
 * enqueue. Passing the payload through unfiltered because nobody wrote a
 * serialiser yet would be the exact failure this module exists to prevent.
 */
function serialise(entityType, data) {
  const fn = SERIALISERS[entityType];
  if (typeof fn !== 'function') return null;
  const out = fn(data || {});
  /* Undefined is noise on the wire and reads as a field we tried to send and
     failed to. Null is a real answer, "we know, and it is empty", and stays. */
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

module.exports = { serialise, SERIALISERS, ENTITY_TYPES };
