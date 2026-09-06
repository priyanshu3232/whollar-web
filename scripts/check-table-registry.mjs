#!/usr/bin/env node
/* The two table registries, checked against each other and against the runbook.
 *
 *   node scripts/check-table-registry.mjs
 *
 * WHY A GATE AND NOT A RUNTIME ASSERTION. Catalyst packages each function
 * separately: auth, formSubmit, crmSync and billOcr each get their own folder,
 * their own package.json and their own node_modules, and nothing outside a
 * function's folder is uploaded with it. So there is no module the four can
 * share, and "one registry" has to mean "two registries plus something that
 * refuses to let them disagree". A require-time assertion inside a function
 * would take that whole function down over a documentation mistake, which is a
 * worse failure than the one it prevents. This runs in CI instead.
 *
 * WHAT IT CHECKS
 *   1. the auth registry names exactly the tables schema.js declares
 *   2. every table name appearing as a literal in a function's source is in
 *      that function's registry
 *   3. crmSync's QUEUE_TABLE matches the formSubmit registry's entry
 *   4. every registered name appears in create-tables.md, so a table cannot be
 *      invented in code with no console instructions behind it
 *   5. the case rule holds: auth tables are lower_snake_case, formSubmit tables
 *      are PascalCase
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Whether a table exists in the live Data
 * Store. That is a question for `catalyst ds:export` and /health/diagnostics,
 * not for a gate that has to pass offline, and eight registered tables do not
 * exist today on purpose: sections 27, 34 and 40 shipped before their console
 * work. See docs/ACTION_TABLE_AUDIT.md.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const F = (p) => join(ROOT, p);

const AUTH_SRC = 'catalyst-backend/functions/auth/src';
const FORM_DIR = 'catalyst-backend/functions/formSubmit';
const RUNBOOK = 'catalyst-backend/scripts/create-tables.md';

const problems = [];
const fail = (msg) => problems.push(msg);

/* ---- the registries ---- */
const authReg = require(F(`${AUTH_SRC}/lib/tables.js`));
const formReg = require(F(`${FORM_DIR}/tables.js`));
const { TABLES } = require(F(`${AUTH_SRC}/lib/schema.js`));

const authOwned = Object.values(authReg.T).map((t) => t.name);
const authRead = Object.values(authReg.F).map((t) => t.name);
const formOwned = Object.values(formReg.T).map((t) => t.name);

/* ---- 1. the auth registry and schema.js name the same set ---- */
const declared = Object.keys(TABLES);
for (const n of authOwned) {
  if (!declared.includes(n)) fail(`tables.js names ${n}, schema.js does not declare it`);
}
for (const n of declared) {
  if (!authOwned.includes(n)) fail(`schema.js declares ${n}, tables.js does not name it`);
}

/* ---- 2. every literal in a function's source is registered ---- */
const KNOWN = new Set([...authOwned, ...authRead, ...formOwned]);

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.output') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js') && !e.name.includes('.bak-')) out.push(p);
  }
  return out;
}

/* Only names that are already known anywhere are considered, because a bare
 * quoted word is not evidence of a table: `'users'` is a table, `'status'` is
 * not, and no regex tells them apart. What this catches is the real failure
 * mode, a table literal left behind in one function while the registry moved,
 * or a name reached from the function that must not touch it. */
function literalsIn(file) {
  // Comments are stripped first, and that is not tidiness. This codebase
  // explains a table by naming the one it is NOT: `product_interest` and
  // `referral_token` both appear in formSubmit comments saying exactly why the
  // code beside them does not touch those tables. Counting a comment as a
  // reference would make the gate punish the clearest writing in the file.
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const found = new Set();
  for (const m of src.matchAll(/['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/g)) {
    if (KNOWN.has(m[1])) found.add(m[1]);
  }
  return found;
}

const authAllowed = new Set([...authOwned, ...authRead]);
for (const file of jsFiles(F(AUTH_SRC))) {
  // tables.js is the registry itself and schema.js is the column declaration:
  // both name tables as their whole job.
  if (file.endsWith('lib/tables.js') || file.endsWith('lib/schema.js')) continue;
  for (const n of literalsIn(file)) {
    if (!authAllowed.has(n)) {
      fail(`${file.replace(ROOT + '/', '')} names ${n}, which the auth registry does not carry`);
    }
  }
}

const formAllowed = new Set(formOwned);
for (const file of jsFiles(F(FORM_DIR))) {
  if (file.endsWith('/tables.js')) continue;
  for (const n of literalsIn(file)) {
    if (!formAllowed.has(n)) {
      fail(`${file.replace(ROOT + '/', '')} names ${n}, which the formSubmit registry does not carry`);
    }
  }
}

/* ---- 3. crmSync agrees with the formSubmit registry ---- */
const crmSrc = readFileSync(F('catalyst-backend/functions/crmSync/index.js'), 'utf8');
const queueMatch = crmSrc.match(/const QUEUE_TABLE = '([A-Za-z_][A-Za-z0-9_]*)'/);
if (!queueMatch) {
  fail('crmSync/index.js has no QUEUE_TABLE constant to check');
} else if (queueMatch[1] !== formReg.T.crmSyncQueue.name) {
  fail(`crmSync names ${queueMatch[1]}, the formSubmit registry says ${formReg.T.crmSyncQueue.name}`);
}

/* ---- 4. every registered name is in the runbook ---- */
const runbook = readFileSync(F(RUNBOOK), 'utf8');
for (const n of [...authOwned, ...formOwned]) {
  if (!runbook.includes('`' + n + '`')) {
    fail(`${n} is registered but never named in ${RUNBOOK}: there are no console instructions for it`);
  }
}

/* ---- 5. the case rule ---- */
for (const n of authOwned) {
  if (!/^[a-z][a-z0-9_]*$/.test(n)) fail(`${n} is an auth table and must be lower_snake_case`);
}
for (const n of formOwned) {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(n)) fail(`${n} is a formSubmit table and must be PascalCase`);
}

/* ---- report ---- */
if (problems.length) {
  console.error('check-table-registry: FAILED');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(
  `check-table-registry: OK, ${authOwned.length} auth tables, ${formOwned.length} formSubmit tables, ` +
  `${authRead.length} read across the line`
);
