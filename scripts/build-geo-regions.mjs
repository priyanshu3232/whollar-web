#!/usr/bin/env node
/* Turn a named Whollar region into a candidate set of FSAs, from boundaries.
 *
 *   node scripts/build-geo-regions.mjs --derive --sources <dir>
 *   node scripts/build-geo-regions.mjs --check
 *
 * WHAT THIS REPLACES. A hand-typed FSA list, which is possible and
 * unverifiable: nothing about "M2M,M2N,M2R" on a campaign row says whether
 * anybody checked, against what, or when. This produces the same list with a
 * boundary behind every entry, two percentages saying how much of what, and a
 * source string that can be re-fetched and checksummed.
 *
 * WHAT IT DOES NOT DO. It does not decide. Everything here is a PROPOSAL:
 * lib/georegions.js is candidates, and an operator confirms the set before a
 * single FSA reaches a campaign. Two things in this pipeline are judgement and
 * are deliberately left to a person:
 *
 *   which source features make up a region   data/geo-regions.json
 *   which candidate FSAs are in              the admin review screen
 *
 * WHY BUILD TIME. The FSA boundary file is 162MB zipped and 297MB of geometry
 * unzipped. A Catalyst function that loaded it per request would be the wrong
 * shape twice over: it is a serverless function with a memory ceiling, and the
 * answer does not change between deploys. Every comparable thing in this repo
 * is already a generator with a --check gate (build-places, build-fsa-cities,
 * build-fsa-ref, build-mixmath) and this is the same trade.
 *
 * WHAT --check CAN AND CANNOT PROVE, stated plainly because the difference
 * matters. It CANNOT re-derive: CI has no 300MB boundary file and this repo's
 * frontend gate is install-free on purpose. What it proves is that the
 * committed module matches the committed mapping, that every region named in
 * it is a real region in lib/places.js, that every FSA in it is one in
 * lib/fsaref.js, and that the source checksums have not been edited away from
 * the file they were derived from. Re-derivation is a --derive run by a human
 * with the sources on disk, and the diff is the review.
 *
 * ------------------------------------------------------------------
 * ON MEASURING AREA IN A PROJECTION
 *
 * The boundary file is EPSG:3347 (Statistics Canada Lambert), metres, so an
 * area is a shoelace sum. It is NOT an exact area on the ground: Lambert's
 * standard parallels are 49 and 77 north, and at Toronto's 43.7 the scale
 * factor runs about 2.5% long in each direction. Measured against the boundary
 * file's own LANDAREA column, shoelace comes out about 5% high on Toronto
 * FSAs, which is that distortion plus the inland water LANDAREA excludes.
 *
 * That is why coverage is reported as a RATIO and never as a number of square
 * kilometres. Two areas measured in the same projection within one city cancel
 * their distortion almost exactly, so coverage_pct is sound to a fraction of
 * a point. Anywhere an absolute area is wanted, the source's own LANDAREA is
 * used instead of anything computed here: that is what feeds the large-rural
 * FSA flag, where being 5% wrong about 900 square kilometres would matter.
 * ------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, existsSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { readDbf, readPolygons } from './lib/shapefile.mjs';
import {
  toLambert, polygonArea, shapesArea, bbox, bboxOverlap,
  sampleIntersectionArea, nearlyTouches,
} from './lib/geometry.mjs';
import { backend } from './backend-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_FILE = join(ROOT, 'data/geo-regions.json');
const OUT = join(ROOT, 'catalyst-backend/functions/auth/src/lib/georegions.js');

const places = backend('lib/places.js');
const fsaref = backend('lib/fsaref.js');
const geo = backend('lib/geo.js');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const flag = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i < 0 || !argv[i + 1] || argv[i + 1].startsWith('--') ? d : argv[i + 1];
};

/* CONFIRM-11 and CONFIRM-12, as one place rather than three. */
const INCLUDE_THRESHOLD = Number(flag('include', '50'));
const REVIEW_THRESHOLD = Number(flag('review', '10'));
const REGION_SHARE_REVIEW = 5;
const AREA_CAP_KM2 = Number(flag('area-cap', '500'));
/* Metres. See sampleIntersectionArea on why this is not finer. */
const GRID_M = Number(flag('grid', '100'));
/* Metres of slack on the adjacency check. Deliberately generous. */
const TOUCH_TOL_M = 250;

const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

/* ------------------------------------------------------------------ *
 * the mapping
 * ------------------------------------------------------------------ */

function readMapping() {
  const raw = readFileSync(MAP_FILE, 'utf8');
  const map = JSON.parse(raw);
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);

  for (const name of Object.keys(map.regions)) {
    /* THE VOCABULARY IS THE KEY. A region here that is not a region a partner
       can declare coverage in is a region no cohort can be bid on, and the
       failure is silent for the life of the auction. Same gate as
       POST /admin/campaigns, for the same reason. */
    if (!places.isLaunchRegion(name)) {
      const near = places.suggest(name);
      die(`data/geo-regions.json names "${name}", which is not a declarable region.`
        + (near.length ? ` Did you mean ${near.join(', ')}?` : '')
        + '\n  The vocabulary is partner/core/places.js.');
    }
  }
  return { map, hash };
}

/** Regions with at least one source feature chosen. The rest are not ready. */
function resolvable(map) {
  const ready = [];
  const pending = [];
  for (const [name, r] of Object.entries(map.regions)) {
    if (r.source && Array.isArray(r.features) && r.features.length) ready.push([name, r]);
    else pending.push([name, r]);
  }
  return { ready, pending };
}

/* ------------------------------------------------------------------ *
 * derive
 * ------------------------------------------------------------------ */

const sha256File = (p) => new Promise((res, rej) => {
  const h = createHash('sha256');
  createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex')))
    .on('error', rej);
});

/* Statistics Canada province identifiers, for the ones this vocabulary
   reaches. Narrowing the FSA scan is the only thing this is for; an unknown
   source simply scans the country, which is correct and slower. */
const PRUID = { ON: '35', QC: '24', BC: '59', AB: '48' };

/** Which province a region's source dataset covers, or null for all of them. */
function provinceOf(spec, map) {
  const src = (spec.source && map.sources[spec.source]) || null;
  return (src && src.province && PRUID[src.province]) || null;
}

/** GeoJSON feature -> rings in EPSG:3347. Polygon and MultiPolygon only. */
function featureToLambert(f) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates]
    : g.type === 'MultiPolygon' ? g.coordinates
      : die(`geometry type ${g.type} is not a polygon`);
  const out = [];
  for (const rings of polys) out.push(rings.map((r) => r.map(([lon, lat]) => toLambert(lon, lat))));
  return out;
}

async function derive() {
  const dir = flag('sources');
  if (!dir) die('--sources <dir> is required with --derive: the directory holding the boundary files.');
  const { map, hash } = readMapping();
  const { ready, pending } = resolvable(map);

  if (!ready.length) {
    die('No region in data/geo-regions.json has any source features chosen yet.\n'
      + '  That is the operator input this whole pipeline runs on, and it is not a guess:\n'
      + '  see the note in that file. Nothing can be derived until at least one is set.');
  }

  /* ---- FSA geometry, filtered to the provinces in play ---- */
  const base = join(dir, 'lfsa000b21a_e', 'lfsa000b21a_e');
  if (!existsSync(base + '.shp')) {
    die(`${base}.shp is not there. Download and unzip:\n  ${map.sources['statcan-fsa-2021'].url}`);
  }
  const zip = join(dir, 'lfsa.zip');
  if (existsSync(zip)) {
    const sum = await sha256File(zip);
    if (sum !== map.sources['statcan-fsa-2021'].sha256) {
      die(`The boundary zip does not match the checksum in data/geo-regions.json.\n`
        + `  recorded ${map.sources['statcan-fsa-2021'].sha256}\n  on disk   ${sum}\n`
        + '  Either the source republished, in which case update the checksum and the\n'
        + '  retrieval date deliberately, or this is not the file it says it is.');
    }
    console.log(`  boundary file checksum matches (${sum.slice(0, 16)}…)`);
  }

  const dbf = readDbf(base + '.dbf');
  console.log(`  ${dbf.rows.length} FSAs in the boundary file`);

  /* ---- each region, one at a time ---- */
  const regions = {};
  const sourceCache = new Map();

  for (const [name, spec] of ready) {
    const src = map.sources[spec.source];
    if (!src) die(`"${name}" names source "${spec.source}", which is not in the sources block.`);

    if (!sourceCache.has(spec.source)) {
      const file = join(dir, `${spec.source}.geojson`);
      if (!existsSync(file)) die(`${file} is not there. Fetch:\n  ${src.url}`);
      sourceCache.set(spec.source, JSON.parse(readFileSync(file, 'utf8')));
    }
    const gj = sourceCache.get(spec.source);

    const chosen = [];
    for (const id of spec.features) {
      const f = gj.features.find((x) => String(x.properties[src.idField]) === String(id));
      if (!f) {
        die(`"${name}" names feature ${src.idField}=${id}, which is not in ${spec.source}.\n`
          + '  A feature id that does not resolve is a region with a hole in it, silently.');
      }
      chosen.push({ id: String(id), name: f.properties[src.nameField], shapes: featureToLambert(f) });
    }
    const regionShapes = chosen.flatMap((c) => c.shapes);
    const regionArea = shapesArea(regionShapes);
    const rb = bbox(regionShapes);

    /* THE PROVINCE FIRST, from the attribute table, before a byte of geometry
       is read. The .shp is 297MB and a region touches a few dozen FSAs; the
       .dbf is 155KB and already says which province each one is in. Reading
       every polygon in Canada to keep forty is the difference between a
       second and a minute, and between a few megabytes held and a few
       hundred. `spec.province` narrows it further where a mapping says so. */
    const pruid = spec.pruid || provinceOf(spec, map);
    const wanted = [];
    for (let i = 0; i < dbf.rows.length; i += 1) {
      const row = dbf.rows[i];
      if (!row || !row.CFSAUID) continue;
      if (pruid && row.PRUID !== pruid) continue;
      wanted.push(i);
    }
    const want = new Set(wanted);
    const polys = readPolygons(base + '.shp', base + '.shx', (i) => want.has(i));

    const candidates = [];
    for (const i of wanted) {
      const rings = polys.get(i);
      if (!rings) continue;
      const shapes = [rings];
      if (!bboxOverlap(bbox(shapes), rb)) continue;
      const fsa = dbf.rows[i].CFSAUID;
      const fsaArea = polygonArea(rings);
      const { area: shared, samples } = sampleIntersectionArea(regionShapes, shapes, GRID_M);
      if (!shared) continue;

      /* Both ratios, in the same projection, so the distortion cancels. */
      const coveragePct = (shared / fsaArea) * 100;
      const regionSharePct = (shared / regionArea) * 100;
      /* The SOURCE's own land area, not the shoelace: this one is compared
         against an absolute threshold, where being 5% long would matter. */
      const landAreaKm2 = Number(dbf.rows[i].LANDAREA);

      let status = coveragePct >= INCLUDE_THRESHOLD ? 'included'
        : (coveragePct >= REVIEW_THRESHOLD || regionSharePct >= REGION_SHARE_REVIEW) ? 'pending'
          : 'excluded';
      const flags = [];
      if (status === 'included' && landAreaKm2 > AREA_CAP_KM2) {
        status = 'pending';
        flags.push(`${fsa} covers ${Math.round(landAreaKm2)} km². Including it makes households far outside ${name} eligible.`);
      }
      candidates.push({
        fsa,
        coveragePct: Number(coveragePct.toFixed(2)),
        regionSharePct: Number(regionSharePct.toFixed(2)),
        landAreaKm2: Number(landAreaKm2.toFixed(2)),
        status,
        flags,
        samples,
      });
    }
    candidates.sort((a, b) => b.coveragePct - a.coveragePct || a.fsa.localeCompare(b.fsa));

    /* Adjacency: an included FSA touching neither the region nor another
       included FSA is almost always a mis-resolution, not a finding. */
    const included = candidates.filter((c) => c.status === 'included');
    for (const c of included) {
      const i = wanted.find((k) => dbf.rows[k].CFSAUID === c.fsa);
      const mine = [polys.get(i)];
      const touches = nearlyTouches(mine, regionShapes, TOUCH_TOL_M)
        || included.some((o) => o !== c
          && nearlyTouches(mine, [polys.get(wanted.find((k) => dbf.rows[k].CFSAUID === o.fsa))], TOUCH_TOL_M));
      if (!touches) {
        c.status = 'pending';
        c.flags.push(`${c.fsa} touches neither ${name} nor any other included area. That is usually a wrong match, not an island.`);
      }
    }

    regions[places.canonical(name)] = {
      features: chosen.map((c) => ({ id: c.id, name: c.name })),
      source: spec.source,
      candidates,
    };
    const inc = candidates.filter((c) => c.status === 'included').map((c) => c.fsa);
    const pend = candidates.filter((c) => c.status === 'pending').map((c) => c.fsa);
    console.log(`  ${name}: ${inc.length} included (${inc.join(',') || 'none'}), ${pend.length} for review (${pend.join(',') || 'none'})`);
  }

  emit({ map, hash, regions, pending });
}

/* ------------------------------------------------------------------ *
 * emit
 * ------------------------------------------------------------------ */

function emit({ map, hash, regions, pending }) {
  const names = Object.keys(regions).sort();
  const body = `'use strict';

/**
 * GENERATED by scripts/build-geo-regions.mjs from data/geo-regions.json. Do NOT
 * edit by hand. Re-derive and commit the result; the --check gate holds this
 * file to the mapping it came from.
 *
 * CANDIDATE FSA sets for ${names.length} region(s), derived by intersecting each
 * region's source boundaries against the Statistics Canada Forward Sortation
 * Area boundary file.
 *
 * THIS IS A PROPOSAL AND NOT A COVERAGE SET. Nothing in this file reaches a
 * campaign. An operator confirms a region in the admin console, and the
 * confirmed set is what is written to campaigns.fsas. A candidate marked
 * 'included' is what the geometry says; whether it is what Whollar means is a
 * market decision, which is what the review screen is for.
 *
 * Thresholds used: include at ${INCLUDE_THRESHOLD}% of the FSA inside the region, review from
 * ${REVIEW_THRESHOLD}%, or from ${REGION_SHARE_REVIEW}% of the region. Any FSA over ${AREA_CAP_KM2} km² of land goes to
 * review whatever its coverage.
 *
 * COVERAGE IS A RATIO, NEVER AN AREA. Both figures are computed in EPSG:3347,
 * where Toronto sits about 2.5% off scale in each direction, so an absolute
 * area from this pipeline would read about 5% long. A ratio of two areas in
 * one projection in one city cancels that almost exactly. landAreaKm2 is the
 * one absolute figure here and it is the SOURCE's own LANDAREA column, not
 * anything computed, because it is the one compared against a fixed threshold.
 *
 * Intersection areas are sampled on a ${GRID_M} metre grid rather than clipped. See
 * scripts/lib/geometry.mjs for why, and for what that costs (a fraction of a
 * percentage point, against thresholds of ${INCLUDE_THRESHOLD} and ${REVIEW_THRESHOLD}).
 *
 * Sources:
${Object.entries(map.sources).map(([k, s]) =>
    ` *   ${k}\n *     ${s.title}\n *     ${s.url}\n *     retrieved ${s.retrieved}${s.sha256 ? `, sha256 ${s.sha256}` : ''}`).join('\n')}
 *
 * Mapping hash: ${hash}
${pending.length ? ` *\n * NOT DERIVED, because no source features are chosen yet:\n${pending.map(([n]) => ` *   ${n}`).join('\n')}` : ''}
 */

const REGIONS = ${JSON.stringify(regions, null, 2).split('\n').join('\n')};

/** The mapping this was derived from, so a drift check has something to read. */
const MAPPING_HASH = ${JSON.stringify(hash)};

/** Every region with candidates, canonical names. */
const all = () => Object.keys(REGIONS);

/** One region's proposal, or null. Never a coverage set: see the header. */
const candidatesFor = (region) => REGIONS[region] || null;

/** What the derivation would include, if nobody looked. The review screen's
 *  starting position and nothing more. */
function proposedFsas(region) {
  const r = REGIONS[region];
  if (!r) return [];
  return r.candidates.filter((c) => c.status === 'included').map((c) => c.fsa);
}

module.exports = {
  REGIONS, MAPPING_HASH, all, candidatesFor, proposedFsas,
  THRESHOLDS: Object.freeze({
    include: ${INCLUDE_THRESHOLD}, review: ${REVIEW_THRESHOLD},
    regionShare: ${REGION_SHARE_REVIEW}, areaCapKm2: ${AREA_CAP_KM2}, gridMetres: ${GRID_M},
  }),
};
`;
  writeFileSync(OUT, body);
  console.log(`\nWrote ${OUT} (${names.length} region(s), mapping ${hash}).`);
}

/* ------------------------------------------------------------------ *
 * check
 * ------------------------------------------------------------------ */

function check() {
  const { map, hash } = readMapping();
  const { ready, pending } = resolvable(map);

  if (!existsSync(OUT)) {
    if (!ready.length) {
      console.log('OK: no region has source features chosen yet, and nothing is derived.');
      console.log(`     ${pending.length} region(s) awaiting an operator: ${pending.map(([n]) => n).join(', ')}`);
      return;
    }
    console.error(`STALE: ${OUT} does not exist but ${ready.length} region(s) are resolvable.`);
    console.error('Run: node scripts/build-geo-regions.mjs --derive --sources <dir>');
    process.exit(1);
  }

  const mod = backend('lib/georegions.js');
  if (mod.MAPPING_HASH !== hash) {
    console.error(`STALE: data/geo-regions.json has changed since lib/georegions.js was derived.`);
    console.error(`  mapping   ${hash}\n  generated ${mod.MAPPING_HASH}`);
    console.error('Re-derive with the boundary sources on disk and commit the diff.');
    process.exit(1);
  }

  /* Both vocabularies, both directions. A region here that is not declarable
     is a cohort nobody can bid on; an FSA here that is not in the reference is
     a cohort nobody can join. Neither is visible from any screen. */
  for (const region of mod.all()) {
    if (!places.isLaunchRegion(region)) {
      console.error(`STALE: lib/georegions.js proposes "${region}", which is not a declarable region.`);
      process.exit(1);
    }
    for (const c of mod.candidatesFor(region).candidates) {
      if (!geo.isFsa(c.fsa) || !fsaref.has(c.fsa)) {
        console.error(`STALE: "${region}" proposes ${c.fsa}, which is not an FSA in lib/fsaref.js.`);
        process.exit(1);
      }
    }
  }
  const derived = mod.all().length;
  console.log(`OK: ${derived} region(s) derived and current, ${pending.length} awaiting an operator.`);
  if (pending.length) console.log(`     ${pending.map(([n]) => n).join(', ')}`);
}

/* ------------------------------------------------------------------ */

if (has('derive')) await derive();
else if (has('check')) check();
else {
  console.log(`
  node scripts/build-geo-regions.mjs --derive --sources <dir>
  node scripts/build-geo-regions.mjs --check

  --sources needs the unzipped StatCan FSA boundary file and one .geojson per
  source named in data/geo-regions.json. See that file for the URLs.

  Options: --include ${INCLUDE_THRESHOLD}  --review ${REVIEW_THRESHOLD}  --area-cap ${AREA_CAP_KM2}  --grid ${GRID_M}
`);
}
