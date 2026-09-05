#!/usr/bin/env node
/* Proves the September 2026 redirect map, two ways.
 *
 *   node scripts/check-redirect-map.mjs          # static: every legacy URL resolves through home/vercel.json
 *   node scripts/check-redirect-map.mjs --live   # after cutover: each www URL lands 200 on the new host in <= 2 hops
 *
 * Static mode walks the rules the way Vercel does, first match wins, for every
 * URL in the saved sitemap plus the unlisted set, and asserts each lands on
 * exactly the same path at https://internet.whollar.ca, or on its documented
 * retarget. It also asserts the umbrella's own paths are NOT redirected: a rule
 * that swallowed /join would be a page that vanished with a green build.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NET = 'https://internet.whollar.ca';
const cfg = JSON.parse(readFileSync(join(ROOT, 'home', 'vercel.json'), 'utf8'));
const LIVE = process.argv.includes('--live');

/* The sitemap as it was the day the map was cut, read from the permanent doc so
   the two cannot drift apart silently. */
const doc = readFileSync(join(ROOT, 'docs', 'REDIRECT_MAP_2026-09.md'), 'utf8');
const section = (title) => (doc.split(`## ${title}`)[1] || '').split(/\n## /)[0];
const rows = (s) => [...s.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| (\d+) \|/gm)].map(m => [m[1], m[2], Number(m[3])]);
const blogSlugs = [...section('Blog slugs covered by the pattern rule').matchAll(/^- `(\/blog\/[^`]+)`$/gm)].map(m => m[1]);
const kept = [...section('Kept on the umbrella').matchAll(/^- `(\/[^`]*)`$/gm)].map(m => m[1]);
/* A literal row is tested as written. A pattern row is tested through a sample:
   :path* becomes a two-segment sample so the destination is proven to carry
   it through. A regex-group source (the old provider rule) is tested with one
   concrete path from each branch. */
const literals = rows(section('Literal rules'));
const patterns = rows(section('Pattern rules'));
const SAMPLE = 'sample/deep';
const cases = [];
for (const [src, dst, code] of literals) {
  if (src.includes('(')) {
    for (const ex of ['/provider', '/provider-dashboard', '/provider.html']) cases.push([ex, dst, code, src]);
  } else cases.push([src, dst, code, src]);
}
for (const [src, dst, code] of patterns) {
  const path = src.replace(/:[A-Za-z]+\*/, SAMPLE).replace(/:[A-Za-z]+/, 'tok');
  const want = dst.replace(/:[A-Za-z]+\*/, SAMPLE).replace(/:[A-Za-z]+/, 'tok');
  cases.push([path, want, code, src]);
}

/* Vercel's path-to-regexp subset this config uses: literals, :name, :name*,
   and plain regex groups. Only an unescaped dot needs escaping; the rest is
   already regex. */
function toRegex(src) {
  const re = src.replace(/(?<!\\)\./g, '\\.').replace(/:([A-Za-z]+)\*/g, '(?<$1>.*)').replace(/:([A-Za-z]+)/g, '(?<$1>[^/]+)');
  return new RegExp('^' + re + '$');
}
function resolve(path, host = 'www.whollar.ca') {
  for (const r of cfg.redirects) {
    if (r.has && !r.has.every(h => h.type === 'host' && h.value === host)) continue;
    const m = toRegex(r.source).exec(path);
    if (!m) continue;
    let dest = r.destination;
    for (const [k, v] of Object.entries(m.groups || {})) dest = dest.replace(`:${k}*`, v).replace(`:${k}`, v);
    return { dest, code: r.statusCode || (r.permanent ? 308 : 307) };
  }
  return null;
}

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('  FAIL ' + msg); } };

for (const [path, want, code, rule] of cases) {
  const r = resolve(path);
  ok(r && r.dest === want && r.code === code, `${path} (rule ${rule}) -> expected ${want} (${code}), got ${r ? r.dest + ' (' + r.code + ')' : 'no rule'}`);
}
for (const slug of blogSlugs) {
  const r = resolve(slug);
  ok(r && r.dest === NET + slug && r.code === 301, `${slug} -> expected ${NET + slug}, got ${r ? r.dest : 'no rule'}`);
}
ok(resolve('/blog/')?.dest === NET + '/blog/', '/blog/ lands on the blog home, not a slug');
for (const p of kept) ok(resolve(p) === null, `${p} is umbrella-owned and must not redirect (got ${resolve(p)?.dest})`);
ok(resolve('/join', 'whollar.ca')?.dest === 'https://www.whollar.ca/join', 'the apex form of an umbrella path goes to www, one hop');
ok(resolve('/blog/x', 'whollar.ca')?.dest === 'https://www.whollar.ca/blog/x', 'the apex form of a legacy path goes to www first (hop 1 of 2)');
ok(!cfg.redirects.some(r => r.source === '/hooks/zeptomail'), 'the webhook is not redirected');
ok(cfg.rewrites.some(r => r.source === '/hooks/zeptomail'), 'the webhook is rewritten to the function');
ok(cfg.redirects.every(r => [301, 308].includes(r.statusCode) || r.source === '/disclosures'), 'every rule is permanent except the one that never was');

console.log(`${checks - fails} of ${checks} static checks pass`);

if (LIVE) {
  console.log('\nlive: following each www URL, two hops maximum');
  for (const [src] of literals.filter(([s]) => !s.includes('(')).concat(blogSlugs.map(s => [s]))) {
    const url = 'https://www.whollar.ca' + src;
    let cur = url, hops = 0, status = 0;
    while (hops <= 2) {
      const res = await fetch(cur, { redirect: 'manual' });
      status = res.status;
      if (status >= 300 && status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location'), cur).href; hops++; continue; }
      break;
    }
    const good = status === 200 && hops <= 2 && cur.startsWith(NET);
    console.log(`  ${good ? 'ok  ' : 'FAIL'} ${src}  ->  ${cur}  (${status}, ${hops} hop${hops === 1 ? '' : 's'})`);
    if (!good) fails++;
  }
}
process.exit(fails ? 1 : 0);
