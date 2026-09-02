'use strict';

/**
 * The field-mapping layer: a serialised payload in, CRM field API names out.
 *
 * THE LAYER THAT WAS MISSING. Before this, an entity row upserted an external id
 * and put everything else in the note body, so a Cohorts record was an id and a
 * paragraph, and nothing in CRM could be filtered, sorted or reported on. The
 * note is not a database. It keeps what has no column and nothing else.
 *
 * Each map returns three things:
 *
 *   fields   written straight onto the record
 *   lookups  { fieldApiName: { entity, id } }, resolved to a CRM record id by
 *            the parent's external id before the write. These are what make the
 *            modules a model rather than eight lists.
 *   noted    keys the map deliberately leaves for the note, so the note builder
 *            can carry them and nothing is silently dropped
 *
 * WHY THIS LIVES IN crmSync AND NOT IN auth. The serialisers run at enqueue and
 * answer "what may leave Catalyst". This runs at delivery and answers "where
 * does it go in this org's CRM". They are different questions with different
 * blast radii: a serialiser mistake is a privacy incident, a field map mistake
 * is a record that looks wrong. Keeping them apart also means the field names,
 * which are one org's configuration, never reach the function that holds the
 * household data.
 */

/** `provider_orders.state` to the Deal stage picklist. The table in
 *  docs/crm-field-build.md is the same mapping, and both must move together. */
const STAGE = Object.freeze({
  acc: 'Accepted',
  bkd: 'Booked',
  act: 'Closed Won',
  rel: 'Closed Lost',
  noshow: 'No Show',
  access: 'Access Failed',
  linefail: 'Line Failed',
});

/** Zoho date fields want `YYYY-MM-DD`, not a datetime. */
function dateOnly(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Today, for a mandatory Closing_Date with nothing better to put in it. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * `${campaign_id}:${user_id}` is the shape of both `order_key` and the
 * membership key, and the household id is the second half.
 *
 * Deriving it here rather than sending it is deliberate. `routes/delivery.js` is
 * partner-facing and does not carry the household's identity, correctly. The key
 * itself is already allowlisted, so this parses a field that was permitted to
 * leave rather than widening what leaves, and it is what lets a Deal link to the
 * household Contact instead of floating unattached.
 */
function householdIdFrom(key) {
  const s = String(key || '');
  const i = s.indexOf(':');
  return i > 0 ? s.slice(i + 1) : null;
}

/** Drop keys with nothing in them: an explicit null clears a CRM field, and
 *  clearing a field because this event did not mention it is data loss. */
function present(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

const MAPS = Object.freeze({
  /* ---- Contacts ---- */
  household: (d) => ({
    fields: present({
      First_Name: d.first_name,
      /* Mandatory on Contacts. The email is a poor name and a worse absence. */
      Last_Name: d.last_name || d.email || null,
      Email: d.email,
      Phone: d.phone,
      Mailing_City: d.city,
      /* DEFECT 1. Zip_Code and State are LEAD field names. On a Contact they are
         refused, and offendingField would drop them, so the postal code was
         being silently lost on every household. */
      Mailing_State: d.province,
      Mailing_Zip: d.postal,
      Whollar_Contact_Type: 'Founding Member',
      Whollar_FSA: d.fsa,
      Whollar_Provider: d.provider,
      Whollar_Speed_Tier: d.speed_tier,
      Whollar_Cohort_Status: d.cohort_status,
    }),
    /* A checkbox is false, not absent, so it is set outside present(). */
    always: { Whollar_Has_Referral: Boolean(d.has_referral) },
    lookups: {},
    noted: [],
  }),

  partner_contact: (d) => ({
    fields: present({
      First_Name: d.first_name,
      Last_Name: d.last_name || d.email || null,
      Email: d.email,
      Phone: d.phone,
      Whollar_Contact_Type: 'Partner Contact',
      Whollar_Partner_Role: d.role,
    }),
    always: {},
    lookups: d.org_id ? { Account_Name: { entity: 'partner', id: d.org_id } } : {},
    noted: ['approval_status'],
  }),

  /* ---- Accounts ---- */
  partner: (d) => ({
    fields: present({
      Account_Name: d.org_name,
      Whollar_Email_Domain: d.email_domain,
      Whollar_Approval_Status: d.approval_status,
      Whollar_Decision_Reason: d.decision_reason,
      Whollar_Application_State: d.application_state,
      Whollar_Terms_Version: d.terms_version,
      Whollar_Billing_State: d.billing_state,
      Whollar_Billing_Email: d.billing_email,
      Whollar_Billing_Contact: d.billing_contact,
      /* A multi-select takes an array. One region per event, and a write
         REPLACES the set rather than adding to it: see the coverage decision
         of 2026-09-02 for why that is accepted for now. */
      Whollar_Coverage: d.coverage_region ? [d.coverage_region] : undefined,
    }),
    always: {},
    lookups: {},
    noted: ['previous_name', 'coverage_status'],
  }),

  /* ---- Cohorts ---- */
  cohort: (d, externalId) => ({
    /* DEFECT 2. This produced a record with an id and a note and nothing else. */
    fields: present({
      Name: d.region || d.campaign_id || externalId,
      Whollar_Campaign_Id: d.campaign_id || externalId,
      Whollar_Region: d.region,
      Whollar_Sub: d.sub,
      Whollar_Stage: d.stage,
      Whollar_FSAs: d.fsas,
      Whollar_Target: d.target == null ? undefined : Number(d.target),
      Whollar_Households: d.households == null ? undefined : Number(d.households),
      Whollar_Promo_Cliff_At: d.promo_cliff_at,
    }),
    always: {},
    lookups: d.winning_partner ? { Whollar_Winning_Partner: { entity: 'partner', id: d.winning_partner } } : {},
    noted: [],
  }),

  /* ---- Cohort_Memberships ---- */
  cohort_membership: (d, externalId) => ({
    fields: present({
      Name: externalId,
      Whollar_Status: d.status,
      Whollar_FSA: d.fsa,
      Whollar_Joined_At: d.joined_at,
      Whollar_Exit_At: d.exit_at,
      Whollar_Exit_Reason: d.exit_reason,
    }),
    always: {},
    lookups: present({
      Whollar_Cohort: d.campaign_id ? { entity: 'cohort', id: d.campaign_id } : undefined,
      Whollar_Household: householdIdFrom(externalId)
        ? { entity: 'household', id: householdIdFrom(externalId) } : undefined,
      Whollar_From_Cohort: d.from_cohort ? { entity: 'cohort', id: d.from_cohort } : undefined,
    }),
    noted: ['region', 'from_region'],
  }),

  /* ---- Sealed_Bids ---- */
  sealed_bid: (d, externalId) => ({
    /* D3. There is no price field here and none may be added. The serialiser
       already refuses one; this refuses it again, at the layer that decides what
       reaches a column, because the two are edited by different people at
       different times for different reasons. */
    fields: present({
      Name: externalId,
      Whollar_Bid_Event: d.event,
      Whollar_Revision: d.revision == null ? undefined : Number(d.revision),
      Whollar_Receipt: d.receipt,
      Whollar_Tier_Count: d.tier_count == null ? undefined : Number(d.tier_count),
      Whollar_Submitted_At: d.submitted_at,
    }),
    always: {},
    lookups: present({
      Whollar_Partner: d.org_id ? { entity: 'partner', id: d.org_id } : undefined,
      Whollar_Cohort: d.campaign_id ? { entity: 'cohort', id: d.campaign_id } : undefined,
    }),
    noted: ['region', 'org_name'],
  }),

  /* ---- Deals ---- */
  switch_order: (d, externalId) => {
    const key = d.order_key || externalId;
    const household = householdIdFrom(key);
    return {
      /* DEFECT 3. Deal_Name, Stage and Closing_Date are mandatory in Zoho and
         nothing set them, so every switch order upsert failed as a client error
         and was dead after two attempts. All three are always present now, which
         is why they are in `always` and not behind present(). */
      fields: present({
        Whollar_Order_No: d.order_no,
        Whollar_Tier: d.tier,
        Whollar_From_Tier: d.from_tier,
        Whollar_FSA: d.fsa,
        Whollar_Slot_At: d.slot_at,
        Whollar_Activated_At: d.activated_at,
        Whollar_Release_Reason: d.release_reason,
      }),
      always: {
        Deal_Name: d.order_no || key,
        Stage: STAGE[d.state] || 'Accepted',
        /* The activation date once activated, the install slot before that, and
           today only when neither exists. Zoho will not take the record without
           one, and a missing mandatory field is not worth losing the event. */
        Closing_Date: dateOnly(d.activated_at) || dateOnly(d.slot_at) || today(),
      },
      lookups: present({
        Account_Name: d.org_id ? { entity: 'partner', id: d.org_id } : undefined,
        Contact_Name: household ? { entity: 'household', id: household } : undefined,
        Whollar_Cohort: d.campaign_id ? { entity: 'cohort', id: d.campaign_id } : undefined,
      }),
      /* D1 as amended: Amount is never set. Money stays in the Data Store until
         the billing build settles the column type and cents-exact arithmetic. */
      noted: ['region', 'state'],
    };
  },
});

/**
 * Map one payload for one entity.
 *
 *   -> { fields, lookups, noted } or null for an entity with no map
 *
 * `fields` already has the `always` set merged in, so a caller writes exactly
 * what it is given.
 */
function mapFor(entityType, data, externalId) {
  const fn = MAPS[entityType];
  if (typeof fn !== 'function') return null;
  const m = fn(data || {}, externalId);
  return {
    fields: Object.assign({}, m.fields, m.always || {}),
    lookups: m.lookups || {},
    noted: m.noted || [],
  };
}

/**
 * Field API names that must never be dropped by the invalid-field retry: the
 * record either fails to write without them, or writes unattached.
 *
 * Declared rather than derived. The obvious implementation probes a map with an
 * empty payload and reads the keys back, and it is wrong: every lookup here is
 * conditional on the payload carrying its parent id, so an empty probe reports
 * no lookups at all and the list silently protects nothing. A list you can read
 * is also a list a reviewer can check against docs/crm-field-build.md.
 */
const LOCKED = Object.freeze({
  household: [],
  partner_contact: ['Account_Name'],
  partner: [],
  cohort: ['Whollar_Winning_Partner'],
  cohort_membership: ['Whollar_Cohort', 'Whollar_Household', 'Whollar_From_Cohort'],
  sealed_bid: ['Whollar_Partner', 'Whollar_Cohort'],
  switch_order: ['Deal_Name', 'Stage', 'Closing_Date', 'Account_Name', 'Contact_Name', 'Whollar_Cohort'],
});

function undroppable(entityType) {
  return LOCKED[entityType] || [];
}

module.exports = { mapFor, undroppable, MAPS, LOCKED, STAGE, dateOnly, householdIdFrom };
