#!/usr/bin/env node
/* The Data Store inventory, generated from the schema the code believes in.
 *
 *   node scripts/build-tables-doc.mjs           write catalyst-backend/TABLES.md
 *   node scripts/build-tables-doc.mjs --check   fail if it is stale (CI)
 *
 * WHY GENERATED. Catalyst has no DDL API, so the console is built by hand from
 * scripts/create-tables.md and the code's expectations live in schema.js. A
 * hand-written inventory would be a third description of the same thing, and
 * the third one is always the one that goes stale. This reads schema.js twice:
 * `require` for the authoritative spec strings, and a text parse of the same
 * file for the comments, because the comments are the half that explains why a
 * column exists and they do not survive the require.
 *
 * META below is a hardcoded list, on purpose and in the same spirit as every
 * other gate here: a table added to schema.js without a line in META fails this
 * script rather than quietly appearing undocumented.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_REL = 'catalyst-backend/functions/auth/src/lib/schema.js';
const OUT_REL = 'catalyst-backend/TABLES.md';
const check = process.argv.includes('--check');

const require = createRequire(import.meta.url);
const { TABLES } = require(join(ROOT, SRC_REL));
const source = readFileSync(join(ROOT, SRC_REL), 'utf8');

/* ---- domain, runbook section, and the one-line purpose, per table ---- */

const D = {
  ID: 'Identity and access',
  AUDIT: 'Audit and preferences',
  HOUSE: 'Households',
  PARTNER: 'Partners',
  COHORT: 'Cohorts',
  AUCTION: 'The auction',
  DELIVERY: 'Delivery and billing',
  BRAND: 'Brands and exclusions',
  GROWTH: 'Growth and sharing',
  NOTIFY: 'Notifications',
  CONFIG: 'Configuration',
};
const DOMAIN_ORDER = [D.ID, D.AUDIT, D.HOUSE, D.PARTNER, D.COHORT, D.AUCTION,
  D.DELIVERY, D.BRAND, D.GROWTH, D.NOTIFY, D.CONFIG];

const META = {
  users:            [D.ID, '1', 'One row per account, member or partner or staff. `email_normalized` is unique as the race guard against concurrent signup'],
  auth_identities:  [D.ID, '2', 'Links an account to an external identity provider'],
  credentials:      [D.ID, '3', 'Password hashes, one row per account that has one'],
  sessions:         [D.ID, '4', 'Live sessions. The one table whose column types are asserted strictly'],
  auth_challenges:  [D.ID, '5', 'OTP and verification challenges in flight'],
  oauth_state:      [D.ID, '6', 'CSRF state for the OAuth round trip'],
  consents:         [D.ID, '7', 'What was agreed to, when, and against which wording'],

  auth_events:      [D.AUDIT, '10', 'The audit trail. Writes are swallowed by design so they cannot break a login, which is why its row count is worth watching'],
  user_prefs:       [D.AUDIT, '15', 'One JSON blob of preferences per account'],
  user_events:      [D.AUDIT, '15', 'Append-only feedback from the dashboards: ratings, notes, the feedback kind'],

  member_bills:     [D.HOUSE, '11', 'One row per member: a household has one home internet bill'],
  provider_ratings: [D.HOUSE, '13', 'The dashboard\'s "One minute, once" card'],
  product_interest: [D.HOUSE, '23', 'The product interest survey. Writes fail silently, so verify in ZCQL and not in the browser'],

  provider_orgs:    [D.PARTNER, '8',  'The partner company, and its approval state'],
  provider_users:   [D.PARTNER, '9',  'Who acts for which org. Deliberately not unique: one person may act for two'],
  provider_coverage:[D.PARTNER, '16', 'The regions an org serves and with what, declared then verified'],
  provider_terms:   [D.PARTNER, '20', 'Terms acceptance, one row per org per version, never updated'],

  campaigns:        [D.COHORT, '16, 29', 'The cohort catalog and the auction calendar. `region` is the partner key, `fsas` the member key, and neither derives the other'],
  campaign_members: [D.COHORT, '12', 'One row per (cohort, member): joined, waitlist, or alert'],
  campaign_notices: [D.COHORT, '27', 'One row per (cohort, stage) announced to its households'],
  seat_claim:       [D.COHORT, '26a', 'A held seat and its exit window'],
  claim_event:      [D.COHORT, '26b', 'Append only. `event_key` unique is the whole double-claim race guard'],
  cohort_counter:   [D.COHORT, '26c', 'The seat count sidecar'],

  provider_bids:        [D.AUCTION, '16, 18, 28, 34e', 'The head of one live sealed bid per (cohort, org). A mirror, not the record'],
  bid_revisions:        [D.AUCTION, '18', '**The sealed record.** Append only, permanently. One row per sealing'],
  campaign_awards:      [D.AUCTION, '21, 30b', 'Won tier by tier, but the grain is (cohort, org): one roster to release'],
  campaign_price_books: [D.AUCTION, '30a', 'The sealed book: the price for every tier at least one partner quoted'],
  household_offers:     [D.AUCTION, '32, 34f', 'The three cards one household was shown, versioned and never rewritten'],

  provider_orders:     [D.DELIVERY, '21, 30c, 31', 'Acceptance through activation. The only table holding a household address against a partner, and only because the household released it'],
  provider_billing:    [D.DELIVERY, '21', 'One billing arrangement per partner, not per cohort'],
  provider_statements: [D.DELIVERY, '21', 'Settlement records only. Accruing is the absence of a row'],

  brand_registry:             [D.BRAND, '34a', 'The canonical brand list, and where a flanker brand is tied to its parent'],
  provider_brands:            [D.BRAND, '34b', 'The brands a partner has attested to operating'],
  distributor_providers:      [D.BRAND, '34c', 'The providers a distributor has attested to serving'],
  member_provider_exclusions: [D.BRAND, '34d', 'The brands whose offers must never reach one household'],
  brand_requests:             [D.BRAND, '34g', 'Optional. A partner asking for a brand the registry does not list'],

  referral_token: [D.GROWTH, '24a', 'A member\'s opaque share token'],
  invite_click:   [D.GROWTH, '25a', 'The `/r/:token` cookie lane, first touch'],
  share_event:    [D.GROWTH, '25b', 'What was shared, from which surface, at which stage'],

  notification_outbox:     [D.NOTIFY, '33a', 'One row per (event, template, recipient)'],
  notification_deliveries: [D.NOTIFY, '33b', 'Append only. One row per attempt, one more per webhook event'],
  email_suppressions:      [D.NOTIFY, '33c', 'The addresses nothing may be written to, and why'],
  unsubscribe_tokens:      [D.NOTIFY, '33d', 'One row per (recipient, scope), reused rather than minted per message'],

  site_config: [D.CONFIG, '16', 'Prices, thresholds, notices, feature flags. `success_fee` lives here, which is why the fee is never a constant in code'],
};

/* Tables the console has that schema.js never declared. Column lists are the
   runbook's, not the code's, because there is no code declaration to read. */
const UNDECLARED = [
  ['provider_applications', '17', 'The founding partner application, one per org. Keys `application_id` and `org_id`'],
  ['application_tasks', '17', "The application's checklist"],
  ['provider_documents', '17, 22a', 'Uploaded documents, with the retention stamp'],
  ['provider_references', '17', 'Referees given on the application'],
  ['coverage_verifications', '17', "The operator's verdict on a claimed region"],
];

/* formSubmit's tables. The admin console reads them through a hardcoded column
   allowlist in routes/admin.js (LEAD_TABLES), which is their only declaration. */
const LEGACY = [
  ['WaitlistSignups', '/waitlist-join', 'yes'],
  ['WaitlistDetails', '/waitlist-details, still the cohort join form\'s target', 'yes'],
  ['BillCheckupSubmissions', '/bill-checkup-join', 'yes'],
  ['DeepReadRequests', '/deep-read', 'yes, tagged hot'],
  ['PartnerApplications', '/partner-application', 'yes, to the partner module'],
  ['ContactSubmissions', '/contact', 'yes'],
  ['CalculatorEstimates', '/calculator-estimate', '**no, deliberately**: the estimate is anonymous'],
  ['CrmSyncQueue', 'every enqueue above', 'it **is** the queue'],
];

/* ---- parse the comments the require cannot carry ---- */

// Returns { tableComment, columns: { name: comment } } for one table block.
function commentsFor(table) {
  const start = source.indexOf(`\n  ${table}: {\n`);
  if (start < 0) return { table: '', columns: {} };
  const end = source.indexOf('\n  },', start);
  const lines = source.slice(start + 1, end).split('\n').slice(1);

  let pending = [];
  let tableComment = '';
  const columns = {};
  let seenColumn = false;

  for (const line of lines) {
    const cm = /^\s*\/\/ ?(.*)$/.exec(line);
    if (cm) { pending.push(cm[1].trim()); continue; }
    const col = /^\s{4}([a-z_]+):/.exec(line);
    if (col) {
      const text = pending.join(' ').replace(/\s+/g, ' ').trim();
      if (!seenColumn && text) { tableComment = text; seenColumn = true; }
      else if (text) columns[col[1]] = text;
      pending = [];
      seenColumn = true;
    }
  }
  return { table: tableComment, columns };
}

// 'varchar(64) unique required' -> { type, unique, required }
function parseSpec(spec) {
  const parts = String(spec).split(/\s+/);
  return {
    type: parts[0],
    unique: parts.includes('unique'),
    required: parts.includes('required'),
  };
}

/* ---- registration gate ---- */

const declared = Object.keys(TABLES);
const unregistered = declared.filter((t) => !META[t]);
const orphaned = Object.keys(META).filter((t) => !declared.includes(t));
if (unregistered.length || orphaned.length) {
  if (unregistered.length) {
    console.error(`build-tables-doc: schema.js declares ${unregistered.join(', ')} with no line in META. Add one, with its domain, runbook section and a one-line purpose.`);
  }
  if (orphaned.length) {
    console.error(`build-tables-doc: META names ${orphaned.join(', ')}, which schema.js no longer declares. Remove the line.`);
  }
  process.exit(1);
}

/* ---- emit ---- */

const total = declared.length + UNDECLARED.length + LEGACY.length;
const out = [];
const w = (s = '') => out.push(s);

w('# Every Data Store table, in one place');
w();
w('<!-- GENERATED by scripts/build-tables-doc.mjs. Do not hand-edit: run the');
w('     generator and commit the diff, or the --check gate reports STALE. -->');
w();
w('An index and a schema, not a build guide. `scripts/create-tables.md` says how');
w('to create each table, `functions/auth/src/lib/schema.js` declares what the code');
w('expects, and this file says what exists, with every column, and why.');
w();
w(`**${total} tables**: ${declared.length} declared in \`schema.js\`, ${UNDECLARED.length} the partner application uses but`);
w(`\`schema.js\` never declared, and ${LEGACY.length} belonging to the legacy marketing forms.`);
w();
w('## The authority chain');
w();
w('| Question | Answer lives in |');
w('| --- | --- |');
w('| What should this table look like? | `schema.js`, the one declaration |');
w('| How do I create it? | `scripts/create-tables.md`, by section |');
w('| Does it exist right now, with the right columns? | `GET /api/auth/health/diagnostics` |');
w();
w('Catalyst has no DDL API. Tables are made by hand in the console, so the code\'s');
w('idea of the schema and the console\'s idea of it drift, and a wrong column name');
w('fails at runtime rather than at deploy. That is what `verify()` is for.');
w();
w('**Ask reality rather than this file.** With an admin session:');
w();
w('```');
w('GET /api/auth/health/diagnostics');
w('```');
w();
w('It returns, for every table `schema.js` declares, whether it exists, which');
w('columns are missing, which are misflagged, and a capped row count. Any status');
w('written into a document goes stale; that endpoint cannot.');
w();
w('## Two gaps worth knowing about');
w();
w('**Five tables are not declared.** Runbook section 17 builds the five under');
w('"Undeclared" below, and none appears in `schema.js`. So `verify()` does not');
w('check them and `/health/diagnostics` will not notice when one is missing or has');
w('a misspelled column. The whole founding partner journey runs on tables with no');
w('drift detection. Declaring them is additive and breaks nothing.');
w();
w('**The eight legacy tables are not declared either**, which matters less: they');
w('predate `schema.js`, they belong to `formSubmit` rather than to auth, and');
w('`routes/admin.js` holds its own hardcoded column allowlist for them.');
w();

/* Index */
w('## Index');
w();
w('| Table | Key | Cols | Section | What it is |');
w('| --- | --- | --- | --- | --- |');
for (const domain of DOMAIN_ORDER) {
  for (const t of declared.filter((x) => META[x][0] === domain)) {
    const cols = Object.entries(TABLES[t]);
    const keys = cols.filter(([, s]) => parseSpec(s).unique).map(([c]) => `\`${c}\``);
    // GitHub keeps underscores in heading anchors and strips the backticks,
    // so the anchor for #### `auth_identities` is #auth_identities.
    w(`| [\`${t}\`](#${t}) | ${keys.join(', ') || 'none'} | ${cols.length} | ${META[t][1]} | ${META[t][2]} |`);
  }
}
for (const [t, sec, purpose] of UNDECLARED) {
  w(`| \`${t}\` | see runbook | n/a | ${sec} | **Not declared.** ${purpose} |`);
}
for (const [t, , crm] of LEGACY) {
  w(`| \`${t}\` | see below | n/a | legacy | formSubmit table. Feeds CRM: ${crm} |`);
}
w();

/* Full schema, domain by domain */
w('## The schema, column by column');
w();
w('Type, `unique` and `required` are exactly what `schema.js` asserts. Catalyst');
w('adds `ROWID`, `CREATEDTIME`, `MODIFIEDTIME` and `CREATORID` to every table and');
w('they are deliberately absent here: they are not ours to declare, and listing');
w('them would make a correctly built table look wrong.');
w();

for (const domain of DOMAIN_ORDER) {
  w(`### ${domain}`);
  w();
  for (const t of declared.filter((x) => META[x][0] === domain)) {
    const c = commentsFor(t);
    w(`#### \`${t}\``);
    w();
    w(`Runbook section ${META[t][1]}. ${META[t][2]}.`);
    w();
    if (c.table) { w(c.table); w(); }
    w('| Column | Type | Unique | Required |');
    w('| --- | --- | --- | --- |');
    for (const [col, spec] of Object.entries(TABLES[t])) {
      const p = parseSpec(spec);
      w(`| \`${col}\` | \`${p.type}\` | ${p.unique ? 'yes' : ''} | ${p.required ? 'yes' : ''} |`);
    }
    w();
    const noted = Object.entries(c.columns);
    if (noted.length) {
      for (const [col, text] of noted) w(`- \`${col}\`: ${text}`);
      w();
    }
  }
}

/* Undeclared */
w('### Undeclared');
w();
w('Built by runbook section 17, used by `routes/application.js` and the admin');
w('console, declared nowhere. The columns are in the runbook; there is no code');
w('declaration to read, which is the problem.');
w();
w('| Table | Section | What it is |');
w('| --- | --- | --- |');
for (const [t, sec, purpose] of UNDECLARED) w(`| \`${t}\` | ${sec} | ${purpose} |`);
w();

/* Legacy */
w('### Legacy marketing forms');
w();
w('Owned by `functions/formSubmit`, not by auth. The column allowlist that lets');
w('the admin console read them is hardcoded in `routes/admin.js` as `LEAD_TABLES`.');
w();
w('| Table | Written by | Feeds CRM |');
w('| --- | --- | --- |');
for (const [t, by, crm] of LEGACY) w(`| \`${t}\` | ${by} | ${crm} |`);
w();

w('## Five rules that apply to every table here');
w();
w('From the head of `create-tables.md`, repeated because they are the ones people');
w('get wrong:');
w();
w('1. Column names are case sensitive.');
w('2. `ROWID`, `CREATEDTIME`, `MODIFIEDTIME` and `CREATORID` are added by');
w('   Catalyst. Never create them by hand.');
w('3. There are no joins, no composite keys and no parameter binding. A composite');
w('   key is flattened into one unique column, which is why `bid_key`,');
w('   `membership_key`, `order_key` and the rest exist in that shape.');
w('4. `LIMIT 300` per query, roughly 15k rows through `queryAll`.');
w('5. A projection that names a column the console does not have empties the whole');
w('   surface, so every read that touches a newer column carries a fallback ladder.');
w('   Check the runbook section before assuming a column is safe to select.');

const text = out.join('\n') + '\n';
const OUT = join(ROOT, OUT_REL);

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error(`build-tables-doc: ${OUT_REL} is STALE. Run: node scripts/build-tables-doc.mjs`);
    process.exit(1);
  }
  console.log(`build-tables-doc: OK, ${total} tables, ${OUT_REL} current`);
  process.exit(0);
}

writeFileSync(OUT, text);
const columns = declared.reduce((n, t) => n + Object.keys(TABLES[t]).length, 0);
console.log(`build-tables-doc: wrote ${OUT_REL}, ${total} tables, ${columns} declared columns`);
