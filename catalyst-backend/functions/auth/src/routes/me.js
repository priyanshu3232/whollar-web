'use strict';

/**
 * The member's account beyond the bill: profile, preferences, feedback,
 * referral standing, and the two rights every account owner has: take your
 * data out, and delete the account.
 *
 *   POST /me/profile    update name / phone / postal code
 *   GET  /me/prefs      the stored preference blob
 *   POST /me/prefs      merge preference keys (notification toggles, interests)
 *   POST /me/event      record feedback: a provider rating, an open note, an
 *                       outage report, a "first in line" interest signal
 *   GET  /me/referral   this member's share code and how many joined with it
 *   GET  /me/export     everything we hold about this account, as JSON
 *   POST /me/delete     revoke sessions, delete owned rows, scrub the account
 *
 * Everything is keyed on the session's user_id. The email appears only in
 * /me/delete's typed confirmation, where it is the proof of intent, and in
 * /me/referral's count, where other people typed this member's code.
 */

const datastore = require('../lib/datastore');
const users = require('../lib/users');
const referral = require('../lib/referral');
const sessions = require('../lib/sessions');
const prefs = require('../lib/prefs');
const audit = require('../lib/audit');
const cookies = require('../lib/cookies');
const ratelimit = require('../lib/ratelimit');
const guards = require('../lib/guards');
const geo = require('../lib/geo');
const seats = require('../lib/seats');
const catalog = require('../lib/catalog');
const cohorts = require('../lib/cohorts');
const { wrap, badRequest, forbidden, AppError } = require('../lib/errors');

const EVENTS = 'user_events';
/* A CLOSED SET, and the only place it is declared. 'feedback' is the open box
   the dashboards call "Share your experience": unprompted, not attached to a
   provider or a cohort, and kept apart from 'rating' so a note about the site
   cannot be read later as an opinion of somebody's provider. The source of the
   box travels in the payload, since a kind per button would grow this set
   without telling the reader anything a payload key does not. */
const EVENT_KINDS = new Set(['rating', 'feedback', 'outage', 'interest', 'provider-notify']);

/* Moved to lib/guards.js. requireUser is deliberately type-agnostic: /me/prefs,
   /me/event, /me/export and /me/delete already serve partners as well as
   members, and the partner console relies on that. */
const requireUser = (req) => guards.requireUser(req);
const requireMember = (req) => guards.requireMember(req, '/me');

/**
 * The member's share code, derived rather than stored. Both halves of that
 * derivation, and why it is eight hex characters rather than four, live in
 * lib/referral.js; this route only renders it and counts what it brought in.
 */
const referralCodeFor = (user) => referral.codeFor(user);

/**
 * Record a feedback event. Append-only; the admin console is the reader.
 * Payload is capped and stored as JSON, never filtered on, so Text is fine.
 */
async function recordEvent(catalystApp, user, kind, payload) {
  const json = JSON.stringify(payload == null ? {} : payload).slice(0, 4000);
  await datastore.insertRow(catalystApp, EVENTS, {
    user_id: user.user_id,
    user_type: user.user_type,
    kind,
    payload: json,
    created_at: datastore.nowDb(),
  });
}

/* ------------------------------------------------------------------ *
 * The postal code, which is also the cohort
 * ------------------------------------------------------------------ */

/**
 * Three changes a day per account.
 *
 * NOT AN ANTI-FRAUD MEASURE, and it should not be mistaken for one. A
 * household that genuinely moves changes its postal code once; a household
 * shopping for a cohort it likes the look of changes it repeatedly, and the
 * honest answer to that is the copy in the not-in-your-area card, which says
 * the cohort is somewhere else and offers the household its own. This limit
 * only stops the shopping being free and fast enough to be worth automating.
 * It matches the three-moves-a-day the seat ledger already applies to the
 * other way of reaching another cohort, deliberately: two doors to the same
 * room should not have different locks.
 */
const POSTAL_CHANGE_MAX = 3;
const POSTAL_CHANGE_WINDOW_SEC = 86400;

/** Columns that ship after the code. Absent until an operator adds them. */
const POSTAL_META_COLUMNS = ['postal_code_updated_at', 'postal_code_source'];

/**
 * Write the profile, retrying without the columns that may not exist yet.
 *
 * `users.postal_code_updated_at` and `postal_code_source` are new, and this
 * stack has no DDL API: they are rows an operator adds by hand in the Zoho
 * console (see catalyst-backend/scripts/create-tables.md). Until they do, an
 * update naming them fails and would take the postal code change down with
 * it, so the stamp is dropped and the change lands. Same trade, and the same
 * reason, as campaign_members.referral_code in routes/campaigns.js: the
 * feature is the change, the stamp is the audit nicety.
 */
async function writeProfile(catalystApp, fields) {
  try {
    await datastore.updateRow(catalystApp, users.USERS, fields);
    return true;
  } catch (err) {
    const trimmed = { ...fields };
    let dropped = false;
    for (const c of POSTAL_META_COLUMNS) {
      if (c in trimmed) { delete trimmed[c]; dropped = true; }
    }
    if (!dropped) throw err;
    await datastore.updateRow(catalystApp, users.USERS, trimmed);
    return false;
  }
}

/**
 * What changing to `newFsa` does to the seat this address holds, if any.
 * -> { claim, cohort, leaves } where `leaves` is true when the held cohort
 * does not cover the new area and the seat has to go back.
 *
 * A cohort with NO FSA set covers everyone, so a member never loses a seat in
 * an unscoped cohort by moving. See geo.eligibilityOf on why unscoped is
 * permissive and how it is being closed off.
 */
async function seatImpact(catalystApp, user, newFsa) {
  const addressId = seats.addressIdFor(user);
  const vertical = seats.VERTICAL_DEFAULT;
  let row = null;
  try {
    row = await seats.getClaim(catalystApp, addressId, vertical);
  } catch {
    /* Ledger unreadable. Refuse rather than guess: saving the postal code
       here could silently orphan a seat this function cannot see, and the
       member can try again in a moment. Same contract as every other read of
       this table, which fails closed. */
    throw new AppError('SERVER_ERROR',
      'We could not check your cohort just now. Please try again shortly.', {
        logDetail: 'postal change refused: seat_claim unreadable',
      });
  }
  const claim = seats.publicClaim(row);
  if (!claim || claim.status !== 'active') return { claim: null, cohort: null, leaves: false };
  const cat = await catalog.load(catalystApp);
  const cohort = cat.byId.get(claim.cohort_id) || null;
  const fsas = (cohort && cohort.fsas) || [];
  return { claim, cohort, leaves: Boolean(fsas.length) && !fsas.includes(newFsa) };
}

function mount(router) {
  /**
   * Update the profile fields a member may change about themselves. Selective:
   * only the keys present in the body are touched, so saving a phone number
   * does not blank the postal code. Email is deliberately absent: the address
   * is the account's identity and every credential hangs off it; changing it
   * is a support conversation, not a PATCH.
   */
  router.post('/me/profile', wrap(async (req, res) => {
    const user = requireMember(req);
    const body = req.body || {};

    const fields = { ROWID: user.ROWID };
    if ('firstName' in body) {
      const first = users.firstNameFrom(user.email_normalized, body.firstName);
      if (!first) throw badRequest('Enter a first name.');
      fields.first_name = first;
    }
    if ('lastName' in body) {
      const s = String(body.lastName == null ? '' : body.lastName).trim().slice(0, 100);
      fields.last_name = s || null;
    }
    if ('phone' in body) {
      const s = String(body.phone == null ? '' : body.phone).replace(/[^\d+\-() .]/g, '').trim().slice(0, 32);
      fields.phone = s || null;
    }
    /* THE POSTAL CODE IS THE COHORT, so it is the one profile field with a
       consequence beyond itself and the only one that can refuse. Everything
       it can do is below; the plain fields above cannot reach any of it. */
    let postalChange = null;
    if ('postalCode' in body) {
      const raw = String(body.postalCode == null ? '' : body.postalCode).trim();
      if (!raw) {
        /* Clearing it is allowed and it is not a cohort change: a household
           with no postal code is eligible for nothing, which is the state a
           new account is in, and it keeps whatever seat it already holds. */
        fields.postal_code = null;
        fields.fsa = null;
      } else {
        const parsed = geo.normalizePostalCode(raw);
        if (parsed.error) {
          throw badRequest('That doesn’t look like a Canadian postal code. Check it and try again.', {
            logDetail: `postal rejected, length ${raw.length}`,
          });
        }
        fields.postal_code = parsed.postal_code;
        /* Derived here, never taken from the client: the FSA decides the
           cohort, so a member who could send one could pick any cohort. */
        fields.fsa = parsed.fsa;
        if (parsed.fsa !== (user.fsa || null)) postalChange = parsed;
      }
    }
    if ('provinceCode' in body) {
      const s = String(body.provinceCode || '').trim().toUpperCase().slice(0, 2);
      fields.province_code = s || null;
    }

    if (Object.keys(fields).length === 1) {
      throw badRequest('Nothing to update.');
    }

    const app = catalyst(req);
    let left = null;

    if (postalChange) {
      /* Limited only when the FSA actually moves. Correcting the last three
         characters of your own postal code is not cohort shopping, and a
         member who mistyped an LDU twice should not be locked out of fixing
         it a third time. */
      if (!await ratelimit.withinLimitFor(app, req, user.user_id,
        { key: 'me.postal', max: POSTAL_CHANGE_MAX, windowSec: POSTAL_CHANGE_WINDOW_SEC })) {
        throw new AppError('RATE_LIMITED',
          'You’ve changed your postal code a few times today. Try again tomorrow, or message us if you’ve moved.', {
            logDetail: `postal change limit for ${user.user_id}`,
            headers: { 'Retry-After': String(POSTAL_CHANGE_WINDOW_SEC) },
            extra: { reason: 'postal_code_change_limit' },
          });
      }

      fields.postal_code_updated_at = datastore.nowDb();
      fields.postal_code_source = 'profile_edit';

      const impact = await seatImpact(app, user, postalChange.fsa);
      if (impact.leaves) {
        const now = Date.now();
        /* THE SEAL OUTRANKS THE CONFIRMATION. Once a cohort's roster is fixed
           its households are its brief, and partners are bidding against that
           count: a seat cannot be handed back after the seal by any route, and
           a postal code change is not a way around the rule that
           POST /cohorts/:id/leave enforces to its face. The household keeps
           the seat and the cohort it is in; the postal code waits. */
        if (!cohorts.joinsOpen(impact.cohort, now)) {
          throw new AppError('SEAL_RACE',
            `${impact.cohort.region} has sealed, so your place in it is fixed for this round. `
            + 'Your postal code can change once the cohort finishes.', {
              logDetail: `postal change refused: ${impact.cohort.id} past join window`,
              extra: { reason: 'cohort_sealed', cohort: { id: impact.cohort.id, region: impact.cohort.region } },
            });
        }
        /* AN EXPLICIT SECOND ANSWER, because the cost is not on the screen
           the member is looking at. They opened a postal code field; the
           consequence is leaving a cohort, and a field that quietly does that
           is a field that lies about what it is. The client renders the
           confirmation from this refusal rather than deciding for itself when
           to show one, so a client that has never heard of cohorts cannot
           skip it. */
        if (body.confirmLeaveCohort !== true) {
          throw new AppError('CONFLICT',
            `${impact.cohort.region} covers your current postal code, not the new one. `
            + 'Save the change and you’ll leave the cohort.', {
              logDetail: `postal change needs confirmation: leaves ${impact.cohort.id}`,
              extra: {
                reason: 'leave_cohort_required',
                cohort: { id: impact.cohort.id, region: impact.cohort.region, sub: impact.cohort.sub || '' },
              },
            });
        }

        /* The seat goes back FIRST and the postal code follows, so the two
           can never disagree in the direction that matters: a household
           holding a seat in a cohort that does not cover it is a household
           counted on a partner's desk under a false address. 'moving' is the
           ledger's own word for this and it is already in seats.REASONS. */
        await seats.transition(app, {
          user, addressId: seats.addressIdFor(user), vertical: seats.VERTICAL_DEFAULT,
          action: 'leave', fromCohortId: impact.cohort.id, toCohortId: null,
          reason: 'moving', requestId: seats.cleanRequestId(req.get('Idempotency-Key')),
        });
        try {
          const held = await datastore.findBy(app, cohorts.MEMBERS_TABLE, 'membership_key',
            `${impact.cohort.id}:${user.user_id}`, ['ROWID']);
          if (held) await datastore.deleteRow(app, cohorts.MEMBERS_TABLE, held.ROWID);
        } catch {
          /* Snapshot row missing or unreadable: the claim is the truth and it
             is already released. seatCount reads both and counts the union. */
        }
        cohorts.invalidate(impact.cohort.id);
        await seats.recount(app, impact.cohort.id);
        left = { id: impact.cohort.id, region: impact.cohort.region };
      }
    }

    try {
      await writeProfile(app, fields);
    } catch (err) {
      if (left) {
        /* The seat was released for a change that then failed to save. Put it
           back rather than leave the household seatless AND unmoved, which is
           the one outcome worse than either. If this throws in turn, the seat
           ledger's own contract applies: nothing silently no-ops, and the
           failure is loud. */
        await seats.transition(app, {
          user, addressId: seats.addressIdFor(user), vertical: seats.VERTICAL_DEFAULT,
          action: 'rejoin', fromCohortId: null, toCohortId: left.id,
          reason: null, requestId: null,
        });
        cohorts.invalidate(left.id);
        await seats.recount(app, left.id);
      }
      throw err;
    }

    const fresh = await users.findById(app, user.user_id);

    audit.recordAsync(app, req, {
      type: 'member.profile.update',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: {
        fields: Object.keys(fields).filter((k) => k !== 'ROWID'),
        /* The FSA and the cohort left, never the postal code: the audit trail
           answers "did this account hop between cohorts" without becoming a
           second copy of where everybody lives. `return_to` is the campaign
           the member was reading when they changed it, which is the whole
           shape of a hop. */
        fsa: postalChange ? postalChange.fsa : undefined,
        left_cohort: left ? left.id : undefined,
        return_to: postalChange && body.returnTo ? String(body.returnTo).slice(0, 64) : undefined,
      },
    });

    const payload = {
      ok: true,
      user: sessions.publicUser({ ...user, ...fresh }),
      leftCohort: left,
    };

    /* WHAT THIS CHANGE DID TO THE COHORT THEY WERE LOOKING AT. The member
       reached this field from a campaign page that told them it was not their
       area, and the answer they came for is whether it is now. Recomputed
       server side against the SAVED row, so the page they land back on cannot
       show a join button the join route would refuse. An unknown or archived
       slug answers null and the client returns them to the dashboard. */
    if (body.returnTo) {
      const cat = await catalog.load(app, { fresh: true });
      const target = cat.byId.get(String(body.returnTo).trim());
      if (target && target.kind !== 'archived') {
        const now = Date.now();
        const st = cohorts.state(target, await cohorts.seatCount(app, target), now);
        const standing = await datastore.findBy(app, cohorts.MEMBERS_TABLE, 'membership_key',
          `${target.id}:${user.user_id}`, ['status']).catch(() => null);
        payload.returnTo = {
          id: target.id,
          eligibility: cohorts.eligibilityFor(st, (fresh && fresh.fsa) || null, standing),
        };
      } else {
        payload.returnTo = null;
      }
    }

    res.status(200).json(payload);
  }));

  /** The preference blob, whichever dashboard is asking. -> { ok, prefs } */
  router.get('/me/prefs', wrap(async (req, res) => {
    const user = requireUser(req);
    res.status(200).json({ ok: true, prefs: await prefs.get(catalyst(req), user.user_id) });
  }));

  /**
   * Merge preference keys. The caller owns whole top-level keys ('alerts',
   * 'interests', 'notify', 'services') and sends complete values for them.
   * -> { ok, prefs }
   *
   * 'services' is the join page's "do you have any of these too?" checklist:
   * [{ service, count, detail }]. It belongs to the account rather than to the
   * lead row that also records it, because it is a standing fact about the
   * household, what else they buy, and therefore what else a cohort could
   * ever be bid for, not a snapshot of one form submission.
   */
  router.post('/me/prefs', wrap(async (req, res) => {
    const user = requireUser(req);
    const body = req.body || {};
    const patch = {};
    for (const key of ['alerts', 'interests', 'notify', 'services']) {
      if (key in body) patch[key] = body[key];
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to save.');

    const merged = await prefs.merge(catalyst(req), user.user_id, patch);
    res.status(200).json({ ok: true, prefs: merged });
  }));

  /**
   * Record feedback: a provider rating, an open note, an outage report, an
   * interest signal.
   * -> { ok }. A failure is a failure: the dashboards only say "logged"
   * when it was.
   */
  router.post('/me/event', wrap(async (req, res) => {
    const user = requireUser(req);
    const body = req.body || {};
    const kind = String(body.kind || '').trim();
    if (!EVENT_KINDS.has(kind)) throw badRequest('Unknown event kind.');

    await ratelimit.enforce(catalyst(req), req, { key: 'me.event.ip', max: 60, windowSec: 3600 });

    try {
      await recordEvent(catalyst(req), user, kind, body.payload);
    } catch (err) {
      throw badRequest('That could not be recorded right now. Please try again shortly.', {
        logDetail: `user_events write failed: ${String((err && err.message) || err).slice(0, 200)}`,
      });
    }

    audit.recordAsync(catalyst(req), req, {
      type: 'member.event',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { kind },
    });

    res.status(200).json({ ok: true });
  }));

  /**
   * The member's share code and how many accounts were created with it.
   * -> { ok, code, joined, pending }
   *
   * `joined` counts verified accounts only. `pending` counts signups that used
   * the code and never proved their address, kept separate so the number on
   * the dashboard cannot be moved by anyone who can reach a signup form.
   *
   * The share link is built by the browser from its own origin rather than
   * returned here: this function has no notion of which host served the page,
   * and a link is not worth threading the base URL through the route for.
   */
  router.get('/me/referral', wrap(async (req, res) => {
    const user = requireMember(req);
    const code = referralCodeFor(user);

    /* The member's opaque token, minted lazily here for accounts that predate
     * the `referral_token` table: this read IS the backfill, no migration
     * script exists. In the response since the share sheet shipped: the
     * dashboard hands out the token wherever one exists, because the legacy
     * code is a literal prefix of the member's UUID and the token discloses
     * nothing. `token` is null until the referral_token table is provisioned,
     * and the client falls back to the legacy code, so nothing waits on the
     * console. */
    const shareToken = await referral.tokenFor(catalyst(req), user);
    const count = await referral.countFor(catalyst(req), [code, shareToken], user.user_id);

    res.status(200).json({ ok: true, code, token: shareToken || null, joined: count.joined, pending: count.pending });
  }));

  /**
   * Everything this account owns, in one JSON document. PIPEDA's access right,
   * self-serve: the browser downloads the response as a file. Each table is
   * read best-effort: an unprovisioned table appears as an empty list, not as
   * a failed export.
   */
  router.get('/me/export', wrap(async (req, res) => {
    const user = requireUser(req);
    const app = catalyst(req);
    const uid = user.user_id;

    const rows = async (table, cols) => {
      try {
        return await datastore.queryAll(app, table, cols, `user_id = ${datastore.lit(uid)}`);
      } catch { return []; }
    };
    const strip = (list) => list.map(({ ROWID, ...rest }) => rest);

    const bill = await (async () => {
      try {
        const row = await datastore.findBy(app, 'member_bills', 'user_id', uid,
          ['provider', 'monthly_cost', 'download_speed', 'access_tech', 'promo_end_date',
            'promo_expired', 'contract_start_date', 'contract_length',
            'switch_threshold', 'source', 'updated_at']);
        if (!row) return null;
        const { ROWID, ...rest } = row;
        return rest;
      } catch { return null; }
    })();

    const doc = {
      exportedAt: new Date().toISOString(),
      account: sessions.publicUser(user),
      bill,
      campaigns: strip(await rows('campaign_members', ['campaign_id', 'status', 'fsa', 'joined_at'])),
      consents: strip(await rows('consents', ['doc_type', 'doc_version', 'accepted_at'])),
      preferences: await prefs.get(app, uid),
      feedback: strip(await rows(EVENTS, ['kind', 'payload', 'created_at'])),
    };

    audit.recordAsync(app, req, {
      type: 'member.export',
      outcome: 'success',
      userId: uid,
      email: user.email_normalized,
    });

    res.status(200).json({ ok: true, data: doc });
  }));

  /**
   * Delete the account. The typed email is the confirmation: a button that
   * deletes on one click is how support tickets are born. Sessions are revoked
   * first, owned rows deleted, and the users row scrubbed rather than removed:
   * the row anchors the audit trail, but nothing personal stays on it. The
   * email slot is rewritten to a tombstone so the address can sign up fresh.
   */
  router.post('/me/delete', wrap(async (req, res) => {
    const user = requireUser(req);
    const app = catalyst(req);
    const typed = users.normalizeEmail((req.body || {}).confirmEmail || '');
    if (!typed || typed !== user.email_normalized) {
      throw badRequest('Type the account email exactly to confirm deletion.');
    }

    // The audit row is written first, while the email is still real.
    await audit.record(app, req, {
      type: 'member.delete',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
    });

    await sessions.revokeAllForUser(app, user.user_id);

    const dropWhere = async (table) => {
      try {
        const rows = await datastore.queryAll(app, table, ['user_id'],
          `user_id = ${datastore.lit(user.user_id)}`);
        for (const row of rows) {
          try { await datastore.deleteRow(app, table, row.ROWID); } catch { /* keep going */ }
        }
      } catch { /* table missing: nothing to delete */ }
    };
    await dropWhere('credentials');
    await dropWhere('auth_identities');
    await dropWhere('member_bills');
    await dropWhere('campaign_members');
    await dropWhere(EVENTS);
    try {
      const p = await datastore.findBy(app, prefs.TABLE, 'pref_key', user.user_id, ['ROWID']);
      if (p) await datastore.deleteRow(app, prefs.TABLE, p.ROWID);
    } catch { /* ditto */ }

    await datastore.updateRow(app, users.USERS, {
      ROWID: user.ROWID,
      status: 'deleted',
      email_normalized: `deleted:${user.user_id}`.slice(0, 255),
      email_display: 'Deleted account',
      first_name: null,
      last_name: null,
      postal_code: null,
      fsa: null,
      province_code: null,
      phone: null,
      referral_code: null,
    });

    cookies.clear(req, res);
    res.status(200).json({ ok: true });
  }));
}

/** The Catalyst app for this request: one name for it in every route above. */
const catalyst = (req) => req.catalyst;

module.exports = { mount, referralCodeFor, EVENTS };
