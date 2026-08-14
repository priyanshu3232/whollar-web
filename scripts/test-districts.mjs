#!/usr/bin/env node
/* The declarable vocabulary, and everything that has to agree with it.
 *
 *   node --test scripts/test-districts.mjs
 *
 * WHY THIS IS A GATE AND NOT A COMMENT. The console stopped accepting free
 * text for coverage, which fixes the input side. It does not fix the other
 * side: a demo seed, a fixture, or a campaign naming "Mississauga Core" when
 * the vocabulary says "Mississauga City Centre" is the same mismatch arriving
 * through a different door, and it renders perfectly while matching nothing.
 * So the rule is stated once, here: every region name any part of this console
 * ships has to BE a district, and a declared one has to be a launch district.
 *
 * The fixtures are a classic browser script, so this evaluates them the way
 * the console does, with a window stub, rather than parsing them by regex.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { DISTRICTS, byName, search, grouped } from '../partner/core/districts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 'North York Central' -> 'north-york-central', the console's own slug rule. */
function slug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* ------------------------------------------------------------------ *
 * the vocabulary itself
 * ------------------------------------------------------------------ */

test('every district has an id, a name, a municipality and a known tier', () => {
  DISTRICTS.forEach((d) => {
    assert.match(d.id, /^[a-z0-9-]+$/, `${d.id}: ids are the wire form, keep them url safe`);
    assert.ok(d.name && d.name.trim() === d.name, `${d.id}: name is padded or empty`);
    assert.ok(d.muni && d.muni.trim() === d.muni, `${d.id}: municipality is padded or empty`);
    assert.ok(d.tier === 'launch' || d.tier === 'soon', `${d.id}: tier ${d.tier}`);
  });
});

test('ids, names and slugs are each unique', () => {
  ['id', 'name'].forEach((key) => {
    const seen = new Set();
    DISTRICTS.forEach((d) => {
      assert.ok(!seen.has(d[key]), `duplicate ${key}: ${d[key]}`);
      seen.add(d[key]);
    });
  });
  /* Slug collision matters more than name collision: coverage_key is
     `${org_id}:${region-slug}` server side, so two districts sharing a slug
     would be one coverage row wearing two names. */
  const slugs = new Set();
  DISTRICTS.forEach((d) => {
    assert.ok(!slugs.has(slug(d.name)), `duplicate slug: ${slug(d.name)}`);
    slugs.add(slug(d.name));
  });
});

test('the launch tier is the GTA and the soon tier is everything queued behind it', () => {
  const launch = DISTRICTS.filter((d) => d.tier === 'launch');
  const soon = DISTRICTS.filter((d) => d.tier === 'soon');
  assert.ok(launch.length >= 30, `launch districts: ${launch.length}`);
  assert.ok(soon.length >= 10, `soon districts: ${soon.length}`);
  /* Hamilton and Ottawa read as queued in the coverage table already, and the
     vocabulary has to say the same thing or the table contradicts the picker. */
  ['Hamilton', 'Ottawa'].forEach((n) => assert.equal(byName(n).tier, 'soon', n));
});

test('search filters on name and on municipality, case insensitively', () => {
  const scar = search('scar');
  assert.equal(scar.length, 4, 'four Scarborough districts');
  scar.forEach((d) => assert.equal(d.muni, 'Scarborough'));
  assert.deepEqual(search('SCAR').map((d) => d.id), scar.map((d) => d.id));

  /* Two Vaughan districts do not carry the word Vaughan. Matching name only
     would answer a reasonable query with an empty list. */
  const vaughan = search('vaughan').map((d) => d.name);
  assert.ok(vaughan.includes('Maple and VMC'), 'municipality match reaches Maple and VMC');
  assert.ok(vaughan.includes('Kleinburg'), 'and Kleinburg');

  assert.equal(search('scarberia').length, 0, 'nothing invented matches');
  assert.equal(search('').length, DISTRICTS.length, 'an empty query is the whole list');
});

test('grouping keeps vocabulary order and puts each district under one municipality', () => {
  const groups = grouped(search('scar'));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].muni, 'Scarborough');
  assert.equal(groups[0].rows.length, 4);

  const all = grouped(DISTRICTS);
  const flat = all.reduce((n, g) => n + g.rows.length, 0);
  assert.equal(flat, DISTRICTS.length, 'no district is dropped or duplicated by grouping');
  assert.equal(all[0].muni, 'Scarborough', 'order is the vocabulary order, not alphabetical');
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

test('every fixture coverage row is a district, and a declared one is a launch district', () => {
  const states = fixtures();
  let rows = 0;
  Object.keys(states).forEach((name) => {
    const cov = (states[name].coverage && states[name].coverage.coverage) || [];
    cov.forEach((c) => {
      rows++;
      const d = byName(c.region);
      assert.ok(d, `${name}: "${c.region}" is not in the vocabulary`);
      assert.equal(slug(c.region), c.slug, `${name}: ${c.region} carries the wrong slug`);
      if (c.status !== 'soon') {
        assert.equal(d.tier, 'launch',
          `${name}: ${c.region} is declared with status ${c.status}, but it is queued for launch`);
      }
    });
  });
  assert.ok(rows > 20, `coverage rows checked: ${rows}`);
});

test('every fixture campaign forms in a district, and its coverage key matches its region', () => {
  const states = fixtures();
  let seen = 0;
  Object.keys(states).forEach((name) => {
    const list = (states[name].campaigns && states[name].campaigns.campaigns) || [];
    list.forEach((c) => {
      seen++;
      assert.ok(byName(c.region), `${name}: campaign region "${c.region}" is not a district`);
      assert.equal(slug(c.coverageRegion || c.region), slug(c.region),
        `${name}: campaign ${c.id} verifies against a different region than it forms in`);
    });
  });
  assert.ok(seen > 5, `campaigns checked: ${seen}`);
});
