'use strict';

/**
 * Founding partner mail.
 *
 * PRIVACY, WHICH IS THE WHOLE CONSTRAINT ON THIS FILE. No partner ever
 * receives another partner's name, price, seal reference, bid count, or the
 * fact that anyone else bid at all. No partner receives a household address
 * before that household has confirmed, and no partner ever receives a
 * household's current provider or price. lib/notify/scrub.js asserts this on
 * the finished body rather than trusting the templates, and a hit fails the
 * send and raises an operator alert.
 *
 * Partner mail does not observe quiet hours: these are business inboxes, and a
 * bid window that closes at 08:00 needs its reminder at 06:00.
 */

module.exports = [

  /* ---------------------------------------------------------------- *
   * The approval or rejection notice.
   *
   * One template with a branch rather than two, so the two outcomes cannot
   * drift into different framings of the same decision. The rejection carries
   * the reason verbatim: it was written to be read by the applicant, and a
   * rejection with no reason generates a support thread, not an ending.
   * ---------------------------------------------------------------- */
  {
    key: 'partner.account.decision',
    fixtures: [
      { approved: true, org_name: 'Northline Fibre', console_url: 'https://www.whollar.ca/partner', first_name: 'Riya' },
      { approved: false, org_name: 'Northline Fibre', reason: 'The coverage claim could not be verified against the plant map you sent.', console_url: 'https://www.whollar.ca/partner', first_name: 'Riya' },
    ],
    audience: 'partner',
    casl: 'transactional',
    priority: 'action_required',
    category: 'account',
    collapse: null,
    required: ['approved', 'org_name'],
    locales: {
      en: (c, h) => {
        const name = String(c.org_name || 'your company').trim();

        if (c.approved === true || c.approved === 'true') {
          return {
            subject: `Welcome to Whollar · your partner account is live`,
            preheader: 'You pay only on a completed, retained switch.',
            greeting: h.greet(c.first_name),
            blocks: [
              h.B.hero(`Your Whollar partner account for ${name} is approved and live.`),
              h.B.soft('From your console you can:'),
              h.B.list([
                'See cohorts forming in your footprint',
                'Submit and update sealed bids on your own terms',
                'Track completed switches and success fees',
              ]),
              h.B.soft('A reminder of how the model works: you pay only on a completed, retained switch. No winning bid, no fee. You control your volume and can pause any time.'),
              h.B.action('Sign in to your console', c.console_url),
              h.B.note('Questions? Reply to this email. A real person reads these.'),
            ],
          };
        }

        const why = String(c.reason || '').trim();
        const blocks = [
          h.B.hero(`We reviewed ${name}'s Whollar partner application and cannot approve it right now.`),
        ];
        if (why) blocks.push(h.B.rows([['Why', why]]));
        blocks.push(h.B.note('If something here is wrong or has changed, reply to this email. A person reads it, and a review can be reopened.'));

        return {
          subject: `About ${name}'s Whollar partner application`,
          preheader: 'Reply to this email if something here is wrong or has changed.',
          greeting: h.greet(c.first_name),
          blocks,
        };
      },
    },
  },
  /* ---------------------------------------------------------------- *
   * The bid desk
   * ---------------------------------------------------------------- */

  /**
   * The receipt for a sealed bid.
   *
   * THEIR OWN BID AND NOTHING ELSE. Not how many partners bid, not whether
   * they are cheapest, not whether anyone bid at all. A receipt that hinted at
   * any of those would make the seal decorative: a partner who could infer the
   * field from an email would price against the field, which is the exact
   * behaviour sealed bidding exists to remove.
   *
   * It carries the receipt number and the revision, because those are the
   * partner's own record of what they submitted and when, and a dispute three
   * months later is settled by a number in an inbox rather than by our word.
   */
  {
    key: 'partner.bid.receipt',
    audience: 'partner',
    casl: 'transactional',
    priority: 'informational',
    category: 'bidding',
    collapse: null,
    required: ['region_label', 'receipt_no', 'console_url'],
    fixtures: [
      { region_label: 'Brampton East', cohort_label: 'Winter cohort', receipt_no: 'R-4471',
        revision_no: 1, sealed_at: 1787000000000, closes_at: 1787600000000,
        console_url: 'https://www.whollar.ca/partner', first_name: 'Riya' },
      { region_label: 'Brampton East', cohort_label: 'Winter cohort', receipt_no: 'R-4482',
        revision_no: 3, sealed_at: 1787200000000, closes_at: 1787600000000,
        console_url: 'https://www.whollar.ca/partner', first_name: 'Riya' },
    ],
    locales: {
      en: (c, h) => {
        const revised = Number(c.revision_no) > 1;
        const rows = [['Cohort', c.cohort_label ? `${c.region_label}, ${c.cohort_label}` : c.region_label],
          ['Receipt', c.receipt_no]];
        if (c.revision_no) rows.push(['Revision', String(c.revision_no)]);
        if (c.sealed_at) rows.push(['Sealed at', h.when(c.sealed_at)]);
        if (c.closes_at) rows.push(['Improve until', h.when(c.closes_at)]);

        return {
          subject: revised
            ? `Bid improved: ${c.region_label}, receipt ${c.receipt_no}`
            : `Bid sealed: ${c.region_label}, receipt ${c.receipt_no}`,
          preheader: revised
            ? 'Your revision is recorded. Earlier versions are kept.'
            : 'Recorded and sealed. You can improve it until close.',
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero(revised
              ? 'Your improved bid is sealed and recorded.'
              : 'Your bid is sealed and recorded.'),
            h.B.rows(rows),
            h.B.soft('A sealed bid is never withdrawn and never edited in place: an improvement is a new version, and every version is kept. That is what makes the receipt worth having.'),
            h.B.para('Your prices stay with you until bidding closes. Nobody sees them, and you see nobody else’s.'),
            h.B.action('Open the bid desk', c.console_url),
          ],
        };
      },
    },
  },

  /**
   * A tier awarded.
   *
   * Carries the tier, the household count in it, and the price. Never the
   * margin, never the losing prices, never who else bid. A partner learns
   * what they won and what they now owe a service to.
   */
  {
    key: 'partner.tier.awarded',
    audience: 'partner',
    casl: 'transactional',
    priority: 'action_required',
    category: 'bidding',
    collapse: null,
    required: ['region_label', 'tier', 'console_url'],
    fixture: {
      region_label: 'Brampton East', cohort_label: 'Winter cohort', tier: '1 Gig',
      household_count: 34, price: '64.99', switch_window_at: 1787600000000,
      console_url: 'https://www.whollar.ca/partner', first_name: 'Riya',
    },
    locales: {
      en: (c, h) => {
        const rows = [['Cohort', c.region_label], ['Tier', c.tier]];
        if (c.household_count) rows.push(['Households in this tier', String(c.household_count)]);
        if (c.price) rows.push(['Your price', `$${c.price} a month`]);
        if (c.switch_window_at) rows.push(['Switch window opens', h.day(c.switch_window_at)]);

        return {
          subject: `You won ${c.tier} in ${c.region_label}`,
          preheader: 'Addresses reach your console as households confirm.',
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero(`You have been awarded ${c.tier} in ${c.region_label}.`),
            h.B.rows(rows),
            h.B.soft('Households now decide. Addresses reach your console as each one confirms and accepts, never before, and only for the households that accepted you.'),
            h.B.para('You are billed only on a completed, retained switch. No activation, no fee.'),
            h.B.action('Open your console', c.console_url),
          ],
        };
      },
    },
  },

  /**
   * A tier bid on and not won.
   *
   * TIER NAME ONLY. No winning price, no winner, no margin, no count of
   * bidders. That is the privacy invariant, and it is also the thing a losing
   * partner most wants and most must not have: a losing price disclosed here
   * is the whole field's pricing reconstructed over three cohorts.
   *
   * It says so plainly rather than leaving a silence that reads as an
   * oversight, because a partner who is told nothing assumes the worst about
   * what everyone else was told.
   */
  {
    key: 'partner.tier.not_awarded',
    audience: 'partner',
    casl: 'transactional',
    priority: 'informational',
    category: 'bidding',
    collapse: 'tier_result',
    collapseMode: 'digest',
    required: ['region_label', 'tier', 'console_url'],
    fixture: {
      region_label: 'Brampton East', tier: '500 Mbps',
      console_url: 'https://www.whollar.ca/partner', first_name: 'Riya',
    },
    locales: {
      en: (c, h) => ({
        subject: `${c.tier} in ${c.region_label} went elsewhere`,
        preheader: 'No prices are disclosed, to you or about you.',
        greeting: h.greet(c.first_name),
        blocks: [
          h.B.hero(`Your bid on ${c.tier} in ${c.region_label} was not the one awarded.`),
          h.B.soft('We do not tell you the winning price, who won it, or how close you were, and we tell nobody those things about your bid either. That symmetry is the whole mechanism: a field that can reconstruct itself from result emails is a field pricing against each other instead of against the cohort.'),
          h.B.para('Your other tiers on this cohort, if you bid any, are decided separately and you hear about each one.'),
          h.B.action('See what is open', c.console_url),
        ],
      }),
    },
  },

  /* ---------------------------------------------------------------- *
   * Billing
   * ---------------------------------------------------------------- */

  {
    key: 'partner.statement.ready',
    audience: 'partner',
    casl: 'transactional',
    priority: 'action_required',
    category: 'billing',
    collapse: null,
    required: ['region_label', 'total', 'console_url'],
    fixture: {
      region_label: 'Brampton East', statement_ref: 'ST-2026-08-0031',
      total: '3040.00', line_count: 32, due_at: 1787600000000,
      console_url: 'https://www.whollar.ca/partner', first_name: 'Riya',
    },
    locales: {
      en: (c, h) => {
        const rows = [['Cohort', c.region_label]];
        if (c.statement_ref) rows.push(['Statement', c.statement_ref]);
        if (c.line_count) rows.push(['Activations billed', String(c.line_count)]);
        rows.push(['Total', `$${c.total}`]);
        if (c.due_at) rows.push(['Due', h.day(c.due_at)]);

        return {
          subject: `Statement ready: ${c.region_label}`,
          preheader: 'One line per completed activation. Net fifteen.',
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero(`Your statement for ${c.region_label} is ready.`),
            h.B.rows(rows),
            h.B.soft('One line per completed, retained activation, and nothing else: no line for a booking, a confirmation or an offer. A line test that failed holds rather than bills.'),
            h.B.para('Anything on it you disagree with, dispute the line in the console and it is held while a person looks.'),
            h.B.action('Open the statement', c.console_url),
          ],
        };
      },
    },
  },

  {
    key: 'partner.statement.dispute_ack',
    audience: 'partner',
    casl: 'transactional',
    priority: 'informational',
    category: 'billing',
    collapse: null,
    required: ['order_ref', 'console_url'],
    fixture: {
      order_ref: 'WH-10428', region_label: 'Brampton East',
      console_url: 'https://www.whollar.ca/partner', first_name: 'Riya',
    },
    locales: {
      en: (c, h) => ({
        subject: `Dispute logged on line ${c.order_ref}`,
        preheader: 'The line is held while a person looks at it.',
        greeting: h.greet(c.first_name),
        blocks: [
          h.B.hero(`Your dispute on line ${c.order_ref} is logged.`),
          h.B.rows([['Line', c.order_ref]].concat(c.region_label ? [['Cohort', c.region_label]] : [])),
          h.B.soft('The line is held while it is reviewed, so it does not fall due underneath the dispute. Your note travels with it.'),
          h.B.para('A person reads every one of these. You will hear the outcome either way.'),
          h.B.action('See the statement', c.console_url),
        ],
      }),
    },
  },
];
