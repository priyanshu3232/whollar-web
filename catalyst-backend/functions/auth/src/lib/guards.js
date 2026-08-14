'use strict';

/**
 * The route guards, in one place.
 *
 * WHY THIS FILE EXISTS. These checks were written four times in four route
 * files as each surface arrived. `requireMember` has three independent copies
 * (campaigns.js, me.js, member.js, rating.js); `requireProvider` in
 * campaigns.js and the inline check in provider.js differ from
 * `requirePartner` in desk.js in a way that matters and that nothing wrote
 * down. The partner console adds five more route files, and a guard that is
 * copy-pasted a fifth time is a guard that will eventually be pasted wrong.
 *
 * THE THREE PROVIDER GATES ARE NOT INTERCHANGEABLE. Getting this wrong is how
 * an unapproved org places a bid, so the difference is stated here rather than
 * inferred from a call site:
 *
 *   requireProvider   signed in AND user_type === 'provider'.
 *                     No org context, no approval. Use for reads that expose
 *                     nothing but aggregate, org-independent facts.
 *
 *   requirePartner    the above, PLUS an org membership, returning the org
 *                     context. Use for anything scoped to one org's own data.
 *                     An unapproved org still passes: it can read its own
 *                     coverage and its own bids, and it should.
 *
 *   requireApproved   takes the context from requirePartner and refuses if the
 *                     org is not approved. Use for every action that touches a
 *                     cohort. Approval is a decision a human made; nothing in
 *                     the codebase may infer it.
 *
 * Approval is computed in exactly one place, orgs.contextFor, and fails closed
 * on anything that is not literally 'approved'.
 */

const orgs = require('./orgs');
const { unauthorized, forbidden } = require('./errors');

/* ------------------------------------------------------------------ *
 * Any signed-in account
 * ------------------------------------------------------------------ */

function requireUser(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  return req.auth.user;
}

/* ------------------------------------------------------------------ *
 * By account type
 * ------------------------------------------------------------------ */

function requireMember(req, where) {
  const user = requireUser(req);
  if (user.user_type !== 'member') {
    throw forbidden('This account is not a member account.', {
      logDetail: `non-member hit ${where || 'a member route'}`,
    });
  }
  return user;
}

function requireProvider(req, where) {
  const user = requireUser(req);
  if (user.user_type !== 'provider') {
    throw forbidden('This account is not a provider account.', {
      logDetail: `non-provider hit ${where || 'a provider route'}`,
    });
  }
  return user;
}

function requireAdmin(req, where) {
  const user = requireUser(req);
  if (user.user_type !== 'admin') {
    throw forbidden('This account is not an admin account.', {
      logDetail: `non-admin hit ${where || 'an admin route'}`,
    });
  }
  return user;
}

/* ------------------------------------------------------------------ *
 * Partner: provider plus org context
 * ------------------------------------------------------------------ */

/** The signed-in partner and their org context, or a refusal. */
async function requirePartner(req, where) {
  const user = requireProvider(req, where);
  const context = await orgs.contextFor(req.catalyst, user.user_id);
  if (!context) {
    throw forbidden('This account is not attached to an organisation.', {
      logDetail: `provider with no membership hit ${where || 'a desk route'}`,
    });
  }
  return { user, context };
}

/** Gate on the approval decision. Never inferred, always the stored value. */
function requireApproved(context) {
  if (!context.approved) {
    throw forbidden('Your organisation is still under review. This opens the moment it is approved.', {
      logDetail: `unapproved org ${context.orgId} hit a gated route`,
    });
  }
  return context;
}

/**
 * Seat role gate.
 *
 * KNOWN GAP, deliberately not papered over here: `orgs.ROLES` declares
 * admin | bidder | viewer, but `orgs.addMember` only ever writes 'admin' (the
 * first seat) or 'viewer' (everyone after), and no route promotes anyone. So
 * requireRole(ctx, 'admin', 'bidder') today means "the first person who signed
 * up". Seat management is its own piece of work; until it exists, calling this
 * with 'bidder' is correct and simply never matches.
 */
function requireRole(context, ...roles) {
  if (!roles.includes(context.role)) {
    throw forbidden('Your access level does not allow that. Ask your organisation’s admin.', {
      logDetail: `role=${context.role} needed one of ${roles.join('|')}`,
    });
  }
  return context;
}

module.exports = {
  requireUser,
  requireMember,
  requireProvider,
  requireAdmin,
  requirePartner,
  requireApproved,
  requireRole,
};
