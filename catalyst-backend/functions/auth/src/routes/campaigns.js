'use strict';

/**
 * Campaigns: the first surface the member and partner dashboards SHARE.
 *
 * One catalog of campaigns, one membership table, and both sides reading
 * counts from it, so a member joining a cohort is one more household on the
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
 * exported for the day a bid-placing route exists: the check must live in
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
const bids = require('../lib/bids');
const awards = require('../lib/awards');
const orders = require('../lib/orders');
const { wrap, badRequest, AppError } = require('../lib/errors');

const TABLE = 'campaign_members';
const { JOIN_STATUS } = catalog;

/* ------------------------------------------------------------------ *
 * Membership reads
 * ------------------------------------------------------------------ */

/**
 * Every membership row, or null when the table cannot be read, which above
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
function publicCampaign(c, counts, mine, now) {
  const t = counts[c.id] || { signups: 0, watching: 0 };
  const s = catalog.publicMemberStage(c, now);
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
    /* DERIVED, not the stored status. `campaign_members.status` is a snapshot
       of the click and no transition rewrites it, so a household that joined
       while the region was gathering read `waitlist` forever, which the
       dashboard renders as a visitor lane with no rail at all. See
       catalog.standingOf: the cohort moves, the click does not. */
    you: mine ? catalog.standingOf(mine.status, c) : null,
    /* Stage and calendar are SERVER OWNED. The dashboard renders these; it
       must never re-derive a stage from `kind` in the browser, which is what
       it did before this field existed. `dates` are epoch ms, and the
       response's `serverTime` is the instant they were staged against, so a
       countdown offsets from that rather than from the visitor's clock. */
    stage: s.stage,
    stageLabel: s.stageLabel,
    next: s.next,
    dates: c.dates || {},
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
 * first: the global kill switch and the per-campaign window are both
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
 * (campaign, user) key: Catalyst's unique constraint is per-column, so the
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
   * was unreadable: the dashboard renders exactly what it rendered before
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
    /* One clock reading for the whole response, for the same reason
       /provider/campaigns takes one: two campaigns in a single payload must
       not be staged a millisecond apart, and the serverTime the dashboard
       offsets from has to be the instant the stages were computed at. */
    const now = Date.now();
    res.status(200).json({
      ok: true,
      serverTime: now,
      live: rows !== null,
      campaigns: visible(cat.list).map((c) => publicCampaign(c, counts, mineBy[c.id], now)),
    });
  }));

  /**
   * The winning offer on a cohort this member belongs to.
   * -> { ok, sealed, closesAt, bidCount, offer }
   *
   * THE SEAL IS THE WHOLE POINT. Nothing about any bid crosses to a household
   * before `bidding_closes_at`. Not the price, not the count, not whether a
   * single partner has bid at all: a member who could watch the count climb
   * could tell a partner how much competition it has, and that is the same
   * leak as showing the bid. Before the close this answers `sealed: true` and
   * nothing else, and the answer is identical for a cohort with six bids and
   * one with none.
   *
   * After the close, ONE offer. The design is a single winning offer for the
   * whole cohort, not a shortlist to browse: the household compares it against
   * its own bill, not against other partners. The winner is the lowest
   * headline price, which `provider_bids.price` already holds (the lowest
   * tier's effective price, written on seal).
   *
   * The losing bids never appear, not even as a redacted row. `bidCount` says
   * how many were read and nothing about who or what they were.
   *
   * Membership is required. A cohort's offer is not public: a household that
   * did not join has nothing to compare it against and no business seeing it.
   */
  router.get('/campaigns/:id/offer', wrap(async (req, res) => {
    const user = requireMember(req);
    const cat = await catalog.load(req.catalyst);
    const campaign = campaignFrom(cat, { campaign: req.params.id });

    /* Membership, checked against the flattened composite. A member who is on
       the waitlist rather than in the cohort is still a member of it. */
    const key = `${campaign.id}:${user.user_id}`;
    let mine = null;
    try {
      mine = await datastore.findBy(req.catalyst, TABLE, 'membership_key', key, ['status']);
    } catch {
      mine = null;
    }
    if (!mine) {
      throw new AppError('FORBIDDEN', 'This offer belongs to a cohort you have not joined.', {
        logDetail: 'offer read without membership',
      });
    }

    const now = Date.now();
    const closesAt = (campaign.dates && campaign.dates.bidding_closes_at) || null;
    /* Closed means the calendar says so, or an admin moved the cohort past the
       auction. An auction with no close date has not closed: absent a date,
       the seal holds rather than falling open. */
    const closed = (closesAt && now >= closesAt)
      || campaign.kind === 'closed' || campaign.kind === 'archived';

    if (!closed) {
      return res.status(200).json({
        ok: true, sealed: true, closesAt, bidCount: null, offer: null,
      });
    }

    const rows = await bids.campaignBidRows(req.catalyst, campaign.id);
    if (rows === null) {
      /* Unreadable, which above all means the auction tables are not created
         yet. Distinct from "nobody bid", and the dashboard renders it as such
         rather than telling a household its cohort drew no interest. */
      return res.status(200).json({
        ok: true, sealed: false, live: false, closesAt, bidCount: null, offer: null,
      });
    }
    if (!rows.length) {
      return res.status(200).json({
        ok: true, sealed: false, live: true, closesAt, bidCount: 0, offer: null,
      });
    }

    /* Lowest headline wins, and the winner is now a RECORD rather than a
       derivation: lib/awards.js seals it on the first read after the close, so
       the household and the winning partner are told the same thing by the
       same row. The direct pick stays as the fallback for the window before
       the awards table exists, and it is the same rule either way. */
    const award = await awards.seal(req.catalyst, campaign, rows, now);
    const win = award
      ? (rows.find((r) => r.bid_key === award.bid_key) || null)
      : awards.pickWinner(rows);
    if (!win) {
      return res.status(200).json({
        ok: true, sealed: false, live: true, closesAt, bidCount: rows.length, offer: null,
      });
    }

    /* The winner is named to the household. That is the reveal the design
       intends, and it is one-directional: no partner learns who else bid. */
    let partner = null;
    try {
      const org = await datastore.findBy(req.catalyst, 'provider_orgs', 'org_id', win.org_id, ['legal_name']);
      partner = (org && org.legal_name) || null;
    } catch {
      partner = null;
    }

    const pub = bids.publicBid(win);
    const cheapest = pub.tiers.slice().sort((a, b) =>
      Number(a.effectivePrice) - Number(b.effectivePrice))[0] || null;

    res.status(200).json({
      ok: true,
      sealed: false,
      live: true,
      closesAt,
      bidCount: rows.length,
      offer: {
        partner,
        price: win.price,
        speed: cheapest ? cheapest.name : null,
        technology: cheapest ? cheapest.technology : null,
        guaranteeMonths: pub.guaranteeMonths,
        afterLine: pub.afterLine,
        equipment: pub.equipment,
        rentalMonthly: pub.rentalMonthly,
        committedHouseholds: pub.committedHouseholds,
        reference: pub.reference,
        tiers: pub.tiers,
      },
    });
  }));

  /**
   * Accept the winning offer. This is the act that creates a switch order, and
   * it is the only thing that ever puts a household address in front of a
   * partner.
   *
   *   POST /campaigns/:id/offer/accept  { address, consent: true }
   *
   * THE CONSENT IS THE ROW. There is no separate consent flag to go stale: the
   * order exists because the household accepted and ticked the release, and it
   * carries the timestamp of both. A partner reads that address later only
   * after its own roster gate, which routes/delivery.js enforces.
   *
   * ADDRESS COMES FROM THE HOUSEHOLD, HERE, NOW. Not from the join, which took
   * an FSA and nothing more, and not from a bill upload, which is a different
   * consent for a different purpose. A service address is given for the
   * install and for nothing else.
   *
   * Idempotent on the order key, which is cohort and member: a double-tapped
   * button is one order. Accepting does not bill: only an activation with a
   * clean line test creates a line, and the response says so because that is
   * the sentence the household should carry away.
   */
  router.post('/campaigns/:id/offer/accept', wrap(async (req, res) => {
    const user = requireMember(req);
    const cat = await catalog.load(req.catalyst);
    const campaign = campaignFrom(cat, { campaign: req.params.id });

    const key = `${campaign.id}:${user.user_id}`;
    let mine = null;
    try {
      mine = await datastore.findBy(req.catalyst, TABLE, 'membership_key', key, ['status', 'fsa']);
    } catch {
      mine = null;
    }
    if (!mine) {
      throw new AppError('FORBIDDEN', 'This offer belongs to a cohort you have not joined.', {
        logDetail: 'offer accept without membership',
      });
    }

    const now = Date.now();
    if (!awards.isClosed(campaign, now)) {
      throw badRequest('Bidding is still open on this cohort. The offer arrives when it closes.');
    }

    const bidRows = await bids.campaignBidRows(req.catalyst, campaign.id);
    const award = await awards.seal(req.catalyst, campaign, bidRows, now);
    if (!award) {
      throw new AppError('CONFLICT', 'There is no offer on this cohort yet.', {
        logDetail: `accept with no award campaign=${campaign.id}`,
      });
    }

    if ((req.body || {}).consent !== true) {
      throw badRequest('Confirm you are happy for your address to go to the winning partner for this install.');
    }
    const address = orders.readAddress((req.body || {}).address);
    const fsa = orders.readFsa((req.body || {}).fsa || mine.fsa);

    const row = await orders.create(req.catalyst, {
      campaignId: campaign.id,
      orgId: award.org_id,
      memberUserId: user.user_id,
      fsa,
      address,
      at: now,
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'offer.accept',
      outcome: 'success',
      userId: user.user_id,
      detail: `cohort=${campaign.id} org=${award.org_id}`,
    });

    res.status(200).json({
      ok: true,
      serverTime: now,
      accepted: true,
      orderNo: (row && row.order_no) || null,
      /* Said plainly, because it is the thing households ask: accepting is not
         a charge, and the install is booked next. */
      note: 'Accepted. Nothing is charged for switching, and your installer books the visit from here.',
    });
  }));

  /**
   * Join. Forming cohort -> a member of it; waitlist/planned region -> on the
   * list. Idempotent: joining twice is one row. An 'alert' row upgrades: a
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
   * The bell: "tell me the day this one moves." Never downgrades: a member
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
   * either is off, and the server refuses regardless, via
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

module.exports = { mount, allRows, tally, requireBiddingOpen, publicPartnerCampaign, publicCampaign, upsert, TABLE };
