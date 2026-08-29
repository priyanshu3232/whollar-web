'use strict';

/**
 * The one read layer for campaign state and seat counts.
 *
 * Both dashboards, the admin console, the bid commitment cap and the seat
 * routes used to compute "how many households are in this cohort" in their
 * own way: a `campaign_members` tally plus a seed baseline on the partner
 * side, a stored `cohort_counter.roster_count` on the member's seat ledger,
 * and the seed alone when either table was unreadable. Three numbers for one
 * fact, and the partner priced against the biggest of them.
 *
 * Now there is one:
 *
 *   seatCount(app, campaign)   -> { seats, waitlist, watching, live }
 *   list(app)                  -> every visible campaign, counted and staged
 *   forMember(state, mine)     -> the member projection
 *   forPartner(state, enabled) -> the partner projection
 *
 * `seats` is a COUNT at read time, per campaign, over the two tables that
 * can hold a membership: active `seat_claim` rows (the ledger, every join
 * since the seat routes shipped) and `campaign_members` rows whose derived
 * standing is `joined` (the click-time snapshot, which is all a household
 * that joined before the ledger existed has). One user_id counts once. No
 * seed baseline is added anywhere: a partner pricing against 64 invented
 * households is worse than one pricing against 6 real ones, and a member
 * being told 64 neighbours are in is a lie the site cannot cash.
 *
 * Memoized 60 seconds per campaign, and INVALIDATED by every write path in
 * the function (campaign join, leave, notify, and every seat transition), so
 * on the instance that took the write the next read is exact. The 60 seconds
 * is the bound across instances, which is the only staleness left. Same
 * lifetime as the catalog memo, so a cohort's kind and its count can never
 * be more than a minute apart.
 *
 * `stage` is never memoized. It is a pure function of (campaign, now) and it
 * is recomputed on every call to forMember/forPartner at the instant the
 * caller names, for the reason lib/catalog.js states: the minute a stage
 * would be stale in is the one before bidding closes.
 */

const datastore = require('./datastore');
const catalog = require('./catalog');
const geo = require('./geo');
const fsaref = require('./fsaref');

const MEMBERS_TABLE = 'campaign_members';
const CLAIM_TABLE = 'seat_claim';

const MEMO_MS = 60 * 1000;
const memo = new Map();

/** Forget one campaign's count, or every campaign's when no id is given. */
function invalidate(campaignId) {
  if (campaignId) memo.delete(String(campaignId));
  else memo.clear();
}

/**
 * The live count for one campaign. `live:false` means a table was unreadable
 * and the number is a floor, not the truth; the dashboards say so rather than
 * render a zero as an answer.
 *
 * One scoped read per table per campaign, never a full scan: queryAll stops
 * silently at its page budget and a ROWID-ordered scan spends it on the oldest
 * campaign first (INV-3).
 */
async function seatCount(catalystApp, campaignOrId) {
  const campaign = typeof campaignOrId === 'string'
    ? (await catalog.load(catalystApp)).byId.get(campaignOrId) || { id: campaignOrId, kind: 'planned' }
    : campaignOrId;
  const id = String(campaign.id);
  const hit = memo.get(id);
  const now = Date.now();
  if (hit && now - hit.at < MEMO_MS) return hit.count;
  const count = await countRows(catalystApp, campaign);
  memo.set(id, { at: now, count });
  return count;
}

async function countRows(catalystApp, campaign) {
  const joined = new Set();
  let waitlist = 0;
  let watching = 0;
  let live = true;

  try {
    const claims = await datastore.queryAll(catalystApp, CLAIM_TABLE, ['member_id'],
      `cohort_id = ${datastore.lit(campaign.id)} AND status = 'active'`);
    for (const r of claims) if (r.member_id) joined.add(String(r.member_id));
  } catch {
    live = false;
  }
  try {
    const rows = await datastore.queryAll(catalystApp, MEMBERS_TABLE, ['user_id', 'status'],
      `campaign_id = ${datastore.lit(campaign.id)}`);
    for (const r of rows) {
      const standing = catalog.standingOf(r.status, campaign);
      if (standing === 'joined') joined.add(String(r.user_id));
      else if (standing === 'waitlist') waitlist += 1;
      else if (standing === 'alert') watching += 1;
    }
  } catch {
    live = false;
  }
  return { seats: joined.size, waitlist, watching, live };
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/** Archived campaigns exist for the admin console only. */
const visible = (list) => list.filter((c) => c.kind !== 'archived');

/**
 * Is this cohort taking new households at `now`?
 *
 * The two halves both matter and they fail differently. `JOIN_STATUS` says
 * whether the KIND admits anyone at all (a forming cohort takes seats, a
 * waitlist or planned region takes names, an auction takes nobody);
 * `announce_at` is the moment the roster is fixed and the brief goes to
 * partners, which is what "joining closes" means to a household. A cohort can
 * be the right kind and past its date, and it is shut.
 *
 * The clock is the caller's, passed in, for the reason catalog.stageOf states:
 * a stage read against a second clock reading is a stage that can disagree
 * with the count beside it.
 */
function joinsOpen(campaign, now) {
  if (!campaign || !catalog.JOIN_STATUS[campaign.kind]) return false;
  const closeAt = campaign.dates && campaign.dates.announce_at;
  return !closeAt || now < closeAt;
}

/**
 * One campaign's canonical state at `now`: the catalog row, the count, and
 * both derived stages. Everything a surface renders is a projection of this
 * object, so two surfaces cannot disagree about whether a cohort is open.
 */
function state(campaign, count, now) {
  const partner = catalog.publicStage(campaign, now);
  const member = catalog.publicMemberStage(campaign, now);
  const c = count || { seats: 0, waitlist: 0, watching: 0, live: false };
  return {
    id: campaign.id,
    region: campaign.region,
    /* The member key. Never sent to a partner: forPartner() below is the
       whole list of what crosses the aisle, and a cohort's FSA set would
       hand a bidder the map of where its households live. */
    fsas: campaign.fsas || [],
    sub: campaign.sub || '',
    kind: campaign.kind,
    target: campaign.target,
    biddingOpen: Boolean(campaign.biddingOpen),
    sortOrder: campaign.sortOrder || 0,
    /* KIND AND THE WINDOW, not kind alone. `joinable` used to answer from
       JOIN_STATUS by itself, so a cohort whose announce_at had passed still
       arrived at the dashboard with joinable:true and rendered a live join
       button whose only possible answer was the 409 both join routes throw.
       Narrowing it here can only ever close a door: every write path still
       re-checks its own window, and this decides display and eligibility. */
    joinable: joinsOpen(campaign, now),
    seats: c.seats,
    waitlist: c.waitlist,
    watching: c.watching,
    countLive: c.live,
    partnerStage: partner.stage,
    partnerStageLabel: partner.stageLabel,
    memberStage: member.stage,
    memberStageLabel: member.stageLabel,
    next: partner.next,
    dates: campaign.dates || {},
    campaign,
  };
}

/**
 * Every visible campaign, counted and staged against ONE clock reading.
 * -> { source, live, serverTime, states }
 *
 * THE CODE CATALOG NEVER REACHES A MEMBER OR A PARTNER. catalog.load() falls
 * back to CODE_CATALOG when the `campaigns` table is missing or empty so the
 * admin console has something to import; before this module that fallback
 * also served six invented cohorts to every dashboard, joinable, with seed
 * counts, and a join against one wrote a real membership row naming a
 * campaign that did not exist. `source:'code'` now means an empty list on
 * every non-admin surface. The admin console still sees the code catalog
 * through catalog.load() directly, which is where the import button lives.
 */
async function list(catalystApp, { fresh = false, includeArchived = false } = {}) {
  const cat = await catalog.load(catalystApp, { fresh });
  const now = Date.now();
  if (cat.source !== 'table') {
    return { source: cat.source, live: false, serverTime: now, states: [] };
  }
  const rows = includeArchived ? cat.list : visible(cat.list);
  const states = [];
  let live = true;
  for (const c of rows) {
    const count = await seatCount(catalystApp, c);
    if (!count.live) live = false;
    states.push(state(c, count, now));
  }
  return { source: cat.source, live, serverTime: now, states };
}

/* ------------------------------------------------------------------ *
 * Projections
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Eligibility
 * ------------------------------------------------------------------ */

/**
 * What this cohort is to THIS household: eligible, already joined, closed to
 * new joins, or somewhere else. One of geo.eligibilityOf's five answers.
 *
 * COMPUTED HERE, ON THE SERVER, EVERY READ, and re-computed on the write path
 * by guards.requireEligible against this same function. The client is told the
 * answer so it can render the right card; it is never asked for it, and a
 * body claiming `eligibility: "eligible"` changes nothing about what the join
 * routes do. Same contract as `stage`.
 *
 * `mine` counts as already_joined for every standing, a bell included: a
 * household that asked to be told when a region opens has a relationship with
 * that cohort, and offering it "this is not your area" would be a worse answer
 * than the one its own alert row already gives.
 */
function eligibilityFor(s, memberFsa, mine) {
  return geo.eligibilityOf(
    { fsas: s.fsas }, memberFsa || null, s.joinable, Boolean(mine)
  );
}

/**
 * What a member's dashboard renders. `mine` is this member's membership row
 * or undefined. `households` is the same number the partner is shown.
 *
 * `memberFsa` is this household's own forward sortation area, derived from
 * their postal code by lib/users.js on write and never accepted from a
 * request. Passing it is what turns the campaign list from "every cohort,
 * joinable by anyone" into "yours, and everyone else's to read".
 */
function forMember(s, mine, memberFsa) {
  const eligibility = eligibilityFor(s, memberFsa, mine);
  return {
    id: s.id,
    region: s.region,
    sub: s.sub,
    kind: s.kind,
    target: s.target,
    members: s.seats,
    households: s.seats,
    waitlist: s.waitlist,
    watching: s.watching,
    joinable: s.joinable,
    /* Which cohort a household may actually take a seat in. `joinable` is a
       fact about the cohort; this is a fact about the pair. The dashboard
       needs both: a cohort can be open and not yours, and it still renders,
       readable, because visibility never depends on eligibility. */
    eligibility,
    /* The rail's ORDER, not a permission. See geo.nearbyTier. */
    nearbyTier: geo.nearbyTier({ fsas: s.fsas }, memberFsa || null, eligibility, fsaref),
    /* DERIVED, not the stored status. See catalog.standingOf. */
    you: mine ? catalog.standingOf(mine.status, s.campaign) : null,
    stage: s.memberStage,
    stageLabel: s.memberStageLabel,
    next: s.next,
    dates: s.dates,
  };
}

/**
 * What a partner's console renders: counts only, never who. `enabled` is
 * the global kill switch. `bidding_open` is display; requireBiddingOpen on
 * the write path is the authority.
 */
function forPartner(s, enabled) {
  return {
    id: s.id,
    region: s.region,
    /* The coverage key this cohort verifies against. Equal to region today. */
    coverageRegion: s.region,
    sub: s.sub,
    kind: s.kind,
    target: s.target,
    members: s.seats,
    households: s.seats,
    signups: s.seats,
    waitlist: s.waitlist,
    watching: s.watching,
    bidding_open: Boolean(enabled) && s.kind === 'auction' && s.biddingOpen,
    stage: s.partnerStage,
    stageLabel: s.partnerStageLabel,
    nextAt: s.next ? s.next.at : null,
    nextWhat: s.next ? s.next.what : null,
    dates: s.dates,
  };
}

/** Is this campaign one a partner may place a sealed bid on right now? */
function partnerBiddable(s, enabled) {
  return forPartner(s, enabled).bidding_open;
}

/** Is this campaign one a member is shown at all? Visible and not archived. */
function memberVisible(s) {
  return s.kind !== 'archived';
}

module.exports = {
  MEMO_MS, MEMBERS_TABLE, CLAIM_TABLE,
  seatCount, invalidate, list, state, visible, joinsOpen,
  forMember, forPartner, partnerBiddable, memberVisible, eligibilityFor,
};
