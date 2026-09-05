'use strict';

/**
 * Mail to an address that has no account behind it.
 *
 * THIS IS THE FIRST `cem` TEMPLATE IN THE REGISTRY, and that is the whole
 * reason this file is separate from member.js and partner.js. Everything in
 * those two is transactional: it goes to somebody who did business with us and
 * is owed an answer. This goes to somebody who typed an address into a popup,
 * which under CASL is a commercial electronic message and carries three
 * obligations the transactional lane does not have.
 *
 *   1. EXPRESS CONSENT, captured before the send and kept. The popup stores
 *      the exact sentence agreed to in WaitlistEmails.ConsentText with a
 *      ConsentAt beside it, and those two columns are deliberately NOT in the
 *      optional group there: an address kept without the sentence agreed to is
 *      an address we are not allowed to write to.
 *   2. AN UNSUBSCRIBE LINK, which lib/notify/unsub.js mints against
 *      recipient_type 'address' and layout.js puts in the footer.
 *   3. A PHYSICAL MAILING ADDRESS in that same footer. outbox.js refuses a cem
 *      send outright when MAIL_POSTAL_ADDRESS is unset, rather than sending
 *      one without it, so this template cannot leave until that is configured.
 *
 * WHAT IT MAY NOT SAY. No count of who else joined, no region progress, no
 * partner name, no price. None of that is settled for somebody who has not
 * joined a cohort, and a number in a welcome letter that turns out to be a
 * guess costs more trust than it buys. It confirms, it hands over the share
 * link, and it stops.
 */

module.exports = [

  {
    key: 'waitlist.welcome',
    /* 'auto' takes the recipient's own audience, which for an address with no
       account is the neutral styling. There is no member here to address. */
    audience: 'auto',
    casl: 'cem',
    priority: 'informational',
    category: 'product_interest',
    collapse: null,
    /* share_url is NOT required. A store that could not mint a code still owes
       this person a confirmation, and a required key that is missing fails the
       whole row rather than dropping a paragraph. The render below simply
       leaves the sharing half out when there is nothing to share. */
    required: ['product_label'],
    fixtures: [
      {
        product_label: 'winter tires',
        share_code: 'WS7KMQT4WB',
        share_url: 'https://www.whollar.ca/join?ref=WS7KMQT4WB',
        join_url: 'https://www.whollar.ca/join',
      },
      /* The no code case, rendered by the gate as well, because it is the one
         that ships the day a column is missing. */
      {
        product_label: 'home internet',
        join_url: 'https://www.whollar.ca/join',
      },
    ],
    locales: {
      en: (c, h) => {
        const blocks = [
          h.B.hero('Welcome to Whollar.'),
          h.B.para(`Your place is held. We will write when ${c.product_label} opens near you, and not before: this is a list, not a newsletter.`),
        ];

        if (c.share_url) {
          blocks.push(h.B.rule());
          blocks.push(h.B.para('This link is yours. Anyone who joins through it is counted as having come from you.'));
          blocks.push(h.B.code(c.share_url));
          blocks.push(h.B.soft('The more households ask for the same thing in the same place, the better the price a partner has to beat. That is the entire mechanism, and sharing is the only part of it you control.'));
        }

        if (c.join_url) {
          blocks.push(h.B.action('Finish joining', c.join_url));
          blocks.push(h.B.soft('Holding a place takes an address. Joining takes a postal code, so we know which cohort you belong to.'));
        }

        return {
          subject: 'Your place at Whollar is held',
          preheader: c.share_url
            ? 'Your place is held, and your share link is inside.'
            : 'Your place is held. We write when something opens near you.',
          greeting: h.greet(c.first_name),
          blocks,
        };
      },
    },
  },

];
