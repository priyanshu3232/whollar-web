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
const STAMP = '20260903n';

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

/* ---------- 10. the smart-buy kit and the sign-up, as modals ---------- */

/* whollar-tire-waitlist-v5.html is the third design drop and the only one with
   working machinery: four calculators with real decision logic, a vehicle
   fitment database, Canadian tire brand and line data, GTA cost config, and a
   two-path sign-up whose answers carry across from the tools. None of that is
   worth reimplementing, so it is ported rather than rewritten.
 *
   WHAT CHANGES, AND WHY. v5 opens its tools as an accordion that grows the
   page, and reveals its sign-up inline. On this page all six open as a modal
   over the landing page instead, which is what the owner asked for and what
   keeps the four cards a fixed size. So the accordion handler and the inline
   reveal in pickPath are the two behaviours replaced; everything else, every
   question, option, hint, disclaimer and result string, is carried verbatim. */

const KIT_JS_HEADER = `/* tires.whollar.ca: the smart-buy kit and the sign-up.
 *
 * GENERATED by scripts/port-tires.mjs from
 * WhollarTireLandingPage/uploads/whollar-tire-waitlist-v5.html. Edit the
 * design drop or the port, never this file.
 *
 * v5 is the only drop with working machinery: four calculators with real
 * decision logic, a vehicle fitment database, Canadian tire lines, GTA cost
 * config, and a two-path sign-up whose answers carry across from the tools.
 * All of it is ported rather than rewritten, question for question.
 *
 * THREE THINGS THE PORT CHANGES.
 *   1. v5 opened the tools as an accordion that grew the page and revealed the
 *      sign-up inline. All six open in one reusable modal here.
 *   2. A cohort opens in waves of 250 so every household gets a real
 *      appointment. The drop used a word CLAUDE.md bans for that, and the
 *      rename covers identifiers as well as copy: waveOf(), CFG.waveSize.
 *   3. v5 fabricated a household count seeded at 1,847, a reference code
 *      minted in the browser, a referral queue with a "simulate a friend"
 *      button, and a confirmation claiming an email had been sent. None of it
 *      ships. The seeds are zero and the completion screen says only what
 *      actually happened.
 *
 * THE FORM STILL SAVES NOTHING. POST /tire-waitlist-join and its three tables
 * are specified in docs/TIRE_VERTICAL_BUILD.md and do not exist yet. The four
 * calculators are fully working: they run entirely here.
 */
`;

const V5_PATH = join(ROOT, 'WhollarTireLandingPage', 'uploads', 'whollar-tire-waitlist-v5.html');
const v5 = readFileSync(V5_PATH, 'utf8').split('\n');
/* 1-indexed and inclusive, to match what the anchors below assert. */
const cut = (a, b) => v5.slice(a - 1, b).join('\n');

/* The boundaries are asserted rather than trusted: a re-exported v5 that moves
   a section would otherwise be sliced silently in the wrong place. */
const ANCHORS = [[13, '<style>'], [379, '</style>'], [509, '<section class="signup" id="signup">'],
  [849, '</section>'], [862, '<section class="confirm hide" id="confirmView">'], [917, '</section>'],
  [928, '<script>'], [2982, '</script>']];
for (const [n, text] of ANCHORS) {
  if (v5[n - 1].trim() !== text) throw new Error(`v5 line ${n} should be ${text}, found ${v5[n - 1].trim()}`);
}

let kitCss = cut(14, 378);
let kitMarkup = cut(509, 849) + '\n' + cut(862, 917);
let kitJs = cut(929, 2981);

/* ---------- 10a. vocabulary ---------- */

/* CLAUDE.md bans "batch", and says so about variable names as well as copy, so
   this is a rename of the concept and not a find-and-replace over the strings:
   waveOf(), CFG.waveSize, S.wave, "Wave 1 opens Oct 6". A cohort opens in
   waves of 250 so every household gets a real appointment. Sixty-six uses, and
   no English word in this file contains "batch" as a substring, so the blanket
   replace is exact. */
for (const [find, repl] of [['batch', 'wave'], ['Batch', 'Wave'], ['pooled', 'combined']]) {
  kitJs = kitJs.split(find).join(repl);
  kitMarkup = kitMarkup.split(find).join(repl);
  kitCss = kitCss.split(find).join(repl);
}

/* ---------- 10b. what v5 fabricates, and does not ship ---------- */

/* Same three lies the /join prototype told, in a bigger frame: a seeded
   household count that starts at 1,847 and is never read from anywhere, a
   reference code minted in the browser, and a confirmation that says an email
   is on its way. On top of those, v5 adds a referral panel whose queue,
   invite tiles and "Simulate a friend joining" button all move numbers that
   no server produced. All of it goes. What is left is a completion screen
   that says what actually happened. */
const HONESTY = [
  /* The seeds. Every city starts at zero until something counts them. */
  [/seed:\s*\d+/g, 'seed:0'],
  [/netCount:\s*\d+,/, 'netCount:null,'],
  /* The confirmation's fabricated lines. */
  /* Anchored to the end of the line, not to the next quote: both of these are
     one long concatenation whose own quotes would end a lazy match early. */
  [/\$\("confRank"\)\.innerHTML = 'You are household.*\n/,
   '$("confRank").textContent = "Your spot is counted, and we will confirm it by email.";\n'],
  [/\$\("confRank"\)\.innerHTML = 'You are vote.*\n/,
   '$("confRank").textContent = "Your vote is counted. We follow the demand.";\n'],
];
for (const [find, repl] of HONESTY) {
  if (!find.test ? !kitJs.includes(find) : !find.test(kitJs)) throw new Error(`honesty edit matched nothing: ${find}`);
  kitJs = kitJs.replace(find, repl);
}

/* The markup those lines drove, plus the referral panel. Cut by anchor so a
   moved block fails here rather than shipping half of itself. */
const STRIP = [
  ['<div class="refbox">', '</div>\n      <p class="mailnote" id="confMail"></p>'],
  ['<div class="linebox">', '<button class="btn btn-ghost btn-sm" type="button" id="fakeRef">Simulate a friend joining</button>\n      </div>'],
];
for (const [from, to] of STRIP) {
  const a = kitMarkup.indexOf(from);
  const b = kitMarkup.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`strip anchor not found: ${from}`);
  kitMarkup = kitMarkup.slice(0, a) + kitMarkup.slice(b + to.length);
}
kitMarkup = kitMarkup.replace('<span id="netCount">4,231</span> households have already joined that one. ', '')
  .replace('<span id="netCount">4231</span> households have already joined that one. ', '');
for (const dead of ['refbox', 'linebox', 'fakeRef', 'confMail']) {
  if (kitMarkup.includes(dead)) throw new Error(`the strip left ${dead} behind`);
}
/* Everything the stripped markup used to answer to. A guard rather than a
   deletion: the handlers stay readable, and the day a server mints a reference
   the markup comes back and they light up again. */
kitJs = kitJs
  .replace('function renderQueue(){', 'function renderQueue(){\n  if(!$("qYou")) return;   /* the referral panel is not on this page */')
  .replace('$("confRef").textContent = S.ref;', 'if($("confRef")) $("confRef").textContent = S.ref;')
  .replace('$("refUrl").value = "whollar.ca/tires?r=" + S.ref.split("-").pop();', 'if($("refUrl")) $("refUrl").value = "whollar.ca/tires?r=" + S.ref.split("-").pop();')
  .replace('$("confMail").textContent = r.email ? "Confirmation on its way to " + r.email + "." : "";', '')
  .replace('$("netCount").textContent = nf(CFG.netCount);', '')
  /* Every visitor is household number one until something counts them, so the
     toast says what happened without putting a number on it. */
  .replace('toast("Spot locked in. You are household <b>#"+nf(S.rank)+"</b>, Wave "+S.wave+".");',
    'toast("Spot noted. Two more sections, and your answers are kept as you go.");')
  .replace('$("copyRef").addEventListener', 'if($("copyRef")) $("copyRef").addEventListener')
  .replace('$("copyLink").addEventListener', 'if($("copyLink")) $("copyLink").addEventListener')

  /* "Simulate a friend joining" moved a referral count with no server behind
     it. Deleted rather than guarded: this one must never come back. */
  .replace(/  \$\("fakeRef"\)\.addEventListener\("click", function\(\)\{[\s\S]*?\n  \}\);\n/, '')
  /* v5's hero owned these two, and this page's hero does not. */
  .replace('$("ctaJoin").addEventListener("click", function(){ scrollToEl($("signup")); });', '')
  .replace('$("ctaTools").addEventListener("click", function(){ scrollToEl($("kit")); });', '')
  /* The hero count-up animated a seeded number that is now zero. */
  .replace(/  \/\/ hero count-up\n  if\(!reduced\(\)\)\{[\s\S]*?\n  \}\n/, '');

/* ---------- 10c. v5's stylesheet, minus everything global ---------- */

/* v5 was a whole page, so its stylesheet sets body, a, button, h1 to h4 and
   :focus-visible. Those would restyle the landing page underneath, which is
   inline-styled canvas output and has its own type. Only the component classes
   come across, and :root with them, because every one of those classes reads
   its colours from those variables. */
const GLOBAL_RULES = [
  '*{box-sizing:border-box;margin:0;padding:0}',
  'html{scroll-behavior:smooth}',
  '@media (prefers-reduced-motion:reduce){ html{scroll-behavior:auto} *{transition:none!important;animation:none!important} }',
  "body{font-family:var(--body);background:var(--cream);color:var(--ink);font-size:16px;line-height:1.58;-webkit-font-smoothing:antialiased}",
  'button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}',
  'a{color:var(--green-deep);text-decoration:underline;text-underline-offset:3px}',
  'input,select,textarea{font:inherit;color:var(--ink)}',
  ':focus-visible{outline:3px solid var(--gold);outline-offset:2px;border-radius:10px}',
  "h1,h2,h3,h4{font-family:var(--disp);letter-spacing:-.01em;text-wrap:balance;line-height:1.13}",
];
for (const rule of GLOBAL_RULES) {
  if (!kitCss.includes(rule)) throw new Error(`v5 global rule not found, so not removed: ${rule.slice(0, 40)}`);
  kitCss = kitCss.split(rule).join('');
}
/* Scoped so the ported components style the modal and nothing else, and so
   v5's --disp (Satoshi, which this host does not serve) falls back to the
   families the landing page already self-hosts. */
kitCss = kitCss.replace(":root{", ".wm-scope,.wmodal{")
  .replace("--disp:'Satoshi',system-ui,-apple-system,sans-serif;", "--disp:'Bricolage Grotesque',system-ui,sans-serif;")
  .replace("--body:'Inter',system-ui,-apple-system,sans-serif;", "--body:'Inter',system-ui,sans-serif;");
if (/Satoshi|fontshare/.test(kitCss)) throw new Error('a font this host does not serve survived');

/* ---------- 10d. the accordion becomes a modal ---------- */

const ACCORDION = kitJs.indexOf('  // kit accordion');
const ACCORDION_END = kitJs.indexOf('  // guided helper folds');
if (ACCORDION < 0 || ACCORDION_END < ACCORDION) throw new Error('the kit accordion block moved');
kitJs = kitJs.slice(0, ACCORDION) + `  // the four tools, as modals over the page
  qsa("[data-wtool]").forEach(function(el){
    el.addEventListener("click", function(e){
      var name = el.getAttribute("data-wtool");
      /* The link is the no-JS path and still goes to /join. With JS the modal
         is the answer, so the navigation is cancelled here and only here. */
      e.preventDefault();
      if(el.classList.contains("locked")){ toast("Not needed with all-weather tires."); return; }
      WM.open(TOOL_TITLES[name], el, function(body){
        /* The mount is a long-lived element that lives in the park between
           opens. Creating one here instead would put a second node with the
           same id in the document, and getElementById would hand mountTool
           the parked one, which is hidden. */
        body.appendChild($("wm-mount-" + name));
        mountTool(name, "wm-mount-" + name, "kx" + name);
      });
    });
  });
` + kitJs.slice(ACCORDION_END);

/* pickPath revealed a form inline and scrolled the page down to it. Now it
   opens the same form in the modal. The state it sets, the remounts and the
   meter are untouched: only where the form appears has changed. */
const OLD_PICK = `function pickPath(which){
  S.path = which;
  $("pathQuick").classList.toggle("sel", which==="quick");
  $("pathGuided").classList.toggle("sel", which==="guided");
  show($("quickForm"), which==="quick");
  show($("guidedForm"), which==="guided");
  if(which==="guided"){ remountOther("strat","x"); remountOther("size","x"); remountOther("rims","x"); remountOther("ins","x"); }
  updateMeter();
  scrollToEl(which==="quick" ? $("quickForm") : $("guidedForm"));
}`;
if (!kitJs.includes(OLD_PICK)) throw new Error('pickPath is not the shape this port expects');
kitJs = kitJs
  .replace('strat: [["mount-k-strat","kxstrat"],', 'strat: [["wm-mount-strat","kxstrat"],')
  .replace('size:  [["mount-k-size","kxsize"],', 'size:  [["wm-mount-size","kxsize"],')
  .replace('rims:  [["mount-k-rims","kxrims"],', 'rims:  [["wm-mount-rims","kxrims"],')
  .replace('ins:   [["mount-k-ins","kxins"],', 'ins:   [["wm-mount-ins","kxins"],');
kitJs = kitJs.split(OLD_PICK).join(`function pickPath(which, opener){
  S.path = which;
  show($("quickForm"), which==="quick");
  show($("guidedForm"), which==="guided");
  if(which==="guided"){ remountOther("strat","x"); remountOther("size","x"); remountOther("rims","x"); remountOther("ins","x"); }
  updateMeter();
  WM.open(which==="quick" ? "Hold my spot" : "Build my profile", opener || null, function(body){
    body.appendChild($("kitchips"));
    body.appendChild($("quickForm"));
    body.appendChild($("guidedForm"));
  });
}`);

/* Inside a modal the page does not move, so a stage change scrolls the dialog
   body rather than the document. */
kitJs = kitJs.split(`  scrollToEl($("guidedForm"));
}`).join(`  WM.toTop();
}`);

/* The two path cards on the landing page are the pathQuick and pathGuided
   buttons v5 drew inside its own sign-up, which this port does not import. */
kitJs = kitJs
  .replace('$("pathQuick").addEventListener("click", function(){ pickPath("quick"); });',
    'qsa(\'[data-wpath="quick"]\').forEach(function(el){ el.addEventListener("click", function(e){ e.preventDefault(); pickPath("quick", el); }); });')
  .replace('$("pathGuided").addEventListener("click", function(){ pickPath("guided"); setStage(1); });',
    'qsa(\'[data-wpath="guided"]\').forEach(function(el){ el.addEventListener("click", function(e){ e.preventDefault(); pickPath("guided", el); setStage(1); }); });')
  /* Back out of a form: close the dialog rather than hide a panel on a page. */
  .replace('$("q_back").addEventListener("click", function(){ show($("quickForm"), false); $("pathQuick").classList.remove("sel"); scrollToEl($("paths")); });',
    '$("q_back").addEventListener("click", function(){ WM.close(); });')
  .replace('$("g_back1").addEventListener("click", function(){ show($("guidedForm"), false); $("pathGuided").classList.remove("sel"); scrollToEl($("paths")); });',
    '$("g_back1").addEventListener("click", function(){ WM.close(); });');
for (const dead of ['$("pathQuick")', '$("pathGuided")', '$("paths")']) {
  if (kitJs.includes(dead)) throw new Error(`${dead} survived, and this page has no such element`);
}

/* The completion screen is a screen in v5 and a modal view here. */
kitJs = kitJs.replace('  show($("home"), false); show($("confirmView"), true);\n  window.scrollTo(0,0);',
  `  WM.open("You are in", null, function(body){ body.appendChild($("confirmView")); show($("confirmView"), true); });`);
kitJs = kitJs.replace('$("backHome").addEventListener("click", function(){\n    show($("confirmView"), false); show($("home"), true);\n    window.scrollTo(0,0);\n  });',
  '$("backHome").addEventListener("click", function(){ WM.close(); });');
kitJs = kitJs.replace('    show($("confirmView"), false); show($("home"), true);\n    pickPath("guided"); setStage(1);',
  '    show($("confirmView"), false);\n    pickPath("guided"); setStage(1);');

/* ---------- 10e. the modal itself ---------- */

const MODAL_JS = `
/* ---- the modal every one of the six buttons opens ----
 * One dialog, reused. The page behind it never moves: it is scroll-locked
 * while the dialog is open and the dialog scrolls its own body. Focus goes in
 * on open, is trapped while open, and returns to the control that opened it.
 *
 * The four tools are rebuilt on each open, which is what mountTool already
 * does. The two forms are MOVED into the dialog rather than rebuilt, so a
 * half-typed answer and every binding on them survives being closed and
 * reopened. That is why the body is emptied by moving its children back to
 * the parking element rather than by innerHTML. */
var TOOL_TITLES = {
  strat: "Winter tires, or all-weather?",
  size:  "What size do I actually need?",
  rims:  "One set of wheels, or two?",
  ins:   "What does my insurer actually give back?"
};

var WM = (function(){
  var root, dialog, body, titleEl, closeBtn, park, lastFocus = null, open = false;

  function focusable(){
    return qsa('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', dialog)
      .filter(function(el){ return el.offsetParent !== null || el === closeBtn; });
  }
  function onKey(e){
    if(!open) return;
    if(e.key === "Escape"){ e.preventDefault(); api.close(); return; }
    if(e.key !== "Tab") return;
    var f = focusable(); if(!f.length) return;
    var first = f[0], last = f[f.length-1];
    if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  }

  var api = {
    open: function(titleText, opener, fill){
      if(!root) return;
      api.empty();
      titleEl.textContent = titleText || "";
      lastFocus = opener || document.activeElement;
      fill(body);
      root.hidden = false;
      open = true;
      document.body.style.overflow = "hidden";
      var f = focusable();
      (f.length ? f[0] : closeBtn).focus();
    },
    close: function(){
      if(!root || !open) return;
      api.empty();
      root.hidden = true;
      open = false;
      document.body.style.overflow = "";
      if(lastFocus && lastFocus.focus) lastFocus.focus();
    },
    /* Children go back to the parking element, never to the bin: quickForm,
       guidedForm, kitchips and confirmView are long-lived and carry state. */
    empty: function(){
      while(body.firstChild){ park.appendChild(body.firstChild); }
    },
    toTop: function(){ if(body) body.scrollTop = 0; }
  };

  function boot(){
    root = $("wmodal"); if(!root) return;
    dialog = qs(".wmodal", root); body = $("wmodalBody");
    titleEl = $("wmodalTitle"); closeBtn = $("wmodalClose"); park = $("wm-park");
    root.addEventListener("click", function(e){ if(e.target === root) api.close(); });
    closeBtn.addEventListener("click", api.close);
    document.addEventListener("keydown", onKey);
  }
  boot();
  return api;
})();
`;
/* ---------- 10e1. the submit ---------- */

/* v5 ended at a console.log. This is the wiring to POST /tire-waitlist-join,
   which writes TireWaitlistSignups, TireWaitlistVehicles, TireWaitlistDetails,
   TireInstallWindows and TireToolRuns (create-tables.md, sections 35 and 36).

   WHY NOT js/whollar-core.js. The vertical playbook says a vertical that uses
   the shared core should copy it with a CI gate holding it byte identical.
   That is right for a page that uses the core; this one would be loading 103 KB
   of member, partner, campaign and referral machinery to reach two functions,
   on a landing page that already carries a 141 KB engine. So the transport is
   here, small, and the comment names what it mirrors so the next person can
   see it is deliberate rather than ignorant of W.submitForm.

   THE ONE SUBTLETY, and the reason a copy is dangerous at all: the body goes
   out with no Content-Type, which makes it text/plain, which is CORS
   safelisted, which means no preflight. The Catalyst gateway answers a
   preflight with no CORS headers at all, so a request that triggers one fails
   before it is sent. Do not "tidy" this by adding application/json. */
const SUBMIT_JS = `
var TIRE_API = "https://whollar-110003037934.development.catalystserverless.ca/server/formSubmit";

/* Mirrors W.submitForm in js/whollar-core.js. See the note in
   scripts/port-tires.mjs section 10e1 before changing the Content-Type. */
function postForm(path, fields){
  return fetch(TIRE_API + path, { method: "POST", body: JSON.stringify(fields) })
    .then(function(r){
      return r.json().catch(function(){ return null; }).then(function(body){
        if(!r.ok){
          var e = new Error((body && body.error) || ("submit failed: " + r.status));
          e.status = r.status; e.body = body;
          throw e;
        }
        return body || {};
      });
    });
}

/* Mirrors W.consentPayload. The field names are read by consentFrom() in
   catalyst-backend/functions/formSubmit/index.js, so the two are only correct
   while they agree. CASL needs what was agreed, when, and where. */
var CONSENT_TEXT = "Add me to the Whollar winter tire cohort and email me about it. I understand this is not a purchase and nothing is charged today.";

/* What the route expects. Built from the same S.record the page already
   assembles, so the form stays the source of truth and this is only a shape. */
function submitPayload(){
  var r = S.record, t = S.tools || {};
  var veh = {
    inputMode: r.veh_entry_mode || "unsure",
    year: r.veh_year, make: r.veh_make, model: r.veh_model,
    vin: r.vin, tireSize: r.tire_size,
    sizeNormalized: (t.size && t.size.oe) || null,
    strategy: r.strategy,
    startingPoint: r.have,
    tireLifeLeft: r.tire_life_left,
    trim: r.veh_trim,
    winterSizeChosen: r.winter_size_chosen,
    sizeDownsized: r.size_downsized,
    sizeAck: r.size_ack,
    staggered: r.staggered,
    tpmsPresent: r.tpms_present,
    rimsRecommendation: r.rims_recommendation,
    ownsRims: (t.rims && t.rims.wh) || null,
    runsWinterNow: null
  };
  var details = r.path === "guided" ? {
    needs: (r.needs || []).join(","),
    tier: r.tier, brand: r.brand, budget: r.budget_per_tire,
    financing: r.financing_interest, installerType: r.installer_type,
    splitPreference: r.split_install_storage ? "prefer" : null,
    installWindows: (r.preferred_slots || []).map(function(x){ return x.date + " " + x.slot; }).join(", "),
    notBefore: r.window_earliest, mustBeOnBy: r.window_latest,
    memberships: (r.memberships || []).join(","),
    priorities: (r.priorities || []).join(","),
    readiness: r.readiness, notes: r.notes,
    brandLine: r.brand_line, travelRadius: r.travel_radius,
    installerName: r.installer_name, installerAddress: r.installer_address,
    installerPostal: r.installer_postal,
    insuranceHelp: r.insurance_help, insurerProvince: r.insurer_province,
    premiumAnnual: r.premium_annual,
    /* Everything asked that has no column, kept verbatim so a new question is
       not a schema change. */
    payload: { language: r.language, smsOpt: r.sms_opt, staggered: r.staggered,
      vehTrim: r.veh_trim, toolsAnswered: Object.keys(t) }
  } : null;

  return {
    path: r.path, source: "tires-site",
    firstName: r.first_name, lastName: r.last_name, email: r.email,
    phone: r.mobile, postalFull: r.postal, city: r.city,
    language: r.language || "en", referral: null,
    consentEmail: !!r.consent_cohort,
    consentSms: !!r.sms_opt,
    consentShare: !!r.consent_share_installers,
    alsoInternet: !!r.consent_internet,
    consentGranted: !!r.consent_cohort,
    consentKind: "tire-cohort",
    consentText: CONSENT_TEXT,
    consentAt: new Date().toISOString(),
    consentSource: window.location.pathname,
    vehicles: [veh],
    details: details,
    windows: (r.preferred_slots || []).map(function(x){ return { date: x.date, slot: x.slot, rank: x.rank }; }),
    toolRuns: Object.keys(t).map(function(k){ return { tool: k, input: null, output: t[k] }; })
  };
}
`;
const FINISH_AT = kitJs.indexOf('function finish(){');
if (FINISH_AT < 0) throw new Error('finish() not found');
kitJs = kitJs.slice(0, FINISH_AT) + SUBMIT_JS + '\n' + kitJs.slice(FINISH_AT);

/* finish() stops pretending. It posts, waits, and only then opens the
   completion screen, with the reference the SERVER minted. A failure says so
   and leaves the form on screen with everything still typed in it, because the
   one thing worse than a form that will not send is a form that says it did. */
const OLD_FINISH = `  /* ---- ZOHO / CATALYST POST GOES HERE ----------------------
     One call creates the Contact and the Waitlist Entry.
     Everything the backend needs is in this object.
     -------------------------------------------------------- */
  console.log("WAITLIST RECORD (would POST to Catalyst):", r);
`;
if (!kitJs.includes(OLD_FINISH)) throw new Error('the finish() placeholder moved');
kitJs = kitJs.split(OLD_FINISH).join(`  postForm("/tire-waitlist-join", submitPayload()).then(function(saved){
    /* The reference is the server's. v5 minted one in the browser, which meant
       two people could hold the same code and nothing could be looked up by
       it. makeRef stays only as the label until this returns. */
    S.ref = saved.reference || S.ref;
    S.wave = saved.wave || S.wave;
    showConfirmation();
  }).catch(function(err){
    busyFinish(false);
    toast(esc(err.message || "We could not save that just now. Nothing was lost, try again."));
  });
  return;
}

/* Split out so the post above has something to call, and so the completion
   screen is built from what came back rather than from what was hoped. */
function showConfirmation(){
  /* Re-enabled on the way through, not only on failure. v5 offers "Add
     another vehicle" from the completion screen, which returns to a form whose
     submit button would otherwise still be disabled and still saying it was
     saving. */
  busyFinish(false);
  var r = S.record;
`);
if (!kitJs.includes('function showConfirmation()')) throw new Error('the finish split did not attach');

/* The submit button has to say something while the request is in flight, or a
   slow network reads as a dead button and gets clicked twice. */
kitJs = kitJs.replace('function finish(){', `function busyFinish(on){
  var b = qs("#g3 button[type=submit]") || qs("#quickForm button[type=submit]");
  if(!b) return;
  b.disabled = on;
  b.style.opacity = on ? "0.6" : "";
  b.dataset.label = b.dataset.label || b.textContent;
  b.textContent = on ? "Saving your spot..." : b.dataset.label;
}

function finish(){
  busyFinish(true);`);

/* ---------- 10e2. long lists of options become a dropdown ---------- */

/* Five or more choices in a row of chips is a wall, and the seven-city and
   six-installer questions were the worst of them. Those condense to a select.
 *
   THE CHIPS STAY, hidden, and remain the source of truth. Everything in v5
   reads and writes them: chipVal, chipVals, setChip, clearChips, gateChips,
   every applyPrefill branch and every gate that disables an option. Replacing
   them with a select would mean rewriting all of that. Driving them from a
   select instead means none of it changes, and an observer keeps the select
   showing whatever the chips say, whoever set them.
 *
   Single-select only. "What you need from us" and "What matters most" are
   multi-select with a cap, and a multiple select box is a worse control than
   the chips, not a better one. */
const CONDENSE_JS = `
var CONDENSE_MIN = 5;

function condenseChips(box){
  if(!box || box.dataset.condensed || !box.dataset.single) return;
  var chips = qsa(".chip", box);
  if(chips.length < CONDENSE_MIN) return;
  box.dataset.condensed = "1";

  var sel = document.createElement("select");
  sel.className = "f-in wm-condensed";
  var lbl = box.previousElementSibling;
  if(lbl && lbl.classList && lbl.classList.contains("f-lbl")) sel.setAttribute("aria-label", lbl.textContent.trim());

  var ph = document.createElement("option");
  ph.value = ""; ph.textContent = "Choose one";
  sel.appendChild(ph);
  chips.forEach(function(c, i){
    var o = document.createElement("option");
    o.value = String(i);
    var small = c.querySelector("small");
    var main = small ? c.textContent.replace(small.textContent, "") : c.textContent;
    o.textContent = small ? main.trim() + " \u00b7 " + small.textContent.trim() : main.trim();
    sel.appendChild(o);
  });

  /* One direction: the reader picks, the chip is pressed, and the chipchange
     event every v5 handler already listens for is dispatched as if they had
     clicked it. */
  sel.addEventListener("change", function(){
    var i = sel.value === "" ? -1 : Number(sel.value);
    chips.forEach(function(c, n){ c.setAttribute("aria-pressed", n === i ? "true" : "false"); });
    box.dispatchEvent(new CustomEvent("chipchange", { bubbles: true }));
  });

  /* The other: anything that presses or disables a chip, and there are many,
     is reflected back without those functions knowing this control exists. */
  var syncing = false;
  function sync(){
    if(syncing) return;
    syncing = true;
    var picked = -1;
    chips.forEach(function(c, n){
      if(c.getAttribute("aria-pressed") === "true") picked = n;
      var o = sel.options[n + 1];
      if(o) o.disabled = c.dataset.off === "1";
    });
    sel.value = picked < 0 ? "" : String(picked);
    syncing = false;
  }
  sync();
  if(window.MutationObserver){
    new window.MutationObserver(sync).observe(box, {
      subtree: true, attributes: true, attributeFilter: ["aria-pressed", "data-off"]
    });
  }
  box.parentNode.insertBefore(sel, box.nextSibling);
}
`;

/* Every group goes through bindChips, and by then its options exist: the two
   that build themselves, fillCityChips and fillBudget, set innerHTML first. */
const OLD_BIND_END = `    box.dispatchEvent(new CustomEvent("chipchange",{bubbles:true}));
  });
}`;
if (!kitJs.includes(OLD_BIND_END)) throw new Error('bindChips is not the shape this port expects');
kitJs = kitJs.split(OLD_BIND_END).join(`    box.dispatchEvent(new CustomEvent("chipchange",{bubbles:true}));
  });
  condenseChips(box);
}`);

/* Defined before init() runs, and inside v5's own closure so it can see $, qs,
   qsa, show, toast and mountTool. */
const INIT_AT = kitJs.indexOf('function init(){');
if (INIT_AT < 0) throw new Error('init() not found');
kitJs = kitJs.slice(0, INIT_AT) + CONDENSE_JS + MODAL_JS + '\n' + kitJs.slice(INIT_AT);

/* ---------- 10f. what goes on the page ---------- */

/* v5's own heading and its two path cards go: this page already has both, in
   the join section, and they are what carry data-wpath. */
const HEAD_FROM = '    <h2>Take your spot.</h2>';
const HEAD_TO = '    <!-- ======== QUICK FORM ======== -->';
const hf = kitMarkup.indexOf(HEAD_FROM), ht = kitMarkup.indexOf(HEAD_TO);
if (hf < 0 || ht < hf) throw new Error("v5's sign-up heading and paths block moved");
kitMarkup = kitMarkup.slice(0, hf) + '    <div class="kitchips hide" id="kitchips"></div>\n\n' + kitMarkup.slice(ht);
if (kitMarkup.includes('id="pathQuick"')) throw new Error('v5 path cards survived');

/* Everything is parked off screen until a modal asks for it. The parking
   element is display:none, so nothing here is in the accessibility tree or
   the tab order while it waits. */
const KIT_MARKUP = `
<!-- The sign-up, the four tool mounts and the completion screen. Parked here
     and moved into the dialog on demand, so state and bindings survive being
     closed and reopened. Generated by scripts/port-tires.mjs from
     WhollarTireLandingPage/uploads/whollar-tire-waitlist-v5.html. -->
<div id="wm-park" class="wm-scope" hidden>
  <div id="wm-mount-strat"></div>
  <div id="wm-mount-size"></div>
  <div id="wm-mount-rims"></div>
  <div id="wm-mount-ins"></div>
${kitMarkup}
</div>

<div class="wmodal-backdrop wm-scope" id="wmodal" hidden>
  <div class="wmodal" role="dialog" aria-modal="true" aria-labelledby="wmodalTitle">
    <div class="wmodal-head">
      <h3 id="wmodalTitle"></h3>
      <button type="button" class="wmodal-x" id="wmodalClose" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
      </button>
    </div>
    <div class="wmodal-body" id="wmodalBody"></div>
  </div>
</div>
`;

/* The canvas already draws a toast, and v5's script drives it by id, so a
   second one here would be a duplicate id and the wrong one would win. */
const TOASTS = (doc.match(/id="toast"/g) || []).length;
if (TOASTS !== 1) throw new Error(`expected the canvas to carry exactly 1 toast, found ${TOASTS}`);
doc = doc.replace('<div class="toast" id="toast"></div>', '<div class="toast wm-scope" id="toast"></div>');

const MODAL_CSS = `
/* v5's components were authored under a global reset this page does not have
   and must not gain: the canvas markup around them is inline-styled and
   assumes default box sizing. Scoped here to the dialog and the parked markup,
   which reproduces exactly the environment those styles expect. Without it
   .f-in's width:100% plus its own padding overflows its .frow grid column, and
   the first and last name inputs overlap. */
.wm-scope,.wm-scope *,.wmodal,.wmodal *{box-sizing:border-box;margin:0;padding:0}
/* The dialog. Centred over a dimmed page on a desktop, a full screen sheet on
   a phone, and its body is what scrolls, so the page behind never moves. */
.wmodal-backdrop{position:fixed;inset:0;background:rgba(14,42,32,.55);display:flex;align-items:center;justify-content:center;padding:24px;z-index:1000}
.wmodal-backdrop[hidden]{display:none}
.wmodal{background:#FCFAF5;border-radius:20px;width:100%;max-width:680px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 30px 80px rgba(14,42,32,.38);font-family:Inter,system-ui,sans-serif;color:#17231D;line-height:1.55;text-align:left}
.wmodal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px;border-bottom:1px solid #E2DACB;background:#FCFAF5;flex:0 0 auto}
.wmodal-head h3{font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-size:20px;letter-spacing:-.02em;margin:0}
.wmodal-x{width:38px;height:38px;flex:0 0 auto;border-radius:50%;border:1px solid #E2DACB;background:#FFFDF8;color:#17231D;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.wmodal-x:hover{background:#F1EDE2}
.wmodal-body{padding:22px;overflow:auto;-webkit-overflow-scrolling:touch}
.wmodal-body > .formcard{margin-top:0}
@media(max-width:640px){
  .wmodal-backdrop{padding:0}
  .wmodal{max-width:none;height:100vh;height:100dvh;max-height:none;border-radius:0}
}
@media(prefers-reduced-motion:no-preference){
  .wmodal{animation:wmPop .18s ease-out}
  @keyframes wmPop{from{transform:translateY(10px);opacity:0}to{transform:none;opacity:1}}
}
/* The completeness meter sticks. v5 offset it by 72px to clear that page's
   own header; in here the dialog body is the scrollport and there is no
   header below it, so 72px parked it in the middle of the panel and the
   section heading scrolled under it. Flush to the top of the scroll area. */
.wm-scope .meter{top:0}
/* Chip groups whose options carry a second line are cards, not tags, and
   flex-wrap left them ragged: two on one row, then one, then one, all
   different widths. An equal column grid lines them up and keeps every option
   the same size, which is what makes them comparable. Groups of plain chips
   (Yes / No, 15 inch / 16 inch) have no second line and stay inline. */
.wm-scope .chips:has(.chip small){display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
/* Plain chips are tags, and tags that wrap ragged read as a different width
   per option when they are really equal choices. Same column rhythm, sized to
   the shorter labels. */
.wm-scope .chips:not(:has(.chip small)){display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:9px}
.wm-scope .chips .chip{width:100%;display:flex;flex-direction:column;justify-content:center}
@media(max-width:560px){
  .wm-scope .chips:has(.chip small),
  .wm-scope .chips:not(:has(.chip small)){grid-template-columns:1fr}
}
/* v5's spacing was drawn for a full page, where a form is one column in a lot
   of air. In a dialog that air is wasted twice over: the panel is already a
   card inside a card, and every section break cost 48px plus a rule. The card
   chrome goes, because the dialog is the card, and the rhythm tightens to
   about half. Nothing is removed, only the gaps between it. */
.wm-scope .formcard{border:0;padding:0;box-shadow:none;background:transparent;margin-top:0}
.wm-scope .formcard + .formcard{margin-top:14px}
.wm-scope .sec-t{margin:16px 0 10px;padding-top:14px}
.wm-scope .sec-t:first-of-type{margin-top:14px}
.wm-scope .field{margin-bottom:12px}
.wm-scope .fgap{margin-top:12px}
.wm-scope .frow,.wm-scope .frow3{gap:12px}
.wm-scope .result{margin-top:12px}
.wm-scope .helperfold{margin:10px 0 2px}
.wm-scope .stagebar{margin:2px 0 4px}
.wm-scope .meter{margin-top:12px}
.wm-scope .formnav{margin-top:18px}
.wm-scope .capnote{margin-top:10px}
.wm-scope .checkline{margin:6px 0}
.wm-scope .signup{padding:0}
.wm-scope .mid{max-width:none;padding:0}
/* !important for the same reason v5's own .hide carries it: the two grid
   rules above match through a :has(), which outranks a plain attribute
   selector, and a row that has been condensed is hidden, full stop. */
.wm-scope .chips[data-condensed]{display:none!important}
/* Selects get the chevron the bill checkup, /become-a-partner and this
   vertical's own /join already use. The native control draws a different
   arrow on every platform and none of them match the chip buttons beside it,
   so Year, Make and Model read as three widgets borrowed from somewhere else.
   Same SVG and the same offsets as those pages, so it is one control across
   the site rather than a fourth variant. */
.wm-scope select.f-in,.wm-scope select.wm-condensed{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' stroke='%235B655C' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 5l4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-right:38px}
.wm-scope select.f-in:disabled{background-image:none}
.wm-scope select.wm-condensed{width:100%}
/* The verdict a tool leaves behind on its card, and the running tally. */
.wm-verdict{display:none;font-size:13.5px;font-weight:600;color:#14352A;background:#CFE7D6;border-radius:9px;padding:6px 12px;width:fit-content;max-width:100%}
[data-wtool].done .wm-verdict{display:inline-block}
.wm-tally{display:inline-block;font-family:Inter,sans-serif;font-size:13px;font-weight:600;color:#2C6A4E;background:#E4EDE2;border:1px solid #CFE0CB;border-radius:999px;padding:7px 15px;margin-top:18px}
[data-wtool].locked{opacity:.55}
`;

/* The four cards gain the id and the hook v5's syncVerdicts paints onto, and
   a place for the verdict to land. The link stays a link: without JavaScript
   it still goes to /join, which is the same tool on its own page. */
const TOOL_KEYS = [['strategy', 'strat'], ['size', 'size'], ['rims', 'rims'], ['insurance', 'ins']];
for (const [urlKey, toolKey] of TOOL_KEYS) {
  const href = `<a href="/join?path=guided&tool=${urlKey}"`;
  if ((doc.split(href).length - 1) !== 1) throw new Error(`tool card ${urlKey}: expected exactly 1`);
  doc = doc.split(href).join(`${href} id="tool-${toolKey}" data-wtool="${toolKey}"`);
}
/* The verdict span goes at the end of each card, which is the last </a> of the
   four in that row. Walked rather than pattern matched, because the cards
   contain anchors of their own. */
for (const [, toolKey] of TOOL_KEYS) {
  const at = doc.indexOf(`data-wtool="${toolKey}"`);
  const end = doc.indexOf('</a>', at);
  if (end < 0) throw new Error(`tool card ${toolKey} has no close`);
  doc = doc.slice(0, end) + `<span class="wm-verdict" id="verdict-${toolKey}"></span>` + doc.slice(end);
}
/* The tally, under the smart-buy heading. */
const TALLY_AT = doc.indexOf('important stuff.</span></h2>');
if (TALLY_AT < 0) throw new Error('the smart-buy heading moved');
doc = doc.slice(0, TALLY_AT + 'important stuff.</span></h2>'.length)
  + '<div style="text-align:center"><span class="wm-tally" id="tally">0 of 4 answered</span></div>'
  + doc.slice(TALLY_AT + 'important stuff.</span></h2>'.length);

/* The two path cards. Same progressive enhancement as the tools. */
for (const [href, which] of [['/join?path=quick', 'quick'], ['/join?path=guided', 'guided']]) {
  const find = `<a href="${href}"`;
  if ((doc.split(find).length - 1) !== 1) throw new Error(`path card ${which}: expected exactly 1`);
  doc = doc.split(find).join(`${find} data-wpath="${which}"`);
}

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
${MODAL_CSS}
/* v5's component stylesheet, scoped to the dialog and the parked markup. */
${kitCss}
</style>
</head>
<body>

${body}
${KIT_MARKUP}
<script src="/js/tires.js?v=${STAMP}"></script>
<script src="/js/tire-kit.js?v=${STAMP}"></script>
</body>
</html>
`;

writeFileSync(join(OUT, 'index.html'), page);
writeFileSync(join(OUT, 'js', 'tire-kit.js'), KIT_JS_HEADER + kitJs + '\n');

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
