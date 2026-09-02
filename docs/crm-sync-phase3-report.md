# Phase 3 report: outbox, wiring and drainer

Phases 1, 2 and 3 of the 2026-09-02 brief are complete, with the four amendments
applied to `docs/crm-sync-decisions.md`. Phase 4 backfill is NOT started, as
instructed. Nothing here is deployed.

## Event coverage

15 of 26 event types are wired to a real code path. Every one of the 26 has a
descriptor in the drainer, so the catalogue and the worker are one list, and the
gate in `scripts/test-crm-outbox.mjs` fails the build if they diverge.

| Event type | Wired at | Descriptor | Tested |
| --- | --- | --- | --- |
| `household.created` | otp | yes | yes |
| `household.verified` | **not wired** | yes | no |
| `household.updated` | me | yes | yes |
| `household.erased` | **not wired** | yes | no |
| `household.consent_changed` | **not wired** | yes | no |
| `cohort.created` | **not wired** | yes | no |
| `cohort.stage_changed` | **not wired** | yes | no |
| `cohort.awarded` | **not wired** | yes | no |
| `cohort.cancelled` | **not wired** | yes | no |
| `cohort_membership.joined` | campaigns, seat | yes | yes |
| `cohort_membership.exited` | campaigns, seat | yes | no |
| `partner.applied` | application | yes | no |
| `partner.state_changed` | admin | yes | no |
| `partner.coverage_changed` | desk | yes | no |
| `partner.updated` | billing, contracts, desk | yes | no |
| `partner_contact.created` | provider | yes | no |
| `partner_contact.updated` | **not wired** | yes | no |
| `sealed_bid.submitted` | desk | yes | yes |
| `sealed_bid.revised` | desk | yes | yes |
| `switch_order.created` | campaigns | yes | no |
| `switch_order.state_changed` | delivery | yes | no |
| `switch_order.activated` | delivery | yes | yes |
| `switch_order.released` | delivery | yes | no |
| `settlement.issued` | **not wired** | yes | no |
| `settlement.paid` | **not wired** | yes | no |
| `settlement.failed` | **not wired** | yes | no |

## The eleven that are not wired, and why

Three groups, and only the first is ordinary backlog.

**Blocked on D4, the `Whollar_ROWID` field.** `cohort.created`,
`cohort.stage_changed`, `cohort.cancelled`, `settlement.issued`,
`settlement.paid`, `settlement.failed`.

A cohort is not a person and a statement is not a person: neither has an email
address, and this drainer's only way of finding a CRM record is
`findRecordByEmail`. Enqueueing them today would write rows that nothing can
deliver, which is worse than not writing them, so the code paths are left alone
until the drainer can upsert on an external id. `cohort.created` and
`cohort.stage_changed` have live call sites waiting for them at
`routes/admin.js:949` and `routes/admin.js:1114`.

**No code path exists at all.** `household.erased`, `settlement.*` writers.

There is **no erasure or redaction route anywhere in this stack**. D6 was decided
in detail on 2026-09-02, including the ordering rule that pending queue rows must
be killed before the CRM deletion is enqueued, and there is nothing to attach it
to. `lib/billing.js` reads settlements (`settlementsFor`) but never issues, pays
or fails one; that writer does not exist either.

This is worth saying plainly: the brief's acceptance test 6, "erase a household",
cannot be written against this codebase today.

**Not separable from an event already wired.** `household.verified`,
`partner_contact.updated`, `cohort.awarded`, `household.consent_changed`.

`household.verified` is the same request as `household.created`: an OTP account
is created and verified in one step, so a second event would fire on the same
line with the same payload. `cohort.awarded` has only one trigger,
`awards.sealBook()`, which seals lazily inside a member's offer read and returns
the same value whether it just sealed or is re-reading an old seal; a call site
there would be racy and aimed at the wrong audience. `household.consent_changed`
needs the suppression writer in `lib/notify/unsub.js`, which is another session's
in-flight work.

## Two event types added to the catalogue

The brief says not to invent events outside its list without reporting them.
Two were needed:

- **`partner.updated`**, used by three live call sites: an org rename, terms
  acceptance, and a billing method going on file. None is an approval change, so
  `partner.state_changed` would have been a lie, and the catalogue had nothing
  else for a partner fact changing.
- **`household.consent_changed`**, for a suppression. Not wired yet, but the
  catalogue needed a name for it that was not `household.updated`, because CASL
  makes it a different kind of event from a phone number changing.

Both need your approval or a rename.

## Cron Expression trial: not run, and not runnable from here

Amendment 2 asks for one attempt at a 15 minute Cron Expression schedule.
**Creating or editing a Job Scheduling job is Catalyst console work with no API
in this project**, so this cannot be done from the repository.

It is owed by the operator: create a Cron Expression job for 15 minutes and
either record that it was accepted, or paste the exact refusal text into
`docs/crm-sync-decisions.md` under D5. Until then the hourly values stand, and
all three of Amendment 2's consequences are implemented at their hourly settings:
parent-first ordering within a run, a 1 minute to 3 hour repair window, and a 90
minute stuck-row reset.

## What Phase 3 actually changed in the drainer

- **Failure classification.** 401 refreshes the token and retries once, then
  fails. 429 honours `Retry-After`. Any other 4xx is dead after two attempts,
  because a malformed field will be just as malformed in ten hours. 5xx and
  network errors back off 1, 5, 25, 125, 625 minutes and are dead after five.
  Errors now carry `httpStatus`, which they did not before, so this is
  possible at all.
- **Per-row claim.** Each row is claimed by a ROWID-keyed update to
  `IN_PROGRESS` before any work, and a claim that does not stick is skipped
  rather than raced.
- **Stuck rows** reset after 90 minutes.
- **Parent-first ordering** within a run, so a cohort membership and the
  household it depends on are delivered in one pass instead of an hour apart.
- **The ZCQL cap is asserted**, not discovered: a batch at 300 throws with a
  message naming `CRM_BATCH_SIZE`.
- **A column ladder on everything.** The five new columns do not exist in the
  console yet, so every write is attempted with them and retried without, and
  every read falls back to the legacy select. This deploys safely today and
  gains the new behaviour the moment the console work is done.

## Not done in Phase 3, and named rather than skipped

**The dead-row digest, D7.** `crmSync` is a separate Catalyst function with no
mailer and no access to the auth function's notify layer. Wiring ZeptoMail into a
second function is its own piece of work with its own environment variables. Dead
rows are logged with their idempotency key and are visible in the queue; nobody
is emailed yet.

## Owed console work, before any of this can deliver

Five columns on `CrmSyncQueue`, by hand, no DDL API:

| Column | Type | Notes |
| --- | --- | --- |
| `EntityType` | Var Char 32 | |
| `EntityRowId` | Var Char 255 | |
| `EventType` | Var Char 64 | |
| `EventVersion` | Var Char 64 | a natural discriminator, not always a number |
| `IdempotencyKey` | Var Char 255 | **must be Unique**, and this is the whole dedupe |
| `NextAttemptAt` | Date-Time | backoff is inert without it |

`IdempotencyKey` being Unique is the one that matters. Without it a retried
request writes a second row and CRM gets the note twice.

## Tests

127 assertions across three files, all passing, all registered in CI:
`test-crm-outbox.mjs` 34, `test-crm-serialisers.mjs` 17, `test-crmnotes.mjs` 76.

They still have never run in CI, because `check-notify-copy.mjs` fails before
reaching them: it transitively requires `zcatalyst-sdk-node` through
`lib/datastore.js`, which is not installed in an install-free workflow. That is
another session's work and I have not touched it.
