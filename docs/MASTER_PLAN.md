# Whollar: Master Architecture Plan & Implementation Guide

> From "polished marketing site + mock login" to a working, professional, scalable
> two-sided marketplace. Compiled 2026-07-28 from a full codebase audit (frontend,
> `catalyst-backend`, build/CI/deploy infrastructure, and project history).
>
> Companion docs: `WHOLLAR_OVERVIEW.md` (product), `catalyst-backend/README.md`
> (forms/OCR backend), `catalyst-backend/CRM_SYNC_RUNBOOK.md` (CRM),
> `catalyst-backend/scripts/create-tables.md` + `auth-env-setup.md` (auth setup).

---

## Part 1: Where the system stands today

### 1.1 What genuinely works (live, verified)

| Capability | Implementation | State |
|---|---|---|
| Lead capture (6 forms) | `formSubmit` Catalyst function → Data Store + File Store | ✅ live, end-to-end tested |
| Bill OCR autofill | `billOcr` → Claude vision, tool-forced extraction | ✅ live, rate-limited |
| CRM sync | `formSubmit` → `CrmSyncQueue` → `crmSync` → Zoho CRM Leads | ✅ pipeline healthy, but **no cron exists**, drains only when run manually |
| Benchmark scoring | `js/whollar-benchmarks.js` generated from 6,803 real advertised plans | ✅ real data, CI-gated |
| Blog, SEO, mobile routing | build scripts + `device-router.js` | ✅ |
| CI gates | drift check, syntax check, benchmark staleness, deploy pipeline | ✅ (gaps: `auth` not syntax-checked; `qa-blog.mjs` manual) |

### 1.2 What looks working but is not

- **Login is a mock.** Both login pages write `{firstName, email, …}` into
  localStorage and redirect. The provider OTP screen verifies nothing; passwords
  are never transmitted. Anyone can "sign in" as anyone from the console.
- **Dashboards are prototypes.** `dashboard.html` and `provider-dashboard.html`
  render almost entirely hardcoded demo data (offers at $54.50/$58/$61, fake
  activity feed, fixed countdown). Neither page makes a single network request.
- **The auth backend has no doors.** `catalyst-backend/functions/auth/` has real,
  well-built infrastructure (config validation, datastore layer with ZCQL
  hazards handled, sessions, cookies, Origin-based CSRF, audit log, schema
  verifier for 10 tables), but `src/routes/` is **empty**. No OTP, no signup,
  no OAuth. The only session mint is dev-only `POST /dev/session`.
  `W.AUTH_API = '/api/auth'` exists in `js/whollar-core.js:58` with **zero call
  sites** in any page.
- **Everything runs in Catalyst's Development environment.** There is no
  production environment. Every live-site submission writes to dev tables
  (`js/whollar-core.js:40`, `vercel.json` rewrite both point at
  `…development.catalystserverless.ca`).

### 1.3 What doesn't exist at all

- Cohort formation, sealed bidding, offer acceptance, concierge workflow,
  provider verification workflow, payments: the entire marketplace core.
- Transactional email and SMS ("we'll text when bids land" is a promise with no
  sender behind it).
- Session cleanup cron (`authCronCleanup` is referenced in `sessions.js:153` and
  `create-tables.md` but has no code).
- ~~Any authenticated data API (dashboards have nothing real to fetch).~~ The
  first one now exists: `GET/POST /me/bill` (`auth/src/routes/member.js`)
  serves the member's switch file from the `member_bills` table, seeded from
  `BillCheckupSubmissions` by email on first read. The rest of the dashboard
  (cohort, offers, activity) is still demo data.

### 1.4 Structural debts and risks

1. **`main` is 13 commits behind `auth-backend`.** The shared JS core, CI gates,
   benchmarks pipeline, dashboards, and auth function are all unmerged. The
   deploy workflow only fires on push to `main`, so the deployed `auth`
   function and the branch can drift.
2. **The 10 auth Data Store tables must be hand-created in the console**
   (Catalyst has no DDL API). Until then, auth boots degraded.
3. **Catalyst platform limits** (discovered by testing, undocumented): ZCQL
   silently truncates at 300 rows; no parameter binding (whitelist-validated
   literals only); no transactions; console-only DDL; domain mapping requires a
   production environment + a manual 48-hour SSL request.
4. **Bundle pages** (`index.html`, `partners.html`, 2 mobile pages) are
   self-unpacking design-tool exports needing `blob:`/`unsafe-eval` CSP carve-outs.
   Editable only via `scripts/bundle-edit.mjs`. A long-term maintainability tax.
5. **Consistency gaps:** `dashboard.html` doesn't load `whollar-core.js` and
   re-implements its helpers; the provider dashboard ships its demo control
   panel to all visitors; `whollar-member-dashboard-v8.html` is an unguarded
   duplicate (excluded from deploys via `.vercelignore`, but still in the repo).
6. **Compliance:** uploaded bills (name, address, account number) have **no
   retention policy** (PIPEDA / Quebec Law 25). Consent data rides in queue JSON
   only, not first-class columns.
7. **billOcr images >5 MB fail** (Anthropic caps images at 5 MB; multer accepts
   15 MB): typical phone photos need a client-side canvas downscale.

---

## Part 2: Target architecture

### 2.1 Guiding decisions

**D1: Finish, don't rewrite.** The stack (static Vercel frontend + Catalyst
serverless functions + Zoho CRM) is coherent and mostly built. The fastest path
to "professionally working" is completing the auth phases and wiring the
frontend, not replatforming.

**D2: Two-tier data strategy.** Catalyst Data Store is fine for what it does
today: lead capture, queues, auth records (simple keyed lookups, already
engineered around ZCQL's limits). It is a poor fit for the **marketplace core**
(cohorts, sealed bids, awards, money): no transactions, no foreign keys,
console-only schema, 300-row query ceiling. Plan: keep Tiers as follows:

- **Tier 1 (now → launch): Catalyst**: auth, forms, OCR, CRM sync, and the
  first member-data API. Ship on what exists.
- **Tier 2 (marketplace build): managed Postgres** (Neon or Supabase) behind a
  thin API layer for cohorts/bids/offers/payments, where transactional
  integrity actually matters. Auth sessions stay in Catalyst; the marketplace
  API validates the same `whollar_session` cookie by calling the auth
  function's session-introspection (or reading the shared table): decide at
  Phase D kickoff. This avoids betting the revenue-bearing domain on a platform
  whose limits have already cost real debugging time.

**D3, Same-origin everything.** The `/api/auth/*` Vercel rewrite is load-bearing
(cookies can't exist otherwise, Safari ITP). Extend the same pattern: every new
API mounts under `/api/*` rewrites. `api.whollar.ca` is a later optimization,
unblocked only after a Catalyst production environment + manual SSL cert exist.

**D4: localStorage becomes a cache, not the truth.** Keep the
`whollar.member` / `whollar.partner` shapes (per the PR #1 design note) but
populate them from `GET /api/auth/session`. The server session is authoritative;
localStorage only makes first paint fast.

**D5, One notification layer, CASL-compliant.** Transactional email first
(Zoho ZeptoMail, same ecosystem, CA data residency; Resend as fallback), SMS
(Twilio) only when bids actually land. Consent records already captured by
`W.consentPayload` become first-class columns.

### 2.2 Target system diagram

```
Browser (www.whollar.ca: Vercel static)
 ├── marketing pages / blog / bill-checkup          (public)
 ├── /whollar-login-consumer, /whollar-login-provider
 ├── /dashboard, /provider-dashboard                (session-guarded)
 │
 ├── same-origin /api/auth/*  ──rewrite──▶ Catalyst auth fn
 │        sessions, OTP login, signup, logout, session introspection
 ├── same-origin /api/member/* ─rewrite──▶ Catalyst memberApi fn   (Phase C)
 │        my bill, my cohort status, my offers
 ├── same-origin /api/market/* ─rewrite──▶ market API (Phase D, Postgres-backed)
 │        cohorts, sealed bids, awards
 │
 ├── cross-origin POST → formSubmit  (leads; stays as-is, preflight-free)
 └── cross-origin POST → billOcr     (extraction; stays as-is)

Catalyst (CA DC, Production env: to be created)
 ├── auth        sessions/cookies/CSRF/OTP/signup + auth tables
 ├── formSubmit  leads → Data Store + File Store → CrmSyncQueue
 ├── billOcr     Claude extraction
 ├── crmSync     cron every 5 min → Zoho CRM
 ├── memberApi   (new) authenticated member/provider data
 └── authCronCleanup (new) session/challenge sweeper

Postgres (Neon/Supabase, Phase D)
 └── cohorts, cohort_members, bids, offers, awards, payouts

Email: ZeptoMail (OTP, deep-read, cohort updates)   SMS: Twilio (bid alerts)
CRM: Zoho CRM (CA DC)   Payments: Stripe (Phase E)  Analytics: Clarity (installed)
```

---

## Part 3: Implementation guide, phase by phase

Phases are ordered by dependency. Each step lists **owner type**:
`[code]` = repo change, `[console]` = manual Catalyst/Zoho/Vercel console action
(only the account owner can do these), `[verify]` = acceptance check.

---

### Phase A: Stabilize the foundation (≈ 2–4 days, mostly console work)

Goal: one source of truth on `main`, a real production environment, the CRM
pipeline actually running on a schedule.

**A1. Merge `auth-backend` → `main`.**
- [code] Open a PR from `auth-backend` (16 commits, +10,293/−696 across 59
  files). Merge after review. This also un-drifts CI: `deploy-functions.yml`
  only runs on `main` pushes.
- [code] Delete/merge stale branches (`blog-launch`, `dashboard-login-integration`).
- [verify] `git log main..auth-backend` is empty; CI green on `main`.

**A2. Close the CI gaps.**
- [code] Add `auth` to the `deploy-functions.yml` test matrix (`npm ci` +
  `node --check index.js` + ideally `node --check src/**`).
- [code] Add a CI job that runs `scripts/qa-blog.mjs` against a local `serve`
  (currently manual).
- [verify] A syntax error introduced in `auth/src/app.js` fails CI.

**A3. Create the 10 auth tables** *(blocking everything in Phase B)*.
- [console] Follow `catalyst-backend/scripts/create-tables.md` click-by-click
  (Development env). Respect the matrices exactly: unique flags, mandatory
  flags, `sessions.token_hash` must NOT be an Encrypted column.
- [console] Set the auth BOOT env vars per `scripts/auth-env-setup.md`
  (`NODE_ENV`, `APP_BASE_URL`, `ALLOWED_ORIGINS`, space-separated,
  `CODE_PEPPER`/`IP_PEPPER`, hex; type keys by hand, the console validator
  rejects pastes confusingly).
- [verify] `GET /api/auth/health` → `status:'ok'`;
  `GET /api/auth/health/diagnostics` → schema verify passes 10/10.

**A4. Turn on the CRM cron (first-time creation, root cause already diagnosed:
no cron exists at all).**
- [console] Cloud Scale → Job Scheduling: Development env, target type
  **URL/Webhook** (NOT "Function", that type drops the `?key=` query and 403s),
  POST, every 5 min, URL
  `https://whollar-110003037934.development.catalystserverless.ca/server/crmSync/process?key=<CRM_CRON_SECRET>`.
- [console] Pre-create the `Lead_Source` picklist options in Zoho CRM (5 values
  + `[dev]` variants: list in `CRM_SYNC_RUNBOOK.md`).
- [verify] Submit a live form; queue row flips PENDING→SYNCED within ~5 min
  with **no manual curl**.

**A5. Create the Catalyst Production environment and promote.**
- [console] Add a payment method; click **Deploy to Production** (migrates
  functions + Data Store schema; data does not migrate: that's correct, dev
  leads stay dev).
- [console] In Production: re-set `ANTHROPIC_API_KEY` (billOcr), all auth BOOT
  vars, all `ZOHO_*`/`CRM_*` vars (`CRM_ENVIRONMENT=production`), create the
  production File Store folder, add whollar.com/.ca domains to Authorized
  Domains, recreate the cron against the production URL.
- [code] Update `UPLOADS_FOLDER_ID` in `formSubmit/index.js` if the prod folder
  ID differs; redeploy → promote.
- [code] **Single-line cutover:** change `W.CATALYST_HOST` in
  `js/whollar-core.js` (drop `.development.`) and the `vercel.json`
  `/api/auth/*` rewrite destination. Also update the 3 `standalone-pages/`
  snapshots or confirm they stay excluded.
- [console] Export the ~weeks of dev-table lead rows (`catalyst ds:export --dc ca`)
  and import into production tables so no lead is stranded in dev.
- [verify] One of each form submitted on www.whollar.com lands in the
  **Production** tables; three `GET /api/auth/health` calls return distinct
  `request_id`s (no rewrite caching).

**A6. Compliance quick wins.**
- [console] Set a File Store retention window (e.g. delete bill uploads after
  90 days unless attached to an active member): PIPEDA / Law 25.
- [console] Add the optional consent/verdict columns from `CRM_SYNC_RUNBOOK.md`
  item 5, then [code] write them in `formSubmit/index.js`.
- [console] DevOps → Application Alert on `crmSync` failed executions.

---

### Phase B: Real authentication (≈ 1–2 weeks)

Goal: the "Preview: accounts aren't live yet" notices come down. Passwordless
email-OTP for members; email+password (+OTP verify) for providers. All the
session/cookie/CSRF plumbing already exists: this phase is routes + email +
frontend wiring.

**B1. Transactional email (feature group `mail`).**
- [console] Set up ZeptoMail (Zoho, CA DC): domain verification for
  whollar.ca sending (SPF/DKIM), API key.
- [code] `auth/src/lib/mail.js`: one `sendOtpEmail(email, code)` (plus a
  generic template sender for later phases). Config already has the `mail`
  feature-group scaffolding in `config.js`.

**B2. OTP login/signup routes (the empty `src/routes/` gets its first files).**
- [code] `POST /otp/request`: validate email; create `auth_challenges` row
  storing `sha256(code + CODE_PEPPER)`, 10-min expiry, max 5 verify attempts;
  per-email + per-IP-hash rate limits (Catalyst Cache, same pattern as
  formSubmit); always return 200 (no account enumeration); send the email.
- [code] `POST /otp/verify`: constant-time compare (`safeEqual`), consume the
  challenge, find-or-create `users` + `auth_identities` (email), write a
  `consents` row, mint session via existing `sessions.create`, set cookie,
  return the same `{user}` shape as `GET /session`. Audit every outcome.
- [code] Signup metadata: accept `firstName`, `postal` on verify (or a
  follow-up `PATCH /me/profile`) so the current login form's fields land in
  `users`.
- [code] Register routes in `app.js`; keep them out of the degraded app.
- [verify] curl flow: request → mailbox code → verify → `GET /session` shows
  `authenticated:true`; wrong code 5× locks the challenge; audit rows written.

**B3. `authCronCleanup` (currently referenced but nonexistent).**
- [code] New function (or a route on auth guarded by a cron secret, mirroring
  crmSync's pattern: cheaper than a fifth function): sweep expired/revoked
  `sessions` and consumed/expired `auth_challenges` + `oauth_state`, paginating
  with `queryAll()`. Add to `catalyst.json` + CI matrix.
- [console] Schedule it daily (URL/Webhook type, same gotcha as A4).

**B4. Wire the consumer frontend to real auth.**
- [code] `whollar-login-consumer.html`: replace the localStorage write with the
  two-step OTP UI (email → 6-digit code: the provider page already has this
  exact UI to copy). Calls `W.AUTH_API + '/otp/request'` / `'/otp/verify'`
  with `credentials:'same-origin'`. On success, write `whollar.member` from the
  **server response** (D4: cache, not truth), then `W.safeNext` redirect.
- [code] `js/whollar-core.js`: add `W.auth.session()` (GET /session),
  `W.auth.logout()`, and `W.auth.require(loginUrl)`: a dashboard-boot helper
  that paints from the localStorage cache immediately, then confirms with
  `GET /session` and redirects/clears on `authenticated:false`.
- [code] `dashboard.html`: **load `whollar-core.js`** (it currently doesn't),
  replace the raw localStorage guard with `W.auth.require()`, wire sign-out to
  `POST /logout` + cache clear. Delete the duplicated `money`/`esc`/date
  helpers in favour of `W.*`.
- [code] Remove the "Preview" notices and the `robots` noindex on the login page
  once verified.
- [verify] Sign in on Safari + Chrome + Firefox (ITP is why the proxy exists:
  test it); session survives reload; logout kills it in all tabs (storage
  event); a hand-forged localStorage key bounces off the server check.

**B5. Provider auth.**
- [code] Routes: `POST /provider/signup` (email OTP verify + scrypt password
  set + create `provider_orgs`/`provider_users`), `POST /provider/login`
  (password, 12-h absolute session per existing TTL config),
  `POST /provider/password-reset/request|confirm` (Phase 5 group).
- [code] `whollar-login-provider.html`: the 3-step wizard already matches this
  shape: wire each step to the real endpoints; the OTP boxes finally verify
  something.
- [code] `provider-dashboard.html`: same `W.auth.require()` treatment with the
  partner key; **gate the demo control panel behind `?demo=1`** (currently
  ships to everyone): the console shows competitor-adjacent cohort internals.
- [verify] Same browser matrix; member session cannot open the partner console
  and vice versa (distinct userType checked server-side, not just separate
  localStorage keys).

**B6. Later auth phases (as demand justifies):** Google OIDC (phase 4: PKCE
helpers already in `crypto.js`, `oauth_state` table exists, CSRF exemption
regex already anticipates the callback), CRM linkage (6).

---

### Phase C: Member product on real data (≈ 1–2 weeks)

Goal: the dashboard stops lying. A member sees *their* bill, *their* verdict,
*their* region status.

**C1. `memberApi` function (new, or routes on auth: keep auth pure; separate
function recommended).**
- [code] Same-origin rewrite `/api/member/:path*` in `vercel.json` (+ the same
  no-store/no-rewrite-cache headers as `/api/auth`).
- [code] Session middleware reused from auth's `sessions.load` (extract the
  shared code into a small internal lib both functions vendor, or duplicate
  deliberately with a drift test: Catalyst functions can't share node modules
  across function dirs).
- [code] Endpoints:
  - `GET /me`: profile + completeness (replaces the hardcoded `PROF` array).
  - `GET /me/bill` / `PUT /me/bill`: the member's current bill snapshot
    (provider, monthly, speed, promoEnd) + computed verdict via the same
    scoring engine (port `score()` server-side or return inputs and let the
    client's `W.score()` run: client-side is fine, the data is theirs).
  - `GET /me/region`: FSA → region status (member counts per FSA from
    `WaitlistSignups`/`users`; honest numbers, no fake "61 of 100").
- [code] `BillCheckupSubmissions` gains a `UserId` column [console]; when a
  signed-in member runs the checkup, `bill-checkup.html` sends the session
  cookie via the same-origin `/api/member/bill-link` (or formSubmit keeps
  working anonymously and a post-login claim-by-email backfills).

**C2. Dashboard de-mocking.**
- [code] `dashboard.html`: fetch `/api/member/me`, `/me/bill`, `/me/region` on
  boot; render real values; keep the demo dataset **only** behind `?demo=1`.
  The promo-cliff card already prefers real `MEMBER.bill.promoEnd`: extend
  that pattern to every card. Offers/auction cards render an honest "your
  region hasn't opened bidding yet" empty state instead of fake providers.
- [code] Delete `whollar-member-dashboard-v8.html` from the repo (it's an
  unguarded duplicate; git history preserves it) or move it to `.backup/`.
- [verify] A fresh member with no bill sees truthful empty states; a member who
  ran the checkup sees their own numbers; nothing in the DOM says "Provider A".

**C3. OCR robustness.**
- [code] Client-side canvas downscale for images >5 MB before `/extract-bill`
  (the known 502 class); keep HEIC handling as-is.
- [code] billOcr: return explicit nulls with a `confidence` flag rather than
  hallucinated plausible values on unreadable input (known issue: blank PNG →
  fabricated $96.50). Add a "was anything legible" boolean to the tool schema
  and 422 on false.

---

### Phase D: Marketplace core: cohorts & sealed bidding (≈ 4–8 weeks)

Goal: the actual business. This is where Tier 2 (Postgres) enters: bids and
awards need transactions and real constraints.

**D1. Stand up Postgres (Neon or Supabase, CA region if available) + a
`market` API.** Host the API as a Vercel Function (same repo, same-origin
`/api/market/*` natively: no rewrite needed) or another Catalyst function with
a pg client; Vercel Functions recommended: first-class env vars, no console
DDL, migrations in git (e.g. `drizzle` or `node-pg-migrate`).
- Schema v1:
  - `cohorts(id, fsa, region_name, renewal_window_start/end, status: forming|open_for_bids|bids_closed|awarded|migrating|done, min_size, created_at)`
  - `cohort_members(cohort_id, user_email/user_id, bill_snapshot jsonb, status: joined|offered|accepted|declined|migrated, joined_at)`: unique(cohort_id, user_id)
  - `provider_accounts(id, catalyst_provider_org_id, verified_at, stripe_customer_id)`
  - `bids(id, cohort_id, provider_id, price_cents, terms jsonb, submitted_at, sealed until cohort.status='bids_closed')`: unique(cohort_id, provider_id)
  - `awards(cohort_id, bid_id, awarded_at, fee_cents, fee_status)`
  - `events(...)` append-only audit.
- Auth bridge: the market API validates `whollar_session` by calling
  `GET <catalyst>/server/auth/session` server-to-server with the forwarded
  cookie (introspection; simple, no shared secrets): cache 60 s.

**D2. Cohort formation job.** Nightly cron (Vercel Cron): cluster
`cohort_members`-eligible members by FSA + renewal window (the FSA→cohort
naming logic already exists client-side in the checkup: port it); open a
cohort at `min_size`; emit email ("your cohort is forming") via the Phase B
mail layer.

**D3. Provider console goes real.** `provider-dashboard.html` fetches
`/api/market/provider/cohorts` (open cohorts in their coverage, the
`PartnerApplications` provinces/tech data seeds coverage), submits sealed bids
(`POST /bids`, server refuses to return competitors' bids until close), sees
win/loss after close. The existing demo "virtual clock" becomes real
`cohorts.renewal_window` timing.

**D4. Member offer flow.** When bids close: rank per cohort, present offers on
the member dashboard (`GET /me/offers`), accept/decline
(`POST /me/offers/:id/accept`), SMS/email "bids landed". Acceptance creates the
concierge work queue: v1 of "concierge" is honestly a Zoho CRM task list per
accepted offer (ops does the switch manually; automate later).

**D5. Provider verification & payments (revenue).**
- Verification: manual ops review of `PartnerApplications` (business number,
  LOA) with a `verified_at` flip: a console/admin page can wait; a protected
  Retool-style internal tool or even direct SQL is fine at first.
- Stripe: provider on file at verification; success fee invoiced on
  `awards` (`fee_status: invoiced|paid`). Webhook → `fee_status` update.

**Ship D behind a region gate:** one FSA/city pilot cohort first, hand-picked
from the existing waitlist tables (this is also the go-to-market plan).

---

### Phase E: Communications, growth, ops (parallel with C/D)

- **E1** Email templates: OTP (B), deep-read results (the checkup already
  promises "we email what we find": currently nobody sends it), cohort
  updates, offer alerts. All CASL-footered; consent columns from A6.
- **E2** Twilio SMS: phone verification at waitlist (number already collected),
  "bids landed" alert. Store consent per channel.
- **E3** Referral mechanics: DONE. Codes derive from the account id
  (`lib/referral.js`), share links carry `?ref=` and are banked by the browser
  until a signup spends them, signup normalises and rejects self-referral, and
  the dashboard card shows the live count from `GET /me/referral`. What is not
  built: a reward attached to a referral, and any admin view of who referred
  whom beyond the `auth_events` detail written at signup.
- **E4** Observability: uptime checks on `/api/auth/health` + formSubmit;
  Catalyst DevOps alerts (crmSync: A6, auth failures); a weekly ZCQL row-count
  digest (queue depth, FAILED rows). Anthropic spend cap (console) as the
  billOcr backstop; consider Turnstile in front of `/extract-bill`.
- **E5** Analytics: Clarity is installed; add conversion events (checkup
  completed, waitlist joined, signed in) via a tiny `W.track()` wrapper so the
  vendor stays swappable.

---

### Phase F: Frontend consolidation & scale hardening (ongoing)

- **F1** Rebuild `index.html` and `partners.html` as normal hand-written HTML
  (like every product page already is). Kills the `blob:`/`unsafe-eval` CSP
  carve-outs, the 2 MB payloads, the `bundle-edit.mjs` editing tax, and the
  double-init hacks. Do it one page at a time; the CSP override rules come out
  with the last bundle.
- **F2** Unify mobile: fold the 4 hand-maintained mobile pages into the
  generated overlay system (`build-mobile-pages.mjs`) as their desktop pages
  become normal HTML (F1 unblocks consumer/provider).
- **F3** Add `/dashboard` + login pages to `device-router.js` pairs or (better)
  make the dashboards responsive: they're normal HTML, a media query beats a
  second page.
- **F4** Introduce a minimal test layer where money/eligibility logic lives:
  node:test unit tests for `W.score()`, postal parsing, and the auth routes
  (they're plain express: supertest works), wired into `check-frontend.yml` /
  `deploy-functions.yml`.
- **F5** Revisit `api.whollar.ca` (Catalyst Domain Mapping) once the production
  environment exists: removes the Vercel proxy hop for auth. Keep the rewrite
  until then; it is correct, not a hack.

---

## Part 4: Sequencing summary & first moves

```
A. Stabilize        ██ merge → tables → cron → PROD env → cutover      (days)
B. Real auth        ████ mail → OTP routes → wire both logins          (1–2 wk)
C. Real dashboard   ███ memberApi → de-mock → OCR fixes                (1–2 wk)
D. Marketplace      ████████ Postgres → cohorts → bids → offers → fees (4–8 wk)
E. Comms/ops        ─── parallel from B onward
F. Consolidation    ─── background, opportunistic
```

**This week, in order:**
1. Merge `auth-backend` into `main` (A1): everything else assumes it.
2. Console session: create the 10 auth tables + BOOT env vars (A3), create the
   CRM cron (A4). Two hours of clicking that unblocks both pipelines.
3. Start Catalyst Production creation (A5): it has lead time (billing, SSL if
   pursuing the domain later).
4. Begin B1/B2 (mail + OTP routes) in code: it doesn't depend on A5 finishing;
   it can be built and tested against dev.

**Definition of "working, professionally" (exit criteria):**
- A visitor can sign up with a real emailed code, sign in on any browser, and
  see a dashboard showing their own bill and an honest region status.
- Every live form writes to a **production** datastore and reaches the CRM
  within 5 minutes automatically.
- No page claims anything the system can't do (no fake offers, no fake OTP).
- One pilot cohort has run end-to-end: formed → bid → offered → accepted →
  switched → success fee invoiced. That's the business, working.
