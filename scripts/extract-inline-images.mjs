/* One-time (repeatable) de-bundling pass for the self-unpacking bundle pages.
 *
 * index.html and partners.html inline ~200 images as base64 data: URIs
 * directly inside the __bundler/template JSON string (see bundle-edit.mjs for
 * why that string can't be hand-edited as plain HTML). That means every
 * visit re-downloads every image as part of one giant, uncacheable HTML
 * response, base64 costs +33% over raw bytes, nothing can load in
 * parallel, and the browser can't reuse a prior visit's images because the
 * HTML document itself is served `must-revalidate`.
 *
 * This script pulls each inline data: URI out to a real file under
 * images/<page>-assets/<sha1>.<ext> (content-hashed, so duplicate blobs
 * collapse to one file for free) and rewrites the template to reference the
 * file by path instead. The loader never treats these strings specially
 * (only ext_resources UUIDs get blob-swapped, per its DOMContentLoaded
 * handler) so a plain same-origin path works exactly like the data: URI did,
 * just cacheable and fetched off the main HTML connection.
 *
 *   node scripts/extract-inline-images.mjs [--check] index.html partners.html
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { readBundle, writeBundle } from './bundle-edit.mjs';

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg',
  'image/webp': 'webp', 'image/gif': 'gif', 'application/json': 'json'
};

const DATA_URI_RE = /data:([a-zA-Z0-9/+.\-]+);base64,([A-Za-z0-9+/=]+)/g;

const args = process.argv.slice(2);
const check = args.includes('--check');
const pages = args.filter(a => a !== '--check');
if (pages.length === 0) pages.push('index.html', 'partners.html');

let anyChanged = false;

for (const page of pages) {
  const bundle = readBundle(page);
  const inner = bundle.inner;
  const slug = basename(page, '.html');
  const assetDir = join('images', `${slug}-assets`);

  const seen = new Map(); // data-uri -> new path
  let bytesBefore = 0, bytesAfter = 0, written = 0, occurrences = 0;

  let next = inner;
  const matches = [...inner.matchAll(DATA_URI_RE)];
  for (const m of matches) {
    const [full, mime, b64] = m;
    if (seen.has(full)) { occurrences++; continue; }
    const ext = EXT[mime];
    if (!ext) { console.error(`  SKIP  ${page}: unknown mime ${mime}, leaving inline`); continue; }

    const bytes = Buffer.from(b64, 'base64');
    const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 12);
    const relPath = `/${assetDir}/${hash}.${ext}`;
    const absPath = join(assetDir, `${hash}.${ext}`);

    const isNew = !existsSync(absPath);
    if (!check && isNew) {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, bytes);
    }
    if (isNew) written++;
    seen.set(full, relPath);
    bytesBefore += full.length;
    bytesAfter += relPath.length;
    occurrences++;
  }

  if (seen.size === 0) {
    console.log(`${page}: no inline data: URIs found, nothing to do`);
    continue;
  }

  for (const [full, relPath] of seen) {
    next = next.split(full).join(relPath);
  }

  const savedChars = (inner.length - next.length);
  console.log(`${page}: ${seen.size} unique assets (${occurrences} references, ${occurrences - seen.size} duplicates collapsed), ${written} files written to ${assetDir}/`);
  console.log(`  template string: ${inner.length.toLocaleString()} -> ${next.length.toLocaleString()} chars (-${savedChars.toLocaleString()})`);

  if (!check) {
    writeBundle(page, bundle, next);
    anyChanged = true;
  }
}

if (check && anyChanged === false) {
  console.log('\n(--check: no files written)');
}
