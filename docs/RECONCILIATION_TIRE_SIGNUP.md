# Tire sign-up: final reconciliation before staging

The v3 design drop against what is deployed on `tires.whollar.ca`, in two
passes: the language, then the functionality. Every claim here was checked
against the **deployed** files and the live Data Store, not a checkout. The
tire host is serving code behind `origin/main`, so the checkout describes a
site that is not running.

Source drop: `whollar-tires/design/uploads/whollar-tire-signup-v3.html`,
byte-identical to the file reviewed on 2026-09-07.

Two surfaces were ported from it and they diverged differently. Neither is
complete, and they are incomplete in different places:

- **the landing modal**, `js/tire-kit.js`: a quick path and a three-step guided path
- **the `/join` page**, `js/tire-join.js`: a quick path and a three-step guided path

**Where copy lives.** `index.html`, `mobile/index.html`, `js/vehicles.js` and the
tools block of `js/tire-kit.js` are written by `scripts/port-tires.mjs` from
`design/uploads/whollar-tire-waitlist-v5.html`, the v3 drop, and
`src/tools/*.html`. Edit those sources, or add a rewrite to the port the way the
batch-to-wave rename was done. A hand edit to a generated file is lost on the
next run.

---

## Part 1. Language

### 1.1 House rules, and where the deployed copy breaks them

Rules: no em dashes anywhere; `client`, `customer`, `lead`, `prospect`, `group`,
`batch`, `pool`, `handover` are never used, in copy or in identifiers; a
household is a household, a release of appointments is a wave.

**Em dashes: zero**, in the drop and on every deployed file. The middle dot
(` · `) is the separator in use and it is fine.

**Banned words still visible to a household, all three from the tools:**

| Text | Where it shows | Authored in |
|---|---|---|
| "Show me the `group` price first" | the spend dropdown, quick and guided | `design/uploads/whollar-tire-signup-v3.html:633` and `whollar-tire-waitlist-v5.html:1012` |
| "Both go into the `group` price, so you are not stuck with the thing that made you hesitate." | strategy tool output | `src/tools/tool-a-strategy.html:1311` |
| "your `group` price should land under all of it" | rims tool output | `src/tools/tool-c-rims.html:1211` |

Say **cohort price** in all three. It is the product's own word and it is the
more honest one: the price exists because of the cohort.

**Banned words in identifiers and comments**, inside the generated tools block
(`tire-kit.js:736` to `747`): `batchSize`, `batchDates`, and the comments
"households released per batch" and "invites that put a friend in your batch".
They come from `src/tools/tool-b-size.html`, `tool-c-rims.html` and
`tool-d-insurance.html`, lines 577 and 588 in each. The port renamed the main
config to `waveSize` and left this second copy behind. One comment in
`tire-join.js:17` says the tools "run entirely on the `client`"; say "in the
browser".

**Two words that are not on the list and should be treated as if they were:**

- "Sealed bids, per tier, on the whole `block`" (landing confirmation). Say
  "for the whole cohort".
- "Think of this as your `order` number" (`/join` confirmation). Every other
  sentence on the page says nothing is being bought. It is a reference.

### 1.2 Concept consistency across the three surfaces

| Concept | Drop | Landing modal | `/join` |
|---|---|---|---|
| the release | Batch | Wave, shown ("Wave 8", "Your wave opens") | **never mentioned** |
| the act of joining | hold my spot | hold my spot, lock in my spot | "Join the `waitlist`", then "You are in the cohort" |
| who bids | installers, shops | installers, then "installers and distributors", then "suppliers", in three consecutive sentences | installers |
| the reference | reference | reference | "order number" |

Pick one household-facing word for the bidder (**installer**) and keep it. The
internal word is partner; a household does not need to learn it. Show the wave
on `/join` or stop showing it on the landing page; the two surfaces currently
describe different products.

### 1.3 Voice

The drop uses no contractions at all. The landing page has "We'll" four times,
"We're", "You're", "Don't". `/join` has "Don't" twice, "Let's", "You're". The
rest of whollar.ca is written without them. One voice, and the drop's is the
one that matches the site.

### 1.4 Care versus selling

Every line that pushes rather than explains, and what the drop or the site
already says better.

| Deployed | Where | The problem | Better |
|---|---|---|---|
| "Text me when my wave opens. Appointment slots go fast and email is slower." | quick form, SMS consent | scarcity attached to a consent box. The guided form already dropped the second sentence. | "Text me when my wave opens." |
| "Why finish now: your place in line is set the moment you join. Cohort capacity is limited by what our installers can fit before winter, so earlier ranks get first pick of the cohort rate and the best install days." | `/join` step 3 | rank pressure, and not in the drop. The drop's closing line is "Your spot is already held. This just adds the detail so we can price it." | use the drop's line |
| "The more you fill in, the sharper your cohort rate." | `/join` step 3 | conditional reward | "The more we know, the more of the quote we can put together before we email you." (the drop's line, already on the landing page) |
| "The tighter your dates, the better the bid." | landing step 3 | the drop said why: "because installers can slot the whole cohort efficiently". The reason was cut and the pressure kept. | restore the reason |
| "Installer reputation", "Closest location", "A specific brand" | `/join` priorities | the drop's are warmer and already on the landing page: "A brand I trust", "A shop close to home", "Least hassle overall" | use the drop's |
| "Later, you may share my details with matched installers so they can quote **and contact me**" | `/join` share consent | broader than what the drop asked for. The drop shares a postal code, vehicle and dates, "not my name, email or phone", and says so. | use the drop's sentence |

Copy that already does this well, and should be protected: "I understand this is
not a purchase and nothing is charged today." "Not my name, email or phone."
"Nothing blocks your signup." "Your spot does not depend on finishing it." "Say
yes and book, or say no and owe nothing."

The drop's size guidance is the best writing in either file and most of it did
not reach the sign-up: "The writing on the tire is the real answer if the tires
on the car now are the ones the factory fitted." "If the two disagree, someone
has changed the size, which is worth knowing before you order." "Sizes that
might work, not sizes we are telling you fit." The heavy-EV note about load
ratings. All of it survives only inside the size tool, which a household has to
open separately. It belongs where the car is chosen.

### 1.5 Promises the system cannot keep

This is the largest care failure and it is not a wording problem.

- Quick form subtitle: "Four fields. You can fill in the rest later **from the
  link in your email**."
- Landing confirmation: "Everything you told us can be changed later **from the
  link in your confirmation email**."

`POST /tire-waitlist-join` enqueues nothing to the notification outbox, and no
tire template exists in the registry. **No email is sent on a tire sign-up.**
The drop made no email promise; the port added one and nothing was built behind
it. Either build the confirmation mail and the edit link, or change both
sentences today.

### 1.6 Copy that describes behaviour the code does not have

- Landing, step 1: "This is the only part that decides your place in line.
  Submit it and the spot is yours, finished profile or not." Button: "Lock in my
  spot, then continue." Toast: "Spot noted."
- `/join`, step 1: "The moment you finish this step you are on the list."

Neither step posts anything. On the landing page step 1 runs `capture(city)`,
shows the toast and moves to step 2; the only POST is `finish()` at the end of
step 3. On `/join`, `guidedPayload` is posted only by `#g3submit`. **A household
that leaves during step 2 or 3 does not exist.** The drop held the spot at step
1 (`doHold` posted before revealing the rest) and that was its central promise.
See 2.1.

---

## Part 2. Functionality

### 2.1 Flow

| | Drop | Landing modal | `/join` |
|---|---|---|---|
| when the spot is held | step 1, its own POST | end of step 3, one POST | quick: step 1; guided: end of step 3 |
| profile | second POST, `stage:profile` | none from this surface | none |
| reference | minted in the browser | minted on the server, Unique, retried | server |
| rank and wave | browser, from a seeded count | server counter | server, **wave never shown** |
| referral | "Move up the line": invites, places moved, `referralMode: skip` | **removed**; `referral: null` hardcoded | none sent |
| second car | no | "Add another vehicle": a second sign-up, own reference | "Add this car": same |
| internet cohort | consent line only | consent line plus a cross-sell on the confirmation | consent line |

Restoring the step-1 hold is the single most valuable functional change on this
list. The backend already supports it: `stage:'profile'` exists for exactly this
and it is the attach that is broken (2.4), not the hold.

The referral block was cut deliberately (the seeded count and "simulate a friend"
button were prototype theatre) but the mechanism underneath was real product.
The corner popup now mints share codes and records clicks; the sign-up is the
one place a referral is never recorded. Decide whether the tire cohort has a
referral incentive. If it does, the sign-up must carry `referral`.

### 2.2 Every question, on every surface

| Question | Drop | Landing modal | `/join` | Column |
|---|---|---|---|---|
| name, email, mobile, postal | yes | yes | yes | `TireWaitlistSignups` |
| city | chip, plus province when "somewhere else" | derived from postal, never asked | select | `City`; **no `Province` column** |
| language | no | step 1 | step 1 | `Language` |
| SMS opt-in | yes | yes | yes | `ConsentSms` |
| what is on the car now, life left | no | step 2 (added) | "Do you run winter tires now" | `StartingPoint`, `TireLifeLeft`, `RunsWinterNow` |
| winter or all-weather | chips, "Open the tools" | chips, six-question tool | inline "Help me choose" | `Strategy` |
| how the size is given | 3 modes | 3 modes | 4 modes (VIN as a mode) | `InputMode` |
| **size options after the car is chosen** | yes, with trim, staggered flag, sticker guidance, downsize, heavy EV | guided: options only; **quick: none, but the confirmation box still appears** | behind a "Show me winter size options" button | `TireSize`, `WinterSizeChosen`, `VehicleTrim` |
| size acknowledgement | yes | quick and guided | **not sent** | `SizeAck` |
| staggered | yes | guided | not sent | `Staggered` |
| downsize | "Look into a smaller winter size for me" | inside the size tool only | not sent | `SizeDownsized` |
| VIN | yes | guided | as a mode | `Vin` |
| needs | multi | 6 options | 9 different options | `Needs` |
| tier | Value, Middle, Premium, Surprise me | same | Recommend, Premium, Mid, Value | `Tier` |
| brand, line, other | brand, line, free text | brand, line filtered by strategy | brand mode only | `Brand`, `BrandLine`; **no column for the free text** |
| dates | tick days, tick slots | earliest and latest, calendar, up to five ranked | date chips, "any", earliest and latest | `TireInstallWindows` (landing only), `InstallWindows` string (both), `NotBefore`, `MustBeOnBy` |
| installer | type, own shop name, address, postal, radius | same | type, "Closer to home, work, either" | `InstallerType`, `InstallerName/Address/Postal`, `TravelRadius`, `Anchor` |
| split install and storage | yes | yes | yes | `SplitPreference` |
| **budget** | **per tire**, six bands | per tire, optional | **per set**, five bands | `Budget` |
| financing | yes | yes | yes | `Financing` |
| insurance | "Remind me to call my insurer" | "Send me what I need to claim the discount", plus a tool | estimator tool, insurer and premium | `InsuranceHelp`, `InsurerProvince`, `PremiumAnnual` |
| memberships | 4 | 4 | 7 | `Memberships` |
| priorities | 5 | same 5 | 5 different | `Priorities` |
| readiness | 3 | same 3 | 3 different | `Readiness` |
| notes | yes | yes | yes | `Notes` |
| share with installers | postal only (quick); postal, vehicle, dates (guided) | postal and size (quick); postal, vehicle, dates (guided) | "share my details ... quote and contact me" | `ConsentShare` |
| tool runs | opened from a link | sent, output only | sent as `tools`, **discarded** | `TireToolRuns` |

### 2.3 The same column, two vocabularies

The two surfaces write different codes into the same columns, so nothing can
be counted across them. Only `Financing` agrees.

| Column | Landing modal | `/join` |
|---|---|---|
| `Tier` | value, mid, premium, any | recommend, premium, mid, value |
| `Needs` | tires, wheels, tpms, install, swap, storage | tires, package, mount, install, swap, align, disposal, storage, oil |
| `InstallerType` | any, local, chain, dealer, mobile, own | any, independent, bigbox, dealer, mobile |
| `Readiness` | now, soon, watching | ready, likely, watch |
| `Priorities` | price, early, brand, close, easy | price, early, brand, close, rep |
| `Memberships` | caa, costco, employer, none | costco, caa, triangle, club, employer, cc, none |
| `Budget` | u120, 120170, 170230, 230300, 300up, unsure **(per tire)** | u800, 800, 1100, 1500, open **(per set)** |

One question set, one code per answer, rendered twice. The drop's lists are the
ones to keep; the landing page already uses them.

### 2.4 Defects, verified live

| | What | Evidence |
|---|---|---|
| D1 | `/join` sends `consent:{granted...}`; the route reads `consentEmail`. Every `/join` sign-up stores `ConsentEmail=false`, empty `ConsentText`, CRM `{consentGranted:false}`. | row `W25C` |
| D2 | Quick path: the confirmation box appears on year, make, model; no size is rendered. `SizeAck` can be true for a size never shown. | `sizeKnown("q")`, no `q_fitWrap` |
| D3 | `stage:profile` writes nothing (every side-table insert collides on a reference-derived Unique key and `insertTolerant` swallows it) and sets `ConsentShare` and `AlsoInternet` to false for anything not resent. Returns `ok:true`. | row `2ZSA` |
| D4 | Quick path drops the spend answer: `details` is built only for `path==='guided'`. | row `CUDG`, no details row |
| D5 | `tools` versus `toolRuns`; `anchor` never written; `referral: null` hardcoded. | code |
| D6 | `toolRuns` sends `input: null`; `InputJson` is always null, so no estimate can be reproduced. | code, and the table holds zero real rows |
| D7 | No hold at step 1 on either guided path (1.6). | handlers |
| D8 | No confirmation email, while two sentences promise one (1.5). | route, registry |

### 2.5 Dates and stage in the copy

"Bidding opens in early October." "Anywhere between mid September 2026 and the
end of January 2027." "On by Nov 1 is the common target for the Ontario
insurance discount." `waveDates` is a hardcoded list, and it exists twice
(`tire-kit.js:38` and `:737`). The server owns campaign stage; a countdown or a
date in copy is a fact that will be wrong by November. Read them from the
server, or at minimum from one place.

---

## Part 3. The work, in order

1. **Hold at step 1, on both guided paths** (D7). Post the hold from step 1,
   carry the reference, post the profile from step 3 as `stage:profile`. The
   copy already describes this.
2. **Make the attach an update** (D3). Upsert on the reference-derived keys;
   write a consent column only when the request carries it. Without this, step
   1 above corrupts what step 3 sends.
3. **Size options on the quick path, and automatically on `/join`** (D2).
   Reuse `g_fitWrap` and `TOOLS.size.suggestHTML`. Options first, one chosen,
   then the confirmation. Bring the sticker, downsize and heavy-EV guidance to
   the same panel.
4. **Consent shape on `/join`** (D1). Flat fields, as the landing modal sends.
5. **The email** (D8). Build the confirmation mail with the edit link, or cut
   both sentences. Not a third option.
6. **One vocabulary** (2.3) and one question set (2.2). `/join` adopts the
   drop's lists. Budget per tire everywhere.
7. **Dropped fields** (D4, D5, D6): spend on the quick path, `toolRuns`,
   `Anchor`, `referral`, tool inputs.
8. **Restorations on `/join`**: brand line, radius, own shop, insurance help,
   size acknowledgement, staggered, downsize, trim.
9. **Copy** (Part 1): three cohort-price fixes at source, the tools block
   identifiers, the six lines in 1.4, one voice, one word for the bidder, the
   wave on `/join`, "reference" not "order".
10. **Decisions**, each one line: province column or stop asking; referral
    incentive on the tire cohort or not; a car per sign-up or a car per
    household; licensed fitment data or the suggestion table with honest copy.

## Part 4. Verification on the staging link

Push the branch and open the `whollar-tires-1w` preview. Preview origins reach
the backend; that CORS work landed on 2026-09-06.

Walk every path by hand, then run `DB_TEST_PLAN.md`:

- Phase 0.3 first: checksum the preview's `tire-kit.js`, `tire-join.js` and
  `vehicles.js` against the branch, so the test is of the code you think it is.
- Phase 2, items 2.12 to 2.14, and add a fourth: **leave at step 2** and confirm
  the row exists.
- Read every table in the row after each submission. Every defect in 2.4
  returned HTTP 200.
- Phase 6 cleanup, and reset `TireCohortCounter` by reading it first.

Only after the preview is clean does this go to production.

---

## Part 5. What shipped on 2026-09-07, and what did not

### The baseline moved

`origin/main` of `whollar-tires` already carried the v3 two-stage rebuild on
both surfaces: hold at step 1, profile attached to the reference, flat consent,
`toolRuns` with inputs on `/join`, brand line, radius, own shop, insurance help,
size acknowledgement, staggered, trim. That resolved D1, D2, D4, D5, D7 and most
of section B **in the checkout**. The live site never received it, because every
Vercel deployment of the tires repo since 04:10 on 6 September, preview and
production, reports "Deployment was blocked". Sibling projects on the same team
deployed fine in the same hour, so it is project-level. Only the Vercel
dashboard shows the reason.

### Backend, deployed (formSubmit only)

Branch `backend-tire-reconcile` in `whollar-web`, deployed from an isolated
worktree with the shared tree confirmed clean and `origin/main` unmoved.

- The profile save writes in upsert mode: every side-table key is looked up
  and the row updated in place; insert only when absent. Stale install windows
  past the new count are deleted. Verified live: row `WHL-TIRE-GTA-GKDD` re-saved
  with a different car and one date instead of two; one vehicle row, updated;
  rank 2 gone.
- Consent columns are written only for keys the request carries. Verified:
  `ConsentShare` and `AlsoInternet` stayed true through a save that did not
  mention them.
- Nested `consent:{granted...}` and `tools` are read as fallbacks, because /js
  is cached a day. Verified: row `P8XG`, sent in the old `/join` shape, stored
  `ConsentEmail=true` with its text and a `TireToolRuns` row with its input.
- `Anchor` is written. Verified on both rows.
- The response reports `saved: {total, failed}` so a test can tell a landed
  save from a swallowed one.

A save replaces the profile: a field not sent is cleared. That is right for
the page, which always sends the whole profile, and wrong for a partial
client. Do not write one.

### Backend, committed and NOT deployed (auth)

`GET /me/tires` adopts a member's tire spots by lowercased address, the way
`/me/bill` adopts a bill, and writes `UserId` back onto the row once that
column exists (create-tables.md 35a, optional, never Mandatory). Registered in
the auth `F` block; the registry gate passes.

It is not deployed because `auth` on `main` carries weeks of committed,
undeployed work waiting on console tables (CRM phases, booking at acceptance,
leave-cohort, the ALLOWED_ORIGINS floor). Deploying auth ships all of it. That
is a separate decision.

**Console step for the owner:** add `UserId`, Var Char 64, optional, to
`TireWaitlistSignups`. The route works without it and links nothing.

### Frontend, on the preview branch

Branch `tire-signup-reconcile` in `whollar-tires`, from `origin/main`. The
copy in Part 1, sections 1.4 to 1.6, is applied: the email promises, the
order-number line, the SMS nudge on all three forms, one word for the bidder,
one voice, and the sidewall-and-sticker guidance under the size options. The
FAQ sentence is fixed in `FAQ_COPY` in the port, which feeds both the visible
answer and the structured data.

### Deferred, with reasons

- **`batchSize` and `batchDates` in the tools' own config.** The port's tools
  assembly anchors on those lines; renaming them mangled the generated kit.
  Identifiers only, never shown. Rename them by teaching the port, not by
  editing the sources.
- **The tire confirmation email.** Needs a template, an internal route from
  formSubmit, an edit link, and an auth deploy. The copy no longer promises it.
- **Calculator inputs from the landing modal** still arrive as `input: null`;
  `/join` sends them. Capturing them means touching four tool sources.
- **Downsizing on `/join`** (`sizeDownsized` is always null there).
- **`PremiumAnnual` reads 10 on every row where nothing was sent.** The code
  writes null. The column has a default in the console. Clear it: a premium of
  ten dollars is a false fact in a money column.

### Test rows to remove

Tagged `QAAUDIT0907`: `TireWaitlistSignups` 1258000000094307 and
1258000000094327; `TireWaitlistVehicles` 1258000000094315 and 1258000000095595;
`TireWaitlistDetails` 1258000000094320 and 1258000000094336;
`TireInstallWindows` 1258000000095589; `TireToolRuns` 1258000000094319 and
1258000000094335; `CrmSyncQueue` where Email is `qa-upsert-0907@whollar.ca` or
`qa-nested-0907@whollar.ca`. `TireCohortCounter` for GTA read 52 after these;
read it again and subtract 2, plus 3 for the `QAAUDIT0906` rows if those are
still there.
