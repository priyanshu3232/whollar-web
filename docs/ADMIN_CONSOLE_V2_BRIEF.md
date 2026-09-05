# Admin console v2: context brief

> Paste this (or point at this file) when starting the design and functionality
> pass on the admin console. Written 2026-08-31 against the code as it stands.
> Companions: `docs/ADMIN_PORTAL_PLAN.md` (the 2026-07-30 architecture),
> `docs/ADMIN_DESIGN_GUIDELINES.md` (tokens, type, components),
> `docs/ADMIN_CONSOLE_RUNBOOK.md` (go-live steps), `admin-console/README.md`.

---

## 0. Read this first: it is not a greenfield build

An admin console already exists and is deployed as its own Vercel project at
`admin.whollar.ca`:

- Frontend: `admin-console/index.html`, one static file, ~1100 lines, inline
  classic script, seven tabs (Overview, Site config, Campaigns, Providers,
  Leads, Deep reads, Audit).
- Backend: `catalyst-backend/functions/auth/src/routes/admin.js`, ~1725 lines,
  26 endpoints, mounted only when `cfg.FEATURES.admin` is on (no config group,
  no route, a plain 404).
- Identity: `users.user_type = 'admin'`, minted by `ADMIN_EMAIL_DOMAIN`
  (@whollar.com) or an `ADMIN_EMAILS` entry, 6-digit OTP, 12-hour non-rolling
  session. There is no signup path to admin.

**Two of your three asks already have working backends and one has no UI at all.**
The job is a redesign and an extension, not a new console. Anything that starts
from a blank page will duplicate 26 endpoints and lose the audit trail.

State the plan against this baseline before writing code.

---

## 1. Ask one: moving a campaign's stage

### What "stage" actually is here: two levers, not one

This is the single thing most likely to be designed wrong.

**Lever A, `campaigns.kind`.** Six values, owned by staff, moved by
`POST /admin/campaigns/:id/transition`:

```
planned, waitlist, forming, auction, closed, archived
```

Legal moves (`lib/catalog.js` TRANSITIONS, enforced server side, a 409 otherwise):

```
planned  -> waitlist, forming, archived
waitlist -> forming, planned, archived
forming  -> auction, waitlist, archived
auction  -> closed, forming
closed   -> archived, auction
archived -> closed
```

Two rules ride on the transition and must be visible in the UI:
- Moving into a household-facing kind asserts the cohort has FSAs
  (`assertScoped`). A cohort opened with an empty FSA set is a cohort no
  partner can bid on, so the call refuses. Show the FSA set on the screen.
- Leaving `auction` always sets `bidding_open = false`. Entering `auction`
  never opens bidding: that is its own deliberate act
  (`POST /admin/bidding` globally, `PUT /admin/campaigns/:id` per campaign).

**Lever B, the calendar.** Seven date columns, in order:

```
announce_at, bidding_opens_at, bidding_closes_at, offers_at,
decision_at, switch_window_at, reconcile_at
```

The server derives two audience-facing stages from those dates plus `kind`
(`catalog.stageOf` and `catalog.memberStageOf`, both pure functions of
(campaign, now), never memoized, never computed in a browser):

| Audience | Stages |
|---|---|
| Partner | planned, announced, open, closing, offers_out, decided |
| Member | forming, locked, bidding, offers, confirm, switching, done |

`kind` outranks the calendar in both directions: a `closed` or `archived`
campaign reads `decided` whatever the dates say, and a non-`auction` campaign
is never in an auction stage.

### The design consequence

A screen with one "stage" dropdown lies to the operator. The campaign screen has
to answer four questions at a glance:

1. What kind is it, and which moves are legal from here (the illegal ones
   shown as unavailable, not hidden, with the reason).
2. What is the partner seeing right now, and what is the household seeing right
   now, as two separate labelled readings.
3. What is the next automatic move, and when (`nextTransition`), so the operator
   can tell "this cohort will open by itself on Tuesday" from "this cohort is
   waiting on me".
4. What the seat counts are and whether they are live (`lib/cohorts.js` is the
   one read layer; `source: 'code'` means the campaigns table is empty and
   members are seeing nothing).

Editing the seven dates is a first-class act on this screen, not a modal
afterthought: it is the lever that actually moves both audiences. Today it is a
secondary sheet with seven `datetime-local` inputs and no preview of the effect.

Design the calendar editor so that changing a date shows, before saving, what
each audience's stage becomes. Also design the "what breaks" warnings: moving
`bidding_closes_at` into the past on a live auction, opening bidding on a cohort
with no verified coverage in its region, archiving a cohort with confirmed
households.

### Existing endpoints for this ask

```
GET  /admin/campaigns                     list, with counts and source
POST /admin/campaigns                     create
PUT  /admin/campaigns/:id                 edit fields, dates, bidding_open
POST /admin/campaigns/:id/transition      { to } move the kind
GET  /admin/campaigns/:id/coverage        the cohort's FSA scope
GET  /admin/campaigns/:id/bids            sealed bids, staff eyes only, one cohort
GET  /admin/campaigns/reconcile           drift check across the count surfaces
POST /admin/campaigns/notices/sweep       stage notices
POST /admin/campaigns/import-defaults     one-time seed of the code catalog
POST /admin/bidding                       the global kill switch
```

Missing and worth designing for: no admin view of the sealed result. The price
book and awards are sealed lazily, on the first partner read after close
(`awards.sealFromCampaign`, called from `routes/delivery.js`), so today an
operator cannot see who won what tier until a partner logs in. See section 4.

---

## 2. Ask two: approving an account

### What exists

`provider_orgs.approval_status` is `pending | approved | rejected`.
`routes/provider.js` states the invariant in its header: **no code path there
can set it to `approved`**. `POST /admin/providers/:orgId/approve` is the only
write of that value in the system. That is the design point of the whole
console, and the UI should carry the weight of it.

```
GET  /admin/providers?status=            queue, pending first
GET  /admin/providers/:orgId             the review: org + people + applications
POST /admin/providers/:orgId/approve     the only write of 'approved'
POST /admin/providers/:orgId/reject      reason required, 3 to 255 chars
POST /admin/providers/:orgId/suspend     approved -> pending, no email
POST /admin/orgs/merge                   duplicate-org repair
```

Approve and reject both mail every active person at the org through the outbox
(`partner.account.decision`), keyed on `provider.decision:<org>:<outcome>` so a
second click does not send a second letter. Suspend deliberately sends nothing.

### What the review screen is missing

`GET /admin/providers/:orgId` returns the org, its people, and the
`PartnerApplications` rows matched by email domain. It does **not** return:

- **The uploaded documents.** The partner application takes documents into the
  File Store (`routes/application.js`, folder `partner_documents`). The reviewer
  approving a company cannot see the letter of authorisation they are approving.
  This is the largest hole in the current flow.
- **The declared coverage.** See ask three: it is the same review, split across
  two screens that do not know about each other.
- **Terms acceptance** (`provider_terms`), so "have they signed" is invisible.
- **The application timeline** (`GET /provider/application/timeline` exists for
  the partner's own view; staff have no equivalent).

So: approve is currently one button with no checklist behind it. Design the
review as a decision surface, where every item a human is supposed to have
checked is on the page with its state, and the approve button is enabled against
a visible checklist rather than always live.

---

## 3. Ask three: verifying coverage

### This is the ask with a backend and no UI at all

The word "coverage" appears exactly once in `admin-console/index.html`, and it is
in a tooltip about bidding. The endpoints have existed unused.

How it works:

- A partner declares regions on `POST /provider/coverage`. Each row lands in
  `provider_coverage` with `coverage_key = "<org_id>:<region-slug>"` and
  `status = 'verifying'`.
- `requireActiveCoverage` in `routes/desk.js` refuses a bid unless that row is
  `status = 'active'`. **Coverage verification is the throttle on bidding.** An
  approved partner with unverified coverage can do nothing.
- Staff decide per region:

```
POST /admin/providers/:orgId/coverage/:region/verify   -> status 'active'
POST /admin/providers/:orgId/coverage/:region/reject   -> status 'rejected'
```

- A refusal needs one of four reason codes, and the partner is shown the
  sentence, and it feeds their serviceability figure:
  `no_facilities`, `outside_footprint`, `tech_unsupported`, `needs_evidence`.
- Every decision writes a `coverage_verifications` row **before** the status
  moves, deliberately: a failed update leaves the region verifiable again, and
  the reverse order would put a region live with no record of who did it.
- Verifying clears any previous `rejection_reason`.

### The design consequence

The work is per (org, region), not per org, so the natural surface is a **queue
across every organisation**, sorted by wait time, not a tab buried inside one
company's review. A partner who declares six regions is six decisions.

Each row needs the evidence to decide on the row: the declared techs, speed and
lead time (`provider_coverage` carries `techs`, `speed`, `lead`), the org's
approval status, whether any live cohort is in that region and whether it is in
auction (a region with an open auction is the urgent one), and the history from
`coverage_verifications` if this region has been refused before.

**Backend gap to write into the plan:** there is no read endpoint for this.
`GET /admin/providers/:orgId` carries no coverage, and there is no cross-org
listing. The design needs `GET /admin/coverage?status=verifying` (plus coverage
on the single-org review payload). Say this explicitly in the plan; do not design
a queue and leave the read undefined.

---

## 4. The "maybe more": candidates, each with evidence

Do not invent features. These are queues that exist in the data model today with
no staff surface, which is the same shape of hole as ask three:

1. **Brand requests.** `POST /provider/brand-request` writes `brand_requests`
   with `status: 'pending_review'` and the partner console shows "Awaiting
   verification". There is no admin route to review one. A partner's roster is
   blocked until someone acts, and no one can. Strongest candidate for a fourth
   function: it is the identical verify/reject pattern as coverage.

2. **Billing disputes.** `POST /provider/orders/:key/dispute` sets
   `provider_orders.dispute_state = 'open'` with a note, and mails the billing
   contacts. Nothing resolves it. A money-adjacent open state with no closer.

3. **Notifications.** Admin endpoints already exist with zero UI:
   `GET /admin/notify/outbox`, `/outbox/:key`, `/suppressions`,
   `POST /admin/notify/suppressions/lift`, `/drain`, `/tick`. The scheduled job
   is still owed, so `/tick` is currently the manual pump. A small screen turns
   "did the household get the offer email" into a lookup instead of a ZCQL query.

4. **Auction result.** No admin view of `campaign_awards` or
   `campaign_price_books`. Combined with the lazy sealing noted in section 1,
   the operator running the auction cannot see its outcome. Consider a "seal
   now" action on the campaign screen so the result exists at close rather than
   at the first partner read.

5. **Household lookup.** There is no way to open one household and see its
   cohort, bill, offer, order and messages. Every support question ("where is my
   install", "why did my offer change") is currently a database query. The Leads
   tab reads intake tables, which is not the same thing.

6. **System health.** `GET /health/diagnostics` verifies the live tables and
   columns against `lib/schema.js`. Several column checks are owed per the
   runbooks. A read-only health tab turns that into a screen an operator checks
   before a launch, instead of a curl.

Recommend a ranking in the plan. My order: coverage queue (asked for), brand
requests, notifications, auction result, disputes, health, household lookup.

---

## 5. Design system: use the existing one

`docs/ADMIN_DESIGN_GUIDELINES.md` is the full brief. The essentials:

- The admin console follows the **member canon**: Satoshi display font, Inter
  body, Space Mono for figures and ids. Not the partner console's Bricolage and
  gold.
- Palette is the shipped `:root`: `--accent:#1E9E63` on `--mint:#E4F4EC` for
  approve, live, confirm. `--terra-text:#A34F2B` on `--terra-soft:#F7E7DD` for
  reject, suspend, paused, anything at stake. `--sub` on `--mist` for pending
  and neutral. `--teal:#0E2A20` dark tiles for staff-only chrome.
- **Never introduce a blue or red alert palette.** Urgency is terra, success is
  green, neutral is mist. That triad is the whole signalling system of the site.
- Body copy at 11 to 13px uses `--ink`, `--sub` or `#5F6B64`, never `#8A968F`.
- `:focus-visible{outline:2.5px solid var(--accent);outline-offset:2px;border-radius:8px}`
  on everything interactive, and the reduced-motion block verbatim.
- Existing components to keep and extend rather than replace: the confirm sheet
  with a required reason textarea, the pending badge on the nav, the toast, the
  loading and error boxes, the day-grouped audit list.

Copy tone: the existing console writes in sentences ("Keep things as they are"
rather than "Cancel"). Match it.

---

## 6. Constraints that will bite

- **No em dashes anywhere.** Copy, code, comments. Commas or colons.
- **No ESM in any browser-loaded file.** `admin-console/index.html` is a classic
  inline script and stays one. The `partner/` build exception covers `partner/`
  and nothing else. If v2 outgrows a single file, that is an owner decision to
  raise, not a thing to assume; the fallback that stays inside the rules is
  several classic scripts loaded in order.
- **CSP.** `admin-console/vercel.json` sets `script-src 'self' 'unsafe-inline'`
  with no `'unsafe-eval'`, and `connect-src 'self'`. No CDN libraries, no
  template compilation, no third-party calls.
- **CSRF is an Origin allowlist**, not a token header: a custom header would
  trigger a preflight the Catalyst gateway answers itself. Keep requests simple
  and same-origin, `credentials: 'same-origin'`.
- **Every staff action writes an audit row** through `audit.record` with an
  `admin.*` type and a `detail` carrying before and after. A new action without
  an audit row is a bug, not an omission. The Audit tab is how the console is
  reviewed.
- **No partner sees another partner's bid, count or reference**, in any response
  including errors. The sealed-bid review is staff-only and scoped hard to one
  campaign in the path. Nothing built here may widen a partner-facing payload.
- **Server owns stage.** Client countdowns offset from the `serverTime` captured
  at fetch, never from a bare `Date.now()`.
- **Terminology, in code as well as copy**: founding partner, partner,
  household, member, cohort, sealed bid, intimation, FSA. Never client,
  customer, lead, prospect, group, pool.
  **The current console has a "Leads" tab.** It violates this rule and should be
  renamed in v2 (the tables keep their shipped names; the surface should not say
  it). Call it Intake, or name the tables.
- **`lib/cohorts.js` is the one read layer** for campaign state and seat counts.
  No seed array, fixture or fallback catalog in any render path.

---

## 7. Housekeeping the plan should pick up

Small, real, and cheap while the console is open:

- `admin-console/vercel.json` still rewrites to the **development** Catalyst
  domain. Whatever is built is tested against Development data, and the swap is
  a go-live step.
- `admin-console/` is **not** in `.vercelignore`, so the main site's
  `cleanUrls: true` publishes the page at `www.whollar.ca/admin-console` as well.
  It carries no data and the server re-checks every call, so it is not a leak,
  but it is a second copy on the wrong host. Add the line or confirm it is
  deliberate.
- `admin-console/index.html` is in no CI gate: not in
  `scripts/check-inline-scripts.mjs`, no `node --check` step. A syntax error
  ships. Register it.
- This file names internal tables and open gaps, and `docs/` is deployed, so it
  is listed in `.vercelignore` like `docs/DELIVERY_AUDIT.md`.

---

## 8. What to deliver in this pass

Design and functionality only. No backend code yet.

1. **Screen inventory**: every tab in v2, what it is for, what it opens onto.
2. **Per screen**: the states (empty, loading, error, table-missing, no
   permission), the data each one reads, the actions each one offers, and the
   confirmation each destructive action requires.
3. **The three flows end to end**, as annotated wireframes or a static clickable
   prototype in the admin palette: move a campaign's stage (both levers), review
   and approve an organisation, work the coverage queue.
4. **The backend delta**: an explicit list of endpoints owed (the coverage reads
   at minimum), payload fields owed on existing endpoints, and any table or
   column that has to exist first. Column ladders matter here: a projection
   without a fallback empties a whole surface in production, so say per runbook
   section whether console work lands first.
5. **Open decisions for the owner**, with a recommendation each, at least:
   - Does v2 stay one HTML file, or split (and if split, how, given the no-ESM rule)?
   - Is there a mobile surface? The README says deliberately none, but approving
     a partner from a phone is a plausible need.
   - Do all admins have all powers, or does approving and verifying want a
     second pair of eyes?
   - Which of section 4 is in scope now, and which is named and deferred?
