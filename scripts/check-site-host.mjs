#!/usr/bin/env node
/* The internet site lives at https://internet.whollar.ca and nowhere else.
 *
 *   node scripts/check-site-host.mjs          # CI: fail if any deployable file still names the old host
 *   node scripts/check-site-host.mjs --fix    # the September 2026 sweep: rewrite them
 *
 * "Deployable" is computed, not listed: every .html, .xml, .txt, .json, .js
 * and .css under the repo that .vercelignore does not exclude, minus the
 * directories that belong to other projects or are never served (home/ is the
 * umbrella, catalyst-backend/ is the backend, docs/ is prose). The old host in
 * any of those is a canonical, an og:url, a JSON-LD @id or a sitemap entry
 * that tells a crawler the page lives where it no longer does.
 *
 * MobileVersion/ is generated from the desktop pages; --fix skips it and the
 * generator is run instead, so the mobile drift gate stays meaningful.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = process.argv.includes('--fix');
const OLD = /https:\/\/(www\.)?whollar\.ca(?=[/"'\s<)]|$)/g;
const NEW = 'https://internet.whollar.ca';
const EXT = new Set(['.html', '.xml', '.txt', '.json', '.js', '.css']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'home', 'catalyst-backend', 'docs', 'scripts', 'admin-console', '.vercel', '.claude']);
const GENERATED = ['MobileVersion' + sep];

/* .vercelignore, read as prefixes and globs the way Vercel does, minus comments. */
const ignore = readFileSync(join(ROOT, '.vercelignore'), 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
function ignored(rel) {
  return ignore.some(p => {
    if (p.startsWith('*.')) return rel.endsWith(p.slice(1));
    const clean = p.replace(/\/$/, '');
    return rel === clean || rel.startsWith(clean + '/') || rel.startsWith(clean + sep);
  });
}
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(ROOT, abs);
    if (SKIP_DIRS.has(name) && dir === ROOT) continue;
    const st = statSync(abs);
    if (st.isDirectory()) { if (!ignored(rel)) yield* walk(abs); continue; }
    if (!EXT.has(name.slice(name.lastIndexOf('.'))) || ignored(rel)) continue;
    /* The site config names www on purpose: its redirects send the umbrella's
       own paths (/join and the welcome screens) to the umbrella. */
    if (rel === 'vercel.json') continue;
    yield rel;
  }
}

let hits = 0, files = 0, fixed = 0, skippedGen = 0;
const byFile = [];
for (const rel of walk(ROOT)) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const n = (text.match(OLD) || []).length;
  if (!n) continue;
  hits += n; files++;
  if (FIX) {
    if (GENERATED.some(g => rel.startsWith(g))) { skippedGen++; byFile.push([rel, n, 'generated, regenerate instead']); continue; }
    writeFileSync(join(ROOT, rel), text.replace(OLD, NEW));
    fixed++; byFile.push([rel, n, 'rewritten']);
  } else byFile.push([rel, n, '']);
}
for (const [rel, n, note] of byFile.sort()) console.log(`  ${String(n).padStart(3)}  ${rel}${note ? '   (' + note + ')' : ''}`);
if (FIX) {
  console.log(`\nrewrote ${fixed} file(s); ${skippedGen} generated file(s) left for the generator`);
} else if (hits) {
  console.log(`\n${hits} reference(s) to the old host in ${files} deployable file(s). Run with --fix, or regenerate.`);
  process.exit(1);
} else {
  console.log('ok      no deployable file names the old host');
}
