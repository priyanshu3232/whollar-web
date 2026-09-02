#!/usr/bin/env node
/* One-time port of the landing page design canvas into a plain static page.
 *
 * The source, Landingpagedesignstructure/Whollar Landing Page.html, is a
 * self-unpacking bundle whose real document sits JSON-encoded in a
 * <script type="__bundler/template">, with assets base64 in a manifest and a
 * design-canvas runtime that renders it. That runtime calls
 *   new Function("React", "module", "exports", "require", code)
 * so it cannot run here at all: the global CSP has no 'unsafe-eval'. It would
 * also put the entire page inside a JS blob, which is what scripts/debundle.mjs
 * already converted four pages away from, and this is the one page where a
 * crawler seeing nothing matters most.
 *
 * So this does the runtime's work once, at build time:
 *   - manifest assets are decoded to real files, PNGs re-encoded as WebP
 *   - <sc-if> resolves: the two section toggles default true and are unwrapped,
 *     the eight picker dots and the vote/join states stay as real elements the
 *     page script shows and hides
 *   - sc-camel-on-click / ref become data- attributes wired by a classic script
 *   - style-hover becomes real CSS rules, sc-camel-view-box becomes viewBox
 *   - the React component's behaviour (picker, vote, join, scroll reveal) is
 *     reimplemented in js/landing.js as a classic script
 *
 *   node scripts/port-landing.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'Landingpagedesignstructure', 'Whollar Landing Page.html');
const IMG_DIR = join(ROOT, 'images', 'landing');
const FONT_DIR = join(ROOT, 'fonts');

/* ---------- 1. crack the bundle ---------- */

function readTagged(html, type) {
  const tag = `<script type="__bundler/${type}">`;
  const s = html.indexOf(tag);
  if (s < 0) throw new Error(`no ${type} block`);
  const b = s + tag.length;
  const e = html.indexOf('</script>', b);
  return JSON.parse(html.slice(b, e).trim());
}

const bundle = readFileSync(SRC, 'utf8');
const manifest = readTagged(bundle, 'manifest');
let doc = readTagged(bundle, 'template');

/* ---------- 2. assets to files ---------- */

/* Readable names, because a UUID in the markup tells a future reader nothing
   about what the file is. Ordered by where each one appears in the page. */
const NAMES = {
  '01763db5-0635-4d72-a15a-c7061cdb3f90': 'wordmark',
  'cc73391a-8289-4151-96ba-6c9c0825e907': 'hero-woman',
  '7eab4ea0-a317-4dc8-b599-1d326dc5a1ac': 'hero-man',
  'f3f16b60-7502-4849-ba30-e4496ef8c0c8': 'hero-man-2',
  '9a160b31-95ec-40af-bcc3-c2ff536b2a09': 'hero-router',
  'cd35005d-3587-4c74-be17-57e793f4eeac': 'tire',
  '6dc2df80-c00b-49a4-9565-13dabeb63376': 'mark-icon',
  '82475c34-48b6-4fea-8f6a-f81249583137': 'testimonial',
  'c4522c75-c9c3-41e8-b02e-a39eb8b0a515': 'step-1',
  'a78c7792-5f5b-4a6c-a820-99fbf14f4551': 'step-2',
  '6e5af802-2b4a-4f9e-9fbf-5c9fe15301bd': 'step-3',
  '8c6fd7e3-77cb-4de3-9fb8-a8d1ca767b32': 'step-4',
  '152d5707-0733-44ad-9197-019ea453d1f0': 'avatar-1',
  'f3820bf3-ea4d-4399-9d42-d3aeaf6fbd6f': 'avatar-2',
  '81efe5bf-a6e0-4423-a987-31a27f0ad2b6': 'avatar-3',
  'ea785291-6b22-4424-9496-a2459495bf9e': 'avatar-4',
  '7d1e3176-caaa-4186-9c16-8b90c90eae4e': 'crowd',
};

mkdirSync(IMG_DIR, { recursive: true });
const written = [];

for (const [id, entry] of Object.entries(manifest)) {
  if (!doc.includes(id)) continue;               // nothing references it
  if (entry.mime === 'text/javascript') continue; // the canvas runtime, dropped
  let buf = Buffer.from(entry.data, 'base64');
  if (entry.compressed) buf = gunzipSync(buf);

  if (entry.mime === 'font/woff2') {
    /* Content-hashed like every other font in fonts/, so a swapped face cannot
       be served from cache under the same name. */
    const { createHash } = await import('node:crypto');
    const h = createHash('sha256').update(buf).digest('hex').slice(0, 6);
    const name = `landing-${h}.woff2`;
    writeFileSync(join(FONT_DIR, name), buf);
    doc = doc.split(`"${id}"`).join(`"/fonts/${name}"`);
    written.push([`fonts/${name}`, buf.length]);
    continue;
  }

  const base = NAMES[id] || id.slice(0, 8);
  if (entry.mime === 'video/mp4') {
    writeFileSync(join(IMG_DIR, `${base}.mp4`), buf);
    doc = doc.split(id).join(`/images/landing/${base}.mp4`);
    written.push([`images/landing/${base}.mp4`, buf.length]);
    continue;
  }

  /* PNG to WebP. The originals total 7.7 MB, which is not a home page. */
  const png = join(IMG_DIR, `${base}.png`);
  const webp = join(IMG_DIR, `${base}.webp`);
  writeFileSync(png, buf);
  execFileSync('python3', ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1])
if im.mode not in ('RGB', 'RGBA'):
    im = im.convert('RGBA')
im.save(sys.argv[2], 'WEBP', quality=82, method=6)
`, png, webp]);
  const { unlinkSync, statSync } = await import('node:fs');
  unlinkSync(png);
  doc = doc.split(id).join(`/images/landing/${base}.webp`);
  written.push([`images/landing/${base}.webp`, statSync(webp).size]);
}

writeFileSync(join(ROOT, '.port-landing-assets.json'), JSON.stringify(written, null, 2));
console.log(`assets written: ${written.length}`);
let total = 0; for (const [, n] of written) total += n;
console.log(`asset total: ${(total / 1048576).toFixed(2)} MB`);
writeFileSync(join(ROOT, '.port-landing-stage1.html'), doc);

/* ---------- 3. resolve the canvas markup ---------- */

/* <sc-if> is the only construct that needs real nesting awareness: everything
   else is an attribute rewrite. Two kinds. The two section toggles both default
   true and have no control in a shipped page, so they are unwrapped and their
   content becomes unconditional. The rest are live state the page script drives,
   so the element survives as a real one carrying a data- hook, hidden when its
   state starts false. */
const STATE_IF = {
  notVoted: { attr: 'data-lp-when="not-voted"', hidden: false },
  voted: { attr: 'data-lp-when="voted"', hidden: true },
  notJoined: { attr: 'data-lp-when="not-joined"', hidden: false },
  joined: { attr: 'data-lp-when="joined"', hidden: true },
};

function resolveIfs(html) {
  const open = /<sc-if\s+value="\{\{\s*([A-Za-z0-9_]+)\s*\}\}"[^>]*>/;
  let guard = 0;
  for (;;) {
    const m = open.exec(html);
    if (!m) break;
    if (++guard > 200) throw new Error('sc-if resolution did not terminate');
    const name = m[1];
    const bodyStart = m.index + m[0].length;

    /* Find this element's own closing tag, counting nested sc-if. */
    let depth = 1, i = bodyStart;
    while (depth > 0) {
      const nextOpen = html.indexOf('<sc-if', i);
      const nextClose = html.indexOf('</sc-if>', i);
      if (nextClose < 0) throw new Error(`unterminated sc-if for ${name}`);
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + 6; }
      else { depth--; i = nextClose + 8; }
    }
    const bodyEnd = i - 8;
    const body = html.slice(bodyStart, bodyEnd);

    let replacement;
    if (name === 'showEyebrows' || name === 'showTestimonial') {
      replacement = body;                       // both default true
    } else if (/^sel[0-7]$/.test(name)) {
      replacement = `<span data-lp-dot="${name.slice(3)}" hidden>${body}</span>`;
    } else if (STATE_IF[name]) {
      const { attr, hidden } = STATE_IF[name];
      replacement = `<span ${attr}${hidden ? ' hidden' : ''}>${body}</span>`;
    } else {
      throw new Error(`unhandled sc-if condition: ${name}`);
    }
    html = html.slice(0, m.index) + replacement + html.slice(i);
  }
  return html;
}

doc = resolveIfs(doc);

/* style-hover becomes a real rule. Deduped, because the same hover colour is
   used 20+ times and 38 single-use classes would be worse than the attribute. */
const hoverRules = new Map();
doc = doc.replace(/\s*style-hover="([^"]*)"/g, (_, decl) => {
  const clean = decl.trim().replace(/;$/, '');
  if (!hoverRules.has(clean)) hoverRules.set(clean, `lp-h${hoverRules.size + 1}`);
  return ` data-lp-hover="${hoverRules.get(clean)}"`;
});
/* Applied as a class so the CSS is a plain rule; the attribute is what the
   transform produced, so fold it into class= here. */
doc = doc.replace(/ data-lp-hover="([^"]+)"/g, (_, cls) => ` class="${cls}"`);
const hoverCss = [...hoverRules].map(([decl, cls]) => `.${cls}:hover{${decl}}`).join('\n');

/* The remaining attribute rewrites. */
const EDITS = [
  [/ sc-camel-view-box=/g, ' viewBox='],
  [/ sc-camel-on-click="\{\{\s*pick([0-7])\s*\}\}"/g, ' data-lp-pick="$1"'],
  [/ sc-camel-on-click="\{\{\s*vote\s*\}\}"/g, ' data-lp-action="vote"'],
  [/ sc-camel-on-click="\{\{\s*join\s*\}\}"/g, ' data-lp-action="join"'],
  [/ ref="\{\{\s*crowdRef\s*\}\}"/g, ' data-lp-crowd'],
  [/ ref="\{\{\s*revealRef\s*\}\}"/g, ' data-lp-reveal'],
  [/ ref="\{\{\s*emailRef\s*\}\}"/g, ''],
  [/ (loop|muted|autoplay|playsinline)="\{\{\s*yes\s*\}\}"/g, ' $1=""'],
  [/\{\{\s*voteMsg\s*\}\}/g, '<span data-lp-votemsg></span>'],
  [/\{\{\s*joinMsg\s*\}\}/g, '<span data-lp-joinmsg></span>'],
  [/ hint-placeholder-val="[^"]*"/g, ''],
  [/ data-screen-label="[^"]*"/g, ''],
  [/<script src="\/?[^"]*cc7b101a[^"]*"><\/script>/g, ''],
  [/<\/?x-dc>/g, ''],
];
for (const [find, repl] of EDITS) doc = doc.replace(find, repl);

/* The canvas component block goes: its behaviour is reimplemented in
   js/landing.js, and shipping it would leave a React class in the page. */
doc = doc.replace(/<script type="text\/x-dc"[\s\S]*?<\/script>/g, '');

/* <helmet> is the canvas's head-content slot: the font preconnects and the
   @font-face block. Lift it out of the body and keep it for the real head. */
let helmet = '';
doc = doc.replace(/<helmet>([\s\S]*?)<\/helmet>/, (_, inner) => { helmet = inner.trim(); return ''; });
if (!helmet) throw new Error('no helmet block found');
writeFileSync(join(ROOT, '.port-landing-helmet.html'), helmet);

const leftover = doc.match(/\{\{[^}]*\}\}|sc-[a-z-]+=|<sc-|<helmet|style-hover/g);
if (leftover) throw new Error(`unconverted canvas syntax: ${[...new Set(leftover)].join(', ')}`);

writeFileSync(join(ROOT, '.port-landing-stage2.html'), doc);
writeFileSync(join(ROOT, '.port-landing-hover.css'), hoverCss);
console.log(`hover rules: ${hoverRules.size}`);
console.log('canvas syntax fully resolved');

/* ---------- 4. vocabulary ---------- */

/* The design copy says "group" where this codebase says cohort, and the
   terminology rule applies to copy, not only code. Exact strings, loud on a
   miss, so a reworded design cannot be silently half-corrected. */
const VOCAB = [
  ['join the group, and access collective buying power', 'join the cohort, and access collective buying power'],
  ['Join the tire group', 'Join the tire cohort'],
  ['same need become one buying group.', 'same need become one cohort.'],
  ['Compare the group offers', 'Compare the cohort offers'],
  ['Create group demand', 'Create cohort demand'],
  ['>For the group<', '>For the cohort<'],
  ['Actual group rates depend', 'Actual cohort rates depend'],
  ['the stronger the buying group becomes', 'the stronger the cohort becomes'],
  ['Anything a group can buy together, a group can buy better.', 'Anything a cohort can buy together, a cohort can buy better.'],
];
for (const [find, repl] of VOCAB) {
  const n = doc.split(find).length - 1;
  if (n !== 1) throw new Error(`vocabulary edit matched ${n} times, expected 1: "${find}"`);
  doc = doc.replace(find, repl);
}
const strayGroup = (doc.replace(/<[^>]+>/g, ' ').match(/\bgroups?\b/gi) || []).length;
if (strayGroup) throw new Error(`"group" still in visible copy ${strayGroup} time(s)`);

/* ---------- 5. the page, assembled ---------- */

/* The design's own footer goes: every page's footer comes from
   scripts/build-footer.mjs between markers, and the design's carried
   placeholder links (Privacy, Terms and three social icons all at #top).
   landing.html is registered in that generator's PAGES. */
const FOOT = doc.match(/<footer[\s\S]*?<\/footer>/);
if (!FOOT) throw new Error('no design footer found');
doc = doc.replace(FOOT[0],
  '<!-- WHOLLAR-FOOTER:START (generated by scripts/build-footer.mjs) -->\n<!-- WHOLLAR-FOOTER:END -->');

/* Body content only: everything between <body> and </body>. */
const body = doc.slice(doc.indexOf('<body>') + 6, doc.indexOf('</body>')).trim();

/* Self-hosted fonts need no Google preconnect. */
const helmetOut = helmet
  .replace(/<link rel="preconnect"[^>]*>\s*/g, '');

const STAMP = '20260902';
const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Whollar: Buy anything better, together</title>
<meta name="description" content="Whollar brings people with the same needs together, turning everyday demand into collective buying power and better prices. Starting with internet and winter tires.">
<!-- Staged for review at /landing. At cutover this file becomes index.html:
     drop this robots line, add the canonical, and register the swap in
     sitemap.xml. Until then it must not be indexed at a side path. -->
<meta name="robots" content="noindex,nofollow">
<script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "xrkpgls1yj");</script>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${helmetOut}
<style>
/* The canvas wrapper's reset, which the inline styles were authored against. */
*{margin:0;padding:0;box-sizing:border-box}
body{background:#FBF7EF;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
/* :hover rules generated from the canvas's style-hover attributes. */
${hoverCss}
/* The sc-if wrappers must not become boxes of their own: the picker dot is a
   flex item of its button and an inline wrapper would strip its 8px box. The
   explicit [hidden] rule is needed because display:contents on the same
   element would otherwise beat the UA's [hidden] -> display:none. */
[data-lp-dot],[data-lp-when]{display:contents}
[data-lp-dot][hidden],[data-lp-when][hidden]{display:none}
</style>
<!-- WHOLLAR-FOOTER-CSS:START (generated by scripts/build-footer.mjs) -->
<!-- WHOLLAR-FOOTER-CSS:END -->
</head>
<body>

${body}

<script src="/js/landing.js?v=${STAMP}"></script>
</body>
</html>
`;

writeFileSync(join(ROOT, 'landing.html'), page);
console.log(`landing.html written: ${(page.length / 1024).toFixed(0)} KB`);
