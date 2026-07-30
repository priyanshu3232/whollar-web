'use strict';

/**
 * The partner console's write surface: the org's own facts, its team, its
 * sealed bids, and the coverage it claims.
 *
 *   POST /provider/org        rename the organisation (org admins only)
 *   GET  /provider/team       who is attached to this org, and how
 *   GET  /provider/bids       the org's live sealed bids
 *   POST /provider/bids       place or improve a sealed bid
 *   GET  /provider/coverage   regions the org serves
 *   POST /provider/coverage   update a region's services / declare a new one
 *
 * Approval gates the competitive surfaces. Renaming your own org and listing
 * your own team only require being in it; placing a bid or editing coverage
 * requires the org to be approved — those are the actions that touch cohorts.
 *
 * Bids additionally pass requireBiddingOpen(), the single gate campaigns.js
 * exports for exactly this route's benefit: the global kill switch and the
 * per-campaign window are checked in one place, here included.
 */

const datastore = require('../lib/datastore');
const orgs = require('../lib/orgs');
const users = require('../lib/users');
const catalog = require('../lib/catalog');
const audit = require('../lib/audit');
const { requireBiddingOpen } = require('./campaigns');
const { wrap, badRequest, unauthorized, forbidden, AppError } = require('../lib/errors');

const BIDS = 'provider_bids';
const COVERAGE = 'provider_coverage';

const TECHS = new Set(['cable', 'fibre', 'fwa', 'dsl']);

/** The signed-in partner and their org context, or a refusal. */
async function requirePartner(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  if (req.auth.user.user_type !== 'provider') {
    throw forbidden('This account is not a provider account.', {
      logDetail: 'non-provider hit /provider desk route',
    });
  }
  const context = await orgs.contextFor(req.catalyst, req.auth.user.user_id);
  if (!context) {
    throw forbidden('This account is not attached to an organisation.', {
      logDetail: 'provider with no membership hit desk route',
    });
  }
  return { user: req.auth.user, context };
}

function requireApproved(context) {
  if (!context.approved) {
    throw forbidden('Your organisation is still under review — this opens the moment it is approved.', {
      logDetail: `unapproved org ${context.orgId} hit a gated desk route`,
    });
  }
}

/** A dollar amount as a canonical string — same contract as member bills. */
function money(value, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return String(Math.round(n * 100) / 100);
}

const str = (v, max) => {
  const s = String(v == null ? '' : v).trim().slice(0, max);
  return s || null;
};

/** 'London East' -> 'london-east'; the region half of coverage_key. */
const slug = (region) =>
  String(region || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function publicBid(row) {
  return {
    campaign: row.campaign_id,
    price: row.price,
    speed: row.speed || null,
    term: row.term || null,
    includes: row.includes ? row.includes.split(',') : [],
    completion: row.completion || null,
    status: row.status,
    updatedAt: row.updated_at || null,
  };
}

function publicCoverage(row) {
  return {
    region: row.region,
    techs: row.techs ? row.techs.split(',') : [],
    speed: row.speed || null,
    lead: row.lead || null,
    status: row.status,
    updatedAt: row.updated_at || null,
  };
}

/** Every coverage row for an org, or null when the table is not provisioned. */
async function coverageRows(catalystApp, orgId) {
  try {
    return await datastore.queryAll(
      catalystApp, COVERAGE,
      ['coverage_key', 'org_id', 'region', 'techs', 'speed', 'lead', 'status', 'updated_at'],
      `org_id = ${datastore.lit(orgId)}`
    );
  } catch {
    return null;
  }
}

function mount(router) {
  /**
   * Rename the organisation. Org admins only — the legal name is what the
   * approval decision was made against, so the change is audited with both
   * values and the admin console sees it in the trail.
   */
  router.post('/provider/org', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    if (context.role !== 'admin') {
      throw forbidden('Only your organisation’s admin can rename it.', {
        logDetail: `role=${context.role} tried org rename`,
      });
    }

    const legalName = str((req.body || {}).legalName, 255);
    if (!legalName || legalName.length < 2) {
      throw badRequest('Enter your organisation’s legal name.');
    }

    const org = await orgs.findById(req.catalyst, context.orgId);
    if (!org) throw badRequest('Organisation not found.');

    await datastore.updateRow(req.catalyst, orgs.ORGS, {
      ROWID: org.ROWID, legal_name: legalName,
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.org.rename',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { org_id: org.org_id, from: org.legal_name, to: legalName },
    });

    res.status(200).json({ ok: true, org: { ...context, orgName: legalName } });
  }));

  /**
   * Who is attached to this org. Names and roles only, for the org's own
   * members — this is the one place a partner sees another person's name, and
   * they are colleagues.
   */
  router.get('/provider/team', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    const memberships = await orgs.membersOf(req.catalyst, context.orgId);

    const team = [];
    for (const m of memberships.slice(0, 50)) {
      const u = await users.findById(req.catalyst, m.user_id);
      if (!u || u.status === 'deleted') continue;
      team.push({
        firstName: u.first_name || null,
        lastName: u.last_name || null,
        email: u.email_display || u.email_normalized,
        role: m.role,
        you: u.user_id === user.user_id,
      });
    }

    res.status(200).json({
      ok: true,
      team,
      // The join rule, stated as data so the console can explain it: anyone
      // who signs up with this domain lands in this org automatically.
      emailDomain: (await orgs.findById(req.catalyst, context.orgId))?.email_domain || null,
    });
  }));

  /** The org's live sealed bids. -> { ok, live, bids } */
  router.get('/provider/bids', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    let rows = null;
    try {
      rows = await datastore.queryAll(
        req.catalyst, BIDS,
        ['bid_key', 'campaign_id', 'price', 'speed', 'term', 'includes', 'completion', 'status', 'updated_at'],
        `org_id = ${datastore.lit(context.orgId)}`
      );
    } catch { /* table not provisioned yet */ }

    res.status(200).json({
      ok: true,
      live: rows !== null,
      bids: (rows || []).map(publicBid),
    });
  }));

  /**
   * Place a sealed bid, or improve the one already standing — one live bid
   * per (campaign, org), and an upsert is what "improvable until close"
   * means. Approval and the bidding window are both enforced here, always.
   */
  router.post('/provider/bids', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);
    if (context.role === 'viewer') {
      throw forbidden('Your seat can view the desk but not place bids — ask your organisation’s admin.', {
        logDetail: 'viewer tried to place a bid',
      });
    }

    const body = req.body || {};
    const cat = await catalog.load(req.catalyst);
    const campaign = cat.byId.get(String(body.campaign || '').trim());
    if (!campaign) throw badRequest('That campaign does not exist.');

    await requireBiddingOpen(req.catalyst, campaign);

    const price = money(body.price, 500);
    if (!price) throw badRequest('Enter a monthly price between $1 and $500.');

    const includes = Array.isArray(body.includes)
      ? body.includes.map((v) => String(v).trim().toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 6)
      : [];
    const completion = (() => {
      const n = parseInt(body.completion, 10);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? String(n) : null;
    })();

    const fields = {
      price,
      speed: str(body.speed, 32),
      term: str(body.term, 32),
      includes: includes.join(',') || null,
      completion,
      status: 'sealed',
      updated_at: datastore.nowDb(),
    };

    const key = `${campaign.id}:${context.orgId}`;
    let improved = false;
    try {
      const existing = await datastore.findBy(req.catalyst, BIDS, 'bid_key', key, ['ROWID', 'price']);
      if (existing) {
        improved = true;
        await datastore.updateRow(req.catalyst, BIDS, { ROWID: existing.ROWID, ...fields });
      } else {
        await datastore.insertRow(req.catalyst, BIDS, {
          bid_key: key,
          campaign_id: campaign.id,
          org_id: context.orgId,
          user_id: user.user_id,
          ...fields,
        });
      }
    } catch (err) {
      throw new AppError('SERVER_ERROR',
        'Bidding is not available right now. Please try again shortly.', {
          logDetail: `provider_bids write failed: ${String((err && err.message) || err).slice(0, 200)}`,
        });
    }

    audit.recordAsync(req.catalyst, req, {
      type: improved ? 'provider.bid.improve' : 'provider.bid.place',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { org_id: context.orgId, campaign: campaign.id, price },
    });

    res.status(200).json({
      ok: true,
      bid: publicBid({ campaign_id: campaign.id, ...fields }),
      improved,
    });
  }));

  /** Regions the org serves. -> { ok, live, coverage } */
  router.get('/provider/coverage', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const rows = await coverageRows(req.catalyst, context.orgId);
    res.status(200).json({
      ok: true,
      live: rows !== null,
      coverage: (rows || []).map(publicCoverage),
    });
  }));

  /**
   * Update a region's services, or declare a new region. A declaration lands
   * as 'verifying' — serviceability is confirmed by an operator, not asserted
   * by the party it advantages. Editing an existing region keeps its status.
   */
  router.post('/provider/coverage', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);

    const body = req.body || {};
    const region = str(body.region, 100);
    if (!region) throw badRequest('Name the region.');
    const regionSlug = slug(region);
    if (!regionSlug) throw badRequest('Name the region.');

    const techs = Array.isArray(body.techs)
      ? [...new Set(body.techs.map((t) => String(t).trim().toLowerCase()).filter((t) => TECHS.has(t)))]
      : [];
    if (!techs.length) throw badRequest('Pick at least one technology you serve there.');

    const fields = {
      region,
      techs: techs.join(','),
      speed: str(body.speed, 16),
      lead: str(body.lead, 32),
      updated_at: datastore.nowDb(),
    };

    const key = `${context.orgId}:${regionSlug}`.slice(0, 200);
    let created = false;
    try {
      const existing = await datastore.findBy(req.catalyst, COVERAGE, 'coverage_key', key, ['ROWID', 'status']);
      if (existing) {
        await datastore.updateRow(req.catalyst, COVERAGE, { ROWID: existing.ROWID, ...fields });
      } else {
        created = true;
        await datastore.insertRow(req.catalyst, COVERAGE, {
          coverage_key: key,
          org_id: context.orgId,
          status: 'verifying',
          ...fields,
        });
      }
    } catch (err) {
      throw new AppError('SERVER_ERROR',
        'Coverage updates are not available right now. Please try again shortly.', {
          logDetail: `provider_coverage write failed: ${String((err && err.message) || err).slice(0, 200)}`,
        });
    }

    audit.recordAsync(req.catalyst, req, {
      type: created ? 'provider.coverage.declare' : 'provider.coverage.update',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { org_id: context.orgId, region: regionSlug, techs },
    });

    const rows = await coverageRows(req.catalyst, context.orgId);
    res.status(200).json({
      ok: true,
      live: rows !== null,
      coverage: (rows || []).map(publicCoverage),
    });
  }));
}

module.exports = { mount, BIDS, COVERAGE };
