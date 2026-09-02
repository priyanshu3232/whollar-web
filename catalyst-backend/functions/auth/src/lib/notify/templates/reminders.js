'use strict';

/**
 * The three reminders, and the thing that makes them different from every
 * other template here.
 *
 * EVERY OTHER LETTER IS SENT BECAUSE SOMETHING HAPPENED. These are sent
 * because nothing did. Your deadline is tomorrow and you have not decided;
 * bidding closes in two hours and you have not bid. There is no event, no
 * route, no click. A scheduler looks at the clock and asks who is about to
 * miss something.
 *
 * WHICH MEANS THEY CAN BE WRONG BY THE TIME THEY SEND. A reminder queued at
 * nine in the evening for a household that decides at eleven is a nag at
 * somebody who already acted, and it is the specific failure that makes people
 * distrust every later email. So each one declares `stillRelevant`, the outbox
 * re-asks it immediately before sending, and a reminder whose reason has gone
 * is cancelled rather than delivered. That predicate is not a nicety; it is
 * the reason a reminder is allowed to exist at all.
 *
 * NONE OF THEM ADDS INFORMATION. A reminder repeats a fact the recipient
 * already has, so it stays short, names the deadline, and links to the one
 * place the thing gets done. A reminder that explains itself at length reads
 * as a new letter and gets answered as one.
 */

const orders = require('../../orders');
const catalog = require('../../catalog');

/** The order this household holds on this cohort, or null. */
async function orderFor(catalystApp, campaignId, userId) {
  try {
    return await orders.findAnyByKey(catalystApp, `${campaignId}:${userId}`.slice(0, 200));
  } catch {
    return null;
  }
}

module.exports = [

  /* ---------------------------------------------------------------- *
   * The decision
   * ---------------------------------------------------------------- */

  {
    key: 'member.offer.reminder',
    audience: 'member',
    casl: 'transactional',
    priority: 'reminder',
    category: 'campaign_steps',
    /* Two offsets on one cohort collapse to the later one if they ever land
       together, which they should not, but a clock that drifts is not a
       reason to send both. */
    collapse: 'offer_reminder',
    collapseMode: 'supersede',
    required: ['region_label', 'decide_by_at', 'dashboard_url'],
    fixtures: [
      { region_label: 'Brampton East', decide_by_at: 1787600000000, hours_left: 72,
        dashboard_url: 'https://internet.whollar.ca/dashboard', first_name: 'Sam' },
      { region_label: 'Brampton East', decide_by_at: 1787600000000, hours_left: 24,
        dashboard_url: 'https://internet.whollar.ca/dashboard', first_name: 'Sam' },
    ],
    /**
     * Relevant only while no order stands.
     *
     * An order IS the decision in this product: accepting is what creates one.
     * So a household with any order, in any state, has decided and must not be
     * reminded. A household whose order was released has been told that
     * separately and is not chased about a deadline for an offer that no
     * longer has a partner behind it.
     */
    stillRelevant: async (ctx, { catalystApp }) => {
      if (!ctx.campaign_id || !ctx.user_id) return true;
      const row = await orderFor(catalystApp, ctx.campaign_id, ctx.user_id);
      return !row;
    },
    locales: {
      en: (c, h) => {
        const soon = Number(c.hours_left) <= 24;
        return {
          subject: soon
            ? `Last day to take your ${c.region_label} offer`
            : `Your ${c.region_label} offer closes soon`,
          preheader: `Deciding by ${h.when(c.decide_by_at)}. Passing is free.`,
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero(soon
              ? `Your offer for ${c.region_label} closes tomorrow and you have not taken it yet.`
              : `Your offer for ${c.region_label} is still open, and it closes soon.`),
            h.B.rows([['Closes', h.when(c.decide_by_at)]]),
            h.B.soft('Taking it books your install in the same step, and nothing is charged for switching. Passing is free and costs you nothing later.'),
            h.B.action('Take it or pass', c.dashboard_url, `Before ${h.when(c.decide_by_at)}`),
            h.B.note('Doing nothing is also an answer: the offer simply lapses and you stay where you are.'),
          ],
        };
      },
    },
  },

  /* ---------------------------------------------------------------- *
   * The install
   * ---------------------------------------------------------------- */

  {
    key: 'member.install.reminder',
    audience: 'member',
    casl: 'transactional',
    priority: 'reminder',
    category: 'delivery',
    collapse: null,
    required: ['partner_name', 'slot_at', 'dashboard_url'],
    fixture: {
      partner_name: 'Northline Fibre', slot_at: 1787600000000,
      slot_window: 'Morning, 8am to 12pm', order_no: 'WH-10428',
      dashboard_url: 'https://internet.whollar.ca/dashboard', first_name: 'Sam',
    },
    /**
     * Relevant only while the order is still booked for the day this reminder
     * was written about.
     *
     * Both halves matter. A released or activated order is not an appointment
     * any more. A REBOOKED one is an appointment on a different day, and
     * reminding a household about the old day would be worse than silence:
     * they would take a morning off for a visit nobody is making.
     */
    stillRelevant: async (ctx, { catalystApp }) => {
      if (!ctx.order_key) return true;
      let row = null;
      try {
        row = await orders.findAnyByKey(catalystApp, ctx.order_key);
      } catch {
        return true;   // unreadable is not a reason to withhold
      }
      if (!row || row.state !== 'bkd') return false;
      if (!ctx.slot_at) return true;
      const d = row.slot_at ? new Date(String(row.slot_at).replace(' ', 'T') + 'Z') : null;
      return Boolean(d) && Math.abs(d.getTime() - Number(ctx.slot_at)) < 60000;
    },
    locales: {
      en: (c, h) => ({
        subject: `Your install is tomorrow`,
        preheader: `${c.partner_name}, ${c.slot_window || h.day(c.slot_at)}.`,
        greeting: h.greet(c.first_name),
        blocks: [
          h.B.hero(`${c.partner_name} is installing your line tomorrow.`),
          h.B.rows([['Day', h.day(c.slot_at)]]
            .concat(c.slot_window ? [['Arrival window', c.slot_window]] : [])
            .concat(c.order_no ? [['Reference', c.order_no]] : [])),
          h.B.soft('Someone over eighteen at home for the window, access to where the line comes in, and your mobile reachable. The crew calls before they arrive.'),
          h.B.para('Your old service stays up until the new line passes its test.'),
          h.B.action('Change the day', c.dashboard_url),
        ],
      }),
    },
  },

  /* ---------------------------------------------------------------- *
   * The bid window
   * ---------------------------------------------------------------- */

  {
    key: 'partner.bid.close_reminder',
    audience: 'partner',
    casl: 'transactional',
    priority: 'reminder',
    category: 'bidding',
    collapse: 'bid_close',
    collapseMode: 'supersede',
    required: ['region_label', 'closes_at', 'console_url'],
    fixtures: [
      { region_label: 'Brampton East', cohort_label: 'Winter cohort', closes_at: 1787600000000,
        hours_left: 24, has_bid: false, console_url: 'https://internet.whollar.ca/partner', first_name: 'Riya' },
      { region_label: 'Brampton East', cohort_label: 'Winter cohort', closes_at: 1787600000000,
        hours_left: 2, has_bid: true, console_url: 'https://internet.whollar.ca/partner', first_name: 'Riya' },
    ],
    /**
     * Relevant only while the window is actually open.
     *
     * A window closed early by an admin, or a campaign moved on, makes this a
     * letter about a door that is already shut. The clock is re-read from the
     * campaign rather than trusted from the context, because the context was
     * written hours ago and the date is exactly the thing that may have moved.
     */
    stillRelevant: async (ctx, { catalystApp, now }) => {
      if (!ctx.campaign_id) return true;
      try {
        const cat = await catalog.load(catalystApp);
        const campaign = cat.byId.get(ctx.campaign_id);
        if (!campaign) return false;
        const closes = (campaign.dates && campaign.dates.bidding_closes_at) || null;
        return !closes || closes > (now || Date.now());
      } catch {
        return true;
      }
    },
    locales: {
      en: (c, h) => {
        const urgent = Number(c.hours_left) <= 2;
        const bid = Boolean(c.has_bid);
        /* SENT WHETHER OR NOT A BID IS SEALED, deliberately. Bids stay
           revisable until close, so "two hours left to improve" is useful to a
           partner who has already bid, and it is the one reminder that cannot
           read as pressure: it names no other partner, no other price, and no
           position. */
        return {
          subject: urgent
            ? `Two hours left on ${c.region_label}`
            : `Bidding closes tomorrow on ${c.region_label}`,
          preheader: bid
            ? 'You can still improve your sealed bid.'
            : 'You have not bid on this cohort yet.',
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero(bid
              ? `You can improve your bid on ${c.region_label} until it closes.`
              : `Bidding on ${c.region_label} closes and you have not bid.`),
            h.B.rows([['Closes', h.when(c.closes_at)]]),
            h.B.soft(bid
              ? 'An improvement is a new sealed version, at least as good on every tier. Your earlier versions are kept, and nobody sees any of them.'
              : 'Every bid is sealed. You are pricing against the cohort, not against a field you can see, and nobody sees yours either.'),
            h.B.action(bid ? 'Improve your bid' : 'Open the bid desk', c.console_url,
              `Closes ${h.when(c.closes_at)}`),
          ],
        };
      },
    },
  },
];
