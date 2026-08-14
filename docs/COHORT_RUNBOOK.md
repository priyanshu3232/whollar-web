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
counts as watching rather than a household. Repeat with as many member accounts
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

**4d. Coverage, then verify it.** A campaigns row alone reaches nobody. It
reaches every partner whose declared coverage matches the region and has
verified.

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
