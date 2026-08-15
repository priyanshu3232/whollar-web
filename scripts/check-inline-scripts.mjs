#!/usr/bin/env node
/* Syntax-check every inline <script> on every live page.
 *
 * These are static pages with no bundler and no test suite, so a stray brace
 * ships silently and the page simply stops working. The bundle pages are worse:
 * their real document is a JSON string inside
 * <script type="__bundler/template">, so a syntax error there blanks the page
 * entirely and nothing in the build would have noticed.
 *
 * Also verifies the bundle templates still decode as JSON: the failure mode
 * if a `<` ever gets written back unescaped.
 *
 *   node scripts/check-inline-scripts.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle } from './bundle-edit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = [
  'index.html', 'partners.html', 'bill-checkup.html', 'become-a-partner.html',
  'waitlist/index.html', 'blog/index.html', 'terms.html', 'privacy.html', 'contact.html',
  'thank-you.html', 'dashboard.html', 'partner/index.html',
  'whollar-login-consumer.html', 'whollar-login-provider.html',
  'welcome-member.html', 'welcome-partner.html',
  'MobileVersion/consumer-mobile.html', 'MobileVersion/provider-mobile.html',
  'MobileVersion/bill-checkup-mobile.html', 'MobileVersion/become-a-partner-mobile.html',
  'MobileVersion/join-the-first-cohort-mobile.html', 'MobileVersion/resources-mobile.html'
];

/* <script> with a src, or a non-JS type (JSON-LD, speculation rules, the
   bundler template) is not JavaScript to parse. */
const SCRIPT_RE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
const NON_JS_TYPE = /type\s*=\s*"(?!text\/javascript|application\/javascript|module)[^"]*"/i;

const tmp = mkdtempSync(join(tmpdir(), 'whl-syntax-'));
let checked = 0, failures = 0;

function checkScripts(source, label) {
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(source))) {
    const attrs = m[1] || '';
    const body = m[2].trim();
    if (!body || NON_JS_TYPE.test(attrs)) continue;

    checked++;
    const file = join(tmp, `s${checked}.js`);
    writeFileSync(file, body);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failures++;
      const msg = (err.stderr || Buffer.from('')).toString().split('\n').slice(0, 4).join('\n');
      console.error(`FAIL  ${label}: inline script #${checked}\n${msg}`);
    }
  }
}

/**
 * Opening and closing <script> tags must balance.
 *
 * WHY THIS IS SEPARATE from the syntax check above. A page can carry a stray
 * </script> that closes nothing, and every real script block on it still
 * parses perfectly, so checkScripts() passes and the page ships. What the
 * browser does with the orphan is treat everything before it as text: it
 * renders the source of the preceding markup on screen.
 *
 * That is not hypothetical. partner/index.html was assembled by splitting its
 * source on the literal string '<body>', and the boot guard's own comment
 * contains the phrase "at the foot of <body>". The split landed inside the
 * comment, the guard was written into the document twice, and the second copy
 * rendered as a wall of JavaScript above the console. Every gate in this repo
 * was green: both script blocks parsed, the footer matched, the bundle was
 * current. One tag count would have caught it.
 */
function checkTagBalance(source, label) {
  const opens = (source.match(/<script\b/gi) || []).length;
  const closes = (source.match(/<\/script\s*>/gi) || []).length;
  if (opens === closes) return;
  failures++;
  console.error(
    `FAIL  ${label}: ${opens} <script> vs ${closes} </script>. `
    + 'An unmatched closing tag renders the markup before it as visible text.'
  );
}

for (const page of PAGES) {
  const path = join(ROOT, page);
  let source;
  try { source = readFileSync(path, 'utf8'); }
  catch { console.error(`FAIL  ${page}: missing`); failures++; continue; }

  checkScripts(source, page);
  checkTagBalance(source, page);

  if (source.includes('<script type="__bundler/template">')) {
    let inner;
    try { inner = readBundle(path).inner; }
    catch (err) { console.error(`FAIL  ${page}: bundle template did not decode: ${err.message}`); failures++; continue; }
    checkScripts(inner, `${page} (bundle template)`);
  }
  console.log(`ok    ${page}`);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${checked} inline script block(s) checked across ${PAGES.length} pages.`);
if (failures) { console.error(`${failures} failure(s).`); process.exit(1); }
