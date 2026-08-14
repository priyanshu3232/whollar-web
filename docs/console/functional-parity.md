# Functional parity: every prototype behaviour, and where it went

§9 of the integration brief is the "nothing may be dropped" checklist. **The
copy we hold is truncated at §9.3 B8**, mid bid-desk. Rows past that point are
reconstructed from `docs/prototype/provider-console-v12.html` itself, the same
method `render-inventory.md` used, and are marked **[R]**. A reconstructed row
is a behaviour the prototype demonstrably has; it is not a guess at what the
missing document said about it.

Status values: **done** shipped and covered by a gate or the QA suite;
**partial** shipped in one state but not all; **pending** not built, with the
view rendering an honest empty state; **dropped** deliberately not ported, with
the reason.

---

## 9.1 Frame and global

| # | Behaviour | Status | Where | Endpoint |
| --- | --- | --- | --- | --- |
| G1 | Collapsible pane, 264px to 78px, labels hidden when collapsed, `aria-expanded` correct | done | `app.js` burger handler, `app.css` `.app.collapsed` | — |
| G2 | Mobile drawer under 940px, slide in, dimmed overlay, closes on overlay click and on nav | done | `app.js`, `core/router.js` `paint()`, `app.css` media query | — |
| G3 | Greeting by time of day, org and region beneath | partial | `views/account.js` `paintChrome()` | 3 |
| G4 | Search over cohorts, min two characters, max six results, stage per result | pending | markup present, handler not wired | 31 |
| G5 | Search keyboard: Enter opens first, Escape closes, click outside closes | pending | — | 31 |
| G6 | Account reachable from pane profile and top-right avatar | done | both carry `data-action="nav"` | — |
| G7 | Toast, 2.4s, one at a time, replaces previous, `role="status"` | done | `core/toast.js` | — |
| G8 | Modal: Escape, backdrop, `[data-mclose]`, scroll lock, **plus focus trap and focus return** | done | `core/modal.js` | — |
| G9 | Countdown ticker, 1s, every `[data-until]`, from server time not `Date.now()` | done | `core/time.js` `startTicker()`, offset by `sync()` | 22 |
| G10 | `prefers-reduced-motion`: no ticker, no rise animation | done | `core/time.js` guards the interval; `app.css` media query | — |
| G11 | Payment failure alert bar above everything, on every view, with recovery route | partial | `components/banner.js` renders it; `state.billing` is never populated | 61 |
| G12 | Gated frame: pane and search hidden during review | done | `core/router.js` `setGated()`, `app.css` `.gated` | 6 |
| G13 | Two "Soon" nav items, visually disabled, not clickable | done | `partner/index.html`, `app.js` skips `.soon` | — |

G3 is partial for an honest reason: the region beneath the org name should be
the partner's primary coverage region, and picking "primary" out of a list with
no ordering column would be an invention. It shows the org name alone until
coverage carries a rank.

## 9.2 Overview

| # | Behaviour | Status | Where |
| --- | --- | --- | --- |
| O1 | Activation checklist, five steps | partial | `components/tasks.js` `activationTasks()` built; not yet wired, because two of its five steps (terms, payment) have no endpoint |
| O2 | Progress bar and "n of 5", becoming "5 of 5 · you're live" | done | `components/tasks.js` `progress()` |
| O3 | Application checklist variant, "n of 5 · review is running" | done | `components/tasks.js` `applicationTasks()` |
| O4 | Four application modals with their own validation and save | done | `views/application.js` |
| O5 | Automatic switch to the review frame at completion, with the toast | done | `views/application.js` `maybeSubmit()`, and server-side in `reread()` |
| O6 | "Your desk at a glance": open, sealed, results pending, next close | done | `views/overview.js` `desk()` |
| O7 | "Demand approaching" variant when nothing is open and nothing sealed | done | `views/overview.js` `demandApproaching()` |
| O8 | Upcoming list, four rows, label plus region plus date | done | `views/overview.js` `upcoming()` |
| O9 | Inline nudge naming which activation steps remain | pending | needs O1 |
| O10 | Auction calendar, five nearest events, today highlighted, countdown inside 24h, click opens the plan | pending | `views/overview.js` has the derivation in `upcoming()`; the calendar component is not built |
| O11 | "How auctions work", three rules | done | `views/overview.js` `howItWorks()` |
| O12 | Closing soon card, three variants | partial | the review-card variant is built; the two approved variants fold into O6 and O7 |
| O13 | Alert toggles, four, persisted per user | done | `views/account.js` | 65, 66 |
| O14 | Long-running variant: hero tiles, 12-month bar chart, funnel, activity feed | pending | every figure in it is one of the hardcoded numbers §2.3 forbids until a query exists |

## 9.3 Bid desk

| # | Behaviour | Status | Where |
| --- | --- | --- | --- |
| B1 | Open auctions table: cohort, households, stage rail, window, your bid, action | done | `views/desk.js` |
| B2 | Five-dot rail with past/now, gold when closing | done | `components/rail.js` |
| B3 | Countdown inline in the window cell inside 24 hours | done | `views/desk.js` `countdown()` |
| B4 | Locked rows for verifying coverage, "Verifies with {region} coverage", no action | done | `views/desk.js` `row()`; fixture `motion` covers it |
| B5 | Plan to bid toggle, "On your slate ✓", both toasts | pending | 27, 28 |
| B6 | Row expand and collapse into the drawer, one at a time | pending | the drawer is the ticket, below |
| B7 | Brief: households, renewal window, speed demand, plant mix, your coverage here, or "Not declared" in rust | pending | 24 |
| B8 | Estimated reachable households from declared plant | pending | 24 |

### Reconstructed from the prototype past this point

| # | Behaviour | Status | Prototype source |
| --- | --- | --- | --- |
| B9 **[R]** | Bid ticket: seven-column tier table (tier, upload, technology, sticker, effective, after, remove), up to four rows | pending | `ticketHTML` @2578 |
| B10 **[R]** | Tier add and remove, with suggested sticker, effective, upload and after per tier | pending | `tierRowHTML` @2566, `SUGG`/`SUGGSTICKER`/`SUGGUP` |
| B11 **[R]** | Reduction presentation select, five options, `custom` revealing a 40-char free-text field | pending | `ticketHTML` @2578, `MECHLBL` |
| B12 **[R]** | Guarantee 12/24/36, after-mode none or per-tier new price | pending | `readTicket` @2621 |
| B13 **[R]** | Equipment: included, rental with a stated monthly, or BYOD; plus extra-pod monthly | pending | `readTicket` @2621 |
| B14 **[R]** | Service commitment, between 10 and the cohort's household count | pending | `readTicket` @2621 |
| B15 **[R]** | Live scenario read-out in the BRIEF pane, not the ticket, at 60/80/100% confirmation, 80% marked likely | pending | `scnCalc` @2258. Note the target: it writes into `.brief .scnbody` |
| B16 **[R]** | Blended price by the cohort's speed demand: 1 Gig takes the 1 Gig tier, "Under 500" the cheapest of 100 and 300, else 500, missing tier falls back to the first offered | pending | `readTicket` @2621 |
| B17 **[R]** | Validation: effective may not exceed sticker, message names the tier | pending | `readTicket` @2621 `bad` |
| B18 **[R]** | Consent checkbox gates the seal button; the button is disabled until ticked | pending | `ticketHTML` @2578 |
| B19 **[R]** | Seal button has four states: normal, "Accept the standard terms to bid", "Bidding paused · billing issue", "Bidding unlocks at approval" | pending | `ticketHTML` @2578 `payBtn` |
| B20 **[R]** | Sealed receipt: tiers, reference, guarantee, after-line, equipment, commitment, close date, "No withdrawals" | pending | `ticketHTML` @2578 |
| B21 **[R]** | "Improve bid" **must create a version**, not delete and re-open | pending | prototype deletes `S.bids[id]`; §7.5 endpoint 34 forbids it |
| B22 **[R]** | Closed receipt at offers-out: "Confirmed so far", decision date, "no way to see other bids" | pending | `ticketHTML` @2578 |
| B23 **[R]** | Planned cohorts table with expected dates, notify-me and add-to-calendar | pending | `renderPlanned` @1220 |
| B24 **[R]** | ICS download per campaign, tentative status for a planned one | pending | `dlICS` @1049 |
| B25 **[R]** | Campaign plan view: seven milestones, done/now marks, per-milestone prose | pending | `renderPlan` @985 |

## 9.4 onward, reconstructed

The bid record, billing, delivery, performance, contracts and coverage. All of
these have a live prototype implementation named in `render-inventory.md`; none
is built here beyond coverage.

| Area | Prototype source | Status |
| --- | --- | --- |
| My bids, with CSV export | `renderBids` @1243 + wrapper @2988 | pending, 32/37 |
| Empty-state nudge when nothing is sealed and something is open | wrapper @2988 | pending |
| Billing: per-campaign statements, not per month | `renderBilling` @1949 + wrapper @2998 | pending, 53-57 |
| Statement lines: success fee, missed-visit credit, held line test, early-churn clawback | `stmtLive` @1899, `stmtSettled` @1930 | pending |
| Delivery board: seven order states, exception-first sort | `renderDelivery` @2884, `RANK` @2883 | pending, 40-52 |
| Roster gate: billing method, capacity, consent | `openGate` @1544 | pending, 41, 42 |
| Logistics and RMA cards | `renderDelivery` @2884 | pending, 51, 52 |
| Performance, four stage-aware variants | `renderPerf` @2805 | pending, 63, 64 |
| Contracts registry, seven row types | `renderContracts` @1966 | pending, 38, 39 |
| Coverage: declare, edit services, status per region | `renderCov` @1354 | **done** |
| Coverage: rejected region with a reason | none, brief addition | **done**, and now reachable |

---

## Deliberately dropped

Each of these is in the prototype and is **not** being ported. The reason
matters more than the list.

| What | Prototype | Why |
| --- | --- | --- |
| The virtual clock: `NOW0`, `NOWOFF`, `now()`, `snap()` | 812-814 | The server owns every deadline. A client clock a partner can advance is the thing the whole stage design exists to prevent |
| `sig()` and `tick()`'s full re-render on stage change | 1413-1414 | Replaced by a store subscription. The signature poll re-rendered eleven views once a second to catch a boundary crossing |
| Demo constants: `CAMPAIGNS`, `COVER`, `HBIDS`, `MONTHS`, `STREETS`, `TECHS` | 820-870 | §2.3. Every one is a number with no row behind it |
| `SCEN` and `runScen()` | 1656-1673 | Replaced by 18 fixtures on the real payload types |
| The prototype control panel: scenario grid, fee input, clock buttons, reset | 790-801 | Demo scaffolding |
| `window.__whollar` debug handle | 2559 | Replaced by the narrower `W.console.state` |
| v4 roster vocabulary `ins`/`sch`/`to`/`rel` | `seedRoster` @1455 | Superseded by the seven-state model. Must never reappear as a database enum |
| `setStage` and `#stageseg` | 1391 | Targets an element that does not exist. Its side effects are preserved in the render cycle |
| `stickyBrief` | 2130 | A no-op bound to scroll, resize and every click. §4.4.5 |
| The v8 single-page application intake form and every `ap-`/`apc-` handler | 2284 | Unreachable: the live flow is the v9 checklist plus modals. §4.3 |
| Capture-phase `stopPropagation` on tier handlers | 2680, 2690 | Existed only to suppress the earlier layer it replaced. One action registry removes the need. §4.4.3 |

## Structural fixes made during the port

The five §4.4 items, and where each landed.

1. `<div id="mainbanner">` moved from **before `<!doctype html>`** into `<body>`
   above `.app`. `partner/index.html:190`.
2. `renderAcq` staleness: there is now one render cycle, `app.js` `renderAll()`,
   and every view is in it. A view not repainted is a missing line, not an
   archaeology problem.
3. Eight document click listeners collapsed into one registry keyed by
   `data-action`. `core/actions.js`, which refuses a duplicate registration
   rather than letting the second silently win.
4. `expandRow`'s side effect on `S.tasks.brief` is gone with the store: renders
   are pure from state.
5. `stickyBrief` deleted.
