'use strict';

/**
 * One household's relationship to one cohort. The FSA is the snapshot taken at
 * join time, which is the whole point of the column: where they were when they
 * joined, not where they have moved to since.
 */
module.exports = (d) => ({
  campaign_id: d.campaign_id || d.cohort || null,
  region: d.region || null,
  status: d.status || d.event || null,
  fsa: d.fsa || null,
  joined_at: d.joined_at || null,
  exit_at: d.exit_at || null,
  exit_reason: d.exit_reason || d.reason || null,
  from_cohort: d.from_cohort || null,
  from_region: d.from_region || null,
});
