# Two cohorts, two partners, side by side

> The stage ladder (cohort-stage-ladder.pdf) run twice, interleaved, so the two
> cohorts sit at different stages at the same moment and two different partners
> bid one each. Every command is copy-paste; `<...>` placeholders are filled once
> in the table below. ZCQL runs in Catalyst console -> Data Store -> ZCQL,
> environment Development. One statement per submission, then wait 60 seconds
> (the catalog memo), then reload the surface you are checking.

| Placeholder | Value used below | Notes |
|---|---|---|
| Cohort A | `etobicoke-a` in `Etobicoke Centre` | partner P1's region |
| Cohort B | `north-york-b` in `North York Central` | partner P2's region |
| `20998ec4-b155-4212-b619-239de870b238` `<P1_USER>` | P1's `org_id` and `user_id` | `SELECT org_id, legal_name FROM provider_orgs;` and `SELECT user_id, org_id FROM provider_users;` |
| `f27b1baa-a185-4655-90e8-f1a2c34303c1` `<P2_USER>` | P2's | same |
| M1, M2 | two member accounts | M1 joins A, M2 joins B |

Both regions are in `node scripts/cohort.mjs regions`, which is the whole
join to a partner: coverage matches on that exact spelling.

## 0. Before rung 0, once

**Deploy the Catalyst auth function first.** Everything up to rung 3 works on
the old function; from rung 4 the award seal, the offer's winner name, the
roster and the statement all depend on the org_id fix that shipped with the
multi-campaign build. Without the deploy, rung 4 shows a null winner and the
delivery view never releases.

Preflight, each must return without an error (zero rows is a pass):

```sql
SELECT ROWID FROM campaigns LIMIT 1;
SELECT announce_at, bidding_opens_at, bidding_closes_at, offers_at,
       decision_at, switch_window_at, reconcile_at FROM campaigns LIMIT 1;
SELECT ROWID FROM campaign_members LIMIT 1;
SELECT coverage_key, org_id, region, status FROM provider_coverage LIMIT 1;
SELECT acceptance_key, org_id, doc_type, doc_version FROM provider_terms LIMIT 1;
SELECT revision_key, bid_key, revision_no, payload FROM bid_revisions LIMIT 1;
SELECT award_key, campaign_id, org_id FROM campaign_awards LIMIT 1;
SELECT claim_key, cohort_id, status FROM seat_claim LIMIT 1;
SELECT cohort_id, roster_count FROM cohort_counter LIMIT 1;
```

Two partner accounts. Sign each up at /become-a-partner with a different
company email domain (two orgs), then:

```sql
SELECT org_id, legal_name, approval_status FROM provider_orgs;
SELECT user_id, org_id, role FROM provider_users;

UPDATE provider_orgs  SET approval_status = 'approved' WHERE org_id  = '20998ec4-b155-4212-b619-239de870b238';
UPDATE provider_orgs  SET approval_status = 'approved' WHERE org_id  = 'f27b1baa-a185-4655-90e8-f1a2c34303c1';
UPDATE provider_users SET role = 'admin' WHERE user_id = '<P1_USER>';
UPDATE provider_users SET role = 'admin' WHERE user_id = '<P2_USER>';
```

Coverage, one region each, so each partner can bid exactly one cohort:

```
node scripts/cohort.mjs coverage 20998ec4-b155-4212-b619-239de870b238 --region "Etobicoke Centre" --status active
node scripts/cohort.mjs coverage f27b1baa-a185-4655-90e8-f1a2c34303c1 --region "North York Central" --status active
```

Paste the INSERT each prints (or the UPDATE it prints when the row exists).
Then, signed in as each partner, open /partner#contracts and accept the
standard cohort terms. That is a console click, not a statement: the terms
gate fails closed until it is done.

Two member accounts (M1, M2) signed up through /waitlist or the join page,
email verified, on /dashboard.

## 1. Rung 0: create both cohorts

B takes the lower sort so it is the featured card; A sits beside it.

```
node scripts/cohort.mjs new etobicoke-a --region "Etobicoke Centre" --sub "Test cohort A" --sort 90
node scripts/cohort.mjs new north-york-b --region "North York Central" --sub "Test cohort B" --sort 89
```

Paste both INSERTs (one per submission). After 60 seconds:

- /dashboard, either member: both cards on "Campaigns near you", B first,
  both badged **Open to join**, both pressable.
- /partner, either partner: both under **Coming cohorts**, **Still forming**.

**You do:** M1 presses A and joins. M2 presses B and joins. Then the seat
rule: as M1, press B's card. Expect the badge **You hold another seat ·
Move here** and the conflict sheet naming both cohorts. Press **Stay in
Etobicoke Centre**. Verify:

```sql
SELECT membership_key, campaign_id, user_id, status FROM campaign_members;
SELECT claim_key, cohort_id, status, version FROM seat_claim;
SELECT cohort_id, roster_count FROM cohort_counter;
```

Two membership rows, two claims, each counter at 1.

## 2. Rungs 1 to 3 on A only, B stays forming

This is the concurrency you are proving: A moves while B does not.

```
node scripts/cohort.mjs step etobicoke-a --to announce
node scripts/cohort.mjs step etobicoke-a --to auction
node scripts/cohort.mjs step etobicoke-a --to bidding
```

Paste each UPDATE, 60 seconds apart. After the third:

- M1's /dashboard rail reads **Bidding**; M2's still reads **Forming** and B's
  card is still joinable.
- /partner as P1: A under **Open auctions**, **Review and bid** drawn. B still
  under Coming cohorts.
- /partner as P2: A under Open auctions but locked, **Verifies with
  Etobicoke Centre coverage**. P2 cannot bid A.

**You do:** as P1, place the bid on A from the ticket. As P2, confirm the
lock and do nothing.

```sql
SELECT bid_key, campaign_id, org_id, price, status, revision_count FROM provider_bids;
```

One row: `etobicoke-a:20998ec4-b155-4212-b619-239de870b238`.

## 3. Rungs 1 to 3 on B

```
node scripts/cohort.mjs step north-york-b --to announce
node scripts/cohort.mjs step north-york-b --to auction
node scripts/cohort.mjs step north-york-b --to bidding
```

Now both are at **bidding**, on independent calendars.

**You do:** as P2, place the bid on B. As P1, open B's row: locked,
**Verifies with North York Central coverage**.

The isolation check (EC-10), on each partner's **My bids** view:

- P1 sees one row, Etobicoke Centre, Sealed. No trace of B or of P2.
- P2 sees one row, North York Central, Sealed. No trace of A or of P1.

```sql
SELECT bid_key, campaign_id, org_id, price FROM provider_bids;
SELECT revision_key, campaign_id, org_id, revision_no FROM bid_revisions;
```

Two head rows, two revisions, each on its own campaign. Optional: as P1,
improve the bid on A (lower price). Expect the same head row updated, a
second revision row, and B's rows untouched.

Admin console: open **Sealed bids** on A, then on B. Each modal lists one bid
and is titled with its own region and slug.

## 4. Rung 4 on A only: A closes while B is still open

```
node scripts/cohort.mjs step etobicoke-a --to close
```

After 60 seconds:

- M1's /dashboard: the offer panel shows P1's company name and price. That
  name being present is the award-seal fix working.
- M2's /dashboard: still **Bidding**, no offer.
- /partner as P1: A reads **Offers out**; a further improve on A is refused.
- /partner as P2: B still **Open**; P2 can still improve on B.

```sql
SELECT award_key, campaign_id, org_id, bid_key, price FROM campaign_awards;
```

One row, `etobicoke-a`, `org_id` = `20998ec4-b155-4212-b619-239de870b238`. No row for B.

## 5. Finish A while B catches up

```
node scripts/cohort.mjs step etobicoke-a --to offers
```

**You do:** M1 accepts the offer on /dashboard (service address + consent).

```sql
SELECT order_key, campaign_id, org_id, state FROM provider_orders;
```

One order on `etobicoke-a`. Then:

```
node scripts/cohort.mjs step etobicoke-a --to decide
node scripts/cohort.mjs step north-york-b --to close
```

Two cohorts, two stages: A at **confirm** / partner **decided**, B at
**offers** / partner **offers_out**. M2 now sees P2's offer; P1 sees nothing
of it.

```sql
SELECT award_key, campaign_id, org_id FROM campaign_awards;
```

Two rows, one org each.

```
node scripts/cohort.mjs step north-york-b --to offers
```

**You do:** M2 accepts. Two orders, one per campaign.

```
node scripts/cohort.mjs step etobicoke-a --to switch
```

**You do:** as P1, /partner#delivery. Add the billing method if the gate asks,
release the roster, book the slot, mark the activation with a clean line
test. P1's board shows A only. As P2, /partner#delivery shows nothing yet (B
is not at switching). Then:

```
node scripts/cohort.mjs step north-york-b --to decide
node scripts/cohort.mjs step north-york-b --to switch
```

**You do:** as P2, the same on B. P2's board shows B only.

```sql
SELECT order_key, campaign_id, org_id, state, activated_at FROM provider_orders;
```

Two `act` rows, each on its own campaign and org.

## 6. Reconcile and close both

```
node scripts/cohort.mjs step etobicoke-a --to reconcile
node scripts/cohort.mjs step north-york-b --to reconcile
node scripts/cohort.mjs step etobicoke-a --to done
node scripts/cohort.mjs step north-york-b --to done
```

Billing, as each partner, /partner#billing: one statement card, for their
own cohort only, `accruing` until an operator issues it. The current-cycle
line sums that partner's cohorts only.

Final state of every table, in one pass:

```sql
SELECT campaign_id, kind, bidding_open FROM campaigns WHERE campaign_id = 'etobicoke-a';
SELECT campaign_id, kind, bidding_open FROM campaigns WHERE campaign_id = 'north-york-b';
SELECT bid_key, campaign_id, org_id FROM provider_bids;
SELECT award_key, org_id FROM campaign_awards;
SELECT order_key, campaign_id, org_id, state FROM provider_orders;
SELECT claim_key, cohort_id, status FROM seat_claim;
```

Every row names exactly one campaign and exactly one org, and nothing on A
names P2 or M2, nothing on B names P1 or M1.

## The same thing from the admin console instead of ZCQL

Once the auth function is deployed, every rung except the four browser acts
can be done in admin.whollar.ca -> Campaigns: **Create a campaign** (sort
order prefilled to feature it), the **-> auction** / **-> closed** transition
buttons, the **Bidding** toggle, and **Schedule** to stamp any of the seven
dates. Each dialog names the region and slug it applies to. The ZCQL path
above is the one that works today against the old function, and the two
never disagree: both write the same row.

## When something does not land

| What you see | What it is |
|---|---|
| Nothing moved | The 60 second memo. Wait, reload. |
| P2 has a bid button on A | P2's coverage includes Etobicoke Centre. One region per partner for this test. |
| Rung 4 on A shows a null winner | The auth function is not redeployed. The seal needs the org_id fix. |
| M1 could join B without a conflict | Joining B went through the old function: the legacy door guard is in the new deploy. |
| Bid refused, no reason | `provider_terms` has no row for that org and version: accept the terms on /partner#contracts. |
| A's rung moved B | It did not. Check `SELECT campaign_id, announce_at, bidding_opens_at FROM campaigns;`: each row carries only its own dates. |
