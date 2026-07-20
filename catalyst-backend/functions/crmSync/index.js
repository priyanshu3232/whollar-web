'use strict';

/* ------------------------------------------------------------------ *
 * crmSync — cron-invoked worker that drains the CrmSyncQueue table and
 * pushes each queued form submission into Zoho CRM as a Lead (+ a Note
 * capturing the submission's details).
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
  maxAttempts: Math.max(1, parseInt(process.env.CRM_MAX_ATTEMPTS || '6', 10))
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

async function findLeadByEmail(ctx, email) {
  const criteria = encodeURIComponent(`(Email:equals:${email})`);
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/Leads/search?criteria=${criteria}`, { headers: authHeaders(token) }));
  if (resp.status === 204) return null;              // 204 = no match
  if (!resp.ok) throw new Error(`lead search ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data?.data?.[0]?.id || null;
}

async function insertLead(ctx, fields) {
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/Leads`, {
      method: 'POST', headers: authHeaders(token), body: JSON.stringify({ data: [fields] })
    }));
  const data = await resp.json();
  const rec = data?.data?.[0];
  if (rec?.code !== 'SUCCESS') throw new Error(`lead insert failed: ${JSON.stringify(data)}`);
  return rec.details.id;
}

async function updateLead(ctx, leadId, fields) {
  const resp = await callCrm(ctx, (token, apiDomain) =>
    fetch(`${apiDomain}/crm/v8/Leads/${leadId}`, {
      method: 'PUT', headers: authHeaders(token), body: JSON.stringify({ data: [fields] })
    }));
  const data = await resp.json();
  const rec = data?.data?.[0];
  if (rec?.code !== 'SUCCESS') throw new Error(`lead update failed: ${JSON.stringify(data)}`);
}

// Notes are best-effort — a failed note must not fail the whole job, because
// the Lead (the important part) is already written.
async function addNote(ctx, leadId, title, content) {
  try {
    const resp = await callCrm(ctx, (token, apiDomain) =>
      fetch(`${apiDomain}/crm/v8/Notes`, {
        method: 'POST', headers: authHeaders(token), body: JSON.stringify({
          data: [{
            Note_Title: String(title).slice(0, 120),
            Note_Content: String(content).slice(0, 32000),
            Parent_Id: leadId,
            se_module: 'Leads'
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
  PartnerApplications:    { label: 'Partner Application', hasName: true, hasCompany: true }
};

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

function noteFor(source, email, data, isProd) {
  const meta = SOURCE_META[source] || { label: source };
  const devTag = isProd ? '' : '[DEV] ';
  const lines = [];
  if (meta.hot) lines.push('⚠ DEEP READ REQUESTED — high intent');
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${v}`); };
  add('Provider', data.provider);
  add('Monthly cost', data.cost);
  add('Download speed', data.speed);
  add('Access tech', data.tech);
  add('Promo end', data.promoEnd);
  add('Months to renewal', data.monthsToRenewal);
  add('Discount', data.discount);
  add('Switch threshold', data.threshold);
  add('FSA', data.fsa);
  add('Postal code', data.postal);
  add('Referral code', data.referral);
  add('Role', data.role);
  add('Provinces', data.provinces);
  add('Access techs', data.techs);
  add('Services', data.services);
  add('Note', data.note);
  add('Attachments', data.files);
  add('Bill file', data.billFileName);
  add('Via', data.via);
  return {
    title: `${devTag}Whollar ${meta.label} — ${email}`.trim(),
    content: lines.length ? lines.join('\n') : `Submission via ${meta.label}.`
  };
}

// Search-then-write: update an existing lead (matched by email) or create one,
// then always attach a Note with this submission's details.
async function syncJob(ctx, job, isProd) {
  const email = job.Email;
  const data = safeParse(job.Payload);

  let leadId = await findLeadByEmail(ctx, email);
  if (leadId) {
    const upd = updateFields(job.Source, data);
    if (Object.keys(upd).length) await updateLead(ctx, leadId, upd);
  } else {
    leadId = await insertLead(ctx, insertFields(job.Source, email, data, isProd));
  }
  const note = noteFor(job.Source, email, data, isProd);
  await addNote(ctx, leadId, note.title, note.content);
  return leadId;
}

/* ------------------------------------------------------------------ *
 * Route — POST /  (and /process). Invoked by the cron with ?key=SECRET.
 * ------------------------------------------------------------------ */

// Accept GET or POST so the run works regardless of the HTTP method the cron
// target uses; the secret key — not the method — is the guard.
app.all(['/', '/process'], async (req, res) => {
  const cfg = config();

  const key = req.query.key || req.headers['x-cron-secret'];
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
        const leadId = await syncJob(ctx, job, cfg.isProd);
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
  }
});

module.exports = app;
