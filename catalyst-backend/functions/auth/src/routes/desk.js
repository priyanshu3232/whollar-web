'use strict';

/**
 * The partner console's write surface: the org's own facts, its team, its
 * sealed bids, and the coverage it claims.
 *
 *   POST /provider/org                        rename the organisation (org admins only)
 *   GET  /provider/team                       who is attached to this org, and how
 *   GET  /provider/campaigns/:id/brief        one cohort's brief: aggregates only
 *   GET  /provider/bids                       the org's live sealed bids
 *   POST /provider/bids                       place a sealed bid (place only, never an upsert)
 *   POST /provider/bids/:campaign/improve     seal a new revision, better on every tier
 *   GET  /provider/bids/:campaign             the org's own bid on one cohort
 *   GET  /provider/bids/:campaign/versions    the org's own sealed revision trail
 *   GET  /provider/coverage                   regions the org serves
 *   POST /provider/coverage                   update a region's services / declare a new one
 *
 * Approval gates the competitive surfaces. Renaming your own org and listing
 * your own team only require being in it; placing a bid or editing coverage
 * requires the org to be approved, because those are the actions that touch
 * cohorts.
 *
 * Bids additionally pass requireBiddingOpen(), the single gate campaigns.js
 * exports for exactly this route's benefit: the global kill switch and the
 * per-campaign window are checked in one place, here included. The bid rules
 * themselves (validation, the append-only revision record, sealed-ness) live
 * in lib/bids.js; its header is the contract.
 *
 * They also pass lib/terms.js requireAccepted(): one agreement covers every
 * auction, so a bid from an org that has not accepted the version in force is
 * refused here as well as hidden in the console. A published version bump
 * pauses every org that has not accepted the new one.
 */

const datastore = require('../lib/datastore');
const orgs = require('../lib/orgs');
const users = require('../lib/users');
const catalog = require('../lib/catalog');
const siteconfig = require('../lib/siteconfig');
const audit = require('../lib/audit');
const crm = require('../lib/crmqueue');
const envelope = require('../lib/envelope');
const bids = require('../lib/bids');
const events = require('../lib/notify/events');
const awards = require('../lib/awards');
const orders = require('../lib/orders');
const terms = require('../lib/terms');
const places = require('../lib/places');
const cohorts = require('../lib/cohorts');
const { requireBiddingOpen } = require('./campaigns');
const rosters = require('../lib/rosters');
const { requirePartner: guardPartner, requireApproved } = require('../lib/guards');
const { wrap, badRequest, forbidden, AppError } = require('../lib/errors');
const application = require('./application');

const BIDS = bids.BIDS;
const COVERAGE = 'provider_coverage';

const TECHS = new Set(['cable', 'fibre', 'fwa', 'dsl']);

/* The guards moved to lib/guards.js when the partner console added five more
   route files that need the same three checks. Behaviour is unchanged, with
   one exception noted there: the "still under review" message lost an em dash,
   which the house style forbids in anything a partner reads. */
const requirePartner = (req) => guardPartner(req, 'a /provider desk route');

/**
 * Write a head row with the brand columns, and without them if the table has
 * not got them yet.
 *
 * `provider_bids.brand_id` and the roster tables are separate schema objects
 * created by hand, so either can exist without the other. A partner whose
 * roster is live can therefore name a valid brand on a table with no column to
 * put it in, and an insert naming an unknown column is refused outright. One
 * retry without the two columns keeps the bid landing: the brand is then
 * recovered for exclusion matching from the org's primary declared brand, the
 * same fallback every bid sealed before the column uses.
 */
async function writeHead(write, row, brandCols) {
  if (!brandCols) return write(row);
  try {
    return await write(Object.assign({}, row, brandCols));
  } catch (err) {
    try {
      return await write(row);
    } catch {
      throw err;
    }
  }
}

/**
 * The brand a bid is made under, validated, or null when this deployment has
 * no roster tables yet.
 *
 *   -> { brandId, providerId, viaDistributorId } | null
 *
 * SECTION 5.5 AND 6.3, AND THE ONE GATE FOR BOTH. `rosters.canBidAs` refuses a
 * brand that is not active, not on the submitting org's attested roster, or,
 * for a distributor submission, whose provider is not on the distributor's
 * attested serving map. It throws the section 13 copy; nothing here softens it.
 *
 * A BID THAT NAMES NO BRAND IS STILL ACCEPTED, and that is deliberate rather
 * than lax. The brand column and the roster tables are created by hand and
 * this code deploys separately from them, so requiring a brand today would
 * close the live auction until an operator finished a schema change. A
 * brandless bid is attributed to its org's primary declared brand by
 * lib/awards.js, so a member's exclusion still bites on it. Once every partner
 * has attested a roster, `requireBrandOnBids` in create-tables.md section 34e
 * is the flip to make this mandatory.
 */
async function brandForBid(req, context, body) {
  const named = String((body || {}).brand_id || '').trim();
  const via = String((body || {}).submitted_via_distributor_id || '').trim() || null;
  if (!named) {
    if (via) {
      throw badRequest('Name the brand this bid is made under.', {
        logDetail: 'distributor submission with no brand_id',
      });
    }
    return null;
  }
  return rosters.canBidAs(req.catalyst, {
    orgId: context.orgId, brandId: named, distributorId: via,
  });
}

const str = (v, max) => {
  const s = String(v == null ? '' : v).trim().slice(0, max);
  return s || null;
};

/** 'London East' -> 'london-east'; the region half of coverage_key. */
const slug = (region) =>
  String(region || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Auctions only reach a desk from inside declared, verified coverage, and a
 * bid write proves it server side whatever the desk rendered. Two refusals,
 * because they ask for different acts: an undeclared region needs a
 * declaration, a declared one needs to wait for the operator.
 */
async function requireActiveCoverage(catalystApp, orgId, campaign) {
  const rows = await coverageRows(catalystApp, orgId);
  const row = (rows || []).find((r) => slug(r.region) === slug(campaign.region));
  if (!row) {
    throw new AppError('CONFLICT',
      `Declare ${campaign.region} coverage before bidding here. Auctions reach your desk from inside declared, verified coverage.`, {
        logDetail: 'bid refused: region not declared',
      });
  }
  if (row.status !== 'active') {
    throw new AppError('CONFLICT',
      `Your ${campaign.region} coverage has not verified yet. Bids open the moment it does.`, {
        logDetail: `bid refused: coverage status=${row.status}`,
      });
  }
}

/**
 * The cohort's current household figure, for the commitment cap. The SAME
 * cohorts.seatCount() the desk list and the member dashboard read, so the
 * cap is validated against the number the partner is looking at, and no seed
 * baseline: a cap against invented households would be a promise to nobody.
 */
async function householdCount(catalystApp, campaign) {
  // INV-3: this cohort's count comes from this cohort's rows alone, so
  // another campaign's volume can never shrink the cap being validated.
  return (await cohorts.seatCount(catalystApp, campaign)).seats;
}

/**
 * The head-row fields one sealing writes. Shared by place and improve.
 *
 * `discount_mix` is named only when there is one to write, or when the head
 * being improved carried one that this revision drops. The column is created
 * by hand (create-tables.md section 28), and naming it on every write would
 * make every bid, custom or not, fail until it exists; naming it only on a
 * custom bid confines that window to the bids that need it.
 */
function headFields(draft, sealed, payloadHash, receivedAt, head) {
  const mixField = draft.discountMix
    ? { discount_mix: JSON.stringify(draft.discountMix) }
    : (head && head.discount_mix ? { discount_mix: null } : {});
  return {
    ...mixField,
    /* The lowest tier's effective price doubles as the legacy headline
       `price`, so readers of the original flat shape keep working. */
    price: draft.tiers[0].effectivePrice,
    tiers: JSON.stringify(draft.tiers),
    guarantee_months: draft.guaranteeMonths,
    after_mode: draft.afterMode,
    after_line: draft.afterLine,
    equipment: draft.equipment,
    rental_monthly: draft.rentalMonthly,
    extra_pod_monthly: draft.extraPodMonthly,
    reduction_presentation: draft.reductionPresentation,
    mechanism_label: draft.mechanismLabel,
    commitment_cap: draft.committedHouseholds,
    revision_count: sealed.revisionNo,
    receipt_no: sealed.receipt,
    payload_hash: payloadHash,
    last_revised_at: datastore.toDb(new Date(receivedAt)),
    updated_at: datastore.nowDb(),
  };
}

function publicCoverage(row) {
  return {
    region: row.region,
    techs: row.techs ? row.techs.split(',') : [],
    speed: row.speed || null,
    lead: row.lead || null,
    status: row.status,
    /* A refused region MUST say why. "Not serviceable" with no reason leaves a
       partner with nothing to act on, and the reason is an enum server side
       because it feeds the serviceability figure on the performance page. */
    rejectionReason: row.rejection_reason || null,
    verifiedAt: row.verified_at || null,
    updatedAt: row.updated_at || null,
  };
}

const COVERAGE_COLS = ['coverage_key', 'org_id', 'region', 'techs', 'speed', 'lead', 'status', 'updated_at'];
const COVERAGE_COLS_V2 = COVERAGE_COLS.concat(['rejection_reason', 'verified_at']);

/**
 * Every coverage row for an org, or null when the table is not provisioned.
 *
 * TWO COLUMN LISTS, on purpose. Tables here are created BY HAND (there is no
 * DDL API), so code and schema deploy separately and in either order. Asking
 * for a column that does not exist yet throws, and the catch below would then
 * report the whole table as unreadable: a partner would see "we could not read
 * your coverage" for every region they own, because of two columns that only
 * matter to one of them. So the extended list is tried first and the original
 * is the fallback.
 */
async function coverageRows(catalystApp, orgId) {
  const where = `org_id = ${datastore.lit(orgId)}`;
  try {
    return await datastore.queryAll(catalystApp, COVERAGE, COVERAGE_COLS_V2, where);
  } catch {
    try {
      return await datastore.queryAll(catalystApp, COVERAGE, COVERAGE_COLS, where);
    } catch {
      return null;
    }
  }
}

function mount(router) {
  /**
   * Rename the organisation. Org admins only: the legal name is what the
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
    crm.enqueueAsync(req.catalyst, req, {
      source: crm.SOURCES.PARTNER_ORG,
      rowId: org.org_id,
      email: user.email_display || user.email_normalized,
      leadType: 'partner',
      data: { org_id: org.org_id, org_name: legalName, previous_name: org.legal_name || null },
    });

    res.status(200).json({ ok: true, org: { ...context, orgName: legalName } });
  }));

  /**
   * Who is attached to this org. Names and roles only, for the org's own
   * members: this is the one place a partner sees another person's name, and
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
      // An org created from a personal address has no such rule, and saying it
      // does would be a promise that nobody else can ever join. `joinByDomain`
      // is what the console branches on; emailDomain stays null there rather
      // than leaking the owner's address back as if it were a company domain.
      ...(await (async () => {
        const org = await orgs.findById(req.catalyst, context.orgId);
        const key = org?.email_domain || null;
        const personal = orgs.isPersonalOrgKey(key);
        return { emailDomain: personal ? null : key, joinByDomain: !!key && !personal };
      })()),
    });
  }));

  /**
   * One cohort's brief: aggregates only. Household count, renewal window, the
   * demand mixes when ops has recorded them, the success fee from config, the
   * org's OWN coverage line for the region, and the org's OWN bid. No
   * identities, no other partner's bid, no bid count, and nothing invented:
   * a mix that has not been recorded arrives null and renders as "to come".
   *
   * requirePartner only, no approval gate: an unapproved org may read
   * aggregates, and the brief is where a pending partner learns what a cohort
   * is. An unknown or archived id is a 404 indistinguishable from
   * never-existed.
   */
  router.get('/provider/campaigns/:id/brief', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const id = String(req.params.id || '').trim();
    const cat = await catalog.load(req.catalyst);
    const campaign = catalog.ID_RE.test(id) ? cat.byId.get(id) : null;
    if (!campaign || campaign.kind === 'archived') {
      throw new AppError('NOT_FOUND', 'That cohort does not exist.', {
        logDetail: 'brief on unknown or archived campaign',
      });
    }

    const enabled = await siteconfig.getValue(req.catalyst, 'bidding_enabled') !== false;
    /* One clock reading for stage and serverTime, the same rule
       /provider/campaigns follows: the stage was computed at the instant the
       console will offset from. Same read layer as the desk list, so the
       brief and the list can never disagree about what a cohort looks like. */
    const now = Date.now();
    const pub = cohorts.forPartner(
      cohorts.state(campaign, await cohorts.seatCount(req.catalyst, campaign), now), enabled);

    /* brief_json rides on the campaigns row but is read here, NOT via
       catalog.COLUMNS: catalog falls back to the code catalog whenever its
       query throws, so naming a column there before the operator has created
       it by hand would knock the whole site back to seed data. A separate
       one-row read degrades to "no mixes yet" instead. */
    let mix = null;
    try {
      const row = await datastore.findBy(req.catalyst, catalog.TABLE, 'campaign_id', id,
        ['campaign_id', 'brief_json']);
      if (row && row.brief_json) mix = JSON.parse(row.brief_json);
    } catch { mix = null; }
    mix = mix || {};

    const fee = await siteconfig.getValue(req.catalyst, 'success_fee');

    /* The measured profile: households at each speed tier, from the speed on
       their bills, said only past the privacy floor (lib/cohorts.js). Takes
       precedence over the hand-pasted brief_json mix in the console because
       it is counted, and the other is estimated. */
    const demand = await cohorts.speedDemand(req.catalyst, campaign);

    const covRows = await coverageRows(req.catalyst, context.orgId);
    const covRow = (covRows || []).find((r) => slug(r.region) === slug(campaign.region));
    const head = await bids.headRow(req.catalyst, `${campaign.id}:${context.orgId}`);

    res.status(200).json({
      ok: true,
      serverTime: now,
      campaign: pub,
      brief: {
        households: pub.households,
        renewalWindow: mix.renewalWindow || null,
        speedMix: Array.isArray(mix.speedMix) ? mix.speedMix : null,
        /* [[tier, households], ...] in ladder order, or null under the floor. */
        speedDemand: demand.tiers,
        speedDemandKnown: demand.known,
        speedDemandOther: demand.other,
        speedDemandLive: demand.live,
        plantMix: Array.isArray(mix.plantMix) ? mix.plantMix : null,
        successFee: fee != null ? String(fee) : null,
      },
      coverage: covRow
        ? Object.assign({ declared: true }, publicCoverage(covRow))
        : { declared: false, status: null },
      bid: head ? bids.publicBid(head) : null,
    });
  }));

  /**
   * The org's live sealed bids. -> { ok, serverTime, live, bids }
   *
   * A RESULT IS A JOIN, NOT A COLUMN. `provider_bids.status` says what the
   * partner did (sealed, improved), and nothing writes a result into it: the
   * result lives in `campaign_awards`, one row per cohort, and it is read here
   * rather than copied. Copying it would need a job to run at every close, and
   * a job that misses one leaves a partner looking at a bid that says 'sealed'
   * three weeks after the cohort was won by somebody else.
   *
   * An award on a cohort this org did not win is 'not_selected' and carries
   * nothing else. No winning org, no winning price, no margin: a partner
   * learns that it lost, which is its own business, and not one fact about
   * whoever won.
   */
  router.get('/provider/bids', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const rows = await bids.bidRows(req.catalyst, context.orgId);
    /* Sealing on read, here as well as on the household's side: a partner
       whose cohort closed while nobody happened to open the member offer page
       would otherwise sit on a bid marked 'sealed' long after it was decided.
       Only closed cohorts are touched, and the seal is idempotent. */
    /* { list, byId, source }, never an array. */
    const cat = await catalog.load(req.catalyst);

    /* AWARD FIRST, BID ROWS ONLY IF THERE IS NO AWARD. The Data Store is
       metered per fetch, and the first version of this read the whole
       campaign's bid table on every boot for every closed cohort this org had
       ever bid on, only to hand the rows to a seal that had nothing left to
       do. Once a cohort is awarded the answer never changes, so the cheap
       lookup is the one that runs every time and the expensive one runs once
       in the life of the cohort. */
    const decided = {};
    const confirmed = {};
    for (const id of new Set((rows || []).map((r) => r.campaign_id))) {
      const campaign = cat.byId.get(id);
      if (!campaign || !awards.isClosed(campaign)) continue;
      /* eslint-disable no-await-in-loop */
      /* Sealed-bid privacy: the all-orgs read stays inside lib/awards.js, so
         no competitor's row ever enters this partner-scoped request. The
         award-first economy this loop used to spell out lives there now, and
         so does the distinction between "you won nothing" and "nothing has
         been decided yet", which a bare award row cannot express. */
      const result = await awards.resultForOrg(req.catalyst, campaign, context.orgId);
      if (result.decided) {
        decided[id] = result;
        if (result.tiersWon.length) {
          confirmed[id] = await orders.confirmedCount(req.catalyst, id, context.orgId);
        }
        /* THE RESULT LETTERS, ON READ.
         *
         * Sealing happens on read in this codebase because there is no cron
         * (lib/awards.js says so at the top), and the letter follows the seal
         * for the same reason. The outbox key is per (campaign, org, tier), so
         * every subsequent board load enqueues nothing: the deduplication is
         * the table's, not a flag anybody has to remember to set.
         *
         * SCOPED TO THIS ORG. `result` is already this partner's own result
         * and the only tier fact allowed across a /provider route. Emitting
         * for every org from one partner's request would be cheap and would
         * mean a partner's request reading every other partner's outcome,
         * which is the thing the whole file is careful about.
         *
         * The gap this leaves: a partner who never opens the console never
         * hears. That is the same gap every read-triggered path here has, and
         * POST /admin/notify/drain plus a scheduled trigger is what closes it.
         */
        const bidTiers = (bids.publicBid(rows.find((r) => r.campaign_id === id) || {}).tiers || [])
          .map((t) => t.name).filter(Boolean);
        const won = new Set(result.tiersWon);
        for (const tier of result.tiersWon) {
          await events.tierAwarded(req, {
            campaign, orgId: context.orgId, tier,
            householdCount: confirmed[id] || null,
          });
        }
        for (const tier of bidTiers) {
          if (won.has(tier)) continue;
          await events.tierNotAwarded(req, { campaign, orgId: context.orgId, tier });
        }
      }
      /* eslint-enable no-await-in-loop */
    }
    envelope.ok(res, {
      live: rows !== null,
      bids: (rows || []).map((row) => {
        const pub = bids.publicBid(row);
        const result = decided[row.campaign_id];
        if (result) {
          /* A COHORT IS NOW WON TIER BY TIER, so winning is a list and not a
             flag: this bid may have taken 100 Mbps and lost 1 Gig on the same
             cohort. `tiersWon` is this partner's own result and the ONLY tier
             fact that crosses to a /provider route. Never the book, never
             another partner's price or tier, not even as a redacted row: a
             partner that could see which tiers it lost would learn exactly
             where a competitor undercut it. */
          pub.state = result.tiersWon.length ? 'won' : 'not_selected';
          pub.tiersWon = result.tiersWon;
          /* This partner's own result, tier by tier: its price, how many bid
             that speed, how many households sat there, and how many have
             confirmed it so far. Every figure is about this org alone; the
             count is a memoized read of this org's own orders on this cohort
             (lib/orders.js confirmedCount), never a stored counter. */
          if (result.tiersWon.length) {
            const count = confirmed[row.campaign_id] || { confirmed: 0, byTier: {}, live: false };
            /* A legacy award with no book row has tiers and no entries: the
               table still lists them, with the count and no price. */
            const entries = result.wonEntries.length
              ? result.wonEntries
              : result.tiersWon.map((t) => ({ tier: t, price: null, demandCount: null }));
            pub.won = entries.map((e) => ({
              tier: e.tier,
              price: e.price,
              demandCount: e.demandCount,
              confirmed: count.byTier[e.tier] || 0,
            }));
            pub.confirmed = count.confirmed;
            pub.confirmedLive = count.live;
          }
        }
        return pub;
      }),
    });
  }));

  /**
   * Place a sealed bid. PLACE ONLY: improving is its own act on its own route,
   * because "place or improve" as one upsert is how a retried request silently
   * rewrites a sealed record. One live bid per (campaign, org); the first
   * sealing writes revision 1.
   */
  router.post('/provider/bids', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);
    if (context.role === 'viewer') {
      throw forbidden('Your seat can view the desk but not place bids. Ask your organisation’s admin.', {
        logDetail: 'viewer tried to place a bid',
      });
    }

    const body = req.body || {};
    /* One clock reading for the gate, the audit row and server_received_at,
       so the record and the decision cannot disagree. Captured before the
       catalog read: the moment of receipt is the moment that counts. */
    const receivedAt = Date.now();
    /* A bid write earns one uncached catalog read. The memo is 60 seconds,
       and a stale close date is wrong in exactly the minute it matters. */
    const cat = await catalog.load(req.catalyst, { fresh: true });
    const campaign = cat.byId.get(String(body.campaign || '').trim());
    if (!campaign) throw badRequest('That campaign does not exist.');

    await requireBiddingOpen(req.catalyst, campaign);
    await requireActiveCoverage(req.catalyst, context.orgId, campaign);
    /* One agreement covers every auction, which is the only reason two bids on
       one cohort are comparable line by line. lib/terms.js is the gate and its
       header is the contract; it is checked here whatever the console
       rendered, and again on improve below. */
    await terms.requireAccepted(req.catalyst, context.orgId);

    const draft = bids.readBid(body, await householdCount(req.catalyst, campaign));
    /* Which brand this bid is made under, checked against the attested roster
       before anything is sealed. A refusal here must land before the revision
       write, because a revision is append-only and a bid sealed under a brand
       the partner cannot claim has no clean way back out. */
    const brand = await brandForBid(req, context, body);

    const key = `${campaign.id}:${context.orgId}`;
    if (await bids.headRow(req.catalyst, key)) {
      throw new AppError('CONFLICT',
        'You already hold a sealed bid on this cohort. Improve it instead; bids are never withdrawn.', {
          logDetail: 'place on an existing bid_key',
        });
    }

    const payload = bids.draftPayload(campaign.id, draft);
    const payloadHash = bids.hashPayload(payload);

    let sealed;
    try {
      sealed = await bids.sealRevision(req.catalyst, {
        bidKey: key, campaignId: campaign.id, orgId: context.orgId,
        userId: user.user_id, payload, payloadHash, receivedAt,
      });
    } catch (err) {
      if (err.conflict) {
        throw new AppError('CONFLICT',
          'Your desk was behind this bid. Reload and improve from the latest version.', {
            logDetail: 'revision race lost on place',
          });
      }
      throw new AppError('SERVER_ERROR',
        'Bidding is not available right now. Please try again shortly.', {
          logDetail: `bid_revisions write failed: ${err.message}`,
        });
    }

    const fields = headFields(draft, sealed, payloadHash, receivedAt);
    try {
      await writeHead(
        (row) => datastore.insertRow(req.catalyst, BIDS, row),
        {
          bid_key: key,
          campaign_id: campaign.id,
          org_id: context.orgId,
          user_id: user.user_id,
          status: 'sealed',
          submitted_at: datastore.toDb(new Date(receivedAt)),
          ...fields,
        },
        brand ? {
          brand_id: brand.brandId,
          submitted_via_distributor_id: brand.viaDistributorId,
        } : null
      );
    } catch (err) {
      /* The sealed record exists; only the convenience head failed. If a
         concurrent place won the bid_key, say so; the orphan revision stays
         in the trail, which is what an append-only record means. Otherwise
         surface the failure and let the next write heal the numbering. */
      let winner = null;
      try { winner = await datastore.findBy(req.catalyst, BIDS, 'bid_key', key, ['ROWID']); } catch { winner = null; }
      if (winner) {
        throw new AppError('CONFLICT',
          'You already hold a sealed bid on this cohort. Improve it instead; bids are never withdrawn.', {
            logDetail: 'head insert lost a concurrent place',
          });
      }
      throw new AppError('SERVER_ERROR',
        'Bidding is not available right now. Please try again shortly.', {
          logDetail: `provider_bids write failed after revision ${sealed.revisionNo}: ${String((err && err.message) || err).slice(0, 200)}`,
        });
    }

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.bid.place',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      /* No prices in the detail. The sealed record is the record. */
      detail: { org_id: context.orgId, campaign: campaign.id, revision: sealed.revisionNo, receipt: sealed.receipt },
    });
    /* NO PRICES, deliberately, and for the same reason the audit line above
       carries none: the sealed record is the record. A CRM note is read by
       more people than an audit row and lives on a surface built for sharing,
       so what it carries is that a bid exists, which cohort it is on, its
       revision and its receipt. The number stays in provider_bids, where the
       seal means something. */
    crm.enqueueAsync(req.catalyst, req, {
      source: crm.SOURCES.SEALED_BID,
      rowId: `${campaign.id}:${context.orgId}`,
      email: user.email_display || user.email_normalized,
      leadType: 'partner',
      data: { event: 'sealed', org_id: context.orgId, org_name: context.orgName || null,
        cohort: campaign.id, region: campaign.region || null,
        revision: sealed.revisionNo, receipt: sealed.receipt },
    });

    /* The receipt, in writing. Their own bid and nothing else: not the number
       of bidders, not whether they are cheapest, not whether anybody else bid
       at all. A receipt that hinted at the field would make the seal
       decorative. */
    await events.bidSealed(req, {
      campaign,
      orgId: context.orgId,
      receiptNo: sealed.receipt,
      revisionNo: sealed.revisionNo,
      sealedAt: receivedAt,
      closesAt: (campaign.dates && campaign.dates.bidding_closes_at) || null,
    });

    const pb = bids.publicBid({
      campaign_id: campaign.id, status: 'sealed',
      submitted_at: datastore.toDb(new Date(receivedAt)), ...fields,
    });
    envelope.ok(res, {
      bid: pb,
      receipt: { no: sealed.receipt, revision: sealed.revisionNo, receivedAt },
    });
  }));

  /**
   * Improve the sealed bid: a new revision, at least as good on every tier.
   * The head bid must exist; an unknown campaign and a campaign the org holds
   * no bid on answer with the same 404, so a probe learns nothing.
   */
  router.post('/provider/bids/:campaign/improve', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);
    requireApproved(context);
    if (context.role === 'viewer') {
      throw forbidden('Your seat can view the desk but not place bids. Ask your organisation’s admin.', {
        logDetail: 'viewer tried to improve a bid',
      });
    }

    const receivedAt = Date.now();
    const id = String(req.params.campaign || '').trim();
    const cat = await catalog.load(req.catalyst, { fresh: true });
    const campaign = catalog.ID_RE.test(id) ? cat.byId.get(id) : null;
    const key = `${id}:${context.orgId}`;
    const head = campaign ? await bids.headRow(req.catalyst, key) : null;
    if (!campaign || !head) {
      throw new AppError('NOT_FOUND', 'You have no bid on that cohort.', {
        logDetail: campaign ? 'improve with no head bid' : 'improve on unknown campaign id',
      });
    }

    await requireBiddingOpen(req.catalyst, campaign);
    await requireActiveCoverage(req.catalyst, context.orgId, campaign);
    /* An improvement is a new sealed bid, so it passes the same terms gate as
       a first one. A version bump between placing and improving pauses both. */
    await terms.requireAccepted(req.catalyst, context.orgId);

    const draft = bids.readBid(req.body, await householdCount(req.catalyst, campaign));
    const payload = bids.draftPayload(campaign.id, draft);
    const payloadHash = bids.hashPayload(payload);

    /* A network retry of the same improvement is one revision, not two: the
       canonical payload hash is the duplicate detector, and equality returns
       the standing receipt with nothing written. */
    if (head.payload_hash && payloadHash === head.payload_hash) {
      const pb = bids.publicBid(head);
      return envelope.ok(res, {
        bid: pb,
        receipt: { no: pb.reference, revision: pb.version, receivedAt },
        duplicate: true,
      });
    }

    /* An improvement may restate the brand, and it is validated exactly as a
       place is. It may not MOVE a sealed bid to a different brand: the bid was
       compared against, and possibly excluded by, households under the brand
       it named, so changing it would retroactively change who the bid was
       from. A brand that differs from the head's is refused. */
    const brand = await brandForBid(req, context, req.body);
    if (brand && head.brand_id && head.brand_id !== brand.brandId) {
      throw badRequest('A sealed bid cannot change the brand it was made under. Place a bid under the other brand instead.', {
        logDetail: `improve tried to move brand from ${head.brand_id} to ${brand.brandId}`,
      });
    }

    const problems = bids.improvementProblems(bids.headDraft(head), draft);
    if (problems.length) {
      throw badRequest('An improvement must be at least as good on every tier: '
        + problems.join('; ') + '.');
    }

    let sealed;
    try {
      sealed = await bids.sealRevision(req.catalyst, {
        bidKey: key, campaignId: campaign.id, orgId: context.orgId,
        userId: user.user_id, payload, payloadHash, receivedAt,
      });
    } catch (err) {
      if (err.conflict) {
        throw new AppError('CONFLICT',
          'Your desk was behind this bid. Reload and improve from the latest version.', {
            logDetail: 'revision race lost on improve',
          });
      }
      throw new AppError('SERVER_ERROR',
        'Bidding is not available right now. Please try again shortly.', {
          logDetail: `bid_revisions write failed: ${err.message}`,
        });
    }

    const fields = headFields(draft, sealed, payloadHash, receivedAt, head);
    try {
      await writeHead(
        (row) => datastore.updateRow(req.catalyst, BIDS, row),
        { ROWID: head.ROWID, status: 'improved', ...fields },
        brand ? {
          brand_id: brand.brandId,
          submitted_via_distributor_id: brand.viaDistributorId,
        } : null
      );
    } catch (err) {
      throw new AppError('SERVER_ERROR',
        'Bidding is not available right now. Please try again shortly.', {
          logDetail: `provider_bids update failed after revision ${sealed.revisionNo}: ${String((err && err.message) || err).slice(0, 200)}`,
        });
    }

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.bid.improve',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { org_id: context.orgId, campaign: campaign.id, revision: sealed.revisionNo, receipt: sealed.receipt },
    });
    /* NO PRICES, deliberately, and for the same reason the audit line above
       carries none: the sealed record is the record. A CRM note is read by
       more people than an audit row and lives on a surface built for sharing,
       so what it carries is that a bid exists, which cohort it is on, its
       revision and its receipt. The number stays in provider_bids, where the
       seal means something. */
    crm.enqueueAsync(req.catalyst, req, {
      source: crm.SOURCES.SEALED_BID,
      rowId: `${campaign.id}:${context.orgId}`,
      email: user.email_display || user.email_normalized,
      leadType: 'partner',
      data: { event: 'improved', org_id: context.orgId, org_name: context.orgName || null,
        cohort: campaign.id, region: campaign.region || null,
        revision: sealed.revisionNo, receipt: sealed.receipt },
    });

    /* Same receipt letter as a first seal, and the revision number is what
       makes it a different one: the event key carries it, so every genuine
       improvement is a new letter and a retried submit is not. */
    await events.bidSealed(req, {
      campaign,
      orgId: context.orgId,
      receiptNo: sealed.receipt,
      revisionNo: sealed.revisionNo,
      sealedAt: receivedAt,
      closesAt: (campaign.dates && campaign.dates.bidding_closes_at) || null,
    });

    const pb = bids.publicBid(Object.assign({}, head, fields, {
      status: 'improved', campaign_id: campaign.id,
    }));
    envelope.ok(res, {
      bid: pb,
      receipt: { no: sealed.receipt, revision: sealed.revisionNo, receivedAt },
      improved: true,
    });
  }));

  /** The org's own bid on one cohort, or the probe-safe 404. */
  router.get('/provider/bids/:campaign', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const id = String(req.params.campaign || '').trim();
    const head = catalog.ID_RE.test(id)
      ? await bids.headRow(req.catalyst, `${id}:${context.orgId}`)
      : null;
    if (!head) {
      throw new AppError('NOT_FOUND', 'You have no bid on that cohort.', {
        logDetail: 'bid read with no head row',
      });
    }
    envelope.ok(res, { bid: bids.publicBid(head) });
  }));

  /**
   * The org's own sealed revision trail, payloads verbatim, ascending. This
   * is the receipt registry: what was sealed is returned exactly as sealed,
   * so it is provable rather than reconstructed.
   */
  router.get('/provider/bids/:campaign/versions', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const id = String(req.params.campaign || '').trim();
    if (!catalog.ID_RE.test(id)) {
      throw new AppError('NOT_FOUND', 'You have no bid on that cohort.');
    }
    let rows;
    try {
      rows = await bids.revisionRows(req.catalyst, `${id}:${context.orgId}`);
    } catch {
      throw new AppError('SERVER_ERROR', 'Bid history is not available right now. Please try again shortly.');
    }
    if (!rows.length) {
      throw new AppError('NOT_FOUND', 'You have no bid on that cohort.', {
        logDetail: 'versions read with no revisions',
      });
    }
    envelope.ok(res, {
      versions: rows.map((r) => {
        let payload = null;
        try { payload = JSON.parse(r.payload); } catch { payload = null; }
        return {
          revision: parseInt(r.revision_no, 10) || null,
          receipt: r.receipt_no,
          receivedAt: envelope.ms(r.server_received_at),
          payload,
        };
      }),
    });
  }));

  /** Regions the org serves. -> { ok, serverTime, live, coverage } */
  router.get('/provider/coverage', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const rows = await coverageRows(req.catalyst, context.orgId);
    envelope.ok(res, {
      live: rows !== null,
      coverage: (rows || []).map(publicCoverage),
    });
  }));

  /**
   * Update a region's services, or declare a new region. A declaration lands
   * as 'verifying': serviceability is confirmed by an operator, not asserted
   * by the party it advantages. Editing an existing region keeps its status.
   *
   * requirePartner and NOT requireApproved, for the same reason billing takes
   * a card and contracts takes the standard terms before approval: declaring
   * coverage is the FIRST step of the application, not a privilege of having
   * finished it. The console's own checklist counts it as step one and the
   * review card tells an applicant serviceability starts the moment their
   * coverage lands, so gating the write here refused the one act the screen
   * was asking for, with a 403 the browser reported as a failed load.
   *
   * Nothing leaks by allowing it. A declaration lands 'verifying' whoever
   * makes it, only an operator moves a region to 'active', and a cohort
   * reaches a desk only through an active region on an approved org. An
   * unapproved partner is declaring where they would serve, which is exactly
   * what the reviewer needs in order to decide.
   */
  router.post('/provider/coverage', wrap(async (req, res) => {
    const { user, context } = await requirePartner(req);

    const body = req.body || {};
    const raw = str(body.region, 100);
    if (!raw) throw badRequest('Name the region.');
    /**
     * The picker constrains this in the browser; the server has to constrain it
     * too, because the browser is not the only caller and free text here is the
     * bug the picker was built to end. A region nobody else spells the same way
     * is a region no cohort ever matches: requireActiveCoverage() above compares
     * slug(row.region) to slug(campaign.region) exactly.
     *
     * KNOWN, not launched. A partner may declare into a queued city; an
     * operator leaves that row 'soon' rather than verifying it. What must not
     * happen is a row naming a place that is in no list at all.
     */
    if (!places.isRegion(raw)) {
      const near = places.suggest(raw);
      throw badRequest(
        `We do not have a region called "${raw}", so no cohort could ever match it.`
        + (near.length ? ` Did you mean ${near.join(', ')}?` : '')
        + ' Pick the region from the list rather than typing it.',
        { logDetail: `coverage region outside vocabulary: ${raw}` }
      );
    }
    /* Stored canonically, so two seats declaring the same place in different
       casing are one coverage row and not two. */
    const region = places.canonical(raw);
    const regionSlug = slug(region);
    if (!regionSlug) throw badRequest('Name the region.');

    const techs = Array.isArray(body.techs)
      ? [...new Set(body.techs.map((t) => String(t).trim().toLowerCase()).filter((t) => TECHS.has(t)))]
      : [];
    if (!techs.length) throw badRequest('Pick at least one technology you serve there.');

    const fields = {
      region,
      techs: techs.join(','),
      /* A CSV of Mbps tiers, ascending, the same shape `techs` uses above:
         "500,1000". It was one label in 16 characters back when the field was
         a single top speed. The whole ladder is "50,100,200,500,1000,2500",
         24 characters, and silently truncating that would leave a partner
         declared at tiers they never picked, so the column is 64 and so is
         this cap. See create-tables.md, provider_coverage. */
      speed: str(body.speed, 64),
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

    /* Declaring a region IS application task one. Doing it here rather than
       asking the console to call a second endpoint means the checklist cannot
       disagree with the coverage table, which is the failure the prototype had
       in the other direction: it tracked task completion in a client-side
       object that a reload discarded.
       Best effort, and deliberately so: the coverage row is the thing that
       matters, and a partner who has declared a region must not be told the
       declaration failed because a checklist row would not write. */
    if (created) {
      await application.setTask(req.catalyst, context.orgId, 'coverage', 'submitted')
        .catch(() => { /* application tables not provisioned yet */ });
    }

    audit.recordAsync(req.catalyst, req, {
      type: created ? 'provider.coverage.declare' : 'provider.coverage.update',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { org_id: context.orgId, region: regionSlug, techs },
    });

    const rows = await coverageRows(req.catalyst, context.orgId);
    envelope.ok(res, {
      live: rows !== null,
      coverage: (rows || []).map(publicCoverage),
    });
  }));

  /**
   * One region's serviceability state, for polling after a declaration.
   *
   * Serviceability is ASYNCHRONOUS and decided by an operator, not asserted by
   * the party it advantages: a declaration lands 'verifying' and only
   * /admin/providers/:orgId/coverage/:region/verify moves it on. Until that
   * admin route existed, nothing anywhere wrote 'active', so every declared
   * region sat in 'verifying' forever and no cohort ever reached any desk.
   * That was the blocker under the whole console.
   */
  router.get('/provider/coverage/:region/serviceability', wrap(async (req, res) => {
    const { context } = await requirePartner(req);
    const regionSlug = slug(req.params.region);
    if (!regionSlug) throw badRequest('Name the region.');

    const rows = await coverageRows(req.catalyst, context.orgId);
    if (rows === null) throw new AppError('SERVER_ERROR', 'Coverage is not available right now. Please try again shortly.');

    const row = rows.find((r) => slug(r.region) === regionSlug);
    if (!row) throw new AppError('NOT_FOUND', 'You have not declared that region.');

    res.status(200).json({ ok: true, serverTime: Date.now(), coverage: publicCoverage(row) });
  }));
}

module.exports = { mount, BIDS, COVERAGE, publicCoverage, coverageRows, slug };
