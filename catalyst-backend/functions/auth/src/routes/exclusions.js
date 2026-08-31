'use strict';

/**
 * The brand registry, a member's provider exclusions, and a partner's attested
 * roster.
 *
 *   GET  /brands                       the active registry, member-safe
 *   GET  /me/exclusions                this member's set, with display names
 *   PUT  /me/exclusions                replace it atomically
 *   GET  /provider/roster              this org's attested brands
 *   POST /provider/roster              declare them, with attestation
 *   POST /provider/brand-request       ask for a listing we do not carry
 *   GET  /provider/cohorts/:id/reach   reachable households, aggregate only
 *   GET  /distributor/serving-map      this distributor's serving map
 *   POST /distributor/serving-map      declare it, with attestation
 *
 * WHAT CROSSES, AND WHAT NEVER DOES. `owner_org_name` never reaches a member:
 * the corporate name behind a flanker brand is frequently the thing the
 * flanker exists to obscure, and volunteering it on a join screen is this
 * system answering a question the household did not ask. The raw
 * member-to-exclusion mapping never reaches a partner or a distributor in any
 * shape, including an error payload: section 10.3. A partner learns one number
 * per cohort, and that number is computed here rather than assembled from rows
 * a partner's request was allowed to hold.
 *
 * THE TWO DISTRIBUTOR ROUTES HAVE NO CONSOLE YET. There is no authenticated
 * distributor role in this system, only a radio button on the public
 * application form, so `requireDistributor` refuses everyone today and says so
 * plainly. They are here because lib/rosters.js `canBidAs` already enforces
 * the serving map on the bid path: the gate exists before the door, which is
 * the right order for a gate whose whole purpose is that a distributor route
 * cannot bypass a member's exclusion.
 */

const datastore = require('../lib/datastore');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');
const brands = require('../lib/brands');
const exclusions = require('../lib/exclusions');
const rosters = require('../lib/rosters');
const bids = require('../lib/bids');
const awards = require('../lib/awards');
const catalog = require('../lib/catalog');
const cohorts = require('../lib/cohorts');
const { requirePartner: guardPartner, requireApproved } = require('../lib/guards');
const {
  wrap, badRequest, unauthorized, forbidden, AppError,
} = require('../lib/errors');

const REQUESTS = 'brand_requests';

/* The postal-code-change tier, section 12. An exclusion edit is the same kind
   of act: a real change a household makes rarely, and a cheap one to replay. */
const EXCL_MAX = 3;
const EXCL_WINDOW_SEC = 86400;

function requireMember(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  if (req.auth.user.user_type !== 'member') {
    throw forbidden('This account is not a member account.', {
      logDetail: 'non-member hit an exclusions route',
    });
  }
  return req.auth.user;
}

/**
 * The partner's org context, or a refusal. The shared guard, so the org comes
 * from the session and never from the request: one partner cannot name
 * another partner's roster even to be told it is forbidden.
 *
 * requirePartner and NOT requireApproved, matching the coverage declaration in
 * routes/desk.js. Declaring the brands you operate is a step of the
 * application, not a privilege of having finished it, and an applicant who
 * cannot state their roster cannot be roster-gated into bidding later. The
 * bid path is where approval is enforced, and it already is.
 */
const requireOrg = (req) => guardPartner(req, 'a /provider roster route');

/**
 * The distributor's own id, or a refusal.
 *
 * Refuses everyone today, deliberately and honestly: the role does not exist
 * yet, so there is no session this can trust. Returning a 403 that says so is
 * better than a route that half-works against a `user_type` nothing sets.
 */
function requireDistributor(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  throw forbidden('Distributor accounts are not open yet.', {
    logDetail: `distributor route hit by user_type=${req.auth.user.user_type}`,
  });
}

/** A list of brand ids from a request body, shape-checked and de-duplicated. */
function readBrandIds(raw) {
  if (!Array.isArray(raw)) {
    throw badRequest('Send the providers as a list.');
  }
  const out = [];
  raw.forEach((v) => {
    const id = String(v == null ? '' : v).trim();
    if (!id) return;
    if (!brands.isBrandId(id)) {
      throw new AppError('VALIDATION_ERROR', 'That is not a provider we list.', {
        logDetail: `malformed brand id len=${id.length}`,
        extra: { error_key: 'unknown_brand' },
      });
    }
    if (out.indexOf(id) < 0) out.push(id);
  });
  return out;
}

/**
 * Check every requested brand exists, and split them by whether a member may
 * select them.
 *
 * A member may exclude an `active` brand, and may KEEP a `retired` one they
 * already hold: edge case 11. So a retired brand already in the member's set
 * passes, and a retired brand newly added is refused, which is what stops a
 * stale picker from quietly re-adding something no longer offered while still
 * letting the member's existing chip survive a save.
 */
async function validateForMember(catalystApp, wanted, held) {
  const registry = await brands.all(catalystApp);
  if (registry === null) {
    throw new AppError('SERVER_ERROR',
      'The provider list is not available right now. Nothing was changed.', {
        logDetail: 'brand_registry unreadable on exclusion write',
      });
  }
  const byId = new Map(registry.filter((r) => r && r.brand_id).map((r) => [r.brand_id, r]));
  const heldSet = held instanceof Set ? held : new Set(held || []);

  wanted.forEach((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new AppError('VALIDATION_ERROR', 'That is not a provider we list.', {
        logDetail: `unknown brand id=${id}`,
        extra: { error_key: 'unknown_brand' },
      });
    }
    if (row.status !== 'active' && !heldSet.has(id)) {
      throw new AppError('VALIDATION_ERROR', 'That provider is no longer on our list.', {
        logDetail: `inactive brand id=${id} status=${row.status}`,
        extra: { error_key: 'inactive_brand' },
      });
    }
  });
  return registry;
}

/**
 * Which brands, of those requested, are family defaults rather than direct
 * picks: a brand whose parent is also in the set, and which the member did not
 * name as the thing they were looking for.
 *
 * The distinction is only ever recorded, never enforced: section 7.1 wants to
 * know how a member arrived at a brand so a dispute about "I never chose
 * that" has an answer, and the member's own ticking is the authority on what
 * the set is.
 */
function sourcesFor(registry, wanted, picked) {
  const byId = new Map((registry || []).filter((r) => r && r.brand_id).map((r) => [r.brand_id, r]));
  const want = new Set(wanted);
  const direct = new Set((picked || []).filter((id) => want.has(id)));
  const out = {};
  wanted.forEach((id) => {
    if (direct.has(id)) { out[id] = 'direct'; return; }
    const row = byId.get(id);
    const parent = row && row.parent_brand_id;
    out[id] = parent && want.has(parent) ? 'family_default' : 'direct';
  });
  return out;
}

function mount(router) {
  /* ---------------------------------------------------------------- *
   * The registry
   * ---------------------------------------------------------------- */

  /**
   * The active registry, searchable. -> { ok, brands: [{ brand_id, ... }] }
   *
   * Member-safe by construction: `publicBrand` names the three fields that
   * cross, so a column added to the table later cannot leak by being spread.
   * Reachable by any signed-in account, member or partner, because both
   * pickers read the same list and neither learns anything from it that the
   * other may not have.
   */
  router.get('/brands', wrap(async (req, res) => {
    if (!req.auth) throw unauthorized('Please sign in again.');

    const rows = await brands.all(req.catalyst);
    if (rows === null) {
      /* Not created yet. An empty list would render the picker as a working
         screen with nothing in it, so the absence is reported as itself. */
      return res.status(200).json({ ok: true, available: false, brands: [] });
    }
    const q = String((req.query || {}).query || '').slice(0, 64);
    const list = brands.search(rows, q);
    res.status(200).json({
      ok: true,
      available: true,
      brands: list.map(brands.publicBrand),
    });
  }));

  /* ---------------------------------------------------------------- *
   * The member's set
   * ---------------------------------------------------------------- */

  /** This member's active exclusions. -> { ok, exclusions: [...] } */
  router.get('/me/exclusions', wrap(async (req, res) => {
    const user = requireMember(req);
    const rows = await exclusions.rowsFor(req.catalyst, user.user_id);
    if (rows === null) {
      const present = await exclusions.probe(req.catalyst);
      return res.status(200).json({
        ok: true, available: present, exclusions: [],
      });
    }
    const registry = await brands.all(req.catalyst);
    res.status(200).json({
      ok: true,
      available: true,
      exclusions: exclusions.listFrom(rows, registry || []),
    });
  }));

  /**
   * Replace this member's set. -> { ok, exclusions, coversAll }
   *
   *   PUT /me/exclusions { brand_ids: [...], picked: [...] }
   *
   * `picked` is optional and records which of the ids the member named
   * directly, the rest being family defaults they accepted. It changes
   * nothing about the set itself.
   *
   * `coversAll` drives the full-coverage warning, and it is computed against
   * the brands actually holding a bid on the member's own cohorts rather than
   * against the registry: section 7.1 is explicit that the warning must never
   * be speculative, and "you may receive no offers" said to a member whose
   * exclusions happen to miss two live bidders is a false alarm that teaches
   * them to ignore the next one.
   */
  router.put('/me/exclusions', wrap(async (req, res) => {
    const user = requireMember(req);

    if (!await ratelimit.withinLimitFor(req.catalyst, req, user.user_id,
      { key: 'me.exclusions', max: EXCL_MAX, windowSec: EXCL_WINDOW_SEC })) {
      throw new AppError('RATE_LIMITED',
        'You have changed your excluded providers a few times today. Try again tomorrow.', {
          logDetail: `exclusion write limit for ${user.user_id}`,
          headers: { 'Retry-After': String(EXCL_WINDOW_SEC) },
          extra: { reason: 'exclusion_change_limit' },
        });
    }

    const wanted = readBrandIds((req.body || {}).brand_ids);
    const picked = Array.isArray((req.body || {}).picked)
      ? readBrandIds((req.body || {}).picked) : wanted;

    const before = await exclusions.setFor(req.catalyst, user.user_id);
    const registry = await validateForMember(req.catalyst, wanted, before || new Set());
    const result = await exclusions.replace(req.catalyst, user.user_id, wanted, {
      sources: sourcesFor(registry, wanted, picked),
    });

    /* Section 10.6: every create and every remove is audited, with the actor
       and the cohort state. The state is what makes a dispute answerable: an
       exclusion added while a cohort sat in `offers_out` behaves differently
       from one added while it was forming, and the trail has to say which. */
    await audit.record(req.catalyst, req, {
      type: 'member.exclusions.replace',
      outcome: 'success',
      userId: user.user_id,
      detail: {
        added: result.added,
        removed: result.removed,
        active_count: result.active.length,
      },
    });

    const rows = await exclusions.rowsFor(req.catalyst, user.user_id);
    res.status(200).json({
      ok: true,
      exclusions: exclusions.listFrom(rows || [], registry),
      coversAll: await coverageWarning(req, user, new Set(result.active)),
    });
  }));

  /* ---------------------------------------------------------------- *
   * The partner's roster
   * ---------------------------------------------------------------- */

  /** This org's attested roster. -> { ok, brands, attestation } */
  router.get('/provider/roster', wrap(async (req, res) => {
    const { context } = await requireOrg(req);
    const att = await rosters.attestationFor(req.catalyst, context.orgId);
    const registry = await brands.all(req.catalyst);
    const byId = new Map((registry || []).filter((r) => r && r.brand_id)
      .map((r) => [r.brand_id, r]));

    res.status(200).json({
      ok: true,
      available: att.reason !== 'no_table',
      attested: att.attested,
      attestedAt: att.at,
      brands: Array.from(att.brands).map((id) =>
        brands.publicBrand(byId.get(id) || { brand_id: id, display_name: id })),
      /* The whole active registry, so the picker can offer it without a
         second round trip. Suggestions by owner name are an operator review
         step (section 5.2) and are not computed here. */
      registry: (registry || []).filter((r) => r.status === 'active').map(brands.publicBrand),
    });
  }));

  /**
   * Declare this org's roster. -> { ok, brands, attestedAt }
   *
   *   POST /provider/roster { brand_ids: [...], attestation: true }
   *
   * The attestation is not a checkbox we store and forget: it names a user and
   * a moment, and any change re-opens it, because a list that was complete in
   * August is a different claim in November. An empty roster is refused
   * (edge case 17): a partner that operates no brands has nothing to bid
   * under, and storing "none" as a complete answer would pass the roster gate
   * with an empty set.
   */
  router.post('/provider/roster', wrap(async (req, res) => {
    const { user, context } = await requireOrg(req);
    if ((req.body || {}).attestation !== true) {
      throw new AppError('VALIDATION_ERROR',
        'Confirm the list is complete before you save it.', {
          logDetail: 'roster save without attestation',
          extra: { error_key: 'attestation_required' },
        });
    }
    const wanted = readBrandIds((req.body || {}).brand_ids);
    if (!wanted.length) {
      throw badRequest('Name at least one brand you operate.');
    }

    /* Every brand must exist and be active. A `pending_review` listing is not
       a brand yet and may not be attested to: that is the whole point of the
       review, and attesting to it would let the request become the answer. */
    const registry = await brands.all(req.catalyst);
    if (registry === null) {
      throw new AppError('SERVER_ERROR',
        'The brand list is not available right now. Nothing was changed.', {
          logDetail: 'brand_registry unreadable on roster write',
        });
    }
    const byId = new Map(registry.filter((r) => r && r.brand_id).map((r) => [r.brand_id, r]));
    wanted.forEach((id) => {
      const row = byId.get(id);
      if (!row) {
        throw new AppError('VALIDATION_ERROR', 'That brand is not one we list.', {
          logDetail: `unknown brand on roster id=${id}`,
          extra: { error_key: 'unknown_brand' },
        });
      }
      if (row.status !== 'active') {
        throw new AppError('VALIDATION_ERROR', row.status === 'pending_review'
          ? 'That brand is still awaiting verification and cannot go on your roster yet.'
          : 'That brand is retired and cannot go on your roster.', {
          logDetail: `inactive brand on roster id=${id} status=${row.status}`,
          extra: { error_key: 'unknown_brand' },
        });
      }
    });

    const result = await rosters.declareRoster(req.catalyst, context.orgId, wanted, {
      userId: user.user_id,
    });

    await audit.record(req.catalyst, req, {
      type: 'provider.roster.attest',
      outcome: 'success',
      userId: user.user_id,
      detail: {
        org_id: context.orgId,
        added: result.added,
        removed: result.removed,
        active_count: result.active.length,
      },
    });

    res.status(200).json({
      ok: true,
      brands: wanted.map((id) => brands.publicBrand(byId.get(id))),
      attestedAt: result.attestedAt,
    });
  }));

  /**
   * Ask for a brand we do not carry. -> { ok, status: 'pending_review' }
   *
   * Creates the registry row as `pending_review` AND an operator task, so the
   * request is a record rather than an email. Nothing may be bid under it
   * until an operator promotes it: `rosters.canBidAs` refuses any brand whose
   * status is not `active`, and the console shows "Awaiting verification".
   */
  router.post('/provider/brand-request', wrap(async (req, res) => {
    const { user, context } = await requireOrg(req);
    const name = String((req.body || {}).name || '').trim().slice(0, 120);
    const evidenceUrl = String((req.body || {}).evidence_url || '').trim().slice(0, 500);
    const note = String((req.body || {}).note || '').trim().slice(0, 1000);

    if (name.length < 2) throw badRequest('Give the brand name as it appears to a household.');
    if (!/^https?:\/\//i.test(evidenceUrl)) {
      throw badRequest('Give a link that shows the brand is yours.');
    }

    /* The slug is derived, never taken from the request: a brand id reaches a
       WHERE clause, and a partner-supplied one is the one string in this
       feature an attacker controls end to end. */
    const slug = brands.fold(name).replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 60);
    if (!brands.isBrandId(slug)) {
      throw badRequest('That brand name cannot be listed. Tell us about it and we will add it by hand.');
    }

    const existing = await brands.find(req.catalyst, slug);
    if (existing) {
      return res.status(200).json({
        ok: true,
        brand_id: slug,
        status: existing.status,
        alreadyListed: existing.status === 'active',
      });
    }

    const nowDb = datastore.nowDb();
    try {
      await datastore.insertRow(req.catalyst, brands.TABLE, {
        brand_id: slug,
        display_name: name,
        parent_brand_id: null,
        owner_org_name: context.orgName || null,
        status: 'pending_review',
        created_at: nowDb,
        updated_at: nowDb,
      });
      brands.invalidate();
    } catch (err) {
      throw new AppError('SERVER_ERROR',
        'That request could not be filed right now. Please try again shortly.', {
          logDetail: `brand request insert failed: ${String((err && err.message) || err).slice(0, 200)}`,
        });
    }

    /* The operator task. Best-effort: the registry row is the record that
       matters, and losing the task must not lose the request. */
    try {
      await datastore.insertRow(req.catalyst, REQUESTS, {
        brand_id: slug,
        provider_id: context.orgId,
        display_name: name,
        evidence_url: evidenceUrl,
        note: note || null,
        requested_by: user.user_id,
        requested_at: nowDb,
        state: 'open',
      });
    } catch {
      console.warn(JSON.stringify({
        at: 'brand-request', note: 'registry row written, operator task not',
        brand_id: slug,
      }));
    }

    await audit.record(req.catalyst, req, {
      type: 'provider.brand.request',
      outcome: 'success',
      userId: user.user_id,
      detail: { org_id: context.orgId, brand_id: slug },
    });

    res.status(200).json({ ok: true, brand_id: slug, status: 'pending_review' });
  }));

  /* ---------------------------------------------------------------- *
   * Reach, aggregate only
   * ---------------------------------------------------------------- */

  /**
   * How many households in one cohort this org's brands can still reach.
   *
   *   -> { ok, total_households, reachable_households, snapshot_at }
   *
   * AGGREGATE ONLY, AND COMPUTED HERE. The per-member exclusion rows are read
   * inside this handler and reduced to one number before anything is written
   * to the response: no identities, no breakdown, no list of who excluded
   * what, not even in an error payload (section 10.3). A partner learns how
   * much of the cohort it can still win and nothing about which households
   * they are.
   *
   * 403 until the roster is attested, because the number is meaningless
   * without one: with no declared brands there is nothing to intersect, and
   * answering zero would read as "every household excluded you".
   */
  router.get('/provider/cohorts/:id/reach', wrap(async (req, res) => {
    const { context } = await requireOrg(req);
    requireApproved(context);
    const att = await rosters.attestationFor(req.catalyst, context.orgId);
    if (!att.attested) {
      throw forbidden(att.reason === 'no_table'
        ? 'Brand rosters are not available yet.'
        : 'Declare and attest the brands you operate before you bid.', {
        logDetail: `reach without roster org=${context.orgId} reason=${att.reason}`,
        extra: { error_key: 'roster_required' },
      });
    }

    const cat = await catalog.load(req.catalyst);
    const campaign = cat.byId.get(String(req.params.id || '').trim());
    if (!campaign || campaign.kind === 'archived') {
      throw new AppError('NOT_FOUND', 'That cohort does not exist.', {
        logDetail: `reach for unknown campaign len=${String(req.params.id || '').length}`,
      });
    }

    const members = await cohorts.memberIds(req.catalyst, campaign);
    if (members === null) {
      return res.status(200).json({
        ok: true, available: false,
        total_households: null, reachable_households: null, snapshot_at: null,
      });
    }

    const total = members.length;
    let reachable = total;
    const present = await exclusions.probe(req.catalyst);
    if (present) {
      let hit = 0;
      for (const memberId of members) {
        /* eslint-disable-next-line no-await-in-loop */
        const set = await exclusions.setFor(req.catalyst, memberId);
        /* An unreadable set counts as unreachable, matching what the award
           path will actually do: the count a partner sees must not promise
           volume the resolution then refuses to deliver. */
        if (set === null || Array.from(att.brands).some((b) => set.has(b))) hit += 1;
      }
      reachable = Math.max(0, total - hit);
    }

    res.status(200).json({
      ok: true,
      available: true,
      total_households: total,
      reachable_households: reachable,
      /* CONFIRM-EXCL-04, snapshot at seal: once the cohort has closed the
         number stops moving, because the resolution it describes has run. */
      snapshot_at: awards.isClosed(campaign, Date.now())
        ? ((campaign.dates && campaign.dates.bidding_closes_at) || null)
        : null,
    });
  }));

  /**
   * This org's result on one closed cohort, as three numbers.
   *
   *   -> { ok, households_won, households_outranked,
   *        households_unreachable_exclusions }
   *
   * AGGREGATE ONLY. CONFIRM-EXCL-07 ships on the brief's default of yes,
   * because the third number is what explains the gap between the reachable
   * count this partner saw before bidding and the households it actually won,
   * and without it that gap reads as the auction having gone wrong. It leaks
   * nothing member-level: no identity, no brand, no competing price, and
   * never which household excluded whom.
   *
   * `households_outranked` is where this org's bid was ELIGIBLE for a
   * household and still holds no tier of that household's book, which is a
   * loss on price. `households_unreachable_exclusions` is where it was never
   * eligible at all. Keeping them apart is the entire point: a partner that
   * confuses the two draws the wrong lesson and lowers a price that was never
   * the problem.
   *
   * ON ITS OWN ROUTE AND NOT THE BID BOARD, deliberately. This walks every
   * member of the cohort and reads each one's exclusion set; the board loop in
   * routes/desk.js is metered per fetch and already economised down to one
   * award lookup per cohort. Folding an O(members) walk into it would make
   * every console boot pay for a number a partner asks for once.
   */
  router.get('/provider/cohorts/:id/results', wrap(async (req, res) => {
    const { context } = await requireOrg(req);
    requireApproved(context);
    const att = await rosters.attestationFor(req.catalyst, context.orgId);

    const cat = await catalog.load(req.catalyst);
    const campaign = cat.byId.get(String(req.params.id || '').trim());
    if (!campaign || campaign.kind === 'archived') {
      throw new AppError('NOT_FOUND', 'That cohort does not exist.', {
        logDetail: `results for unknown campaign len=${String(req.params.id || '').length}`,
      });
    }
    if (!awards.isClosed(campaign, Date.now())) {
      throw new AppError('CONFLICT', 'This cohort has not closed yet.', {
        logDetail: `results before close campaign=${campaign.id}`,
      });
    }

    const members = await cohorts.memberIds(req.catalyst, campaign);
    const rows = await bids.campaignBidRows(req.catalyst, campaign.id);
    if (members === null || rows === null) {
      return res.status(200).json({
        ok: true, available: false,
        households_won: null, households_outranked: null,
        households_unreachable_exclusions: null,
      });
    }

    /* Does this org hold a bid here at all? If not, every count is zero and
       nothing below needs to run: a partner that did not bid learns nothing
       about a cohort it is not in. */
    const ours = rows.filter((r) => String(r.org_id || '') === String(context.orgId));
    if (!ours.length) {
      return res.status(200).json({
        ok: true, available: true,
        households_won: 0, households_outranked: 0,
        households_unreachable_exclusions: 0,
      });
    }

    const brandMap = await rosters.brandOwners(req.catalyst);
    const registry = await brands.all(req.catalyst);
    const statusById = new Map((registry || [])
      .filter((r) => r && r.brand_id).map((r) => [r.brand_id, r.status]));
    const statusOf = (id) => statusById.get(id) || null;
    const ourBrands = new Set(Array.from(att.brands));
    /* A bid of ours whose brand is not on the current roster still counts as
       ours: it was attested when it was sealed, and a roster edited afterwards
       must not make this partner's own history unreadable to it. */
    ours.forEach((r) => {
      const b = awards.brandOfBid(r, brandMap);
      if (b) ourBrands.add(b);
    });

    let won = 0;
    let outranked = 0;
    let unreachable = 0;

    for (const memberId of members) {
      /* eslint-disable no-await-in-loop */
      const excluded = await exclusions.setFor(req.catalyst, memberId);
      if (excluded === null) {
        /* Unreadable. Counted as unreachable, matching what the offer route
           will actually do for this household, so the three numbers add up to
           the roster and never overstate what this partner could have won. */
        unreachable += 1;
        continue;
      }
      if (Array.from(ourBrands).some((b) => excluded.has(b))) {
        unreachable += 1;
        continue;
      }
      const built = awards.bookForMember(rows, null, { excluded, brandMap, statusOf });
      if (built.book.some((e) => e && String(e.orgId) === String(context.orgId))) won += 1;
      else outranked += 1;
      /* eslint-enable no-await-in-loop */
    }

    res.status(200).json({
      ok: true,
      available: true,
      households_won: won,
      households_outranked: outranked,
      households_unreachable_exclusions: unreachable,
    });
  }));

  /* ---------------------------------------------------------------- *
   * The distributor's serving map. No console yet: see the header.
   * ---------------------------------------------------------------- */

  router.get('/distributor/serving-map', wrap(async (req, res) => {
    requireDistributor(req);
    res.status(200).json({ ok: true, providers: [] });
  }));

  router.post('/distributor/serving-map', wrap(async (req, res) => {
    requireDistributor(req);
    res.status(200).json({ ok: true });
  }));
}

/**
 * Does this member's new set cover every brand bidding on a cohort they are
 * in? Returns the cohort id it is true for, or null.
 *
 * Best-effort and never fatal to the save: the set is already written by the
 * time this runs, and a warning that could not be computed must not turn a
 * successful save into an error. Checked only for cohorts that have drawn a
 * bid, so a member with no live cohort is never warned speculatively.
 */
async function coverageWarning(req, user, excluded) {
  if (!excluded || !excluded.size) return null;
  try {
    const cat = await catalog.load(req.catalyst);
    const mine = await cohorts.campaignsForMember(req.catalyst, user.user_id);
    if (!mine || !mine.length) return null;

    const brandMap = await rosters.brandOwners(req.catalyst);
    for (const campaignId of mine) {
      const campaign = cat.byId.get(campaignId);
      if (!campaign) continue;
      /* eslint-disable-next-line no-await-in-loop */
      const rows = await bids.campaignBidRows(req.catalyst, campaignId);
      if (!rows || !rows.length) continue;
      const bidBrands = rows.map((r) => awards.brandOfBid(r, brandMap)).filter(Boolean);
      if (exclusions.coversAll(excluded, bidBrands)) return campaignId;
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = { mount, REQUESTS };
