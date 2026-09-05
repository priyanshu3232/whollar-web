#!/usr/bin/env node
/* Cohort geography: the postal code, the FSA, and who may join what.
 *
 *   node --test scripts/test-geo.mjs
 *
 * WHY THIS IS A GATE. Eligibility is the first rule in this codebase that can
 * fail SILENTLY IN BOTH DIRECTIONS. A rule that is too tight closes a live
 * cohort to the households it was built for, and nothing about that looks
 * broken: the dashboard renders, the counts hold, and joining stops working.
 * A rule that is too loose puts households from the wrong end of the province
 * on a partner's desk, and that does not look broken either until somebody
 * tries to install a line.
 *
 * So the two ends are pinned here rather than described: what a valid postal
 * code is, what an empty FSA set means, and the fact that the browser's
 * normalizer and the server's agree character for character. The last one
 * matters because the client validates inline and the server decides; if they
 * disagree, the disagreement shows up as a field that accepts a value and a
 * save that refuses it, with no message that explains why.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backend } from './backend-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const geo = backend('lib/geo');
const fsaref = backend('lib/fsaref');
const guards = backend('lib/guards');

/* The browser half, evaluated the way a page loads it. */
function loadCore() {
  const sandbox = {};
  sandbox.window = sandbox;
  const code = readFileSync(join(ROOT, 'js/whollar-core.js'), 'utf8');
  new Function('window', 'globalThis', code + '\nreturn window;')(sandbox, sandbox);
  return sandbox.WHOLLAR;
}
const W = loadCore();

/* ------------------------------------------------------------------ *
 * normalization
 * ------------------------------------------------------------------ */

const GOOD = [
  ['M2N 4K1', 'M2N4K1', 'M2N'],
  ['m2n 4k1', 'M2N4K1', 'M2N'],   // lowercase
  ['M2N4K1', 'M2N4K1', 'M2N'],    // no space
  ['M2N-4K1', 'M2N4K1', 'M2N'],   // hyphen
  ['  M2N  4K1  ', 'M2N4K1', 'M2N'],
  ['P0T 1A0', 'P0T1A0', 'P0T'],   // rural: second character 0, valid
  ['X0A 0H0', 'X0A0H0', 'X0A'],   // Nunavut
];

const BAD = [
  'D1A 1A1',  // D is not a leading letter
  'W1A 1A1',  // nor W
  'Z1A 1A1',  // nor Z
  'M2D 4K1',  // D in an inner letter position
  'M2N 4U1',  // U in an inner letter position
  'M2N4K',    // five characters
  'M2N4K12',  // seven
  '12345',
  'M2N 4K1 extra',
  '',
  null,
  undefined,
];

test('a valid postal code normalizes to code, FSA and display form', () => {
  for (const [raw, code, fsa] of GOOD) {
    const r = geo.normalizePostalCode(raw);
    assert.equal(r.error, undefined, `${raw} was rejected`);
    assert.equal(r.postal_code, code);
    assert.equal(r.fsa, fsa);
    assert.equal(r.display, `${fsa} ${code.slice(3)}`);
  }
});

test('an invalid postal code is refused, and refused the same way every time', () => {
  for (const raw of BAD) {
    const r = geo.normalizePostalCode(raw);
    assert.equal(r.error, 'invalid_postal_code', `${String(raw)} was accepted`);
    assert.equal(r.fsa, undefined, `${String(raw)} leaked an FSA`);
  }
});

test('the FSA is always the first three characters of the normalized code', () => {
  /* Never a separate input. A member who could send an FSA could pick any
     cohort in the country; lib/users.js has derived it on write since the
     first signup for exactly that reason and this keeps the derivation the
     only one there is. */
  for (const [raw, code] of GOOD) {
    assert.equal(geo.fsaOf(raw), code.slice(0, 3));
  }
  assert.equal(geo.fsaOf('nonsense'), null);
});

test('the browser normalizer and the server normalizer agree, character for character', () => {
  /* The client validates inline to save a round trip and the server decides.
     If the two disagree, a member meets a field that accepts what the save
     refuses, with no message that could explain it. */
  assert.ok(W && typeof W.normalizePostal === 'function', 'js/whollar-core.js has no normalizePostal');
  for (const [raw] of GOOD) {
    const a = geo.normalizePostalCode(raw);
    const b = W.normalizePostal(raw);
    assert.deepEqual(b, a, `disagreed on ${raw}`);
  }
  for (const raw of BAD) {
    assert.deepEqual(W.normalizePostal(raw), { error: 'invalid_postal_code' },
      `browser accepted ${String(raw)}`);
  }
});

/* ------------------------------------------------------------------ *
 * an FSA set
 * ------------------------------------------------------------------ */

test('an FSA list parses, deduplicates and sorts, whatever it was typed as', () => {
  assert.deepEqual(geo.parseFsaList('m2n, M2M M2R;m2n'), ['M2M', 'M2N', 'M2R']);
  assert.deepEqual(geo.parseFsaList(''), []);
  assert.deepEqual(geo.parseFsaList(null), []);
  assert.equal(geo.formatFsaList(['M2R', 'M2M']), 'M2M,M2R');
});

test('a bad entry in a stored list costs that entry, not the catalog', () => {
  /* The read path is lenient because a hand-edited row must not take every
     campaign down with it; the write path (routes/admin.js) is strict because
     that is where a human is present to fix the typo. */
  assert.deepEqual(geo.parseFsaList('M2N,ZZZ,M2M'), ['M2M', 'M2N']);
});

/* ------------------------------------------------------------------ *
 * the reference
 * ------------------------------------------------------------------ */

test('the FSA reference is loaded, and knows the FSAs the launch cities sit in', () => {
  assert.ok(fsaref.COUNT > 1500, `only ${fsaref.COUNT} FSAs`);
  for (const fsa of ['M2N', 'M5V', 'L4C', 'L6Y']) {
    assert.equal(fsaref.has(fsa), true, `${fsa} is missing from the reference`);
    const p = fsaref.lookup(fsa);
    assert.equal(p.province, 'ON');
    assert.ok(p.city, `${fsa} has no city`);
  }
  assert.equal(fsaref.has('M9Z'), false, 'M9Z is not a real FSA');
  assert.equal(fsaref.lookup('M9Z'), null);
});

/* ------------------------------------------------------------------ *
 * eligibility
 * ------------------------------------------------------------------ */

const camp = (fsas) => ({ id: 'c', fsas });

test('a household inside the set may join, one outside it may not', () => {
  assert.equal(geo.eligibilityOf(camp(['M2N', 'M2M']), 'M2N', true, false), 'eligible');
  assert.equal(geo.eligibilityOf(camp(['M2N', 'M2M']), 'M4C', true, false), 'not_in_area');
});

test('a household with no postal code is eligible for nothing scoped', () => {
  assert.equal(geo.eligibilityOf(camp(['M2N']), null, true, false), 'not_in_area');
});

test('inside the set but past the join window reads as closed, not as elsewhere', () => {
  /* The difference is the whole card: "this cohort has moved on and the next
     one for your area shows here" is a different sentence from "this cohort
     is somewhere else", and a household in the right area deserves the first. */
  assert.equal(geo.eligibilityOf(camp(['M2N']), 'M2N', false, false), 'joins_closed');
  assert.equal(geo.eligibilityOf(camp(['M2N']), 'M4C', false, false), 'not_in_area');
});

test('a standing outranks geography, so a coverage edit cannot evict anybody', () => {
  /* An operator removing an FSA from a live cohort must not lock the
     households already in it out of their own dashboard. Grandfathering, and
     the record of what was true at the time is campaign_members.fsa. */
  assert.equal(geo.eligibilityOf(camp(['M2N']), 'M4C', true, true), 'already_joined');
  assert.equal(geo.eligibilityOf(camp([]), 'M4C', false, true), 'already_joined');
});

test('an empty FSA set is UNSCOPED and everyone may join it', () => {
  /* This is the migration, and it is deliberate. Reading an empty set as
     "nobody" would, on the deploy that shipped it, close every live cohort to
     every household at once with no error anywhere. routes/admin.js refuses to
     open a NEW cohort unscoped and reconcile lists the ones that still are, so
     the set only shrinks. If this test ever has to change, the campaigns have
     to be scoped first. */
  assert.equal(geo.eligibilityOf(camp([]), 'M4C', true, false), 'unscoped');
  assert.equal(geo.eligibilityOf(camp([]), null, true, false), 'unscoped');
  assert.equal(geo.canJoin('unscoped'), true);
});

test('exactly three answers permit a join, and not_in_area is not one of them', () => {
  assert.deepEqual([...geo.JOINABLE_ELIGIBILITY].sort(),
    ['already_joined', 'eligible', 'unscoped']);
  assert.equal(geo.canJoin('not_in_area'), false);
  assert.equal(geo.canJoin('joins_closed'), false);
});

/* ------------------------------------------------------------------ *
 * the guard both join doors call
 * ------------------------------------------------------------------ */

const forming = (fsas) => ({ id: 'north-york-central', kind: 'forming', dates: {}, fsas });
const NOW = 1756000000000;

test('the guard returns the answer when a join is allowed', () => {
  assert.equal(guards.requireEligible(forming(['M2N']), { fsa: 'M2N' }, NOW), 'eligible');
  assert.equal(guards.requireEligible(forming([]), { fsa: 'M4C' }, NOW), 'unscoped');
});

test('the guard refuses an outside household with 403 and a reason the client can act on', () => {
  assert.throws(() => guards.requireEligible(forming(['M2N']), { fsa: 'M4C' }, NOW), (e) => {
    assert.equal(e.code, 'NOT_IN_AREA');
    assert.equal(e.status, 403);
    assert.equal(e.extra.reason, 'not_in_area');
    /* The refusal names no other region and no FSA: a member who could probe
       this route would otherwise read a cohort's coverage map back out of it
       one postal code at a time. */
    assert.equal(/M2N/.test(e.message), false, 'the refusal leaked the cohort FSA');
    return true;
  });
});

test('the guard tells a missing postal code apart from a wrong one', () => {
  /* Two different next steps: add your postal code, or wait for your own
     cohort. One 409 and one 403 so a client cannot conflate them by reading
     the copy. */
  assert.throws(() => guards.requireEligible(forming(['M2N']), { fsa: null }, NOW), (e) => {
    assert.equal(e.code, 'POSTAL_MISSING');
    assert.equal(e.status, 409);
    assert.equal(e.extra.reason, 'postal_code_missing');
    return true;
  });
});

test('the guard refuses a cohort past its join window even inside the area', () => {
  const closed = { id: 'c', kind: 'auction', dates: {}, fsas: ['M2N'] };
  assert.throws(() => guards.requireEligible(closed, { fsa: 'M2N' }, NOW), (e) => {
    assert.equal(e.code, 'JOIN_CLOSED');
    assert.equal(e.extra.reason, 'joins_closed');
    return true;
  });
});

test('the join window closes at announce_at, whatever the kind says', () => {
  const shut = { id: 'c', kind: 'forming', dates: { announce_at: NOW - 1000 }, fsas: ['M2N'] };
  assert.throws(() => guards.requireEligible(shut, { fsa: 'M2N' }, NOW), (e) => {
    assert.equal(e.code, 'JOIN_CLOSED');
    return true;
  });
  const open = { id: 'c', kind: 'forming', dates: { announce_at: NOW + 1000 }, fsas: ['M2N'] };
  assert.equal(guards.requireEligible(open, { fsa: 'M2N' }, NOW), 'eligible');
});

test('the guard reads nothing but the campaign row and the member row', () => {
  /* The signature is the proof: there is no request and no body in it, so a
     client claiming eligibility has nothing to claim it into. Three, because
     the fourth parameter carries a default and Function#length stops there. */
  assert.equal(guards.requireEligible.length, 3);
});

/* ------------------------------------------------------------------ *
 * the rail's order, which is not a permission
 * ------------------------------------------------------------------ */

test('nearby tiers run own-area, then city, then province, then everything else', () => {
  /* The city here is GeoNames' label, which is a borough rather than the
     municipality for much of Toronto: M2N and M2M are both "Willowdale" and
     M5V is "Toronto". That is the reference's documented caveat and it makes
     the city tier tighter than a municipal boundary would, which is the right
     direction for a tier that means "near you". Eligibility never reads it. */
  const home = 'M2N';                          // Willowdale, ON
  const own = geo.nearbyTier(camp(['M2N']), home, 'eligible', fsaref);
  const city = geo.nearbyTier(camp(['M2M']), home, 'not_in_area', fsaref);  // Willowdale
  const prov = geo.nearbyTier(camp(['L6Y']), home, 'not_in_area', fsaref);  // Brampton, ON
  const away = geo.nearbyTier(camp(['V6B']), home, 'not_in_area', fsaref);  // Vancouver, BC
  assert.equal(own, 0);
  assert.ok(city < prov, `city tier ${city} did not beat province tier ${prov}`);
  assert.ok(prov < away, `province tier ${prov} did not beat the rest ${away}`);
});

test('an unknown FSA costs a campaign its place in the sort and nothing more', () => {
  assert.equal(geo.nearbyTier(camp(['M2N']), null, 'not_in_area', fsaref), 3);
  assert.equal(geo.nearbyTier(camp([]), 'M2N', 'not_in_area', fsaref), 3);
  assert.equal(geo.nearbyTier(camp(['M2N']), 'M2N', 'eligible', null), 0);
});
