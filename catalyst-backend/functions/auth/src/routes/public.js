'use strict';

/**
 * The one unauthenticated data route: published site configuration.
 *
 * GET /public/config -> { ok, config: { key: value, ... } }
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
const { wrap } = require('../lib/errors');

function mount(router) {
  router.get('/public/config', wrap(async (req, res) => {
    const config = await siteconfig.publicConfig(req.catalyst);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).json({ ok: true, config });
  }));
}

module.exports = { mount };
