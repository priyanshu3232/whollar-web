#!/usr/bin/env node
/* One-time port of the waitlist design canvas into a plain static page.
 *
 * Same job and same reasons as scripts/port-landing.mjs: the source in
 * commonwaitlist/ is a self-unpacking bundle rendered by a canvas runtime that
 * compiles itself with new Function, which the site CSP forbids, so it cannot
 * run here at all and its content would be invisible to crawlers besides.
 *
 * The one difference that matters: this page carries a real form. The canvas
 * component validates it and then only flips a flag, so as designed it tells
 * someone "you're in" and sends nothing. The port wires it to the waitlist
 * route the backend already has, POST /waitlist-join, which writes the row and
 * queues the CRM lead with no session and no emailed code.
 *
 * WHY NOT AN ACCOUNT. It was one, briefly: /signup and the OTP lane both mint
 * a member, and both hold the account inert behind a 6-digit code, so the port
 * carried a screen to type it in. That screen is gone at the user's call: the
 * form should end at the welcome. No code means no verified address, so it
 * means no account, because this backend has no route that makes one without
 * one. What is left is a real waitlist: the details are stored, the lead
 * reaches the CRM, and the household is counted. See js/waitlist-join.js.
 *
 *   node scripts/port-waitlist.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* MOVED. The output of this port, join.html, became home/join.html on 2026-09-02
   and was transformed there for the umbrella project: canonical, og, absolute
   product links. Re-running this writes a root join.html again, which now
   redirects to the umbrella and which the host gate would flag. Historical,
   like debundle.mjs. */
if (!process.argv.includes('--force')) {
  console.error('scripts/port-waitlist.mjs: output moved to home/ and was transformed there; pass --force only to re-port from the design source.');
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* commonwaitlist.html, NOT commonwaitlist/Whollar Waitlist.html. The folder
   holds an older cut: account creation with a password. This one is the
   waitlist proper, passwordless, and it asks which product you are pooling
   for, which is what the new multi-product landing page needs. */
const SRC = join(ROOT, 'commonwaitlist.html');
const IMG_DIR = join(ROOT, 'images', 'waitlist');
const FONT_DIR = join(ROOT, 'fonts');

function readTagged(html, type) {
  const tag = `<script type="__bundler/${type}">`;
  const s = html.indexOf(tag);
  if (s < 0) throw new Error(`no ${type} block`);
  const b = s + tag.length;
  return JSON.parse(html.slice(b, html.indexOf('</script>', b)).trim());
}

const bundle = readFileSync(SRC, 'utf8');
const manifest = readTagged(bundle, 'manifest');
let doc = readTagged(bundle, 'template');

/* ---------- assets ---------- */

const NAMES = {
  '9a46a83f-7e10-4b5d-ae95-b7f048e7b716': 'logo-bell',
  '1b44cee1-805e-44ff-8355-d350d0fdfcea': 'logo-rogers',
  '95f360e6-adc7-423c-8910-e03cb62917a9': 'logo-teksavvy',
  '4fb93213-151b-4114-bcbd-5fc08b354961': 'logo-oxio',
  /* Same four logos, different ids in this cut of the design. */
  'a3c7d6e2-0000-0000-0000-000000000000': 'logo-unused',
};

mkdirSync(IMG_DIR, { recursive: true });
let assetBytes = 0, assetCount = 0;

for (const [id, entry] of Object.entries(manifest)) {
  if (!doc.includes(id)) continue;
  if (entry.mime === 'text/javascript') continue;   // the canvas runtime
  let buf = Buffer.from(entry.data, 'base64');
  if (entry.compressed) buf = gunzipSync(buf);

  if (entry.mime === 'font/woff2') {
    const h = createHash('sha256').update(buf).digest('hex').slice(0, 6);
    const name = `waitlist-${h}.woff2`;
    writeFileSync(join(FONT_DIR, name), buf);
    doc = doc.split(`"${id}"`).join(`"/fonts/${name}"`);
    assetBytes += buf.length; assetCount++;
    continue;
  }

  /* Left in their own formats: these are four small provider logos, two of
     them SVG, and a WebP pass would cost more than the 46 KB they weigh. */
  const ext = entry.mime === 'image/svg+xml' ? 'svg' : entry.mime === 'image/jpeg' ? 'jpg' : 'png';
  const name = `${NAMES[id] || id.slice(0, 8)}.${ext}`;
  writeFileSync(join(IMG_DIR, name), buf);
  doc = doc.split(id).join(`/images/waitlist/${name}`);
  assetBytes += buf.length; assetCount++;
}
console.log(`assets: ${assetCount}, ${(assetBytes / 1024).toFixed(0)} KB`);

/* ---------- canvas markup ---------- */

/* providerLogos defaults true and providerText is its else-branch, so the
   logos stay and the text fallback goes. Everything else is live state. */
const STATE_IF = {
  hasError: 'data-wl-when="error"',
  joined: 'data-wl-when="joined"',
  notJoined: 'data-wl-when="not-joined"',
  refOpen: 'data-wl-when="ref-open"',
  refClosed: 'data-wl-when="ref-closed"',
};
const HIDDEN_AT_REST = new Set(['hasError', 'joined', 'refOpen']);

function resolveIfs(html) {
  const open = /<sc-if\s+value="\{\{\s*([A-Za-z0-9_]+)\s*\}\}"[^>]*>/;
  let guard = 0;
  for (;;) {
    const m = open.exec(html);
    if (!m) break;
    if (++guard > 200) throw new Error('sc-if resolution did not terminate');
    const name = m[1];
    const bodyStart = m.index + m[0].length;
    let depth = 1, i = bodyStart;
    while (depth > 0) {
      const nextOpen = html.indexOf('<sc-if', i);
      const nextClose = html.indexOf('</sc-if>', i);
      if (nextClose < 0) throw new Error(`unterminated sc-if for ${name}`);
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + 6; }
      else { depth--; i = nextClose + 8; }
    }
    const body = html.slice(bodyStart, i - 8);
    let replacement;
    if (name === 'providerLogos') replacement = body;
    else if (name === 'providerText') replacement = '';
    else if (STATE_IF[name]) {
      replacement = `<span ${STATE_IF[name]}${HIDDEN_AT_REST.has(name) ? ' hidden' : ''}>${body}</span>`;
    } else throw new Error(`unhandled sc-if condition: ${name}`);
    html = html.slice(0, m.index) + replacement + html.slice(i);
  }
  return html;
}
doc = resolveIfs(doc);

/* style-hover and style-focus become real rules, deduped into classes. */
const rules = new Map();
function classFor(decl, pseudo) {
  const key = pseudo + '|' + decl.trim().replace(/;$/, '');
  if (!rules.has(key)) rules.set(key, `wl-${pseudo}${rules.size + 1}`);
  return rules.get(key);
}
doc = doc.replace(/\s*style-(hover|focus)="([^"]*)"/g, (_, kind, decl) => ` __cls="${classFor(decl, kind)}"`);
/* Fold the marker into a real class=, merging where the element has one. */
doc = doc.replace(/(<[^>]*?)\s__cls="([^"]+)"([^>]*>)/g, (m, a, cls, b) => {
  if (/\sclass="/.test(a + b)) {
    return (a + b).replace(/\sclass="([^"]*)"/, ` class="$1 ${cls}"`);
  }
  return `${a} class="${cls}"${b}`;
});
const css = [...rules].map(([key, cls]) => {
  const [pseudo, decl] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
  return `.${cls}:${pseudo}{${decl}}`;
}).join('\n');

const EDITS = [
  [/ sc-camel-view-box=/g, ' viewBox='],
  [/ sc-camel-auto-complete=/g, ' autocomplete='],
  [/ sc-camel-max-length=/g, ' maxlength='],
  [/ sc-camel-no-validate="\{\{\s*true\s*\}\}"/g, ' novalidate'],
  [/ sc-camel-on-submit="\{\{\s*onSubmit\s*\}\}"/g, ' data-wl-form'],
  [/ sc-camel-on-click="\{\{\s*onOpenRef\s*\}\}"/g, ' data-wl-action="open-ref"'],
  [/ sc-camel-on-click="\{\{\s*onReset\s*\}\}"/g, ' data-wl-action="reset"'],
  [/ required="\{\{\s*true\s*\}\}"/g, ' required'],
  [/ ref="\{\{\s*rootRef\s*\}\}"/g, ' data-wl-root'],
  [/ ref="\{\{\s*[A-Za-z0-9_]+\s*\}\}"/g, ''],   // the rest already carry ids
  [/\{\{\s*error\s*\}\}/g, '<span data-wl-error></span>'],
  [/\{\{\s*doneArea\s*\}\}/g, '<span data-wl-donearea></span>'],
  [/\{\{\s*donePool\s*\}\}/g, '<span data-wl-donepool></span>'],
  [/\{\{\s*doneNumber\s*\}\}/g, '<span data-wl-donenumber></span>'],
  [/ hint-placeholder-val="[^"]*"/g, ''],
  [/ data-screen-label="[^"]*"/g, ''],
  [/<script src="\/?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"><\/script>/g, ''],
  [/<\/?x-dc>/g, ''],
];
for (const [find, repl] of EDITS) doc = doc.replace(find, repl);

let helmet = '';
doc = doc.replace(/<helmet>([\s\S]*?)<\/helmet>/, (_, inner) => { helmet = inner.trim(); return ''; });
if (!helmet) throw new Error('no helmet block');
doc = doc.replace(/<script type="text\/x-dc"[\s\S]*?<\/script>/g, '');

const leftover = doc.match(/\{\{[^}]*\}\}|sc-[a-z-]+=|<sc-|<helmet|style-hover|style-focus|__cls/g);
if (leftover) throw new Error(`unconverted canvas syntax: ${[...new Set(leftover)].join(', ')}`);
console.log(`hover/focus rules: ${rules.size}`);

/* ---------- links ---------- */

/* The design points at whollar.com; production is www.whollar.ca and internal
   links are root-relative, so the apex redirect never costs a hop. */
const LINKS = [
  ['href="https://www.whollar.com/terms"', 'href="/terms"'],
  ['href="https://www.whollar.com/privacy"', 'href="/privacy"'],
  ['href="https://www.whollar.com/"', 'href="/"'],
];
for (const [find, repl] of LINKS) {
  if (!doc.includes(find)) throw new Error(`link edit matched nothing: ${find}`);
  doc = doc.split(find).join(repl);
}
if (/whollar\.com/.test(doc)) throw new Error('a whollar.com link survived');

/* ---------- copy ---------- */

/* Same terminology rule as the landing port: the design says group, this
   codebase says cohort, and the rule covers copy. */
const VOCAB = [
  ['Group rate unlocked', 'Cohort rate unlocked'],
  ['Group rate · mount, balance, install', 'Cohort rate · mount, balance, install'],
  ['We group your address with the neighbours', 'We place your address with the neighbours'],
  ['providers bid for the whole group', 'providers bid for the whole cohort'],
  /* The masked price in the illustrative bid table. Em dashes are banned
     repo-wide and this is not prose but it is still a page string, so it uses
     bullets, which read as hidden digits without reaching for a dash at all. */
  ['$ — —', '$ • •'],
  /* POST /waitlist-join refuses a row without a valid 10-digit number, and the
     welcome screen promises "we text you the moment one lands", so the design's
     "optional" was wrong on both ends. Says what the number is for instead. */
  ['>Mobile <span style="font-weight:500;color:#68705F">· optional</span>',
   '>Mobile <span style="font-weight:500;color:#68705F">· we text you when a bid lands</span>'],
];
for (const [find, repl] of VOCAB) {
  const n = doc.split(find).length - 1;
  if (n < 1) throw new Error(`copy edit matched nothing: "${find}"`);
  doc = doc.split(find).join(repl);
}
const strayGroup = (doc.replace(/<[^>]+>/g, ' ').match(/\bgroups?\b/gi) || []).length;
if (strayGroup) throw new Error(`"group" still in visible copy ${strayGroup} time(s)`);
if (doc.includes('—')) throw new Error('an em dash survived');

/* ---------- the page ---------- */

const body = doc.slice(doc.indexOf('<body>') + 6, doc.indexOf('</body>')).trim();
const helmetOut = helmet.replace(/<link rel="preconnect"[^>]*>\s*/g, '');
const STAMP = '20260902a';

const page = `<!DOCTYPE html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join Whollar: become a founding member</title>
<meta name="description" content="Hold your spot in your neighbourhood's cohort. Whollar brings households together so providers bid for the whole street at once.">
<!-- Staged for review at /join alongside /landing. The live waitlist is still
     /waitlist/, so this must not be indexed as a second one. At cutover, drop
     this line, add the canonical, and retire whichever page loses. -->
<meta name="robots" content="noindex,nofollow">
<script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "xrkpgls1yj");
/* This form collects a name, email, password, phone and postal code. Clarity
   records session replays, so mask text content by default (PIPEDA / Law 25). */
window.clarity('set','mask','true');</script>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script src="/js/whollar-core.js?v=${STAMP}"></script>
${helmetOut}
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0E2A20;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
${css}
/* The sc-if wrappers must not become boxes of their own. */
[data-wl-when]{display:contents}
[data-wl-when][hidden]{display:none}
</style>
</head>
<body>

${body}

<script src="/js/waitlist-join.js?v=20260902b"></script>
</body>
</html>
`;

writeFileSync(join(ROOT, 'join.html'), page);
console.log(`join.html written: ${(page.length / 1024).toFixed(0)} KB`);
