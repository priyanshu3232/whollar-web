#!/usr/bin/env node
/* Build js/whollar-estimate-bench.js from "Whollar Pricing Model.xlsx".
 *
 *   node scripts/build-estimate-bench.mjs
 *   node scripts/build-estimate-bench.mjs --check   # CI: fail if output is stale
 *
 * The homepage estimator asks two questions only: current monthly bill and
 * postal code. This file is the reference it compares against: per city, the
 * single cheapest advertised plan at 100 Mbps or better, with the provider
 * named so the card can say who is selling it.
 *
 * This is a THIRD reference, distinct from the two that already exist, and
 * the three must not be confused:
 *
 *   js/whollar-benchmarks.js    (build-benchmarks.mjs, same workbook)
 *     "what does the market charge for this exact tier/tech/provider"
 *     -> drives the checkup's weak/fair/strong verdict. Tier-keyed, mean-based.
 *
 *   js/whollar-base-pricing.js  (build-base-pricing.mjs, PlanSavvy workbook)
 *     "cheapest advertised floor in this province, any speed"
 *     -> drove the OLD estimator. Province-only, no speed floor, no provider.
 *
 *   js/whollar-estimate-bench.js  (this file)
 *     "cheapest advertised plan at >=100 Mbps in this CITY, and who sells it"
 *     -> drives the NEW estimator. City-keyed, province fallback, named provider.
 *
 * The old estimator's number was the cheapest plan at ANY speed, so a 15 Mbps
 * DSL line could set the floor a household could not actually live on. The
 * 100 Mbps gate is what makes the comparison honest, and it is why this file
 * exists rather than a widened build-base-pricing.mjs.
 *
 * PIPELINE (row counts as of the 2026-08 workbook, printed by every run)
 *   6803 data rows in
 *   -144  monthly_price <= 0 (prepaid//promo rows that would return a $0
 *         benchmark and read as "free internet")
 *   -556  provider is blank (cannot be named on screen, and naming is the
 *         point of this file)
 *   -555  Satellite rows in a city that ALSO has terrestrial rows. Starlink
 *         is listed nationwide and would otherwise win the "cheapest" slot in
 *         rural cities where a real cable/fibre line exists. Satellite is kept
 *         where it is the only thing listed, because there it is the truth.
 *   = 5548 rows, 493 cities, every one of which has a >=100 Mbps plan.
 *
 * RANK ON EFFECTIVE COST, DISPLAY THE MONTHLY. eff = monthly_price +
 * upfront_payment / 24. A $0/mo-looking plan with a $200 install is not
 * cheaper than one without it over a two-year hold, so eff decides the
 * winner; the card shows monthly_price, because that is the number a
 * household compares to their own bill.
 *
 * CITY NAME DISAMBIGUATORS. The sheet suffixes duplicate city names with a
 * bare integer: "Waterloo 1", "Richmond 2", "Kingston 3". The suffix is
 * scraper noise, not part of the name, and it is stripped with /\s+\d+$/ --
 * NOT just a trailing " 1". 43 cities carry " 1" and five carry " 2"/" 3"
 * ("Richmond 2", "Berwick 2", "Kingston 3", "Windsor 3", "Stratford 2");
 * stripping only " 1" would leave Richmond BC unreachable, which is eight
 * FSAs of a real city. Verified collision-free: no two suffixed names in one
 * province collapse onto each other.
 *
 * RESOLUTION is a two-level cascade, computed in whollar-core.js, not here:
 *   FSA3 -> city  via js/whollar-fsa-cities.js (GeoNames), then this table
 *   first letter -> province  via WHOLLAR.parsePostal, then BY_PROVINCE
 * The caller is told which basis was used so the copy can say "in Toronto"
 * or "across Ontario" and never imply local precision it does not have.
 *
 * THE CITY JOIN is the lossy step and is measured, not assumed: the coverage
 * report written beside the output lists every unmatched FSA city. Two
 * fixups are applied here, in this order, and both are conservative:
 *
 *   1. NORMALIZE: strip accents, drop periods/apostrophes, fold hyphens and
 *      slashes to spaces, collapse whitespace, lowercase. "Trois-Rivieres"
 *      and "Trois Rivieres" are the same place; "St. Catharines" and
 *      "St Catharines" are too.
 *
 *   2. ALIAS amalgamated boroughs onto their municipality (ALIAS below).
 *      GeoNames segments Toronto into Scarborough/North York/Etobicoke/York/
 *      East York and Montreal into its boroughs; the pricing sheet lists only
 *      "Toronto" and "Montreal". Without this the densest, highest-traffic
 *      postal codes in the country all fall back to the province number.
 *      Every alias target is asserted to exist in the built table, so a
 *      pricing-sheet change that drops a city turns this script red instead
 *      of silently sending those FSAs to the province fallback.
 *
 * NO compass-direction stripping, matching build-fsa-cities.mjs: "North York",
 * "North Vancouver" and "North Bay" are distinct real municipalities. GeoNames'
 * own trailing-direction artifacts ("Stratford South", "Drummondville South")
 * are handled by a trailing-direction retry that runs ONLY after an exact
 * match has already failed, so it can never override a real hit.
 *
 * Quebec's rural FSAs carry administrative REGION names in GeoNames
 * ("Monteregie", "Capitale-Nationale", "Lanaudiere"), not city names. Those
 * are not cities and no alias can fix them; they resolve to the province
 * number, which is the correct answer for them.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const XLSX = join(ROOT, 'Whollar Pricing Model.xlsx');
const OUT = join(ROOT, 'js/whollar-estimate-bench.js');
const COVERAGE = join(ROOT, 'js/whollar-estimate-bench.coverage.txt');
const FSA_CITIES = join(ROOT, 'js/whollar-fsa-cities.js');
const CHECK = process.argv.includes('--check');
const SHEET = 'xl/worksheets/sheet1.xml';   /* "Internet Pricing" */
const MIN_MBPS = 100;
const UPFRONT_MONTHS = 24;

/* ---------- minimal xlsx reader (no dependency, mirrors build-benchmarks.mjs) ---------- */

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

/* Sheet slugs -> the two-letter codes WHOLLAR.parsePostal returns. */
const PROVINCE_CODE = {
  'alberta': 'AB', 'british-columbia': 'BC', 'manitoba': 'MB',
  'new-brunswick': 'NB', 'newfoundland-and-labrador': 'NL',
  'northwest-territories': 'NT', 'nova-scotia': 'NS', 'nunavut': 'NU',
  'ontario': 'ON', 'prince-edward-island': 'PE', 'quebec': 'QC',
  'saskatchewan': 'SK', 'yukon': 'YT'
};

/* Amalgamated boroughs and annexed municipalities: GeoNames' name -> the
   municipality the pricing sheet actually lists. Keyed "PROV|normalized".
   Province-keyed on purpose: Vanier is an Ottawa neighbourhood in ON and a
   Quebec City one in QC. */
const ALIAS = {
  /* Toronto (1998 amalgamation) */
  'ON|scarborough': 'Toronto', 'ON|north york': 'Toronto',
  'ON|etobicoke': 'Toronto', 'ON|east york': 'Toronto', 'ON|york': 'Toronto',
  'ON|willowdale': 'Toronto', 'ON|don mills': 'Toronto',
  'ON|downsview': 'Toronto', 'ON|agincourt': 'Toronto',
  'ON|rexdale': 'Toronto', 'ON|weston': 'Toronto', 'ON|leaside': 'Toronto',
  /* Ottawa (2001 amalgamation) */
  'ON|gloucester': 'Ottawa', 'ON|kanata': 'Ottawa', 'ON|nepean': 'Ottawa',
  'ON|orleans': 'Ottawa', 'ON|vanier': 'Ottawa', 'ON|stittsville': 'Ottawa',
  'ON|cumberland': 'Ottawa', 'ON|rockcliffe park': 'Ottawa',
  /* Hamilton (2001), Vaughan, Brantford, Windsor, Sault Ste. Marie */
  'ON|ancaster': 'Hamilton', 'ON|dundas': 'Hamilton',
  'ON|stoney creek': 'Hamilton', 'ON|waterdown': 'Hamilton',
  'ON|flamborough': 'Hamilton',
  'ON|woodbridge': 'Vaughan', 'ON|maple': 'Vaughan',
  'ON|brant': 'Brantford',
  'ON|tecumseh': 'Windsor', 'ON|la salle': 'Windsor',
  'ON|sault ste': 'Sault Ste Marie',
  /* Montreal (2002 merger; several boroughs demerged in 2006 but the sheet
     lists only "Montreal", so the boroughs point there) */
  'QC|saint laurent': 'Montreal', 'QC|plateau mont royal': 'Montreal',
  'QC|ahuntsic': 'Montreal', 'QC|cote des neiges': 'Montreal',
  'QC|mercier': 'Montreal', 'QC|saint leonard': 'Montreal',
  'QC|rosemont': 'Montreal', 'QC|villeray': 'Montreal',
  'QC|petite patrie': 'Montreal', 'QC|mount royal': 'Montreal',
  'QC|notre dame de grace': 'Montreal', 'QC|verdun': 'Montreal',
  'QC|cartierville': 'Montreal', 'QC|lasalle': 'Montreal',
  'QC|lachine': 'Montreal', 'QC|anjou': 'Montreal',
  'QC|outremont': 'Montreal',
  'QC|hochelaga': 'Montreal', 'QC|maisonneuve': 'Montreal',
  'QC|pierrefonds': 'Montreal', 'QC|riviere des prairies': 'Montreal',
  'QC|montreal nord': 'Montreal', 'QC|saint michel': 'Montreal',
  'QC|ville marie': 'Montreal', 'QC|centre sud': 'Montreal',
  'QC|saint henri': 'Montreal', 'QC|pointe aux trembles': 'Montreal',
  'QC|roxboro': 'Montreal', 'QC|ile bizard': 'Montreal',
  /* Laval (single city since 1965; GeoNames keeps the old sectors) */
  'QC|chomedey': 'Laval', 'QC|auteuil': 'Laval',
  'QC|sainte dorothee': 'Laval', 'QC|duvernay': 'Laval',
  'QC|vimont': 'Laval', 'QC|laval des rapides': 'Laval',
  'QC|pont viau': 'Laval', 'QC|fabreville': 'Laval',
  'QC|sainte rose': 'Laval', 'QC|laval ouest': 'Laval',
  /* Quebec City (2002 amalgamation) */
  'QC|beauport': 'Quebec City', 'QC|sainte foy': 'Quebec City',
  'QC|loretteville': 'Quebec City', 'QC|val belair': 'Quebec City',
  'QC|charlesbourg': 'Quebec City', 'QC|sillery': 'Quebec City',
  'QC|cap rouge': 'Quebec City', 'QC|lac saint charles': 'Quebec City',
  'QC|vanier': 'Quebec City',
  /* Jean-Talon is a Montreal street AND a Quebec City sector. Both provinces
     are QC, so the province key cannot separate them: the FSAs that actually
     carry this name are G2M and G2N, which are Quebec City (Montreal is the
     H prefix throughout). Mapping it to Montreal, as an alphabetical reading
     of the name suggests, put two Quebec City FSAs on Montreal pricing. */
  'QC|jean talon': 'Quebec City',
  /* Gatineau (2002), Longueuil (2002), Trois-Rivieres (2002) */
  'QC|hull': 'Gatineau', 'QC|aylmer': 'Gatineau',
  'QC|buckingham': 'Gatineau', 'QC|masson angers': 'Gatineau',
  'QC|saint hubert': 'Longueuil', 'QC|greenfield park': 'Longueuil',
  'QC|lemoyne': 'Longueuil',
  'QC|cap de la madeleine': 'Trois Rivieres',
  'QC|trois rivieres ouest': 'Trois Rivieres',
  /* Greater Victoria, Halifax Regional Municipality (1996) */
  'BC|saanich': 'Victoria', 'BC|oak bay': 'Victoria',
  'BC|esquimalt': 'Victoria',
  'NS|lower sackville': 'Halifax', 'NS|sackville': 'Halifax',
  /* Renames and boundary wording the sheet spells differently. Each of these
     is the same settlement under a longer or older name, NOT a nearby one:
     "Lake Simcoe" -> "Simcoe" and "Fort Nelson" -> "Nelson" look similar and
     are deliberately absent, because those are different places. */
  'QC|sainte therese de blainville': 'Sainte Therese',
  'QC|sorel': 'Sorel Tracy',
  'QC|vaudreuil dorion rcm': 'Vaudreuil Dorion',
  'BC|langley township': 'Langley', 'BC|langley city': 'Langley',
  'NL|conception bay': 'Conception Bay South',
  'NL|grand falls': 'Grand Falls Windsor',
  'NB|florenceville': 'Florenceville Bristol'
  /* Deliberately NOT aliased, though they look close enough to be:
     "Fredericton Junction" is its own village 30 km from Fredericton, and
     "Peterborough County" is the rural county, not the city. Each is a
     single FSA, and the province number is the honest answer for both. */
};

/* Trailing GeoNames direction artifacts, retried only after an exact miss. */
const TRAILING_DIR = /\s+(north|south|east|west|central|northeast|northwest|southeast|southwest|north central|south central)$/;

/* Accent/punctuation-insensitive key. */
const norm = s => String(s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[.'’]/g, '')
  .replace(/[-\/]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/* The sheet's duplicate-name disambiguator: a trailing bare integer. */
const stripDisambiguator = s => String(s || '').trim().replace(/\s+\d+$/, '');

const num = v => {
  const n = Number(String(v == null ? '' : v).trim());
  return Number.isFinite(n) ? n : null;
};

/* ---------- build ---------- */

const strings = sharedStrings(XLSX);
const rows = sheetRows(XLSX, SHEET, strings);
const header = rows[0].map(h => String(h || '').trim());
const col = name => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`column "${name}" missing from the sheet; header is ${header.join(', ')}`);
  return i;
};
const C = {
  province: col('province'), city: col('city'), provider: col('provider'),
  tech: col('connection_type'), mbps: col('download_mbps'),
  upfront: col('upfront_payment'), price: col('monthly_price')
};

const stats = { in: rows.length - 1, prepaid: 0, noProvider: 0, satellite: 0, noProvince: 0, noCity: 0 };

let kept = [];
for (const r of rows.slice(1)) {
  const price = num(r[C.price]);
  if (!(price > 0)) { stats.prepaid++; continue; }
  const provider = String(r[C.provider] || '').trim();
  if (!provider) { stats.noProvider++; continue; }
  const pv = PROVINCE_CODE[String(r[C.province] || '').trim()];
  if (!pv) { stats.noProvince++; continue; }
  const city = stripDisambiguator(r[C.city]);
  if (!city) { stats.noCity++; continue; }
  kept.push({
    pv, city, provider,
    tech: String(r[C.tech] || '').trim(),
    mbps: num(r[C.mbps]),
    price,
    eff: price + (num(r[C.upfront]) || 0) / UPFRONT_MONTHS
  });
}

/* Satellite is dropped only where terrestrial exists in the same city. */
const cityRows = new Map();
for (const r of kept) {
  const k = r.pv + '|' + r.city;
  if (!cityRows.has(k)) cityRows.set(k, []);
  cityRows.get(k).push(r);
}
const filtered = [];
for (const [, list] of cityRows) {
  const hasTerrestrial = list.some(r => r.tech && r.tech !== 'Satellite');
  for (const r of list) {
    if (hasTerrestrial && r.tech === 'Satellite') { stats.satellite++; continue; }
    filtered.push(r);
  }
}

/* Cheapest >=100 Mbps plan per city, ranked on eff. Ties break on the lower
   displayed monthly, then provider name, so the output is deterministic. */
const better = (a, b) => a.eff !== b.eff ? a.eff < b.eff
  : a.price !== b.price ? a.price < b.price
  : a.provider < b.provider;

const byCity = new Map(), byProvince = new Map();
for (const r of filtered) {
  if (!(r.mbps >= MIN_MBPS)) continue;
  const ck = r.pv + '|' + r.city;
  if (!byCity.has(ck) || better(r, byCity.get(ck))) byCity.set(ck, r);
  if (!byProvince.has(r.pv) || better(r, byProvince.get(r.pv))) byProvince.set(r.pv, r);
}

const rec = r => ({ p: r.price, eff: Math.round(r.eff * 100) / 100, mb: r.mbps, who: r.provider });
const CITY = {}, PROV = {};
for (const [k, r] of [...byCity].sort((a, b) => a[0] < b[0] ? -1 : 1)) CITY[k] = rec(r);
for (const [k, r] of [...byProvince].sort((a, b) => a[0] < b[0] ? -1 : 1)) PROV[k] = rec(r);

/* Every alias must point at a city that survived, or the alias is a silent
   no-op that sends real FSAs to the province fallback. */
const brokenAliases = Object.entries(ALIAS)
  .filter(([k, target]) => !CITY[k.split('|')[0] + '|' + target]);
if (brokenAliases.length) {
  console.error('Alias targets missing from the built table:');
  for (const [k, t] of brokenAliases) console.error(`  ${k} -> ${t}`);
  process.exit(1);
}

/* ---------- resolve the FSA -> city join, and measure it ---------- */

const fsaGlobal = {};
new Function('window', readFileSync(FSA_CITIES, 'utf8')).call(fsaGlobal, fsaGlobal);
const FSA_CITY = fsaGlobal.WHOLLAR && fsaGlobal.WHOLLAR.FSA_CITY;
if (!FSA_CITY) throw new Error('js/whollar-fsa-cities.js did not expose WHOLLAR.FSA_CITY');

/* Normalized city key -> the exact CITY key, per province. */
const lookup = new Map();
for (const k of Object.keys(CITY)) {
  const i = k.indexOf('|');
  lookup.set(k.slice(0, i) + '|' + norm(k.slice(i + 1)), k);
}

/* FSA3 -> CITY key. Only FSAs that actually resolve are emitted, so the file
   carries no dead entries and the client's miss path is a plain lookup miss. */
const FSA = {};
const unresolved = new Map();
for (const [fsa, r] of Object.entries(FSA_CITY)) {
  const pv = r.province, raw = norm(r.city);
  const aliased = ALIAS[pv + '|' + raw];
  let hit = aliased ? (CITY[pv + '|' + aliased] ? pv + '|' + aliased : null)
                    : lookup.get(pv + '|' + raw);
  if (!hit && TRAILING_DIR.test(raw)) {
    const base = raw.replace(TRAILING_DIR, '');
    const a2 = ALIAS[pv + '|' + base];
    hit = a2 ? (CITY[pv + '|' + a2] ? pv + '|' + a2 : null) : lookup.get(pv + '|' + base);
  }
  if (hit) FSA[fsa] = hit;
  else {
    const key = pv + '|' + r.city;
    unresolved.set(key, (unresolved.get(key) || 0) + 1);
  }
}

const totalFsa = Object.keys(FSA_CITY).length;
const resolved = Object.keys(FSA).length;
const pct = (100 * resolved / totalFsa).toFixed(1);

/* ---------- emit ---------- */

const stamp = new Date().toISOString().slice(0, 10);
const j = o => JSON.stringify(o);

const body = `/* GENERATED by scripts/build-estimate-bench.mjs from "Whollar Pricing
 * Model.xlsx", sheet "Internet Pricing". Do NOT edit by hand. Re-run the
 * script to refresh, and commit both this file and the .coverage.txt beside it.
 *
 * The homepage estimator's reference: per city, the cheapest advertised plan
 * at ${MIN_MBPS} Mbps or better, ranked on monthly + upfront/${UPFRONT_MONTHS} and displayed at
 * the monthly. See the script header for the full pipeline and its rationale.
 *
 * ${stats.in} sheet rows in. Dropped: ${stats.prepaid} with monthly_price <= 0,
 * ${stats.noProvider} with no provider, ${stats.satellite} Satellite rows in cities that also have
 * terrestrial service. ${Object.keys(CITY).length} cities and ${Object.keys(PROV).length} provinces emitted.
 * ${resolved} of ${totalFsa} FSAs (${pct}%) resolve to a city; the rest use the province
 * number. Built ${stamp}.
 *
 * These are ADVERTISED reseller prices, not offers Whollar can make. The card
 * that renders them says so.
 */
(function (W) {
  'use strict';
  W.WHOLLAR = W.WHOLLAR || {};
  var Q = W.WHOLLAR;

  /* FSA3 -> key into ESTIMATE_BY_CITY. Only resolvable FSAs are listed. */
  Q.ESTIMATE_FSA_CITY = ${j(FSA)};

  /* "PROV|City" -> { p: displayed monthly, eff: ranking cost, mb: download
     Mbps, who: provider }. */
  Q.ESTIMATE_BY_CITY = ${j(CITY)};

  /* Province fallback, same shape, same rules. */
  Q.ESTIMATE_BY_PROVINCE = ${j(PROV)};

  Q.ESTIMATE_BENCH_META = ${j({
    built: stamp,
    source: 'Whollar Pricing Model.xlsx / Internet Pricing',
    minMbps: MIN_MBPS,
    upfrontMonths: UPFRONT_MONTHS,
    rowsIn: stats.in,
    droppedPrepaid: stats.prepaid,
    droppedNoProvider: stats.noProvider,
    droppedSatellite: stats.satellite,
    rowsScored: filtered.length,
    cities: Object.keys(CITY).length,
    provinces: Object.keys(PROV).length,
    fsaTotal: totalFsa,
    fsaResolved: resolved
  })};
})(typeof window !== 'undefined' ? window : globalThis);
`;

const coverage = [
  `whollar-estimate-bench.js coverage, built ${stamp}`,
  ``,
  `Source: Whollar Pricing Model.xlsx, sheet "Internet Pricing"`,
  `  ${stats.in} data rows in`,
  `  -${stats.prepaid} monthly_price <= 0`,
  `  -${stats.noProvider} provider blank`,
  `  -${stats.noProvince} province not recognised`,
  `  -${stats.noCity} city blank`,
  `  -${stats.satellite} Satellite in a city that also has terrestrial rows`,
  `  = ${filtered.length} rows scored, ${Object.keys(CITY).length} cities with a >=${MIN_MBPS} Mbps plan`,
  ``,
  `FSA join (js/whollar-fsa-cities.js, ${totalFsa} FSAs)`,
  `  ${resolved} resolve to a city (${pct}%)`,
  `  ${totalFsa - resolved} fall back to the province number`,
  ``,
  `Unresolved FSA city names, by FSA count. Quebec administrative regions`,
  `(Monteregie, Capitale-Nationale, Lanaudiere, ...) are NOT cities and cannot`,
  `be resolved; they are expected here. Anything else with a high count is a`,
  `candidate for the ALIAS table in the build script.`,
  ``,
  ...[...unresolved].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(4)}  ${k}`)
].join('\n') + '\n';

if (CHECK) {
  const stale = [];
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== body) stale.push(OUT);
  if (!existsSync(COVERAGE) || readFileSync(COVERAGE, 'utf8') !== coverage) stale.push(COVERAGE);
  if (stale.length) {
    console.error('STALE: ' + stale.map(f => f.replace(ROOT + '/', '')).join(', '));
    console.error('Run: node scripts/build-estimate-bench.mjs');
    process.exit(1);
  }
  console.log(`OK  ${Object.keys(CITY).length} cities, ${resolved}/${totalFsa} FSAs resolved`);
} else {
  writeFileSync(OUT, body);
  writeFileSync(COVERAGE, coverage);
  console.log(`${stats.in} rows in -> ${filtered.length} scored`);
  console.log(`dropped: ${stats.prepaid} prepaid, ${stats.noProvider} no-provider, ${stats.satellite} satellite`);
  console.log(`${Object.keys(CITY).length} cities, ${Object.keys(PROV).length} provinces`);
  console.log(`${resolved}/${totalFsa} FSAs resolved to a city (${pct}%)`);
  console.log(`wrote ${OUT.replace(ROOT + '/', '')} and ${COVERAGE.replace(ROOT + '/', '')}`);
}
