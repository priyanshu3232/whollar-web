# One cohort, end to end

> How to put a cohort into the `campaigns` table and drive it through the whole
> loop: visible on both dashboards, taking consumer joins, then taking sealed
> bids from a partner. Every step is either a ZCQL statement you paste into the
> Catalyst console or an action in a browser. Nothing here needs a deploy.
>
> Written 2026-08-14. Companion: `catalyst-backend/scripts/create-tables.md`
> (what each table must contain), `scripts/cohort.mjs` (generates and checks
> every statement below).

## The one thing to understand first

A cohort cannot take joins and bids at the same time, and that is deliberate.
`kind` is a single lifecycle column:

```
planned → waitlist → forming → auction → closed → archived
             joins open            bids open
```

`JOIN_STATUS` opens joining on `planned | waitlist | forming`. `requireBiddingOpen`
opens bidding on `auction` with `bidding_open = true`. Nothing is ever both,
because a sealed auction is run against a locked household count.

**So the order below is not a suggestion.** Collect the consumer joins first,
then move to auction. Moving early locks joining and there is no way to take a
join after it, short of moving the cohort back to `forming`.

## Which environment

The live site proxies to **Development** (`vercel.json`), not Production:

```
https://whollar-110003037934.development.catalystserverless.ca/server/auth/:path*
```

Catalyst console → project `whollar` → environment **Development** → Data Store
→ ZCQL. Editing Production changes nothing you can see.

---

# Phase 0: preflight

Every table below is created by hand and none of them announce their absence.
A missing table looks exactly like a quiet week: `catalog.js` falls back to the
code catalog, every other read answers `live: false` and renders an empty
state, and bid writes refuse with a message about availability.

Run these in ZCQL. **Each must return without an error.** Zero rows is fine; an
error means a table or column name is wrong.

```sql
-- the cohort itself
SELECT ROWID FROM campaigns LIMIT 1;
SELECT announce_at, bidding_opens_at, bidding_closes_at, offers_at,
       decision_at, switch_window_at, reconcile_at FROM campaigns LIMIT 1;

-- consumer joins land here. Without it every count is a seed.
SELECT ROWID FROM campaign_members LIMIT 1;

-- the global bidding kill switch
SELECT ROWID FROM site_config LIMIT 1;

-- partner identity and approval
SELECT org_id, approval_status FROM provider_orgs LIMIT 1;
SELECT user_id, org_id, role FROM provider_users LIMIT 1;

-- which desks a cohort reaches
SELECT coverage_key, org_id, region, status FROM provider_coverage LIMIT 1;

-- the sealed bid. Both of these must exist before any bid can be written.
SELECT bid_key, campaign_id, org_id, status FROM provider_bids LIMIT 1;
SELECT tiers, guarantee_months, revision_count, receipt_no, payload_hash
  FROM provider_bids LIMIT 1;
SELECT revision_key, bid_key, revision_no, payload, receipt_no,
       server_received_at FROM bid_revisions LIMIT 1;
```

Anything that errors: build it from `create-tables.md`. Sections 16 (campaigns,
site_config, provider_bids, provider_coverage) and 18 (bid_revisions plus the
fifteen columns) are the ones this loop depends on.

Reads degrade quietly, writes do not. You can do Phases 1 to 3 with the bid
tables missing; Phase 6 is where it stops.

---

# Phase 1: create the cohort

Generate the statement, and read what it says the two dashboards will do with
it before pasting:

```
node scripts/cohort.mjs new kitchener-central --region Kitchener --sub "Autumn cohort"
```

It prints an `INSERT INTO campaigns (...)` and a prediction of both surfaces.
Paste the INSERT into ZCQL.

Three choices worth making deliberately:

- **`--region` is not decoration.** It is what `provider_coverage` matches on in
  Phase 5. A cohort in a region no partner covers reaches nobody.
- **Seeds default to 0.** `seed_members` and `seed_households` are added to real
  joins on both surfaces, so a non-zero seed is padding a partner will
  eventually bid against. Leave them at 0 unless you are staging a demo.
- **The slug is permanent.** It is the id both dashboards key on and every
  `bid_key` is built from.

Leave the seven date columns null for now. That is the normal state of a new
cohort: stage falls back to `kind` alone, which is the pre-calendar behaviour.

## Verify

```sql
SELECT campaign_id, region, sub, kind, target, seed_members, seed_households,
       bidding_open, sort_order FROM campaigns;
```

`kind` must read exactly `forming`, lowercase. `catalog.fromRow` reads any
unrecognised value back as `planned` and says nothing.

---

# Phase 2: confirm it reached both dashboards

Wait up to 60 seconds. `catalog.load()` memoizes the table, and a hand-written
ZCQL statement cannot call `catalog.invalidate()` the way the admin routes do.

**Consumer.** Sign in as a member, open `/dashboard`, network tab:

```
GET /api/auth/campaigns
```

The cohort should be in `campaigns[]` with `"joinable": true`, `"kind":
"forming"`, `"stage": "forming"`, `"members": 0`. On the page it appears on the
"Campaigns near you" row, and as the "Open in your area" card if it sorts first
among joinable cohorts.

**Partner.** Sign in as a provider, open `/partner`:

```
GET /api/auth/provider/campaigns
```

Same cohort, `"bidding_open": false`, `"stage": "planned"`. It will not be on
the desk itself until Phase 5: `biddableCampaigns()` filters the desk to
regions where that org's coverage is `active`.

Check `"live"` on both. `live: false` means `campaign_members` was unreadable
and every count is a seed, which looks exactly like a cohort nobody has joined.

---

# Phase 3: take consumer joins

This is the phase that has to happen before Phase 6.

Signed in as a member on `/dashboard`, press **Choose this cohort** on the
cohort's card. That opens the six preference questions; saving them calls:

```
POST /api/auth/campaigns/join   { campaign: "kitchener-central" }
```

## Verify

```sql
SELECT membership_key, campaign_id, user_id, status FROM campaign_members;
```

One row per join, `status = 'joined'` for a forming cohort. `membership_key` is
`${campaign_id}:${user_id}`, the composite flattened because Catalyst's unique
constraint is per column.

The count on both dashboards is `seed_members + joins`, so with seeds at 0 the
number you see is the number of real households. Joining twice is one row, and
leaving before the cohort locks is allowed: forming cohorts are not binding.

Repeat with as many member accounts as you want households.

---

# Phase 4: make the partner able to bid at all

Four gates sit between a provider account and a bid, and they are checked in
this order. Three of them are normally an admin decision, and with no admin
console they are ZCQL.

**4a. The provider account and org.** Sign up at `/become-a-partner`, which
runs `POST /provider/signup` then `/provider/signup/verify` with an OTP. That
creates the user (`user_type = 'provider'`), the org, and the membership.

**4b. Approval.** Orgs are created `pending` and there is no code path that
self-approves: `orgs.js` computes `approved` in one place and fails closed on
anything that is not literally `approved`.

```sql
SELECT org_id, legal_name, approval_status FROM provider_orgs;

UPDATE provider_orgs SET approval_status = 'approved'
WHERE org_id = '<org_id>';
```

**4c. The seat role.** `addMember` writes `admin` for the first seat in an org
and `viewer` for everyone after, and no route promotes anyone. A `viewer` seat
can read the desk and not bid.

```sql
SELECT user_id, org_id, role FROM provider_users;

-- only if the seat you are testing with is a viewer
UPDATE provider_users SET role = 'admin' WHERE user_id = '<user_id>';
```

**4d. The global kill switch.** Absent is fine and defaults to on. If the row
exists and reads `false`, every bid on every cohort is refused within a minute.

```sql
SELECT config_key, value FROM site_config WHERE config_key = 'bidding_enabled';
```

---

# Phase 5: coverage, or the cohort reaches nobody

A `campaigns` row alone does not reach a partner desk. It reaches every partner
whose declared coverage matches the cohort's region and has verified, and
nobody else.

```
node scripts/cohort.mjs coverage <org_id> --region Kitchener
```

It prints both an INSERT and the UPDATE to use if the row already exists.
`coverage_key` is `${org_id}:${region-slug}`, truncated at 200.

The region string must equal the cohort's `region`. Both sides are slugged
before comparison, so `Chatham-Kent` and `chatham kent` match, but `Kitchener`
and `Kitchener-Waterloo` do not.

New coverage rows normally land `verifying` and are moved to `active` only by
`POST /admin/providers/:orgId/coverage/:region/verify`. Writing `active`
directly goes around that check. Fine for a test org. Not fine for a real one:
serviceability accuracy is what the figure beside a partner's bid is built
from.

## Verify

```sql
SELECT coverage_key, org_id, region, status FROM provider_coverage;
```

Then reload `/partner`. The cohort should now be on the desk, showing household
count and stage, with bidding still shut.

---

# Phase 6: open the auction

Joins lock the instant this lands, so do Phase 3 first.

```
node scripts/cohort.mjs move kitchener-central --from forming --to auction
node scripts/cohort.mjs bidding kitchener-central --on
```

Two statements, in that order, and they are separate on purpose: entering
auction never opens bidding implicitly. Staging an auction and opening the bid
window are two decisions.

## Optionally, a calendar

```
node scripts/cohort.mjs calendar kitchener-central --minutes 3
```

One UPDATE setting all seven dates a few minutes apart, so the cohort can be
watched through every member stage in half an hour instead of six weeks. The
rail advances on its own because the server restages on every read; nothing is
derived in the browser.

Keep `--minutes` at 2 or more. The catalog memoizes for 60 seconds, so a faster
calendar moves through stages the dashboard never gets to show.

**`bidding_closes_at` is the one with teeth.** Past it, `requireBiddingOpen`
refuses every bid regardless of `bidding_open`, which is what stops an auction
staying open past its own published deadline because nobody was at a keyboard.
Dates may close a window and may never open one.

## Verify

```sql
SELECT campaign_id, kind, bidding_open FROM campaigns
WHERE campaign_id = 'kitchener-central';
```

Consumer side: `GET /api/auth/campaigns` now reports `"joinable": false` and
`"stage": "bidding"`. The card stays on the row, read-only, and any member who
joined keeps their place and their stage rail.

Partner side: `GET /api/auth/provider/campaigns` reports `"bidding_open": true`.

---

# Phase 7: take a bid

On `/partner`, open the cohort's bid ticket and submit. Do not hand-roll the
body: `lib/bids.js` validates tiers, technologies, upload speeds, sticker and
effective prices, the guarantee term, the after-guarantee mode, equipment and
the commitment cap, and the console builds all of it.

```
POST /api/auth/provider/bids
```

The write order matters and is deliberate: `bid_revisions` is inserted **first**,
so a bid can never exist without its sealed record.

## Verify

```sql
SELECT revision_key, bid_key, revision_no, receipt_no, server_received_at
FROM bid_revisions;

SELECT bid_key, campaign_id, org_id, price, status, revision_count, receipt_no
FROM provider_bids;
```

One `bid_revisions` row per sealing, `revision_no` 1-based. One `provider_bids`
head row per `(campaign, org)`, `status = 'sealed'`, `price` the lowest tier's
effective price.

To revise, use **Improve** on the desk (`POST /provider/bids/:campaign/improve`).
Placing twice on one cohort is refused with a conflict.

**There is no withdraw path, and this is not an oversight.** No delete endpoint,
no admin backdoor, no code path anywhere that removes a bid record. The latest
revision at close is the binding one. If you are testing and want a clean slate,
use a different campaign id rather than looking for a way to delete rows.

---

# What to expect at each stage, without running anything

```
node scripts/cohort.mjs preview --kind forming
node scripts/cohort.mjs preview --kind auction --bidding-open
```

Prints what both dashboards will show for a given `kind` and flag. It calls the
same `memberStageOf` and `stageOf` the routes call, imported from
`lib/catalog.js`, so it is the running site's own answer and not a second
implementation of the rules.

# Everything to check at once

```
node scripts/cohort.mjs verify kitchener-central
```

Prints every SELECT above in one block, plus the two endpoints to open in a
browser.

# Common silences

| What you see | What it is |
|---|---|
| Cohort missing from both dashboards | The 60 second catalog memo. Wait, then hard refresh. |
| Cohort missing, and `kind` looks right | `kind` is not lowercase, or not one of the six. `fromRow` reads anything else as `planned`. |
| All six seeded regions vanished | The `campaigns` table went from empty to one row. An empty table falls back to the code catalog; a populated one is the truth. Add the rest or accept it. |
| Counts stuck, `live: false` | `campaign_members` is unreadable. Every count is a seed. |
| Cohort on the consumer side, absent from the desk | No `provider_coverage` row at `status = 'active'` for that region and org. |
| `bidding_open` true, every bid refused | `bidding_closes_at` has passed, or `site_config.bidding_enabled` is `false`. |
| "Bidding is not available right now" | `bid_revisions` or the fifteen `provider_bids` columns do not exist. |
| "Your organisation is still under review" | `provider_orgs.approval_status` is not literally `approved`. |
| "Your seat can view the desk but not place bids" | `provider_users.role` is `viewer`. |
