'use strict';

/**
 * The unauthenticated data routes: published site configuration, and the one
 * question the join form has to ask before anyone has an account.
 *
 * GET /public/config   -> { ok, config: { key: value, ... } }
 * GET /public/referral -> { ok, valid, code, firstName }
 *
 * What the marketing pages and dashboards call (via `W.siteConfig()`) to
 * render prices, thresholds and notices the admin console can change without
 * a deploy. Only keys marked `published` appear, values only: no
 * descriptions, no audit fields, nothing about who changed what.
 *
 * Cacheable for 60 seconds, deliberately overriding the function-wide
 * no-store: this response is identical for every visitor, carries nothing
 * personal, and is the one answer the whole site asks for on every load.
 * The 60s matches the server-side memo, so a console edit is fully live
 * everywhere within a minute.
 */

const siteconfig = require('../lib/siteconfig');
const referral = require('../lib/referral');
const ratelimit = require('../lib/ratelimit');
const { wrap } = require('../lib/errors');

function mount(router) {
  router.get('/public/config', wrap(async (req, res) => {
    const config = await siteconfig.publicConfig(req.catalyst);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).json({ ok: true, config });
  }));

  /**
   * Does this referral code belong to anyone, and to whom.
   *
   * The join form asks before submitting, so someone who mistypes a neighbour's
   * code is told at the field rather than signing up unattributed and never
   * finding out. Answering needs no session because the people who need the
   * answer do not have one yet.
   *
   * WHAT THIS DISCLOSES, deliberately: a first name, to a caller who already
   * holds the code. That is the feature, "Referred by Priya" is the reassurance
   * the field exists to give. Nothing else about the account is readable, the
   * code space is four billion wide, and the rate limit below makes walking it
   * pointless. An unparseable code never reaches the store at all.
   *
   * Never cached: unlike /public/config the answer differs per caller, and a
   * shared cache keyed on the URL would hand one visitor another's lookup.
   */
  router.get('/public/referral', wrap(async (req, res) => {
    const code = referral.normalize((req.query && req.query.code) || '');
    if (!code) return res.status(200).json({ ok: true, valid: false, code: null, firstName: null });

    await ratelimit.enforce(req.catalyst, req, {
      key: 'referral.check', max: 40, windowSec: 3600,
    });

    const owner = await referral.resolve(req.catalyst, code);
    res.status(200).json({
      ok: true,
      valid: Boolean(owner),
      code,
      firstName: (owner && owner.first_name) || null,
    });
  }));
}

module.exports = { mount };
