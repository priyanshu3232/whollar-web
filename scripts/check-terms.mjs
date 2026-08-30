#!/usr/bin/env node
/* The vocabulary gate for the price book surfaces.
 *
 *   node scripts/check-terms.mjs          report
 *   node scripts/check-terms.mjs --check  fail on any hit (CI)
 *
 * CLAUDE.md fixes the words: partner and household, cohort and sealed bid,
 * never client, customer, lead, ISP or group buy, and no em or en dash
 * anywhere. Member-facing copy additionally never says "auction". This gate
 * holds the files the price book touches to that, in STRING LITERALS and
 * VISIBLE TEXT: comments are stripped first, because a comment that names the
 * word it forbids is how a rule gets explained.
 *
 * Deliberately narrow. scripts/check-console-copy.mjs is the whole console's
 * gate; this is the member side and the backend modules of one feature, with
 * the one heading partner/views/brief.js is allowed to keep.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

/* [file, member-facing]. Member-facing files may not say "auction" at all. */
const FILES = [
  ['dashboard.html', true],
  ['js/whollar-core.js', true],
  ['catalyst-backend/functions/auth/src/lib/offers.js', true],
  ['catalyst-backend/functions/auth/src/lib/tiers.js', true],
  ['catalyst-backend/functions/auth/src/routes/seat.js', true],
  ['partner/core/tiers.js', false],
  ['partner/views/brief.js', false],
];

const BANNED = [
  [/\u2014|\u2013/g, 'em or en dash'],
  [/\bcustomers?\b/gi, 'customer'],
  [/\blead generators?\b|\blead delivery\b|\bleads?\b(?!ing)/gi, 'lead'],
  [/\bISPs?\b/g, 'ISP'],
  [/\bgroup[ -]buys?\b/gi, 'group buy'],
];

/* Strip block and line comments so the gate reads what ships. Strings are
   kept. Crude on purpose: a `//` inside a string literal would drop the rest
   of that line from the check, and none of the files here has one. */
function stripComments(src) {
  /* Newlines inside a stripped comment are kept, so the line numbers in the
     report are the file's own. */
  const keepLines = (m) => m.replace(/[^\n]/g, '');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, keepLines);
}

/* The words a member reads, or a partner reads: string literals and, in HTML,
   text between tags. The bare kind value 'auction' (a wire enum) is not copy. */
function hits(rel, memberFacing) {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  /* A line marked `terms:allow` is a deliberate exception, read before the
     comments are stripped: the incumbents' own framing quoted in a blog
     blurb, or a detector constant that has to match the word it forbids. */
  const allowed = new Set();
  raw.split('\n').forEach((line, i) => { if (line.includes('terms:allow')) allowed.add(i); });
  const src = stripComments(raw);
  const out = [];
  const lines = src.split('\n');
  const rules = BANNED.slice();
  if (memberFacing) rules.push([/\bauction(s|ed|ing)?\b/gi, 'auction']);
  lines.forEach((line, i) => {
    if (allowed.has(i)) return;
    for (const [re, name] of rules) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const word = m[0];
        /* The campaign kind enum and its key forms are wire values, not copy. */
        if (name === 'auction' && /['"`]auction['"`]|\bauction\s*:|kind\s*===?\s*['"]auction/.test(line)) continue;
        /* "lead" as a coverage lead time column (`lead: row.lead`) is a field, not a lead. */
        if (name === 'lead' && /\blead\s*[:=]|\.lead\b|lead_time/.test(line)) continue;
        out.push(`${rel}:${i + 1}: ${name} (${word.trim()})`);
      }
    }
  });
  return out;
}

let all = [];
for (const [rel, memberFacing] of FILES) {
  try {
    all = all.concat(hits(rel, memberFacing));
  } catch (err) {
    console.error(`check-terms: cannot read ${rel}: ${err.message}`);
    process.exit(1);
  }
}

if (all.length) {
  console.error(`check-terms: ${all.length} hit(s)`);
  all.forEach((h) => console.error('  ' + h));
  if (check) process.exit(1);
} else {
  console.log(`check-terms: OK, ${FILES.length} files clean`);
}
