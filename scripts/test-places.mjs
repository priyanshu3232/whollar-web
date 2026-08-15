#!/usr/bin/env node
/* The declarable vocabulary, and everything that has to agree with it.
 *
 *   node --test scripts/test-places.mjs
 *
 * WHY THIS IS A GATE AND NOT A COMMENT. The console stopped accepting free text
 * for coverage, which fixes the input side. It does not fix the other side: a
 * demo seed, a fixture, or a campaign naming "Mississauga Core" when the
 * vocabulary says "Mississauga City Centre" is the same mismatch arriving
 * through a different door, and it renders perfectly while matching nothing.
 *
 * That mismatch is not cosmetic. routes/desk.js requireActiveCoverage() matches
 * a bid to coverage with slug(row.region) === slug(campaign.region), an exact
 * comparison, server side. A campaign whose region is not a name a partner can
 * pick is a campaign nobody can ever bid on. So the rule is stated once, here:
 * every region name any part of this console ships has to BE a region in
 * core/places.js, and a declared one has to sit in a launch city.
 *
 * Replaces test-districts.mjs, which guarded core/districts.js before the
 * picker became city-then-region.
 *
 * The fixtures are a classic browser script, so this evaluates them the way the
 * console does, with a window stub, rather than parsing them by regex.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  PLACES, findCity, isWholeCity, placeOf, readsAs, isLaunchRegion, searchCities
} from '../partner/core/places.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 'North York Central' -> 'north-york-central', the console's own slug rule. */
function slug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const everyRegion = () => PLACES.flatMap((p) => p.regions.map((r) => ({ region: r, place: p })));

/* ------------------------------------------------------------------ *
 * the vocabulary itself
 * ------------------------------------------------------------------ */

test('every place has a city, a province, a launch flag and at least one region', () => {
  PLACES.forEach((p) => {
    assert.ok(p.city && p.city.trim() === p.city, `${p.city}: city is padded or empty`);
    assert.ok(p.province && p.province.trim() === p.province, `${p.city}: province is padded or empty`);
    assert.equal(typeof p.launch, 'boolean', `${p.city}: launch must be a boolean, not ${typeof p.launch}`);
    assert.ok(Array.isArray(p.regions) && p.regions.length, `${p.city}: no regions`);
    p.regions.forEach((r) => {
      assert.ok(r && r.trim() === r, `${p.city}: region "${r}" is padded or empty`);
      assert.ok(slug(r), `${p.city}: region "${r}" slugs to nothing`);
    });
  });
});

test('city and province pairs are unique, and so are the regions inside one city', () => {
  const seen = new Set();
  PLACES.forEach((p) => {
    const key = p.city + '|' + p.province;
    assert.ok(!seen.has(key), `duplicate city: ${key}`);
    seen.add(key);
    const inner = new Set();
    p.regions.forEach((r) => {
      assert.ok(!inner.has(slug(r)), `${p.city}: duplicate region slug ${slug(r)}`);
      inner.add(slug(r));
    });
  });
});

/* The one place the model leaks, pinned so a second leak cannot arrive quietly.
 *
 * coverage_key is `${org_id}:${region-slug}` server side, with no city in it, so
 * two regions sharing a slug are ONE coverage row for any org that declares
 * both. Today that is exactly one pair, in two cities we do not both run, and
 * placeOf() resolves it to the launch one. A third name joining them is a real
 * decision (a city column on provider_coverage) and should turn this red rather
 * than silently making two regions unaddressable. */
test('exactly one region name repeats across cities, and it is the known one', () => {
  const byslug = new Map();
  everyRegion().forEach(({ region, place }) => {
    const k = slug(region);
    byslug.set(k, (byslug.get(k) || []).concat(place.city + ', ' + place.province));
  });
  const collisions = [...byslug.entries()].filter(([, v]) => v.length > 1);
  assert.deepEqual(
    collisions.map(([k]) => k), ['west-end'],
    'a new cross-city region name needs a city column on provider_coverage first'
  );
  assert.equal(collisions[0][1].length, 2, 'and still only in two cities');
});

test('the launch tier is the GTA and everything else is queued behind it', () => {
  const launch = PLACES.filter((p) => p.launch);
  assert.deepEqual(
    launch.map((p) => p.city).sort(),
    ['Brampton', 'Markham', 'Mississauga', 'Richmond Hill', 'Toronto', 'Vaughan'],
    'the launch cities are the GTA six'
  );
  launch.forEach((p) => assert.equal(p.province, 'Ontario', `${p.city} launched outside Ontario`));
  assert.ok(PLACES.length - launch.length >= 100, `queued cities: ${PLACES.length - launch.length}`);
  /* Hamilton and Ottawa read as queued in the coverage table, and the
     vocabulary has to say the same thing or the table contradicts the picker. */
  ['Hamilton', 'Ottawa'].forEach((c) => assert.equal(findCity(c, 'Ontario').launch, false, c));
});

test('a whole-city entry names itself, and only those do', () => {
  PLACES.forEach((p) => {
    if (p.regions.length !== 1) {
      assert.equal(isWholeCity(p), false, `${p.city}: multi-region place read as a whole city`);
      return;
    }
    assert.equal(isWholeCity(p), p.regions[0] === p.city,
      `${p.city}: single region "${p.regions[0]}" disagrees with isWholeCity`);
  });
  assert.equal(isWholeCity(findCity('Oshawa', 'Ontario')), true);
  assert.equal(isWholeCity(findCity('Toronto', 'Ontario')), false);
});

/* ------------------------------------------------------------------ *
 * the lookups the picker and the table are built on
 * ------------------------------------------------------------------ */

test('searchCities filters on city and on province, case insensitively', () => {
  const bramp = searchCities('bramp');
  assert.equal(bramp.length, 1);
  assert.equal(bramp[0].city, 'Brampton');
  assert.deepEqual(searchCities('BRAMP').map((p) => p.city), ['Brampton']);

  /* Province match: a partner typing their province should not get nothing. */
  const bc = searchCities('british columbia');
  assert.ok(bc.length > 40, `BC cities: ${bc.length}`);
  bc.forEach((p) => assert.equal(p.province, 'British Columbia'));

  assert.equal(searchCities('scarberia').length, 0, 'nothing invented matches');
  assert.equal(searchCities('').length, PLACES.length, 'an empty query is the whole list');
});

test('placeOf resolves a region to its city, and prefers the launch one on the collision', () => {
  assert.equal(placeOf('Scarborough Centre').city, 'Toronto');
  assert.equal(placeOf('Kitsilano').city, 'Vancouver');
  assert.equal(placeOf('Oshawa').city, 'Oshawa');
  /* Toronto is a launch city and Vancouver is not, so the shared name resolves
     to the one actually running cohorts. */
  assert.equal(placeOf('West End').city, 'Toronto');
  assert.equal(placeOf('Scarberia'), null, 'an invented region resolves to nothing');
  assert.equal(placeOf(''), null);
});

test('readsAs is the sentence the picker promises, and the table repeats', () => {
  assert.equal(readsAs('Scarborough Centre'), 'Scarborough Centre, Toronto, Ontario');
  assert.equal(readsAs('Kitsilano'), 'Kitsilano, Vancouver, British Columbia');
  /* An unplaceable region reads as itself rather than inventing a city. */
  assert.equal(readsAs('Scarberia'), 'Scarberia');
});

test('only a region in a launch city can be declared', () => {
  assert.equal(isLaunchRegion('Scarborough Centre'), true);
  assert.equal(isLaunchRegion('Brampton East'), true);
  assert.equal(isLaunchRegion('Oshawa'), false, 'a queued city is not declarable');
  assert.equal(isLaunchRegion('Kitsilano'), false);
  assert.equal(isLaunchRegion('Scarberia'), false);
  /* Every region of every launch city, so a city flipped to launch cannot
     leave some of its regions behind. */
  PLACES.filter((p) => p.launch).forEach((p) => {
    p.regions.forEach((r) => assert.equal(isLaunchRegion(r), true, `${p.city}: ${r}`));
  });
});

/* ------------------------------------------------------------------ *
 * everything that has to agree with it
 * ------------------------------------------------------------------ */

/** Run partner/demo/fixtures.js the way the console loads it. */
function fixtures() {
  const src = readFileSync(join(ROOT, 'partner/demo/fixtures.js'), 'utf8');
  /* The stubs the file needs at load. It refuses to install without an api
     object to swap and without a localhost hostname, which is belt two of the
     three keeping fixtures out of production; the stub satisfies both rather
     than working around either. */
  const win = {
    WHOLLAR: { console: { api: { coverage() {}, campaigns() {} } } },
    location: { search: '', hostname: 'localhost' },
    URLSearchParams
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(src, win);
  const f = win.WHOLLAR.console.fixtures;
  assert.ok(f && f.states, 'fixtures installed onto WHOLLAR.console');
  return f.states;
}

test('every fixture coverage row is a real region, and a declared one is in a launch city', () => {
  const states = fixtures();
  let rows = 0;
  Object.keys(states).forEach((name) => {
    const cov = (states[name].coverage && states[name].coverage.coverage) || [];
    cov.forEach((c) => {
      rows++;
      assert.ok(placeOf(c.region), `${name}: "${c.region}" is not in the vocabulary`);
      if (c.slug !== undefined) {
        assert.equal(slug(c.region), c.slug, `${name}: ${c.region} carries the wrong slug`);
      }
      if (c.status !== 'soon') {
        assert.equal(isLaunchRegion(c.region), true,
          `${name}: ${c.region} is declared with status ${c.status}, but its city is queued`);
      }
    });
  });
  assert.ok(rows > 20, `coverage rows checked: ${rows}`);
});

test('every fixture campaign forms in a real region, and its coverage key matches it', () => {
  const states = fixtures();
  let seen = 0;
  Object.keys(states).forEach((name) => {
    const list = (states[name].campaigns && states[name].campaigns.campaigns) || [];
    list.forEach((c) => {
      seen++;
      /* THE one that matters. requireActiveCoverage compares these two slugs
         exactly, so a campaign region a partner cannot pick is a campaign
         nobody can bid on. */
      assert.ok(placeOf(c.region), `${name}: campaign region "${c.region}" is not in the vocabulary`);
      assert.equal(slug(c.coverageRegion || c.region), slug(c.region),
        `${name}: campaign ${c.id} verifies against a different region than it forms in`);
    });
  });
  assert.ok(seen > 5, `campaigns checked: ${seen}`);
});
