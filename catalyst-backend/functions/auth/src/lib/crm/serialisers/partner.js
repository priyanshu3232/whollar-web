'use strict';

/**
 * A founding partner company. Three approval states, not the sixteen the brief
 * assumed: see docs/crm-sync-audit.md premise 2.
 *
 * No rates and no fees. `provider_orgs.lead_rate` is being added as a per-company
 * override of the success fee and is money, which D1 as amended keeps out of CRM
 * entirely until the billing build settles it.
 */
module.exports = (d) => ({
  org_id: d.org_id || null,
  org_name: d.org_name || null,
  previous_name: d.previous_name || null,
  email_domain: d.email_domain || null,
  approval_status: d.approval_status || d.decision || null,
  decision_reason: d.reason || null,
  application_state: d.application_state || null,
  terms_version: d.doc_version || null,
  billing_state: d.billing_state || d.method || null,
  billing_email: d.billing_email || null,
  billing_contact: d.billing_contact || null,
  coverage_region: d.coverage_region || null,
  coverage_status: d.coverage_status || null,
});
