# Phase 3b report: external-id upsert and remaining wiring

Phase 4 backfill NOT started. Nothing deployed. All decisions recorded in
`docs/crm-sync-decisions.md` under "Amendments of 2026-09-02, Phase 3b".

## The two unfilled pastes

Your brief carried two `[PASTE: ...]` placeholders that arrived empty:

- the CRM module API names and the `Whollar_ROWID` field API name per module
- the Cron Expression result

I did not guess them into code. That is the same failure that kept your cron
refused for five weeks: a literal `<CRM_CRON_SECRET>` sitting in a URL. Both are
now **configuration**, read from environment variables with D1's proposed names
as defaults, so confirming them changes a console variable and not the build.

| Variable | Default | Used for |
| --- | --- | --- |
| `CRM_EXTERNAL_ID_FIELD` | `Whollar_ROWID` | the dedupe field on every module |
| `CRM_MODULE_HOUSEHOLD` | `Contacts` | households |
| `CRM_MODULE_PARTNER_CONTACT` | `Contacts` | people at a partner |
| `CRM_MODULE_PARTNER` | `Accounts` | partner companies |
| `CRM_MODULE_COHORT` | `Cohorts` | cohorts |
| `CRM_MODULE_MEMBERSHIP` | `Cohort_Memberships` | cohort membership |
| `CRM_MODULE_SEALED_BID` | `Sealed_Bids` | bids |
| `CRM_MODULE_SWITCH_ORDER` | `Deals` | orders |
| `CRM_MODULE_SETTLEMENT` | `Settlements` | reserved, no writer yet |

Zoho pluralises and underscores custom module names in ways worth confirming in
Setup, Developer Hub, API Names before trusting the defaults.

The Cron Expression trial still cannot be run from here: creating or editing a
Job Scheduling job is console work with no API in this project.

## Event coverage: 18 of 22 wired

The catalogue lost four entries this phase, all recorded with reasons in the
decisions file: `household.verified` folded into `household.created`, and the
three `settlement.*` removed until a writer exists.

| Event | Entity | Wired at | Descriptor | Tested |
| --- | --- | --- | --- | --- |
| `household.created` | `household` | otp | yes | yes |
| `household.updated` | `household` | me | yes | yes |
| `household.erased` | `household` | **no** | yes | no |
| `household.consent_changed` | `household` | **no** | yes | no |
| `cohort.created` | `cohort` | admin | yes | yes |
| `cohort.stage_changed` | `cohort` | admin | yes | yes |
| `cohort.awarded` | `cohort` | **no** | yes | no |
| `cohort.cancelled` | `cohort` | admin | yes | yes |
| `cohort_membership.joined` | `cohort_membership` | campaigns, seat | yes | yes |
| `cohort_membership.exited` | `cohort_membership` | campaigns, seat | yes | yes |
| `partner.applied` | `partner` | application | yes | yes |
| `partner.state_changed` | `partner` | admin | yes | yes |
| `partner.coverage_changed` | `partner` | desk | yes | yes |
| `partner.updated` | `partner` | billing, contracts, desk | yes | yes |
| `partner_contact.created` | `partner_contact` | provider | yes | yes |
| `partner_contact.updated` | `partner_contact` | **no** | yes | no |
| `sealed_bid.submitted` | `sealed_bid` | desk | yes | yes |
| `sealed_bid.revised` | `sealed_bid` | desk | yes | yes |
| `switch_order.created` | `switch_order` | campaigns | yes | yes |
| `switch_order.state_changed` | `switch_order` | delivery | yes | yes |
| `switch_order.activated` | `switch_order` | delivery | yes | yes |
| `switch_order.released` | `switch_order` | delivery | yes | yes |
### The four not wired

| Event | Reason |
| --- | --- |
| `household.erased` | see report |
| `household.consent_changed` | needs the suppression writer in `lib/notify/unsub.js`, another session's in-flight work |
| `cohort.awarded` | deferred: `awards.sealBook()` is lazy, fires on a member read, and no explicit award action exists |
| `partner_contact.updated` | no code path: `/me/profile` is `requireMember` only and no partner self-edit route exists |
`household.erased` is the one worth restating: **there is no erasure or
redaction route anywhere in this stack.** D6 is deferred with it and acceptance
test 6 is struck from this build, with the ordering rule recorded in the
decisions file so it survives to the build that needs it.

## D4 as implemented

`upsertByExternalId(ctx, module, externalId, fields)` posts to the v8 `/upsert`
endpoint with `duplicate_check_fields` set to the external id field. Every
entity-typed row goes through it. Legacy website-form rows keep the
search-then-write path they have used since July, deliberately: rewriting a
working sync to no purpose is how working syncs stop working.

**Contact adoption**, the one place email is still a key. A household that filled
in a bill checkup in August already has a CRM record with no `Whollar_ROWID` on
it, and upserting on the id alone would grow a second one beside it. So a
Contact-shaped entity is looked up by email once; if a record exists and carries
no external id, the id is written onto it and it becomes that household's record
for ever after. Three guards, each tested:

- a record already carrying **another** household's id is never adopted
- a record already carrying **this** household's id is returned without a write
- Accounts never take this path at all

**The dedupe key can never be dropped.** `offendingField` drops what Zoho refuses
and retries, which is right for a postal code and catastrophic for the external
id: dropping it turns an upsert into an insert, and an insert that should have
matched is a duplicate. `isRequired` now covers the external id field alongside
Email, Last_Name and Company, and a test asserts a refused external id fails
loudly rather than quietly forking the record.

## Item 4, the column ladder: kept and made loud

Not removed. Removing it turns a renamed or missing column into a lost event,
which is worse than a legacy row. Leaving it silent would let an environment run
for weeks writing rows with no idempotency key and no dedupe.

So the fallback stays and now logs at error level, naming the event and saying
in words that the row has no idempotency key and cannot dedupe. A test asserts
the wide path is the one taken when the columns are present.

## Test results, run locally with zcatalyst-sdk-node installed

Every step in `check-frontend.yml`, run one at a time from the repository root.

```
44 steps, 44 passed, 0 failed
```

Including the five CRM suites:

```
test-crm-outbox.mjs        34 passed, 0 failed
test-crm-serialisers.mjs   17 passed, 0 failed
test-crm-events.mjs        22 passed, 0 failed
test-crm-upsert.mjs        19 passed, 0 failed
test-crmnotes.mjs          76 passed, 0 failed
                          168 assertions
```

And, worth noting, `check-notify-copy.mjs --check` **passes locally**:

```
check-notify-copy: OK, 23 template(s), 39 rendered message(s) clean
```

That is the step failing in CI. It proves the CI red is purely the missing
`zcatalyst-sdk-node` in an install-free workflow and not a defect in that code.

## Deploy

Backend only. `catalyst-backend` is in `.vercelignore`, so none of this touches
the website.

**Through the pipeline, which is the normal path.** Any push to `main` touching
`catalyst-backend/**` runs `.github/workflows/deploy-functions.yml`, which tests
then deploys to the Catalyst **Development** environment. Watch the Actions tab;
about three minutes.

**By hand, if you need it.** From `catalyst-backend`, install each function's
dependencies first, because `node_modules` is gitignored and Catalyst packages
local dependencies at deploy time:

```
cd catalyst-backend
for d in functions/*/; do (cd "$d" && npm ci --omit=dev); done
catalyst deploy --dc ca --org 110003037934 --project 1258000000014001 \
  --token "$CATALYST_TOKEN" --only functions -ni
```

All five flags are required together. Without them `catalyst deploy` prints an
auth failure, exits 0, and deploys nothing, which is how this pipeline was a
false green for its first runs in July.

Two functions change: **auth** (the outbox, serialisers and 20 call sites) and
**crmSync** (upsert, adoption, classification, backoff). The Job Scheduling job
itself needs no change: it still POSTs the same URL.

## What to enable in the console, in this order

1. **Confirm the API names** above and set any that differ, on the **crmSync**
   function's environment variables.
2. **Confirm `IdempotencyKey` is Unique** on `CrmSyncQueue`. Everything else
   degrades; this one silently permits duplicate delivery.
3. **Deploy**, and watch the queue: rows should start carrying `EntityType` and
   `IdempotencyKey`. If you see the loud fallback line in DevOps logs, a column
   name is wrong.
4. **Test one event with nothing released.** Sign in, join a cohort, then read
   the parked row:
   ```sql
   SELECT EventType, IdempotencyKey, Payload FROM CrmSyncQueue WHERE Status = 'PARKED' ORDER BY CREATEDTIME DESC LIMIT 5
   ```
5. **Release**, only when the payloads read correctly:
   ```sql
   UPDATE CrmSyncQueue SET Status = 'PENDING' WHERE Status = 'PARKED'
   ```
   and set `CRM_NEW_SOURCES=true` on the **auth** function so later events skip
   the parked lane.
6. **Watch the first drain** in DevOps logs, filtered to crmSync. Adoption logs a
   line per Contact it claims, which is the one to read first: it tells you the
   form-created records are being enriched rather than duplicated.

Stop there. Phase 4 backfill is next and is not started.
