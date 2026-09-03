# Building tires.whollar.ca

The winter tire vertical, end to end: the landing page at its own host, the
waitlist behind it, and the Catalyst tables the form needs. Written 2026-09-03
against `docs/VERTICAL_PLAYBOOK.md`, which is the generic wiring; this is the
tire-specific build on top of it.

Sources in hand:

| What | Where | State |
|---|---|---|
| Landing design | `WhollarTireLandingPage/` | Claude Design canvas, 23 MB, not portable as it stands |
| Waitlist design | `whollar-waitlist-tyre.html` | Working prototype, plain HTML, posts nothing |
| Umbrella card that links here | `home/index.html`, the Winter tires card | Points at `/join` today |
| Tire welcome screen | `home/join-welcome-tires.html` | Exists, buttons point at the umbrella |

---

## 0. Five decisions, before any code

**1. The host is `tires.whollar.ca`, not `tyre`.** Everything in this
codebase already spells it the North American way: the pool value is `tires`,
the welcome screen is `join-welcome-tires.html`, the CRM field
`Whollar_Pooling_For` carries `tires`, the seat vertical is `tires`, the card
on the umbrella says "Winter tires", and `docs/VERTICAL_PLAYBOOK.md` already
names `tires.whollar.ca`. Shipping `tyre` in the hostname alone means one
spelling in DNS and another in every row, every CRM record and every log line.
If the British spelling is wanted for the domain anyway, attach both and 308
`tyre.whollar.ca` to `tires.whollar.ca` in the vertical's own `vercel.json`,
and keep `tires` everywhere inside the code. Do not split the spelling.

**2. "Group" cannot ship, and a gate enforces it.** `CLAUDE.md` bans it, and
the port scripts throw on a stray "group" in visible copy: the landing port
already renamed eleven of them. Both new designs lean on it hard:

| Design string | Becomes |
|---|---|
| Join the winter tire group (nav, hero, and the sticky CTA) | Join the winter tire cohort |
| turns everyone looking for winter tires into one powerful buying group | into one powerful cohort |
| the group rate (waitlist confirm screen, x3) | the cohort rate |
| You're one of the group | You're in the cohort |
| when my area forms a group | when my area forms a cohort |

Same for "pool" as a noun. This changes the button text on the screens as
drawn, so agree it before the port runs, not after.

**3. Which door owns the household.** `home/join.html` already asks internet,
tires or both, and writes `WaitlistSignups` plus a CRM record with
`Whollar_Pooling_For = tires`. The tire waitlist asks about thirty more
things. Two doors to the same cohort will double-count households unless one
of them wins. **Recommended:** the umbrella `/join` stays the light door for
someone who arrived at the brand, the vertical's own waitlist is the deep door
for someone who arrived for tires, and both write the same identity table
(section 5a) keyed on the email, with a `Source` column telling them apart.
`TireWaitlistDetails` then simply does not exist for a household that came
through the light door.

**4. The waitlist prototype is a demo in three places** and each has to be
made real or removed before it ships. They are listed in section 8.

**5. The canvas cannot ship as it is.** `WhollarTireLandingPage/support.js`
compiles itself with `new Function` twice, and the global CSP has no
`'unsafe-eval'`, so the page renders blank in production. It also carries 13
`sc-if` conditions, 17 `style-hover` attributes, 25 `{{ }}` bindings and 6
`<sc-` elements. It gets the same treatment as the umbrella:
`scripts/port-tires.mjs`, modelled on `scripts/port-landing.mjs`.

---

## 1. The vertical shell

```
tires/
  index.html            the ported landing, canonical https://tires.whollar.ca/
  join.html             the ported waitlist, published at /join by cleanUrls
  join-welcome.html     the confirm screen, if it stays a page rather than a panel
  vercel.json           cleanUrls, the CSP and headers, its own redirects
  robots.txt            allow all, names its own sitemap
  sitemap.xml           its pages only
  llms.txt              what the vertical is, linking back to the umbrella
  404.html              noindex
  og/                   one produced 1200x630 image
  js/  fonts/  images/  self-contained, nothing loaded from another host
```

Copy `home/vercel.json` as the starting point and strip the redirect map: the
tire host has no legacy URLs to honour yet.

**Register it, in this order, or the gates skip it silently:**

1. `.vercelignore`: add a `tires` line next to the `home` line, same reason.
   Without it the internet project publishes a second copy at `/tires/index`.
2. `scripts/check-inline-scripts.mjs` PAGES: `tires/index.html`,
   `tires/join.html`, and the welcome page if it is one.
3. `scripts/check-console-copy.mjs` PAGES: the same three.
4. `scripts/check-site-host.mjs` SKIP_DIRS: add `tires`. That gate asserts the
   *internet* site names `internet.whollar.ca`; the tire directory is a
   different project and would fail it wrongly.
5. `.github/workflows/check-frontend.yml`: a `node --check` step for every new
   file under `tires/js/`.
6. Every `/js` reference inside `tires/` carries a `?v=` stamp, bumped by hand
   on each change, exactly as the root site does.

`home/` pages are not in `scripts/build-footer.mjs` and neither are these: a
vertical carries its own footer. Copy the markup, do not import the generator.

**OWNER step:** import the repo as a new Vercel project on the Whollar team,
Root Directory `tires`, Framework `Other`, no build command.

---

## 2. Port the landing canvas

`scripts/port-tires.mjs`, following `scripts/port-landing.mjs` section for
section. What that script does, and what this one must do too:

1. **Assets to files.** The canvas points at `./assets/`, `./uploads/` and 7
   local sources. Decode them into `tires/images/` and `tires/fonts/`, and
   re-encode the PNGs to WebP the way the landing port did (7.7 MB became
   2 MB there). The 23 MB directory must not reach a deploy: the design source
   stays in the repo and goes in `.vercelignore`, like
   `Landingpagedesignstructure`.
2. **Resolve the canvas syntax.** Every `sc-if` becomes a real element or is
   unwrapped, `style-hover` becomes deduped CSS rules, `{{ }}` bindings are
   resolved or become `data-` hooks, `<sc-*>` elements are replaced. The port
   throws if any survives, which is what stops a half-port from shipping.
3. **Re-implement the behaviour as a classic script** in `tires/js/tires.js`.
   The canvas has a live counter ("Friends joined", "Simulate a friend
   joining") which is demo behaviour: decide whether it becomes a real count
   from `GET /tire-count` (section 6) or is cut. A fake counter on a
   production page is a claim about how many people joined.
4. **Vocabulary pass**, as in decision 2 above, with the same throw-on-miss
   count the landing port uses.
5. **Metadata.** Canonical `https://tires.whollar.ca/`, og and twitter with the
   produced image, `Organization` JSON-LD whose `@id` points at the umbrella's
   `https://www.whollar.ca/#org` (one organisation, many hosts), and a
   `Service` node for the vertical.

**CTAs on the landing page:**

| Button | Goes to |
|---|---|
| Join the winter tire cohort (nav, hero, sticky) | `/join` on this host |
| See how it works | `#how` on this page |
| The Whollar wordmark | `https://www.whollar.ca/` |

Same-host `/join` on purpose: it keeps the form same-origin with the
vertical's own CSP and gives the backend one new origin to allowlist instead
of two.

---

## 3. Port the waitlist

`whollar-waitlist-tyre.html` is already a plain page with no canvas runtime,
so this is a move and a rewire rather than a port: copy it to `tires/join.html`,
lift the inline `<script>` into `tires/js/tire-join.js` (the repo serves no
page-level inline logic that CI cannot `node --check`), and:

- Load `js/whollar-core.js` for `W.submitForm`, `W.parsePostal` and
  `W.consentPayload`. Copy it into `tires/js/` and add a `cmp` step to
  `check-frontend.yml` holding it byte-identical to the root copy, the way
  `home/` does. A copy that drifts is a second implementation.
- Replace the three demo behaviours (section 8).
- Keep the four calculators exactly as they are. They run entirely on the
  client, they are the reason someone picks the guided path, and their
  disclaimers are already written honestly.
- Mirror the server's validation in the page, in its own words, so a 400 never
  surfaces raw. The route below requires first name, last name, a valid email,
  a readable 10-digit phone and a real FSA.

---

## 4. What the form collects

Both paths, as drawn. This is the inventory the tables in section 5 are built
from.

**Identity (quick and guided stage 1):** first name, last name, email, mobile,
postal code, city, preferred language, email consent (required), SMS consent,
share-with-installers consent, and on the guided path a checkbox that adds the
household to the internet cohort too.

**Vehicle (quick, and guided stage 2):** an input mode of vehicle / tire size /
VIN / not sure, then year, make, model, or a size string, or a VIN. Plus
whether they run winter tires today, whether they already own winter rims, and
the winter-versus-all-weather answer the strategy tool produced.

**Needs and preferences (guided stages 2 and 3):** what applies (nine chips,
multi), tier, brand openness, install date windows (eight chips plus "any"),
a not-before date and a must-be-on-by date, installer type, closer to home or
work, whether install and storage may be split, budget band, financing
interest, memberships (seven chips, multi), what matters most (five chips,
pick two), readiness, and a free-text note.

**Tool runs:** the insurance estimator (premium, insurer), the size tool
(current size), the rims calculator (TPMS, years, who swaps) and the strategy
tool (tire life, ownership horizon, driving, storage). Inputs and the answer
each produced.

---

## 5. The Catalyst tables

**Three required, two optional.** These are lead tables owned by the
`formSubmit` function, not auth tables, so they follow the convention of
`WaitlistSignups` and `BillCheckupSubmissions`: **PascalCase table names and
PascalCase columns.** That is deliberately different from the
`lower_snake_case` rule at the top of `catalyst-backend/scripts/create-tables.md`,
which governs the auth tables in that document. Getting this wrong fails at
runtime, not at deploy.

Add them to `create-tables.md` as section 35. Create in **Development** first.
Never create `ROWID`, `CREATEDTIME`, `MODIFIEDTIME` or `CREATORID`: Catalyst
adds those. Turn on the PII validator on every column marked PII, at creation
time, because it cannot be applied retroactively.

### 5a. `TireWaitlistSignups` (required)

One row per person. The row every other tire table points back at.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `ReferenceCode` | Var Char | 24 | YES | YES | | `WHL-TIRE-GTA-XXXX`, minted by the server, never by the browser. The unique flag is the race guard |
| `Email` | Var Char | 254 | | YES | YES | lowercased, the join key everywhere in this backend |
| `FirstName` | Var Char | 120 | | YES | YES | |
| `LastName` | Var Char | 120 | | YES | YES | |
| `Phone` | Var Char | 20 | | | YES | digits only, matching `WaitlistSignups.Phone` |
| `FSA` | Var Char | 3 | | YES | | first three of the postal code |
| `PostalFull` | Var Char | 7 | | | YES | tires are installed at an address, so the full code earns its place here |
| `City` | Var Char | 40 | | YES | | `gta`, `ottawa`, `calgary`, `edmonton`, `montreal`, `vancouver`, `other` |
| `Path` | Var Char | 12 | | YES | | `quick` or `guided`. The one number that says whether the tools earn their build |
| `Source` | Var Char | 24 | | YES | | `tires-site` here, `umbrella-join` for a household that came through `home/join.html`. This is what keeps decision 3 honest |
| `Language` | Var Char | 5 | | | | `en` or `fr` |
| `ReferralCode` | Var Char | 64 | | | | as typed, a code or a neighbour's email |
| `ConsentEmail` | Var Char | 5 | | YES | | `true` or `false`. Catalyst offers no boolean type |
| `ConsentSms` | Var Char | 5 | | | | |
| `ConsentShare` | Var Char | 5 | | | | share details with matched installers |
| `AlsoInternet` | Var Char | 5 | | | | the internet cohort checkbox |
| `ConsentText` | Text | 4000 | | YES | | the exact sentence agreed to. CASL needs what, when and where, and the checkbox state alone proves none of it |
| `ConsentAt` | DateTime | - | | YES | | |
| `SubmittedAt` | DateTime | - | | YES | | |

### 5b. `TireWaitlistVehicles` (required)

One row per car. Separate because the confirm screen offers "Got another car?
Add it to the waitlist for its own spot", and because a tire cohort is sized
by tire size, not by household.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `VehicleKey` | Var Char | 40 | YES | YES | | `${ReferenceCode}:${n}`. Unique is what makes a double submit one row, and what makes "add another car" idempotent |
| `ReferenceCode` | Var Char | 24 | | YES | | the link back to 5a. The Data Store has no joins, so this is read as a filter |
| `Email` | Var Char | 254 | | YES | YES | denormalised for the same reason |
| `InputMode` | Var Char | 10 | | YES | | `vehicle`, `size`, `vin` or `unsure` |
| `VehicleYear` | Var Char | 4 | | | | |
| `VehicleMake` | Var Char | 40 | | | | |
| `VehicleModel` | Var Char | 60 | | | | |
| `Vin` | Var Char | 17 | | | YES | identifies a specific car, so it is PII |
| `TireSize` | Var Char | 20 | | | | as typed, e.g. `225/45R17` |
| `SizeNormalized` | Var Char | 20 | | | | parsed and canonical. This is the column a cohort is actually sized on, so it is separate from what they typed |
| `Strategy` | Var Char | 12 | | | | `winter`, `allweather`, or empty when the tool was not run |
| `RunsWinterNow` | Var Char | 10 | | | | `every`, `some`, `never` |
| `OwnsRims` | Var Char | 10 | | | | `alloy`, `steel`, `no` |
| `SubmittedAt` | DateTime | - | | YES | | |

### 5c. `TireWaitlistDetails` (required)

One row per signup, written only by the guided path. Columns for what a
cohort is actually built from, one payload for the rest, so a new question on
the form is not a schema change.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `ReferenceCode` | Var Char | 24 | YES | YES | | one details row per signup |
| `Email` | Var Char | 254 | | YES | YES | |
| `Needs` | Var Char | 255 | | | | comma list: `tires,package,mount,install,swap,align,disposal,storage,oil` |
| `Tier` | Var Char | 12 | | | | `recommend`, `premium`, `mid`, `value` |
| `Brand` | Var Char | 12 | | | | `open`, `name`, `specific` |
| `Budget` | Var Char | 12 | | | | `u800`, `800`, `1100`, `1500`, `open` |
| `Financing` | Var Char | 8 | | | | `yes`, `maybe`, `no` |
| `InstallerType` | Var Char | 16 | | | | `any`, `independent`, `bigbox`, `dealer`, `mobile` |
| `Anchor` | Var Char | 8 | | | | `home`, `work`, `either` |
| `SplitPreference` | Var Char | 12 | | | | `prefer`, `dontmind`, `one` |
| `InstallWindows` | Var Char | 255 | | | | the chosen date chips, or `any` |
| `NotBefore` | Var Char | 10 | | | | `YYYY-MM-DD`. Var Char, not DateTime: it is a date with no time and nothing sorts on it |
| `MustBeOnBy` | Var Char | 10 | | | | as above. Nov 1 is the usual insurance target |
| `Memberships` | Var Char | 255 | | | | `costco,caa,triangle,club,employer,cc,none` |
| `Priorities` | Var Char | 120 | | | | up to two of `price,early,brand,close,rep` |
| `Readiness` | Var Char | 10 | | | | `ready`, `likely`, `watch` |
| `Notes` | Text | 4000 | | | YES | free text, so treat it as PII: people put addresses and phone numbers in these |
| `Payload` | Text | 10000 | | | | everything the form asked that has no column above, verbatim JSON |
| `SubmittedAt` | DateTime | - | | YES | | |

### 5d. `TireToolRuns` (optional, ship without it)

The four calculators, inputs and answer. Worth having because it says what
people are unsure about, which is what decides whether the guided path keeps
earning its build. Nothing breaks without it: the route writes the same values
into `TireWaitlistDetails.Payload` when the table is absent.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `RunKey` | Var Char | 40 | YES | YES | | `${ReferenceCode}:${Tool}` |
| `ReferenceCode` | Var Char | 24 | | YES | | |
| `Tool` | Var Char | 12 | | YES | | `insurance`, `size`, `rims`, `strategy` |
| `InputJson` | Text | 2000 | | YES | | what they answered |
| `OutputJson` | Text | 2000 | | YES | | what we told them. Keep it: it is what we said, on a date, about money |
| `RanAt` | DateTime | - | | YES | | |

### 5e. `TireCohortCounter` (required only if the rank pill ships)

See section 8. An honest "you are number N" cannot be produced by counting
rows: ZCQL refuses any `LIMIT` over 300, which is why `/pooling-count` reports
`300+` rather than a number. A counter row is the only honest way to show a
rank.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `CounterKey` | Var Char | 64 | YES | YES | | `tires:<city>` |
| `Vertical` | Var Char | 16 | | YES | | `tires` |
| `City` | Var Char | 40 | | YES | | |
| `Joined` | Int | 10 | | YES | | incremented on each accepted signup |
| `UpdatedAt` | DateTime | - | | YES | | |

### 5f. Gate checks, in the ZCQL tab

```sql
SELECT ROWID FROM TireWaitlistSignups LIMIT 1;
SELECT ROWID FROM TireWaitlistVehicles LIMIT 1;
SELECT ROWID FROM TireWaitlistDetails LIMIT 1;
```

Then submit the guided path once on a preview and confirm one row in each,
with the same `ReferenceCode` in all three. Run the same insert twice by hand
against `TireWaitlistVehicles`: the second must fail. If it does not,
`VehicleKey` was created without Unique, and a double submit will duplicate
the car.

---

## 6. The backend route

One route in `catalyst-backend/functions/formSubmit/index.js`, next to
`/waitlist-join`:

```
POST /tire-waitlist-join
```

- Rate limit `{ key: 'tire-waitlist-join', max: 20, windowSec: 3600 }`, same
  as the other waitlist routes.
- Validate first name, last name, email (`isEmail`), phone (`normalizePhone`)
  and postal (`normalizePostal`) before touching the Data Store, returning the
  same shape of message the page will show.
- Mint `ReferenceCode` server side. `WHL-TIRE-<CITY3>-<4 chars>` from the
  same alphabet the prototype uses, retried on a unique-constraint collision.
- Insert 5a, then 5b for each vehicle, then 5c when the guided path sent
  details, then 5d per tool run if that table exists.
- `enqueueCrm` with `leadType: 'consumer'` and a payload carrying
  `pooling_for: 'tires'`, so a tire household lands on the same CRM record
  shape as one that came through `home/join.html`. The `Whollar_Pooling_For`
  field work is already owed and tracked; this lane inherits it rather than
  adding to it.
- Return `{ ok: true, reference, rank }`, and nothing else. No PII in the
  response.

Plus, only if the counter ships:

```
GET /tire-count?city=gta
```

Read-only, counts only, no PII, the same shape as `/pooling-count`.

---

## 7. Wiring, CORS and the domain

**The umbrella side.** In `home/index.html`, the Winter tires card's
`href="/join"` becomes `https://tires.whollar.ca/`, matching the internet card
directly above it. Change it in `scripts/port-landing.mjs` too, in the `CTAS`
map, or the next regeneration silently reverts it. Add the host to
`home/llms.txt`. Point the buttons and the step link on
`home/join-welcome-tires.html` at the vertical.

**CORS, all four places, in this order.** A form that posts from a host
missing from any one of them fails with "we couldn't reach our servers", which
reads as the page being broken:

1. The Catalyst console CORS rule for the project.
2. `GATEWAY_CORS_ORIGINS` on both functions.
3. The `ALLOWED_ORIGINS` array in `formSubmit/index.js` (hardcoded, not an env
   var).
4. The `ALLOWED_ORIGINS` env var on the auth function, only if the vertical
   ever calls `/api/auth/*`. As designed it does not.

Probe it without a browser before believing it works, always with a known-good
origin in the same run as a control:

```
curl -s -o /dev/null -D - -X POST <fn-url>/tire-waitlist-join \
  -H "Origin: https://tires.whollar.ca" | grep -i access-control-allow-origin
```

Absent means blocked.

**The domain. OWNER steps:** attach `tires.whollar.ca` to the new Vercel
project; at IONOS add `CNAME tires -> cname.vercel-dns.com`; wait for Valid
Configuration. Then verify 200 on `/`, `/join`, `/robots.txt`, `/sitemap.xml`
and a 404 on a junk path, and run the curl matrix in
`docs/DOMAIN_CUTOVER_RUNBOOK.md` step 4 against the host. Add the property in
Search Console and submit the sitemap.

---

## 8. What is demo data and must not ship

The prototype is honest about being a prototype. Three things in it are
fabricated and each has to be made real or cut:

1. **The rank.** `GTA_BASE = 1847` plus a random number, printed as "You're
   #1,848 in the GTA cohort". It is a claim about how many people joined.
   Either back it with `TireCohortCounter` (5e) or replace the pill with the
   copy the confirm screen already has: "Your vote is counted."
2. **The reference code.** Generated in the browser from `Math.random`, so two
   people can hold the same one and nothing can be looked up by it. The server
   mints it (section 6) and the page prints what came back.
3. **The submit.** `finish()` shows the confirm screen and posts nothing. The
   page currently tells someone "We just emailed it to you" when no email was
   sent and no row was written.

Also on the landing canvas: **"Simulate a friend joining"** and the friends
counter are demo controls. Cut the button. The counter either reads
`GET /tire-count` or goes with it.

---

## 9. Order of work

1. Decisions in section 0, especially the hostname spelling and the "group"
   rename. Everything downstream carries them.
2. `tires/` directory, `vercel.json`, gate registration, `.vercelignore`.
   **OWNER:** the Vercel project.
3. `scripts/port-tires.mjs` and `tires/index.html`. Review on a preview.
4. `tires/join.html` and `tires/js/tire-join.js`, still posting nothing.
   Review on a preview.
5. **OWNER:** create 5a, 5b and 5c in the Catalyst console, Development.
6. The route in section 6, deployed to the Catalyst Development environment,
   then CORS, then the page wired to it. Verify with the section 5f checks.
7. The umbrella card and the welcome screen point at the vertical.
8. **OWNER:** DNS, then the go-live checks in section 7.

Steps 3 and 4 are reviewable on the staging alias before any of the backend
work exists, so the design can be signed off in parallel with the table
creation.
