#!/usr/bin/env node
/* The gate on every email Whollar sends.
 *
 *   node scripts/check-notify-copy.mjs          report
 *   node scripts/check-notify-copy.mjs --check  fail on any hit (CI)
 *
 * WHY THIS RENDERS RATHER THAN GREPS. check-terms.mjs and check-console-copy.mjs
 * both read files and look for words, which is right for a page whose copy is
 * a string literal in the source. An email is not that: its subject is built
 * from a region name, its footer is assembled at send time, its plain text is
 * rendered from a block list, and its compliance obligations are properties of
 * the finished message rather than of any line in the file. So this renders
 * every template against every fixture, through the real layout, and checks
 * what would actually arrive.
 *
 * WHAT IT ENFORCES, and why each one is here rather than in a review comment:
 *
 *   no em or en dash          the house rule, and the one that drifts fastest
 *   vocabulary                partner and household, never client, lead, ISP,
 *                             group buy; member-facing never says auction
 *   subject under 60          Gmail truncates past that on a phone
 *   preheader, and not the    without one the client takes the first words of
 *   subject again             the body, which for a card layout is alt text
 *   plain text, complete      some clients prefer it, and a code that exists
 *                             only inside a <table> is a code some people
 *                             cannot use
 *   sender identification     CASL exempts transactional mail from the
 *   and a postal address      opt-out and from nothing else
 *   unsubscribe on cem        and never on transactional, where offering one
 *                             would promise something the system will not do
 *   https only, allowlisted   a plaintext link in an email is a downgrade
 *                             attack somebody else gets to run
 *   alt on every image        Gmail and Outlook block remote images by default
 *   under 100 KB              Gmail clips past roughly that and hides the
 *                             footer, which is the compliance half
 *   required keys fail        a template that renders "decide by " with
 *   closed                    nothing after it must fail, not send
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const require_ = createRequire(import.meta.url);

const NOTIFY = join(ROOT, 'catalyst-backend/functions/auth/src/lib/notify');
const registry = require_(join(NOTIFY, 'registry.js'));
const layout = require_(join(NOTIFY, 'layout.js'));

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

const BANNED = [
  [/[—–]/g, 'em or en dash'],
  [/\bcustomers?\b/gi, 'customer'],
  [/\bclients?\b/gi, 'client'],
  [/\blead generators?\b|\blead delivery\b|\bleads?\b(?!ing)/gi, 'lead'],
  [/\bISPs?\b/g, 'ISP'],
  [/\bgroup[ -]buys?\b/gi, 'group buy'],
  [/\bvendors?\b/gi, 'vendor'],
  [/\bprospects?\b/gi, 'prospect'],
  [/\bsubscribers?\b/gi, 'subscriber'],
  [/\bgenuinely\b/gi, 'genuinely'],
];

/** Member-facing copy additionally never says this. */
const MEMBER_BANNED = [[/\bauctions?\b/gi, 'auction']];

const LINK_HOSTS = new Set([
  'www.whollar.ca', 'whollar.ca', 'www.whollar.com', 'whollar.com',
]);

const MAX_SUBJECT = 60;
const MAX_BYTES = 100 * 1024;

/* The footer values the gate renders with. Real ones come from config; these
   exist so the gate can prove the footer is assembled at all. */
const FOOTER = {
  legalName: 'Whollar',
  postalAddress: '1 Example Street, Toronto ON M5V 0A1',
  contactEmail: 'info@whollar.com',
  preferencesUrl: 'https://www.whollar.ca/dashboard#settings',
};

let problems = 0;
const hit = (where, msg) => { problems += 1; console.error(`  ${where}  ${msg}`); };

/* ------------------------------------------------------------------ *
 * Source files: the plain grep, for comments and anything not rendered
 * ------------------------------------------------------------------ */

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...sourceFiles(p));
    else if (name.name.endsWith('.js')) out.push(p);
  }
  return out;
}

for (const file of sourceFiles(NOTIFY)) {
  const rel = file.slice(ROOT.length + 1);
  const src = readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    if (/[—–]/.test(line)) hit(`${rel}:${i + 1}`, 'em or en dash');
  });
}

/* ------------------------------------------------------------------ *
 * Rendered messages
 * ------------------------------------------------------------------ */

function renderOne(entry, ctx) {
  const audience = entry.audience === 'auto' ? 'member' : entry.audience;
  const out = registry.render(entry, ctx, { locale: 'en', timezone: 'America/Toronto' });
  return layout.assemble({
    audience,
    subject: out.subject,
    preheader: out.preheader,
    greeting: out.greeting,
    blocks: out.blocks,
    footer: layout.footerBlocks({
      ...FOOTER,
      whyLine: 'You are getting this because you have a Whollar account.',
      unsubscribeUrl: entry.casl === 'cem' ? 'https://www.whollar.ca/u/ABCD1234EFGH5678' : null,
    }),
  });
}

let rendered = 0;

for (const entry of registry.all()) {
  const fixtures = registry.fixturesOf(entry);
  const memberFacing = entry.audience === 'member' || entry.audience === 'auto';

  /* The contract fails closed, and that is a claim worth testing rather than
     trusting: drop one required key and the render must be refused. */
  if (entry.required.length) {
    const short = { ...fixtures[0] };
    delete short[entry.required[0]];
    if (!registry.missing(entry, short).includes(entry.required[0])) {
      hit(entry.key, `required key ${entry.required[0]} is declared but not detected as missing`);
    }
  }

  for (const [n, ctx] of fixtures.entries()) {
    const where = fixtures.length > 1 ? `${entry.key}[${n}]` : entry.key;
    let m;
    try {
      m = renderOne(entry, ctx);
    } catch (err) {
      hit(where, `render threw: ${String(err && err.message)}`);
      continue;
    }
    rendered += 1;

    const surfaces = [['subject', m.subject], ['preheader', m.preheader || ''],
      ['text', m.text], ['html', m.html]];

    for (const [name, body] of surfaces) {
      for (const [re, label] of BANNED) {
        const found = String(body).match(re);
        if (found) hit(where, `${name} contains ${label} ("${found[0]}")`);
      }
      if (memberFacing) {
        for (const [re, label] of MEMBER_BANNED) {
          if (re.test(String(body))) hit(where, `${name} contains ${label}, and this is member facing`);
        }
      }
    }

    if (!m.subject) hit(where, 'no subject');
    if (m.subject.length > MAX_SUBJECT) {
      hit(where, `subject is ${m.subject.length} characters, over ${MAX_SUBJECT}`);
    }
    if (!m.preheader) hit(where, 'no preheader');
    else if (m.preheader.trim() === m.subject.trim()) hit(where, 'preheader repeats the subject');

    if (!m.text || m.text.length < 40) hit(where, 'plain text is missing or too short to read alone');
    if (/<[a-z][\s\S]*>/i.test(m.text)) hit(where, 'plain text contains markup');

    /* CASL. Identification and the address on every message; the unsubscribe
       only where an opt-out actually applies. */
    if (!m.text.includes(FOOTER.legalName)) hit(where, 'footer does not identify the sender');
    if (!m.text.includes(FOOTER.postalAddress)) hit(where, 'footer carries no postal address');
    if (!m.text.includes('Notification settings')) hit(where, 'no notification settings link');
    const hasUnsub = /\/u\//.test(m.text);
    if (entry.casl === 'cem' && !hasUnsub) hit(where, 'a commercial message with no unsubscribe link');
    if (entry.casl === 'transactional' && hasUnsub) {
      hit(where, 'a transactional message offering an unsubscribe it will not honour');
    }

    for (const url of String(m.html).match(/https?:\/\/[^"'\s<>)]+/g) || []) {
      if (url.startsWith('http://')) { hit(where, `plaintext link ${url}`); continue; }
      let host;
      try { host = new URL(url).hostname; } catch { hit(where, `unparseable link ${url}`); continue; }
      if (!LINK_HOSTS.has(host)) hit(where, `link to a host that is not allowlisted: ${host}`);
    }

    for (const img of String(m.html).match(/<img\b[^>]*>/gi) || []) {
      if (!/\balt\s*=\s*"[^"]+"/i.test(img)) hit(where, 'an image with no alt text');
    }

    const bytes = Buffer.byteLength(m.html, 'utf8');
    if (bytes > MAX_BYTES) hit(where, `${Math.round(bytes / 1024)} KB, over the ${MAX_BYTES / 1024} KB clipping limit`);
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

if (problems) {
  console.error(`\ncheck-notify-copy: ${problems} problem(s) across ${rendered} rendered message(s)`);
  process.exit(check ? 1 : 0);
}
console.log(`check-notify-copy: OK, ${registry.all().length} template(s), ${rendered} rendered message(s) clean`);
