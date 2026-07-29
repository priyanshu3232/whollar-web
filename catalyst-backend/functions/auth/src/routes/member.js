'use strict';

/**
 * The member's own data: the bill behind the dashboard's switch file.
 *
 * This is the first authenticated data API — everything else the dashboard
 * shows is still demo scaffolding. Two routes, one row per member:
 *
 *   GET  /me/bill   what the server knows about this member's bill
 *   POST /me/bill   replace it (the checkup and the dashboard both call this)
 *
 * Everything is keyed on `users.user_id`, never on the email string. The email
 * appears in exactly one place: the one-time BACKFILL. The public bill checkup
 * writes unauthenticated leads to `BillCheckupSubmissions` keyed by whatever
 * email the visitor typed, and people run the checkup before they have an
 * account. So the first time a member asks for their bill and `member_bills`
 * has nothing, we look their email up in the lead table, copy the latest
 * submission across under their user_id, and from then on the lead table is
 * never consulted for them again. That copy is what links "the person who ran
 * the checkup" to "the account that signed in" across devices.
 *
 * The same-device link (a checkup done signed-out, with no email at all) is
 * closed on the client instead: whollar-core.js keeps the completed checkup as
 * a pending handoff and POSTs it here after sign-in.
 */

const datastore = require('../lib/datastore');
const audit = require('../lib/audit');
const { wrap, badRequest, unauthorized, forbidden } = require('../lib/errors');

const TABLE = 'member_bills';

/**
 * The public checkup's lead table, owned by the formSubmit function and
 * created in the console long before this file existed. Read-only here, and
 * only inside the backfill; column names are its PascalCase, not our
 * snake_case.
 */
const LEADS_TABLE = 'BillCheckupSubmissions';

/* ------------------------------------------------------------------ *
 * Field hygiene
 * ------------------------------------------------------------------ */

/** Trimmed, length-capped string, or null. Never an empty string. */
function str(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().slice(0, max);
  return s || null;
}

/**
 * A dollar amount as a canonical string, or null. Stored as text (see
 * schema.js) but validated as a number so "abc" and a 7-figure "bill" are
 * refused rather than rendered back at the member later.
 */
function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10000) return null;
  return String(Math.round(n * 100) / 100);
}

/** 'YYYY-MM-DD' or 'YYYY-MM' with a real month, or null. */
function promoEnd(value) {
  const s = str(value, 10);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return s;
}

const truthy = (v) =>
  v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';

/** One shape for the wire, whichever table the row came from. */
function publicBill(row) {
  return {
    provider: row.provider || null,
    monthly: row.monthly_cost || null,
    speed: row.download_speed || null,
    tech: row.access_tech || null,
    promoEnd: row.promo_end_date || null,
    promoExpired: Boolean(Number(row.promo_expired || 0)),
    discount: row.discount_amount || null,
    threshold: row.switch_threshold || null,
    source: row.source || null,
    updatedAt: row.updated_at || null,
  };
}

/* ------------------------------------------------------------------ *
 * Backfill from the public checkup
 * ------------------------------------------------------------------ */

/**
 * The latest lead this member's email left in the public checkup, or null.
 *
 * Tries the address exactly as they typed it at signup and its lowercased
 * form — the lead table stores whatever case the checkup form was given, and
 * ZCQL offers no LOWER(), so an email cased a third way on the checkup is
 * simply not found. That is an accepted miss: the pending-handoff path on the
 * client covers the same-device case regardless of casing.
 *
 * Every failure returns null. The lead table belongs to another function; it
 * being renamed, empty, or mid-migration must degrade to "no earlier checkup",
 * never to a 500 on the member's dashboard.
 */
async function latestLead(catalystApp, user) {
  const candidates = [...new Set(
    [user.email_display, user.email_normalized].filter(Boolean)
  )];

  for (const email of candidates) {
    try {
      const rows = await datastore.query(
        catalystApp, LEADS_TABLE,
        `SELECT ROWID, Provider, MonthlyCost, DownloadSpeed, AccessTech, ` +
        `PromoEndDate, PromoExpired, DiscountAmount, SwitchThreshold ` +
        `FROM ${LEADS_TABLE} WHERE Email = ${datastore.lit(email)} ` +
        `ORDER BY ROWID DESC LIMIT 1`
      );
      if (rows[0]) return rows[0];
    } catch {
      // lit() rejecting an odd address, or the table missing: not found —
      // fall through to the next candidate rather than aborting the search.
    }
  }
  return null;
}

/** A lead row reshaped into a member_bills row (without user_id/source). */
function fromLead(lead) {
  return {
    provider: str(lead.Provider, 100),
    monthly_cost: money(lead.MonthlyCost),
    download_speed: str(lead.DownloadSpeed, 16),
    access_tech: str(lead.AccessTech, 32),
    promo_end_date: promoEnd(lead.PromoEndDate),
    promo_expired: truthy(lead.PromoExpired) ? 1 : 0,
    discount_amount: money(lead.DiscountAmount),
    switch_threshold: str(lead.SwitchThreshold, 64),
  };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

function requireMember(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  if (req.auth.user.user_type !== 'member') {
    throw forbidden('This account is not a member account.', {
      logDetail: 'non-member hit /me/bill',
    });
  }
  return req.auth.user;
}

function mount(router) {
  /**
   * What the server knows about this member's bill. -> { ok, bill }
   * `bill` is null for a member who has never run a checkup anywhere we can
   * see — that is a normal answer, not an error.
   */
  router.get('/me/bill', wrap(async (req, res) => {
    const user = requireMember(req);

    let row = await datastore.findBy(req.catalyst, TABLE, 'user_id', user.user_id);
    if (!row) {
      const lead = await latestLead(req.catalyst, user);
      if (lead) {
        const fields = fromLead(lead);
        row = {
          user_id: user.user_id,
          ...fields,
          source: 'bill-checkup-backfill',
          updated_at: datastore.nowDb(),
        };
        try {
          await datastore.insertRow(req.catalyst, TABLE, row);
          audit.recordAsync(req.catalyst, req, {
            type: 'member.bill.backfill',
            outcome: 'success',
            userId: user.user_id,
            email: user.email_normalized,
            detail: { lead_rowid: String(lead.ROWID) },
          });
        } catch {
          // A concurrent first-load already inserted it; serve what we built.
        }
      }
    }

    res.status(200).json({ ok: true, bill: row ? publicBill(row) : null });
  }));

  /**
   * Replace this member's bill. -> { ok, bill }
   *
   * POST rather than PUT so it rides the same CSRF and client plumbing as
   * every other state-changing auth call. The row is a replacement, not a
   * merge: the checkup always submits the full picture it has, and merging
   * would resurrect a provider the member has since corrected.
   */
  router.post('/me/bill', wrap(async (req, res) => {
    const user = requireMember(req);
    const b = req.body || {};

    const fields = {
      provider: str(b.provider, 100),
      monthly_cost: money(b.monthly),
      download_speed: str(b.speed, 16),
      access_tech: str(b.tech, 32),
      promo_end_date: promoEnd(b.promoEnd),
      promo_expired: truthy(b.promoExpired) ? 1 : 0,
      discount_amount: money(b.discount),
      switch_threshold: str(b.threshold, 64),
    };

    if (!fields.provider && !fields.monthly_cost && !fields.download_speed &&
        !fields.promo_end_date) {
      throw badRequest('There is nothing to save yet — run the checkup first.', {
        logDetail: 'bill save with no usable field',
      });
    }

    const source = b.source === 'dashboard' ? 'dashboard' : 'bill-checkup';
    const existing = await datastore.findBy(
      req.catalyst, TABLE, 'user_id', user.user_id, ['ROWID', 'user_id']
    );

    const row = { ...fields, source, updated_at: datastore.nowDb() };
    if (existing) {
      await datastore.updateRow(req.catalyst, TABLE, { ROWID: existing.ROWID, ...row });
    } else {
      await datastore.insertRow(req.catalyst, TABLE, { user_id: user.user_id, ...row });
    }

    audit.recordAsync(req.catalyst, req, {
      type: 'member.bill.save',
      outcome: 'success',
      userId: user.user_id,
      email: user.email_normalized,
      detail: { source, replaced: Boolean(existing) },
    });

    res.status(200).json({ ok: true, bill: publicBill(row) });
  }));
}

module.exports = { mount };
