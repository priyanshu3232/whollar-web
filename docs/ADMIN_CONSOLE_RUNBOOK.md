# Admin console: go-live runbook

> Everything that has to happen outside the code for admin.whollar.ca to work,
> in order. The code (backend routes + `admin-console/`) is already written;
> each step below is a console/DNS/deploy action only you can do.
> Written 2026-07-30. Companion: `docs/ADMIN_PORTAL_PLAN.md`,
> `admin-console/README.md`.

## 1. Catalyst Data Store: create tables & columns

Console → Data Store. Column names are case-sensitive; the code's expectation
lives in `functions/auth/src/lib/schema.js`, and
`GET /api/auth/health/diagnostics` verifies your clicking afterwards.

### 1a. `site_config` (new table)

| Column | Type | Max | Unique | Mandatory |
|---|---|---|---|---|
| `config_key` | Var Char | 64 | ✅ | ✅ |
| `value` | Text | - | | ✅ |
| `value_type` | Var Char | 16 | | ✅ |
| `published` | Boolean | - | | |
| `description` | Var Char | 255 | | |
| `updated_by` | Var Char | 64 | | |
| `updated_at` | Date Time | - | | |

### 1b. `campaigns` (new table)

| Column | Type | Max | Unique | Mandatory |
|---|---|---|---|---|
| `campaign_id` | Var Char | 64 | ✅ | ✅ |
| `region` | Var Char | 100 | | ✅ |
| `sub` | Var Char | 100 | | |
| `kind` | Var Char | 16 | | ✅ |
| `target` | Int | - | | |
| `seed_members` | Int | - | | |
| `seed_households` | Int | - | | |
| `bidding_open` | Boolean | - | | |
| `sort_order` | Int | - | | |
| `updated_by` | Var Char | 64 | | |
| `updated_at` | Date Time | - | | |

Do **not** hand-insert rows: sign in to the console and press
**"Import the shipped catalog"** on the Campaigns tab; it seeds the six
current campaigns and is safe to run twice.

### 1c. `provider_orgs`: add one column

| Column | Type | Max | Unique | Mandatory |
|---|---|---|---|---|
| `rejection_reason` | Var Char | 255 | | |

(Reject works without it, the reason then survives only in the audit row,
but add it so the review screen can show it.)

### 1d. `campaign_members`: if still not created

Already specified in `catalyst-backend/scripts/create-tables.md`; the member
join counts stay on demo seeds until it exists.

## 2. Auth function environment variables

Console → Functions → auth → Configuration:

| Variable | Value | Why |
|---|---|---|
| `ADMIN_EMAIL_DOMAIN` | `whollar.com` | The allowlist. Every mailbox on this domain can become an admin: the domain must be one only the company controls. Setting it is what mounts `/admin/*` at all. |
| `ADMIN_EMAILS` | *(optional)* `someone@gmail.com …` | Individual off-domain admins, space/comma separated. |
| `SESSION_TTL_ADMIN_HOURS` | *(optional, default 12)* | Absolute admin session ceiling; sessions never roll. |
| `ALLOWED_ORIGINS` | **append** `https://admin.whollar.ca` | CSRF Origin allowlist: without this every admin mutation is refused with "could not be verified". |

Then **redeploy the auth function** (`catalyst deploy` from
`catalyst-backend/`).

⚠ OTP delivery: admin sign-in emails go through the same mailer as member
codes. Whichever transport is live (`GET /api/auth/health` reports it) must be
able to deliver to `@whollar.com` mailboxes, i.e. those mailboxes must
actually exist. In dev with the `log` transport the code is returned in the
response and the login form auto-fills it.

## 3. Vercel: the admin.whollar.ca project

1. New Vercel project, **Root Directory = `admin-console/`** (or run
   `vercel --prod` from that folder). It ships `index.html` + `vercel.json`
   (headers, CSP, and the `/api/auth/*` → Catalyst rewrite).
2. Project → Domains → add `admin.whollar.ca`.
3. DNS (wherever whollar.ca is hosted): `CNAME admin → cname.vercel-dns.com`.

The cookie story needs no work: the rewrite makes the API same-origin, so the
`whollar_session` cookie is set host-only on `admin.whollar.ca`, separate from
the www cookie.

## 4. First sign-in & acceptance

1. Open `https://admin.whollar.ca` → staff email → code → console loads.
   The first verify **creates** your admin account (audited `admin.login`,
   `created:true`).
2. Overview shows live counts; flip the kill switch off → within a minute
   `GET /api/auth/provider/campaigns` (as a partner) answers
   `bidding:{enabled:false}`. Flip it back.
3. Campaigns → Import the shipped catalog → move a test campaign
   `planned → waitlist` and back; check the member dashboard still renders.
4. Providers → your pending org (if any) → approve → the partner receives the
   email and their console banner disappears.
5. Audit tab shows every one of the above with before/after values.

## 5. Standing cautions

- `NODE_ENV` is still `development` on Catalyst (flip owed): dev routes
  (`/health/diagnostics`, `/dev/logout-everywhere`) and the OTP
  code-in-response behaviour (when no mail transport) exist until it flips.
  Flip it before treating the console as production.
- The CRM cron job is still not created (see `CRM_SYNC_RUNBOOK.md`); the
  Overview's "CRM pending" number will grow until it is.
- Deep-read file downloads are deliberately not in v1: the tab lists
  requests; files open from the Catalyst console until the audited proxy
  ships.
