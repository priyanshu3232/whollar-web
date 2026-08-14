#!/usr/bin/env node
/* Build js/whollar-signal-lookup.js from "Whollar Pricing Model.xlsx".
 *
 *   node scripts/build-signal-lookup.mjs
 *   node scripts/build-signal-lookup.mjs --check   # CI: fail if the output is stale
 *
 * Reads the "Internet Pricing" sheet (~6,800 advertised plans) and emits the
 * FSA-level, median-based reference the checkup's five-band signal card
 * scores against (WHOLLAR.signalBaseFor(), whollar-core.js). This is a
 * SEPARATE reference from js/whollar-benchmarks.js / js/whollar-base-
 * pricing.js: those are unchanged and still power W.benchmarkFor()/
 * W.p10For() for the homepage estimator.
 *
 * ------------------------------------------------------------------
 * WHY THIS DOESN'T PRODUCE A GENUINE THREE-TIER fsa/city/province CASCADE
 *
 * The sheet is keyed by CITY, not FSA: there is no row finer-grained than
 * a city. "FSA-level" data is therefore, definitionally, the SAME number as
 * the city it belongs to (via js/whollar-fsa-cities.js's FSA->city map),
 * just addressed by a different key. A "city" fallback tier below "fsa"
 * would only ever fire in a situation identical to the one "fsa" already
 * handles (both depend on resolving the same FSA->city join), so it can
 * never be reached as a genuinely DIFFERENT step. This build still emits
 * SIGNAL_BY_CITY (city is the sheet's native grain, and it costs nothing to
 * expose it under its own key), and WHOLLAR.signalBaseFor() still tries it
 * in the documented order, but expect confidence to only ever come back
 * as 'fsa' or 'province' in practice for this data source, not 'city'.
 * Flagging this now rather than pretending three tiers are equally live.
 * ------------------------------------------------------------------
 * DATA DECISIONS
 *
 * 1. Rows with monthly_price null or <= 0 are dropped (prepaid/lump-sum
 *    plans; their cost sits in upfront_payment).
 * 2. Satellite rows are dropped entirely, not just excluded from a pooled
 *    aggregate: Starlink prices on a different basis (see build-
 *    benchmarks.mjs for the same call on the older reference).
 * 3. Speeds are bucketed to the NEAREST of 12 tiers (25/50/75/100/150/300/
 *    500/750/1000/1500/3000/8000 Mbps): nearest by absolute distance, not
 *    by rounding down, so e.g. 60 Mbps buckets to 50 (|60-50|=10) not 75
 *    (|60-75|=15).
 * 4. A single 99th-percentile trim runs ONCE per (speedTier, connectionType)
 *    pair, nationally, before any geographic split, not re-computed per
 *    city/province/FSA (too few rows at that grain for a percentile to mean
 *    anything). The 'terrestrial' pool (cable+fibre combined) is built from
 *    rows that already passed this trim at their specific type; it is not
 *    trimmed a second time.
 * 5. City names are normalized (lowercased, trimmed, periods/apostrophes
 *    stripped, a trailing " <digits>" disambiguator dropped, e.g. this
 *    sheet's "Alberton 1" -> "alberton") before matching against GeoNames'
 *    city spellings in js/whollar-fsa-cities.js. Same normalization on both
 *    sides; a city that still doesn't match resolves no FSAs and just never
 *    appears in SIGNAL_BY_FSA (falls through to province at runtime).
 * 6. Minimum sample size is 5. A (geography, speedTier, connectionType)
 *    bucket under that count is omitted entirely, not shipped thin: the
 *    runtime cascade in WHOLLAR.signalBaseFor() walks up to the next,
 *    coarser key when a lookup misses, exactly the fallback this omission
 *    is designed to trigger.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const XLSX = join(ROOT, 'Whollar Pricing Model.xlsx');
const FSA_CITIES_FILE = join(ROOT, 'js/whollar-fsa-cities.js');
const OUT = join(ROOT, 'js/whollar-signal-lookup.js');
const COVERAGE_OUT = join(ROOT, 'js/whollar-signal-lookup.coverage.txt');
const CHECK = process.argv.includes('--check');
const MIN_SAMPLE = 5;
const SPEED_TIERS = [25, 50, 75, 100, 150, 300, 500, 750, 1000, 1500, 3000, 8000];

/* ---------- minimal xlsx reader (mirrors build-benchmarks.mjs) ---------- */

function unzip(file, member) {
  return execFileSync('unzip', ['-p', file, member], { maxBuffer: 1 << 28 }).toString('utf8');
}
const decode = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');

function sharedStrings(file) {
  const xml = unzip(file, 'xl/sharedStrings.xml');
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

/* ---------- mappings ---------- */

const PROVINCE_CODE = {
  'alberta': 'AB', 'british-columbia': 'BC', 'manitoba': 'MB',
  'new-brunswick': 'NB', 'newfoundland-and-labrador': 'NL',
  'northwest-territories': 'NT', 'nova-scotia': 'NS', 'nunavut': 'NU',
  'ontario': 'ON', 'prince-edward-island': 'PE', 'quebec': 'QC',
  'saskatchewan': 'SK', 'yukon': 'YT'
};

/* This sheet has no DSL / fixed-wireless rows (verified: only Cable, FTTH,
   Satellite appear): matches build-benchmarks.mjs's finding on the same
   sheet. A user reporting DSL/fixed-wireless simply has no specific-type
   entry to match and falls straight to the terrestrial pool. */
const TECH = { 'Cable': 'cable', 'FTTH': 'fibre' }; // Satellite deliberately absent: dropped, not mapped

function nearestTier(mbps) {
  let best = SPEED_TIERS[0], bestDist = Math.abs(mbps - SPEED_TIERS[0]);
  for (const t of SPEED_TIERS) {
    const d = Math.abs(mbps - t);
    if (d < bestDist) { best = t; bestDist = d; }
  }
  return best;
}

/* Lowercase, trim, drop periods/apostrophes, collapse whitespace, drop a
   trailing " <digits>" disambiguator this sheet uses for duplicate city
   names (e.g. "Alberton 1", "Amherst 1"). Same function runs on both the
   pricing sheet's city column and GeoNames' place names, so either side's
   punctuation quirks wash out symmetrically. */
function normCity(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[.''’]/g, '')
    .replace(/\s+\d+$/, '')
    .replace(/\s+/g, ' ');
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(nums, p) {
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/* ---------- load FSA -> city (js/whollar-fsa-cities.js) ---------- */

function loadFsaCity() {
  const code = readFileSync(FSA_CITIES_FILE, 'utf8');
  const sandbox = {};
  sandbox.window = sandbox;
  new Function('window', 'globalThis', code + '\nreturn window;')(sandbox, sandbox);
  if (!sandbox.WHOLLAR || !sandbox.WHOLLAR.FSA_CITY) {
    throw new Error(`${FSA_CITIES_FILE} did not define WHOLLAR.FSA_CITY`);
  }
  return sandbox.WHOLLAR.FSA_CITY;
}

/* ---------- build ---------- */

const FSA_CITY = loadFsaCity();

// Reverse index: normalized city name -> [fsa, ...]. Cities the sheet uses
// that don't normalize-match any GeoNames place name resolve zero FSAs:
// expected and fine, the province level still covers them.
const cityToFsas = new Map();
for (const [fsa, loc] of Object.entries(FSA_CITY)) {
  const key = normCity(loc.city) + '|' + loc.province;
  if (!cityToFsas.has(key)) cityToFsas.set(key, []);
  cityToFsas.get(key).push(fsa);
}

const strings = sharedStrings(XLSX);
const rows = sheetRows(XLSX, 'xl/worksheets/sheet1.xml', strings);
const header = rows[0];
const col = Object.fromEntries(header.map((h, i) => [h, i]));
for (const need of ['province', 'city', 'connection_type', 'download_mbps', 'monthly_price']) {
  if (col[need] === undefined) throw new Error(`Internet Pricing sheet is missing column "${need}"`);
}

const skipped = { badPrice: 0, badSpeed: 0, satellite: 0, unknownProvince: 0 };
// rowsByTypeTier[tier|type] = [{price, province, city}, ...]: raw, pre-trim,
// used only to compute the national 99th-percentile cutoff per bucket.
const rowsByTypeTier = new Map();

for (const r of rows.slice(1)) {
  const price = parseFloat(r[col.monthly_price]);
  if (!Number.isFinite(price) || price <= 0) { skipped.badPrice++; continue; }
  const mbps = parseFloat(r[col.download_mbps]);
  if (!Number.isFinite(mbps) || mbps <= 0) { skipped.badSpeed++; continue; }
  const connRaw = (r[col.connection_type] || '').trim();
  if (connRaw === 'Satellite') { skipped.satellite++; continue; }
  const type = TECH[connRaw];
  if (!type) { skipped.badSpeed++; continue; } // unrecognised connection_type value, treat like bad data

  const slug = (r[col.province] || '').trim();
  const pv = PROVINCE_CODE[slug];
  if (!pv) { skipped.unknownProvince++; continue; }

  const tier = nearestTier(mbps);
  const key = tier + '|' + type;
  if (!rowsByTypeTier.has(key)) rowsByTypeTier.set(key, []);
  rowsByTypeTier.get(key).push({ price, province: pv, city: (r[col.city] || '').trim() });
}

// 99th-percentile cutoff per (tier, type), applied once, nationally.
const cutoffs = new Map();
for (const [key, list] of rowsByTypeTier) cutoffs.set(key, percentile(list.map(r => r.price), 99));

const trimmed = []; // flat list of surviving rows, tagged with tier/type
let usedRows = 0, trimmedOut = 0;
for (const [key, list] of rowsByTypeTier) {
  const [tierStr, type] = key.split('|');
  const tier = Number(tierStr);
  const cutoff = cutoffs.get(key);
  for (const r of list) {
    if (r.price > cutoff) { trimmedOut++; continue; }
    usedRows++;
    trimmed.push({ ...r, tier, type });
  }
}

// Bucket: cityKey|tier|type and cityKey|tier|terrestrial, provKey|tier|type
// and provKey|tier|terrestrial. cityKey is "normCity|provinceCode" so two
// same-named cities in different provinces never collide.
const cityBuckets = new Map();
const provBuckets = new Map();
const push = (map, key, price) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(price);
};
for (const r of trimmed) {
  const cityKey = normCity(r.city) + '|' + r.province;
  push(cityBuckets, cityKey + '|' + r.tier + '|' + r.type, r.price);
  push(cityBuckets, cityKey + '|' + r.tier + '|terrestrial', r.price);
  push(provBuckets, r.province + '|' + r.tier + '|' + r.type, r.price);
  push(provBuckets, r.province + '|' + r.tier + '|terrestrial', r.price);
}

function aggregate(buckets, minSample) {
  const out = {};
  for (const [key, prices] of buckets) {
    if (prices.length < minSample) continue;
    out[key] = [Math.round(median(prices) * 100), prices.length]; // integer cents
  }
  return out;
}

const SIGNAL_BY_CITY_RAW = aggregate(cityBuckets, MIN_SAMPLE); // keyed "normcity|PV|tier|type"
const SIGNAL_BY_PROVINCE = aggregate(provBuckets, MIN_SAMPLE);  // keyed "PV|tier|type"

// Fan city aggregates out to every FSA that resolves to that city (the
// FSA/city collapse documented in the file header above). SIGNAL_BY_CITY
// keeps the province in its key ("normcity|PV|tier|type"): several
// same-named cities exist in different provinces (e.g. Windsor, ON and
// Windsor, NS), and dropping the province would silently collide them.
const SIGNAL_BY_FSA = {};
const SIGNAL_BY_CITY = {};
const fsasWithAnyCoverage = new Set();
for (const [cityKey, val] of Object.entries(SIGNAL_BY_CITY_RAW)) {
  const parts = cityKey.split('|');
  const type = parts.pop();
  const tier = parts.pop();
  const provCity = parts.join('|'); // "normcity|PV"
  SIGNAL_BY_CITY[provCity + '|' + tier + '|' + type] = val;
  const fsas = cityToFsas.get(provCity) || [];
  for (const fsa of fsas) {
    SIGNAL_BY_FSA[fsa + '|' + tier + '|' + type] = val;
    fsasWithAnyCoverage.add(fsa);
  }
}

/* ---------- coverage report ---------- */

const totalFsas = Object.keys(FSA_CITY).length;
const perTierCoverage = SPEED_TIERS.map(t => {
  const nCities = Object.keys(SIGNAL_BY_CITY).filter(k => k.split('|')[2] === String(t)).length;
  const nProv = Object.keys(SIGNAL_BY_PROVINCE).filter(k => k.split('|')[1] === String(t)).length;
  return `    ${String(t).padStart(4)} Mbps: ${nCities} city buckets, ${nProv} province buckets`;
}).join('\n');

const stamp = new Date().toISOString().slice(0, 10);
const coverageReport = `Whollar signal lookup coverage report
Built: ${stamp}
Source: "Whollar Pricing Model.xlsx" (Internet Pricing sheet)

Source rows: ${rows.length - 1}
Used after price/speed/province/satellite filtering: ${usedRows}
Dropped: ${skipped.badPrice} null/zero price, ${skipped.badSpeed} bad speed or unrecognised connection type, ${skipped.satellite} satellite, ${skipped.unknownProvince} unrecognised province
Trimmed as above the 99th percentile for their (speedTier, connectionType) bucket: ${trimmedOut}

FSAs known (js/whollar-fsa-cities.js): ${totalFsas}
FSAs with at least one usable (speedTier, connectionType) bucket: ${fsasWithAnyCoverage.size} (${(100 * fsasWithAnyCoverage.size / totalFsas).toFixed(1)}%)
FSAs with NO usable bucket at any tier (province-level fallback only): ${totalFsas - fsasWithAnyCoverage.size}

Per speed tier, bucket counts (a bucket = one geography x connectionType-or-terrestrial combination that cleared the ${MIN_SAMPLE}-sample minimum):
${perTierCoverage}

Caveats:
- FSA-level and city-level numbers are the same underlying figure (see the
  build script's header comment): this sheet has no data finer than city.
  Expect signalBaseFor()'s confidence field to report 'fsa' or 'province' in
  practice, not 'city'.
- City-name matching between this sheet and js/whollar-fsa-cities.js is a
  normalized string match (case, punctuation, a numeric suffix this sheet
  uses for duplicate names). A city whose sheet spelling doesn't normalize-
  match any GeoNames place name resolves zero FSAs and falls through to
  province for every postal code in it.
- If a large share of FSAs only resolve at province level, that is a signal
  to narrow launch geography to well-covered FSAs, not to lower the sample
  threshold below ${MIN_SAMPLE}.
`;

/* ---------- emit ---------- */

const body = `/* GENERATED by scripts/build-signal-lookup.mjs from "Whollar Pricing Model.xlsx".
 * Do NOT edit by hand. Re-run the script when the spreadsheet changes.
 *
 * Source: ${rows.length - 1} rows on the Internet Pricing sheet. Used: ${usedRows}.
 * Dropped: ${skipped.badPrice} null/zero price, ${skipped.badSpeed} bad speed/type,
 * ${skipped.satellite} satellite, ${skipped.unknownProvince} unrecognised province.
 * ${trimmedOut} rows trimmed as above the 99th percentile for their bucket.
 * Built ${stamp}.
 *
 * See js/whollar-signal-lookup.coverage.txt for the full coverage report,
 * and this script's header comment for why 'city' collapses onto 'fsa' for
 * this particular data source.
 *
 * Keys are "<geo>|<speedTier>|<connectionType-or-'terrestrial'>". Values are
 * [medianMonthlyPriceCents, sampleSize]. Consumed by WHOLLAR.signalBaseFor()
 * in whollar-core.js.
 */
(function (root) {
  'use strict';
  var W = root.WHOLLAR || (root.WHOLLAR = {});

  W.SIGNAL_META = {
    source: 'Whollar Pricing Model.xlsx (Internet Pricing)',
    builtOn: ${JSON.stringify(stamp)},
    sourceRows: ${rows.length - 1},
    usedRows: ${usedRows},
    minSample: ${MIN_SAMPLE},
    speedTiers: ${JSON.stringify(SPEED_TIERS)}
  };

  W.SIGNAL_BY_FSA = ${JSON.stringify(SIGNAL_BY_FSA)};
  W.SIGNAL_BY_CITY = ${JSON.stringify(SIGNAL_BY_CITY)};
  W.SIGNAL_BY_PROVINCE = ${JSON.stringify(SIGNAL_BY_PROVINCE)};
})(typeof window !== 'undefined' ? window : globalThis);
`;

if (CHECK) {
  const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  const strip = s => (s || '').replace(/Built \d{4}-\d{2}-\d{2}\./, '').replace(/builtOn: "[^"]*"/, '');
  if (strip(prev) === strip(body)) { console.log(`ok      ${OUT.replace(ROOT + '/', '')}`); process.exit(0); }
  console.error(`STALE   js/whollar-signal-lookup.js. Regenerate with: node scripts/build-signal-lookup.mjs`);
  process.exit(1);
}

writeFileSync(OUT, body);
writeFileSync(COVERAGE_OUT, coverageReport);
console.log(`written js/whollar-signal-lookup.js (${(body.length / 1024).toFixed(1)} KB)`);
console.log(`written js/whollar-signal-lookup.coverage.txt`);
console.log(coverageReport);
