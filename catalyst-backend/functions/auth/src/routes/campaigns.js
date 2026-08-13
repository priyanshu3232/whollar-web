'use strict';

/**
 * Campaigns: the first surface the member and partner dashboards SHARE.
 *
 * One catalog of campaigns, one membership table, and both sides reading
 * counts from it — so a member joining a cohort is one more household on the
 * partner's desk.
 *
 *   GET  /campaigns            what a signed-in member sees near them
 *   POST /campaigns/join       join a forming cohort / a waitlist
 *   POST /campaigns/leave      undo a join (forming cohorts are not binding)
 *   POST /campaigns/notify     "text me the day it opens"
 *   GET  /provider/campaigns   the same campaigns, partner-shaped: counts only
 *
 * The catalog itself now lives in `lib/catalog.js`: the `campaigns` table when
 * it exists, the original code constant when it does not. That move is what
 * lets the admin console change a cohort's lifecycle without a deploy; the
 * fallback is what keeps day one identical to yesterday. Membership stays in
 * `campaign_members`, untouched.
 *
 * Bidding is enforced here as data, decided elsewhere: the response to the
 * partner desk carries `bidding.enabled` (the global kill switch from
 * site_config) and each auction's `bidding_open`. `requireBiddingOpen()` is
 * exported for the day a bid-placing route exists — the check must live in
 * one helper so no future route can forget it.
 *
 * Counts only ever cross the aisle. A partner sees how many households a
 * campaign has, never who they are.
 */

const datastore = require('../lib/datastore');
const audit = require('../lib/audit');
const catalog = require('../lib/catalog');
const siteconfig = require('../lib/siteconfig');
const guards = require('../lib/guards');
const { wrap, badRequest, AppError } = require('../lib/errors');

const TABLE = 'campaign_members';
const { JOIN_STATUS } = catalog;

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

/** Archived campaigns exist for the admin console only. */
const visible = (list) => list.filter((c) => c.kind !== 'archived');

/**
 * One campaign, partner-shaped: counts only, stage derived at `now`. Shared
 * by /provider/campaigns and the brief route in desk.js so the desk list and
 * the brief can never disagree about what a cohort looks like.
 *
 * `stage` is DISPLAY ONLY, and server owned. The console renders it and must
 * never recompute it: a browser clock a few minutes fast would otherwise
 * disagree with the server about whether a sealed window is open.
 * Authorisation stays with bidding_open here and with requireBiddingOpen on
 * the write path.
 */
function publicPartnerCampaign(c, counts, enabled, now) {
  const t = counts[c.id] || { signups: 0, watching: 0 };
  const s = catalog.publicStage(c, now);
  return {
    id: c.id,
    region: c.region,
    /* The coverage key this cohort verifies against. Equal to region today;
       sent separately so the console never has to guess, and so a cohort can
       one day display "Scarborough East" while verifying against the
       partner's "Scarborough" coverage. */
    coverageRegion: c.region,
    sub: c.sub,
    kind: c.kind,
    target: c.target,
    members: c.seedMembers + t.signups,
    households: c.seedHouseholds + t.signups,
    signups: t.signups,
    watching: t.watching,
    bidding_open: enabled && c.kind === 'auction' && Boolean(c.biddingOpen),
    stage: s.stage,
    stageLabel: s.stageLabel,
    nextAt: s.next ? s.next.at : null,
    nextWhat: s.next ? s.next.what : null,
    dates: c.dates || {},
  };
}

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

/* Both moved to lib/guards.js, which is now the only place any of these are
   written. Note requireProvider is the WEAK provider gate: signed in and of
   type provider, with no org context and no approval check. That is correct
   here, because /provider/campaigns returns counts that are the same for every
   partner. Anything scoped to one org's own data wants requirePartner. */
const requireMember = (req) => guards.requireMember(req, '/campaigns');
const requireProvider = (req) => guards.requireProvider(req, '/provider/campaigns');

/** The catalog entry the body names, or a 400 that says what is on offer. */
function campaignFrom(cat, body) {
  const id = String((body || {}).campaign || '').trim();
  const c = cat.byId.get(id);
  if (!c || c.kind === 'archived') {
    throw badRequest('That campaign does not exist.', {
      logDetail: `unknown campaign id, length ${id.length}`,
    });
  }
  return c;
}

/**
 * The one bidding gate. Every future route that accepts a bid MUST call this
 * first — the global kill switch and the per-campaign window are both
 * enforced here and nowhere else, so no new route can check one and forget
 * the other. Refuses with 409, the code the dashboards render as "bidding is
 * paused", not as an error of theirs.
 */
async function requireBiddingOpen(catalystApp, campaign) {
  const enabled = await siteconfig.getValue(catalystApp, 'bidding_enabled');
  if (enabled === false) {
    throw new AppError('CONFLICT', 'Bidding is paused across Whollar right now.', {
      logDetail: 'bid refused: bidding_enabled=false',
    });
  }
  if (campaign.kind !== 'auction' || !campaign.biddingOpen) {
    throw new AppError('CONFLICT', 'Bidding is not open on this campaign.', {
      logDetail: `bid refused: kind=${campaign.kind} bidding_open=${campaign.biddingOpen}`,
    });
  }
  /**
   * The deadline backstop.
   *
   * Closing an auction is otherwise a manual admin action: someone has to flip
   * bidding_open at the stated minute. Nobody is at a keyboard at 5pm on the
   * day every cohort closes, so without this a sealed auction stays open past
   * its own published deadline, and a late bid is accepted against partners
   * who respected it.
   *
   * This is not a scheduler and does not need one. It fails safe in both
   * directions: no date means the previous behaviour exactly, and a passed
   * date means refuse. A missed manual close becomes a stale label on a desk
   * instead of an accepted late bid.
   *
   * Note this reads the CLOSE date only. Bidding still does not OPEN on a
   * date; it opens when an admin says so. Dates may close a window, never
   * open one, so a mistyped date cannot let anyone in early.
   */
  const closesAt = campaign.dates && campaign.dates.bidding_closes_at;
  if (closesAt && Date.now() >= closesAt) {
    throw new AppError('CONFLICT', 'Bidding has closed on this cohort.', {
      logDetail: `bid refused: past bidding_closes_at by ${Date.now() - closesAt}ms`,
      /* The refusal carries the server clock so the console can show the
         partner that the server decided, not their machine. The window is
         half-open, [opens_at, closes_at): a write stamped exactly closes_at
         is late. */
      extra: { serverTime: Date.now(), closedAt: closesAt },
    });
  }
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
    const cat = await catalog.load(req.catalyst);
    const rows = await allRows(req.catalyst);
    const counts = rows ? tally(rows) : {};
    const mineBy = {};
    if (rows) {
      for (const r of rows) if (r.user_id === user.user_id) mineBy[r.campaign_id] = r;
    }
    res.status(200).json({
      ok: true,
      live: rows !== null,
      campaigns: visible(cat.list).map((c) => publicCampaign(c, counts, mineBy[c.id])),
    });
  }));

  /**
   * Join. Forming cohort -> a member of it; waitlist/planned region -> on the
   * list. Idempotent: joining twice is one row. An 'alert' row upgrades — a
   * join is strictly more interest than a bell. -> { ok, campaign }
   */
  router.post('/campaigns/join', wrap(async (req, res) => {
    const user = requireMember(req);
    const cat = await catalog.load(req.catalyst);
    const campaign = campaignFrom(cat, req.body);
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
    const cat = await catalog.load(req.catalyst);
    const campaign = campaignFrom(cat, req.body);
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
    const cat = await catalog.load(req.catalyst);
    const campaign = campaignFrom(cat, req.body);
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
   * The partner's view: the same campaigns, counts only.
   * -> { ok, live, bidding, campaigns }
   *
   * `households` is what the bid desk's `hh` column shows; `members`/`target`
   * feed the "Cohort forming: 62 of 100" notes on planned rows. No member
   * identity of any kind crosses this boundary.
   *
   * `bidding.enabled` is the global kill switch; each campaign additionally
   * carries `bidding_open`. The dashboard renders bid forms disabled when
   * either is off — and the server refuses regardless, via
   * requireBiddingOpen(), the day a bid route exists.
   */
  router.get('/provider/campaigns', wrap(async (req, res) => {
    requireProvider(req);
    const cat = await catalog.load(req.catalyst);
    const rows = await allRows(req.catalyst);
    const counts = rows ? tally(rows) : {};
    const enabled = await siteconfig.getValue(req.catalyst, 'bidding_enabled') !== false;

    /* One clock reading for the whole response, so two campaigns in the same
       payload cannot be staged against times a millisecond apart, and so the
       serverTime the console offsets from is the same instant the stages were
       computed at. Derived here rather than inside catalog.load(), which is
       memoized for 60 seconds: a stage may never be up to a minute stale, and
       the minute it would be stale in is the one before bidding closes. */
    const now = Date.now();

    res.status(200).json({
      ok: true,
      serverTime: now,
      live: rows !== null,
      bidding: {
        enabled,
        notice: enabled ? null : 'Bidding is paused across Whollar right now.',
      },
      campaigns: visible(cat.list).map((c) => publicPartnerCampaign(c, counts, enabled, now)),
    });
  }));
}

module.exports = { mount, allRows, tally, requireBiddingOpen, publicPartnerCampaign, TABLE };
