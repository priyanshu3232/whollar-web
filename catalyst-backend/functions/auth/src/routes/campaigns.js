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
 * The catalog lives in `lib/catalog.js`; the STATE of a campaign (its count,
 * its two stages, whether it is open) lives in `lib/cohorts.js`, and both
 * routes here are projections of that one object. Membership stays in
 * `campaign_members`; the seat ledger in `seat_claim`; cohorts.seatCount()
 * counts across both so the number a member sees is the number a partner
 * prices against.
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
const seats = require('../lib/seats');
const users = require('../lib/users');
const catalog = require('../lib/catalog');
const cohorts = require('../lib/cohorts');
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
 * This member's own membership rows, keyed by campaign id. One scoped read
 * on user_id, never a scan of every campaign's rows to find one person's.
 * Null when the table cannot be read, which above all means "not created in
 * the console yet": the dashboard must tell "no rows" from "no table".
 */
async function mineRows(catalystApp, userId) {
  try {
    const rows = await datastore.queryAll(
      catalystApp, TABLE, ['campaign_id', 'user_id', 'status'],
      `user_id = ${datastore.lit(userId)}`
    );
    const by = {};
    for (const r of rows) by[r.campaign_id] = r;
    return by;
  } catch {
    return null;
  }
}

/** One campaign, freshly counted, member-shaped. For the mutation replies. */
async function memberReply(catalystApp, campaign, mine) {
  cohorts.invalidate(campaign.id);
  const now = Date.now();
  const s = cohorts.state(campaign, await cohorts.seatCount(catalystApp, campaign), now);
  return { now, campaign: cohorts.forMember(s, mine) };
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
  cohorts.invalidate(campaign.id);
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
    const row = {
      membership_key: key,
      campaign_id: campaign.id,
      user_id: user.user_id,
      status,
      fsa: user.fsa || null,
      joined_at: datastore.nowDb(),
    };
    try {
      /* Referral attribution, stamped with the campaign actually joined: the
         code this member arrived carrying, copied at join time. The referrer's
         panel total stays a count over users.referral_code; this stamp is what
         makes a per-campaign attribution answerable at all, and it lands on
         the row of the campaign the household chose, which may not be the
         referrer's own cohort. Read here rather than from the session user,
         whose projection deliberately stays narrow. */
      const rec = await users.findById(catalystApp, user.user_id);
      await datastore.insertRow(catalystApp, TABLE, {
        ...row, referral_code: (rec && rec.referral_code) || null,
      });
    } catch (stampErr) {
      /* The column ships after the code: until the operator adds
         campaign_members.referral_code in the console, the plain row is the
         join and nothing is lost but the stamp. */
      await datastore.insertRow(catalystApp, TABLE, row);
    }
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
    /* ONE read layer, one clock. cohorts.list() counts and stages every
       visible campaign at a single instant; /provider/campaigns calls the
       same function, so the two surfaces cannot disagree about a cohort. */
    const { source, live, serverTime: now, states } = await cohorts.list(req.catalyst);
    const mineBy = await mineRows(req.catalyst, user.user_id);
    /* THE MEMBER'S OWN DECISION, RESTORED. An accepted offer is an order row
       and the row is the record: without this field a household that accepted
       saw the Offers panel again on every reload, take button live, as if it
       had never answered. Asked only where an order can exist at all, which
       is a cohort this member joined whose window has closed, so the common
       payload costs nothing extra. Order number and state only: the address
       a household consented to release goes to its winning partner through
       routes/delivery.js and nowhere else, this response included. */
    const list = [];
    for (const s of states) {
      const mine = mineBy ? mineBy[s.id] : undefined;
      const pub = cohorts.forMember(s, mine);
      if (mine && awards.isClosed(s.campaign, now)) {
        try {
          const key = `${s.id}:${user.user_id}`.slice(0, 200);
          const row = await orders.findAnyByKey(req.catalyst, key);
          if (row) pub.yourOrder = { orderNo: row.order_no || null, state: row.state || 'acc' };
        } catch {
          /* Orders table unreadable: the decision cannot be restored, and
             everything else in the payload stands. Same contract as counts. */
        }
      }
      list.push(pub);
    }
    res.status(200).json({
      ok: true,
      serverTime: now,
      /* `live` is false when a count table was unreadable OR when this
         member's own rows were: either way the dashboard must not read the
         answer's silences as "you left everything". */
      live: live && mineBy !== null,
      source,
      campaigns: list,
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

    /* serverTime on every exit: this is the endpoint a household polls
       against closesAt, so the countdown must offset from the server clock. */
    if (!closed) {
      return res.status(200).json({
        ok: true, serverTime: now, sealed: true, closesAt, bidCount: null, offer: null,
      });
    }

    const rows = await bids.campaignBidRows(req.catalyst, campaign.id);
    if (rows === null) {
      /* Unreadable, which above all means the auction tables are not created
         yet. Distinct from "nobody bid", and the dashboard renders it as such
         rather than telling a household its cohort drew no interest. */
      return res.status(200).json({
        ok: true, serverTime: now, sealed: false, live: false, closesAt, bidCount: null, offer: null,
      });
    }
    if (!rows.length) {
      return res.status(200).json({
        ok: true, serverTime: now, sealed: false, live: true, closesAt, bidCount: 0, offer: null,
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
        ok: true, serverTime: now, sealed: false, live: true, closesAt, bidCount: rows.length, offer: null,
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
      serverTime: now,
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

    /* INV-1: one seat per address per vertical. This door predates the seat
       ledger and used to bypass it, so one household could join N forming
       cohorts and be counted on N desks at once. A full join now runs the
       same claim transition as POST /cohorts/:id/join; a waitlist or alert
       standing is interest, not a seat, and stays ledger-free. */
    if (status === 'joined') {
      const addressId = seats.addressIdFor(user);
      const vertical = seats.VERTICAL_DEFAULT;
      const now = Date.now();
      const closeAt = campaign.dates && campaign.dates.announce_at;
      if (closeAt && now >= closeAt) {
        throw new AppError('JOIN_CLOSED', 'Joining has closed on this cohort.', {
          logDetail: `join refused: ${campaign.id} window shut`,
        });
      }
      let existing = null;
      let ledgerReadable = true;
      try {
        existing = seats.publicClaim(await seats.getClaim(req.catalyst, addressId, vertical));
      } catch {
        /* Ledger unreadable means the whole seat system is down, and refusing
           here would close the one door that still works. The next successful
           seat write re-establishes the invariant. Reads degrade; the guard
           below still refuses whenever a held seat CAN be seen. */
        ledgerReadable = false;
      }
      if (existing && existing.status === 'active' && existing.cohort_id !== campaign.id) {
        const held = cat.byId.get(existing.cohort_id);
        audit.recordAsync(req.catalyst, req, {
          type: 'seat.move.blocked', outcome: 'success', userId: user.user_id,
          email: user.email_normalized,
          detail: { from_cohort: existing.cohort_id, to_cohort: campaign.id, via: 'campaigns.join' },
        });
        throw new AppError('SEAT_HELD',
          held ? `You are already in ${held.region}.` : 'This address already holds a cohort seat.', {
            logDetail: `join refused: address holds ${existing.cohort_id}`,
            extra: { held_cohort: held ? { id: held.id, region: held.region, sub: held.sub } : null },
          });
      }
      if (ledgerReadable && (!existing || existing.status !== 'active')) {
        cohorts.invalidate(campaign.id);
        const count = (await cohorts.seatCount(req.catalyst, campaign)).seats;
        if (campaign.target && count >= campaign.target) {
          throw new AppError('ROSTER_FULL', `${campaign.region} is full for this round.`, {
            logDetail: `join refused: ${campaign.id} at target`,
          });
        }
        await seats.transition(req.catalyst, {
          user, addressId, vertical,
          action: existing && existing.cohort_id === campaign.id ? 'rejoin' : 'join',
          fromCohortId: null, toCohortId: campaign.id,
          reason: null, requestId: seats.cleanRequestId(req.get('Idempotency-Key')),
        });
        await seats.recount(req.catalyst, campaign.id);
      }
    }

    const was = await upsert(req.catalyst, campaign, user, status);
    audit.recordAsync(req.catalyst, req, {
      type: 'campaign.join',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { campaign: campaign.id, status, was },
    });

    const reply = await memberReply(req.catalyst, campaign, { status });
    res.status(200).json({ ok: true, serverTime: reply.now, campaign: reply.campaign });
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

    /* INV-1's other half: if this address's seat is on this cohort, the
       ledger releases it under the same rules as POST /cohorts/:id/leave, or
       refuses the same way once the roster sealed. Without this, a leave
       through the old door dropped the snapshot row but kept the claim
       active, stranding the address behind SEAT_HELD everywhere. A waitlist
       or alert row has no seat and keeps the old idempotent path. */
    try {
      const addressId = seats.addressIdFor(user);
      const claim = seats.publicClaim(
        await seats.getClaim(req.catalyst, addressId, seats.VERTICAL_DEFAULT));
      if (claim && claim.status === 'active' && claim.cohort_id === campaign.id) {
        const now = Date.now();
        const closeAt = campaign.dates && campaign.dates.announce_at;
        if (!(campaign.kind === 'forming' && (!closeAt || now < closeAt))) {
          throw new AppError('SEAL_RACE',
            `${campaign.region} sealed while this page was open. Nothing is owed and you are not committed to switch.`, {
              logDetail: `leave refused: ${campaign.id} past join window`,
            });
        }
        await seats.transition(req.catalyst, {
          user, addressId, vertical: seats.VERTICAL_DEFAULT,
          action: 'leave', fromCohortId: campaign.id, toCohortId: null,
          reason: null, requestId: seats.cleanRequestId(req.get('Idempotency-Key')),
        });
        await seats.recount(req.catalyst, campaign.id);
        await seats.applyHysteresis(req.catalyst, campaign.id);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Ledger unreadable: same degradation as the join guard above.
    }

    try {
      const existing = await datastore.findBy(
        req.catalyst, TABLE, 'membership_key', key, ['ROWID', 'status']
      );
      if (existing) await datastore.deleteRow(req.catalyst, TABLE, existing.ROWID);
    } catch {
      // Table missing: there was nothing to leave. Idempotent success.
    }
    cohorts.invalidate(campaign.id);

    audit.recordAsync(req.catalyst, req, {
      type: 'campaign.leave',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { campaign: campaign.id },
    });

    const reply = await memberReply(req.catalyst, campaign, undefined);
    res.status(200).json({ ok: true, serverTime: reply.now, campaign: reply.campaign });
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

    const reply = await memberReply(req.catalyst, campaign, { status });
    res.status(200).json({ ok: true, serverTime: reply.now, campaign: reply.campaign });
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
    const enabled = await siteconfig.getValue(req.catalyst, 'bidding_enabled') !== false;
    /* The SAME cohorts.list() the member route reads, projected for a
       partner. One clock reading for the whole payload, taken inside list():
       two campaigns in one answer are never staged a millisecond apart, and
       serverTime is the instant the stages were computed at. */
    const { source, live, serverTime: now, states } = await cohorts.list(req.catalyst);
    res.status(200).json({
      ok: true,
      serverTime: now,
      live,
      source,
      bidding: {
        enabled,
        notice: enabled ? null : 'Bidding is paused across Whollar right now.',
      },
      campaigns: states.map((s) => cohorts.forPartner(s, enabled)),
    });
  }));
}

module.exports = { mount, requireBiddingOpen, upsert, TABLE, mineRows };
