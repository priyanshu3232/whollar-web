# Zoho CRM sync — setup runbook

How leads flow from the website into Zoho CRM, and the one-time console setup
needed to turn it on. The code is already deployed by the pipeline; the steps
below are the parts only you can do in the Catalyst / CRM consoles.

> ## ⚠ Open items that only console access can fix
>
> These came out of the July 2026 audit. The code changes are in; these are
> the parts that cannot be done from the repository.
>
> **1. There is no production Catalyst environment.** `.catalystrc` declares
> exactly one environment — id `110003037934`, type 3, **Development** — and
> `.github/workflows/deploy-functions.yml` deploys to it by name. Every form on
> the live site therefore writes to a development Data Store. Create the
> production environment, then change `CATALYST_HOST` in
> [`js/whollar-core.js`](../js/whollar-core.js) (one line, used by every page)
> and the `--project` / env args in the deploy workflow.
>
> **2. Confirm the cron job exists and `CRM_SYNC_ENABLED=true`.** With the
> switch off, `crmSync` returns `{ok:true, skipped:true}` and the queue grows
> forever without erroring. Check with:
> `SELECT COUNT(ROWID) FROM CrmSyncQueue WHERE Status = 'PENDING'`
>
> **3. Pre-create the `Lead_Source` picklist options** (Setup → Customization →
> Modules → Leads → Lead_Source). Zoho rejects a picklist value that is not
> already defined, so a missing option used to fail every insert, retry six
> times, and land the lead on `FAILED` — silent total lead loss. `crmSync` now
> drops the offending field and retries so the lead still lands, but the
> attribution is lost until these exist:
> `Whollar Waitlist`, `Whollar Waitlist Details`, `Whollar Bill Checkup`,
> `Whollar Deep Read`, `Whollar Partner Application` — plus the same five with
> a ` [dev]` suffix while `CRM_ENVIRONMENT` is not `production`.
> Also confirm `Rating` accepts `Hot` (it does by default).
>
> **4. Set a File Store retention policy.** Uploaded bills contain a name,
> service address and account number. Nothing in this repo deletes them. Decide
> a retention window and enforce it in the console (PIPEDA / Quebec Law 25).
>
> **5. Optional Data Store columns.** Consent and verdict data currently ride
> in the `CrmSyncQueue.Payload` JSON and reach the CRM Note, but are not
> columns on the source tables — adding a column that does not exist in the
> console makes `insertRow` fail outright, so the code deliberately does not
> write them. To persist them as first-class fields, create these and add them
> to the row objects in `functions/formSubmit/index.js`:
> `ConsentGranted` (boolean), `ConsentText` (text), `ConsentAt` (datetime),
> `ConsentSource` (text), `Verdict` (text), `EffectiveCost` (double),
> `PostalCode` (text), `ProvinceCode` (text).

## How it works

```
Website form
   → formSubmit  (saves the row in Data Store, then adds a job to CrmSyncQueue)
        → CrmSyncQueue table  (a to-do list of leads waiting to reach CRM)
             → crmSync  (cron runs it every few minutes; pushes each job to Zoho CRM)
                  → Zoho CRM Lead  (created/updated by email, + a Note with the details)
```

Why a queue: a form submission NEVER fails because CRM is slow or down — it just
saves a row and a job. `crmSync` drains the queue on a schedule and retries
anything that failed, so no lead is lost. Only `crmSync` holds the Zoho
credentials; `formSubmit` has none.

Which forms become leads: Waitlist, Waitlist details, Bill checkup, Deep read
(marked "Hot"), and Partner applications. The anonymous savings calculator is
NOT synced (no name/email — there's no person to create).

---

## Step 1 — Create the `CrmSyncQueue` table (Cloud Scale → Data Store)

New Table, name it exactly **`CrmSyncQueue`**, and add these columns. Leave
every column **not mandatory** (so a partial insert can never fail):

| Column        | Type       | Max length | Notes                    |
| ------------- | ---------- | ---------- | ------------------------ |
| `Source`      | Text       | 255        | which form               |
| `SourceRowId` | Text       | 255        | ROWID of the source row  |
| `Email`       | Text       | 255        | lead email               |
| `LeadType`    | Text       | 50         | consumer / partner       |
| `Payload`     | Text       | 25000      | submission data (JSON)   |
| `Status`      | Text       | 50         | PENDING/SYNCED/FAILED    |
| `Attempts`    | Number     | —          | retry counter            |
| `LastError`   | Text       | 25000      | last failure message     |
| `CrmLeadId`   | Text       | 255        | the created CRM lead id  |
| `SyncedAt`    | Date-Time  | —          | when it reached CRM      |

`ROWID`, `CREATEDTIME`, `MODIFIEDTIME` are added automatically — don't create them.

## Step 2 — Set environment variables on `crmSync` (Serverless → Functions → crmSync)

Open the `crmSync` function → its configuration / Environment Variables, and add:

| Variable             | Value                                        |
| -------------------- | -------------------------------------------- |
| `ZOHO_CLIENT_ID`     | from the Self Client → Client Secret tab     |
| `ZOHO_CLIENT_SECRET` | from the Self Client → Client Secret tab     |
| `ZOHO_REFRESH_TOKEN` | the refresh token you generated              |
| `ZOHO_ACCOUNTS_URL`  | `https://accounts.zohocloud.ca`              |
| `ZOHO_API_DOMAIN`    | `https://www.zohoapis.ca`                    |
| `CRM_CRON_SECRET`    | a long random string you invent (the cron's password) |
| `CRM_ENVIRONMENT`    | `development` (in prod, set `production`)     |
| `CRM_SYNC_ENABLED`   | `false`  ← leave OFF until Step 4            |
| `CRM_PARTNER_MODULE` | *(optional)* module partner applications land in — see below |
| `CRM_PARTNER_NAME_FIELD` | *(optional)* that module's name field, if not the default |

(If your CRM is on the US DC instead, use `accounts.zoho.com` / `www.zohoapis.com`.)

`CRM_SYNC_ENABLED=false` is the safety switch: the function deploys and the cron
can fire, but nothing is written to CRM yet. `CRM_ENVIRONMENT=development` tags
every test lead's source as `… [dev]` and note titles as `[DEV] …`, so test data
is one filter away from deletion in CRM.

### Partner module — landing provider leads in their own module

By default everything lands in **Leads**, with `Lead_Source` telling consumer
and provider apart. To give partner applications their **own module** instead,
set `CRM_PARTNER_MODULE` (no redeploy needed — env vars are read per run):

- **`Vendors`** — the built-in module; zero Zoho setup. The record's name
  becomes the applicant's company (`Vendor_Name`), Email and Phone carry over,
  and the full application (role, provinces, access techs, LOA…) is attached
  as a Note, exactly like before.
- **A custom module** (e.g. `Partners`, Enterprise edition and up): create it
  in Setup → Customization → Modules, then set `CRM_PARTNER_MODULE` to its
  **API name** (Setup → Developer Hub → APIs → API Names — often plural, e.g.
  `Partners`). Requirements: an **Email**-type field with API name `Email`
  (used for dedupe search), and if its mandatory name field isn't called
  `Name`, set `CRM_PARTNER_NAME_FIELD` to its API name.

Behaviour once set:

- Consumer sources (waitlist, bill checkup, deep read) still become Leads;
  only `PartnerApplications` rows go to the partner module. Dedupe is
  **per-module**: the same email can be a consumer Lead *and* a partner
  record — that's the point.
- `Lead_Source` / `Company` / `Rating` are Leads-only fields and are not sent
  to the partner module (they'd be rejected as INVALID_DATA); the `[DEV]` tag
  still appears in the Note title outside production.
- Partner applications synced **before** the switch stay in Leads; move them
  by hand once (Zoho has a Mass Transfer/convert tooling) or just delete the
  `[dev]`-tagged ones.
- If the module name is wrong or its Email field is missing, those queue rows
  fail with a clear `<module> search 400/INVALID_MODULE` in `LastError`,
  retry up to `CRM_MAX_ATTEMPTS`, and consumer syncs are unaffected.
- The Self Client scope must cover the module. A refresh token minted with
  `ZohoCRM.modules.ALL` covers Vendors and custom modules; one scoped only to
  `ZohoCRM.modules.leads.*` does not — check the scope you used and mint a new
  token if needed (a `OAUTH_SCOPE_MISMATCH` in `LastError` is the symptom).

## Step 3 — Create the cron (Cloud Scale → Cron, or Job Scheduling)

- New Cron → schedule: every 5 minutes (or 15 — your call).
- Target type: **Third-party URL** (Webhook).
- Method: **POST**.
- URL: your crmSync function URL with the secret, e.g.
  `https://whollar-<id>.development.catalystserverless.ca/server/crmSync/process?key=YOUR_CRM_CRON_SECRET`
  (copy the exact function URL from the crmSync function page; append
  `/process?key=…`).

## Step 4 — Test on Development, THEN go live

1. Confirm the pipeline deployed `crmSync` (GitHub Actions green; the function
   appears under Serverless → Functions).
2. With `CRM_SYNC_ENABLED=false`, submit a test form on the dev site → check
   **Data Store → CrmSyncQueue**: a row should appear with `Status = PENDING`.
   (This proves formSubmit → queue works, with zero CRM risk.)
3. Flip `CRM_SYNC_ENABLED=true`. Trigger the worker once manually (or wait for
   the cron):
   ```
   curl -X POST "https://whollar-<id>.development.catalystserverless.ca/server/crmSync/process?key=YOUR_CRM_CRON_SECRET"
   ```
   Expect `{"ok":true,"processed":1,"synced":1,"failed":0}`.
4. Check Zoho CRM → Leads: a new lead tagged `Whollar … [dev]` with a Note. The
   queue row should now read `Status = SYNCED`. Watch **DevOps → Logs** for
   `crmSync` if anything is off; failures land in the row's `LastError`.
5. Create a **DevOps → Application Alert** on `crmSync` failed executions so you
   get emailed if the sync breaks.

When it all checks out in dev, promote to Production, and in the **Production**
environment set `CRM_ENVIRONMENT=production`, `CRM_SYNC_ENABLED=true`, the
production function URL in the cron, and the same Zoho variables.

## Troubleshooting

- `403 forbidden` from the curl → the `?key=` doesn't match `CRM_CRON_SECRET`.
- `skipped … CRM_SYNC_ENABLED is not true` → flip the switch to `true`.
- `token refresh failed` → wrong `ZOHO_*` creds or wrong DC domain.
- Rows stuck `PENDING`, never SYNCED → the cron isn't hitting the URL (check the
  cron's URL/method) — the manual curl in Step 4 isolates cron vs. code.
- Row `FAILED` with a `LastError` → read it; a bad field/scope shows here.
