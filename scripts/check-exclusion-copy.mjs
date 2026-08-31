#!/usr/bin/env node
/* The gate on the exclusions copy deck.
 *
 *   node scripts/check-exclusion-copy.mjs          report
 *   node scripts/check-exclusion-copy.mjs --check  fail on any hit (CI)
 *
 * WHY THIS FILE EXISTS. Section 13 of the brief is a copy inventory marked
 * verbatim, and this feature is the one place on the site where a sentence is
 * load-bearing rather than persuasive. "Excluded providers will never be able
 * to send you an offer through Whollar" is a guarantee the server enforces;
 * softening it to "we will try not to" would make the screen lie about
 * behaviour that is actually correct, and hardening some other line into a
 * second promise would make the server lie about behaviour that is not.
 *
 * So the strings are checked where they are rendered, in dashboard.html and
 * partner/views/roster.js, against the deck below.
 *
 * IT ALSO CHECKS FOR THE COPY THAT MUST NOT BE THERE. Two constraints from the
 * brief's section 4.5 and the tail of section 13 are stated as prohibitions,
 * and a prohibition cannot be verified by looking for a string that is
 * present:
 *
 *   nothing may tie exclusions to price. The exclusion screen and the offer
 *   screen must not reference each other's economics, because a member who
 *   reads "excluding providers may cost you money" is being charged for a
 *   preference, and one who reads "this saves you money" is being sold one.
 *
 *   nothing may hint that a cheaper offer was skipped. The awarded offer is
 *   presented as the household's offer, full stop. This is the constraint most
 *   likely to be broken by a well-meaning edit, because "we found you the best
 *   offer from providers you allowed" reads as helpful and tells a household
 *   there was a better one.
 *
 * The old non-binding "avoid" question is checked for too: it promised the
 * opposite ("it doesn't bind them: whoever wins, you still see the offer"), and
 * a copy revert that restored that line beside the new guarantee would leave
 * the join flow making both promises at once.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

let fail = 0;
let pass = 0;
const ok = (cond, label) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${label}`);
};

/* Files whose visible copy this gate owns. A new surface rendering any of the
   deck below belongs in this list, or its copy is simply unchecked, which is
   the trap every hardcoded list in this repo carries. */
const FILES = {
  'dashboard.html': readFileSync(join(ROOT, 'dashboard.html'), 'utf8'),
  'partner/views/roster.js': readFileSync(join(ROOT, 'partner/views/roster.js'), 'utf8'),
};

/* ------------------------------------------------------------------ *
 * The deck, section 13. Keys are the brief's own.
 * ------------------------------------------------------------------ */

const DECK = [
  ['excl.join.heading', 'dashboard.html',
    'Any providers you want to avoid?'],
  ['excl.join.sub', 'dashboard.html',
    'Optional. Excluded providers will never be able to send you an offer through Whollar. You can change this any time from your dashboard.'],
  ['excl.join.search_placeholder', 'dashboard.html',
    'Search providers'],
  ['excl.family.parent_selected', 'dashboard.html',
    '{Parent} also operates these brands. We have excluded them too. Untick any you are open to hearing from.'],
  ['excl.family.flanker_selected', 'dashboard.html',
    '{Flanker} is operated by {Parent}. Do you also want to exclude {Parent}?'],
  ['excl.dash.empty', 'dashboard.html',
    'You have not excluded any providers. If there is a provider you never want to hear from, set it here.'],
  ['excl.dash.cta', 'dashboard.html',
    'Manage exclusions'],
  ['excl.warn.full_coverage', 'dashboard.html',
    'Heads up, this covers every provider currently able to serve your area, so you may receive no offers.'],
  ['prov.roster.heading', 'partner/views/roster.js',
    'Brands you operate'],
  ['prov.roster.attest', 'partner/views/roster.js',
    'We confirm this is the complete list of consumer brands our organization owns or operates. Bids and offers we submit are made on behalf of these brands only.'],
  ['prov.roster.pending', 'partner/views/roster.js',
    'Awaiting verification'],
];

/* Copy the SERVER owns, checked in its own source for the same reason: a
   refusal a partner reads is copy, whatever file it lives in. */
const SERVER = [
  ['prov.bid.err_roster', 'catalyst-backend/functions/auth/src/lib/rosters.js',
    'This brand is not on your attested roster. Update your roster in settings, then resubmit.'],
  ['dist.bid.err_map', 'catalyst-backend/functions/auth/src/lib/rosters.js',
    'This provider is not on your attested serving map. Update your serving map in settings, then resubmit.'],
  ['prov.roster.attest (server copy)', 'catalyst-backend/functions/auth/src/lib/rosters.js',
    'We confirm this is the complete list of consumer brands our organization owns or operates. Bids and offers we submit are made on behalf of these brands only.'],
  ['dist.map.attest', 'catalyst-backend/functions/auth/src/lib/rosters.js',
    'We confirm this is the complete list of providers we serve. Bids we submit or manage are made only on behalf of these providers and their attested brands.'],
  ['prov.reach.line', 'partner/views/ticket.js',
    'Reachable households in this cohort for your brands: '],
  ['prov.results.unreachable', 'catalyst-backend/scripts/create-tables.md',
    'households_unreachable_exclusions'],
  ['excl.offers.withdrawn', 'catalyst-backend/functions/auth/src/lib/offers.js',
    'withdrawn_by_exclusion'],
];

/* A source file's copy, with the HTML entities the pages use folded back and
   JS string concatenation joined, so a line split across two literals for line
   length still matches the deck. */
/**
 * Strip comments, so this gate reads what a member reads.
 *
 * NOT COSMETIC. The first version of this file scanned whole sources and
 * failed on its own explanatory comments: the note in dashboard.html quoting
 * the OLD non-binding promise ("it doesn't bind them") tripped the check for
 * that promise having returned, and the note in roster.js explaining that this
 * screen never says an exclusion cost a partner a cohort tripped the check for
 * tying exclusions to price. Both comments are correct and both should stay.
 * A prohibition on visible copy has to be evaluated against visible copy, or
 * it punishes the act of writing down why the rule exists.
 */
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    /* Line comments only where the line is not a URL and not inside a string.
       Conservative on purpose: a missed line comment costs a false positive
       this gate reports, and an over-eager strip costs a missed violation. */
    .replace(/^\s*\/\/.*$/gm, ' ');
}

function normalise(text) {
  return text
    .replace(/&rarr;/g, '')
    .replace(/&hellip;/g, '…')
    .replace(/&times;/g, '×')
    .replace(/&amp;/g, '&')
    /* 'a '\n  + 'b' -> 'ab'. The console's views wrap long sentences this way. */
    .replace(/'\s*\+\s*\n?\s*'/g, '')
    .replace(/'\s*\n\s*\+\s*'/g, '')
    /* The apostrophe the pages use is typographic; the brief's is not. One
       vocabulary for comparison, so a curly quote is not a copy change. */
    .replace(/[‘’]/g, "'")
    .replace(/\\u2026/g, '…')
    .replace(/\\'/g, "'");
}

console.log('The exclusions copy deck, section 13\n');

const cache = {};
function read(rel) {
  if (!cache[rel]) {
    cache[rel] = normalise(FILES[rel] !== undefined
      ? FILES[rel]
      : readFileSync(join(ROOT, rel), 'utf8'));
  }
  return cache[rel];
}

DECK.concat(SERVER).forEach(([key, file, copy]) => {
  ok(read(file).indexOf(normalise(copy)) >= 0, `${key} verbatim in ${file}`);
});

/* ------------------------------------------------------------------ *
 * The prohibitions
 * ------------------------------------------------------------------ */

console.log('');

/* The house rule first, on the two surfaces this gate owns. */
Object.keys(FILES).forEach((rel) => {
  /* The dash rule applies to comments too: CLAUDE.md says anywhere. */
  const hits = (FILES[rel].match(/[—–]/g) || []).length;
  ok(hits === 0, `no em or en dash in ${rel} (${hits})`);
});

/* Section 4.5 and the tail of section 13. Each pattern is a sentence shape
   somebody would plausibly write, not a word: banning the word "price" from a
   page about providers would be unmaintainable and would not catch the actual
   failure, which is a CLAUSE joining an exclusion to money. */
/* The money words are matched in their MONEY sense only. "save" is the verb
   this codebase uses for writing a record ("we could not save your excluded
   providers"), and banning it outright made the gate fail on its own success
   path. So a saving has to be of something: money, a dollar figure, or a
   month. Same for "cost". */
const MONEY = '(?:money|\\$\\d|a month|per month|/mo|on your bill|dollars)';
const FORBIDDEN = [
  [new RegExp(`exclud\\w*[^.?!]{0,60}\\b(?:costs?|saves?|saving)\\b[^.?!]{0,20}${MONEY}`, 'i'),
    'ties an exclusion to price'],
  [new RegExp(`\\b(?:costs?|saves?|saving)\\b[^.?!]{0,20}${MONEY}[^.?!]{0,60}exclud`, 'i'),
    'ties price to an exclusion'],
  [/exclud\w*[^.?!]{0,60}\b(cheaper|more expensive|higher price|pay more|costs you)\b/i,
    'ties an exclusion to price'],
  [/\b(cheaper|more expensive|pay more|costs you)\b[^.?!]{0,60}exclud/i,
    'ties price to an exclusion'],
  [/\b(best|cheapest|lowest)\b[^.?!]{0,50}\b(available to you|you allowed|from providers you)/i,
    'hints that a better offer was filtered out'],
  [/\b(skipped|excluded|filtered)\b[^.?!]{0,40}\b(cheaper|lower|better) (offer|bid|price)/i,
    'names a skipped cheaper bid'],
  [/does\s?n[o']t bind them/i,
    'the old non-binding avoid promise is back'],
  [/whoever wins, you still see the offer/i,
    'the old non-binding avoid promise is back'],
];

Object.keys(FILES).forEach((rel) => {
  const text = normalise(stripComments(FILES[rel]));
  FORBIDDEN.forEach(([re, why]) => {
    const m = text.match(re);
    ok(!m, `${rel}: ${why}${m ? ` -> "${String(m[0]).slice(0, 80)}"` : ''}`);
  });
});

/* The vocabulary rule from CLAUDE.md, on the copy this feature added. `lead`
   is checked as a word so "already" and "leading" do not trip it. */
const BANNED_WORDS = /\b(client|customer|lead|leads|prospect|group buy|vendor)\b/i;
Object.keys(FILES).forEach((rel) => {
  /* Only the lines this feature owns: these files are large and predate the
     rule in places this gate is not here to relitigate. */
  const lines = stripComments(FILES[rel]).split('\n')
    .filter((l) => /EXCL|excl-|exclusion|roster|brand/i.test(l));
  const bad = lines.filter((l) => BANNED_WORDS.test(l));
  ok(bad.length === 0, `${rel}: exclusion and roster lines use the house vocabulary`
    + (bad.length ? ` -> "${bad[0].trim().slice(0, 70)}"` : ''));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (CHECK && fail) process.exit(1);
