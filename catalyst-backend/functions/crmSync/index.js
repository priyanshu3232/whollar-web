'use strict';

/* ------------------------------------------------------------------ *
 * crmSync — cron-invoked worker that drains the CrmSyncQueue table and
 * pushes each queued form submission into Zoho CRM (+ a Note capturing the
 * submission's details). Consumer submissions become Leads; partner
 * applications go to their own module when CRM_PARTNER_MODULE is set
 * (e.g. 'Vendors' or a custom module), so the two sides land respectively.
 *
 * WHY a queue + this worker (instead of calling CRM from formSubmit):
 *   - The visitor's form never fails because CRM is slow / rate-limited /
 *     the token expired — formSubmit only writes a Data Store row.
 *   - Nothing is lost: this worker retries PENDING/FAILED rows every run.
 *   - Only THIS function holds the Zoho credentials (formSubmit has none).
 *
 * It is an Advanced I/O (HTTP) function. A Catalyst Job Scheduling cron
 * hits its URL on a schedule with ?key=<CRM_CRON_SECRET>. It is safe to
 * call repeatedly — each run processes a bounded batch and is idempotent
 * per row (a SYNCED row is never re-sent).
 * ------------------------------------------------------------------ */

const catalyst = require('zcatalyst-sdk-node');
const express = require('express');

const app = express();
app.use(express.json({ limit: '256kb', type: ['application/json', 'text/plain'] }));

const QUEUE_TABLE = 'CrmSyncQueue';

// All tunables come from env variables (set in the Catalyst console, never
// committed). Read fresh each request so a console change needs no redeploy.
const config = () => ({
  accountsUrl: process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zohocloud.ca',
  apiDomainFallback: process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.ca',
  clientId: process.env.ZOHO_CLIENT_ID,
  clientSecret: process.env.ZOHO_CLIENT_SECRET,
  refreshToken: process.env.ZOHO_REFRESH_TOKEN,
  cronSecret: process.env.CRM_CRON_SECRET,
  enabled: process.env.CRM_SYNC_ENABLED === 'true',
  isProd: process.env.CRM_ENVIRONMENT === 'production',
  batchSize: Math.max(1, parseInt(process.env.CRM_BATCH_SIZE || '50', 10)),
  maxAttempts: Math.max(1, parseInt(process.env.CRM_MAX_ATTEMPTS || '6', 10)),
  // Module partner applications land in ('Vendors', or a custom module's API
  // name). Default 'Leads' keeps everything in one module until the dedicated
  // module exists in Zoho — see "Partner module" in CRM_SYNC_RUNBOOK.md.
  partnerModule: (process.env.CRM_PARTNER_MODULE || 'Leads').trim() || 'Leads',
  // That module's mandatory display-name field, when it isn't the default
  // (Vendor_Name for Vendors, Name for custom modules).
  partnerNameField: (process.env.CRM_PARTNER_NAME_FIELD || '').trim()
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

// Catalyst DateTime columns want "YYYY-MM-DD HH:MM:SS" (UTC), not ISO 8601.
const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const authHeaders = (token) => ({
  Authorization: `Zoho-oauthtoken ${token}`,
  'Content-Type': 'application/json'
});

/* ---- Access token: refresh-token → access-token, cached in Catalyst Cache ---- *
 * Access tokens live ~1h; Zoho rate-limits how often you may mint them, so we
 * cache one across cron runs and only refresh when it's within 5 min of expiry
 * (or when a 401 forces it). The default cache segment needs no console setup. */
const TOKEN_CACHE_KEY = 'crm_access_token';

async function getAccessToken(catalystApp, cfg, force) {
  const seg = catalystApp.cache().segment();

  if (!force) {
    try {
      const raw = await seg.getValue(TOKEN_CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c.exp && c.exp - Date.now() > 5 * 60 * 1000) {
          return { token: c.token, apiDomain: c.apiDomain };
        }
      }
    } catch { /* fall through to a fresh refresh */ }
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken
  });
  const resp = await fetch(`${cfg.accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`token refresh failed: ${JSON.stringify(data)}`);

  const apiDomain = data.api_domain || cfg.apiDomainFallback;
  const exp = Date.now() + ((data.expires_in || 3600) * 1000);
  const value = JSON.stringify({ token: data.access_token, apiDomain, exp });
  try { await seg.put(TOKEN_CACHE_KEY, value, 1); }
  catch { try { await seg.update(TOKEN_CACHE_KEY, value, 1); } catch { /* best effort */ } }

  return { token: data.access_token, apiDomain };
}

// Run a CRM request; on a 401 (token expired mid-batch) refresh once and retry.
async function callCrm(ctx, doRequest) {
  let resp = await doRequest(ctx.token, ctx.apiDomain);
  if (resp.status === 401) {
    await ctx.refresh();
    resp = await doRequest(ctx.token, ctx.apiDomain);
  }
  return resp;
}

async function findRecordByEmail(ctx, moduleName, email) {
  // Lowercased so Genie@x.com and genie@x.com resolve to one record rather
  // than two. Parentheses, commas and colons are the criteria syntax's own
  // delimiters (colon separates field:operator:value), so strip them from the
  // value before interpolating — otherwise an address with an extra colon in
  // its local part (rare, but RFC-legal) can reshape the search clause. The
  // module must have an Email-type field whose API name is `Email` (Leads and
  // Vendors both do; a custom partner module needs one created — see the runbook).
  const safe = String(email || '').toLowerCase().replace(/[(),:]/g, '');
  const criteria = encodeURIComponent(`(Email:equals:${safe})`);
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/${moduleName}/search?criteria=${criteria}`, { headers: authHeaders(token) }));
  if (resp.status === 204) return null;              // 204 = no match
  if (!resp.ok) throw new Error(`${moduleName} search ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data?.data?.[0]?.id || null;
}

// Zoho rejects a picklist value that is not already defined on the field, with
// INVALID_DATA naming the offending field. Lead_Source and Rating are picklists
// by default, and this worker writes five Lead_Source labels (plus a " [dev]"
// suffix outside production) — if those options do not exist in the console,
// EVERY insert fails, retries six times, lands on FAILED, and the leads are
// silently lost. Rather than lose them, drop the offending field and retry
// once: an imperfectly tagged lead in the CRM beats no lead at all.
const PICKLIST_FIELDS = ['Lead_Source', 'Rating'];

function offendingPicklist(data) {
  const rec = data?.data?.[0];
  if (rec?.code !== 'INVALID_DATA') return null;
  const api = rec?.details?.api_name;
  return PICKLIST_FIELDS.includes(api) ? api : null;
}

async function postRecord(ctx, moduleName, fields) {
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/${moduleName}`, {
      method: 'POST', headers: authHeaders(token), body: JSON.stringify({ data: [fields] })
    }));
  return resp.json();
}

async function insertRecord(ctx, moduleName, fields) {
  let payload = { ...fields };
  let data = await postRecord(ctx, moduleName, payload);
  let rec = data?.data?.[0];

  const dropped = [];
  // At most one retry per picklist field, so a broken config can't loop.
  for (let i = 0; i < PICKLIST_FIELDS.length && rec?.code !== 'SUCCESS'; i++) {
    const bad = offendingPicklist(data);
    if (!bad || !(bad in payload)) break;
    console.error(`[crmSync] "${payload[bad]}" is not a valid ${bad} picklist option — dropping it and retrying. Add it in the Zoho console to keep the tag.`);
    delete payload[bad];
    dropped.push(bad);
    data = await postRecord(ctx, moduleName, payload);
    rec = data?.data?.[0];
  }

  if (rec?.code !== 'SUCCESS') throw new Error(`${moduleName} insert failed: ${JSON.stringify(data)}`);
  return { id: rec.details.id, dropped };
}

async function updateRecord(ctx, moduleName, recordId, fields) {
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/${moduleName}/${recordId}`, {
      method: 'PUT', headers: authHeaders(token), body: JSON.stringify({ data: [fields] })
    }));
  const data = await resp.json();
  const rec = data?.data?.[0];
  if (rec?.code !== 'SUCCESS') throw new Error(`${moduleName} update failed: ${JSON.stringify(data)}`);
}

// Notes are best-effort — a failed note must not fail the whole job, because
// the record (the important part) is already written.
async function addNote(ctx, moduleName, recordId, title, content) {
  try {
    const resp = await callCrm(ctx, (token, apiDomain) =>
      fetch(`${apiDomain}/crm/v8/Notes`, {
        method: 'POST', headers: authHeaders(token), body: JSON.stringify({
          data: [{
            Note_Title: String(title).slice(0, 120),
            Note_Content: String(content).slice(0, 32000),
            Parent_Id: recordId,
            se_module: moduleName
          }]
        })
      }));
    if (!resp.ok) console.error('[crmSync] note failed', resp.status, await resp.text());
  } catch (err) {
    console.error('[crmSync] note error:', err);
  }
}

/* ---- Mapping: a queue row (Source + Payload) → Zoho Lead fields + a Note ---- */

const SOURCE_META = {
  WaitlistSignups:        { label: 'Waitlist', hasName: true },
  WaitlistDetails:        { label: 'Waitlist Details', hasName: false },
  BillCheckupSubmissions: { label: 'Bill Checkup', hasName: false },
  DeepReadRequests:       { label: 'Deep Read', hasName: false, hot: true },
  PartnerApplications:    { label: 'Partner Application', hasName: true, hasCompany: true, partner: true }
};

// Which module a source's records live in. Consumers are always Leads;
// partner applications go to cfg.partnerModule — which defaults to 'Leads'
// too, so nothing changes until CRM_PARTNER_MODULE is set in the console.
const moduleFor = (source, cfg) =>
  (SOURCE_META[source] || {}).partner ? cfg.partnerModule : 'Leads';

// The partner module's mandatory display-name field: Vendors ships with
// Vendor_Name, custom modules with Name, unless the env var says otherwise.
const partnerNameField = (cfg) =>
  cfg.partnerNameField || (cfg.partnerModule === 'Vendors' ? 'Vendor_Name' : 'Name');

// Fields for a NEW record in a dedicated partner module. Only fields every
// module has (its name field, Email, Phone) — Last_Name / Company /
// Lead_Source are Leads fields and would be INVALID_DATA anywhere else. The
// application detail rides in the Note, exactly as it does for Leads.
function partnerInsertFields(cfg, email, data) {
  const name = data.company
    || [data.firstName, data.lastName].filter(Boolean).join(' ')
    || email;
  const fields = { [partnerNameField(cfg)]: name, Email: email };
  if (data.phone) fields.Phone = data.phone;
  return fields;
}

// Fields for a NEW lead. Zoho requires Last_Name and Company on Leads, so for
// nameless/company-less consumer sources we fall back to the email / "Individual".
function insertFields(source, email, data, isProd) {
  const meta = SOURCE_META[source] || { label: source };
  const envTag = isProd ? '' : ' [dev]';
  const fields = {
    Email: email,
    Last_Name: (meta.hasName && data.lastName) ? data.lastName : email,
    Company: meta.hasCompany ? (data.company || 'Unknown') : 'Individual',
    Lead_Source: `Whollar ${meta.label}${envTag}`
  };
  if (meta.hasName && data.firstName) fields.First_Name = data.firstName;
  if (data.phone) fields.Phone = data.phone;
  if (meta.hot) fields.Rating = 'Hot';
  return fields;
}

// Fields safe to apply to an EXISTING lead: never overwrite the name with a
// placeholder, and never rewrite Lead_Source (first touch wins). Enrichment
// detail goes to a Note instead, so history is preserved, not clobbered.
function updateFields(source, data) {
  const meta = SOURCE_META[source] || {};
  const fields = {};
  if (meta.hasName && data.lastName) fields.Last_Name = data.lastName;
  if (meta.hasName && data.firstName) fields.First_Name = data.firstName;
  if (data.phone) fields.Phone = data.phone;
  if (meta.hot) fields.Rating = 'Hot';
  return fields;
}

// The contract-length <select> values, as both forms send them. '0' and '-1'
// are answers, not lengths, and reading "Contract length: -1" off a lead is
// worse than reading nothing.
const CONTRACT_LENGTH = {
  '0': 'No contract / month-to-month',
  '-1': 'Not sure'
};

function noteFor(source, email, data, isProd, dropped) {
  const meta = SOURCE_META[source] || { label: source };
  const devTag = isProd ? '' : '[DEV] ';
  const lines = [];
  if (meta.hot) lines.push('⚠ DEEP READ REQUESTED — high intent');

  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${v}`); };
  const money = v => (v === undefined || v === null || v === '' ? null : `$${Number(v).toFixed(2)}`);

  // What the visitor was actually shown. The note used to carry only the gross
  // charge, so a rep opening the lead saw "$90" while the screen had said
  // "$60/mo with promo" — two different numbers for the same household.
  if (data.verdict) {
    const VERDICT = {
      strong: 'STRONG — already below the reference price',
      fair: 'FAIR — near the reference price',
      weak: 'WEAK — above the reference price',
      cliff: 'CLIFF — promo ends within 60 days',
      unknown: 'NOT SCORED'
    };
    add('Result shown', VERDICT[data.verdict] || data.verdict);
    if (data.verdict === 'unknown' && data.verdictReason) add('Not scored because', data.verdictReason);
    if (data.benchmarkPrice) {
      const LEVEL = {
        A: 'their provider, connection type, speed and province',
        B: 'connection type, speed and province (provider not in our set)',
        C: 'connection type and speed, national',
        D: 'their provider, speed and province',
        E: 'speed and province',
        F: 'speed only, national'
      };
      add('Compared against', `${money(data.benchmarkPrice)}/mo advertised`);
      add('Match basis', LEVEL[data.benchmarkLevel] || data.benchmarkScope || '—');
      add('Plans behind that figure', data.benchmarkSample);
      if (data.benchmarkCaveat) add('⚠ Comparison caveat', data.benchmarkCaveat);
    }
  }

  add('Provider', data.provider);
  // What `cost` means changed on 2026-08-08: it is now the net figure the
  // household pays TODAY, promo included, not the regular price. The label
  // said "before discount" for two days after that, which is the one reading
  // a rep must not take from it. `effectiveCost` is the same number by that
  // definition, so it only earns a line when it actually differs.
  add('Monthly charge (what they pay today)', money(data.cost));
  if (data.effectiveCost !== undefined && data.effectiveCost !== null
      && Number(data.effectiveCost) !== Number(data.cost)) {
    add('Effective monthly cost', money(data.effectiveCost));
  }
  add('Download speed', data.speed);
  add('Access tech', data.tech);
  add('Promo end', data.promoEnd);
  add('Months to renewal', data.monthsToRenewal);
  add('Discount', money(data.discount));
  // The number the conversation is actually about: what the bill becomes when
  // the promo lapses. Derived rather than collected, because the form asks
  // what they pay now and how much is taken off, not the sum of the two.
  if (Number(data.discount) > 0 && Number(data.cost) > 0) {
    add('Price after the promo ends', money(Number(data.cost) + Number(data.discount)));
  }
  add('Contract start', data.contractStart);
  add('Contract length', CONTRACT_LENGTH[String(data.contractLength)]
    || (data.contractLength ? `${data.contractLength} months` : null));
  add('Switch threshold', data.threshold);
  // One geography block, in one format: "A1A 1A1" plus the FSA and province.
  add('Postal code', data.postal);
  add('FSA', data.fsa);
  add('Province', data.provinceCode ? `${data.province || ''} (${data.provinceCode})`.trim() : data.province);
  add('Referral code', data.referral);
  add('Role', data.role);
  add('Provinces', data.provinces);
  add('Access techs', data.techs);
  add('Services', data.services);
  add('Note', data.note);
  add('Attachments', data.files);
  add('Bill file', data.billFileName);
  add('Via', data.via);

  // CASL: the consent record has to be retrievable per contact, so it lives on
  // the lead rather than only in the Data Store row.
  if (data.consentGranted) {
    lines.push('');
    lines.push('— Consent —');
    add('Granted at (server)', data.consentAt);
    add('Consent type', data.consentKind);
    add('Source page', data.consentSource);
    add('IP', data.consentIp);
    add('Wording shown', data.consentText);
  } else if (data.consentGranted === false) {
    lines.push('');
    lines.push('— Consent: NOT granted. Do not send commercial email to this address. —');
  }

  if (dropped && dropped.length) {
    lines.push('');
    lines.push(`⚠ ${dropped.join(', ')} could not be set: the value is not an option on that picklist in Zoho. Add it in Setup → Fields to restore the tag.`);
  }

  return {
    title: `${devTag}Whollar ${meta.label} — ${email}`.trim(),
    content: lines.length ? lines.join('\n') : `Submission via ${meta.label}.`
  };
}

// Search-then-write: update an existing record (matched by email, within the
// source's module) or create one, then always attach a Note with this
// submission's details. Dedupe never crosses modules — the same email can be
// both a consumer Lead and a partner record, which is the point.
async function syncJob(ctx, job, cfg) {
  const email = job.Email;
  const data = safeParse(job.Payload);
  const moduleName = moduleFor(job.Source, cfg);
  const isPartnerModule = moduleName !== 'Leads';

  let recordId = await findRecordByEmail(ctx, moduleName, email);
  let dropped = [];
  if (recordId) {
    // In a partner module the only enrichable field is Phone — the name field
    // is never overwritten, same rule as Leads.
    const upd = isPartnerModule
      ? (data.phone ? { Phone: data.phone } : {})
      : updateFields(job.Source, data);
    if (Object.keys(upd).length) await updateRecord(ctx, moduleName, recordId, upd);
  } else {
    const fields = isPartnerModule
      ? partnerInsertFields(cfg, email, data)
      : insertFields(job.Source, email, data, cfg.isProd);
    const created = await insertRecord(ctx, moduleName, fields);
    recordId = created.id;
    dropped = created.dropped;
  }
  const note = noteFor(job.Source, email, data, cfg.isProd, dropped);
  await addNote(ctx, moduleName, recordId, note.title, note.content);
  return recordId;
}

/* ------------------------------------------------------------------ *
 * Route — POST /  (and /process). Invoked by the cron with ?key=SECRET.
 * ------------------------------------------------------------------ */

// A query-string secret lands in access logs, the cron scheduler's own run
// history, and any Referer header — a header does not. The header is
// preferred and should be the only thing the cron job actually sends; the
// query param still works so this deploy can't silently break a cron target
// that was configured before header support existed. Once the Job Scheduling
// webhook is confirmed to send `X-Cron-Secret` instead, delete the query
// fallback below — the console.error makes it obvious from the logs whether
// anything is still using it.
const LOCK_KEY = 'crm_sync_batch_lock';
// Cache expiry here is in whole hours (Catalyst's segment API has no finer
// grain) — 1h is the crash-recovery ceiling, not the normal hold time. The
// lock is released explicitly in `finally` below on every normal exit, so a
// healthy run only ever holds it for the length of one batch; this TTL only
// matters if a run dies without reaching that release.
const LOCK_TTL_HOURS = 1;

// Accept GET or POST so the run works regardless of the HTTP method the cron
// target uses; the secret key — not the method — is the guard.
app.all(['/', '/process'], async (req, res) => {
  const cfg = config();

  const key = req.headers['x-cron-secret'] || req.query.key;
  if (req.query.key && cfg.cronSecret && req.query.key === cfg.cronSecret) {
    console.error('[crmSync] cron secret received via query string — reconfigure the Job Scheduling webhook to send it as an X-Cron-Secret header instead');
  }
  // No/invalid key: a plain GET is a harmless health check; anything else is denied.
  if (!cfg.cronSecret || key !== cfg.cronSecret) {
    if (req.method === 'GET') return res.json({ ok: true, service: 'crmSync' });
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  // Master switch — lets the function deploy and the cron fire harmlessly
  // until you're ready to actually write to CRM (see runbook).
  if (!cfg.enabled) {
    return res.json({ ok: true, skipped: true, reason: 'CRM_SYNC_ENABLED is not true' });
  }
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    return res.status(500).json({ ok: false, error: 'Zoho credentials not configured' });
  }

  const catalystApp = catalyst.initialize(req);
  const result = { ok: true, processed: 0, synced: 0, failed: 0 };

  // Mutual exclusion for the batch below. `put` creates the cache entry and
  // rejects if it already exists (that's why getAccessToken falls back to
  // `update` on the same call) — so a second overlapping invocation (a manual
  // trigger landing mid-cron, or the cron firing again before a slow batch
  // finishes) fails here and skips instead of racing the first run to select
  // and re-send the same PENDING rows.
  const lockSeg = catalystApp.cache().segment();
  try {
    await lockSeg.put(LOCK_KEY, String(Date.now()), LOCK_TTL_HOURS);
  } catch (err) {
    return res.json({ ok: true, skipped: true, reason: 'a sync is already in progress' });
  }

  try {
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT ROWID, Source, SourceRowId, Email, LeadType, Payload, Attempts ` +
      `FROM ${QUEUE_TABLE} WHERE Status = 'PENDING' ORDER BY CREATEDTIME ASC LIMIT ${cfg.batchSize}`
    );

    if (!rows.length) return res.json({ ...result, note: 'queue empty' });

    const first = await getAccessToken(catalystApp, cfg, false);
    const ctx = {
      token: first.token,
      apiDomain: first.apiDomain,
      refresh: async () => {
        const t = await getAccessToken(catalystApp, cfg, true);
        ctx.token = t.token;
        ctx.apiDomain = t.apiDomain;
      }
    };
    const table = catalystApp.datastore().table(QUEUE_TABLE);

    for (const r of rows) {
      const job = r[QUEUE_TABLE];
      result.processed++;
      try {
        const leadId = await syncJob(ctx, job, cfg);
        await table.updateRow({
          ROWID: job.ROWID,
          Status: 'SYNCED',
          CrmLeadId: String(leadId),
          SyncedAt: nowStr(),
          Attempts: (parseInt(job.Attempts, 10) || 0) + 1,
          LastError: null
        });
        result.synced++;
      } catch (err) {
        const attempts = (parseInt(job.Attempts, 10) || 0) + 1;
        const status = attempts >= cfg.maxAttempts ? 'FAILED' : 'PENDING';
        await table.updateRow({
          ROWID: job.ROWID,
          Status: status,
          Attempts: attempts,
          LastError: String(err).slice(0, 2000)
        });
        result.failed++;
        console.error(`[crmSync] job ${job.ROWID} failed (attempt ${attempts}/${cfg.maxAttempts}):`, err);
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[crmSync] batch error:', err);
    res.status(500).json({ ok: false, error: String(err) });
  } finally {
    try { await lockSeg.delete(LOCK_KEY); } catch { /* TTL covers cleanup either way */ }
  }
});

module.exports = app;
