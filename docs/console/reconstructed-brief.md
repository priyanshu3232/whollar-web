# Integration brief: the reconstructed sections

The copy of `whollar-provider-console-v12-integration-brief.md` we hold is
**truncated mid-section 6.3**. Sections 7 through 15 are missing and are not on
disk. Every session prompt in the runbook cites them by number.

Five of them are derivable from the prototype itself, and are reconstructed
here. Four are not, and are listed at the end as an open ask.

| Section | Status |
| --- | --- |
| 7. Screen by screen | Reconstructed, in [render-inventory.md](render-inventory.md) |
| 8. The scenario fixtures | Reconstructed, below, and built as `js/console-fixtures.js` |
| 9. (title unknown) | **Needs your document** |
| 10. (title unknown) | **Needs your document** |
| 11. Prototype scaffolding to strip | Reconstructed, below, with line numbers |
| 12. Stubs to replace | Reconstructed, below. Six, all enumerated |
| 13. Phase order | Substituted by the PR breakdown in the plan |
| 14. QA matrix | Reconstructed, below, built as `scripts/qa-console.mjs` |
| 15. Definition of done | **Needs your document** |
| tail of 6.3 | **Needs your document** |

---

## Section 8: the fixture states

Fourteen are the prototype's `SCEN` array at lines 1656-1671, carried across as
**data on the real payload types** rather than as state mutations on demo
constants. Two are the brief's stated additions. The seventeenth is explained
below and is the reason doing this from the data beat doing it from the names.

Built as `js/console-fixtures.js`, reachable at
`http://localhost:3000/provider-console?fixture=<name>`.

| # | Name | State | Source |
| --- | --- | --- | --- |
| 1 | `pending` | Application in progress, nothing submitted | prototype |
| 2 | `review` | Submitted, 48 hour clock running | prototype |
| 3 | `rejected` | Application refused, with a reason and a route back | **brief addition** |
| 4 | `first` | Approved, first login, no coverage declared | prototype |
| 5 | `covrejected` | A declared region failed serviceability | **brief addition** |
| 6 | `ready` | Coverage active, nothing open | prototype |
| 7 | `announced` | Cohort dated, bidding not yet open | prototype |
| 8 | `open` | Bidding open, close still distant | **see below** |
| 9 | `closing` | Inside the last 24 hours, countdown running | prototype (`open`) |
| 10 | `sealed` | A bid is in, improvable until close | prototype |
| 11 | `offersout` | Bids closed, offers with households, nothing to do | prototype |
| 12 | `won` | Won, roster gated, counts only | prototype |
| 13 | `lost` | Not selected | prototype |
| 14 | `delivery` | Roster released, exceptions live | prototype |
| 15 | `reconcile` | Switch window closing, statement accruing | prototype |
| 16 | `motion` | Long-running partner with a record | prototype |
| 17 | `payfail` | Billing failed, bidding paused | prototype |

**Why seventeen.** The prototype's `open` scenario resets its virtual clock to
zero while its lead cohort closes 2 hours 14 minutes later. What that scenario
actually renders is therefore the **closing** state, with the countdown running
and the row hot. A genuinely open cohort with a distant close is a different
render path and had no fixture at all. Splitting the two adds the missing one.

Three rules the fixtures follow, each of which is a rule about the real API:

1. **Nothing computes a stage.** Every fixture states `stage` outright, because
   the server derives it. A fixture that computed stage from timestamps would
   teach the client to compute stage from timestamps.
2. **Timestamps are relative to a supplied `serverTime`**, in epoch
   milliseconds, exactly as the API delivers it. The datastore's own
   `YYYY-MM-DD HH:MM:SS` format carries no zone marker and shifts by the
   reader's offset.
3. **The gated roster has no `orders` key at all**, rather than an empty array.
   See `won` versus `delivery`.

---

## Section 11: prototype scaffolding to strip

All line numbers are `docs/prototype/provider-console-v12.html`.

**Markup**

| Lines | What |
| --- | --- |
| 790 | `#ctl-toggle`, the "Prototype controls" button |
| 791-801 | `#ctl`, the controls panel |
| 793 | the "Demo data" badge |
| 795 | `#scen`, the scenario button grid |
| 797 | `#cfg-fee`, the success-fee input |
| 798-799 | `#t3h` and `#t7d`, the clock buttons |
| 800 | `#rst`, reset |

**JavaScript**

| Lines | What |
| --- | --- |
| 812-814 | the virtual clock: `NOW0`, `NOWOFF`, `now()`, `snap()` |
| 820-849 | `CAMPAIGNS` |
| 850-857 | `HBIDS` |
| 858 | `MONTHS` |
| 859-869 | `COVER` |
| 870 | `TECHS` |
| 1413-1414 | `sig()` and `tick()`, the 1 second poll and its signature comparison |
| 1454 | `STREETS` |
| 1650-1655 | `base()` |
| 1656-1671 | `SCEN` (reconstructed as fixtures instead) |
| 1673 | `runScen()` |
| 2559 | `window.__whollar`, the debug handle |

**One thing that looks like scaffolding and is not.** Line 1 of the prototype is
`<div id="mainbanner"></div>`, sitting **before `<!doctype html>`**. It is
`renderBanner()`'s host, so it must exist. Move it inside `<body>`; do not
delete it. Browsers silently recover from where it is now, which is why the
prototype appears to work.

**Also not scaffolding:** `.toast` and `.modal` CSS and markup are real chrome.
Only `.ctl*` and `.scengrid` (17 lines of CSS) are scaffolding, and they are
already dropped from `provider-console.html`.

---

## Section 12: the stubs

Six, all of the form `toast('Prototype: ...')`.

| Line | Hook | Becomes |
| --- | --- | --- |
| 1335 | `[data-payu]` | endpoint 59, a hosted payment flow. The console never handles raw card data |
| 1336 | `[data-pdf]` | endpoint 56, statement export |
| 1337 | `[data-edit]` | account field editing, endpoints 7 and 66 |
| 1338 | `#signout` | **not really a stub.** `provider-dashboard.html:721` already has the correct implementation, and `provider-console.html` ships it: end the server session with `W.session.end('partner')`, because clearing localStorage alone leaves the cookie alive and the boot guard adopts it straight back |
| 1339 | `#c-mail` | a `mailto:`, shipped |
| 1625 | `[data-cda]` | the cohort delivery agreement document, endpoint 38 |

---

## Section 14: the QA matrix

Built as `scripts/qa-console.mjs`. Run against a local dev server; deliberately
not in CI, for the reason `scripts/test-signal-card.mjs:5-13` already records
(provisioning a browser binary costs real time on every run, and
`check-frontend.yml` is install-free).

Twelve groups, currently 35 assertions:

1. Signed out: nothing paints, redirect carries `?next`
2. Signed in and approved: real org name, not the email-domain fallback
3. Signed in and not approved: the banner, and honest empty-state copy
4. A definite 401 signs the tab out and clears the local record
5. **A network failure does NOT sign anyone out.** The inverse of 4, and the one
   that matters for a 12 hour non-rolling session
6. Cross-tab sign-out, and the bfcache restore
7. All 11 views render, one at a time, none blank
8. Four widths, zero horizontal overflow
9. The burger: collapse on desktop, overlay on mobile
10. The register: 67 endpoints, every one live or a tagged stub, and a stub
    fails as `NOT_IMPLEMENTED`/501 exactly as the server will
11. Every fixture installs and renders with no console error
12. Fixture mode declines to install off localhost

Still to add as the views land: the seven-column tier table at 390px, an
improvement that raises a price being refused with the term named, and the
roster response carrying no `orders` key before the gate.

**Playwright notes carried from the runbook:** SVG text needs `text_content()`,
not `inner_text()`. Collapsed accordions and unexpanded desk drawers hide text
from `inner_text()` and produce false failures, so expand before asserting.
Re-verify any failure before reporting it: two of the first three failures in
this harness were the harness, not the console.

---

## What still needs your document

- **Sections 9 and 10.** Their titles alone would say whether they are
  reconstructible. Everything either side of them is.
- **Section 13, phase order.** The plan's PR breakdown substitutes for it. If
  yours differs, the difference is the interesting part.
- **Section 15, definition of done.** Not reconstructible: it is your bar.
- **The tail of section 6.3.** Truncated mid-sentence.

Not worth chasing: the two reference screenshots for the session 5 gate.
`?fixture=pending` and `?fixture=review` reproduce both states on demand, and
cover the other fifteen as well.
