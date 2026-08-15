# TASK: Ship the Whollar Partner Console (v12) into the repo — EXACT copy, zero redesign

## 0. The one rule that overrides everything else

You are NOT designing or rebuilding this UI. A finished, working, single-file prototype
already exists: **`provider-console-v12.html`** (236,298 bytes, 3,071 lines,
md5 `7eb2ec0310818b50ae50ef5b78954c08`). It accompanies this prompt.

- **Transplant it. Do not regenerate it.** Copy the file byte-for-byte into the repo.
  Do not re-type it, do not let a formatter touch it, do not "clean it up", do not
  convert it to React/Vue/components, do not swap fonts, do not rename variables,
  do not rewrite any copy text, do not reorder CSS.
- If this markdown arrived without the HTML file, STOP and ask for the file.
  Never reconstruct it from memory or from screenshots.
- After copying, verify: `md5sum` must equal `7eb2ec0310818b50ae50ef5b78954c08`.
  If it doesn't, you modified it — revert and copy again.

Past attempts failed because the file was re-generated instead of copied. The visual
identity (Bricolage Grotesque display / Inter body / Space Mono data, the
cream-paper + forest + gold palette, the 264px collapsible pane, the stage rails,
the drawer bid tickets) is all already encoded in the file. Any regeneration loses it.

## 1. Where it goes in the repo

1. Place the file at the path currently served as the partner console
   (replacing/сsuperseding `provider-dashboard.html`), keeping the old file as
   `provider-dashboard.legacy.html` until sign-off. If routing maps
   `/partner` or `/provider` to a file, point it at this one.
2. Keep it a **static, single-file page**. No build step. It has zero external JS
   dependencies — only Google Fonts CSS and inline SVG. Keep the
   `<link rel="preconnect">` + Google Fonts `<link>` exactly as-is.
3. The mobile twin convention (MobileVersion/) does NOT apply yet — do not generate
   a mobile twin for this file; it already handles ≤940px itself (off-canvas pane,
   stacked grids). Ship desktop file only.
4. Do not add analytics, meta tags, or scripts to the file in this task.

## 2. What the file IS (architecture map — read before touching anything)

Single IIFE, `"use strict"`, vanilla JS, ES5-style. Understand these before any edit:

### 2.1 Design tokens (CSS `:root`)
`--ink #17211B, --forest #12372B, --forest2 #1E5741, --gold #C29B3C,
--gold-deep #A8842B, --gold-soft #F5EAD2, --tint #E3EDE6, --tintb #CBDCCE,
--paper #F1EDE2, --card #FCFAF5, --line #E1DBCB, --sub #5B655C,
--win #1E5741, --lose #8C4622, --lose-soft #F2E3D6`.
Fonts: `--disp` Bricolage Grotesque, `--body` Inter, `--mono` Space Mono.
Pane widths: `--panew 264px`, `--panec 78px`. Mobile breakpoint: **940px**.
These values are law. Never substitute.

### 2.2 App frame
`.app` = CSS grid `[pane | main]`; `.collapsed` narrows the pane; ≤940px the pane
becomes a fixed off-canvas drawer with `.paneopen` + `#overlay`. Views are
`section.view[data-v]` toggled by `nav(v)`; left-nav buttons carry `data-view`,
and any element with `data-nav` navigates (global delegated click handler).
`document.body.gated` hides pane+search for the pre-approval "Under review" frame.

### 2.3 Virtual clock & stage machine
`NOW0 = Date.now()` at load, `NOWOFF` advanced by prototype controls
(+3h / +7d). `now() = NOW0 + NOWOFF`. `snap(days,hour)` builds campaign
timestamps relative to load time — this is why the demo always has a live
countdown. `stageOf(c)` derives one of 5 stages
(`Announced / Open / Closing / Offers out / Decided`) purely from
`c.t.{announce,open,close,offers,decide}` vs `now()`; "Closing" = within 24h of
close. A 1s `tick()` updates every `[data-until]` countdown and calls
`renderAll()` only when the stage signature `sig()` changes.

### 2.4 State
- `S` — partner-side session state: `stage` ('day1'|'motion'), `fee` (success fee,
  default 95), `bids{cohortId: bidObject}`, `tasks{cov,terms,pay,brief,bid}`,
  `planOpen`.
- `P` — journey state: `stage` ('active'|'pending'), `payIssue`, `intent{}`,
  `res{}` (won/lost override), `gate{}` (roster released), `cap` (installs/wk),
  `rosters{}`, `rosterMeta{}`, application fields (`app`, `appCov`, `appDone`,
  `appView` 'frame'|'tasks', `appDoneAt`, `ptasks`, `docs`).
- Data constants: `CAMPAIGNS` (single source of truth; 4 live + 2 planned cohorts),
  `HBIDS` (historical bids), `MONTHS` (12-mo chart), `COVER` (regions), plus
  `TIEROPTS/TECHOPTS/SUGG/SUGGUP/SUGGSTICKER/MECHLBL`.

### 2.5 Render pipeline
Pure render functions write innerHTML from state: `renderTasks, renderOverviewBits,
renderOvLive, renderAgenda, renderDesk, renderPlanned, renderPlan, renderBids,
renderBilling, renderCov, renderDelivery, renderPerf, renderContracts,
renderPending, renderBanner, renderAcq, renderMotionCharts`.
`renderAll()` is **extended by reassignment** (`var _renderAll=renderAll;
renderAll=function(){_renderAll(); ...}`) — an intentional decorator chain.

### 2.6 ⚠️ Version layering — the thing you must NOT "fix"
The script contains sections labelled `v4 … v12 overrides`. Later sections
**redeclare the same functions** (`briefHTML`, `ticketHTML`, `readTicket`,
`scnCalc`, `tierRowHTML`, `seedRoster`, `rosterStats`, `renderDelivery`,
`renderBilling`, `renderContracts`, `renderPending`, `renderPerf`,
`renderOvLive`, `renderTasks`…). Because function declarations hoist, **the last
declaration wins** — that is the design. Some listeners are registered in the
**capture phase** (`addEventListener(..., true)`) precisely to pre-empt older
bubbling listeners (tier add-row, tier-name change).
**Do not deduplicate, merge, reorder, or delete "earlier versions" of these
functions.** Any such cleanup silently changes behavior. Treat the file as
append-only history.

### 2.7 Scenario engine (the demo's spine)
`SCEN` = 14 scenarios, each `[key, label, mutator]`; every mutator calls `base()`
(full reset incl. `restoreCover()`) then mutates `S`/`P`/`NOWOFF`. `SCENNAV`
routes each scenario to a landing view; sealed/offersout/won/lost auto-expand the
`kw` (Scarborough East) drawer row. Prototype controls panel (`#ctl`) exposes:
scenario grid, success-fee input, +3h / +7d clock, reset.
Scenario keys: `pending, review, first, ready, announced, open, sealed,
offersout, won, lost, delivery, reconcile, motion, payfail`.

### 2.8 Key interactive flows (all already working — verify, don't rewrite)
- **Application**: pending frame → "Complete your application" → dashboard task
  list (PTASKS: coverage / registration / documents / agreement / reference),
  each opening a modal (`openPendModal`); completing all five flips
  `appDoneAt` and returns to the review frame with the 48h clock.
- **Bid ticket** (v10+): tier table with **Sticker /mo + Effective /mo + After**
  columns (max 4 rows, add/remove, per-tier tech & upload, auto-suggest prices
  on tier change), "how the reduction reads" mech selector (member discount /
  promo credit / cashback / none / custom text), guarantee 12/24/36, equipment
  (included / rental / BYOD) + pod pricing, service commitment cap, consent
  checkbox gates the **Place sealed bid** button, `readTicket` validates
  effective ≤ sticker, live scenario table in the brief column blends tier
  prices by cohort speed-demand and caps at commitment.
- **Delivery / OM board**: states `acc/bkd/act/noshow/access/linefail/rel`,
  exception-first sort (`RANK`), SLA labels, mark-activated → billing accrues,
  can't-serve release modal ($0), capacity input, logistics/CPE + RMA cards,
  settled variant.
- **Billing**: per-campaign statements (`stmtLive`) — success fees × $fee,
  $25 no-show pass-through credits, held line-fail fees, 13% HST, net-15 total;
  `stmtSettled` adds the early-churn clawback line.
- **Search** (`#q`): live dropdown over campaigns, Enter opens best match's plan.
- **ICS export** per campaign; **CSV export** of the bid record.
- `window.__whollar` debug handle exposes `S`, `P`, `COVER`, `renderDesk`,
  `renderAll` for scripted QA.

## 3. Acceptance checklist (run ALL before declaring done)

Open the file in a browser and verify, using the Prototype controls panel:

1. `md5sum` of the deployed file = `7eb2ec0310818b50ae50ef5b78954c08`.
2. All 14 scenario buttons render without console errors and land on the view
   named in `SCENNAV`.
3. "Application · in progress": body is gated (no left pane), "Complete your
   application" → task dashboard; finishing all 5 modals returns to the review
   frame and toasts the 48h clock.
4. "First login": overview shows the 5-step activation card at 1 of 5; declaring
   a region on Coverage ticks step 1 everywhere.
5. "Bidding open": Scarborough East drawer opens; consent checkbox enables
   "Place sealed bid"; placing seals, toasts, updates My bids; "Improve bid"
   reopens the ticket. Terms not accepted → button reads
   "Accept the standard terms to bid".
6. Tier table: add caps at 4 rows, remove works, changing tier auto-fills
   sticker/effective/upload/after; effective > sticker blocks with the toast.
7. Countdown chips tick every second; "+3 hours" collapses the Scarborough
   countdown correctly; "+7 days" moves stages (Announced→Open→…); calendar,
   desk rails, and plan view all move together.
8. "Won, roster gated": billing-setup gate modal (add card + capacity + consent)
   releases the roster to Delivery.
9. "Delivery window": OM board shows the exception mix (1 no-show, 1 access,
   1 line-fail per seed), rebooking/activating updates tiles and Billing accrual.
10. "Reconciliation" and "Long-running partner": statements show HST math,
    held lines, and the settled statement with clawback; Performance shows the
    four-tile historical view; overview switches to the "motion" tiles + chart.
11. "Payment issue": red banner renders, desk bid buttons read
    "Bidding paused · billing issue".
12. ≤940px: pane becomes off-canvas via burger + overlay; grids stack; drawer
    grid stacks brief above ticket.
13. `prefers-reduced-motion`: no animations, ticker interval not started.
14. ICS download and CSV export both produce files.

## 4. Explicitly forbidden

- Converting to React/Next/components, adding a bundler, or splitting the file.
- Running Prettier/ESLint --fix or any formatter on it.
- Deduplicating the v4–v12 function redeclarations (see §2.6).
- Changing fonts, colors, spacing, copy, icon SVGs, or the favicon data-URI.
- Adding frameworks "for maintainability". Maintainability here = the file's
  own override-layer convention: **new behavior goes in a new
  `/* ===== v13 additions ===== */` block appended before `/* boot */`,
  overriding by redeclaration**, exactly like v5–v12 do.

## 5. Only after the checklist passes — optional prod hardening (separate commit)

If asked to prep for production (do NOT do this unasked):
- Gate the Prototype controls behind `?demo=1` (hide `#ctl-toggle`/`#ctl`
  otherwise). One small v13 block; no other edits.
- Auth guard: the page must sit behind the existing partner session
  (whollar_session cookie via `js/whollar-core.js`); server must enforce
  `approved` — the front end alone is not the boundary.
- Future data wiring replaces ONLY the seed constants (`CAMPAIGNS`, `COVER`,
  `S.tasks`, `P.*`) from a boot endpoint returning the same shapes; every render
  function stays untouched. The API contract for that lives in
  `catalyst-schema-and-implementation.md` (separate doc).

## 6. Definition of done

- File deployed at the partner-console route, md5-verified.
- Checklist §3 fully passed, with a short written QA log (scenario → result).
- Legacy file preserved as `.legacy.html`.
- No other files in the repo modified except routing and the legacy rename.
