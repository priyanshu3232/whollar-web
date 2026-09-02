'use strict';

/**
 * A switch order, acceptance through activation.
 *
 * NO PRICE, and this one is worth stating because a call site does send one.
 * `routes/campaigns.js` passes the accepted price, which is a real thing the
 * household agreed to; it is also the winning bid's price for that tier, and
 * D1 as amended keeps money out of CRM until the billing build settles the
 * column type and cents-exact arithmetic. The allowlist drops it without the
 * call site having to know, which is the arrangement working as intended.
 *
 * NO ADDRESS and NO MOBILE. `provider_orders` is the only table holding a
 * household's address against a partner, and only because that household ticked
 * a release for one install visit.
 */
module.exports = (d) => ({
  order_key: d.order_key || null,
  order_no: d.order_no || null,
  campaign_id: d.campaign_id || d.cohort || null,
  region: d.region || null,
  org_id: d.org_id || null,
  state: d.state || d.event || null,
  tier: d.tier || null,
  from_tier: d.from_tier || null,
  fsa: d.fsa || null,
  slot_at: d.slot_at || null,
  activated_at: d.activated_at || null,
  release_reason: d.release_reason || null,
});
