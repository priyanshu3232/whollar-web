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
const envelope = require('../lib/envelope');
const bids = require('../lib/bids');
const awards = require('../lib/awards');
const terms = require('../lib/terms');
const { requireBiddingOpen, allRows, tally, publicPartnerCampaign } = require('./campaigns');
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
 * The cohort's current household figure, for the commitment cap. Seed plus
 * live sign-ups, the same arithmetic the desk list shows, so the cap is
 * validated against the number the partner is looking at.
 */
async function householdCount(catalystApp, campaign) {
  const rows = await allRows(catalystApp);
  const t = rows ? tally(rows) : {};
  const signups = (t[campaign.id] && t[campaign.id].signups) || 0;
  return campaign.seedHouseholds + signups;
}

/** The head-row fields one sealing writes. Shared by place and improve. */
function headFields(draft, sealed, payloadHash, receivedAt) {
  return {
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

    const memberRows = await allRows(req.catalyst);
    const counts = memberRows ? tally(memberRows) : {};
    const enabled = await siteconfig.getValue(req.catalyst, 'bidding_enabled') !== false;
    /* One clock reading for stage and serverTime, the same rule
       /provider/campaigns follows: the stage was computed at the instant the
       console will offset from. */
    const now = Date.now();
    const pub = publicPartnerCampaign(campaign, counts, enabled, now);

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
    const cat = await catalog.load(req.catalyst);
    const byId = {};
    (cat || []).forEach((c) => { byId[c.id] = c; });

    const decided = {};
    for (const id of new Set((rows || []).map((r) => r.campaign_id))) {
      const campaign = byId[id];
      if (!campaign || !awards.isClosed(campaign)) continue;
      /* eslint-disable no-await-in-loop */
      const all = await bids.campaignBidRows(req.catalyst, id);
      const award = await awards.seal(req.catalyst, campaign, all);
      /* eslint-enable no-await-in-loop */
      if (award) decided[id] = award;
    }
    envelope.ok(res, {
      live: rows !== null,
      bids: (rows || []).map((row) => {
        const pub = bids.publicBid(row);
        const award = decided[row.campaign_id];
        if (award) pub.state = award.org_id === context.orgId ? 'won' : 'not_selected';
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
      await datastore.insertRow(req.catalyst, BIDS, {
        bid_key: key,
        campaign_id: campaign.id,
        org_id: context.orgId,
        user_id: user.user_id,
        status: 'sealed',
        submitted_at: datastore.toDb(new Date(receivedAt)),
        ...fields,
      });
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

    const fields = headFields(draft, sealed, payloadHash, receivedAt);
    try {
      await datastore.updateRow(req.catalyst, BIDS, {
        ROWID: head.ROWID, status: 'improved', ...fields,
      });
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
