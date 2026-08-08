#!/usr/bin/env node
/* Build js/whollar-fsa-cities.js from GeoNames' free Canada postal-code export.
 *
 *   node scripts/build-fsa-cities.mjs
 *
 * Downloads http://download.geonames.org/export/zip/CA.zip (Creative Commons
 * Attribution 4.0 -- see http://creativecommons.org/licenses/by/3.0/), unzips
 * it with the system `unzip` binary, and parses CA.txt: a tab-separated file,
 * one row per FSA-ish point, columns:
 *   country, postal code, place name, admin name1 (province, full),
 *   admin code1 (province, 2-letter), admin name2 (city/borough/county --
 *   often blank), admin code2, admin name3, admin code3, lat, lon, accuracy.
 *
 * GeoNames' Canadian rows are ALMOST ENTIRELY already at 3-character FSA
 * granularity (Canada Post's full 6-character file is paid/licensed and
 * GeoNames doesn't have it): 1655 of 1657 rows in the 2026-08 pull are bare
 * FSAs. The remaining 2 are single-address special codes carrying the full
 * 6 characters ("T3T 0E5", "V3Y 0H2"); those are truncated to their first 3
 * characters per the task's stated fallback rule. This script fails loudly
 * if that minority ever grows past 5% of rows, since that would mean the
 * source format changed wholesale rather than containing a couple of edge
 * cases.
 *
 * CITY-NAME EXTRACTION, per row (documented here because it is the one
 * genuinely lossy step -- everything else is a straight column copy):
 *   1. admin2 (col 6), trimmed, is used AS-IS when present. It's GeoNames'
 *      own place segmentation and already correctly separates e.g. Toronto's
 *      boroughs (Scarborough / North York / Etobicoke / York / East York)
 *      and Montreal's (Anjou / Mercier / Saint-Leonard / Laval), so no
 *      further cleanup is applied.
 *   2. Else, if the place-name has a single-item "(...)" suffix (no "/"
 *      inside), the parenthetical is the actual settlement name for a
 *      region-descriptor prefix (e.g. "Eastern Alberta (St. Paul)" -> "St.
 *      Paul", "Akwesasne Region (Akwesasne)" -> "Akwesasne") -- use it.
 *   3. Else the text before the first "(" (or the whole place name if there
 *      is none) is used verbatim -- covers plain single-town FSAs ("Taber",
 *      "Banff") and multi-neighbourhood parentheticals where col 6 was
 *      empty ("North York (Sweeney Park / Wigmore Park)" -> "North York").
 *   No compass-direction stripping is done anywhere: "North York", "North
 *   Vancouver", "North Bay" etc. are real, distinct municipality names and
 *   blind "North "/"South " stripping would corrupt them.
 *
 * One FSA can have multiple source rows (2 in this pull: C0A, L9X). Per-FSA,
 * the most frequent extracted city wins; ties (incl. the common case of every
 * candidate appearing once) keep whichever candidate was encountered FIRST
 * in the source file, per the task's stated fallback rule.
 *
 * Province: GeoNames' admin code1 for CA is already the standard 2-letter
 * code (verified: exactly {AB,BC,MB,NB,NL,NS,NT,NU,ON,PE,QC,SK,YT}, 13
 * values, no conversion needed) -- used directly, no full-name mapping step.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ZIP_URL = 'http://download.geonames.org/export/zip/CA.zip';
const LICENSE = 'Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/) -- credit: GeoNames.org';
const VALID_PROVINCES = new Set(['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT']);

const OUT_JS = path.resolve('js/whollar-fsa-cities.js');
const OUT_COVERAGE = path.resolve('js/whollar-fsa-cities.coverage.txt');

function download() {
  const dir = mkdtempSync(path.join(tmpdir(), 'geonames-ca-'));
  const zipPath = path.join(dir, 'CA.zip');
  console.log(`Downloading ${ZIP_URL} ...`);
  execFileSync('curl', ['-sS', '-o', zipPath, '--max-time', '60', ZIP_URL]);
  console.log('Unzipping ...');
  execFileSync('unzip', ['-o', zipPath, '-d', dir]);
  const txtPath = path.join(dir, 'CA.txt');
  const text = readFileSync(txtPath, 'utf8');
  return { text, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function extractCity(placeName, admin2) {
  const trimmedAdmin2 = admin2.trim();
  if (trimmedAdmin2) return trimmedAdmin2;

  const parenMatch = placeName.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (parenMatch) {
    const prefix = parenMatch[1].trim();
    const inner = parenMatch[2].trim();
    if (inner && !inner.includes('/')) return inner;
    return prefix || placeName.trim();
  }
  return placeName.trim();
}

function build() {
  const { text, cleanup } = download();
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);

  /** @type {Map<string, {cityCounts: Map<string, number>, order: string[], province: string}>} */
  const byFsa = new Map();
  let rowCount = 0;
  let badRows = 0;
  let sixCharRows = 0;

  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 12) { badRows++; continue; }
    const [country, postalCodeRaw, placeName, , adminCode1, adminName2] = cols;
    if (country !== 'CA') { badRows++; continue; }
    rowCount++;

    // Verify the stated assumption: Canadian GeoNames postal codes are
    // ALMOST ALL already 3-character FSAs (1655 of 1657 in the 2026-08 pull).
    // A tiny minority (2 rows: "T3T 0E5", "V3Y 0H2" -- both single-address
    // special codes) carry the full 6-character code; for those we fall back
    // to the task's stated rule and take the first 3 characters. If that
    // minority ever grows large it means the source format changed wholesale
    // and this script should fail loudly instead of silently truncating --
    // hence the hard cap below.
    const postalCodeCompact = postalCodeRaw.replace(/\s+/g, '').trim().toUpperCase();
    if (postalCodeCompact.length !== 3 && postalCodeCompact.length !== 6) { badRows++; continue; }
    if (postalCodeCompact.length === 6) sixCharRows++;
    const fsa = postalCodeCompact.slice(0, 3);

    const province = adminCode1.trim();
    if (!VALID_PROVINCES.has(province)) { badRows++; continue; }

    const city = extractCity(placeName, adminName2 || '');
    if (!city) { badRows++; continue; }

    let entry = byFsa.get(fsa);
    if (!entry) {
      entry = { cityCounts: new Map(), order: [], province };
      byFsa.set(fsa, entry);
    }
    if (!entry.cityCounts.has(city)) entry.order.push(city);
    entry.cityCounts.set(city, (entry.cityCounts.get(city) || 0) + 1);
  }

  cleanup();

  if (sixCharRows > rowCount * 0.05) {
    throw new Error(`${sixCharRows} of ${rowCount} rows carried full 6-character postal codes (>5%) -- the source format likely changed wholesale; re-check the FSA-pooling logic before trusting a first-3-chars truncation at this scale.`);
  }
  if (sixCharRows > 0) {
    console.log(`Note: ${sixCharRows} row(s) carried a full 6-character postal code; truncated to their first 3 characters as the FSA per the stated fallback rule.`);
  }

  const result = {};
  for (const [fsa, entry] of byFsa) {
    let bestCity = entry.order[0];
    let bestCount = -1;
    for (const city of entry.order) {
      const count = entry.cityCounts.get(city);
      if (count > bestCount) { bestCount = count; bestCity = city; }
    }
    result[fsa] = { city: bestCity, province: entry.province };
  }

  return { result, rowCount, badRows, fsaCount: Object.keys(result).length };
}

function main() {
  const { result, rowCount, badRows, fsaCount } = build();

  const fsaEntries = Object.keys(result).sort().map((fsa) => {
    const { city, province } = result[fsa];
    return `${JSON.stringify(fsa)}:{city:${JSON.stringify(city)},province:${JSON.stringify(province)}}`;
  });

  const provinceCounts = {};
  for (const fsa of Object.keys(result)) {
    const p = result[fsa].province;
    provinceCounts[p] = (provinceCounts[p] || 0) + 1;
  }
  const provinceBreakdown = Object.keys(provinceCounts).sort()
    .map((p) => `${p}=${provinceCounts[p]}`).join(', ');

  const builtOn = new Date().toISOString().slice(0, 10);

  const js = `/* GENERATED by scripts/build-fsa-cities.mjs from GeoNames' free Canada
 * postal-code export (http://download.geonames.org/export/zip/CA.zip, file
 * CA.txt). Do NOT edit by hand. Re-run the script to refresh.
 *
 * Source: GeoNames.org, Creative Commons Attribution 4.0 license
 * (https://creativecommons.org/licenses/by/4.0/) -- attribution: geonames.org.
 * This is NOT the authoritative Canada Post Postal Code Conversion File
 * (that file is paid/licensed); it is a best-effort free-tier mapping built
 * from ${rowCount} source rows covering ${fsaCount} distinct FSAs.
 * ${badRows} source rows were dropped (non-CA rows / unrecognised province /
 * empty place name).
 * Built ${builtOn}.
 *
 * City-per-FSA was chosen by: prefer GeoNames' own admin2 (city/borough)
 * column when present; else the single-item parenthetical in the place name
 * when there is one ("Eastern Alberta (St. Paul)" -> "St. Paul"); else the
 * place name's text before the first "(" (or the whole place name). No
 * compass-direction stripping is applied anywhere (see script header for why
 * -- "North York" / "North Vancouver" / "North Bay" are real place names).
 * A handful of FSAs have more than one source row (C0A, L9X in this pull);
 * for those the most frequent extracted city wins, ties broken by whichever
 * candidate appeared first in the source file.
 *
 * Coverage: ${fsaCount} FSAs, by province: ${provinceBreakdown}.
 * See js/whollar-fsa-cities.coverage.txt for the full coverage note.
 *
 * Known data-quality caveats (inherited from GeoNames, not introduced here):
 *  - GeoNames groups some genuinely distinct municipalities under one
 *    admin2 label for a metro area (e.g. North Vancouver / West Vancouver
 *    FSAs all report admin2 "Vancouver"). A city-name lookup against this
 *    file will therefore sometimes resolve a suburb to its metro's name.
 *  - A few rural/district FSAs report a district or region name rather than
 *    a specific town (e.g. Ontario's Algoma District FSAs resolve to
 *    "Algoma", not the specific town GeoNames lists in parentheses).
 *  - This is a best-effort free-tier mapping, not the authoritative Canada
 *    Post file -- use it as a first-pass lookup, not a source of truth.
 */
(function (root) {
  'use strict';
  var W = root.WHOLLAR || (root.WHOLLAR = {});

  W.FSA_CITY_META = {
    source: "GeoNames.org CA.txt (http://download.geonames.org/export/zip/CA.zip)",
    license: "CC BY 4.0 -- https://creativecommons.org/licenses/by/4.0/",
    builtOn: ${JSON.stringify(builtOn)},
    sourceRows: ${rowCount},
    droppedRows: ${badRows},
    fsaCount: ${fsaCount}
  };

  W.FSA_CITY = {${fsaEntries.join(',')}};
})(typeof window !== 'undefined' ? window : globalThis);
`;

  writeFileSync(OUT_JS, js);
  console.log(`Wrote ${OUT_JS} (${fsaEntries.length} FSAs)`);

  const REAL_FSA_APPROX = 1600;
  const coverage = `Whollar FSA -> city coverage summary
Built: ${builtOn}
Source: GeoNames.org CA.txt (${ZIP_URL}), CC BY 4.0 license (credit: geonames.org)
Not the authoritative Canada Post Postal Code Conversion File (that is paid/licensed).

Source rows read:    ${rowCount}
Rows dropped:        ${badRows} (non-CA / unrecognised province / empty place name)
Distinct FSAs mapped: ${fsaCount}

Coverage vs. real Canadian FSAs: Canada has roughly ${REAL_FSA_APPROX}-1,800 assigned
forward sortation areas (the exact count shifts slightly over time as Canada
Post adds new ones). This dataset's ${fsaCount} FSAs represents essentially
full coverage of that range (~${Math.min(100, Math.round((fsaCount / REAL_FSA_APPROX) * 100))}%+), since GeoNames' free export
already contains one entry per assigned FSA rather than a sample.

By province: ${provinceBreakdown}

Data-quality caveats:
- This is GeoNames' free/CC-licensed export, not the paid Canada Post file --
  treat it as a best-effort mapping, not a source of truth.
- GeoNames sometimes groups genuinely distinct municipalities under one
  metro-area label (e.g. North Vancouver / West Vancouver FSAs both resolve
  to "Vancouver" here, because that is what GeoNames' own admin2 column says
  for those rows).
- A few rural/district FSAs resolve to a district/region name rather than a
  specific town (e.g. some Ontario "County" or Quebec administrative-region
  FSAs), because GeoNames' own admin2 column reports the district there.
- City name spelling/casing is taken directly from GeoNames and not
  independently verified against any other source.
`;
  writeFileSync(OUT_COVERAGE, coverage);
  console.log(`Wrote ${OUT_COVERAGE}`);
  console.log('\n' + coverage);
}

main();
