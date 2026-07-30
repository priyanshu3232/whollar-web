# Whollar — Member & Partner dashboards: the complete functional hand-off

> Everything the two signed-in surfaces do today, what is real vs demo, and
> exactly where each piece of data comes from — the knowledge base to carry
> into building the admin console. Written 2026-07-30 from the code as shipped
> (`dashboard.html`, `provider-dashboard.html`, `js/whollar-core.js`).
>
> Companions: `docs/ADMIN_PORTAL_PLAN.md` (admin architecture),
> `docs/ADMIN_DESIGN_GUIDELINES.md` (visual language),
> `docs/MASTER_PLAN.md` (roadmap).

---

## 0. The one mental model

Both dashboards are **static HTML pages that boot on demo data and then let
the server overwrite whatever it actually knows**. Every server touch goes
through one shared library, `js/whollar-core.js` (`window.WHOLLAR`, alias
`W`), against the Catalyst `auth` function via the same-origin rewrite
`/api/auth/*`. Auth is a `whollar_session` cookie; the localStorage records
(`whollar.member` / `whollar.partner`) are a UX cache, **never** the
authorization boundary — the pages say so in comments, repeatedly.

Design consequence for the admin console: whatever the console edits
(campaign counts/kinds, provider approval, site copy) will surface on these
pages **only through the server endpoints below**. There is no other pipe.

---

## 1. Member dashboard — `dashboard.html` (served at `/dashboard`)

### 1.1 Boot & session

1. Parse-time guard: read `localStorage['whollar.member']`. If missing/invalid
   → hide the page and call `W.session.adopt('member')` (asks `GET /session`;
   a cookie from a Google sign-in can exist with empty localStorage). Adopt
   succeeds → reload; fails → redirect to
   `/whollar-login-consumer?next=<here>`.
2. `pageshow` (bfcache) and cross-tab `storage` events re-run the check, so a
   sign-out in another tab kills this one.
3. Sign out = `W.session.end('member')` → server session revoked + local
   record cleared, then redirect to the sign-in page.
4. Personalization: first name/initials/email written into greeting, avatar,
   sidebar profile, account list, referral code (`WHL-<NAME>-7`).

### 1.2 Views (left-nav tabs, all in the one file)

**Home** — the main event:

| Block | What it does | Real or demo |
|---|---|---|
| Cliff banner + gauge | SVG ring counts months to the member's promo reset; headline copy escalates only within 6 months; drives 4 other spots (`data-fld` bindings) from ONE date | **Real when a bill exists**: date comes from `MEMBER.bill.promoEnd`; falls back to demo `2026-11` |
| Campaign card | 7-step rail `forming → locked → bidding → offers → confirm → switching → done`, with a rendered panel per state (dot-cluster progress, sealed-bid rows + countdown, offer cards with savings math, $10 deposit confirm flow w/ consent checkbox, concierge switching checklist, done summary) | **Demo**: state machine is local (`S.state`); no server campaign-stage endpoint yet. Offer prices, dates, activity feed all seeded |
| Switch file card | provider / monthly / speed / promo end / threshold + "spot strength" meter | **Real fields when a bill exists** (painted from `MEMBER.bill`), meter is static demo |
| Referral card | copy `WHL-<NAME>-7` code | Demo (no referral backend) |
| Rate-your-provider card | 4 aspects × 5 dots, one-shot thank-you | Demo, nothing persisted |
| Outage report card | symptom chips + "since when" → appends to activity feed | Demo, local only |
| Worth a read / Member room | 3 blog links; Reddit teaser | Static |
| Campaigns near you row + "How regions open" sheet | 4 region cards + a modal listing all 6 campaigns with join/leave/notify actions | **Half real** — see 1.3 |

**My bills** — the switch-file card again, full width, plus "Mobile — Soon" /
"Streaming — Soon" teaser cards. Real bill fields when present.

**Knowledge centre** — the 10 blog articles as image tiles (static list, real
links into `/blog/*`).

**Campaign history** — deliberate empty state ("your first campaign is still
in play").

**Profile** — completion ring (hardcoded 6-of-8 checklist), account details
(name/email real, mobile/region demo, all Edit buttons are "lands with
accounts" toasts), notification toggles (toast only), "Download my data" /
"Delete my account" (toasts only), sign out (real).

**Contact** — concierge text/email tiles (toasts).

### 1.3 What is live-wired (the parts the admin console will touch)

- **Bill sync** — `W.session.syncBill()` on every load: pushes any pending
  checkup handoff (`POST /me/bill`), then pulls the account copy
  (`GET /me/bill`) into `MEMBER.bill` and repaints cliff + switch file. This
  is how a checkup on the phone shows up on the laptop. Backed by the
  `member_bills` table.
- **Campaigns** — `W.session.campaignsList()` (`GET /campaigns`) overwrites
  the six seeded campaigns (`london-east`, `london-north`, `chatham-kent`,
  `windsor-core`, `kingston-west`, `hamilton-mountain`) with server counts,
  each member's own standing (`you: joined|waitlist|alert|null`), and
  `live:true/false`. Join / leave / notify buttons call
  `POST /campaigns/join|leave|notify`. Joinability by `kind`:
  `forming`/`waitlist`/`planned` joinable, `auction`+ not. **A 404/network
  failure degrades to local demo behaviour** — buttons still "work" without
  a server.
- **Session** — adopt/end as above.

Everything else (offers, deposits, stages, referrals, ratings, outages,
notifications, profile edits, search) is front-end demo with `?demo=1`
revealing a state-jump control panel.

### 1.4 Data the member surface knows about a member

`whollar.member` record: `email`, `firstName`, `lastName`, optional
`bill { provider, monthly, speed, promoEnd, threshold }`. The server's copy
of the bill (via `/me/bill`) is authoritative; the local one is a cache.

---

## 2. Partner console — `provider-dashboard.html`

### 2.1 Boot & session

Same pattern with the **deliberately separate** key `whollar.partner` and
`W.session.adopt('provider')` (a member session must not open the partner
console; adopt refuses on `userType` mismatch). Sign-in return path
preserved via `?next=`. Sign out = `W.session.end('partner')`.

Org name fallback chain: local record → email-domain guess ("sam@northline.ca"
→ "Northline") → **overwritten by the server** when `/provider/me` answers.

### 2.2 The two real server calls

- **`W.session.providerMe()`** (`GET /provider/me`) → `{ ok, user, org:
  { orgName, role }, approved }`. Repaints all org/name spots and — the
  admin-critical bit — **shows/hides the "your application is under review"
  banner from `approved`**. `approved:false` partners are signed in but see
  the banner and (by contract) never real data. *This flag is exactly what
  the admin console's approve/reject/suspend will flip.*
- **`W.session.providerCampaigns()`** (`GET /provider/campaigns`) → live
  household counts mapped onto the six demo campaigns (`CAMPMAP`
  kw→kingston-west, le→london-east, wc→windsor-core, hm→hamilton-mountain,
  ln→london-north, ck→chatham-kent). Member joins on the other dashboard move
  these columns — counts only, never identities. `live:false` (membership
  table absent) leaves the seeds.

Everything else below is demo, driven by a **virtual clock** (prototype
controls can advance +3h/+7d) that recomputes every stage from fixed
timestamps.

### 2.3 Views

| View | Contents | Real or demo |
|---|---|---|
| **Overview — day one** | 4-step activation checklist (coverage ✓, payment, review a brief, place a bid) with progress bar; auction calendar (derived agenda of opens/closes/offers/decisions); "how auctions work" (sealed · binding · pay-on-completion); "closing soon" card with countdown | Demo mechanics; household counts real when service answers |
| **Overview — in motion** | Stat tiles (households acquired, $95 CAC, win rate 3 of 6, open auctions); 12-month completed-switches bar chart; coverage→bid→won→confirmed→completed funnel; activity feed | All demo |
| **Bid desk** | Table of every auction in declared coverage: households, 5-stage minirail (Announced→Open→Closing→Offers out→Decided), window + countdown, your-bid pill; expandable row = **auction brief** (households, renewal window, speed-demand + intent mix bars, your comparable — "aggregates only") + **bid ticket** (price/speed/term/completion-assumption slider, revenue scenario table at 60/80/100% confirmation, consent checkbox → "Place sealed bid", improvable-until-close, no withdrawals) | Demo bids (local `S.bids`); household counts live-patched |
| **Campaign plan** | Per-campaign 7-milestone timeline (announced → open → close → offers → decision → switching → reconciliation) with next-step highlight; ICS calendar export | Demo dates, real counts in header |
| **My bids** | Bid record table (cohort, placed, bid, result, confirmed, completed, fees) + CSV export; day-one empty state | Demo |
| **Acquisition** | Monthly chart, region table, completion-rate tiles; day-one shows a ghosted sample chart | Demo |
| **Billing** | "$95 success fee per completed switch, invoice monthly, 14-day reconciliation"; invoice table; payment-method card | Demo |
| **Coverage** | Declared regions table (status active/verifying, technologies, top speed, install lead, open-auction count) with per-region service editor and "declare a region" row — **this decides which auctions reach the desk** | Demo, local only |
| **Account** | Legal name, sign-in email (real), bid authority, team (single seat); service capability; Whollar contact | Email real, rest demo |

Prototype controls: partner stage day-one/in-motion, success-fee input,
clock advance, reset.

### 2.4 Concepts the partner console commits Whollar to

Worth internalizing before designing admin controls, because the copy
promises them: sealed bids (one best number, masked to rivals), binding
until close / improvable / no withdrawals, coverage-gated auction visibility,
aggregates-only briefs (never member identities, providers, or prices),
pay-per-completed-switch (confirmed sets volume tiers; only live connections
invoice), 14-day dispute window per invoice line.

---

## 3. The shared core — `js/whollar-core.js`

One IIFE, loaded synchronously by every wired page. Beyond utilities
(postal/money/date parsing, benchmarks from `whollar-benchmarks.js`,
`escapeHtml`, `titleCase`, `monogram`, `safeNext` open-redirect guard), the
session API the dashboards use:

```
W.session.read()                       GET  /session        (who am I)
W.session.adopt('member'|'provider')   read + type-check + write local record
W.session.end('member'|'partner')      POST /logout + clear local record
W.session.billGet() / billSave(bill)   GET/POST /me/bill
W.session.syncBill()                   push pending checkup → pull account bill
W.session.campaignsList()              GET  /campaigns
W.session.campaignJoin/Leave/Notify(id)POST /campaigns/join|leave|notify
W.session.providerMe()                 GET  /provider/me    (org + approved)
W.session.providerCampaigns()          GET  /provider/campaigns
W.session.providerSignup/Verify/Login  POST /provider/signup|signup/verify|login
W.member / W.partner                   localStorage stores ('whollar.member'/'whollar.partner')
```

`W.AUTH_API = '/api/auth'` (vercel.json rewrite → Catalyst `auth` function);
mutations ride `authPost()` which carries the CSRF/origin discipline.
The admin console adds `W.siteConfig()` (public config) and its own
`/admin/*` calls per the portal plan — same library, same patterns.

Note: the mobile twins under `MobileVersion/` are **generated** from desktop
pages (see `shared-core-and-build-gates`); dashboards are desktop pages with
responsive CSS, and the admin console deliberately gets no mobile twin.

---

## 4. What the admin console controls on these surfaces (traceability)

| Admin action (portal plan) | Where it lands on these dashboards |
|---|---|
| Approve / reject / suspend a provider org | `/provider/me → approved` → partner console banner disappears/reappears; real-data surfaces unlock/lock |
| Edit campaign info (region, sub, target, kind, sort) | `GET /campaigns` (member cards, join rules via `kind`) and `GET /provider/campaigns` (bid desk counts/notes) |
| Move campaign through lifecycle (`forming→auction→closed…`) | Member: join buttons appear/disappear (`joinable` by kind), badges change; Partner: desk stage, agenda, plan view |
| Global bidding kill switch | Partner: bid forms render disabled with a notice (`bidding:{enabled:false}` in `/provider/campaigns`); member copy adjusts via public config |
| Site config (prices, thresholds, banner copy) | `data-config` placeholders + `W.siteConfig()` — to be added to pages in phase ADM-2 |
| Read leads / deep-reads / audit | No dashboard surface; admin-only visibility |

The parts of the dashboards that are still demo (offers, deposits, sealed-bid
storage, invoices, coverage persistence, referrals) belong to the future
Phase-D marketplace backend — the admin console should **not** grow controls
for them yet; there is nothing behind them to control.
