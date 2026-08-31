'use strict';

/**
 * The reminder sweep: the one thing here that fires because nothing happened.
 *
 * WHY THIS EXISTS SEPARATELY FROM lib/notify/events.js. An event emitter is
 * called by the route that caused the event, and it knows exactly who and
 * what. A reminder has no route and no cause: it has a deadline, a list of
 * people who have not acted, and a clock. So it is a sweep, and it looks like
 * lib/notices.js on purpose, because that is the shape this codebase already
 * uses for "there is no cron here".
 *
 * THE OFFSET IS PART OF THE IDENTITY. `outbox.enqueue` takes a `slot`, which
 * goes into the idempotency key, so "the 24 hour reminder for this cohort" and
 * "the 2 hour reminder" are different rows while a second sweep of either is a
 * no-op. That is what lets this run on every dashboard load and on a timer at
 * the same time without anybody being reminded twice.
 *
 * THE WINDOW IS BEHIND, NOT AHEAD. A T-24h reminder is enqueued when the
 * deadline is between 24 hours and 24 hours minus the window away. Reading it
 * as "less than 24 hours away" would fire the 24 hour reminder again at 23, at
 * 22, and at every sweep until the deadline: the idempotency key stops the
 * duplicate rows, but the first sweep after the deadline enters T-2h territory
 * and the semantics stop meaning anything. A bounded window keeps each offset
 * to the moment it names.
 *
 * SENDING IS NOT THIS MODULE'S JOB. Every row is enqueued and the drain sends
 * it, which is what puts quiet hours, suppression and the still-relevant
 * re-check between the decision to remind and the reminder. A reminder is the
 * message most likely to be wrong by the time it goes out, so it is the one
 * that most needs that gap.
 */

const datastore = require('../datastore');
const catalog = require('../catalog');
const users = require('../users');
const orgs = require('../orgs');
const outbox = require('./outbox');

const ORDERS = 'provider_orders';
const COVERAGE = 'provider_coverage';

const HOUR = 3600 * 1000;

/**
 * How wide a sweep looks around each offset.
 *
 * Has to exceed the interval between sweeps or an offset is missed entirely.
 * Ninety minutes covers an hourly timer with room, and covers the read-driven
 * case where sweeps are irregular. Wider is safe: a second sweep inside the
 * same window enqueues the same key and writes nothing.
 */
const WINDOW_MS = 90 * 60 * 1000;

/** Households mailed per cohort per sweep. A larger cohort finishes next time. */
const BATCH = 120;

/* The offsets, in hours before the deadline. Decided rather than configured:
   a reminder cadence is a product judgement, and one in a config table is one
   nobody can see while reading the code that sends it. */
const OFFER_OFFSETS = Object.freeze([72, 24]);
const INSTALL_OFFSETS = Object.freeze([24]);
const BID_CLOSE_OFFSETS = Object.freeze([24, 2]);

/** Is `deadline` currently sitting `hours` out, within the sweep window? */
function due(now, deadline, hours) {
  if (!deadline) return false;
  const at = deadline - hours * HOUR;
  return now >= at && now < at + WINDOW_MS;
}

const slotLabel = (hours) => `t-${hours}h`;

const base = (cfg) => String((cfg && cfg.APP_BASE_URL) || 'https://www.whollar.ca').replace(/\/+$/, '');

/* ------------------------------------------------------------------ *
 * Reads, each campaign-scoped and each degrading to nothing
 * ------------------------------------------------------------------ */

/**
 * Every order on one cohort, across orgs.
 *
 * lib/orders.js exposes rowsForCampaign(orgId, campaignId) and nothing wider,
 * because a partner route must never read another partner's orders. This is
 * not a partner route: it runs to decide who needs reminding, nothing derived
 * from it reaches a partner, and the only thing that leaves is an email to the
 * household named on the row. The projection is the base column list, so it
 * works on a table created before any of the later sections.
 */
async function ordersOn(catalystApp, campaignId) {
  try {
    return await datastore.queryAll(catalystApp, ORDERS,
      ['order_key', 'order_no', 'campaign_id', 'org_id', 'member_user_id',
        'state', 'slot_at'],
      `campaign_id = ${datastore.lit(campaignId)}`) || [];
  } catch {
    return [];
  }
}

/** The orgs claiming coverage of one region. Empty when unreadable. */
async function orgsCovering(catalystApp, region) {
  if (!region) return [];
  try {
    const rows = await datastore.queryAll(catalystApp, COVERAGE, ['org_id', 'region'],
      `region = ${datastore.lit(String(region))}`) || [];
    return Array.from(new Set(rows.map((r) => String(r.org_id)).filter(Boolean)));
  } catch {
    return [];
  }
}

/** The households standing in one cohort, by user id. */
async function householdsOn(catalystApp, campaign) {
  const ids = new Set();
  try {
    const claims = await datastore.queryAll(catalystApp, 'seat_claim', ['member_id'],
      `cohort_id = ${datastore.lit(campaign.id)} AND status = 'active'`) || [];
    for (const r of claims) if (r.member_id) ids.add(String(r.member_id));
  } catch { /* the membership snapshot below still answers */ }
  try {
    const rows = await datastore.queryAll(catalystApp, 'campaign_members', ['user_id', 'status'],
      `campaign_id = ${datastore.lit(campaign.id)}`) || [];
    for (const r of rows) {
      if (catalog.standingOf(r.status, campaign) === 'joined') ids.add(String(r.user_id));
    }
  } catch { /* nothing to remind */ }
  return Array.from(ids).slice(0, BATCH);
}

/** A member recipient, or null when there is nobody to write to. */
async function recipientFor(catalystApp, userId) {
  try {
    const u = await users.findById(catalystApp, userId);
    if (!u || !u.email_normalized) return null;
    return {
      type: 'member',
      id: u.user_id,
      email: u.email_normalized,
      locale: u.locale || 'en',
      timezone: u.timezone || 'America/Toronto',
      firstName: u.first_name || null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The three sweeps
 * ------------------------------------------------------------------ */

/**
 * Households with an offer and no decision, as the decision deadline nears.
 *
 * "No decision" is "no order row", because in this product accepting is what
 * creates one. Read once per cohort and turned into a set, rather than a
 * lookup per household: a hundred households would otherwise be a hundred
 * reads on every sweep.
 */
async function sweepOffers(catalystApp, cfg, campaign, now, out) {
  const decideBy = (campaign.dates && campaign.dates.decision_at) || null;
  const hours = OFFER_OFFSETS.filter((n) => due(now, decideBy, n));
  if (!hours.length) return;

  const decided = new Set(
    (await ordersOn(catalystApp, campaign.id)).map((r) => String(r.member_user_id))
  );
  const households = await householdsOn(catalystApp, campaign);

  for (const id of households) {
    if (decided.has(String(id))) continue;
    /* eslint-disable-next-line no-await-in-loop */
    const recipient = await recipientFor(catalystApp, id);
    if (!recipient) continue;
    for (const n of hours) {
      /* eslint-disable-next-line no-await-in-loop */
      const r = await outbox.enqueue(catalystApp, cfg, {
        templateKey: 'member.offer.reminder',
        eventKey: `offer.reminder:${campaign.id}`,
        slot: slotLabel(n),
        recipient,
        campaignId: campaign.id,
        context: {
          region_label: campaign.region,
          decide_by_at: decideBy,
          hours_left: n,
          /* Carried so stillRelevant can re-ask at send time. */
          campaign_id: campaign.id,
          user_id: recipient.id,
          dashboard_url: `${base(cfg)}/dashboard`,
          first_name: recipient.firstName,
        },
        now,
      });
      if (r && r.created) out.queued += 1;
    }
  }
}

/** Booked installs a day out. */
async function sweepInstalls(catalystApp, cfg, campaign, now, out) {
  const rows = (await ordersOn(catalystApp, campaign.id)).filter((r) => r.state === 'bkd');
  if (!rows.length) return;

  for (const row of rows) {
    const slotAt = row.slot_at
      ? new Date(String(row.slot_at).replace(' ', 'T') + 'Z').getTime() : null;
    const hours = INSTALL_OFFSETS.filter((n) => due(now, slotAt, n));
    if (!hours.length) continue;

    /* eslint-disable-next-line no-await-in-loop */
    const recipient = await recipientFor(catalystApp, row.member_user_id);
    if (!recipient) continue;
    /* eslint-disable-next-line no-await-in-loop */
    const partner = await partnerName(catalystApp, row.org_id);

    for (const n of hours) {
      /* eslint-disable-next-line no-await-in-loop */
      const r = await outbox.enqueue(catalystApp, cfg, {
        templateKey: 'member.install.reminder',
        /* Keyed on the order AND the slot, so a rebooking earns a fresh
           reminder rather than being deduplicated against the old day's. */
        eventKey: `install.reminder:${row.order_key}:${slotAt}`,
        slot: slotLabel(n),
        recipient,
        campaignId: campaign.id,
        context: {
          partner_name: partner,
          slot_at: slotAt,
          order_no: row.order_no || null,
          order_key: row.order_key,
          dashboard_url: `${base(cfg)}/dashboard`,
          first_name: recipient.firstName,
        },
        now,
      });
      if (r && r.created) out.queued += 1;
    }
  }
}

/**
 * Partners whose bid window is about to close.
 *
 * Coverage-matched, not bid-matched: the partner who most needs this is the
 * one who has not bid, and a sweep over bidders would reach only the partners
 * who did not need reminding. `has_bid` changes the wording and never the
 * recipient list.
 */
async function sweepBidClose(catalystApp, cfg, campaign, now, out) {
  const closesAt = (campaign.dates && campaign.dates.bidding_closes_at) || null;
  const hours = BID_CLOSE_OFFSETS.filter((n) => due(now, closesAt, n));
  if (!hours.length) return;
  if (campaign.kind !== 'auction') return;

  const covering = await orgsCovering(catalystApp, campaign.region);
  if (!covering.length) return;

  /* One read, not one per org: which orgs already hold a bid here. Used for
     the wording only. */
  let bidders = new Set();
  try {
    const rows = await datastore.queryAll(catalystApp, 'provider_bids', ['org_id', 'campaign_id'],
      `campaign_id = ${datastore.lit(campaign.id)}`) || [];
    bidders = new Set(rows.map((r) => String(r.org_id)));
  } catch { /* wording falls back to "you have not bid", which is the safer half */ }

  for (const orgId of covering) {
    /* eslint-disable-next-line no-await-in-loop */
    const contacts = await bidContacts(catalystApp, orgId);
    for (const recipient of contacts) {
      for (const n of hours) {
        /* eslint-disable-next-line no-await-in-loop */
        const r = await outbox.enqueue(catalystApp, cfg, {
          templateKey: 'partner.bid.close_reminder',
          eventKey: `bid.close_reminder:${campaign.id}:${orgId}`,
          slot: slotLabel(n),
          recipient,
          campaignId: campaign.id,
          context: {
            region_label: campaign.region,
            cohort_label: campaign.sub || null,
            closes_at: closesAt,
            hours_left: n,
            has_bid: bidders.has(String(orgId)),
            campaign_id: campaign.id,
            console_url: `${base(cfg)}/partner`,
          },
          now,
        });
        if (r && r.created) out.queued += 1;
      }
    }
  }
}

/** Active people at one org, as partner recipients. */
async function bidContacts(catalystApp, orgId) {
  let rows = [];
  try {
    rows = await orgs.membersOf(catalystApp, orgId) || [];
  } catch {
    return [];
  }
  const out = [];
  for (const m of rows) {
    /* eslint-disable-next-line no-await-in-loop */
    const r = await recipientFor(catalystApp, m.user_id);
    if (r) out.push({ ...r, type: 'partner' });
  }
  return out;
}

async function partnerName(catalystApp, orgId) {
  if (!orgId) return null;
  try {
    const org = await orgs.findById(catalystApp, orgId);
    return org ? (org.legal_name || null) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

/**
 * One sweep over every campaign.
 *
 * `states` are cohorts.state() objects when a read path has them, exactly as
 * lib/notices.js takes them, so a dashboard load reuses work it has already
 * done. The tick route passes none and this loads the catalog itself.
 *
 * -> { swept, queued }
 */
async function sweep(catalystApp, cfg, states, now = Date.now()) {
  const out = { swept: 0, queued: 0 };
  if (!cfg) return out;

  let campaigns;
  if (Array.isArray(states) && states.length) {
    campaigns = states.map((s) => s.campaign).filter(Boolean);
  } else {
    try {
      campaigns = (await catalog.load(catalystApp)).list || [];
    } catch {
      return out;
    }
  }

  for (const campaign of campaigns) {
    if (!campaign || campaign.kind === 'archived') continue;
    out.swept += 1;
    /* Each sweep is independent: one unreadable table must not cost the other
       two their reminders. */
    /* eslint-disable no-await-in-loop */
    try { await sweepOffers(catalystApp, cfg, campaign, now, out); } catch { /* next */ }
    try { await sweepInstalls(catalystApp, cfg, campaign, now, out); } catch { /* next */ }
    try { await sweepBidClose(catalystApp, cfg, campaign, now, out); } catch { /* next */ }
    /* eslint-enable no-await-in-loop */
  }
  return out;
}

/** Fire and forget, for a read path that must not wait on a sweep. */
function sweepAsync(catalystApp, cfg, states, now) {
  Promise.resolve(sweep(catalystApp, cfg, states, now)).catch(() => {});
}

module.exports = {
  WINDOW_MS, BATCH, OFFER_OFFSETS, INSTALL_OFFSETS, BID_CLOSE_OFFSETS,
  due, slotLabel, sweep, sweepAsync,
  sweepOffers, sweepInstalls, sweepBidClose,
  ordersOn, orgsCovering, householdsOn,
};
