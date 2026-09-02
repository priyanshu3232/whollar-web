'use strict';

/**
 * The CRM outbox: one row per business event, drained by the crmSync job.
 *
 * Replaces lib/crmqueue.js, which this grew out of. There is one outbox and one
 * drainer; a second implementation of either is the thing Phase 0 item 6 of the
 * build brief exists to prevent.
 *
 * Four rules, enforced here rather than trusted to the seventeen call sites:
 *
 *   1. A FAILED ENQUEUE MUST NEVER FAIL THE REQUEST. Losing one CRM note is an
 *      inconvenience; refusing somebody's signup, or a partner's sealed bid,
 *      because a mirror was unreachable is not a trade anyone would make.
 *
 *   2. THE ALLOWLIST IS THE CONTROL. Every payload goes through its entity's
 *      serialiser first, which keeps only named fields, and the key-name scrub
 *      second, as a backstop for a field a serialiser wrongly named. D2 as
 *      amended 2026-09-02. A payload for an entity with no serialiser is
 *      refused outright rather than passed through.
 *
 *   3. NOTHING SHIPS UNTIL SOMEBODY SAYS SO. New sources are written PARKED,
 *      invisible to the drainer's `WHERE Status = 'PENDING'`, until
 *      CRM_NEW_SOURCES=true. Invisible rather than merely last: left PENDING
 *      they sort to the head by CREATEDTIME and every batch fills with rows the
 *      worker cannot deliver, stopping the working form sync dead behind them.
 *
 *   4. AN UNKNOWN EVENT IS A PROGRAMMING ERROR, caught here. A typo'd event
 *      name inserts perfectly happily and only surfaces as a mislabelled record
 *      in somebody's CRM weeks later.
 *
 * THE COLUMN LADDER. `EntityType`, `EventType`, `EventVersion`,
 * `IdempotencyKey` and `NextAttemptAt` are new columns that must be added by
 * hand in the Catalyst console, because there is no DDL API. Until they exist an
 * insert naming them is refused outright, so every write is attempted with them
 * and retried without. The legacy shape still carries `Source`, which is what
 * the deployed drainer routes on today, so this deploys safely before the
 * console work and gains the new columns the moment it is done.
 */

const datastore = require('../datastore');
const { serialise, ENTITY_TYPES } = require('./serialisers');

const TABLE = 'CrmSyncQueue';

/* ------------------------------------------------------------------ *
 * The event catalogue
 * ------------------------------------------------------------------ */

/**
 * Every event this function may enqueue: its entity type, and the legacy
 * `Source` value the deployed drainer still routes on.
 *
 * `Source` is not redundant with `EventType`. The drainer in crmSync has a
 * descriptor per Source and is deployed; changing what it routes on is a Phase 3
 * change, and until then Source is the routing key and EventType is the
 * catalogue name. Both are written so the switch is a one-line change in the
 * worker rather than a migration of every historic row.
 *
 * Three names below are NOT in the build brief's catalogue and are flagged in
 * the Phase 3 report rather than invented silently: `partner.updated`, which the
 * catalogue lacks and which terms, billing and a rename all need, and
 * `household.consent_changed`, which a suppression needs.
 */
const EVENTS = Object.freeze({
  'household.created':          { entity: 'household',         source: 'MemberSignups' },
  'household.updated':          { entity: 'household',         source: 'MemberProfiles' },
  'household.erased':           { entity: 'household',         source: 'HouseholdErased' },
  'household.consent_changed':  { entity: 'household',         source: 'EmailSuppressions' },

  'cohort.created':             { entity: 'cohort',            source: 'Cohorts' },
  'cohort.stage_changed':       { entity: 'cohort',            source: 'Cohorts' },
  'cohort.awarded':             { entity: 'cohort',            source: 'CohortAwards' },
  'cohort.cancelled':           { entity: 'cohort',            source: 'Cohorts' },

  'cohort_membership.joined':   { entity: 'cohort_membership', source: 'CohortSeats' },
  'cohort_membership.exited':   { entity: 'cohort_membership', source: 'CohortSeats' },

  'partner.applied':            { entity: 'partner',           source: 'ProviderApplications' },
  'partner.state_changed':      { entity: 'partner',           source: 'PartnerApprovals' },
  'partner.coverage_changed':   { entity: 'partner',           source: 'PartnerCoverage' },
  'partner.updated':            { entity: 'partner',           source: 'PartnerOrgs' },

  'partner_contact.created':    { entity: 'partner_contact',   source: 'PartnerSignups' },
  'partner_contact.updated':    { entity: 'partner_contact',   source: 'PartnerSignups' },

  'sealed_bid.submitted':       { entity: 'sealed_bid',        source: 'SealedBids' },
  'sealed_bid.revised':         { entity: 'sealed_bid',        source: 'SealedBids' },

  'switch_order.created':       { entity: 'switch_order',      source: 'HouseholdOrders' },
  'switch_order.state_changed': { entity: 'switch_order',      source: 'HouseholdOrders' },
  'switch_order.activated':     { entity: 'switch_order',      source: 'HouseholdOrders' },
  'switch_order.released':      { entity: 'switch_order',      source: 'HouseholdOrders' },

  /* settlement.* removed 2026-09-02: no writer exists, lib/billing.js only
     reads statements. They return with the billing build. The serialiser stays,
     because the entity is real and the allowlist is what will be reviewed then. */
});

const EVENT_TYPES = Object.freeze(Object.keys(EVENTS));

/* ------------------------------------------------------------------ *
 * The backstop scrub
 * ------------------------------------------------------------------ */

/**
 * Keys that never leave, whatever a serialiser named. Rule 2's second layer.
 *
 * These two lists fail differently, which is why there are two. A serialiser is
 * a list a person edits and can widen by accident. This is a rule that does not
 * care who edited what, and it is checked over the serialiser's OUTPUT, so a
 * serialiser that starts naming `address` tomorrow still cannot publish one.
 */
const PRIVATE_KEYS = /^(address|address_line|street|unit|buzzer|slot_address|install_phone|order_phone|member_phone)$/i;

const SECRET_KEYS = /^(code|otp|token|password|pass|pwd|secret|hash|authorization|cookie|id_token|access_token|refresh_token|client_secret|pkce_verifier|verifier|nonce|ip|ip_hash|consent_hash|payload_hash|referral_code|referred_by)$/i;

const looksSecret = (s) =>
  /^\d{6}$/.test(s) ||                       // a bare OTP
  /^[A-Fa-f0-9]{32,}$/.test(s) ||            // a digest
  /^[A-Za-z0-9_-]{40,}$/.test(s);            // a base64url token

/**
 * One pass over the serialiser's output. No truncation of any kind: lib/audit.js
 * bounds arrays to 20 and strings to 500 because it is building a log line, and
 * a cohort's tier list quietly losing members here would produce a CRM record
 * that is confidently wrong. Size is handled once, by PAYLOAD_MAX.
 *
 * The depth cap is a cycle guard and nothing else, which is why it is generous:
 * JSON.stringify throws on a circular reference, but this recursion would not
 * reach it.
 */
function scrub(value, depth = 0) {
  if (depth > 8) return '[deep]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PRIVATE_KEYS.test(k)) continue;
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return looksSecret(value) ? '[redacted]' : value;
  return value;
}

/** `Payload` is Text 25000. An oversize payload becomes a marker rather than a
 *  truncated JSON string, which would take the whole note with it on parse. */
const PAYLOAD_MAX = 20000;

/* ------------------------------------------------------------------ *
 * Versions and keys
 * ------------------------------------------------------------------ */

/**
 * `${entityType}:${entityRowid}:${eventType}:${version}`, unique.
 *
 * The version is what makes a second genuine event distinct from a retried
 * request. Callers with a natural discriminator pass it: a bid revision number,
 * an order state. Callers without one get a count of prior rows for the same
 * entity and event.
 *
 * THE RACE, stated rather than hidden. Two concurrent enqueues of the same event
 * on the same entity compute the same count and therefore the same key, and the
 * unique constraint rejects the second. For a retried request that is exactly
 * right. For two genuinely simultaneous distinct events it would drop one, which
 * is why every event that can legitimately repeat within a second, bid revisions
 * and order transitions, passes an explicit version instead of relying on this.
 */
async function nextVersion(catalystApp, entityType, entityRowid, eventType) {
  try {
    const rows = await datastore.query(catalystApp, TABLE,
      `SELECT ROWID FROM ${TABLE} WHERE EntityType = ${datastore.lit(entityType)}`
      + ` AND EntityRowId = ${datastore.lit(String(entityRowid))}`
      + ` AND EventType = ${datastore.lit(eventType)} LIMIT 200`);
    return (rows ? rows.length : 0) + 1;
  } catch {
    /* The new columns do not exist yet, or the query failed. A second-resolution
       clock keeps the key unique, which is the only property that matters here;
       it is not an ordinal and nothing reads it as one. */
    return Math.floor(Date.now() / 1000);
  }
}

/**
 * PENDING once the operator says so, PARKED until then. Read per call rather
 * than cached at require time, so flipping the console variable takes effect on
 * the next request instead of the next cold start.
 */
const statusNow = () => (String(process.env.CRM_NEW_SOURCES || '').trim() === 'true' ? 'PENDING' : 'PARKED');

/* ------------------------------------------------------------------ *
 * Enqueue
 * ------------------------------------------------------------------ */

/**
 * Queue one business event for the CRM drainer. Best-effort: see rule 1.
 *
 * @param {object} catalystApp
 * @param {object} req                 for the request id in the failure log
 * @param {object} event
 * @param {string} event.eventType     one of EVENT_TYPES
 * @param {string} event.entityRowid   the source row's own key
 * @param {string} event.email         who this is about; the drainer matches on it
 * @param {'consumer'|'partner'} [event.leadType]
 * @param {object} [event.payload]     serialised, then scrubbed, then written
 * @param {number|string} [event.version]  a natural discriminator where one exists
 */
async function enqueue(catalystApp, req, event) {
  try {
    const eventType = event && event.eventType;
    const spec = EVENTS[eventType];
    if (!spec) throw new Error(`unknown CRM event ${JSON.stringify(eventType)}`);
    /* Email is required only where email is the match. A household and a person
       at a partner are found by it, once, during adoption; a cohort, an order or
       a statement is found by its external id and has no address of its own.
       Requiring one everywhere would mean inventing one, and an invented address
       lands a cohort's note on whichever human happened to trigger it. */
    const CONTACTISH = ['household', 'partner_contact'];
    if (!event.email && CONTACTISH.includes(spec.entity)) {
      throw new Error(`${eventType} enqueued with no email`);
    }

    /* Rule 2, in order: allowlist, then backstop. A missing serialiser is a
       refusal, never a pass-through. */
    const named = serialise(spec.entity, event.payload);
    if (named === null) throw new Error(`no serialiser for entity ${spec.entity}`);
    let body = JSON.stringify(scrub(named));
    if (body.length > PAYLOAD_MAX) body = JSON.stringify({ oversize: true, bytes: body.length });

    const rowid = event.entityRowid == null ? '' : String(event.entityRowid);
    const version = event.version == null
      ? await nextVersion(catalystApp, spec.entity, rowid, eventType)
      : event.version;

    const legacy = {
      Source: spec.source,
      SourceRowId: rowid.slice(0, 255) || null,
      Email: event.email ? String(event.email).slice(0, 255) : null,
      /* 'consumer' and 'partner' are the column's existing vocabulary, read by
         crmSync to decide which module a row lands in. The house words are
         member and household; these two are the wire format of a table built in
         July and are not ours to rename from this side. */
      LeadType: event.leadType === 'partner' ? 'partner' : 'consumer',
      Payload: body,
      Status: statusNow(),
      Attempts: 0,
    };
    const withNew = Object.assign({}, legacy, {
      EntityType: spec.entity,
      EntityRowId: rowid.slice(0, 255) || null,
      EventType: eventType,
      EventVersion: Number(version) || 1,
      IdempotencyKey: `${spec.entity}:${rowid}:${eventType}:${version}`.slice(0, 255),
    });

    /* The ladder, kept and made LOUD rather than removed.
    
       The six columns exist in the console as of 2026-09-02, so the wide insert
       is the path every row should take, and the fallback is now a signal rather
       than a normal mode: it means a column was renamed, dropped, or never
       created in the environment this is running in. Removing the fallback
       outright would turn that into a lost event, which is worse; leaving it
       silent would let an environment run for weeks writing rows with no
       idempotency key and no dedupe. So it stays, and it complains.
    
       `scripts/test-crm-outbox.mjs` asserts that the wide path is the one taken
       when the columns are there. */
    try {
      await datastore.insertRow(catalystApp, TABLE, withNew);
    } catch (err) {
      try {
        await datastore.insertRow(catalystApp, TABLE, legacy);
        console.error(JSON.stringify({
          level: 'error',
          message: 'crm outbox fell back to the legacy columns: this row has NO idempotency key and cannot dedupe',
          event_type: eventType,
          detail: String((err && err.message) || err).slice(0, 200),
        }));
      } catch {
        throw err;
      }
    }
  } catch (err) {
    console.error(JSON.stringify({
      req_id: req && req.id,
      level: 'error',
      message: 'crm enqueue failed',
      event_type: event && event.eventType,
      detail: String((err && err.message) || err).slice(0, 200),
    }));
  }
}

/** Fire-and-forget, which is what nearly every call site wants: the row it cares
 *  about is already saved, and making a member wait on a mirror is the latency
 *  equivalent of rule 1. */
function enqueueAsync(catalystApp, req, event) {
  Promise.resolve(enqueue(catalystApp, req, event)).catch(() => {});
}

module.exports = {
  enqueue, enqueueAsync, EVENTS, EVENT_TYPES, ENTITY_TYPES, TABLE, scrub, nextVersion,
};
