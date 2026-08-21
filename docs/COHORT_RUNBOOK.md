# One cohort, end to end

> Every command to take a cohort from nothing to awarded, with both dashboards
> live at each step. Written from an actual run on 2026-08-14 (Kitchener), so
> the gotchas below are the ones that were actually hit, not the ones that were
> imagined.
>
> `node` commands run in a terminal at the repo root. Everything they print
> goes into Catalyst console -> Data Store -> **ZCQL**, environment
> **Development**, which is what `vercel.json` proxies the live site to.
> Companions: `scripts/cohort.mjs`, `catalyst-backend/scripts/create-tables.md`.

> **Driving one cohort by hand, one UPDATE per stage**, is
> `node scripts/cohort.mjs step <id> --list`, and it is printed as a document in
> `docs/console/cohort-stage-ladder.pdf`. Nothing on that path is on a clock, so
> a bid window opened at one rung stays open until the next rung closes it.
>
> **Creating a cohort that is open to bid immediately**, with several live at
> once and the newest one featured, is a different shape and is its own section
> at the end: "Several cohorts at once, and the newest one featured".

## The two rules that set the whole order

**A cohort cannot take joins and bids at the same time.** `kind` is one column:

```
planned -> waitlist -> forming -> auction -> closed -> archived
             joins open              bids open
```

Joining is open on `planned | waitlist | forming`. Bidding is open on `auction`
with `bidding_open`. Nothing is ever both, because a sealed auction runs against
a locked household count. **Collect the joins first.** There is no join path
after the auction move.

**You cannot have a fast rail and a fillable bid window at once.** Two minutes
per stage is right for watching the member rail move and far too short to fill a
bid ticket. So the calendar is set twice: compressed for the front half, widened
while the partner bids, compressed again for the tail. Phases 6, 8 and 10.

---

## Phase 0: preflight

Run in ZCQL. Each must return **without an error**; zero rows is fine.

```sql
SELECT ROWID FROM campaigns LIMIT 1;
SELECT announce_at, bidding_opens_at, bidding_closes_at, offers_at,
       decision_at, switch_window_at, reconcile_at FROM campaigns LIMIT 1;
SELECT ROWID FROM campaign_members LIMIT 1;
SELECT ROWID FROM site_config LIMIT 1;
SELECT org_id, approval_status FROM provider_orgs LIMIT 1;
SELECT user_id, org_id, role FROM provider_users LIMIT 1;
SELECT coverage_key, org_id, region, status FROM provider_coverage LIMIT 1;
SELECT bid_key, campaign_id, org_id, status FROM provider_bids LIMIT 1;
SELECT tiers, guarantee_months, revision_count, receipt_no FROM provider_bids LIMIT 1;
SELECT revision_key, bid_key, revision_no, payload, receipt_no FROM bid_revisions LIMIT 1;
```

Anything that errors: build it from `create-tables.md`, sections 16 and 18.
Reads degrade silently, writes do not. Phases 1 to 5 work with the bid tables
missing; phase 9 is where it stops.

---

## Phase 1: create the cohort

```
node scripts/cohort.mjs new kitchener-central --region Kitchener --sub "Autumn cohort"
```

Paste the `INSERT`. Three things that matter:

- **`--region` is not decoration.** `provider_coverage` matches on it (phase 4).
- **Seeds default to 0.** They are added to real joins on both surfaces, so a
  non-zero seed is padding a partner eventually bids against.
- **The slug is permanent.** Both dashboards key on it; every `bid_key` is built
  from it. It never appears on screen: `region` and `sub` are what render.
- **`--kind` defaults to `forming`, which is the kind that takes joins.** Create
  a cohort you intend to collect households on as `forming`. A join taken while
  the cohort is `planned` or `waitlist` is written to `campaign_members.status`
  as `waitlist` and stays that way forever, because nothing rewrites that column
  on a transition. `catalog.standingOf` now reads such a row as `joined` once the
  cohort is past gathering, so this is no longer load-bearing, but the row will
  still say `waitlist` when you `SELECT` it in phase 3. The admin console's
  "New campaign" sheet defaults to `forming` for the same reason.

Leave the seven dates null. Stage falls back to `kind` alone, which is correct
for a cohort that has not been scheduled.

> **Duplicate key?** The row already exists. `SELECT` it and `UPDATE` the fields
> you wanted rather than inserting. Do not `DELETE`: there are no foreign keys,
> so any `campaign_members` row survives pointing at nothing.

---

## Phase 2: confirm both sides see it

Wait 60 seconds. `catalog.load()` memoizes the rows, and hand-written ZCQL
cannot call `catalog.invalidate()` the way the admin routes do.

- **Consumer:** `GET /api/auth/campaigns` -> `joinable: true`, `stage: forming`,
  `members: 0`. On the page it is on the "Campaigns near you" row.
- **Partner:** `GET /api/auth/provider/campaigns` -> same cohort,
  `bidding_open: false`, `stage: planned`. **Not on the desk yet**: that needs
  phase 4.

Check `live` on both. `live: false` means `campaign_members` was unreadable and
every count is a seed, which looks exactly like a cohort nobody joined.

---

## Phase 3: take the consumer joins

**Do this before phase 6.** On `/dashboard`, press **Choose this cohort**, answer
the six questions. That calls `POST /campaigns/join`.

```sql
SELECT membership_key, campaign_id, user_id, status FROM campaign_members
WHERE campaign_id = 'kitchener-central';
```

One row per household. `status` is `joined`, `waitlist` or `alert`; only `alert`
counts as watching rather than a household. `status` is what joining meant when
it was clicked, not the household's standing today: a `waitlist` row on a cohort
past gathering reaches the dashboard as `joined` (`catalog.standingOf`). What you
should never see on a cohort you are driving is a household whose only row is
`alert`, which is a bell and gets no cohort at all. Repeat with as many member accounts
as you want households.

---

## Phase 4: make the partner able to bid

Four gates, checked in this order. Three are normally admin decisions, and with
no admin console deployed they are ZCQL.

**4a. Account and org.** Sign up at `/become-a-partner`. That creates the user
(`user_type = 'provider'`), the org, and the membership.

**4b. Approval.** Orgs are created `pending`, and nothing self-approves.

```sql
SELECT org_id, legal_name, approval_status FROM provider_orgs;
UPDATE provider_orgs SET approval_status = 'approved' WHERE org_id = '<org_id>';
```

**4c. Seat role.** `addMember` writes `admin` for the first seat in an org and
`viewer` for everyone after, and no route promotes anyone. A `viewer` cannot bid.

```sql
SELECT user_id, org_id, role FROM provider_users;
UPDATE provider_users SET role = 'admin' WHERE user_id = '<user_id>';
```

**4d. Coverage, then verify it.** Coverage gates the bid, not the sighting: the
desk renders every cohort in the payload, and a region this org has not verified
renders the row locked rather than hiding it.

```
node scripts/cohort.mjs coverage <org_id> --region Kitchener
```

New coverage lands `verifying`, and the desk shows the cohort greyed with
**"Verifies with Kitchener coverage"**. Move it on, mirroring what
`POST /admin/providers/:orgId/coverage/:region/verify` does:

```sql
UPDATE provider_coverage
SET status = 'active', verified_at = '<now>', rejection_reason = '', updated_at = '<now>'
WHERE coverage_key = '<org_id>:kitchener';
```

If that errors on the last two columns they are not created yet; drop them and
set `status` alone, which is the same fallback the route takes. Optionally
record the decision:

```sql
INSERT INTO coverage_verifications (coverage_key, org_id, region, result, reason, checked_by, checked_at)
VALUES ('<org_id>:kitchener', '<org_id>', 'Kitchener', 'active', NULL, 'manual', '<now>');
```

**4e. The global switch.** Absent is fine and means on.

```sql
SELECT config_key, value FROM site_config WHERE config_key = 'bidding_enabled';
```

Reload `/partner`. The row should be un-greyed, still with no bid button.

---

## Phase 5: watch the front half of the rail

Set a compressed calendar so joining shuts and bidding opens within minutes:

```
node scripts/cohort.mjs calendar kitchener-central --minutes 2 --start 3
```

Paste it **immediately**: the first date is three minutes out.

---

## Phase 6: open the auction

**This locks the joins permanently.** Two statements, separate on purpose:
entering auction never opens bidding implicitly.

```sql
UPDATE campaigns SET kind = 'auction' WHERE campaign_id = 'kitchener-central';
UPDATE campaigns SET bidding_open = true WHERE campaign_id = 'kitchener-central';
```

> **If `bidding_open` reads false afterwards**, the bare `true` literal was not
> accepted. Try `'true'`, then `1`, then the row's checkbox in the Data Store UI.
> `isTruthyDb` accepts all of them on read.

Now watch `/dashboard`. It repolls every 15 seconds while a calendar fits inside
36 hours, so the rail moves on its own:

| | Consumer rail | Partner desk |
|---|---|---|
| start | Forming | Planned |
| +3 min | **Locked** | Announced |
| +5 min | **Bidding** | Closing, **Review and bid** appears |

---

## Phase 7: widen the window so a bid can actually be filled

Two minutes is not enough to fill a ticket. Push the close and **the whole
tail**: `stageOf` reads `decision_at` first, so leaving it at +9 minutes makes
the cohort read `Decided` however far out the close is.

```sql
UPDATE campaigns SET
  bidding_closes_at = '<+1 day>',
  offers_at         = '<+2 days>',
  decision_at       = '<+4 days>',
  switch_window_at  = '<+7 days>',
  reconcile_at      = '<+14 days>'
WHERE campaign_id = 'kitchener-central';
```

`announce_at` and `bidding_opens_at` stay as they are, so the transitions
already watched are preserved.

---

## Phase 8: place the bid

**Reload `/partner` first.** The console fetches campaigns once at boot and
never polls; the member dashboard is the only side that moves on its own.

Open the cohort's bid ticket and submit. Do not hand-roll the body: `lib/bids.js`
validates tiers, technologies, upload speeds, sticker and effective prices, the
guarantee term, equipment and the commitment cap, and the console builds it.

```sql
SELECT revision_key, bid_key, revision_no, receipt_no, server_received_at FROM bid_revisions;
SELECT bid_key, campaign_id, org_id, price, status, revision_count FROM provider_bids;
```

`bid_revisions` is written first, so a bid can never exist without its sealed
record. To change a bid use **Improve** on the desk; placing twice is refused.
**There is no withdraw path anywhere.** For a clean slate, use a new campaign id.

---

## Phase 9: close bidding and show the household its offer

```sql
UPDATE campaigns SET bidding_closes_at = '<3 minutes from now>' WHERE campaign_id = 'kitchener-central';
```

Or compress the whole tail again to watch Offers -> Confirm -> Switching -> Done:

```
node scripts/cohort.mjs calendar kitchener-central --minutes 2 --start 2
```

The moment `bidding_closes_at` passes, `GET /campaigns/:id/offer` unseals and the
dashboard shows the **real** bid: the price that was placed, the winning org's
legal name, and the true count. Before the close it reveals nothing at all, not
even how many bids exist.

---

## Phase 10: award it

No route writes this. The partner console renders `won` and `not_selected` pills
but nothing in the backend has ever produced them.

```sql
UPDATE provider_bids SET status = 'won', updated_at = '<now>'
WHERE bid_key = 'kitchener-central:<org_id>';

UPDATE provider_bids SET status = 'not_selected', updated_at = '<now>'
WHERE campaign_id = 'kitchener-central' AND status != 'won';

UPDATE campaigns SET kind = 'closed', bidding_open = false, updated_at = '<now>'
WHERE campaign_id = 'kitchener-central';
```

Reload `/partner`: the bid shows **Won**.

> **Known gap.** The member offer route picks the **lowest headline price**, not
> the bid marked `won`. Identical with one bidder. With several you could award
> the second-cheapest for better terms and the household would still be shown
> the cheapest. The award should be the source of truth and currently is not.

---

## Things that cost time on the real run

| Symptom | Cause |
|---|---|
| Cohort missing from both dashboards | The 60 second catalog memo. Wait. |
| Cohort missing, `kind` looks right | `kind` is not lowercase, or not one of the six. `fromRow` reads anything else as `planned` and says nothing. |
| All other regions vanished | The table went from empty to one row. An empty `campaigns` falls back to the code catalog; a populated one is the truth. |
| Counts stuck, `live: false` | `campaign_members` unreadable. Every count is a seed. |
| On the consumer side, absent from the desk | No `provider_coverage` row at `status = 'active'` for that region and org. |
| Desk row greyed, "Verifies with ... coverage" | Same. Phase 4d. |
| Desk row un-greyed but no bid button | Stage is not `open` or `closing`. `Announced` does **not** mean `kind = auction`: any non-auction cohort past `announce_at` reads `announced`. |
| Desk stale after a ZCQL write | The partner console does not poll. Reload it. |
| A boundary looks late | The tiles round to the minute; the real boundary carries seconds. `16:13` is `16:13:55`. |
| `bidding_open` true, every bid refused | `bidding_closes_at` has passed, or `site_config.bidding_enabled` is false. |
| "Bidding is not available right now" | `bid_revisions` or the fifteen `provider_bids` columns do not exist. |
| "Your organisation is still under review" | `approval_status` is not literally `approved`. |
| "Your seat can view the desk but not place bids" | `provider_users.role` is `viewer`. |
| A number on screen never changes | Check it is not a fixture. The countdown, the activity feed, the offer price and the provider count were all literals until 2026-08-14. `tplBidding`'s "3 providers at the table" still is. |

## Still fixtures on the member dashboard

`tplBidding` renders **"Bidding: 3 providers at the table"** with three masked
rows, on every cohort, whatever the real count. It cannot honestly show a count
at all while a window is sealed, so the number and the rows both have to go
rather than being wired up.

The activity feed is the other one. `FEEDS` in `dashboard.html` carries dated
lines per state, `[['Aug 4','Cohort opened for London East']]` and
`[['Sep 15','Bidding opened, bids sealed']]` among them, and they render on any
cohort. Same class of bug as the three below, and not yet fixed.

**Fixed on 2026-08-20**, all three the same mistake, a fixture that reads as
data on the screen whose only job is telling a household what to expect:

- The join dialog's button read **"Join London East · free"** as a literal,
  whichever card was pressed. The join itself always went to the right cohort,
  so the only wrong thing on screen was the sentence being consented to.
- The **date tiles** carried `Sep 12 / Sep 15 to 17 / Sep 24 / October` in the
  markup, and `paintDates` left any column the cohort had no date for alone. A
  cohort one rung into its ladder has one date, so a member saw one real
  deadline and four invented ones. Now `To come`.
- `tplLocked` read **"Bidding opens September 15"** in bold, on every cohort.
  Now the cohort's own `bidding_opens_at`, or "We'll text you the day bidding
  opens" when it has none, which is the normal state for a locked cohort whose
  window is not scheduled.

Groups 6h, 6i and 6j of `scripts/qa-dashboard.mjs` hold all three.

---

# Several cohorts at once, and the newest one featured

> The path above starts a cohort at `forming` and collects joins for days before
> anyone bids. This is the other shape: **a cohort that is open to bid the
> minute the row lands**, several of them live together, and the newest one
> featured on the member dashboard. One `INSERT` per cohort, and nothing already
> written has to move.
>
> Everything below is written with placeholders. Fill these five in once and the
> whole sequence follows.

| Placeholder | What it is | Rules that are not negotiable |
|---|---|---|
| `<ID>` | `campaign_id`, the slug | 3 to 64 characters of `a-z`, `0-9` and hyphen. **Permanent**: both dashboards key on it and every `bid_key` is built from it. Never rendered on screen. |
| `<REGION>` | the region name | Must be one of the 37 from `node scripts/cohort.mjs regions`. This is the entire join to a partner, matched by slug, server side. |
| `<REGION_SLUG>` | `<REGION>` lowercased, every run of non-alphanumerics turned into one hyphen | Only used to build `coverage_key`. `North York Central` gives `north-york-central`; `Maple and VMC` gives `maple-and-vmc`. |
| `<SORT>` | `sort_order` | **Lower is featured.** Start at 100 and count down one per cohort. |
| `<ORG_ID>` | the partner org that should see it | From `SELECT org_id, legal_name FROM provider_orgs;` |

`<DAYS>`, `<NOW>` and `<USER_ID>` appear once each and are named where they do.

## What "featured" is, exactly

There is no `featured` column and there should not be one. Two separate things
on `/dashboard` read as featured, and both fall out of `sort_order`:

1. **The hero panel and the `#cc-first` card** come from `featuredCamp()`
   (`dashboard.html`): the member's own cohort if they have joined one,
   otherwise the first **joinable** cohort, otherwise `CAMPS[0]`.
2. **The order of the four cards** in "Campaigns near you" comes from
   `ccRank()`: joined, then `forming`, then `auction`, then `planned`, then
   `waitlist`, with `sort_order` breaking ties inside each bucket.

`catalog.load()` sorts **ascending**, so the featured cohort is the one with the
**lowest `sort_order`**. Three consequences, and all three are load-bearing:

- **Newest featured means counting down.** Start a store at `<SORT>` = 100 and
  take one off per cohort. The new row sorts below every existing one without a
  single `UPDATE`, and the cohort that was featured shifts to position 1. The
  alternative, renumbering the rows already there, is one `UPDATE` per cohort,
  and the one you miss is the one that stays featured.
- **Kind outranks recency.** A `forming` cohort sits above every `auction` one
  whatever its `sort_order`, because `ccRank` buckets by `kind` first. So
  "newest is featured" holds only across cohorts of the **same kind**. Mixed
  kinds are ordered by lifecycle, deliberately: a household reads what it can
  join before what it cannot.
- **A member who has joined a cohort always sees their own as featured.** That
  is `featuredCamp()`'s first line and it is not a bug to route around.

> **An `auction` cohort is not joinable, so the featured card carries no join
> CTA.** Its badge reads "Sealed bidding" and the whole-card button is not
> rendered. `kind` is one column: joins are open on `planned | waitlist |
> forming`, bids on `auction`, and nothing is ever both. If the featured card
> has to be joinable, create at `forming` and open bidding later, which is
> phases 1 to 6 above.

## Step 1: preflight, once per environment

ZCQL. Each must return **without an error**; zero rows is fine.

```sql
SELECT ROWID FROM campaigns LIMIT 1;
SELECT announce_at, bidding_opens_at, bidding_closes_at, offers_at,
       decision_at, switch_window_at, reconcile_at FROM campaigns LIMIT 1;
SELECT ROWID FROM campaign_members LIMIT 1;
SELECT coverage_key, org_id, region, status FROM provider_coverage LIMIT 1;
SELECT acceptance_key, org_id, doc_type, doc_version FROM provider_terms LIMIT 1;
```

`campaigns` and `campaign_members` missing is silent: every read falls back to
the six-region code catalog and seed counts. `provider_terms` missing is **not**
silent and is not a degradation: `lib/terms.js` fails closed, so every bid is
refused until the table exists (`create-tables.md` section 20).

An existence check that needs no console:

```
cd catalyst-backend && catalyst ds:export --table campaigns --page 1
```

## Step 2: name it, and check the name can be bid on

```
node scripts/cohort.mjs regions
```

`<REGION>` must be in that list. `<ID>` is normally its slug, but it does not
have to be: `region` is what renders and what coverage matches, `<ID>` is only
the key. A cohort named for a place no partner can declare renders on both
dashboards, takes joins, runs its clock down, and takes no bids, with nothing
logged anywhere.

## Step 3: one statement, both dashboards, open to bid

```
node scripts/cohort.mjs seed <ID> --regions "<REGION>" --first <DAYS> --sort <SORT>
```

`--regions` may be omitted when `<ID>` title-cases into `<REGION>` exactly. The
tool refuses any name that is not declarable, which is the check ZCQL cannot do
for you.

Paste the one `INSERT` it prints. It carries `kind = 'auction'`,
`bidding_open = true` and all seven calendar dates, so the row is live on both
surfaces as soon as the memo expires:

```sql
INSERT INTO campaigns (campaign_id, region, kind, seed_members, seed_households,
  bidding_open, sort_order, updated_by, updated_at, announce_at, bidding_opens_at,
  bidding_closes_at, offers_at, decision_at, switch_window_at, reconcile_at)
VALUES ('<ID>', '<REGION>', 'auction', 0, 0, true, <SORT>,
  'manual', '<NOW>', '<close -10d>', '<close -7d>', '<close>', '<close +2d>',
  '<close +9d>', '<close +12d>', '<close +26d>');
```

`<DAYS>` is days to the bid close, and it is what decides `bidding_open`: the
tool writes `true` only when `bidding_opens_at` is already behind and the close
is still ahead. `<DAYS>` of 1 to 6 opens the window now; 8 writes `false` and the
desk reads **Announced**, not open.

Then, one minute later:

| | Consumer, `GET /api/auth/campaigns` | Partner, `GET /api/auth/provider/campaigns` |
|---|---|---|
| shows up | "Campaigns near you", badge **Sealed bidding** | on **every** approved partner's desk; biddable only where coverage is active |
| stage | `bidding` | `open`, or `closing` inside the last 24h |
| joinable | `false` | n/a |
| bid window | n/a | `bidding_open: true` |

Nothing else has to be written for the consumer side. **The partner side needs
steps 4 and 5**, and until then the cohort is on no desk at all.

## Step 3b: the same thing on a test rail, in minutes

For a test case rather than a launch, `--minutes` replaces `--first` and dates
the whole batch from now:

```
node scripts/cohort.mjs seed <ID> --minutes 5 --sort <SORT>
```

The schedule is fixed in multiples of the interval, and **two dates are
deliberately behind**:

```
announce_at        -2 intervals   joining already shut
bidding_opens_at   -1 interval    the window is already open
bidding_closes_at  +1 interval    <- the bid window is TWO intervals wide
offers_at          +2
decision_at        +3
switch_window_at   +4
reconcile_at       +5             the whole rail ends here
```

That is what makes the row biddable the moment it lands. `bidAction()` in
`partner/views/desk.js` draws **Review and bid** only at stage `open` or
`closing`, and `stageOf` only reaches those once `bidding_opens_at` has passed,
so a rail that starts in the future writes `bidding_open = true` and still shows
a locked row. The tool prints the minute each date falls on and
`scripts/test-cohort.mjs` asserts the derived stage is one the desk will draw a
button on.

- **2 is the floor.** `catalog.load()` memoizes for 60 seconds, so `--minutes 1`
  is refused rather than accepted and quietly unwatchable.
- **5 leaves ten minutes to fill a ticket, 10 leaves twenty.** The window is two
  intervals wide for exactly this reason.
- **Every cohort in the batch runs the same rail.** Staggering them would put
  each in a different stage, and the reason to seed several at once is to look
  at a row of cards.
- **The member rail only self-advances for a member who joined that cohort**
  (`nextPollDelay` in `dashboard.html`: 15 seconds while the calendar spans
  under 36 hours, 120 seconds otherwise). An auction cannot be joined, so a
  full-rail test means creating at `forming`, joining, then moving to auction.
- **The partner console never polls.** Reload it after each write.

`--minutes` and `--first` cannot be combined: the tool refuses rather than
ignoring one of them.

## Step 4: coverage, or the cohort reaches nobody's bid ticket

**Coverage gates bidding, not visibility.** `views/desk.js` renders every
campaign in the payload: `planned` and `announced` under "Coming cohorts", the
rest under "Open auctions". What coverage decides is the row's action cell. With
`status = 'active'` for that region the row draws the bid button; without it the
row still renders, locked, tagged **"Verifies with &lt;REGION&gt; coverage"**.
`biddableCampaigns()` in `partner/core/state.js` is the actual coverage filter
and only the My bids ticket list calls it, while `requireActiveCoverage()` is
what refuses the write. One coverage row per org per region.

```sql
SELECT org_id, legal_name, approval_status FROM provider_orgs;
```

```
node scripts/cohort.mjs coverage <ORG_ID> --region "<REGION>"
```

That prints the `INSERT`, and the `UPDATE` to use instead when the row exists.
New coverage normally lands `verifying`, which greys the desk row with
"Verifies with `<REGION>` coverage". Move it on:

```sql
UPDATE provider_coverage
SET status = 'active', verified_at = '<NOW>', rejection_reason = '', updated_at = '<NOW>'
WHERE coverage_key = '<ORG_ID>:<REGION_SLUG>';
```

If that errors on the last two columns they are not created yet; drop them and
set `status` alone, which is the same fallback the admin route takes.

## Step 5: the three gates on the bid itself

Only if a partner is meant to actually bid, not just see the cohort.
`<USER_ID>` is the seat that will place it.

```sql
UPDATE provider_orgs  SET approval_status = 'approved' WHERE org_id  = '<ORG_ID>';
UPDATE provider_users SET role = 'admin'              WHERE user_id = '<USER_ID>';
SELECT config_key, value FROM site_config WHERE config_key = 'bidding_enabled';
```

`bidding_enabled` absent is fine and means on. The standard cohort terms are
accepted by the partner in the console (`POST /provider/contracts/terms/accept`),
so `provider_terms` needs to exist but needs no row written by hand.

## Step 6: every cohort after the first takes a lower `<SORT>`

Call the one already in the table `<ID_A>` at `<SORT_A>`, and the new one
`<ID_B>`. Then `<SORT_B>` = `<SORT_A>` - 1:

```
node scripts/cohort.mjs seed <ID_B> --regions "<REGION_B>" --first <DAYS> --sort <SORT_B>
```

```sql
INSERT INTO campaigns (...) VALUES ('<ID_B>', '<REGION_B>', 'auction', 0, 0,
  true, <SORT_B>, ...);
```

`<ID_B>` sorts below `<ID_A>`, so it is featured and `<ID_A>` shifts to position
1. Both stay live, both stay open to bid, and the `<ID_A>` row is not touched.
Repeat, one lower each time. Then step 4 again for `<REGION_B>`: coverage is per
region, so a partner covering `<REGION_A>` sees `<REGION_B>`'s row locked rather
than biddable.

To hand the featured slot back to `<ID_A>`, move the newer one **below** it
rather than moving the older one up, so only one row is ever rewritten:

```sql
UPDATE campaigns SET sort_order = <SORT_A + 1> WHERE campaign_id = '<ID_B>';
```

## Step 7: verify what both sides will read

```
node scripts/cohort.mjs verify <ID>
```

```sql
SELECT campaign_id, region, kind, bidding_open, sort_order FROM campaigns;
SELECT campaign_id, announce_at, bidding_opens_at, bidding_closes_at,
       offers_at, decision_at, switch_window_at, reconcile_at FROM campaigns;
SELECT org_id, region, status FROM provider_coverage;
```

`sort_order` ascending in that first result **is** the card order on
`/dashboard`, inside each `kind` bucket. Groups 6f and 6g of
`scripts/qa-dashboard.mjs` assert both halves of that in a browser: an
all-auction catalog features the newest cohort, and one `forming` cohort takes
the slot back whatever its number. Then in a browser, signed in on each
side: `GET /api/auth/campaigns` and `GET /api/auth/provider/campaigns`. Check
`live` on both; `live: false` means `campaign_members` was unreadable and every
count is a seed, which looks exactly like a cohort nobody joined.

## What bites on this path

| Symptom | Cause |
|---|---|
| The new cohort is not featured | Another cohort's `kind` outranks it. `ccRank` buckets by `kind` before it reads `sort_order`. |
| The new cohort is not featured, all are `auction` | Its `sort_order` is not the lowest, or the 60 second memo has not expired. |
| Featured card has no join button | It is an `auction`. Auctions are never joinable, by design. |
| Featured card is not the newest, for one member | They have joined a cohort. Theirs is always featured. |
| Every other region vanished | The table went from empty to one row. An empty `campaigns` falls back to the code catalog; a populated one is the truth, so seed every region you want visible. |
| A cohort on a desk in a region that partner never declared | Expected. The desk is not coverage filtered; the row renders locked with "Verifies with ... coverage". Coverage gates the bid, not the sighting. |
| Desk reads **Announced**, no bid button | `bidding_opens_at` is still ahead, so the tool wrote `bidding_open = false`. Use a smaller `<DAYS>`, or `node scripts/cohort.mjs bidding <ID> --on`. |
| Desk stale after a ZCQL write | The partner console fetches once at boot. Reload it. |
| `kind` looks right, cohort still missing | `kind` is not lowercase. `fromRow` reads anything outside the six as `planned` and says nothing. |
