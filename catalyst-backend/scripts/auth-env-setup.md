# `auth` function — environment variables

**Console path:** Catalyst → **Whollar** → Serverless → Functions → **auth** →
Configuration → Environment Variables.

The function validates all of this at cold start. Until the **Phase 0** block
below is set, `/auth/health` reports `"status": "degraded"` and every other
route returns `503`. That is deliberate: a function that boots with an
`undefined` pepper and silently hashes with it is worse than one that refuses.

After changing variables, **redeploy** (`catalyst deploy --only functions:auth`)
or restart the function — config is read once, at cold start.

---

## How the browser reaches this function

Not on the Catalyst host. The site calls **`https://www.whollar.ca/api/auth/*`**,
which `vercel.json` rewrites server-side to
`…development.catalystserverless.ca/server/auth/*`.

That indirection is what makes session cookies work at all. `catalystserverless.ca`
cannot set a cookie scoped to `whollar.ca` — a browser only accepts `Set-Cookie`
for its own domain or a parent of it — and a third-party cookie would be blocked
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
full — see `GOOGLE_REDIRECT_URI` below.

---

## Phase 0 — set these now

| Variable | Development value | Production value |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| `APP_BASE_URL` | `https://www.whollar.ca` | `https://www.whollar.ca` |
| `API_BASE_URL` | `https://www.whollar.ca` | `https://www.whollar.ca` |
| `COOKIE_DOMAIN` | `.whollar.ca` | `.whollar.ca` |
| `ALLOWED_ORIGINS` | `https://www.whollar.ca https://whollar.ca http://localhost:3000` | `https://www.whollar.ca https://whollar.ca` |
| `CODE_PEPPER` | see below | **generate a different one** |
| `IP_PEPPER` | see below | **generate a different one** |

`www` is the canonical host — the apex `whollar.ca` 308s to it — so it leads both
lists. The apex stays in `ALLOWED_ORIGINS` because a 308 preserves the method and
body of a POST, so a request can legitimately arrive having started there.

### Console quirks that will waste your afternoon

The Catalyst console validates what you type into the environment-variable
dialog, and its error message — *"environment_variables must contain only
alphanumeric and underscore and should not start with Numeric"* — is reported
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
file. Scratchpad paths are per-session and do not survive — if that file is gone,
the pair is gone with it, so mint a new one with the command below.

To mint a fresh pair (do this separately for production — the two environments
must not share a pepper):

```bash
node -e "const c=require('crypto');console.log('CODE_PEPPER='+c.randomBytes(32).toString('base64'));console.log('IP_PEPPER='+c.randomBytes(32).toString('base64'))"
```

**These are permanent.** `CODE_PEPPER` rotating invalidates every OTP in flight
(tolerable — they last 10 minutes). `IP_PEPPER` rotating makes all historical
`ip_hash` values incomparable with new ones, which breaks abuse forensics
across the rotation boundary. Store both in the password manager.

---

## Later phases — grouped, all-or-nothing

Each group below is validated as a unit. Set **none** of a group's variables and
the feature reports `enabled: false` on `/auth/health` and its routes are off.
Set **some** and the function refuses to boot, naming what is missing — a
half-configured OAuth client is the failure mode that eats a day of debugging.

### Phase 3 — `consents` and `mail`

| Variable | Notes |
|---|---|
| `TERMS_VERSION` | `YYYY-MM-DD`, e.g. `2026-07-01`. Must match the version stamp on `/terms`. |
| `PRIVACY_VERSION` | as above, for `/privacy` |
| `PARTNER_TERMS_VERSION` | as above |
| `ZEPTOMAIL_TOKEN` | secret |
| `ZEPTOMAIL_FROM` | `no-reply@whollar.ca` |

### Phase 4 — `google`

| Variable | Notes |
|---|---|
| `GOOGLE_CLIENT_ID` | |
| `GOOGLE_CLIENT_SECRET` | secret |
| `GOOGLE_REDIRECT_URI` | `https://www.whollar.ca/api/auth/google/callback` — must match the Google console entry byte for byte |

### Phase 6 — `crm`

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

### Phase 8 — `apple`

| Variable | Notes |
|---|---|
| `APPLE_TEAM_ID` | |
| `APPLE_SERVICES_ID` | a Services ID, **not** an App ID |
| `APPLE_KEY_ID` | |
| `APPLE_PRIVATE_KEY` | PEM; `\n` may be backslash-escaped, the loader unescapes |
| `APPLE_REDIRECT_URI` | |

---

## Frontend

Vercel gets **no environment variables at all**. This is a static site with no
build step — there is nothing to substitute a variable into. The two things the
browser needs are committed instead:

- the rewrite in `vercel.json`, which maps `/api/auth/*` onto the function;
- `W.AUTH_API = '/api/auth'` in `js/whollar-core.js`.

That is a feature, not a shortcut: a value that reaches the browser is public by
definition, so having no mechanism to inject one means no pepper, client secret
or private key can ever leak that way by accident.

The rewrite also carries `x-vercel-enable-rewrite-caching: 0`. Since April 2026
Vercel honours upstream cache headers on external rewrites by default, and a
cached auth response would hand one visitor another visitor's session. The
function additionally sets `Cache-Control: no-store` on every auth response —
two independent guards, because one of them silently regressing is survivable
and both is not.
