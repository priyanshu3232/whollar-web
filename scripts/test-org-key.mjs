#!/usr/bin/env node
/* Unit tests for the organisation key.
 *
 *   node --test scripts/test-org-key.mjs
 *
 * IN CI BECAUSE THIS DECIDES WHO SHARES A SEALED BID.
 *
 * Everything a partner owns is scoped by org_id, and an org is found by
 * `email_domain`. So whatever orgKeyFor() returns is, transitively, the answer
 * to "who can see my coverage, my team, my statements and my bids".
 *
 * Partner signup used to refuse personal addresses outright, which made the
 * question moot. It accepts them now, and the whole safety of that change rests
 * on one line: a free-provider address keys on the full address rather than the
 * bare domain. Get that wrong and every Gmail signup lands in one shared
 * organisation, which breaks the invariant CLAUDE.md states without
 * qualification: no partner sees another partner's bid, count, or reference.
 *
 * These are pure string functions, so there is no database and no excuse for
 * not testing them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { backend } from './backend-module.mjs';

const orgs = backend('lib/orgs.js');

test('colleagues on a company domain share one organisation', () => {
  assert.equal(orgs.orgKeyFor('sam@northline.ca'), 'northline.ca');
  assert.equal(orgs.orgKeyFor('dana@northline.ca'), 'northline.ca');
  assert.equal(
    orgs.orgKeyFor('sam@northline.ca'),
    orgs.orgKeyFor('dana@northline.ca'),
    'the second person at a partner must join the first one\'s org, and inherit its approval'
  );
});

test('two unrelated personal addresses NEVER share an organisation', () => {
  /* The one that matters. If this fails, two strangers see each other's
     sealed bids. */
  for (const domain of ['gmail.com', 'outlook.com', 'yahoo.ca', 'icloud.com', 'proton.me']) {
    assert.notEqual(
      orgs.orgKeyFor(`alice@${domain}`),
      orgs.orgKeyFor(`bob@${domain}`),
      `two ${domain} signups resolved to the same organisation`
    );
  }
});

test('a personal address keys on the whole address, not the domain', () => {
  assert.equal(orgs.orgKeyFor('priyanshu@gmail.com'), 'priyanshu@gmail.com');
  assert.ok(orgs.isPersonalOrgKey(orgs.orgKeyFor('priyanshu@gmail.com')));
  assert.ok(!orgs.isPersonalOrgKey(orgs.orgKeyFor('sam@northline.ca')));
});

test('the same person signing up twice resolves to their own organisation', () => {
  /* Case and whitespace both normalise, or a second attempt would create a
     second org and lose the approval decision already made about the first. */
  assert.equal(orgs.orgKeyFor('Sam@Gmail.com'), orgs.orgKeyFor('sam@gmail.com'));
  assert.equal(orgs.orgKeyFor('  sam@gmail.com  '), orgs.orgKeyFor('sam@gmail.com'));
  assert.equal(orgs.orgKeyFor('SAM@NORTHLINE.CA'), orgs.orgKeyFor('sam@northline.ca'));
});

test('an institutional subdomain is a company domain, not a personal one', () => {
  /* ma.iitr.ac.in is a department, and everyone in it is genuinely the same
     institution. Only the listed consumer providers are treated as personal. */
  assert.equal(orgs.orgKeyFor('priyanshu_c@ma.iitr.ac.in'), 'ma.iitr.ac.in');
  assert.ok(!orgs.isPersonalOrgKey(orgs.orgKeyFor('priyanshu_c@ma.iitr.ac.in')));
});

test('isPersonalOrgKey reads a stored key, including a missing one', () => {
  assert.ok(orgs.isPersonalOrgKey('sam@gmail.com'));
  assert.ok(!orgs.isPersonalOrgKey('northline.ca'));
  assert.ok(!orgs.isPersonalOrgKey(null));
  assert.ok(!orgs.isPersonalOrgKey(''));
});

test('every listed free provider produces a personal key', () => {
  /* The list and the behaviour must not drift apart: adding a domain to
     FREE_EMAIL_DOMAINS has to be sufficient to isolate it. */
  for (const domain of orgs.FREE_EMAIL_DOMAINS) {
    const key = orgs.orgKeyFor(`someone@${domain}`);
    assert.ok(orgs.isPersonalOrgKey(key), `${domain} did not produce a personal org key`);
  }
});
