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
 * appears in exactly one place: the ADOPTION of a public checkup lead. The
 * public bill checkup writes unauthenticated leads to `BillCheckupSubmissions`
 * keyed by whatever email the visitor typed, and people run the checkup before
 * they have an account. So when a member asks for their bill we look their
 * email up in the lead table and copy the latest submission across under their
 * user_id — always on the first ask, and afterwards whenever that lead is
 * NEWER than what we hold. That copy is what links "the person who ran the
 * checkup" to "the account that signed in" across devices.
 *
 * Adoption is not one-time because the checkup's own save to this table can be
 * lost: the results screen fires POST /me/bill and does not wait for it, so a
 * closed tab or a dropped connection leaves the member's newest numbers sitting
 * in the lead table with a stale row here. A lead that postdates our row is
 * therefore always the better answer — except against `source: 'dashboard'`,
 * which is the member correcting the numbers by hand and outranks any lead.
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

/**
 * Is there a bill in here at all?
 *
 * The four fields the dashboard cannot render a switch file without. This is
 * what stops an empty submission being stored as if it were a reading: the
 * checkup's quick-join rail sends a lead the moment an email is typed, long
 * before the form is filled, so "a lead exists" is not "a bill is known".
 * Adoption leans on it hardest — an empty lead that happens to be newer must
 * never blank a row that has real numbers in it.
 */
const hasSubstance = (f) => Boolean(
  f.provider || f.monthly_cost || f.download_speed || f.promo_end_date
);

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
 * Adoption from the public checkup
 * ------------------------------------------------------------------ */

/**
 * The latest lead this member's email left in the public checkup that actually
 * carries a bill, or null.
 *
 * Reads a short window rather than one row, because the newest lead is often
 * not the informative one: the checkup's quick-join rail files a lead as soon
 * as an email is typed, so an email-only row routinely sits on top of the
 * filled-in submission from the same visit. Taking `LIMIT 1` would find that
 * empty row, decline it as having nothing to adopt, and never look past it —
 * the member's real checkup would stay invisible on every subsequent load.
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
const LEAD_WINDOW = 5;

async function latestLead(catalystApp, user) {
  const candidates = [...new Set(
    [user.email_display, user.email_normalized].filter(Boolean)
  )];

  for (const email of candidates) {
    try {
      const rows = await datastore.query(
        catalystApp, LEADS_TABLE,
        `SELECT ROWID, Provider, MonthlyCost, DownloadSpeed, AccessTech, ` +
        `PromoEndDate, PromoExpired, DiscountAmount, SwitchThreshold, ` +
        `SubmittedAt, CREATEDTIME ` +
        `FROM ${LEADS_TABLE} WHERE Email = ${datastore.lit(email)} ` +
        `ORDER BY ROWID DESC LIMIT ${LEAD_WINDOW}`
      );
      for (const row of rows) {
        if (hasSubstance(fromLead(row))) return row;
      }
    } catch {
      // lit() rejecting an odd address, or the table missing: not found —
      // fall through to the next candidate rather than aborting the search.
    }
  }
  return null;
}

/**
 * Is this stored row one a public checkup lead may replace?
 *
 * Everything except the member's own dashboard edit. They typed those numbers
 * looking at the bill; a checkup they ran on a phone last month must not undo
 * the correction. Every other source (an earlier adoption, an earlier checkup)
 * is just an older reading of the same bill.
 *
 * A row without a ROWID cannot be addressed by updateRow, so it cannot be
 * replaced either — say so here rather than discovering it mid-write.
 */
const adoptable = (row) => Boolean(row.ROWID) && row.source !== 'dashboard';

/**
 * Does `lead` postdate `row`?
 *
 * `SubmittedAt` is written by formSubmit's catalystNow() and `updated_at` by
 * datastore.nowDb() — the same `YYYY-MM-DD HH:MM:SS` UTC on both sides, so the
 * comparison is between two clocks we own. `CREATEDTIME` backs it up for rows
 * an older formSubmit left the column empty on; it is Catalyst's own and its
 * format is Catalyst's choice, which fromDb parses when it can.
 *
 * Anything undateable answers false. Declining to replace a row we cannot date
 * is the safe direction: the checkup's own POST /me/bill is the primary path,
 * and this only exists to catch what that path drops.
 */
function leadIsNewer(lead, row) {
  const at = datastore.fromDb(lead.SubmittedAt) || datastore.fromDb(lead.CREATEDTIME);
  const held = datastore.fromDb(row.updated_at);
  if (!at || !held) return false;
  return at.getTime() > held.getTime();
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

    // The lead table is consulted when we hold nothing, and when what we hold
    // could be superseded by a checkup run since. See the file header.
    // latestLead only ever returns a lead with a bill in it, so the only
    // question left here is which of the two readings is more recent.
    if (!row || adoptable(row)) {
      const lead = await latestLead(req.catalyst, user);
      if (lead && (!row || leadIsNewer(lead, row))) {
        const adopted = {
          ...fromLead(lead),
          source: 'bill-checkup-backfill',
          updated_at: datastore.nowDb(),
        };
        try {
          if (row) {
            await datastore.updateRow(req.catalyst, TABLE, { ROWID: row.ROWID, ...adopted });
          } else {
            await datastore.insertRow(req.catalyst, TABLE, { user_id: user.user_id, ...adopted });
          }
          audit.recordAsync(req.catalyst, req, {
            type: 'member.bill.backfill',
            outcome: 'success',
            userId: user.user_id,
            email: user.email_normalized,
            detail: { lead_rowid: String(lead.ROWID), replaced: Boolean(row) },
          });
          row = { ...(row || {}), ...adopted };
        } catch {
          // A concurrent first-load already inserted it, or the write failed:
          // serve what we have rather than 500ing the member's dashboard.
          row = row || { user_id: user.user_id, ...adopted };
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

    if (!hasSubstance(fields)) {
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
