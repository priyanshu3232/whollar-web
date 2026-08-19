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
 * CHIP ANSWERS ARE STORED AS VALUES, NEVER LABELS. `yes`, not "Yes, build it".
 * The chip copy will be edited and every edit would otherwise open a second
 * bucket that nothing can reconcile with the first.
 *
 * THE DETAIL TABLES ARE THE ONE EXCEPTION, and they are an exception because
 * their labels ARE their values. "Rogers", "Toyota", "235/55R20" are proper
 * nouns and a measurement; nobody renames a car make the way a price band gets
 * renamed, so there is no second bucket waiting to happen. Minting a parallel
 * code for each would be a second catalog to keep in step with the client's,
 * and a catalog that drifts silently drops the newest phones and cars, which
 * are the ones a carrier or a tire shop most wants to quote against.
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
/* The catalogs the tables pick from. These mirror the lists in dashboard.html
   and exist here because the client is not to be trusted with what it sends,
   only with what it shows. */
const FINANCED = ['Yes, financed', 'No, own phone', 'Not sure'];
const CARRIERS = ['Rogers', 'Fido', 'Bell', 'Virgin Plus', 'Telus', 'Koodo',
  'Freedom', 'Public Mobile', 'Lucky', 'Chatr', 'Other'];
const SVCS = ['Netflix', 'Crave', 'Disney+', 'Prime Video', 'Apple TV+',
  'Paramount+', 'Sportsnet+', 'TSN+', 'YouTube Premium', 'Other'];
const BILLVIA = ['Direct to the service', 'Rogers bill', 'Bell bill', 'Telus bill',
  'App Store / Google Play', 'Amazon', 'Not sure'];
const PACKS = ['Rogers (bundled streaming)', 'Bell (Crave bundle)', 'Telus (Stream+)',
  'Amazon Prime channels', 'Other package'];
const NEEDS = ['New tires', 'New rims', 'Install: mount + balance', 'Alignment',
  'Swap on / off rims', 'Seasonal changeover', 'Seasonal storage'];

/**
 * Free text that is a catalog name, not prose: a car make, a model, a phone.
 * Validated by SHAPE and not by membership, deliberately.
 *
 * The alternative is an allowlist of every phone and every trim level sold in
 * Canada, deployed inside this function. That list changes twice a year, and
 * the day it goes stale it starts silently dropping the newest handsets, which
 * are precisely the ones worth knowing about. A capped string off a closed
 * charset cannot carry markup, a URL, a newline or a paragraph, which is the
 * whole of what this gate is for: the field is 40 characters of the sort of
 * thing that is moulded into a tailgate.
 */
const CATALOG_TEXT = /^[A-Za-z0-9 ,.:()/+&-]{1,40}$/;
/** A metric tire size and nothing else: 235/55R20. */
const TIRE_SIZE = /^\d{3}\/\d{2}R\d{2}$/;

/**
 * The products this endpoint will record, and for each one the questions it
 * will keep and the shape each will accept.
 *
 * FOUR SHAPES, and a question is exactly one of them:
 *   { enum }              one value from a fixed list, or an array of them
 *   { list, max }         several values from a fixed list
 *   { object }            one record of named fields
 *   { rows, fields }      up to `rows` records of named fields
 * A field inside a record is { enum }, { list, max }, { text }, { money } or
 * { size }. Nothing else parses, so a shape this file does not name cannot be
 * stored by describing it in a request.
 */
const PRODUCTS = {
  mobile: {
    interest: { enum: ['yes', 'maybe', 'no'] },
    lines: { enum: ['1', '2', '3', '4', '5'] },
    line_rows: {
      rows: 5,
      fields: {
        carrier: { enum: CARRIERS },
        financed: { enum: FINANCED },
        device: { text: true },
        pay: { money: 2000 },
      },
    },
  },
  streaming: {
    interest: { enum: ['yes', 'maybe', 'no'] },
    paymode: { enum: ['one', 'sep', 'mix'] },
    svccount: { enum: ['1', '2', '3', '4', '5', '6'] },
    pack: { object: { provider: { enum: PACKS }, pay: { money: 2000 } } },
    pack_svcs: { list: SVCS, max: SVCS.length },
    svc_rows: {
      rows: 6,
      fields: {
        service: { enum: SVCS },
        via: { enum: BILLVIA },
        pay: { money: 2000 },
      },
    },
  },
  tires: {
    interest: { enum: ['yes', 'maybe', 'no'] },
    cars: { enum: ['1', '2', '3', '4'] },
    car_rows: {
      rows: 4,
      fields: {
        make: { text: true },
        model: { text: true },
        size: { size: true },
        needs: { list: NEEDS, max: NEEDS.length },
      },
    },
  },
};

/**
 * The `answers` column is Text 4000. Nothing the shapes above allow comes near
 * it (five mobile lines is roughly 400 characters), but the cap is checked
 * rather than reasoned about, because the day a table grows a column is not the
 * day anyone re-does this arithmetic. Over the cap, the row arrays are dropped
 * and the chip answers are kept: a truncated JSON string in the column would
 * take the whole submission with it, including the one answer that matters.
 */
const ANSWERS_MAX = 3600;

function requireMember(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  if (req.auth.user.user_type !== 'member') {
    throw forbidden('This account is not a member account.', {
      logDetail: 'non-member hit /me/product-interest',
    });
  }
  return req.auth.user;
}

/** One scalar field inside a record. Returns null for anything not allowed. */
function cleanField(spec, given) {
  if (spec.enum) {
    return (typeof given === 'string' && spec.enum.includes(given)) ? given : null;
  }
  if (spec.list) {
    if (!Array.isArray(given)) return null;
    const picked = [...new Set(given.filter((v) => spec.list.includes(v)))].slice(0, spec.max);
    return picked.length ? picked : null;
  }
  if (spec.text) {
    const v = typeof given === 'string' ? given.trim() : '';
    return CATALOG_TEXT.test(v) ? v : null;
  }
  if (spec.size) {
    const v = typeof given === 'string' ? given.trim() : '';
    return TIRE_SIZE.test(v) ? v : null;
  }
  if (spec.money) {
    /* A string of digits is accepted as well as a number: a number input hands
       back a string, and refusing "72" while accepting 72 would drop every
       amount from a browser that did not coerce it. */
    const n = typeof given === 'number' ? given : Number(String(given || '').trim());
    if (!Number.isFinite(n) || n < 0 || n > spec.money) return null;
    return Math.round(n);
  }
  return null;
}

/** One record. Fields that fail are dropped; a record with none left is null. */
function cleanRecord(fields, given) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) return null;
  const out = {};
  for (const [name, spec] of Object.entries(fields)) {
    const v = cleanField(spec, given[name]);
    if (v !== null) out[name] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Keep the answers this product's question set recognises, in the shape it
 * declares. Anything not named, or named but the wrong shape, is dropped
 * silently rather than rejected: a stale tab running last week's chip set
 * should still have its answer counted for the questions that did not change,
 * not have the whole submission refused.
 */
function cleanAnswers(product, raw) {
  const allowed = PRODUCTS[product];
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const [question, spec] of Object.entries(allowed)) {
    const given = raw[question];

    if (spec.rows) {
      if (!Array.isArray(given)) continue;
      const rows = given.slice(0, spec.rows)
        .map((r) => cleanRecord(spec.fields, r))
        .filter(Boolean);
      if (rows.length) out[question] = rows;
      continue;
    }
    if (spec.object) {
      const rec = cleanRecord(spec.object, given);
      if (rec) out[question] = rec;
      continue;
    }
    const v = cleanField(spec, given);
    if (v !== null) out[question] = v;
  }

  /* The size guard. Drop the record-shaped answers, biggest first, until what
     is left fits the column. The chip answers are never dropped: they are a
     few dozen bytes and they are the ones the build order is decided on. */
  const bulky = Object.keys(out).filter((k) => allowed[k].rows || allowed[k].object);
  while (JSON.stringify(out).length > ANSWERS_MAX && bulky.length) {
    delete out[bulky.pop()];
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
