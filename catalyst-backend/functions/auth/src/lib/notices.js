'use strict';

/**
 * Stage notices: one email to every household in a cohort, once per stage.
 *
 * THE PROBLEM THIS SOLVES. A cohort's stage is DERIVED, never stored
 * (lib/catalog.js), and it is moved by writing a date into the `campaigns`
 * row. A row written by hand in ZCQL runs no code at all, and even the admin
 * transition route only changes `kind`. So the moment a cohort starts bidding,
 * nothing anywhere notices. There is no event to hang an email on, and there
 * is no cron in this stack to poll for one.
 *
 * So the comparison happens ON READ. Every dashboard load already computes
 * every cohort's stage; this adds one scoped query against a ledger of what
 * has already been announced, and does nothing at all when nothing has moved.
 * The first person to load a page after a stage flips is what sends the mail,
 * which on a live surface is seconds. `POST /admin/campaigns/notices/sweep`
 * forces the same pass for the case where nobody is browsing, which is mostly
 * an operator testing alone.
 *
 * CLAIM BEFORE SEND, always. The notice row is written FIRST and the unique
 * constraint on `notice_key` is the race guard: two overlapping sweeps collide
 * there and the loser sends nothing. Since the letters moved into
 * lib/notify/outbox.js there is a second guard underneath it, the per
 * household idempotency key, which catches the case the claim cannot see: a
 * cohort that gained a household between two sweeps.
 *
 * That ordering is deliberate and it is not symmetric. Crash after claiming and some households miss one letter; crash
 * after sending and every household gets the letter twice on the next read.
 * For a message that goes to a whole cohort at once, missing beats duplicating.
 *
 * SEEDING, so shipping this does not blast anyone. A campaign with no notice
 * rows at all has never been swept, and its current stage is recorded WITHOUT
 * sending. Otherwise every cohort already at `bidding` would mail every one of
 * its households the minute this deploys, announcing a step they watched
 * happen days ago.
 */

const datastore = require('./datastore');
const catalog = require('./catalog');
const users = require('./users');
const outbox = require('./notify/outbox');

const TABLE = 'campaign_notices';
const MEMBERS_TABLE = 'campaign_members';
const CLAIM_TABLE = 'seat_claim';

/** Households mailed in one pass. A cohort larger than this finishes on the next. */
const BATCH = 120;

const keyFor = (campaignId, stage) => `${campaignId}:${stage}`.slice(0, 130);

/** Every stage already announced for this campaign, as a Set. Null if unreadable. */
async function announced(catalystApp, campaignId) {
  try {
    const rows = await datastore.queryAll(catalystApp, TABLE, ['stage'],
      `campaign_id = ${datastore.lit(campaignId)}`);
    return new Set((rows || []).map((r) => String(r.stage)));
  } catch {
    return null;
  }
}

/**
 * Take the right to send this letter, or return false because someone else
 * has it. The insert IS the lock: `notice_key` is unique, so the second
 * writer's insert throws and it sends nothing.
 */
async function claim(catalystApp, campaignId, stage, now) {
  try {
    await datastore.insertRow(catalystApp, TABLE, {
      notice_key: keyFor(campaignId, stage),
      campaign_id: campaignId,
      stage,
      sent_count: 0,
      sent_at: datastore.toDb(new Date(now)),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The households in this cohort, by user id. The same union
 * lib/cohorts.js counts: an active seat claim is a seat, and a
 * `campaign_members` row whose DERIVED standing is `joined` is the older
 * form of the same fact. A waitlist place and a bell are interest, not
 * membership, and are not written to.
 */
async function recipients(catalystApp, campaign) {
  const ids = new Set();
  try {
    const claims = await datastore.queryAll(catalystApp, CLAIM_TABLE, ['member_id'],
      `cohort_id = ${datastore.lit(campaign.id)} AND status = 'active'`);
    for (const r of claims) if (r.member_id) ids.add(String(r.member_id));
  } catch {
    /* Ledger unreadable. The membership snapshot below still answers. */
  }
  try {
    const rows = await datastore.queryAll(catalystApp, MEMBERS_TABLE, ['user_id', 'status'],
      `campaign_id = ${datastore.lit(campaign.id)}`);
    for (const r of rows) {
      if (catalog.standingOf(r.status, campaign) === 'joined') ids.add(String(r.user_id));
    }
  } catch {
    /* Both unreadable means no recipients, and the claim row still stands:
       this stage is marked announced and nobody is mailed twice later. */
  }
  return Array.from(ids).slice(0, BATCH);
}

/**
 * Queue one stage's letter to one cohort, then drain. Returns how many rows
 * were written, not how many were delivered: quiet hours can hold a letter
 * until morning, and the outbox is what knows the difference.
 *
 * A single household failing never stops the rest: one bad row in a hundred
 * must not cost the other ninety-nine their notice.
 */
async function mailCohort(catalystApp, cfg, campaign, stage, now) {
  const ids = await recipients(catalystApp, campaign);
  const next = catalog.nextTransition(campaign, now);
  const base = String(cfg.APP_BASE_URL || '').replace(/\/+$/, '');
  let queued = 0;

  for (const id of ids) {
    let rec = null;
    try {
      /* eslint-disable-next-line no-await-in-loop */
      rec = await users.findById(catalystApp, id);
    } catch {
      rec = null;
    }
    const to = rec && rec.email_normalized;
    if (!to) continue;

    /* The event key is the campaign and the stage, not the sweep, so a second
       sweep that somehow got past the claim row still writes the same outbox
       row and sends nothing twice. Two guards for one letter, deliberately:
       the claim is per cohort and this is per household, and a cohort that
       gains a member between two sweeps is exactly the case the claim alone
       cannot see. */
    try {
      /* eslint-disable-next-line no-await-in-loop */
      const result = await outbox.enqueue(catalystApp, cfg, {
        templateKey: 'member.campaign.stage',
        eventKey: `campaign.stage:${campaign.id}:${stage}`,
        recipient: {
          type: 'member',
          id: String(id),
          email: to,
          locale: rec.locale || 'en',
          timezone: rec.timezone || 'America/Toronto',
          firstName: rec.first_name || null,
        },
        campaignId: campaign.id,
        context: {
          stage,
          region_label: campaign.region,
          cohort_label: campaign.sub || null,
          dashboard_url: `${base}/dashboard`,
          next_at: next ? next.at : null,
          first_name: rec.first_name || null,
        },
        now,
      });
      if (result && (result.status === 'queued' || result.status === 'held')) queued += 1;
    } catch {
      /* One household's row failed. The others still get theirs. */
    }
  }

  /* Written, now send. The drain is what respects quiet hours, so a stage
     that flips at midnight queues here and goes out at seven. */
  await outbox.drain(catalystApp, cfg, { now }).catch(() => {});
  return queued;
}

/** Record how many were written to the outbox, for the operator reading the
    ledger. Not how many were delivered: quiet hours mean a letter queued at
    midnight has not gone anywhere yet, and a count that said otherwise would
    be the ledger's first lie. */
async function stamp(catalystApp, campaignId, stage, sent) {
  try {
    const row = await datastore.findBy(catalystApp, TABLE, 'notice_key',
      keyFor(campaignId, stage), ['ROWID']);
    if (row) await datastore.updateRow(catalystApp, TABLE, { ROWID: row.ROWID, sent_count: sent });
  } catch {
    /* The count is a convenience. The claim row is the fact that matters. */
  }
}

/**
 * One pass over already-staged campaigns.
 *
 * `states` are cohorts.state() objects, so this never recomputes a stage and
 * never disagrees with the payload the same request is about to return.
 * -> { swept, seeded, sent }
 */
async function sweep(catalystApp, cfg, states, now = Date.now()) {
  const out = { swept: 0, seeded: 0, sent: 0 };
  if (!cfg || !Array.isArray(states)) return out;

  for (const s of states) {
    const stage = s.memberStage;
    if (!stage) continue;

    const seen = await announced(catalystApp, s.id);
    if (seen === null) return out;      // table absent: do nothing, quietly
    if (seen.has(stage)) continue;      // this letter has already gone

    const first = seen.size === 0;
    if (!await claim(catalystApp, s.id, stage, now)) continue;

    if (first) {
      /* Never seen before. Record where it stands and say nothing: this is
         a cohort that existed before notices did, not one that just moved. */
      out.seeded += 1;
      continue;
    }
    const sent = await mailCohort(catalystApp, cfg, s.campaign, stage, now);
    await stamp(catalystApp, s.id, stage, sent);
    out.swept += 1;
    out.sent += sent;
  }
  return out;
}

/** Fire and forget, for a read path that must not wait on mail. */
function sweepAsync(catalystApp, cfg, states, now) {
  Promise.resolve(sweep(catalystApp, cfg, states, now)).catch(() => {});
}

module.exports = { TABLE, BATCH, sweep, sweepAsync, announced, recipients, keyFor };
