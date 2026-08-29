'use strict';

/**
 * Delivery: won cohorts become rosters, and only a live connection bills.
 *
 *   GET  /provider/campaigns/:id/roster          counts, and orders only past the gate
 *   POST /provider/campaigns/:id/roster/gate     release the roster: billing, capacity, consent
 *   POST /provider/campaigns/:id/capacity        restate install capacity per week
 *   GET  /provider/orders                        every order this org holds, across cohorts
 *   POST /provider/orders/:key/slot              book, or rebook, an install
 *   POST /provider/orders/:key/activate          the ONLY event that creates a billable line
 *   POST /provider/orders/:key/exception         no-show, access denied, line test failed
 *   POST /provider/orders/:key/release           this household will not be served, with a reason
 *
 * THE INTIMATION BOUNDARY IS ENFORCED HERE, IN THIS FILE, AND NOWHERE ELSE.
 * Three server-side facts have to be true before one household address reaches
 * one partner:
 *
 *   1. an award row naming this org as the winner of this cohort,
 *   2. a completed roster gate: billing method on file, install capacity
 *      stated, and the confidentiality acknowledgement recorded,
 *   3. the household's own consent, recorded when it accepted the offer.
 *
 * Before the gate the roster response carries counts and the `orders` key is
 * ABSENT, not an empty array. Absent is unambiguous; `[]` cannot be told apart
 * from "the gate passed and nobody accepted", and a client cannot render rows
 * that were never transmitted. partner/core/contract.js asserts both shapes
 * from the client side as well, which is the point of asserting it twice.
 *
 * EVERY READ OF A RELEASED ROSTER IS AUDITED. Rows are fetched on view-open
 * and explicit refresh, never polled, and each read writes an auth_events row
 * naming the org, the cohort and the count. A partner reading a hundred
 * addresses leaves a hundred-address-shaped trace.
 *
 * NOTHING HERE TRUSTS A ROUTE PARAMETER FOR AN ORG. The org comes from the
 * session context, always, and an order belonging to another org answers
 * exactly like an order that does not exist.
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

const requirePartner = (req) => guardPartner(req, 'a /provider delivery route');

const notFound = (what) => new AppError('NOT_FOUND', what, { logDetail: 'delivery lookup miss' });

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * Install capacity, per week, in this region.
 *
 * Bounded rather than free: it is shown to households as the pace they can
 * book against, and a zero would offer them nothing while a four-figure number
 * would promise a pace no crew runs.
 */
function readCapacity(value) {
  const n = toInt(value);
  if (!n || n < 1 || n > 500) {
    throw badRequest('State how many installs you can run per week here, between 1 and 500.');
  }
  return n;
}

/**
 * The cohort, the award on it, and this org's standing.
 *
 * Sealing happens here, on read, because there is no cron: the first read
 * after a close writes the award. See lib/awards.js for why that is safer than
 * a schedule. A campaign this org did not win throws the same 404 as a
 * campaign that does not exist.
 */
async function requireWon(req, context) {
  /* catalog.load() returns { list, byId, source }, not an array. Reaching for
     .find on it is how this route answered every request with a 500 for one
     deploy: the lookup is byId, the same as every other caller. */
  const cat = await catalog.load(req.catalyst);
  const campaign = cat.byId.get(String(req.params.id || ''));
  if (!campaign) throw notFound('That cohort is not on your board.');

  /* Sealed-bid privacy: the all-orgs read stays inside lib/awards.js, so no
     competitor's row ever enters this partner-scoped request. The org is
     passed in rather than filtered out afterwards, because a cohort can now be
     won by several partners at once: asking for "the award" and comparing it
     to this org would hand back somebody else's row to compare against. */
  const award = await awards.sealFromCampaign(req.catalyst, campaign, context.orgId);
  if (!award) {
    throw notFound('That cohort is not on your board.');
  }
  return { campaign, award };
}

function mount(router) {
  /**
   * Endpoint 40. The roster.
   *
   * Counts always; addresses only past the gate. The gate object is returned
   * either way, because a partner who cannot see the roster is owed the reason
   * and the remaining step rather than an empty board.
   */
  router.get('/provider/campaigns/:id/roster', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);
    const { campaign, award } = await requireWon(req, context);

    const bill = await billing.methodFor(req.catalyst, context.orgId);
    const rows = await orders.rowsForCampaign(req.catalyst, context.orgId, campaign.id);
    const counts = orders.counts(rows || []);

    const payload = {
      campaign: { id: campaign.id, region: campaign.region, sub: campaign.sub || '' },
      award: awards.publicAward(award, bill),
      billing: billing.publicMethod(bill),
      counts,
      /* Unreadable is not empty. The console says "could not be read" rather
         than telling a partner that nobody accepted their offer. */
      live: rows !== null,
    };

    if (!awards.gatePassed(award, bill)) {
      /* No `orders` key at all. See the header, and contract.js rosterGated. */
      return ok(res, payload);
    }

    audit.recordAsync(req.catalyst, req, {
      type: 'roster.read',
      outcome: 'success',
      userId: user.user_id,
      detail: `org=${context.orgId} cohort=${campaign.id} orders=${counts.total}`,
    });

    return ok(res, Object.assign(payload, {
      orders: orders.sortForBoard(rows || []).map(orders.publicOrder),
    }));
  }));

  /**
   * Endpoint 41. The roster gate.
   *
   * All three conditions are checked here, server side, in this order, and the
   * refusal names the one that failed. The console draws the same three rows,
   * but the console is not what protects a household's address.
   */
  router.post('/provider/campaigns/:id/roster/gate', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);
    const { campaign, award } = await requireWon(req, context);

    const bill = await billing.methodFor(req.catalyst, context.orgId);
    if (!bill || !bill.onFile) {
      throw new AppError('CONFLICT',
        'Add a billing method first. Nothing is charged now: your first line is your first activation.', {
          logDetail: `roster gate without billing org=${context.orgId}`,
        });
    }

    const capacity = readCapacity((req.body || {}).capacityWeekly);
    if ((req.body || {}).consent !== true) {
      throw badRequest('Acknowledge how household details may be used before the roster releases.');
    }

    await awards.release(req.catalyst, award, { capacity, userId: user.user_id, at: Date.now() });

    audit.recordAsync(req.catalyst, req, {
      type: 'roster.release',
      outcome: 'success',
      userId: user.user_id,
      detail: `org=${context.orgId} cohort=${campaign.id} capacity=${capacity}`,
    });

    const rows = await orders.rowsForCampaign(req.catalyst, context.orgId, campaign.id);
    const fresh = await awards.findForOrg(req.catalyst, campaign.id, context.orgId);
    return ok(res, {
      award: awards.publicAward(fresh || award, bill),
      counts: orders.counts(rows || []),
      orders: orders.sortForBoard(rows || []).map(orders.publicOrder),
    });
  }));

  /**
   * Endpoint 49 and 50, as one route. Capacity is a single number and a
   * separate GET for it would be a second read of a row the roster already
   * returned.
   */
  router.post('/provider/campaigns/:id/capacity', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);
    const { campaign, award } = await requireWon(req, context);

    const capacity = readCapacity((req.body || {}).capacityWeekly);
    await awards.setCapacity(req.catalyst, award, capacity);

    audit.recordAsync(req.catalyst, req, {
      type: 'roster.capacity',
      outcome: 'success',
      userId: user.user_id,
      detail: `org=${context.orgId} cohort=${campaign.id} capacity=${capacity}`,
    });
    return ok(res, { capacityWeekly: capacity });
  }));

  /**
   * Every order this org holds, across cohorts, for the delivery board's
   * cohort picker and for the billing page's line derivation.
   *
   * Addresses are included ONLY for cohorts whose gate has passed, decided per
   * cohort rather than for the whole response: a partner with two won cohorts
   * and one released roster sees one set of addresses.
   */
  router.get('/provider/orders', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);

    const bill = await billing.methodFor(req.catalyst, context.orgId);
    const awardRows = await awards.rowsForOrg(req.catalyst, context.orgId);
    const rows = await orders.rowsForOrg(req.catalyst, context.orgId);

    const released = {};
    (awardRows || []).forEach((a) => {
      if (awards.gatePassed(a, bill)) released[a.campaign_id] = true;
    });

    const byCampaign = {};
    (rows || []).forEach((r) => {
      const list = byCampaign[r.campaign_id] || (byCampaign[r.campaign_id] = []);
      list.push(r);
    });

    const cohorts = (awardRows || []).map((a) => {
      const mine = byCampaign[a.campaign_id] || [];
      const out = {
        campaignId: a.campaign_id,
        award: awards.publicAward(a, bill),
        counts: orders.counts(mine),
      };
      if (released[a.campaign_id]) {
        out.orders = orders.sortForBoard(mine).map(orders.publicOrder);
      }
      return out;
    });

    const shown = cohorts.reduce((t, c) => t + (c.orders ? c.orders.length : 0), 0);
    if (shown) {
      audit.recordAsync(req.catalyst, req, {
        type: 'roster.read',
        outcome: 'success',
        userId: user.user_id,
        detail: `org=${context.orgId} cohorts=${cohorts.length} orders=${shown}`,
      });
    }

    return ok(res, { cohorts, live: rows !== null && awardRows !== null });
  }));

  /* ---------------------------------------------------------------- *
   * One order at a time
   * ---------------------------------------------------------------- */

  /** The order, plus the award and gate that authorise touching it. */
  async function requireOrder(req, context) {
    const row = await orders.findByKey(req.catalyst, context.orgId, String(req.params.key || ''));
    if (!row) throw notFound('That order is not on your board.');

    const award = await awards.findForOrg(req.catalyst, row.campaign_id, context.orgId);
    const bill = await billing.methodFor(req.catalyst, context.orgId);
    if (!award || !awards.gatePassed(award, bill)) {
      /* The gate is not merely a view filter: without it there is no authority
         to act on the household either. */
      throw notFound('That order is not on your board.');
    }
    return { row, award, bill };
  }

  /**
   * Endpoint 44. Book or rebook an install.
   *
   * The household picks the slot in the member flow; a partner books on their
   * behalf when the household asked for a date by phone, which is most of
   * them. Either way the slot is a fact about an appointment, so it is dated
   * and it is recorded.
   */
  router.post('/provider/orders/:key/slot', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);
    const { row } = await requireOrder(req, context);

    const at = Date.now();
    const slot = orders.readSlot((req.body || {}).slotAt, at);
    orders.requireTransition(row.state, 'bkd');

    await orders.move(req.catalyst, row, 'bkd', {
      slot_at: datastore.toDb(new Date(slot)),
      note: row.state === 'acc' ? 'Booked' : 'Rebooked, household confirmed',
    }, at);

    audit.recordAsync(req.catalyst, req, {
      type: 'order.slot',
      outcome: 'success',
      userId: user.user_id,
      detail: `org=${context.orgId} order=${row.order_no || row.order_key}`,
    });
    return ok(res, { order: orders.publicOrder(await orders.findAnyByKey(req.catalyst, row.order_key)) });
  }));

  /**
   * Endpoint 45. THE ONLY EVENT THAT CREATES A BILLABLE LINE.
   *
   * Two assertions are required and both are recorded: the line tested clean,
   * and the incumbent service was confirmed cancelled. Neither is inferable
   * from anything else the system holds, both are things the partner knows and
   * we do not, and a fee that accrues without them is a fee nobody can defend
   * in a dispute.
   */
  router.post('/provider/orders/:key/activate', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);
    const { row } = await requireOrder(req, context);

    const b = req.body || {};
    if (b.lineTestClean !== true) {
      throw badRequest('An activation needs a clean line test. Log the failure as an exception instead, and the fee holds.');
    }
    if (b.incumbentCancelled !== true) {
      throw badRequest('Confirm the incumbent service is cancelled. A household paying twice is a switch that has not finished.');
    }
    orders.requireTransition(row.state, 'act');

    const at = Date.now();
    await orders.move(req.catalyst, row, 'act', {
      activated_at: datastore.toDb(new Date(at)),
      note: 'Line test clean, incumbent cancellation confirmed',
    }, at);

    audit.recordAsync(req.catalyst, req, {
      type: 'order.activate',
      outcome: 'success',
      userId: user.user_id,
      detail: `org=${context.orgId} cohort=${row.campaign_id} order=${row.order_no || row.order_key}`,
    });
    return ok(res, { order: orders.publicOrder(await orders.findAnyByKey(req.catalyst, row.order_key)) });
  }));

  /**
   * Endpoint 47. An exception, chosen by the partner.
   *
   * The prototype randomised which of the three it was, which is fine in a
   * demo and would be a lie in a record: the partner was there and we were
   * not. A line-test failure holds the fee rather than billing it, and holding
   * is a state, not a deletion.
   */
  router.post('/provider/orders/:key/exception', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);
    const { row } = await requireOrder(req, context);

    const kind = String((req.body || {}).kind || '').trim();
    if (orders.EXCEPTIONS.indexOf(kind) < 0) {
      throw badRequest('Say which exception this was: no-show, access denied, or line test failed.');
    }
    orders.requireTransition(row.state, kind);

    const NOTE = {
      noshow: 'Household not home. Missed-visit credit applies and three slots are offered.',
      access: 'Access to the building or utility room was not in place.',
      linefail: 'Line tested below the bid tier. The fee holds until a clean retest.',
    };
    await orders.move(req.catalyst, row, kind, { note: NOTE[kind] }, Date.now());

    audit.recordAsync(req.catalyst, req, {
      type: 'order.exception',
      outcome: 'success',
      userId: user.user_id,
      detail: `org=${context.orgId} order=${row.order_no || row.order_key} kind=${kind}`,
    });
    return ok(res, { order: orders.publicOrder(await orders.findAnyByKey(req.catalyst, row.order_key)) });
  }));

  /**
   * Endpoint 46. Release a household this partner cannot serve.
   *
   * The reason comes from the enum and never from free text, because it feeds
   * the serviceability figure that future briefs carry beside this partner's
   * bid. Releasing costs nothing on either side, and saying so in the response
   * is deliberate: a release that felt like a penalty would be a release that
   * happened as a no-show three weeks later.
   */
  router.post('/provider/orders/:key/release', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);
    const { row } = await requireOrder(req, context);

    const reason = String((req.body || {}).reason || '').trim();
    if (orders.RELEASE_REASONS.indexOf(reason) < 0) {
      throw badRequest('Pick a release reason. It feeds your serviceability figure, so it cannot be free text.');
    }
    orders.requireTransition(row.state, 'rel');

    await orders.move(req.catalyst, row, 'rel', {
      release_reason: reason,
      note: 'Released before install. Nothing bills on either side.',
    }, Date.now());

    audit.recordAsync(req.catalyst, req, {
      type: 'order.release',
      outcome: 'success',
      userId: user.user_id,
      detail: `org=${context.orgId} order=${row.order_no || row.order_key} reason=${reason}`,
    });
    return ok(res, { order: orders.publicOrder(await orders.findAnyByKey(req.catalyst, row.order_key)) });
  }));
}

module.exports = { mount, requireWon };
