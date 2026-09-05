# Phase 0 audit: Catalyst to Zoho CRM event sync

Written against the build brief of 2026-09-02. No production code was written for
this brief. Four of its premises are contradicted by the codebase and are listed
first, because three of them change the shape of the work rather than a detail of
it.

## Headline: four premises to settle before Phase 1

**1. There is no `campaign_events` spine. It has never existed.**

The brief calls it "the append-only spine and the authoritative state record"
and derives the outbox from it. No such table exists, and this is not a new
discovery: three prior audits in this repo already record it, at
[docs/PHASE0-NOTIFICATIONS-AUDIT.md:203](PHASE0-NOTIFICATIONS-AUDIT.md),
[docs/DELIVERY_AUDIT.md:131](DELIVERY_AUDIT.md) and
[docs/MULTI_CAMPAIGN_AUDIT.md:109](MULTI_CAMPAIGN_AUDIT.md), the last of which
calls the current state "four disjoint append-only logs".

What exists instead: `auth_events` (the audit trail), `bid_revisions` (the
sealed record), `claim_event`, `share_event`, `user_events`,
`notification_deliveries`, `invite_click`. Seven logs, no spine.

Consequence: `source_event_rowid`, the repair scan in Phase 5.1, and the
ordering rule "business row, then spine event, then outbox" have nothing to
point at. Either the spine gets built first, which is a much larger project than
this sync, or the outbox is written directly from the business write and the
repair scan keys off the business tables instead.

**2. Partner lifecycle has three states, not sixteen.**

`APPROVAL` is `['pending', 'approved', 'rejected']`,
[lib/orgs.js:28](../catalyst-backend/functions/auth/src/lib/orgs.js). D1's
"lifecycle state as picklist mirroring the 16 partner states" and
`partner.state_changed` carrying from and to have three values to move between.
There is a richer state machine on the application itself,
`provider_applications.state`: draft, submitted, under_review, info_needed,
approved, rejected, six values, runbook section 17. If sixteen states are
wanted, they do not exist yet and designing them is its own piece of work.

**3. `amount_cents` does not exist. Money in this stack is a string.**

Zero occurrences repo-wide. `provider_bids.price`, `provider_orders.price` and
`campaign_awards.price` are all `varchar(16)`; the one place cents are used is
`provider_bids.discount_mix`, the sealed custom mix, section 28. So D1's "Amount
= expected success fee in dollars, derived from `amount_cents` in the seal
payload" has no source field.

There is a second problem with that line. The success fee is not on the order at
all: it is `site_config.success_fee`, read through
[lib/billing.js:217](../catalyst-backend/functions/auth/src/lib/billing.js), and
CLAUDE.md states it is configuration on the agreement and never a constant. A
third session is at this moment adding `provider_orgs.lead_rate` to override it
per company, uncommitted in the working tree. A Deal amount copied at enqueue
time would be a snapshot of a number that is being made per-partner this week.

**4. Job Scheduling will not run every 5 minutes.**

D5 proposes 5 minutes. The console refused any Periodic interval under **60
minutes** when this was attempted on 2026-09-01. The live job `crmSyncdrain`,
id 1258000000017880, is hourly for that reason. Sub-hourly may be reachable
through a Cron Expression job type, untested, or it may be a plan limit. At the
current volume, roughly five leads a day, hourly is ample; the brief should
either accept 60 minutes or fund an investigation.

---

## 1. Existing outbox

**Implemented, correct for what it does, roughly half the brief's columns.**

Table `CrmSyncQueue`, created by hand, documented at
[catalyst-backend/CRM_SYNC_RUNBOOK.md:71](../catalyst-backend/CRM_SYNC_RUNBOOK.md).

| Brief wants | Today | Gap |
| --- | --- | --- |
| `entity_type` | `Source` (form or event name) | rename in meaning, not shape |
| `entity_rowid` | `SourceRowId` | present |
| `event_type` | folded into `Source` | absent as its own column |
| `event_version` | | absent |
| `idempotency_key` unique | | **absent, and this is the load-bearing one** |
| `payload_json` | `Payload`, Text 25000 | present |
| `status` | `Status` | values differ, see below |
| `attempt_count` | `Attempts` | present |
| `next_attempt_at` | | absent |
| `last_error` | `LastError` | present |
| `delivered_at` | `SyncedAt` | present |
| `crm_record_id` | `CrmLeadId` | present |
| `source_event_rowid` | | absent, and has nothing to reference (premise 1) |

Status values today are `PENDING`, `SYNCED`, `FAILED`, plus `PARKED` added
2026-09-01. The brief wants pending, in_progress, delivered, failed, dead. Three
of the five map; `in_progress` and `dead` are new.

**Processed-marking is ROWID-keyed and correct.** `table.updateRow({ ROWID: job.ROWID, ... })`
in [crmSync/index.js](../catalyst-backend/functions/crmSync/index.js), and
`lib/datastore.js:187` throws a TypeError if `updateRow` is called without one.
The brief's item 1 concern does not apply here.

**Every column addition is manual console work.** Catalyst has no DDL API. Nine
new columns means nine hand edits in the console before any code that names them
can deploy, and a projection naming a column that does not exist empties the
whole surface. See the column-ladder rule in CLAUDE.md.

## 2. Existing scheduled job

**Implemented, with three gaps against the brief.**

Job Scheduling job `crmSyncdrain`, Periodic, hourly, target type URL webhook,
POST to `/server/crmSync/process` with the secret as `?key=`. It was created
2026-07-23 and **delivered nothing until 2026-09-01**, because the URL carried
the literal placeholder `<CRM_CRON_SECRET>` and every run was refused in 8 to 30
milliseconds. Fixed; the backlog of 195 drained on its own overnight.

- **Batch**: `CRM_BATCH_SIZE`, default 50, `ORDER BY CREATEDTIME ASC`. Under the
  300-row cap, but **the cap is not asserted and there is no pagination**. Brief
  item 3.1 wants both.
- **Concurrency**: a single Catalyst Cache batch lock, `crm_sync_batch_lock`,
  1 hour TTL, released in `finally`. **Not** the per-row `in_progress` claim with
  an affected-row check the brief asks for. The lock is correct for one drainer
  and gives no protection if the brief's `in_progress` state is added later.
- **Retry**: `CRM_MAX_ATTEMPTS`, default 6, then `FAILED`. **There is no backoff
  of any kind**: zero occurrences of `next_attempt_at`, `Retry-After` or any
  delay. A failing row is re-marked `PENDING` and retried on the very next run.
  No 401 refresh-once-then-fail path, no 429 handling, no 4xx versus 5xx
  classification, no `dead` state, no admin digest.
- **Auth**: refresh-token flow, access token cached in Catalyst Cache with TTL,
  credentials from environment variables, never in code. Correct.
- **Data centre**: `accounts.zohocloud.ca` and `www.zohoapis.ca`,
  [crmSync/index.js:33-34](../catalyst-backend/functions/crmSync/index.js).
  **CA confirmed.** No stop condition.

## 3. Existing CRM mapping

**Search-then-write, not upsert. Dedupe by email. No Catalyst identifier in CRM.**

`findRecordByEmail` searches `(Email:equals:...)`, then `updateRecord` or
`insertRecord`, then always `addNote`. Modules: `Leads` for households,
`CRM_PARTNER_MODULE` for partner sources, defaulting to `Leads` so nothing moves
until an operator sets it. Fields written: `Email`, `Last_Name`, `Company`,
`Lead_Source`, `First_Name`, `Phone`, `Rating`, and since 2026-09-02 `Zip_Code`
and `State`.

**No field holds a Catalyst identifier.** There is no `Whollar_ROWID` anywhere,
in code or in CRM. D4's dedupe key does not exist yet and is the single largest
prerequisite in the brief: without it every resync duplicates, and Accounts
cannot be deduped at all because Zoho gives Accounts no standard Email field.

`Lead_Source` is deliberately never rewritten on update, first touch wins, so a
record's origin survives enrichment.

## 4. Business write sites

Of the seventeen writes the brief lists, **sixteen already enqueue**, committed
2026-09-01 in `3c725d0` and extended 2026-09-02. This is the one area where the
brief is asking for work that largely exists, under a different event vocabulary.

| Brief's event | Site | State |
| --- | --- | --- |
| household account created | `routes/otp.js` | done, `MemberSignups`, on `created` only |
| account verified | same path | same event, not separable today |
| household details entered | `routes/me.js` `/me/profile` | done, `MemberProfiles`, uncommitted |
| cohort join | `routes/seat.js`, `routes/campaigns.js` | done, `CohortSeats` |
| cohort exit | both, plus move and pass | done, `CohortSeats` |
| partner application submitted | `routes/application.js` | done, `ProviderApplications` |
| partner state transitions | `routes/admin.js` approve and reject | done, `PartnerApprovals` |
| coverage added or retired | `routes/desk.js` `/provider/coverage` | **absent** |
| sealed bid submitted | `routes/desk.js` | done, `SealedBids` |
| bid revised | `routes/desk.js` improve | done, `SealedBids` |
| campaign closed | `routes/admin.js` transition | **absent** |
| campaign awarded | `lib/awards.js` `sealBook` | **absent, deliberately**, see below |
| switch order created | `routes/campaigns.js` offer accept | done, `HouseholdOrders` |
| order state transitions | `routes/delivery.js` slot, exception | done, `HouseholdOrders` |
| activation confirmed | `routes/delivery.js` activate | done, `HouseholdOrders` |
| statement issued, paid, failed | `lib/billing.js` | **absent** |
| terms accepted, billing on file | `routes/contracts.js`, `routes/billing.js` | done, beyond the brief |

**Award is absent on purpose.** Its only trigger is `awards.sealBook()`, which
seals lazily inside a member's offer read and returns the same value whether it
just sealed or is re-reading an existing seal. A call site there is both racy and
aimed at the wrong audience. It needs a real trigger before it can be wired.

## 5. Spine coverage

**Absent, as premise 1. Nothing to check against.**

The enqueue calls sit beside the existing `audit.recordAsync` in each handler,
which is the closest thing this codebase has to an event record and is
explicitly a security trail, not a business spine.

## 6. Existing partial CRM code

**One implementation, no competitors.** `crmSync` plus `lib/crmqueue.js` plus the
`CrmSyncQueue` table. No `crm_sync_state`, no event functions, no second drainer.
`users.crm_contact_id` exists as a column, is written `null` at creation
([lib/users.js:189](../catalyst-backend/functions/auth/src/lib/users.js)) and is
never updated: a dead field that D4 should either use or drop.

`config.js` declares a `crm` GROUP of `ZOHO_CRM_*` variables that **no auth code
reads**, so `/api/auth/health` reports `crm:false` permanently regardless of
whether sync works. Dead configuration; recommend deleting.

## 7. Unscoped queries

Not fully audited: this needs a pass of its own and should not be folded into a
CRM task. Two observations. `lib/cohorts.js` is the single read layer for
campaign state and seat counts and is scoped. `routes/desk.js` bid reads take an
org context from `requirePartner` before touching `provider_bids`. Nothing
obviously unscoped was seen while reading the sixteen write sites, but absence of
evidence here is weak evidence and the brief is right that it deserves its own
sweep.

## 8. Data volumes

**Cannot be answered from the repository.** ZCQL access is console-only from
here. Known: `CrmSyncQueue` is 195 delivered, 4 parked, 0 pending as of
2026-09-02. Every other count is owed and should be gathered before the backfill
is designed, because the backfill's batching depends on it:

```sql
SELECT COUNT(ROWID) FROM users
SELECT COUNT(ROWID) FROM provider_orgs
SELECT COUNT(ROWID) FROM campaigns
SELECT COUNT(ROWID) FROM campaign_members
SELECT COUNT(ROWID) FROM provider_bids
SELECT COUNT(ROWID) FROM provider_orders
```

## 9. Two things already true that the brief asks for

**The em dash lint exists**, at `scripts/check-console-copy.mjs`, wired into
`.github/workflows/check-frontend.yml`. It is deliberately scoped to the console
files rather than repo-wide, because older pages carry hundreds of em dashes and
a gate that is red on day one gets switched off on day one. Extending it to this
feature's files is a small change; extending it repo-wide is not.

**CI is currently red and has been since 2026-09-01**, and it is unrelated to
CRM. `scripts/check-notify-copy.mjs` transitively requires
`zcatalyst-sdk-node` through `lib/datastore.js`, which is not installed in an
install-free workflow. It passes on any developer machine and fails every CI run,
and because a failed step skips the rest, **the two CRM gates at the end of the
file have never run in CI**. This should be fixed before more gates are added
behind it.
