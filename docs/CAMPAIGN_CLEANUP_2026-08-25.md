# Campaign table cleanup: close and archive everything, 2026-08-25

## What this is, and what I could not do

Every card in the two lists you pasted came from the **server**. There is no seed
array, fixture or fallback catalog in the member render path any more, and
`lib/cohorts.js` returns an empty list rather than the code catalog on a
non-admin surface (`source:'code'` -> `states: []`). So there are **no dummy
cards in the UI sense**: all 16 are real rows in the live `campaigns` table.
What several of them are is *test rows left behind by QA seeding*, which is a
different problem and the one this document closes.

I could not read or write the table from here:

- there is no write path from a laptop to the Data Store (same reason every
  schema change in this repo is a document, not a migration), and
- reaching `GET /admin/campaigns` needs an admin session, which needs an
  emailed OTP.

So the state below is **decoded from the card badges**, which is exact for
`kind`, and the statements are generated to match `scripts/cohort.mjs` literal
for literal. Run the enumeration SELECT first: it is the only thing that gives
you the `campaign_id` slugs, which the badges cannot.

## How the badges decode

From `dashboard.html` `CCBADGE` and `ccCard()`:

| Badge on the card | What it proves about `kind` |
| --- | --- |
| `Your cohort · Bidding` | the member's own row, past `bidding_opens_at` |
| `Sealed bidding` | `auction`, exactly |
| `You hold another seat · Move here` | `joinable` -> `forming` \| `waitlist` \| `planned` |
| `Offers out` | `closed` |
| `Closed` | `archived` |

`Offers out` and `Closed` appear on **no card in your list**. That is the
answer to "how many are active": all of them.

## Inventory: 16 rows, 16 active, 0 closed, 0 archived

Second line is `sub`, plus `closes <date>` where the row carries `announce_at`
(`ccSub()`), so a bare `closes Aug 19` means the row has **no** `sub`.

| # | Region | Second line | Badge | `kind` |
| --- | --- | --- | --- | --- |
| 1 | Scarborough Southwest | First cohort | Your cohort · Bidding | auction (your seat) |
| 2 | Etobicoke | Etobicoke Centre | Move here | joinable |
| 3 | Scarborough Southwest | First cohort | Move here | joinable |
| 4 | Vaughan | Winter cohort · closes Aug 24 | Move here | joinable |
| 5 | Kleinburg | Autumn cohort | Sealed bidding | auction |
| 6 | North York Central | Main cohort | Sealed bidding | auction |
| 7 | The Annex | *(none)* | Sealed bidding | auction |
| 8 | Mississauga City Centre | *(none)* | Sealed bidding | auction |
| 9 | Etobicoke North | Winter cohort | Sealed bidding | auction |
| 10 | Vaughan Woodbridge | Winter cohort | Sealed bidding | auction |
| 11 | Etobicoke | Etobicoke Central | Sealed bidding | auction |
| 12 | North York Central | closes Aug 19 | Move here | joinable |
| 13 | North York Central | North York Central | Move here | joinable |
| 14 | London South | Winter cohort | Move here | joinable |
| 15 | Scarborough Centre | Winter cohort | Move here | joinable |
| 16 | North York East | *(none)* | Move here | joinable |

**8 at `auction`** (1, 5, 6, 7, 8, 9, 10, 11) and **8 joinable** (2, 3, 4, 12,
13, 14, 15, 16). Nothing is at `closed` or `archived`, so every one of the 16
needs a move.

## Duplicates

Five clusters. Two of them are actively harmful, not cosmetic.

1. **Scarborough Southwest / First cohort, twice (1 and 3).** Same region, same
   `sub`, different `kind`: you hold a seat in one and the other is offered to
   you as a move. A household cannot tell them apart on the card, and pressing
   the twin opens the seat-conflict sheet to move out of a cohort into its own
   identical copy. Worst row in the set.
2. **North York Central, three times (6, 12, 13).** One at auction with
   `sub = Main cohort`, one joinable with no `sub` and a past `announce_at`,
   one joinable whose `sub` echoes the region name. A partner with North York
   Central coverage sees one biddable cohort and two more gathering in the same
   territory.
3. **Etobicoke, twice (2 and 11),** distinguished only by `sub`:
   `Etobicoke Centre` and `Etobicoke Central`. Row 2's `sub` also collides with
   the real region **Etobicoke Centre**, and row 9 is the neighbouring
   **Etobicoke North**, so three cards in the grid read as Etobicoke.
4. **Vaughan (4) against Vaughan Woodbridge (10),** both `Winter cohort`.
   Vaughan is the city header in `lib/places.js`, Vaughan Woodbridge is the
   declarable region inside it: overlapping territory, two cohorts.
5. **`sub` echoing the region (13, and 2/11 in effect).** `North York Central ·
   North York Central` is a row whose label carries no information.

## Other faults worth fixing while the table is being cleared

- **4 rows name a region no partner can declare**, so they can never receive a
  bid: `Etobicoke` (2 and 11), `Vaughan` (4), `London South` (14). The
  declarable list is 37 names in `lib/places.js`; `requireActiveCoverage()`
  matches on the region slug exactly. Row 11 is the sharp one: it is at
  **sealed bidding** in a region no coverage can match, so it refuses every bid
  it receives while presenting as open.
- **4 rows carry no `sub`** (7, 8, 12, 16), so the card's second line is blank.
- **2 rows advertise a join deadline that has passed** while still joinable:
  `closes Aug 24` (4) and `closes Aug 19` (12). `announce_at` is the moment
  joins lock, and `memberStageOf` will already read these as `locked` while the
  badge still invites a move.

## The moves

`TRANSITIONS` in `lib/catalog.js` does **not** allow `auction -> archived` in
one hop. The ladder is `auction -> closed -> archived`, and
`planned` / `waitlist` / `forming -> archived` directly. Leaving `auction`
always sets `bidding_open = false`; a row left at `closed` with the window
still true reads as open on inspection and refuses every bid in practice.

Two ways to run it. **Prefer the first.**

### A. The admin console (validated)

`/admin` -> campaigns -> transition. It runs
`POST /admin/campaigns/:id/transition`, which checks the state machine, closes
the bid window on the way out of `auction`, invalidates the catalog memo and
writes an `admin.campaign.transition` audit row. Two clicks per auction row
(closed, then archived), one per joinable row. 24 transitions for 16 rows.

### B. ZCQL, if the console is not an option

**ZCQL enforces none of the above.** No state machine, no audit row, no memo
invalidation (the catalog memo is 60s, so both dashboards lag by up to a
minute). One statement per submission: paste these in order, top to bottom.

Enumerate first. This is the only step that gives you the slugs:

```sql
SELECT ROWID, campaign_id, region, sub, kind, bidding_open, sort_order, announce_at, bidding_closes_at FROM campaigns;
```

Then, in this order:

```sql
UPDATE campaigns SET kind = 'closed', bidding_open = false, updated_at = '2026-08-24 19:03:46' WHERE kind = 'auction';
```

```sql
UPDATE campaigns SET kind = 'archived', bidding_open = false, updated_at = '2026-08-24 19:03:46' WHERE kind = 'closed';
```

```sql
UPDATE campaigns SET kind = 'archived', bidding_open = false, updated_at = '2026-08-24 19:03:46' WHERE kind = 'forming';
```

```sql
UPDATE campaigns SET kind = 'archived', bidding_open = false, updated_at = '2026-08-24 19:03:46' WHERE kind = 'waitlist';
```

```sql
UPDATE campaigns SET kind = 'archived', bidding_open = false, updated_at = '2026-08-24 19:03:46' WHERE kind = 'planned';
```

Statement 1 closes the 8 auctions. Statement 2 archives them together with any
row already sitting at `closed`. Statements 3 to 5 archive the 8 joinable rows.
If your console refuses an `UPDATE` whose `WHERE` is not on a unique column,
fall back to the per-row form, which is what `scripts/cohort.mjs move` emits:

```sql
UPDATE campaigns SET kind = 'closed', updated_at = '2026-08-24 19:03:46' WHERE campaign_id = '<slug>';
UPDATE campaigns SET bidding_open = false WHERE campaign_id = '<slug>';
```

Verify. Both should return nothing:

```sql
SELECT campaign_id, kind, bidding_open FROM campaigns WHERE kind != 'archived';
```

```sql
SELECT campaign_id, kind, bidding_open FROM campaigns WHERE bidding_open = true;
```

`updated_by` is left as it was by either path B statement; the admin route
would have stamped it with the operator's user id.

## What archiving all 16 does to the rest of the system

State it plainly before you run it:

- **Both dashboards go empty.** `cohorts.list()` filters `archived` out, and
  there is no seed fallback, so a member sees zero cohort cards and a partner
  sees zero biddable regions. That is correct behaviour, not a bug, and it is
  what a cleared table looks like.
- **Your own seat survives in the ledger and disappears from the page.** The
  `seat_claim` row for Scarborough Southwest stays `active` while its campaign
  stops being returned by `GET /campaigns`, so the seat card vanishes and the
  claim does not. This is *not* reported as an orphan:
  `GET /admin/campaigns/reconcile` loads with `includeArchived: true`, so an
  archived id is still "known". Release the seats first if you want the ledger
  clean, or accept active claims against archived cohorts.
- **`archived -> closed` is the only way back.** Archived is terminal
  otherwise, so a row archived by mistake un-archives to `closed`, never
  straight back to `auction`.
- **Nothing here touches bids, awards or orders.** Closing a cohort does not
  delete a sealed bid, and there is no withdraw path by design.

## After the table is empty

`POST /admin/campaigns/import-defaults` seeds the 6-row code catalog, every
region of which is declarable. Rebuild the real cohorts from there or with
`node scripts/cohort.mjs new <slug> --region "<declarable region>"`, and check
each one with `node scripts/cohort.mjs verify <slug>` before pasting: that is
the step which would have caught `Etobicoke`, `Vaughan` and `London South` on
the way in.

## Why these campaigns do not look synced to the provider console

The server side **is** synced. `GET /provider/campaigns` and `GET /campaigns`
call the same `cohorts.list()`, at one clock reading, and the partner route
sends **every** visible campaign to **every** provider: there is no coverage
filter and no per-org filter anywhere in the route
([routes/campaigns.js:681-699](../catalyst-backend/functions/auth/src/routes/campaigns.js#L681-L699)).
Household counts match too: both projections read the same `s.seats`. The same
was true of the deployed version on `main`, which maps `visible(cat.list)` for
every partner.

So nothing is being filtered out. Four other things make the two surfaces look
unrelated.

### 1. An unapproved org cannot reach the desk at all

`setGated()` toggles `body.gated`, and `app.css` hides `.pane` (the whole nav
pane) and the search box. An org that is not approved lands on `pending` and
has **no navigation to the desk**, so the count of campaigns it can see is
zero no matter what the table holds. `state.approved` defaults to `false` and
only `/provider/me` answering `approved: true` clears it. Check this first: if
the partner account being compared is not approved, everything below is moot.

### 2. The member tile derives its stage from `kind` alone, the desk does not

This is the real divergence, and it is a standing-rule violation.
`CCBADGE` in [dashboard.html:2620](../dashboard.html#L2620) maps `kind` to a
badge in the browser: `auction` always reads **"Sealed bidding"**, whatever the
calendar says and whatever `bidding_open` is. The partner desk uses the
server's `stage`, which for an auction row with no dates and
`bidding_open = false` is `announced`, and `isComing()` files `announced` under
**Coming cohorts**.

Running the real `forMember` and `forPartner` over rows shaped like the 16:

```
region / sub                             kind      member tile        partner desk
Scarborough Southwest / First cohort     auction   Sealed bidding     LIVE · Open
Kleinburg / Autumn cohort                auction   Sealed bidding     Coming · Announced   <-- DISAGREE
North York Central / Main cohort         auction   Sealed bidding     Coming · Announced   <-- DISAGREE
The Annex                                auction   Sealed bidding     LIVE · Open
Mississauga City Centre                  auction   Sealed bidding     Coming · Announced   <-- DISAGREE
Etobicoke North / Winter cohort          auction   Sealed bidding     LIVE · Open
Vaughan Woodbridge / Winter cohort       auction   Sealed bidding     Coming · Announced   <-- DISAGREE
Etobicoke / Etobicoke Central            auction   Sealed bidding     LIVE · Open
```

Every auction row whose window was never opened tells the household bidding is
under way and tells the partner the cohort has not started. `forMember` already
sends `stage` and `stageLabel` **per campaign**, so the tile has the server's
answer in hand and ignores it. The member's *own* card reads `c.stageLabel`
correctly; only the other tiles fall back to `CCBADGE`. That is the client
deriving stage, which the standing rules forbid.

### 3. Four rows can never be interacted with from the desk

`row()` marks a cohort `unlocked` only when the partner has **active coverage**
whose slug equals the cohort's `coverageRegion`. Checked against
`places.isRegion()`:

- `Etobicoke` -> not a region
- `Vaughan` -> not a region
- `London South` -> not a region

Those four rows (Etobicoke twice, Vaughan, London South) name places no partner
can declare, so `unlocked` is false forever: the desk shows
`Verifies with Etobicoke coverage`, the row never expands, and no bid is
possible. `Etobicoke / Etobicoke Central` is the sharp case, because it renders
as a **LIVE, open** auction that cannot be bid on by anyone.

### 4. The desk's copy claims a filter that does not exist

Two strings on the desk are now false: `You see a cohort because it sits inside
your declared coverage`, and the `Planned in your coverage` heading over the
Coming table. Every partner sees every cohort; coverage decides whether a row
can be *expanded*, not whether it is *listed*. A partner reading that line and
seeing London South concludes their coverage is wrong.

### What to fix, and in what order

1. Confirm the partner org is approved, or nothing else is observable.
2. Point the member tile badge at `c.stageLabel` (falling back to `CCBADGE`
   only when the payload carries no stage), so one server answer drives both
   surfaces. One line in `ccCard()`.
3. Reword the two desk strings to say listed-vs-biddable rather than claiming a
   filter.
4. The four unbiddable regions are fixed by the cleanup above: archive them and
   recreate against declarable names, with `cohort.mjs verify` as the gate.
