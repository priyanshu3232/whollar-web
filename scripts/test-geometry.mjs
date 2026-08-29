#!/usr/bin/env node
/* The geometry a cohort's coverage is derived from.
 *
 *   node --test scripts/test-geometry.mjs
 *
 * WHY THIS IS A GATE. scripts/lib/geometry.mjs is written by hand, because a
 * polygon library would be a dependency in a gate that is install-free on
 * purpose. Hand-written geometry is exactly the kind of code whose bugs are
 * invisible: a projection with a sign error, a shoelace that counts a hole
 * twice, a point-in-polygon that misses a vertical edge. None of those would
 * throw. They would quietly scope a cohort wrong, and the first symptom would
 * be a household in the wrong region on a partner's desk.
 *
 * The fixtures are synthetic and exact, so every assertion here has an answer
 * that can be checked by hand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toLambert, ringArea, polygonArea, shapesArea, bbox, bboxOverlap,
  inShapes, sampleIntersectionArea, nearlyTouches,
} from './lib/geometry.mjs';

/* A square as one POLYGON, which is an array of rings. Wound so that
   ringArea() reads it negative, which is the orientation an outer boundary has
   in this file's convention; reversing it makes a hole. Which sign means which
   is asserted below rather than assumed, because getting it backwards would
   inflate every area that contains a park instead of shrinking it. */
const square = (x, y, s) => [[[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]];
/* And the same square as SHAPES, which is an array of polygons: a region built
   of five neighbourhoods is shapes, one neighbourhood is a polygon. Keeping
   the two straight is most of the surface area for a mistake in here. */
const shape = (x, y, s) => [square(x, y, s)];
const near = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

/* ------------------------------------------------------------------ *
 * area
 * ------------------------------------------------------------------ */

test('a square of known side has the area it should', () => {
  assert.equal(polygonArea(square(0, 0, 100)), 10000);
  assert.equal(polygonArea(square(-5000, -5000, 2000)), 4000000);
});

test('a hole is subtracted, not added', () => {
  /* Adding a hole instead of removing it would inflate every FSA containing a
     park, a rail yard or a stretch of lake, and the coverage ratio would come
     out low across a whole city with nothing anywhere saying why. */
  const outer = square(0, 0, 100)[0];
  const hole = [...square(25, 25, 50)[0]].reverse();
  assert.equal(polygonArea([outer, hole]), 10000 - 2500);
});

test('signed ring area is what tells an outer ring from a hole', () => {
  /* The property that matters is OPPOSITE SIGNS, not which way round:
     polygonArea sums the signed rings and takes the magnitude once at the end,
     so a hole cancels an equal piece of its outer ring whichever convention
     the file uses. */
  const outer = square(0, 0, 10)[0];
  const hole = [...outer].reverse();
  assert.ok(ringArea(outer) * ringArea(hole) < 0, 'a ring and its reverse must read opposite');
  assert.equal(Math.abs(ringArea(outer)), 100);
});

test('several shapes sum, so a region built of five neighbourhoods measures once', () => {
  assert.equal(shapesArea([square(0, 0, 100), square(1000, 0, 100)]), 20000);
});

/* ------------------------------------------------------------------ *
 * point in polygon
 * ------------------------------------------------------------------ */

test('a point inside is inside and a point outside is not', () => {
  const s = shape(0, 0, 100);
  assert.equal(inShapes(s, 50, 50), true);
  assert.equal(inShapes(s, 150, 50), false);
  assert.equal(inShapes(s, 50, 150), false);
  assert.equal(inShapes(s, -1, 50), false);
});

test('a point in a hole counts as outside', () => {
  const outer = square(0, 0, 100)[0];
  const hole = [...square(25, 25, 50)[0]].reverse();
  assert.equal(inShapes([[outer, hole]], 50, 50), false, 'the middle is a hole');
  assert.equal(inShapes([[outer, hole]], 10, 10), true, 'the ring around it is not');
});

/* ------------------------------------------------------------------ *
 * intersection
 * ------------------------------------------------------------------ */

test('two squares overlapping by a known amount measure that amount', () => {
  /* 1000m squares offset by 500m in x: exactly half. The grid is 10m, so the
     sampled answer should land within a fraction of a percent. */
  const a = square(0, 0, 1000);
  const b = square(500, 0, 1000);
  const { area } = sampleIntersectionArea([a], [b], 10);
  near(area, 500000, 500000 * 0.01, 'half-overlap');
});

test('disjoint shapes share nothing, and cost nothing to find out', () => {
  const r = sampleIntersectionArea([square(0, 0, 100)], [square(5000, 5000, 100)], 10);
  assert.equal(r.area, 0);
  assert.equal(r.samples, 0, 'the bounding boxes did not touch, so nothing was sampled');
});

test('a shape entirely inside another is entirely shared', () => {
  const outer = square(0, 0, 1000);
  const inner = square(400, 400, 200);
  const { area } = sampleIntersectionArea([outer], [inner], 10);
  near(area, 40000, 40000 * 0.02, 'contained');
});

test('the grid is fine enough that refining it does not move a decision', () => {
  /* THE CLAIM THE WHOLE DERIVATION RESTS ON. Coverage is compared against 50
     and 10, so what matters is not that a sampled area is exact but that
     refining the grid cannot walk an FSA across a threshold. The fixture is
     the size of a real FSA, roughly 10km across, which is what the 100 metre
     default was chosen against. */
  const a = square(0, 0, 10000);
  const b = square(4600, 0, 10000);
  const pct = (step) => sampleIntersectionArea([a], [b], step).area / polygonArea(a) * 100;
  const coarse = pct(100);
  const fine = pct(25);
  near(coarse, fine, 0.5, 'coverage percentage at two grid resolutions');
  assert.ok(coarse > 50 && fine > 50, 'and both land the same side of the threshold');
});

/* ------------------------------------------------------------------ *
 * projection
 * ------------------------------------------------------------------ */

test('the projection puts Toronto and Vancouver where they belong', () => {
  /* EPSG:3347 is metres from a false origin at 6,200,000E 3,000,000N. Checked
     as a relationship rather than against a coordinate, because what a wrong
     sign or a swapped parallel breaks is the relationship: Vancouver has to be
     a long way west of Toronto and Iqaluit a long way north of both. */
  const toronto = toLambert(-79.38, 43.65);
  const vancouver = toLambert(-123.12, 49.28);
  const iqaluit = toLambert(-68.52, 63.75);

  assert.ok(vancouver[0] < toronto[0] - 2500000, 'Vancouver is well west of Toronto');
  assert.ok(iqaluit[1] > toronto[1] + 1500000, 'Iqaluit is well north of Toronto');
  /* Both inside the projected extent of the country by a wide margin. */
  for (const [x, y] of [toronto, vancouver, iqaluit]) {
    assert.ok(x > 3000000 && x < 9500000, `x ${x} is off the map`);
    assert.ok(y > 500000 && y < 5500000, `y ${y} is off the map`);
  }
});

test('a kilometre is a kilometre, near the middle of the country', () => {
  /* One tenth of a degree of latitude is about 11.1km anywhere. Checked near
     the first standard parallel, where Lambert is true to scale. */
  const a = toLambert(-91.87, 49.0);
  const b = toLambert(-91.87, 49.1);
  near(Math.hypot(b[0] - a[0], b[1] - a[1]), 11120, 120, 'a tenth of a degree of latitude');
});

test('scale distortion grows away from the standard parallels, and is not claimed away', () => {
  /* THE REASON COVERAGE IS A RATIO. The addendum asked for a test that the
     same shape measures the same at 60 north as at 45. In this projection it
     does NOT, and asserting that it does would be asserting something false:
     Lambert is true to scale on its two standard parallels, 49 and 77, and
     runs long between and beyond them. Toronto at 43.7 measures about 5% long
     against the boundary file's own land areas.

     What IS true, and what the pipeline actually depends on, is the test
     below: a ratio of two areas at the same place is unaffected. */
  const deg = 0.05;
  const areaAt = (lat) => {
    const p = [toLambert(-91.87, lat), toLambert(-91.87 + deg, lat),
      toLambert(-91.87 + deg, lat + deg), toLambert(-91.87, lat + deg)];
    return Math.abs(polygonArea([[...p, p[0]]]));
  };
  const at49 = areaAt(49);
  const at60 = areaAt(60);
  assert.notEqual(Math.round(at49), Math.round(at60),
    'if these were equal the projection would not be Lambert');
});

test('a ratio of two areas in one place is stable, which is what coverage is', () => {
  /* Two boxes in the same city, one half the other. The ratio has to be a half
     wherever the city is, or a coverage percentage would mean something
     different in Toronto than in Vancouver. */
  const ratioAt = (lon, lat) => {
    const o = toLambert(lon, lat);
    const box = (w, h) => {
      const p1 = toLambert(lon + w, lat);
      const p2 = toLambert(lon, lat + h);
      return Math.abs((p1[0] - o[0]) * (p2[1] - o[1]) - (p1[1] - o[1]) * (p2[0] - o[0]));
    };
    return box(0.02, 0.01) / box(0.04, 0.01);
  };
  near(ratioAt(-79.38, 43.65), 0.5, 0.005, 'Toronto');
  near(ratioAt(-123.12, 49.28), 0.5, 0.005, 'Vancouver');
});

/* ------------------------------------------------------------------ *
 * boxes and adjacency
 * ------------------------------------------------------------------ */

test('bounding boxes and their overlap', () => {
  assert.deepEqual(bbox([square(10, 20, 30)]), [10, 20, 40, 50]);
  assert.equal(bboxOverlap([0, 0, 10, 10], [5, 5, 15, 15]), true);
  assert.equal(bboxOverlap([0, 0, 10, 10], [11, 0, 20, 10]), false);
});

test('adjacency is generous, because it exists to catch a whole wrong area', () => {
  const a = square(0, 0, 1000);
  const touching = square(1000, 0, 1000);
  const nearby = square(1100, 0, 1000);
  const far = square(50000, 0, 1000);
  assert.equal(nearlyTouches([a], [touching], 250), true, 'shared edge');
  assert.equal(nearlyTouches([a], [nearby], 250), true, 'within tolerance');
  assert.equal(nearlyTouches([a], [far], 250), false, 'the other side of the city');
});
