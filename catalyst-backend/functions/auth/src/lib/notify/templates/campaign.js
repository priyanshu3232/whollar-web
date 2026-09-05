'use strict';

/**
 * The cohort stage letter: one email per stage a cohort reaches, to every
 * household in it.
 *
 * SEVEN STAGES, SEVEN LETTERS, ONE TEMPLATE. The vocabulary is the member's
 * (lib/catalog.js MEMBER_STAGES), not the partner's: a household is told what
 * has happened to its own cohort and what, if anything, it now has to do. The
 * dashboard and this letter derive stage from the same server value, so an
 * email can never announce a step the dashboard disagrees with.
 *
 * `doing` is the honest half. Four of the seven stages ask nothing of the
 * household, and saying so plainly beats manufacturing an action: an email
 * that ends "nothing to do" is one the next email is still trusted after.
 *
 * COLLAPSE MODE IS SUPERSEDE, NOT DIGEST. A cohort's stage is moved by writing
 * a date into the campaigns row, so a campaign can cross two stages between
 * one dashboard load and the next and both letters enqueue in the same second.
 * Merging them into a digest would produce "bidding has opened, and also the
 * offer is in", which is worse than either. The newer letter wins and the
 * older one is cancelled, which is exactly the shape of skip_if_superseded.
 *
 * WORD CARE. This is member-facing copy, so it never says "auction": the word
 * for what partners do here is sealed bidding, and scripts/check-notify-copy.mjs
 * holds this file to that.
 */

const STAGES = Object.freeze({
  forming: {
    subject: (r) => `${r} is gathering`,
    lead: (r) => `Your cohort in ${r} is open and gathering households.`,
    body: 'The more households join before it locks, the more a partner is bidding for, and the better the price they put forward.',
    doing: 'Nothing to do. We will write again the day joining closes.',
    pre: 'Nothing to do yet.',
  },
  locked: {
    subject: (r) => `${r} is locked, and the brief is fixed`,
    lead: (r) => `Joining has closed on ${r}. Your cohort's roster is final.`,
    body: 'Partners now receive the brief: how many households, which area, and what you asked for. Nothing about you personally goes to any of them.',
    doing: 'Nothing to do. Sealed bidding opens next.',
    pre: 'Sealed bidding opens next.',
  },
  bidding: {
    subject: (r) => `Sealed bidding is live for ${r}`,
    lead: (r) => `Partners are bidding for ${r} now, and every bid is sealed.`,
    body: 'No partner can see another partner’s price, their count, or whether they bid at all. That is what makes them price against your cohort rather than against each other’s guesses.',
    doing: 'Nothing to do. We will send you the winning offer when bidding closes.',
    pre: 'Nothing to do while bidding runs.',
  },
  offers: {
    subject: (r) => `Your offer for ${r} is in`,
    lead: (r) => `Bidding has closed on ${r} and the winning offer is on your dashboard.`,
    body: 'One offer, the lowest headline price your cohort drew. Compare it against your own bill, which is the only comparison that matters.',
    doing: 'Open your dashboard to read it. Accepting is what creates your switch order: you pick your install day and arrival window as you accept, and nothing is charged for switching.',
    pre: 'Open your dashboard to read it.',
  },
  confirm: {
    subject: (r) => `Confirmations are closing for ${r}`,
    lead: (r) => `The window to accept your offer for ${r} is closing.`,
    body: 'Households that have accepted are counted for the install schedule. Households that have not simply stay where they are, and nothing is owed either way.',
    doing: 'If you want the offer, accept it on your dashboard before the deadline.',
    pre: 'Accept before the deadline if you want it.',
  },
  switching: {
    subject: (r) => `Installs are running for ${r}`,
    lead: (r) => `Your cohort in ${r} has reached its switch window.`,
    body: 'Your installer has the day and arrival window you picked when you accepted, and carries out the line test on the visit. You are not billed for switching, and your old service stays up until the new line passes.',
    doing: 'Keep the mobile number you gave reachable on the day. Reply to this email if anything looks wrong.',
    pre: 'Keep your mobile reachable on the day.',
  },
  done: {
    subject: (r) => `${r} is complete`,
    lead: (r) => `Your cohort in ${r} has finished and the final counts have settled.`,
    body: 'Thank you for going in with your neighbours. A cohort only works because enough households moved at once, and yours did.',
    doing: 'Nothing to do. We will tell you when a new cohort opens near you.',
    pre: 'Nothing to do.',
  },
});

const STAGE_NAMES = Object.freeze(Object.keys(STAGES));

module.exports = [
  {
    key: 'member.campaign.stage',
    /* One fixture per stage, because a template with seven branches has seven
       letters and a gate that renders one of them checks one seventh of the
       copy. scripts/check-notify-copy.mjs renders every entry here. */
    fixtures: STAGE_NAMES.map((stage) => ({
      stage,
      region_label: 'Brampton East',
      cohort_label: 'Winter cohort',
      dashboard_url: 'https://internet.whollar.ca/dashboard',
      next_at: 1787000000000,
      first_name: 'Sam',
    })),
    audience: 'member',
    casl: 'transactional',
    priority: 'informational',
    category: 'campaign_steps',
    collapse: 'campaign_stage',
    collapseMode: 'supersede',
    /* `stage` and `region_label` are what the letter cannot be written
       without. `next_at` is optional: a cohort with a partial calendar says
       less rather than inventing a date, for the same reason the dashboard
       does. */
    required: ['stage', 'region_label', 'dashboard_url'],
    locales: {
      en: (c, h) => {
        const copy = STAGES[c.stage];
        if (!copy) throw new Error(`member.campaign.stage: unknown stage ${c.stage}`);
        const place = String(c.region_label).slice(0, 100);
        const label = c.cohort_label ? `${place}, ${String(c.cohort_label).slice(0, 100)}` : place;
        const blocks = [
          h.B.hero(copy.lead(label)),
          h.B.soft(copy.body),
          h.B.para(copy.doing),
        ];
        if (c.next_at) blocks.push(h.B.rows([['Next', h.when(c.next_at)]]));
        blocks.push(h.B.action('Open your dashboard', c.dashboard_url));
        return {
          subject: copy.subject(place),
          preheader: copy.pre,
          greeting: h.greet(c.first_name),
          blocks,
        };
      },
    },
  },
];

module.exports.STAGES = STAGES;
module.exports.STAGE_NAMES = STAGE_NAMES;
