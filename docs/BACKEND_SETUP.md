# Backend setup, start to finish

One ordered path from an empty Catalyst project to a backend all three hosts can
use. Written 2026-09-06, checked against the live Development environment.

The detail already exists and is not repeated here. This is the order, the
reason for the order, and the check at the end of each step. Where a step says
"see X", X has the real instructions:

| Document | What it holds |
|---|---|
| `catalyst-backend/scripts/create-tables.md` | every table, column, type, length and flag, 41 sections |
| `catalyst-backend/scripts/auth-env-setup.md` | the auth environment variables, in phases, with the console quirks |
| `catalyst-backend/README.md` | the original formSubmit and billOcr setup |
| `docs/STORE_BACKLOG_2026-09.md` | the console work Development still owes, in priority order |
| `docs/ACTION_TABLE_AUDIT.md` | which action writes which table, and whether it exists |
| `docs/MAIL_AUTH_RUNBOOK.md` | SPF, DKIM and DMARC for the sending domain |
| `catalyst-backend/CRM_SYNC_RUNBOOK.md` | the Zoho CRM side |
| `docs/ADMIN_CONSOLE_RUNBOOK.md` | going live with the admin console |

**Read step 0 before doing anything.** The single most expensive mistake
available here is assuming the Catalyst environment named "Development" is a
development environment.

---

## 0. What you are setting up, and one thing that will surprise you

Four Advanced I/O functions on one Catalyst project, sharing one Data Store:

| Function | Who calls it | Owns |
|---|---|---|
| `auth` | signed-in members, partners, staff | 49 tables, `lower_snake_case` |
| `formSubmit` | public pages, no session | 19 tables, `PascalCase` |
| `billOcr` | the checkup page's upload | no table |
| `crmSync` | a scheduler | reads `CrmSyncQueue` |

Three hosts write to all of it: `whollar.ca`, `internet.whollar.ca` and
`tires.whollar.ca`. The case difference between the two families is deliberate
and is explained in `docs/TABLE_NAMING_GUIDE.md`. The function that writes a
table decides its case, and nothing else does.

**The surprise.** The Catalyst project has exactly one environment provisioned,
called **Development**, and it is what the live site talks to. `vercel.json`
rewrites `/api/auth/*` to
`whollar-110003037934.development.catalystserverless.ca`, and the function's own
health endpoint reports `env: production` because `NODE_ENV` is set to
`production` inside it. So "Development" is the environment name, not the
environment's job. Real households have rows in it.

Two consequences, and both matter more than they look:

- **Nothing here is safe to treat as a scratch environment.** A dropped table is
  a dropped table.
- **There is no staging.** Test writes land beside real ones, which is why the
  gate checks in `create-tables.md` all use probe values you delete afterwards.

If you are standing up a genuinely separate Production environment, read step 9
first: the order is the same but three things change.

**How a browser reaches the backend.** Same origin, through Vercel, never
directly:

```
internet.whollar.ca/api/auth/*   ->  .../server/auth/*
internet.whollar.ca/r/:token     ->  .../server/auth/r/:token      (share links)
internet.whollar.ca/u/:token     ->  .../server/auth/u/:token      (unsubscribe)
internet.whollar.ca/hooks/zeptomail -> .../server/auth/hooks/zeptomail
```

`formSubmit` and `billOcr` are called at their Catalyst URLs directly, which is
why they carry their own CORS allowlist and `auth` does not need one for the
same hosts.

---

## 1. Account, CLI, and linking the project

Only needed once per machine.

```
npm install -g zcatalyst-cli
catalyst login
cd catalyst-backend
catalyst init          # link an existing project, Functions only
```

Say **Functions only**. Letting it scaffold a `client/` folder gives you a
second, empty frontend that nothing serves and that confuses every later
`catalyst deploy`.

**Check:**

```
catalyst whoami
catalyst project:list
```

The project you want must show `(active)`. Every `ds:*` command resolves the
project from `.catalystrc` in the working directory, so run them from
`catalyst-backend/` or pass `--project <name>`. From anywhere else you get a 401
that does not mention the project.

**On Development: done.** `.catalystrc` is committed and names project `Whollar`
(`1258000000014001`), environment Development, data center **CA**. The CA data
center matters: ZeptoMail and the Zoho APIs are regional, and pointing a
Canadian token at a US host fails as "Invalid API Token", which sends you hunting
for a bad token rather than a wrong hostname.

---

## 2. The Data Store

68 tables. There is no DDL API, no migration tool and no rename: every one is
created by hand in **Cloud Scale → Data Store → Create Table**.

Build them from `create-tables.md`, in section order. Read the five rules at the
top of that file first; they cover the four columns Catalyst adds by itself and
must never be created, the type ceilings, and the PII validator.

Two rules that cost real outages when broken:

- **Column names are case sensitive and must match the code exactly.** A wrong
  case fails at runtime, not at deploy, so it surfaces as a 500 on somebody's
  form rather than a failed build.
- **Only columns marked required get the Mandatory validator.** `ReferralCode`
  was once set mandatory by accident, which made every referral-free signup fail.

Sections 1 to 34 are the `auth` family, `lower_snake_case`. Sections 35 to 41 are
the `formSubmit` family, **`PascalCase`, table and column**. Rule 2 at the top of
that file still says everything is snake_case; it means the auth family, and
sections 35, 37, 38 and 39 each say so in bold.

**Check:**

```
node scripts/check-store-tables.mjs
```

It probes every registered table in both families and names the runbook section
for anything missing. It needs `catalyst login` and takes about a minute per
table, so it is a coffee-length command, not a fast one.

**On Development: 60 of 68 exist.** The eight that do not, and the columns and
flags still owed, are `docs/STORE_BACKLOG_2026-09.md` in the order worth doing
them. Start at block 1: it is the only item already corrupting data rather than
failing to record it.

---

## 3. File Store folders

Two, both **private**, under **Cloud Scale → File Store → New Folder**.

| Folder | Holds | Wired by |
|---|---|---|
| uploads | bills attached to a checkup or waitlist entry | `UPLOADS_FOLDER_ID` in `functions/formSubmit/index.js` |
| `partner_documents` | founding partner registration documents | `FILESTORE_DOCS_FOLDER_ID`, an env var on `auth` |

Copy each folder's numeric id from the console and set it in the place named
above. The uploads id lives in code and ships with a deploy; the documents id is
an environment variable, because that one is per environment.

Until the uploads id is set, forms still submit: the attachment is skipped and
the rest of the row saves. Until `FILESTORE_DOCS_FOLDER_ID` is set, the
`docstore` feature reports `false` and document upload 501s.

**Check:** `GET /api/auth/health` shows `features.docstore: true`.

**On Development: done.** `partner_documents` is `1258000000073364`, uploads is
`1258000000015979`, and health reports `docstore: true`.

---

## 4. Environment variables

**Console → your project → the function → Environment Variables.** Per function
and per environment; nothing is shared between them.

### The trap, before the list

`catalyst deploy` **silently wipes console environment variables if
`env_variables` is present in that function's `catalyst-config.json`.** The CLI
config wins. Deploying with `"env_variables": {}` deletes every variable you set
in the console, with no warning at deploy time, and the next request fails with
an authentication error that names nothing useful.

`billOcr/catalyst-config.json` therefore **omits the field entirely**. It is not
set to `{}`. Leave it omitted, in every function.

### `auth`

`lib/config.js` validates all of this at require time and throws one error
listing every problem at once, so you do not redeploy five times to find five
typos. Two tiers.

**BOOT.** Missing any of these and the function mounts a degraded app: `/health`
reports which names are missing, names only, and every other route answers 503.
Fails closed, on purpose.

| Variable | Notes |
|---|---|
| `NODE_ENV` | `development` \| `production` \| `test`, default `development` |
| `APP_BASE_URL` | where the browser is, e.g. `https://internet.whollar.ca` |
| `API_BASE_URL` | where this function is reached, the same host through the rewrite |
| `COOKIE_DOMAIN` | the session cookie's domain |
| `ALLOWED_ORIGINS` | see the note below |
| `CODE_PEPPER` | secret. See `auth-env-setup.md` on the two peppers |
| `IP_PEPPER` | secret. Different value from `CODE_PEPPER` |

**`ALLOWED_ORIGINS` is unioned with a list in code and cannot be narrowed.**
`internet.whollar.ca`, `www.whollar.ca` and `tires.whollar.ca` are hardcoded in
`config.js` as `CANONICAL_ORIGINS`, because on 2026-09-03 the domain restructure
moved the product and the console variable was not widened with it: `csrf.js`
then refused every state-changing request from the new host, so no sign-in, no
join and no bid, while reads carried on working and the site looked healthy from
outside. The variable is still read and still required; it is where a staging
alias or a local origin goes. The union only ever adds.

**Optional at boot, with defaults:** `MAIL_REPLY_TO`, `MAIL_LEGAL_NAME`,
`MAIL_POSTAL_ADDRESS`, `MAIL_FROM_TRANSACTIONAL`, `MAIL_FROM_CEM`,
`MAIL_WEBHOOK_SECRET`, `NOTIFY_CRON_SECRET`, `SESSION_TTL_MEMBER_DAYS` (30),
`SESSION_TTL_PARTNER_HOURS` (12).

`MAIL_POSTAL_ADDRESS` boots without a value and **gates commercial mail**: the
outbox writes a `cem` message as `failed` with `no_postal_address` rather than
sending one without it. Canadian anti-spam law, not a style preference.

**GROUPS.** Each is all or nothing. Set none and the feature reports
`enabled: false` and its routes 501. Set some and it is a configuration error,
because half-configured OAuth is the failure mode that eats a day.

| Group | Variables | Turns on |
|---|---|---|
| `smtp` | `SMTP_USER`\*, `SMTP_PASS`\*, `SMTP_FROM`, `SMTP_HOST` (smtp.ionos.com), `SMTP_PORT` (587) | the fallback mail relay |
| `mail` | `ZEPTOMAIL_TOKEN`\*, `ZEPTOMAIL_FROM`, `ZEPTOMAIL_API_BASE` (api.zeptomail.ca) | the transactional sender |
| `consents` | `TERMS_VERSION`, `PRIVACY_VERSION`, `PARTNER_TERMS_VERSION` | recording what was agreed to |
| `google` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`\*, `GOOGLE_REDIRECT_URI` | sign in with Google |
| `admin` | `ADMIN_EMAIL_DOMAIN`, `ADMIN_EMAILS`, `SESSION_TTL_ADMIN_HOURS` (12) | the admin console |
| `docstore` | `FILESTORE_DOCS_FOLDER_ID`, `DOC_RETENTION_DAYS` (400) | partner document upload |
| `crm` | `ZOHO_CRM_CLIENT_ID`, `ZOHO_CRM_CLIENT_SECRET`\*, `ZOHO_CRM_REFRESH_TOKEN`\*, `ZOHO_ACCOUNTS_BASE`, `ZOHO_API_BASE` | the CRM mirror from `auth` |

\* secret. Never in `catalyst-config.json`, which is committed.

### `formSubmit`

`AUTH_FUNCTION_URL`, `NOTIFY_CRON_SECRET`, `ZEPTOMAIL_TOKEN`, `ZEPTOMAIL_FROM`,
`ZEPTOMAIL_API_BASE`, `CLICK_PEPPER`.

The first two are a pair: the waitlist confirmation mail rides the notification
outbox on `auth`, so `POST /waitlist-email` asks across with one server to server
call. `NOTIFY_CRON_SECRET` must be **the same value on both functions**; it is
compared in constant time. Missing either and the mail is silently not sent, with
one log line saying so.

`CLICK_PEPPER` is optional. A missing one falls back to a build constant, which
weakens click dedupe and breaks nothing.

### `billOcr`

`ANTHROPIC_API_KEY`, starting `sk-ant-`. Claude reads the bill directly, vision
for images and native PDF, so there is no separate OCR step. Catalyst's own Zia
OCR returns `ML_ERROR` for every format on the CA data center, which is why it
was removed.

### `crmSync`

`ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`,
`ZOHO_ACCOUNTS_URL`, `ZOHO_API_DOMAIN`, `CRM_SYNC_ENABLED`, `CRM_BATCH_SIZE`,
`CRM_MAX_ATTEMPTS`, `CRM_CRON_SECRET`, `CRM_EXTERNAL_ID_FIELD`, and the
`CRM_MODULE_*` set that maps each entity to a Zoho module. See
`CRM_SYNC_RUNBOOK.md` and `CRM_MODEL.md`.

**Check:** `GET /api/auth/health` lists every feature and whether it is on.
`GET /api/auth/health/mail` adds whether the postal address, the webhook secret
and the cron secret are configured.

**On Development, as of 2026-09-06:**

```
features: smtp true, mail true, consents FALSE, google FALSE,
          admin true, docstore true, crm FALSE
```

`consents` off means consent recording is not running. `google` off is expected
and dormant. `crm` off on `auth` means the auth side of the CRM mirror is not
configured, which is separate from the `crmSync` function's own variables.

---

## 5. Deploy

```
cd catalyst-backend
for f in auth formSubmit billOcr crmSync; do (cd functions/$f && npm install); done
catalyst deploy
```

**Deploy the backend before the frontend that depends on it**, every time. This
repo has been burned by the opposite order more than once: a frontend calling a
route the deployed function does not have yet answers 400 or 404 on every
attempt, and it looks like a frontend bug.

**Deploying from a shared tree needs one look first.** Other sessions work in
this repo. `catalyst deploy` uploads the working tree, not `HEAD`, so a deploy
from a clean checkout can revert somebody's live uncommitted fix. Diff the
function against what is deployed, and check who else is working, before you
push a deploy.

**Check:** both hosts answer.

```
curl -s https://internet.whollar.ca/api/auth/health
curl -s https://<project>.development.catalystserverless.ca/server/formSubmit/pooling-count
```

---

## 6. CORS and authorized domains

Two places, and they must agree or the browser blocks the request while both
sides look correct in isolation.

1. **Cloud Scale → Authentication → Authorized Domains**: add each host and
   enable CORS.
2. **In code**: `ALLOWED_ORIGINS` on `auth` (unioned with `CANONICAL_ORIGINS`),
   and the hardcoded list at the top of `functions/formSubmit/index.js`.

The two code lists are only safe while they agree. A staging preview needs
adding in three places: the auth environment variable, `formSubmit`, and
`billOcr`.

**Check:** open the site on each host and submit one form. A CORS failure shows
in the browser console and nowhere else, which is why this gets its own step.

---

## 7. The scheduled jobs

Two things need a clock, and **neither has one today**. This is the largest gap
in the running system and it is invisible, because both endpoints work perfectly
when something happens to call them.

### The notification tick

`POST /admin/notify/tick` sweeps reminders and drains the outbox. It
authenticates with `NOTIFY_CRON_SECRET`, not an admin session, so a scheduler can
call it.

Create it under **Cloud Scale → Job Scheduling**, calling that route on a cron
with the secret. Without it, mail drains only when a request happens to trigger a
drain, which means queued mail can sit indefinitely on a quiet day.

`health/mail` reporting `cron_configured: true` means **the secret is set**, not
that a job exists. They are different facts and only the first is visible from
outside.

### The CRM drain

`crmSync` reads `CrmSyncQueue` and pushes into Zoho CRM. **No cron job exists at
all**, which was diagnosed as a config problem more than once before anyone
checked whether the job had ever been created. The pipeline itself is healthy.

Before creating it, add the six `CrmSyncQueue` columns from block 2 of
`STORE_BACKLOG_2026-09.md`. Every row written today carries no idempotency key
and cannot dedupe, so a first run of the drainer against that backlog is also a
first run without protection against writing everything twice.

**Check:** run each route by hand once with its secret and confirm rows move.

---

## 8. Verification, in the order that isolates a fault

Work down. Each step assumes the one above passed.

1. **`GET /api/auth/health`.** Is the function up, which features are on, which
   transport mail will use. A 503 here with a list of names is a missing BOOT
   variable.
2. **`GET /api/auth/health/diagnostics`**, signed in as an admin. Runs
   `schema.js verify()` across all 49 auth tables and returns every missing
   table, missing column, and wrong Unique or Mandatory flag, plus a row count
   each. **This is the single most useful request in the system** and it is the
   check the whole store audit was assembled by hand to replace.
3. **`node scripts/check-store-tables.mjs`.** The same existence question for
   both families, including the 19 `formSubmit` tables that `verify()` does not
   cover.
4. **`GET /api/auth/health/mail`.** Delivery outcomes, redacted. Watch
   `transport`: a preferred transport of `zeptomail` with deliveries going out
   over `smtp` means ZeptoMail is refusing and the fallback is carrying
   everything.
5. **One smoke action per surface**, each of which must land a row: a tire guided
   signup, a city request, a product vote, a bill checkup, a member join, a
   partner coverage declaration, a staff coverage verify. `ACTION_TABLE_AUDIT.md`
   says which table each one writes.

**When a form fails and the gates are green**, the fault is almost always the
store rather than the code, and Application Logs will name the column. Do not
patch code around a console mistake.

---

## 9. Standing up a real Production environment

The order above holds. Three things change, and one is easy to miss.

- **Everything is per environment.** A separate Data Store with none of the 68
  tables, a separate File Store with new folder ids, and a separate set of
  environment variables on all four functions. Nothing carries across.
- **The URLs change.** `.development.catalystserverless.ca` becomes the
  production domain, in `vercel.json`'s four rewrites and in `CATALYST_BASE` on
  the pages that call `formSubmit` and `billOcr` directly.
- **The peppers must be different values.** `CODE_PEPPER` and `IP_PEPPER` are
  what make a hash from one environment useless in the other. Copying them
  forward is the quiet way to make two environments one.

Then work step 2 again from `create-tables.md` in full, including section 41,
which exists because three tables were live for months with no console
instructions written down and a rebuild from that file would have produced a
store three tables short.

---

## What to do first, today

Development is built and serving. In priority order:

1. **`STORE_BACKLOG_2026-09.md` block 1.** Three Unique flags are off and one
   founding partner already has two application rows. It is the only open item
   corrupting data rather than failing to record it.
2. **Block 2**, the six `CrmSyncQueue` columns, before any CRM cron exists.
3. **The two scheduled jobs** in step 7 above.
4. **`consents`**, which is off, so nothing records what anyone agreed to.
5. **Mail authentication.** There is still no SPF for ZeptoMail, no DKIM and no
   DMARC on the sending domain, which is why ZeptoMail refuses and SMTP carries
   everything. Stepwise fix in `MAIL_AUTH_RUNBOOK.md`.
