# Zoho CRM sync — setup runbook

How leads flow from the website into Zoho CRM, and the one-time console setup
needed to turn it on. The code is already deployed by the pipeline; the steps
below are the parts only you can do in the Catalyst / CRM consoles.

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

(If your CRM is on the US DC instead, use `accounts.zoho.com` / `www.zohoapis.com`.)

`CRM_SYNC_ENABLED=false` is the safety switch: the function deploys and the cron
can fire, but nothing is written to CRM yet. `CRM_ENVIRONMENT=development` tags
every test lead's source as `… [dev]` and note titles as `[DEV] …`, so test data
is one filter away from deletion in CRM.

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
