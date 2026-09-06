# Data Store backlog, 2026-09-06

The console work the audit turned up, in the order worth doing it. Everything
here is a click in the Zoho Catalyst console on the **Development** environment;
none of it can be done from code, because Catalyst has no DDL API.

Every block ends with a check you can paste into the console's ZCQL tab. Do one
block, run its check, then move on. `node scripts/check-store-tables.mjs` answers
the whole existence question in one command once you are logged in with the CLI.

Where a block says "section N", that is `catalyst-backend/scripts/create-tables.md`,
which has the full column list, types, lengths and flags. **Build from there, not
from here.** This file is the order and the reason; that file is the instructions.

The audit behind it: `ACTION_TABLE_AUDIT.md`. The naming rule: `TABLE_NAMING_GUIDE.md`.

---

## 1. Three Unique flags that are off, and one duplicate row to delete

**Do this first.** It is the only item here that is already corrupting data
rather than merely failing to record it.

`provider_applications` holds two rows for one org, written four milliseconds
apart with the same `application_id` and the same `org_id`. `application_tasks`
holds the matching duplicate `task_key_org`. All three columns are declared
Unique in section 17, so the flags are off in the console.

`findApplication` reads `LIMIT 1`, so that partner's application is half
invisible: whichever row comes back first is the one they see, and the other
holds whatever was written to it.

**In the console:** turn IsUnique on for

| Table | Column |
|---|---|
| `provider_applications` | `application_id` |
| `provider_applications` | `org_id` |
| `application_tasks` | `task_key_org` |

The duplicate rows have to go first, or the flag will not take. Find them:

```sql
SELECT ROWID, application_id, org_id, state, legal_name, CREATEDTIME
  FROM provider_applications
  WHERE org_id = '6621cddb-8146-490a-80d8-b7256acfae0e'
```

Two rows come back. Keep the one carrying real content (`state = 'submitted'`,
`legal_name = 'ABCD'`) and delete the empty draft. Then the same for the task:

```sql
SELECT ROWID, task_key_org, state, CREATEDTIME FROM application_tasks
  WHERE task_key_org = '6621cddb-8146-490a-80d8-b7256acfae0e:registration'
```

**Check, after the flags are on.** Insert the same key twice from the ZCQL tab.
The second must be refused:

```sql
INSERT INTO application_tasks (task_key_org, org_id, task_key, state)
  VALUES ('unique-probe:coverage', 'unique-probe', 'coverage', 'empty')
```

Run it twice. If both succeed, the flag did not take. Delete the probe row after.

**Then re-check the rest.** These three were caught because the tables had
enough rows to collide. Most do not: `provider_bids` has 0 rows,
`household_offers` 0, `campaign_members` 1, `campaign_awards` 1,
`provider_orders` 1. Their race guards are unverified and a two-insert test is
the only way to know. `claim_event.event_key` at 45 rows is the one with real
evidence behind it, and it is clean.

---

## 2. Six columns on `CrmSyncQueue`

Every CRM event written today falls back to the legacy ten columns and logs
"this row has NO idempotency key and cannot dedupe". The comment above that
fallback in `lib/crm/outbox.js` says the six columns were created on 2026-09-02.
They were not.

| Column | Type | Length | Unique | Notes |
|---|---|---|:--:|---|
| `EntityType` | Var Char | 32 | | `household` \| `cohort` \| `partner` \| `cohort_membership` \| `sealed_bid` \| `switch_order` \| `settlement` |
| `EntityRowId` | Var Char | 255 | | |
| `EventType` | Var Char | 64 | | the catalogue name, e.g. `household.created` |
| `EventVersion` | Int | - | | |
| `IdempotencyKey` | Var Char | 255 | ✅ | `${entity}:${rowid}:${eventType}:${version}`. **The unique flag is the whole point of the column** |
| `NextAttemptAt` | DateTime | - | | |

PascalCase, like the rest of the formSubmit family.

**Check:**

```sql
SELECT EntityType, EntityRowId, EventType, EventVersion, IdempotencyKey, NextAttemptAt
  FROM CrmSyncQueue LIMIT 1
```

An empty result is fine. An error naming a column is not. After it passes, the
next enqueue should stop logging the fallback line.

Worth knowing: **nothing reaches Zoho CRM today regardless**, because no cron
job exists to run the drainer. That is a separate piece of work and this column
set is what makes it safe to run twice.

---

## 3. Section 40: `WaitlistShareCodes` and `ReferralClicks`

The waitlist share code is live on all three hosts and records nothing. A
household leaves an address in the corner popup, the address saves, the code
write fails, and the card falls back to a done state with no code on it.
`POST /ref-click` writes nowhere, so no arrival on a shared link is ever counted,
and `GET /admin/referral/waitlist` answers 500 by design while the table is
unreadable.

Build both from section 40a and 40b. Gate checks are 40c.

---

## 4. Section 27: `campaign_notices`

Nothing tells a household its cohort moved stage. `lib/notices.js` catches the
missing table and returns quietly, so `POST /admin/campaigns/notices/sweep`
reports success while doing nothing at all, which is the worst shape a gap can
take.

Build from section 27. Its gate checks are in the same section.

---

## 5. Section 34: provider exclusions, five tables

**Decide before building.** This is a whole feature that was built, deployed and
never given a store: the member's "do not offer me these providers" picker, the
partner brand roster, brand requests, and the distributor serving map. Six
endpoints read empty and two refuse.

If the feature is wanted:

| Table | Section |
|---|---|
| `brand_registry` | 34a |
| `provider_brands` | 34b |
| `distributor_providers` | 34c |
| `member_provider_exclusions` | 34d |
| `brand_requests` | 34g |

Then its columns, which are the rest of the same feature: `provider_bids.brand_id`
and `submitted_via_distributor_id` (34e), and the five on `household_offers` (34f).

If the feature is not wanted, say so and the code comes out. Leaving it is the
one option with no upside: six endpoints that look implemented and answer empty.

---

## 6. Columns owed on tables that already exist

Each of these has a fallback ladder in the code, which is why none has ever
raised an error and none has ever worked.

| Table | Column | Section | What starts working |
|---|---|---|---|
| `campaigns` | `fsas` | 29a | FSA-scoped campaign eligibility. Today `lib/catalog.js` drops the column from its projection and every campaign reads as unscoped. |
| `campaign_members` | `referral_code` | 12 | the referral stamp on a join, which is multi-campaign attribution |
| `provider_orgs` | `rejection_reason` | 8 | the sentence a refused partner is shown |
| `users` | `postal_code_updated_at`, `postal_code_source` | 29b | the trail on a postal code change |
| `WaitlistSignups` | `PoolingFor` | landing port | which product a household is pooling for. It already exists on `CityRequests`. PascalCase. |

**Check, per table:** select the new column with `LIMIT 1`. Empty is fine, an
error naming the column is not.

---

## 7. One rename

`CityRequests.province` is lowercase where the code and section 37a say
`Province`. It is the only case mismatch left in the whole store, across both
families and all sixty tables. `formSubmit`'s insert maps around it and logs one
line per process, so nothing is broken; renaming the column in the console
clears the workaround and needs no deploy.

---

## 8. The admin console v2 columns

Nothing reads any of these yet, so nothing breaks while they are absent. Build
them when the code that uses them is written, not before. The specs are in
`TABLE_NAMING_GUIDE.md` section 3.5.

`scheduler_ticks`, `campaign_disqualifications`, `campaigns.schedule_armed`,
`provider_orgs.lead_rate`, `provider_orgs.serviceability_url`,
`provider_bids.invalidated_at`, `provider_bids.invalidated_reason`,
`campaign_awards.override_reason`, `campaign_awards.overridden_at`.

---

## 9. When the blocks above are done

1. `node scripts/check-store-tables.mjs` and confirm nothing reads MISSING.
2. Sign in as an admin and read `GET /api/auth/health/diagnostics`. It now covers
   all 49 auth tables, the five partner application tables included, and reports
   every missing column and every wrong Unique or Mandatory flag. That is the
   check this backlog was assembled by hand to replace, and after this it is one
   request.
3. Smoke one action per surface against Development and confirm a row lands: a
   tire guided signup, a city request, a product vote, a bill checkup, a join, a
   partner coverage declaration, a staff coverage verify.
4. Tick the rows in `ACTION_TABLE_AUDIT.md` as they go green.

## Not on this list, deliberately

- **`privacy_requests`.** `GET /me/export` and `POST /me/delete` already write an
  `auth_events` row each. Decided against 2026-09-06.
- **A table for passing on an offer.** `POST /cohorts/:id/pass` is complete:
  `claim_event` carries the action and the reason, the membership drops, the
  order releases and the seat count recounts.
- **A table for the $10 acceptance fee.** There is no payment service provider in
  the stack, so there is nothing to record against yet.
- **Prefixing the auth tables.** Decided against 2026-09-06. The reasoning is in
  `TABLE_NAMING_GUIDE.md` section 4.
