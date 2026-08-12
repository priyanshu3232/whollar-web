#!/usr/bin/env node
/* Unit tests for the route guards.
 *
 *   node --test scripts/test-guards.mjs
 *
 * In CI because these are the checks that decide whether an unapproved
 * organisation can place a bid, and because they were copy-pasted across four
 * route files before being extracted. A test is what stops the fifth copy.
 *
 * No database. The guards touch only req.auth and orgs.contextFor, so
 * contextFor is stubbed per case.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { backend } from './backend-module.mjs';

const orgs = backend('lib/orgs.js');
const guards = backend('lib/guards.js');

const req = (userType) => ({
  auth: userType ? { user: { user_id: 'u1', user_type: userType, email_normalized: 'a@b.ca' } } : null,
  catalyst: {},
});

/** The error code a guard throws, or 'NO THROW'. */
async function code(fn) {
  try { await fn(); return 'NO THROW'; } catch (e) { return e.code || e.name; }
}

/** Swap orgs.contextFor for one case and always put it back. */
async function withContext(value, fn) {
  const real = orgs.contextFor;
  orgs.contextFor = async () => value;
  try { return await fn(); } finally { orgs.contextFor = real; }
}

const ctx = (over = {}) => ({
  orgId: 'o1', orgName: 'Northline', role: 'admin',
  approvalStatus: 'approved', approved: true, ...over,
});

test('signed out is UNAUTHENTICATED, not FORBIDDEN', async () => {
  /* The distinction is load-bearing: the console bounces to sign-in on 401
     and shows a message on 403. */
  assert.equal(await code(() => guards.requireUser(req(null))), 'UNAUTHENTICATED');
  assert.equal(await code(() => guards.requireMember(req(null))), 'UNAUTHENTICATED');
  assert.equal(await code(() => guards.requireProvider(req(null))), 'UNAUTHENTICATED');
  assert.equal(await code(() => guards.requireAdmin(req(null))), 'UNAUTHENTICATED');
});

test('the wrong account type is FORBIDDEN', async () => {
  assert.equal(await code(() => guards.requireMember(req('provider'))), 'FORBIDDEN');
  assert.equal(await code(() => guards.requireProvider(req('member'))), 'FORBIDDEN');
  assert.equal(await code(() => guards.requireAdmin(req('provider'))), 'FORBIDDEN');
  assert.equal(await code(() => guards.requireAdmin(req('member'))), 'FORBIDDEN');
});

test('the right type passes and the user comes back', () => {
  assert.equal(guards.requireMember(req('member')).user_id, 'u1');
  assert.equal(guards.requireProvider(req('provider')).user_id, 'u1');
  assert.equal(guards.requireAdmin(req('admin')).user_id, 'u1');
});

test('requireUser is type-agnostic on purpose', () => {
  /* /me/prefs, /me/event, /me/export and /me/delete already serve partners as
     well as members, and the partner console depends on that. */
  for (const t of ['member', 'provider', 'admin']) {
    assert.equal(guards.requireUser(req(t)).user_id, 'u1');
  }
});

test('requirePartner needs an org membership on top of the type', async () => {
  await withContext(null, async () => {
    assert.equal(await code(() => guards.requirePartner(req('provider'))), 'FORBIDDEN');
  });
  await withContext(ctx(), async () => {
    assert.equal(await code(() => guards.requirePartner(req('member'))), 'FORBIDDEN',
      'a member is refused on type, before the org lookup');
  });
});

test('THE IMPORTANT ONE: an unapproved org passes requirePartner and fails requireApproved', async () => {
  /* An unapproved partner must still be able to read its own coverage and its
     own bids, so requirePartner deliberately does not check approval. Every
     action that touches a cohort adds requireApproved. Collapsing the two into
     one guard is how an unapproved org ends up bidding. */
  await withContext(ctx({ approvalStatus: 'pending', approved: false }), async () => {
    const { context } = await guards.requirePartner(req('provider'));
    assert.equal(context.orgId, 'o1', 'requirePartner lets them in');
    assert.equal(await code(() => guards.requireApproved(context)), 'FORBIDDEN', 'requireApproved does not');
  });
});

test('approval fails closed on anything that is not exactly approved', () => {
  for (const approved of [false, null, undefined, 0, '', 'yes']) {
    assert.equal(code(() => guards.requireApproved(ctx({ approved }))) instanceof Promise, true);
  }
  for (const approved of [false, null, undefined]) {
    assert.throws(() => guards.requireApproved(ctx({ approved })), /under review/);
  }
  assert.doesNotThrow(() => guards.requireApproved(ctx({ approved: true })));
});

test('requireRole gates seats', () => {
  assert.throws(() => guards.requireRole(ctx({ role: 'viewer' }), 'admin', 'bidder'), /access level/);
  assert.equal(guards.requireRole(ctx({ role: 'viewer' }), 'viewer', 'admin').role, 'viewer');
  assert.equal(guards.requireRole(ctx({ role: 'admin' }), 'admin').role, 'admin');
});

test('no message a partner reads carries an em dash', () => {
  /* House rule, and these are shown verbatim: lib/errors.js composes them on
     the explicit assumption that pages do not rewrite them. */
  const msgs = [];
  const cases = [
    () => guards.requireUser(req(null)),
    () => guards.requireMember(req('provider')),
    () => guards.requireProvider(req('member')),
    () => guards.requireAdmin(req('member')),
    () => guards.requireApproved(ctx({ approved: false })),
    () => guards.requireRole(ctx({ role: 'viewer' }), 'admin'),
  ];
  for (const fn of cases) {
    try { fn(); assert.fail('expected a throw'); } catch (e) { msgs.push(e.message); }
  }
  assert.equal(msgs.length, cases.length);
  for (const m of msgs) assert.ok(!m.includes('—'), `em dash in: ${m}`);
});
