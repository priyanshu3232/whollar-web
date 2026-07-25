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

## Phase 0 — set these now

| Variable | Development value | Production value |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| `APP_BASE_URL` | `https://whollar.ca` | `https://whollar.ca` |
| `API_BASE_URL` | `https://whollar-110003037934.development.catalystserverless.ca` | `https://api.whollar.ca` |
| `COOKIE_DOMAIN` | `.whollar.ca` | `.whollar.ca` |
| `ALLOWED_ORIGINS` | `https://whollar.ca,https://www.whollar.ca,http://localhost:3000` | `https://whollar.ca,https://www.whollar.ca` |
| `CODE_PEPPER` | see below | **generate a different one** |
| `IP_PEPPER` | see below | **generate a different one** |

Optional, defaulted if unset:

| Variable | Default |
|---|---|
| `SESSION_TTL_MEMBER_DAYS` | `30` |
| `SESSION_TTL_PARTNER_HOURS` | `12` |

### The two peppers

A pair has already been generated for the **development** environment. They are
in the session scratchpad, deliberately *not* committed:

```
/private/tmp/claude-501/-Users-santiago-1whollar/2a2bbf32-0563-42e3-95e2-c49f17264f0a/scratchpad/auth-peppers.txt
```

Copy each value into the console, then delete the file.

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
| `GOOGLE_REDIRECT_URI` | `https://api.whollar.ca/auth/google/callback` — must match the Google console entry byte for byte |

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

Vercel gets exactly **one** variable:

```
NEXT_PUBLIC_API_BASE_URL = https://api.whollar.ca
```

Nothing else. Anything prefixed `NEXT_PUBLIC_` ships in the browser bundle, so
no client secret, private key, or pepper may ever be given that prefix.
