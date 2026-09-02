'use strict';

/**
 * D3 option (a): THE FACT OF A BID, NEVER ITS CONTENT.
 *
 * Permitted: which partner, which cohort, which revision, the receipt, when.
 * Refused: price, tiers, discount_mix, guarantee months, equipment, commitment
 * cap, payload hash. Not one of them appears below, and because this is an
 * allowlist, a call site that starts sending prices tomorrow changes nothing.
 *
 * This is the one serialiser where the refusal is the feature. A sealed bid
 * reaching another partner is the single failure this business cannot have, and
 * a CRM is a surface built for sharing. `scripts/test-crm-serialisers.mjs`
 * passes a full price-bearing bid through this and asserts the output by field
 * list equality, not by spot check.
 */
module.exports = (d) => ({
  org_id: d.org_id || null,
  org_name: d.org_name || null,
  campaign_id: d.campaign_id || d.cohort || null,
  region: d.region || null,
  event: d.event || null,
  revision: d.revision == null ? null : Number(d.revision),
  receipt: d.receipt || null,
  tier_count: d.tier_count == null ? null : Number(d.tier_count),
  submitted_at: d.submitted_at || null,
});
