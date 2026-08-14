#!/usr/bin/env node
/* Copy rules for the partner console.
 *
 *   node scripts/check-console-copy.mjs
 *
 * WHY SCOPED, not repo-wide. The house rule is no em dashes anywhere, but the
 * repo has a few hundred of them in older pages and comments, and a gate that
 * fails on day one gets disabled on day one. This one covers the console files
 * only, where the count is currently zero, so it stays green and stays on.
 * Widen it when the rest is cleaned up (there is a remove-em-dashes branch).
 *
 * It also enforces the terminology list from CLAUDE.md, because those words
 * become table names and API paths, not just visible strings, and by the time
 * a LeadService is in the schema it is expensive to rename.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'partner/index.html',
  'partner/app.css',
  'partner/app.js',
  'partner/core/api.js',
  'partner/core/contract.js',
  'partner/core/state.js',
  'partner/core/router.js',
  'partner/core/actions.js',
  'partner/core/session.js',
  'partner/core/time.js',
  'partner/core/format.js',
  'partner/core/districts.js',
  'partner/core/toast.js',
  'partner/core/modal.js',
  'partner/components/banner.js',
  'partner/components/emptystate.js',
  'partner/components/gate.js',
  'partner/components/rail.js',
  'partner/components/tasks.js',
  'partner/views/account.js',
  'partner/views/application.js',
  'partner/views/bids.js',
  'partner/views/brief.js',
  'partner/views/contracts.js',
  'partner/views/coverage.js',
  'partner/views/desk.js',
  'partner/views/overview.js',
  'partner/views/performance.js',
  'partner/views/placeholders.js',
  'partner/views/ticket.js',
  'partner/demo/fixtures.js',
  'scripts/qa-console.mjs',
  'scripts/test-districts.mjs',
  'scripts/build-console.mjs'
];

/* Banned words. Each is paired with what to say instead, because a gate that
   only says "no" gets worked around. Word boundaries on both sides so
   "download" does not trip "lead", and case-insensitive.

   NOT banned, deliberately:

   "client", at all. In a browser codebase that word overwhelmingly means the
   browser, and it is load-bearing in exactly the sentences that matter most
   here: "the client never computes stage", "a client clock a few minutes fast
   would let a partner bid after close". Banning it flagged fourteen correct
   sentences; narrowing to "the/a client" still flagged seven. There is no
   regex that separates the business sense from the technical one, and a gate
   that cries wolf on correct code is worse than no gate for that word. It is
   still in the CLAUDE.md list and still a review point; it is just not
   machine-checkable. The words that actually leak into product copy are
   "lead", "prospect" and "customer", and those are caught below.

   "user". whollar-core.js and the session payload use userType and
   publicUser; renaming those is a backend change, not a copy fix.

   "lead" as an adjective is still caught, and that is correct: write "first
   cohort", not "lead cohort", so the noun stays unambiguous. */
const BANNED = [
  [/\bleads?\b/i, 'household, or member (and "first", not "lead", as an adjective)'],
  [/\blead[- ]?gen(eration)?\b/i, 'cohort formation'],
  [/\bprospects?\b/i, 'household'],
  [/\bcustomers?\b/i, 'household, or member'],
  [/\bhandover\b/i, 'intimation'],
  [/\bpostal prefix\b/i, 'FSA']
];

/* Lines that legitimately contain a banned word because they are ABOUT the
   rule, or name an existing backend table we do not control. */
const EXEMPT = [
  /CLAUDE\.md/,
  /never use|do not use|banned|instead of|terminology/i,
  /PartnerApplications|LEAD_TABLES|formSubmit/,
  /not leads:/,           /* the billing view's own copy makes the point */

  /* "install lead time" is the operations sense: how long after an order a
     technician can attend. It is not a sales lead, it is the word the industry
     uses, and `lead` is the literal column name in provider_coverage that
     desk.js reads and writes. Renaming the domain to satisfy a copy rule aimed
     at a different word would be the tail wagging the dog. */
  /lead[- ]?time|LEAD_TIMES|ce-lead|\.lead\b|\blead:/i
];

let problems = 0;
let scanned = 0;

for (const rel of FILES) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) continue;
  scanned++;
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, i) => {
    const n = i + 1;

    if (line.includes('—')) {
      console.error(`${rel}:${n}  em dash. Use a comma, a colon, or two sentences.`);
      console.error(`    ${line.trim().slice(0, 100)}`);
      problems++;
    }

    if (EXEMPT.some(re => re.test(line))) return;
    for (const [re, use] of BANNED) {
      const m = re.exec(line);
      if (!m) continue;
      console.error(`${rel}:${n}  "${m[0]}". Use ${use}.`);
      console.error(`    ${line.trim().slice(0, 100)}`);
      problems++;
    }
  });
}

if (problems) {
  console.error(`\n${problems} problem(s) across ${scanned} console file(s).`);
  process.exit(1);
}
console.log(`ok      ${scanned} console file(s): no em dashes, no banned terminology`);
