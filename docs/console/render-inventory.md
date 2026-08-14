# v12 prototype: which function is actually live

Source: `docs/prototype/provider-console-v12.html` (3,071 lines).
Produced mechanically by brace-balance parsing, not by reading, because reading
is what produced the wrong rule below.

## Why this file exists

The prototype was built by successive patching. Later versions were appended
rather than merged, so **23 function names have more than one definition**. Any
port has to answer, per name, which one runs.

The integration brief gives one rule: *"Sixteen functions are defined more than
once and the later definition wins at runtime. Always port the LAST definition
in the file."*

**That rule is right for 16 names and wrong for 7.** Those 7 are not redefined,
they are *decorated*: each later version captures the previous one in a `var _x`
and calls it. Porting only the last definition of `renderOverviewBits` would
drop four of its five layers, including every line of its pending-partner copy.

Both mechanisms are in play at once. `renderBilling` is declared twice **and**
then wrapped, so its live behaviour is the second declaration plus one wrapper,
and the first declaration is dead.

---

## A. Redefined: port the last declaration

Plain `function f(){}` declarations hoist, so within the single IIFE the last
one in source order wins for the whole scope, including for calls that appear
textually earlier.

| Function | Live span | Dead declarations |
| --- | --- | --- |
| `ticketHTML` | **2578-2619** | 1102, 1728, 2022, 2187 |
| `readTicket` | **2621-2660** | 1774, 2067, 2226 |
| `briefHTML` | **2157-2184** | 1087, 1706, 1991 |
| `scnCalc` | **2258-2269** | 1173, 1793, 2089 |
| `renderDelivery` | **2884-2984** | 1471, 1853, 2351 |
| `renderPending` | **3009-3029** | 1635, 2284, 2689 |
| `tierRowHTML` | **2566-2576** | 2014, 2145 |
| `renderPerf` | **2805-2877** | 1566 |
| `renderOvLive` | **2753-2802** | 2704 |
| `renderTasks` | **2445-2459** | 910 |
| `renderContracts` | **1966-1985** | 1588 |
| `renderBilling` | **1949-1963** | 1315 (then wrapped, see B) |
| `seedRoster` | **1818-1836** | 1455 |
| `rosterStats` | **1837-1842** | 1464 |
| `deliveryCampaign` | **2429-2432** | 1526 |
| `bidLine` | **2060-2066** | 1768 |

Confirmations worth carrying into the port:

- **`ticketHTML` @2578 is the right one** if it has a seven-column tier table
  (Tier, Upload, Technology, Sticker, Effective, After, remove), a reduction
  presentation select with five options including `custom`, and no law-line
  boxes. A four-column table means an earlier definition.
- **`seedRoster` @1818 and `rosterStats` @1837** use the canonical order
  vocabulary. The dead pair at 1455/1464 uses `ins|sch|to|rel`, which is the v4
  set. It must not be ported and must not reappear as a database enum.

---

## B. Decorated: port the composition

Each of these captures the previous version and calls it. Verified
mechanically: every one of the 7 contains a call to its captured alias.

| Function | Layers | Chain |
| --- | --- | --- |
| `renderOverviewBits` | **5** | decl @934 → `_rob` @2122 → `_rob9` @2542 → `_rob10` @2736 → `_rob11` @3041 |
| `renderAll` | 2 | decl @1407 → `_renderAll` @1697 |
| `renderBids` | 2 | decl @1243 → `_rbids11` @2988 |
| `renderBilling` | 2 | decl **@1949** (last of 2) → `_rbill11` @2998 |

### What each layer adds

**`renderAll` @1697** appends a second render pass: `renderDelivery`,
`renderPerf`, `renderContracts`, `renderBanner`, `renderPending`, `syncGate`.
The base only refreshed the overview, agenda, desk, planned, bids, coverage and
plan. Flattening to the last definition alone would leave six views stale after
every clock tick and every scenario change.

**`renderBids` @2988** appends the empty-state nudge: when the partner has
sealed nothing and a cohort in coverage is open, it injects a `#bidnudge` card
before `#bidscard`. It removes any previous `#bidnudge` first, so it is
re-entrant.

**`renderBilling` @2998** appends one sentence to `#b-cycle` when a bid is at
stage 3 and no roster exists yet, saying confirmations cost nothing.

### `renderOverviewBits`, layer by layer

Order matters, and two layers write the same four DOM nodes.

1. **base @934** writes `#ov-sub`, `#cs-eb`, `#cs-title`, `#cs-line` from the
   open-auction count and the next close.
2. **`_rob` @2122** overwrites all four *when `COVER` is empty*: "Declare your
   coverage first".
3. **`_rob9` @2542** returns immediately unless `P.stage === 'pending'`; when it
   is pending it overwrites all four again with application-progress copy.
4. **`_rob10` @2736** calls `renderOvLive()`, then auto-submits the application
   when all five tasks are clear and `!P.appDone`.
5. **`_rob11` @3041** returns unless pending; in the tasks view it appends a
   "See the review timeline" link to `#cs-line`, and stamps `P.appDoneAt` and
   returns to the frame when `appAll()` first becomes true.

> **Hazard 1: layer 2's copy is unreachable for pending partners.** A pending
> partner with no coverage gets "Declare your coverage first" written by layer 2
> and immediately overwritten by layer 3. Flattening these into one function
> without preserving precedence will resurrect copy that never shipped. The
> reachable combinations are: pending (layer 3 wins), active with no coverage
> (layer 2 wins), active with coverage (base wins).

> **Hazard 2: the application auto-submit is guarded twice, by two different
> flags.** Layer 4 fires on `!P.appDone`; layer 5 fires on
> `P.appView === 'tasks' && appAll() && !P.appDoneAt`. Both call `syncGate()`,
> `renderPending()` and `nav('pending')`, and both toast, with different wording
> and different claimed timelines ("four business days" vs "48 hour clock").
> The brief calls this the single most important transition in the pending
> experience and requires it to be idempotent and to fire once. In the prototype
> it is two transitions sharing one trigger. **Porting decision: keep layer 5's
> behaviour and wording (`appDoneAt` plus the 48 hour clock, which matches the
> decision-due calculation elsewhere) and drop layer 4's toast and transition,
> keeping only its `renderOvLive()` call.** Server side, submission is
> idempotent regardless, because the endpoint stamps `submittedAt` only if unset.

---

## C. How to port

For each name in table A, take the live span and ignore the rest.

For each name in table B, write **one flat function** whose body is the base
followed by each layer in chain order, then delete the layers that are
unreachable or that duplicate a later layer, and record why in a comment. Do not
keep the decorator pattern: it exists because the prototype was patched without
being edited, and it is the reason this document was necessary.

Two things to carry over unchanged, because they look accidental and are not:

- **The exception-first sort in `renderDelivery`** (`RANK`: `noshow`, `access`,
  `linefail` = 0, then `acc`, `bkd`, `act`, `rel`). The board opens on what needs
  a decision, not on what is going well.
- **`renderOvLive`'s two modes.** It renders a "demand approaching" panel rather
  than a wall of zeros when a partner has no open cohorts, no sealed bids and no
  pending results. A stat grid of four zeros is the state most likely to make a
  new partner close the tab.

## D. Not ported

`seedRoster` @1455 and `rosterStats` @1464 (dead v4 vocabulary). `sig()`,
`tick()`, `now()`, `snap()`, `NOW0`, `NOWOFF` (the virtual clock). `base()`
@1653 and the `SCEN` array @1656-1671 (the scenario switcher; its 14 states are
reconstructed as fixtures instead, see `docs/console/fixtures.md`). `CAMPAIGNS`,
`COVER`, `HBIDS`, `MONTHS`, `STREETS`, `TECHS` (demo constants).
`window.__whollar` @2559 (debug handle).
