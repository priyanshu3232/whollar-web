# Phase 0 findings: what the live Development store actually holds

Written 2026-09-06. Working notes for the action-to-table audit. Delete once
`docs/ACTION_TABLE_AUDIT.md` and `docs/TABLE_NAMING_GUIDE.md` carry everything
that matters.

Method: `catalyst ds:export --table <name> --page 1` against project **Whollar**,
environment **Development** (the only environment in `.catalystrc`), logged in as
hubcart99@gmail.com. A scheduled job means the table exists; `404, No such Table
with the given name exists` means it does not. The downloaded report's CSV header
is the live column list, which is how the column drift below was read without a
signed-in admin session.

---

## 1. Where the prompt was wrong

| The prompt said | Reality |
|---|---|
| `catalyst-backend/create-tables.md` | It is `catalyst-backend/scripts/create-tables.md`. |
| "about 48 auth tables and about 17 formSubmit tables" | 49 auth, **19** formSubmit. |
| "Confirm the deep-read table's real name" | `DeepReadRequests`. |
| The formSubmit family is 17 named tables | Three more are shipped and were not in the list: `DeepReadRequests`, `CalculatorEstimates`, `ContactSubmissions`. |
| "Rewrite `TABLES.md` from the registry and the live store" | **`TABLES.md` is generated.** `scripts/build-tables-doc.mjs` writes it from `schema.js` and has a `--check` gate. Hand-writing it makes the gate red. See section 7. |
| "Pass on offers: `user_events.kind` is a closed set, adding `pass` is a code change" | `POST /cohorts/:id/pass` already exists and is complete: `seats.transition(action:'pass', reason)` writes `claim_event`, drops the `campaign_members` row, releases the `provider_orders` row and recounts `cohort_counter`. `claim_event.reason` is a real column. **Nothing is owed here.** |
| "Data export, delete account: no table in the file" | `GET /me/export` and `POST /me/delete` are both shipped, and both write an `auth_events` row. A `privacy_requests` table would be a second record of something already recorded. |
| "`coverage_verifications`: `TABLES.md` called it un-declared" | True, and it is not alone: **five** spec tables are absent from `schema.js`. |
| "the six tire tables ... confirm which half is done" | All six exist. The route `POST /tire-waitlist-join` exists and writes all six. |
| "`ProductVotes` STILL MISSING" (memory, 2026-09-05) | It exists now. |
| "ALL runbook tables exist" (memory, 2026-08-24) | False as of today: eight shipped tables are missing. |
| "a formSubmit hardening is written, uncommitted, undeployed" (memory) | It is committed: `bd0027f` and `70edd2e`. The backend working tree is clean. |

---

## 2. The two families, counted

| Family | Function | Case | Spec | In `schema.js` | Live |
|---|---|---|--:|--:|--:|
| auth | `auth` | `lower_snake_case` | 49 | 44 | 43 |
| formSubmit | `formSubmit` | `PascalCase` | 19 | n/a | 17 |
| | | | **68** | | **60** |

`billOcr` touches no table. `crmSync` touches `CrmSyncQueue` only.

---

## 3. Tables that do not exist in Development

Eight of them are shipped features whose code is live and writing nowhere.

### auth family (6)

| Table | Section | What is dead because of it |
|---|---|---|
| `campaign_notices` | 27 | The stage-notice sweep. `lib/notices.js` catches the absence and returns quietly, so no member is ever told a cohort moved stage. |
| `brand_registry` | 34a | The provider-exclusions picker. `GET /brands` answers empty. |
| `provider_brands` | 34b | The partner roster view. `GET /provider/roster` answers empty; `POST /provider/roster` refuses. |
| `distributor_providers` | 34c | `GET/POST /distributor/serving-map`. |
| `member_provider_exclusions` | 34d | `GET/PUT /me/exclusions`. The PUT throws a clean "not available right now" rather than lying, which is the one good thing here. |
| `brand_requests` | 34g | `POST /provider/brand-request`. |

Section 34 was never built in the console: all five of its tables are absent, and
that is the whole provider-exclusions feature, member side and partner side.

### formSubmit family (2)

| Table | Section | What is dead because of it |
|---|---|---|
| `WaitlistShareCodes` | 40a | Every per-email share code the waitlist popup mints. `POST /waitlist-email` still saves the address; only the code write fails. `GET /admin/referral/waitlist` 500s by design when this table is unreadable. |
| `ReferralClicks` | 40b | `POST /ref-click`, called from `whollar-home/js/waitlist-join.js`. Nothing counts an arrival on a shared link. |

### Owed by the admin v2 brief, correctly absent (3)

`scheduler_ticks`, `campaign_disqualifications`, `privacy_requests`. No code reads
or writes any of them yet.

---

## 4. Five spec tables `schema.js` does not declare

`provider_applications`, `application_tasks`, `provider_documents`,
`provider_references`, `coverage_verifications`.

All five exist live. All five are read and written by `routes/application.js` and
`routes/admin.js`. None is covered by `verify()`, so `/health/diagnostics` reports
neither their row counts nor a single missing column on them: the whole founding
partner application is outside the one thing built to catch console drift.

This, not the `for` loop, is what "extend `/health/diagnostics` to iterate the
auth registry in full" actually means. The loop already iterates `TABLE_NAMES`;
the list is what is short.

---

## 5. Column drift, all 60 live tables

Every existing table's live column list is in `_live_columns.md`, read from the
header row of its export report. Comparing that against `schema.js` and against
what `formSubmit` writes gives four findings and nothing else.

### 5.1 In the code, not in the store (auth)

| Table | Column | Section | Consequence |
|---|---|---|---|
| `campaigns` | `fsas` | 29a | FSA-scoped eligibility is inert. `lib/catalog.js` drops it from the projection through `COLUMNS_MIN`, so every campaign reads as unscoped and nothing errors. |
| `users` | `postal_code_updated_at`, `postal_code_source` | 29b | no trail on a postal code change. `routes/me.js` drops and retries. |
| `provider_orgs` | `rejection_reason` | 8 | the sentence a refused partner is shown is not stored. `routes/admin.js` retries without it. |
| `campaign_members` | `referral_code` | 12 | multi-campaign referral attribution is lost on every join. |
| `provider_bids` | `brand_id`, `submitted_via_distributor_id` | 34e | part of section 34 |
| `household_offers` | `version`, `superseded_at`, `audit_json`, `excluded_json`, `withdrawn_json` | 34f | part of section 34 |

Every one has a fallback ladder, which is why none of this shows up as an error.
That is also why none of it was noticed.

### 5.2 In the code, not in the store (formSubmit)

`WaitlistSignups.PoolingFor` does not exist. `insertTolerant` lists it as
optional and drops it, so which product a household is pooling for is lost on
every internet-lane join. It **does** exist on `CityRequests`.

### 5.2b `CrmSyncQueue` is six columns short

Live: `Source`, `SourceRowId`, `Email`, `LeadType`, `Payload`, `Status`,
`Attempts`, `LastError`, `CrmLeadId`, `SyncedAt`. Ten columns, the legacy set.

`lib/crm/outbox.js` and `crmSync/index.js` both write `EntityType`,
`EntityRowId`, `EventType`, `EventVersion`, `IdempotencyKey` and
`NextAttemptAt`. None exists. The outbox falls back to the legacy ten and logs
"this row has NO idempotency key and cannot dedupe" every time, which is every
time. The comment above that fallback says the six columns "exist in the console
as of 2026-09-02". They do not.

### 5.2c Three Unique flags are provably off

The brief says the Unique flags cannot be read without a console session or a
two-insert test. For three columns the data already answers it.
`provider_applications` holds two rows with the same `application_id` **and** the
same `org_id`, written four milliseconds apart, and `application_tasks` holds two
rows with the same `task_key_org`:

```
2026-09-04 22:12:07:076  app-6621cddb-8146-490a-80d8-b7256acfae0e
2026-09-04 22:12:07:080  app-6621cddb-8146-490a-80d8-b7256acfae0e
```

A unique column cannot hold the same value twice, so:

- `provider_applications.application_id` Unique is **off**
- `provider_applications.org_id` Unique is **off**
- `application_tasks.task_key_org` Unique is **off**

All three are declared Unique in section 17, and all three sit on tables
`schema.js` does not declare, so `verify()` has never checked them either. That
is one root cause, not two.

The consequence is live: `findApplication` is a `LIMIT 1` read on `org_id`, so
that org has a second application row nothing will ever show, and a
double-submitted registration can land on either.

**No duplicates were found anywhere else**, and that is weak evidence, not a
clean bill. A unique constraint only shows itself when it is contended, and the
tables where contention matters most are nearly empty: `provider_bids` 0 rows,
`household_offers` 0, `campaign_members` 1, `campaign_awards` 1,
`provider_orders` 1, `campaign_price_books` 1. The scan means something only for
`users` (143 rows), `sessions` (329), `credentials` (131), `auth_identities` (58)
and `claim_event` (45), and those five are clean.

`claim_event.event_key` at 45 rows is the one race guard with real evidence
behind it.

### 5.3 In the store, not in `schema.js`

| Table | Column | Section |
|---|---|---|
| `users` | `referral_carrier`, `referral_same_region` | 24b |
| `provider_coverage` | `rejection_reason`, `verified_at` | 17 |

`verify()` cannot report on a column it has never heard of, and `TABLES.md` is
generated from `schema.js`, so these four are live and undocumented.

### 5.4 Case drift

One, and only one, in the whole store:

```
CityRequests: ROWID CREATORID CREATEDTIME MODIFIEDTIME City province Email
              SubmittedAt FSA PoolingFor Marketing
```

`province` is lowercase where section 37a and the code say `Province`. The case
mapper absorbs it and logs once per process. Renaming the column in the console
fixes it with no deploy.

The eight tire misspellings recorded on 2026-09-05 are gone: `Priorities` and
every other tire column now reads correctly. Every other `formSubmit` table
matches its spec exactly.

---

## 6. Code inventory

Every one of the 68 table names appears as a string literal in
`catalyst-backend/functions`. There are no orphan literals: nothing in code names
a table the spec does not have. Table names reach the Data Store through
`lib/datastore.js` (auth) and a local `insert`/`insertTolerant` pair (formSubmit);
`.table()` is called with a literal in only five places outside those helpers.

`GET /admin/leads/:table` resolves through `LEAD_TABLES`, an 11-entry frozen map,
so a browser value never reaches ZCQL as a table name. Eight live intake tables
are absent from that map and therefore invisible to staff: `CityRequests`,
`ProductVotes`, `ReferralClicks` and the six tire tables.

One cross-family read: `routes/admin.js` reads `PartnerApplications`,
`WaitlistSignups`, `WaitlistDetails`, `BillCheckupSubmissions`,
`CalculatorEstimates`, `ContactSubmissions`, `DeepReadRequests`, `CrmSyncQueue`,
`WaitlistEmails`, `WaitlistShareCodes` and `ReferralClicks`. The `auth` function
reads eleven PascalCase tables it does not own. That is by design and it is the
reason a registry has to carry both families.

---

## 7. `TABLES.md` is generated, and that changes the plan

`scripts/build-tables-doc.mjs` writes `catalyst-backend/TABLES.md` from
`schema.js`, twice over: `require` for the specs and a text parse for the
comments. It has a `--check` mode and a hardcoded `META` list, so a table added
to `schema.js` without a `META` line fails the script rather than appearing
undocumented.

So the way to make `TABLES.md` describe reality is to fix `schema.js` and re-run
the generator, not to write `TABLES.md`. Declaring the five missing tables in
`schema.js` therefore does three things at once: `/health/diagnostics` starts
checking them, `TABLES.md` starts documenting them, and the registry in Phase 4
has one list to read rather than two.

---

## 8. Open questions for the owner

1. Section 34 (provider exclusions, five tables) and section 27
   (`campaign_notices`): built in code, never built in the console. Create them,
   or was the feature shelved?
2. Section 40 (`WaitlistShareCodes`, `ReferralClicks`): the waitlist share code
   is live on three hosts and records nothing. Create them?
3. `privacy_requests`: `/me/export` and `/me/delete` already write `auth_events`.
   Still wanted?
4. Option C, prefixing the 48 auth tables: yes or no. Recommendation is in the
   naming guide, and it is no.
