'use strict';

/**
 * Billing: a success fee when a switch completes, and only then.
 *
 *   GET    /provider/billing/cycle          what is accruing right now
 *   GET    /provider/statements             one statement per won cohort
 *   GET    /provider/statements/:campaign   one statement, with its lines
 *   POST   /provider/orders/:key/dispute    flag one line, freeze only that line
 *   GET    /provider/billing/method         the method on file
 *   POST   /provider/billing/method         add or replace it
 *   DELETE /provider/billing/method         take it off file
 *
 * A STATEMENT IS A VIEW OVER ORDERS. lib/billing.js explains why nothing here
 * writes a line: the events are already recorded on the delivery board, and a
 * second copy would drift from them. This route reads orders, applies the
 * configured fee, and returns arithmetic anyone can check against the board.
 *
 * THE FEE IS CONFIGURATION, NEVER A CONSTANT. It is read from site config per
 * request, so an agreement change takes effect without a deploy and no number
 * in this file can contradict the agreement.
 *
 * A DISPUTE FREEZES ONE LINE. Not the statement: a partner who disagrees with
 * one activation should not have to withhold the other forty. The disputed
 * line drops out of the total and says why, and the order it points at is
 * untouched, because a dispute is a claim about a fee and not a claim that the
 * install did not happen.
 *
 * NOTHING HERE CAN CHARGE ANYTHING. There is no payment service provider in
 * this stack. What a partner puts on file is an invoicing arrangement, and
 * every screen says so rather than implying a card is about to be debited.
 */

const catalog = require('../lib/catalog');
const awards = require('../lib/awards');
const orders = require('../lib/orders');
const billing = require('../lib/billing');
const audit = require('../lib/audit');
const datastore = require('../lib/datastore');
const { ok } = require('../lib/envelope');
const { requirePartner: guardPartner, requireApproved } = require('../lib/guards');
const { wrap, badRequest, AppError } = require('../lib/errors');

const requirePartner = (req) => guardPartner(req, 'a /provider billing route');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

/** Where a statement goes. Validated, because an invoice to a typo is a
    partner who learns what they owe from a late notice. */
function readEmail(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!EMAIL_RE.test(s) || s.length > 255) {
    throw badRequest('Enter the email address statements should go to.');
  }
  return s;
}

function readContact(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (s.length < 2) throw badRequest('Name who to address the statement to.');
  return s.slice(0, 120);
}

/**
 * Every statement this org has, derived. One per cohort it has won, whether or
 * not anything has activated: a won cohort with nothing activated yet is a
 * statement reading zero, which is a true and useful thing to see.
 */
async function buildStatements(req, context) {
  const cat = await catalog.load(req.catalyst);
  const byId = {};
  (cat || []).forEach((c) => { byId[c.id] = c; });

  const awardRows = await awards.rowsForOrg(req.catalyst, context.orgId);
  const orderRows = await orders.rowsForOrg(req.catalyst, context.orgId);
  const settlements = await billing.settlementsFor(req.catalyst, context.orgId);
  const t = await billing.terms(req.catalyst);

  const byCampaign = {};
  (orderRows || []).forEach((r) => {
    (byCampaign[r.campaign_id] || (byCampaign[r.campaign_id] = [])).push(r);
  });

  const statements = (awardRows || [])
    .filter((a) => byId[a.campaign_id])
    .map((a) => billing.statementFor({
      campaign: byId[a.campaign_id],
      rows: byCampaign[a.campaign_id] || [],
      t,
      settlement: settlements[a.campaign_id] || null,
    }));

  /* Accruing first, then most recently issued: what is open outranks what is
     closed on a page a partner opens to see what they owe. */
  statements.sort((x, y) => {
    if ((x.state === 'accruing') !== (y.state === 'accruing')) return x.state === 'accruing' ? -1 : 1;
    return (y.issuedAt || 0) - (x.issuedAt || 0);
  });

  return { statements, t, live: awardRows !== null && orderRows !== null };
}

function mount(router) {
  /** Endpoint 53. The current cycle: one sentence's worth of numbers. */
  router.get('/provider/billing/cycle', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    requireApproved(context);
    const { statements, t, live } = await buildStatements(req, context);
    const method = await billing.methodFor(req.catalyst, context.orgId);
    return ok(res, {
      cycle: billing.cycleFor(statements, t),
      method: billing.publicMethod(method),
      live,
    });
  }));

  /** Endpoint 54. Every statement, per cohort, never per month. */
  router.get('/provider/statements', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    requireApproved(context);
    const { statements, t, live } = await buildStatements(req, context);
    const method = await billing.methodFor(req.catalyst, context.orgId);
    return ok(res, {
      statements,
      cycle: billing.cycleFor(statements, t),
      method: billing.publicMethod(method),
      live,
    });
  }));

  /**
   * Endpoint 55. One statement, with the order behind every line.
   *
   * The line rows carry the order number and the activation date and no
   * address: a statement is a financial document, and a partner reconciling
   * one does not need a household's street to do it. The board has the
   * address, under the consent that released it.
   */
  router.get('/provider/statements/:campaign', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    requireApproved(context);

    const id = String(req.params.campaign || '');
    const { statements } = await buildStatements(req, context);
    const statement = statements.find((s) => s.campaignId === id);
    if (!statement) {
      throw new AppError('NOT_FOUND', 'No statement for that cohort.', {
        logDetail: 'statement lookup miss',
      });
    }

    const rows = await orders.rowsForCampaign(req.catalyst, context.orgId, id);
    const billable = (rows || [])
      .filter((r) => r.state === 'act' || r.state === 'noshow' || r.state === 'linefail')
      .map((r) => ({
        key: r.order_key,
        orderNo: r.order_no || null,
        state: r.state,
        activatedAt: r.activated_at ? new Date(String(r.activated_at).replace(' ', 'T') + 'Z').getTime() : null,
        disputeState: r.dispute_state || null,
        disputeNote: r.dispute_note || null,
      }));

    return ok(res, { statement, lines: billable });
  }));

  /**
   * Endpoint 57. Dispute one line.
   *
   * Recorded on the order, because the line is the order. Fourteen days is the
   * window the billing page states; it is not enforced here, deliberately: a
   * partner who is late with a dispute should be told by a person, not refused
   * by a route that has no idea whether the delay was ours.
   */
  router.post('/provider/orders/:key/dispute', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);

    const row = await orders.findByKey(req.catalyst, context.orgId, String(req.params.key || ''));
    if (!row) {
      throw new AppError('NOT_FOUND', 'That line is not on your statement.', {
        logDetail: 'dispute lookup miss',
      });
    }
    if (row.state !== 'act' && row.state !== 'noshow' && row.state !== 'linefail') {
      throw badRequest('That order has no line on a statement to dispute.');
    }

    const note = String((req.body || {}).note || '').replace(/\s+/g, ' ').trim();
    if (note.length < 10) throw badRequest('Say what is wrong with the line, in a sentence.');

    await datastore.updateRow(req.catalyst, orders.ORDERS, {
      ROWID: row.ROWID,
      dispute_state: 'open',
      dispute_note: note.slice(0, 400),
      disputed_at: datastore.nowDb(),
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'statement.dispute',
      outcome: 'success',
      userId: user.user_id,
      detail: `org=${context.orgId} order=${row.order_no || row.order_key}`,
    });

    return ok(res, { disputed: true, key: row.order_key });
  }));

  /* ---------------------------------------------------------------- *
   * The method on file
   * ---------------------------------------------------------------- */

  /** Endpoint 58. */
  router.get('/provider/billing/method', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const method = await billing.methodFor(req.catalyst, context.orgId);
    return ok(res, { method: billing.publicMethod(method) });
  }));

  /**
   * Endpoint 59, as a write rather than a redirect to a hosted checkout.
   *
   * requirePartner and not requireApproved: an org under review can put its
   * invoicing details on file, and asking it to come back and do that at the
   * exact moment it first wins a cohort is how a roster sits gated for a day.
   */
  router.post('/provider/billing/method', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    const b = req.body || {};
    if (b.acceptsNet15 !== true) {
      throw badRequest('Accept net-15 settlement on activated households before we put a method on file.');
    }
    const email = readEmail(b.email);
    const contact = readContact(b.contact);

    const method = await billing.putMethod(req.catalyst, {
      orgId: context.orgId, email, contact, userId: user.user_id, at: Date.now(),
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'billing.method',
      outcome: 'success',
      userId: user.user_id,
      detail: `org=${context.orgId} method=invoice`,
    });
    return ok(res, { method: billing.publicMethod(method) });
  }));

  /**
   * Endpoint 60. Take it off file.
   *
   * The row is retired, not deleted: it is what a released roster was gated
   * on, and deleting it would erase the evidence that the gate was ever
   * legitimately passed. A retired method fails the gate from that moment on,
   * which is what taking it off file is supposed to mean.
   */
  router.delete('/provider/billing/method', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    const existing = await billing.methodFor(req.catalyst, context.orgId);
    if (existing) {
      await datastore.updateRow(req.catalyst, billing.BILLING, {
        ROWID: existing.ROWID,
        state: 'retired',
        updated_at: datastore.nowDb(),
      });
      audit.recordAsync(req.catalyst, req, {
        type: 'billing.method',
        outcome: 'success',
        userId: user.user_id,
        detail: `org=${context.orgId} retired`,
      });
    }
    return ok(res, { method: billing.publicMethod(await billing.methodFor(req.catalyst, context.orgId)) });
  }));
}

module.exports = { mount };
