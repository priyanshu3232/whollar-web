# How Whollar is shaped inside Zoho CRM

Companion to `CRM_SYNC_RUNBOOK.md`, which covers the plumbing (queue, worker,
cron, credentials). This file covers the **model**: what becomes a record, in
which module, keyed on what, and what deliberately never leaves the Data Store.

## The one rule

**The Data Store is the system of record. CRM is the relationship surface.**

Every number that decides anything (a sealed price, a seat count, a fee, a
tier) is answered by the Data Store, and CRM holds a copy for people to read.
Where the two disagree, the Data Store is right and CRM is stale. No
operational decision is ever taken from a CRM figure, and nothing writes back
from CRM into the Data Store.

This is what keeps CRM from becoming a second, drifting source of truth. It
also decides most of the questions below: when in doubt, sync the person and
the status, not the arithmetic.

## A correction to the obvious mental model

**Members do not bid.** Partners bid: one sealed bid per (cohort, partner),
revisable, append-only. A member joins a cohort, and later accepts one of the
three cards in the window they are shown.

So "the household that bid on a cohort" is two separate records:

- **joined a cohort**, from `campaign_members` / `seat_claim`
- **accepted an offer**, from `household_offers` then `provider_orders`

Keeping them separate is the point: the first is interest, the second is
revenue, and the gap between them is the number the business lives on.

## The entity map

| Whollar thing | Zoho module | External key | Written when |
| --- | --- | --- | --- |
| Anonymous form fill | **Leads** | `Email` | form submitted (live today) |
| Household with an account | **Contacts** | `Whollar_User_Id` | OTP signup verified |
| Partner company | **Accounts** | `Whollar_Org_Id` | partner org created |
| Person at a partner | **Contacts**, linked to the Account | `Whollar_User_Id` | `provider_users` row |
| Partner application | **Deals**, pipeline `Partner Onboarding` | `Whollar_Org_Id` | application submitted |
| Cohort | **Campaigns** | `Whollar_Campaign_Id` | campaign row created |
| Household in a cohort | **Campaign Member** (native related list) | the pair | join, leave, move, pass |
| Sealed bid | custom module **Sealed Bids** | `Whollar_Bid_Key` | sealed, updated on revision |
| Award | fields on the Sealed Bid record | `Whollar_Bid_Key` | award settles |
| Order through to activation | **Deals**, pipeline `Cohort Delivery` | `Whollar_Order_Key` | offer accepted |
| Billing arrangement | fields on the Account | `Whollar_Org_Id` | billing method saved |
| Terms acceptance | fields on the Account | `Whollar_Org_Id` | terms accepted |
| Rating, product interest, checkup | Notes on the Contact | n/a | as they happen |

### Why Contacts and not Leads for households

Leads is a staging area Zoho expects you to convert out of. A household with
an account, an FSA and a cohort seat is a relationship, not a lead. The
conversion point is **account creation**: the form fill lands as a Lead, and
the day that email verifies an account, that Lead converts to a Contact
carrying its history. Campaign membership works against either, so cohorts do
not care which side of the conversion someone is on.

### Why Accounts and not Vendors for partners

The partner is the party that pays the success fee, so it belongs in the
module that carries revenue, related lists and Deals. Vendors is a
procurement module with no Deal relation.

This is a change from today's `CRM_PARTNER_MODULE`, which defaults to Leads
and documents Vendors as the alternative. It also forces a technical change:
**Accounts has no standard Email field**, so the current search-by-email
dedupe cannot work there. See "Dedupe on an external id" below.

## Field specs

Only the fields the sync writes. Everything else is Zoho's default layout.

### Contacts (household)

| Field | API name | Source |
| --- | --- | --- |
| Whollar user id | `Whollar_User_Id` | `users.user_id`, unique, external id |
| First / Last name | `First_Name` / `Last_Name` | `users.first_name` / `last_name` |
| Email | `Email` | `users.email_display` |
| Phone | `Phone` | `users.phone` |
| Postal code | `Mailing_Zip` | `users.postal_code` |
| FSA | `Whollar_FSA` | `users.fsa` |
| Province | `Mailing_State` | `users.province_code` |
| Language | `Whollar_Locale` | `users.locale` |
| Account status | `Whollar_Status` | `users.status` |
| Referral code | `Whollar_Referral_Code` | `users.referral_code` |
| Email opt out | `Email_Opt_Out` | consent state and `email_suppressions` |

Write `crm_contact_id` back into `users` on first create. The column exists
and is written null today, and it is the only thing that makes the link
auditable in both directions.

### Contacts (person at a partner)

Same module, distinguished by `Whollar_Contact_Type = partner` and an Account
link. `provider_users.role` goes to `Whollar_Partner_Role`. Note that
`provider_users.user_id` is deliberately not unique: one person may act for
two partner orgs, so this is many-to-one onto Accounts and the sync must not
assume otherwise.

### Accounts (partner)

| Field | API name | Source |
| --- | --- | --- |
| Org id | `Whollar_Org_Id` | `provider_orgs.org_id`, unique, external id |
| Account name | `Account_Name` | `provider_orgs.legal_name` |
| Email domain | `Whollar_Email_Domain` | `provider_orgs.email_domain` |
| Approval status | `Whollar_Approval_Status` | `provider_orgs.approval_status` |
| Approved at / by | `Whollar_Approved_At` / `_By` | `provider_orgs.approved_at` / `approved_by` |
| Rejection reason | `Whollar_Rejection_Reason` | `provider_orgs.rejection_reason` |
| Terms version | `Whollar_Terms_Version` | `provider_terms.doc_version` |
| Terms accepted at | `Whollar_Terms_Accepted_At` | `provider_terms.accepted_at` |
| Billing email | `Whollar_Billing_Email` | `provider_billing.billing_email` |
| Billing state | `Whollar_Billing_State` | `provider_billing.state` |

Terms acceptance is append-only per version in the Data Store, and the Account
carries only the latest. That is fine: the Account is a summary, and the proof
that v1 was accepted when the v1 bids were placed lives in `provider_terms`
where it belongs.

### Campaigns (cohort)

| Field | API name | Source |
| --- | --- | --- |
| Campaign id | `Whollar_Campaign_Id` | `campaigns.campaign_id`, unique, external id |
| Name | `Campaign_Name` | `region` plus `sub` |
| Type | `Type` | `campaigns.kind` |
| Start / End | `Start_Date` / `End_Date` | `bidding_opens_at` / `bidding_closes_at` |
| Region | `Whollar_Region` | `campaigns.region` (the partner key) |
| FSAs | `Whollar_FSAs` | `campaigns.fsas` (the member key) |
| Target seats | `Whollar_Target` | `campaigns.target` |

`region` and `fsas` are different keys and neither derives the other: region
decides who may bid, FSAs decide which households may join. Keep both, labelled.

Member Status on the campaign mirrors `campaign_members.status` plus the seat
lifecycle: `joined`, `waitlist`, `alert`, `passed`, `moved`, `left`.

### Sealed Bids (custom module)

One record per `bid_key`, which is `${campaign_id}:${org_id}`. **Updated in
place on every revision, never one record per revision.** `bid_revisions` is
the authoritative history and stays in the Data Store.

| Field | API name | Source |
| --- | --- | --- |
| Bid key | `Whollar_Bid_Key` | `provider_bids.bid_key`, unique, external id |
| Partner | lookup to Accounts | `org_id` |
| Cohort | lookup to Campaigns | `campaign_id` |
| Headline price | `Whollar_Price` | `provider_bids.price` |
| Status | `Whollar_Bid_Status` | `sealed` or `improved` |
| Revisions | `Whollar_Revision_Count` | `provider_bids.revision_count` |
| Guarantee months | `Whollar_Guarantee_Months` | `provider_bids.guarantee_months` |
| Receipt no | `Whollar_Receipt_No` | `provider_bids.receipt_no` |
| Sealed at | `Whollar_Submitted_At` | `provider_bids.submitted_at` |
| Tiers won | `Whollar_Tiers_Won` | `campaign_awards.tiers_won` |
| Awarded at | `Whollar_Awarded_At` | `campaign_awards.awarded_at` |

**This module must never be visible to a partner.** Partners have no CRM login
today. The day anyone opens a Zoho portal, Sealed Bids is excluded from every
portal profile, along with any Campaign view that shows a bid count. No
partner sees another partner's bid, count, or reference, and a CRM view is not
an exception to that.

Do not sync `tiers`, `discount_mix` or `payload_hash`. They are the sealed
mechanics, they are large, and nothing in CRM answers a question with them.

### Deals, pipeline `Partner Onboarding`

One per partner application, on the Account. Stages follow the real journey:
`Submitted`, `Documents`, `References`, `Coverage Verified`, `Approved`,
`Rejected`. Amount stays empty: an application is not revenue.

This exists so the onboarding funnel has aging and stage history for free,
which is the one thing the Data Store makes awkward to ask.

### Deals, pipeline `Cohort Delivery`

One per `provider_orders.order_key`, which is `${campaign_id}:${user_id}`.
Linked to the partner Account, the household Contact and the cohort Campaign.

| Field | API name | Source |
| --- | --- | --- |
| Order key | `Whollar_Order_Key` | `provider_orders.order_key`, unique, external id |
| Order no | `Whollar_Order_No` | `provider_orders.order_no` |
| Stage | `Stage` | mapped from `provider_orders.state` |
| Tier | `Whollar_Tier` | `provider_orders.tier` |
| Accepted price | `Whollar_Accepted_Price` | `provider_orders.price` |
| Slot | `Whollar_Slot_At` | `provider_orders.slot_at` |
| Activated at | `Whollar_Activated_At` | `provider_orders.activated_at` |
| Amount | `Amount` | **0 until activation**, then the success fee |

State to stage: `acc` Accepted, `bkd` Booked, `act` Activated, `rel`
Released, `noshow` No Show, `access` Access Failed, `linefail` Line Failed.

Two rules bite here and both are absolute:

1. **`Amount` stays 0 until the state reaches `act`.** No billable line comes
   from a confirmation, an offer acceptance, or a booking. Only an activation
   with a clean line test creates a fee. A Deal carrying an Amount at Booked
   would put unearned revenue in the forecast, which is the same error in a
   dashboard that it is in an invoice.
2. **The fee is read from `site_config.success_fee`**, via the same path
   `lib/billing.js` uses. It is configuration on the agreement, never a
   constant. The 95 in the code is a fallback for an unconfirmed number and
   must not be copied into a Zoho field default.

## What never goes to CRM

Not an oversight list. Each of these is a deliberate refusal.

- **`provider_orders.address_line` and `.phone`.** The household released an
  address and a mobile to **one partner for one install visit**, by ticking a
  box that said so. A CRM record is a different audience and a different
  retention period. The Deal names the cohort and the FSA; the address stays
  where the household put it.
- **`household_offers.audit_json`.** Operator-only by rule, and it contains
  per-bid resolution across partners.
- **`bid_revisions`.** History belongs to the sealed record.
- **`member_bills` values and OCR output.** Someone's actual bill is the most
  sensitive thing here and CRM answers no question with it. The checkup
  verdict as a Note is enough.
- **`sessions`, `credentials`, `auth_challenges`, `auth_events`.** Security
  data. It never leaves the backend.
- **`notification_outbox` and `notification_deliveries`.** Plumbing.
- **`campaign_price_books`.** Internal computation, superseded on every recut.

## What must go to CRM, for legal reasons

**Consent and suppression state, on the Contact and the Lead.**

This is the item most likely to be forgotten and the only one with a statutory
edge. Canada's anti-spam law does not care that the unsubscribe was recorded
in `email_suppressions` if a marketer then mails that address from a CRM list
that never heard about it. So:

- `Email_Opt_Out` is set from consent state at create, and
- every write to `email_suppressions` enqueues a CRM update that sets it.

An address suppressed in the Data Store and mailable in CRM is a defect with a
fine attached, not a sync gap.

## Three technical decisions the model forces

### 1. Dedupe on an external id, never on email

Today `findRecordByEmail` searches `(Email:equals:…)` and requires the module
to have an `Email` field. That works for Leads. It cannot work for Accounts,
which has no standard Email field at all, and it is wrong for everything else:
a partner org has many emails, a cohort has none, and an email that changes
would fork the record.

Every module above gets a **unique text field holding the Data Store key**,
marked as the module's external id, and the writer searches on that. Email
stays the key for Leads alone, where it is the only thing an anonymous form
fill has.

Without this, every resync duplicates. It is the single highest-consequence
detail in this document.

### 2. Move the writer to upsert

Search-then-write is two calls before any write, so today's 158-row backlog
costs roughly 474 API calls. Zoho's upsert endpoint takes duplicate-check
fields and does it in one. With external ids in place the dedupe semantics are
identical and the failure mode is better: no window between the search and the
write for a second run to insert a duplicate.

Confirm the endpoint against the org's API version before rewriting, and keep
the search path for Leads-by-email.

### 3. The source descriptor replaces `moduleFor`

`SOURCE_META` plus `moduleFor` currently answers one question: Leads or the
partner module. The model above needs four answers per source: which module,
which key field, how to build the key, and which field map. That is one
descriptor table in `crmSync/index.js` and the rest of the worker stays as it
is, including the lock, the retry ladder and the note builder.

## The process

### Phase 0: confirm two things before building anything

1. **Zoho edition.** Custom modules need Enterprise or above. If the org is on
   Standard or Professional, **Sealed Bids has no home**, and the right answer
   is to skip bids in CRM entirely rather than deform another module into
   holding them. Everything else in this document works on any edition.
2. **Who owns records.** Zoho assigns an owner per record and routes
   notifications by it. Decide now whether that is one operations user or a
   round robin, because changing it later rewrites every record.

### Phase 1: build the schema in Zoho (console, half a day)

Setup work only, no code. In order, because later steps reference earlier ones:

1. Custom fields on Contacts, Accounts, Campaigns, as specced above. Mark each
   `Whollar_*_Id` unique and set it as the module's external id.
2. The `Sealed Bids` custom module, with lookups to Accounts and Campaigns.
3. The two Deal pipelines and their stages.
4. Picklist values for every status field, spelled exactly as the Data Store
   spells them. A value the code sends that the picklist lacks is dropped, and
   the note builder already warns about that in the record it writes.
5. Field-level permission: Sealed Bids hidden from every profile that is not
   operations.

### Phase 2: rework the writer (code, 1 to 2 days)

1. The source descriptor table.
2. External-id dedupe, keeping email for Leads.
3. Upsert, if Phase 0 confirms it.
4. Lookup resolution: a Sealed Bid needs the Account and Campaign record ids,
   so the writer resolves them by external id and caches within a batch.
5. Field-map coverage test per source, run in CI the way the other gates are.

### Phase 3: add the enqueue points (code, 1 day)

`lib/crmqueue.js` in the auth function, one `enqueue()` writing the existing
nine-column `CrmSyncQueue` shape, swallowing every error and never throwing
into a request path. Then the call sites:

| Event | Route | Source |
| --- | --- | --- |
| member account verified | `routes/otp.js` | `MemberSignups` |
| partner account verified | `routes/provider.js` | `PartnerSignups` |
| partner org created | `routes/desk.js` `/provider/org` | `PartnerOrgs` |
| application submitted | `routes/application.js` | `ProviderApplications` |
| approved or rejected | `routes/admin.js` | `PartnerApprovals` |
| terms accepted | `routes/contracts.js` | `PartnerTerms` |
| billing method saved | `routes/billing.js` | `PartnerBilling` |
| cohort joined, left, moved, passed | `routes/seat.js` | `CohortSeats` |
| bid sealed or improved | `routes/desk.js` | `SealedBids` |
| award settled | `lib/awards.js` | `CohortAwards` |
| offer accepted | `routes/campaigns.js` | `HouseholdOrders` |
| order state changed | `routes/delivery.js` | `HouseholdOrders` |
| suppression added | `lib/notify/` | `EmailSuppressions` |

No new tables. `CrmSyncQueue` is source-agnostic, which is the one piece of
luck in this whole exercise.

### Phase 4: backfill (one-off, half a day)

Existing rows predate the enqueue points, so CRM would start empty of
everything except forms. Generate queue rows from the Data Store, in
dependency order, because lookups need their targets to exist:

`campaigns` then `provider_orgs` then `users` then `provider_users` then
`campaign_members` then `provider_bids` then `campaign_awards` then
`provider_orders`.

Write the generator as a script that emits `CrmSyncQueue` inserts, so the
backfill goes through the same worker, the same field maps and the same
retry ladder as live traffic. A backfill on a separate code path is a second
implementation that will disagree with the first.

### Phase 5: verify and guard

1. Row counts per module against `SELECT COUNT` per table.
2. Spot-check one record per module against its Data Store row.
3. Re-run one backfill batch and confirm **zero duplicates**. This is the test
   that proves external ids work, and it is the only one that matters.
4. Confirm a suppressed address reads `Email_Opt_Out` true in CRM.
5. Confirm Sealed Bids is invisible to every non-operations profile.
6. Alert on `crmSync` failed executions, and on queue depth: the oldest
   PENDING row's age is the health signal, not the count.

## Deploy order

The worker learns the new sources before the auth function starts sending
them. An unknown source falls through to a generic label rather than failing,
so this is cleanliness rather than breakage, but the Zoho schema must exist
before either: a field the picklist lacks is dropped silently on write, and a
missing custom module fails the whole batch for that source.

Zoho schema, then `crmSync`, then `auth`, then the backfill.
