# CRM sync decisions, D1 to D7

Answers to the hard-stop decisions in the 2026-09-02 build brief. Recorded
verbatim where the human answered, marked pending where they have not. Nothing
in Phase 1 onward may contradict this file; if a decision turns out to be wrong,
change it here first and note the date.

## Settled 2026-09-02

### The spine question, which the brief assumed rather than asked

**No spine. The outbox is written directly from each business write.**

`campaign_events` does not exist and building it is a larger project than this
sync. The 16 already-wired events write the outbox from the business handler,
beside the existing `audit.recordAsync`, and that stays. The Phase 5 repair scan
keys off the business tables rather than off a spine, and `source_event_rowid`
is dropped from the outbox column list because it has nothing to reference.

Accepted cost, stated so nobody rediscovers it later: there is no single ordered
record of what happened to an entity. Reconstructing a household's history means
reading several tables. If that becomes painful, the middle path is a spine for
campaign-scoped events only, and this decision is the place to revisit.

#### Downstream documents that assume a spine

Amendment 3 asked for every reference to `campaign_events`, `campaignEvents`,
`event_spine` and append-only, so downstream work could be corrected later.

**The answer is that no document assumes it exists.** Every reference already
records its absence, and three of them predate this work:

| File and line | What it says |
| --- | --- |
| `docs/PHASE0-NOTIFICATIONS-AUDIT.md:19` | "There is no event spine and there is no scheduler" |
| `docs/PHASE0-NOTIFICATIONS-AUDIT.md:203` | "Absent. `campaign_events` does not exist. `account_events` does not exist." |
| `docs/PHASE0-NOTIFICATIONS-AUDIT.md:207` | lists the five append-only ledgers that exist instead |
| `docs/DELIVERY_AUDIT.md:38` | "absent as a concept: this stack has `auth_events` only" |
| `docs/DELIVERY_AUDIT.md:131` | "There is no `campaign_events` table in this stack and no dedupe" |
| `docs/MULTI_CAMPAIGN_AUDIT.md:109` | "No such table. Four disjoint append-only logs" |
| `docs/MULTI_CAMPAIGN_AUDIT.md:284` | "Also confirmed: no `campaign_events` spine" |

So **no correction work is owed** to the billing, multi-campaign or cohort-exit
efforts on this point. The only thing that assumed the table exists is the CRM
build brief itself. The other append-only references are to real tables that do
exist and are unrelated: `consents`, `bid_revisions`, `claim_event`,
`user_events`, `notification_deliveries`.

### D1, module mapping: accepted, with the Deal amount removed

The module map stands as proposed. One amendment: **a Deal carries stage and the
order key, and no amount.**

`amount_cents` does not exist; money in this stack is `varchar(16)`. More
importantly the success fee is not on the order at all, it is
`site_config.success_fee`, and `provider_orgs.lead_rate` is being added to
override it per company. A figure copied into CRM at enqueue time would be a
snapshot of a number still being designed, and the nightly reconciler would then
fight billing over which is right.

Money stays in the Data Store, where billing owns it. CRM reports the pipeline by
count and stage, which is what it is good at.

### D2, household PII allowlist: accepted as proposed, full postal code included

Permitted: first name, last name, email, **full postal code**, FSA, province,
phone, city, current provider, plan speed tier, cohort status, referral token
presence as a boolean.

**Amended 2026-09-02: allowlist first, key-name scrub second.**

The control is a per-entity **allowlist serialiser** in `lib/crm/serialisers/`.
Each one names every field permitted to leave Catalyst for that entity type. A
field not named there does not exist as far as CRM is concerned, whatever a call
site passes and whatever it is called.

The key-name exclusion in the outbox stays, but as a **backstop, not the
control**. Order of operations, enforced in `enqueue()` and not left to callers:

1. the entity's serialiser, which keeps only named fields
2. the scrub over the serialiser's output, which removes anything address-shaped
   or secret-shaped that a serialiser wrongly named
3. insert

Two layers because they fail differently. A serialiser is a list someone edits
and can widen by accident; the scrub is a rule that does not care who edited
what. Backstopped: street address, unit, buzzer, the install address and mobile
from `provider_orders`, tokens, hashes, any document.

Asserted by `scripts/test-crm-serialisers.mjs`, which adds a fake column to a
household payload and fails if it reaches the outbox row.

Note the deliberate asymmetry with the audit trail, which records the FSA and
never the postal code. That is an append-only security log which must not become
a second copy of where everyone lives. This is a customer record, where a postal
code is the ordinary field that makes a household reachable.

### D3, sealed bid visibility: option (a), fact of bid only

CRM stores that a bid exists: partner, cohort, revision number, receipt,
timestamp. **No prices, ever, in any module, note, field or log line.**

Already built and already asserted: `scripts/test-crmnotes.mjs` passes a price
into the payload deliberately and fails if it appears in the note. The same rule
is stated in `routes/desk.js` beside the audit line, which carries no prices for
the same reason.

Revisit only if CRM gains a second user AND a restricted profile is verified to
hold. A sealed bid reaching another partner is the one failure this business
cannot have.

## Settled with a recommendation, uncontested

### D4, dedupe key: recommended, uncontested

`Whollar_ROWID` as a unique external-ID text field on every module, email as the
secondary match for records the form sync created earlier.

Effectively forced rather than chosen: Zoho gives Accounts no standard Email
field, so email dedupe cannot work there at all, and without a stable key every
resync duplicates every record. Historical form-created records should be matched
by email and updated rather than left alone, so a household does not end up as
two records.

### D5, cadence: forced by the platform, 60 minutes

Job Scheduling refused any Periodic interval under 60 minutes on 2026-09-01. The
live job `crmSyncdrain` is hourly. Nightly reconciler at 03:00 America/Toronto.

**Cron Expression trial: NOT RUN, and it cannot be run from here.** Creating or
editing a Job Scheduling job is Catalyst console work with no API in this
project. The trial is owed by the operator: create a Cron Expression job for a 15
minute schedule, and either record that it was accepted or paste the exact
refusal text into this file. Until then the hourly values below stand.

**Amended 2026-09-02: three numbers follow from hourly.** Revert all three to the
brief's originals if the 15 minute schedule is accepted.

**a. No dependency requeue as the first move.** Within a single run, rows are
processed parent-first by entity type:

    household, cohort, partner, partner_contact,
    cohort_membership, sealed_bid, switch_order, settlement

Parent CRM ids resolved earlier in the same run are reused before any lookup, so
a household and the cohort membership that depends on it are almost always
delivered in one pass. Only if the parent is still absent after that does a row
wait for the next run, capped at **3 waits**, then dead with reason
`missing_parent`. Waiting an hour for a parent that arrived in the same batch is
the failure this ordering exists to prevent.

**b. Repair scan window: 1 minute to 3 hours.** Business rows created in that
window with no matching outbox row are enqueued. Keyed off the business tables,
per the no-spine decision, not off `source_event_rowid`.

**c. Stuck rows: `in_progress` older than 90 minutes** resets to pending, not 15.
A run that legitimately spans an hourly boundary must not have its own rows
reclaimed underneath it.

### D6, erasure propagation: delete the Contact, keep the order anonymised

Settled 2026-09-02.

On `household.erased`:

- The **Contact** and its **Cohort_Memberships** are deleted from CRM.
- The **Switch_Order** survives, with the Contact link removed and the name
  fields replaced by `Redacted household`, so partner settlement history and
  activation counts stay intact and auditable. A partner's earned fee keeps its
  record; the person it was earned on does not.
- **Any pending outbox row for that household is marked dead with reason
  `erased`**, before anything else. This is the part that is easy to miss and the
  part that matters: a queue draining an hour later would otherwise deliver the
  details of somebody who asked to be forgotten, and the delivery would look
  entirely successful.

The erasure path must therefore kill the queue rows first and enqueue the CRM
deletion second, never the other way round.

### D7, outage alerting: recommended, low stakes and reversible

One ZeptoMail digest to the admin at most once per hour listing dead rows, plus a
badge count on the admin dashboard. Taken as the default unless contradicted.


## Deferred to billing build

Recorded here, not acted on in this sync. Nothing below changes any CRM code.

- **Money is `varchar(16)`** throughout: `provider_bids.price`,
  `provider_orders.price`, `campaign_awards.price`. Not a number, not cents.
- **`amount_cents` does not exist** anywhere in the repository. The only place
  cents are used at all is `provider_bids.discount_mix`, the sealed custom mix,
  create-tables.md section 28.
- **The success fee is not on the order.** It is `site_config.success_fee`, read
  through `lib/billing.js`, with `provider_orgs.lead_rate` being added as a
  per-company override.

**The billing build must resolve the column type and cents-exact arithmetic
before any fee is computed.** Deciding that inside a CRM sync would be settling
the money model as a side effect of a mirror, which is the wrong order. Until it
is settled, no CRM record carries a fee amount, per D1 as amended.


## Amendments of 2026-09-02, Phase 3b

### Catalogue additions approved

`partner.updated` and `household.consent_changed` are approved as named.

### `household.verified` removed from the catalogue

Folded into `household.created`. An OTP account is created and verified in the
same request: `users.findOrCreate` returns `created`, a session is issued, and
there is no second moment to observe. A separate event would have fired on the
same line, with the same payload, against the same record, and every household
would carry two identical notes a millisecond apart. Removed from `EVENTS` and
from the drainer's descriptors rather than left as a name nothing can emit.

If email verification ever becomes a distinct step, this is the decision to
reopen.

### D6 erasure: deferred to a dedicated build

**No erasure or redaction route exists anywhere in this stack.** There is nothing
to attach the decision to, so the CRM half is deferred with it, and acceptance
test 6 is struck from this build and moved to that one.

**The ordering rule is recorded here so it is not lost**, because it is the part
that is easy to get wrong and expensive to get wrong:

> On erasure, pending outbox rows for that household are marked dead with reason
> `erased` FIRST, and the CRM deletion is enqueued SECOND. In that order and
> never the reverse. A queue draining an hour later would otherwise deliver the
> details of somebody who asked to be forgotten, and the delivery would look
> entirely successful.

The deletion itself, once built: delete the Contact and its Cohort_Memberships,
keep the Switch_Order with the Contact link removed and the name fields replaced
by `Redacted household`.

### `settlement.issued` / `paid` / `failed`: deferred to the billing build

No writer exists: `lib/billing.js` reads settlements and never issues, pays or
fails one. Removed from the catalogue rather than left as three entries that can
never be emitted. They return with the billing build, alongside the column type
and cents-exact arithmetic questions already recorded under "Deferred to billing
build".

### `cohort.awarded`: deferred until an explicit award action exists

Its only possible trigger today is `awards.sealBook()`, which is **lazy**: it
seals on the first read after a cohort closes, from inside a member's offer
request, and returns the same value whether it just sealed or is re-reading an
existing seal. A caller cannot tell the two apart, so an enqueue there would fire
on every read, on a member's request path, about a partner. Unsuitable in three
separate ways.

It needs an explicit operator award action, or a return value that distinguishes
a fresh seal. Kept in the catalogue because the trigger is a matter of when, not
whether.

### D7 digest: deferred to the ZeptoMail notification build

`crmSync` is a separate Catalyst function with no mailer and no access to the
auth function's notify layer. Dead rows are logged with their idempotency key and
are visible in the queue; nobody is emailed yet.

### The two unanswered pastes

The Phase 3b brief carried two `[PASTE: ...]` placeholders that were never
filled: the CRM module and `Whollar_ROWID` field API names, and the Cron
Expression result.

Rather than guess names that fail at runtime, both are **configuration**, read
from environment variables with D1's proposed names as defaults. See
`CRM_MODULE_*` and `CRM_EXTERNAL_ID_FIELD` in the Phase 3b report. Confirming
them changes an environment variable, not the build.


## Amendments of 2026-09-02, Phase 3c

### Partner coverage: a multi-select on Accounts, not a module

`Whollar_Coverage`, a multi-select picklist on Accounts whose values are the
region slugs. `partner.coverage_changed` writes that field, not the note.

No coverage module. A partner serves a handful of regions and the only questions
asked of them are "does this partner cover Toronto West" and "who covers it",
both of which a multi-select answers. A module would buy per-region status and
verification dates, which already live in `provider_coverage` where they are
authoritative.

One consequence to be aware of: a multi-select is **replaced**, not appended, on
each write, and a `coverage_changed` event carries one region. The map therefore
writes the region it was told about; making it carry the full set means reading
`provider_coverage` at enqueue time, which is a change to the serialiser and is
not in this phase.

### Settlements: not built

The module is not created. Deferred to the billing build along with the three
`settlement.*` events already removed from the catalogue. The serialiser stays,
because the entity is real and the allowlist is what gets reviewed then.

### Two rules that are now tests, not intentions

**Sealed_Bids carries no price field, ever**, and the module is restricted to the
founder's profile. **Deals `Amount` is left empty.**

Both were already asserted at the serialiser boundary. As of Phase 3c they are
asserted again at the field-mapping boundary, which is the layer that decides
what is written to a CRM field: `scripts/test-crm-fieldmap.mjs` passes prices and
amounts into both maps and fails if either produces a field carrying one. Two
layers, because a serialiser and a field map are edited by different people at
different times for different reasons.
