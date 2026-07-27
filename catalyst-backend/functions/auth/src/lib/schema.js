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
    user_type:        'varchar(16) required',
    status:           'varchar(16) required',
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
  },
  provider_users: {
    // Deliberately NOT unique: one person may act for two provider orgs (a
    // reseller bidding for two carriers). Adding the constraint later is easy;
    // removing one is not.
    user_id: 'varchar(64) required',
    org_id:  'varchar(64) required',
    role:    'varchar(16) required',
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
