'use strict';

/**
 * The canonical description of the auth Data Store schema.
 *
 * Catalyst has no DDL API, so the tables are created by hand in the console
 * from `scripts/create-tables.md`. That means the code's idea of the schema and
 * the console's idea of it can drift, and — because a wrong column name fails
 * at *runtime*, not at deploy — the drift surfaces as a 500 on someone's login
 * rather than as a failed build. This module is the defence: one declaration of
 * what the code expects, and `verify()` to check reality against it.
 *
 * Column names are case-sensitive.
 *
 * ROWID / CREATEDTIME / MODIFIEDTIME / CREATORID are added to every table by
 * Catalyst and are deliberately absent below: they are not ours to declare, and
 * listing them would make a correctly built table look wrong.
 *
 * Spec syntax, space-separated:
 *   varchar(N) | datetime | int | text | encrypted   the console's column type
 *   unique                                            IsUnique is on
 *   required                                          Mandatory is on
 *
 * `unique` and `required` are asserted. The type is *reported* rather than
 * asserted, because Catalyst's `data_type` strings are undocumented and an
 * over-strict match would cry wolf — with one exception, noted on `sessions`.
 */

/** Added by Catalyst to every table. Never declared, never created by hand. */
const MANAGED = Object.freeze(['ROWID', 'CREATEDTIME', 'MODIFIEDTIME', 'CREATORID']);

const TABLES = Object.freeze({
  users: {
    user_id:          'varchar(64) unique required',
    email_normalized: 'varchar(255) unique required', // race guard for concurrent signup
    email_display:    'varchar(255) required',
    first_name:       'varchar(100)',
    last_name:        'varchar(100)',
    user_type:        'varchar(16) required',
    status:           'varchar(16) required',
    // Cohort placement. `fsa` is the first three characters of the postal code
    // and is what a cohort is actually keyed on, so it is stored separately
    // rather than re-derived on every query — Catalyst has no computed columns
    // and no way to index an expression.
    postal_code:      'varchar(10)',
    fsa:              'varchar(3)',
    province_code:    'varchar(2)',
    phone:            'varchar(32)',
    referral_code:    'varchar(64)',
    last_login_at:    'datetime',
    crm_contact_id:   'varchar(64)',
  },
  auth_identities: {
    user_id:           'varchar(64) required',
    provider:          'varchar(16) required',
    provider_uid:      'varchar(255) required',
    // The composite (provider, provider_uid) flattened into one column, because
    // Catalyst's unique constraint is per-column and has no composite form.
    provider_key:      'varchar(255) unique required',
    email_at_provider: 'varchar(255)',
    linked_at:         'datetime',
  },
  credentials: {
    user_id:      'varchar(64) unique required',
    hash:         'encrypted',
    algo:         'varchar(64)',
    updated_at:   'datetime',
    failed_count: 'int',
    locked_until: 'datetime',
  },
  sessions: {
    session_id: 'varchar(64) unique required',
    // MUST NOT be encrypted: this is the lookup key on every authenticated
    // request, and Catalyst cannot filter on an encrypted column. It is already
    // a SHA-256 digest, so nothing is in the clear either way. This one type IS
    // asserted — getting it wrong makes every session lookup fail.
    token_hash: 'varchar(64) unique required',
    user_id:    'varchar(64) required',
    expires_at: 'datetime required',
    revoked_at: 'datetime',
    ip_hash:    'varchar(64)',
    user_agent: 'varchar(255)',
  },
  auth_challenges: {
    challenge_id:     'varchar(64) unique required',
    email_normalized: 'varchar(255) required',
    code_hash:        'encrypted',
    purpose:          'varchar(32) required',
    expires_at:       'datetime required',
    attempts:         'int',
    consumed_at:      'datetime',
    ip_hash:          'varchar(64)',
  },
  oauth_state: {
    state:         'varchar(255) unique required',
    pkce_verifier: 'encrypted',
    nonce:         'varchar(255)',
    redirect_to:   'varchar(255)',
    provider:      'varchar(16) required',
    expires_at:    'datetime required',
  },
  consents: {
    user_id:     'varchar(64) required',
    doc_type:    'varchar(32) required',
    doc_version: 'varchar(32) required',
    accepted_at: 'datetime required',
    ip_hash:     'varchar(64)',
  },
  provider_orgs: {
    org_id:          'varchar(64) unique required',
    legal_name:      'varchar(255) required',
    email_domain:    'varchar(255)',
    approval_status: 'varchar(16) required',
    approved_by:     'varchar(255)',
    approved_at:     'datetime',
    // Written by the admin console's reject action; read back on the review
    // screen. The reject route tolerates this column being absent (the reason
    // then survives only in the audit row), so adding it is non-breaking.
    rejection_reason: 'varchar(255)',
  },
  provider_users: {
    // Deliberately NOT unique: one person may act for two provider orgs (a
    // reseller bidding for two carriers). Adding the constraint later is easy;
    // removing one is not.
    user_id: 'varchar(64) required',
    org_id:  'varchar(64) required',
    role:    'varchar(16) required',
  },
  member_bills: {
    // One row per member: the household has one home-internet bill, and the
    // dashboard renders "the" switch file, not a history. A new checkup
    // replaces the row. History, when it is wanted, is a new table — turning
    // this into an append-only log would silently change what GET /me/bill
    // means.
    user_id:          'varchar(64) unique required',
    provider:         'varchar(100)',
    // Numbers stored as strings on purpose: bills carry cents, the console's
    // Int column cannot, and nothing ever filters or sums these server-side.
    monthly_cost:     'varchar(16)',
    download_speed:   'varchar(16)',
    access_tech:      'varchar(32)',
    // 'YYYY-MM-DD' or 'YYYY-MM', exactly as the dashboard's parsePromoEnd
    // reads it. Not a datetime: it is month-granular user input, and a
    // datetime column would force an invented day and time onto it.
    promo_end_date:   'varchar(10)',
    promo_expired:    'int',
    // Monthly promo credit, money-as-string like monthly_cost above.
    discount_amount:  'varchar(16)',
    // Same month-granular 'YYYY-MM-DD' / 'YYYY-MM' shape as promo_end_date.
    contract_start_date: 'varchar(10)',
    // The form's <select> values as typed: '12'|'24'|'36'|'0'|'-1'.
    contract_length:  'varchar(8)',
    switch_threshold: 'varchar(64)',
    source:           'varchar(32) required',
    updated_at:       'datetime required',
  },
  campaign_members: {
    // One row per (campaign, member) relationship, whatever its strength:
    // 'joined' a forming cohort, 'waitlist' for a region still gathering, or
    // 'alert' (the bell — "text me the day it opens"). The pair is flattened
    // into one unique column because Catalyst's unique constraint is
    // per-column, same as auth_identities.provider_key.
    membership_key: 'varchar(130) unique required', // `${campaign_id}:${user_id}`
    campaign_id:    'varchar(64) required',
    user_id:        'varchar(64) required',
    status:         'varchar(16) required',
    // Snapshot of users.fsa at join time — cohorts are keyed on FSA, and the
    // clustering job should see where the member was when they joined, not
    // where they moved later.
    fsa:            'varchar(3)',
    joined_at:      'datetime required',
  },
  site_config: {
    // Editable site information: prices, thresholds, notices, feature flags —
    // including bidding_enabled, the global kill switch. Written only by the
    // admin console; read by GET /public/config and server-side flag checks.
    // Every read path falls back to lib/siteconfig.js DEFAULTS when this
    // table is missing, so creating it is enabling, never load-bearing.
    config_key:  'varchar(64) unique required',
    value:       'text required',        // JSON-encoded, typed by value_type
    value_type:  'varchar(16) required', // string | number | boolean | json
    published:   'boolean',              // only published keys reach /public/config
    description: 'varchar(255)',
    updated_by:  'varchar(64)',
    updated_at:  'datetime',
  },
  campaigns: {
    // The campaign catalog, promoted from the code constant in
    // routes/campaigns.js. lib/catalog.js reads it with a 60s memo and falls
    // back to the code catalog when the table is missing or empty — so the
    // dashboards keep working before this exists, and the console's
    // "import defaults" seeds it with the same six rows.
    campaign_id:     'varchar(64) unique required', // slug, immutable once created
    region:          'varchar(100) required',
    sub:             'varchar(100)',
    // planned | waitlist | forming | auction | closed | archived
    kind:            'varchar(16) required',
    target:          'int',
    seed_members:    'int',
    seed_households: 'int',
    bidding_open:    'boolean', // only meaningful while kind = auction
    sort_order:      'int',
    updated_by:      'varchar(64)',
    updated_at:      'datetime',
    // The auction calendar. All seven are OPTIONAL: a cohort with no dates
    // behaves exactly as it did before they existed, because `kind` and
    // `bidding_open` remain the authority. lib/catalog.js derives the
    // partner-facing stage from these on every read, for DISPLAY only, and
    // requireBiddingOpen reads bidding_closes_at as a close-only backstop.
    // Dates may close a bid window; they may never open one.
    announce_at:       'datetime', // brief fixed, coverage-matched partners told
    bidding_opens_at:  'datetime',
    bidding_closes_at: 'datetime', // the one with teeth: past it, bids refuse
    offers_at:         'datetime', // winning offer goes to each household
    decision_at:       'datetime', // household confirmations lock
    switch_window_at:  'datetime', // installs and transfers run
    reconcile_at:      'datetime', // final counts settle
    // The brief's demand profile: renewal window, speed mix, plant mix, as a
    // JSON blob ops maintains. Read by the brief route with its OWN one-row
    // query, deliberately NOT via catalog.COLUMNS: catalog falls back to the
    // code catalog when its query throws, and naming a missing column there
    // would knock the whole site back to seed data.
    brief_json:        'text',
  },
  user_prefs: {
    // One JSON blob of preferences per account, member or provider alike:
    // notification toggles, interest flags, "tell me when this opens" marks.
    // A blob and not columns because these keys change with the product and a
    // console-only schema cannot keep up; nothing ever filters on a preference.
    pref_key:   'varchar(64) unique required', // users.user_id
    prefs:      'text required',               // JSON object
    updated_at: 'datetime required',
  },
  user_events: {
    // Append-only feedback from the dashboards: provider ratings, outage
    // reports, "first in line" interest, a partner's opening-day alerts.
    // Write-only from the product; the admin console reads it. Payload is JSON
    // and never filtered on — queries go by user_id or kind only.
    user_id:    'varchar(64) required',
    user_type:  'varchar(16)',
    kind:       'varchar(32) required',
    payload:    'text',
    created_at: 'datetime required',
  },
  provider_bids: {
    // The HEAD of one live sealed bid per (campaign, org): a convenience
    // mirror of the latest bid_revisions row, which is the authoritative
    // sealed record. The pair is flattened into one unique column, same trick
    // as membership_key. lib/bids.js is the only writer.
    bid_key:     'varchar(130) unique required', // `${campaign_id}:${org_id}`
    campaign_id: 'varchar(64) required',
    org_id:      'varchar(64) required',
    user_id:     'varchar(64) required',          // who placed it, for the org's own record
    price:       'varchar(16) required',          // headline: lowest tier's effective price
    speed:       'varchar(32)',                   // legacy flat shape, kept readable
    term:        'varchar(32)',
    includes:    'varchar(255)',                  // CSV of included extras
    completion:  'varchar(8)',                    // assumed completion %, as typed
    status:      'varchar(16) required',          // 'sealed' | 'improved'
    updated_at:  'datetime required',
    // The tiered bid, added by the auction core (create-tables.md section 18).
    // Reads fall back to the list above while these are missing; writes need
    // them.
    tiers:                  'text',               // JSON array of tier rows, money as strings
    guarantee_months:       'int',                // 12 | 24 | 36
    after_mode:             'varchar(8)',         // 'none' | 'new'
    after_line:             'varchar(255)',
    equipment:              'varchar(8)',         // 'inc' | 'rent' | 'byod'
    rental_monthly:         'varchar(16)',
    extra_pod_monthly:      'varchar(16)',
    reduction_presentation: 'varchar(16)',
    mechanism_label:        'varchar(64)',
    commitment_cap:         'int',
    revision_count:         'int',
    receipt_no:             'varchar(32)',
    payload_hash:           'varchar(64)',
    submitted_at:           'datetime',           // first sealing, written once
    last_revised_at:        'datetime',
  },
  bid_revisions: {
    // THE SEALED RECORD. Append-only, permanently: one row per sealing,
    // written BEFORE the head above, never updated, never deleted, no
    // withdraw path at any layer. The latest revision at close is the
    // binding bid. Addresses never enter this table, so retention never
    // redacts it.
    revision_key:       'varchar(200) unique required', // `${campaign}:${org}:${revision_no}`, the race guard
    bid_key:            'varchar(130) required',
    campaign_id:        'varchar(64) required',
    org_id:             'varchar(64) required',
    revision_no:        'int required',
    payload:            'text required',          // the canonical bid JSON, exactly as sealed
    payload_hash:       'varchar(64) required',
    receipt_no:         'varchar(32) required',   // random, never sequential
    submitted_by:       'varchar(64) required',
    server_received_at: 'datetime required',      // the clock reading the close was judged by
  },
  provider_coverage: {
    // The regions an org serves and with what. Rows the org declares itself
    // start as 'verifying' — serviceability is confirmed by an operator, not
    // asserted by the party it advantages.
    coverage_key: 'varchar(200) unique required', // `${org_id}:${region-slug}`
    org_id:       'varchar(64) required',
    region:       'varchar(100) required',
    techs:        'varchar(64) required',         // CSV: cable, fibre, fwa, dsl
    speed:        'varchar(16)',
    lead:         'varchar(32)',
    status:       'varchar(16) required',         // 'active' | 'verifying'
    updated_at:   'datetime required',
  },
  auth_events: {
    event_type:       'varchar(64) required',
    user_id:          'varchar(64)',
    email_normalized: 'varchar(255)',
    ip_hash:          'varchar(64)',
    user_agent:       'varchar(255)',
    outcome:          'varchar(16) required',
    detail:           'text',
  },
  provider_ratings: {
    // The dashboard's "One minute, once" card. One row per member — `unique`
    // on user_id is what makes a second POST /me/rating fail with CONFLICT
    // instead of silently overwriting the first, same trick as member_bills'
    // upsert key but refusing the second write rather than replacing it.
    user_id:     'varchar(64) unique required',
    provider:    'varchar(100) required',
    price:       'int required',
    reliability: 'int required',
    support:     'int required',
    speed:       'int required',
    created_at:  'datetime required',
  },
});

const TABLE_NAMES = Object.freeze(Object.keys(TABLES));

function parseSpec(spec) {
  const parts = String(spec).split(/\s+/);
  return {
    type: parts[0],
    unique: parts.includes('unique'),
    required: parts.includes('required'),
  };
}

const looksEncrypted = (dataType) => /encrypt/i.test(String(dataType || ''));

/**
 * Check the live Data Store against the declaration above.
 *
 * Uses the SDK's column metadata rather than probing with SELECTs: one call per
 * table returns every real column name, so a misspelling can be reported as
 * "you have `locked_untill`, expected `locked_until`" instead of the far less
 * actionable "something is missing".
 *
 * Returns a plain object safe to serialise — schema names only, never row data.
 */
async function verify(catalystApp) {
  const datastore = catalystApp.datastore();
  const tables = {};
  let okCount = 0;

  for (const table of TABLE_NAMES) {
    const expected = TABLES[table];
    let actual;

    try {
      actual = await datastore.table(table).getAllColumns();
    } catch (err) {
      tables[table] = { ok: false, table_missing: true, detail: short(err) };
      continue;
    }

    const byName = new Map(
      (actual || []).map((c) => [c.column_name, c])
    );

    const missing = [];
    const wrongUnique = [];
    const wrongRequired = [];
    const typeNotes = [];

    for (const [col, spec] of Object.entries(expected)) {
      const want = parseSpec(spec);
      const got = byName.get(col);

      if (!got) { missing.push(col); continue; }

      if (Boolean(got.is_unique) !== want.unique) {
        wrongUnique.push(`${col}: is_unique=${Boolean(got.is_unique)}, expected ${want.unique}`);
      }
      if (Boolean(got.is_mandatory) !== want.required) {
        wrongRequired.push(`${col}: mandatory=${Boolean(got.is_mandatory)}, expected ${want.required}`);
      }

      // The one asserted type. An encrypted token_hash cannot be filtered on,
      // so every session lookup would fail — at runtime, on every request.
      if (table === 'sessions' && col === 'token_hash' && looksEncrypted(got.data_type)) {
        typeNotes.push(`token_hash is ${got.data_type} — MUST be Var Char, it is queried on every request`);
      }
      // Encrypted columns cannot appear in a WHERE clause. Flag the inverse too:
      // a column we expect to be encrypted that plainly is not.
      if (want.type === 'encrypted' && !looksEncrypted(got.data_type)) {
        typeNotes.push(`${col} is ${got.data_type}, expected Encrypted text`);
      }
    }

    // Columns present in the console that the code knows nothing about. Not an
    // error — but a typo usually shows up here as the twin of a `missing` entry,
    // which is what turns "missing" into "misspelled as".
    const unexpected = [...byName.keys()]
      .filter((n) => !MANAGED.includes(n) && !(n in expected))
      .sort();

    const problems = missing.length || wrongUnique.length || wrongRequired.length || typeNotes.length;
    if (!problems) {
      okCount++;
      tables[table] = unexpected.length
        ? { ok: true, columns: Object.keys(expected).length, unexpected }
        : { ok: true, columns: Object.keys(expected).length };
    } else {
      tables[table] = {
        ok: false,
        ...(missing.length ? { missing } : {}),
        ...(unexpected.length ? { unexpected } : {}),
        ...(wrongUnique.length ? { unique_mismatch: wrongUnique } : {}),
        ...(wrongRequired.length ? { mandatory_mismatch: wrongRequired } : {}),
        ...(typeNotes.length ? { type_problems: typeNotes } : {}),
      };
    }
  }

  return {
    ok: okCount === TABLE_NAMES.length,
    tables_expected: TABLE_NAMES.length,
    tables_ok: okCount,
    tables,
  };
}

/** First line of an error, length-capped. Never the stack, never a value. */
function short(err) {
  return String((err && err.message) || err).split('\n')[0].slice(0, 200);
}

module.exports = { TABLES, TABLE_NAMES, MANAGED, verify };
