#!/usr/bin/env node
/* Port of the winter tire design canvas into the tires/ vertical.
 *
 * Same job and same reasons as scripts/port-landing.mjs: the source in
 * WhollarTireLandingPage/ is a Claude Design canvas whose runtime
 * (support.js) compiles itself with new Function, which the site CSP forbids,
 * so it cannot run here at all and its content would be invisible to crawlers.
 *
 * WHAT THIS PORT DELIBERATELY DROPS. The canvas is two products in one file:
 * a landing page, and a full signup flow that opens over it in a fixed shell,
 * driven by kit.js, a 139 KB engine it fetches at runtime. The signup is a
 * page of its own here, at /join on this host, ported separately from the
 * waitlist prototype. So the flow shell, the four tool modals it hosts, and
 * kit.js with it, are cut, and every control that opened them becomes a link
 * to /join. Nothing is lost: /join carries the same four tools and the same
 * two paths. What is gained is a landing page that is HTML a crawler can read
 * rather than a mount point for an engine.
 *
 *   node scripts/port-tires.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'WhollarTireLandingPage', 'Whollar Winter Tires.dc.html');
const OUT = join(ROOT, 'tires');
const IMG_DIR = join(OUT, 'images');
const FONT_DIR = join(OUT, 'fonts');
mkdirSync(IMG_DIR, { recursive: true });
mkdirSync(FONT_DIR, { recursive: true });

const HOST = 'https://tires.whollar.ca';
const UMBRELLA = 'https://www.whollar.ca';
const NET = 'https://internet.whollar.ca';
const STAMP = '20260903b';

let doc = readFileSync(SRC, 'utf8');

/* ---------- 1. the helmet, and the body we keep ---------- */

let helmet = '';
doc = doc.replace(/<helmet>([\s\S]*?)<\/helmet>/, (_, inner) => { helmet = inner.trim(); return ''; });
if (!helmet) throw new Error('no helmet block found');

/* The canvas component block goes: its only real behaviour is the scroll
   reveal, reimplemented in tires/js/tires.js, and the rest drove the flow
   shell this port cuts. */
doc = doc.replace(/<script type="text\/x-dc"[\s\S]*$/, '');

/* ---------- 2. cut the flow shell and the tool modals ---------- */

/* Both are matched on their own anchors rather than by line number, so a
   canvas edit that moves them still cuts the right thing, and a canvas edit
   that renames them fails here instead of shipping a 139 KB dead mount. */
function cutBlock(html, startNeedle, label) {
  const at = html.indexOf(startNeedle);
  if (at < 0) throw new Error(`${label}: anchor not found (${startNeedle})`);
  /* Walk from the anchor's own opening tag to its matching close. */
  const openTag = html.lastIndexOf('<', at);
  const tagName = /^<([a-z-]+)/.exec(html.slice(openTag))[1];
  let i = openTag, depth = 0;
  const open = new RegExp(`<${tagName}[\\s>]`, 'g');
  const close = new RegExp(`</${tagName}>`, 'g');
  while (i < html.length) {
    open.lastIndex = i; close.lastIndex = i;
    const o = open.exec(html), c = close.exec(html);
    if (!c) throw new Error(`${label}: unclosed <${tagName}>`);
    if (o && o.index < c.index) { depth++; i = o.index + 1; continue; }
    depth--; i = c.index + 1;
    if (depth === 0) return html.slice(0, openTag) + html.slice(c.index + c[0].length);
  }
  throw new Error(`${label}: never balanced`);
}
doc = cutBlock(doc, 'data-flow-shell="1"', 'flow shell');

/* ---------- 3. resolve the canvas syntax ---------- */

/* THE SOURCE IS UNBALANCED, and the modal cut below depends on knowing it:
   the canvas carries six <sc-if> and seven </sc-if>, one stray close left
   inside the tool modal by a design edit. Asserted rather than assumed, so
   that if the canvas is ever fixed upstream this port stops and someone
   re-reads the cut instead of silently removing the wrong span. */
const OPENS = (doc.match(/<sc-if\b/g) || []).length;
const CLOSES = (doc.match(/<\/sc-if>/g) || []).length;
if (OPENS !== 6 || CLOSES !== 7) {
  throw new Error(`sc-if balance changed: ${OPENS} open, ${CLOSES} close (expected 6 and 7 after the shell cut)`);
}

/* The two well-formed conditions are the component's own props, and both have
   a fixed answer on a static page: the city status labels are off by default
   (nothing is measuring demand in Ottawa yet, so the label would be a claim
   about a city where nothing is happening), and the cross-sell is on. */
doc = doc.replace(/<sc-if value="\{\{ showCityStatus \}\}"[^>]*>[\s\S]*?<\/sc-if>/g, '');
doc = doc.replace(/<sc-if value="\{\{ showCrossSell \}\}"[^>]*>([\s\S]*?)<\/sc-if>/g, '$1');

/* What is left is the tool modal, and the stray close is inside it, so the
   block runs from its anchor to the LAST </sc-if> in the document. */
const modalAt = doc.indexOf('<sc-if value="{{ toolOpen }}"');
const modalEnd = doc.lastIndexOf('</sc-if>');
if (modalAt < 0 || modalEnd < modalAt) throw new Error('tool modal: anchor not found');
doc = doc.slice(0, modalAt) + doc.slice(modalEnd + '</sc-if>'.length);

for (const dead of ['mount-k-strat', 'mount-k-size', 'mount-k-rims', 'mount-k-ins', 'kit.js', 'kit.css', 'id="signup"', 'id="confirmView"']) {
  if (doc.includes(dead)) throw new Error(`the cut left ${dead} behind`);
}

/* Every control that opened the flow or a tool becomes a link to /join, which
   is where both now live. Buttons become anchors: a control that navigates is
   a link, and a link works before any script runs. */
const OPENERS = [
  ['{{ openStrategy }}', '/join?path=guided&tool=strategy'],
  ['{{ openSize }}', '/join?path=guided&tool=size'],
  ['{{ openRims }}', '/join?path=guided&tool=rims'],
  ['{{ openIns }}', '/join?path=guided&tool=insurance'],
  ['{{ openQuick }}', '/join?path=quick'],
  ['{{ openGuided }}', '/join?path=guided'],
];
for (const [binding, href] of OPENERS) {
  const re = new RegExp(`<button type="button" onClick="${binding.replace(/[{}]/g, '\\$&')}"`, 'g');
  const hits = doc.match(re);
  if (!hits || hits.length !== 1) throw new Error(`opener ${binding}: expected 1, found ${hits ? hits.length : 0}`);
  doc = doc.replace(re, `<a href="${href}"`);
}
/* Close the tags those buttons opened. Done by walking, not by a blind
   replace, because the cards contain nested elements. */
doc = (function closeOpeners(html) {
  let out = '', i = 0;
  const anchor = /<a href="\/join\?path=[^"]*"/g;
  let m;
  while ((m = anchor.exec(html))) {
    const end = html.indexOf('</button>', m.index);
    if (end < 0) throw new Error('an opener has no </button> to close');
    out += html.slice(i, end) + '</a>';
    i = end + '</button>'.length;
  }
  return out + html.slice(i);
})(doc);
if (/onClick=|<button[^>]*>[\s\S]*?Join quickly/.test(doc)) throw new Error('an opener survived as a button');

/* style-hover becomes a real rule, deduped, exactly as the landing port does. */
const hoverRules = new Map();
doc = doc.replace(/\s*style-hover="([^"]*)"/g, (_, decl) => {
  const clean = decl.trim().replace(/;$/, '');
  if (!hoverRules.has(clean)) hoverRules.set(clean, `t-h${hoverRules.size + 1}`);
  return ` class="${hoverRules.get(clean)}"`;
});
const hoverCss = [...hoverRules].map(([decl, cls]) => `.${cls}:hover{${decl}}`).join('\n');

/* <image-slot> is a canvas element backed by image-slot.js. A real <img>. */
doc = doc.replace(/<image-slot\b([^>]*)><\/image-slot>/g, (_, attrs) => {
  const src = /src="([^"]*)"/.exec(attrs);
  const alt = /alt="([^"]*)"/.exec(attrs);
  const fit = /fit="([^"]*)"/.exec(attrs);
  if (!src) throw new Error('an image-slot has no src');
  return `<img src="${src[1]}" alt="${alt ? alt[1] : ''}" style="width:100%;height:100%;object-fit:${fit ? fit[1] : 'cover'};display:block">`;
});

doc = doc.replace(/ data-screen-label="[^"]*"/g, '');
doc = doc.replace(/ hint-placeholder-val="[^"]*"/g, '');
doc = doc.replace(/<script src="\.\/(support|image-slot)\.js"><\/script>/g, '');
doc = doc.replace(/<\/?x-dc>/g, '');

const leftover = doc.match(/\{\{[^}]*\}\}|<sc-|<\/sc-|<image-slot|style-hover|onClick=/g);
if (leftover) throw new Error(`unresolved canvas syntax: ${[...new Set(leftover)].join(', ')}`);

/* ---------- 4. assets ---------- */

/* Three PNGs, 1.7 MB, of which the hero is 1.5 MB. WebP, like the landing
   port: a hero is not a place to ship a megabyte and a half. */
const written = [];
for (const [file, base] of [['hero-winter-tire-gta.png', 'hero-tire'], ['whollar-mark.png', 'mark'], ['whollar-mark-gradient.png', 'mark-gradient']]) {
  const from = join(ROOT, 'WhollarTireLandingPage', 'assets', file);
  const png = join(IMG_DIR, `${base}.png`);
  const webp = join(IMG_DIR, `${base}.webp`);
  copyFileSync(from, png);
  execFileSync('python3', ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1])
if im.mode not in ('RGB', 'RGBA'):
    im = im.convert('RGBA')
im.save(sys.argv[2], 'WEBP', quality=82, method=6)
`, png, webp]);
  const { unlinkSync } = await import('node:fs');
  unlinkSync(png);
  doc = doc.split(`./assets/${file}`).join(`/images/${base}.webp`);
  written.push([`images/${base}.webp`, statSync(webp).size]);
}
if (doc.includes('./assets/')) throw new Error('an asset reference survived');

/* ---------- 5. fonts ---------- */

/* The canvas links Google Fonts. This host self-hosts, like every other page
   here, and the three families it wants (Bricolage Grotesque, Inter, Space
   Mono) are already self-hosted for the umbrella's /join, at the same weights.
   Reuse those files rather than fetching a second copy of the same faces. */
const joinHtml = readFileSync(join(ROOT, 'home', 'join.html'), 'utf8');
const faces = joinHtml.match(/@font-face \{[\s\S]*?\}/g) || [];
if (faces.length < 20) throw new Error(`expected the umbrella's @font-face block, found ${faces.length} faces`);
const fontCss = faces.join('\n');
const fontFiles = new Set((fontCss.match(/\/fonts\/[a-z0-9-]+\.woff2/g) || []));
if (!fontFiles.size) throw new Error('no font files referenced');
for (const ref of fontFiles) {
  const name = ref.split('/').pop();
  copyFileSync(join(ROOT, 'home', 'fonts', name), join(FONT_DIR, name));
}
helmet = helmet.replace(/<link rel="preconnect"[^>]*>\s*/g, '')
  .replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>\s*/g, '')
  .replace(/<script src="\.\/image-slot\.js"><\/script>\s*/g, '');
if (/googleapis|gstatic/.test(helmet)) throw new Error('a Google Fonts reference survived');

/* ---------- 5b. the helmet outlives the cut, and carries its debris ----------
   The flow shell is gone from the body, but its stylesheet link and the rules
   that skinned it were in <helmet>, which was lifted out in step 1 and so
   never saw the checks in step 3. Left alone they ship a 404 on ./kit.css from
   a host that has no such file, plus dead selectors for a #wh-kit-host that no
   longer exists. Both are asserted, not swept: if a canvas edit renames them
   the port stops here rather than shipping the next dead reference. */
if (!helmet.includes('<link rel="stylesheet" href="./kit.css">')) {
  throw new Error('the kit stylesheet link is no longer in the helmet: re-read step 5b');
}
helmet = helmet.replace(/<link rel="stylesheet" href="\.\/kit\.css">\s*/, '');
const kitFrom = helmet.indexOf('/* the imported kit');
const kitTo = helmet.indexOf('.wh-tool-mount .toolcard, .wh-tool-mount > * { background:transparent }');
if (kitFrom < 0 || kitTo < kitFrom) throw new Error('the dead kit rules moved: re-read step 5b');
helmet = helmet.slice(0, kitFrom) + helmet.slice(kitTo + '.wh-tool-mount .toolcard, .wh-tool-mount > * { background:transparent }'.length);
for (const dead of ['kit.css', 'wh-kit-host', 'wh-tool-mount']) {
  if (helmet.includes(dead)) throw new Error(`the helmet still carries ${dead}`);
}

/* ---------- 6. vocabulary ---------- */

/* Same rule as every other port here: the design says group, this codebase
   says cohort, and CLAUDE.md makes that a rule about code as well as copy. */
const VOCAB = [
  ['one powerful buying group', 'one powerful cohort'],
  ['Join the winter tire group', 'Join the winter tire cohort'],
  /* The join section's headline splits the phrase across a colour span, so
     the plain rule above cannot see it. */
  ['tire group.</span>', 'tire cohort.</span>'],
  ['the group rate', 'the cohort rate'],
  ['group rate', 'cohort rate'],
  ['your group', 'your cohort'],
  ['a group of drivers', 'a cohort of drivers'],
  /* The comparison table, the four how-it-works steps, and the what-you-get
     list. Every one of these is the design's word for the thing this codebase
     calls a cohort. */
  ['>Group demand<', '>Cohort demand<'],
  ['We take the group to suppliers', 'We take the cohort to suppliers'],
  ['compete for the group\u2019s business', 'compete for the cohort\u2019s business'],
  ['Group pricing from suppliers', 'Cohort pricing from suppliers'],
  /* The footer tagline. "pool" is on the banned list in CLAUDE.md, and this
     is the participle rather than the noun, but the rule does not split that
     hair and the sentence reads the same without it. */
  ['Household buying power, pooled.', 'Household buying power, combined.'],
];
for (const [find, repl] of VOCAB) doc = doc.split(find).join(repl);
/* Names the survivors with their context: a bare count sends the next reader
   grepping a 96 KB canvas for a word that appears in attributes too. */
const visible = doc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const strays = [...visible.matchAll(/\bgroups?\b/gi)]
  .map(m => visible.slice(Math.max(0, m.index - 60), m.index + 40).trim());
if (strays.length) throw new Error(`"group" still in visible copy:\n  ${strays.join('\n  ')}`);
const strayPool = (doc.replace(/<[^>]+>/g, ' ').match(/\bpool(ing|ed|s)?\b/gi) || []).length;
if (strayPool) throw new Error(`"pool" still in visible copy ${strayPool} time(s)`);
if (doc.includes('—')) throw new Error('an em dash survived');

/* ---------- 6b. where "join" goes, and what the two paths are called ------ */

/* Every Join control scrolls to the join section at the foot of the page, and
   the choice is made there. That section is the pitch: what joining costs,
   what it gets you, and the two ways in. Sending the header CTA straight to
   the form skips all of it. That was tried, and reverted at the owner's call.

   The path cards take the names the design's own signup flow used, which this
   port cut along with the flow shell. "Just hold my spot" loses the "just":
   nothing about holding a spot is the lesser choice, and the word apologised
   for picking it. */
const joinCtas = (doc.match(/href="#join"/g) || []).length;
if (joinCtas !== 4) throw new Error(`expected 4 #join links, found ${joinCtas}`);

const PATH_NAMES = [
  ['>Quick signup<', '>Hold my spot<'],
  ['>Guided signup<', '>Build my profile<'],
];
for (const [find, repl] of PATH_NAMES) {
  if ((doc.split(find).length - 1) !== 1) throw new Error(`path card ${find}: expected exactly 1`);
  doc = doc.split(find).join(repl);
}

/* ---------- 7. cross-host links ---------- */

/* Nothing on this host links to a path another host owns. The wordmark goes
   to the umbrella, the cross-sell to the internet product, and everything
   else is same-host. */
doc = doc.replace(/<a href="#top" style="display:flex/, `<a href="${UMBRELLA}" style="display:flex`);
const XLINKS = [['#internet-program', `${NET}/`], ['#internet', `${NET}/`]];
for (const [find, repl] of XLINKS) doc = doc.split(`href="${find}"`).join(`href="${repl}"`);

/* ---------- 8. the page ---------- */

const body = doc.replace(/<!DOCTYPE html>[\s\S]*?<body>/i, '').replace(/<\/body>[\s\S]*$/i, '').trim();

const page = `<!DOCTYPE html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Whollar winter tires: one cohort, one price, GTA 2026</title>
<meta name="description" content="Whollar brings GTA drivers together so installers bid for the whole cohort at once. Work out what you actually need, then hold your spot for Winter 2026.">
<link rel="canonical" href="${HOST}/">
<meta property="og:type" content="website">
<meta property="og:url" content="${HOST}/">
<meta property="og:title" content="Whollar winter tires: one cohort, one price">
<meta property="og:description" content="Stop shopping for winter tires one car at a time. GTA drivers, one cohort, Winter 2026.">
<meta property="og:image" content="${HOST}/og/tires.jpg">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"${UMBRELLA}/#org","name":"Whollar","url":"${UMBRELLA}/"},{"@type":"Service","name":"Whollar winter tire cohort","serviceType":"Collective buying for winter tires and installation","areaServed":{"@type":"Place","name":"Greater Toronto Area"},"provider":{"@id":"${UMBRELLA}/#org"},"url":"${HOST}/"}]}</script>
<script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "xrkpgls1yj");</script>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
${fontCss}
</style>
${helmet}
<style>
/* The nav, the hero CTA and the footer all point at sections of this page, and
   the canvas left them as instant jumps under a sticky header: the section
   title landed behind the bar and nothing told you the page had moved.
   --wh-head is measured off that header in js/tires.js, because it is taller on
   a phone than the 92px fallback here. Smooth is opt-out, not opt-in: someone
   who asked their system for less motion gets the jump. */
html{scroll-padding-top:var(--wh-head,92px)}
@media (prefers-reduced-motion: no-preference){html{scroll-behavior:smooth}}
/* :hover rules generated from the canvas's style-hover attributes. */
${hoverCss}
</style>
</head>
<body>

${body}

<script src="/js/tires.js?v=${STAMP}"></script>
</body>
</html>
`;

writeFileSync(join(OUT, 'index.html'), page);

/* ---------- 9. the waitlist is NOT generated ----------

   It was, briefly, and this is why it stopped being. whollar-waitlist-tyre.html
   is a one-time design drop with no runtime and no upstream that will ever
   regenerate it, so the only thing a generator bought here was the ability to
   re-run a set of string edits against a file nobody will edit again. Against
   that, tires/join.html now carries a real submit: payload assembly, the
   validation that mirrors POST /tire-waitlist-join, the CASL consent record
   read off the label as ticked, and the deep links from this page. Maintaining
   that as string patches applied to the prototype's inline script inside a
   Node template literal means every backend change is an edit to a string.

   So tires/join.html and tires/js/tire-join.js are ordinary source files,
   registered in the gates by hand like every other page outside partner/:
   scripts/check-inline-scripts.mjs, scripts/check-console-copy.mjs, and a
   node --check step in .github/workflows/check-frontend.yml. The prototype
   stays in the repo, and in .vercelignore, so the rewire can still be read
   against its source.

   What this port DOES still own is tires/index.html above, which has an
   upstream that regenerates: the design canvas. */

console.log(`hover rules: ${hoverRules.size}`);
console.log(`fonts copied: ${fontFiles.size}`);
for (const [f, n] of written) console.log(`  ${f}  ${(n / 1024).toFixed(0)} KB`);
console.log(`tires/index.html written: ${(page.length / 1024).toFixed(0)} KB`);
