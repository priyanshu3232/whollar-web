#!/usr/bin/env node
/* Which registered tables actually exist in the Data Store.
 *
 *   node scripts/check-store-tables.mjs                 both families
 *   node scripts/check-store-tables.mjs --family=form   formSubmit only
 *   node scripts/check-store-tables.mjs --columns       also print live columns
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT. The auth function answers
 * "does this table exist and does it have the right columns" through
 * GET /health/diagnostics, which runs schema.js verify() behind an admin
 * session. formSubmit has no equivalent and should not get one: it is the
 * unauthenticated public function, so an admin-only route there would mean
 * duplicating session handling into the one function deliberately built
 * without it, and an unauthenticated one would publish the table inventory of
 * a system whose own documents are kept out of the deploy for naming tables.
 *
 * So: the CLI, which is already how the console is reached without the
 * console. `catalyst ds:export --table X --page 1` schedules a job when the
 * table exists and answers `404, No such Table with the given name exists`
 * when it does not. Nothing is read, nothing is written, and the answer covers
 * both families through one list.
 *
 * NOT A CI GATE. It needs `catalyst login` and it talks to a live environment,
 * so it fails offline by design. scripts/check-table-registry.mjs is the gate;
 * this is the thing you run when the gate is green and a form still does not
 * save. Development is the environment all three hosts talk to, so it is the
 * default; pass --production when that changes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'catalyst-backend');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const family = (args.find((a) => a.startsWith('--family=')) || '').split('=')[1] || 'both';
const withColumns = args.includes('--columns');
const production = args.includes('--production');

const authReg = require(join(BACKEND, 'functions/auth/src/lib/tables.js'));
const formReg = require(join(BACKEND, 'functions/formSubmit/tables.js'));

const targets = [];
if (family === 'both' || family === 'auth') {
  for (const t of Object.values(authReg.T)) targets.push({ ...t, family: 'auth' });
}
if (family === 'both' || family === 'form') {
  for (const t of Object.values(formReg.T)) targets.push({ ...t, family: 'formSubmit' });
}
if (!targets.length) {
  console.error('check-store-tables: --family must be auth, form, or both');
  process.exit(2);
}

/* The CLI only offers to download a report when its stdout is a pipe rather
   than a file, which is why the caller here reads the output instead of
   redirecting it. Learned the slow way. */
function probe(table) {
  const dir = mkdtempSync(join(tmpdir(), 'whollar-probe-'));
  try {
    const cliArgs = ['ds:export', '--table', table, '--page', '1'];
    if (production) cliArgs.push('--production');
    let out = '';
    try {
      out = execFileSync('catalyst', cliArgs, {
        cwd: withColumns ? dir : BACKEND,
        input: withColumns ? 'y\n' : 'N\n',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: withColumns ? 180000 : 60000,
      });
    } catch (err) {
      out = String((err.stdout || '') + (err.stderr || '') + (err.message || ''));
    }
    const clean = out.replace(/\[[0-9;]*m/g, '');
    if (/No such Table/i.test(clean)) return { exists: false };
    if (!/Successfully scheduled/i.test(clean)) {
      return { exists: null, detail: clean.trim().split('\n').pop().slice(0, 120) };
    }
    if (!withColumns) return { exists: true };

    const zip = readdirSync(dir).find((f) => f.startsWith('Export_') && f.endsWith('.zip'));
    if (!zip) return { exists: true, columns: null };
    execFileSync('unzip', ['-o', '-q', join(dir, zip), '-d', join(dir, 'o')]);
    const csv = readdirSync(join(dir, 'o')).find((f) => f.endsWith('.csv'));
    if (!csv) return { exists: true, columns: null };
    const header = readFileSync(join(dir, 'o', csv), 'utf8').split('\n')[0];
    const cols = header.replace(/"/g, '').split(',')
      .filter((c) => !['ROWID', 'CREATORID', 'CREATEDTIME', 'MODIFIEDTIME'].includes(c));
    return { exists: true, columns: cols };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`check-store-tables: ${targets.length} table(s), ` +
  `${production ? 'Production' : 'Development'}${withColumns ? ', reading columns' : ''}`);

const missing = [];
const unknown = [];
for (const t of targets) {
  const r = probe(t.name);
  const mark = r.exists === true ? 'ok     ' : r.exists === false ? 'MISSING' : '?      ';
  let line = `  ${mark} ${t.name.padEnd(28)} ${t.family.padEnd(10)} ${t.surface.padEnd(8)} §${t.spec}`;
  if (r.columns) line += `\n            ${r.columns.join(', ')}`;
  if (r.detail) line += `  ${r.detail}`;
  console.log(line);
  if (r.exists === false) missing.push(t);
  if (r.exists === null) unknown.push(t);
}

console.log('');
if (missing.length) {
  console.log(`${missing.length} table(s) registered in code and absent from the store:`);
  for (const t of missing) console.log(`  ${t.name}  create-tables.md section ${t.spec}`);
} else {
  console.log('every registered table exists.');
}
if (unknown.length) {
  console.log(`\n${unknown.length} table(s) could not be probed. A "already under processing"` +
    ' answer means a previous export job still holds the table: wait and re-run.');
}
/* A missing table is a finding, not a failure of this script: eight of them are
   known and recorded in docs/ACTION_TABLE_AUDIT.md. Exit non-zero only when the
   probe itself could not answer. */
process.exit(unknown.length ? 1 : 0);
