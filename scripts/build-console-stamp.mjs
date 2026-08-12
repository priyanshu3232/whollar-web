#!/usr/bin/env node
/* Keep the ?v= cache stamps on the partner console's scripts honest.
 *
 *   node scripts/build-console-stamp.mjs           # rewrite the stamps
 *   node scripts/build-console-stamp.mjs --check   # CI: fail if any is stale
 *
 * WHY THIS EXISTS. vercel.json caches everything under /js for 24 hours with a
 * 7-day stale-while-revalidate, so the only thing that makes a browser fetch a
 * new copy is a changed URL. Every other page in this repo bumps its ?v= by
 * hand, and the evidence says hand-bumping does not survive contact with a long
 * project: js/partners-page.js is pinned at ?v=20260806 next to
 * js/device-router.js?v=20260806a, and scripts/debundle.mjs still emits
 * whollar-core.js?v=20260806, three revisions behind what the pages carry.
 *
 * Stale HTML is not the failure mode. HTML is not matched by that cache rule,
 * so provider-console.html is always fresh. The failure is the pairing: a
 * partner runs TODAY's markup against YESTERDAY's JavaScript, for up to a week,
 * and the symptom is a view that renders empty rather than an error anyone
 * reports. This project ships the console over nine PRs, so that window is open
 * nine times.
 *
 * The stamp is a content hash, not a date. Two edits on one day produce two
 * stamps, which is the case the date-plus-letter convention gets wrong by
 * needing a human to notice the letter. Nothing else in the repo is touched:
 * this script only ever rewrites ?v= on the console's own <script src> tags.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

/* The page, and the scripts whose stamps it owns. Order is the load order in
   the page: the contract module defines the enums the console reads. */
const PAGE = 'provider-console.html';
const SCRIPTS = [
  'js/whollar-console-contract.js',
  'js/whollar-console-api.js',
  'js/whollar-provider-console.js'
];

/* Short, but long enough that a collision is not a thing anyone will meet:
   8 hex characters over the handful of versions a file has in its lifetime. */
const stamp = src => createHash('sha256').update(src).digest('hex').slice(0, 8);

/* Rewrite ?v= on exactly one src, leaving every other script tag alone. A
   global replace across the file would also rewrite whollar-core.js, whose
   stamp is shared with fourteen other pages and is not ours to move. */
function restamp(html, path, want) {
  const re = new RegExp(`(src="/${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?v=)([^"]*)(")`, 'g');
  let found = 0, current = null;
  const out = html.replace(re, (_m, a, had, b) => { found++; current = had; return a + want + b; });
  return { out, found, current };
}

const pagePath = join(ROOT, PAGE);

/* Before PR 1 lands, the console does not exist yet. That is not a failure:
   this script ships in PR 0 precisely so the gate is already wired when the
   files arrive, and a gate that fails on an absent file would block PR 0. */
if (!existsSync(pagePath)) {
  console.log(`ok      ${PAGE} not present yet, nothing to stamp`);
  process.exit(0);
}

const html = readFileSync(pagePath, 'utf8');
let next = html;
const stale = [];
const missing = [];

for (const path of SCRIPTS) {
  const file = join(ROOT, path);
  if (!existsSync(file)) { missing.push(path); continue; }

  const want = stamp(readFileSync(file));
  const { out, found, current } = restamp(next, path, want);

  /* A script that exists but is not referenced with a ?v= is the quiet
     version of this bug: it ships uncacheable-by-URL and never updates. */
  if (found === 0) { missing.push(`${path} (no <script src="/${path}?v=..."> in ${PAGE})`); continue; }

  if (current !== want) stale.push(`${path}  ${current} -> ${want}`);
  next = out;
}

if (missing.length) {
  console.error(`ERROR   ${PAGE} references, or should reference, files that are not wired up:`);
  for (const m of missing) console.error(`          ${m}`);
  process.exit(1);
}

if (CHECK) {
  if (!stale.length) { console.log(`ok      ${PAGE} script stamps match their contents`); process.exit(0); }
  console.error(`STALE   ${PAGE} carries cache stamps that do not match the files:`);
  for (const s of stale) console.error(`          ${s}`);
  console.error(`        Regenerate with: node scripts/build-console-stamp.mjs`);
  process.exit(1);
}

if (!stale.length) { console.log(`ok      ${PAGE} script stamps already current`); process.exit(0); }

writeFileSync(pagePath, next);
console.log(`written ${PAGE}`);
for (const s of stale) console.log(`  ${s}`);
