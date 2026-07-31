'use strict';

/**
 * The member's private rating of their own provider — the dashboard's
 * "One minute, once" card: Price / Reliability / Support / Speed, 1-5 each.
 * Never shown to bidding providers; only the admin console reads it.
 *
 *   GET  /me/rating   the rating this member has already given, or null
 *   POST /me/rating   record it, once — CONFLICT on a second attempt
 *
 * One row per member. `provider_ratings.user_id` is unique, so a concurrent
 * double-submit (two tabs, a doubled click) fails at the insert even if both
 * requests race past the existing-row check below.
 */

const datastore = require('../lib/datastore');
const audit = require('../lib/audit');
const { wrap, badRequest, unauthorized, forbidden, AppError } = require('../lib/errors');

const TABLE = 'provider_ratings';
const ASPECTS = ['price', 'reliability', 'support', 'speed'];

function requireMember(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  if (req.auth.user.user_type !== 'member') {
    throw forbidden('This account is not a member account.', {
      logDetail: 'non-member hit /me/rating',
    });
  }
  return req.auth.user;
}

/** 1-5 integer, or null if missing / out of range / not a whole number. */
function score(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

function publicRating(row) {
  return {
    provider: row.provider || null,
    price: Number(row.price) || null,
    reliability: Number(row.reliability) || null,
    support: Number(row.support) || null,
    speed: Number(row.speed) || null,
    createdAt: row.created_at || null,
  };
}

function mount(router) {
  /** The rating this member has already given, or null. -> { ok, rating } */
  router.get('/me/rating', wrap(async (req, res) => {
    const user = requireMember(req);
    const row = await datastore.findBy(req.catalyst, TABLE, 'user_id', user.user_id);
    res.status(200).json({ ok: true, rating: row ? publicRating(row) : null });
  }));

  /**
   * Record this member's rating. -> { ok, rating }
   * CONFLICT if one already exists — unlike /me/bill this is not a
   * replace-on-resubmit endpoint; the card is a one-time ask.
   */
  router.post('/me/rating', wrap(async (req, res) => {
    const user = requireMember(req);
    const b = req.body || {};

    const provider = String(b.provider || '').trim().slice(0, 100);
    if (!provider) throw badRequest('Missing provider.');

    const fields = {};
    for (const aspect of ASPECTS) {
      const s = score(b[aspect]);
      if (s === null) throw badRequest('Rate every category from 1 to 5.');
      fields[aspect] = s;
    }

    const existing = await datastore.findBy(req.catalyst, TABLE, 'user_id', user.user_id, ['ROWID']);
    if (existing) {
      throw new AppError('CONFLICT', 'You have already rated your provider.', {
        logDetail: 'duplicate /me/rating submission',
      });
    }

    const row = { user_id: user.user_id, provider, ...fields, created_at: datastore.nowDb() };
    try {
      await datastore.insertRow(req.catalyst, TABLE, row);
    } catch (err) {
      // The unique constraint on user_id is the real guard — the existence
      // check above is just what makes the common case a clean error message
      // instead of a raw insert failure.
      throw new AppError('CONFLICT', 'You have already rated your provider.', {
        logDetail: `provider_ratings insert failed: ${String((err && err.message) || err).slice(0, 200)}`,
      });
    }

    audit.recordAsync(req.catalyst, req, {
      type: 'member.rating.save',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { provider },
    });

    res.status(200).json({ ok: true, rating: publicRating(row) });
  }));
}

module.exports = { mount };
