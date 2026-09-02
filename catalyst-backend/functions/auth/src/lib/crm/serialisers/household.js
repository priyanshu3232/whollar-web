'use strict';

/**
 * A household, D2's allowlist exactly.
 *
 * NOT HERE, and each for its own reason. Street address, unit and buzzer: never
 * collected against a household except in `provider_orders`, where they were
 * released to one partner for one install visit. Bill uploads and documents: the
 * most sensitive thing this business holds and CRM answers no question with
 * them. The referral CODE: D2 permits the presence of a referral, not the token,
 * so it becomes a boolean here and the code itself stops at this line.
 */
module.exports = (d) => ({
  first_name: d.first_name || null,
  last_name: d.last_name || null,
  email: d.email || null,
  phone: d.phone || null,
  postal: d.postal || null,
  fsa: d.fsa || null,
  province: d.province || null,
  city: d.city || null,
  provider: d.provider || null,
  speed_tier: d.speed_tier || null,
  cohort_status: d.cohort_status || null,
  user_type: d.user_type || null,
  /* Presence, never the token. D2. */
  has_referral: Boolean(d.referred_by || d.referral_code || d.has_referral),
});
