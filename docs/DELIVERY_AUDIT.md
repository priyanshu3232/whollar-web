# Delivery, Phase 0 audit

Date: 2026-08-28. Read-only. No production code was written, per the build
brief's instruction to report Phase 0 and collect the five hard-stop answers
first.

## Headline

**The brief is written against a state that no longer exists.** Sections 4, 5
and 6 of it propose building a delivery chain that largely shipped in commit
`fd64c7b`, "A win becomes a record, a roster, an activation, and one statement
line". Backend, front end and the table runbook are all in place.

Taking section 4's data model (`rosters`, `switch_orders`, `billing_methods`)
and section 5's state machine (`pending > contacted > booked > activated`) as
written would be a rewrite of working code plus a break of the client/server
wire contract, for no gain. See "What to build instead" at the end.

## Inventory

| Concern | Where | Status |
|---|---|---|
| Award / winner sealing | `lib/awards.js` | implemented, correct |
| Roster gate: billing, capacity, consent | `lib/awards.js`, `routes/delivery.js` | implemented, gaps below |
| Switch orders and the state machine | `lib/orders.js` | implemented, correct |
| Order creation at acceptance | `routes/campaigns.js` | implemented, correct |
| Book / activate / exception / release | `routes/delivery.js` | implemented, correct |
| Pre-gate data wall | `routes/delivery.js`, `partner/core/contract.js` | implemented, asserted twice |
| Statement math, cents-exact | `lib/billing.js` | implemented, correct |
| Billing method on file | `lib/billing.js` | implemented, invoice not a PSP |
| Delivery board UI | `partner/views/delivery.js` | implemented |
| The four tables | runbook section 21 | created, columns unverified |
| Offers-out state | | absent |
| Per-gate progress, actor, timestamp, consent version | | absent |
| Stage guard on release | | absent |
| Weekly pacing, window validation, cliff warning | | absent |
| Completion, settlement, admin mirrors | | absent |
| `campaign_events` and event dedupe | | absent as a concept: this stack has `auth_events` only |
| Member timeline mirror on booked and activated | | absent |
| Export | | absent, which matches the brief's own HS4 recommendation |

## The three platform checks

**Scoping (brief item 2).** Clean. Every campaign-scoped read carries its
filter, and the delivery reads carry both:
`rowsForCampaign` is `org_id = ? AND campaign_id = ?` in `lib/orders.js`.
No offenders.

**Non-ROWID writes (brief item 3).** Zero, and structurally impossible.
`lib/datastore.js` exposes no SQL UPDATE or DELETE path at all: `updateRow`
throws a `TypeError` without a ROWID, `deleteRow` takes a row id, and every
write in the function goes through them. The failure mode the brief warns
about is not reachable in this codebase.

**Duplicate `campaign_id` (brief item 4).** Real, and handled loosely.
`catalog.load` builds `byId` as a Map, so duplicates collapse and the winner is
whichever sorts last by `sort_order` then id, not newest `CREATEDTIME`, and
nothing logs it. It does not threaten writes, which are all by ROWID, and it
does not threaten scoping, because the join key everywhere is the
`campaign_id` string used consistently. Worth a warning log, not a refactor.

**Catalog cache (brief item 5).** Confirmed, and already reasoned about in the
code: rows memoized 60 seconds, stage deliberately not. The delivery view
already updates from each write's verified response rather than re-fetching.

## The five hard stops

Three are already answered by shipped code.

- **HS2, billing rails: answered and shipped.** There is no payment service
  provider. What a partner puts on file is an invoicing arrangement: billing
  email, contact, net-15, `state active`. This is roughly the brief's option
  (c) without the document upload. A PSP can extend this row later rather than
  replace it. No keys are needed to ship.
- **HS5(b), the missed-visit credit: answered and shipped.** $25, configurable
  via `site_config.missed_visit_credit`, applied on a `noshow`, deducted from
  the partner statement.
- **HS4, export: the recommended answer is already the behaviour.** No export
  path exists anywhere. `api.statementExport` is a stub.
- **HS1, who releases: open.** Shipped behaviour is partner self-serve with
  `gate_by` and `gate_at` stamped. There is no admin release. Recommend
  keeping self-serve and adding the admin action.
- **HS3, the roster field set: open, and the brief asks for more, not less.**
  What is released today is `address_line` plus `fsa`, and nothing else. The
  brief's proposed set adds household name, contact channel, tier, effective
  price and install notes. None of those columns exist and none are collected
  at acceptance. Structural opinion: add the contact channel only. A partner
  phoning to book is the actual workflow; the other three are either already on
  the offer or not needed to complete an install.
- **HS5(a), household cancellation after a deposit: open, and unanswerable as
  posed.** There is no deposit concept anywhere in the backend. Someone has to
  say what the deposit is before the policy can be written.

## The real gap list

1. **Erasure leaves the address behind.** `POST /me/delete` drops
   `credentials`, `auth_identities`, `member_bills`, `campaign_members` and
   events, but never touches `provider_orders`, whose column is
   `member_user_id` and is not in the list. A member who deletes their account
   leaves their service address on a partner's board indefinitely. This is the
   brief's edge case 16, it is live, and it is the sharpest finding here.
2. **Release is not stage-guarded.** The gate checks billing, capacity and
   consent, never the campaign stage. A partner can release the roster the
   instant bidding closes, before decisions lock. Edge case 3 fails.
3. **Release is not idempotent.** A second POST to the gate overwrites
   `gate_at` with a fresh timestamp rather than returning the existing roster.
   Edge cases 4 and 5 fail. Cheap to fix, because orders are created at member
   acceptance and not at release, so there is no duplicate-row hazard. The
   brief's assumption that release creates the rows is wrong for this
   codebase, and the codebase is right.
4. **Gate progress is one write, not three.** `awards.release` sets capacity,
   `consent_ack` and `gate_at` together. There is no incremental save, no
   per-gate actor and timestamp line, and no consent copy version. Edge cases 3
   and 14 both fail.
5. **Offers-out does not render.** `waiting()` only fires when the org holds
   zero awards, so once the award seals the view jumps straight to the gated
   card. No acceptance count against a target, no decisions-lock date, no poll,
   no pre-gate capacity field.
6. **No pacing.** Capacity is stored and never used. `readSlot` validates
   future and within a year, not the switch window and not remaining weekly
   capacity. Edge cases 11, 12 and 19 absent.
7. **No completion or settlement.** `settled_at` exists as a column nothing
   writes, and `provider_statements` is read-only in code. Admin has no
   settlement, release or dispute surface at all.
8. **Member mirror is one field.** `yourOrder` returns order number and state,
   with no install date and no timeline entries.
9. **Events.** There is no `campaign_events` table in this stack and no dedupe
   key on `auth_events`. Section 6's event contract and edge case 24 would be
   new infrastructure.

## What to build instead

Keep the shipped vocabulary (`acc`, `bkd`, `act`, `rel`, `noshow`, `access`,
`linefail`), the shipped tables and the shipped endpoints. Treat the brief's
sections 4 to 6 as superseded, and its sections 7 and 8 as the actual spec:
nearly every genuine gap above is a section 7 UI state or a section 8 edge
case, not a data model.

That reframes the work from a rewrite into roughly nine additions, of which
item 1 should ship on its own and immediately.

Blocked on HS1, HS3 and HS5(a).
