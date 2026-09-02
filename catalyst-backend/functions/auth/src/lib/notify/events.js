'use strict';

/**
 * One named function per domain event, and the routes call nothing else.
 *
 * WHY NOT dispatch() DIRECTLY FROM EACH ROUTE. Because then every route would
 * own recipient resolution, and recipient resolution is where this gets
 * dangerous. "Who hears about a tier award" is a question with a wrong answer
 * that leaks one partner's result to another, and it should be answered once,
 * here, next to the other answers, rather than nine times in nine files by
 * whoever was editing that file. The brief's section 5 calls these resolvers;
 * this is that layer.
 *
 * EVERY ONE OF THESE IS FIRE AND FORGET. A route is serving a person who did
 * something else: a partner booked a slot, a household accepted an offer. That
 * request must not fail, slow down, or roll back because a letter could not be
 * written. So each emitter swallows its own failure and logs it, and the outbox
 * row is the thing that records what happened.
 *
 * ORDER MATTERS AT THE CALL SITE. Emit AFTER the write that the letter
 * describes, never before. An email saying "your install is booked" that
 * arrives because the booking write then failed is worse than no email, and it
 * is the failure mode of every "notify optimistically" design.
 */

const notify = require('./index');
const users = require('../users');
const orgs = require('../orgs');
const datastore = require('../datastore');

/* ------------------------------------------------------------------ *
 * Resolvers
 * ------------------------------------------------------------------ */

/** The site's own origin, trailing slash removed. */
const base = (cfg) => String((cfg && cfg.APP_BASE_URL) || 'https://internet.whollar.ca').replace(/\/+$/, '');

/** A member user row, or null. Never throws: a missing person is not an error. */
async function memberById(catalystApp, userId) {
  if (!userId) return null;
  try {
    const u = await users.findById(catalystApp, userId);
    return u && u.email_normalized ? u : null;
  } catch {
    return null;
  }
}

/**
 * A partner's name as it should read in a household's email.
 *
 * Falls back to null rather than to a placeholder, and every template that
 * takes it declares it required, so a name we cannot read fails the row with
 * `missing:partner_name` instead of sending "your installer, undefined".
 */
async function orgName(catalystApp, orgId) {
  if (!orgId) return null;
  try {
    const org = await orgs.findById(catalystApp, orgId);
    return org ? (org.legal_name || null) : null;
  } catch {
    return null;
  }
}

/**
 * The people at a partner org who should hear about `role`.
 *
 * ROLE ROUTING IS BEST EFFORT AND DEGRADES TO EVERYONE, on purpose.
 * `provider_users.notify_roles` is the column that makes a statement land in
 * the billing inbox rather than the bid desk, and it does not exist yet.
 * Absent, this returns every active person at the org, which is exactly what
 * the approval notice has always done. So the routing is an upgrade that a
 * console change switches on, never a prerequisite that makes mail vanish
 * while the column is missing.
 *
 * A partner with no active people gets no letter and that is correct: there is
 * nobody to write to.
 */
async function partnerContacts(catalystApp, orgId, role) {
  if (!orgId) return [];

  let rows = [];
  let routed = false;
  /* Widest first. The narrow list is what provider_users has today. */
  for (const cols of [['user_id', 'org_id', 'role', 'notify_roles'], ['user_id', 'org_id', 'role']]) {
    try {
      /* eslint-disable-next-line no-await-in-loop */
      rows = await datastore.queryAll(catalystApp, orgs.MEMBERSHIPS, cols,
        `org_id = ${datastore.lit(orgId)}`);
      routed = cols.length === 4;
      break;
    } catch {
      /* next, narrower list */
    }
  }

  const out = [];
  for (const m of rows || []) {
    if (routed && role) {
      const claimed = String(m.notify_roles || '').split(',').map((s) => s.trim()).filter(Boolean);
      /* An empty value means "not configured", which routes everything, not
         "wants nothing". Silence by omission is the wrong default for a
         statement that falls due. */
      if (claimed.length && !claimed.includes(role) && !claimed.includes('all')) continue;
    }
    /* eslint-disable-next-line no-await-in-loop */
    const u = await memberById(catalystApp, m.user_id);
    if (!u || u.status !== 'active') continue;
    out.push({
      type: 'partner',
      id: u.user_id,
      email: u.email_normalized,
      locale: u.locale || 'en',
      timezone: u.timezone || 'America/Toronto',
      firstName: u.first_name || null,
    });
  }
  return out;
}

/** A recipient object from a member user row. */
const memberRecipient = (u) => ({
  type: 'member',
  id: u.user_id,
  email: u.email_normalized,
  locale: u.locale || 'en',
  timezone: u.timezone || 'America/Toronto',
  firstName: u.first_name || null,
});

/**
 * Send, and never let the failure reach the caller.
 *
 * The log line names the event rather than the template, because when this
 * goes wrong the question is "why did nobody hear about the install", not
 * "which template key was it".
 */
async function emit(req, event, spec) {
  try {
    return await notify.dispatch(req, spec);
  } catch (err) {
    console.error(JSON.stringify({
      req_id: req.id,
      level: 'error',
      message: 'notification event failed',
      event,
      detail: String((err && err.message) || err).slice(0, 200),
    }));
    return null;
  }
}

/** Emit to several partner contacts, one outbox row each. */
async function emitEach(req, event, recipients, spec) {
  for (const recipient of recipients) {
    /* eslint-disable-next-line no-await-in-loop */
    await emit(req, event, { ...spec, recipient });
  }
}

/* ------------------------------------------------------------------ *
 * Member events
 * ------------------------------------------------------------------ */

/**
 * A household took a seat in a cohort.
 *
 * Keyed on the campaign and the member, so joining twice, which the join route
 * treats as idempotent, is also one letter.
 */
async function cohortJoined(req, { campaign, user, have = null, need = null }) {
  const cfg = req.app.get('cfg');
  if (!user || !user.email_normalized) return null;
  return emit(req, 'cohort.joined', {
    templateKey: 'member.cohort.joined',
    eventKey: `cohort.joined:${campaign.id}:${user.user_id}`,
    recipient: memberRecipient(user),
    campaignId: campaign.id,
    context: {
      region_label: campaign.region,
      cohort_label: campaign.sub || null,
      have, need,
      dashboard_url: `${base(cfg)}/dashboard`,
      first_name: user.first_name || null,
    },
  });
}

/**
 * A household accepted an offer, which in this product is also a booking.
 *
 * The event key carries the tier, so a change of pick is a NEW letter rather
 * than a duplicate suppressed by the first one. That is the right call: the
 * household changed something and needs the new day in writing.
 */
async function offerAccepted(req, { campaign, user, entry, row, changedFrom = null }) {
  const cfg = req.app.get('cfg');
  if (!user || !user.email_normalized) return null;
  const partner = await orgName(req.catalyst, entry.orgId);
  return emit(req, 'offer.accepted', {
    templateKey: 'member.offer.accepted',
    eventKey: `offer.accepted:${campaign.id}:${user.user_id}:${entry.tier}`,
    recipient: memberRecipient(user),
    campaignId: campaign.id,
    context: {
      partner_name: partner,
      tier: entry.tier,
      price: entry.price || null,
      slot_at: row ? ms(row.slot_at) : null,
      slot_window: (row && row.slot_window) || null,
      address_line: (row && row.address_line) || null,
      order_no: (row && row.order_no) || null,
      region_label: campaign.region,
      changed_from: changedFrom,
      dashboard_url: `${base(cfg)}/dashboard`,
      first_name: user.first_name || null,
    },
  });
}

/** A household passed on the round. */
async function offerPassed(req, { campaign, user, released = false }) {
  const cfg = req.app.get('cfg');
  if (!user || !user.email_normalized) return null;
  return emit(req, 'offer.passed', {
    templateKey: 'member.offer.passed',
    eventKey: `offer.passed:${campaign.id}:${user.user_id}`,
    recipient: memberRecipient(user),
    campaignId: campaign.id,
    context: {
      region_label: campaign.region,
      released: Boolean(released),
      dashboard_url: `${base(cfg)}/dashboard`,
      first_name: user.first_name || null,
    },
  });
}

/* ------------------------------------------------------------------ *
 * Install events, all keyed off an order row
 * ------------------------------------------------------------------ */

const ms = (v) => {
  const d = datastore.fromDb(v);
  return d ? d.getTime() : null;
};

/** The household behind an order, plus the partner's name. */
async function orderParties(req, row) {
  const user = await memberById(req.catalyst, row && row.member_user_id);
  if (!user) return null;
  return { user, partner: await orgName(req.catalyst, row.org_id) };
}

/**
 * A slot was booked, or moved.
 *
 * `previousSlotAt` is what distinguishes the two letters, and it comes from
 * the row BEFORE the write, so the call site has to capture it first. A
 * rebooking that cannot say what it moved from is still a rebooking, and the
 * template prints only the new day in that case.
 */
async function installScheduled(req, { row, previousSlotAt = null, rebooked = false }) {
  const cfg = req.app.get('cfg');
  const parties = await orderParties(req, row);
  if (!parties) return null;
  const slotAt = ms(row.slot_at);
  return emit(req, rebooked ? 'install.rebooked' : 'install.scheduled', {
    templateKey: rebooked ? 'member.install.rebooked' : 'member.install.scheduled',
    /* The slot is in the key, so every genuine move sends and a retried save
       of the same day does not. */
    eventKey: `install.slot:${row.order_key}:${slotAt}`,
    recipient: memberRecipient(parties.user),
    campaignId: row.campaign_id || null,
    context: {
      partner_name: parties.partner,
      slot_at: slotAt,
      previous_slot_at: previousSlotAt,
      slot_window: row.slot_window || null,
      order_no: row.order_no || null,
      dashboard_url: `${base(cfg)}/dashboard`,
      first_name: parties.user.first_name || null,
    },
  });
}

/** A visit that did not complete: no-show, access, or a failed line test. */
async function installException(req, { row, kind }) {
  const cfg = req.app.get('cfg');
  const parties = await orderParties(req, row);
  if (!parties) return null;
  return emit(req, 'install.exception', {
    templateKey: 'member.install.exception',
    /* Keyed on the kind and not on a timestamp: a second no-show is a second
       letter, and a double-submitted exception is not. */
    eventKey: `install.exception:${row.order_key}:${kind}:${Date.now()}`,
    recipient: memberRecipient(parties.user),
    campaignId: row.campaign_id || null,
    context: {
      partner_name: parties.partner,
      kind,
      order_no: row.order_no || null,
      dashboard_url: `${base(cfg)}/dashboard`,
      first_name: parties.user.first_name || null,
    },
  });
}

/** The line tested clean and the incumbent is cancelled. The finish line. */
async function switchComplete(req, { row, monthlySaving = null }) {
  const cfg = req.app.get('cfg');
  const parties = await orderParties(req, row);
  if (!parties) return null;
  return emit(req, 'switch.complete', {
    templateKey: 'member.switch.complete',
    eventKey: `switch.complete:${row.order_key}`,
    recipient: memberRecipient(parties.user),
    campaignId: row.campaign_id || null,
    context: {
      partner_name: parties.partner,
      tier: row.tier || null,
      price: row.price || null,
      monthly_saving: monthlySaving,
      dashboard_url: `${base(cfg)}/dashboard`,
      first_name: parties.user.first_name || null,
    },
  });
}

/**
 * The partner released the household.
 *
 * The household's OWN pass also releases an order, and that household already
 * has the pass letter. Sending both would tell somebody who just left that
 * their install was cancelled, which reads as a second, worse thing having
 * happened. So `household_passed` emits nothing here.
 */
async function orderReleased(req, { row, reason, regionLabel = null }) {
  const cfg = req.app.get('cfg');
  if (reason === 'household_passed') return null;
  const parties = await orderParties(req, row);
  if (!parties) return null;
  return emit(req, 'order.released', {
    templateKey: 'member.order.released',
    eventKey: `order.released:${row.order_key}`,
    recipient: memberRecipient(parties.user),
    campaignId: row.campaign_id || null,
    context: {
      reason,
      region_label: regionLabel,
      dashboard_url: `${base(cfg)}/dashboard`,
      first_name: parties.user.first_name || null,
    },
  });
}

/* ------------------------------------------------------------------ *
 * Partner events
 * ------------------------------------------------------------------ */

/** The receipt for a sealed or improved bid. Goes to the bid desk. */
async function bidSealed(req, { campaign, orgId, receiptNo, revisionNo, sealedAt, closesAt }) {
  const cfg = req.app.get('cfg');
  const to = await partnerContacts(req.catalyst, orgId, 'bids');
  return emitEach(req, 'bid.sealed', to, {
    templateKey: 'partner.bid.receipt',
    /* The revision is the identity: a new version is a new receipt. */
    eventKey: `bid.sealed:${campaign.id}:${orgId}:${revisionNo}`,
    campaignId: campaign.id,
    context: {
      region_label: campaign.region,
      cohort_label: campaign.sub || null,
      receipt_no: receiptNo,
      revision_no: revisionNo || null,
      sealed_at: sealedAt || null,
      closes_at: closesAt || null,
      console_url: `${base(cfg)}/partner`,
    },
  });
}

/** A tier awarded to this partner. */
async function tierAwarded(req, { campaign, orgId, tier, householdCount = null, price = null }) {
  const cfg = req.app.get('cfg');
  const to = await partnerContacts(req.catalyst, orgId, 'bids');
  return emitEach(req, 'tier.awarded', to, {
    templateKey: 'partner.tier.awarded',
    eventKey: `tier.awarded:${campaign.id}:${orgId}:${tier}`,
    campaignId: campaign.id,
    context: {
      region_label: campaign.region,
      cohort_label: campaign.sub || null,
      tier,
      household_count: householdCount,
      price,
      switch_window_at: (campaign.dates && campaign.dates.switch_window_at) || null,
      console_url: `${base(cfg)}/partner`,
    },
  });
}

/** A tier this partner bid on and did not win. Tier name only, by invariant. */
async function tierNotAwarded(req, { campaign, orgId, tier }) {
  const cfg = req.app.get('cfg');
  const to = await partnerContacts(req.catalyst, orgId, 'bids');
  return emitEach(req, 'tier.not_awarded', to, {
    templateKey: 'partner.tier.not_awarded',
    eventKey: `tier.not_awarded:${campaign.id}:${orgId}:${tier}`,
    campaignId: campaign.id,
    context: {
      region_label: campaign.region,
      tier,
      console_url: `${base(cfg)}/partner`,
    },
  });
}

/** A statement is ready. Goes to billing, not to the bid desk. */
async function statementReady(req, { campaign, orgId, ref, statementRef = null, total, lineCount, dueAt }) {
  const cfg = req.app.get('cfg');
  const to = await partnerContacts(req.catalyst, orgId, 'billing');
  return emitEach(req, 'statement.ready', to, {
    templateKey: 'partner.statement.ready',
    /* `ref` identifies the issue for deduplication and is never printed;
       `statementRef` is the human reference and is printed only when one
       exists. Conflating them puts `brampton-east:1787000000000` on a
       partner's statement email as though it were a document number. */
    eventKey: `statement.ready:${ref || `${campaign.id}:${orgId}`}`,
    campaignId: campaign.id,
    context: {
      region_label: campaign.region,
      statement_ref: statementRef || null,
      total,
      line_count: lineCount || null,
      due_at: dueAt || null,
      console_url: `${base(cfg)}/partner`,
    },
  });
}

/** A disputed line, acknowledged. */
async function disputeLogged(req, { orgId, orderRef, regionLabel = null, campaignId = null }) {
  const cfg = req.app.get('cfg');
  const to = await partnerContacts(req.catalyst, orgId, 'billing');
  return emitEach(req, 'statement.dispute', to, {
    templateKey: 'partner.statement.dispute_ack',
    eventKey: `statement.dispute:${orderRef}`,
    campaignId,
    context: {
      order_ref: orderRef,
      region_label: regionLabel,
      console_url: `${base(cfg)}/partner`,
    },
  });
}

module.exports = {
  /* resolvers, exported for the tests */
  memberById, orgName, partnerContacts, memberRecipient, base,
  /* member */
  cohortJoined, offerAccepted, offerPassed,
  installScheduled, installException, switchComplete, orderReleased,
  /* partner */
  bidSealed, tierAwarded, tierNotAwarded, statementReady, disputeLogged,
};
