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

Because the browser and the function agree on `https://www.whollar.ca` as the
public origin, `APP_BASE_URL` and `API_BASE_URL` are deliberately the same value.
Anything that needs the `/api/auth` prefix (OAuth redirect URIs) spells it out in
full: see `GOOGLE_REDIRECT_URI` below.

---

## Phase 0: set these now

| Variable | Development value | Production value |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| `APP_BASE_URL` | `https://www.whollar.ca` | `https://www.whollar.ca` |
| `API_BASE_URL` | `https://www.whollar.ca` | `https://www.whollar.ca` |
| `COOKIE_DOMAIN` | `.whollar.ca` | `.whollar.ca` |
| `ALLOWED_ORIGINS` | `https://www.whollar.ca https://whollar.ca http://localhost:3000` | `https://www.whollar.ca https://whollar.ca` |
| `CODE_PEPPER` | see below | **generate a different one** |
| `IP_PEPPER` | see below | **generate a different one** |

`www` is the canonical host, the apex `whollar.ca` 308s to it, so it leads both
lists. The apex stays in `ALLOWED_ORIGINS` because a 308 preserves the method and
body of a POST, so a request can legitimately arrive having started there.

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
