'use strict';

/**
 * The admin console API: the restricted control plane behind admin.whollar.ca.
 *
 * Nothing here exists unless the `admin` config group is set
 * (ADMIN_EMAIL_DOMAIN): mount() returns without adding a single route, so on
 * an environment without the group the whole surface 404s rather than
 * refusing. When it is set, the allowlist IS the identity model:
 *
 *   IDENTITY   Admins are `users` rows with user_type='admin'. There is no
 *              signup path. The only way a row acquires that type is
 *              /admin/login/verify succeeding for an allowlisted address:
 *              an email on ADMIN_EMAIL_DOMAIN (the staff domain) or listed
 *              in ADMIN_EMAILS.
 *
 *   AUTH       Email OTP, the same challenge machinery as the member flow but
 *              under its own purpose ('admin_login'), so a code minted on the
 *              member form can never be spent here. Sessions are the standard
 *              cookie sessions with the admin TTL: a 12-hour absolute
 *              ceiling, no rolling: same reasoning as the partner console,
 *              with more at stake.
 *
 *   AUTHZ      requireAdmin() on every other route: session + user_type
 *              check, generic 403 otherwise (no admin-existence oracle).
 *              CSRF rides the existing Origin allowlist: admin.whollar.ca
 *              must be in ALLOWED_ORIGINS.
 *
 *   AUDIT      Every mutation writes auth_events with a before -> after
 *              snapshot, awaited rather than fire-and-forget: for this
 *              surface a lost audit row is worse than a slower response.
 *
 * The approval invariant provider.js documents, "no code path can set
 * `approved`", ends here, deliberately: /admin/providers/:orgId/approve is
 * the one call site in the entire system that writes it, and it writes it on
 * behalf of a named human.
 */

const datastore = require('../lib/datastore');
const sessions = require('../lib/sessions');
const users = require('../lib/users');
const orgs = require('../lib/orgs');
const challenges = require('../lib/challenges');
const mailer = require('../lib/mailer');
const notify = require('../lib/notify');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');
const siteconfig = require('../lib/siteconfig');
const catalog = require('../lib/catalog');
const cohorts = require('../lib/cohorts');
const notices = require('../lib/notices');
const seats = require('../lib/seats');
const places = require('../lib/places');
const geo = require('../lib/geo');
const fsaref = require('../lib/fsaref');
const bids = require('../lib/bids');
const awards = require('../lib/awards');
const campaigns = require('./campaigns');
const desk = require('./desk');
const { wrap, badRequest, unauthorized, forbidden, AppError } = require('../lib/errors');
const { canRevealCode } = require('./otp');

const PURPOSE = 'admin_login';

/* ------------------------------------------------------------------ *
 * Allowlist + guards
 * ------------------------------------------------------------------ */

function isAllowlisted(cfg, email) {
  if (!cfg.FEATURES.admin) return false;
  if (orgs.domainOf(email) === cfg.ADMIN_EMAIL_DOMAIN) return true;
  return (cfg.ADMIN_EMAILS || []).includes(email);
}

/**
 * Session + type check. The 403 body is the generic forbidden, identical to
 * what a member gets poking at /provider/me, so probing /admin/* teaches an
 * outsider nothing beyond "not yours".
 */
function requireAdmin(req) {
  if (!req.auth) throw unauthorized('Please sign in again.');
  if (req.auth.user.user_type !== 'admin') {
    throw forbidden('You do not have access to that.', {
      logDetail: `non-admin hit ${req.path}`,
    });
  }
  return req.auth.user;
}

/** Route params that end up in ZCQL literals: bound the charset first. */
function cleanId(raw, what) {
  const s = String(raw || '').trim();
  if (!/^[A-Za-z0-9:_-]{1,130}$/.test(s)) {
    throw badRequest(`That ${what} is not valid.`);
  }
  return s;
}

/* ------------------------------------------------------------------ *
 * Read helpers
 * ------------------------------------------------------------------ */

/**
 * How many rows a table holds. COUNT first; if the environment's ZCQL
 * dialect refuses it, fall back to a capped read that answers "n" or "cap+".
 * Never rows.length of an uncapped read: that silently stops at 300 and
 * reports the ceiling as if it were the total.
 */
async function countRows(catalystApp, table, where) {
  const t = datastore.ident(table);
  const clause = where ? ` WHERE ${where}` : '';
  try {
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT COUNT(ROWID) FROM ${t}${clause}`
    );
    const first = rows && rows[0] ? (rows[0][t] || rows[0]) : null;
    if (first) {
      for (const v of Object.values(first)) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    }
  } catch { /* fall through to the capped read */ }
  try {
    const rows = await datastore.query(
      catalystApp, t, `SELECT ROWID FROM ${t}${clause} LIMIT ${datastore.MAX_ROWS}`
    );
    return rows.length >= datastore.MAX_ROWS ? `${datastore.MAX_ROWS}+` : rows.length;
  } catch (err) {
    return null; // table missing/unreadable: the overview shows a dash, not a 500
  }
}

/**
 * Newest-first page of a table. ROWID-descending with a `before` cursor:
 * the mirror of datastore.queryAll's ascending cursor, for surfaces (leads,
 * audit) where the recent rows are the interesting ones.
 */
async function recentRows(catalystApp, table, columns, { before, limit, where } = {}) {
  const t = datastore.ident(table);
  const cols = ['ROWID', 'CREATEDTIME', ...columns.filter((c) => c !== 'ROWID' && c !== 'CREATEDTIME')]
    .map(datastore.ident).join(', ');
  const parts = [];
  if (where) parts.push(where);
  if (before) parts.push(`ROWID < ${datastore.lit(before)}`);
  const clause = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const rows = await datastore.query(
    catalystApp, t,
    `SELECT ${cols} FROM ${t}${clause} ORDER BY ROWID DESC LIMIT ${n}`
  );
  return {
    rows,
    // The cursor for the next page, or null when this one came back short.
    next: rows.length === n ? rows[rows.length - 1].ROWID : null,
  };
}

/* ------------------------------------------------------------------ *
 * Lead tables the console may read. A hardcoded map, never a request value:
 * ZCQL has no parameter binding, so nothing from a URL reaches a query
 * without resolving through an allowlist first (the formSubmit pattern).
 * ------------------------------------------------------------------ */

const LEAD_TABLES = Object.freeze({
  WaitlistSignups: ['FirstName', 'LastName', 'Email', 'Phone', 'FSA', 'ReferralCode', 'SubmittedAt'],
  WaitlistDetails: ['Email', 'FSA', 'Provider', 'MonthlyCost', 'DownloadSpeed', 'PromoEndDate',
    'SwitchThreshold', 'Services', 'BillFileName', 'SubmittedAt'],
  BillCheckupSubmissions: ['Email', 'Via', 'PostalFSA', 'Provider', 'MonthlyCost', 'DownloadSpeed',
    'AccessTech', 'PromoEndDate', 'MonthsToRenewal', 'PromoExpired', 'ContractStartDate',
    'ContractLength', 'SwitchThreshold', 'BillFileName', 'SubmittedAt'],
  DeepReadRequests: ['Email', 'Note', 'FileNames', 'SubmittedAt'],
  PartnerApplications: ['Role', 'FirstName', 'LastName', 'Company', 'Email', 'Phone', 'Provinces',
    'AccessTech', 'LegalName', 'ProviderType', 'BusinessNumber', 'Brands', 'Signatory',
    'RepresentsBrands', 'LOA', 'OtherType', 'Note', 'SubmittedAt'],
  CalculatorEstimates: ['PostalCode', 'FSA', 'MonthlyBill', 'EstimatedAnnualSavings', 'SubmittedAt'],
  ContactSubmissions: ['FirstName', 'LastName', 'Email', 'Phone', 'Company', 'Topic', 'Message', 'SubmittedAt'],
  CrmSyncQueue: ['Source', 'SourceRowId', 'Email', 'LeadType', 'Status', 'Attempts', 'LastError', 'SyncedAt'],
});

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

function mount(router, cfg) {
  // No config group, no surface. Everything under /admin falls through to the
  // app-level 404: indistinguishable from the route never having existed.
  if (!cfg.FEATURES.admin) return;

  /* ---------------- sign-in (no session required) ---------------- */

  /**
   * Issue a staff login code. The domain gate answers plainly rather than
   * opaquely, which addresses are staff addresses is not a secret worth a
   * confusing form, and a staff member who typoes the domain needs to be told.
   */
  router.post('/admin/login/start', wrap(async (req, res) => {
    const email = users.normalizeEmail((req.body && req.body.email) || '');
    if (!users.isEmail(email)) throw badRequest('Enter a valid email address.');
    if (!isAllowlisted(cfg, email)) {
      throw forbidden(`Use your @${cfg.ADMIN_EMAIL_DOMAIN} staff email address.`, {
        logDetail: 'admin login: address not allowlisted',
      });
    }

    await ratelimit.enforce(req.catalyst, req, { key: 'admin.start.ip', max: 10, windowSec: 3600 });
    await ratelimit.enforceFor(req.catalyst, req, email, { key: 'admin.start.email', max: 5, windowSec: 3600 });

    const { code, ttlMinutes } = await challenges.start(req.catalyst, req, { email, purpose: PURPOSE });
    // Best-effort personalisation; a miss or a lookup failure sends the same
    // email with the bare greeting.
    const known = await users.findByEmail(req.catalyst, email).catch(() => null);
    const sent = await notify.dispatch(req, {
      templateKey: 'account.otp',
      eventKey: `admin.login:${req.id}`,
      to: email,
      user: known,
      context: { code, purpose: 'login', ttl_minutes: ttlMinutes },
    });
    const delivered = Boolean(sent.delivered);

    audit.recordAsync(req.catalyst, req, {
      type: 'admin.login.start', outcome: 'success', email,
      detail: {
        delivered,
        transport: sent.transport || mailer.transportName(cfg),
        outbox_status: sent.status,
        send_error: sent.sendError || null,
      },
    });

    const body = { ok: true, ttlMinutes };
    if (canRevealCode(cfg)) {
      body.dev = { note: 'No mail provider configured: code returned here instead.', code };
    }
    res.status(200).json(body);
  }));

  /**
   * Check the code and start an admin session.
   *
   * This is the ONLY place an account acquires user_type 'admin': a fresh
   * allowlisted address gets a new admin row; an existing member row on the
   * staff domain is promoted (and the promotion audited). A provider row is
   * refused outright: a partner org on the staff domain would be a
   * configuration accident, not a login.
   */
  router.post('/admin/login/verify', wrap(async (req, res) => {
    const email = users.normalizeEmail((req.body && req.body.email) || '');
    const code = String((req.body && req.body.code) || '').trim();

    if (!users.isEmail(email)) throw badRequest('Enter a valid email address.');
    if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code from your email.');
    if (!isAllowlisted(cfg, email)) {
      throw forbidden(`Use your @${cfg.ADMIN_EMAIL_DOMAIN} staff email address.`, {
        logDetail: 'admin verify: address not allowlisted',
      });
    }

    await ratelimit.enforce(req.catalyst, req, { key: 'admin.verify.ip', max: 30, windowSec: 3600 });

    const result = await challenges.verify(req.catalyst, req, { email, code, purpose: PURPOSE });
    if (!result.ok) {
      audit.recordAsync(req.catalyst, req, {
        type: 'admin.login', outcome: 'failure', email,
        detail: { reason: result.reason, remaining: result.remaining },
      });
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: `admin verify failed: ${result.reason}`,
      });
    }

    let { user, created } = await users.findOrCreate(req.catalyst, {
      email, userType: 'admin',
    });

    if (user.user_type === 'provider') {
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: 'admin verify: address belongs to a provider account',
      });
    }
    if (user.status !== 'active') {
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: `admin verify: account status ${user.status}`,
      });
    }

    if (!created && user.user_type !== 'admin') {
      // A member row on the staff domain: promote it, on the record.
      await datastore.updateRow(req.catalyst, users.USERS, { ROWID: user.ROWID, user_type: 'admin' });
      await audit.record(req.catalyst, req, {
        type: 'admin.promote', outcome: 'success', email, userId: user.user_id,
        detail: { from: user.user_type, to: 'admin', by: 'allowlist' },
      });
      user = { ...user, user_type: 'admin' };
    }

    if (created) {
      await users.linkIdentity(req.catalyst, {
        userId: user.user_id, provider: 'otp',
        providerUid: user.user_id, emailAtProvider: email,
      });
    }

    await users.touchLastLogin(req.catalyst, user);
    const session = await sessions.create(req.catalyst, req, res, {
      userId: user.user_id, userType: 'admin',
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'admin.login', outcome: 'success', email, userId: user.user_id,
      detail: { created },
    });

    res.status(200).json({
      ok: true,
      user: sessions.publicUser(user),
      expiresAt: session.expiresAt,
    });
  }));

  /** Who am I, admin-shaped. The console's boot call. */
  router.get('/admin/me', wrap(async (req, res) => {
    const user = requireAdmin(req);
    res.status(200).json({ ok: true, user: sessions.publicUser(user) });
  }));

  /* ---------------- overview ---------------- */

  /**
   * Situational awareness in one call: lead volumes, CRM queue health,
   * pending approvals, campaign membership, and the state of the kill switch.
   * Every count survives its table being missing (null -> the console shows
   * a dash), because the overview must render on a half-provisioned console.
   */
  router.get('/admin/overview', wrap(async (req, res) => {
    requireAdmin(req);
    const c = req.catalyst;

    const leadCounts = {};
    for (const table of Object.keys(LEAD_TABLES)) {
      if (table === 'CrmSyncQueue') continue;
      leadCounts[table] = await countRows(c, table);
    }

    const crm = {};
    for (const status of ['PENDING', 'SYNCED', 'FAILED']) {
      crm[status.toLowerCase()] = await countRows(c, 'CrmSyncQueue', `Status = ${datastore.lit(status)}`);
    }

    const orgRows = await (async () => {
      try {
        return await datastore.queryAll(c, orgs.ORGS,
          ['org_id', 'approval_status'], 'ROWID > 0');
      } catch { return null; }
    })();
    const providerCounts = { pending: 0, approved: 0, rejected: 0 };
    if (orgRows) {
      for (const row of orgRows) {
        const s = row.approval_status || 'pending';
        providerCounts[s] = (providerCounts[s] || 0) + 1;
      }
    }

    /* The admin reads the code catalog too (it is what the import button
       imports), so this goes to catalog.load() for the rows and to the shared
       read layer for the counts, campaign by campaign. */
    const cat = await catalog.load(c, { fresh: true });
    cohorts.invalidate();
    const countBy = {};
    let countsLive = true;
    for (const k of cat.list) {
      countBy[k.id] = await cohorts.seatCount(c, k);
      if (!countBy[k.id].live) countsLive = false;
    }

    res.status(200).json({
      ok: true,
      bidding_enabled: (await siteconfig.getValue(c, 'bidding_enabled')) !== false,
      leads: leadCounts,
      crm_queue: crm,
      providers: orgRows ? providerCounts : null,
      members: await countRows(c, users.USERS, `user_type = ${datastore.lit('member')}`),
      campaigns: {
        source: cat.source,
        list: cat.list.map((k) => {
          const t = countBy[k.id];
          return {
            id: k.id, region: k.region, kind: k.kind, target: k.target,
            members: t.seats,
            households: t.seats,
            waitlist: t.waitlist,
            watching: t.watching,
            bidding_open: Boolean(k.biddingOpen),
          };
        }),
        memberships_live: countsLive,
      },
    });
  }));

  /* ---------------- site information ---------------- */

  router.get('/admin/config', wrap(async (req, res) => {
    requireAdmin(req);
    const view = await siteconfig.adminView(req.catalyst);
    res.status(200).json({ ok: true, ...view });
  }));

  /**
   * Create or update one key. Typed: the write is validated against
   * `value_type` so a stray string can never land where the site reads a
   * number. Audited with before -> after.
   */
  router.put('/admin/config/:key', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const key = String(req.params.key || '').trim();
    const body = req.body || {};

    let change;
    try {
      change = await siteconfig.setValue(req.catalyst, {
        key,
        value: body.value,
        valueType: body.value_type,
        published: body.published,
        description: body.description,
        updatedBy: admin.user_id,
      });
    } catch (err) {
      if (err instanceof TypeError) throw badRequest(err.message);
      throw new AppError('SERVER_ERROR',
        'Config is not writable right now: has the site_config table been created?', {
          logDetail: `site_config write failed: ${String((err && err.message) || err).slice(0, 200)}`,
        });
    }

    await audit.record(req.catalyst, req, {
      type: 'admin.config.set', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: { key, before: change.before, after: change.after },
    });

    res.status(200).json({ ok: true, key, ...change });
  }));

  /**
   * The global kill switch, as its own verb: it is the single most
   * consequential flag, and "POST /admin/bidding {enabled:false}" is what a
   * runbook can say unambiguously.
   */
  router.post('/admin/bidding', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const enabled = (req.body || {}).enabled;
    if (typeof enabled !== 'boolean') throw badRequest('Send { enabled: true | false }.');

    const change = await siteconfig.setValue(req.catalyst, {
      key: 'bidding_enabled', value: enabled, valueType: 'boolean',
      published: true, updatedBy: admin.user_id,
    }).catch((err) => {
      throw new AppError('SERVER_ERROR',
        'The switch is not writable right now: has the site_config table been created?', {
          logDetail: `bidding toggle failed: ${String((err && err.message) || err).slice(0, 200)}`,
        });
    });

    await audit.record(req.catalyst, req, {
      type: 'admin.bidding.toggle', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: { before: change.before, after: change.after },
    });

    res.status(200).json({ ok: true, bidding_enabled: enabled });
  }));

  /* ---------------- campaigns ---------------- */

  router.get('/admin/campaigns', wrap(async (req, res) => {
    requireAdmin(req);
    const cat = await catalog.load(req.catalyst, { fresh: true });
    cohorts.invalidate();
    const countBy = {};
    let countsLive = true;
    for (const c of cat.list) {
      countBy[c.id] = await cohorts.seatCount(req.catalyst, c);
      if (!countBy[c.id].live) countsLive = false;
    }
    res.status(200).json({
      ok: true,
      source: cat.source,
      memberships_live: countsLive,
      campaigns: cat.list.map((c) => {
        const t = countBy[c.id];
        return {
          id: c.id, region: c.region, sub: c.sub, kind: c.kind, target: c.target,
          /* Recorded on the row and shown here as configuration. NO COUNT
             ADDS THEM: every household figure on every surface is a live
             count over the ledger and the snapshot table. */
          seed_members: c.seedMembers, seed_households: c.seedHouseholds,
          members: t.seats,
          households: t.seats,
          waitlist: t.waitlist,
          watching: t.watching,
          bidding_open: Boolean(c.biddingOpen),
          sort_order: c.sortOrder,
          /* Epoch ms per calendar column, so the console can render and edit
             the schedule it could previously only see in ZCQL. */
          dates: c.dates || {},
        };
      }),
    });
  }));

  /**
   * Drift detector: what members see, what partners see, and what the raw
   * tables say, side by side. -> { ok, serverTime, source, surfaces, campaigns, orphans, mismatches }
   *
   * Both dashboards read lib/cohorts.js, so by construction they cannot
   * disagree; this endpoint is what proves that on a live store and catches
   * the day someone forks a projection. Each campaign is projected through
   * the SAME forMember/forPartner the public routes use, and its household
   * figure is then checked against three raw reads: active seat claims,
   * snapshot rows standing as joined, and the stored roster_count sidecar.
   * Anything that disagrees is a named mismatch, and the console renders
   * the list rather than a green tick it cannot back.
   *
   * Two full-table reads (seat_claim active, campaign_members) find rows
   * naming a campaign the catalog no longer has: a ghost a dashboard would
   * never render but a count could silently include. Bounded by queryAll's
   * page budget, which is stated in the payload rather than hidden.
   */
  /**
   * Force a stage-notice pass, and WAIT for it.
   *
   * The same sweep every dashboard read fires, run on demand and answered with
   * its result. It exists for the case the read path cannot cover: an operator
   * moving a cohort through its stages with nobody else on the site, where
   * there is no dashboard load to trigger anything. Also the honest way to see
   * what a stage change actually mailed, since the read path deliberately
   * throws that number away.
   *
   * Idempotent, because the sweep is: a stage already announced is skipped on
   * the unique constraint, so pressing this twice sends nothing twice.
   */
  router.post('/admin/campaigns/notices/sweep', wrap(async (req, res) => {
    requireAdmin(req);
    cohorts.invalidate();
    const { states, serverTime } = await cohorts.list(req.catalyst, { fresh: true });
    const result = await notices.sweep(req.catalyst, cfg, states, serverTime);
    audit.recordAsync(req.catalyst, req, {
      type: 'admin.campaign.notices', outcome: 'success',
      detail: result,
    });
    res.status(200).json({ ok: true, serverTime, ...result });
  }));

  router.get('/admin/campaigns/reconcile', wrap(async (req, res) => {
    requireAdmin(req);
    const c = req.catalyst;
    cohorts.invalidate();
    const enabled = (await siteconfig.getValue(c, 'bidding_enabled')) !== false;
    const { source, live, serverTime, states } = await cohorts.list(c, { fresh: true, includeArchived: true });
    const known = new Set(states.map((s) => s.id));

    const mismatches = [];
    if (source !== 'table') {
      mismatches.push({ kind: 'code_catalog', campaign: null,
        detail: 'The campaigns table is empty or unreadable: members and partners are shown nothing until it is imported.' });
    }

    const rows = [];
    for (const s of states) {
      const member = cohorts.forMember(s, undefined);
      const partner = cohorts.forPartner(s, enabled);
      let claims = null; let joinedRows = null; let stored = null;
      try {
        claims = (await datastore.queryAll(c, cohorts.CLAIM_TABLE, ['member_id'],
          `cohort_id = ${datastore.lit(s.id)} AND status = 'active'`)).length;
      } catch { claims = null; }
      try {
        const mrows = await datastore.queryAll(c, cohorts.MEMBERS_TABLE, ['user_id', 'status'],
          `campaign_id = ${datastore.lit(s.id)}`);
        joinedRows = mrows.filter((r) => catalog.standingOf(r.status, s.campaign) === 'joined').length;
      } catch { joinedRows = null; }
      const counter = await seats.counterFor(c, s.id);
      stored = counter ? counter.roster_count : null;

      const row = {
        id: s.id, region: s.region, kind: s.kind,
        member_visible: cohorts.memberVisible(s),
        partner_listed: s.kind !== 'archived',
        partner_biddable: partner.bidding_open,
        member_stage: member.stage, partner_stage: partner.stage,
        households_member: member.households,
        households_partner: partner.households,
        seat_claims: claims, joined_rows: joinedRows, roster_count_stored: stored,
        count_live: s.countLive,
        fsas: s.fsas,
      };
      rows.push(row);

      /* THE UNSCOPED LIST, and the reason this drift report is where it goes.
         A campaign taking joins with no FSA set is open to every household in
         Canada. That is the pre-coverage behaviour and it is deliberately not
         broken by the deploy (geo.eligibilityOf says why), but it is a state
         that should end, and a state that ends only if somebody can see it.
         Nothing else on any surface says which cohorts are still in it. */
      if (s.joinable && !s.fsas.length) {
        mismatches.push({ kind: 'unscoped_campaign', campaign: s.id,
          detail: `${s.region} takes joins and covers no FSAs, so every household in Canada is eligible for it. Set its postal code areas.` });
      }

      if (member.households !== partner.households) {
        mismatches.push({ kind: 'surface_count', campaign: s.id,
          detail: `Members see ${member.households} households, partners see ${partner.households}.` });
      }
      if (stored !== null && claims !== null && stored !== claims) {
        mismatches.push({ kind: 'counter_drift', campaign: s.id,
          detail: `cohort_counter says ${stored}, the ledger holds ${claims} active claims. Nothing renders the counter; the next seat transition recounts it.` });
      }
      if (claims !== null && joinedRows !== null && joinedRows > claims && s.kind !== 'archived') {
        mismatches.push({ kind: 'legacy_rows', campaign: s.id,
          detail: `${joinedRows - claims} joined rows carry no seat claim (joined before the ledger). They are counted; they hold no seat.` });
      }
      if (!s.countLive) {
        mismatches.push({ kind: 'count_unreadable', campaign: s.id,
          detail: 'A count table was unreadable; the figure shown is a floor.' });
      }
    }

    /* Ghost rows: memberships or claims naming a campaign the catalog does
       not carry. Full reads, bounded by the page budget. */
    const orphans = { claims: {}, memberships: {}, truncated: false };
    try {
      const all = await datastore.queryAll(c, cohorts.CLAIM_TABLE, ['cohort_id'], `status = 'active'`);
      for (const r of all) if (r.cohort_id && !known.has(String(r.cohort_id))) {
        orphans.claims[r.cohort_id] = (orphans.claims[r.cohort_id] || 0) + 1;
      }
      if (all.length >= 15000) orphans.truncated = true;
    } catch { /* ledger unreadable: reported per campaign above */ }
    try {
      const all = await datastore.queryAll(c, cohorts.MEMBERS_TABLE, ['campaign_id', 'status'], 'ROWID > 0');
      for (const r of all) if (r.campaign_id && !known.has(String(r.campaign_id)) && r.status !== 'alert') {
        orphans.memberships[r.campaign_id] = (orphans.memberships[r.campaign_id] || 0) + 1;
      }
      if (all.length >= 15000) orphans.truncated = true;
    } catch { /* snapshot unreadable: reported per campaign above */ }
    for (const [id, n] of Object.entries(orphans.claims)) {
      mismatches.push({ kind: 'orphan_claims', campaign: id,
        detail: `${n} active seat claims name a campaign the catalog does not carry.` });
    }
    for (const [id, n] of Object.entries(orphans.memberships)) {
      mismatches.push({ kind: 'orphan_memberships', campaign: id,
        detail: `${n} membership rows name a campaign the catalog does not carry.` });
    }

    const memberIds = states.filter(cohorts.memberVisible).map((s) => s.id);
    const partnerIds = states.filter((s) => s.kind !== 'archived').map((s) => s.id);
    const biddable = states.filter((s) => cohorts.partnerBiddable(s, enabled)).map((s) => s.id);
    res.status(200).json({
      ok: true,
      serverTime,
      source,
      counts_live: live,
      surfaces: {
        member: memberIds,
        partner: partnerIds,
        partner_biddable: biddable,
        member_only: memberIds.filter((id) => !partnerIds.includes(id)),
        partner_only: partnerIds.filter((id) => !memberIds.includes(id)),
      },
      campaigns: rows,
      orphans,
      mismatches,
    });
  }));

  /** Validate the editable fields of a campaign body. Throws 400s. */
  function campaignFields(body, { partial = false } = {}) {
    const out = {};
    const has = (k) => body[k] !== undefined;
    const int = (k, v, min, max) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw badRequest(`${k} must be a whole number between ${min} and ${max}.`);
      }
      return n;
    };
    if (has('region') || !partial) {
      const r = String(body.region || '').trim();
      if (!r || r.length > 100) throw badRequest('region is required (up to 100 characters).');
      /**
       * THE REGION IS THE JOIN, so it is a vocabulary and not a text box.
       *
       * requireActiveCoverage() in routes/desk.js matches a bid to coverage
       * with slug(coverage.region) === slug(campaign.region), exactly. A cohort
       * named anything a partner cannot pick from the coverage picker is a
       * cohort nobody can ever bid on, and nothing about it looks wrong: it
       * renders on both dashboards, counts households, runs its clock down and
       * closes with no bids. That failure is indistinguishable from a quiet
       * market, which is why it has to be refused at the write rather than
       * found in a fortnight.
       *
       * Launch, not merely known: the picker offers only launch-city regions as
       * selectable, so a cohort in a queued city is unreachable for the same
       * reason by a different route.
       *
       * The canonical spelling is what gets stored, so 'scarborough centre'
       * and 'Scarborough Centre' cannot become two cohorts nobody can join.
       */
      if (!places.isLaunchRegion(r)) {
        const near = places.suggest(r);
        throw badRequest(
          `"${r}" is not a region a partner can declare coverage in, so no one could bid on this cohort.`
          + (near.length ? ` Did you mean ${near.join(', ')}?` : '')
          + ' The declarable list is partner/core/places.js.',
          { logDetail: `campaign region outside vocabulary: ${r}` }
        );
      }
      out.region = places.canonical(r);
    }
    if (has('fsas')) {
      /**
       * THE MEMBER KEY, and the second half of a cohort's geography. `region`
       * above decides which partners may bid; this decides which households
       * may join. Neither derives the other and both are typed by an operator,
       * so both are a vocabulary rather than a text box.
       *
       * VALIDATED AGAINST THE REFERENCE, one entry at a time, because the
       * failure of a bad FSA is the same silent one a bad region name has: a
       * cohort scoped to M9Z renders perfectly, counts nothing, and refuses
       * every household that tries to join, and it is indistinguishable from a
       * region nobody wants. A typo has to be a 400 while somebody is looking
       * at it.
       *
       * The reference is GeoNames by way of js/whollar-fsa-cities.js and it is
       * NOT the authoritative Canada Post file, which is why it gates only
       * this path and never a household's own postal code. See lib/fsaref.js.
       */
      const raw = body.fsas === null ? '' : String(body.fsas);
      if (raw.length > 4000) throw badRequest('That is more FSAs than a cohort can cover.');
      const parts = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
      const bad = [];
      const unknown = [];
      for (const part of parts) {
        if (!geo.isFsa(part)) bad.push(part.toUpperCase().slice(0, 8));
        else if (!fsaref.has(part)) unknown.push(part.toUpperCase());
      }
      if (bad.length) {
        throw badRequest(
          `${bad.slice(0, 5).join(', ')} ${bad.length === 1 ? 'is not' : 'are not'} shaped like an FSA. `
          + 'An FSA is three characters: a letter, a digit, a letter, e.g. M2N.',
          { logDetail: `campaign fsas malformed: ${bad.length}` }
        );
      }
      if (unknown.length) {
        throw badRequest(
          `${unknown.slice(0, 5).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the FSA reference. `
          + 'Check the code. The reference is js/whollar-fsa-cities.js.',
          { logDetail: `campaign fsas unknown: ${unknown.length}` }
        );
      }
      /* Stored sorted and deduplicated, so two saves of the same coverage in
         a different order are the same string and the audit diff is empty. */
      out.fsas = geo.formatFsaList(parts) || null;
    }
    if (has('sub')) out.sub = String(body.sub || '').trim().slice(0, 100);
    if (has('target')) out.target = body.target === null ? null : int('target', body.target, 1, 1000000);
    if (has('seed_members')) out.seed_members = int('seed_members', body.seed_members, 0, 1000000);
    if (has('seed_households')) out.seed_households = int('seed_households', body.seed_households, 0, 1000000);
    if (has('sort_order')) out.sort_order = int('sort_order', body.sort_order, 0, 100000);
    if (has('bidding_open')) {
      if (typeof body.bidding_open !== 'boolean') throw badRequest('bidding_open must be true or false.');
      out.bidding_open = body.bidding_open;
    }
    if (has('brief_json')) {
      /* The cohort brief's demand profile, served verbatim to partner desks by
         the brief route. Validated as JSON here so a typo becomes a 400 for
         the admin rather than a null mix for every partner. */
      if (body.brief_json === null || body.brief_json === '') {
        out.brief_json = null;
      } else {
        const s = String(body.brief_json);
        if (s.length > 10000) throw badRequest('brief_json is over 10,000 characters.');
        try { JSON.parse(s); } catch { throw badRequest('brief_json must be valid JSON.'); }
        out.brief_json = s;
      }
    }
    /* The seven calendar columns that drive every derived stage. Accepted as
       epoch ms or an ISO date string; null clears one. These used to be
       settable only by hand-pasted ZCQL, which left a concurrent campaign's
       whole schedule outside validation and outside the audit trail; each
       campaign's calendar is its own, so this write never touches another
       campaign's clock. */
    for (const k of catalog.DATE_COLUMNS) {
      if (!has(k)) continue;
      if (body[k] === null || body[k] === '') { out[k] = null; continue; }
      const d = new Date(body[k]);
      if (Number.isNaN(d.getTime())) {
        throw badRequest(`${k} must be a date (epoch ms or ISO), or null to clear it.`);
      }
      out[k] = datastore.toDb(d);
    }
    return out;
  }

  /** The calendar must read in ladder order wherever two rungs are both set. */
  function assertCalendarOrder(merged) {
    let prev = null;
    for (const k of catalog.DATE_COLUMNS) {
      const v = merged[k];
      if (v == null || v === '') continue;
      const parsed = datastore.fromDb(v);
      if (!parsed) continue;
      const t = parsed.getTime();
      if (prev && t < prev.t) {
        throw badRequest(`${k} lands before ${prev.k}; the calendar must read in lifecycle order.`);
      }
      prev = { k, t };
    }
  }

  /** Audit-safe copy of campaign fields: the brief blob becomes its length. */
  const auditableCampaignFields = (fields) => {
    const out = { ...fields };
    if ('brief_json' in out) {
      out.brief_json = out.brief_json ? `[json, ${out.brief_json.length} chars]` : null;
    }
    return out;
  };

  /**
   * A cohort that takes joins must say who it takes them from.
   *
   * A campaign in a joinable kind with no FSA set is open to EVERYBODY, which
   * is what every campaign was before coverage existed and what every one of
   * them still is until an operator scopes it (geo.eligibilityOf says why that
   * ramp is deliberate). This gate is the other end of the ramp: no NEW cohort
   * can be created unscoped, and none can be moved into a joinable kind
   * unscoped, so the unscoped set only ever shrinks.
   *
   * Refused as a CONFLICT rather than a validation error: the body is fine,
   * the state of the campaign is what says no.
   */
  function assertScoped(kind, fsas, id) {
    if (!catalog.JOIN_STATUS[kind]) return;
    if (geo.parseFsaList(fsas).length) return;
    throw new AppError('CONFLICT',
      `Add at least one FSA before opening ${id} to households. `
      + 'A cohort with no postal code areas is open to everyone, which is not a cohort.', {
        logDetail: `campaign ${id} joinable with no fsas`,
        extra: { reason: 'no_fsas' },
      });
  }

  /**
   * Which other campaigns already cover any of these FSAs.
   *
   * A WARNING AND NOT A REFUSAL. Two cohorts sharing an FSA is a real
   * configuration: a region that fills and reopens for a second round, or two
   * renewal windows in one area. The households there will see both, ordered
   * by whichever closes first, which is a defensible thing to show and a
   * terrible thing to do by accident. So the operator is told, and decides.
   */
  async function overlapWith(catalystApp, id, fsas) {
    const mine = geo.parseFsaList(fsas);
    if (!mine.length) return [];
    const cat = await catalog.load(catalystApp, { fresh: true });
    const out = [];
    for (const c of cat.list) {
      if (c.id === id || c.kind === 'archived') continue;
      const shared = (c.fsas || []).filter((f) => mine.includes(f));
      if (shared.length) out.push({ campaign: c.id, region: c.region, fsas: shared });
    }
    return out;
  }

  /** The operator-facing sentence for an overlap, or null. */
  const overlapNote = (rows) => (rows.length
    ? rows.map((r) => `${r.region} already covers ${r.fsas.join(', ')}. Members there will see both.`).join(' ')
    : null);

  const campaignsWriteError = (err) => new AppError('SERVER_ERROR',
    'Campaigns are not writable right now: has the campaigns table been created?', {
      logDetail: `campaigns write failed: ${String((err && err.message) || err).slice(0, 200)}`,
    });

  router.post('/admin/campaigns', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const body = req.body || {};
    const id = String(body.id || '').trim();
    if (!catalog.ID_RE.test(id)) {
      throw badRequest('id must be a slug: 3-64 characters of a-z, 0-9 and hyphen.');
    }
    /* `forming` is the default because it is the kind that TAKES JOINS, and a
       cohort created without saying otherwise is one somebody means to collect
       households on. It defaulted to `planned`, which quietly wrote every join
       taken before the first transition as `waitlist` (JOIN_STATUS), and that
       column is a snapshot nothing rewrites. catalog.standingOf now reads such
       a row as the household it is, so this is no longer load-bearing, but the
       default that surprises nobody is the one that matches the lifecycle step
       an operator is actually at. scripts/cohort.mjs new has always used it. */
    const kind = String(body.kind || 'forming');
    if (!catalog.KINDS.includes(kind)) {
      throw badRequest(`kind must be one of ${catalog.KINDS.join(' | ')}.`);
    }
    const fields = campaignFields(body);
    assertCalendarOrder(fields);
    assertScoped(kind, fields.fsas, id);

    let existing = null;
    try {
      existing = await datastore.findBy(req.catalyst, catalog.TABLE, 'campaign_id', id, ['ROWID']);
    } catch (err) {
      throw campaignsWriteError(err);
    }
    if (existing) {
      throw new AppError('CONFLICT', 'A campaign with that id already exists.');
    }

    try {
      await datastore.insertRow(req.catalyst, catalog.TABLE, {
        campaign_id: id,
        region: fields.region,
        sub: fields.sub || '',
        kind,
        target: fields.target === undefined ? null : fields.target,
        seed_members: fields.seed_members || 0,
        seed_households: fields.seed_households || 0,
        bidding_open: Boolean(fields.bidding_open),
        sort_order: fields.sort_order || 0,
        ...(fields.fsas !== undefined ? { fsas: fields.fsas } : {}),
        ...(fields.brief_json !== undefined ? { brief_json: fields.brief_json } : {}),
        ...Object.fromEntries(catalog.DATE_COLUMNS
          .filter((k) => fields[k] !== undefined)
          .map((k) => [k, fields[k]])),
        updated_by: admin.user_id,
        updated_at: datastore.nowDb(),
      });
    } catch (err) {
      throw campaignsWriteError(err);
    }
    catalog.invalidate();

    await audit.record(req.catalyst, req, {
      type: 'admin.campaign.create', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: { campaign: id, kind, ...auditableCampaignFields(fields) },
    });

    res.status(200).json({ ok: true, id, warning: overlapNote(await overlapWith(req.catalyst, id, fields.fsas)) });
  }));

  router.put('/admin/campaigns/:id', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const id = cleanId(req.params.id, 'campaign id');
    const fields = campaignFields(req.body || {}, { partial: true });
    if (!Object.keys(fields).length) throw badRequest('Nothing to change.');

    let row;
    try {
      row = await datastore.findBy(req.catalyst, catalog.TABLE, 'campaign_id', id,
        ['ROWID', ...catalog.COLUMNS]);
    } catch (err) {
      throw campaignsWriteError(err);
    }
    if (!row) {
      throw badRequest('That campaign is not in the campaigns table. Import defaults first, or create it.');
    }

    const before = {};
    for (const k of Object.keys(fields)) before[k] = row[k];

    /* Order is judged over the MERGED calendar: an edit that moves one rung
       must still read in ladder order against the rungs it does not touch. */
    const mergedDates = {};
    for (const k of catalog.DATE_COLUMNS) {
      mergedDates[k] = fields[k] !== undefined ? fields[k] : row[k];
    }
    assertCalendarOrder(mergedDates);

    /* Clearing the coverage of a cohort that is currently taking joins is the
       same act as opening an unscoped one, so it takes the same refusal. The
       row's OWN kind, not a body field: kind moves through the transition
       route and never through here. */
    if (fields.fsas !== undefined) assertScoped(row.kind, fields.fsas, id);

    await datastore.updateRow(req.catalyst, catalog.TABLE, {
      ROWID: row.ROWID, ...fields,
      updated_by: admin.user_id, updated_at: datastore.nowDb(),
    });
    catalog.invalidate();

    await audit.record(req.catalyst, req, {
      type: 'admin.campaign.update', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: {
        campaign: id,
        before: auditableCampaignFields(before),
        after: auditableCampaignFields(fields),
      },
    });

    res.status(200).json({
      ok: true, id,
      warning: fields.fsas === undefined
        ? null
        : overlapNote(await overlapWith(req.catalyst, id, fields.fsas)),
    });
  }));

  /**
   * One campaign's coverage, with the real number of households in each FSA.
   * -> { ok, id, region, fsas: [{ fsa, city, province, members }], overlap }
   *
   * THE NUMBER IS A COUNT OF ROWS, taken at read time against users.fsa, and
   * it is the only figure on this screen. An operator scoping a cohort is
   * deciding whether an area has anybody in it, and a seed, an estimate or a
   * population figure would answer a different question convincingly. Where a
   * count cannot be read it is null and the console says so, rather than a
   * zero that reads as an answer.
   *
   * Capped, because this is one scoped query per FSA and an operator who
   * pastes a province's worth of them should get a refusal rather than a
   * timeout.
   */
  const COVERAGE_COUNT_MAX = 40;

  router.get('/admin/campaigns/:id/coverage', wrap(async (req, res) => {
    requireAdmin(req);
    const id = cleanId(req.params.id, 'campaign id');
    const cat = await catalog.load(req.catalyst, { fresh: true });
    const campaign = cat.byId.get(id);
    if (!campaign) throw badRequest('That campaign is not in the campaigns table.');

    const list = campaign.fsas || [];
    const counted = list.slice(0, COVERAGE_COUNT_MAX);
    const out = [];
    for (const fsa of counted) {
      const place = fsaref.lookup(fsa);
      let members = null;
      try {
        members = (await datastore.queryAll(req.catalyst, users.USERS, ['user_id'],
          `fsa = ${datastore.lit(fsa)}`)).length;
      } catch {
        members = null;
      }
      out.push({
        fsa,
        city: place ? place.city : null,
        province: place ? place.province : null,
        members,
      });
    }

    res.status(200).json({
      ok: true,
      id,
      region: campaign.region,
      fsas: out,
      /* Named so the console cannot render a partial list as a whole one. */
      notCounted: list.slice(COVERAGE_COUNT_MAX),
      overlap: await overlapWith(req.catalyst, id, list.join(',')),
    });
  }));

  /**
   * Lifecycle moves, validated against the state machine. Moving to `auction`
   * locks member joins and (once bidding_open is set) opens the partner bid
   * window; `archived -> auction` and its kin are refused.
   */
  router.post('/admin/campaigns/:id/transition', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const id = cleanId(req.params.id, 'campaign id');
    const to = String((req.body || {}).to || '').trim();
    if (!catalog.KINDS.includes(to)) {
      throw badRequest(`to must be one of ${catalog.KINDS.join(' | ')}.`);
    }

    let row;
    try {
      row = await datastore.findBy(req.catalyst, catalog.TABLE, 'campaign_id', id,
        ['ROWID', 'kind', 'bidding_open', 'fsas']);
    } catch (err) {
      throw campaignsWriteError(err);
    }
    if (!row) {
      throw badRequest('That campaign is not in the campaigns table. Import defaults first, or create it.');
    }

    const from = catalog.KINDS.includes(row.kind) ? row.kind : 'planned';
    const legal = catalog.TRANSITIONS[from] || [];
    if (!legal.includes(to)) {
      throw new AppError('CONFLICT',
        `A ${from} campaign cannot move to ${to}. Legal moves: ${legal.join(', ') || 'none'}.`);
    }

    /* Opening a cohort to households is the moment its coverage has to exist:
       every other rung of the ladder can carry an empty FSA set harmlessly,
       and this one cannot. */
    assertScoped(to, row.fsas, id);

    const fields = { ROWID: row.ROWID, kind: to, updated_by: admin.user_id, updated_at: datastore.nowDb() };
    // Leaving auction always closes the bid window; entering it never opens
    // it implicitly: opening bidding is its own deliberate act (PUT bidding_open).
    if (from === 'auction' && to !== 'auction') fields.bidding_open = false;
    await datastore.updateRow(req.catalyst, catalog.TABLE, fields);
    catalog.invalidate();

    await audit.record(req.catalyst, req, {
      type: 'admin.campaign.transition', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: { campaign: id, from, to },
    });

    res.status(200).json({ ok: true, id, kind: to });
  }));

  /**
   * The sealed-bids review, one campaign at a time.
   *
   * STAFF EYES ONLY, and scoped hard to the one campaign in the path: the
   * response never carries another campaign's row, so reviewing cohort A can
   * not read or leak cohort B (sealed-bid privacy is a partner-facing rule;
   * the operator running the auction reviews all of one cohort's bids, which
   * is the review this endpoint exists for). Labelled with the campaign's
   * region and id so the console can title the modal unambiguously.
   */
  router.get('/admin/campaigns/:id/bids', wrap(async (req, res) => {
    requireAdmin(req);
    const id = cleanId(req.params.id, 'campaign id');
    const cat = await catalog.load(req.catalyst, { fresh: true });
    const campaign = cat.byId.get(id);
    if (!campaign) throw badRequest('That campaign is not in the campaigns table.');

    const rows = await bids.campaignBidRows(req.catalyst, id);

    /* THE REVIEW IS A MATRIX NOW: tiers down, partners across. A cohort is won
       tier by tier, so "who won" is a column of answers rather than one, and an
       operator comparing bids needs to see the same grid the rule works on.

       `sealed` is the recorded book when the cohort has closed and somebody has
       read it. `computed` is what the rule says the book would be from the rows
       in hand, and it is shown for an OPEN cohort too, where it is a preview
       and nothing more. They are separate keys on purpose: an operator must be
       able to see when a sealed book and the current rows disagree, which is
       exactly what a late price correction looks like, and collapsing them
       into one field is how that goes unnoticed. */
    const sealedBook = await awards.bookFor(req.catalyst, id);
    const computedBook = awards.buildBook(rows || []);

    /* One org-name read per distinct org on the cohort. */
    const names = {};
    for (const r of rows || []) {
      const orgId = r.org_id || String(r.bid_key || '').split(':').slice(1).join(':');
      if (!orgId || names[orgId] !== undefined) continue;
      try {
        /* eslint-disable-next-line no-await-in-loop */
        const org = await datastore.findBy(req.catalyst, orgs.ORGS, 'org_id', orgId, ['legal_name']);
        names[orgId] = (org && org.legal_name) || null;
      } catch {
        names[orgId] = null;
      }
    }

    res.status(200).json({
      ok: true,
      campaign: { id: campaign.id, region: campaign.region, sub: campaign.sub || '', kind: campaign.kind },
      live: rows !== null,
      /* Staff eyes only, and one campaign at a time. The org id travels here
         and nowhere partner-facing. */
      book: {
        sealed: sealedBook ? sealedBook.map((e) => ({
          tier: e.tier, price: e.price, org_id: e.orgId,
          org_name: names[e.orgId] || null, bid_key: e.bidKey,
        })) : null,
        computed: computedBook.map((e) => ({
          tier: e.tier, price: e.price, org_id: e.orgId,
          org_name: names[e.orgId] || null, bid_key: e.bidKey,
        })),
        /* True when the rows in hand no longer produce the sealed book. Not an
           error: a sealed book is the promise already made to households, and
           it wins. It is surfaced so an operator can see that it happened. */
        drifted: Boolean(sealedBook) && JSON.stringify(sealedBook.map((e) => [e.tier, e.price, e.orgId]))
          !== JSON.stringify(computedBook.map((e) => [e.tier, e.price, e.orgId])),
      },
      bids: (rows || []).map((r) => {
        const orgId = r.org_id || String(r.bid_key || '').split(':').slice(1).join(':');
        return {
          bid_key: r.bid_key,
          org_id: orgId,
          org_name: names[orgId] || null,
          price: r.price,
          status: r.status,
          revision_count: r.revision_count || 1,
          receipt_no: r.receipt_no || null,
          guarantee_months: r.guarantee_months || null,
          commitment_cap: r.commitment_cap || null,
          submitted_at: r.submitted_at || null,
          last_revised_at: r.last_revised_at || null,
          /* WHICH TIERS THIS BID TOOK, from the sealed book when there is one
             and the computed preview otherwise. A bid can win some tiers and
             lose others on one cohort, so a boolean cannot say what happened. */
          won_tiers: (sealedBook || computedBook)
            .filter((e) => e.bidKey === r.bid_key)
            .map((e) => e.tier),
        };
      }),
    });
  }));

  /**
   * Seed the table from the code catalog: the one-time promotion. Skips ids
   * that already exist, so it is safe to run twice.
   */
  router.post('/admin/campaigns/import-defaults', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const imported = [];
    for (const c of catalog.CODE_CATALOG) {
      let existing;
      try {
        existing = await datastore.findBy(req.catalyst, catalog.TABLE, 'campaign_id', c.id, ['ROWID']);
      } catch (err) {
        throw campaignsWriteError(err);
      }
      if (existing) continue;
      await datastore.insertRow(req.catalyst, catalog.TABLE, {
        campaign_id: c.id,
        region: c.region,
        sub: c.sub,
        kind: c.kind,
        target: c.target,
        seed_members: c.seedMembers,
        seed_households: c.seedHouseholds,
        bidding_open: Boolean(c.biddingOpen),
        sort_order: c.sortOrder,
        updated_by: admin.user_id,
        updated_at: datastore.nowDb(),
      });
      imported.push(c.id);
    }
    catalog.invalidate();

    await audit.record(req.catalyst, req, {
      type: 'admin.campaign.import', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: { imported },
    });

    res.status(200).json({ ok: true, imported });
  }));

  /* ---------------- provider approval: the human gate ---------------- */

  router.get('/admin/providers', wrap(async (req, res) => {
    requireAdmin(req);
    let orgRows;
    try {
      orgRows = await datastore.queryAll(req.catalyst, orgs.ORGS,
        [...orgs.ORG_COLUMNS, 'rejection_reason', 'CREATEDTIME'].filter((c) => c !== 'ROWID'), 'ROWID > 0');
    } catch {
      // The optional rejection_reason column may not exist yet; retry without.
      orgRows = await datastore.queryAll(req.catalyst, orgs.ORGS,
        [...orgs.ORG_COLUMNS, 'CREATEDTIME'].filter((c) => c !== 'ROWID'), 'ROWID > 0');
    }

    let memberships = [];
    try {
      memberships = await datastore.queryAll(req.catalyst, orgs.MEMBERSHIPS,
        ['user_id', 'org_id', 'role'], 'ROWID > 0');
    } catch { /* no memberships yet */ }
    const seats = {};
    for (const m of memberships) seats[m.org_id] = (seats[m.org_id] || 0) + 1;

    const status = String(req.query.status || 'all');
    const list = orgRows
      .filter((o) => status === 'all' || (o.approval_status || 'pending') === status)
      .map((o) => ({
        org_id: o.org_id,
        legal_name: o.legal_name,
        email_domain: o.email_domain,
        approval_status: o.approval_status || 'pending',
        approved_by: o.approved_by || null,
        approved_at: o.approved_at || null,
        rejection_reason: o.rejection_reason || null,
        seats: seats[o.org_id] || 0,
        created_at: o.CREATEDTIME || null,
      }))
      // Pending first: the queue the console opens onto.
      .sort((a, b) => (a.approval_status === 'pending' ? 0 : 1) - (b.approval_status === 'pending' ? 0 : 1));

    res.status(200).json({ ok: true, providers: list });
  }));

  /**
   * The full review: the org, the people who signed up under it, and the
   * PartnerApplications rows matched by email domain: the form answers
   * (provinces, access tech, business number, LOA) are the review material.
   */
  router.get('/admin/providers/:orgId', wrap(async (req, res) => {
    requireAdmin(req);
    const orgId = cleanId(req.params.orgId, 'organisation id');
    const org = await orgs.findById(req.catalyst, orgId);
    if (!org) throw new AppError('NOT_FOUND', 'No such organisation.');

    const memberships = await orgs.membersOf(req.catalyst, orgId);
    const people = [];
    for (const m of memberships) {
      const u = await users.findById(req.catalyst, m.user_id);
      if (u) {
        people.push({
          user_id: u.user_id,
          email: u.email_display || u.email_normalized,
          first_name: u.first_name,
          last_name: u.last_name,
          status: u.status,
          org_role: m.role,
        });
      }
    }

    // Applications by domain, matched in code: ZCQL string functions are not
    // dependable enough to express "ends with @domain" server-side.
    const key = String(org.email_domain || '').toLowerCase();
    let applications = [];
    try {
      const rows = await datastore.queryAll(req.catalyst, 'PartnerApplications',
        LEAD_TABLES.PartnerApplications, 'ROWID > 0');
      /* An org created from a personal address stores the whole address here,
         not a domain, so the suffix match would look for '@sam@gmail.com' and
         silently find nothing. Match the address exactly in that case. */
      applications = orgs.isPersonalOrgKey(key)
        ? rows.filter((r) => key && String(r.Email || '').toLowerCase() === key)
        : rows.filter((r) => key && String(r.Email || '').toLowerCase().endsWith(`@${key}`));
    } catch { /* lead table unreadable: review still renders */ }

    res.status(200).json({
      ok: true,
      org: {
        org_id: org.org_id,
        legal_name: org.legal_name,
        email_domain: org.email_domain,
        approval_status: org.approval_status || 'pending',
        approved_by: org.approved_by || null,
        approved_at: org.approved_at || null,
      },
      people,
      applications,
    });
  }));

  /** Load an org for a decision route or throw the shared 404. */
  async function orgForDecision(req) {
    const orgId = cleanId(req.params.orgId, 'organisation id');
    const org = await orgs.findById(req.catalyst, orgId);
    if (!org) throw new AppError('NOT_FOUND', 'No such organisation.');
    return org;
  }

  /**
   * Email every active person in the org, through the outbox.
   *
   * Every person in the org, and not a routing role, because this is the one
   * message that is about the org itself rather than about anybody's job in
   * it: a company being approved or turned down is news for whoever is on the
   * account. Role routing (bids, delivery, billing) starts with the messages
   * that have a desk to land on.
   */
  async function notifyOrgUsers(req, org, context) {
    const memberships = await orgs.membersOf(req.catalyst, org.org_id).catch(() => []);
    const outcomes = [];
    for (const m of memberships) {
      /* eslint-disable-next-line no-await-in-loop */
      const u = await users.findById(req.catalyst, m.user_id).catch(() => null);
      if (!u || u.status !== 'active') continue;
      /* One outbox row per person, keyed on the org and the decision, so a
         second click on Approve does not send the whole company a second
         letter. One address failing never stops the rest. */
      /* eslint-disable-next-line no-await-in-loop */
      const sent = await notify.dispatch(req, {
        templateKey: 'partner.account.decision',
        eventKey: `provider.decision:${org.org_id}:${context.approved ? 'approved' : 'rejected'}`,
        user: u,
        context,
      });
      outcomes.push({ user: u.user_id, delivered: Boolean(sent.delivered), status: sent.status });
    }
    return outcomes;
  }

  /**
   * THE write of `approved`: the only one in the system. Stamps who and
   * when, tells the org's people their console is live, audits.
   */
  router.post('/admin/providers/:orgId/approve', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const org = await orgForDecision(req);
    const before = org.approval_status || 'pending';

    await datastore.updateRow(req.catalyst, orgs.ORGS, {
      ROWID: org.ROWID,
      approval_status: 'approved',
      approved_by: admin.user_id,
      approved_at: datastore.nowDb(),
    });

    const mailed = await notifyOrgUsers(req, org, {
      approved: true,
      org_name: org.legal_name,
      console_url: `${String(cfg.APP_BASE_URL || '').replace(/\/+$/, '')}/partner`,
    });

    await audit.record(req.catalyst, req, {
      type: 'admin.provider.approve', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: { org_id: org.org_id, before, after: 'approved', mailed },
    });

    res.status(200).json({ ok: true, org_id: org.org_id, approval_status: 'approved' });
  }));

  router.post('/admin/providers/:orgId/reject', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const org = await orgForDecision(req);
    const reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 3 || reason.length > 255) {
      throw badRequest('A rejection needs a reason (3-255 characters). The audit trail and the email both carry it.');
    }
    const before = org.approval_status || 'pending';

    try {
      await datastore.updateRow(req.catalyst, orgs.ORGS, {
        ROWID: org.ROWID, approval_status: 'rejected',
        approved_by: admin.user_id, approved_at: datastore.nowDb(),
        rejection_reason: reason,
      });
    } catch {
      // rejection_reason column not created yet: the decision still stands;
      // the reason survives in the audit row and the email.
      await datastore.updateRow(req.catalyst, orgs.ORGS, {
        ROWID: org.ROWID, approval_status: 'rejected',
        approved_by: admin.user_id, approved_at: datastore.nowDb(),
      });
    }

    const mailed = await notifyOrgUsers(req, org, {
      approved: false,
      org_name: org.legal_name,
      reason,
      console_url: `${String(cfg.APP_BASE_URL || '').replace(/\/+$/, '')}/partner`,
    });

    await audit.record(req.catalyst, req, {
      type: 'admin.provider.reject', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: { org_id: org.org_id, before, after: 'rejected', reason, mailed },
    });

    res.status(200).json({ ok: true, org_id: org.org_id, approval_status: 'rejected' });
  }));

  /* ---------------------------------------------------------------- *
   * Coverage verification
   *
   * THE ONE PLACE 'active' IS WRITTEN, and the reason these two routes exist.
   * provider_coverage rows land 'verifying' when a partner declares a region,
   * and until now nothing anywhere moved them on. The effect was not a missing
   * admin feature, it was a dead console: a cohort only reaches a bid desk
   * from inside an ACTIVE region, so every partner who declared coverage saw
   * an empty desk forever and had no way to tell that from having no cohorts.
   *
   * Serviceability is decided by an operator against facilities data, never
   * asserted by the party it advantages, which is why this lives behind
   * requireAdmin and not on the partner's own coverage route.
   * ---------------------------------------------------------------- */

  /** Reasons a footprint can be refused. An enum, not prose: this feeds the
      serviceability accuracy figure that future auction briefs carry beside a
      partner's bid, and free text would make that number unbuildable. */
  const COVERAGE_REJECT_REASONS = new Map([
    ['no_facilities', 'No facilities record for this footprint.'],
    ['outside_footprint', 'The addresses in this region sit outside your declared footprint.'],
    ['tech_unsupported', 'The technology declared here is not available at these addresses.'],
    ['needs_evidence', 'We need the wholesale agreement reference before we can confirm this footprint.'],
  ]);

  /** Locate one declared region, by org and region slug. */
  async function coverageForDecision(req) {
    const org = await orgForDecision(req);
    const regionSlug = desk.slug(req.params.region);
    if (!regionSlug) throw badRequest('Name the region.');

    const key = `${org.org_id}:${regionSlug}`.slice(0, 200);
    const row = await datastore.findBy(
      req.catalyst, desk.COVERAGE, 'coverage_key', key,
      ['ROWID', 'coverage_key', 'org_id', 'region', 'status']
    ).catch(() => null);
    if (!row) throw new AppError('NOT_FOUND', 'That organisation has not declared that region.');
    return { org, row, regionSlug };
  }

  /**
   * Append the decision to the audit table, then move the row.
   *
   * ORDER MATTERS. The verification record is written FIRST: if the row update
   * fails the region stays 'verifying' and can be verified again, which is
   * harmless. The reverse order would leave a region live with no record of
   * who made it live, on the one decision that decides whether a partner can
   * bid at all.
   */
  async function recordVerification(req, admin, org, row, result, reason) {
    try {
      await datastore.insertRow(req.catalyst, 'coverage_verifications', {
        coverage_key: row.coverage_key,
        org_id: org.org_id,
        region: row.region,
        /* `outcome`, not `result`. ZCQL reserves `result`, so the console
           refuses to create a column by that name at all. `outcome` is the
           name auth_events already uses for the same idea, and that column has
           been written on every request in production since launch. */
        outcome: result,
        reason: reason || null,
        checked_by: admin.user_id,
        checked_at: datastore.nowDb(),
      });
    } catch {
      /* Table not created yet. The decision still stands and the audit row
         below carries it; create-tables.md documents the table. */
    }
  }

  router.post('/admin/providers/:orgId/coverage/:region/verify', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const { org, row, regionSlug } = await coverageForDecision(req);
    const before = row.status || 'verifying';

    await recordVerification(req, admin, org, row, 'active', null);

    /* rejection_reason is cleared: a region that failed once and then verified
       must not keep showing the old reason underneath a green dot. */
    const fields = { ROWID: row.ROWID, status: 'active', updated_at: datastore.nowDb() };
    try {
      await datastore.updateRow(req.catalyst, desk.COVERAGE, {
        ...fields, verified_at: datastore.nowDb(), rejection_reason: '',
      });
    } catch {
      /* The two newer columns are not created yet. The status change is the
         part that unblocks the desk, so it lands either way. */
      await datastore.updateRow(req.catalyst, desk.COVERAGE, fields);
    }

    await audit.record(req.catalyst, req, {
      type: 'admin.coverage.verify', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: { org_id: org.org_id, region: regionSlug, before, after: 'active' },
    });

    res.status(200).json({ ok: true, org_id: org.org_id, region: regionSlug, status: 'active' });
  }));

  router.post('/admin/providers/:orgId/coverage/:region/reject', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const reasonCode = String((req.body || {}).reason || '').trim();
    if (!COVERAGE_REJECT_REASONS.has(reasonCode)) {
      throw badRequest(
        `A refusal needs one of these reasons: ${[...COVERAGE_REJECT_REASONS.keys()].join(', ')}. `
        + 'The partner is shown it, and it feeds their serviceability figure.'
      );
    }
    const { org, row, regionSlug } = await coverageForDecision(req);
    const before = row.status || 'verifying';
    const sentence = COVERAGE_REJECT_REASONS.get(reasonCode);

    await recordVerification(req, admin, org, row, 'rejected', reasonCode);

    const fields = { ROWID: row.ROWID, status: 'rejected', updated_at: datastore.nowDb() };
    try {
      await datastore.updateRow(req.catalyst, desk.COVERAGE, { ...fields, rejection_reason: sentence });
    } catch {
      /* rejection_reason column not created yet. The refusal still stands and
         the reason survives in the verification and audit rows; the partner
         sees the generic sentence the console falls back to. */
      await datastore.updateRow(req.catalyst, desk.COVERAGE, fields);
    }

    await audit.record(req.catalyst, req, {
      type: 'admin.coverage.reject', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: { org_id: org.org_id, region: regionSlug, before, after: 'rejected', reason: reasonCode },
    });

    res.status(200).json({ ok: true, org_id: org.org_id, region: regionSlug, status: 'rejected' });
  }));

  /**
   * approved -> pending. Their sessions keep working, but every surface that
   * checks approval loses access on its next request. No email: suspension
   * is usually the start of a conversation, not its conclusion.
   */
  router.post('/admin/providers/:orgId/suspend', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const org = await orgForDecision(req);
    const before = org.approval_status || 'pending';
    if (before !== 'approved') {
      throw new AppError('CONFLICT', `Only an approved organisation can be suspended (this one is ${before}).`);
    }

    await datastore.updateRow(req.catalyst, orgs.ORGS, {
      ROWID: org.ROWID, approval_status: 'pending',
    });

    await audit.record(req.catalyst, req, {
      type: 'admin.provider.suspend', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: { org_id: org.org_id, before, after: 'pending' },
    });

    res.status(200).json({ ok: true, org_id: org.org_id, approval_status: 'pending' });
  }));

  /**
   * The duplicate-domain repair orgs.js anticipates: move every membership to
   * the survivor, delete the empty row. Rare; audited; refuses to merge an
   * org into itself.
   */
  router.post('/admin/orgs/merge', wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const body = req.body || {};
    const fromId = cleanId(body.fromOrgId, 'organisation id');
    const toId = cleanId(body.toOrgId, 'organisation id');
    if (fromId === toId) throw badRequest('fromOrgId and toOrgId must differ.');

    const from = await orgs.findById(req.catalyst, fromId);
    const to = await orgs.findById(req.catalyst, toId);
    if (!from || !to) throw new AppError('NOT_FOUND', 'No such organisation.');

    const moving = await orgs.membersOf(req.catalyst, fromId);
    const existing = await orgs.membersOf(req.catalyst, toId);
    const already = new Set(existing.map((m) => m.user_id));

    let moved = 0;
    let dropped = 0;
    for (const m of moving) {
      if (already.has(m.user_id)) {
        await datastore.deleteRow(req.catalyst, orgs.MEMBERSHIPS, m.ROWID);
        dropped++;
      } else {
        await datastore.updateRow(req.catalyst, orgs.MEMBERSHIPS, { ROWID: m.ROWID, org_id: toId });
        moved++;
      }
    }
    await datastore.deleteRow(req.catalyst, orgs.ORGS, from.ROWID);

    await audit.record(req.catalyst, req, {
      type: 'admin.org.merge', outcome: 'success',
      userId: admin.user_id, email: admin.email_normalized,
      detail: {
        from: { org_id: from.org_id, legal_name: from.legal_name },
        to: { org_id: to.org_id, legal_name: to.legal_name },
        moved, dropped,
      },
    });

    res.status(200).json({ ok: true, moved, dropped, survivor: toId });
  }));

  /* ---------------- visibility ---------------- */

  /**
   * Read-only lead views. `:table` resolves through LEAD_TABLES: a request
   * value never reaches ZCQL as a table name. Paginated newest-first; the UI
   * always shows a "more" affordance while `next` is non-null.
   */
  router.get('/admin/leads/:table', wrap(async (req, res) => {
    requireAdmin(req);
    const table = String(req.params.table || '');
    const columns = LEAD_TABLES[table];
    if (!columns) {
      throw badRequest(`Unknown table. One of: ${Object.keys(LEAD_TABLES).join(', ')}.`);
    }
    const before = req.query.before ? cleanId(req.query.before, 'cursor') : null;

    let page;
    try {
      page = await recentRows(req.catalyst, table, columns, {
        before, limit: req.query.limit,
      });
    } catch (err) {
      throw new AppError('SERVER_ERROR', 'That table could not be read.', {
        logDetail: `leads read failed for ${table}: ${String((err && err.message) || err).slice(0, 200)}`,
      });
    }

    res.status(200).json({ ok: true, table, columns, rows: page.rows, next: page.next });
  }));

  /**
   * The audit trail, filterable. Reads the same auth_events every route
   * writes: including the admin actions above, so the console can watch
   * itself being used.
   */
  router.get('/admin/audit', wrap(async (req, res) => {
    requireAdmin(req);
    const before = req.query.before ? cleanId(req.query.before, 'cursor') : null;
    const parts = [];
    if (req.query.type) {
      const t = String(req.query.type).trim();
      if (!/^[a-z0-9._-]{1,64}$/i.test(t)) throw badRequest('That type filter is not valid.');
      parts.push(`event_type = ${datastore.lit(t)}`);
    }
    if (req.query.outcome) {
      const o = String(req.query.outcome).trim();
      if (o !== 'success' && o !== 'failure') throw badRequest('outcome must be success or failure.');
      parts.push(`outcome = ${datastore.lit(o)}`);
    }

    const page = await recentRows(req.catalyst, audit.TABLE,
      ['event_type', 'user_id', 'email_normalized', 'outcome', 'detail'],
      { before, limit: req.query.limit, where: parts.join(' AND ') || null });

    res.status(200).json({ ok: true, rows: page.rows, next: page.next });
  }));
}

module.exports = { mount, requireAdmin, LEAD_TABLES };
