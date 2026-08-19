'use strict';

/**
 * "New products in progress": the dashboard's demand survey for the three
 * products that do not exist yet (mobile plans, streaming, winter tires).
 *
 *   POST /me/product-interest   record this member's answers for one product
 *
 * WHAT THIS IS NOT. It is not a join, not a bid, not a cohort. Nothing here
 * creates a membership, a fee or an obligation on either side; it answers one
 * question, "which of these do we build first", and the answer to that is a
 * count of households per product plus what they say they already pay.
 *
 * ONE ROW PER (member, product), and a resubmit REPLACES it. Someone who opens
 * winter tires twice has one opinion, not two, and a survey that double-counts
 * the member who changed their mind is a survey that answers its own question
 * wrongly. `interest_key` is the flattened composite, same trick as
 * `campaign_members.membership_key`, because Catalyst's unique constraint is
 * per column and there are no composite keys in the Data Store.
 *
 * WHAT THE CLIENT MAY SET, and what it may not. The client sends the product,
 * the answer VALUES, the consent flag and which page asked. It does not send
 * who it is or when this happened: `user_id`, `email` and `submitted_at` come
 * from the session and the clock on this side, because a demand signal a caller
 * can attribute to another member is not a demand signal.
 *
 * ANSWERS ARE STORED AS VALUES, NEVER LABELS. `u40`, not "Under $40". The chip
 * copy will be edited (a band renamed, a carrier added) and every edit would
 * otherwise open a second bucket that nothing can reconcile with the first.
 */

const datastore = require('../lib/datastore');
const audit = require('../lib/audit');
const { wrap, badRequest, unauthorized, forbidden } = require('../lib/errors');

const TABLE = 'product_interest';

/**
 * The products this endpoint will record, and for each one the questions it
 * will keep and the values each will accept.
 *
 * An allowlist and not free-form storage, on purpose. This is written by an
 * unprivileged member session, and without it the table is a place any signed-in
 * browser can put 10 KB of arbitrary JSON of its own choosing. Anything not
 * named here is dropped silently rather than rejected: a stale tab running last
 * week's chip set should still have its answer counted for the questions that
 * did not change, not have the whole submission refused.
 */
const PRODUCTS = {
  mobile: {
    interest: ['yes', 'maybe', 'no'],
    carrier: ['rogers-fido', 'bell-virgin', 'telus-koodo', 'freedom-public', 'other'],
    spend: ['u40', '40-60', '60-80', '80p', 'unsure'],
  },
  streaming: {
    interest: ['yes', 'maybe', 'no'],
    services: ['1-2', '3-4', '5p', 'isp-bundle', 'unsure'],
    spend: ['u25', '25-50', '50-80', '80p', 'unsure'],
  },
  tires: {
    interest: ['yes', 'maybe', 'no'],
    parts: ['buy', 'swap', 'storage'],
    tire_cost: ['u600', '600-1000', '1000-1500', '1500p', 'unsure'],
    swap_cost: ['diy', 'u80', '80-120', '120p', 'unsure'],
    storage_cost: ['home', 'u80', '80-150', '150p', 'unsure'],
  },
};

function requireMember(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  if (req.auth.user.user_type !== 'member') {
    throw forbidden('This account is not a member account.', {
      logDetail: 'non-member hit /me/product-interest',
    });
  }
  return req.auth.user;
}

/**
 * Keep the answers this product's question set recognises, in the shape it
 * declares. A multi-answer question arrives as an array and is stored as one,
 * deduped and capped at the number of options it actually has.
 */
function cleanAnswers(product, raw) {
  const allowed = PRODUCTS[product];
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const [question, values] of Object.entries(allowed)) {
    const given = raw[question];
    if (Array.isArray(given)) {
      const picked = [...new Set(given.filter((v) => values.includes(v)))].slice(0, values.length);
      if (picked.length) out[question] = picked;
    } else if (typeof given === 'string' && values.includes(given)) {
      out[question] = given;
    }
  }
  return out;
}

/** A postal FSA or null. Anything else is a typo or a probe, not an FSA. */
function fsa(value) {
  const v = String(value || '').trim().toUpperCase();
  return /^[A-Z]\d[A-Z]$/.test(v) ? v : null;
}

/** A same-origin path, capped. Never a full URL: it is provenance, not a link. */
function sourcePage(value) {
  const v = String(value || '').trim();
  return /^\/[\w\-./]*$/.test(v) ? v.slice(0, 120) : null;
}

function mount(router) {
  /**
   * Record (or replace) this member's answers for one product. -> { ok, saved }
   *
   * `keep_posted` false does NOT mean discard: the answers still count towards
   * which product gets built, they just do not put the member on the list that
   * gets told when it does. Storing the flag rather than acting on it here is
   * what keeps that distinction auditable later.
   */
  router.post('/me/product-interest', wrap(async (req, res) => {
    const user = requireMember(req);
    const b = req.body || {};

    const product = String(b.product || '').trim();
    if (!Object.prototype.hasOwnProperty.call(PRODUCTS, product)) {
      throw badRequest('Unknown product.');
    }

    const answers = cleanAnswers(product, b.answers);
    const key = `${user.user_id}:${product}`;
    const now = datastore.nowDb();

    const row = {
      interest_key: key,
      user_id: user.user_id,
      product,
      answers: JSON.stringify(answers),
      keep_posted: b.keepPosted ? 'yes' : 'no',
      email: user.email_normalized || null,
      fsa: fsa(b.fsa),
      source_page: sourcePage(b.sourcePage),
      submitted_at: now,
    };

    const existing = await datastore.findBy(req.catalyst, TABLE, 'interest_key', key, ['ROWID']);
    if (existing) {
      await datastore.updateRow(req.catalyst, TABLE, { ROWID: existing.ROWID, ...row });
    } else {
      try {
        await datastore.insertRow(req.catalyst, TABLE, row);
      } catch (err) {
        // The unique `interest_key` is the real guard; the read above only
        // makes the common case one write instead of two. Two tabs submitting
        // at once land here, and the loser updates rather than failing: both
        // are the same member's opinion and the later one wins by definition.
        const winner = await datastore.findBy(req.catalyst, TABLE, 'interest_key', key, ['ROWID']);
        if (!winner) throw err;
        await datastore.updateRow(req.catalyst, TABLE, { ROWID: winner.ROWID, ...row });
      }
    }

    audit.recordAsync(req.catalyst, req, {
      type: 'member.product_interest.save',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { product, keepPosted: Boolean(b.keepPosted), questions: Object.keys(answers) },
    });

    res.status(200).json({ ok: true, saved: { product, answers } });
  }));
}

module.exports = { mount, PRODUCTS };
