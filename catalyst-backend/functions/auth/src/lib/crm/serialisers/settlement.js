'use strict';

/**
 * A settlement statement: that one was issued, paid or failed, and for which
 * partner and period. No amounts, per D1 as amended and the "Deferred to
 * billing build" section of docs/crm-sync-decisions.md.
 */
module.exports = (d) => ({
  statement_key: d.statement_key || null,
  org_id: d.org_id || null,
  org_name: d.org_name || null,
  state: d.state || d.event || null,
  period: d.period || null,
  issued_at: d.issued_at || null,
  paid_at: d.paid_at || null,
  failure_reason: d.failure_reason || null,
});
