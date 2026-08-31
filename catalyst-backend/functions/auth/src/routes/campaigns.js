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
const geo = require('../lib/geo');
const bids = require('../lib/bids');
const notices = require('../lib/notices');
const awards = require('../lib/awards');
const prefs = require('../lib/prefs');
const orders = require('../lib/orders');
const offers = require('../lib/offers');
const { ms } = require('../lib/envelope');
const { wrap, badRequest, AppError } = require('../lib/errors');

const TABLE = 'campaign_members';
const { JOIN_STATUS } = catalog;

/* ------------------------------------------------------------------ *
 * The price book: which entry a household opens on
 * ------------------------------------------------------------------ */

/**
 * The tier a household would open its offer on, from the one speed fact this
 * server holds: the preference chip stored on `user_prefs.interests`.
 *
 * 'keep' is deliberately NOT answered here. It means "the speed I have now",
 * and this route does not know that: the dashboard does, from the bill on the
 * checkup, and it re-centres its own three-wide window without another round
 * trip. Answering it with a guess would open somebody's offer on a speed they
 * never chose, which is the exact failure the price book exists to end.
 *
 * A preferences read that fails is not an error. The household still gets the
 * whole book; only which card it opens on is affected.
 */
async function preferredChip(catalystApp, userId) {
  let stored = {};
  try {
    stored = await prefs.get(catalystApp, userId);
  } catch {
    stored = {};
  }
  const want = ((stored && stored.interests) || {}).speed || null;
  return want === 'up' || want === 'cheap' || want === 'keep' ? want : null;
}

/**
 * The speed on this household's bill, as the checkup recorded it
 * (member_bills.download_speed: a bare Mbps figure, "0" for Not sure), or
 * null. Read once per offer read so the window can centre on it server side;
 * an unreadable table is null, which the window rule treats as unknown.
 */
async function billSpeed(catalystApp, userId) {
  try {
    const row = await datastore.findBy(catalystApp, 'member_bills', 'user_id', userId, ['download_speed']);
    return row && row.download_speed != null && row.download_speed !== '' ? String(row.download_speed) : null;
  } catch {
    return null;
  }
}

/**
 * A partner's legal name, or null.
 *
 * Resolved at read time rather than frozen into the sealed book: a legal name
 * can change, and a book that stored one would keep telling households the old
 * one long after the partner stopped using it. Null on an unreadable row,
 * because a nameless offer is still an offer and a 500 is not.
 */
async function partnerName(catalystApp, orgId) {
  if (!orgId) return null;
  try {
    const org = await datastore.findBy(catalystApp, 'provider_orgs', 'org_id', orgId, ['legal_name']);
    return (org && org.legal_name) || null;
  } catch {
    return null;
  }
}

/**
 * The book entry a household opens on: its preferred tier when the book holds
 * one, else the cheapest, which is what the single winner always was.
 */
function centreEntry(book, tier) {
  if (!book || !book.length) return null;
  if (tier) {
    const hit = book.filter((e) => e.tier === tier)[0];
    if (hit) return hit;
  }
  return book.slice().sort((a, b) => Number(a.price) - Number(b.price))[0] || null;
}

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

/**
 * This member's standing on ONE campaign, or null. The scoped read behind the
 * idempotent branch of a join: a household that is already in a cohort must
 * not be refused by the eligibility gate when the cohort's coverage changed
 * under it, or an operator editing an FSA set would lock existing households
 * out of their own cohort's dashboard. See geo.eligibilityOf and INV grandfathering.
 */
async function mineOn(catalystApp, campaign, userId) {
  try {
    return await datastore.findBy(
      catalystApp, TABLE, 'membership_key', `${campaign.id}:${userId}`, ['status']
    );
  } catch {
    return null;
  }
}

/**
 * present | missing | invalid, for this member's stored postal code.
 *
 * `invalid` is a real state and not a theoretical one: postal codes were
 * stored before lib/geo.js existed, validated by a looser regex, so a row can
 * carry six characters this stack will no longer derive an FSA from. Those
 * households see the "add your postal code" card with the same prompt a new
 * one gets, rather than an empty dashboard with no explanation. The count of
 * them is answerable in ZCQL against users.fsa IS NULL AND postal_code IS NOT
 * NULL, which is the migration report §10.7 asks for without a migration that
 * rewrites anybody's row.
 */
function postalStateOf(user) {
  if (user && user.fsa) return 'present';
  if (user && user.postal_code) return 'invalid';
  return 'missing';
}

/** One campaign, freshly counted, member-shaped. For the mutation replies. */
async function memberReply(catalystApp, campaign, mine, memberFsa) {
  cohorts.invalidate(campaign.id);
  const now = Date.now();
  const s = cohorts.state(campaign, await cohorts.seatCount(catalystApp, campaign), now);
  return { now, campaign: cohorts.forMember(s, mine, memberFsa) };
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

function mount(router, cfg) {
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
    /* STAGE NOTICES, off the same states this response is built from. Nothing
       in this stack notices a cohort moving: the stage is derived, and the
       write that moves it is a date in a row. So the read compares against the
       ledger of what has been announced and mails the difference. Fired and
       forgotten: a household waiting on a hundred outbound emails before its
       own dashboard paints would be a poor trade. See lib/notices.js. */
    notices.sweepAsync(req.catalyst, cfg, states, now);
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
      const pub = cohorts.forMember(s, mine, user.fsa);
      if (mine && awards.isClosed(s.campaign, now)) {
        try {
          const key = `${s.id}:${user.user_id}`.slice(0, 200);
          const row = await orders.findAnyByKey(req.catalyst, key);
          if (row) {
            pub.yourOrder = {
              orderNo: row.order_no || null,
              state: row.state || 'acc',
              /* The slot the household booked at acceptance, so the switching
                 panel can say the day rather than "confirmed by text". A date
                 the household chose is not identity. */
              slotAt: ms(row.slot_at),
            };
          }
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
      /* THE MEMBER'S OWN GEOGRAPHY, so the dashboard can say which of the
         three "nothing to join" cards it is looking at without guessing: no
         postal code on file at all, a stored code this stack can no longer
         parse, or a perfectly good postal code with no cohort in it yet. They
         read identically as an empty eligible list and they need three
         different cards. Derived, never echoed from a request. */
      memberFsa: user.fsa || null,
      postalCodeState: postalStateOf(user),
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

    /* THE COHORT'S RESULT IS A PRICE BOOK, not a winner. lib/awards.js seals
       it on the first read after the close: for every tier at least one
       partner quoted, the lowest effective price, under tie rules that give
       every reader the same answer. Three tiers of one cohort can belong to
       three partners, and every household picking the same speed still pays
       the same price, which is the property that makes a cohort a cohort.

       The household is shown its own tier and its two neighbours. The SLICE is
       the dashboard's, because only it knows the household's own bill speed;
       every PRICE in it is this route's, sealed, and never worked out on the
       client. */
    const book = await awards.sealBook(req.catalyst, campaign, rows, now);
    if (!book || !book.length) {
      return res.status(200).json({
        ok: true, serverTime: now, sealed: false, live: true, closesAt,
        bidCount: rows.length, book: [], offer: null,
      });
    }

    /* The winning partners are named to the household. That is the reveal the
       design intends, and it is one-directional: no partner learns who else
       bid, or that it shares a cohort at all. Resolved once per org rather
       than once per tier, because one partner commonly wins several. */
    const names = {};
    /* THE PARTNER'S PACE, per org. A partner states installs per week at its
       roster gate, and the household books against that pace: the number is
       shown beside the picker and a week already at it is greyed out, so the
       accept route's refusal of a full week is one a household rarely meets.
       Counts only ever leave this loop as "full" or "not full" per week: no
       other household's slot, address or number is on this wire. */
    const pace = {};
    for (const orgId of new Set(book.map((e) => e.orgId).filter(Boolean))) {
      /* eslint-disable-next-line no-await-in-loop */
      names[orgId] = await partnerName(req.catalyst, orgId);
      try {
        /* eslint-disable-next-line no-await-in-loop */
        const award = await awards.findForOrg(req.catalyst, campaign.id, orgId);
        const cap = award ? parseInt(award.install_capacity_weekly, 10) : null;
        if (cap > 0) {
          /* eslint-disable-next-line no-await-in-loop */
          const held = await orders.rowsForCampaign(req.catalyst, orgId, campaign.id);
          pace[orgId] = { capacityWeekly: cap, fullWeeks: orders.fullWeeks(held || [], cap, now) };
        }
      } catch {
        /* No pace known: the picker offers every day and the accept decides. */
      }
    }

    /* THE ORG ID DOES NOT CROSS. A household needs the partner's name to
       decide and the tier name to accept. The org id is this server's
       business, and the accept route resolves it from the sealed book rather
       than trusting whatever comes back up the wire. */
    const wire = book.map((e) => ({
      tier: e.tier,
      price: e.price,
      partner: names[e.orgId] || null,
      guaranteeMonths: e.guaranteeMonths,
      afterPrice: e.afterPrice,
      afterLine: e.afterLine,
      equipment: e.equipment,
      rentalMonthly: e.rentalMonthly,
      technology: e.technology,
      uploadMbps: e.uploadMbps,
      /* The named parts of the reduction on this tier, in the cents the seal
         recorded. Labels and money only: a household reads what a step is
         called and what it is worth, never the share arithmetic behind it,
         and never a figure this route worked out for itself. */
      mix: e.mix,
      reference: e.reference,
      /* Installs per week this partner runs here, and the weeks inside the
         booking window already at that pace, as Monday 00:00 UTC stamps.
         Null and empty when the partner has not stated a pace yet. */
      capacityWeekly: pace[e.orgId] ? pace[e.orgId].capacityWeekly : null,
      fullWeeks: pace[e.orgId] ? pace[e.orgId].fullWeeks : [],
    }));

    /* THE HOUSEHOLD'S WINDOW, RECORDED. Which three entries of the book this
       household is shown depends on the speed on its bill and its preference
       chip, both read here, on the server, and the answer is written once to
       `household_offers` (lib/offers.js) so a bill edited after the decision
       cannot re-centre the cards under it. The cards carry the seal's price
       strings; the facts beside them (guarantee, equipment, partner name) are
       the book entry's, looked up by tier. */
    const speed = await billSpeed(req.catalyst, user.user_id);
    const pref = await preferredChip(req.catalyst, user.user_id);
    const offered = await offers.materialise(req.catalyst, campaign, user.user_id, book,
      { speed, pref }, now);
    const byTier = {};
    wire.forEach((e) => { byTier[e.tier] = e; });
    const cards = offered.cards.map((c) => {
      if (c.position === 'none' || !c.tier) return { tier: null, position: 'none' };
      const e = byTier[c.tier] || {};
      return Object.assign({}, e, {
        tier: c.tier,
        price: c.price,
        partner: names[c.orgId] || e.partner || null,
        position: c.position,
      });
    });

    /* `offer` is the card the window centres on, and it stays on the wire so
       every panel that reads a single offer keeps working while the cards are
       ported. */
    const centre = cards.filter((c) => c.position === 'current')[0]
      || centreEntry(wire, pref === 'up' ? '1 Gig' : null);

    let yourOrder = null;
    try {
      const row = await orders.findAnyByKey(req.catalyst, `${campaign.id}:${user.user_id}`.slice(0, 200));
      if (row) {
        yourOrder = {
          orderNo: row.order_no || null,
          state: row.state || 'acc',
          tier: row.tier || null,
          price: row.price || null,
          slotAt: ms(row.slot_at),
        };
      }
    } catch {
      yourOrder = null;
    }

    res.status(200).json({
      ok: true,
      serverTime: now,
      sealed: false,
      live: true,
      closesAt,
      bidCount: rows.length,
      decisionAt: (campaign.dates && campaign.dates.decision_at) || null,
      book: wire,
      offers: {
        cards,
        centre: offered.centre,
        nearest: offered.nearest,
        rule: offered.rule,
        recorded: Boolean(offered.recorded),
        offeredAt: offered.offeredAt || null,
      },
      yourOrder,
      offer: centre ? {
        partner: centre.partner,
        price: centre.price,
        speed: centre.tier,
        technology: centre.technology,
        guaranteeMonths: centre.guaranteeMonths,
        afterLine: centre.afterLine,
        equipment: centre.equipment,
        rentalMonthly: centre.rentalMonthly,
        reference: centre.reference,
        /* The shape the dashboard's applyOffer() already reads: a per-tier
           list it looks up by tier name. One entry, because an offer is now
           one tier of the book rather than a whole bid. */
        mix: centre.mix ? [{
          tier: centre.tier,
          reductionCents: centre.mix.reductionCents,
          mix: centre.mix.rows,
        }] : null,
      } : null,
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
    const book = await awards.sealBook(req.catalyst, campaign, bidRows, now);
    if (!book || !book.length) {
      throw new AppError('CONFLICT', 'There is no offer on this cohort yet.', {
        logDetail: `accept with no book campaign=${campaign.id}`,
      });
    }

    /* WHICH TIER, AND THEREFORE WHICH PARTNER. The household accepted one
       entry of the book, and a cohort's tiers can belong to different
       partners, so the tier is what decides who delivers this install. Read
       from the SEALED BOOK and never from the request: the body names a
       speed, and the server answers who won it and at what price. A body that
       named an org, or a price, would be a household setting both.

       The tier is required. Defaulting to the cheapest is what the single
       award used to do implicitly, and it would send a household that chose 1
       Gig to whoever happened to win 100 Mbps. */
    const wanted = String((req.body || {}).tier || '').trim();
    if (!wanted) {
      throw badRequest('Choose which speed you are accepting.');
    }
    const entry = awards.entryFor(book, wanted);
    if (!entry) {
      throw badRequest('That speed is not one of the offers on this cohort.', {
        logDetail: `accept unknown tier=${wanted.slice(0, 40)} campaign=${campaign.id}`,
      });
    }

    if ((req.body || {}).consent !== true) {
      throw badRequest('Confirm you are happy for your address to go to the winning partner for this install.');
    }
    const address = orders.readAddress((req.body || {}).address);
    const fsa = orders.readFsa((req.body || {}).fsa || mine.fsa);

    /* THE APPOINTMENT IS PART OF THE ACCEPT. The household picks an install
       day inside the next fifteen days and an arrival window, and gives the
       mobile number the crew calls on the day. All three are required: an
       accept that books nothing is a household waiting on a phone call that
       the old flow admitted "most of them" needed. The order lands on the
       partner's board already booked. */
    /* CONFIRMATIONS LOCK AT decision_at. After it a household neither takes
       a card nor changes one: the partners are planning installs against the
       list as it stood. Checked BEFORE the body is read, so a client that
       predates the booking step is told the true reason and not that a
       phone number is missing. */
    const decisionAt = (campaign.dates && campaign.dates.decision_at) || null;
    if (decisionAt && now >= decisionAt) {
      throw new AppError('DECISIONS_LOCKED', 'Confirmations have locked on this cohort. Your installer books from here.', {
        logDetail: `accept after decision_at campaign=${campaign.id}`,
        extra: { serverTime: now, decisionAt },
      });
    }

    const phone = orders.readPhone((req.body || {}).phone);
    const slotWindow = orders.readSlotWindow((req.body || {}).slotWindow);
    const slotAt = orders.readBookingSlot((req.body || {}).slotAt, now);

    /* THE CARD MUST BE ONE THE HOUSEHOLD WAS SHOWN. The recorded window is
       the record of the offer; a tier outside it was never this household's
       offer, whatever the book holds. Materialised here as well as on the
       read, so an accept that arrives before any read (a second device, a
       retry after the table was created) is held to the same three cards
       the read would have recorded. An unreadable table computes the same
       window and holds the accept to it, unrecorded. */
    const shown = await offers.materialise(req.catalyst, campaign, user.user_id, book, {
      speed: await billSpeed(req.catalyst, user.user_id),
      pref: await preferredChip(req.catalyst, user.user_id),
    }, now);
    if (!(shown.cards || []).some((c) => c.tier === entry.tier)) {
      throw badRequest('That speed is not one of the cards you were shown.', {
        logDetail: `accept off-window tier=${entry.tier} campaign=${campaign.id}`,
      });
    }

    const existing = await orders.findAnyByKey(req.catalyst, key);

    /* A RELEASED ORDER IS NOT RE-ACCEPTED HERE. 'rel' is terminal: a partner
       that could not serve the address, or the household's own pass, ended
       this order, and a second one on the same key would be a household the
       board had already been told was gone. Said plainly rather than
       answered as a booking that no partner will ever see. */
    if (existing && existing.state === 'rel') {
      throw new AppError('CONFLICT', existing.release_reason === 'household_passed'
        ? 'You passed on this cohort, and that stands. Your concierge can help if that was a mistake.'
        : 'This order was released by the partner and cannot be re-taken here. Your concierge can help.', {
        logDetail: `accept on released order key=${key} reason=${existing.release_reason || ''}`,
      });
    }
    const repick = Boolean(existing && (existing.tier || null) !== entry.tier);

    /* THE PARTNER'S STATED PACE IS A REAL LIMIT. Checked for a first accept
       and for any change of pick, against the day the household is booking
       NOW and without the household's own row: a retried accept of the same
       card already holds its slot, and refusing the retry because its own
       booking filled the week would be the idempotency promise broken from
       the other side. */
    if (!existing || repick) {
      const award = await awards.findForOrg(req.catalyst, campaign.id, entry.orgId);
      const cap = award ? parseInt(award.install_capacity_weekly, 10) : null;
      if (cap > 0) {
        const held = (await orders.rowsForCampaign(req.catalyst, entry.orgId, campaign.id) || [])
          .filter((r) => r.order_key !== key);
        if (orders.bookedInWeek(held, slotAt) >= cap) {
          throw new AppError('CONFLICT',
            'That week is full with this partner. Pick a day in another week.', {
              logDetail: `accept slot in full week campaign=${campaign.id} org=${entry.orgId}`,
            });
        }
      }
    }

    /* THE LAST GATE, AND IT IS THE SEAT LEDGER, NOT THE SNAPSHOT ROW.
     *
     * The membership read at the top of this route is many Data Store calls
     * old by now: the sealed book, the recorded window and the capacity check
     * all happen between. A household that passed in another tab in that
     * interval would land an accepted order under a released claim, and the
     * partner's board would carry a line for a household the ledger says is
     * gone. That is exactly the state the pass route's ordering exists to
     * prevent, and it prevents it in one direction only.
     *
     * So the claim is re-read HERE, immediately before the write, and the
     * accept refuses when the seat is no longer on this cohort. The pass
     * releases the claim FIRST (seats.transition), then drops the membership,
     * then releases any order, so this check sees a pass that has begun even
     * before the row this route opened on has gone.
     *
     * It is a narrowing, not a lock: Catalyst has no compare and swap, so a
     * pass that lands between this read and the create below still wins the
     * ledger and loses the order. The pass's own order release covers that
     * ordering, and what is left is the millisecond between these two calls
     * rather than the seconds this route spends above. An unreadable ledger
     * does not refuse an accept: seats.getClaim throws, and a household must
     * not lose an offer to a table outage.
     */
    try {
      const held = seats.publicClaim(
        await seats.getClaim(req.catalyst, seats.addressIdFor(user), seats.VERTICAL_DEFAULT));
      if (held && held.status !== 'active') {
        throw new AppError('CONFLICT',
          'You left this cohort while this page was open, so the offer is closed. Nothing is owed.', {
            logDetail: `accept refused: claim released campaign=${campaign.id}`,
          });
      }
      if (held && held.cohort_id && held.cohort_id !== campaign.id) {
        throw new AppError('CONFLICT',
          'Your seat has moved to another cohort, so this offer is closed. Nothing is owed.', {
            logDetail: `accept refused: claim holds ${held.cohort_id}, accept on ${campaign.id}`,
          });
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'CONFLICT') throw err;
      /* Ledger unreadable, or no claim row at all (a household that joined
         before the ledger existed). Neither is a reason to refuse an offer. */
    }

    let row;
    let changed = null;
    if (repick) {
      /* A CHANGE OF PICK IS AN UPDATE, NEVER A SECOND ROW. The one order on
         this household moves to the new tier, price and partner by ROWID and
         is read back before anything is answered. The earlier version of this
         route answered the new tier while keeping the old row, so a household
         that moved from 500 Mbps to 1 Gig was told 1 Gig and served 500. */
      const moved = await orders.changePick(req.catalyst, existing, {
        orgId: entry.orgId, tier: entry.tier, price: entry.price,
        phone, slotAt, slotWindow, at: now,
      });
      row = moved.row;
      changed = moved.before;
    } else {
      row = await orders.create(req.catalyst, {
        campaignId: campaign.id,
        orgId: entry.orgId,
        memberUserId: user.user_id,
        fsa,
        address,
        phone,
        slotAt,
        slotWindow,
        tier: entry.tier,
        /* The book price at acceptance, frozen on the order. What the household
           was shown is what the statement has to bill against, and re-deriving
           it later from a book that an admin may since have corrected is how
           the two drift apart. */
        price: entry.price,
        at: now,
      });
      orders.invalidateConfirmed(campaign.id, entry.orgId);
    }

    audit.recordAsync(req.catalyst, req, {
      type: changed ? 'offer.repick' : 'offer.accept',
      outcome: 'success',
      userId: user.user_id,
      detail: changed
        ? `cohort=${campaign.id} from_org=${changed.orgId} from_tier=${changed.tier} org=${entry.orgId} tier=${entry.tier}`
        : `cohort=${campaign.id} org=${entry.orgId} tier=${entry.tier} slot=${slotAt} window=${slotWindow}`,
    });

    res.status(200).json({
      ok: true,
      serverTime: now,
      accepted: true,
      orderNo: (row && row.order_no) || null,
      /* The row's own state and slot, which on a retried accept are the ones
         the first accept booked, not the ones this body asked for. */
      state: (row && row.state) || 'acc',
      slotAt: row ? ms(row.slot_at) : null,
      /* Echoed so the confirmation screen names the speed and the partner the
         server actually recorded, rather than the ones the client believed it
         had chosen. */
      tier: entry.tier,
      price: entry.price,
      partner: (await partnerName(req.catalyst, entry.orgId)),
      /* Said plainly, because it is the thing households ask: accepting is not
         a charge, and the install is booked. */
      note: 'Accepted and booked. Nothing is charged for switching, and your installer has your day, your address and your number.',
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

    /* WHERE THIS HOUSEHOLD LIVES DECIDES WHICH COHORT IT MAY JOIN, and the
       decision is made here, from the member row and the campaign row, at the
       instant of the write. The dashboard is told the same answer on the read
       so it can render the right card; nothing in the body is consulted, so a
       request claiming eligibility gets exactly the refusal an honest one
       would. One guard, both doors: routes/seat.js calls the same function.

       `mine` first, because a household already standing in this cohort keeps
       its place when an operator edits the FSA set out from under it. The
       seat's own fsa_at_join snapshot (campaign_members.fsa) is the record of
       what was true when it joined. */
    const standing = await mineOn(req.catalyst, campaign, user.user_id);
    guards.requireEligible(campaign, user, Date.now(), { mine: standing });

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

    const reply = await memberReply(req.catalyst, campaign, { status }, user.fsa);
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

    const reply = await memberReply(req.catalyst, campaign, undefined, user.fsa);
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

    const reply = await memberReply(req.catalyst, campaign, { status }, user.fsa);
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
    /* A partner opening the desk sweeps too. The letters go to households, not
       to partners: this is simply the other surface that already knows every
       cohort's stage, and a cohort whose members are asleep still moves. */
    notices.sweepAsync(req.catalyst, cfg, states, now);
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
