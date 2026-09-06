# Table naming guide

One rule, written once, for the sixty-eight tables in the Whollar Data Store.
Plus the short list of things that really are inconsistent, the tables and
columns still owed, and an owner decision on prefixing.

Written 2026-09-06 from the live Development store. The audit of who writes what
is in `ACTION_TABLE_AUDIT.md`.

---

## 1. The rule

### Rule 1: the function decides the case

Two Catalyst functions own tables, and each has its own case. That is not drift,
it is the shape of the system: the two families were built at different times
for different callers and neither can be renamed without breaking the other.

| Function | Who posts to it | Case, table and column | Examples |
|---|---|---|---|
| `auth` | signed-in members, partners, staff | `lower_snake_case` | `users`, `campaigns`, `provider_bids`, `household_offers` |
| `formSubmit` | public pages, no session | `PascalCase` | `WaitlistSignups`, `BillCheckupSubmissions`, `TireWaitlistSignups`, `CityRequests` |

**A new table takes the case of the function that will write it. Nothing else
decides.** Not the surface it serves, not the feature it belongs to, not what
the table next to it is called.

`billOcr` owns no table. `crmSync` owns none either: it reads and updates
`CrmSyncQueue`, which `formSubmit` created.

The `auth` function reads eleven `PascalCase` tables it does not own, in
`routes/admin.js` and `routes/member.js`. Reading across the line is fine.
Writing a table means owning its case.

### Rule 2: ownership is a tag, not a prefix

Every registry entry carries `surface: 'home' | 'internet' | 'tires' | 'shared'`.
A table can serve two surfaces without being renamed, which several already do:
`CityRequests` is posted from `whollar.ca` and `tires.whollar.ca`, `WaitlistEmails`
from all three.

### Rule 3: composite uniques are flattened

Catalyst's unique constraint is per column and has no composite form. Where the
model needs a unique pair, store a derived single column and make that unique:
`membership_key`, `provider_key`, `offer_key`, `VehicleKey`, `EmailKey`.

Naming: `_key` (or `Key`) for a derived composite, `_id` (or `Id`) for a
Whollar-minted identifier.

### Rule 4: timestamps end in `_at`, or `At`

`joined_at`, `sealed_at`, `occurred_at`. `SubmittedAt`, `ConsentAt`, `RanAt`.
No exceptions in either family.

### Rule 5: money is a string

Catalyst's Int has no cents. `price`, `monthly_cost`, `fee_each` and every other
amount stay Var Char and are compared as strings or parsed in code.

### Rule 6: plural for row tables, singular for singletons

`users`, `campaigns`, `provider_bids`. `site_config` is the one true singleton.

**Six `auth` tables are singular and are not being renamed**: `referral_token`,
`invite_click`, `share_event`, `seat_claim`, `claim_event`, `cohort_counter`.
Each carries a unique race guard (`token`, `event_key`, `claim_key`, `cohort_id`)
and a rename buys nothing but risk. Recorded as an exception, deliberately.

### One change to `create-tables.md`

Rule 2 at the top of that file says "Everything below is `lower_snake_case`",
which stopped being true at section 14 and is contradicted in bold in sections
35, 37, 38 and 39. Replace it with rule 1 above, and leave a one-line pointer in
each of those four sections rather than restating the warning four times.

---

## 2. Real inconsistencies to fix

This is the whole rename list. Everything else that looks inconsistent is one of
the rules above working correctly.

| Where | Problem | Fix | Family |
|---|---|---|---|
| `CityRequests.province` | lowercase in a PascalCase table. The case mapper in `formSubmit` writes to the live name and logs one line per process, so nothing is broken, but every insert is routed through a workaround | rename the column to `Province` in the console. No deploy. | formSubmit |

**That is the only one**, across all sixty live tables. The eight tire
misspellings recorded on 2026-09-05 are fixed: `TireWaitlistDetails.Priorities`
and every other tire column now reads correctly. Every other `formSubmit` table
matches its spec exactly, PascalCase throughout, verified column by column from
the export headers in `_live_columns.md`.

There is no case drift anywhere in the `auth` family.

---

## 3. Owed additions

### 3.1 Tables that exist in code and not in the store

These are not new work. They are the store catching up with shipped code, and
each one has a section in `catalyst-backend/scripts/create-tables.md` already
written. Build them from there, not from here.

| Table | Section | Family | What it unblocks |
|---|---|---|---|
| `campaign_notices` | 27 | auth | stage notices. Nobody is told a cohort moved. |
| `brand_registry` | 34a | auth | the brand list, member and partner |
| `provider_brands` | 34b | auth | the partner brand roster |
| `distributor_providers` | 34c | auth | the distributor serving map |
| `member_provider_exclusions` | 34d | auth | "do not offer me these providers" |
| `brand_requests` | 34g | auth | "please add this brand" |
| `WaitlistShareCodes` | 40a | formSubmit | the per-email share code the popup mints |
| `ReferralClicks` | 40b | formSubmit | counting arrivals on a shared link |

Sections 34 and 40 are each a whole feature that was built, deployed and never
given its tables.

### 3.2 Columns that exist in code and not in the store

Read from the live export headers, section by section.

| Table | Column | Section | Consequence today |
|---|---|---|---|
| `campaigns` | `fsas` | 29a | FSA-scoped campaign eligibility is inert. `lib/catalog.js` drops the column from its projection (`COLUMNS_MIN`) and every campaign reads as unscoped. |
| `users` | `postal_code_updated_at`, `postal_code_source` | 29b | no trail on postal code changes. `routes/me.js` drops and retries, so the change itself lands. |
| `provider_orgs` | `rejection_reason` | 8 | the sentence a refused partner is shown is not stored. `routes/admin.js` retries without it. |
| `campaign_members` | `referral_code` | 12 | multi-campaign referral attribution is lost. The insert falls back. |
| `provider_bids` | `brand_id`, `submitted_via_distributor_id` | 34e | part of section 34 |
| `household_offers` | `version`, `superseded_at`, `audit_json`, `excluded_json`, `withdrawn_json` | 34f | part of section 34 |
| `WaitlistSignups` | `PoolingFor` | landing port | which product a household is pooling for is dropped on every internet-lane join. `insertTolerant` lists it optional. It already exists on `CityRequests`. |
| `CrmSyncQueue` | `EntityType`, `EntityRowId`, `EventType`, `EventVersion`, `IdempotencyKey` (Unique), `NextAttemptAt` | CRM model phases 0 to 3c | **every CRM event is written with no idempotency key and cannot dedupe.** `lib/crm/outbox.js` carries a fallback to the legacy ten columns and logs each time it takes it. The comment above that fallback says "the six columns exist in the console as of 2026-09-02"; the live store says they do not. |

### 3.3 Columns in the store that `schema.js` does not declare

The drift running the other way. `verify()` cannot report on a column it has
never heard of, and `TABLES.md`, which is generated from `schema.js`, does not
document it.

| Table | Column | Section |
|---|---|---|
| `users` | `referral_carrier`, `referral_same_region` | 24b |
| `provider_coverage` | `rejection_reason`, `verified_at` | 17 |

### 3.4 Five tables `schema.js` does not declare at all

`provider_applications`, `application_tasks`, `provider_documents`,
`provider_references`, `coverage_verifications`.

All five exist and all five are written on every partner application. None is
covered by `verify()`, so `/health/diagnostics` reports neither their row counts
nor a missing column on any of them: the whole founding partner journey is
outside the one mechanism built to catch console drift.

Declaring them in `schema.js` is the fix, and it is what makes
`/health/diagnostics` cover the full registry. The loop already iterates every
name `schema.js` gives it.

It is not academic. Three Unique flags on these tables are provably off:
`provider_applications.application_id`, `provider_applications.org_id` and
`application_tasks.task_key_org` each hold the same value twice, written
milliseconds apart. One founding partner already has two application rows, and
`findApplication` reads `LIMIT 1`. All three are declared Unique in section 17
and none has ever been checked, because `verify()` has never heard of the table.

### 3.5 New, owed by the admin console v2 brief

No code reads any of these yet, so nothing breaks while they are absent. Every
column is optional.

#### `scheduler_ticks` (auth, new)

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `tick_key` | Var Char | 64 | yes | yes | one per run |
| `ran_at` | DateTime | - | | yes | |
| `armed_scanned` | Int | - | | | default 0 |
| `moved` | Int | - | | | default 0 |
| `errors` | Int | - | | | default 0 |
| `detail` | Text | 10000 | | | JSON |

#### `campaign_disqualifications` (auth, new)

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `disq_key` | Var Char | 130 | yes | yes | `${campaign_id}:${org_id}` |
| `campaign_id` | Var Char | 64 | | yes | |
| `org_id` | Var Char | 64 | | yes | |
| `reason` | Var Char | 255 | | yes | required on the write |
| `actor` | Var Char | 64 | | yes | the admin's `user_id` |
| `disqualified_at` | DateTime | - | | yes | |

#### Columns to add (auth)

| Table | Column | Type | Length | Notes |
|---|---|---|---|---|
| `campaigns` | `schedule_armed` | Var Char | 8 | `yes` or `no`. Var Char, not Boolean: every other flag in this family is a Var Char and a mixed convention is worse than a slightly wide column. |
| `provider_orgs` | `lead_rate` | Int | - | per-partner override of `site_config.success_fee` |
| `provider_orgs` | `serviceability_url` | Var Char | 255 | rule 3 of `create-tables.md` caps Var Char at 255 |
| `provider_bids` | `invalidated_at` | DateTime | - | |
| `provider_bids` | `invalidated_reason` | Var Char | 255 | and add `invalidated` to the `status` set |
| `campaign_awards` | `override_reason` | Var Char | 255 | `method` and `awarded_by` already exist |
| `campaign_awards` | `overridden_at` | DateTime | - | |

### 3.6 Proposed and not needed

Checked against the code, each of these turns out to be already handled:

- **Pass on an offer.** `POST /cohorts/:id/pass` is complete: `seats.transition`
  writes `claim_event` with `action='pass'` and the member's `reason`, drops the
  `campaign_members` row, releases the `provider_orders` row and recounts.
  `claim_event.reason` is a live Var Char(24). No table, no new `user_events`
  kind, no code change.
- **Stay with the current provider.** Not accepting an offer is the whole act.
  There is nothing to write.
- **Email me when this cohort moves.** `POST /campaigns/notify` records an
  `auth_events` row and deliberately no membership: "standing is interest, not a
  seat, and stays ledger free". Leave it.
- **`privacy_requests`.** `GET /me/export` and `POST /me/delete` are both shipped
  and both write an `auth_events` row. A second record of the same request would
  need a reader before it earns a table. **Owner's answer, 2026-09-06: no.**
- **The $10 acceptance fee.** There is no payment service provider in the stack
  (section 21). No table until a processor is chosen.
- **Partner intent to bid, partner cohort watch.** Nothing in `routes/desk.js`
  writes either, and no surface asks for them. **Owner decision**, and the
  question is whether the feature is wanted at all, not where to put it.

---

## 4. Option C: prefixing the `auth` family

The proposal is `net_` or `core_` prefixes on the 48 `auth` tables, so that a
table's name says which product it belongs to.

**Recommendation: no.**

What it costs:

- 48 renames in the Catalyst console, by hand, one at a time. There is no DDL
  API and no rename script.
- Every rename is a runtime failure until the code catches up, and the code
  cannot catch up until the rename lands, because there is no way to write both
  names at once. The window is however long it takes to click through 48 tables.
- This repo has been bitten by name mismatch three times that are written down:
  section 14, section 19 and the `CityRequests.province` outage of 2026-09-05.
  Each was one name. This is 48.
- `crmSync` and the `auth` function's own cross-family reads both need review.
- The `formSubmit` family stays `PascalCase` regardless, so the store ends up
  with two conventions either way. The prefix does not unify anything; it adds a
  third thing to remember.

What it buys: a name that repeats what the registry's `surface` tag already
says, for free, in a place a reader is already looking.

If the owner wants it anyway, it is a separate session after the registry lands,
with the full old-to-new map written first and the console work done in one
sitting.

**Owner's answer, 2026-09-06: dropped.** The registry carries current names and
a `surface` tag. No prefix, no rename map.

---

## 5. Decisions

Answered 2026-09-06:

- **Option C, prefixes: dropped.** See section 4.
- **`privacy_requests`: no.** `auth_events` already records both requests.
- **`schema.js` is completed before the registry**, so the registry reads one
  list and `/health/diagnostics` covers the partner application.

Still open, and each needs a console session rather than a code change:

1. Section 34, five tables: build them, or was provider exclusions shelved?
2. Section 27, `campaign_notices`: build it? Nothing tells a household its cohort
   moved until it exists.
3. Section 40, `WaitlistShareCodes` and `ReferralClicks`: build them? The share
   code is live on three hosts and records nothing.
4. The six `CrmSyncQueue` columns: worth doing first regardless of the others,
   because every CRM event written today carries no idempotency key.
5. Partner intent to bid: is the feature wanted at all?
