# Whollar — Admin Console: Plan & Architecture

> The complete plan and architecture for the Whollar admin console: the
> restricted control plane that manages site information, turns bidding on and
> off (globally and per campaign), and performs the human approval of provider
> organisations. Only platform admins can reach any of it.
>
> Written 2026-07-30. Companion to `docs/MASTER_PLAN.md` (its phases A–E are
> referenced below). Supersedes the earlier draft of this file.
>
> **Build note (2026-07-30, later the same day):** the console was built —
> `routes/admin.js` + `routes/public.js` in the auth function, and a
> stand-alone frontend in `admin-console/`. Two decisions changed from this
> plan during the build, at the owner's direction: the console is hosted on
> its **own subdomain `admin.whollar.ca`** (a separate Vercel project whose
> `vercel.json` proxies `/api/auth/*` to the same Catalyst function — still
> same-origin from the browser's view, so §2's rules hold), and admin
> identity is **`users.user_type = 'admin'` gated by `ADMIN_EMAIL_DOMAIN`
> (@whollar.com) + OTP**, not a `role` column — no users-table change needed,
> and every member/provider guard excludes admins for free. Go-live steps:
> `docs/ADMIN_CONSOLE_RUNBOOK.md`.

---

## 0. The single most important fact

**The backend was already designed for this console — it's the missing half.**

- `provider_orgs` carries `approval_status` (`pending | approved | rejected`),
  `approved_by`, `approved_at` — and `routes/provider.js` states the contract
  in its header comment: *"APPROVAL decides whether we deal with that company
  at all. A human sets `provider_orgs.approval_status`. **No code path here can
  set it to `approved`.**"* Today that human has no surface to set it from
  except raw console row-editing. The admin console is that surface.
- `orgs.js` notes that a domain race can produce a duplicate empty org "an
  operator can merge" — the admin console is where that operator works.
- Verified-but-unapproved partners already get a session carrying
  `approved: false`, and every real-data surface is required to check it.
  **Caveat (verified 2026-07-30):** today that check lives only in the partner
  console's front-end banner — `/provider/me` and `/provider/campaigns` gate
  on `user_type === 'provider'` and return `approved` as data, not as a gate
  (defensible while everything they serve is counts-only). Any future route
  that serves real data, bids first of all, must enforce `approved`
  server-side — and ADM-4's *suspend* only bites if it does.

So this is not a new system. It is one new role, one new route file, two new
tables, and one new page, plugged into auth/session/CSRF/audit/mailer
infrastructure that is already deployed and battle-tested.

---

## 1. Scope — what the admin console controls

| Domain | Controls |
|---|---|
| **Access** | Only users with the platform `admin` role can load the console or call any `/admin/*` API. There is no signup path to admin — admins are minted by allowlist (see §3). |
| **Site information** | Prices, thresholds, banner/notice copy, feature flags — every "business setting" the marketing site and dashboards render. Changed in the console, live on next page load, **no deploy**. |
| **Bidding control** | A global bidding kill switch, plus per-campaign lifecycle: create → forming → auction (bidding open) → closed → archived. Enforced **server-side** in the provider routes, not just hidden in the UI. |
| **Provider approval** | The human gate: review a provider org (and the partner application that led to it), approve / reject / suspend. Approval is what unlocks the partner console's real data. Includes the org-merge repair tool. |
| **Visibility** | Read-only lead views (CRM stays the primary lead desk), CRM queue health, deep-read queue, audit trail. |

Out of scope (deliberately): editing benchmark prices (`whollar-benchmarks.js`
is generated from 6,803 real advertised plans and CI-gated — market *data*,
never a setting), lead nurturing (Zoho CRM's job), and the Phase-D marketplace
money objects (bids/awards/payouts live in the future Postgres market API; the
admin console will grow surfaces for them there, see §10).

---

## 2. System architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Browser — www.whollar.ca (Vercel static)                                 │
│                                                                          │
│  admin.html  ─── loads whollar-core.js, checks session → role=admin      │
│   │   (client check is UX only; the server re-checks every request)      │
│   │                                                                      │
│   │ same-origin fetch: whollar_session cookie + CSRF header (existing)   │
│   ▼                                                                      │
│  /api/auth/*  ── vercel.json rewrite ──▶ Catalyst `auth` function        │
│                                                                          │
│  public pages ──▶ GET /api/auth/public/config   (no auth, cacheable)     │
│  provider-dashboard ──▶ GET /provider/campaigns (bidding gate enforced)  │
└──────────────────────────────────────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼─────────────────────────────────────┐
│ Catalyst `auth` function (existing app.js / middleware stack)            │
│                                                                          │
│  src/routes/admin.js   (NEW — mounted behind requireAdmin middleware)    │
│    overview · config CRUD · campaigns CRUD · provider approval ·         │
│    org merge · leads read · deep-reads · audit read                      │
│                                                                          │
│  src/routes/public.js  (NEW — GET /public/config only)                   │
│                                                                          │
│  existing routes gain flag checks:                                       │
│    campaigns.js  → reads `campaigns` table (catalog fallback) +          │
│                    site_config.bidding_enabled                           │
│    provider.js   → unchanged (approval was always read from the table)   │
│                                                                          │
│  existing libs reused: sessions · csrf · audit · ratelimit · mailer ·    │
│                        datastore (ZCQL hazards handled) · errors         │
└──────────────────────────────────────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼─────────────────────────────────────┐
│ Catalyst Data Store                                                      │
│  existing: users · sessions · provider_orgs · provider_users ·           │
│            campaign_members · auth_events · PartnerApplications · leads… │
│  NEW:      site_config · campaigns                                       │
│  File Store: bill uploads (admin gets short-lived proxied reads)         │
└──────────────────────────────────────────────────────────────────────────┘

Email (mailer.js, existing): approval / rejection notices to providers.
```

Three architectural rules, inherited from the Master Plan and kept:

1. **Same-origin everything (D3).** The console is a page on the main site;
   its API rides the existing `/api/auth/*` rewrite. No new domain, no new
   cookie story, no CORS.
2. **Server is the boundary.** Every flag and every role is enforced in the
   Catalyst function. The static `admin.html` being world-downloadable is fine
   — it contains zero data; everything it shows comes from authenticated calls.
3. **Graceful degradation.** Like `campaign_members`, if a new table doesn't
   exist yet the site falls back (config → shipped defaults, campaigns → code
   catalog). The console going down must never take the marketing site down.

---

## 3. Access control — "only people with admin access"

### 3.1 Identity model

Platform admin is a **user attribute**, not a separate account system:

- Add `role` (Var Char 16, default `user`) to the existing `users` table.
  Values: `user | admin`. (Kept separate from `user_type` member/provider —
  an admin is a staff person, orthogonal to being a member; and separate from
  `provider_users.role` admin/bidder/viewer, which is an **org-level** role
  that grants nothing on the platform.)
- **Bootstrap by allowlist:** `ADMIN_EMAILS` env var (space-separated, same
  convention as `ALLOWED_ORIGINS`). At OTP verify, if the normalized email is
  on the list and `role !== 'admin'`, promote and audit (`admin.promote`,
  actor `system:allowlist`). No signup path, no console row-editing, no
  self-service. Removing an email from the list does not demote by itself —
  demotion is an explicit admin action (or console edit), so a config typo
  can't lock everyone out silently.

### 3.2 Authentication & session

- Admins sign in through the **existing member OTP flow** (email code). No new
  password system, no new challenge table. The session cookie, expiry,
  revocation, and CSRF are all the deployed ones.
- `GET /session` response gains `role` so the frontend can route; the server
  never trusts it back.

### 3.3 Authorization — `requireAdmin`

New middleware in `app.js`, mounted ahead of the whole `/admin` router:

```
session cookie → sessions.verify (existing)
  → users.findById → role === 'admin' ?  next()
  → else 403 (body identical to the generic forbidden — no admin-existence oracle)
every request under /admin also passes the existing CSRF check on mutations
```

Additional hardening on the admin surface:

- **Step-up for destructive actions:** approval/rejection/suspension, org
  merge, and the bidding kill switch require a session younger than 12 h
  (`sessions.issued_at` is derivable; otherwise re-OTP). Cheap insurance
  against a stolen long-lived cookie.
- **Rate limits** on `/admin/*` (existing `ratelimit.js`, modest caps — this
  surface has ~2 users).
- **Full audit:** every mutation writes `auth_events` (the audit table —
  there is no table literally named `audit_log`) via the existing
  `audit.recordAsync` — actor user_id, action, target id, before → after
  snapshot (JSON, truncated). The console itself has an "Audit" tab reading it.
- Optional later: `ADMIN_IP_ALLOWLIST` env (hashed-IP check, same
  `IP_PEPPER` pattern) — off by default; a VPN requirement can come when
  there's a team.

### 3.4 What being admin does NOT grant

No raw File Store browsing (bill files are proxied per-request with an audit
row), no reading OTP codes or credential hashes (Encrypted columns stay
code-only), no impersonation ("login as user" is explicitly out of scope —
support flows read data, they don't borrow sessions).

---

## 4. Data model

### 4.1 NEW `site_config` — the information & flags store

| Column | Type | Len | Unique | Mandatory | Notes |
|---|---|---|---|---|---|
| `config_key` | Var Char | 64 | ✅ | ✅ | e.g. `membership_price`, `bidding_enabled`, `banner_notice` |
| `value` | Text | — | | ✅ | JSON-encoded (string/number/bool/object) |
| `value_type` | Var Char | 16 | | ✅ | `string \| number \| boolean \| json` — the console renders the right editor and validates writes |
| `published` | Boolean | — | | | only published keys appear in `GET /public/config` |
| `description` | Var Char | 255 | | | shown in the console so future-you knows what a key does |
| `updated_by` | Var Char | 64 | | | admin user_id |
| `updated_at` | DateTime | — | | | |

Seed keys (day one): `bidding_enabled` (bool, **the global kill switch**),
`membership_price`, `default_switch_threshold`, `banner_notice`,
`waitlist_open` (bool), `provider_signups_open` (bool).

Read paths:
- `GET /public/config` → published keys only, `Cache-Control: max-age=60`,
  fetched by `W.siteConfig()` in `whollar-core.js` (localStorage-cached like
  the member shape — config is a cache, server is truth: Master Plan D4).
- Server-side reads (the flag checks in §6) go straight to the table with a
  60-second in-process memo — a config flip propagates in ≤1 min without
  hammering ZCQL on every request.
- **Fallback:** table missing/unreadable → `DEFAULT_CONFIG` frozen object in
  code (current hardcoded values). Site never breaks because config is down.

### 4.2 NEW `campaigns` — the catalog, promoted from code to data

`routes/campaigns.js` currently holds the catalog as a code constant —
reasonable when campaigns changed "by deploy (an ops decision)". The admin
console exists precisely to make that an ops decision *without* a deploy, so
the catalog becomes a table with the same shape:

| Column | Type | Len | Unique | Mandatory | Notes |
|---|---|---|---|---|---|
| `campaign_id` | Var Char | 64 | ✅ | ✅ | slug, e.g. `london-east` (immutable once created) |
| `region` | Var Char | 100 | | ✅ | display name |
| `sub` | Var Char | 100 | | | e.g. `Autumn cohort` |
| `kind` | Var Char | 16 | | ✅ | `forming \| waitlist \| planned \| auction \| closed \| archived` |
| `target` | Int | — | | | household target; null for auction |
| `seed_members` | Int | — | | | baseline, as today |
| `seed_households` | Int | — | | | baseline, as today |
| `bidding_open` | Boolean | — | | | per-campaign bid gate (see §6) |
| `sort_order` | Int | — | | | console-controlled display order |
| `created_by` / `updated_by` | Var Char | 64 | | | admin user_id |
| `created_at` / `updated_at` | DateTime | — | | | |

- `campaigns.js` changes from `const CATALOG = [...]` to "read the table
  (60-s memo); **fall back to the code CATALOG if the table is missing**" —
  the exact graceful-degradation pattern the module already uses for
  `campaign_members`. Existing member/provider routes keep their shapes;
  `campaign_members` is untouched.
- One-time seeding: a console-run script (or the console's "import defaults"
  button) inserts the six current catalog rows.

### 4.3 Existing tables the console operates on (no schema change)

- `provider_orgs` — the approval object (§7). Add nothing; `approval_status`,
  `approved_by`, `approved_at` were built for this. One addition worth making
  while in the console: `rejection_reason` (Var Char 255).
- `provider_users`, `users` — read for the approval review screen (who signed
  up under this org). `users` gains only the `role` column (§3).
- `PartnerApplications` — linked into the review screen by email domain, so
  the human sees the application form answers next to the org they're
  approving.
- `auth_events` (the audit log) — gains new action types, no schema change.
- Lead tables (`WaitlistSignups`, `BillCheckupSubmissions`, `DeepReadRequests`,
  …) — read-only, paginated.

---

## 5. API surface — `src/routes/admin.js`

All routes: session + `requireAdmin` + CSRF on mutations + audit on mutations.
All list routes paginated (`limit`≤100 + `offset` cursor) because **ZCQL
silently truncates at 300 rows**; the UI always shows a "more" affordance.
`:table` on the leads route resolves through a hardcoded allowlist (ZCQL has
no parameter binding — nothing from a URL ever reaches a query as a literal
without whitelist validation, the established `formSubmit` pattern).

```
# Situational awareness
GET  /admin/overview            counts per lead table, CrmSyncQueue depth by
                                status, pending provider orgs, campaign joins,
                                bidding_enabled state

# Site information
GET  /admin/config              all keys incl. unpublished
PUT  /admin/config/:key         validate against value_type, write, audit
                                (creates the key if new)

# Bidding & campaigns
POST /admin/bidding             { enabled: bool }  → site_config.bidding_enabled
                                (step-up required; audited as admin.bidding.toggle)
GET  /admin/campaigns           table + live member/household tallies
POST /admin/campaigns           create (slug validated ^[a-z0-9-]{3,64}$)
PUT  /admin/campaigns/:id       edit fields, change kind, open/close bidding
POST /admin/campaigns/:id/transition   { to: 'auction' | 'closed' | ... }
                                validated against the §6 state machine

# Provider approval (the human gate)
GET  /admin/providers                    orgs by approval_status, with member
                                         counts and matched PartnerApplications
GET  /admin/providers/:orgId             full review: org, its provider_users,
                                         the users behind them, application rows
POST /admin/providers/:orgId/approve     status→approved, stamp approved_by/at,
                                         email the org's users, audit (step-up)
POST /admin/providers/:orgId/reject      { reason } → status→rejected + email + audit
POST /admin/providers/:orgId/suspend     approved→pending (kills real-data access
                                         on next session check) + audit
POST /admin/orgs/merge                   { fromOrgId, toOrgId } — the duplicate-
                                         domain repair orgs.js anticipates: move
                                         provider_users rows, delete empty org

# Visibility
GET  /admin/leads/:table        whitelisted table names only; read-only
GET  /admin/deep-reads          queue + per-file short-lived proxied download
POST /admin/deep-reads/:id/complete
GET  /admin/audit               filterable by actor / action / target
```

And one **unauthenticated** route in its own module (`public.js`):

```
GET /public/config              published site_config subset, 60-s cache
```

---

## 6. Control-plane semantics — how "bidding off" actually stops bidding

Two independent gates, both enforced server-side; the UI only mirrors them.

**Gate 1 — global kill switch** (`site_config.bidding_enabled`):

- `GET /provider/campaigns` keeps answering (partners still see their desk)
  but the response carries `bidding: { enabled: false, notice }`; the provider
  dashboard renders bid forms disabled with the notice.
- Any future bid-placing route (`POST /provider/bids` — Phase D) **refuses**
  with `409 bidding_paused` when the flag is off. The check lives in one
  helper (`requireBiddingOpen(campaign)`) so no future route can forget it.
- Member-side surfaces read the same flag from `/public/config` to adjust
  copy ("bidding opens soon") — cosmetic, since members never place bids.

**Gate 2 — per-campaign lifecycle** (`campaigns.kind` + `bidding_open`):

```
                    admin creates
                         │
        ┌──────────┬─────┴────┐
        ▼          ▼          ▼
     planned → waitlist → forming ──▶ auction ──▶ closed ──▶ archived
     (notify    (joinable  (joinable,  (locked;    (no bids;   (hidden
      only)      as wait-   fills to    bidding_    results     from all
                 list)      target)     open=true)  visible)    surfaces)
```

- Transitions are validated server-side (`/admin/campaigns/:id/transition`
  rejects e.g. `archived → auction`); each transition is audited.
- `bidding_open` is only meaningful in `auction` and is set false by
  `closed`. Effective bidding for a campaign =
  `site_config.bidding_enabled && campaign.kind === 'auction' && campaign.bidding_open`.
- Member join/leave rules stay exactly as `JOIN_STATUS` encodes today —
  `forming/waitlist/planned` joinable, `auction+` not — but now read from the
  table, so the console moving a campaign to `auction` immediately locks
  member joins **and** opens the partner bid window in the same act.

**Site information** propagates the same way: console PUT → `site_config` →
(≤60 s) server reads + `GET /public/config` → pages render new values on next
load. Hardcoded prices in normal pages become `data-config="membership_price"`
placeholders filled by `W.siteConfig()`; the two sealed bundle pages get a
one-time `scripts/bundle-edit.mjs` surgery to add the same placeholders, after
which their numbers never require touching a bundle again.

---

## 7. Provider approval — the human-gate workflow

State machine on `provider_orgs.approval_status` (existing values, one new
optional column `rejection_reason`):

```
            signup (auto)                    admin only
 (none) ────────────────▶ pending ──approve──▶ approved
                            ▲  │                  │
                            │  └──reject──▶ rejected   (terminal unless
                            │                            admin re-opens)
                            └────────suspend──────────┘
```

- **pending** — what signup creates. Partner can log in, sees "under review".
- **approve** — sets `approved`, stamps `approved_by` (admin user_id) and
  `approved_at`, emails every user in the org's `provider_users` ("your
  Whollar partner console is live"), audits. *This is the only place in the
  entire system that writes `approved` — preserving the invariant
  `provider.js` documents.*
- **reject** — with a required reason; email + audit. Rejected orgs' users
  keep the "not approved" landing, never real data.
- **suspend** — `approved → pending`, for when something changes about a
  company. Their sessions keep working but every real-data surface re-checks
  approval (already the contract), so access drops on the next request.

The review screen shows everything a human needs in one place: org (domain,
legal name), the people who signed up under it, and the matching
`PartnerApplications` row(s) by email domain — the form answers (provinces,
access tech, business number, LOA…) are the actual review material.

The **org merge** tool handles the documented race (two orgs for one domain):
pick survivor, move memberships, delete the empty row, audit. Rare, but when
it happens it currently requires raw console surgery.

---

## 8. Admin frontend — `admin.html`

One static page, same stack as every other page in the repo (plain HTML +
`whollar-core.js`, no framework, Satoshi/Inter, the existing design language).
Deployed with the site; **excluded from `sitemap.xml` and given
`<meta name="robots" content="noindex">`** (secrecy is not the security — the
server is — but there's no reason to advertise it).

Boot sequence:
1. `W.session()` → not signed in → redirect to member login with
   `?return=/admin.html`.
2. Signed in but `role !== 'admin'` → render a plain 404-style "not found"
   body (no hint that an admin surface exists).
3. Admin → load tabs. Every tab is a thin renderer over one `/admin/*` route.

Tabs (matching §5): **Overview** (counts, queue health, bidding state with the
big switch) · **Site config** (typed editors per `value_type`, publish toggle)
· **Campaigns** (table + lifecycle buttons + create form) · **Providers**
(pending queue first; review screen; approve/reject/suspend; merge tool) ·
**Leads** (read-only, paginated, per-table) · **Deep reads** (queue + file
view + complete) · **Audit** (filterable log).

Mobile: the console is desktop-first; it gets the responsive-enough treatment
but is deliberately **not** added to `device-router.js`'s mobile-pair system —
no mobile twin to keep in sync for an internal tool.

---

## 9. Threat model & security non-negotiables

| Threat | Defence |
|---|---|
| Non-admin calls `/admin/*` directly | `requireAdmin` on the router mount — server-side, every request; generic 403 |
| Stolen admin cookie | Step-up (fresh session) for approve/reject/suspend/merge/kill-switch; existing session expiry + revocation; audit trail to detect |
| CSRF on mutations | Existing Origin-based CSRF middleware, admin routes included |
| Account enumeration via admin flows | Admin uses the existing opaque OTP flow; 403 body identical to generic forbidden |
| ZCQL injection via console inputs | No parameter binding exists → whitelist-validated literals only (existing pattern); table names from a hardcoded map; slugs regex-validated |
| Silent data truncation | Every list paginated; never render a count derived from a 300-row-capped read as if complete (`overview` uses `SELECT COUNT`) |
| Config typo takes the site down | `value_type` validation on write; `DEFAULT_CONFIG` fallback on read; `public/config` serves last-good on table errors |
| Kill switch forgotten in new code | Single `requireBiddingOpen()` helper; adding a bid route without it fails code review by convention (documented in the route file header) |
| Bill-file exposure | Files proxied through an authed, audited, short-lived route — File Store never exposed directly |
| Admin self-lockout | Allowlist promotion is idempotent at every login; demotion never automatic |
| Compromised `ADMIN_EMAILS` env | Env vars are console-only (same trust level as every existing secret: peppers, API keys); changing it requires Catalyst console access, which is the root of trust already |

Plus the standing rules: every mutation audited with before/after; no
Encrypted column ever readable through the console; rate limits on all admin
routes; `NODE_ENV=production` flip (already owed) before any of this goes live
— the dev-mode code-reveal behaviour (`canRevealCode`) must be dead first.

---

## 10. Build plan — phases, order, acceptance

### ADM-0 · Prerequisites (console session, ~half a day) — mostly already owed
1. CRM cron creation (Master Plan A4) — lead management lives in Zoho CRM now.
2. Create tables: `campaign_members` (owed), `site_config`, `campaigns`;
   add `users.role`, `provider_orgs.rejection_reason` columns.
3. Flip `NODE_ENV` (owed from auth phase 5). Set `ADMIN_EMAILS`.
- ✅ *Accept:* `/api/auth/health/diagnostics` schema verify passes including
  new tables; a form submission reaches Zoho CRM unattended.

### ADM-1 · Admin identity & shell (~2 days, code)
1. Allowlist promotion at OTP verify; `role` in session payload.
2. `requireAdmin` middleware + step-up helper; mount empty admin router.
3. `GET /admin/overview`; `admin.html` with boot sequence + Overview tab.
- ✅ *Accept:* non-admin session → 403 + audit row; admin sees live counts;
  page renders "not found" for a signed-in non-admin.

### ADM-2 · Site information (~2–3 days, code)
1. `site_config` CRUD + `GET /public/config` + `W.siteConfig()` core helper.
2. Replace hardcoded editable values in normal pages; one-time bundle surgery
   for the two sealed pages (placeholder elements).
3. Config tab with typed editors + publish toggle.
- ✅ *Accept:* change `membership_price` in the console → marketing page shows
  it on refresh, zero deploys; audit row has before/after; deleting the
  `site_config` table (dev) leaves the site rendering defaults.

### ADM-3 · Campaigns & bidding control (~3–4 days, code)
1. Promote catalog: `campaigns` table read with code-catalog fallback; seed.
2. Lifecycle transitions + `bidding_open`; `requireBiddingOpen()` helper;
   `bidding_enabled` kill switch route; provider routes return the bidding
   state; provider dashboard renders disabled bid UI when off.
3. Campaigns tab (create, edit, transition, live tallies) + the kill switch
   on Overview (step-up gated).
- ✅ *Accept:* flip the kill switch → within 60 s `GET /provider/campaigns`
  reports `bidding.enabled:false` and the dashboard disables bid forms;
  moving a campaign to `auction` locks member joins (409 on `/campaigns/join`)
  in the same minute; `archived → auction` transition is refused.

### ADM-4 · Provider approval (~3–4 days, code)
1. Providers list/review routes (orgs + memberships + matched applications).
2. Approve / reject / suspend with step-up, mailer templates, audit.
3. Org merge tool. Providers tab UI.
- ✅ *Accept:* end-to-end — a real partner signup lands `pending`; console
  approve → they receive the email and the partner console shows real data;
  suspend → their next request is back behind the "under review" wall. The
  invariant holds: `grep`ing the codebase for writes of `approved` finds
  exactly one call site, inside `/admin/providers/:orgId/approve`.

### ADM-5 · Visibility (~2 days, code)
Leads read views, deep-read queue with proxied file access, audit tab.
- ✅ *Accept:* a 400-row lead table pages correctly past the 300-row ZCQL
  ceiling; opening a bill writes an audit row.

### Beyond — Phase D alignment
When the marketplace core (sealed bids, awards, money) lands on Postgres, the
admin console grows tabs for those objects backed by the market API — same
page, same session, `requireAdmin` introspected across services (Master Plan
D2 decision point). `site_config`, campaigns, approval, and lead visibility
stay exactly where this document puts them.

**Total: roughly 2–2.5 weeks of code after the half-day console session**, all
inside the existing auth function and one new page. No new services, no new
auth system, no new hosting, no framework.

---

## 11. Decisions taken (so they don't get re-litigated)

- **Buy vs build:** no Retool/Zoho Creator — they'd need service credentials
  into the Data Store, can't reuse the session/approval logic, and the team is
  1–2 people. Revisit only at Phase D (Postgres makes buy-options viable).
- **Inside the auth function, not a new function:** approval and roles are
  auth-domain objects; a separate `adminApi` function would duplicate the
  session/CSRF/datastore stack and add a cold path. Split later if it grows.
- **Catalog → table now, not later:** "bidding on/off from the console" is
  incompatible with a campaign catalog that changes only by deploy. The
  fallback-to-code pattern keeps the risk at zero.
- **Admin via role, not separate user table:** one identity system, one
  session mechanism, no second login page to secure.
- **No impersonation, no raw file browsing, no Encrypted-column reads** — the
  console is powerful enough without becoming the breach amplifier.
