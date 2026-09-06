# Action to table audit

Every action a person or the system can take on the three hosts, the table each
one reads and writes, and whether that table exists in the live Development
store today.

Read 2026-09-06 against the Whollar project, Development environment. Existence
was probed table by table with `catalyst ds:export`; a scheduled job means the
table is there, `404, No such Table with the given name exists` means it is not.

**`Exists live?` reads:**

- **yes**, the tables this action needs are all there
- **no**, at least one is absent, and what that costs is named in Gaps
- **derived**, the action reads no table of its own

`Owner check` is for ticking off as tables land. The console work these rows
imply, in the order worth doing it, is `STORE_BACKLOG_2026-09.md`. Working notes
are in `_phase0_findings.md`; the naming rule and the owed table specs are in
`TABLE_NAMING_GUIDE.md`; every table's live column list is in `_live_columns.md`.

Existence can be re-read at any time with `node scripts/check-store-tables.mjs`,
and once the tables land, `GET /api/auth/health/diagnostics` answers the column
and flag half for all 49 auth tables in one request.

**Eight shipped tables do not exist.** Six of them are the whole of section 34
(provider exclusions) plus section 27 (stage notices) on the `auth` side, and two
are section 40 (waitlist share codes) on the `formSubmit` side. Every row that
depends on them is marked **no** below.

---

## 1. Home, `whollar.ca` (formSubmit, PascalCase)

| # | Action | Where | Reads | Writes | Exists live? | Gaps | Owner check |
|---|---|---|---|---|---|---|---|
| 1 | Bring Whollar to my city | `js/city-request.js`, `POST /city-request` | | `CityRequests`, `CrmSyncQueue` | yes | live column is `province`, the code and section 37a say `Province`. The case mapper absorbs it and logs once per process. | [ ] |
| 2 | Vote for a product, eight buttons | `js/landing.js`, `POST /product-vote` | | `ProductVotes`, `CrmSyncQueue` | yes | created since 2026-09-05. Absent from `LEAD_TABLES`, so no staff view. | [ ] |
| 3 | Leave an address in the corner popup | `js/referral-popup.js`, `POST /waitlist-email` | `WaitlistEmails` | `WaitlistEmails`, `WaitlistShareCodes`, `CrmSyncQueue` | **no** | `WaitlistShareCodes` (40a) absent. The address is saved; the share code is not, so the card falls back to a done state with no code. | [ ] |
| 4 | Arrive on a shared link | `js/waitlist-join.js`, `POST /ref-click` | | `ReferralClicks` | **no** | `ReferralClicks` (40b) absent. Nothing counts an arrival, on any host. | [ ] |
| 5 | Join the waitlist | `js/waitlist-join.js`, `POST /waitlist-join` | | `WaitlistSignups`, `CrmSyncQueue` | yes | `WaitlistSignups.PoolingFor` does not exist, so which product the household is pooling for is dropped | [ ] |
| 6 | Send a message from the popup | `js/referral-popup.js`, `POST /contact` | | `ContactSubmissions`, `CrmSyncQueue` | yes | | [ ] |

## 2. Internet, public pages (formSubmit, PascalCase)

| # | Action | Where | Reads | Writes | Exists live? | Gaps | Owner check |
|---|---|---|---|---|---|---|---|
| 7 | Run the bill checkup | `bill-checkup.html`, `POST /bill-checkup-join` | | `BillCheckupSubmissions`, `CrmSyncQueue` | yes | upload goes to `billOcr`, which touches no table | [ ] |
| 8 | Ask for a deep read of a bill | `bill-checkup.html`, `POST /deep-read` | | `DeepReadRequests`, `CrmSyncQueue` | yes | the "deep read" table of the runbook. Its real name is `DeepReadRequests`. | [ ] |
| 9 | Join the waitlist | `js/waitlist-join.js`, `POST /waitlist-join` | | `WaitlistSignups`, `CrmSyncQueue` | yes | same missing `PoolingFor` as row 5 | [ ] |
| 10 | Add bill details to a waitlist entry | `waitlist/index.html`, `POST /waitlist-details` | | `WaitlistDetails`, `CrmSyncQueue` | yes | | [ ] |
| 11 | Apply as a founding partner, public form | `become-a-partner.html`, `POST /partner-application` | | `PartnerApplications`, `CrmSyncQueue` | yes | | [ ] |
| 12 | Get a savings estimate | `index.html`, `POST /calculator-estimate` | | `CalculatorEstimates`, `CrmSyncQueue` | yes | | [ ] |
| 13 | Send a message from the contact page | `contact.html`, `POST /contact` | | `ContactSubmissions`, `CrmSyncQueue` | yes | | [ ] |
| 14 | Read the households-pooling count | `GET /pooling-count` | `WaitlistSignups` | | yes | | [ ] |

## 3. Tires, `tires.whollar.ca` (formSubmit, PascalCase)

| # | Action | Where | Reads | Writes | Exists live? | Gaps | Owner check |
|---|---|---|---|---|---|---|---|
| 15 | Quick winter tire signup | `js/tire-join.js`, `POST /tire-waitlist-join` | `TireWaitlistSignups`, `TireCohortCounter` | `TireWaitlistSignups`, `TireWaitlistVehicles`, `TireCohortCounter`, `CrmSyncQueue` | yes | all six tire tables exist and the route is written. It was still undeployed as of the last note; confirm before smoke testing. | [ ] |
| 16 | Guided winter tire signup | same route, guided branch | as above | plus `TireWaitlistDetails`, `TireInstallWindows`, `TireToolRuns` | yes | none of the six is in `LEAD_TABLES`, so staff cannot read any of them outside the console | [ ] |
| 17 | Bring Whollar to my city | `js/city-request.js`, `POST /city-request` | | `CityRequests`, `CrmSyncQueue` | yes | same `province` case drift as row 1 | [ ] |
| 18 | Corner popup, address and message | `js/referral-popup.js` | `WaitlistEmails` | `WaitlistEmails`, `WaitlistShareCodes`, `ContactSubmissions`, `CrmSyncQueue` | **no** | `WaitlistShareCodes` absent, as row 3 | [ ] |

## 4. Internet, member (auth, snake_case)

Every row here also writes `auth_events`, because every route calls
`audit.record`. It is listed only where it is the whole of the write.

| # | Action | Where | Reads | Writes | Exists live? | Gaps | Owner check |
|---|---|---|---|---|---|---|---|
| 19 | Create an account with a password | `POST /signup`, `/signup/verify` | `users`, `credentials`, `referral_token` | `users`, `credentials`, `auth_challenges`, `auth_identities`, `consents`, `sessions`, `auth_events` | yes | | [ ] |
| 20 | Sign in with a code | `POST /otp/start`, `/otp/verify` | `users` | `auth_challenges`, `auth_identities`, `consents`, `sessions`, `users` | yes | | [ ] |
| 21 | Sign in with a password | `POST /login`, `/login/verify` | `users`, `credentials` | `auth_challenges`, `sessions`, `users` | yes | | [ ] |
| 22 | Sign in with Google | `GET /google/start`, `/google/callback` | `users`, `auth_identities` | `oauth_state`, `users`, `auth_identities`, `consents`, `sessions` | yes | dormant until the OAuth environment variables are set | [ ] |
| 23 | Reset a forgotten password | `POST /password/forgot`, `/password/reset` | `users` | `auth_challenges`, `credentials`, `users` | yes | | [ ] |
| 24 | Save a bill on the dashboard | `GET/POST /me/bill` | `member_bills`, `BillCheckupSubmissions`, `WaitlistDetails` | `member_bills` | yes | one of two places the `auth` function reads PascalCase tables | [ ] |
| 25 | Join a cohort | `POST /cohorts/:id/join`, `POST /campaigns/join` | `campaigns`, `seat_claim`, `cohort_counter` | `seat_claim`, `claim_event`, `campaign_members`, `cohort_counter` | yes | `campaign_members.referral_code` (12) does not exist, so the join loses its referral stamp. `claim_event.event_key` Unique is the whole race guard and is still unverified. | [ ] |
| 26 | Leave a cohort | `POST /cohorts/:id/leave`, `POST /campaigns/leave` | same | same | yes | | [ ] |
| 27 | Move to a different cohort | `POST /cohorts/:id/move` | same | same | yes | | [ ] |
| 28 | Pass on the offer | `POST /cohorts/:id/pass` | `campaigns`, `seat_claim`, `provider_orders` | `seat_claim`, `claim_event`, `campaign_members`, `cohort_counter`, `provider_orders` | yes | **complete.** The reason lands in `claim_event.reason`, the order releases, the seat count recounts. No new table and no new `user_events` kind is owed. | [ ] |
| 29 | Read the offer for a cohort | `GET /campaigns/:id/offer` | `campaigns`, `provider_bids`, `campaign_awards`, `campaign_price_books`, `household_offers`, `provider_orders` | `household_offers` (seals the window on first read) | yes | | [ ] |
| 30 | Accept an offer and book the install | `POST /campaigns/:id/offer/accept` | as above | `provider_orders`, `campaign_members`, `CrmSyncQueue` | yes | `provider_orders.phone` (31) and the two section 30c columns exist | [ ] |
| 31 | Change which tier was picked | inside `POST /campaigns/:id/offer/accept` | `provider_orders` | `provider_orders` | yes | | [ ] |
| 32 | Ask to be told when a cohort moves | `POST /campaigns/notify` | `campaigns` | `auth_events` | yes | **no table.** Standing is recorded as an audit row only, deliberately: "interest, not a seat, and stays ledger free". | [ ] |
| 33 | Set contact preferences | `GET/POST /me/prefs` | `user_prefs` | `user_prefs` | yes | | [ ] |
| 34 | Rate a provider | `GET/POST /me/rating` | `provider_ratings` | `provider_ratings` | yes | | [ ] |
| 35 | Share an experience, report an outage, register interest, ask to be notified | `POST /me/event` | | `user_events` | yes | closed kind set: `rating`, `feedback`, `outage`, `interest`, `provider-notify` | [ ] |
| 36 | Tick a product interest tile | `POST /me/product-interest` | `product_interest` | `product_interest` | yes | the POST fails silently by design, verify writes in ZCQL | [ ] |
| 37 | Choose providers to exclude | `GET/PUT /me/exclusions` | `brand_registry`, `member_provider_exclusions` | `member_provider_exclusions` | **no** | both tables absent (34a, 34d). The GET answers empty, the PUT refuses cleanly rather than lying. The whole feature is dead. | [ ] |
| 38 | Read the brand list | `GET /brands` | `brand_registry` | | **no** | absent (34a) | [ ] |
| 39 | Edit the profile and postal code | `POST /me/profile` | `users`, `campaigns`, `seat_claim` | `users`, `seat_claim`, `claim_event`, `campaign_members` | yes | `users.postal_code_updated_at` and `postal_code_source` (29b) do **not** exist. The change lands, the trail does not. | [ ] |
| 40 | Read the share code and what it brought in | `GET /me/referral` | `referral_token`, `users`, `invite_click` | `referral_token` | yes | | [ ] |
| 41 | Arrive through a member share link | `GET /r/:token` | `referral_token` | `invite_click` | yes | | [ ] |
| 42 | Record a share sheet action | `POST /share/event` | | `share_event` | yes | | [ ] |
| 43 | Unsubscribe from an email | `GET/POST /u/:token` | `unsubscribe_tokens` | `email_suppressions`, `user_prefs` | yes | | [ ] |
| 44 | Read my notifications | `GET /me/notifications` | `notification_outbox` | | yes | | [ ] |
| 45 | Export my data | `GET /me/export` | `users`, `member_bills`, `campaign_members`, `consents`, `user_prefs`, `user_events` | `auth_events` | yes | **shipped.** The audit row is the record of the request. | [ ] |
| 46 | Delete my account | `POST /me/delete` | `users` | `users`, `credentials`, `auth_identities`, `member_bills`, `campaign_members`, `sessions`, `auth_events` | yes | **shipped**, same note | [ ] |

## 5. Internet, partner (auth, snake_case)

| # | Action | Where | Reads | Writes | Exists live? | Gaps | Owner check |
|---|---|---|---|---|---|---|---|
| 47 | Create a partner account, sign in | `POST /provider/signup`, `/provider/login` and their verifies | `users`, `credentials`, `provider_orgs`, `provider_users` | `users`, `credentials`, `auth_challenges`, `consents`, `sessions`, `provider_orgs`, `provider_users` | yes | | [ ] |
| 48 | Name the organisation | `POST /provider/org` | `provider_orgs` | `provider_orgs`, `CrmSyncQueue` | yes | | [ ] |
| 49 | Read the application and its five tasks | `GET /provider/application`, `/timeline` | `provider_applications`, `application_tasks`, `provider_documents`, `provider_references` | | yes | **`provider_applications.application_id` and `org_id` and `application_tasks.task_key_org` all hold duplicate values, so their Unique flags are off.** One org already has two application rows and `findApplication` is a `LIMIT 1`. None of these four tables is declared in `schema.js`, so `verify()` has never checked the flags either. | [ ] |
| 50 | Fill in registration | `PATCH /provider/application/registration` | `provider_applications` | `provider_applications`, `application_tasks` | yes | | [ ] |
| 51 | Upload a document | `POST /provider/application/documents` | `provider_documents` | `provider_documents`, `application_tasks`, File Store folder `partner_documents` | yes | the two section 22a columns are live: `document_key`, `updated_at` | [ ] |
| 52 | Remove a document | `DELETE /provider/application/documents/:kind` | `provider_documents` | `provider_documents`, `application_tasks` | yes | | [ ] |
| 53 | Accept the agreement | `POST /provider/application/agreement` | | `application_tasks` | yes | | [ ] |
| 54 | Add a reference | `POST /provider/application/reference` | `provider_references` | `provider_references`, `application_tasks` | yes | | [ ] |
| 55 | Submit the application | `POST /provider/application/submit` | `provider_applications`, `application_tasks` | `provider_applications`, `CrmSyncQueue` | yes | | [ ] |
| 56 | Declare coverage | `GET/POST /provider/coverage` | `provider_coverage` | `provider_coverage`, `CrmSyncQueue` | yes | region names only on the wire, city then region in the picker | [ ] |
| 57 | Check serviceability for a region | `GET /provider/coverage/:region/serviceability` | `provider_orgs` | | yes | `provider_orgs.serviceability_url` does **not** exist. The route answers without it. | [ ] |
| 58 | Accept the standard cohort terms | `GET /provider/contracts`, `POST /provider/contracts/terms/accept` | `provider_terms`, `site_config` | `provider_terms`, `CrmSyncQueue` | yes | | [ ] |
| 59 | Declare the brand roster | `GET/POST /provider/roster` | `provider_brands`, `brand_registry`, `distributor_providers` | `provider_brands` | **no** | all three absent (34a, 34b, 34c). The view answers empty and the save refuses. | [ ] |
| 60 | Ask for a brand to be added | `POST /provider/brand-request` | `brand_registry` | `brand_requests` | **no** | both absent (34a, 34g) | [ ] |
| 61 | Read the reach of a cohort | `GET /provider/cohorts/:id/reach` | `provider_brands`, `member_provider_exclusions`, `campaign_members` | | **no** | exclusions absent, so reach cannot subtract anyone | [ ] |
| 62 | Read a cohort result | `GET /provider/cohorts/:id/results` | `provider_bids`, `campaign_awards`, `brand_registry`, `provider_brands` | | **no** | | [ ] |
| 63 | Distributor serving map | `GET/POST /distributor/serving-map` | `distributor_providers`, `provider_brands` | `distributor_providers` | **no** | absent (34c) | [ ] |
| 64 | Read the brief for a cohort | `GET /provider/campaigns/:id/brief` | `campaigns`, `campaign_members`, `seat_claim`, `provider_bids`, `campaign_awards`, `site_config` | | yes | `brief_json` is live. **`campaigns.fsas` (29a) is not**, so the brief cannot scope by FSA and every campaign reads as unscoped. | [ ] |
| 65 | Place a sealed bid | `POST /provider/bids` | `campaigns`, `provider_terms`, `provider_bids` | `provider_bids`, `bid_revisions` | yes | `provider_bids.discount_mix` (28) is live, so a custom mix seals | [ ] |
| 66 | Improve a bid | `POST /provider/bids/:campaign/improve` | `provider_bids` | `provider_bids`, `bid_revisions` | yes | append only, no withdraw path, correct | [ ] |
| 67 | Read own bids and versions | `GET /provider/bids`, `/:campaign`, `/:campaign/versions` | `provider_bids`, `bid_revisions`, `campaign_awards`, `provider_orders` | | yes | | [ ] |
| 68 | Read the roster of won households | `GET /provider/campaigns/:id/roster` | `campaign_awards`, `provider_orders`, `provider_billing` | `auth_events` | yes | | [ ] |
| 69 | Pass the roster gate | `POST /provider/campaigns/:id/roster/gate` | `campaign_awards`, `provider_billing` | `campaign_awards` | yes | | [ ] |
| 70 | Set weekly install capacity | `POST /provider/campaigns/:id/capacity` | `campaign_awards` | `campaign_awards` | yes | `install_capacity_weekly` is live | [ ] |
| 71 | Book a slot | `POST /provider/orders/:key/slot` | `provider_orders` | `provider_orders`, `CrmSyncQueue` | yes | | [ ] |
| 72 | Activate a line | `POST /provider/orders/:key/activate` | `provider_orders` | `provider_orders`, `CrmSyncQueue` | yes | the only write that creates a fee | [ ] |
| 73 | Log an exception, release an order | `POST /provider/orders/:key/exception`, `/release` | `provider_orders` | `provider_orders`, `CrmSyncQueue` | yes | | [ ] |
| 74 | Dispute an order | `POST /provider/orders/:key/dispute` | `provider_orders` | `provider_orders` | yes | | [ ] |
| 75 | Read the billing cycle and statements | `GET /provider/billing/cycle`, `/provider/statements` | `provider_billing`, `provider_statements`, `provider_orders` | | yes | | [ ] |
| 76 | Set or remove a billing method | `POST/DELETE /provider/billing/method` | `provider_billing` | `provider_billing`, `CrmSyncQueue` | yes | there is no payment service provider in the stack, so this records an arrangement, not a card | [ ] |
| 77 | Read the team | `GET /provider/team` | `provider_users`, `provider_orgs`, `users` | | yes | | [ ] |
| 78 | Intent to bid, watch a cohort | not implemented | | | derived | nothing in `routes/desk.js` writes either. Decide with the owner whether it is worth a table. | [ ] |

## 6. Internet, staff (auth, snake_case)

Every one of these writes `auth_events` through `audit.record`. That is the audit
log, and it is the only one.

| # | Action | Where | Reads | Writes | Exists live? | Gaps | Owner check |
|---|---|---|---|---|---|---|---|
| 79 | Sign in as staff | `POST /admin/login/start`, `/verify` | `users` | `auth_challenges`, `sessions`, `users`, `auth_events` | yes | `user_type='admin'` plus an `@whollar.com` address | [ ] |
| 80 | Read the overview | `GET /admin/overview` | `campaigns`, `campaign_members`, `seat_claim`, `member_bills`, `site_config`, `CrmSyncQueue` | | yes | | [ ] |
| 81 | Read and change site config | `GET /admin/config`, `PUT /admin/config/:key` | `site_config` | `site_config`, `auth_events` | yes | the success fee lives here, never in code | [ ] |
| 82 | Open or close bidding | `POST /admin/bidding` | `site_config` | `site_config`, `auth_events` | yes | | [ ] |
| 83 | Create, edit, transition a campaign | `POST/PUT /admin/campaigns`, `/:id/transition` | `campaigns` | `campaigns`, `auth_events`, `CrmSyncQueue` | yes | the server owns stage, correctly | [ ] |
| 84 | Import default campaigns | `POST /admin/campaigns/import-defaults` | `campaigns` | `campaigns`, `auth_events` | yes | | [ ] |
| 85 | Reconcile campaign drift | `GET /admin/campaigns/reconcile` | `campaigns`, `campaign_members`, `seat_claim`, `claim_event`, `cohort_counter` | | yes | | [ ] |
| 86 | Sweep stage notices | `POST /admin/campaigns/notices/sweep` | `campaigns`, `campaign_members`, `seat_claim` | `campaign_notices`, `notification_outbox` | **no** | `campaign_notices` (27) absent. `lib/notices.js` catches it and returns quietly, so the sweep reports success and nobody is ever told a cohort moved. | [ ] |
| 87 | Read the bids on a campaign | `GET /admin/campaigns/:id/bids` | `provider_bids`, `bid_revisions`, `campaign_awards`, `campaign_price_books` | | yes | | [ ] |
| 88 | Read partners, approve, reject, suspend | `GET /admin/providers`, `POST /:orgId/approve`, `/reject`, `/suspend` | `provider_orgs`, `provider_users`, `users`, `PartnerApplications`, `provider_terms` | `provider_orgs`, `auth_events`, `CrmSyncQueue` | yes | `provider_orgs.rejection_reason` (8) does **not** exist, so a rejection's reason is not stored. Approval is also not yet enforced server side on the partner's own routes. | [ ] |
| 89 | Verify or reject a coverage claim | `POST /admin/providers/:orgId/coverage/:region/verify`, `/reject` | `provider_coverage` | `provider_coverage`, `coverage_verifications`, `auth_events` | yes | `coverage_verifications` exists but is undeclared in `schema.js` | [ ] |
| 90 | Read all coverage | `GET /admin/coverage` | `provider_coverage`, `campaigns` | | yes | | [ ] |
| 91 | Change partner settings | `POST /admin/providers/:orgId/settings` | `provider_orgs` | `provider_orgs`, `auth_events` | yes | `provider_orgs.lead_rate` does **not** exist, so a per-partner fee override cannot be set | [ ] |
| 92 | Merge two partner organisations | `POST /admin/orgs/merge` | `provider_orgs`, `provider_users` | `provider_orgs`, `provider_users`, `auth_events` | yes | | [ ] |
| 93 | Read an intake table | `GET /admin/leads/:table` | one of 11 in `LEAD_TABLES` | | partly | eight live intake tables are missing from the map: `CityRequests`, `ProductVotes`, `ReferralClicks`, and the six tire tables. Staff cannot read any of them. | [ ] |
| 94 | Read the waitlist referral report | `GET /admin/referral/waitlist` | `WaitlistShareCodes`, `ReferralClicks`, `WaitlistSignups` | | **no** | 500s by design when `WaitlistShareCodes` is unreadable, which is now | [ ] |
| 95 | Read demand by FSA | `GET /admin/intake/geo` | `WaitlistSignups`, `WaitlistDetails`, `BillCheckupSubmissions`, `CalculatorEstimates` | | yes | | [ ] |
| 96 | Read the audit log | `GET /admin/audit` | `auth_events` | | yes | | [ ] |
| 97 | Read and drain the outbox | `GET /admin/notify/outbox`, `POST /admin/notify/drain`, `/tick` | `notification_outbox`, `notification_deliveries` | `notification_outbox`, `notification_deliveries` | yes | the Job Scheduling job that would call `/tick` on a clock does not exist | [ ] |
| 98 | Read and lift suppressions | `GET /admin/notify/suppressions`, `POST /lift` | `email_suppressions` | `email_suppressions`, `auth_events` | yes | | [ ] |
| 99 | Arm a campaign for the scheduler | not implemented | | | **no** | `campaigns.schedule_armed` and `scheduler_ticks` are both absent and no code reads them | [ ] |
| 100 | Invalidate a bid | not implemented | | | **no** | `provider_bids.invalidated_at`, `invalidated_reason` absent | [ ] |
| 101 | Disqualify a partner from a cohort | not implemented | | | **no** | `campaign_disqualifications` absent | [ ] |
| 102 | Override an award | not implemented | | | **no** | `campaign_awards.override_reason`, `overridden_at` absent. `method` and `awarded_by` exist. | [ ] |
| 103 | Read a partner's uploaded document | not implemented | `provider_documents` | | derived | a File Store read, no table | [ ] |

## 7. System actions

| # | Action | Where | Reads | Writes | Exists live? | Gaps | Owner check |
|---|---|---|---|---|---|---|---|
| 104 | Queue a public submission for the CRM | `enqueueCrm` in `formSubmit`, `lib/crm/outbox.js` in `auth` | | `CrmSyncQueue` | yes but missing columns | the six phase 0 to 3c columns (`EntityType`, `EntityRowId`, `EventType`, `EventVersion`, `IdempotencyKey`, `NextAttemptAt`) do not exist, so every row falls back to the legacy ten and carries no idempotency key. The code comment says they were created on 2026-09-02; the store disagrees. Best effort by design, errors are swallowed. | [ ] |
| 105 | Push queued rows into Zoho CRM | `crmSync` function | `CrmSyncQueue` | `CrmSyncQueue` | yes | **no cron job exists**, so the drainer never runs and nothing reaches CRM | [ ] |
| 106 | Send queued mail | `lib/notify/outbox.js` drain | `notification_outbox`, `email_suppressions`, `unsubscribe_tokens`, `user_prefs` | `notification_outbox`, `notification_deliveries` | yes | no Job Scheduling job, so it only drains when a request happens to trigger it | [ ] |
| 107 | Sweep cohort stage notices | `lib/notices.js` `sweepAsync`, on `GET /campaigns` and `GET /provider/campaigns` | `campaigns`, `campaign_members`, `seat_claim` | `campaign_notices`, `notification_outbox` | **no** | as row 86 | [ ] |
| 108 | Seal the price book on first read | `lib/awards.js` `sealBook` | `provider_bids`, `campaigns` | `campaign_price_books`, `campaign_awards` | yes | | [ ] |
| 109 | Seal the household window on first read | `lib/offers.js` | `campaign_price_books` | `household_offers` | yes | | [ ] |
| 110 | Recount cohort seats | `lib/seats.js` `recount` | `seat_claim` | `cohort_counter` | yes | | [ ] |
| 111 | Move armed campaigns on a clock | not implemented | | | **no** | rows 99 and 105 are the same missing piece: there is no scheduler in this project at all | [ ] |

---

## Tables and columns that must exist before these actions record anything

Deduplicated, grouped by the function that owns them. This is the input to the
owed-additions list in `TABLE_NAMING_GUIDE.md`.

### `auth` function, `lower_snake_case`

Absent and blocking shipped code:

| Table | Section | Blocks rows |
|---|---|---|
| `campaign_notices` | 27 | 86, 107 |
| `brand_registry` | 34a | 37, 38, 59, 60, 62 |
| `provider_brands` | 34b | 59, 61, 62, 63 |
| `distributor_providers` | 34c | 59, 61, 62, 63 |
| `member_provider_exclusions` | 34d | 37, 61, 62, 63 |
| `brand_requests` | 34g | 60 |

Absent and owed by the admin v2 brief, nothing broken meanwhile:

`scheduler_ticks`, `campaign_disqualifications`, `campaigns.schedule_armed`,
`provider_orgs.lead_rate`, `provider_orgs.serviceability_url`,
`provider_bids.invalidated_at`, `provider_bids.invalidated_reason`,
`campaign_awards.override_reason`, `campaign_awards.overridden_at`.

### `formSubmit` function, `PascalCase`

| Table | Section | Blocks rows |
|---|---|---|
| `WaitlistShareCodes` | 40a | 3, 18, 94 |
| `ReferralClicks` | 40b | 4, 94 |

One column to add: `WaitlistSignups.PoolingFor`.

One column rename, no deploy needed: `CityRequests.province` to `Province`.

### Columns owed on tables that already exist (auth)

`campaigns.fsas` (29a), `users.postal_code_updated_at` and `postal_code_source`
(29b), `provider_orgs.rejection_reason` (8), `campaign_members.referral_code`
(12). Each has a fallback ladder in the code, which is why none of them has ever
raised an error and none of them has ever worked. Full list and consequence in
`TABLE_NAMING_GUIDE.md` section 3.2.

### Not a table

- Notify me when a cohort moves (row 32) is an `auth_events` row on purpose.
- Pass on an offer (row 28) is complete in `claim_event`.
- Export and delete my data (rows 45, 46) are complete, with `auth_events` as the record.
- The $10 acceptance fee has no payment service provider behind it, so it has no table.
