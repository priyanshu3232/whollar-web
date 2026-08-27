# Reset the campaigns table, then drive one cohort from ZCQL

Owner's brief, 2026-08-27: one database, one consumer dashboard, one partner
console, and a cohort created in ZCQL visible on both sides, biddable on one
and joinable on the other, moving stage by stage from further ZCQL. This is the
runbook for that. It supersedes the catalog hold in
[CAMPAIGN_CLEANUP_2026-08-25.md](CAMPAIGN_CLEANUP_2026-08-25.md), which is
removed: both surfaces read the table again.

Everything below is pasted into **Catalyst console -> Data Store -> ZCQL**,
Development environment, **one statement per submission**. A block of nine is a
syntax error there.

## 0. What the code now guarantees

- `GET /campaigns` and `GET /provider/campaigns` both call `cohorts.list()`,
  which counts and stages every campaign at **one clock reading**. The two
  surfaces cannot disagree about a cohort.
- Stage is derived from the seven date columns **on the server**, per request,
  never memoized and never computed by a browser.
- The counts are a COUNT at read time over `seat_claim` and `campaign_members`.
  No seed baseline anywhere.
- The catalog is memoized **60 seconds**. Allow a minute after each statement
  before judging a dashboard, and reload `/partner`: the console fetches
  campaigns once at boot and never polls.
- An empty table falls back to the code catalog for the **admin console only**
  (`source:'code'` is an empty list on every member and partner route). So an
  empty table is four labelled empty slots on each surface, not six invented
  cohorts.

## 1. Enumerate. This is the only step that gives you the slugs

```sql
SELECT ROWID, campaign_id, region, sub, kind, bidding_open, sort_order FROM campaigns;
```

Expect 16 rows: 5 duplicate clusters, 4 naming regions no partner can declare
(`Etobicoke` twice, `Vaughan`, `London South`), all of them QA seed rows.

## 2. Check for sealed bids BEFORE deleting anything

```sql
SELECT campaign_id, org_id, status FROM provider_bids;
```

**A campaign with a bid row is not deleted.** Bids are append-only and there is
no withdraw path, by design: deleting the campaign would orphan a sealed bid
that no longer names anything. Archive those instead (step 4), which takes them
off every surface and leaves the record whole.

Also check what a delete would strand:

```sql
SELECT campaign_id, COUNT(ROWID) FROM campaign_members GROUP BY campaign_id;
```

```sql
SELECT cohort_id, member_id, status FROM seat_claim WHERE status = 'active';
```

## 3. Delete the rows with no bids, dependents first

Deleting a campaign and leaving its memberships behind strands the household:
an active `seat_claim` against a cohort that no longer exists means the address
is refused everywhere with SEAT_HELD and has no cohort to leave. So the
dependents go first, in this order, one statement each.

```sql
DELETE FROM seat_claim WHERE cohort_id = '<slug>';
```

```sql
DELETE FROM campaign_members WHERE campaign_id = '<slug>';
```

```sql
DELETE FROM cohort_counter WHERE cohort_id = '<slug>';
```

```sql
DELETE FROM campaigns WHERE campaign_id = '<slug>';
```

`seat_events` is an append-only audit trail and stays. Repeat the four for each
slug from step 1.

## 4. Archive, for any campaign that carries a bid

`TRANSITIONS` does not allow `auction -> archived` in one hop, and leaving
`auction` must close the window: a row left at `closed` with `bidding_open`
still true reads as open on inspection and refuses every bid in practice.

```sql
UPDATE campaigns SET kind = 'closed', bidding_open = false, updated_at = '<UTC now>' WHERE campaign_id = '<slug>';
```

```sql
UPDATE campaigns SET kind = 'archived', updated_at = '<UTC now>' WHERE campaign_id = '<slug>';
```

## 5. Verify the table is clear

Both should return nothing:

```sql
SELECT campaign_id, kind FROM campaigns WHERE kind != 'archived';
```

```sql
SELECT campaign_id FROM campaigns WHERE bidding_open = true;
```

At this point `/dashboard` shows **Areas 2 to 5** on the cohort row and Areas 6
to 9 behind View all, and `/partner` shows **Areas 1 to 4** on the open-auction
table and 5 to 8 on Coming cohorts. Grey, labelled, empty. That is the empty
state, not a failed load.

## 6. Create one real cohort

Generate the statement rather than typing it, so the region is checked against
`lib/places.js` on the way in. That check is what would have caught
`Etobicoke`, `Vaughan` and `London South` before they reached the table.

```
node scripts/cohort.mjs new scarborough-east --region "Scarborough East" --sub "Autumn cohort"
node scripts/cohort.mjs verify scarborough-east
```

The INSERT it prints creates the cohort at `kind = 'forming'` with no calendar.
Within a minute:

- **/dashboard** takes Area 2 and becomes a real card: the region name, the
  cohort label, a photograph, badge **Open to join**, and the whole card is the
  join target. Areas 3, 4, 5 stay grey.
- **/partner** takes Area 5 on Coming cohorts, reading `Still forming`. It is
  biddable only from an org whose `provider_coverage` row for Scarborough East
  is `status = 'active'`; without one the row renders locked and says which
  coverage it verifies with.

The photograph needs no step. `regionArtKey()` hashes any region name onto one
of the 20 photographs in `images/regions/`, so every cohort is illustrated the
moment its row exists.

## 7. Move it stage by stage

```
node scripts/cohort.mjs step scarborough-east --list
```

Nine rungs, one UPDATE each, and under every rung it prints what the consumer
sees, what the partner sees, and whether the bid button is live, by calling the
same stage functions the routes call. The ladder is resumable: the row says
where it is, so nothing has to be kept in your head.

| # | rung | consumer | partner | bid button |
| --- | --- | --- | --- | --- |
| 1 | announce | locked | announced | no |
| 2 | auction | locked | announced | no |
| 3 | bidding | bidding | open | **yes** |
| 4 | close | offers | offers_out | no |
| 5 | offers | offers | offers_out | no |
| 6 | decide | confirm | decided | no |
| 7 | switch | switching | decided | no |
| 8 | reconcile | done | decided | no |
| 9 | done | done | decided | no |

Every rung stamps its date with the moment you run it and leaves every later
date NULL, so nothing expires while you work: a window opened at rung 3 stays
open until rung 4 closes it.

Rungs 1 and 2 are the pair that used to lie. An auction whose window had never
been opened told the household sealed bidding was under way and told the
partner the cohort had not started. `memberStageOf` now reads `bidding_open`
the way `stageOf` always did, so both surfaces say the same thing, and
`scripts/test-campaign-stage.mjs` asserts the pair together.

## 8. A cohort with an open bid window, in one paste

For a rail that is biddable immediately rather than nine statements later:

```
node scripts/cohort.mjs seed scarborough-east --minutes 5
```
