# `auth` function: environment variables

**Console path:** Catalyst → **Whollar** → Serverless → Functions → **auth** →
Configuration → Environment Variables.

The function validates all of this at cold start. Until the **Phase 0** block
below is set, `/auth/health` reports `"status": "degraded"` and every other
route returns `503`. That is deliberate: a function that boots with an
`undefined` pepper and silently hashes with it is worse than one that refuses.

After changing variables, **redeploy** (`catalyst deploy --only functions:auth`)
or restart the function: config is read once, at cold start.

---

## How the browser reaches this function

Not on the Catalyst host. The site calls **`https://www.whollar.ca/api/auth/*`**,
which `vercel.json` rewrites server-side to
`…development.catalystserverless.ca/server/auth/*`.

That indirection is what makes session cookies work at all. `catalystserverless.ca`
cannot set a cookie scoped to `whollar.ca`, a browser only accepts `Set-Cookie`
for its own domain or a parent of it, and a third-party cookie would be blocked
by Safari ITP regardless. Proxying makes the browser see a single origin, so the
cookie is ordinary first-party `SameSite=Lax`, there is no CORS, and no preflight.

The obvious alternative, mapping `api.whollar.ca` straight onto the function, is
**not currently available**: Catalyst Domain Mappings are production-environment
only, this project has just a Development environment, and the SSL certificate is
a manual `support@zohocatalyst.com` request with a 48-hour turnaround. Revisit it
when the production environment exists; the change is then one constant in
`js/whollar-core.js` plus deleting the rewrite.

Because the browser and the function agree on `https://internet.whollar.ca` as the
public origin (the product host since the September 2026 restructure; www is the
umbrella and 301s every product path here), `APP_BASE_URL` and `API_BASE_URL` are deliberately the same value.
Anything that needs the `/api/auth` prefix (OAuth redirect URIs) spells it out in
full: see `GOOGLE_REDIRECT_URI` below.

---

## Phase 0: set these now

| Variable | Development value | Production value |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| `APP_BASE_URL` | `https://internet.whollar.ca` | `https://internet.whollar.ca` |
| `API_BASE_URL` | `https://internet.whollar.ca` | `https://internet.whollar.ca` |
| `COOKIE_DOMAIN` | `.whollar.ca` | `.whollar.ca` |
| `ALLOWED_ORIGINS` | `https://internet.whollar.ca https://www.whollar.ca https://whollar.ca http://localhost:3000` | `https://internet.whollar.ca https://www.whollar.ca https://whollar.ca` |
| `CODE_PEPPER` | see below | **generate a different one** |
| `IP_PEPPER` | see below | **generate a different one** |

`internet.whollar.ca` is the product host and leads both lists. `www` and the apex
stay in `ALLOWED_ORIGINS`: the umbrella at www hosts /join, which posts to the
backend, and the apex 308s to www, which preserves the method and body of a POST,
so a request can legitimately arrive having started there.

**`ALLOWED_ORIGINS` IS THE ONE ROW THAT GROWS. Read the live value in the
console, never this table.** It is Phase 0 setup, not an inventory, and origins
have been appended to it since: `https://admin.whollar.ca` for the admin console
(ADMIN_CONSOLE_RUNBOOK) and `https://whollar-staging-1w.vercel.app` for staging,
confirmed present 2026-08-27. Anything missing from it fails only on WRITES, and
only with "That request could not be verified": GET is exempt from the origin
check, so a surface whose origin is absent reads perfectly and refuses every
button, which does not look like a configuration problem from the browser.

Per-deployment preview URLs (`https://whollar-<hash>-whollar1.vercel.app`) must
never be added: they rotate on every push, so the entry is dead by the next
commit. `whollar-staging-1w` is the stable alias and is the one to allow.

### Console quirks that will waste your afternoon

The Catalyst console validates what you type into the environment-variable
dialog, and its error message, *"environment_variables must contain only
alphanumeric and underscore and should not start with Numeric"*, is reported
for problems in either the **Key** or the **Value** field, which makes it much
less helpful than it looks.

- **Type the Key by hand; never paste it.** A pasted key that carries a trailing
  space or newline is invisible in the input and produces exactly that error.
- **`ALLOWED_ORIGINS` is separated by spaces above, not commas.** The loader
  accepts comma, whitespace or semicolon in any mix precisely so that whichever
  punctuation the console dislikes this week, the value can still be expressed.
- **The peppers are hex, not base64.** Same 256 bits, but no `+`, `/` or `=` for
  the validator to trip over.

If a value is rejected and you need to find out whether the Key or the Value is
at fault, save it once with a trivially safe value such as `x`. If that saves,
the Key was fine and the problem is punctuation in the value.

Optional, defaulted if unset:

| Variable | Default |
|---|---|
| `SESSION_TTL_MEMBER_DAYS` | `30` |
| `SESSION_TTL_PARTNER_HOURS` | `12` |

### The two peppers

A pair has been generated for the **development** environment. They live in the
session scratchpad, deliberately *not* committed:

```
/private/tmp/claude-501/-Users-santiago-1whollar/b3dc1393-7adf-4050-9dee-32f5e08a6111/scratchpad/auth-peppers-dev.txt
```

Copy each value into the console and into the password manager, then delete the
file. Scratchpad paths are per-session and do not survive: if that file is gone,
the pair is gone with it, so mint a new one with the command below.

To mint a fresh pair (do this separately for production: the two environments
must not share a pepper):

```bash
node -e "const c=require('crypto');console.log('CODE_PEPPER='+c.randomBytes(32).toString('base64'));console.log('IP_PEPPER='+c.randomBytes(32).toString('base64'))"
```

**These are permanent.** `CODE_PEPPER` rotating invalidates every OTP in flight
(tolerable: they last 10 minutes). `IP_PEPPER` rotating makes all historical
`ip_hash` values incomparable with new ones, which breaks abuse forensics
across the rotation boundary. Store both in the password manager.

---

## Later phases: grouped, all-or-nothing

Each group below is validated as a unit. Set **none** of a group's variables and
the feature reports `enabled: false` on `/auth/health` and its routes are off.
Set **some** and the function refuses to boot, naming what is missing: a
half-configured OAuth client is the failure mode that eats a day of debugging.

### Phase 3: `consents` and `mail`

| Variable | Notes |
|---|---|
| `TERMS_VERSION` | `YYYY-MM-DD`, e.g. `2026-07-01`. Must match the version stamp on `/terms`. |
| `PRIVACY_VERSION` | as above, for `/privacy` |
| `PARTNER_TERMS_VERSION` | as above |
| `ZEPTOMAIL_TOKEN` | secret |
| `ZEPTOMAIL_FROM` | `no-reply@whollar.ca` |

### Phase 4: `google`

| Variable | Notes |
|---|---|
| `GOOGLE_CLIENT_ID` | ends `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | secret; starts `GOCSPX-` |
| `GOOGLE_REDIRECT_URI` | `https://www.whollar.ca/api/auth/google/callback`: must match the Google console entry byte for byte |

#### Getting those three values

In the [Google Cloud console](https://console.cloud.google.com/), with a project
selected (create one: the name is internal and users never see it):

**1. APIs & Services → OAuth consent screen.** User type **External**. Fill in
the app name (this IS shown on the consent screen: use `Whollar`), a user
support email, and a developer contact email. Under *Authorized domains* add
`whollar.ca`.

**2. Scopes: add none.** The flow asks for `openid email profile`, which Google
classes as non-sensitive. That is the whole reason this needs no Google review:
sensitive and restricted scopes require a verification process that takes weeks,
and none of them are used here.

**3. Publish it.** While the consent screen is in *Testing*, only addresses on
the test-user list can sign in and their sessions expire after seven days.
Press **Publish app**. Because every scope is non-sensitive, this takes effect
immediately: there is no review to wait for.

**4. Credentials → Create credentials → OAuth client ID.**
Application type **Web application**.

- **Authorized redirect URIs**: add exactly one:
  `https://www.whollar.ca/api/auth/google/callback`
  Google matches this string exactly. A trailing slash, `http`, or the apex
  without `www` is a different URI and fails with `redirect_uri_mismatch`.
- **Authorized JavaScript origins**: leave empty. That field is for browser-side
  flows using Google's JS library. This is a server-side authorization-code flow;
  the browser never talks to Google's APIs directly, so it needs no origin.

The client ID and secret are shown on save. The secret is retrievable later, but
treat it as write-once and store it somewhere you trust.

Note that the redirect URI points at **`www.whollar.ca`, not at Catalyst.** Google
sends the browser back to our own domain, and the `/api/auth` rewrite in
`vercel.json` proxies it to the function, which is what lets the function set a
first-party session cookie. Pointing Google straight at
`…catalystserverless.ca` would work as an OAuth flow and then fail to log
anybody in, because the cookie it set would belong to the wrong domain.

#### Then

Set the three variables in the Catalyst console (**re-read the Console quirks
above**: type the Keys by hand) and redeploy the `auth` function. Confirm with:

```
curl -s https://www.whollar.ca/api/auth/health | python3 -m json.tool
```

`features.google` must be `true`. If it is `false`, all three variables are
unset; if the function 503s instead, one of them is set and another is missing:
a half-configured group deliberately refuses to boot, and `/health` names the
absentees.

#### Testing it

Sign-in is a full-page navigation, so it cannot be exercised with `curl`: the
flow only completes in a browser, on the live domain, because that is the only
place the registered redirect URI resolves. Open `/whollar-login-consumer` and
press **Continue with Google**. A success lands on `/dashboard` signed in; a
failure comes back to the login page as `?error=<code>` with a readable message
and the email form still available. `GET /api/auth/dev/events` shows what the
server recorded, including the reason behind a `google_failed`.

### Phase 6: `crm`

| Variable | Notes |
|---|---|
| `ZOHO_CRM_CLIENT_ID` | |
| `ZOHO_CRM_CLIENT_SECRET` | secret |
| `ZOHO_CRM_REFRESH_TOKEN` | secret |
| `ZOHO_ACCOUNTS_BASE` | defaults to `https://accounts.zohocloud.ca` (Canadian DC) |
| `ZOHO_API_BASE` | defaults to `https://www.zohoapis.ca` (Canadian DC) |

The existing `crmSync` function has its own copies of these under different
names (`ZOHO_CLIENT_ID`, `ZOHO_ACCOUNTS_URL`, …). They are separate functions
with separate environments; the `auth` names are the ones this function reads.

---

## Phase 7: the notification layer, five ungrouped variables

These are **not a group.** Every one of them is read individually, sits in the
BOOT block rather than in `GROUPS`, and has a fallback, so the function boots
with none of them set and nothing reports `degraded`. That is the opposite of
the phases above and it is worth saying out loud, because it means **the failure
mode here is silence, not a 503.** A missing pepper stops the world; a missing
postal address stops one class of email and says so only in a log line.

Set these before or with the deploy that carries `lib/notify`. Section 33 of
`create-tables.md` has the four tables they go with.

| Variable | Value | What is true if it is unset |
|---|---|---|
| `MAIL_LEGAL_NAME` | the registered entity name | the footer says `Whollar` |
| `MAIL_POSTAL_ADDRESS` | one line, street to postal code | **every commercial send is refused** |
| `MAIL_FROM_TRANSACTIONAL` | `no-reply@mail.whollar.com` | falls back to `ZEPTOMAIL_FROM` |
| `MAIL_FROM_CEM` | `news@news.whollar.com` | falls back to `ZEPTOMAIL_FROM` |
| `MAIL_WEBHOOK_SECRET` | 32+ random hex characters | **the delivery webhook answers 503 to everything** |

### `MAIL_POSTAL_ADDRESS` has no fallback on purpose

It is the one variable here with no default, and `lib/config.js` says so in a
comment because the reasoning is not obvious. CASL requires a physical mailing
address in every commercial electronic message. A plausible-looking default
address in a compliance footer is worse than a missing one, because it looks
correct in every review anybody will ever give it, including yours.

So instead: unset, transactional mail sends with sender identification and no
address, and `lib/notify/outbox.js` **refuses every commercial send** with
`last_error: no_postal_address` and an error line naming the variable. Phase A
ships no commercial template, so nothing is blocked today. The first one added
is what makes this bite, and it will bite silently: the outbox row says `failed`
and no email goes anywhere.

Format is one line, no newlines. The console dialog rejects a value it dislikes
with the same unhelpful message described under Phase 0, so if a comma or a
number sign is refused, save `x` first to prove the Key is fine.

### `MAIL_WEBHOOK_SECRET` is what makes the suppression list work

`POST /hooks/zeptomail` compares this in constant time against the
`X-Whollar-Hook` header and answers **503 to every request** when it is unset.
An unauthenticated endpoint that writes suppressions is a way for anybody to
stop anybody else's mail, so refusing is the only safe default.

The consequence of leaving it unset is the quiet kind: bounces and complaints
never reach `email_suppressions`, the list stays empty, and an empty suppression
list looks exactly like healthy delivery. `/health/mail` reports
`webhook_configured` for that reason.

Generate one the same way as the peppers:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then configure the webhook in the ZeptoMail console to POST to
`https://www.whollar.ca/hooks/zeptomail` with the header
`X-Whollar-Hook: <the value>`. The path is rewritten in `vercel.json` alongside
`/r/:token` and `/u/:token`, so it must be the `whollar.ca` URL, not the
Catalyst one.

### The two senders, and why they are separate

Reputation is per sending domain, and the two kinds of mail cannot share it. A
spam complaint about a region-opening announcement must not cost a member the
sign-in code they are waiting for. Two Mail Agents on two subdomains keeps the
blast radius on the half that earned it.

Both fall back to `ZEPTOMAIL_FROM`, so a half-configured environment behaves
exactly as it did before the split existed. That is deliberate: the split is an
improvement, not a prerequisite, and it should not be able to break mail by
being incomplete.

Neither subdomain sends anything until it is verified in the ZeptoMail console
and its DKIM record is published. `docs/MAIL_AUTH_RUNBOOK.md` is that work, and
it is the reason phase 5 of that runbook gates on evidence rather than a date.

### Confirming the endpoint while you are here

`ZEPTOMAIL_API_BASE` must be `https://api.zeptomail.ca`, the Canadian DC. The
code default is now that host, so an unset variable is no longer a residency
problem. An explicitly wrong one still is, and it would not look wrong in any
log: mail would keep arriving.

---

## Phase 8: the timer

The notification layer has a reminder lane, and a reminder is the one message
that fires because nothing happened: your decision deadline is tomorrow and you
have not decided, bidding closes in two hours and you have not bid. There is no
event and no route. Something has to look at the clock.

**Console path:** Catalyst -> Whollar -> Job Scheduling -> Cron.

| Setting | Value |
|---|---|
| Target | `POST https://www.whollar.ca/api/auth/admin/notify/tick` |
| Interval | hourly |
| Header | `X-Cron-Secret: <NOTIFY_CRON_SECRET>` |

Which means a sixth variable, alongside the five in Phase 7:

| Variable | Value | If unset |
|---|---|---|
| `NOTIFY_CRON_SECRET` | 32+ random hex characters | the tick route is admin-only and the timer cannot call it |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The header is load bearing twice over. `lib/csrf.js` exempts the tick route
from the Origin check **only when `x-cron-secret` is present**, because a timer
sends no Origin and an unconditional check refuses every run. A missing header
therefore fails with "That request could not be verified" rather than with
anything about a secret, which is a confusing error worth recognising.

Never send it as a query parameter. `crmSync` still accepts one for a job
configured before header support existed, and its own code logs a warning when
that path is used, because a secret in a URL lands in access logs and in the
scheduler's own run history. There is no legacy job here, so this route takes
the header alone.

One target, not two. It sweeps for due reminders and then drains the outbox, in
that order: sweeping first means a reminder that becomes due this minute goes
out this minute, while draining first would add a full interval of latency to
every reminder, which on a two-hour bid-close warning is a large slice of the
warning.

**Hourly, and not more often.** The sweep window is ninety minutes wide, so an
hourly timer cannot step over an offset. Every offset in the lane is measured in
hours. A one-minute timer would do no harm, because the idempotency key carries
the offset label and a second sweep inside the same window writes nothing, but
it would spend a Data Store read budget on answering "no" fifty-nine times an
hour.

**The route authenticates two ways**, because a timer has no session. An admin
session works, so an operator can force a pass by hand from a browser. The
`X-Cron-Secret` header works, which is what Job Scheduling can actually send.
With `NOTIFY_CRON_SECRET` unset the route is admin-only, which is the right
state before a timer exists, and the reminder lane then runs on the read-driven
sweep alone: it fires on every member dashboard load, and it is strictly weaker
for exactly the recipients reminders exist for, because a reminder is for
somebody who is not looking.

> **The trap this project has already fallen into once.** `crmSync` was written
> to be cron-invoked, the Job Scheduling job was never created, and the pipeline
> read as broken for weeks while the code was healthy the whole time. There is
> nothing in a deploy that tells you a timer does not exist. `GET /api/auth/health/mail`
> signed in as admin shows `outbox.counts.queued` climbing, which is what a
> missing timer looks like from the outside: rows enqueued and never drained.

---

## Frontend

Vercel gets **no environment variables at all**. This is a static site with no
build step: there is nothing to substitute a variable into. The two things the
browser needs are committed instead:

- the rewrite in `vercel.json`, which maps `/api/auth/*` onto the function;
- `W.AUTH_API = '/api/auth'` in `js/whollar-core.js`.

That is a feature, not a shortcut: a value that reaches the browser is public by
definition, so having no mechanism to inject one means no pepper, client secret
or private key can ever leak that way by accident.

The rewrite also carries `x-vercel-enable-rewrite-caching: 0`. Since April 2026
Vercel honours upstream cache headers on external rewrites by default, and a
cached auth response would hand one visitor another visitor's session. The
function additionally sets `Cache-Control: no-store` on every auth response:
two independent guards, because one of them silently regressing is survivable
and both is not.
