'use strict';

/**
 * Append-only writes to `CrmSyncQueue`, from the auth function.
 *
 * The queue, the worker and the cron already exist: `formSubmit` has enqueued
 * the six marketing forms since July and `crmSync` drains them into Zoho on a
 * schedule. What has never existed is a note from anything BEHIND the sign-in
 * door, so CRM knows who filled in a form and nothing about who then created
 * an account, joined a cohort, applied as a partner, sealed a bid, accepted an
 * offer or had a line activated. This is the missing half.
 *
 * No new table. `CrmSyncQueue` is source-agnostic by design: a Source string, a
 * SourceRowId, an Email and a JSON Payload. Adding a source is adding a name
 * here and a descriptor in crmSync, not a migration.
 *
 * Three rules, enforced here rather than trusted to call sites:
 *
 *   1. A FAILED ENQUEUE MUST NEVER FAIL THE REQUEST. Losing one CRM note is
 *      an inconvenience; refusing somebody's signup, or a partner's sealed bid,
 *      because a marketing queue was unreachable is not a trade anyone would
 *      make. Every write swallows its own error and logs it, exactly as
 *      lib/audit.js does and for the same reason.
 *
 *   2. THE INSTALL ADDRESS NEVER LEAVES. `provider_orders` holds a household's
 *      address and mobile against a partner, and only because that household
 *      ticked a release saying so, for one install visit. A CRM record is a
 *      different audience with a different retention period and a much wider
 *      reader list. `stripPrivate()` drops those keys by name whatever a call
 *      site passes, so a caller who spreads a whole order row into the payload
 *      does not thereby publish where somebody lives.
 *
 *   3. NOTHING SHIPS UNTIL SOMEBODY SAYS SO. New sources are written PARKED,
 *      which the worker's `WHERE Status = 'PENDING'` does not select. Capture
 *      starts the day this deploys; delivery starts when the flag below is
 *      flipped. See "The parked lane".
 *
 * THE PARKED LANE, and why it is not just PENDING. Parked rows are invisible to
 * the drain rather than merely last in it. Left PENDING they would sort to the
 * head by CREATEDTIME and every batch of 50 would fill with rows the worker has
 * no descriptor for yet, so the working form sync would stop dead behind them.
 * Invisible is the only safe holding state in a FIFO queue.
 *
 * Release is two moves, in this order:
 *   1. `CRM_NEW_SOURCES=true` on the auth function, so NEW notes go straight to
 *      PENDING. An env var and not a constant, so the flip needs no deploy.
 *   2. `UPDATE CrmSyncQueue SET Status = 'PENDING' WHERE Status = 'PARKED'`
 *      in the ZCQL console, once, to release everything already captured.
 */

const datastore = require('./datastore');

const TABLE = 'CrmSyncQueue';

/**
 * Every source this function may enqueue. A frozen list and not free-form
 * strings, because a typo'd Source is not an error anywhere: the row inserts,
 * the worker finds no descriptor, and the note lands in Zoho under a label
 * nobody meant. The names are matched by the descriptor table in
 * crmSync/index.js, so the two lists are one list in two places and adding to
 * either alone is the mistake this guards against.
 */
const SOURCES = Object.freeze({
  MEMBER_SIGNUP:      'MemberSignups',
  PARTNER_SIGNUP:     'PartnerSignups',
  PARTNER_ORG:        'PartnerOrgs',
  PARTNER_APPLIED:    'ProviderApplications',
  PARTNER_DECISION:   'PartnerApprovals',
  PARTNER_TERMS:      'PartnerTerms',
  PARTNER_BILLING:    'PartnerBilling',
  COHORT_SEAT:        'CohortSeats',
  SEALED_BID:         'SealedBids',
  COHORT_AWARD:       'CohortAwards',
  HOUSEHOLD_ORDER:    'HouseholdOrders',
  EMAIL_SUPPRESSION:  'EmailSuppressions',
});
const SOURCE_VALUES = Object.freeze(Object.values(SOURCES));

/**
 * Keys that never reach CRM, whatever a call site passes. Rule 2 above.
 *
 * `address_line` and the order's `phone` are the load-bearing pair: they exist
 * in exactly one table, released by the household to exactly one partner, for
 * exactly one visit. The rest are here because an order or a member row spread
 * into a payload carries them along and none of them answers a question CRM
 * asks. A member's own signup phone is NOT on this list and is not meant to be:
 * the waitlist form has sent that to Zoho since July and it is how anybody gets
 * called back.
 */
const PRIVATE_KEYS = /^(address|address_line|street|unit|buzzer|slot_address|install_phone|order_phone|member_phone)$/i;

/**
 * Keys whose value is a secret whatever it looks like, and shapes that are a
 * secret whatever the key is called. Same intent as lib/audit.js, deliberately
 * NOT the same function.
 *
 * `audit.scrub` is built for a log line and bounds one: arrays are cut to 20,
 * strings to 500 characters, anything past four levels becomes '[deep]'. Those
 * are the right limits for something a person reads in a console and the wrong
 * ones here, because this payload is the note itself. A cohort's tier list or a
 * household's cars quietly losing members would produce a CRM record that is
 * confidently wrong, which is worse than one that is obviously missing. So the
 * secret-detection is shared in spirit and the truncation is not: size is
 * governed by PAYLOAD_MAX below, once, at the end.
 */
const SECRET_KEYS = /^(code|otp|token|password|pass|pwd|secret|hash|authorization|cookie|id_token|access_token|refresh_token|client_secret|pkce_verifier|verifier|nonce|ip|ip_hash|consent_hash|payload_hash)$/i;

const looksSecret = (s) =>
  /^\d{6}$/.test(s) ||                       // a bare OTP
  /^[A-Fa-f0-9]{32,}$/.test(s) ||            // a digest
  /^[A-Za-z0-9_-]{40,}$/.test(s);            // a base64url token

/**
 * One pass: drop what may never leave, mark what is a secret, keep the rest
 * whole. The depth cap is a cycle guard and nothing else, which is why it is
 * generous: `JSON.stringify` throws on a circular reference, but this recursion
 * would not reach it.
 */
function stripPrivate(value, depth = 0) {
  if (depth > 8) return '[deep]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => stripPrivate(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PRIVATE_KEYS.test(k)) continue;
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : stripPrivate(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return looksSecret(value) ? '[redacted]' : value;
  return value;
}

/**
 * `Payload` is Text 25000 in the console. Nothing a call site here builds comes
 * near that, but the cap is checked rather than reasoned about: an over-long
 * value is dropped for a marker instead of being truncated, because a JSON
 * string cut in half takes the whole note with it when the worker parses it.
 */
const PAYLOAD_MAX = 20000;

function payloadFor(data) {
  const json = JSON.stringify(stripPrivate(data || {}));
  if (json.length <= PAYLOAD_MAX) return json;
  return JSON.stringify({ oversize: true, bytes: json.length });
}

/**
 * PENDING once the operator says so, PARKED until then. Read per call rather
 * than cached at require time, so flipping the console variable takes effect on
 * the next request instead of the next cold start.
 */
const statusNow = () => (String(process.env.CRM_NEW_SOURCES || '').trim() === 'true' ? 'PENDING' : 'PARKED');

/**
 * Queue one event for the CRM worker. Best-effort: see rule 1.
 *
 * @param {object} catalystApp
 * @param {object} req                  for the request id in the failure log
 * @param {object} event
 * @param {string} event.source         one of SOURCES
 * @param {string} [event.rowId]        the source row's own key, for repair later
 * @param {string} event.email          who this is about; the worker matches on it
 * @param {'consumer'|'partner'} [event.leadType]
 * @param {object} [event.data]         scrubbed and stripped before it is written
 */
async function enqueue(catalystApp, req, event) {
  try {
    const source = event && event.source;
    /* An unknown source is a programming error, not a runtime condition, and it
       is caught here because the alternative is finding it in Zoho. */
    if (!SOURCE_VALUES.includes(source)) {
      throw new Error(`unknown CRM source ${JSON.stringify(source)}`);
    }
    if (!event.email) throw new Error(`${source} enqueued with no email`);

    await datastore.insertRow(catalystApp, TABLE, {
      Source: source,
      SourceRowId: event.rowId != null ? String(event.rowId).slice(0, 255) : null,
      Email: String(event.email).slice(0, 255),
      /* 'consumer' and 'partner' are the column's existing vocabulary, read by
         crmSync to decide which module a row lands in. The house words are
         member and household; these two are the wire format of a table built in
         July and are not ours to rename from this side. */
      LeadType: event.leadType === 'partner' ? 'partner' : 'consumer',
      Payload: payloadFor(event.data),
      Status: statusNow(),
      Attempts: 0,
    });
  } catch (err) {
    console.error(JSON.stringify({
      req_id: req && req.id,
      level: 'error',
      message: 'crm enqueue failed',
      source: event && event.source,
      detail: String((err && err.message) || err).slice(0, 200),
    }));
  }
}

/**
 * Fire-and-forget, which is what nearly every call site wants: the row it cares
 * about is already saved, and making a member wait on a marketing queue is the
 * latency equivalent of rule 1.
 */
function enqueueAsync(catalystApp, req, event) {
  Promise.resolve(enqueue(catalystApp, req, event)).catch(() => {});
}

module.exports = { enqueue, enqueueAsync, SOURCES, SOURCE_VALUES, TABLE, stripPrivate };
