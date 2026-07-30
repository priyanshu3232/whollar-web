# Whollar — Backend as it exists today: the admin-panel hand-off

> The current state of `catalyst-backend/`, verified against the code on
> 2026-07-30. This is the "what exists" companion to
> `docs/ADMIN_PORTAL_PLAN.md` (which is the "what to build"); read this first
> so the admin work plugs into real seams. Sibling docs:
> `docs/ADMIN_HANDOFF_DASHBOARDS.md`, `docs/ADMIN_DESIGN_GUIDELINES.md`.

---

## 1. Topology

Zoho **Catalyst** serverless (project `Whollar`, env `Development`,
`whollar-110003037934.development.catalystserverless.ca`), four Advanced-I/O
node20 functions declared in `catalyst-backend/catalyst.json`:

| Function | What it is | Where admin work lands |
|---|---|---|
| `auth` | The real app: `src/app.js` + `src/lib/*` (16 libs) + `src/routes/*` (otp, password, reset, google, provider, member, campaigns) | **Here.** New `routes/admin.js` + `routes/public.js` mount into the same router/middleware stack |
| `formSubmit` | Public lead intake (6 POST routes, own CORS, no sessions) | Read-only "Leads" tab reads its tables |
| `billOcr` | `/extract-bill` → claude-sonnet-5 tool-forced field extraction | Untouched |
| `crmSync` | Cron-secret-gated queue drainer → Zoho CRM | Overview tab reads `CrmSyncQueue` depth |

Browser path: `https://www.whollar.ca/api/auth/*` → vercel.json rewrite →
`/server/auth/*`. The router is mounted at both `/` and `/auth`, so
`/health` and `/auth/health` are the same route. Same-origin cookie
(`whollar_session`, host-only, HttpOnly, SameSite=Lax) + Origin-allowlist
CSRF on mutations (no token — a custom header would trigger a preflight the
Catalyst gateway answers without CORS headers).

Config is fail-fast: `config.load()` validates everything at boot and a
broken env serves a degraded app (health says `degraded`, all else 503).
Admin additions (`ADMIN_EMAILS`) should join `config.js` the same way.

## 2. Route surface today (what the admin console sits beside)

- Core: `GET /health`, `GET /health/mail`, `GET /session` (200 with
  `authenticated:false`, never 401), `POST /logout`; dev-only
  `GET /health/diagnostics` (schema verify + row counts) and
  `POST /dev/logout-everywhere`.
- Member auth: `/otp/start`, `/otp/verify`, `/signup`, `/signup/verify`,
  `/login`, `/password/forgot`, `/password/reset`, `/google/start`,
  `/google/callback` (CSRF-exempt, single-use `oauth_state`). Google is the
  only social provider — Apple was removed 2026-07-30.
- Partner auth: `/provider/signup` (creates org via
  `orgs.findOrCreateForDomain`, refuses free-mail domains),
  `/provider/signup/verify`, `/provider/login` (unapproved partners still
  get sessions, with `approved:false`), `GET /provider/me`.
- Member data: `GET/POST /me/bill` (one `member_bills` row per member,
  full replace; GET backfills from `BillCheckupSubmissions` leads).
- Campaigns: `GET /campaigns`, `POST /campaigns/join|leave|notify` (member),
  `GET /provider/campaigns` (counts only). **The catalog is a code constant**
  (`CATALOG`, 6 campaigns) — promoting it to the `campaigns` table is admin
  phase ADM-3. Join rules: `JOIN_STATUS = {forming:'joined',
  waitlist:'waitlist', planned:'waitlist'}`; `auction` not joinable.

Two facts that shape admin design:

1. **`grep -i admin` finds no admin routes anywhere.** The only "admin" in
   the codebase is `provider_users.role ∈ {admin,bidder,viewer}` — an
   org-level role granting nothing on the platform. Everything in the portal
   plan is greenfield on top of existing libs.
2. **Approval is not yet enforced server-side.** `provider.js` documents the
   invariant (*no code path can set `approved`* — true, verified) and
   `orgs.contextFor()` computes `approved` in exactly one place, but
   `/provider/me` and `/provider/campaigns` gate only on
   `user_type === 'provider'`. Fine while responses are counts-only; the
   moment a real-data route exists (bids), it must check approval — and
   admin *suspend* only has teeth once that check exists.

## 3. Tables (Data Store)

**Auth schema** — 12 tables declared in `src/lib/schema.js`, hand-created per
`scripts/create-tables.md` (Catalyst has **no DDL API**; a missing column is
a runtime 500, hence `schema.verify()` + `/health/diagnostics`):

`users` (user_id, email_normalized unique, user_type member|provider, status,
profile fields — **no `role` column yet**; ADM-0 adds it),
`auth_identities`, `credentials` (scrypt, lockout), `sessions` (members roll
past 50% TTL, partners don't; member TTL 30d, partner 12h),
`auth_challenges` (OTP, 10-min TTL, 5 attempts), `oauth_state`, `consents`
(append-only), `provider_orgs` (**org_id, legal_name, email_domain — not
unique, race → operator merge; approval_status pending|approved|rejected,
approved_by, approved_at — no `rejection_reason` yet**), `provider_users`
(user_id deliberately non-unique, org_id, role), `member_bills` (one row per
member, string-typed money/speeds, `source`), `campaign_members`
(membership_key = `campaign_id:user_id` unique, status joined|waitlist|alert,
fsa snapshot — **table itself still owed in the console**), and
`auth_events` — **the audit log** (event_type, user_id, email, ip_hash,
outcome, scrubbed JSON `detail` ≤10k). ~23 event types are already written
via `audit.recordAsync`; admin actions extend this list, no schema change.

**Lead/marketing tables** (formSubmit-owned): `WaitlistSignups`,
`WaitlistDetails`, `BillCheckupSubmissions`, `DeepReadRequests` (file ids in
File Store folder `1258000000015979`), `PartnerApplications` (the review
material for provider approval: provinces, access tech, business number,
LOA…), `CalculatorEstimates`, `CrmSyncQueue` (Status
PENDING|SYNCED|FAILED, Attempts, LastError). The admin "Leads" tab reads
these read-only; the whitelist for `:table` comes from this list.

**New in the portal plan:** `site_config`, `campaigns`, plus `users.role`
and `provider_orgs.rejection_reason` columns (console session, ADM-0).

## 4. The lib stack the admin router reuses

All in `functions/auth/src/lib/`: `sessions` (create/load/revoke/
revokeAllForUser), `cookies`, `csrf` (Origin allowlist; add nothing),
`ratelimit` (Cache fixed-window, **fails open**), `audit`
(recordAsync → `auth_events`, secret-scrubbing), `errors`
(`AppError` + `{error:{code,message}}` wire shape), `mailer` (zeptomail →
smtp → log precedence; approval/rejection notices become two new templates),
`datastore` (`lit()` whitelist-validated literals, `queryAll` ROWID-cursor
pagination), `schema`, `crypto` (peppered hashes), `users`, `credentials`,
`challenges`, `consents`, `orgs` (findOrCreateForDomain, contextFor,
membersOf — org merge repairs the documented duplicate-domain race),
`oidc`, `request` (clientIp precedence). `requireAdmin` + a step-up helper
are the only new middleware.

## 5. Platform constraints that must shape admin code

These are all documented in code comments and verified against the live env:

- **ZCQL LIMIT > 300 is a hard 400**, and an unlimited query silently stops
  at 300. Every admin list route paginates (`limit ≤ 100` + ROWID cursor);
  counts use `SELECT COUNT`, never `rows.length` of a capped read.
- **No parameter binding in ZCQL.** `lit()` whitelists
  (`^[A-Za-z0-9@._:+/=-]{1,320}$`) and throws — free-form admin input
  (config values, rejection reasons) must go through the object API
  (`insertRow`/`updateRow`), never string queries; table names resolve
  through a hardcoded map.
- **Dates**: Catalyst wants `YYYY-MM-DD HH:MM:SS` UTC (rejects ISO-8601);
  use `datastore.toDb/nowDb/fromDb` only. `expires_at`-style comparisons
  happen in code, never in WHERE.
- **Unique constraints are single-column only** → flattened keys
  (`membership_key`, `provider_key`); `site_config.config_key` follows suit.
- **Encrypted columns can't be WHERE'd or read back usefully** — the admin
  console must never select them (plan §3.4 already forbids it).
- **Over-length values truncate silently** on insert — validate lengths in
  code (config `value_type` validation covers this).
- **Graceful degradation is the house pattern**: `campaign_members`
  unreadable → `live:false` + seed counts; bill-lead adoption failure →
  "no earlier checkup", never 500. `site_config` and the `campaigns` table
  must degrade the same way (frozen `DEFAULT_CONFIG`, code-catalog
  fallback) — plan §2 rule 3.
- **Fail-open vs fail-closed is deliberate**: rate limits and audit writes
  fail open (availability), status flips and challenge consumption fail the
  request (integrity). Admin mutations are integrity-class: the
  `approval_status` write and its audit row should be awaited; the
  notification email can be best-effort.

## 6. Environment

Auth BOOT vars (missing any → degraded app): `NODE_ENV` (**still
`development` — flip owed before admin goes live**, it's what turns off
dev routes/diagnostics), `APP_BASE_URL`, `API_BASE_URL`, `COOKIE_DOMAIN`,
`ALLOWED_ORIGINS`, `CODE_PEPPER`, `IP_PEPPER`, `MAIL_REPLY_TO`, session
TTLs. Feature groups (all-or-nothing): `smtp`, `mail` (ZeptoMail),
`consents`, `google`, `crm` (declared,
unused — live CRM path is crmSync's own `ZOHO_*`/`CRM_*` vars).
**`ADMIN_EMAILS` joins BOOT-style validation in `config.js`** (space/comma
separated, same parsing convention as `ALLOWED_ORIGINS`).

crmSync: `CRM_CRON_SECRET`-gated `/process`; `CRM_SYNC_ENABLED` must be the
literal string `'true'`; **the cron job itself still doesn't exist** (ADM-0
prerequisite A4).

## 7. Ready-made seams for each admin capability

| Admin capability (user's asks) | The seam that already exists |
|---|---|
| 1. Change provider account status | `provider_orgs.approval_status` + `approved_by/at` columns; `orgs.contextFor()` as the single `approved` computation; `orgs.membersOf()` for the review screen; `PartnerApplications` joined by email domain; mailer for notices. Missing: the route, `rejection_reason` column, and server-side enforcement on future real-data routes |
| 2. Change cohort information | Today a code constant in `routes/campaigns.js` — ADM-3 promotes `CATALOG` to a `campaigns` table with code fallback; member/provider routes keep their response shapes so both dashboards update with zero front-end changes |
| 3. Control running cohort programmes | Lifecycle `kind` transitions + `bidding_open` per campaign + global `site_config.bidding_enabled`, all enforced in the campaign routes (`JOIN_STATUS` already keys joinability off `kind`) |
| 4. Discretionary extras | Overview counts (`SELECT COUNT` per lead table + queue depth), site_config editor, leads read views, deep-read queue w/ audited file proxy, audit browser over `auth_events`, org-merge tool — all specced in plan §5 |
