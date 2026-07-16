# Whollar — Product & Technical Overview

> A single reference for what Whollar is, how the product works, what's been built,
> and where it's going. Written to be reusable as context for teammates, investors,
> or AI assistants. Last compiled: 2026-07-16.

---

## 1. What Whollar Is

**Whollar is a demand-aggregation marketplace for home internet in Canada.** It pools
individual households into *cohorts* — neighbours whose contracts renew around the same
time — and has internet providers **bid to win the whole group at once**, instead of
chasing customers one lead at a time.

The one-line pitch, in the site's own words:
- **For households:** *"Stop paying the loyalty tax. Wholesale buying power that saves you dollars."*
- **For providers:** *"The future of broadband acquisition doesn't start with advertising. We organize verified household demand before providers compete."*

### The core insight
> *"One household has no leverage. Hundreds do."*

A single customer negotiating with their ISP has no power. But if a whole street's worth
of households — all up for renewal in the same window — show up as one organized,
verified group, providers will compete on price to win them. Whollar is the layer that
**gathers, verifies, groups, and times** that demand, then runs the competition.

### Two-sided model

| Side | What they get | What Whollar asks of them |
|------|---------------|---------------------------|
| **Households** (demand) | A group price without negotiating, hold music, or contract-date anxiety. Concierge handles the switch. Free to join. | Upload one bill; join a cohort; pick an offer or pass. |
| **Providers** (supply) | Verified, pre-organized demand tagged with renewal dates — "receive demand instead of chasing clicks." Plan capacity against real demand. | Get verified; bid on cohorts in regions they serve. |

### How it works (household journey)
1. **Upload one bill.** A photo or PDF confirms current plan, speed, and renewal date. *"That's all we need."*
2. **Join your neighbourhood.** Whollar groups you with nearby households renewing around the same time.
3. **Providers compete** to win the whole group in a **sealed bid** ("every bid stands on its own merits").
4. **Choose and relax.** Compare offers, pick one or stay put — *"it's always your call."* A **real concierge** (not a chatbot) handles the paperwork and the switch.

### How it works (provider journey)
> *"We gather, we organise, you capitalize."*
1. **Households qualify themselves in** (verified, with renewal dates).
2. **A cohort forms and providers compete** — sealed bids, exact address shared only after selection.
3. **Whollar migrates them** → successful activation.

### Business model
**Free for households. Providers pay only when they win a cohort** —
*"providers pay us only when they win your group."* This is a success-fee / outcome-based
model on the supply side, with zero cost and zero obligation on the demand side.

### Market & regulatory context (used as product tailwinds)
- **Canada-first**, rolled out **region by region** ("before your region opens without you").
- **CRTC TPIA** (Third-Party Internet Access) is part of the model — independent regional
  providers can compete alongside national carriers (the bill-checkup and partner forms both
  list "Cable (TPIA)" as an access type).
- **CRTC 2026-43**: activation, change, and cancellation fees are banned as of **June 12, 2026** —
  Whollar uses this ("switching costs $0 in fees") to remove the friction of switching.
- **The "promo cliff"**: the site educates households that discounts silently expire and
  prices reset 30–60%, which is the emotional wedge for the whole product.

### The bigger vision
Internet is explicitly framed as **"chapter one."** Copy repeatedly signals expansion:
*"The next markets are already on our map, sealed until launch, and founding members hear
it before a word goes public."* The long-term positioning is a **household advocate / group-buying
layer across recurring-bill categories**, starting with broadband. On the provider side the
framing is **"demand infrastructure for internet providers."**

---

## 2. Tech Stack

Whollar today is a **static, front-end marketing & lead-capture site** — no application
backend has been built yet. Form submissions are stubbed at "wire-up points" (see §5).

### Front end
- **Plain HTML / CSS / vanilla JavaScript.** No SPA framework for the hand-built pages.
  Hand-authored pages use inline `<style>` and a small inline `<script>` per page.
- **Design-tool exports (React-driven):** the large landing/waitlist pages are exported from
  a design compiler. They ship an `<x-dc>` document plus a generated runtime
  (`waitlist/js/dc-runtime.js`, *"GENERATED from dc-runtime/src/*.ts — rebuild with `bun run build`"*)
  that hydrates with **React / ReactDOM loaded from `unpkg.com`**. `Join the Waitlist (1).html`
  is the same kind of export.
- **Animations:** [lottie-web](https://airbnb.io/lottie/) (`js/lottie.min.js`) rendering
  dotLottie / Lottie JSON files (`*.lottie`, `*.json`) for the hero and the "three steps" icons.
- **Fonts:** Satoshi + General Sans via **Fontshare**, Inter via **Google Fonts** (self-hosted
  `.woff2` copies also live in `waitlist/assets/fonts/`).
- **Media:** MP4 background/hero videos (`Next (1).mp4`, `waitlist/assets/neural-connections.mp4`),
  SVG assets (`favicon.svg`, `house.svg`), PNG imagery.

### Forms & data capture
- **Zoho Forms** — the "Become a founding member" form posts to **`forms.zohopublic.ca`**
  (`Become_a_founding_member_of_Whollar/`), using Zoho's `zf_*` validation library, including a
  signature-capture canvas and referral-code field. This is the **one live backend integration** today.
- All other forms (bill checkup, waitlist rail, partner application) are **client-side only** and
  log a payload to the console at a `WIRE-UP POINT` — not yet persisted anywhere.
- A **Cal.com** link is referenced as the "Book a call" scheduling wire-up point.

### Tooling / dev / hosting
- **`package.json`** (`whollar-site`): a static site served locally with **`serve`** (`npm start` → `serve -l 3000 .`).
- **`playwright-core`** is a dev dependency (used for visual/layout verification during development).
- Dependency tree (`@zeit/schemas`, `serve`) and the connected **Vercel** integration point at
  **Vercel-style static hosting** as the deployment target. No `vercel.json` committed yet.
- **Git** for version control; `.backup/` holds `.bak` snapshots of the landing pages.
- No build step for the hand-authored pages (they're shipped as-is); only the design-tool
  exports have an upstream `bun` build that lives outside this repo.

### What is *not* in the stack yet
No database, no server/API, no auth, no bill-parsing/OCR, no email/SMS delivery, no bidding
engine, no payments. These are the future-integration surface (§5).

---

## 3. What's Been Done So Far

A complete, polished **marketing + lead-capture front end for both sides of the marketplace**,
plus an interactive consumer tool. Page by page:

### Consumer-facing
- **`index.html` (= `Whollar Landing Page v7.html`, byte-identical)** — the main consumer
  landing page. Includes:
  - Animated hero ("Wholesale buying power that saves you dollars"), loyalty-tax framing, live
    savings counter.
  - **Interactive "upload your internet bill"** demo (drag-and-drop, encrypted-and-secure states).
  - **How it works** (3 steps), **Why Whollar** (never negotiate / never wait on hold / promo-expiry
    tracking / concierge), an animated **"bids closed, your street has a new low price"** call scene.
  - **"Whollar becomes your internet advocate"** — renewal reminders, future negotiations handled,
    concierge support, provider-issue escalation, and **"Backup internet during outages" (marked *Coming soon*)**.
  - **Trust & safety** (never sell data, end-to-end encryption, no obligation), **Founding members**
    section, **FAQ**, and a **Contact** block (email `hello@whollar.ca`, live chat).
- **`whollar-bill checkup-v6.html`** — the flagship interactive tool, **"The Whollar checkup."**
  Households enter postal code, provider, monthly charge, download speed, access technology, promo
  end-date, and discount (or **attach a bill** PDF/photo). It:
  - Resolves the postal **FSA → a named local cohort**, computes months-to-renewal and whether the
    promo has expired.
  - Explains the "part of your bill nobody explains" (rented box, credits, the promo cliff), citing
    CRTC 2026-43 ($0 switching fees) and rented-modem costs.
  - Offers a **"deep read"** (upload agreement / more bills, emailed analysis) and an inline
    **waitlist join** ("providers pay us only when they win your group").
- **`waitlist/` (Become a founding member of Whollar)** — the waitlist / founding-member landing:
  name, email, phone ("a number to text when bids land"), postal code, **referral code + shareable
  referral link** ("move your area up the line"), founding perks, "what joining gets you," a
  content/newsletter promise, and FAQ. Built as a React design-tool export.
- **`Join the Waitlist (1).html`** — an earlier/alternate waitlist export (same design-tool lineage).

### Provider-facing
- **`Whollar Provider Landing v7.html`** — the provider marketing page. Positions Whollar as
  **"demand infrastructure for internet providers"**: the problem ("the broadband industry has
  mastered marketing, not demand"), a **Today vs. With-Whollar toggle**, "see the demand coming and
  plan to win it," the 3-step provider flow, a **founding-provider-partner** pitch, FAQ, and CTAs
  ("Request Early Access," "Schedule a Strategy Call"). Footer links: Company, Founding partners,
  Privacy, Contact, LinkedIn, Legal.
- **`whollar-partner-v6.html`** — the **provider application form** ("Become a founding partner").
  A split hero with a multi-branch form that routes by role — **I work at the provider / I'm in
  sales / I'm a distributor or dealer / Something else** — collecting company, website, phone,
  provinces served, access technologies, and role-specific credentials (legal name, provider type,
  business number, brands, authorized signatory, LOA). Also a "three steps to your first cohort"
  explainer with Lottie animations, a lanes section, and an FAQ. *(This is the page most recently
  under active iteration — layout/animation/FAQ/spacing polish.)*
- **`Become_a_founding_member_of_Whollar/`** — a Zoho-backed founding-member form (the live
  submission path), with signature capture and referral validation.

### Shared assets & infra
- Lottie animation library + a set of animation files (`apply`, `job-review`/`We review`,
  `bid-animation`/gavel, `application-completed`, `search`, etc.), wired into the "three steps" cards.
- `favicon.svg`, `house.svg`, hero/section videos, brand imagery.
- Local dev server config, Playwright for verification, `.backup/` snapshots, git history.

### Current state summary
- ✅ Consumer landing, provider landing, bill-checkup tool, waitlist, partner application — all
  designed and interactive on the client.
- ✅ Founding-member capture live via Zoho.
- ⚠️ Every other form is a **front-end mock** — data is validated and shaped into a payload but only
  `console.log`-ged. Nothing is stored, no cohorts are actually formed, no bids actually run yet.

---

## 4. Future Goals (Product Roadmap)

Drawn from on-page copy ("Coming soon," "on our map," "future negotiations," "before your region opens"):

1. **Launch the first real cohorts in Canada**, region by region — turn the waitlist into live,
   bid-able neighbourhood groups.
2. **Stand up the real bidding/auction engine** — cohort formation by FSA + renewal window,
   sealed-bid provider competition, winner selection, address reveal post-selection.
3. **Concierge-led migration** — operationalize the "a real person handles the switch" promise
   (paperwork, provider handoff, activation confirmation).
4. **Ongoing advocacy, automated** — renewal-date tracking, **"future negotiations handled"**
   (auto-run the next round at term end, household just approves), promo-expiry alerts, and
   **provider-issue escalation**.
5. **Backup internet during outages** — the explicitly flagged **"Coming soon" premium add-on**.
6. **Expand beyond internet** — internet is "chapter one"; the roadmap points to additional
   recurring-bill markets/categories, revealed to founding members first.
7. **Multi-region / national rollout** — open new markets progressively; founding members get
   early access and first pick per market.
8. **Provider partner program** — recruit and onboard **founding provider partners** who help
   shape regions, bidding structure, and roadmap.
9. **Content & market-watch channel** — launches/updates, CRTC & market analysis in plain
   language, and how-to guides (promised in the waitlist "stay tuned" section).

---

## 5. Future Integrations Needed

Mapped to the concrete gaps in the codebase (the `WIRE-UP POINT` stubs and the promises the UI
already makes). This is roughly the build order to go from "marketing site" to "working marketplace."

### A. Backend foundation (unblocks everything)
- **Application server / API** to receive the currently-stubbed POSTs:
  - `whollar-bill checkup-v6.html` → *POST waitlist payload* and *POST deep-read payload (files, note, email)*.
  - `whollar-partner-v6.html` → *POST partner application*.
  - Waitlist rail joins.
- **Database** for the core domain objects: **households, bills, cohorts (FSA + renewal window),
  providers, bids, activations, referrals.**
- **Authentication & portals** — provider portal (see cohorts, place bids) and household account
  (track status, approve offers).

### B. Bill intake & parsing (the "we decode every line" promise)
- **File storage** for uploaded bills/agreements (PDF + images), encrypted at rest.
- **OCR + document parsing → structured extraction** (plan, speed, monthly total, rented-equipment
  line items, discount, promo end-date, the "cliff"). Likely OCR + an LLM extraction step. This
  directly powers the checkup's "deep read."

### C. Messaging & notifications
- **Transactional email** (e.g. Resend / Postmark / SendGrid) — "we email you what we find,"
  "we'll write when your cohort opens," deep-read results.
- **SMS** (e.g. Twilio) — the repeated promise to **"text when bids land"** requires phone
  verification + SMS delivery.
- **Live chat** — the consumer site advertises "Live chat, available 24/7."

### D. Marketplace mechanics
- **Cohort-formation engine** — cluster households by postal FSA + renewal date; the FSA→cohort
  naming already exists client-side in the checkup and needs a server counterpart.
- **Sealed-bid auction service** — provider bidding, sealed both ways, winner selection, and the
  post-selection address reveal.
- **Provider verification** — validate CRTC registration / business number, provider type, brands,
  distributor Letters of Authorization (the partner form already collects all of this).
- **Payments / billing for providers** — collect the success fee when a provider wins a cohort
  (e.g. Stripe), since the whole revenue model is "providers pay only when they win."

### E. Growth & ops
- **Referral tracking** — the waitlist already issues referral links/codes ("move your area up the
  line"); needs attribution + a leaderboard/queue-position mechanic.
- **CRM consolidation** — decide whether to keep **Zoho Forms** for founding members or unify all
  capture into the new backend/CRM.
- **Scheduling** — wire the **Cal.com** "Book a call" / "Schedule a Strategy Call" links to a real
  calendar.
- **Analytics & consent** — product analytics, plus privacy/consent tooling consistent with the
  strong "we never sell your data, end-to-end encrypted" promises.
- **Geo/FSA data service** — a maintained postal-code → region/coverage dataset feeding both
  cohort formation and provider coverage matching.

### F. Deployment & platform hardening
- **Vercel (or equivalent) hosting** with proper env/secrets management, once the backend and
  integrations exist (currently a plain static `serve`).
- **Consolidate the design-tool exports** — the React `dc-runtime` pages load React from `unpkg`
  at runtime; for production these should be self-hosted/pinned and CSP-reviewed.

---

## Appendix A — Data each form collects today

| Form | Fields captured | Destination today |
|------|-----------------|-------------------|
| **Bill checkup** | postal code (→FSA cohort), provider, monthly charge, download speed, access tech, promo end-date, discount, switch-threshold, email, **uploaded bill file**, deep-read files + note | `console.log` (stub) |
| **Waitlist** | name, email, phone, postal code, referral code / neighbour email | `console.log` (stub) + React export |
| **Partner application** | role, first/last name, company, website, phone, provinces, access tech, legal name, provider type, business number, brands, signatory, distributor LOA, other-type note, timestamp | `console.log` (stub) |
| **Founding member (Zoho)** | title, first/last name, email, phone, referral code, signature | **`forms.zohopublic.ca` (live)** |

## Appendix B — Repository map (source, excluding `node_modules`)

```
index.html                              Consumer landing (= Whollar Landing Page v7.html)
Whollar Landing Page v7.html            Consumer landing (source copy)
Whollar Provider Landing v7.html        Provider marketing landing
whollar-partner-v6.html                 Provider application form ("Become a founding partner")
whollar-bill checkup-v6.html            Interactive bill-checkup / cohort estimator tool
waitlist/                               Waitlist / founding-member landing (React design-export)
Join the Waitlist (1).html              Earlier waitlist export
Become_a_founding_member_of_Whollar/    Zoho-backed founding-member form (live submit)
js/lottie.min.js                        Lottie animation runtime
*.lottie / *.json                       Lottie/dotLottie animation sources (apply, review, bid, etc.)
favicon.svg, house.svg, *.png, *.mp4    Brand & media assets
package.json                            Static-site tooling (serve, playwright-core)
.backup/                                .bak snapshots of the landing pages
```

## Appendix C — External services referenced in code

- **Fontshare** (`api.fontshare.com`) — Satoshi / General Sans fonts
- **Google Fonts** (`fonts.googleapis.com`, `fonts.gstatic.com`) — Inter
- **unpkg** (`unpkg.com`) — React / ReactDOM for the design-tool exports
- **Zoho Forms** (`forms.zohopublic.ca`) — founding-member submissions (live)
- **Cal.com** (`cal.com`) — "Book a call" scheduling (wire-up target)
- Brand contact: **`hello@whollar.ca`**, domain **`whollar.ca`**

---

*Notes on provenance: Everything above is derived from the current repository — page copy,
form logic, `WIRE-UP POINT` comments, `package.json`, and referenced hosts. Product-roadmap and
integration items are inferred from on-page promises ("Coming soon," "text when bids land,"
"we decode every line") and the stubbed submission paths; they represent intent visible in the
code, not a committed engineering plan.*
