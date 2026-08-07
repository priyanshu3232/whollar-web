#!/usr/bin/env node
/* Build js/whollar-base-pricing.js from "PlanSavvy-Pricing.xlsx".
 *
 *   node scripts/build-base-pricing.mjs
 *   node scripts/build-base-pricing.mjs --check   # CI: fail if the output is stale
 *
 * Reads the "Internet Plans" sheet (the twelve lowest-priced advertised
 * plans per province, source: plansavvy.ai) and emits a floor-price
 * reference: the cheapest going rate a household's area actually offers.
 *
 * This is a DIFFERENT reference from js/whollar-benchmarks.js (built by
 * build-benchmarks.mjs from "Whollar Pricing Model.xlsx"). That file answers
 * "what does the market typically charge for this exact tier/tech/provider"
 * and drives the weak/fair/strong verdict. This one answers "what is the
 * cheapest advertised floor in this household's area" and drives the
 * savings-over-term projection — see WHOLLAR.basePriceFor() in
 * whollar-core.js. The two are kept separate on purpose: the verdict
 * (category) logic is unchanged, only the floor-price number is new.
 *
 * Sheet has no provider/tech granularity worth keying on (17 providers
 * across just 156 rows, most independents), so the cascade here has two
 * levels only:
 *   province + speed tier   → mean of that province's plans at that tier
 *   province                → mean of every plan listed for that province
 *   speed tier (national)   → mean of that tier pooled across all provinces
 *   national                → mean of every plan in the sheet
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const XLSX = join(ROOT, 'PlanSavvy-Pricing.xlsx');
const OUT = join(ROOT, 'js/whollar-base-pricing.js');
const CHECK = process.argv.includes('--check');
const SHEET = 'Internet Plans';

/* ---------- minimal xlsx reader (no dependency, mirrors build-benchmarks.mjs) ---------- */

function unzip(file, member) {
  return execFileSync('unzip', ['-p', file, member], { maxBuffer: 1 << 28 }).toString('utf8');
}
const decode = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');

/* PlanSavvy-Pricing.xlsx has no xl/sharedStrings.xml at all — every string is
   inline (t="inlineStr"). Whollar Pricing Model.xlsx does use shared strings,
   which is why build-benchmarks.mjs assumes the member exists; this reader
   must not, so a missing table of shared strings is simply an empty one. */
function sharedStrings(file) {
  let xml;
  try { xml = unzip(file, 'xl/sharedStrings.xml'); } catch (e) { return []; }
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
    decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
}

function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(file, member, strings) {
  const xml = unzip(file, member);
  const out = [];
  for (const rowM of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of rowM[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const idx = colIndex(c[1]);
      const isShared = /t="s"/.test(c[2]);
      const inline = c[3].match(/<is>([\s\S]*?)<\/is>/);
      let val = '';
      if (inline) val = decode([...inline[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));
      else {
        const v = c[3].match(/<v>([\s\S]*?)<\/v>/);
        if (v) val = isShared ? (strings[+v[1]] ?? '') : decode(v[1]);
      }
      cells[idx] = val;
    }
    if (cells.length) out.push(cells);
  }
  return out;
}

/* Locate the "Internet Plans" sheetN.xml via workbook.xml + its rels, rather
   than assuming sheet order — a spreadsheet re-save can reorder tabs without
   renumbering files. */
function sheetMember(file, name) {
  const wb = unzip(file, 'xl/workbook.xml');
  const m = wb.match(new RegExp(`<sheet [^>]*name="${name}"[^>]*r:id="(rId\\d+)"`));
  if (!m) throw new Error(`sheet "${name}" not found in workbook.xml`);
  const rels = unzip(file, 'xl/_rels/workbook.xml.rels');
  const r = rels.match(new RegExp(`Target="/?(xl/worksheets/[^"]+)"[^>]*Id="${m[1]}"|Id="${m[1]}"[^>]*Target="/?(xl/worksheets/[^"]+)"`));
  if (!r) throw new Error(`relationship ${m[1]} not found`);
  return r[1] || r[2];
}

/* ---------- mappings ---------- */

const PROVINCE_CODE = {
  'British Columbia': 'BC', 'Alberta': 'AB', 'Saskatchewan': 'SK', 'Manitoba': 'MB',
  'Ontario': 'ON', 'Quebec': 'QC', 'New Brunswick': 'NB', 'Nova Scotia': 'NS',
  'Prince Edward Island': 'PE', 'Newfoundland and Labrador': 'NL',
  'Northwest Territories': 'NT', 'Yukon': 'YT', 'Nunavut': 'NU'
};

/* Same eight tiers and geometric-mean band edges as build-benchmarks.mjs /
   W.SPEED_TIERS — the two datasets must bucket speed identically or a
   household could see a different tier win the verdict than the one its
   savings figure is computed against. */
const TIERS = [25, 50, 100, 150, 300, 500, 1000, 1500];
const EDGES = TIERS.slice(0, -1).map((t, i) => Math.sqrt(t * TIERS[i + 1]));
const tierFor = mbps => {
  for (let i = 0; i < EDGES.length; i++) if (mbps < EDGES[i]) return TIERS[i];
  return TIERS[TIERS.length - 1];
};

/* "30 Mbps" / "1 Gbps" / "1.0 Gbps" → a plain Mbps number. */
function parseDownload(s) {
  const m = String(s || '').trim().match(/^([\d.]+)\s*(Mbps|Gbps)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /gbps/i.test(m[2]) ? n * 1000 : n;
}

/* ---------- build ---------- */

const member = sheetMember(XLSX, SHEET);
const strings = sharedStrings(XLSX);
const rows = sheetRows(XLSX, member, strings);

const headerIdx = rows.findIndex(r => r[0] === 'Province' && r[2] === 'Provider');
if (headerIdx === -1) throw new Error(`"${SHEET}" header row (Province/Provider/…) not found`);
const header = rows[headerIdx];
const col = Object.fromEntries(header.map((h, i) => [h, i]));
for (const need of ['Province', 'Provider', 'Download', 'Price / mo']) {
  if (col[need] === undefined) throw new Error(`"${SHEET}" is missing column "${need}"`);
}

const byProvTier = new Map(), byProv = new Map(), byTier = new Map(), all = [];
const skipped = { unknownProvince: 0, badPrice: 0, badSpeed: 0 };
let used = 0;

for (const r of rows.slice(headerIdx + 1)) {
  const provinceName = (r[col.Province] || '').trim();
  if (!provinceName) continue;
  const pv = PROVINCE_CODE[provinceName];
  if (!pv) { skipped.unknownProvince++; continue; }

  const price = parseFloat(r[col['Price / mo']]);
  if (!Number.isFinite(price) || price <= 0) { skipped.badPrice++; continue; }

  const mbps = parseDownload(r[col.Download]);
  if (!mbps) { skipped.badSpeed++; continue; }
  const tier = tierFor(mbps);

  used++;
  const push = (map, key) => { if (!map.has(key)) map.set(key, []); map.get(key).push(price); };
  push(byProvTier, `${pv}|${tier}`);
  push(byProv, pv);
  push(byTier, String(tier));
  all.push(price);
}

const mean = prices => Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
const toTable = map => Object.fromEntries([...map].sort().map(([k, prices]) => [k, [mean(prices), prices.length]]));

const provinceTierTable = toTable(byProvTier);
const provinceTable = toTable(byProv);
const tierTable = toTable(byTier);
const nationalAgg = all.length ? [mean(all), all.length] : null;

/* Cheapest single advertised plan per province — not a mean of the twelve,
   the lowest one of them. Feeds the homepage "calculate my saving" widget,
   which has no speed/tech input to key a like-for-like comparison off: the
   most defensible number without one is the province's actual price floor,
   framed to the visitor as a maximum-possible saving (see the widget's own
   disclaimer), not a typical outcome. */
const min = prices => Math.round(Math.min(...prices) * 100) / 100;
const toMinTable = map => Object.fromEntries([...map].sort().map(([k, prices]) => [k, [min(prices), prices.length]]));
const provinceMinTable = toMinTable(byProv);
const nationalMinAgg = all.length ? [min(all), all.length] : null;

const stamp = new Date().toISOString().slice(0, 10);
const body = `/* GENERATED by scripts/build-base-pricing.mjs from "PlanSavvy-Pricing.xlsx".
 * Do NOT edit by hand. Re-run the script when the spreadsheet changes.
 *
 * Source: ${SHEET} sheet, ${rows.length - headerIdx - 1} advertised plans
 * (the cheapest twelve per province, source: plansavvy.ai).
 * Used: ${used}. Dropped: ${skipped.unknownProvince} unrecognised provinces,
 * ${skipped.badPrice} unusable prices, ${skipped.badSpeed} unusable speeds.
 * Built ${stamp}.
 *
 * This is the FLOOR reference consumed by WHOLLAR.basePriceFor() (see
 * whollar-core.js) for the "you could save" projection. It is deliberately
 * separate from W.BENCHMARKS (js/whollar-benchmarks.js), which still decides
 * the weak/fair/strong/cliff verdict — that logic is unchanged.
 *
 * Cascade, most to least specific:
 *   province + speedTier   BASE_BY_PROVINCE_TIER["<pv>|<tier>"]
 *   province                BASE_BY_PROVINCE["<pv>"]
 *   speedTier (national)    BASE_BY_TIER["<tier>"]
 *   national                BASE_NATIONAL
 * Values are [meanMonthlyPrice, sampleSize].
 *
 * BASE_MIN_BY_PROVINCE / BASE_MIN_NATIONAL are a separate, speed-blind pair:
 * the single CHEAPEST advertised plan (not a mean) per province / overall.
 * Values are [minMonthlyPrice, sampleSize].
 */
(function (root) {
  'use strict';
  var W = root.WHOLLAR || (root.WHOLLAR = {});

  W.BASE_META = {
    source: 'PlanSavvy-Pricing.xlsx (Internet Plans)',
    builtOn: ${JSON.stringify(stamp)},
    sourceRows: ${rows.length - headerIdx - 1},
    usedRows: ${used}
  };

  W.BASE_BY_PROVINCE_TIER = ${JSON.stringify(provinceTierTable)};
  W.BASE_BY_PROVINCE = ${JSON.stringify(provinceTable)};
  W.BASE_BY_TIER = ${JSON.stringify(tierTable)};
  W.BASE_NATIONAL = ${JSON.stringify(nationalAgg)};
  W.BASE_MIN_BY_PROVINCE = ${JSON.stringify(provinceMinTable)};
  W.BASE_MIN_NATIONAL = ${JSON.stringify(nationalMinAgg)};
})(typeof window !== 'undefined' ? window : globalThis);
`;

if (CHECK) {
  const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  const strip = s => (s || '').replace(/Built \d{4}-\d{2}-\d{2}\./, '').replace(/builtOn: "[^"]*"/, '');
  if (strip(prev) === strip(body)) { console.log(`ok      ${OUT.replace(ROOT + '/', '')}`); process.exit(0); }
  console.error(`STALE   js/whollar-base-pricing.js. Regenerate with: node scripts/build-base-pricing.mjs`);
  process.exit(1);
}

writeFileSync(OUT, body);
console.log(`written js/whollar-base-pricing.js`);
console.log(`  ${rows.length - headerIdx - 1} source rows -> ${used} used`);
console.log(`  ${Object.keys(provinceTierTable).length} province+tier keys, ${Object.keys(provinceTable).length} province keys, ${Object.keys(tierTable).length} tier keys`);
