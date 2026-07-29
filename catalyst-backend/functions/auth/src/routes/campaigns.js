'use strict';

/**
 * Campaigns: the first surface the member and partner dashboards SHARE.
 *
 * Until now the two dashboards each carried their own hardcoded cohort
 * numbers, with no common identity between "London East" on a member card and
 * `le` on the partner bid desk. This module is the join point: one catalog of
 * campaigns, one membership table, and both sides reading counts from it — so
 * a member joining a cohort is one more household on the partner's desk.
 *
 *   GET  /campaigns            what a signed-in member sees near them
 *   POST /campaigns/join       join a forming cohort / a waitlist
 *   POST /campaigns/leave      undo a join (forming cohorts are not binding)
 *   POST /campaigns/notify     "text me the day it opens"
 *   GET  /provider/campaigns   the same campaigns, partner-shaped: counts only
 *
 * The CATALOG below is deliberately code, not a table. The set of campaigns
 * changes by deploy (an ops decision), membership changes by the minute (a
 * user decision) — only the latter needs a Data Store table, and Catalyst
 * tables are hand-created in the console, so every table this module does NOT
 * need is 25 minutes it does not cost. What the catalog holds as `seed*` are
 * the demo baselines the dashboards already showed; live sign-ups add to
 * them, so day one looks like the prototype and every real join moves both
 * surfaces by one.
 *
 * Counts only ever cross the aisle. A partner sees how many households a
 * campaign has, never who they are — same privacy line the bid desk already
 * promises ("bidding providers never see your provider or your price").
 */

const datastore = require('../lib/datastore');
const audit = require('../lib/audit');
const { wrap, badRequest, unauthorized, forbidden, AppError } = require('../lib/errors');

const TABLE = 'campaign_members';

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

/**
 * `kind` is what a member may do about it:
 *   forming  — a cohort filling toward its target; joinable, leaveable
 *   waitlist — a region gathering interest; joinable as a waitlist entry
 *   planned  — announced, opens later; notify only
 *   auction  — already locked and in front of partners; members are done here
 *
 * `seedMembers` is the member-facing baseline ("61 of 100 households"),
 * `seedHouseholds` the partner-facing one (the bid desk's `hh` column). They
 * differ on purpose where the dashboards' demo copy differed — each surface
 * keeps its familiar number, and live joins increment both.
 */
const CATALOG = [
  { id: 'kingston-west',     region: 'Kingston West',     sub: 'Autumn cohort', kind: 'auction',  target: null, seedMembers: 64, seedHouseholds: 64 },
  { id: 'london-east',       region: 'London East',       sub: 'Autumn cohort', kind: 'forming',  target: 100,  seedMembers: 61, seedHouseholds: 112 },
  { id: 'london-north',      region: 'London North',      sub: 'Winter cohort', kind: 'planned',  target: 100,  seedMembers: 61, seedHouseholds: 100 },
  { id: 'chatham-kent',      region: 'Chatham-Kent',      sub: 'First cohort',  kind: 'waitlist', target: 100,  seedMembers: 37, seedHouseholds: 100 },
  { id: 'windsor-core',      region: 'Windsor',           sub: 'Winter cohort', kind: 'waitlist', target: 100,  seedMembers: 52, seedHouseholds: 87 },
  { id: 'hamilton-mountain', region: 'Hamilton Mountain', sub: 'Winter cohort', kind: 'auction',  target: null, seedMembers: 58, seedHouseholds: 58 },
];

const byId = new Map(CATALOG.map((c) => [c.id, c]));

/** What joining each kind means. Absent = not joinable. */
const JOIN_STATUS = { forming: 'joined', waitlist: 'waitlist', planned: 'waitlist' };

/* ------------------------------------------------------------------ *
 * Membership reads
 * ------------------------------------------------------------------ */

/**
 * Every membership row, or null when the table cannot be read — which above
 * all means "not created in the console yet". The distinction matters: the
 * dashboards must keep working on seed numbers before the table exists, so
 * "no rows" and "no table" are different answers, not both `[]`.
 */
async function allRows(catalystApp) {
  try {
    return await datastore.queryAll(
      catalystApp, TABLE, ['campaign_id', 'user_id', 'status'], 'ROWID > 0'
    );
  } catch {
    return null;
  }
}

/** Fold rows into per-campaign tallies: sign-ups and watchers. */
function tally(rows) {
  const counts = {};
  for (const row of rows) {
    const c = counts[row.campaign_id] || (counts[row.campaign_id] = { signups: 0, watching: 0 });
    if (row.status === 'alert') c.watching += 1;
    else c.signups += 1;
  }
  return counts;
}

/** One campaign, wire-shaped. `mine` is this member's row or undefined. */
function publicCampaign(c, counts, mine) {
  const t = counts[c.id] || { signups: 0, watching: 0 };
  return {
    id: c.id,
    region: c.region,
    sub: c.sub,
    kind: c.kind,
    target: c.target,
    members: c.seedMembers + t.signups,
    households: c.seedHouseholds + t.signups,
    watching: t.watching,
    joinable: Boolean(JOIN_STATUS[c.kind]),
    you: mine ? mine.status : null,
  };
}

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

function requireMember(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  if (req.auth.user.user_type !== 'member') {
    throw forbidden('This account is not a member account.', {
      logDetail: 'non-member hit /campaigns',
    });
  }
  return req.auth.user;
}

function requireProvider(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  if (req.auth.user.user_type !== 'provider') {
    throw forbidden('This account is not a provider account.', {
      logDetail: 'non-provider hit /provider/campaigns',
    });
  }
  return req.auth.user;
}

/** The catalog entry the body names, or a 400 that says what is on offer. */
function campaignFrom(body) {
  const id = String((body || {}).campaign || '').trim();
  const c = byId.get(id);
  if (!c) {
    throw badRequest('That campaign does not exist.', {
      logDetail: `unknown campaign id, length ${id.length}`,
    });
  }
  return c;
}

/**
 * The single write funnel. Every mutation is an upsert on the flattened
 * (campaign, user) key — Catalyst's unique constraint is per-column, so the
 * pair is stored as one column, same trick as `auth_identities.provider_key`.
 * A failure here is almost always "table not created yet"; say so once,
 * clearly, instead of a generic 500.
 */
async function upsert(catalystApp, campaign, user, status) {
  const key = `${campaign.id}:${user.user_id}`;
  let existing;
  try {
    existing = await datastore.findBy(
      catalystApp, TABLE, 'membership_key', key, ['ROWID', 'status']
    );
    if (existing) {
      if (existing.status !== status) {
        await datastore.updateRow(catalystApp, TABLE, { ROWID: existing.ROWID, status });
      }
      return existing.status;
    }
    await datastore.insertRow(catalystApp, TABLE, {
      membership_key: key,
      campaign_id: campaign.id,
      user_id: user.user_id,
      status,
      fsa: user.fsa || null,
      joined_at: datastore.nowDb(),
    });
    return null;
  } catch (err) {
    throw new AppError('SERVER_ERROR',
      'Campaign sign-ups are not available right now. Please try again shortly.', {
        logDetail: `campaign_members write failed: ${String((err && err.message) || err).slice(0, 200)}`,
      });
  }
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

function mount(router) {
  /**
   * The campaigns a member can see, with live counts and their own standing.
   * -> { ok, live, campaigns }
   *
   * `live:false` means counts are seed baselines because the membership table
   * was unreadable — the dashboard renders exactly what it rendered before
   * this API existed, and hides nothing.
   */
  router.get('/campaigns', wrap(async (req, res) => {
    const user = requireMember(req);
    const rows = await allRows(req.catalyst);
    const counts = rows ? tally(rows) : {};
    const mineBy = {};
    if (rows) {
      for (const r of rows) if (r.user_id === user.user_id) mineBy[r.campaign_id] = r;
    }
    res.status(200).json({
      ok: true,
      live: rows !== null,
      campaigns: CATALOG.map((c) => publicCampaign(c, counts, mineBy[c.id])),
    });
  }));

  /**
   * Join. Forming cohort -> a member of it; waitlist/planned region -> on the
   * list. Idempotent: joining twice is one row. An 'alert' row upgrades — a
   * join is strictly more interest than a bell. -> { ok, campaign }
   */
  router.post('/campaigns/join', wrap(async (req, res) => {
    const user = requireMember(req);
    const campaign = campaignFrom(req.body);
    const status = JOIN_STATUS[campaign.kind];
    if (!status) {
      throw badRequest('This campaign is already with providers and closed to new joins.', {
        logDetail: `join on kind=${campaign.kind}`,
      });
    }

    const was = await upsert(req.catalyst, campaign, user, status);
    audit.recordAsync(req.catalyst, req, {
      type: 'campaign.join',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { campaign: campaign.id, status, was },
    });

    const rows = await allRows(req.catalyst);
    const counts = rows ? tally(rows) : {};
    res.status(200).json({
      ok: true,
      campaign: publicCampaign(campaign, counts, { status }),
    });
  }));

  /**
   * Leave. Forming cohorts are explicitly not binding until lock, and a
   * waitlist you cannot get off is a trap, not a list. Idempotent: leaving a
   * campaign you never joined succeeds. -> { ok, campaign }
   */
  router.post('/campaigns/leave', wrap(async (req, res) => {
    const user = requireMember(req);
    const campaign = campaignFrom(req.body);
    const key = `${campaign.id}:${user.user_id}`;

    try {
      const existing = await datastore.findBy(
        req.catalyst, TABLE, 'membership_key', key, ['ROWID', 'status']
      );
      if (existing) await datastore.deleteRow(req.catalyst, TABLE, existing.ROWID);
    } catch {
      // Table missing: there was nothing to leave. Idempotent success.
    }

    audit.recordAsync(req.catalyst, req, {
      type: 'campaign.leave',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { campaign: campaign.id },
    });

    const rows = await allRows(req.catalyst);
    const counts = rows ? tally(rows) : {};
    res.status(200).json({
      ok: true,
      campaign: publicCampaign(campaign, counts, undefined),
    });
  }));

  /**
   * The bell: "tell me the day this one moves." Never downgrades — a member
   * who already joined and then taps the bell stays joined. -> { ok, campaign }
   */
  router.post('/campaigns/notify', wrap(async (req, res) => {
    const user = requireMember(req);
    const campaign = campaignFrom(req.body);
    const key = `${campaign.id}:${user.user_id}`;

    let status = 'alert';
    let existing = null;
    try {
      existing = await datastore.findBy(
        req.catalyst, TABLE, 'membership_key', key, ['ROWID', 'status']
      );
    } catch {
      existing = null;
    }
    if (existing) {
      status = existing.status; // already joined/waitlisted: the bell adds nothing
    } else {
      await upsert(req.catalyst, campaign, user, 'alert');
    }

    audit.recordAsync(req.catalyst, req, {
      type: 'campaign.notify',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { campaign: campaign.id },
    });

    const rows = await allRows(req.catalyst);
    const counts = rows ? tally(rows) : {};
    res.status(200).json({
      ok: true,
      campaign: publicCampaign(campaign, counts, { status }),
    });
  }));

  /**
   * The partner's view: the same campaigns, counts only. -> { ok, live, campaigns }
   *
   * `households` is what the bid desk's `hh` column shows; `members`/`target`
   * feed the "Cohort forming: 62 of 100" notes on planned rows. No member
   * identity of any kind crosses this boundary.
   */
  router.get('/provider/campaigns', wrap(async (req, res) => {
    requireProvider(req);
    const rows = await allRows(req.catalyst);
    const counts = rows ? tally(rows) : {};
    res.status(200).json({
      ok: true,
      live: rows !== null,
      campaigns: CATALOG.map((c) => {
        const t = counts[c.id] || { signups: 0, watching: 0 };
        return {
          id: c.id,
          region: c.region,
          sub: c.sub,
          kind: c.kind,
          target: c.target,
          members: c.seedMembers + t.signups,
          households: c.seedHouseholds + t.signups,
          signups: t.signups,
          watching: t.watching,
        };
      }),
    });
  }));
}

module.exports = { mount };
