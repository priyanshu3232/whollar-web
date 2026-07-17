# Whollar → Zoho Catalyst backend

This folder is a self-contained [Zoho Catalyst](https://catalyst.zoho.com) project. It has two
Advanced I/O functions:

- **`formSubmit`** — receives every form submission from the marketing site (waitlist join,
  waitlist add-on details, bill-checkup waitlist joins, deep-read requests, partner applications)
  and stores them in Catalyst's Data Store (and File Store, for attached bills). It replaces the
  `console.log('[whollar-... placeholder]', ...)` stubs in the site's HTML with real `fetch()` calls.
- **`billOcr`** — OCRs the bill a household attaches on the checkup tool (via Catalyst's Zia OCR)
  and calls Claude to extract structured fields (provider, speed, access tech, promo date,
  amounts), so the checkup form can auto-fill itself instead of making the household retype
  everything from the bill they just uploaded.

It does **not** touch the "Become a founding member" form under `Become_a_founding_member_of_Whollar/`
— that one already submits live to Zoho Forms and was left as-is.

---

## Current status (as deployed)

- **Project:** `Whollar` (`1258000000014001`), org `hubcart99` (`110003037934`), data center **CA**.
- **Environment:** deployed to the **Development** environment and end-to-end tested. All five
  `formSubmit` routes insert correctly, including file uploads to File Store. `billOcr` is deployed
  but needs `ANTHROPIC_API_KEY` set before the bill auto-fill works (see §5).
- **Live function base URL** (baked into the three HTML pages' `CATALYST_BASE`):
  `https://whollar-110003037934.development.catalystserverless.ca/server/formSubmit`
- **File Store folder ID** in use: `1258000000015979` (set as `UPLOADS_FOLDER_ID` in `formSubmit/index.js`).
- **CORS allowlist** (in both functions' `ALLOWED_ORIGINS`): `https://whollar.ca`,
  `https://www.whollar.ca`, `http://localhost:3000`.

Because this is the **development** environment, submissions currently land in the *dev* copies of
the tables. See **Going to production** at the bottom before pointing the live whollar.ca site at it.

### Schema gotchas we hit (so they don't bite again)
- Data Store column names must match the code **exactly** (case-sensitive). A `BillField` typo
  and a duplicate `DonwloadSpeed` in `WaitlistDetails` both caused silent insert failures until
  corrected to `BillFileId` / `DownloadSpeed`.
- Only the columns marked "required" below should have Catalyst's **IsMandatory** validator on.
  `ReferralCode` was accidentally set mandatory, which made every referral-less signup fail.
  Keep every non-required column **optional**.

---

## 1. One-time account setup

1. Sign in at [catalyst.zoho.com](https://catalyst.zoho.com) and create a new project (e.g. `whollar`).
2. Install the CLI and log in:
   ```
   npm install -g zcatalyst-cli
   catalyst login
   ```
3. From this folder (`catalyst-backend/`), link the CLI to your project:
   ```
   catalyst init
   ```
   Choose "link an existing project" and pick the project you just created. When it asks which
   components to set up, choose **Functions only** — the frontend keeps living wherever it's
   hosted today (do not let it scaffold a `client/` folder).

## 2. Create the Data Store tables

In the Catalyst console: **Cloud Scale → Data Store → Create Table**. Catalyst tables aren't
defined as code, so create these five tables and columns by hand once. `Text` = up to 10,000
characters, `Var Char` = up to 255. Every column below should allow nulls unless marked required.

### WaitlistSignups
| Column | Type | Notes |
|---|---|---|
| FirstName | Var Char | required |
| LastName | Var Char | required |
| Email | Var Char | required |
| Phone | Var Char | required |
| FSA | Var Char | required |
| ReferralCode | Var Char | |
| SubmittedAt | DateTime | |

### WaitlistDetails
| Column | Type | Notes |
|---|---|---|
| Email | Var Char | required — links back to WaitlistSignups.Email |
| FSA | Var Char | |
| Provider | Var Char | |
| MonthlyCost | Double | |
| DownloadSpeed | Var Char | |
| PromoEndDate | Var Char | stored as the raw `YYYY-MM-DD` string from the date input |
| SwitchThreshold | Var Char | |
| Services | Text | JSON array, e.g. `[{"service":"ott","count":2,"detail":null}]` |
| BillFileId | Var Char | Catalyst File Store file ID, if a bill was attached |
| BillFileName | Var Char | original filename |
| SubmittedAt | DateTime | |

### BillCheckupSubmissions
| Column | Type | Notes |
|---|---|---|
| Email | Var Char | required |
| Via | Var Char | `rail` (quick-join widgets) or `form` (main check flow) |
| PostalFSA | Var Char | |
| Provider | Var Char | |
| MonthlyCost | Double | |
| DownloadSpeed | Var Char | |
| AccessTech | Var Char | |
| PromoEndDate | Var Char | raw `YYYY-MM-DD` |
| MonthsToRenewal | Int | |
| PromoExpired | Boolean | |
| DiscountAmount | Double | |
| SwitchThreshold | Var Char | |
| BillFileId | Var Char | |
| BillFileName | Var Char | |
| SubmittedAt | DateTime | |

### DeepReadRequests
| Column | Type | Notes |
|---|---|---|
| Email | Var Char | required |
| Note | Text | |
| FileIds | Text | JSON array of File Store IDs |
| FileNames | Text | JSON array of original filenames |
| ContextSnapshot | Text | JSON snapshot of the checkup answers at time of request |
| SubmittedAt | DateTime | |

### PartnerApplications
| Column | Type | Notes |
|---|---|---|
| Role | Var Char | required — `provider` / `sales` / `distributor` / `other` |
| FirstName | Var Char | required |
| LastName | Var Char | required |
| Company | Var Char | required |
| Email | Var Char | required |
| Phone | Var Char | required |
| Provinces | Text | JSON array |
| AccessTech | Text | JSON array |
| LegalName | Var Char | |
| ProviderType | Var Char | |
| BusinessNumber | Var Char | |
| Brands | Var Char | |
| Signatory | Var Char | |
| RepresentsBrands | Var Char | |
| LOA | Var Char | |
| OtherType | Var Char | |
| Note | Text | |
| SubmittedAt | DateTime | |

## 3. Create the File Store folder (for bill attachments)

**Cloud Scale → File Store → New Folder**, e.g. `whollar-uploads`. Open it and copy its numeric
folder ID from the URL or the folder details panel. Paste it into
`functions/formSubmit/index.js` as `UPLOADS_FOLDER_ID`. Until this is set, the forms still submit
successfully — attached files are just skipped (the rest of the row still saves).

> **Done for the dev environment** — `UPLOADS_FOLDER_ID` is `1258000000015979`, verified against a
> real upload: `uploadFile()` returns the file ID under `.id`, which `storeFile()` already reads.
> The uploaded bill also needs disk-based multer (not memory) — the SDK derives the multipart
> filename from the stream's `.path`, which only an `fs.ReadStream` has, so the function writes
> uploads to `/tmp` and streams them up, deleting the temp file afterward.
> **For production you'll create a new folder** in the production environment and repeat this.

## 4. Allow the site's domain to call the function (CORS)

**Cloud Scale → Authentication → Authorized Domains** — add the domain(s) the site is served
from (e.g. `https://whollar.ca`, `https://www.whollar.ca`) and enable CORS for each.

The function also sets its own `Access-Control-Allow-Origin` header from an allowlist in code —
edit `ALLOWED_ORIGINS` at the top of `functions/formSubmit/index.js` to match the same domains.
Both need to agree, or browsers will still block the request.

## 5. Set the Anthropic API key for `billOcr`

`billOcr` calls the Claude API to turn raw OCR text into structured fields. In the Catalyst
console: **your project → `billOcr` function → Environment Variables**, add `ANTHROPIC_API_KEY`
with your key. Don't put the key in `catalyst-config.json` — that file is committed to the repo.

## 6. Install dependencies and deploy

```
cd functions/formSubmit && npm install && cd ../..
cd functions/billOcr && npm install && cd ../..
catalyst deploy
```

After deploying, each function is reachable at:

```
https://<your-project-domain>.catalystserverless.com/server/formSubmit
https://<your-project-domain>.catalystserverless.com/server/billOcr
```

(Find `<your-project-domain>` in the Catalyst console under Project Settings, or in the deploy
output.) There's also a `.development.catalystserverless.com` variant for the dev environment —
useful for testing before you point the live site at production.

## 7. Point the frontend at your deployed functions

`whollar-bill checkup-v6.html` has two base-URL constants near the top of its `<script>` block —
`CATALYST_BASE` (formSubmit) and `BILL_OCR_BASE` (billOcr, derived from `CATALYST_BASE`). Replace
the `CATALYST_BASE` placeholder with your real base URL from step 6 and `BILL_OCR_BASE` updates
with it automatically.

`waitlist/index.html` and `whollar-partner-v6.html` only talk to `formSubmit` — same
`CATALYST_BASE` constant, no change needed there. Grep for `CATALYST_BASE` to find each spot.

## Routes

### `formSubmit`

| Method | Path | Used by |
|---|---|---|
| POST | `/waitlist-join` | Waitlist page, stage 1 (name/email/phone/postal code) |
| POST | `/waitlist-details` | Waitlist page, stage 2 (optional add-on details + bill attachment) |
| POST | `/bill-checkup-join` | Bill checkup tool, all "join the waitlist" entry points |
| POST | `/deep-read` | Bill checkup tool, "send me a deep read" |
| POST | `/partner-application` | Partner application form |

All routes return `{ ok: true, id }` on success (`id` is the new row's `ROWID`) or
`{ ok: false, error }` with a 4xx/5xx status on failure.

### `billOcr`

| Method | Path | Used by |
|---|---|---|
| POST | `/extract-bill` | Bill checkup tool, "Shortcut: attach your bill" upload |

Returns `{ ok: true, confidence, fields }` on success, where `fields` matches the checkup form's
`#prov`/`#cost`/`#spd`/`#tech`/`#pdate`/`#disc` values exactly (`null` for anything the model
wasn't confident about — the form just leaves that field blank), or `{ ok: false, error }` on
failure.

## Local testing

Serve the static site (from the repo root) and open a form page on **http://localhost:3000** —
that origin is already in the CORS allowlist, and the pages already point at the deployed dev
function, so a real submission from your browser lands in the dev tables:

```
npm start            # repo root — serves the site on :3000
```

To run a *function* locally instead (against the live project's Data Store / File Store — there's
no local emulator for those, so rows land in the real dev tables):

```
cd catalyst-backend/functions/formSubmit && npm install && catalyst serve
```

---

## Going to production

Everything above is deployed to the **Development** environment. Catalyst keeps Development and
Production fully separate (separate data, separate function URLs). The CLI (`catalyst deploy`)
**only ever deploys to Development** — there is no `--production` flag. Promotion is a console
action that *migrates your functions and Data Store schema* from dev to prod for you (you do **not**
hand-recreate the tables). To take this live on whollar.ca:

1. **Add a payment method.** Production requires billing enabled on the project.
2. **Click "Deploy to Production"** in the Catalyst console header. This migrates the functions and
   the Data Store table/column definitions from Development to Production. (New tables/functions
   can only be created in Development and then promoted — never directly in Production.)
3. **Re-set the per-environment config in Production**, since secrets and some resources don't carry
   over: set `ANTHROPIC_API_KEY` on the Production `billOcr` (§5), add whollar.ca to Production
   **Authorized Domains** (§4), and confirm the Production **File Store** folder ID — if it differs
   from the dev `1258000000015979`, update `UPLOADS_FOLDER_ID` and re-promote.
4. **Repoint the frontend.** In the three HTML pages, change `CATALYST_BASE` from the
   `...development.catalystserverless.ca...` URL to the Production one (the same URL **without** the
   `.development` segment). `BILL_OCR_BASE` in the checkup page derives from it automatically.
5. Submit one of each form on the live site and confirm rows appear in the **Production** tables.
