/* Just enough geometry to intersect a neighbourhood with a postal area.
 *
 * WHY BY HAND. Every other generated file in this repo is built by a script
 * with no dependencies, which is what keeps check-frontend install-free and
 * fast enough that nobody turns it off. A polygon library would be one
 * devDependency for one build, and what it would buy is a general clipper: an
 * exact boolean intersection of two arbitrary multi-ring polygons, which is
 * the hardest thing in this file to get right and the one thing this problem
 * does not need. See sampleIntersectionArea() for what it does instead.
 *
 * PLANAR ONLY, AND THAT IS THE POINT. Statistics Canada ships the FSA boundary
 * file in EPSG:3347 (NAD83 / Statistics Canada Lambert), metres, so an area is
 * a shoelace sum and not a spherical integral. The neighbourhood boundaries
 * come in WGS84 degrees and are projected INTO 3347 before anything is
 * measured, because an area computed in degrees is not an area: a square
 * degree at 60 north is about half a square degree at 45.
 */

/* ------------------------------------------------------------------ *
 * EPSG:3347, from the .prj that ships with the boundary file
 * ------------------------------------------------------------------ */

const LCC = {
  a: 6378137,                 // GRS 1980
  invF: 298.257222101,
  lat1: 49,
  lat2: 77,
  lat0: 63.390675,
  lon0: -91.86666666666666,
  x0: 6200000,
  y0: 3000000,
};

const RAD = Math.PI / 180;

/** Snyder's Lambert Conformal Conic, two standard parallels, ellipsoidal. */
function lccProjector(p = LCC) {
  const f = 1 / p.invF;
  const e = Math.sqrt(2 * f - f * f);
  const m = (φ) => Math.cos(φ) / Math.sqrt(1 - e * e * Math.sin(φ) ** 2);
  const t = (φ) => Math.tan(Math.PI / 4 - φ / 2)
    / ((1 - e * Math.sin(φ)) / (1 + e * Math.sin(φ))) ** (e / 2);

  const φ1 = p.lat1 * RAD, φ2 = p.lat2 * RAD, φ0 = p.lat0 * RAD;
  const m1 = m(φ1), m2 = m(φ2), t1 = t(φ1), t2 = t(φ2), t0 = t(φ0);
  const n = Math.log(m1 / m2) / Math.log(t1 / t2);
  const F = m1 / (n * t1 ** n);
  const ρ0 = p.a * F * t0 ** n;

  /** [lon, lat] in degrees -> [x, y] in metres. */
  return function project(lon, lat) {
    const ρ = p.a * F * t(lat * RAD) ** n;
    const θ = n * ((lon - p.lon0) * RAD);
    return [p.x0 + ρ * Math.sin(θ), p.y0 + ρ0 - ρ * Math.cos(θ)];
  };
}

export const toLambert = lccProjector();

/* ------------------------------------------------------------------ *
 * Rings
 *
 * A polygon here is an array of rings, each an array of [x, y] pairs, in the
 * shapefile's own convention: a clockwise ring is an outer boundary and a
 * counter-clockwise one is a hole. Signed shoelace area is what tells them
 * apart, so it is computed once and reused rather than tested for.
 * ------------------------------------------------------------------ */

/** Signed area of one ring, m². Positive clockwise in shapefile order. */
export function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return s / 2;
}

/** Net area of a polygon: outer rings less their holes, m². */
export function polygonArea(rings) {
  return Math.abs(rings.reduce((sum, r) => sum + ringArea(r), 0));
}

/** Net area of several polygons, m². Used for a region built of features. */
export const shapesArea = (shapes) => shapes.reduce((s, rings) => s + polygonArea(rings), 0);

/** [minX, minY, maxX, maxY] over every ring given. */
export function bbox(shapes) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const rings of shapes) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < a) a = x;
        if (y < b) b = y;
        if (x > c) c = x;
        if (y > d) d = y;
      }
    }
  }
  return [a, b, c, d];
}

export const bboxOverlap = (p, q) =>
  p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3];

/**
 * Is the point inside? Even-odd crossing count over every ring at once, which
 * handles holes without knowing which rings are holes: a point inside an outer
 * ring and inside a hole crosses both and comes out even, which is correct.
 */
export function inShapes(shapes, x, y) {
  let inside = false;
  for (const rings of shapes) {
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y)
          && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * The area two shapes share, m², by sampling a regular grid over the box they
 * both fall in.
 *
 * WHY SAMPLED RATHER THAN CLIPPED. An exact clipper (Greiner-Hormann, Weiler
 * Atherton) is the classic answer and it is also the classic source of subtle
 * wrong answers: degenerate vertices, collinear edges, holes touching outer
 * rings, and self-intersections in real municipal data. It would be a few
 * hundred lines of the kind of code whose bugs are invisible until a cohort is
 * scoped wrong.
 *
 * What the answer is FOR is a coverage percentage compared against a threshold
 * of 50 and a review band starting at 10. At the default 100 metre grid a
 * neighbourhood-sized region is sampled at a few hundred thousand points and
 * the percentage lands within a small fraction of one point, which is far
 * inside any distance that could move an FSA across either line. Where it is
 * not, the FSA is within a fraction of a percent of a threshold and belongs in
 * front of an operator anyway, which is what the review band is for.
 *
 * The resolution is recorded in the output so the number is never read as
 * exact. Halving it is a four-fold cost and changes no decision.
 */
export function sampleIntersectionArea(a, b, step) {
  const ba = bbox(a), bb = bbox(b);
  if (!bboxOverlap(ba, bb)) return { area: 0, samples: 0, hits: 0 };
  const minX = Math.max(ba[0], bb[0]);
  const minY = Math.max(ba[1], bb[1]);
  const maxX = Math.min(ba[2], bb[2]);
  const maxY = Math.min(ba[3], bb[3]);

  let hits = 0, samples = 0;
  /* Cell CENTRES, offset by half a step, so a shared edge is not counted
     twice by two neighbouring polygons that both contain the boundary. */
  for (let y = minY + step / 2; y < maxY; y += step) {
    for (let x = minX + step / 2; x < maxX; x += step) {
      samples += 1;
      if (inShapes(a, x, y) && inShapes(b, x, y)) hits += 1;
    }
  }
  return { area: hits * step * step, samples, hits };
}

/**
 * Do these two shapes share a boundary, or come within `tol` metres of one?
 *
 * The adjacency check: an included FSA that touches no other included FSA and
 * does not touch the region is almost always a mis-resolution, a name matched
 * on the wrong side of the city. Answered on bounding boxes grown by the
 * tolerance rather than on edges, which is deliberately generous: this exists
 * to catch a whole FSA in the wrong place, and a check that fired on the
 * geometry of a river bend would be turned off within a week.
 */
export function nearlyTouches(a, b, tol) {
  const p = bbox(a), q = bbox(b);
  return p[0] - tol <= q[2] && q[0] - tol <= p[2]
      && p[1] - tol <= q[3] && q[1] - tol <= p[3];
}
