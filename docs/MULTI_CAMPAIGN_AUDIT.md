# Multi-campaign concurrency: Phase 0 audit

> Ground-truth audit of whether two or more campaigns can run concurrently at
> different stages without cross-contamination. Six parallel audits: backend lib,
> backend routes, member home, partner console, admin console, referral.
> Date: 2026-08-24. Nothing was changed; this is the report the build starts from.

## Verdict

The backend is architecturally multi-campaign already, and deliberately so.
There is no "current campaign" singleton anywhere: every campaign-scoped table
keys on a flattened composite carrying the campaign id, every route takes the
campaign from a path param or body, and stage is a pure function of
(campaign, now) recomputed per request, never cached or stored. The sealed-bid
axis, the strongest part of the codebase, is genuinely parallel-safe: an org can
hold one bid per campaign on N campaigns, enforced three layers deep.

What actually breaks concurrency is not scoping. It is: one P0 bug that blocks
the delivery and billing chain on every campaign equally, two structural gaps
(a second unguarded membership door, campaign-blind referral attribution), and
surface work (member home renders one cohort, the partner console never
refetches, the admin console cannot see bids or set dates).

Several of the brief's assumptions do not match this codebase. They are listed
at the end and were raised before Phase 1.

## Findings table

| # | Brief item | State | Where |
|---|---|---|---|
| 0.1.1 | campaign_id on campaign-scoped tables | Mostly correct | membership_key, bid_key, revision_key, award_key, order_key, statement_key all embed campaign id. Gaps: claim_event carries optional from/to cohort ids, no single filterable column; auth_events has no campaign column at all (campaign only inside the JSON detail blob, unqueryable in ZCQL); invite_click none; share_event optional |
| 0.1.2 | Membership uniqueness | Partially implemented | seat_claim: one per (address, vertical), global across campaigns, guarded at routes/seat.js:206-226. But POST /campaigns/join (routes/campaigns.js:533) writes campaign_members with no seat check: two doors, one lock. A member can hold N memberships via the legacy door |
| 0.1.2 | Bid uniqueness per (org, campaign) | Implemented and correct | bid_key unique + pre-check (desk.js:411-419) + revision_key race guard (bids.js:406-436), revision-before-head write order. N campaigns per org works today |
| 0.1.3 | Campaign singletons | Absent (good) | Exhaustively verified twice: no LIMIT 1 over open campaigns, no getActiveCampaign, no stored featured flag. See "Real singletons" below for what is global instead |
| 0.2.4 | Unscoped queries | 3 real findings | See list below |
| 0.2.5 | Cache keys | Correct, one caveat | Catalog memo and siteconfig memo are global but hold global data; cohort_counter is per-cohort; stage is never memoized (the load-bearing decision, catalog.js:319-325). The brief's "60-second referral COUNT cache" does not exist; /me/referral is uncached and computed on read |
| 0.3.6 | State machine | Implemented, different vocabulary | kind ladder planned>waitlist>forming>auction>closed>archived plus 7 date columns; stageOf/memberStageOf derive display stage. Transitions explicit-id, guarded by TRANSITIONS map, 409 on illegal or repeated, audit columns + auth_events row awaited (admin.js:675-715) |
| 0.3.7 | Scheduled jobs | Absent by design | No scheduler exists in the stack (stated in 4 files). Everything is seal-on-read: award seals on first read past close (awards.js:150-177, award_key unique makes the race idempotent); date backstop refuses late bids (campaigns.js:200-220). The only cron is crmSync, unrelated |
| 0.3.8 | Job idempotency | n/a / correct | Seal-on-read is idempotent by unique key; kind transitions are loudly non-repeatable (409), which is safe |
| 0.4.9 | Non-featured cards unclickable | Confirmed, state-dependent | Fixed for the arrive state (QA group 6l). Still broken: in state result only the featured card is pressable; in state waitlist no card is pressable (choose gate at dashboard.html:6173, inert div at 6182-6184). Hover CSS makes inert cards look pressable |
| 0.4.10 | New-member tile | Refuted as stated | The arrive lane does render the cohort tile below the checkup card (dashboard.html:5850). Real adjacent holes: "Nothing open near you yet" fallback when featured is not joinable (5884); result lane is a single card and #ckprompt is locked out of visitor states (6037); post-exit Rejoin notice lives in the member lane, invisible in the state an exit produces |
| 0.4.11 | Multi-membership rendering | Implemented but broken | joinedCamp() returns exactly one (dashboard.html:5498-5507) and every rail, date, panel, poll, share and countdown reads it. A second joined cohort's card shows the first cohort's stage pill (6120); history rows same bug (4304, 4309). Server side is fine: GET /campaigns returns per-campaign `you` |
| 0.4.12 | Partner console | Mostly correct, 3 defects | Bid ticket, My Bids, Delivery, Billing, Contracts all campaign-keyed with explicit ids and no state bleed. Defects: fetch-once-never-refetch (stale stage until a 409); overview counts every campaign platform-wide under the label "in your coverage" (overview.js:169-206 vs 203); expandedRow renders the full bid form on locked cohorts (desk.js:159) |
| 0.4.13 | Admin console | Partial | Every action carries an explicit campaign id, no singleton. Absent: sealed-bids review (windows can be toggled, contents unreachable), any read/write of the 7 date columns, per-campaign pause (only the global kill switch), cancel, sort_order/featured control, partner notify on launch. Dialogs name the slug, not the region. No compare-and-set: two admins last-writer-wins |
| 0.4.14 | Referrer panel bug | Confirmed, 3 causes | Primary: loadReferral() runs once per page load while the poll repaints a frozen REF (dashboard.html:4124 vs 6809/7839). Secondary: the /r/ cookie lane is dead on the /waitlist/ to /signup funnel (password.js never imports share; otp.js:212 burns the cookie). Tertiary: attribution binds only at account creation. Bonus live bug: refCountText checks REF.code and reads "will appear shortly" forever on token-only accounts (4069 vs 7247) |
| 0.4.14 | Attribution campaign-aware | Absent by design | One string on users.referral_code; no attribution edge table (deliberate, create-tables.md:1342); campaign_members carries no referral column; count increments at verify regardless of any campaign or join |

## P0: the award seal is broken (predates this task)

BID_COLS and BID_COLS_V2 (lib/bids.js:68-72) do not select org_id, and
awards.seal writes `org_id: win.org_id` (lib/awards.js:162) into a mandatory
column. The insert fails, the catch at awards.js:170-175 misreads it as a race,
and no award ever seals: the member sees a null winner, the partner never sees
a win, no roster releases, no statement builds, on every campaign. This is why
the delivery chain was never smoke-tested clean. Fix is one line (add org_id to
BID_COLS, or derive from bid_key).

## Unscoped-query list

1. routes/campaigns.js:55-63 `allRows()`: full campaign_members scan
   (`ROWID > 0`), folded per campaign in JS. queryAll caps at 15,000 rows and
   truncates silently, ROWID-ascending, so old campaigns crowd new ones out of
   the count. Feeds member counts, partner desk counts, the brief, admin, and
   the bid commitment cap (a valid bid can be refused). Fix: read
   cohort_counter, which already exists and is recomputed on every seat
   transition.
2. routes/delivery.js:91 and routes/desk.js:358 call bids.campaignBidRows from
   /provider routes, violating the invariant documented at bids.js:352-359.
   Campaign-scoped but not org-scoped: competitors' sealed rows sit in request
   memory. Not serialized today; one debug log away from a breach.
3. lib/seats.js:128-131: seat idempotency is keyed (claim_key, request_id) with
   no campaign; a reused Idempotency-Key across two different cohort requests
   for the same address silently replays the first.

Deliberate and correct (not defects): catalog.js:332 and siteconfig.js:161
global reads; the org-scoped cross-campaign aggregates in bids/awards/orders/
billing/contracts, each regrouped per campaign by the caller.

## Singleton list

No campaign singleton exists. What is genuinely global, and shared by every
running campaign:

- site_config: bidding_enabled (kill switch), cohort_terms_version (a bump
  pauses bidding on all campaigns for unaccepted orgs), success_fee (changes
  restate every unissued statement everywhere; frozen only at settlement),
  missed_visit_credit, tax_rate_pct, default_switch_threshold, waitlist_open
  (lib/siteconfig.js:36-93). Per-campaign config does not exist.
- CODE_CATALOG fallback: 6 hardcoded campaigns substituted when the campaigns
  table is missing or empty (catalog.js:80-87, 333-345).
- lib/places.js:353-357: duplicate-region tiebreak commented "only one of the
  two running cohorts".
- Client: joinedCamp() single-cohort rendering; SHORTCAL global date-format
  flag; one share payload per document; the single #cd countdown.

## Contradictions with the brief (decisions taken before Phase 1)

1. **Featured rule.** Brief: most recently launched open campaign, computed.
   Repo: no featured column by explicit design; lowest sort_order wins inside
   kind buckets (ccRank), joinable outranks auction, a joined member always
   sees their own cohort first; browser QA (groups 6f/6g) asserts this.
2. **Jobs.** Brief Phase 2 assumes Job Scheduling per (campaign, milestone).
   The stack has no scheduler at all, on purpose: stage is derived, awards seal
   on read, the close is enforced by a date backstop. Building jobs is new
   infrastructure that four files argue against, not a fix.
3. **INV-1 scope.** Brief: one membership per member per vertical. Repo: one
   seat per address per vertical, keyed on address deliberately (lib/seats.js).
   The defect is not the rule, it is the second door that skips it.
4. **campaign_events spine.** No such table. Four disjoint append-only logs
   (claim_event, bid_revisions, auth_events, consents); bid_revisions is the
   only one carrying campaign_id mandatorily.
5. **Referral cache.** The 60-second COUNT cache does not exist; the panel bug
   is a fetch-once bug plus a dead cookie lane.
6. **Known defects.** One of three was already fixed (new-member tile), one is
   real in two states (unclickable cards in result and waitlist, fixed in
   arrive), one is real with a different mechanism (referrer panel).

## Proposed fix order

P0 (unblocks everything, single line + smoke test)
1. awards org_id projection bug.

P1 data and scoping
2. Close the legacy door: route POST /campaigns/join through the seat guard
   (or retire it into /cohorts/:id/join).
3. allRows() to cohort_counter reads.
4. Org-scope or wrap the two campaignBidRows calls in /provider routes.
5. Campaign-stamped referral attribution write at join (new column or row),
   keeping users.referral_code for the count.
6. schema.js: declare the 7 missing tables so diagnostics can verify the
   delivery chain; add campaign_id to auth_events writes (new column).
7. Move-ledger compensation: re-insert the origin membership row when the
   cross-cohort move fails halfway (seat.js:365-386).

P2 lifecycle
8. Admin API for the seven date columns (validation, audit row, catalog
   invalidate), plus surfacing them in the admin console. This is the real gap
   the brief's "jobs" phase points at.
9. serverTime on the four bare member endpoints (offer, join, leave, notify).

P3 member surfaces
10. Widen the choose gate to result and waitlist states; drop hover affordance
    on genuinely inert cards.
11. Per-card stage rendering: cards and history rows read their own campaign's
    stage, not the global S.state; countdown/poll consider all memberships.
12. Referrer panel: refresh loadReferral on poll/visibility/join; fix
    refCountText token-awareness; read the ref cookie on the password lane.
13. Completed-campaign history needs the server to stop dropping
    archived/closed rows for members who were in them (or a history endpoint).

P4 partner console
14. Refetch campaigns+bids on visibilitychange, router change, and after seal.
15. biddableCampaigns() behind every "in your coverage" figure.
16. Gate expandedRow on unlocked; point the overview terms tick at termsState.

P5 admin console
17. Sealed-bids review view (new backend endpoint, campaign-scoped, org-blind).
18. Region + id in every confirmation; compare-and-set on transition and
    bid-window writes; per-campaign pause primitive; sort_order on the launch
    sheet.

Deferred pending decisions: featured-rule change, scheduler build, per-campaign
terms/fee config, capacity computation, cancellation flow, FSA overlap policy.

## Build log: what shipped 2026-08-24 (same day as this audit)

Decisions taken (user-confirmed): keep the sort_order featured rule; keep
seal-on-read and build the date API instead of a scheduler; keep one seat per
(address, vertical) and close the legacy door.

Backend (catalyst-backend/functions/auth):
- P0 fixed: org_id added to BID_COLS (lib/bids.js), awards.seal derives the
  org from bid_key as a fallback and logs its catch (lib/awards.js). The
  delivery/billing chain can now actually seal.
- allRows() is per-campaign: one scoped read per campaign id, no full-table
  scan, all eight call sites updated (routes/campaigns.js, desk.js, admin.js).
- Legacy doors closed: POST /campaigns/join runs the seat-claim transition and
  refuses SEAT_HELD/JOIN_CLOSED/ROSTER_FULL for forming cohorts; POST
  /campaigns/leave releases the claim under the same rules (R2/SEAL_RACE).
- Referral attribution stamped at join: campaign_members.referral_code carries
  the code the member arrived with, on the campaign actually joined. Column
  fallback until the console has it (see owed work below).
- awards.sealFromCampaign() is the only sanctioned /provider path to a seal;
  the all-orgs bid read no longer enters partner request scope (desk.js,
  delivery.js).
- Admin API for the seven date columns on POST/PUT /admin/campaigns, with
  ladder-order validation over the merged calendar, audit rows, catalog
  invalidation; GET /admin/campaigns now returns dates (epoch ms).
- New GET /admin/campaigns/:id/bids: staff-only, campaign-scoped sealed-bids
  review with org names and the award state.
- serverTime added to GET /campaigns/:id/offer (all exits) and the three
  member mutations.
- Cross-cohort move failure now restores the origin membership row and
  recounts both ledgers (routes/seat.js).
- schema.js declares the seven previously undeclared tables (campaign_awards,
  provider_orders, provider_billing, provider_statements, product_interest,
  invite_click, share_event) so /health/diagnostics can verify the chain.

Member dashboard (dashboard.html):
- Every joinable cohort card is pressable in every visitor state (result and
  waitlist included), matching the arrive fix QA group 6l shipped.
- Cards and history rows badge with their OWN campaign's stage, not the
  page's; history leave buttons gate on the row's stage.
- doJoinLegacy handles SEAT_HELD (conflict sheet), JOIN_CLOSED, ROSTER_FULL.
- Referrer panel: refreshes on the 120s beat and on visibilitychange;
  refCountText is token-aware. Inline field editors survive repaints (the
  select-popup focus-bounce fix).

Partner console (partner/):
- Campaigns and bids refetch on visibilitychange and on entering
  desk/overview/bids, throttled to one refetch per minute (app.js).
- Overview "in your coverage" figures count biddableCampaigns(); the
  activation terms tick reads termsState(); locked desk rows never render the
  expanded ticket; duplicate billing state key removed; bids view tolerates
  the b.campaign field name. Locked-row dim removed (app.css) so both desk
  sections read at full ink.

Admin console (admin-console/index.html):
- Per-campaign Schedule sheet (7 datetime-local fields, changed-only PUT).
- Sealed bids modal per campaign, labelled with region and id.
- Confirmation dialogs name region and slug; launch sheet takes sort_order,
  prefilled one below the current lowest (newest-featured convention).

Tests:
- scripts/test-multicampaign.mjs: 36 assertions driving the real route
  handlers over an in-memory Data Store (unique constraints derived from
  schema.js). Covers EC-10 both directions, INV-1 through the legacy door,
  INV-2, INV-3, the award-seal P0 regression, a bystander-campaign
  byte-identical snapshot, and per-campaign member standing.
- Full regression at ship time: qa-dashboard 123/123, qa-console 171 passing
  (4 pre-existing mix-schedule failures also present on clean HEAD),
  qa-seat 64/64, qa-share 94/94, backend TAP suites 114/114, all build gates
  green.

Owed manual work (Zoho console):
- ADD COLUMN campaign_members.referral_code, Var Char 64, not unique, not
  mandatory (create-tables.md section 12). Until then joins still work and
  only the attribution stamp is skipped.
- Still owed from before: event_key Unique double-insert test (26d), section
  22 folder + env vars, section 19/18 column checks.

Deploy order: the Catalyst auth function FIRST (the legacy-door guard and the
offer serverTime are backwards-compatible), then the frontend. The admin
console's new Schedule/Sealed bids features 404 gracefully against an old
backend but say nothing useful, so redeploy admin-console after the function.

Deferred, with reasons:
- Completed-campaign history: the server drops archived cohorts from
  GET /campaigns, so the data never reaches the client; needs a history
  endpoint or a per-member archived carve-out. Copy already promises it.
- Post-exit "Rejoin" notice renders only in the member lane, invisible in the
  visitor state an exit produces; needs a visitor-lane slot.
- Capacity vs declared install capacity across overlapping switching windows:
  warn-only computation not yet built (open decision 3 still open).
- Cancellation flow (bid voiding, member notice): blocked on the notification
  machinery that does not exist (no scheduler, no campaign mail templates) and
  on open decision 4.
- Per-campaign share sheet: moot while INV-1 holds one seat per address in
  one vertical; revisit with the second vertical.
- Promo-cliff reminders: absent server-side entirely (no scheduler); the
  client-side cliff watch is the only reminder. EC-25 is therefore N/A today.

## Build log: campaign and cohort sync, 2026-08-25

Audit first (nothing changed until findings were reported), then one pass.

What the audit found, against the brief's two suspected causes:

1. Ghost cards were real, and on both ends. `dashboard.html` booted from a
   six-entry `CAMPS` seed (London East, London North, Chatham-Kent, Windsor,
   Kingston West, Hamilton Mountain: no campaign_id behind any of them, one
   marked `you:'joined'`), dropped only when a LIVE answer arrived. The server
   had its own six (`CODE_CATALOG`, the GTA regions) that `catalog.load()`
   served to members AND partners whenever the `campaigns` table was missing
   or empty. The two lists shared no id.
2. The wire was NOT two queries. `GET /campaigns` and `GET /provider/campaigns`
   already shared `catalog.load()`, `allRows()` and `tally()`. The count
   divergence was elsewhere: the partner desk, brief and commitment cap read
   `seedHouseholds + campaign_members signups` (seed baselines of 58 to 112
   per cohort, plus waitlist rows), while the member seat ledger read the
   stored `cohort_counter.roster_count` (real claims, no seed, forming only).
   Same cohort, two definitions of "a household in it".

Also confirmed: no `campaign_events` spine and no 60s referral cache exist
(see the contradictions list above), so neither was copied.

Built:

- `lib/cohorts.js`, the one read layer. `seatCount(app, campaign)` is a
  COUNT at read time per campaign over active `seat_claim` rows and
  `campaign_members` rows standing as joined, one user_id once, NO seed.
  60s memo per campaign, invalidated by every write path (join, leave,
  notify, every seat transition, membership row drop), so on the writing
  instance the next read is exact and 60s bounds cross-instance staleness.
  `list()` counts and stages every visible campaign at one clock reading;
  `forMember()` / `forPartner()` are the two projections. `source:'code'`
  is an EMPTY list on every non-admin route: the shipped catalog is a
  template for the admin import button, never a live surface.
- Every count reader rewired onto it: GET /campaigns, GET /provider/campaigns,
  the brief, the bid commitment cap, ROSTER_FULL on both join doors, every
  seat route reply, the admin overview and list. `allRows`/`tally`/
  `publicCampaign`/`publicPartnerCampaign` are gone. `cohort_counter` is now a
  sidecar for the publish-hysteresis flags only; no read path renders it.
- `GET /admin/campaigns/reconcile`: projects every campaign through the same
  forMember/forPartner, diffs the surface id sets, checks each household
  figure against three raw reads (claims, joined rows, stored counter), and
  scans both tables for rows naming a campaign the catalog no longer has.
  Named mismatch kinds: code_catalog, surface_count, counter_drift,
  legacy_rows, count_unreadable, orphan_claims, orphan_memberships. The admin
  console's Campaigns tab renders it on open as the "Drift check" card.
- Member dashboard: `CAMPS` boots empty; a skeleton paints until the first
  answer; `dropUnnamed()` runs on EVERY answer; a dev-host-only console
  warning fires for any card whose id the server did not name (DEVHOST =
  localhost, 127.0.0.1, *.vercel.app; never www). The choose gate now admits
  a member holding no seat (waitlist or alert standing), which was the
  "non-featured open cohorts unclickable" defect in its remaining state, and
  inert tiles no longer carry the hover lift.
- Partner console: planned rows say "Gathering · N on the list" for
  planned/waitlist kinds (`waitlist` is a new field) instead of reading
  interest as households. `campaignsSource` carried in state. Bundle rebuilt.
- Tests: scripts/test-multicampaign.mjs sections 9 (three members join by
  both doors; partner desk, brief, member list, seat ledger and drift check
  all answer 3 without waiting; ROSTER_FULL on the real count; memo
  invalidation; legacy rows and bells; a drifted counter reaches no partner
  but is named) and 10 (empty table: member and partner lists empty with
  source=code, admin still sees six to import, orphans named). Now in CI.
  qa-dashboard groups 6, 6a, 6c cover the empty state, the skeleton, and the
  widened gate. scripts/qa-sync.mjs loads both dashboards side by side at
  1280/940/768/390 from payloads generated by the real lib/cohorts.js
  projections and asserts the same region set and matching counts.

Decisions taken (user confirmed "yes" to the recommendation):
- seat_claim ∪ joined snapshot rows is the definition of a household in a
  cohort; seed baselines add to nothing anywhere.
- Cache-on-read with write invalidation, 60s bound, over poll or push.
- Seeds deleted outright, not flagged: the only placeholder path left is
  partner/demo (localhost only, not shipped) and it renders no member cards.
- The unclickable-cards defect fixed in the same pass.

Consequences to know:
- The admin list still shows `seed_members`/`seed_households` as the recorded
  configuration on the row. They feed no number. Consider dropping the
  columns from the admin create sheet in a later pass.
- A cohort's household figure on day one is its real count, which may be 0.
  That is the point.
- Deploy the Catalyst auth function BEFORE the frontend: the old frontend
  tolerates the new payloads (extra fields), but the new dashboard against
  an old function never receives `source` and only loses the dev warning.
