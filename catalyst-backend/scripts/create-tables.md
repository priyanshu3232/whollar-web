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
   bitten by exactly this before: see the schema gotchas in `README.md`.)

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
| `fsa` | Var Char | 3 | | | | first three characters: what a cohort is keyed on |
| `province_code` | Var Char | 2 | | | | `ON`, `BC`, … |
| `phone` | Var Char | 32 | | | ✅ | for the "bids landed" text |
| `referral_code` | Var Char | 64 | | | | the code they arrived with, not the one they own. Stored only in the canonical `WHL-<8 hex>` form written by `lib/referral.js`: the referrer's count is an exact match on this column, so a raw typed variant here is a referral nobody ever gets credited for |
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
| `algo` | Var Char | 64 | | | | e.g. `scrypt$16384$8$1$64`: lets us re-hash on upgrade |
| `updated_at` | DateTime | - | | | | |
| `failed_count` | Int | - | | | | default **0** |
| `locked_until` | DateTime | - | | | | null when not locked |

`algo` is not decoration: it records the parameters a hash was produced with, so
raising the scrypt cost later doesn't lock out everyone who signed up before.

## 4. `sessions`

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `session_id` | Var Char | 64 | ✅ | ✅ | | UUID v4 |
| `token_hash` | Var Char | 64 | ✅ | ✅ | | SHA-256 **hex** of the cookie token. Queried every request: see rule 3. |
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
| `user_id` | Var Char | 64 | | | | nullable: many events precede knowing who it is |
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
| `user_id` | Var Char | 64 | ✅ | ✅ | | one bill per member: the upsert key |
| `provider` | Var Char | 100 | | | | e.g. `Rogers` |
| `monthly_cost` | Var Char | 16 | | | | number as a string: bills carry cents, Int cannot |
| `download_speed` | Var Char | 16 | | | | the checkup's `<select>` value, e.g. `500` |
| `access_tech` | Var Char | 32 | | | | cable / fibre / DSL / fixed wireless |
| `promo_end_date` | Var Char | 10 | | | | `YYYY-MM-DD` or `YYYY-MM`; month-granular user input, not a DateTime |
| `promo_expired` | Int | - | | | | 0 \| 1 |
| `discount_amount` | Var Char | 16 | | | | number as a string |
| `contract_start_date` | Var Char | 10 | | | | same month-granular shape as `promo_end_date` |
| `contract_length` | Var Char | 8 | | | | the form's `<select>` value: `12` \| `24` \| `36` \| `0` \| `-1` |
| `switch_threshold` | Var Char | 64 | | | | e.g. `$25+/mo` |
| `source` | Var Char | 32 | | ✅ | | `bill-checkup` \| `bill-checkup-backfill` \| `waitlist` \| `waitlist-backfill` \| `dashboard` |
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
(member) and `GET /provider/campaigns` (partner). Only membership lives here;
the campaign catalog itself is the `campaigns` table, section 16. It used to be
a code constant in `routes/campaigns.js`, and that constant survives as the
fallback `src/lib/catalog.js` uses whenever the table is missing or empty.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `membership_key` | Var Char | 130 | ✅ | ✅ | | **derived**: `` `${campaign_id}:${user_id}` ``: the composite unique, flattened like `auth_identities.provider_key` |
| `campaign_id` | Var Char | 64 | | ✅ | | catalog slug, e.g. `london-east` |
| `user_id` | Var Char | 64 | | ✅ | | FK to `users.user_id` (logical) |
| `status` | Var Char | 16 | | ✅ | | `joined` \| `waitlist` \| `alert`: **a snapshot of the click**, see below |
| `fsa` | Var Char | 3 | | | | snapshot of `users.fsa` at join time |
| `joined_at` | DateTime | - | | ✅ | | |

`status` records what joining meant **at the moment it was clicked**:
`JOIN_STATUS` maps a `forming` cohort to `joined` and a `planned` or `waitlist`
region to `waitlist`. Nothing rewrites it afterwards. A lifecycle transition
writes the `campaigns` row alone, and a cohort driven by hand in the Data Store
never reaches a route at all, so a household that joined a `planned` region
still reads `waitlist` here long after that region formed and went to auction.

**Do not read this column as the member's standing.** `lib/catalog.js`
`standingOf(status, campaign)` derives that on every read, and `GET /campaigns`
sends the derived value as `you`: a `waitlist` row on a cohort past `planned`
and `waitlist` is a `joined` household. Derived rather than repaired by a write
for the same reason stage is, and because that is the only version of the fix
that reaches a cohort moved by hand. `alert` is never promoted: a bell was
never a join.

Until this table exists, `GET /campaigns` and `GET /provider/campaigns` answer
with `live: false` and the seed demo counts, the dashboards keep working,
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

## 14. Two columns to add to `BillCheckupSubmissions`

That table belongs to the marketing-site family under **Do not touch** below.
It is already there and already collecting; what follows is a column
*addition*, which is the one edit that family does take. Nothing here drops or
renames anything.

The checkup started asking these two questions on 2026-08-06 and has had
nowhere to put the answers since:

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `ContractStartDate` | Var Char | 10 | | | `YYYY-MM-DD` |
| `ContractLength` | Var Char | 8 | | | `12` \| `24` \| `36` \| `0` \| `-1` |

The write tolerates them being missing, the insert retries without them and
logs why, so the site keeps working before you do this; it just keeps
discarding those two answers. The matching `contract_start_date` /
`contract_length` on `member_bills` are in section 11 above.

`MonthlyCost` here, and `monthly_cost` on `member_bills`, mean the price paid
**today**, promo included. That meaning changed on 2026-08-08 and the column
did not. Anything reading either as a regular or list price is reading it wrong.

### `WaitlistDetails` is deliberately NOT being widened

Stage 2 of the join page ("Want it to count for more?") asks seven bill
questions and a services checklist, which is more than that table has columns
for. It stays as it is anyway, because by the time that form is on screen the
visitor is a signed-in member, signup and the emailed code both completed
seconds earlier, so every answer has an owner keyed on `user_id`:

| What stage 2 collects | Where it belongs | Written by |
|---|---|---|
| provider, price, speed, promo end, discount, contract start + length, switch threshold | `member_bills` | `POST /me/bill`, `source: 'waitlist'` |
| the services checklist | `user_prefs`, under the `services` key | `POST /me/prefs` |
| first name, last name, postal code, province | `users` | `POST /signup`, already |
| the attached bill file | Catalyst file store, id on the lead row | `/waitlist-details` |

What remains in `WaitlistDetails` is the CRM's lead trail and the fallback
`GET /me/bill` reads when the member write above was lost: five bill fields,
the services JSON, and the file id. Copying names and postal codes into it
would duplicate PII into a table that is not the record of them, and `crmSync`
reads the queued payload rather than these columns regardless.

## 15. `user_prefs` and `user_events`

Both are declared in `src/lib/schema.js` and verified by `/health/diagnostics`,
but were never written up here. No action if they already exist: check with
the queries below before creating anything.

`user_prefs`: one JSON blob per account, member or provider alike. A blob and
not columns because these keys change with the product and a console-only
schema cannot keep up; nothing ever filters on a preference. Current top-level
keys: `alerts`, `interests`, `notify`, `services`.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `pref_key` | Var Char | 64 | ✅ | ✅ | `users.user_id` |
| `prefs` | Text | - | | ✅ | JSON object |
| `updated_at` | DateTime | - | | ✅ | |

`user_events`: append-only feedback from the dashboards: provider ratings,
open notes from the "Share your experience" box, outage reports, "first in
line" interest, a partner's opening-day alerts. Write-only from the product;
the admin console reads it. `kind` is a closed set declared in
`src/routes/me.js`, and a kind the deployed function does not know is a 400,
so adding one is a code change and a redeploy, never a console change.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `user_id` | Var Char | 64 | | ✅ | |
| `user_type` | Var Char | 16 | | | |
| `kind` | Var Char | 32 | | ✅ | `rating` \| `feedback` \| `outage` \| `interest` \| `provider-notify` |
| `payload` | Text | - | | | JSON, never filtered on |
| `created_at` | DateTime | - | | ✅ | |

Reads degrade to empty when `user_prefs` is missing, so toggles render their
defaults; writes throw a clear "not available" rather than a generic 500.

---

## 16. `campaigns`, `site_config`, `provider_bids`, `provider_coverage`

**These four were live in code and undocumented here.** All four are declared
in `src/lib/schema.js` and reported by `/health/diagnostics`, and all four are
written by deployed routes. Rule 1 above says this file is the only record of
what a hand-created table must contain, so the omission meant that recreating
this environment from scratch, or standing Production up, would have produced
a site that looked fine and silently fell back to defaults. Section 12 of this
file still said "the campaign catalog itself is code, not a table"; it has not
been true since the admin console shipped.

Nothing here is a new instruction if the tables already exist. Check with the
Verify queries first.

### `campaigns`

The catalog, promoted from a code constant so that "open bidding on Windsor" is
an ops decision rather than a deploy. `src/lib/catalog.js` reads it with a 60
second memo and **falls back to the code catalog when the table is missing or
empty**, which is why its absence has been invisible.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `campaign_id` | Var Char | 64 | ✅ | ✅ | slug, immutable once created |
| `region` | Var Char | 100 | | ✅ | |
| `sub` | Var Char | 100 | | | e.g. `Autumn cohort` |
| `kind` | Var Char | 16 | | ✅ | `planned` \| `waitlist` \| `forming` \| `auction` \| `closed` \| `archived` |
| `target` | Int | - | | | households the cohort is aiming at |
| `seed_members` | Int | - | | | |
| `seed_households` | Int | - | | | |
| `bidding_open` | Boolean | - | | | only meaningful while `kind = auction` |
| `sort_order` | Int | - | | | |
| `updated_by` | Var Char | 64 | | | |
| `updated_at` | DateTime | - | | | |

**The auction calendar, seven columns, all optional.** A cohort with none of
them behaves exactly as it did before they existed, because `kind` and
`bidding_open` remain the authority. `src/lib/catalog.js` derives the
partner-facing stage from these on every read, for **display only**.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `announce_at` | DateTime | - | | | brief fixed, coverage-matched partners told |
| `bidding_opens_at` | DateTime | - | | | |
| `bidding_closes_at` | DateTime | - | | | **the one with teeth**, see below |
| `offers_at` | DateTime | - | | | winning offer goes to each household |
| `decision_at` | DateTime | - | | | household confirmations lock |
| `switch_window_at` | DateTime | - | | | installs and transfers run |
| `reconcile_at` | DateTime | - | | | final counts settle |

`bidding_closes_at` is the only one that changes behaviour rather than
labelling. `requireBiddingOpen()` refuses a bid once it has passed, so a cohort
cannot stay open past its own published deadline just because nobody was at a
keyboard to flip `bidding_open` at 5pm. **Dates may close a bid window and may
never open one**: bidding still opens only when an admin says so, so a mistyped
date cannot let anyone in early.

### `site_config`

One row per tunable. Read by `/public/config` (60s cacheable) and written by
the admin console. `bidding_enabled` is the global bidding kill switch.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `config_key` | Var Char | 64 | ✅ | ✅ | |
| `value` | Text | 10000 | | ✅ | JSON-encoded, typed by `value_type`, so a boolean is `true` and not `"true"` |
| `value_type` | Var Char | 16 | | ✅ | `string` \| `number` \| `boolean` \| `json` |
| `published` | Boolean | - | | | only published keys reach `/public/config` |
| `description` | Var Char | 255 | | | what the admin console shows beside the editor |
| `updated_by` | Var Char | 64 | | | |
| `updated_at` | DateTime | - | | | |

> **Corrected.** This list previously showed `value` as Var Char 255 and
> omitted `value_type`, `published` and `description`, all three of which
> `lib/siteconfig.js` requires. A table built from the old list would fail
> every read of it, and the failure is invisible: every caller falls back to
> the code DEFAULTS.

### `provider_bids`

One live sealed bid per (campaign, org). Rule 4 above: Catalyst's unique
constraint is per column, so the pair is flattened into `bid_key`.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `bid_key` | Var Char | 130 | ✅ | ✅ | `${campaign_id}:${org_id}` |
| `campaign_id` | Var Char | 64 | | ✅ | |
| `org_id` | Var Char | 64 | | ✅ | |
| `user_id` | Var Char | 64 | | ✅ | who placed it, for the org's own record |
| `price` | Var Char | 16 | | ✅ | money as a string, see rule 3. The headline: the lowest tier's effective price |
| `status` | Var Char | 16 | | ✅ | `sealed` \| `improved` |
| `updated_at` | DateTime | - | | | |

> **Corrected.** This list previously omitted `user_id`, which every insert
> writes, and carried `updated_by`, which nothing writes. It also carried
> `speed`, `term`, `includes` and `completion` from the flat experimental
> shape; the tiered bid in section 18 replaced all four, nothing reads them,
> and a table created today does not need them.

**Section 18 adds fifteen more columns to this table.** If you are creating it
for the first time, create the seven above and the fifteen there in one pass.

### `provider_coverage`

The regions an org claims, and what it can render there.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `coverage_key` | Var Char | 200 | ✅ | ✅ | `${org_id}:${region-slug}`, truncated to 200 by the write path |
| `org_id` | Var Char | 64 | | ✅ | |
| `region` | Var Char | 100 | | ✅ | as typed |
| `techs` | Var Char | 64 | | ✅ | CSV of `cable` \| `fibre` \| `fwa` \| `dsl` |
| `speed` | Var Char | 64 | | | CSV of Mbps tiers, ascending: `500,1000`. **Widen from 16 if this table predates the multi-tier picker,** see below |
| `lead` | Var Char | 32 | | | install lead time, capped at 32 |
| `status` | Var Char | 16 | | ✅ | `verifying` \| `active` \| `soon` \| `rejected` |
| `updated_at` | DateTime | - | | ✅ | |

> **Corrected against `lib/schema.js`, which is what `/health/diagnostics`
> verifies.** This list previously showed `coverage_key` as 130 (the write path
> builds a key it truncates at 200), `speed` as 32 (capped at 16 on write) and
> `lead` as 64 (capped at 32), and left `techs` and `updated_at` optional when
> both are required.

> **`speed` must be widened to 64 on any table created before the multi-tier
> picker.** It carried one label ("1 Gig") while the console asked for a top
> speed; it now carries the SET of tiers a partner can render there, as an
> ascending CSV of Mbps, exactly the way `techs` carries its list. The whole
> ladder is `50,100,200,500,1000,2500`, 24 characters, so 16 truncates a
> partner who declares more than two tiers, and it truncates silently: the row
> saves, and the desk then matches them on tiers they never picked. Widen the
> column in the Zoho console before a partner declares, and note that the
> **column length is the only thing that has to change** (existing single-label
> rows still read correctly: the client parses `"1 Gig"` back to 1000).

> **Known gap, not a schema problem.** New rows land `verifying` and **no route
> anywhere moves them on**, so `active` is currently unreachable. The admin
> **Resolved.** `POST /admin/providers/:orgId/coverage/:region/verify` and
> `.../reject` are the routes that were missing, and they are the only place
> `active` is ever written. Add the two columns below before deploying them.

**Two columns to add to `provider_coverage`.** Both optional, and the code
falls back to the original column list if they are absent, so the table keeps
working while you add them.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `rejection_reason` | Var Char | 255 | | | the sentence a refused partner is shown |
| `verified_at` | DateTime | - | | | stamped by the admin verify route |

---

## 17. The founding partner application

Five tables. The application is the partner's first screen and, until it
clears, their only one.

**Why one row per task rather than five columns on the application.** The
screen says "each piece starts its own check the moment it lands". With five
booleans that sentence is decoration: a submitted document and a cleared one
look identical, and a partner whose registration was flagged sees "under
review" forever with no idea which number did not match.

### `provider_applications`

One per org. `state` here is a **hint**, not the authority: `routes/application.js`
derives the real state from the task rows plus `submitted_at` and `decided_at`,
for the same reason the campaign stage is derived. A state written by whoever
spoke last is a state nobody can reason about.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `application_id` | Var Char | 64 | ✅ | ✅ | `app-${org_id}` |
| `org_id` | Var Char | 64 | ✅ | ✅ | one application per org |
| `state` | Var Char | 16 | | ✅ | `draft` \| `submitted` \| `under_review` \| `info_needed` \| `approved` \| `rejected` |
| `legal_name` | Var Char | 160 | | | |
| `operating_name` | Var Char | 160 | | | |
| `crtc_registration` | Var Char | 64 | | | checked against the public register by a person |
| `business_number` | Var Char | 32 | | | optional at application time |
| `submitted_at` | DateTime | - | | | **written once.** See below |
| `decision_due_at` | DateTime | - | | | `submitted_at` + 48h |
| `decided_at` | DateTime | - | | | |
| `decision_note` | Text | 10000 | | | shown verbatim on a declined application. **Text, not Var Char 500:** rule 3 caps Var Char at 255 and the console enforces it. Never filtered on, so Text is the right column |
| `review_note` | Text | 10000 | | | shown when one task is flagged. Text, for the same reason as `decision_note` |
| `reapply_after` | DateTime | - | | | |
| `source` | Var Char | 16 | | | `self_serve` \| `outreach` \| `distributor` |
| `role_route` | Var Char | 24 | | | carried from the public onboarding page |
| `updated_at` | DateTime | - | | | |

> **`submitted_at` is written only if unset, and that is load-bearing.** The
> console calls submit the moment the fifth task lands, and a re-render or a
> double click calls it again. Writing it unconditionally would move
> `decision_due_at` every time, and that deadline is the one number on the
> screen a partner is entitled to trust.

### `application_tasks`

One row per (org, task). Rule 4 applies: Catalyst's unique constraint is per
column, so the pair is flattened into `task_key_org`.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `task_key_org` | Var Char | 200 | ✅ | ✅ | `${org_id}:${task_key}` |
| `org_id` | Var Char | 64 | | ✅ | |
| `task_key` | Var Char | 16 | | ✅ | `coverage` \| `registration` \| `documents` \| `agreement` \| `reference` |
| `state` | Var Char | 16 | | ✅ | `empty` \| `submitted` \| `verifying` \| `cleared` \| `flagged` |
| `completed_at` | DateTime | - | | | when the partner finished their half |
| `checked_at` | DateTime | - | | | when a reviewer finished theirs |
| `note` | Text | 10000 | | | reviewer's note, or the consent hash for `agreement`. Text, for the same reason as `provider_applications.decision_note` |
| `updated_at` | DateTime | - | | | |

> A partner's own write can reach `submitted`, never `cleared`. Only
> `registration` cleared by a reviewer means the CRTC number matched. A partner
> able to clear their own check would make the vetting story decorative.
> `agreement` is the exception: signing it IS the whole of that task.

### `provider_documents`

**PII.** Only the file store reference is stored here; the file itself lives in
a **private** Catalyst File Store folder. Never a public folder, never a
guessable name (the stored name is `${org_id}-${kind}-${uuid}.${ext}`, never
the partner's own filename), and `retention_delete_after` is what makes the
deletion promise on the application screen real.

> **This section said "through a presigned URL" and that was wrong.**
> `zcatalyst-sdk-node` 2.5 exposes `createFolder` / `uploadFile` /
> `downloadFile` and nothing that mints a signed URL, so there is nothing to
> presign and endpoint 8 cannot exist as written. The bytes therefore do reach
> the auth function, through an `express.raw` parser **scoped to that one
> route**; the app-level `express.json({ limit: '64kb' })` that every other
> call runs under is untouched. Nothing about the file is logged: `app.js`
> logs method, path and status, and the filename rides in the query string,
> which is not part of `req.path`. If Catalyst Stratus is adopted later,
> endpoint 8 becomes real and this note is what to delete.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `document_key` | Var Char | 200 | ✅ | ✅ | **new.** `${org_id}:${kind}`. The flattened composite, same pattern as `application_tasks.task_key_org`: Catalyst's unique constraint is per column, so an (org, kind) pair has to be one column. Without it, replacing a document inserts a second row instead of updating the first |
| `document_id` | Var Char | 64 | ✅ | ✅ | `doc-${uuid}`. Opaque, and never on the wire |
| `org_id` | Var Char | 64 | | ✅ | |
| `kind` | Var Char | 32 | | ✅ | `crtc_registration` \| `business_registration` \| `insurance` \| `other` |
| `file_store_ref` | Var Char | 255 | | ✅ | the File Store file id. **Never on the wire**: it is the one field that would let a partner ask the store for an object that is not theirs |
| `filename` | Var Char | 255 | | | as uploaded, display only, path separators stripped |
| `bytes` | Int | - | | | |
| `mime` | Var Char | 64 | | | one of `application/pdf`, `image/png`, `image/jpeg`, `image/heic`, `image/heif`, `image/webp`. Read from the request's own `Content-Type`, so it is a check on what was sent, not on what a form field claimed |
| `uploaded_by` | Var Char | 64 | | | `user_id` |
| `uploaded_at` | DateTime | - | | | |
| `review_state` | Var Char | 16 | | ✅ | `pending` \| `accepted` \| `rejected`. A partner's upload is always `pending`; they can no more accept their own document than clear their own CRTC check |
| `retention_delete_after` | DateTime | - | | | stamped at upload from `DOC_RETENTION_DAYS` |
| `updated_at` | DateTime | - | | | **new** |

### `provider_references`

One contact, contacted once, told exactly why, **never added to any list**.
That last part is a promise made on the application screen, so there is no
marketing consent column here and there must not be one.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `reference_key` | Var Char | 200 | ✅ | ✅ | `${org_id}:ref` |
| `org_id` | Var Char | 64 | | ✅ | |
| `name_role` | Var Char | 160 | | ✅ | |
| `email` | Var Char | 255 | | ✅ | |
| `contacted_at` | DateTime | - | | | |
| `response_state` | Var Char | 16 | | ✅ | `pending` \| `responded` \| `no_response` |
| `updated_at` | DateTime | - | | | |

### `coverage_verifications`

Append only. Every serviceability decision, with who made it. Written **before**
the `provider_coverage` row moves: if the row update then fails the region
stays `verifying` and can be verified again, which is harmless. The reverse
order would leave a region live with no record of who made it live, on the one
decision that determines whether a partner can bid at all.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `coverage_key` | Var Char | 200 | | ✅ | matches `provider_coverage.coverage_key` |
| `org_id` | Var Char | 64 | | ✅ | |
| `region` | Var Char | 100 | | ✅ | as declared |
| `outcome` | Var Char | 16 | | ✅ | `active` \| `rejected`. **Was `result`, which ZCQL reserves:** the console refuses to create a column by that name. `outcome` is what `auth_events` already calls the same idea |
| `reason` | Var Char | 32 | | | `no_facilities` \| `outside_footprint` \| `tech_unsupported` \| `needs_evidence` |
| `checked_by` | Var Char | 64 | | ✅ | admin `user_id` |
| `checked_at` | DateTime | - | | ✅ | |

> The reason is an **enum, not prose**, because it feeds the serviceability
> accuracy figure that future auction briefs carry beside a partner's bid. Free
> text would make that number unbuildable.

---

## 18. The auction core: bid revisions, the tiered bid, the brief

The bid ticket increment. One new table, fifteen columns added to
`provider_bids`, one column added to `campaigns`, and one optional
`site_config` row. Code deploys safely before or after this section is done:
every read tries the extended column list first and falls back to the original,
so the window between deploy and console work degrades instead of erroring.
Bid WRITES, however, need all of it: placing a bid inserts into
`bid_revisions` first, so until this section is done the place route answers
"Bidding is not available right now."

> **FIRST, find out what actually exists.** Section 16's four tables were
> documented after the fact, on the assumption they had been created. Do not
> assume: sign in as an admin and call `GET /api/auth/health/diagnostics`,
> which runs `lib/schema.js verify()` and names every missing table, missing
> column, and wrong constraint in one answer. Nothing in this system tells you
> otherwise on its own, and that is deliberate: `lib/catalog.js` falls back to
> the code catalog when `campaigns` is unreadable, and every other read
> answers `live: false` and renders an empty state. A missing table looks
> exactly like a quiet week.
>
> If a table below does not exist, create it from the FULL column list in
> section 16 plus the additions here, not from the additions alone.

### Columns to add to `provider_bids`

The head row grows from the flat experimental shape to the full sealed bid.
Existing columns keep their names and meanings; `price` becomes the headline
(the lowest tier's effective price) and `status` stays the state column, with
`improved` joining `sealed` as a value.

Note that section 16's list of this table is **wrong in one way that matters**:
it omits `user_id`, which every insert writes, and lists `updated_by`, which
nothing writes. Section 16 has been corrected. It also listed `speed`, `term`,
`includes` and `completion`, which the tiered bid replaced: a bid's speeds
live in `tiers` and its term in `guarantee_months`. Nothing reads or writes
those four any more, so a table created today does not need them, and a table
that already has them is unaffected.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `tiers` | Text | 10000 | | | JSON array, one entry per tier: `{name, uploadMbps, technology, stickerPrice, effectivePrice, afterPrice}`, money as canonical strings |
| `guarantee_months` | Int | | | | 12 \| 24 \| 36 |
| `after_mode` | Var Char | 8 | | | `none` \| `new` |
| `after_line` | Var Char | 255 | | | derived display line: `$69 / 500 Mbps, ...` or `no scheduled change` |
| `equipment` | Var Char | 8 | | | `inc` \| `rent` \| `byod` |
| `rental_monthly` | Var Char | 16 | | | money string; set only when `equipment = rent` |
| `extra_pod_monthly` | Var Char | 16 | | | money string; null means included |
| `reduction_presentation` | Var Char | 16 | | | `member` \| `promo` \| `cash` \| `none` \| `custom` |
| `mechanism_label` | Var Char | 64 | | | only when `custom`; validated against pressure language server side |
| `commitment_cap` | Int | | | | households the org commits to serve |
| `revision_count` | Int | | | | convenience mirror of the revisions table, which is authoritative |
| `receipt_no` | Var Char | 32 | | | the latest sealed receipt |
| `payload_hash` | Var Char | 64 | | | sha256 of the sealed payload; the duplicate-submit detector |
| `submitted_at` | DateTime | | | | first sealing, written once |
| `last_revised_at` | DateTime | | | | |

### `bid_revisions` (new table)

**The sealed record. Append-only, permanently.** One row per sealing, written
BEFORE the head row, so a bid can never exist without its sealed record. No
route updates or deletes a row here, no admin backdoor removes one, and there
is no withdraw path anywhere in the system: the latest revision at close is
the binding one. Addresses never enter this table, so retention never redacts
it.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `revision_key` | Var Char | 200 | ✅ | ✅ | `${campaign_id}:${org_id}:${revision_no}`, the flattened composite (rule 4) and the race guard: concurrent revisions collide here and the loser gets a clean conflict |
| `bid_key` | Var Char | 130 | | ✅ | matches `provider_bids.bid_key` |
| `campaign_id` | Var Char | 64 | | ✅ | |
| `org_id` | Var Char | 64 | | ✅ | |
| `revision_no` | Int | | | ✅ | 1-based |
| `payload` | Text | 10000 | | ✅ | the full canonical bid JSON, exactly as sealed |
| `payload_hash` | Var Char | 64 | | ✅ | |
| `receipt_no` | Var Char | 32 | | ✅ | random, not sequential: a sequence would leak platform bid counts |
| `submitted_by` | Var Char | 64 | | ✅ | `user_id` |
| `server_received_at` | DateTime | | | ✅ | the server clock reading the close boundary was judged against |

### One column to add to `campaigns`

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `brief_json` | Text | 10000 | | | the brief's demand profile, ops-maintained: `{"renewalWindow": "Oct to Dec", "speedMix": [["1 Gig", 42], ["500 Mbps", 41], ["Under 500", 17]], "plantMix": [["Cable", 58], ["FTTP", 33], ["FTTN", 9]]}` |

Deliberately NOT in `catalog.js`'s column list: the catalog falls back to the
code catalog when its query throws, so naming this column there before it
exists in the console would knock the whole site back to seed data. The brief
route reads it with its own one-row query and degrades to "profile to come"
when the column or value is absent. Percentages are content, not arithmetic:
the server renders what ops recorded and invents nothing.

### One optional `site_config` row

`success_fee` (type `number`, unpublished). The code default is 95, marked in
`lib/siteconfig.js` as an unconfirmed planning number; create the row only to
override it. Unpublished means it never appears on `/public/config`: partners
see it on their own briefs.

---

## 19. The v17 checkup: columns to add to `BillCheckupSubmissions`

The bill checkup was rebuilt on 2026-08-13 (the v17 migration). The household
now states two prices, the promo window each applies to, and optionally a
month-by-month promo ladder; the engine's outputs are stored so historical
results stay reproducible. Like section 14, this is a column *addition* to a
Do-not-touch-family table, which is the one edit that family takes.

The insert tolerates every column below being missing (they are a tolerated
group, dropped together on retry), so the site keeps working before you do
this; it just keeps discarding these answers. The retry now drops groups
newest-first, so a gap here no longer costs `ContractStartDate` /
`ContractLength` the way the 2026-08-12 outage did.

| Column | Type | Notes |
|---|---|---|
| `PriceDuringPromo` | Double | field 08, the monthly price during the promo |
| `PriceAfterPromo` | Double | field 09, nullable |
| `PromoPeriods` | Text | JSON `[{"amount":50,"months":6}, …]`, nullable |
| `PromoFallbackPrice` | Double | the price for months the periods do not cover, nullable |
| `IsMultiPromo` | Boolean | the checkbox state |
| `StartDateUnknown` | Boolean | "I don't know" on field 05 |
| `PromoEndUnknown` | Boolean | "I don't know" on field 07 |
| `ComputedWindowMonths` | Int | always 12 in this release; stored so old rows stay reproducible |
| `ComputedCurrentCost` | Double | engine: cost of the next 12 months as they stand |
| `ComputedBenchmarkMonthly` | Double | engine, INTERNAL ONLY: never shown to a household |
| `ComputedSavings` | Double | engine: currentCost minus benchmark times 12 |
| `ComputedOverpaidToDate` | Double | engine, netted, nullable |
| `ComputedBasis` | Var Char (32) | `dated` \| `dated-no-sticker` \| `midpoint-estimate` \| `current-only` \| `periods` |
| `ComputedTone` | Var Char (16) | `high` \| `moderate` \| `fair` \| `no-benchmark` |

### What changed for the old columns

- **`MonthlyCost` keeps its meaning**: the price paid TODAY, promo included
  (the 2026-08-08 definition). The v17 page derives it from the promo
  structure, so it stays correct even for lapsed promos. Nothing rereads it
  differently.
- **`DiscountAmount` is retired.** The discount/waiver field was deleted from
  the form (the promo price already nets discounts out; keeping it double
  counts), so the insert no longer names the column. The 2026-08-12 note
  saying it must be re-added in the console is superseded: do not re-add it.
  Where it still exists it just holds the historical answers.
- **Backfill for pre-v17 rows** is done at read time, not by rewriting rows:
  a row with `ComputedWindowMonths` null is a pre-engine row, and its
  `MonthlyCost` stands in for `PriceDuringPromo` (`PriceAfterPromo` stays
  null). Old rows were produced by a different engine and are never
  recomputed.

The `member_bills` side needs no change: `/me/bill` keeps storing `monthly`
as the price paid today, and the page has stopped sending `discount`
(`discount_amount` remains, nullable, for historical rows).

---

## 20. The standard cohort terms: `provider_terms`

One new table and one optional `site_config` row, for the Contracts view and
the terms gate on bidding.

> **THIS ONE BLOCKS BIDDING, unlike section 18's tolerant reads.** `lib/terms.js`
> fails **closed**: if `provider_terms` cannot be read it refuses the bid rather
> than waving it through, because an unreadable table means acceptance cannot be
> proved and a bid placed without provable acceptance is the exact thing the gate
> exists to prevent. So create this table **before** deploying the code, or every
> `POST /provider/bids` answers "Bidding is not available right now." The refusal
> is logged with `provider_terms unreadable: terms gate failed closed`, which is
> the string to search for if bidding stops after a deploy.

### `provider_terms` (new table)

One row per org per version, written once and never updated. Accepting v2 must
not erase the proof that v1 was accepted when the v1 bids were placed, which is
the same append-only rule `consents` and `bid_revisions` follow.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `acceptance_key` | Var Char | 200 | ✅ | ✅ | `${org_id}:cohort_terms:${version}`. The unique constraint is what makes a double-tapped button and a network retry one acceptance |
| `org_id` | Var Char | 64 | | ✅ | |
| `doc_type` | Var Char | 32 | | ✅ | `cohort_terms` today. The partner agreement and the application agreement are different records with different lifecycles; this column is what keeps them apart if they ever land here |
| `doc_version` | Var Char | 32 | | ✅ | matches `cohort_terms_version` in `site_config` |
| `accepted_at` | DateTime | - | | ✅ | |
| `accepted_by` | Var Char | 64 | | ✅ | `user_id` of the seat that accepted. The org is bound; the person is on the record |
| `accepted_email` | Var Char | 255 | | | shown back in Contracts as who accepted |
| `consent_hash` | Var Char | 64 | | | hash of the text that was on screen, not just the version label: a label can be edited later, a hash is what makes the record provable |
| `ip_hash` | Var Char | 64 | | | same salted hash as `consents.ip_hash` |

### One optional `site_config` row

`cohort_terms_version` (type `string`, unpublished). The code default is `v1`.
Create the row only to publish a new version, and understand what that does:
**every org that has not accepted the new version is paused at its next bid
attempt**, with a refusal naming the new version and pointing at Contracts.
That is the intended behaviour, not a side effect, so change the row in the
same sitting as the new text. A value outside `[A-Za-z0-9][A-Za-z0-9._-]{0,31}`
is treated as a misconfigured row and falls back to `v1` with a warning in the
logs, rather than stopping bidding.

---

## 21. Delivery and billing: four tables

The chain a won cohort runs down, in order, and each table is the record of one
link in it:

```
award  ->  roster gate  ->  order  ->  activation  ->  statement line
```

> **These read TOLERANTLY, unlike section 20.** Every read here returns null on
> a missing table and the console renders "could not be read" or an empty board.
> Nothing bills and no address is released while they are absent, so deploying
> the code before creating them is safe: the delivery board simply says a win is
> what fills it. The one thing that does NOT degrade is the roster gate, which
> fails **closed**: an unreadable `provider_billing` counts as no method on file,
> and a household address is never released against a billing record nobody could
> confirm.

### `campaign_awards` (new table)

One row per cohort: who won it, and, on the same row, the roster gate. The gate
is one-to-one with the award (same partner, same cohort, same act), so a
separate table would be a join with nothing on the other side of it.

Sealed on the first read after a cohort closes, by whichever surface reads it
first. There is no cron in this stack, so nothing can be scheduled for the
moment of the close; the unique `award_key` is what makes two concurrent
readers produce one award.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `award_key` | Var Char | 64 | ✅ | ✅ | the `campaign_id`. A cohort is won once, and the unique constraint is what enforces that under a race |
| `campaign_id` | Var Char | 64 | | ✅ | |
| `org_id` | Var Char | 64 | | ✅ | the winning partner |
| `bid_key` | Var Char | 200 | | ✅ | the sealed bid that won, so the award points at the exact offer |
| `price` | Var Char | 16 | | | headline price at award, frozen. Money is a string everywhere: the Int column has no cents |
| `bid_count` | Int | - | | | how many sealed bids the cohort drew. The winner's own competitive context, and already public to households as `bidCount` |
| `method` | Var Char | 24 | | ✅ | `lowest_headline` \| `admin` |
| `awarded_by` | Var Char | 64 | | | `auto`, or the admin `user_id` on a corrected award |
| `awarded_at` | DateTime | - | | ✅ | |
| `gate_at` | DateTime | - | | | when the roster released. Null means gated, and the `orders` key is then absent from every roster response |
| `gate_by` | Var Char | 64 | | | the seat that released it |
| `install_capacity_weekly` | Int | - | | | installs per week the partner states for this region. Shown to households when they book |
| `consent_ack` | Var Char | 8 | | | `yes` once the confidentiality acknowledgement is recorded |
| `settled_at` | DateTime | - | | | set when the cohort's statement settles. A settled board is read-only |

### `provider_orders` (new table)

One row per household that accepted a winning offer. **This is the only table in
the system that holds a household address against a partner**, and it exists
only because that household ticked the release when it accepted.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `order_key` | Var Char | 200 | ✅ | ✅ | | `${campaign_id}:${user_id}`. Unique, so a double-tapped accept is one order and not two households |
| `order_no` | Var Char | 24 | | ✅ | | `WHL-XXXX-C`, quotable by both sides. Random, not sequential: a sequence tells every partner how many switches the platform has run |
| `campaign_id` | Var Char | 64 | | ✅ | | |
| `org_id` | Var Char | 64 | | ✅ | | the partner delivering it |
| `member_user_id` | Var Char | 64 | | ✅ | ✅ | never sent to the partner. They deliver to an address, not to a platform identifier |
| `state` | Var Char | 16 | | ✅ | | `acc` \| `bkd` \| `act` \| `rel` \| `noshow` \| `access` \| `linefail`. Mirrors `partner/core/contract.js` ORDER_STATE. **`act` is the only state that creates a billable line** |
| `fsa` | Var Char | 8 | | | | first half of the postcode |
| `address_line` | Var Char | 200 | | ✅ | ✅ | as the household typed it, for the install and nothing else |
| `slot_at` | DateTime | - | | | | the booked install |
| `note` | Var Char | 200 | | | | what the last move meant, in a sentence the partner can read |
| `release_reason` | Var Char | 32 | | | | `no_plant` \| `building_access` \| `speed_tier_unavailable` \| `household_cancelled`. An enum because it feeds the serviceability figure future briefs carry |
| `activated_at` | DateTime | - | | | | the moment a fee exists. Nothing before this bills |
| `dispute_state` | Var Char | 16 | | | | `open` \| `upheld` \| `credited`. A line is an order, so a dispute lives here rather than in a statement table |
| `dispute_note` | Var Char | 400 | | | | |
| `disputed_at` | DateTime | - | | | | |
| `created_at` | DateTime | - | | ✅ | | acceptance, which is also the consent timestamp |
| `updated_at` | DateTime | - | | ✅ | | |

### `provider_billing` (new table)

One row per org: where a statement goes, and the acceptance of net-15
settlement. **Not a card.** There is no payment service provider in this stack,
and a fake card on a real screen is worse than an honest invoicing arrangement.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `org_id` | Var Char | 64 | ✅ | ✅ | one arrangement per partner |
| `method` | Var Char | 16 | | ✅ | `invoice` today. The column exists so a PSP later extends this row rather than replacing it |
| `billing_email` | Var Char | 255 | | ✅ | where statements go. The gate reads this: no email, no method on file |
| `billing_contact` | Var Char | 120 | | | who to address it to |
| `state` | Var Char | 16 | | ✅ | `active` \| `retired`. Taking a method off file retires the row, never deletes it: it is what a released roster was gated on |
| `added_by` | Var Char | 64 | | | |
| `added_at` | DateTime | - | | ✅ | |
| `updated_at` | DateTime | - | | | |

### `provider_statements` (new table)

**Settlement only.** What is owed is arithmetic over `provider_orders`, computed
on every read, so there is nothing here to drift from the board. What an
operator issued, and when it was paid, is a record and lives here.

A cohort with no row is `accruing`. That is why the table can be empty and the
billing page still works.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `statement_key` | Var Char | 200 | ✅ | ✅ | `${campaign_id}:${org_id}` |
| `campaign_id` | Var Char | 64 | | ✅ | statements settle per cohort, never per month |
| `org_id` | Var Char | 64 | | ✅ | |
| `state` | Var Char | 16 | | ✅ | `issued` \| `paid` \| `disputed`. `accruing` is never stored: it is the absence of a row |
| `activated_count` | Int | - | | | frozen at issue |
| `fee_each` | Var Char | 16 | | | the fee in force at issue, frozen. A later config change must not restate an invoice already sent |
| `subtotal` | Var Char | 16 | | | |
| `tax` | Var Char | 16 | | | |
| `total` | Var Char | 16 | | | |
| `issued_at` | DateTime | - | | | |
| `due_at` | DateTime | - | | | net-15 from issue |
| `paid_at` | DateTime | - | | | |

### Three optional `site_config` rows

All unpublished, all with code defaults, so none has to exist for the pages to
work:

- `missed_visit_credit` (number, default `25`). Passed through to a household
  that waited in for a missed visit. It reduces the partner statement and is
  revenue to nobody.
- `tax_rate_pct` (number, default `13`). Ontario HST today. One row, so a rate
  change is a config edit rather than a deploy against invoices already issued.
- `tax_registration` (string, default empty). Printed on statements. **The line
  is omitted while this is blank**, because an invented registration number on
  an invoice is worse than no line at all.

`success_fee` (number, default `95`) already exists in section 16 and is read by
every statement. It stays an unconfirmed planning number until the agreement
terms settle, which is exactly why it is a row and never a constant in code.

---

## 22. Partner application document upload

Three things, in this order. Until all three are done the route answers **501**
and the console says so on the row rather than pretending a file landed.

### 22a. Two columns to add to `provider_documents`

If the table does not exist yet, create it from §17 above, which already has
both. If it does exist, add them:

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `document_key` | Var Char | 200 | ✅ | ✅ | `${org_id}:${kind}` |
| `updated_at` | DateTime | - | | | |

> `document_key` **must** carry the unique constraint. It is what makes a
> replacement an update instead of a second row, and with two rows for one kind
> the console shows whichever the query returns first, which is neither
> predictable nor the one just uploaded.
>
> Adding a mandatory unique column to a table that already holds rows is
> refused by the console. If `provider_documents` has rows, add
> `document_key` as **optional first**, backfill it (`${org_id}:${kind}` for
> each row), then set mandatory and unique.

### 22b. One private File Store folder

**Catalyst console → File Store → Create Folder.**

| Field | Value |
|---|---|
| Folder name | `partner-documents` |
| Public access | **off**. These are CRTC registration letters and incorporation documents |

Copy the folder **id** from the folder's detail page. It is a number.

### 22c. Two environment variables, in **both** environments

**Catalyst console → Settings → Environment Variables**, for Development and
for Production, then redeploy the `auth` function so it reads them.

| Name | Value | Notes |
|---|---|---|
| `FILESTORE_DOCS_FOLDER_ID` | the id from 22b | different id per environment; a Development upload must never land in the Production folder |
| `DOC_RETENTION_DAYS` | `400` | optional, defaults to 400 |

`FILESTORE_DOCS_FOLDER_ID` is what switches `FEATURES.docstore` on. Confirm it
after deploying:

```
curl -s https://<your-catalyst-host>/server/auth/health | python3 -m json.tool
```

`features.docstore` must read `true`. If it reads `false` the variable is unset
or empty in that environment, and uploads will keep answering 501.

### Verifying the round trip

Sign in as a partner, open the console, **Documents → Choose file**, attach a
small PDF. Then:

```sql
SELECT document_key, kind, filename, bytes, mime, review_state, uploaded_at
FROM provider_documents LIMIT 5;

-- both documents attached puts the task at 'submitted', one of two leaves it 'empty'
SELECT task_key, state, completed_at FROM application_tasks
WHERE task_key = 'documents' LIMIT 5;

SELECT event_type, outcome, CREATEDTIME FROM auth_events
WHERE event_type = 'provider.application.document.upload' LIMIT 5;
```

The file itself appears in the `partner-documents` folder under
`${org_id}-${kind}-${uuid}.${ext}`, never under the partner's own filename.

---

## 23. `product_interest`

The dashboard's "New products in progress" card: three tiles (mobile plans,
streaming, winter tires), each opening a short survey. What this table holds is
**demand**, not a cohort: which product to build first, and what the households
asking for it already pay. Nothing here creates a membership, a bid or a fee.

Written by `POST /me/product-interest` (`routes/interest.js`); nothing reads it
yet except the console. One row per (member, product), and a resubmit
**replaces** it: a member who opens winter tires twice has one opinion, not two.

`answers` holds two kinds of thing, and the difference is deliberate.

**The chip questions store values, never labels**: `{"interest":"yes",
"cars":"2"}`. The copy on those chips will be edited, and storing "Under $40"
would open a second bucket the day that becomes "Under $45".

**The detail tables store catalog names as themselves**, because for these the
label *is* the value:

```json
{"interest":"yes","lines":"2",
 "line_rows":[{"carrier":"Rogers","financed":"Yes, financed",
               "device":"iPhone 17 Pro","pay":72}]}
```

Nobody renames a car make the way a price band gets renamed, so no second
bucket is waiting to happen, and minting a parallel code for every phone and
trim level would be a catalog to keep in step with the client's. `make`,
`model` and `device` are therefore validated by **shape** (40 characters off a
closed charset) rather than by membership, so a handset released after the last
deploy is recorded rather than silently dropped. `carrier`, `financed`,
`service`, `via`, `provider` and `needs` stay allowlisted, and `size` must
match `235/55R20` exactly. Row arrays are capped: 5 mobile lines, 6 streaming
services, 4 cars.

The server drops any question, value or shape not named in `PRODUCTS` in
`routes/interest.js`, so a stale tab contributes the answers that still exist
rather than having the whole submission refused. It also drops the row arrays,
largest first, if the encoded JSON would exceed 3,600 characters, so a
submission can never be truncated into invalid JSON in the column. Worst case
today is about 850 characters, so that guard is a backstop and not a limit
anyone meets.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `interest_key` | Var Char | 130 | ✅ | ✅ | | **derived**: `` `${user_id}:${product}` ``: the composite unique, flattened like `campaign_members.membership_key` |
| `user_id` | Var Char | 64 | | ✅ | | FK to `users.user_id` (logical) |
| `product` | Var Char | 32 | | ✅ | | `mobile` \| `streaming` \| `tires` |
| `answers` | Text | 4000 | | ✅ | | JSON object, values not labels. Never filtered on |
| `keep_posted` | Var Char | 3 | | ✅ | | `yes` \| `no`: whether to tell them when it opens |
| `email` | Var Char | 190 | | | ✅ | snapshot of `users.email_normalized`, so the notify list is one query |
| `fsa` | Var Char | 3 | | | | snapshot of the member's FSA at submission, for a per-region read |
| `source_page` | Var Char | 120 | | | | the path that asked, e.g. `/dashboard` |
| `submitted_at` | DateTime | - | | ✅ | | server clock, never the client's |

`keep_posted` is a `yes`/`no` string rather than a boolean for the same reason
every other flag in this store is: the Data Store has no boolean column and a
`0`/`1` Var Char reads as a count in the console's table view.

**`keep_posted: no` does not mean discard.** The answers still count towards
which product gets built; they only keep the member off the list that gets told
when it does. Anything that later mails this table must filter on the column,
not assume the row's presence is consent.

Until this table exists, the card still works: the survey POST fails, the
dashboard retries once, logs a console warning and says nothing to the member.
That is deliberate (see `npSend` in `dashboard.html`): a demand signal is not
worth blocking a dialog on. It also means **a missing table is silent**, and
silent in both directions: the route answers, the member is thanked, and the
answer is dropped. **Confirmed missing in Development on 2026-08-19**, with
`POST /me/product-interest` deployed and answering, so every survey submitted
since then is gone. Nothing recovers them: create the table, then check the
audit trail rather than the browser.

The fastest existence check needs no console, and it is the one that found the
above. It reads rows, it creates nothing:

```
cd catalyst-backend
catalyst ds:export --table product_interest --page 1
```

`404, No such Table with the given name exists` means it has not been created.
Add `--production` for the other environment, which has its own empty store.

```sql
SELECT interest_key, product, keep_posted, submitted_at FROM product_interest LIMIT 5;

SELECT event_type, outcome, CREATEDTIME FROM auth_events
WHERE event_type = 'member.product_interest.save' LIMIT 5;
```

The counts the card exists to produce:

```sql
-- which product to build first
SELECT product, COUNT(ROWID) FROM product_interest GROUP BY product;

-- who to tell when it opens
SELECT email FROM product_interest WHERE product = 'mobile' AND keep_posted = 'yes';
```

---

## 24. Referral tokens: one table and two `users` columns

The opaque share token that replaces handing out a prefix of the member's
`user_id`. The legacy `WHL-<8 hex>` code IS the first eight characters of the
UUID, so every share link discloses a third of the account's primary
identifier; the token discloses nothing. Legacy codes keep resolving forever
(links are already in the wild), the token is simply what gets handed out once
the dashboard switches over.

One console visit covers this session and the two that follow it: the table
now, the two `users` columns so the carrier and same-region work does not wait
on console access later.

### 24a. `referral_token` (new table)

Issued at member creation and lazily by `GET /me/referral` for accounts that
predate the table. `lib/referral.js` is the only writer. Until this table
exists, nothing breaks: issuance is best-effort, every signup logs one
`referral token insert failed` line and proceeds, and the dashboard keeps
showing the legacy code.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `token` | Var Char | 16 | ✅ | ✅ | | 8 characters stored uppercase, no hyphen (`K7MQT4WB`). The hyphen in `K7MQ-T4WB` is display only. The unique constraint is the collision guard: issuance inserts blind and regenerates on failure |
| `owner_type` | Var Char | 16 | | ✅ | | `member` \| `partner` \| `staff`. Only `member` is issued or resolved today |
| `owner_id` | Var Char | 64 | | ✅ | | FK to `users.user_id` (logical) |
| `status` | Var Char | 16 | | ✅ | | `active` \| `suspended` \| `retired`. A suspended token must keep its row: it still explains the arrivals it produced |
| `clicks` | Int | - | | | | default 0. Diagnostic only, never shown to the member |
| `issued_at` | DateTime | - | | ✅ | | |

One **active** token per member is policy, not a constraint: a suspended
token's row has to survive, so `owner_id` cannot be unique.

There is deliberately **no per-token cap and no address-level check**. One
token can be used by any number of people; four roommates who each create an
account are four counted arrivals. What prevents double-counting is on the
other side entirely: the joining member's `users.referral_code` is one column
holding one string, so one joining member can only ever credit one referrer.

### 24b. Two columns to add to `users`

Written by the sessions after this one; nullable so their absence changes
nothing. Same drill as section 14: **Edit Table** on `users`, add both.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `referral_carrier` | Var Char | 24 | | | | how the code arrived: `typed_code` \| `typed_email` \| `link_cookie` \| `resume_email`. Written at signup alongside `referral_code` |
| `referral_same_region` | Var Char | 8 | | | | `yes` \| `no`, computed ONCE when this member verifies, comparing FSAs. Never recomputed: a number that changes when someone moves house is a support conversation with no good ending |

### 24c. Gate checks, in the ZCQL tab

**The unique constraint is enforced.** Insert two rows with the same token;
the second must fail. If it does not, stop: issuance is not collision-safe and
nothing downstream is.

```sql
INSERT INTO referral_token (token, owner_type, owner_id, status, clicks, issued_at)
VALUES ('TESTTKN0', 'member', 'gate-check', 'active', 0, '2026-08-21 00:00:00');

-- run it a second time: this one MUST error on the unique constraint
INSERT INTO referral_token (token, owner_type, owner_id, status, clicks, issued_at)
VALUES ('TESTTKN0', 'member', 'gate-check-2', 'active', 0, '2026-08-21 00:00:00');

-- then remove the fixture (SELECT its ROWID first)
SELECT ROWID FROM referral_token WHERE token = 'TESTTKN0';
DELETE FROM referral_token WHERE ROWID = <that rowid>;
```

**Confirmed in Development on 2026-08-21.** The second insert errors with
exactly: `Duplicate value for token. Please give a different value`, which the
wording match in `lib/referral.js` (`duplicate` / `unique` / `already exists`)
catches, and `scripts/test-referral-token.mjs` now pins that exact text. If
Catalyst ever rewords it, the same shape appears in Application Logs as
`referral token insert failed` the first time a live signup collides.

### 24d. Two informational probes (record the answers, nothing waits on them)

These no longer gate this build: counting stays in code over paginated reads,
the pattern every other count here uses, and the one state transition involved
(`users.status` pending → active) already exists and is already idempotent.
They decide which primitive is available on the day rewards attach and a
balance needs guarding under concurrency.

**A third probe earned its place here the same day it was written.** ZCQL's
LIKE wildcard is `*`, not SQL's `%`: `LIKE 'bf93ebdc%'` returned nothing for a
row an exact match found, `LIKE '*bf93ebdc*'` returned it (verified in the
live console, 2026-08-21). The `%` spelling had shipped in the legacy referral
resolver on 2026-08-14 and silently resolved nobody for a week. Any future
prefix or contains query must use `*`, and the cheap way to prove a new one
works is this pair against any known row:

```sql
SELECT user_id FROM users WHERE user_id = '<a real id>';
SELECT user_id FROM users WHERE user_id LIKE '<its first 8 chars>*';
```

Both must return the row, or the wildcard query is decoration.

**Both original probes ran in Development on 2026-08-21.** (a) executed and applied: the
guarded predicate held and `clicks` moved to 1 on the fixture row. What the
response reports (rows affected or not) went unrecorded, so re-run it the day
that number matters. (b) executed cleanly and returned `3, active` with three
tokens in the table: COUNT with GROUP BY works, as section 23's sample
queries assumed.

```sql
-- (a) Does ZCQL UPDATE support a guarding predicate, and what does it return?
--     Wanted: whether the response says how many rows were affected.
UPDATE referral_token SET clicks = 1
WHERE token = 'TESTTKN0' AND status = 'active';

-- (b) Does COUNT with GROUP BY execute? (Section 23's sample queries assume
--     it does; this is the confirmation.)
SELECT status, COUNT(ROWID) FROM referral_token GROUP BY status;
```

Run (a) between the two 24c inserts, while the fixture row still exists.

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
SELECT ROWID FROM provider_applications LIMIT 1;
SELECT ROWID FROM application_tasks LIMIT 1;
SELECT document_key, updated_at FROM provider_documents LIMIT 1;
SELECT ROWID FROM provider_references LIMIT 1;
SELECT ROWID FROM coverage_verifications LIMIT 1;
SELECT rejection_reason, verified_at FROM provider_coverage LIMIT 1;
SELECT ROWID FROM consents LIMIT 1;
SELECT ROWID FROM provider_orgs LIMIT 1;
SELECT ROWID FROM provider_users LIMIT 1;
SELECT ROWID FROM auth_events LIMIT 1;
SELECT ROWID FROM member_bills LIMIT 1;
SELECT ROWID FROM campaign_members LIMIT 1;
SELECT ROWID FROM provider_ratings LIMIT 1;
SELECT ROWID FROM campaigns LIMIT 1;
SELECT ROWID FROM site_config LIMIT 1;
SELECT ROWID FROM provider_bids LIMIT 1;
SELECT ROWID FROM provider_coverage LIMIT 1;
SELECT ROWID FROM provider_terms LIMIT 1;
SELECT ROWID FROM campaign_awards LIMIT 1;
SELECT ROWID FROM provider_orders LIMIT 1;
SELECT ROWID FROM provider_billing LIMIT 1;
SELECT ROWID FROM provider_statements LIMIT 1;
SELECT ROWID FROM product_interest LIMIT 1;
SELECT token, owner_type, owner_id, status FROM referral_token LIMIT 1;
```

Then one that exercises the column names the hot path depends on:

```sql
SELECT user_id, email_normalized, user_type, status FROM users LIMIT 1;
SELECT session_id, token_hash, expires_at, revoked_at FROM sessions LIMIT 1;
```

And sections 14 and 15, which fail loudly until the columns and tables exist:

```sql
SELECT ContractStartDate, ContractLength FROM BillCheckupSubmissions LIMIT 1;
SELECT contract_start_date, contract_length FROM member_bills LIMIT 1;
SELECT pref_key, prefs FROM user_prefs LIMIT 1;
SELECT user_id, kind, payload FROM user_events LIMIT 1;
SELECT bid_key, campaign_id, org_id, status FROM provider_bids LIMIT 1;
SELECT coverage_key, org_id, region, status FROM provider_coverage LIMIT 1;
-- The auction calendar. Errors here mean section 16's seven columns are
-- missing, which is silent: stage falls back to kind + bidding_open, and
-- bidding never auto-closes at its published deadline.
SELECT announce_at, bidding_opens_at, bidding_closes_at, offers_at,
       decision_at, switch_window_at, reconcile_at FROM campaigns LIMIT 1;
```

And section 18, the auction core. The first two fail loudly until the columns
and table exist; while they fail, reads degrade and bid writes refuse.

```sql
SELECT tiers, guarantee_months, revision_count, receipt_no, payload_hash
  FROM provider_bids LIMIT 1;
SELECT revision_key, bid_key, revision_no, payload, receipt_no,
       server_received_at FROM bid_revisions LIMIT 1;
SELECT brief_json FROM campaigns LIMIT 1;
```

And section 20, the terms gate. This one refuses bids while it errors, rather
than degrading:

```sql
SELECT acceptance_key, org_id, doc_type, doc_version, accepted_at,
       accepted_by, accepted_email, consent_hash, ip_hash
  FROM provider_terms LIMIT 1;
```

Run the discount columns too. On 2026-08-12 every `/bill-checkup-join` insert
was failing with a 500 while the same table still counted rows fine and other
tables still accepted writes: the signature of a column the insert names and
the table no longer has. `DiscountAmount` is the one whose console state
actually moved (see §14's history: dropped-then-restored across 08-06/08-07),
so start here. Whichever of these errors is the column to re-add:

```sql
SELECT DiscountAmount FROM BillCheckupSubmissions LIMIT 1;
SELECT discount_amount FROM member_bills LIMIT 1;
```

`DiscountAmount` is `Double`; `discount_amount` is `Var Char(16)`. The write now
survives either being missing, the insert retries without the tolerated columns
so the lead is still captured, but it discards that answer until the column is
back, and a lead missing the field is not the same as a lead that never arrived.

If `users` or `sessions` errors on the bare `SELECT` above, the table name may
be colliding with a ZCQL keyword. Tell me and I'll rename to `auth_users` /
`auth_sessions` across the schema and the repository in one pass, but check
before assuming; both are expected to be fine.

---

## Do not touch

This project's Data Store already holds the marketing-site tables written by
`formSubmit` (waitlist, bill checkup, deep read, partner applications) and
`CrmSyncQueue`. None of the tables above overlap with them. Leave them alone.
