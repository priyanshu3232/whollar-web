'use strict';


/* ------------------------------------------------------------------ *
 * crmSync: cron-invoked worker that drains the CrmSyncQueue table and
 * pushes each queued form submission into Zoho CRM (+ a Note capturing the
 * submission's details). Consumer submissions become Leads; partner
 * applications go to their own module when CRM_PARTNER_MODULE is set
 * (e.g. 'Vendors' or a custom module), so the two sides land respectively.
 *
 * WHY a queue + this worker (instead of calling CRM from formSubmit):
 *   - The visitor's form never fails because CRM is slow / rate-limited /
 *     the token expired: formSubmit only writes a Data Store row.
 *   - Nothing is lost: this worker retries PENDING/FAILED rows every run.
 *   - Only THIS function holds the Zoho credentials (formSubmit has none).
 *
 * It is an Advanced I/O (HTTP) function. A Catalyst Job Scheduling cron
 * hits its URL on a schedule with ?key=<CRM_CRON_SECRET>. It is safe to
 * call repeatedly: each run processes a bounded batch and is idempotent
 * per row (a SYNCED row is never re-sent).
 * ------------------------------------------------------------------ */

const catalyst = require('zcatalyst-sdk-node');
const express = require('express');

const app = express();
app.use(express.json({ limit: '256kb', type: ['application/json', 'text/plain'] }));

const fieldmap = require('./fieldmap');

const QUEUE_TABLE = 'CrmSyncQueue';

// All tunables come from env variables (set in the Catalyst console, never
// committed). Read fresh each request so a console change needs no redeploy.
const config = () => ({
  accountsUrl: process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zohocloud.ca',
  apiDomainFallback: process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.ca',
  clientId: process.env.ZOHO_CLIENT_ID,
  clientSecret: process.env.ZOHO_CLIENT_SECRET,
  refreshToken: process.env.ZOHO_REFRESH_TOKEN,
  cronSecret: process.env.CRM_CRON_SECRET,
  enabled: process.env.CRM_SYNC_ENABLED === 'true',
  isProd: process.env.CRM_ENVIRONMENT === 'production',
  batchSize: Math.max(1, parseInt(process.env.CRM_BATCH_SIZE || '50', 10)),
  maxAttempts: Math.max(1, parseInt(process.env.CRM_MAX_ATTEMPTS || '6', 10)),
  // Module partner applications land in ('Vendors', or a custom module's API
  // name). Default 'Leads' keeps everything in one module until the dedicated
  // module exists in Zoho: see "Partner module" in CRM_SYNC_RUNBOOK.md.
  partnerModule: (process.env.CRM_PARTNER_MODULE || 'Leads').trim() || 'Leads',
  // That module's mandatory display-name field, when it isn't the default
  // (Vendor_Name for Vendors, Name for custom modules).
  partnerNameField: (process.env.CRM_PARTNER_NAME_FIELD || '').trim(),
  /* D4. The API name of the unique external-id field, on every module. One
     name across modules is the normal Zoho arrangement; it is configuration
     rather than a constant because it is one org's setup, and a wrong name
     here is the difference between an upsert and a duplicate. Default is D1's
     proposed name. */
  externalIdField: (process.env.CRM_EXTERNAL_ID_FIELD || 'Whollar_ROWID').trim(),
  /* Module API names per entity, D1's proposal as defaults. Zoho pluralises
     and underscores custom module names in ways that are worth confirming in
     Setup, Developer Hub, API Names before trusting these. */
  modules: {
    household:         (process.env.CRM_MODULE_HOUSEHOLD || 'Contacts').trim(),
    partner_contact:   (process.env.CRM_MODULE_PARTNER_CONTACT || 'Contacts').trim(),
    partner:           (process.env.CRM_MODULE_PARTNER || 'Accounts').trim(),
    cohort:            (process.env.CRM_MODULE_COHORT || 'Cohorts').trim(),
    cohort_membership: (process.env.CRM_MODULE_MEMBERSHIP || 'Cohort_Memberships').trim(),
    sealed_bid:        (process.env.CRM_MODULE_SEALED_BID || 'Sealed_Bids').trim(),
    switch_order:      (process.env.CRM_MODULE_SWITCH_ORDER || 'Deals').trim(),
    settlement:        (process.env.CRM_MODULE_SETTLEMENT || 'Settlements').trim(),
  }
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

// Catalyst DateTime columns want "YYYY-MM-DD HH:MM:SS" (UTC), not ISO 8601.
const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const authHeaders = (token) => ({
  Authorization: `Zoho-oauthtoken ${token}`,
  'Content-Type': 'application/json'
});

/* ---- Access token: refresh-token → access-token, cached in Catalyst Cache ---- *
 * Access tokens live ~1h; Zoho rate-limits how often you may mint them, so we
 * cache one across cron runs and only refresh when it's within 5 min of expiry
 * (or when a 401 forces it). The default cache segment needs no console setup. */
const TOKEN_CACHE_KEY = 'crm_access_token';

async function getAccessToken(catalystApp, cfg, force) {
  const seg = catalystApp.cache().segment();

  if (!force) {
    try {
      const raw = await seg.getValue(TOKEN_CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c.exp && c.exp - Date.now() > 5 * 60 * 1000) {
          return { token: c.token, apiDomain: c.apiDomain };
        }
      }
    } catch { /* fall through to a fresh refresh */ }
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken
  });
  const resp = await fetch(`${cfg.accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`token refresh failed: ${JSON.stringify(data)}`);

  const apiDomain = data.api_domain || cfg.apiDomainFallback;
  const exp = Date.now() + ((data.expires_in || 3600) * 1000);
  const value = JSON.stringify({ token: data.access_token, apiDomain, exp });
  try { await seg.put(TOKEN_CACHE_KEY, value, 1); }
  catch { try { await seg.update(TOKEN_CACHE_KEY, value, 1); } catch { /* best effort */ } }

  return { token: data.access_token, apiDomain };
}

// Run a CRM request; on a 401 (token expired mid-batch) refresh once and retry.
async function callCrm(ctx, doRequest) {
  let resp = await doRequest(ctx.token, ctx.apiDomain);
  if (resp.status === 401) {
    await ctx.refresh();
    resp = await doRequest(ctx.token, ctx.apiDomain);
  }
  return resp;
}

/**
 * An Error that says what HTTP said, so `classify()` can tell a stale token from
 * a malformed field from Zoho being down. Without this every failure looked the
 * same and every failure was retried the same way.
 */
function crmError(message, resp) {
  const err = new Error(message);
  if (resp) {
    err.httpStatus = resp.status;
    try { err.retryAfter = resp.headers && resp.headers.get('retry-after'); } catch { /* no headers */ }
  }
  return err;
}

async function findRecordByEmail(ctx, moduleName, email) {
  // Lowercased so Genie@x.com and genie@x.com resolve to one record rather
  // than two. Parentheses, commas and colons are the criteria syntax's own
  // delimiters (colon separates field:operator:value), so strip them from the
  // value before interpolating: otherwise an address with an extra colon in
  // its local part (rare, but RFC-legal) can reshape the search clause. The
  // module must have an Email-type field whose API name is `Email` (Leads and
  // Vendors both do; a custom partner module needs one created: see the runbook).
  const safe = String(email || '').toLowerCase().replace(/[(),:]/g, '');
  const criteria = encodeURIComponent(`(Email:equals:${safe})`);
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/${moduleName}/search?criteria=${criteria}`, { headers: authHeaders(token) }));
  if (resp.status === 204) return null;              // 204 = no match
  if (!resp.ok) throw crmError(`${moduleName} search ${resp.status}: ${await resp.text()}`, resp);
  const data = await resp.json();
  return data?.data?.[0]?.id || null;
}

// Zoho rejects a picklist value that is not already defined on the field, with
// INVALID_DATA naming the offending field. Lead_Source and Rating are picklists
// by default, and this worker writes five Lead_Source labels (plus a " [dev]"
// suffix outside production): if those options do not exist in the console,
// EVERY insert fails, retries six times, lands on FAILED, and the leads are
// silently lost. Rather than lose them, drop the offending field and retry
// once: an imperfectly tagged lead in the CRM beats no lead at all.
/* Without these the record is not worth writing: Zoho requires the first two
   on a Lead and the third is what tells a company from a household. Every
   other field is droppable, which is the whole point of the retry below. */
/* Without these the record is not worth writing: Zoho requires the first two on
   a Lead and the third is what tells a company from a household.
   `externalIdField` joins them for a sharper reason. `offendingField` drops what
   Zoho refuses and retries, which is right for a postal code and catastrophic
   for the dedupe key: dropping it turns an upsert into an insert, and an insert
   that should have matched is a duplicate record. If the external id is refused,
   the name is wrong and the row must fail loudly rather than quietly fork. */
const REQUIRED_FIELDS = ['Email', 'Last_Name', 'Company'];
/**
 * Whether a field may be dropped and the write retried without it.
 *
 * `offendingField` drops what Zoho refuses, which is right for a postal code and
 * wrong for three other kinds of field. The external id: dropping it turns an
 * upsert into an insert and an insert that should have matched is a duplicate.
 * A module's mandatory fields: dropping `Deal_Name` produces a record Zoho will
 * refuse anyway, so the retry only wastes the attempt. A lookup: dropping it
 * writes the record unattached, which succeeds, looks fine, and leaves a
 * membership pointing at nothing.
 *
 * ITEM 6 OF THE PHASE 3C BRIEF WAS TRUNCATED after the word `offendingField`,
 * so this is the defensible reading and not a stated requirement. If the intent
 * was different, this function is the whole of the change.
 */
const isRequired = (api, cfg, entity) =>
  REQUIRED_FIELDS.includes(api)
  || api === (cfg && cfg.externalIdField)
  || (entity ? fieldmap.undroppable(entity).includes(api) : false);

/* At most this many fields dropped before giving up, so a misconfigured org
   cannot turn one note into an unbounded run of writes. */
const MAX_FIELD_DROPS = 5;

/**
 * The field Zoho just refused, if dropping it is worth a retry.
 *
 * This used to name two picklists explicitly, which was right while the only
 * fields that could be refused were Lead_Source and Rating. It is no longer:
 * notes now carry a phone, a postal code and a province, and whether those
 * exist under the API names used here depends on one org's configuration. A
 * wrong name would otherwise fail the whole note six times and land it in
 * FAILED, losing the event to save a field. So anything Zoho names is dropped
 * and retried, except the three without which there is no record at all.
 */
function offendingField(data, payload, cfg, ctxEntity) {
  const rec = data?.data?.[0];
  if (rec?.code !== 'INVALID_DATA') return null;
  const api = rec?.details?.api_name;
  if (!api || !(api in payload) || isRequired(api, cfg, ctxEntity)) return null;
  return api;
}

async function postRecord(ctx, moduleName, fields) {
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/${moduleName}`, {
      method: 'POST', headers: authHeaders(token), body: JSON.stringify({ data: [fields] })
    }));
  return resp.json();
}

async function insertRecord(ctx, moduleName, fields) {
  let payload = { ...fields };
  let data = await postRecord(ctx, moduleName, payload);
  let rec = data?.data?.[0];

  const dropped = [];
  for (let i = 0; i < MAX_FIELD_DROPS && rec?.code !== 'SUCCESS'; i++) {
    const bad = offendingField(data, payload, ctx && ctx.cfg, ctx && ctx.entity);
    if (!bad) break;
    console.error(`[crmSync] ${moduleName}.${bad} refused "${payload[bad]}": dropping it and retrying. Add the field or the picklist option in the Zoho console to keep it.`);
    delete payload[bad];
    dropped.push(bad);
    data = await postRecord(ctx, moduleName, payload);
    rec = data?.data?.[0];
  }

  if (rec?.code !== 'SUCCESS') {
    /* A record Zoho refused on content, not on transport. 400 so classify()
       treats it as a client error: one more attempt and then dead, rather than
       an hourly retry of the same rejected payload for ever. */
    const err = new Error(`${moduleName} insert failed: ${JSON.stringify(data)}`);
    err.httpStatus = 400;
    throw err;
  }
  return { id: rec.details.id, dropped };
}

/**
 * D4: upsert on the external id, which is the only dedupe that works for every
 * module.
 *
 * Email cannot be the key. Zoho gives Accounts no standard Email field at all,
 * a partner org has several addresses, and an address that changes would fork
 * the record. `Whollar_ROWID` is the Catalyst ROWID, it never changes, and it is
 * unique in CRM, so the same row delivered twice updates once. That property is
 * what makes the backfill safe to run twice and the reconciler safe to run
 * nightly.
 *
 * `duplicate_check_fields` names the field Zoho matches on. If the name is wrong
 * Zoho refuses the record rather than matching on something else, and
 * `isRequired` keeps that refusal loud: the alternative is silently inserting a
 * duplicate every hour for ever.
 */
async function upsertByExternalId(ctx, moduleName, externalId, fields) {
  const field = ctx.cfg.externalIdField;
  const body = {
    data: [Object.assign({}, fields, { [field]: String(externalId) })],
    duplicate_check_fields: [field],
  };
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/${moduleName}/upsert`, {
      method: 'POST', headers: authHeaders(token), body: JSON.stringify(body),
    }));
  const data = await resp.json();
  const rec = data?.data?.[0];
  if (rec?.code !== 'SUCCESS') {
    const err = new Error(`${moduleName} upsert failed: ${JSON.stringify(data)}`);
    err.httpStatus = resp.status >= 400 ? resp.status : 400;
    throw err;
  }
  return { id: rec.details.id, action: rec.action || 'upserted' };
}

/**
 * The one place email is still a key, and only for Contacts.
 *
 * The form sync has been writing Leads and Contacts by email since July, so a
 * household that filled in a bill checkup in August already has a record with no
 * `Whollar_ROWID` on it. Upserting on the external id alone would create a second
 * one beside it. So a Contact-shaped entity is looked up by email ONCE: if a
 * record exists and carries no external id, it is adopted, meaning the id is
 * written onto it and it becomes the household's record for ever after.
 *
 * After adoption email is never used for that record again, which is the whole
 * point. Accounts never take this path.
 */
async function adoptContactByEmail(ctx, moduleName, email, externalId) {
  if (!email) return null;
  const existing = await findRecordByEmail(ctx, moduleName, email).catch(() => null);
  if (!existing) return null;
  const field = ctx.cfg.externalIdField;
  /* `findRecordByEmail` returns an id only, so read the field back before
     claiming an unowned record: a Contact that already carries somebody else's
     external id must never be adopted onto this household. */
  const owned = await recordExternalId(ctx, moduleName, existing);
  if (owned && String(owned) !== String(externalId)) return null;
  if (owned) return existing;
  await updateRecord(ctx, moduleName, existing, { [field]: String(externalId) });
  console.log(JSON.stringify({ level: 'info', message: 'crm contact adopted',
    module: moduleName, crm_record_id: existing, external_id: String(externalId) }));
  return existing;
}

/** The external id already on a record, or null. */
async function recordExternalId(ctx, moduleName, recordId) {
  const field = ctx.cfg.externalIdField;
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/${moduleName}/${recordId}?fields=${encodeURIComponent(field)}`,
      { headers: authHeaders(token) }));
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.data?.[0]?.[field] || null;
}

/**
 * A record's CRM id, found by its Catalyst ROWID. This is how a lookup is
 * resolved: a Deal does not carry the text of a cohort, it carries a pointer to
 * the Cohorts record, and the pointer is a CRM id nobody outside CRM knows.
 */
async function findByExternalId(ctx, moduleName, externalId) {
  const field = ctx.cfg.externalIdField;
  const criteria = encodeURIComponent(`(${field}:equals:${externalId})`);
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/${moduleName}/search?criteria=${criteria}`, { headers: authHeaders(token) }));
  if (resp.status === 204) return null;
  if (!resp.ok) throw crmError(`${moduleName} lookup ${resp.status}: ${await resp.text()}`, resp);
  const data = await resp.json();
  return data?.data?.[0]?.id || null;
}

/**
 * Turn `{ fieldName: { entity, id } }` into `{ fieldName: crmRecordId }`.
 *
 * A parent that is not in CRM yet throws a missing-parent error rather than
 * writing the record unattached. Parent-first ordering means this is rare
 * within a run; when it happens the row waits and retries, capped, and a
 * membership pointing at nothing is never written. An orphan record is worse
 * than a late one because nothing later repairs it.
 */
async function resolveLookups(ctx, lookups) {
  const out = {};
  for (const [field, ref] of Object.entries(lookups || {})) {
    const moduleName = ctx.cfg.modules[ref.entity];
    if (!moduleName || !ref.id) continue;
    // eslint-disable-next-line no-await-in-loop
    const id = await findByExternalId(ctx, moduleName, ref.id);
    if (!id) {
      const err = new Error(`parent not in CRM yet: ${ref.entity} ${ref.id} for ${field}`);
      err.missingParent = true;
      throw err;
    }
    out[field] = id;
  }
  return out;
}

async function updateRecord(ctx, moduleName, recordId, fields) {
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/${moduleName}/${recordId}`, {
      method: 'PUT', headers: authHeaders(token), body: JSON.stringify({ data: [fields] })
    }));
  const data = await resp.json();
  const rec = data?.data?.[0];
  if (rec?.code !== 'SUCCESS') {
    const err = new Error(`${moduleName} update failed: ${JSON.stringify(data)}`);
    err.httpStatus = 400;
    throw err;
  }
}

// Notes are best-effort: a failed note must not fail the whole job, because
// the record (the important part) is already written.
async function addNote(ctx, moduleName, recordId, title, content) {
  try {
    const resp = await callCrm(ctx, (token, apiDomain) =>
      fetch(`${apiDomain}/crm/v8/Notes`, {
        method: 'POST', headers: authHeaders(token), body: JSON.stringify({
          data: [{
            Note_Title: String(title).slice(0, 120),
            Note_Content: String(content).slice(0, 32000),
            Parent_Id: recordId,
            se_module: moduleName
          }]
        })
      }));
    if (!resp.ok) console.error('[crmSync] note failed', resp.status, await resp.text());
  } catch (err) {
    console.error('[crmSync] note error:', err);
  }
}

/* ---- Mapping: a queue row (Source + Payload) → Zoho Lead fields + a Note ---- */

const SOURCE_META = {
  WaitlistSignups:        { label: 'Waitlist', hasName: true },
  /* The winter tire vertical, tires.whollar.ca. hasName matters: without a
     row here the source falls back to { label: source }, hasName is undefined,
     and Last_Name is set to the household's email address instead of their
     name. Its own label rather than the internet waitlist's, because
     Lead_Source is how the CRM tells the two products apart. */
  TireWaitlistSignups:    { label: 'Winter Tire Waitlist', hasName: true },
  /* The waitlist popup on all three hosts. Missing until 2026-09-05, which is
     exactly the failure the tire comment above describes: with no row here
     hasName was undefined and Last_Name was being set to the email address. */
  WaitlistEmails:         { label: 'Waitlist Popup', hasName: false },
  WaitlistDetails:        { label: 'Waitlist Details', hasName: false },
  BillCheckupSubmissions: { label: 'Bill Checkup', hasName: false },
  DeepReadRequests:       { label: 'Deep Read', hasName: false, hot: true },
  PartnerApplications:    { label: 'Partner Application', hasName: true, hasCompany: true, partner: true },

  /* ---- the auth function's sources -------------------------------------
   * Everything above is a website form: an anonymous stranger, whose whole
   * story is the one payload. Everything below is somebody already known,
   * doing a thing on a date, so each carries a `lines()` that renders that
   * one event and nothing else. The record is found by email and the note is
   * added to it; a person's history is the stack of notes, in order, which is
   * why none of these rewrites a field.
   *
   * `label` reaches the reader twice, in `Lead_Source` on a record this
   * source created and in every note title, so it is written as a person
   * would say it out loud.
   *
   * The names must match lib/crmqueue.js SOURCES exactly. scripts/test-crmqueue.mjs
   * asserts that, and it is strict the moment one of them appears here.
   */
  MemberSignups: {
    label: 'Account Created', hasName: true,
    lines: (d) => [
      d.user_type === 'provider' ? 'Created a partner account.' : 'Created a member account.',
      row('Postal area', d.fsa), row('Province', d.province),
      row('Referred by', d.referred_by),
    ],
  },
  MemberProfiles: {
    label: 'Member Details', hasName: true, address: true,
    lines: (d) => [
      'Filled in their details.',
      row('Phone', d.phone), row('Postal code', d.postal),
      row('Postal area', d.fsa), row('Province', d.province),
      row('Pooling for', d.pooling_for),
    ],
  },
  PartnerSignups: {
    label: 'Partner Account', hasName: true, hasCompany: true, partner: true,
    lines: (d) => [
      'Created a partner account.',
      row('Organisation', d.org_name), row('Approval', d.approval_status),
    ],
  },
  PartnerOrgs: {
    label: 'Partner Organisation', hasName: false, hasCompany: true, partner: true,
    lines: (d) => [
      d.previous_name && d.previous_name !== d.org_name
        ? `Organisation renamed from ${d.previous_name} to ${d.org_name}.`
        : `Organisation registered as ${d.org_name}.`,
    ],
  },
  ProviderApplications: {
    label: 'Application Submitted', hasName: false, hasCompany: true, partner: true,
    lines: (d) => ['Founding partner application submitted.', row('Organisation', d.org_name)],
  },
  PartnerApprovals: {
    label: 'Application Decision', hasName: false, hasCompany: true, partner: true,
    lines: (d) => [
      d.decision === 'approved'
        ? 'APPROVED. The partner console is live for this organisation.'
        : 'DECLINED.',
      row('Organisation', d.org_name), row('Reason', d.reason),
    ],
  },
  PartnerTerms: {
    label: 'Terms Accepted', hasName: false, hasCompany: true, partner: true,
    lines: (d) => [
      `Accepted the standard cohort terms, version ${d.doc_version || 'unknown'}.`,
      row('Organisation', d.org_name),
    ],
  },
  PartnerBilling: {
    label: 'Billing On File', hasName: false, hasCompany: true, partner: true,
    lines: (d) => [
      'Billing method on file: invoice, net 15 on activated households.',
      row('Organisation', d.org_name), row('Billing email', d.billing_email),
      row('Billing contact', d.billing_contact),
    ],
  },
  CohortSeats: {
    label: 'Cohort', hasName: false,
    lines: (d) => {
      const SEAT = {
        joined: 'Joined the cohort.', rejoined: 'Rejoined the cohort.',
        left: 'Left the cohort.', moved: 'Moved to this cohort.',
        passed: 'Passed on this round.', waitlist: 'Joined the waitlist.',
        alert: 'Asked to be told when this one opens.',
      };
      return [
        SEAT[d.event] || `Cohort membership: ${d.event || 'changed'}.`,
        row('Cohort', d.region || d.cohort),
        d.from_region ? row('Moved from', d.from_region) : null,
        row('Postal area', d.fsa), row('Reason', d.reason),
      ];
    },
  },
  SealedBids: {
    label: 'Sealed Bid', hasName: false, hasCompany: true, partner: true,
    /* Deliberately no price. routes/desk.js does not send one and this would
       not print it if it did: the sealed record is the record, and a CRM note
       is read by more people than the auction ever should be. */
    lines: (d) => [
      d.event === 'improved'
        ? `Improved their sealed bid, revision ${d.revision || '?'}.`
        : 'Placed a sealed bid.',
      row('Cohort', d.region || d.cohort), row('Receipt', d.receipt),
      row('Organisation', d.org_name),
    ],
  },
  CohortAwards: {
    label: 'Cohort Award', hasName: false, hasCompany: true, partner: true,
    lines: (d) => [
      'Won tiers in this cohort.',
      row('Cohort', d.region || d.cohort), row('Tiers won', (d.tiers_won || []).join(', ')),
      row('Organisation', d.org_name),
    ],
  },
  HouseholdOrders: {
    label: 'Order', hasName: false,
    lines: (d) => {
      const ORDER = {
        accepted: 'Accepted an offer.', repicked: 'Changed their pick.',
        booked: 'Install booked.', rebooked: 'Install rebooked.',
        activated: 'LINE ACTIVATED.', released: 'Released back to the cohort.',
        noshow: 'Exception: household not home.',
        access: 'Exception: no access to the building or utility room.',
        linefail: 'Exception: line tested below the bid tier.',
      };
      return [
        ORDER[d.event] || `Order: ${d.event || 'changed'}.`,
        row('Cohort', d.region || d.cohort), row('Speed', d.tier),
        d.price ? row('Price accepted', `$${d.price}/mo`) : null,
        d.from_tier ? row('Changed from', d.from_tier) : null,
        row('Order', d.order_no), row('Postal area', d.fsa),
        /* Says a fee is now earned, never how much. The figure is
           configuration on the agreement (site_config.success_fee) and a
           number copied here would be read as the invoice. */
        d.billable ? 'This activation earns a success fee. The amount is on the agreement.' : null,
      ];
    },
  },
  PartnerCoverage: {
    label: 'Coverage', hasName: false, hasCompany: true, partner: true,
    lines: (d) => [
      d.coverage_status === 'declared'
        ? `Declared coverage in ${d.coverage_region || 'a new region'}.`
        : `Updated their ${d.coverage_region || 'regional'} coverage.`,
      row('Organisation', d.org_name),
    ],
  },
  /* The three below have descriptors and no call site yet, deliberately.
     `Cohorts` and `Settlements` are blocked on D4: a cohort and a statement have
     no email, and this worker's only match is by email, so enqueueing them today
     would write rows nothing can deliver. `HouseholdErased` has no code path at
     all: there is no erasure route in this stack yet. They are declared here so
     the catalogue and the worker stay one list, and so the day any of them is
     wired the note already reads correctly. See docs/crm-sync-audit.md. */
  Cohorts: {
    label: 'Cohort Record', hasName: false,
    lines: (d) => [
      d.stage ? `Cohort stage is now ${d.stage}.` : 'Cohort record.',
      row('Region', d.region), row('Households', d.households), row('Target', d.target),
    ],
  },
  Settlements: {
    label: 'Settlement', hasName: false, hasCompany: true, partner: true,
    lines: (d) => [
      `Statement ${d.state || 'updated'}.`,
      row('Period', d.period), row('Organisation', d.org_name),
      row('Reason', d.failure_reason),
    ],
  },
  HouseholdErased: {
    label: 'Erased', hasName: false,
    lines: () => ['Household erased at their request. This record is being removed.'],
  },
  EmailSuppressions: {
    label: 'Unsubscribed', hasName: false,
    lines: (d) => [
      'UNSUBSCRIBED. Do not send commercial email to this address.',
      row('Reason', d.reason), row('Scope', d.scope),
    ],
  },
};

/** `Label: value`, or nothing at all when there is no value to show. */
function row(k, v) {
  return (v === undefined || v === null || v === '') ? null : `${k}: ${v}`;
}

// Which module a source's records live in. Consumers are always Leads;
// partner applications go to cfg.partnerModule, which defaults to 'Leads'
// too, so nothing changes until CRM_PARTNER_MODULE is set in the console.
const moduleFor = (source, cfg) =>
  (SOURCE_META[source] || {}).partner ? cfg.partnerModule : 'Leads';

// The partner module's mandatory display-name field: Vendors ships with
// Vendor_Name, custom modules with Name, unless the env var says otherwise.
const partnerNameField = (cfg) =>
  cfg.partnerNameField || (cfg.partnerModule === 'Vendors' ? 'Vendor_Name' : 'Name');

// Fields for a NEW record in a dedicated partner module. Only fields every
// module has (its name field, Email, Phone): Last_Name / Company /
// Lead_Source are Leads fields and would be INVALID_DATA anywhere else. The
// application detail rides in the Note, exactly as it does for Leads.
function partnerInsertFields(cfg, email, data) {
  const n = names(data);
  const name = n.company
    || [n.first, n.last].filter(Boolean).join(' ')
    || email;
  const fields = { [partnerNameField(cfg)]: name, Email: email };
  if (data.phone) fields.Phone = data.phone;
  return fields;
}

// Fields for a NEW lead. Zoho requires Last_Name and Company on Leads, so for
// nameless/company-less consumer sources we fall back to the email / "Individual".
/* The forms send firstName/lastName/company; the auth function sends
   first_name/last_name/org_name, because those are its column names and a
   payload that renames its own columns on the way out is a payload nobody can
   trace back. Both shapes are read here, once, so no field mapper below has to
   know which half of the system a note came from. */
/* Zip_Code and State are Zoho's standard Lead fields. Written here rather than
   at each call site so there is one place to correct if an org names them
   differently, and insertRecord drops whatever it refuses rather than losing
   the note over a field name. */
function addressOnto(fields, data) {
  if (data.postal) fields.Zip_Code = data.postal;
  if (data.province) fields.State = data.province;
  return fields;
}

function names(data) {
  return {
    first: data.firstName || data.first_name || null,
    last: data.lastName || data.last_name || null,
    company: data.company || data.org_name || null,
  };
}

function insertFields(source, email, data, isProd) {
  const meta = SOURCE_META[source] || { label: source };
  const envTag = isProd ? '' : ' [dev]';
  const n = names(data);
  const fields = {
    Email: email,
    Last_Name: (meta.hasName && n.last) ? n.last : email,
    Company: meta.hasCompany ? (n.company || 'Unknown') : 'Individual',
    Lead_Source: `Whollar ${meta.label}${envTag}`
  };
  if (meta.hasName && n.first) fields.First_Name = n.first;
  if (data.phone) fields.Phone = data.phone;
  if (meta.address) addressOnto(fields, data);
  if (meta.hot) fields.Rating = 'Hot';
  poolingOnto(fields, data);
  return fields;
}

// Which product they asked for on /join. Read in both shapes, like names():
// the form lane sends poolingFor, the auth lane pooling_for. Written on an
// existing lead too, unlike the name: the newest answer is the right one, and
// a household that changes its mind on /join should not be stuck as internet.
function poolingOnto(fields, data) {
  const v = data.poolingFor || data.pooling_for || null;
  if (v) fields.Whollar_Pooling_For = v;
  return fields;
}

// Fields safe to apply to an EXISTING lead: never overwrite the name with a
// placeholder, and never rewrite Lead_Source (first touch wins). Enrichment
// detail goes to a Note instead, so history is preserved, not clobbered.
function updateFields(source, data) {
  const meta = SOURCE_META[source] || {};
  const n = names(data);
  const fields = {};
  if (meta.hasName && n.last) fields.Last_Name = n.last;
  if (meta.hasName && n.first) fields.First_Name = n.first;
  if (data.phone) fields.Phone = data.phone;
  if (meta.address) addressOnto(fields, data);
  if (meta.hot) fields.Rating = 'Hot';
  poolingOnto(fields, data);
  return fields;
}

// The contract-length <select> values, as both forms send them. '0' and '-1'
// are answers, not lengths, and reading "Contract length: -1" off a lead is
// worse than reading nothing.
const CONTRACT_LENGTH = {
  '0': 'No contract / month-to-month',
  '-1': 'Not sure'
};

function noteFor(source, email, data, isProd, dropped, queuedAt) {
  const meta = SOURCE_META[source] || { label: source };
  const devTag = isProd ? '' : '[DEV] ';
  const lines = [];
  if (meta.hot) lines.push('⚠ DEEP READ REQUESTED: high intent');

  // When the household actually submitted, and how far behind this record is.
  // A stalled cron is invisible in CRM otherwise: the rep sees a lead created
  // today and calls it as a warm enquiry when the form was filled weeks ago.
  // The queue clock runs UTC-7 against a UTC Date.now(), which can move the
  // day count by one at a boundary and never changes whether a gap is shown.
  // An unparseable stamp leaves both lines out rather than printing NaN.
  const stamp = queuedAt ? String(queuedAt).trim().slice(0, 19).replace(' ', 'T') : '';
  const at = stamp ? Date.parse(stamp) : NaN;
  if (!Number.isNaN(at)) lines.push(`Submitted: ${stamp.replace('T', ' ')}`);
  const lateDays = Number.isNaN(at) ? 0 : Math.floor((Date.now() - at) / 86400000);
  if (lateDays >= 1) {
    lines.push(`⚠ Reached CRM ${lateDays} day${lateDays === 1 ? '' : 's'} after it was submitted: the sync was stalled. Not a fresh enquiry.`);
  }

  /* A source with its own `lines()` renders that and stops. Everything below
     this point reads a website form's payload: a verdict, a benchmark, a
     promo end date. An account being created has none of those, and running
     it through that machinery would print a note made entirely of absences. */
  if (typeof meta.lines === 'function') {
    let own = [];
    try {
      own = meta.lines(data) || [];
    } catch (err) {
      /* A malformed payload must not cost the whole note. The record still
         gets a line saying the event happened, which is the part that
         matters, and the parse problem goes to the logs. */
      own = [`(this note could not be rendered: ${String((err && err.message) || err).slice(0, 120)})`];
    }
    own.filter(Boolean).forEach((l) => lines.push(l));
    return {
      title: `${devTag}Whollar ${meta.label}: ${email}`.trim(),
      content: lines.length ? lines.join('\n') : `${meta.label}.`,
    };
  }

  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${v}`); };
  const money = v => (v === undefined || v === null || v === '' ? null : `$${Number(v).toFixed(2)}`);

  // What the visitor was actually shown. The note used to carry only the gross
  // charge, so a rep opening the lead saw "$90" while the screen had said
  // "$60/mo with promo": two different numbers for the same household.
  if (data.verdict) {
    const VERDICT = {
      strong: 'STRONG, already below the reference price',
      fair: 'FAIR, near the reference price',
      weak: 'WEAK, above the reference price',
      cliff: 'CLIFF, promo ends within 60 days',
      unknown: 'NOT SCORED'
    };
    add('Result shown', VERDICT[data.verdict] || data.verdict);
    if (data.verdict === 'unknown' && data.verdictReason) add('Not scored because', data.verdictReason);
    if (data.benchmarkPrice) {
      const LEVEL = {
        A: 'their provider, connection type, speed and province',
        B: 'connection type, speed and province (provider not in our set)',
        C: 'connection type and speed, national',
        D: 'their provider, speed and province',
        E: 'speed and province',
        F: 'speed only, national'
      };
      add('Compared against', `${money(data.benchmarkPrice)}/mo advertised`);
      add('Match basis', LEVEL[data.benchmarkLevel] || data.benchmarkScope || '-');
      add('Plans behind that figure', data.benchmarkSample);
      if (data.benchmarkCaveat) add('⚠ Comparison caveat', data.benchmarkCaveat);
    }
  }

  // The v17 checkup (2026-08-13): what the household was shown, engine terms.
  // `tone` is the card that appeared. The benchmark figure is INTERNAL: it may
  // sit in this note for a rep, it must never reach anything household-facing.
  if (data.tone) {
    const TONE = {
      high: 'HIGH, loyalty is costing them a fortune',
      moderate: 'MODERATE, staying put has a price',
      fair: 'FAIR, ahead today',
      'no-benchmark': 'NOT SCORED, no published rate at their speed'
    };
    add('Result shown', TONE[data.tone] || data.tone);
    if (data.savings12 !== undefined && data.savings12 !== null && data.tone !== 'no-benchmark') {
      add(`Could save over ${data.windowMonths || 12} months`, money(data.savings12));
    }
    add('Their next 12 months cost', money(data.currentCost12));
    add('Benchmark monthly (internal, never shown)', money(data.benchmarkMonthly));
    add('Overpaid to date (netted)', money(data.overpaidToDate));
    add('Calculation basis', data.basis);
    if (data.fallbackGeo) add('⚠ Benchmark geography', 'out-of-province offer fallback');
    add('Price during promo', money(data.priceDuringPromo));
    add('Price after promo', money(data.priceAfterPromo));
    if (data.isMultiPromo) add('Multi promo', data.promoPeriods || 'yes');
    add('Fallback price for uncovered months', money(data.promoFallbackPrice));
    if (data.startUnknown) add('Contract start', 'not known to the household');
    if (data.promoUnknown) add('Promo end', 'not known to the household');
  }

  add('Provider', data.provider);
  // What `cost` means changed on 2026-08-08: it is now the net figure the
  // household pays TODAY, promo included, not the regular price. The label
  // said "before discount" for two days after that, which is the one reading
  // a rep must not take from it. `effectiveCost` is the same number by that
  // definition, so it only earns a line when it actually differs.
  add('Monthly charge (what they pay today)', money(data.cost));
  if (data.effectiveCost !== undefined && data.effectiveCost !== null
      && Number(data.effectiveCost) !== Number(data.cost)) {
    add('Effective monthly cost', money(data.effectiveCost));
  }
  add('Download speed', data.speed);
  add('Access tech', data.tech);
  add('Promo end', data.promoEnd);
  add('Months to renewal', data.monthsToRenewal);
  add('Discount', money(data.discount));
  // The number the conversation is actually about: what the bill becomes when
  // the promo lapses. Derived rather than collected, because the form asks
  // what they pay now and how much is taken off, not the sum of the two.
  if (Number(data.discount) > 0 && Number(data.cost) > 0) {
    add('Price after the promo ends', money(Number(data.cost) + Number(data.discount)));
  }
  add('Contract start', data.contractStart);
  add('Contract length', CONTRACT_LENGTH[String(data.contractLength)]
    || (data.contractLength ? `${data.contractLength} months` : null));
  add('Switch threshold', data.threshold);
  // One geography block, in one format: "A1A 1A1" plus the FSA and province.
  add('Postal code', data.postal);
  add('FSA', data.fsa);
  add('Province', data.provinceCode ? `${data.province || ''} (${data.provinceCode})`.trim() : data.province);
  add('Referral code', data.referral);
  /* The code THIS person now holds and can share, which is the opposite
     direction to the line above: that one says who sent them. */
  add('Share code', data.shareCode);
  add('Role', data.role);
  add('Provinces', data.provinces);
  add('Access techs', data.techs);
  add('Services', data.services);
  add('Note', data.note);
  add('Attachments', data.files);
  add('Bill file', data.billFileName);
  add('Via', data.via);

  // CASL: the consent record has to be retrievable per contact, so it lives on
  // the lead rather than only in the Data Store row.
  if (data.consentGranted) {
    lines.push('');
    lines.push(', Consent,');
    add('Granted at (server)', data.consentAt);
    add('Consent type', data.consentKind);
    add('Source page', data.consentSource);
    add('IP', data.consentIp);
    add('Wording shown', data.consentText);
  } else if (data.consentGranted === false) {
    lines.push('');
    lines.push(': Consent: NOT granted. Do not send commercial email to this address.:');
  }

  if (dropped && dropped.length) {
    lines.push('');
    lines.push(`⚠ ${dropped.join(', ')} could not be set: the value is not an option on that picklist in Zoho. Add it in Setup → Fields to restore the tag.`);
  }

  return {
    title: `${devTag}Whollar ${meta.label}: ${email}`.trim(),
    content: lines.length ? lines.join('\n') : `Submission via ${meta.label}.`
  };
}

// Search-then-write: update an existing record (matched by email, within the
// source's module) or create one, then always attach a Note with this
// submission's details. Dedupe never crosses modules: the same email can be
// both a consumer Lead and a partner record, which is the point.
/**
 * Which path a row takes.
 *
 * A row with an `EntityType` came from lib/crm/outbox.js and has a Catalyst
 * ROWID to key on, so it upserts on the external id and cannot duplicate. A row
 * without one is a website form written by formSubmit, which has no entity and
 * no ROWID worth keying on, and keeps the search-then-write path it has used
 * since July. The two coexist deliberately: rewriting the form path would be
 * changing a working sync to no purpose, and it is exactly the code the June
 * leads in your CRM were created by.
 */
async function syncEntityJob(ctx, job, cfg) {
  const entity = job.EntityType;
  const moduleName = cfg.modules[entity];
  const email = job.Email;
  const data = safeParse(job.Payload);
  const externalId = job.EntityRowId || job.SourceRowId;

  const mapped = fieldmap.mapFor(entity, data, externalId);
  if (!mapped) throw new Error(`no field map for entity ${entity}`);

  /* Which entity's undroppable list applies while this row is being written.
     Rows are processed one at a time, so a single slot on the shared context is
     enough and avoids threading the entity through four call layers. */
  ctx.entity = entity;

  /* Lookups first. A parent that is not in CRM yet throws before anything is
     written, so a half-linked record is never created. */
  const links = await resolveLookups(ctx, mapped.lookups);
  const fields = Object.assign({}, mapped.fields, links);

  /* Contacts only, once per record: adopt what the form sync already created
     rather than growing a second copy beside it. */
  if (entity === 'household' || entity === 'partner_contact') {
    await adoptContactByEmail(ctx, moduleName, email, externalId);
  }

  const { id } = await upsertByExternalId(ctx, moduleName, externalId, fields);

  /* THE NOTE IS NO LONGER THE DUMPING GROUND. Everything with a column is now in
     a column, so the note keeps the two lines a person actually reads: when it
     happened, and what happened in a sentence. The descriptor renders the date
     first and the headline second, which is why this takes two. */
  const full = noteFor(job.Source, email || externalId, data, cfg.isProd, [], job.CREATEDTIME);
  const head = String(full.content).split('\n').slice(0, 2).join('\n');
  await addNote(ctx, moduleName, id, full.title, head);
  return id;
}

async function syncJob(ctx, job, cfg) {
  if (job.EntityType && cfg.modules[job.EntityType]) return syncEntityJob(ctx, job, cfg);

  const email = job.Email;
  const data = safeParse(job.Payload);
  const moduleName = moduleFor(job.Source, cfg);
  const isPartnerModule = moduleName !== 'Leads';

  let recordId = await findRecordByEmail(ctx, moduleName, email);
  let dropped = [];
  if (recordId) {
    // In a partner module the only enrichable field is Phone: the name field
    // is never overwritten, same rule as Leads.
    const upd = isPartnerModule
      ? (data.phone ? { Phone: data.phone } : {})
      : updateFields(job.Source, data);
    if (Object.keys(upd).length) await updateRecord(ctx, moduleName, recordId, upd);
  } else {
    const fields = isPartnerModule
      ? partnerInsertFields(cfg, email, data)
      : insertFields(job.Source, email, data, cfg.isProd);
    const created = await insertRecord(ctx, moduleName, fields);
    recordId = created.id;
    dropped = created.dropped;
  }
  const note = noteFor(job.Source, email, data, cfg.isProd, dropped, job.CREATEDTIME);
  await addNote(ctx, moduleName, recordId, note.title, note.content);
  return recordId;
}

/* ------------------------------------------------------------------ *
 * Route: POST /  (and /process). Invoked by the cron with ?key=SECRET.
 * ------------------------------------------------------------------ */

// A query-string secret lands in access logs, the cron scheduler's own run
// history, and any Referer header: a header does not. The header is
// preferred and should be the only thing the cron job actually sends; the
// query param still works so this deploy can't silently break a cron target
// that was configured before header support existed. Once the Job Scheduling
// webhook is confirmed to send `X-Cron-Secret` instead, delete the query
// fallback below: the console.error makes it obvious from the logs whether
// anything is still using it.
/* ------------------------------------------------------------------ *
 * Failure classification and backoff (Phase 3)
 * ------------------------------------------------------------------ */

/**
 * Minutes to wait after each failed attempt. Five entries, so the fifth failure
 * is the last: after that the row is dead and a person has to look at it.
 *
 * The old behaviour was no wait at all: a failed row was re-marked PENDING and
 * retried on the very next run. With an hourly job that was survivable; it is
 * still wrong, because a row failing for a reason that will not fix itself
 * consumed a CRM API call every hour forever.
 */
const BACKOFF_MINUTES = Object.freeze([1, 5, 25, 125, 625]);

/**
 * What kind of failure this is, which decides whether waiting helps.
 *
 *   auth    the token is stale or revoked. Refresh once and retry immediately;
 *           if it repeats, waiting will not help and a person must re-mint it.
 *   rate    429. Honour Retry-After when Zoho sends one, because it knows.
 *   client  any other 4xx. A malformed field or a module that does not exist
 *           will be just as malformed in ten hours. One retry, then dead.
 *   server  5xx, a timeout, a socket closing. Exactly what backoff is for.
 */
function classify(err) {
  /* A parent not yet in CRM is not a failure of this row, it is an ordering
     problem that usually resolves inside the same run and always resolves
     within one more. Capped at 3 waits so a genuinely orphaned row stops
     retrying rather than waiting for a parent that is never coming. */
  if (err && err.missingParent) return { kind: 'parent', minutes: 5 };
  const status = err && err.httpStatus;
  if (status === 401) return { kind: 'auth' };
  if (status === 429) {
    const after = parseInt((err && err.retryAfter) || '', 10);
    return { kind: 'rate', minutes: Number.isFinite(after) ? Math.ceil(after / 60) : 5 };
  }
  if (status >= 400 && status < 500) return { kind: 'client' };
  return { kind: 'server' };
}

/**
 * Parent-first, per D5 amendment 2a.
 *
 * A cohort membership needs its household in CRM. On an hourly schedule,
 * requeueing it for the next run costs an hour for something that arrived in
 * the same batch, so the batch is ordered instead and the parent is delivered
 * first within a single pass. Rows whose EntityType is unreadable, which is
 * every row until the column is added by hand, sort last and behave exactly as
 * they do today.
 */
const ENTITY_ORDER = Object.freeze([
  'household', 'cohort', 'partner', 'partner_contact',
  'cohort_membership', 'sealed_bid', 'switch_order', 'settlement',
]);
const entityRank = (e) => {
  const i = ENTITY_ORDER.indexOf(e);
  return i < 0 ? ENTITY_ORDER.length : i;
};

/** `YYYY-MM-DD HH:MM:SS`, n minutes from now, in the format Catalyst accepts. */
function inMinutes(n) {
  const d = new Date(Date.now() + n * 60000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const LOCK_KEY = 'crm_sync_batch_lock';
// Cache expiry here is in whole hours (Catalyst's segment API has no finer
// grain): 1h is the crash-recovery ceiling, not the normal hold time. The
// lock is released explicitly in `finally` below on every normal exit, so a
// healthy run only ever holds it for the length of one batch; this TTL only
// matters if a run dies without reaching that release.
const LOCK_TTL_HOURS = 1;

// Accept GET or POST so the run works regardless of the HTTP method the cron
// target uses; the secret key, not the method, is the guard.
app.all(['/', '/process'], async (req, res) => {
  const cfg = config();

  const key = req.headers['x-cron-secret'] || req.query.key;
  if (req.query.key && cfg.cronSecret && req.query.key === cfg.cronSecret) {
    console.error('[crmSync] cron secret received via query string: reconfigure the Job Scheduling webhook to send it as an X-Cron-Secret header instead');
  }
  // No/invalid key: a plain GET is a harmless health check; anything else is denied.
  if (!cfg.cronSecret || key !== cfg.cronSecret) {
    if (req.method === 'GET') return res.json({ ok: true, service: 'crmSync' });
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  // Master switch: lets the function deploy and the cron fire harmlessly
  // until you're ready to actually write to CRM (see runbook).
  if (!cfg.enabled) {
    return res.json({ ok: true, skipped: true, reason: 'CRM_SYNC_ENABLED is not true' });
  }
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    return res.status(500).json({ ok: false, error: 'Zoho credentials not configured' });
  }

  const catalystApp = catalyst.initialize(req);
  const result = { ok: true, processed: 0, synced: 0, failed: 0 };

  // Mutual exclusion for the batch below. `put` creates the cache entry and
  // rejects if it already exists (that's why getAccessToken falls back to
  // `update` on the same call), so a second overlapping invocation (a manual
  // trigger landing mid-cron, or the cron firing again before a slow batch
  // finishes) fails here and skips instead of racing the first run to select
  // and re-send the same PENDING rows.
  const lockSeg = catalystApp.cache().segment();
  try {
    await lockSeg.put(LOCK_KEY, String(Date.now()), LOCK_TTL_HOURS);
  } catch (err) {
    return res.json({ ok: true, skipped: true, reason: 'a sync is already in progress' });
  }

  try {
    /* Reset rows a previous run left claimed. 90 minutes and not 15, per D5
       amendment 2c: on an hourly schedule a run that legitimately spans the
       boundary must not have its own rows reclaimed underneath it. */
    try {
      const stuck = await catalystApp.zcql().executeZCQLQuery(
        `SELECT ROWID FROM ${QUEUE_TABLE} WHERE Status = 'IN_PROGRESS' LIMIT 200`);
      const t = catalystApp.datastore().table(QUEUE_TABLE);
      for (const r of stuck) {
        const row = r[QUEUE_TABLE];
        const age = Date.now() - Date.parse(String(row.MODIFIEDTIME || '').slice(0, 19).replace(' ', 'T'));
        if (!(age > 90 * 60000)) continue;
        // eslint-disable-next-line no-await-in-loop
        await t.updateRow({ ROWID: row.ROWID, Status: 'PENDING' });
        result.reclaimed = (result.reclaimed || 0) + 1;
      }
    } catch { /* MODIFIEDTIME unreadable or the table is mid-provision: skip */ }

    /* The new columns are added by hand and may not exist yet, so the wide
       select is tried and the legacy one is the fallback. Everything below
       tolerates the new fields being undefined. */
    const SELECT_NEW = `SELECT ROWID, Source, SourceRowId, Email, LeadType, Payload, Attempts, CREATEDTIME, `
      + `EntityType, EventType, EventVersion, IdempotencyKey, NextAttemptAt `
      + `FROM ${QUEUE_TABLE} WHERE Status = 'PENDING' ORDER BY CREATEDTIME ASC LIMIT ${cfg.batchSize}`;
    // CREATEDTIME rides along so the note can say when the household actually
    // submitted. Draining a stalled queue writes weeks-old rows in one batch,
    // and without this every one of them reads as today's.
    const SELECT_OLD = `SELECT ROWID, Source, SourceRowId, Email, LeadType, Payload, Attempts, CREATEDTIME `
      + `FROM ${QUEUE_TABLE} WHERE Status = 'PENDING' ORDER BY CREATEDTIME ASC LIMIT ${cfg.batchSize}`;

    let rows;
    try {
      rows = await catalystApp.zcql().executeZCQLQuery(SELECT_NEW);
    } catch {
      rows = await catalystApp.zcql().executeZCQLQuery(SELECT_OLD);
    }

    /* ZCQL refuses above 300 rather than truncating, so a batch size at the cap
       is a configuration error waiting to become a hard 400. Named here rather
       than discovered in production. */
    if (rows.length >= 300) {
      throw new Error(`batch of ${rows.length} is at the ZCQL cap: lower CRM_BATCH_SIZE or paginate`);
    }

    if (!rows.length) return res.json({ ...result, note: 'queue empty' });

    /* Due-time filter and parent-first order, both no-ops until the columns
       exist. A row with no NextAttemptAt is due, which is what every row
       written before backoff existed is. */
    const nowDb = nowStr();
    rows = rows
      .filter((r) => !r[QUEUE_TABLE].NextAttemptAt || String(r[QUEUE_TABLE].NextAttemptAt) <= nowDb)
      .sort((a, b) => entityRank(a[QUEUE_TABLE].EntityType) - entityRank(b[QUEUE_TABLE].EntityType));

    if (!rows.length) return res.json({ ...result, note: 'nothing due' });

    const first = await getAccessToken(catalystApp, cfg, false);
    const ctx = {
      cfg,
      token: first.token,
      apiDomain: first.apiDomain,
      refresh: async () => {
        const t = await getAccessToken(catalystApp, cfg, true);
        ctx.token = t.token;
        ctx.apiDomain = t.apiDomain;
      }
    };
    const table = catalystApp.datastore().table(QUEUE_TABLE);

    for (const r of rows) {
      const job = r[QUEUE_TABLE];
      const key = job.IdempotencyKey || `${job.Source}:${job.SourceRowId}:${job.ROWID}`;

      /* Claim by ROWID before doing any work. The batch lock above already
         serialises runs; this is the belt for the day a second drainer exists,
         and it is cheap. A claim that does not stick means another run has the
         row, so skip it rather than racing. */
      try {
        await table.updateRow({ ROWID: job.ROWID, Status: 'IN_PROGRESS' });
      } catch {
        result.skipped = (result.skipped || 0) + 1;
        continue;
      }

      result.processed++;
      const attempts = (parseInt(job.Attempts, 10) || 0) + 1;
      try {
        const leadId = await syncJob(ctx, job, cfg);
        await table.updateRow({
          ROWID: job.ROWID,
          Status: 'SYNCED',
          CrmLeadId: String(leadId),
          SyncedAt: nowStr(),
          Attempts: attempts,
          LastError: null
        });
        result.synced++;
        console.log(JSON.stringify({ level: 'info', message: 'crm delivered',
          idempotency_key: key, attempt: attempts, crm_record_id: String(leadId) }));
      } catch (err) {
        const how = classify(err);

        /* A stale token is worth one immediate retry, because refreshing is the
           whole fix and waiting 25 minutes to apply it helps nobody. */
        if (how.kind === 'auth' && !job.__retriedAuth) {
          try {
            await ctx.refresh();
            const leadId = await syncJob(ctx, job, cfg);
            await table.updateRow({
              ROWID: job.ROWID, Status: 'SYNCED', CrmLeadId: String(leadId),
              SyncedAt: nowStr(), Attempts: attempts, LastError: null
            });
            result.synced++;
            continue;
          } catch { /* fall through and be treated as a failure */ }
        }

        /* A 4xx that is not rate limiting will be just as wrong next hour, so it
           gets one more attempt and then stops consuming API calls forever. */
        const cap = how.kind === 'client' ? 2 : (how.kind === 'parent' ? 3 : cfg.maxAttempts);
        const dead = attempts >= cap;
        const wait = (how.kind === 'rate' || how.kind === 'parent')
          ? how.minutes
          : BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];

        const update = {
          ROWID: job.ROWID,
          Status: dead ? 'DEAD' : 'PENDING',
          Attempts: attempts,
          LastError: `[${how.kind === 'parent' && dead ? 'missing_parent' : how.kind}] ${String(err).slice(0, 1900)}`,
        };
        try {
          await table.updateRow(Object.assign({}, update, { NextAttemptAt: inMinutes(wait) }));
        } catch {
          /* NextAttemptAt not added in the console yet: the row still records
             its failure and retries on the next run, which is the behaviour
             this file had before backoff existed. */
          await table.updateRow(update);
        }

        result.failed++;
        if (dead) result.dead = (result.dead || 0) + 1;
        console.error(JSON.stringify({ level: 'error', message: 'crm delivery failed',
          idempotency_key: key, attempt: attempts, kind: how.kind,
          dead, next_attempt_in_minutes: dead ? null : wait,
          detail: String((err && err.message) || err).slice(0, 300) }));
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[crmSync] batch error:', err);
    res.status(500).json({ ok: false, error: String(err) });
  } finally {
    try { await lockSeg.delete(LOCK_KEY); } catch { /* TTL covers cleanup either way */ }
  }
});

/* The express app is what Catalyst mounts. The second export is a test
   surface and nothing else reads it: the note builders below are twelve pure
   functions whose failure mode is a note that reads wrongly in somebody's CRM,
   which no amount of staring at the file catches and one assertion does.
   Attached to the app rather than replacing the export, so the deployment
   contract is unchanged. */
app.__test = { SOURCE_META, noteFor, insertFields, updateFields, moduleFor, names, offendingField, fieldmap,
  findByExternalId, resolveLookups,
  classify, entityRank, BACKOFF_MINUTES, ENTITY_ORDER, inMinutes, isRequired, config,
  upsertByExternalId, adoptContactByEmail, syncJob, syncEntityJob };

module.exports = app;
