#!/usr/bin/env node
/* Build js/whollar-benchmarks.js from "Whollar Pricing Model.xlsx".
 *
 *   node scripts/build-benchmarks.mjs
 *   node scripts/build-benchmarks.mjs --check   # CI: fail if the output is stale
 *
 * Reads the "Internet Pricing" sheet (6,803 advertised plans scraped from
 * redflagdeals/planhub) and emits the aggregated reference prices the bill
 * checkup scores against. Sheets 3-5 are cell-phone plans and are ignored.
 *
 * WHY AGGREGATE AT BUILD TIME: the raw sheet is ~390 KB of XLSX and the pages
 * are static HTML with no server. Shipping 6,800 rows to every visitor to
 * compute one average would be absurd; the aggregate is a few KB.
 *
 * ------------------------------------------------------------------
 * DATA DECISIONS: each one changes the number a household is shown.
 *
 * 1. Rows with monthly_price <= 0 are DROPPED (144 of them). They are
 *    prepaid/lump-sum plans whose cost sits in upfront_payment; averaging a
 *    $0 into a tier drags the reference price down and manufactures
 *    "you're overpaying" verdicts.
 *
 * 2. Speeds are BUCKETED to the eight tiers the form's <select> offers.
 *    The sheet has 33 distinct speeds (5 → 8000 Mbps); the form has
 *    25/50/100/150/300/500/1000/1500. Band edges are the geometric mean of
 *    adjacent tiers, so 940 Mbps lands in 1000 and 3000+ lands in 1500,
 *    which matches that option's own label, "1.5 Gig or faster".
 *
 * 3. Satellite is EXCLUDED from every tech-blind aggregate. Starlink is 912
 *    rows at $85-$160 and it makes the tier-only averages non-monotonic:
 *    150 Mbps averages $89 while 300 Mbps averages $71, purely because
 *    Starlink's 150 Mbps plan sits in the first bucket. A household that
 *    picked "Not sure" for connection type is not on satellite. They would
 *    know. Keeping satellite in that fallback would tell cable customers at
 *    150 Mbps that $80 is a good deal when the cable reference is $56.
 *
 * 4. Providers are grouped, because the form offers "An independent (oxio,
 *    TekSavvy…)" as ONE option covering ~13 carriers. Virgin and Fizz are
 *    flanker brands owned by incumbents, so they are not "independents".
 *    Rogers, Shaw, Eastlink and SaskTel are options on the form with ZERO
 *    rows in this sheet. They fall through to the provider-blind level,
 *    which is exactly the fallback behaviour that was asked for.
 * ------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const XLSX = join(ROOT, 'Whollar Pricing Model.xlsx');
const OUT = join(ROOT, 'js/whollar-benchmarks.js');
const CHECK = process.argv.includes('--check');

/* ---------- minimal xlsx reader (no dependency) ---------- */

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

/* Sheet slugs → the two-letter codes WHOLLAR.parsePostal returns. */
const PROVINCE_CODE = {
  'alberta': 'AB', 'british-columbia': 'BC', 'manitoba': 'MB',
  'new-brunswick': 'NB', 'newfoundland-and-labrador': 'NL',
  'northwest-territories': 'NT', 'nova-scotia': 'NS', 'nunavut': 'NU',
  'ontario': 'ON', 'prince-edward-island': 'PE', 'quebec': 'QC',
  'saskatchewan': 'SK', 'yukon': 'YT'
};

/* Sheet connection_type → the form's #tech groups. The sheet has no DSL and
   no fixed-wireless rows at all, so those two form options resolve to no
   tech-keyed data and fall through to the tech-blind levels. */
const TECH_GROUP = { 'Cable': 'cable', 'FTTH': 'fibre', 'Satellite': 'satellite' };

/* Sheet provider → group. The form sells one "An independent" option covering
   many carriers, so the group, not the raw name, is the aggregation key. */
const PROVIDER_GROUP = {
  'Bell': 'bell', 'Telus': 'telus', 'Videotron': 'videotron', 'Cogeco': 'cogeco',
  'Virgin': 'flanker', 'Fizz': 'flanker',          // incumbent-owned, not independents
  'Starlink': 'satellite-isp'
  // everything else → 'independent' (see groupFor)
};
const groupFor = name => PROVIDER_GROUP[name] || (name ? 'independent' : null);

const TIERS = [25, 50, 100, 150, 300, 500, 1000, 1500];
const EDGES = TIERS.slice(0, -1).map((t, i) => Math.sqrt(t * TIERS[i + 1]));
const tierFor = mbps => {
  for (let i = 0; i < EDGES.length; i++) if (mbps < EDGES[i]) return TIERS[i];
  return TIERS[TIERS.length - 1];
};

/* ---------- build ---------- */

const strings = sharedStrings(XLSX);
const rows = sheetRows(XLSX, 'xl/worksheets/sheet1.xml', strings);
const header = rows[0];
const col = Object.fromEntries(header.map((h, i) => [h, i]));
for (const need of ['province', 'provider', 'connection_type', 'download_mbps', 'monthly_price']) {
  if (col[need] === undefined) throw new Error(`Internet Pricing sheet is missing column "${need}"`);
}

const buckets = new Map();
const push = (key, price) => {
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = []));
  b.push(price);
};

const skipped = { zeroPrice: 0, badSpeed: 0, noProvince: 0, unknownProvince: 0 };
let used = 0;

for (const r of rows.slice(1)) {
  const price = parseFloat(r[col.monthly_price]);
  if (!Number.isFinite(price) || price <= 0) { skipped.zeroPrice++; continue; }
  const mbps = parseFloat(r[col.download_mbps]);
  if (!Number.isFinite(mbps) || mbps <= 0) { skipped.badSpeed++; continue; }
  const slug = (r[col.province] || '').trim();
  if (!slug) { skipped.noProvince++; continue; }
  const pv = PROVINCE_CODE[slug];
  if (!pv) { skipped.unknownProvince++; continue; }

  const tech = TECH_GROUP[(r[col.connection_type] || '').trim()] || null;
  const grp = groupFor((r[col.provider] || '').trim());
  const tier = tierFor(mbps);
  used++;

  /* Tech-keyed levels, most specific first. */
  if (tech && grp) push(`A|${pv}|${grp}|${tech}|${tier}`, price);
  if (tech) push(`B|${pv}|${tech}|${tier}`, price);
  if (tech) push(`C|${tech}|${tier}`, price);

  /* Tech-blind levels EXCLUDE satellite. See decision 3 in the header. */
  if (tech !== 'satellite') {
    if (grp) push(`D|${pv}|${grp}|${tier}`, price);
    push(`E|${pv}|${tier}`, price);
    push(`F|${tier}`, price);

    /* Undivided province-wide pools, for the homepage estimator. It knows only
       a postal code: no speed, no tech, no provider, so it cannot use any of
       the keyed levels above. Satellite is excluded here for the same reason
       it is excluded from D-F. */
    push(`P|${pv}`, price);
    push('P|CA', price);
  }
}

/* Mean, rounded to cents, plus the sample size so the UI can qualify a thin
   reference instead of stating it as flatly as a thick one. */
const table = {};
for (const [key, prices] of [...buckets].sort()) {
  if (key.startsWith('P|')) continue;              // percentile pools, emitted separately
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  table[key] = [Math.round(mean * 100) / 100, prices.length];
}

/* The mean of every price at or below the 10th percentile.
 *
 * WHY THE BOTTOM DECILE AND NOT THE MEAN: this figure answers "what does the
 * cheap end of this province's advertised market cost", which is the price a
 * cohort is bidding toward. The mean answers "what does the market cost on
 * average", which is roughly what an unhappy household is already paying, so
 * comparing a bill against it understates the gap the cohort is trying to
 * close.
 *
 * Ceil, not floor, on the cut: a 22-row province (PE) would otherwise take
 * 2 rows, and a province with under 10 rows would take none at all.
 */
function p10Average(prices) {
  const sorted = [...prices].sort((a, b) => a - b);
  const cut = Math.max(1, Math.ceil(sorted.length * 0.10));
  const bottom = sorted.slice(0, cut);
  const mean = bottom.reduce((a, b) => a + b, 0) / bottom.length;
  return [Math.round(mean * 100) / 100, bottom.length, sorted.length];
}

const p10 = {};
for (const [key, prices] of [...buckets].sort()) {
  if (!key.startsWith('P|')) continue;
  p10[key.slice(2)] = p10Average(prices);
}
/* NT, NU and YT are satellite-only in this sheet, so they have no pool at all
   and the estimator falls through to the national figure. Recorded here so the
   absence is visible in the generated file rather than a silent gap. */
const noPool = Object.keys(PROVINCE_CODE).map(s => PROVINCE_CODE[s]).filter(pv => !p10[pv]).sort();
/* 'CA' is the national pool and is emitted as its own constant, not as a
   province nobody's postal code parses to. */
const p10Provinces = Object.fromEntries(Object.entries(p10).filter(([k]) => k !== 'CA'));

const stamp = new Date().toISOString().slice(0, 10);
const body = `/* GENERATED by scripts/build-benchmarks.mjs from "Whollar Pricing Model.xlsx".
 * Do NOT edit by hand. Re-run the script when the spreadsheet changes.
 *
 * Source: ${rows.length - 1} advertised Canadian home-internet plans.
 * Used: ${used}. Dropped: ${skipped.zeroPrice} zero/prepaid-price rows,
 * ${skipped.badSpeed} unusable speeds, ${skipped.noProvince + skipped.unknownProvince} unusable provinces.
 * Built ${stamp}.
 *
 * Keys are "<level>|<dims…>" and values are [meanMonthlyPrice, sampleSize].
 * Levels, tried in this order by WHOLLAR.benchmarkFor():
 *   A  province | providerGroup | tech | speedTier     most specific
 *   B  province | tech | speedTier                     drops the provider  ← the specified first fallback
 *   C  tech | speedTier                                drops the province
 *   D  province | providerGroup | speedTier            no tech (satellite excluded)
 *   E  province | speedTier                            (satellite excluded)
 *   F  speedTier                                       last resort (satellite excluded)
 *
 * W.P10_BY_PROVINCE / W.P10_NATIONAL are a separate, unkeyed aggregate for the
 * homepage estimator, which has only a postal code to work with. Values are
 * [bottomDecileMeanMonthlyPrice, rowsInThatDecile, rowsInProvince].
 */
(function (root) {
  'use strict';
  var W = root.WHOLLAR || (root.WHOLLAR = {});

  W.BENCH_META = {
    builtOn: ${JSON.stringify(stamp)},
    sourceRows: ${rows.length - 1},
    usedRows: ${used},
    tiers: ${JSON.stringify(TIERS)}
  };

  /* Mean of every advertised price at or below the province's 10th percentile:
     what the cheap end of that market costs. The homepage estimator compares a
     household's bill against this figure, annualised. Satellite excluded.
     ${noPool.length ? 'Satellite-only in this sheet, so absent here and served by P10_NATIONAL: ' + noPool.join(', ') + '.' : 'Every province has a pool.'} */
  W.P10_BY_PROVINCE = ${JSON.stringify(p10Provinces)};
  W.P10_NATIONAL = ${JSON.stringify(p10.CA)};

  /* Sheet speeds are continuous; the form offers eight tiers. Band edges are
     the geometric mean of adjacent tiers. */
  W.SPEED_TIERS = ${JSON.stringify(TIERS)};
  W.SPEED_EDGES = ${JSON.stringify(EDGES.map(e => Math.round(e * 100) / 100))};

  /* #prov <option> value → the provider group used as an aggregation key.
     Rogers, Shaw, Eastlink and SaskTel are offered by the form but have no
     rows in the dataset; they map to a group that is simply absent from the
     table, so the lookup falls through to the provider-blind level. */
  W.PROVIDER_GROUPS = ${JSON.stringify({
    'Rogers': 'rogers', 'Bell': 'bell', 'Telus': 'telus', 'Shaw': 'shaw',
    'Vidéotron': 'videotron', 'Cogeco': 'cogeco', 'Eastlink': 'eastlink',
    'SaskTel': 'sasktel', 'An independent (oxio, TekSavvy…)': 'independent',
    'Other / not sure': null
  }, null, 2).replace(/\n/g, '\n  ')};

  /* #tech <option> value → tech group. DSL and fixed wireless have no rows in
     the dataset, so they resolve to null and use the tech-blind levels. */
  W.TECH_GROUPS = ${JSON.stringify({
    'Cable (TV coax jack)': 'cable',
    'Fibre (thin glass line)': 'fibre',
    'DSL (old phone line)': null,
    'Fixed wireless (5G antenna)': null,
    'Satellite (dish)': 'satellite',
    'Not sure': null
  }, null, 2).replace(/\n/g, '\n  ')};

  W.BENCHMARKS = ${JSON.stringify(table, null, 0).replace(/","/g, '",\n    "').replace(/^\{/, '{\n    ').replace(/\}$/, '\n  }')};
})(typeof window !== 'undefined' ? window : globalThis);
`;

if (CHECK) {
  const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  /* The build date changes daily; compare everything else. */
  const strip = s => (s || '').replace(/Built \d{4}-\d{2}-\d{2}\./, '').replace(/builtOn: "[^"]*"/, '');
  if (strip(prev) === strip(body)) { console.log(`ok      ${OUT.replace(ROOT + '/', '')}`); process.exit(0); }
  console.error(`STALE   js/whollar-benchmarks.js. Regenerate with: node scripts/build-benchmarks.mjs`);
  process.exit(1);
}

writeFileSync(OUT, body);
console.log(`written js/whollar-benchmarks.js`);
console.log(`  ${rows.length - 1} source rows → ${used} used (${skipped.zeroPrice} zero-price dropped)`);
console.log(`  ${Object.keys(table).length} aggregate keys, ${(body.length / 1024).toFixed(1)} KB`);
for (const lvl of 'ABCDEF') {
  const n = Object.keys(table).filter(k => k.startsWith(lvl + '|')).length;
  console.log(`    level ${lvl}: ${n} keys`);
}
