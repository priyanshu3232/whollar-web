# Auth Data Store tables: console setup

Catalyst has no DDL API, so these tables are created by hand in the console.
This is the click-through list. Work top to bottom; it takes about 25 minutes.

**Console path:** Catalyst → project **Whollar** (`1258000000014001`) →
**Cloud Scale → Data Store → New Table**.

Do this in the **Development** environment first. Production is a separate
environment with its own empty Data Store: when you promote, you create every
table again there (or use the console's environment promotion).

---

## Before you start: five rules that apply to every table

1. **Never create `ROWID`, `CREATEDTIME`, `MODIFIEDTIME`, or `CREATORID`.**
   Catalyst adds them to every table automatically.

2. **Column names are case-sensitive and must match the code exactly.**
   Everything below is `lower_snake_case`. A `Email` where the code says
   `email_normalized` fails at runtime, not at deploy. (This project has been
   bitten by exactly this before. See the schema gotchas in `README.md`.)

3. **Type choice follows one rule:**
   | Use | When | Limit |
   |---|---|---|
   | **Var Char** | anything unique, mandatory, or used in a `WHERE` clause | 255 chars |
   | **Text** | long free-form values never filtered on | 10,000 chars |
   | **Encrypted text** | a secret that is *never* queried | 10,000 chars |
   | **Int** | counters | 10 digits |
   | **DateTime** | timestamps | `YYYY-MM-DD HH:MM:SS` |

   Encrypted columns are for values we only ever *read back and compare in
   code*. Anything that appears in a `WHERE` clause must be plain Var Char.
   That is why `sessions.token_hash` below is **Var Char, not Encrypted text**:
   it is looked up on literally every request. It is already a SHA-256 digest,
   so there is no plaintext secret at rest either way.

4. **`Default Value` is not offered on `Text` columns.** Where the table below
   says *default 0*, set it on the Int column. If the console won't accept it,
   leave it blank: the repository layer writes `0` explicitly on insert.

5. **Turn on the `PII/ePHI` validator** on every column flagged **PII** below.
   That switches on per-row activity logging in Application Logs, which is what
   we rely on for PIPEDA and Quebec Law 25 access records. It cannot be
   retro-applied to history, so set it at creation time.

**On `IsUnique`:** Catalyst's unique constraint is **per column**: there is no
composite unique index. Where the data model needs a unique *pair*, we store a
derived single column and make that unique. That is what `auth_identities.provider_key`
is for; see the note under that table.

**DateTime format:** Catalyst wants `YYYY-MM-DD HH:MM:SS` in UTC. It is **not**
ISO-8601: `new Date().toISOString()` (`2026-07-25T18:00:00.000Z`) is rejected.
`lib/datastore.js` will own a single formatter; never hand-format a date at a
call site.

---

## 1. `users`

The person. One row per human, regardless of how many ways they sign in.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `user_id` | Var Char | 64 | ✅ | ✅ | | UUID v4 we generate. Never expose `ROWID` outside the backend. |
| `email_normalized` | Var Char | 255 | ✅ | ✅ | ✅ | lowercase + trim only. Dots and `+tags` preserved. |
| `email_display` | Var Char | 255 | | ✅ | ✅ | exactly as the user typed it |
| `first_name` | Var Char | 100 | | | ✅ | collected at signup only |
| `last_name` | Var Char | 100 | | | ✅ | |
| `user_type` | Var Char | 16 | | ✅ | | `member` \| `provider` |
| `status` | Var Char | 16 | | ✅ | | `active` \| `pending` \| `disabled` |
| `postal_code` | Var Char | 10 | | | ✅ | full code, `K1A 0B1` |
| `fsa` | Var Char | 3 | | | | first three characters, what a cohort is keyed on |
| `province_code` | Var Char | 2 | | | | `ON`, `BC`, … |
| `phone` | Var Char | 32 | | | ✅ | for the "bids landed" text |
| `referral_code` | Var Char | 64 | | | | the code they arrived with, not the one they own |
| `last_login_at` | DateTime | - | | | | |
| `crm_contact_id` | Var Char | 64 | | | | written back by `crm-sync`; null until then |

The unique constraint on `email_normalized` is the one that matters: it is the
race guard for concurrent signup (§6.4 step 6). Do not skip it.

`fsa` duplicates the first three characters of `postal_code` on purpose. Cohorts
are formed by FSA, Catalyst has no computed columns, and ZCQL cannot index an
expression, so the alternative is scanning every row and slicing in code, which
runs into the 300-row query ceiling well before it runs into anything else.

## 2. `auth_identities`

One row per *way in*. This table is what makes account linking work: one human,
several credentials.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `user_id` | Var Char | 64 | | ✅ | | FK to `users.user_id` (logical, not enforced) |
| `provider` | Var Char | 16 | | ✅ | | `google` \| `password` \| `otp` |
| `provider_uid` | Var Char | 255 | | ✅ | | Google `sub`; for `otp`/`password`, the `user_id` |
| `provider_key` | Var Char | 255 | ✅ | ✅ | | **derived**: `` `${provider}:${provider_uid}` `` |
| `email_at_provider` | Var Char | 255 | | | ✅ | may drift from `users.email_normalized`; informational |
| `linked_at` | DateTime | - | | | | |

`provider_key` exists only because `IsUnique` is per-column. It is the composite
`(provider, provider_uid)` constraint, flattened. The repository writes it; no
call site ever builds it by hand.

## 3. `credentials`

Partners only. Members never have a password row.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `user_id` | Var Char | 64 | ✅ | ✅ | | one credential per user |
| `hash` | **Encrypted text** | - | | | | scrypt output, never queried |
| `algo` | Var Char | 64 | | | | e.g. `scrypt$16384$8$1$64` - lets us re-hash on upgrade |
| `updated_at` | DateTime | - | | | | |
| `failed_count` | Int | - | | | | default **0** |
| `locked_until` | DateTime | - | | | | null when not locked |

`algo` is not decoration: it records the parameters a hash was produced with, so
raising the scrypt cost later doesn't lock out everyone who signed up before.

## 4. `sessions`

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `session_id` | Var Char | 64 | ✅ | ✅ | | UUID v4 |
| `token_hash` | Var Char | 64 | ✅ | ✅ | | SHA-256 **hex** of the cookie token. Queried every request - see rule 3. |
| `user_id` | Var Char | 64 | | ✅ | | |
| `expires_at` | DateTime | - | | ✅ | | |
| `revoked_at` | DateTime | - | | | | set by logout and by password reset |
| `ip_hash` | Var Char | 64 | | | | `sha256(ip + IP_PEPPER)` hex, never a raw IP |
| `user_agent` | Var Char | 255 | | | | truncated to 255 in code |

## 5. `auth_challenges`

Email codes and password-reset tokens. **The TTL lives here, in `expires_at`,
not in Cache**: Catalyst Cache expiry is expressed in whole hours (default 48),
so a 10-minute code is not representable. Expiry is checked in code on read and
swept by `authCronCleanup`.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `challenge_id` | Var Char | 64 | ✅ | ✅ | | |
| `email_normalized` | Var Char | 255 | | ✅ | ✅ | |
| `code_hash` | **Encrypted text** | - | | | | `sha256(code + CODE_PEPPER)`; compared in code, never queried |
| `purpose` | Var Char | 32 | | ✅ | | `login` \| `signup` \| `password_reset` |
| `expires_at` | DateTime | - | | ✅ | | |
| `attempts` | Int | - | | | | default **0** |
| `consumed_at` | DateTime | - | | | | the replay defence |
| `ip_hash` | Var Char | 64 | | | | |

## 6. `oauth_state`

Single-use, short-lived. Deleted on callback: this row *is* the OAuth CSRF
defence, so "look up **and delete**" is one operation, not two.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `state` | Var Char | 255 | ✅ | ✅ | | 32 random bytes, base64url |
| `pkce_verifier` | **Encrypted text** | - | | | | never queried |
| `nonce` | Var Char | 255 | | | | echoed back in the `id_token` |
| `redirect_to` | Var Char | 255 | | | | already validated before it is written |
| `provider` | Var Char | 16 | | ✅ | | `google` |
| `expires_at` | DateTime | - | | ✅ | | 10 minutes |

## 7. `consents`

**One row per document.** Never a single boolean, never a bundled flag. CASL and
Law 25 both want provable, versioned, timestamped consent, and marketing consent
must be revocable independently of the terms.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `user_id` | Var Char | 64 | | ✅ | | |
| `doc_type` | Var Char | 32 | | ✅ | | `terms` \| `privacy` \| `partner_terms` \| `marketing` |
| `doc_version` | Var Char | 32 | | ✅ | | from `TERMS_VERSION` etc., e.g. `2026-07-01` |
| `accepted_at` | DateTime | - | | ✅ | | |
| `ip_hash` | Var Char | 64 | | | | |

Rows are append-only. A withdrawal is a new row, not an update: the history is
the evidence.

## 8. `provider_orgs`

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `org_id` | Var Char | 64 | ✅ | ✅ | | |
| `legal_name` | Var Char | 255 | | ✅ | | |
| `email_domain` | Var Char | 255 | | | | e.g. `telus.com`; checked against the signup email |
| `approval_status` | Var Char | 16 | | ✅ | | `pending` \| `approved` \| `rejected` |
| `approved_by` | Var Char | 255 | | | | internal operator identifier |
| `approved_at` | DateTime | - | | | | |

## 9. `provider_users`

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `user_id` | Var Char | 64 | | ✅ | | see note |
| `org_id` | Var Char | 64 | | ✅ | | |
| `role` | Var Char | 16 | | ✅ | | `admin` \| `bidder` \| `viewer` |

**Open question for you:** `user_id` is left *not* unique. Making it unique would
hard-code "one person belongs to exactly one provider org". That is true today,
but a reseller/distributor acting for two carriers would break it, and adding a
unique constraint later is easy while removing one is not. Say the word if you
want it unique.

## 10. `auth_events`

Append-only. **This is the only production debugging tool the auth system has**:
every route writes to it, on success and on failure.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `event_type` | Var Char | 64 | | ✅ | | e.g. `otp.start`, `session.load`, `partner.login` |
| `user_id` | Var Char | 64 | | | | nullable - many events precede knowing who it is |
| `email_normalized` | Var Char | 255 | | | ✅ | nullable |
| `ip_hash` | Var Char | 64 | | | | |
| `user_agent` | Var Char | 255 | | | | |
| `outcome` | Var Char | 16 | | ✅ | | `success` \| `failure` |
| `detail` | Text | 10000 | | | | JSON string |

Never write a raw code, token, password, or IP into `detail`. `lib/audit.js`
strips them; do not bypass it by calling `insertRow` directly.

## 11. `member_bills`

The signed-in member's switch file: what `/dashboard` renders. One row per
member; a new checkup replaces it. Written by `POST /me/bill`, read by
`GET /me/bill`, and seeded from `BillCheckupSubmissions` when a member's email
matches a public checkup: on the first read, and again on any read where that
lead is newer than the row (the adoption in `routes/member.js`, which is what
covers a checkup whose own save never arrived). A row with
`source = 'dashboard'` is never overwritten that way.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `user_id` | Var Char | 64 | ✅ | ✅ | | one bill per member, the upsert key |
| `provider` | Var Char | 100 | | | | e.g. `Rogers` |
| `monthly_cost` | Var Char | 16 | | | | number as a string - bills carry cents, Int cannot |
| `download_speed` | Var Char | 16 | | | | the checkup's `<select>` value, e.g. `500` |
| `access_tech` | Var Char | 32 | | | | cable / fibre / DSL / fixed wireless |
| `promo_end_date` | Var Char | 10 | | | | `YYYY-MM-DD` or `YYYY-MM`; month-granular user input, not a DateTime |
| `promo_expired` | Int | - | | | | 0 \| 1 |
| `discount_amount` | Var Char | 16 | | | | number as a string |
| `switch_threshold` | Var Char | 64 | | | | e.g. `$25+/mo` |
| `source` | Var Char | 32 | | ✅ | | `bill-checkup` \| `bill-checkup-backfill` \| `dashboard` |
| `updated_at` | DateTime | - | | ✅ | | |

A bill is a household's private pricing detail, so treat the whole row the way
`users.postal_code` is treated: consider the PII validator on `provider`,
`monthly_cost` and `promo_end_date` if per-row access logging is wanted here too.

## 12. `campaign_members`

The bridge between the member dashboard and the partner console. One row per
(campaign, member) relationship: joining a forming cohort, sitting on a
region's waitlist, or just asking to be told when it opens. The partner
console only ever reads **counts** from this table: no member identity
crosses to providers.

Written by `POST /campaigns/join|leave|notify`, read by `GET /campaigns`
(member) and `GET /provider/campaigns` (partner). The campaign catalog itself
is code (`routes/campaigns.js`), not a table: only membership lives here.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `membership_key` | Var Char | 130 | ✅ | ✅ | | **derived**: `` `${campaign_id}:${user_id}` ``, the composite unique, flattened like `auth_identities.provider_key` |
| `campaign_id` | Var Char | 64 | | ✅ | | catalog slug, e.g. `london-east` |
| `user_id` | Var Char | 64 | | ✅ | | FK to `users.user_id` (logical) |
| `status` | Var Char | 16 | | ✅ | | `joined` \| `waitlist` \| `alert` |
| `fsa` | Var Char | 3 | | | | snapshot of `users.fsa` at join time |
| `joined_at` | DateTime | - | | ✅ | | |

Until this table exists, `GET /campaigns` and `GET /provider/campaigns` answer
with `live: false` and the seed demo counts (the dashboards keep working)
and the join/notify POSTs return a clear "not available right now" error.
Creating the table is what switches the whole feature live; no redeploy needed.

## 13. `provider_ratings`

The dashboard's "One minute, once" card: a private rating of the member's own
provider (Price / Reliability / Support / Speed, 1-5 each). One row per
member; `user_id` unique is what makes a second `POST /me/rating` fail with a
clear "already rated" error instead of overwriting the first. Written and read
by `routes/rating.js`. Never shown to bidding providers: same access model as
`user_events`.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `user_id` | Var Char | 64 | ✅ | ✅ | | one rating per member |
| `provider` | Var Char | 100 | | ✅ | | e.g. `Rogers`, whatever the member's bill named |
| `price` | Int | - | | ✅ | | 1-5 |
| `reliability` | Int | - | | ✅ | | 1-5 |
| `support` | Int | - | | ✅ | | 1-5 |
| `speed` | Int | - | | ✅ | | 1-5 |
| `created_at` | DateTime | - | | ✅ | | |

Until this table exists, both routes fail with a server error, same as
`/me/bill` before `member_bills` was created: this table is load-bearing from
the moment the route is deployed, not an optional enhancement.

---

## Verify

In the console: **Data Store → ZCQL** (or **Explore**), and run each of these.
Each should return zero rows and **no error**: an error means a table name or
column name is wrong.

```sql
SELECT ROWID FROM users LIMIT 1;
SELECT ROWID FROM auth_identities LIMIT 1;
SELECT ROWID FROM credentials LIMIT 1;
SELECT ROWID FROM sessions LIMIT 1;
SELECT ROWID FROM auth_challenges LIMIT 1;
SELECT ROWID FROM oauth_state LIMIT 1;
SELECT ROWID FROM consents LIMIT 1;
SELECT ROWID FROM provider_orgs LIMIT 1;
SELECT ROWID FROM provider_users LIMIT 1;
SELECT ROWID FROM auth_events LIMIT 1;
SELECT ROWID FROM member_bills LIMIT 1;
SELECT ROWID FROM campaign_members LIMIT 1;
SELECT ROWID FROM provider_ratings LIMIT 1;
```

Then one that exercises the column names the hot path depends on:

```sql
SELECT user_id, email_normalized, user_type, status FROM users LIMIT 1;
SELECT session_id, token_hash, expires_at, revoked_at FROM sessions LIMIT 1;
```

If `users` or `sessions` errors on the bare `SELECT` above, the table name may
be colliding with a ZCQL keyword. Tell me and I'll rename to `auth_users` /
`auth_sessions` across the schema and the repository in one pass, but check
before assuming; both are expected to be fine.

---

## Do not touch

This project's Data Store already holds the marketing-site tables written by
`formSubmit` (waitlist, bill checkup, deep read, partner applications) and
`CrmSyncQueue`. None of the tables above overlap with them. Leave them alone.
