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
const geo = require('./geo');
const cohorts = require('./cohorts');
const { unauthorized, forbidden, AppError } = require('./errors');

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

/* ------------------------------------------------------------------ *
 * Cohort geography
 * ------------------------------------------------------------------ */

/**
 * May this household take a place in this cohort?
 *
 * THE ONE ELIGIBILITY GATE, and it lives here because there are three doors
 * into a cohort and they are not going to stay three:
 *
 *   POST /campaigns/join    the original door: a seat, or a place on a list
 *   POST /cohorts/:id/join  the seat ledger's own door
 *   POST /campaigns/notify  a bell, which is NOT a join and does not call this
 *
 * A check written twice is a check that will eventually be written once. The
 * seat route arrived after the campaign route and inherited none of its rules
 * by accident once already, which is how a household could hold a seat the
 * other door would have refused; the fix then was seats.transition as the one
 * write, and this is the same fix for the one read.
 *
 * THE CLIENT'S ANSWER IS NEVER TRUSTED. lib/cohorts.js computes the same
 * eligibility on the read path so the dashboard can render the right card, and
 * this recomputes it from the campaign row and the member row at the instant
 * of the write. A request body claiming eligibility changes nothing: nothing
 * in this function reads the body.
 *
 * The bell is deliberately outside the gate. "Text me the day it opens" on a
 * cohort somewhere else is a wish, not a seat: it takes nothing from the
 * cohort, tells the household nothing about it, and refusing it would be the
 * site declining to be told what somebody wants.
 *
 * @param {object} campaign  a catalog row (carries `fsas`, `kind`, `dates`)
 * @param {object} user      the member row (carries `fsa`)
 * @param {number} now
 * @param {object} [opts]    { mine } this member's existing standing, if any
 */
function requireEligible(campaign, user, now, opts = {}) {
  const eligibility = geo.eligibilityOf(
    campaign,
    (user && user.fsa) || null,
    cohorts.joinsOpen(campaign, now),
    Boolean(opts.mine)
  );
  if (geo.canJoin(eligibility)) return eligibility;

  if (eligibility === 'not_in_area' && !(user && user.fsa)) {
    throw new AppError('POSTAL_MISSING',
      'Add your postal code first so we can check your cohort.', {
        logDetail: `join refused: ${campaign.id} member has no fsa`,
        extra: { reason: 'postal_code_missing' },
      });
  }
  if (eligibility === 'not_in_area') {
    /* The refusal names no FSA and no other region. A member who could probe
       this route would otherwise be able to read a cohort's coverage map back
       out of it one postal code at a time. */
    throw new AppError('NOT_IN_AREA',
      'This cohort is for a different postal code. Yours will show at the top of your dashboard when it opens.', {
        logDetail: `join refused: ${campaign.id} outside member fsa`,
        extra: { reason: 'not_in_area' },
      });
  }
  throw new AppError('JOIN_CLOSED',
    'This cohort isn’t taking new households right now.', {
      logDetail: `join refused: ${campaign.id} kind=${campaign.kind} not accepting joins`,
      extra: { reason: 'joins_closed' },
    });
}

module.exports = {
  requireEligible,
  requireUser,
  requireMember,
  requireProvider,
  requireAdmin,
  requirePartner,
  requireApproved,
  requireRole,
};
