/* Read/write helpers for self-unpacking bundle pages.
 *
 * HISTORICAL: index.html, partners.html and their mobile builds used to ship
 * as bundles, where the real document lives as a JSON-encoded string inside
 * <script type="__bundler/template">…</script> and a loader in the outer head
 * swaps it in on DOMContentLoaded. scripts/debundle.mjs converted all four to
 * plain static HTML so crawlers see content without executing JS. These
 * helpers stay for that converter and for any future bundle drop.
 *
 * `<` must stay escaped as < on the way back in, otherwise a literal
 * </script> inside the payload would terminate the outer script tag early and
 * blank the page.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TAG = '<script type="__bundler/template">';

export function readBundle(path) {
  const outer = readFileSync(path, 'utf8');
  const start = outer.indexOf(TAG);
  if (start < 0) throw new Error(`${path}: no bundler template found`);
  const bodyStart = start + TAG.length;
  const end = outer.indexOf('</script>', bodyStart);
  if (end < 0) throw new Error(`${path}: unterminated bundler template`);
  return {
    outer,
    prefix: outer.slice(0, bodyStart),
    suffix: outer.slice(end),
    inner: JSON.parse(outer.slice(bodyStart, end).trim())
  };
}

export function writeBundle(path, bundle, nextInner) {
  const encoded = JSON.stringify(nextInner).replace(/</g, '\\u003c');
  writeFileSync(path, bundle.prefix + encoded + bundle.suffix);
}

/* Apply a list of [description, find, replace] edits, failing loudly on a miss
   or an ambiguous match rather than silently doing nothing. */
export function applyEdits(text, edits, label) {
  let out = text, failed = 0;
  for (const [desc, find, repl] of edits) {
    const n = out.split(find).length - 1;
    if (n === 0) { console.error(`  MISS  ${label}: ${desc}`); failed++; continue; }
    if (n > 1) { console.error(`  AMBIG ${label}: ${desc} (${n} matches)`); failed++; continue; }
    out = out.replace(find, repl);
    console.log(`  ok    ${label}: ${desc}`);
  }
  return { text: out, failed };
}
