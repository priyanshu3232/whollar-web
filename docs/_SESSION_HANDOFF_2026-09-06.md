# Session handoff, 2026-09-06

A full Data Store audit, then guided console work with the owner. This is where
it got to, what is still in flight, and the things that turned out not to be true.

**Read these first, in this order:** `STORE_BACKLOG_2026-09.md` (the task list and
what is done), `BACKEND_SETUP.md` (the whole backend, ordered), then
`ACTION_TABLE_AUDIT.md` if you need the detail. All are in `.vercelignore`
because `docs/` IS deployed.

---

## 1. Stop and read this before anything else

**19 messages are sitting in `notification_outbox` waiting to send. 15 of them
are one-time sign-in codes from between 31 August and 5 September.**

`lib/notify/outbox.js` `drain()` has **no age or expiry guard**: it takes
everything `queued` or `held` whose `earliest_send_at` has passed and sends it.
So the first time anything drains that queue, 15 people get a sign-in code that
expired days ago. It will not work, and it reads as an intrusion attempt.

The owner was told to run this and had not confirmed it at handoff:

```sql
UPDATE notification_outbox SET status = 'cancelled'
  WHERE status = 'queued' OR status = 'held'
```

```sql
SELECT status, COUNT(ROWID) FROM notification_outbox GROUP BY status
```

**Check that first.** `queued` and `held` must both read zero before any
scheduled job is created. Nothing is deleted; `cancelled` is a status the code
already uses and the drain ignores.

Those 15 stale codes are also evidence: people asked to sign in over the past
week and the code never went out.

---

## 2. Where the work lives

Branches moved during the session because a peer session is working in the same
tree.

| Branch | Tip | Holds |
|---|---|---|
| `main` | `ab25db5` | the audit, `schema.js`, the registries, the backlog |
| `table-registry` | `3c21dff` | merged into main, done with |
| `tire-profile-attach` | `7cbd3a3` | the peer's work **plus two of ours** |

Six commits were made here. Four are on `main` via the peer's merge:

```
3f1abfb  the audit docs and .vercelignore
73ab6e5  schema.js completed to 49 tables, TABLES.md regenerated
72d6858  the two table registries and the CI gate
3c21dff  the console backlog
```

**Two are stranded on `tire-profile-attach`**, because HEAD had been switched
under us when they were committed:

```
6911527  docs/BACKEND_SETUP.md and its .vercelignore line
7cbd3a3  backlog progress, the Mandatory warning, the CRM cron correction,
         and a create-tables.md typo fix
```

Both are **docs only**, no code. Cherry-pick them onto `main` when convenient:

```
git checkout main && git cherry-pick 6911527 7cbd3a3
```

Nothing is pushed. `git status` also shows several untracked files that belong to
the peer session, not to us.

---

## 3. What was actually done

### The audit (read-only)

Every table name probed against the live Development store with
`catalyst ds:export`; a scheduled job means it exists, `404 No such Table` means
it does not. The header row of each export report is that table's real column
list, which is how the column drift was read without an admin session.

Produced: `ACTION_TABLE_AUDIT.md` (111 actions across six surfaces),
`TABLE_NAMING_GUIDE.md`, `_live_columns.md` (all 60 tables' live columns),
`_phase0_findings.md`, `STORE_BACKLOG_2026-09.md`, `BACKEND_SETUP.md`.

### The code (all on main)

`schema.js` now declares **49** auth tables, up from 44. The five it never knew
about were `provider_applications`, `application_tasks`, `provider_documents`,
`provider_references` and `coverage_verifications`, which is the entire founding
partner application. `verify()` had never checked any of it.

Two registries, one per function, because Catalyst packages each function
separately and there is no module they can share:
`functions/auth/src/lib/tables.js` and `functions/formSubmit/tables.js`.
`scripts/check-table-registry.mjs` refuses to let them disagree and runs in CI.
93 literals across 43 files became registry references, proven to resolve to the
same names as before.

`scripts/check-store-tables.mjs` probes both families for existence. Needs
`catalyst login`, about a minute per table.

### The console work, with the owner

| # | Task | State |
|---|---|---|
| 1 | 3 Unique flags + 2 duplicate rows | done, verified |
| 2 | `CrmSyncQueue` six columns | done, verified |
| 3 | `WaitlistShareCodes`, `ReferralClicks` | done, verified |
| 4 | `campaign_notices` | done, verified |
| 5 | Six owed columns | done, verified |
| 6 | `CityRequests.province` to `Province` | **NOT done**, verified still lowercase |
| 7 | Notification tick job | **in flight**, see section 1 |
| 8 | `consents` env vars | not started |
| 9 | Mail DNS: SPF, DKIM, DMARC | not started |
| - | Section 34, five tables | **deferred by the owner** |

Every "verified" above means the table was re-exported and read, not that the
owner said so. That is how the `task_key` wipe was caught, twice.

Store is **63 of 68 tables**. The five absent are all section 34.

---

## 4. Things that turned out not to be true

Each of these was believed, written down somewhere, and wrong. Check before
trusting any similar claim.

**The Catalyst environment named "Development" is production.** It is the only
one provisioned, `vercel.json` rewrites to it, and the function reports
`NODE_ENV: production` from inside. Real households have rows in it and there is
no staging.

**Adding Mandatory to a populated column rebuilds it and empties it**, silently,
and without bumping the rows' `MODIFIEDTIME` so nothing looks like a write.
`application_tasks.task_key` was wiped twice this way, once on my own
instruction. Recovered from `task_key_org`, which is `${org_id}:${task_key}`.
Unique is safe to add to a populated column; Mandatory is not. **Set Mandatory at
creation or not at all.** `task_key` is deliberately left optional now, so
`/health/diagnostics` will report a `mandatory_mismatch` on it. That report is
correct; leave it.

**The CRM drainer is running**, hourly at about `:20`. The repo said for weeks
that no cron existed. `CrmSyncQueue.SyncedAt` shows 03:20:36, 04:20:40, 05:20:46.
Of 313 rows: 292 SYNCED, 20 PARKED, 1 DEAD.

**`ProductVotes` exists** and `NODE_ENV` is already `production` and
`FILESTORE_DOCS_FOLDER_ID` is already set. All three were recorded as owed.

---

## 5. Live state worth knowing

`GET /api/auth/health` on 2026-09-06:

```
smtp true, mail true, consents FALSE, google FALSE,
admin true, docstore true, crm FALSE
```

`consents: false` means nothing records what anyone agreed to. That is Task 8 and
it needs `TERMS_VERSION`, `PRIVACY_VERSION`, `PARTNER_TERMS_VERSION` on the
`auth` function.

Mail prefers ZeptoMail and every actual delivery goes out over SMTP, so ZeptoMail
is still refusing. Traces to missing SPF, DKIM and DMARC. That is Task 9,
`MAIL_AUTH_RUNBOOK.md`.

**20 rows are PARKED in `CrmSyncQueue`**, held behind `CRM_NEW_SOURCES=true`:
CohortSeats 11, PartnerCoverage 4, PartnerOrgs 3, PartnerSignups 2. Opening that
valve is a deliberate decision and is roughly what the owner means by "sync the
whole backend". **One row is DEAD**: a `TireWaitlistSignups` row Zoho refused
with `INVALID_DATA expected_data_type: email`. Look at that before opening the
valve, because it suggests the tire form is not validating addresses.

---

## 6. Decisions the owner has already made

- **Table prefixes (Option C): dropped.** Registry carries current names plus a
  surface tag.
- **`privacy_requests`: no.** `/me/export` and `/me/delete` already write
  `auth_events`.
- **`schema.js` completed before the registry:** done.
- **Commits on a branch, not straight to main:** done, though the peer merged it.
- **Section 34: deferred**, not cancelled. Building it is 41 columns of console
  work; removing it is about 1,300 lines across four files plus 10 routes.

---

## 7. How to work with this owner

They move fast, do the console steps immediately, and report back briefly. The
method that worked:

- **One task at a time.** Give the exact columns, flags and the ZCQL check. Wait.
- **Verify every "done" by re-exporting the table**, not by taking the report at
  face value. That caught two silent data wipes.
- **Give exact ROWIDs and expected row counts** so a silent no-op is
  distinguishable from a real change.
- **ZCQL's LIKE wildcard is `*`, not `%`.** A `%` pattern matches nothing and
  reports success.
- Column-level facts come from `catalyst ds:export`, the CSV header is the column
  list. The CLI only offers the report download when its stdout is a pipe, not a
  file, and it needs `--project Whollar` when run outside `catalyst-backend/`.

---

## 8. The immediate next three things

1. **Confirm the outbox is drained of stale rows** (section 1). Nothing else
   until that reads zero.
2. **Finish Task 7**: manual `curl` of `/admin/notify/tick` with the
   `x-cron-secret` header, then create the Job Scheduling entry every 15 minutes.
   Copy the shape of the existing CRM job.
3. **Task 6**, the `province` rename, whenever. Save the rows first: unlike
   `task_key` there is no twin column to recover from.
