'use strict';

/**
 * What a household hears about its own switch, from joining to the line going
 * live.
 *
 * THE STAGE LETTER IS NOT THIS. `member.campaign.stage` says what happened to
 * the COHORT: it is the same seven letters to everyone in it. These say what
 * happened to THIS household, and every one of them is triggered by an act
 * rather than by a date: a seat taken, an offer accepted, a slot booked, a
 * line tested. A household that never accepts an offer receives none of them.
 *
 * WHAT THEY MAY CONTAIN. The partner's name, once this household has accepted
 * that partner, because it is who is coming to the door. The tier, the price
 * and the slot, because they are the household's own. Never another
 * household, never another partner's bid, never a count of who else accepted.
 * lib/notify/scrub.js asserts that rather than trusting these files.
 *
 * "ESTIMATED" IS NOT DECORATION. Anywhere a saving or a date is a projection
 * it says so, because the whole product is a comparison against a bill and a
 * number that turns out to be a guess costs more trust than it ever bought.
 */

module.exports = [

  /* ---------------------------------------------------------------- *
   * The seat
   * ---------------------------------------------------------------- */

  {
    key: 'member.cohort.joined',
    audience: 'member',
    casl: 'transactional',
    priority: 'informational',
    category: 'campaign_steps',
    collapse: null,
    required: ['region_label', 'dashboard_url'],
    fixture: {
      region_label: 'Brampton East', cohort_label: 'Winter cohort',
      dashboard_url: 'https://internet.whollar.ca/dashboard',
      have: 61, need: 100, first_name: 'Sam',
    },
    locales: {
      en: (c, h) => {
        const blocks = [
          h.B.hero(`You are in. Your seat in ${c.region_label} is held.`),
          h.B.soft('A cohort is a number partners bid against, so every household that joins makes the price a partner has to beat a little harder to hold.'),
        ];
        /* Counts only when the server actually has them. A progress line that
           says "0 of 100" because a read failed is worse than no line. */
        if (c.have && c.need) {
          blocks.push(h.B.rows([
            ['Households so far', `${c.have} of ${c.need}`],
          ]));
        }
        blocks.push(h.B.para('Nothing to do now. We will write when joining closes and again when the sealed bids land.'));
        blocks.push(h.B.action('Open your dashboard', c.dashboard_url));
        return {
          subject: `Your seat in ${c.region_label} is held`,
          preheader: 'Nothing to do now. We write at every step.',
          greeting: h.greet(c.first_name),
          blocks,
        };
      },
    },
  },

  /* ---------------------------------------------------------------- *
   * The decision
   * ---------------------------------------------------------------- */

  {
    key: 'member.offer.accepted',
    audience: 'member',
    casl: 'transactional',
    priority: 'informational',
    category: 'campaign_steps',
    collapse: null,
    /* The partner, the speed and the day are the three things this letter
       exists to confirm. Without any one of them it is a receipt for nothing. */
    required: ['partner_name', 'tier', 'slot_at', 'dashboard_url'],
    fixtures: [
      {
        partner_name: 'Northline Fibre', tier: '1 Gig', price: '64.99',
        slot_at: 1787000000000, slot_window: 'Morning, 8am to 12pm',
        address_line: '18 Rutherford Road', order_no: 'WH-10428',
        region_label: 'Brampton East', dashboard_url: 'https://internet.whollar.ca/dashboard',
        first_name: 'Sam', changed_from: null,
      },
      {
        partner_name: 'Northline Fibre', tier: '1 Gig', price: '64.99',
        slot_at: 1787000000000, slot_window: 'Afternoon, 12pm to 5pm',
        address_line: '18 Rutherford Road', order_no: 'WH-10428',
        region_label: 'Brampton East', dashboard_url: 'https://internet.whollar.ca/dashboard',
        first_name: 'Sam', changed_from: '500 Mbps',
      },
    ],
    locales: {
      en: (c, h) => {
        const changed = Boolean(c.changed_from);
        const rows = [
          ['Partner', c.partner_name],
          ['Speed', c.tier],
        ];
        if (c.price) rows.push(['Price', `$${c.price} a month`]);
        rows.push(['Install day', h.day(c.slot_at)]);
        if (c.slot_window) rows.push(['Arrival window', c.slot_window]);
        if (c.address_line) rows.push(['Address', c.address_line]);
        if (c.order_no) rows.push(['Reference', c.order_no]);

        return {
          subject: changed
            ? `Changed to ${c.tier}, and your install is rebooked`
            : `Accepted: ${c.partner_name} on ${c.tier}`,
          preheader: `Installing ${h.day(c.slot_at)}. Nothing is charged for switching.`,
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero(changed
              ? `Your pick is now ${c.tier} with ${c.partner_name}, and your install day has moved with it.`
              : `You accepted ${c.partner_name} on ${c.tier}, and your install is booked.`),
            h.B.rows(rows),
            h.B.soft('Your address and mobile number go to this partner for the install and for nothing else. Your old service stays up until the new line passes its test, so there is no day without internet.'),
            h.B.para('Nothing is charged for switching, and no deposit is held.'),
            h.B.action('See it on your dashboard', c.dashboard_url),
            h.B.note('Need a different day? Change it on your dashboard, or reply to this email and a person will sort it.'),
          ],
        };
      },
    },
  },

  {
    key: 'member.offer.passed',
    audience: 'member',
    casl: 'transactional',
    priority: 'informational',
    category: 'campaign_steps',
    collapse: null,
    required: ['region_label', 'dashboard_url'],
    fixture: {
      region_label: 'Brampton East', dashboard_url: 'https://internet.whollar.ca/dashboard',
      released: true, first_name: 'Sam',
    },
    locales: {
      en: (c, h) => ({
        subject: `You passed on ${c.region_label}`,
        preheader: 'Nothing is owed, and nothing changes with your current service.',
        greeting: h.greet(c.first_name),
        blocks: [
          h.B.hero(`You passed on the offer for ${c.region_label}, and that is a complete answer.`),
          h.B.soft(c.released
            ? 'Your seat is released and the order you had accepted is cancelled. Nothing is owed on either side, and your current service is untouched.'
            : 'Your seat is released. Nothing is owed on either side, and your current service is untouched.'),
          h.B.para('We will tell you when a new cohort opens near you. Passing once does not put you at the back of any queue.'),
          h.B.action('Open your dashboard', c.dashboard_url),
        ],
      }),
    },
  },

  /* ---------------------------------------------------------------- *
   * The install
   *
   * `action_required` on three of these, so they are never held for quiet
   * hours. A slot that moved to tomorrow morning is a thing a household needs
   * at midnight, not at seven.
   * ---------------------------------------------------------------- */

  {
    key: 'member.install.scheduled',
    audience: 'member',
    casl: 'transactional',
    priority: 'action_required',
    category: 'delivery',
    collapse: null,
    required: ['partner_name', 'slot_at', 'dashboard_url'],
    fixture: {
      partner_name: 'Northline Fibre', slot_at: 1787000000000,
      slot_window: 'Morning, 8am to 12pm', order_no: 'WH-10428',
      dashboard_url: 'https://internet.whollar.ca/dashboard', first_name: 'Sam',
    },
    locales: {
      en: (c, h) => ({
        subject: `Your install is booked for ${h.day(c.slot_at)}`,
        preheader: `${c.partner_name} has your day and your number.`,
        greeting: h.greet(c.first_name),
        blocks: [
          h.B.hero(`${c.partner_name} has booked your install for ${h.day(c.slot_at)}.`),
          h.B.rows([
            ['Partner', c.partner_name],
            ['Day', h.day(c.slot_at)],
          ].concat(c.slot_window ? [['Arrival window', c.slot_window]] : [])
            .concat(c.order_no ? [['Reference', c.order_no]] : [])),
          h.B.soft('What to have ready: someone over eighteen at home for the window, access to where the line comes in, and the mobile number you gave us reachable. The crew calls before they arrive.'),
          h.B.para('Your old service stays up until the new line passes its test.'),
          h.B.action('See or change this', c.dashboard_url),
        ],
      }),
    },
  },

  {
    key: 'member.install.rebooked',
    audience: 'member',
    casl: 'transactional',
    priority: 'action_required',
    category: 'delivery',
    collapse: null,
    required: ['partner_name', 'slot_at', 'dashboard_url'],
    fixture: {
      partner_name: 'Northline Fibre', slot_at: 1787600000000,
      previous_slot_at: 1787000000000, slot_window: 'Afternoon, 12pm to 5pm',
      order_no: 'WH-10428', dashboard_url: 'https://internet.whollar.ca/dashboard',
      first_name: 'Sam',
    },
    locales: {
      en: (c, h) => {
        const rows = [];
        if (c.previous_slot_at) rows.push(['Was', h.day(c.previous_slot_at)]);
        rows.push(['Now', h.day(c.slot_at)]);
        if (c.slot_window) rows.push(['Arrival window', c.slot_window]);
        if (c.order_no) rows.push(['Reference', c.order_no]);
        return {
          subject: `Your install moved to ${h.day(c.slot_at)}`,
          preheader: `${c.partner_name} has rebooked. Nothing else changes.`,
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero(`${c.partner_name} has moved your install day.`),
            h.B.rows(rows),
            h.B.soft('Nothing else changes: same partner, same speed, same price. Your old service stays up until the new line passes.'),
            h.B.action('See or change this', c.dashboard_url),
            h.B.note('If that day does not work, change it on your dashboard or reply to this email.'),
          ],
        };
      },
    },
  },

  {
    key: 'member.install.exception',
    audience: 'member',
    casl: 'transactional',
    priority: 'action_required',
    category: 'delivery',
    collapse: null,
    required: ['partner_name', 'kind', 'dashboard_url'],
    fixtures: ['noshow', 'access', 'linefail'].map((kind) => ({
      kind,
      partner_name: 'Northline Fibre',
      order_no: 'WH-10428',
      dashboard_url: 'https://internet.whollar.ca/dashboard',
      first_name: 'Sam',
    })),
    locales: {
      en: (c, h) => {
        /* Plain language, and the household's side of it. The partner logged
           a code; a household reads a sentence about its own day. */
        const COPY = {
          noshow: {
            subject: 'Your installer could not reach you',
            hero: `${c.partner_name} came out and could not get an answer, so the visit did not happen.`,
            body: 'Nothing is charged for a missed visit, and a missed-visit credit applies to your first bill. Pick another day whenever suits.',
            step: 'Pick a new day',
          },
          access: {
            subject: 'Your install needs building access',
            hero: `${c.partner_name} could not get to where the line comes in, so the visit could not go ahead.`,
            body: 'This is usually a locked utility room or a building that needs notice. Nothing is charged, and the visit reschedules once access is arranged.',
            step: 'Rebook once access is sorted',
          },
          linefail: {
            subject: 'Your line did not pass its test',
            hero: `${c.partner_name} installed the line and it tested below the speed you were offered.`,
            body: 'So the switch is not finished and nothing is billed for it. Your old service is still up and stays up. The partner returns to retest, and the offer holds at the price you accepted.',
            step: 'See where this stands',
          },
        }[c.kind];
        if (!COPY) throw new Error(`member.install.exception: unknown kind ${c.kind}`);

        return {
          subject: COPY.subject,
          preheader: 'Nothing is charged, and your current service is untouched.',
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero(COPY.hero),
            h.B.soft(COPY.body),
            h.B.action(COPY.step, c.dashboard_url),
            h.B.note('If any of that is wrong, reply to this email. A person reads these.'),
          ],
        };
      },
    },
  },

  {
    key: 'member.switch.complete',
    audience: 'member',
    casl: 'transactional',
    priority: 'informational',
    category: 'delivery',
    collapse: null,
    required: ['partner_name', 'dashboard_url'],
    fixture: {
      partner_name: 'Northline Fibre', tier: '1 Gig', price: '64.99',
      monthly_saving: '48.00', dashboard_url: 'https://internet.whollar.ca/dashboard',
      first_name: 'Sam',
    },
    locales: {
      en: (c, h) => {
        const rows = [['Partner', c.partner_name]];
        if (c.tier) rows.push(['Speed', c.tier]);
        if (c.price) rows.push(['Price', `$${c.price} a month`]);
        /* Labelled Estimated, always. It is derived from a bill the household
           typed in, and the first real bill is the only figure that settles
           it. An unlabelled saving that turns out to be a projection costs
           more trust than it buys. */
        if (c.monthly_saving) rows.push(['Saving a month', `$${c.monthly_saving} (Estimated)`]);

        return {
          subject: 'Your switch is complete',
          preheader: 'The line passed and your old service is cancelled.',
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero('Your new line passed its test and your old service is cancelled. The switch is done.'),
            h.B.rows(rows),
            h.B.soft('Your first bill comes from your new partner, not from Whollar. We never bill a household for anything.'),
            h.B.para('If you were renting equipment from your old provider, return it in their window or they will keep charging for it. Their instructions are on your final bill.'),
            h.B.action('See your switch', c.dashboard_url),
            h.B.note('Anything not as promised? Reply to this email. That is what the record is for.'),
          ],
        };
      },
    },
  },

  {
    key: 'member.order.released',
    audience: 'member',
    casl: 'transactional',
    priority: 'action_required',
    category: 'delivery',
    collapse: null,
    required: ['reason', 'dashboard_url'],
    fixtures: ['no_plant', 'building_access', 'speed_tier_unavailable', 'household_cancelled'].map((reason) => ({
      reason,
      region_label: 'Brampton East',
      dashboard_url: 'https://internet.whollar.ca/dashboard',
      first_name: 'Sam',
    })),
    locales: {
      en: (c, h) => {
        /* The partner picked a reason from an enum because it feeds their
           serviceability figure. The household gets the sentence that reason
           means for them, and never the partner's name: this is a partner
           that could not serve the address, and naming them here would read
           as blame for something that is usually the street. */
        const COPY = {
          no_plant: 'There is no line into your address on that partner’s network yet.',
          building_access: 'That partner could not get the building access the install needs.',
          speed_tier_unavailable: 'The speed you accepted is not available at your address on that network.',
          household_cancelled: 'This order was cancelled at your request.',
        }[c.reason] || 'This order could not go ahead at your address.';

        return {
          subject: 'Your install could not go ahead',
          preheader: 'Nothing is owed, and your current service is untouched.',
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero('Your order has been released, so this install is not happening.'),
            h.B.rows([['Why', COPY]]),
            h.B.soft('Nothing is owed on either side and your current service is untouched. This is the honest end of an order, not a penalty.'),
            h.B.para(c.region_label
              ? `We will tell you when a new cohort opens near ${c.region_label}, and your bill details are already on file so joining takes one tap.`
              : 'We will tell you when a new cohort opens near you.'),
            h.B.action('Open your dashboard', c.dashboard_url),
            h.B.note('If you think this is wrong, reply to this email. A person reads these.'),
          ],
        };
      },
    },
  },
];
