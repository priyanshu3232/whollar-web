#!/usr/bin/env node
/* One-time conversion of the four self-unpacking bundle pages into plain
 * static HTML, so crawlers that never execute JS (Bingbot, GPTBot,
 * PerplexityBot, ClaudeBot, link unfurlers) see the real page instead of
 * "Loading…".
 *
 * The bundle format (see bundle-edit.mjs): the finished document sits
 * JSON-encoded in <script type="__bundler/template">, binary assets sit
 * base64-encoded in <script type="__bundler/manifest"> keyed by UUID, and a
 * loader swaps the template in on DOMContentLoaded after rewriting UUID
 * references to blob: URLs and injecting window.__resources = {id: blobUrl}.
 *
 * This script performs the loader's work at build time instead:
 *   - live manifest assets (referenced by UUID in the template) are decoded
 *     and written to real files; UUID references become root-relative paths.
 *     Assets byte-identical to a file already in the repo (js/lottie.min.js,
 *     fonts/*) reuse that file instead of duplicating it.
 *   - live ext_resources entries become a static window.__resources map of
 *     file paths, injected where the loader used to inject blob URLs. Every
 *     consumer does `(window.__resources && window.__resources.id) || fallback`,
 *     so the contract is unchanged.
 *   - manifest assets nothing references (React, ReactDOM, Babel, two pin
 *     icons and several images from an earlier iteration) are dropped.
 *   - the outer wrapper's head scripts (/js/device-router.js,
 *     /js/whollar-core.js) move into the document head, after the viewport
 *     meta: device-router reads the viewport width at parse time and misroutes
 *     without that ordering.
 *   - title / canonical / favicon carried by only one of the two heads are
 *     merged so nothing crawler-visible is lost.
 *
 *   node scripts/debundle.mjs
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle } from './bundle-edit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = [
  {
    file: 'index.html',
    assetDir: 'images/index-assets',
    canonical: 'https://www.whollar.ca/'
  },
  {
    file: 'partners.html',
    assetDir: 'images/partners-assets',
    appJs: 'js/partners-page.js',
    canonical: 'https://www.whollar.ca/partners'
  },
  {
    file: 'MobileVersion/consumer-mobile.html',
    assetDir: 'images/index-assets',
    canonical: 'https://www.whollar.ca/'
  },
  {
    file: 'MobileVersion/provider-mobile.html',
    assetDir: 'images/partners-assets',
    appJs: 'js/provider-mobile-page.js',
    canonical: 'https://www.whollar.ca/partners'
  }
];

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg',
  'application/json': 'json', 'font/woff2': 'woff2',
  'text/javascript': 'js', 'application/javascript': 'js'
};

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

/* Files already in the repo that embedded assets may duplicate. */
const KNOWN = new Map();
KNOWN.set(sha1(readFileSync(join(ROOT, 'js/lottie.min.js'))), '/js/lottie.min.js');
for (const f of readdirSync(join(ROOT, 'fonts'))) {
  KNOWN.set(sha1(readFileSync(join(ROOT, 'fonts', f))), '/fonts/' + f);
}

function decode(entry) {
  const raw = Buffer.from(entry.data, 'base64');
  return entry.compressed ? gunzipSync(raw) : raw;
}

/* Name an extracted font from the @font-face block that references it:
   scan back from the url() to the nearest font-family / font-weight. */
function fontName(template, uuid, hash) {
  const i = template.indexOf(uuid);
  const back = template.slice(Math.max(0, i - 600), i);
  const fam = back.match(/font-family:\s*['"]?([\w -]+)['"]?/g);
  const wgt = back.match(/font-weight:\s*(\d+)/g);
  const famName = fam ? fam[fam.length - 1].replace(/font-family:\s*/, '').replace(/['"]/g, '').trim().toLowerCase().replace(/\s+/g, '-') : 'font';
  const weight = wgt ? wgt[wgt.length - 1].replace(/\D/g, '') : '400';
  return `fonts/${famName}-${weight}-${hash.slice(0, 6)}.woff2`;
}

function extractTag(html, re) {
  const m = html.match(re);
  return m ? m[0] : null;
}

let failures = 0;

for (const page of PAGES) {
  const path = join(ROOT, page.file);
  const bundle = readBundle(path);
  let template = bundle.inner;
  const outer = bundle.outer;

  const mm = outer.match(/<script type="__bundler\/manifest">([\s\S]*?)<\/script>/);
  const em = outer.match(/<script type="__bundler\/ext_resources">([\s\S]*?)<\/script>/);
  const manifest = mm ? JSON.parse(mm[1]) : {};
  const extResources = em ? JSON.parse(em[1]) : [];

  console.log(`\n${page.file}`);
  const writeAsset = (bytes, destRel) => {
    const dest = join(ROOT, destRel);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) writeFileSync(dest, bytes);
    else if (sha1(readFileSync(dest)) !== sha1(bytes)) {
      throw new Error(`hash collision writing ${destRel}`);
    }
    return '/' + destRel;
  };

  const pathFor = (uuid, entry, bytes) => {
    const h = sha1(bytes);
    if (KNOWN.has(h)) return KNOWN.get(h);
    let rel;
    if (entry.mime === 'font/woff2') rel = fontName(template, uuid, h);
    else if (EXT_BY_MIME[entry.mime] === 'js') {
      if (!page.appJs) throw new Error(`${page.file}: unexpected JS asset ${uuid}`);
      rel = page.appJs;
    } else rel = `${page.assetDir}/${h.slice(0, 12)}.${EXT_BY_MIME[entry.mime] || 'bin'}`;
    const p = writeAsset(bytes, rel);
    KNOWN.set(h, p);
    return p;
  };

  /* 1. UUID-referenced manifest assets -> files. */
  let live = 0, dead = 0;
  for (const [uuid, entry] of Object.entries(manifest)) {
    if (!template.includes(uuid)) { dead++; continue; }
    const bytes = decode(entry);
    const p = pathFor(uuid, entry, bytes);
    template = template.split(uuid).join(p);
    live++;
    console.log(`  asset ${uuid.slice(0, 8)} (${entry.mime}) -> ${p}`);
  }

  /* 2. ext_resources consumed via window.__resources -> static map. */
  const resourceMap = {};
  for (const entry of extResources) {
    if (!template.includes(entry.id)) { dead++; continue; }
    const bytes = decode(manifest[entry.uuid]);
    resourceMap[entry.id] = pathFor(entry.uuid, manifest[entry.uuid], bytes);
    console.log(`  resource "${entry.id}" -> ${resourceMap[entry.id]}`);
  }
  if (Object.keys(resourceMap).length) {
    const headOpen = template.match(/<head[^>]*>/i);
    const inj = `\n<script>window.__resources = ${JSON.stringify(resourceMap)};</script>`;
    const i = headOpen.index + headOpen[0].length;
    template = template.slice(0, i) + inj + template.slice(i);
  }
  console.log(`  live assets: ${live}, dropped (unreferenced): ${dead}`);

  /* 3. Head merge. Device router MUST come after the viewport meta. */
  const viewport = template.match(/<meta name="viewport"[^>]*>/);
  if (!viewport) throw new Error(`${page.file}: no viewport meta in template`);
  /* Test the head only: the body contains SVG <title> elements. */
  const tHead = template.slice(0, template.indexOf('<body'));
  const additions = [];
  if (!/rel="icon"/.test(tHead)) {
    additions.push('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  }
  if (!/<title[\s>]/.test(tHead)) {
    const t = extractTag(outer.slice(0, outer.indexOf('<body')), /<title[^>]*>[\s\S]*?<\/title>/);
    if (t) additions.push(t);
  }
  if (!/rel="canonical"/.test(tHead)) {
    additions.push(`<link rel="canonical" href="${page.canonical}">`);
  }
  additions.push('<script src="/js/device-router.js"></script>');
  additions.push('<script src="/js/whollar-core.js"></script>');
  const vi = viewport.index + viewport[0].length;
  template = template.slice(0, vi) + '\n' + additions.join('\n') + template.slice(vi);

  /* 4. Sanity: nothing bundle-shaped may survive. */
  const leftover = template.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  if (leftover) { console.error(`  FAIL leftover uuid ${leftover[0]}`); failures++; continue; }
  if (template.includes('__bundler')) { console.error('  FAIL __bundler survives'); failures++; continue; }

  /* 5. Every root-relative subresource the page references must exist. */
  const refs = new Set();
  for (const m of template.matchAll(/(?:src|href)="(\/(?:js|images|fonts)\/[^"]+)"/g)) refs.add(m[1]);
  for (const m of template.matchAll(/url\((['"]?)(\/(?:js|images|fonts)\/[^)'"]+)\1\)/g)) refs.add(m[2]);
  for (const r of refs) {
    if (!existsSync(join(ROOT, r.split('#')[0].split('?')[0]))) {
      console.error(`  FAIL missing subresource ${r}`); failures++;
    }
  }

  writeFileSync(path, template);
  console.log(`  wrote ${page.file} (${(template.length / 1024).toFixed(0)} KB, was ${(outer.length / 1024).toFixed(0)} KB)`);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll bundles converted.');
