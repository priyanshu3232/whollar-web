'use strict';

/**
 * Provider organisations and the people who act for them.
 *
 * The thing that makes a partner account different from a member account is
 * that a partner is not really a person: they are a person acting for a
 * company. Two rows express that: `provider_orgs` is the company, and
 * `provider_users` is the membership, carrying the role.
 *
 * A partner console shows competitor pricing and cohort internals, so proving
 * an email address is NOT sufficient to see any of it. Verification proves the
 * address; approval decides whether the company is one we deal with. They are
 * separate gates and both must pass.
 */

const crypto = require('node:crypto');
const datastore = require('./datastore');

const ORGS = 'provider_orgs';
const MEMBERSHIPS = 'provider_users';

const ORG_COLUMNS = ['ROWID', 'org_id', 'legal_name', 'email_domain',
  'approval_status', 'approved_by', 'approved_at'];
const MEMBERSHIP_COLUMNS = ['ROWID', 'user_id', 'org_id', 'role'];

const ROLES = Object.freeze(['admin', 'bidder', 'viewer']);
const APPROVAL = Object.freeze(['pending', 'approved', 'rejected']);

/**
 * Consumer mailbox providers, refused for partner signup.
 *
 * Not security theatre: the domain IS the identity claim here. Everyone at
 * `telus.com` is presumed to be the same company, which is what lets the second
 * person from a provider join the first one's org automatically. That inference
 * is sound for a corporate domain and absurd for `gmail.com`, where it would
 * put every unrelated Gmail user into one shared organisation with access to
 * each other's cohorts.
 *
 * It is a small list on purpose. It only has to catch the addresses people
 * reach for by habit; a determined signup with an obscure free provider still
 * lands in `pending` and is refused by a human, which is the real gate.
 */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.ca', 'yahoo.co.uk',
  'hotmail.com', 'hotmail.ca', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'rogers.com', 'bell.net',
  'sympatico.ca', 'shaw.ca', 'telus.net', 'videotron.ca', 'cogeco.ca',
]);

/** Everything after the `@`, lowercased. */
const domainOf = (email) => String(email || '').split('@')[1]?.trim().toLowerCase() || '';

const isFreeEmailDomain = (email) => FREE_EMAIL_DOMAINS.has(domainOf(email));

/**
 * The key an organisation is found by, which is NOT always the domain.
 *
 * Signing up with a personal address used to be refused outright. It is
 * allowed now, and that one change would otherwise open a hole big enough to
 * break the auction: orgs are keyed on `email_domain`, and everything a
 * partner owns is scoped by `org_id`. Two strangers signing up with different
 * gmail addresses would both resolve to the domain 'gmail.com', both be added
 * to the same organisation, and each would then see the other's coverage,
 * their team list with real names and addresses, and their SEALED BIDS.
 *
 * That last one is the invariant the whole reverse auction rests on, and
 * CLAUDE.md states it without qualification: no partner sees another partner's
 * bid, count, or reference, in any response.
 *
 * So a free-provider address keys on the FULL ADDRESS instead of the domain.
 * One person gets one organisation; the same person signing up twice finds
 * their own; two gmail users never meet. Corporate domains are untouched and
 * still pool colleagues into one org, which is the behaviour that makes a
 * second person at a partner work at all.
 *
 * The '@' in the stored value is what tells the rest of the system which kind
 * it is looking at. Nothing else needs a new column.
 */
const orgKeyFor = (email) => {
  const normalized = String(email || '').trim().toLowerCase();
  return isFreeEmailDomain(normalized) ? normalized : domainOf(normalized);
};

/** True when an org was created from one personal address rather than a domain. */
const isPersonalOrgKey = (key) => String(key || '').includes('@');

/* ------------------------------------------------------------------ *
 * Organisations
 * ------------------------------------------------------------------ */

const findByDomain = (catalystApp, domain) =>
  datastore.findBy(catalystApp, ORGS, 'email_domain', String(domain).toLowerCase(), ORG_COLUMNS);

const findById = (catalystApp, orgId) =>
  datastore.findBy(catalystApp, ORGS, 'org_id', orgId, ORG_COLUMNS);

/**
 * Find the org for an email domain, or create it pending approval.
 *
 * Matching on the domain is what makes the second person from a company join
 * the first one's organisation instead of creating a duplicate, and, more
 * importantly, means the second person inherits whatever approval decision was
 * already made about that company rather than getting a fresh unreviewed one.
 *
 * `email_domain` is not a unique column in the schema, so a race can produce
 * two orgs for one domain. That is tolerable in a way the equivalent on `users`
 * is not: the loser is an empty org row an operator can merge, not a second
 * account for a real person. Re-reading after insert keeps the common case
 * correct.
 */
async function findOrCreateForDomain(catalystApp, { domain, legalName }) {
  const emailDomain = String(domain).toLowerCase();

  const existing = await findByDomain(catalystApp, emailDomain);
  if (existing) return { org: existing, created: false };

  const orgId = crypto.randomUUID();
  await datastore.insertRow(catalystApp, ORGS, {
    org_id: orgId,
    legal_name: String(legalName || emailDomain).trim().slice(0, 255),
    email_domain: emailDomain.slice(0, 255),
    // Never anything but pending on creation. An org becomes approved only by
    // a human deciding so: there is no code path that self-approves.
    approval_status: 'pending',
    approved_by: null,
    approved_at: null,
  });

  const raced = await findByDomain(catalystApp, emailDomain);
  return { org: raced || (await findById(catalystApp, orgId)), created: true };
}

/* ------------------------------------------------------------------ *
 * Memberships
 * ------------------------------------------------------------------ */

async function membershipFor(catalystApp, userId) {
  return datastore.findBy(catalystApp, MEMBERSHIPS, 'user_id', userId, MEMBERSHIP_COLUMNS);
}

/** Everyone attached to an org. Paginated: see datastore.queryAll. */
const membersOf = (catalystApp, orgId) =>
  datastore.queryAll(catalystApp, MEMBERSHIPS, ['user_id', 'org_id', 'role'],
    `org_id = ${datastore.lit(orgId)}`);

/**
 * Attach a user to an org. Idempotent.
 *
 * The first person at a company becomes `admin`; everyone after them becomes
 * `viewer`, and an admin promotes them. The alternative, trusting whatever
 * role the signup form asked for, would let the fifth person at a provider
 * grant themselves bidding rights by choosing a dropdown value, which is not a
 * decision the person signing up gets to make about themselves.
 */
async function addMember(catalystApp, { userId, orgId }) {
  const existing = await membershipFor(catalystApp, userId);
  if (existing) return { membership: existing, created: false };

  const existingMembers = await membersOf(catalystApp, orgId);
  const role = existingMembers.length === 0 ? 'admin' : 'viewer';

  await datastore.insertRow(catalystApp, MEMBERSHIPS, {
    user_id: userId,
    org_id: orgId,
    role,
  });

  const membership = await membershipFor(catalystApp, userId);
  return { membership, created: true };
}

/* ------------------------------------------------------------------ *
 * The view a signed-in partner gets
 * ------------------------------------------------------------------ */

/**
 * Org + role + approval state for a user, or null if they are not a partner.
 *
 * `approved` is computed here and nowhere else, so no caller can arrive at its
 * own answer. Anything other than the literal string `approved` is not
 * approved: a null, a typo or a future status all fail closed.
 */
async function contextFor(catalystApp, userId) {
  const membership = await membershipFor(catalystApp, userId);
  if (!membership) return null;

  const org = await findById(catalystApp, membership.org_id);
  if (!org) return null;

  return {
    orgId: org.org_id,
    orgName: org.legal_name,
    role: membership.role,
    approvalStatus: org.approval_status || 'pending',
    approved: org.approval_status === 'approved',
  };
}

module.exports = {
  ORGS, MEMBERSHIPS, ORG_COLUMNS, MEMBERSHIP_COLUMNS, ROLES, APPROVAL,
  FREE_EMAIL_DOMAINS, domainOf, isFreeEmailDomain, orgKeyFor, isPersonalOrgKey,
  findByDomain, findById, findOrCreateForDomain,
  membershipFor, membersOf, addMember, contextFor,
};
