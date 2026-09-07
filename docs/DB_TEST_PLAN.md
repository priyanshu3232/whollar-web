# Database test plan, all three hosts

How to establish that every table in the Data Store is reachable, written
correctly, and read back correctly. Ordered so that a failure early on does not
produce false failures later.

**The one rule this plan exists to enforce: verify by exporting the table and
reading it, never by the form's confirmation screen.** Most side-table inserts
in `formSubmit` go through `insertTolerant`, which logs a failure and still
returns `ok:true`. A 200 proves the main row landed and nothing else. Every
"check" below is a read of the store, not a read of the response.

The environment is **Development**, which is production: it is the only one
provisioned, all three hosts rewrite to it, and the function reports
`NODE_ENV: production` from inside. There is no staging. Test data lands beside
real households, so tag it and clean it up.

---

## Phase 0. Preconditions

Nothing below is meaningful until these are true.

### 0.1 The CLI can read the store

```
catalyst whoami
catalyst project:list
```

Both must answer. Column facts come from `catalyst ds:export --table X --page 1`,
whose CSV header is that table's real column list. The CLI only offers the
report download when its stdout is a **pipe, not a file**, and it needs
`--project Whollar` when run outside `catalyst-backend/`.

### 0.2 The CRM cron secret matches

`CRM_CRON_SECRET` on `crmSync` must equal what the Job Scheduling job sends.
While they disagree, every CRM assertion in Phase 4 is a false negative and
every queued row stays `PENDING`.

```
curl -X POST -H "X-Cron-Secret: <value>" \
  "https://whollar-110003037934.development.catalystserverless.ca/server/crmSync/process"
```

`{"ok":true,...}` passes. `403` means fix it before going further.

### 0.3 Live is not disk

Deployed JavaScript has been behind `origin/main` on the tire host. Auditing a
local checkout answers a question nobody asked.

```
curl -s https://tires.whollar.ca/js/tire-kit.js | shasum -a 256
git -C ~/whollar-tires show origin/main:js/tire-kit.js | shasum -a 256
```

Do this for every file whose form you are about to test. Where they differ, the
live file is the subject of the test. The same applies to the backend: confirm
the deployed `formSubmit` matches `HEAD` before trusting any read of its source.

---

## Phase 1. Existence and shape

### 1.1 Every registered table exists

```
node scripts/check-store-tables.mjs
```

Probes both families from the two registries. About a minute per table. A
`MISSING` line is a finding, not a script failure; the five known absences are
all section 34, deferred.

### 1.2 Every auth column and flag is right

Sign in as an admin, then:

```
GET /api/auth/health/diagnostics
```

This covers all 49 auth tables including the five partner-application ones, and
reports every missing column and every wrong Unique or Mandatory flag. It is the
one request that replaces a hand audit.

Expect one **known and correct** report: `mandatory_mismatch` on
`application_tasks.task_key`. That column is deliberately optional. Adding
Mandatory to a populated column rebuilds it and empties it, silently, without
bumping `MODIFIEDTIME`. Leave it.

### 1.3 Feature switches

```
GET /api/auth/health
```

Read `features`. `consents:false` means nothing records what anyone agreed to.
`crm:false` and `google:false` are expected today.

---

## Phase 2. The write path, formSubmit family

One submission per route. Use a tag such as `QAAUDIT<date>` in a name field and
a distinct address per route on a domain you own, so every row is findable and
removable.

Post as the browser does: the pages send `Content-Type: text/plain`, and the
function accepts `application/json` and `text/plain` only.

Base: `https://whollar-110003037934.development.catalystserverless.ca/server/formSubmit`

| # | Route | Host surface | Tables to export and read |
|---|---|---|---|
| 2.1 | `/waitlist-join` | www join | `WaitlistSignups` |
| 2.2 | `/waitlist-details` | www join step 2 | `WaitlistDetails` |
| 2.3 | `/bill-checkup-join` | internet checkup | `BillCheckupSubmissions` |
| 2.4 | `/calculator-estimate` | internet estimator | `CalculatorEstimates` |
| 2.5 | `/deep-read` | internet | `DeepReadRequests` |
| 2.6 | `/partner-application` | internet partners | `PartnerApplications` |
| 2.7 | `/contact` | shared | `ContactSubmissions` |
| 2.8 | `/city-request` | shared | `CityRequests` |
| 2.9 | `/product-vote` | home | `ProductVotes` |
| 2.10 | `/waitlist-email` | corner popup, all hosts | `WaitlistEmails`, `WaitlistShareCodes` |
| 2.11 | `/ref-click` | shared link arrival | `ReferralClicks` |
| 2.12 | `/tire-waitlist-join` quick | tires modal | `TireWaitlistSignups`, `TireWaitlistVehicles`, `TireCohortCounter` |
| 2.13 | `/tire-waitlist-join` guided | tires modal | the three above plus `TireWaitlistDetails`, `TireInstallWindows`, `TireToolRuns` |
| 2.14 | `/tire-waitlist-join` `stage:profile` | tires attach | all tire side tables, plus re-read the signup row |

Every row also enqueues to `CrmSyncQueue`, checked in Phase 4.

### How to check one route

1. POST it, note the HTTP status and any returned reference or id.
2. Export **every** table in that row, not just the first.
3. For each landed row, list which columns hold a value and which are empty.
4. Compare the empty list against what you sent. A field you sent that came back
   empty is the finding.

Step 4 is the whole point. A column can exist, accept the insert, and still be
empty because the frontend named the field differently or dropped it before the
wire.

### Known traps at this phase

- **A field collected but never sent.** Check the payload builder in the live
  JS, not the form markup. A question can be on screen, stored in the page's
  own record, and dropped at the payload boundary.
- **Nested versus flat.** A payload sending `consent: {granted:true}` does not
  satisfy a backend reading `b.consentEmail`, and the row stores `false` with no
  error anywhere.
- **Name mismatches.** `tools` versus `toolRuns` is silent data loss.
- **Unique key collisions on a second write.** Keys derived from a reference,
  such as `VehicleKey` = `${reference}:1`, collide when the same household
  submits twice. `insertTolerant` swallows the refusal and the update is lost.
- **Counters move.** A tire signup increments `TireCohortCounter`, which feeds
  the household count shown on the site. Note the value before you start.

---

## Phase 3. The write path, auth family

These need a session, so drive them from the browser rather than curl.

1. **Sign in** with an OTP. Confirm the code arrives, then read `auth_challenges`
   and `auth_events`.
2. **Join a cohort** from the member dashboard. Read `campaign_members`,
   `claim_event` and the seat count.
3. **Leave and rejoin** to exercise the pass path. Read `claim_event` again.
4. **Partner application**: submit one and read `provider_applications`,
   `application_tasks`, `provider_documents`, `provider_references`,
   `coverage_verifications`.
5. **Coverage declaration** as a partner, then a **sealed bid**. Read
   `provider_bids` and `bid_revisions`. Bids are append-only; there is no
   withdraw path and there must not be one.
6. **Terms acceptance**. Read `provider_terms`.

Two-insert probes are the only way to prove a Unique flag on a table with too
few rows to have collided naturally. Insert the same key twice from the ZCQL
tab; the second must be refused. Delete the probe row afterwards.

---

## Phase 4. The asynchronous legs

A row landing in a queue is not the same as it arriving.

### 4.1 CRM

```sql
SELECT Source, Status, Email, Attempts, LastError, SyncedAt
  FROM CrmSyncQueue ORDER BY CREATEDTIME DESC LIMIT 20
```

Every Phase 2 submission should appear. After a cron run they should read
`SYNCED` with a `CrmLeadId`. `PARKED` means held behind `CRM_NEW_SOURCES`.
`DEAD` means Zoho refused it: read `LastError` and fix the source, because a
refusal is usually a validation gap upstream.

Then confirm the record actually exists in Zoho CRM. The queue saying `SYNCED`
is the sender's opinion.

### 4.2 Notifications

```sql
SELECT status, COUNT(ROWID) FROM notification_outbox GROUP BY status
```

`queued` and `held` should drain to zero on the tick's schedule. Anything
sitting for longer than one interval means the job is not running or not
authenticating.

Security mail (`account.otp`) is sent **inline** and never waits for the drain,
so a stuck OTP row means the inline send failed, which is a different fault from
a missing cron.

The drain has **no age guard**. Before creating or re-enabling the job, cancel
anything stale, or expired sign-in codes go out to real people:

```sql
UPDATE notification_outbox SET status = 'cancelled'
  WHERE status = 'queued' OR status = 'held'
```

---

## Phase 5. Read-back

Writing is half of it. For each surface, confirm the data comes back:

- member dashboard renders the cohort, seat count and stage from the server
- partner console renders coverage, bids and contracts
- admin console renders the campaign list and reconcile check
- `/pooling-count` returns a live number
- a shared referral link resolves and records a click

No campaign card, seat count or household count may come from a seed array or
fallback catalog. `lib/cohorts.js` is the one read layer for campaign state.

---

## Phase 6. Cleanup

1. Collect the ROWIDs of every tagged row, per table, from the exports.
2. `DELETE FROM <table> WHERE ROWID IN (...)` in the ZCQL tab. The CLI has no
   delete command; this is console work.
3. **Reset counters by reading first.** `TireCohortCounter` must be re-read and
   decremented by the number of test signups, never set to a remembered number:
   a real household joining in the meantime would be erased.
4. Delete the `CrmSyncQueue` rows **before** the CRM cron runs, or the test
   households land in the real CRM.
5. Remove any two-insert probe rows.

---

## Notes that save time

- **ZCQL's LIKE wildcard is `*`, not `%`.** A `%` pattern matches nothing and
  reports success.
- **Unique is safe to add to a populated column. Mandatory is not**: it rebuilds
  the column and empties it. Set Mandatory at creation or not at all.
- Auth tables are `lower_snake_case`, formSubmit tables are `PascalCase`, on
  purpose. The writing function decides the case, nothing else.
- `catalyst ds:export` schedules a job. "Already under processing" means a
  previous export still holds that table: wait and re-run.
