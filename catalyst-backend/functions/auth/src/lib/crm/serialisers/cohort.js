'use strict';

/** A cohort. D1: region, FSA list, stage, promo cliff, household count, winner. */
module.exports = (d) => ({
  campaign_id: d.campaign_id || d.cohort || null,
  region: d.region || null,
  sub: d.sub || null,
  stage: d.stage || d.kind || null,
  target: d.target == null ? null : Number(d.target),
  households: d.households == null ? null : Number(d.households),
  fsas: d.fsas || null,
  promo_cliff_at: d.promo_cliff_at || null,
  winning_partner: d.winning_partner || null,
});
