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
| `rejection_reason` | Var Char | 255 | | | | the operator's reason on a rejected application, shown back to the partner. Added with the admin console (docs/ADMIN_CONSOLE_RUNBOOK.md section 1c); `routes/admin.js` retries the write without it when it is missing |

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
| `referral_code` | Var Char | 64 | | | | snapshot of `users.referral_code` at join time: the code this member was referred by, stamped with the campaign they actually joined. **Added 2026-08-24 for multi-campaign attribution**: until the column exists the insert falls back to the plain row and only the stamp is lost |

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
| Folder name | `partner_documents`. Underscore, not hyphen: the console allows only letters, numbers and `_` in a folder name. The code never reads the name, only the id |
| Public access | **off**. These are CRTC registration letters and incorporation documents |

Copy the folder **id** from the folder's detail page. It is a number.

### 22c. Two environment variables, in **both** environments

**Catalyst console → Whollar → Serverless → Functions → `auth` → Configuration
→ Environment Variables**, the same list the SMTP and CORS variables live in
(`scripts/auth-env-setup.md`). Variables are per function, not per project.
Set them in every environment the project has, then redeploy the `auth`
function so it reads them.

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

The file itself appears in the `partner_documents` folder under
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

## 25. Cohort share: `invite_click` and `share_event`

Two write-only logs behind the campaign card's share sheet. Both writes are
best-effort in code (routes/share.js): until these tables exist, every share
and every landing still works, and each skipped write is one
`invite click insert failed` or `share event insert failed` line in
Application Logs. Same contract as section 23.

**There is deliberately no `attribution_edge` table.** The attribution ledger
already exists as one column holding one string: the joining member's
`users.referral_code`, plus `users.referral_carrier` from section 24b
(`typed_code` | `typed_email` | `link_cookie` | `resume_email`). One row per
joining member is one referrer per joining member, the count is an exact
match on that column at read time, and it counts verified accounts only. A
parallel edge table would be a second copy of the same fact that could
disagree with the first.

### 25a. `invite_click` (new table)

One row per landing on `GET /r/:token`, written before the redirect, valid
token or not. Never mutated afterward, by anyone.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `token` | Var Char | 16 | | | | normalized, or empty when the token failed its checksum |
| `token_valid` | Var Char | 8 | | ✅ | | `yes` \| `no`. A failed checksum is a logged fact, not an error page |
| `landed_at` | DateTime | - | | ✅ | | |
| `first_touch` | Var Char | 8 | | | | `yes` \| `no`. `no` means a different sender's cookie was already present, so this click set nothing |
| `ip_hash` | Var Char | 128 | | | | peppered hash, never a raw IP |
| `ua_hash` | Var Char | 128 | | | | sha256 of the user agent |

No `cookie_id` and no `resolved_member_id`: resolution happens at
verification through `users.referral_code`, and joining a click row to a
person would make this table PII it does not need to be.

### 25b. `share_event` (new table)

Fire-and-forget telemetry from the share sheet, POST `/share/event`,
whitelisted event names only: `share_control_shown`, `share_opened`,
`share_channel_selected`, `share_copied`, `share_native_completed`,
`share_dismissed`.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `event` | Var Char | 32 | | ✅ | | from the whitelist, nothing else is written |
| `member_id` | Var Char | 64 | | | | from the session when one exists |
| `cohort_id` | Var Char | 64 | | | | |
| `stage_at_share` | Var Char | 24 | | | | |
| `channel` | Var Char | 24 | | | | `copy` \| `sms` \| `whatsapp` \| `email` \| `native` |
| `placement` | Var Char | 24 | | | | `header` \| `panel` \| `rail` |
| `tier` | Var Char | 12 | | | | `native` \| `modal` \| `manual` |
| `target` | Var Char | 12 | | | | for `share_copied`: `link` \| `code` |
| `reason` | Var Char | 24 | | | | for `share_dismissed` |
| `created_at` | DateTime | - | | ✅ | | |
| `ip_hash` | Var Char | 128 | | | | peppered hash |
| `ua_hash` | Var Char | 128 | | | | sha256 of the user agent |

### 25c. Gate checks, in the ZCQL tab

Both tables take a manual insert and read it back, which is all the code
path needs:

```sql
INSERT INTO invite_click (token, token_valid, landed_at, first_touch)
VALUES ('TESTTKN0', 'yes', '2026-08-22 00:00:00', 'yes');
SELECT ROWID, token, token_valid FROM invite_click WHERE token = 'TESTTKN0';
DELETE FROM invite_click WHERE ROWID = <that rowid>;

INSERT INTO share_event (event, stage_at_share, channel, created_at)
VALUES ('share_opened', 'forming', 'copy', '2026-08-22 00:00:00');
SELECT ROWID, event FROM share_event WHERE event = 'share_opened';
DELETE FROM share_event WHERE ROWID = <that rowid>;
```

Then one live check end to end: open
`https://www.whollar.ca/r/<any member's real token>` in a private window,
confirm the 302 lands on `/waitlist/?ref=<token>`, and SELECT the newest
`invite_click` row.

---

## 26. Cohort seats: `seat_claim`, `claim_event` and `cohort_counter`

The exit-window feature: one cohort seat per address per vertical, leave
while forming, atomic move between cohorts. Written and read by
routes/seat.js through lib/seats.js, and by nothing else.

**The first two tables fail closed.** Until `seat_claim` and `claim_event`
exist, every seat route returns a clear 500 ("Cohort seats are not available
right now"), and the dashboard keeps rendering the pre-seat join flow. This
is the terms-gate contract, not the section 23 silent-skip contract: a seat
system that silently no-ops would let one address into two cohorts.
`cohort_counter` alone is the sidecar exception: without it, counts degrade
to the campaign seed numbers, logged as `cohort_counter write skipped`.

**Why the key is the address, not the member.** A household that is
genuinely moving holds two addresses for a while, and each address is its
own seat. Nothing in the codebase has an address identity yet, so until an
address table exists the id is derived as `<user_id>/1` (one default slot
per member). When real addresses land, new slots get new ids and every row
here keys correctly with no rewrite.

### 26a. `seat_claim` (new table)

The enforcement point. Exactly one row per `(address_id, vertical)`, created
on first join and reused forever. The row either points at a cohort
(`status='active'`) or it does not. A move swaps `cohort_id` in place, so an
address is never seatless mid-flight and can never hold two seats.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `claim_key` | Var Char | 96 | ✅ | ✅ | | `<address_id>:<vertical>`, the flattened composite key |
| `address_id` | Var Char | 72 | | ✅ | | `<user_id>/1` until an address table exists |
| `vertical` | Var Char | 24 | | ✅ | | `internet` for this slice |
| `member_id` | Var Char | 64 | | ✅ | | |
| `cohort_id` | Var Char | 64 | | | | null while released |
| `status` | Var Char | 12 | | ✅ | | `active` \| `released` |
| `version` | Int | - | | ✅ | | optimistic lock, starts at 1, see 26b |
| `claimed_at` | DateTime | - | | | | |
| `released_at` | DateTime | - | | | | |

### 26b. `claim_event` (new table, append only)

One row per transition, never mutated. This table is two things at once: the
audit trail (the input to churn analysis, so `reason` is captured even when
null) and the **race guard**. Catalyst has no conditional update, so every
transition first inserts the event whose `event_key` is
`<claim_key>:<version+1>`; the unique constraint lets exactly one concurrent
writer in, and the loser re-reads and returns a 409. Two tabs leaving the
same seat produce one state change and one conflict, by construction.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `event_key` | Var Char | 120 | ✅ | ✅ | | `<claim_key>:<version>`, the serialization point |
| `claim_key` | Var Char | 96 | | ✅ | | |
| `address_id` | Var Char | 72 | | ✅ | | |
| `member_id` | Var Char | 64 | | ✅ | | |
| `from_cohort_id` | Var Char | 64 | | | | |
| `to_cohort_id` | Var Char | 64 | | | | |
| `action` | Var Char | 16 | | ✅ | | `join` \| `leave` \| `move` \| `rejoin` \| `pass` \| `cancel` \| `seal` \| `admin_move` |
| `reason` | Var Char | 24 | | | | `timing` \| `retention_offer` \| `moving` \| `other_cohort` \| `changed_mind`, else null |
| `actor` | Var Char | 16 | | | | `member` \| `system` \| `admin` |
| `request_id` | Var Char | 128 | | | | the Idempotency-Key header; a replay returns current state instead of writing twice |
| `occurred_at` | DateTime | - | | ✅ | | |

### 26c. `cohort_counter` (new table, sidecar)

Roster count and publish state per cohort. A sidecar rather than columns on
`campaigns` because lib/catalog.js selects a fixed column list and falls back
to the code catalog when the query errors: adding columns there would break
every campaign read until the console caught up. `roster_count` is recomputed
on every transition by counting active claims (a recount cannot go negative
and cannot drift) and only read, never scanned, on the read path.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `cohort_id` | Var Char | 64 | ✅ | ✅ | | |
| `roster_count` | Int | - | | ✅ | | maintained on transitions only |
| `min_threshold` | Int | - | | | | |
| `public_threshold` | Int | - | | | | un-publish floor is 10 percent below this |
| `published` | Boolean | - | | | | hysteresis: never re-cleared after `partner_announced` |
| `partner_announced` | Boolean | - | | | | once true, the cohort never un-publishes |
| `updated_at` | DateTime | - | | | | |

### 26d. Gate checks, in the ZCQL tab

```sql
INSERT INTO seat_claim (claim_key, address_id, vertical, member_id, status, version)
VALUES ('TESTADDR/1:internet', 'TESTADDR/1', 'internet', 'TESTUSER', 'released', 1);
SELECT ROWID, claim_key, status, version FROM seat_claim WHERE claim_key = 'TESTADDR/1:internet';
DELETE FROM seat_claim WHERE ROWID = <that rowid>;

INSERT INTO claim_event (event_key, claim_key, address_id, member_id, action, occurred_at)
VALUES ('TESTADDR/1:internet:1', 'TESTADDR/1:internet', 'TESTADDR/1', 'TESTUSER', 'join', '2026-08-22 00:00:00');
SELECT ROWID, event_key, action FROM claim_event WHERE claim_key = 'TESTADDR/1:internet';
DELETE FROM claim_event WHERE ROWID = <that rowid>;

INSERT INTO cohort_counter (cohort_id, roster_count) VALUES ('test-cohort', 0);
SELECT ROWID, cohort_id, roster_count FROM cohort_counter WHERE cohort_id = 'test-cohort';
DELETE FROM cohort_counter WHERE ROWID = <that rowid>;
```

Then confirm the unique constraint actually guards: run the `claim_event`
INSERT twice and the second must fail. If it does not, the `event_key` column
was created without Unique and every concurrency guarantee in this feature is
off.

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
SELECT ROWID FROM invite_click LIMIT 1;
SELECT ROWID FROM share_event LIMIT 1;
SELECT ROWID FROM seat_claim LIMIT 1;
SELECT ROWID FROM claim_event LIMIT 1;
SELECT ROWID FROM cohort_counter LIMIT 1;
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

## 27. Cohort stage notices: `campaign_notices`

One row per campaign per stage announced, and the unique key is the whole
mechanism.

**Why this table exists.** A cohort's stage is derived, never stored, and it is
moved by writing a date into the `campaigns` row. A row written by hand in ZCQL
runs no code at all, so nothing in this stack notices a cohort reaching
`bidding`. There is no event to hang an email on and no cron to poll for one.
`lib/notices.js` therefore compares on read: every dashboard load already
computes each cohort's stage, and this table is the record of which of those
stages have already been mailed.

**The unique constraint IS the race guard.** The notice row is written BEFORE a
single email goes out, so two overlapping sweeps collide on `notice_key` and
the loser sends nothing. That ordering is deliberate and not symmetric: crash
after claiming and some households miss one letter, crash after sending and
every household gets it twice on the next read. For a letter that goes to a
whole cohort at once, missing beats duplicating.

**Seeding.** A campaign with no rows here has never been swept, so its current
stage is recorded without sending. Without that, every cohort already at
`bidding` mails its whole roster the minute this deploys, announcing a step
those households watched happen days ago.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `notice_key` | Var Char | 130 | ✅ | ✅ | **derived**: `` `${campaign_id}:${stage}` ``. The flattened composite (rule 4) and the race guard. **The Unique flag is not optional here**: without it the same letter goes out on every concurrent read |
| `campaign_id` | Var Char | 64 | | ✅ | catalog slug |
| `stage` | Var Char | 16 | | ✅ | a member stage: `forming` \| `locked` \| `bidding` \| `offers` \| `confirm` \| `switching` \| `done` |
| `sent_count` | Int | - | | | how many were delivered. A convenience for the operator; the row's existence is the fact that matters |
| `sent_at` | DateTime | - | | ✅ | when the claim was taken |

### Gate checks, in the ZCQL tab

Prove the unique flag actually took, because everything rests on it. The second
insert must be **refused**:

```sql
INSERT INTO campaign_notices (notice_key, campaign_id, stage, sent_count, sent_at) VALUES ('gate-test:bidding', 'gate-test', 'bidding', 0, '2026-08-27 00:00:00');
```

```sql
INSERT INTO campaign_notices (notice_key, campaign_id, stage, sent_count, sent_at) VALUES ('gate-test:bidding', 'gate-test', 'bidding', 0, '2026-08-27 00:00:01');
```

If the second one succeeds, the Unique flag is not set and every household will
be mailed repeatedly. Fix it before going near a live cohort. Then clean up:

```sql
DELETE FROM campaign_notices WHERE campaign_id = 'gate-test';
```

To re-send a stage during testing, delete its row and let the next read
re-announce it:

```sql
DELETE FROM campaign_notices WHERE notice_key = 'scarborough-east:bidding';
```

---

## 28. The custom mix: one column to add to `provider_bids`

The custom reduction read used to seal a single derived label and drop the
mix itself on the floor. It now seals the mix: per tier, the sticker and
effective prices in cents, the reduction between them, and each named row's
share and cents. The household offer reads those cents; nothing downstream
re-derives them.

**Why cents are stored and not only shares.** A share is a percentage of a
reduction that differs by tier, and a row's dollar figure is the result of a
largest-remainder split that lands the total on the gap exactly. Storing the
result means the panel a partner confirmed and the line a household reads are
the same document, and a later change to the arithmetic cannot rewrite a
sealed bid.

**Deploy order.** Code deploys safely before the column exists: every read
tries the widest column list first and falls back, so a bid without a mix is
unaffected. A CUSTOM bid write names the column, so until it exists, sealing a
custom mix answers "Bidding is not available right now" and every other
reduction read seals as before. Create the column, then re-test a custom seal.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `discount_mix` | Text | 10000 | | | JSON, only when `reduction_presentation = custom`: `{"applyToAll": true, "tiers": [{"tier": "300 Mbps", "stickerCents": 10000, "effectiveCents": 5000, "gapCents": 5000, "mix": [{"type": "member", "label": "Member discount", "sharePct": "50", "amountCents": 2500, "periodStartMo": 0, "periodEndMo": 24}, ...]}]}`. A tier whose sticker equals its effective carries an empty `mix`. The same object is inside `bid_revisions.payload` for that revision |

### Gate checks, in the ZCQL tab

After creating the column, seal a custom bid from the console on a test
cohort and read it back. The row must carry the JSON and the sum of
`amountCents` on each tier must equal that tier's `gapCents`:

```sql
SELECT bid_key, reduction_presentation, mechanism_label, discount_mix FROM provider_bids WHERE reduction_presentation = 'custom' LIMIT 5;
```

Then `GET /api/auth/health/diagnostics` as an admin: `lib/schema.js verify()`
names the column and must not list it as missing.

## 29. Campaign eligibility by FSA: one column on `campaigns`, two on `users`

A campaign is now scoped to the postal code areas it covers. Which partners
may bid on a cohort is still decided by its **region name**, exactly as it
was: `requireActiveCoverage()` matches `slug(coverage.region)` to
`slug(campaign.region)` and `lib/places.js` is the vocabulary both sides are
held to. Nothing in this section touches that. What is new is the other key:
which **households** may join, decided by the FSA, the first three characters
of a member's postal code.

Two keys, two audiences, one row. Neither derives the other: an FSA does not
know which of Toronto's twenty region names it sits inside, and a region name
is a label an operator chose.

**Why one column and not a `campaign_fsas` table.** A cohort covers between
one and a couple of dozen FSAs and the set changes when an operator decides it
does. A table would buy a per-FSA audit trail at the cost of a second read
inside `lib/cohorts.js`, a uniqueness constraint the Data Store cannot express
without the constraint-insert dance on every save, and a soft-delete column.
The audit trail already exists in `auth_events`, which records the before and
after of every campaign write. The one case a `removed_at` column would answer,
a household grandfathered into a cohort whose coverage later changed, is
answered by `campaign_members.fsa`, the snapshot taken at join time, which has
existed since that table did.

**Deploy order, and the one thing to watch.** Code deploys safely before the
column exists: `lib/catalog.js` reads it through the same column list every
other field uses and an absent column parses as an empty set.

**An empty FSA set means UNSCOPED, which means open to everyone.** This is
deliberate and it is the migration. Every campaign that exists today has no
FSA set, and reading an empty set as "nobody is eligible" would, on the deploy
that shipped it, close every live cohort to every household at once: the
dashboards would render, the counts would hold, and joining would simply stop
working with no error anywhere. So the permissive reading is kept, and closed
off from the other end instead:

- `POST /admin/campaigns` refuses to create a campaign in a joinable kind
  (`forming`, `waitlist`, `planned`) with no FSAs.
- `POST /admin/campaigns/:id/transition` refuses to move one into a joinable
  kind with no FSAs.
- `PUT /admin/campaigns/:id` refuses to clear the FSAs of one already taking
  joins.
- `GET /admin/campaigns/reconcile` lists every campaign still unscoped, under
  `mismatches[].kind = 'unscoped_campaign'`.

So the unscoped set only ever shrinks, and it is visible while it does. **Scope
the live campaigns before announcing this feature**: until then every household
in Canada is eligible for every open cohort, which is exactly what is true
today.

### 29a. One column to add to `campaigns`

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `fsas` | Text | 4000 | | | Comma-separated, uppercase, sorted, e.g. `M2M,M2N,M2R`. Written sorted and deduplicated by `routes/admin.js` so two saves of the same coverage produce the same string and an audit diff of an unchanged set is empty. Every entry is validated against `lib/fsaref.js` on the write path; a malformed or unknown FSA is a 400 while an operator is looking at it. Empty means unscoped, above |

### 29b. Two columns to add to `users`

Both optional, both an audit nicety rather than a dependency: `routes/me.js`
writes them and, if the write fails because they do not exist, drops them and
retries so the postal code change itself still lands. Same trade as
`campaign_members.referral_code`.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `postal_code_updated_at` | DateTime | | | | When the postal code last changed |
| `postal_code_source` | Text | 24 | | | `signup` \| `checkup_claim` \| `profile_edit` \| `operator` |

### 29c. Gate checks, in the ZCQL tab

Scope one campaign from the admin console, then read it back. The column must
hold the sorted list, and the campaign must still carry its region name:

```sql
SELECT campaign_id, region, kind, fsas FROM campaigns LIMIT 20;
```

Every campaign taking joins must have a non-empty `fsas`. This is the query
behind the reconcile report's `unscoped_campaign` rows, and it should return
nothing once the live campaigns are scoped:

```sql
SELECT campaign_id, region, kind FROM campaigns WHERE kind IN ('forming','waitlist','planned') AND fsas IS NULL LIMIT 50;
```

Households whose stored postal code this stack can no longer parse. They see
the "add your postal code" card rather than an empty dashboard, and this is
the count of them. It is a report, not a migration: nothing rewrites anybody's
row:

```sql
SELECT COUNT(ROWID) FROM users WHERE user_type = 'member' AND fsa IS NULL AND postal_code IS NOT NULL;
```

Then a join, end to end. Sign in as a member whose FSA is **not** in a scoped
campaign's list and `POST /api/auth/campaigns/join` naming it: the answer must
be `403 NOT_IN_AREA`, and it must be the same answer when the request body
carries `"eligibility": "eligible"`. Then `POST /api/auth/cohorts/<id>/join`
for the same pair: the same refusal, because both doors call
`guards.requireEligible` and there is no third.

Finally `GET /api/auth/health/diagnostics` as an admin: `lib/schema.js
verify()` names all three columns and must not list them as missing.

## 30. The price book: one new table, three columns

The cohort's result stops being a single winning bid and becomes a **price
book**: for each speed tier, the lowest effective price among every sealed bid
that quoted it. A household sees the winner at its own tier plus the tier above
and the tier below, so a cohort's three offers can come from three partners and
every household picking the same speed still pays the same price.

That changes what an award **is**. It used to be one row per cohort, because a
cohort had one winner. A cohort can now be won by several partners at once, and
the roster gate has to stay one per partner per cohort, so the award row's grain
moves from *the cohort's winner* to *this partner's award on this cohort*.

**NOTHING HERE HAS TO HAPPEN BEFORE THE DEPLOY.** New code looks an award up by
`campaign_id:org_id`, and every row created before the price book is keyed on
`campaign_id` alone. Rather than make that a migration you have to land first,
`awards.findForOrg` reads the old key second and rewrites the row in place on
the way past, keeping its roster gate, its capacity and its consent. So the
backfill in 30d is a tidy-up, not a prerequisite, which is the right shape for a
migration nobody can run inside a transaction.

The one case worth knowing about: the old rule awarded the lowest headline
price, and under the per-tier rule that partner can win no tier at all. Their
award is **kept, not revoked**, re-keyed with an empty `tiers_won`, and a line
goes in the log saying so. Taking the cohort off their board would strand real
orders for a rule that changed after they were placed.

### 30a. `campaign_price_books` (new table)

One row per cohort: the whole book, sealed once. Sealed on the first read after
the cohort closes, by whichever surface reads it first, exactly as the award
was: there is no cron in this stack, so nothing can be scheduled for the moment
of a close, and the unique `book_key` is what makes two concurrent readers
produce one book.

The book is stored rather than derived on each read for the reason the award was
recorded in the first place: two readers a second apart must agree, and a late
write or a price correction must never silently re-award a tier a household has
already been shown.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `book_key` | Var Char | 64 | ✅ | ✅ | the `campaign_id`. A cohort is booked once, and the unique constraint is what enforces that under a race. Same pattern as `award_key` |
| `campaign_id` | Var Char | 64 | | ✅ | |
| `book_json` | Text | 10000 | | ✅ | the sealed book, ascending by tier, one entry per tier that drew at least one bid. Shape below |
| `bid_count` | Int | - | | | how many sealed bids the cohort drew. Already public to households as `bidCount`; no partner learns anything else about another |
| `method` | Var Char | 24 | | ✅ | `lowest_per_tier` \| `admin`. `admin` exists so a corrected book is distinguishable from a computed one, in the record and not only in an audit line |
| `sealed_at` | DateTime | - | | ✅ | |

`book_json` holds one entry per tier, ascending in the order of the standard
ladder in `lib/bids.js` (`50 Mbps, 100 Mbps, 300 Mbps, 500 Mbps, 1 Gig,
1.5 Gig, 2.5 Gig`). A tier nobody bid is **absent**, not null, so a household's
three-wide window skips to the next tier that has a winner:

```json
[{"tier":"100 Mbps","price":"50.00","orgId":"org_...","bidKey":"cmp_...:org_...",
  "afterPrice":"65.00","afterLine":"$65 / 100 Mbps","guaranteeMonths":24,
  "equipment":"inc","rentalMonthly":null,"technology":"fibre","uploadMbps":"30",
  "commitment":120,"mix":null}]
```

The partner's **legal name is not stored here**. It is resolved from
`provider_orgs` at read time, the way the single award already resolved it: a
name can change, and a book that froze one would keep telling households an old
one.

### 30b. One column to add to `campaign_awards`

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `tiers_won` | Text | 1000 | | | JSON array of tier names this partner holds on this cohort, e.g. `["100 Mbps","1 Gig"]`. Six names is under 70 bytes; the width is slack, not need |

Two existing columns keep their name and change their meaning. Neither is a
console edit, both are worth knowing when you read a row:

- `award_key` becomes `${campaign_id}:${org_id}`. **The unique flag stays on**,
  and it is now what makes one partner's award on one cohort single.
- `price` becomes the lowest tier price *this partner* won, not the cohort's
  headline. Still Var Char: money is a string everywhere here.

The three roster-gate columns (`gate_at`, `install_capacity_weekly`,
`consent_ack`) do not move and do not change. One partner, one cohort, one gate,
even when that partner won four tiers.

### 30c. Two columns to add to `provider_orders`

The household now chooses which tier it accepts, so the order has to carry it.
Without these the partner books an install without knowing the speed, and the
statement cannot say what was sold.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `tier` | Var Char | 24 | | | the tier name the household accepted, from the standard ladder. Absent on an order created before the price book, which reads as the cohort's single winner |
| `price` | Var Char | 16 | | | the book price for that tier at acceptance, frozen. **Var Char, not a number column**: money is a string everywhere here, and the Int column has no cents |

Both are optional rather than mandatory so the code deploys safely in either
order against them: a read tries the wider column list first and falls back, the
pattern `provider_bids` already uses for `discount_mix`. Only `award_key` has an
order that matters, and that is the backfill below.

### 30d. The backfill, optional, in the ZCQL tab

Only worth doing to leave the table tidy, and only if it has rows at all. If
this returns nothing, skip the rest of 30d entirely:

```sql
SELECT ROWID, award_key, campaign_id, org_id, price FROM campaign_awards LIMIT 200;
```

For each row, set `award_key` to `campaign_id:org_id` and `tiers_won` to the
tier that award actually won. The old award was the lowest headline price, which
is the lowest tier the winning bid quoted, so read it off that bid:

```sql
SELECT bid_key, org_id, price, tiers FROM provider_bids WHERE campaign_id = '<campaign_id>';
```

Then one UPDATE per row, by ROWID. ZCQL has no reliable string concatenation, so
the composite key is typed out rather than computed:

```sql
UPDATE campaign_awards SET award_key = '<campaign_id>:<org_id>', tiers_won = '["100 Mbps"]' WHERE ROWID = <rowid>;
```

Verify no row is left on the old key. Every `award_key` must contain a colon:

```sql
SELECT ROWID, award_key, campaign_id, org_id, tiers_won FROM campaign_awards LIMIT 200;
```

Rows you leave alone are repaired by the first read that touches them, so a
partially finished backfill is a fine place to stop.

### 30e. Gate checks, in the ZCQL tab

The new table answers at all:

```sql
SELECT ROWID FROM campaign_price_books LIMIT 1;
```

Then close a test cohort and read its offer as a joined member
(`GET /api/auth/campaigns/<id>/offer`). The response must carry a `book` array,
and the first read must have sealed the row:

```sql
SELECT book_key, campaign_id, bid_count, method, sealed_at FROM campaign_price_books LIMIT 5;
```

Read it twice and confirm `sealed_at` does not move: the second read must find
the row, not write a new one. Then confirm the derived awards, one row per
partner that won at least one tier, all on composite keys:

```sql
SELECT award_key, campaign_id, org_id, price, tiers_won, method FROM campaign_awards LIMIT 50;
```

The two-partner case is the one worth building on purpose: seal two bids on one
cohort where each is cheapest at a different tier, close it, and confirm
`campaign_awards` has **two** rows and neither partner's desk response names the
other. A partner may see its own `tiersWon` and nothing else: not the book, not
another partner's price, not a redacted row.

Accept an offer at a tier that is **not** the cheapest, and confirm the order
went to the partner that won *that* tier:

```sql
SELECT order_key, campaign_id, org_id, tier, price, state FROM provider_orders LIMIT 20;
```

Finally `GET /api/auth/health/diagnostics` as an admin: `lib/schema.js verify()`
names the new table and the three new columns, and must not list them as
missing.

## 31. The booking at acceptance: one column to add to `provider_orders`

A household now books its install as it accepts: a day inside the next fifteen
days, one of three arrival windows, and the mobile number the crew calls on the
day. The order lands on the partner's board already `bkd`, with `slot_at` set
and a `note` naming the window. Only the number needs a column.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `phone` | Var Char | 24 | | | ✅ | `+1` and ten digits, as `lib/orders.js readPhone` normalises it. Given at acceptance for the install visit and nothing else. Read by the delivering partner only, on the same row, under the same consent, as the address |

Optional rather than mandatory, so the code deploys safely in either order:
reads try the wider column list first and fall back (`ORDER_COLS_V4` down to
`ORDER_COLS`), the same ladder as section 30c. **Until this column exists the
number is not lost**: the insert falls back and writes it into `note`, which the
same partner reads on the same board row. Add the column so it stops riding in
prose.

No new state and no new transition: an accept with a slot inserts straight into
`bkd`, which `TRANSITIONS` already allows out of. The partner's Rebook,
Activate, exception and release moves are unchanged.

### 31a. Gate checks, in the ZCQL tab

Accept an offer from the dashboard with a day and window picked, then confirm
the row arrived booked, with the slot and the number:

```sql
SELECT order_key, state, slot_at, phone, note FROM provider_orders LIMIT 20;
```

`state` must read `bkd` and `slot_at` must be the window's start on the day
picked. Then open the partner's Delivery view: the household's row must show
the day, the window's start time, the address and the number, and the Booked
tile must count it.

Set an install capacity of 1 on that cohort's roster gate and accept a second
household in the same week: the accept must be refused with "That week is full
with this partner", and a third household's confirm screen must show that
week's days greyed out.

Finally `GET /api/auth/health/diagnostics` as an admin: `lib/schema.js verify()`
names `phone` and must not list it as missing.

## 32. The household's window: `household_offers` (new table)

A household is shown three cards of the sealed price book: its own speed and
the two beside it. Which three depends on the household (the speed on its bill,
its preference chip), and until this table nothing recorded the answer: the
dashboard sliced the window on every render, so a bill edited after the
decision silently re-centred the cards under a choice already made, and "what
did you show me" had no record. Now `lib/offers.js` writes one row per
household per cohort on the first offer read after the seal, and never
rewrites it.

**Nothing here has to happen before the deploy.** Without the table the offer
route computes the same window and answers it with `recorded:false`; the
household sees its cards and only the audit line is missing. Create it and the
next read records.

### 32a. `household_offers` (new table)

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `offer_key` | Var Char | 130 | ✅ | ✅ | | `${campaign_id}:${user_id}`. The unique flag is the race guard: two readers on the same household write one row |
| `campaign_id` | Var Char | 64 | | ✅ | | |
| `user_id` | Var Char | 64 | | ✅ | ✅ | never sent to a partner |
| `speed_mbps` | Var Char | 16 | | | | the bill speed as it was read, `"0"` is the checkup's Not sure, empty when no bill |
| `centre_tier` | Var Char | 24 | | | | the book tier the window centred on |
| `window_rule` | Var Char | 40 | | ✅ | | which branch produced the cards, e.g. `bill:centred`, `bill:nearest:end_low`, `unknown:end_low`, `pref_up:end_high`, `none` |
| `cards_json` | Text | 4000 | | ✅ | | `[{tier, orgId, bidKey, price, position}]`, position `below`, `current`, `above`, or one card with `none` |
| `offered_at` | DateTime | - | | ✅ | | |

Every `price` in `cards_json` is the seal's string, copied from `book_json`,
never recomputed.

### 32b. Gate checks, in the ZCQL tab

```sql
SELECT ROWID FROM household_offers LIMIT 1;
```

Then read a closed cohort's offer as a joined member
(`GET /api/auth/campaigns/<id>/offer`): the response carries `offers.cards`
with `offers.recorded: true`, and one row exists:

```sql
SELECT offer_key, centre_tier, window_rule, offered_at FROM household_offers LIMIT 5;
```

Read it twice and confirm `offered_at` does not move. Change the member's bill
speed on the checkup and read again: the cards must NOT change, because the
record is the record. Then run the insert twice by hand and the second must
fail: if it does not, `offer_key` was created without Unique.

Finally `GET /api/auth/health/diagnostics` as an admin: `lib/schema.js verify()`
names `household_offers` and must not list it as missing.

---

## 33. The notification layer: four tables, two columns, five variables

Phase A of the notification build. What this unblocks is not new email, it is
the ability to stop sending it: four signup surfaces and `privacy.html` already
tell people they can unsubscribe at any time, and until these tables exist
there is no list to put them on.

**Nothing here is required for the site to keep working.** Every read degrades:
`lib/notify/outbox.js` returns quietly when `notification_outbox` is missing,
exactly as `lib/notices.js` does, and `lib/notify/suppress.js` fails CLOSED for
commercial mail and OPEN for a sign-in code. So a deploy before these tables
exist sends nothing new and locks nobody out. It also records nothing, which is
the state to leave as quickly as possible.

**Order matters here, unlike most sections.** Create the tables BEFORE
deploying the auth function. The code is written to survive their absence, but
every message sent in the gap is a message with no delivery record and no
suppression check, and there is no way to reconstruct either afterwards.

### 33a. `notification_outbox` (new table)

One row per (event, template, recipient). **The unique flag on `notify_key` is
the whole deduplication.** `lib/notices.js` sweeps on every dashboard load, so
without it a cohort's letters go out again on every page view.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `notify_key` | Var Char | 64 | ✅ | ✅ | sha256 over event, template and recipient. **The Unique flag is not optional.** |
| `event_key` | Var Char | 190 | | ✅ | `campaign.stage:brampton-east:offers` for a system decision, `otp.start:<req id>` for a click |
| `template_key` | Var Char | 80 | | ✅ | `member.campaign.stage` |
| `recipient_type` | Var Char | 16 | | ✅ | `member` \| `partner` \| `admin` \| `address` |
| `recipient_id` | Var Char | 190 | | ✅ | `users.user_id`, or the address itself for `address` |
| `recipient_email` | Var Char | 255 | | ✅ | snapshot at enqueue |
| `locale` | Var Char | 8 | | | `en`, fallback `en` |
| `timezone` | Var Char | 64 | | | IANA, fallback `America/Toronto` |
| `campaign_id` | Var Char | 64 | | | present on every campaign-scoped message |
| `context` | Text | 10000 | | | render context, JSON |
| `send_priority` | Var Char | 16 | | ✅ | `security` \| `action_required` \| `informational` \| `reminder`. **Not `priority`**: that is reserved in ZCQL and the console refuses it |
| `casl_class` | Var Char | 16 | | ✅ | `transactional` \| `cem` |
| `category` | Var Char | 32 | | ✅ | the preference category |
| `collapse_group` | Var Char | 120 | | | `campaign_stage:brampton-east` |
| `earliest_send_at` | DateTime | - | | ✅ | quiet hours land here |
| `status` | Var Char | 16 | | ✅ | `queued` \| `held` \| `superseded` \| `sending` \| `sent` \| `failed` \| `suppressed` \| `cancelled` |
| `attempts` | Int | - | | | |
| `last_error` | Var Char | 190 | | | `missing:dashboard_url`, `scrubbed:other_partner_name` |
| `subject` | Var Char | 190 | | | written on success, for the member's own history |
| `body_sha` | Var Char | 64 | | | the body itself is NOT stored: no blob store is wired |
| `created_at` | DateTime | - | | ✅ | |
| `updated_at` | DateTime | - | | | |
| `sent_at` | DateTime | - | | | |

### 33b. `notification_deliveries` (new table, append only)

One row per attempt, and one more per webhook event on that attempt. Append
only on purpose: updating the previous row in place would destroy the sequence
that answers "it was accepted, and then it bounced".

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `outbox_key` | Var Char | 64 | | ✅ | the outbox row's `notify_key` |
| `client_reference` | Var Char | 64 | | | the value **we** chose, echoed back by ZeptoMail. Matched on first |
| `provider_message_id` | Var Char | 200 | | | the value the provider chose. The fallback |
| `transport` | Var Char | 16 | | | `zeptomail` \| `smtp` \| `log` |
| `status` | Var Char | 24 | | ✅ | `accepted` \| `delivered` \| `bounced_hard` \| `bounced_soft` \| `complained` \| `clicked` \| `failed` \| `unknown`. **Never `opened`**: open tracking is off for member mail by decision |
| `status_at` | DateTime | - | | ✅ | |
| `detail` | Var Char | 500 | | | bounce reason, provider error |
| `created_at` | DateTime | - | | ✅ | |

### 33c. `email_suppressions` (new table)

The addresses nothing may be written to. **`email` must be Unique**: the
address is the identity here, whatever number of accounts have used it.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `email` | Var Char | 255 | ✅ | ✅ | lowercased by the write path |
| `reason` | Var Char | 24 | | ✅ | `hard_bounce` \| `complaint` \| `unsubscribed_all` \| `manual` |
| `source` | Var Char | 120 | | | `webhook:hardbounce`, `unsub:one_click` |
| `first_seen_at` | DateTime | - | | ✅ | |
| `last_seen_at` | DateTime | - | | ✅ | |

`hard_bounce` and `complaint` block **transactional mail as well**, and that
asymmetry is deliberate: a complaint means somebody pressed the spam button,
and continuing to send them sign-in codes is how a sending domain gets filtered
for every other member at once.

### 33d. `unsubscribe_tokens` (new table)

One row per (recipient, scope), **reused, not minted per message**. A token per
email would put millions of rows in a lookup table and would break the link in
an old email, which is exactly when people press one.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `token_key` | Var Char | 200 | ✅ | ✅ | **derived**: `` `${recipient_type}:${recipient_id}:${scope}` ``. The flattened composite (rule 4) |
| `token` | Var Char | 16 | ✅ | ✅ | opaque, two checked halves, no identity encoded |
| `recipient_type` | Var Char | 16 | | ✅ | `member` \| `partner` |
| `recipient_id` | Var Char | 190 | | ✅ | |
| `scope` | Var Char | 32 | | ✅ | `all_cem`, or one unlockable category |
| `created_at` | DateTime | - | | ✅ | |
| `used_at` | DateTime | - | | | first press. The row is NOT burned: a second press must be a no-op |

### 33e. Two columns to add to `users`

Both optional, both with a ladder in `lib/users.js`, so an environment without
them reads one rung narrower and falls back to `en` and `America/Toronto`.
Correct for the GTA footprint, wrong the day a British Columbia household joins.

| Column | Type | Length | Unique | Mandatory | Notes |
|---|---|---|:--:|:--:|---|
| `locale` | Var Char | 8 | | | `en`. French is written before any Quebec region opens |
| `timezone` | Var Char | 64 | | | IANA. Quiet hours are held against this |

### 33f. Environment variables, in **both** environments

| Name | Required | Notes |
|---|:--:|---|
| `MAIL_POSTAL_ADDRESS` | for commercial mail | **No fallback, deliberately.** An invented address in a compliance footer is worse than a missing one because it looks correct in every review. Unset, transactional mail sends with identification and no address, and every commercial send is REFUSED with `no_postal_address` |
| `MAIL_LEGAL_NAME` | | defaults to `Whollar`. Set it to the registered entity name |
| `MAIL_FROM_TRANSACTIONAL` | | e.g. `no-reply@mail.whollar.com`. Falls back to `ZEPTOMAIL_FROM`. **It must be an address a verified ZeptoMail Mail Agent may send as.** Set it to a subdomain with no Mail Agent behind it and ZeptoMail refuses every transactional send, sign-in codes included. Leave it unset until the Mail Agent exists: the fallback is the sender that already works |
| `MAIL_FROM_CEM` | | e.g. `news@news.whollar.com`. Falls back to `ZEPTOMAIL_FROM`. Same rule, same failure |

Neither of these reaches the SMTP relay. It authenticates as one mailbox and
refuses any other From, so it always sends as `SMTP_FROM`. That is not a
limitation to work around: it is what keeps the fallback able to carry a login
code on a day ZeptoMail cannot. `GET /api/auth/health` reports all three
addresses as `mail_senders`, and the transactional one is the field to read
first when mail stops arriving.
| `MAIL_WEBHOOK_SECRET` | for the webhook | Unset, `POST /hooks/zeptomail` answers 503 to everything. An unauthenticated endpoint that writes suppressions is a way for anyone to silence anyone |

Also confirm `ZEPTOMAIL_API_BASE` is `https://api.zeptomail.ca` in **both**
environments. The code default is now the Canadian host, so an unset variable
is no longer a residency problem, but an explicitly wrong one still is.

### 33g. Gate checks, in the ZCQL tab

**The deduplication.** The second insert must be **refused**:

```sql
INSERT INTO notification_outbox (notify_key, event_key, template_key, recipient_type, recipient_id, recipient_email, send_priority, casl_class, category, earliest_send_at, status, created_at) VALUES ('gate-test-key', 'gate:test', 'account.otp', 'address', 'gate@test.invalid', 'gate@test.invalid', 'security', 'transactional', 'security', '2026-08-30 00:00:00', 'queued', '2026-08-30 00:00:00');
```

```sql
INSERT INTO notification_outbox (notify_key, event_key, template_key, recipient_type, recipient_id, recipient_email, send_priority, casl_class, category, earliest_send_at, status, created_at) VALUES ('gate-test-key', 'gate:test', 'account.otp', 'address', 'gate@test.invalid', 'gate@test.invalid', 'security', 'transactional', 'security', '2026-08-30 00:00:01', 'queued', '2026-08-30 00:00:01');
```

If the second one succeeds, the Unique flag on `notify_key` is not set and
every cohort will be mailed again on every dashboard load. Fix it before going
near a live cohort. Then clean up:

```sql
DELETE FROM notification_outbox WHERE notify_key = 'gate-test-key';
```

**The suppression list.** Same test, and the same stakes in the other
direction: without the Unique flag on `email`, one address accumulates a row
per bounce and the reason that explains the block is whichever row is read
first.

```sql
INSERT INTO email_suppressions (email, reason, source, first_seen_at, last_seen_at) VALUES ('gate@test.invalid', 'manual', 'gate-test', '2026-08-30 00:00:00', '2026-08-30 00:00:00');
```

```sql
INSERT INTO email_suppressions (email, reason, source, first_seen_at, last_seen_at) VALUES ('gate@test.invalid', 'complaint', 'gate-test', '2026-08-30 00:00:01', '2026-08-30 00:00:01');
```

The second must be refused. Then:

```sql
DELETE FROM email_suppressions WHERE email = 'gate@test.invalid';
```

**The two token constraints.** `unsubscribe_tokens` needs Unique on **both**
`token_key` and `token`. The first stops a second row for one recipient, the
second stops two recipients sharing a link.

```sql
INSERT INTO unsubscribe_tokens (token_key, token, recipient_type, recipient_id, scope, created_at) VALUES ('member:gate:all_cem', 'GATE0TESTGATE0TE', 'member', 'gate', 'all_cem', '2026-08-30 00:00:00');
```

```sql
INSERT INTO unsubscribe_tokens (token_key, token, recipient_type, recipient_id, scope, created_at) VALUES ('member:other:all_cem', 'GATE0TESTGATE0TE', 'member', 'other', 'all_cem', '2026-08-30 00:00:01');
```

The second must be refused on `token`. Then:

```sql
DELETE FROM unsubscribe_tokens WHERE recipient_id = 'gate';
```

**The two new `users` columns exist.** This must return rows rather than an
error, and if it errors the ladder in `lib/users.js` is what is carrying the
site:

```sql
SELECT user_id, locale, timezone FROM users LIMIT 1
```

**The deliveries table takes a row.**

```sql
INSERT INTO notification_deliveries (outbox_key, client_reference, transport, status, status_at, created_at) VALUES ('gate-test-key', 'gate-test-key', 'log', 'accepted', '2026-08-30 00:00:00', '2026-08-30 00:00:00');
```

```sql
DELETE FROM notification_deliveries WHERE outbox_key = 'gate-test-key';
```

### 33h. After the tables exist

`GET /api/auth/health/diagnostics` (admin session required) reports every
declared table, so the four new ones appear there once created. A row count of
zero on `notification_outbox` after a sign-in attempt means the table exists
and nothing wrote to it, which is a different problem from the table being
absent, and the two are worth telling apart before hunting through DNS again.

---

## 34. Provider exclusions: four new tables, one column pair, four columns

A member names the providers they will not hear from, every founding partner
declares the brands it operates, and the price book is then cut PER MEMBER out
of that member's eligible bids. The promise made to the household is absolute
("excluded providers will never be able to send you an offer"), so it is
enforced in the award and in the accept, not by hiding a card.

**Deploy order matters here, and it is not the usual one.** Every other section
in this file can land in either order. This one has a rule:

1. **34a `brand_registry` first, and seed it.** Nothing else is usable without
   it: a roster picks from it, an exclusion picks from it, and a bid names a row
   in it. An empty registry is a working screen with nothing in it.
2. **34b `provider_brands` next.** Until it exists no bid may name a brand, and
   `lib/rosters.js canBidAs` says so rather than passing the bid through.
3. **34d `member_provider_exclusions` next.** This is the one with a safety
   consequence: see the note under it.
4. **34e and 34f, the columns, last and at any time.** Both have fallbacks.

**What happens before any of it lands:** nothing changes. `brands.all()`,
`rosters.rosterFor()` and `exclusions.setFor()` each return the "not created"
answer, the exclusion step reports itself unavailable, the offer route reads
the sealed cohort book exactly as it does today, and no member is filtered.

### 34a. `brand_registry` (new table)

The canonical list of consumer-facing brands, and the one place a flanker brand
is tied to its parent. Members, partners and bids all resolve through it, so
nothing free-types a brand name into matching logic.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `brand_id` | Var Char | 64 | ✅ | ✅ | | slug, `^[a-z0-9][a-z0-9-]{0,62}$`, e.g. `bell`, `virgin-plus`, `oxio`. Reaches a WHERE clause, so the charset is enforced in `lib/brands.js` |
| `display_name` | Var Char | 120 | | ✅ | | exact consumer-facing name, accents included, e.g. `Vidéotron` |
| `parent_brand_id` | Var Char | 64 | | | | null for a parent or independent brand. ONE level only: a flanker's parent must itself have null here |
| `owner_org_name` | Var Char | 255 | | | | operator review only. **Never rendered to a member**: `publicBrand()` names the three fields that cross |
| `status` | Var Char | 16 | | ✅ | | `active` \| `retired` \| `pending_review` |
| `created_at` | DateTime | - | | ✅ | | |
| `updated_at` | DateTime | - | | | | |

**Seeding.** Take the provider column of the pricing dataset. Every parent gets
`parent_brand_id` null; every flanker points at its parent. Only `active` rows
are selectable anywhere, so seed conservatively and promote later: a brand
missing from the registry cannot be excluded, which is a worse failure than a
brand nobody picks.

### 34b. `provider_brands` (new table)

The brands one founding partner has attested to operating. Soft removal only:
a bid sealed last month was made under the roster as it stood then.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `roster_key` | Var Char | 160 | ✅ | ✅ | | `${provider_id}:${brand_id}`. The Data Store has no partial unique index, so this is one row per (org, brand) EVER, revived rather than re-inserted |
| `provider_id` | Var Char | 64 | | ✅ | | `provider_orgs.org_id` |
| `brand_id` | Var Char | 64 | | ✅ | | `brand_registry.brand_id` |
| `declared_at` | DateTime | - | | ✅ | | re-stamped on every attestation, including for unchanged rows: the date is the date the WHOLE list was last sworn to |
| `attested_by` | Var Char | 64 | | ✅ | | the user id that attested |
| `removed_at` | DateTime | - | | | | soft removal, history never deleted |

### 34c. `distributor_providers` (new table)

The providers one distributor has attested to serving.

**There is no distributor console yet**, and this table is not on any live
path today. It is created now because `lib/rosters.js canBidAs` already
enforces it: the moment an authenticated distributor role exists, a
distributor bid is checked against this map and cannot bypass a member's
exclusion. The gate before the door, which for this particular gate is the
right order.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `serving_key` | Var Char | 160 | ✅ | ✅ | | `${distributor_id}:${provider_id}` |
| `distributor_id` | Var Char | 64 | | ✅ | | |
| `provider_id` | Var Char | 64 | | ✅ | | `provider_orgs.org_id` |
| `declared_at` | DateTime | - | | ✅ | | |
| `attested_by` | Var Char | 64 | | ✅ | | |
| `removed_at` | DateTime | - | | | | |

### 34d. `member_provider_exclusions` (new table)

One row per brand a member has excluded, materialised at write time. Never "the
parent plus whatever the registry says its children are today": a registry edit
must not silently widen or narrow a list the member already agreed to.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `excl_key` | Var Char | 160 | ✅ | ✅ | | `${member_id}:${brand_id}`. One row per pair EVER; a re-exclusion revives the row and bumps `cycles` |
| `member_id` | Var Char | 64 | | ✅ | ✅ | never sent to a partner in any shape, including an error payload |
| `brand_id` | Var Char | 64 | | ✅ | | |
| `source` | Var Char | 16 | | ✅ | | `direct` \| `family_default`. Recorded, never enforced |
| `created_at` | DateTime | - | | ✅ | | re-stamped on a revival |
| `removed_at` | DateTime | - | | | | soft removal |
| `cycles` | Int | - | | | | how many times this pair has been excluded. Absent is read as 1 |

**Read the safety note before creating this one.** `lib/exclusions.js`
distinguishes two failures that look identical to Catalyst and demand opposite
behaviour. Table absent means nobody anywhere has an exclusion, so offers route
exactly as they did before the feature: an empty set is correct. Table PRESENT
and a member's read failing means an empty set is a guess, and the guess
delivers an offer the household refused. So presence is probed separately and
`setFor()` returns null in the second case, which every award path treats as
"do not route" and never as "nothing excluded". A household then sees
`offersHeld: true` instead of an offer. That is the intended behaviour: the
promise is absolute, so the failure mode is a missing offer, never a wrong one.

The full history for a dispute is in `auth_events`, not here: every create and
remove writes `member.exclusions.replace` with the added and removed lists.

### 34e. Two columns to add to `provider_bids`

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `brand_id` | Var Char | 64 | | | | the brand this bid is made under. Validated against the attested roster at submission |
| `submitted_via_distributor_id` | Var Char | 64 | | | | null for a direct provider submission |

**Both nullable, and a bid that names no brand is still accepted.** These
columns and 34b are separate schema objects, so either can exist without the
other; `routes/desk.js writeHead()` retries the head write without them. A
brandless bid is attributed to its org's primary declared brand by
`lib/awards.js brandOfBid()`, so an exclusion still bites on every bid sealed
before this column existed. Making a brand mandatory is a later flip, worth
making only once every active partner has attested a roster.

### 34f. Five columns to add to `household_offers`

Section 32 recorded one window per household and never rewrote it, which is
exactly what a new exclusion during `offers_out` has to change. Both hold by
versioning: a row is still never rewritten, and a new exclusion writes version
n+1 and stamps version n superseded.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `version` | Int | - | | | | absent is read as 1, so every row already in the table is version 1 without being touched |
| `superseded_at` | DateTime | - | | | | set when a later version replaces this one |
| `audit_json` | Text | 20000 | | | | the per-bid resolution for this version: `[{bidKey, orgId, brandId, status}]`, status `awarded` \| `outranked` \| `skipped_excluded_brand` \| `invalidated_brand_inactive` \| `skipped_unresolved_brand`. **Operator-only. Never in a member or provider payload** |
| `excluded_json` | Text | 4000 | | | | the exclusion set this version was cut against, which is what makes a stale window detectable |
| `withdrawn_json` | Text | 4000 | | | | tiers this household held and no longer holds: `[{tier, price, state:'withdrawn_by_exclusion'}]` |

`offer_key` stays `${campaign_id}:${user_id}` for version 1 and takes a `:v{n}`
suffix from version 2, so the existing unique constraint keeps working and no
row already written needs a new key.

### 34g. `brand_requests` (new table, optional)

A partner asking for a brand we do not list creates a `pending_review` row in
34a plus an operator task here. The registry row is the record that matters and
the task is best-effort, so this table is optional: without it the request
still lands, and only the operator queue is lost.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `brand_id` | Var Char | 64 | | ✅ | | the derived slug, never partner-supplied |
| `provider_id` | Var Char | 64 | | ✅ | | |
| `display_name` | Var Char | 120 | | ✅ | | |
| `evidence_url` | Var Char | 500 | | ✅ | | |
| `note` | Text | 1000 | | | | |
| `requested_by` | Var Char | 64 | | ✅ | | |
| `requested_at` | DateTime | - | | ✅ | | |
| `state` | Var Char | 16 | | ✅ | | `open` \| `promoted` \| `refused` |

### 34h. Gate checks, in the ZCQL tab

Each table answers at all:

```sql
SELECT ROWID FROM brand_registry LIMIT 1;
SELECT ROWID FROM provider_brands LIMIT 1;
SELECT ROWID FROM distributor_providers LIMIT 1;
SELECT ROWID FROM member_provider_exclusions LIMIT 1;
```

The two unique flags are the race guards, and both must be tested by hand,
because a missing Unique flag fails silently as a duplicate row rather than as
an error. Insert the same `excl_key` twice: the second must fail. Same for
`roster_key`.

The one-level family rule, which no constraint can express:

```sql
SELECT brand_id, parent_brand_id FROM brand_registry WHERE parent_brand_id IS NOT NULL LIMIT 100;
```

Every `parent_brand_id` in that result must name a row whose own
`parent_brand_id` is null. A two-hop chain is a data error; `familyOf()`
reports it as `depthError` rather than resolving a grandparent the member was
never shown.

Then the columns:

```sql
SELECT brand_id, submitted_via_distributor_id FROM provider_bids LIMIT 1;
SELECT version, superseded_at, excluded_json FROM household_offers LIMIT 1;
```

**The end-to-end check, which is the only one that proves the feature.** Two
members on one closed cohort, two partners bidding under two different brands
at different prices:

1. As member M, `PUT /api/auth/me/exclusions` naming the CHEAPER brand.
2. `GET /api/auth/campaigns/<id>/offer` as M, then as member N who excluded
   nothing.
3. N's `book` holds the cheaper brand at the contested tier. M's holds the
   dearer one, at its own price, and **M's whole response must contain no
   occurrence of the excluded brand's name or its price**. Check the raw JSON,
   not the rendered card.
4. `SELECT offer_key, version, excluded_json FROM household_offers` shows one
   row per member, M's `excluded_json` carrying the brand.
5. As the cheaper partner, `GET /api/auth/provider/cohorts/<id>/results`:
   `households_unreachable_exclusions` is 1 and no member is named.

Then add a second exclusion as M and read the offer again: a new row appears at
`version` 2, version 1 carries `superseded_at`, and the response's
`offers.withdrawn` names the tier that went.

Finally `GET /api/auth/health/diagnostics` as an admin: `lib/schema.js verify()`
names the four new tables and must not list them as missing.

---

## 35. The winter tire waitlist: three tables, two optional

`tires.whollar.ca` has a sign-up with two paths: a quick one that asks for the
essentials, and a guided one that walks four calculators and asks about thirty
more things. `POST /tire-waitlist-join` on the **formSubmit** function writes
what comes back. The pages are built and deployed; the route and these tables
are what is left. See `docs/TIRE_VERTICAL_BUILD.md` for the build around them.

**READ THIS BEFORE THE FIRST COLUMN.** Rule 2 at the top of this document says
`lower_snake_case`. **That rule governs the auth tables, and these are not auth
tables.** These belong to the formSubmit function, alongside `WaitlistSignups`,
`BillCheckupSubmissions` and `PartnerApplications`, and every one of those uses
**PascalCase table names and PascalCase columns**. `FirstName`, not
`first_name`. Getting this wrong fails at runtime, not at deploy: the insert
throws on an unknown column and the household is told the servers could not be
reached.

**Fail-closed, deliberately.** There is no silent-skip contract here. Until
35a, 35b and 35c exist the route returns a clear error and the page keeps the
form on screen with what was typed still in it. A waitlist that accepts a
household and drops it is worse than one that says it is not open yet, and this
is the only door the tire cohort has.

**Order:** 35a first (everything else points at its `ReferenceCode`), then 35b
and 35c in either order. 35d and 35e are optional and can come later or never.

### 35a. `TireWaitlistSignups` (new table)

One row per person. The row every other tire table points back at.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `ReferenceCode` | Var Char | 24 | ✅ | ✅ | | `WHL-TIRE-GTA-XXXX`, minted by the server, never by the browser. Unique is the race guard, and it is what a household quotes back to change anything |
| `Email` | Var Char | 254 | | ✅ | ✅ | lowercased on write. Every table in this backend joins on the lowercased address, because ZCQL has no `LOWER()` and Zoho's equals is not reliably case-insensitive |
| `FirstName` | Var Char | 120 | | ✅ | ✅ | |
| `LastName` | Var Char | 120 | | ✅ | ✅ | |
| `Phone` | Var Char | 20 | | | ✅ | digits only, the shape `WaitlistSignups.Phone` already stores. The canonical `+1` form goes to the CRM |
| `FSA` | Var Char | 3 | | ✅ | | first three of the postal code, and what a cohort is grouped by |
| `PostalFull` | Var Char | 7 | | | ✅ | tires are fitted at an address, so unlike the internet lead tables the full code earns a column here rather than living only in the CRM payload |
| `City` | Var Char | 40 | | ✅ | | `gta`, `ottawa`, `calgary`, `edmonton`, `montreal`, `vancouver`, `other`. Only `gta` is open; the rest are a vote |
| `Path` | Var Char | 12 | | ✅ | | `quick` or `guided`. The one number that says whether the four calculators earn their build |
| `Source` | Var Char | 24 | | ✅ | | `tires-site` from this vertical, `umbrella-join` from `home/join.html`, which already asks internet / tires / both. Two doors reach one cohort and this is what keeps the count honest |
| `Language` | Var Char | 5 | | | | `en` or `fr` |
| `ReferralCode` | Var Char | 64 | | | | as typed: a code, or a neighbour's email |
| `ConsentEmail` | Var Char | 5 | | ✅ | | `true` or `false`. Catalyst offers no boolean type |
| `ConsentSms` | Var Char | 5 | | | | the guided path asks separately, because a text at 8pm is a different promise than an email |
| `ConsentShare` | Var Char | 5 | | | | may their details go to matched installers |
| `AlsoInternet` | Var Char | 5 | | | | the "add me to the internet cohort too" checkbox |
| `ConsentText` | Text | 4000 | | ✅ | | the exact sentence agreed to. CASL needs what, when and where, and a checkbox state proves none of the three a year later |
| `ConsentAt` | DateTime | - | | ✅ | | |
| `SubmittedAt` | DateTime | - | | ✅ | | |

### 35b. `TireWaitlistVehicles` (new table)

One row per car, not per household. Two reasons: the confirm screen offers
"Got another car? Add it to the waitlist for its own spot", and a tire cohort
is sized by tire size, so the size is the unit a bid is built on.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `VehicleKey` | Var Char | 40 | ✅ | ✅ | | `${ReferenceCode}:${n}`. Unique is what makes a double submit one row and "add another car" idempotent. **Test this one twice by hand** |
| `ReferenceCode` | Var Char | 24 | | ✅ | | the link back to 35a. The Data Store has no joins, so this is read as a filter |
| `Email` | Var Char | 254 | | ✅ | ✅ | denormalised for the same reason |
| `InputMode` | Var Char | 10 | | ✅ | | `vehicle`, `size`, `vin` or `unsure`. Someone who picked `unsure` is not a worse household, they are a household to call |
| `VehicleYear` | Var Char | 4 | | | | |
| `VehicleMake` | Var Char | 40 | | | | |
| `VehicleModel` | Var Char | 60 | | | | |
| `Vin` | Var Char | 17 | | | ✅ | identifies one specific car, so it is PII |
| `TireSize` | Var Char | 20 | | | | exactly as typed, e.g. `225/45R17` |
| `SizeNormalized` | Var Char | 20 | | | | parsed and canonical. Separate from what they typed, because this is the column a cohort is actually cut on and a typo must not silently become a size |
| `Strategy` | Var Char | 12 | | | | `winter`, `allweather`, or empty when the tool was not run. The all-weather answer means no second set of rims and no storage, which changes what the bid asks for |
| `RunsWinterNow` | Var Char | 10 | | | | `every`, `some`, `never` |
| `OwnsRims` | Var Char | 10 | | | | `alloy`, `steel`, `no` |
| `SubmittedAt` | DateTime | - | | ✅ | | |

### 35c. `TireWaitlistDetails` (new table)

One row per signup, written only by the guided path. Columns for what a bid is
actually built from, one payload for the rest, so a new question on the form is
not a schema change and a console visit.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `ReferenceCode` | Var Char | 24 | ✅ | ✅ | | one details row per signup |
| `Email` | Var Char | 254 | | ✅ | ✅ | |
| `Needs` | Var Char | 255 | | | | comma list of `tires,package,mount,install,swap,align,disposal,storage,oil` |
| `Tier` | Var Char | 12 | | | | `recommend`, `premium`, `mid`, `value` |
| `Brand` | Var Char | 12 | | | | `open`, `name`, `specific` |
| `Budget` | Var Char | 12 | | | | `u800`, `800`, `1100`, `1500`, `open` |
| `Financing` | Var Char | 8 | | | | `yes`, `maybe`, `no` |
| `InstallerType` | Var Char | 16 | | | | `any`, `independent`, `bigbox`, `dealer`, `mobile` |
| `Anchor` | Var Char | 8 | | | | `home`, `work`, `either` |
| `SplitPreference` | Var Char | 12 | | | | `prefer`, `dontmind`, `one`: may fitting and storage be two places |
| `InstallWindows` | Var Char | 255 | | | | the chosen date chips, or `any`. Fitting capacity before first snow is the real constraint on cohort size |
| `NotBefore` | Var Char | 10 | | | | `YYYY-MM-DD`. Var Char and not DateTime: it is a date with no time, and nothing sorts on it |
| `MustBeOnBy` | Var Char | 10 | | | | as above. Nov 1 is the usual insurance target |
| `Memberships` | Var Char | 255 | | | | `costco,caa,triangle,club,employer,cc,none` |
| `Priorities` | Var Char | 120 | | | | up to two of `price,early,brand,close,rep` |
| `Readiness` | Var Char | 10 | | | | `ready`, `likely`, `watch` |
| `Notes` | Text | 4000 | | | ✅ | free text. PII by default: people put addresses, plate numbers and phone numbers in these boxes |
| `Payload` | Text | 10000 | | | | every answer with no column above, verbatim JSON |
| `SubmittedAt` | DateTime | - | | ✅ | | |

### 35d. `TireToolRuns` (new table, optional)

The four calculators, what was answered and what was said back. Worth having:
it is the only measure of what people are unsure about, which is what decides
whether the guided path keeps earning its build. **Nothing breaks without it.**
The route writes the same values into `TireWaitlistDetails.Payload` when this
table is absent, and logs `TireToolRuns write skipped`, the same sidecar
contract `cohort_counter` has in section 26.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `RunKey` | Var Char | 40 | ✅ | ✅ | | `${ReferenceCode}:${Tool}` |
| `ReferenceCode` | Var Char | 24 | | ✅ | | |
| `Tool` | Var Char | 12 | | ✅ | | `insurance`, `size`, `rims`, `strategy` |
| `InputJson` | Text | 2000 | | ✅ | | what they answered |
| `OutputJson` | Text | 2000 | | ✅ | | what we told them. Keep it: this is a statement we made, on a date, about their money |
| `RanAt` | DateTime | - | | ✅ | | |

### 35e. `TireCohortCounter` (new table, optional)

**Only needed if a rank or a live count is ever shown.** It is not shown today,
and that is deliberate: the prototype printed "you are #1,848", which was 1847
plus a random number, and the port removed it.

An honest count cannot come from counting rows. ZCQL refuses any `LIMIT` over
300, a hard Catalyst ceiling, which is why `/pooling-count` answers `300+`
rather than a number once a table passes that size. A counter row is the only
way to show a rank that is true.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `CounterKey` | Var Char | 64 | ✅ | ✅ | | `tires:<city>`, e.g. `tires:gta` |
| `Vertical` | Var Char | 16 | | ✅ | | `tires` |
| `City` | Var Char | 40 | | ✅ | | |
| `Joined` | Int | 10 | | ✅ | | incremented on each accepted signup. Default 0 |
| `UpdatedAt` | DateTime | - | | ✅ | | |

### 35f. Gate checks, in the ZCQL tab

The three required tables answer at all:

```sql
SELECT ROWID FROM TireWaitlistSignups LIMIT 1;
SELECT ROWID FROM TireWaitlistVehicles LIMIT 1;
SELECT ROWID FROM TireWaitlistDetails LIMIT 1;
```

Then submit the guided path once against a preview of `tires.whollar.ca` and
confirm one row in each, carrying the same `ReferenceCode`:

```sql
SELECT ReferenceCode, City, Path, Source, ConsentAt FROM TireWaitlistSignups LIMIT 5;
SELECT VehicleKey, InputMode, SizeNormalized, Strategy FROM TireWaitlistVehicles LIMIT 5;
SELECT ReferenceCode, Needs, InstallWindows, Readiness FROM TireWaitlistDetails LIMIT 5;
```

**Then prove the unique flags, because they are the whole race guard.** Insert
the same `VehicleKey` twice by hand: the second must fail. Do the same for
`TireWaitlistSignups.ReferenceCode`. If either succeeds, the column was created
without Unique, and a double submit will duplicate a household or a car.

Finally, submit the quick path: exactly one row in 35a and one in 35b, and
**nothing in 35c**. A details row from the quick path means the route is
writing empty preferences, which then read as answers nobody gave.

---

## 36. What the v5 port added: one new table, eighteen columns

Section 35 was written against the first tire waitlist drop. The page that
actually shipped is the v5 port (`tires/js/tire-kit.js`, generated by
`scripts/port-tires.mjs`), and it asks a good deal more: four calculators whose
answers are kept, a starting-point question, a trim, a VIN, ranked appointment
windows, and a size acknowledgement that is a liability record rather than a
preference.

**This section is a delta.** If 35a, 35b and 35c already exist, nothing here
asks you to recreate them. Add the columns, and one table.

**None of it is fail-closed.** Every column below is optional on the write, and
the route puts anything it cannot place into `TireWaitlistDetails.Payload`. So
the three tables from section 35 are enough to open the door; this section is
what stops the richest answers arriving as JSON nobody queries.

### 36a. Columns to add to `TireWaitlistSignups`

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `Wave` | Int | 10 | | | | which wave of 250 this household lands in. Derived at write time from the count, and stored because the number they were told is the number they were told |

`rank` is deliberately NOT a column. It cannot be computed honestly without
36e's counter, and a rank that is really "everyone is number one" is worse than
no rank. See the note under 35e.

### 36b. Columns to add to `TireWaitlistVehicles`

The car is where v5 asks the most, and where a bid is actually built.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `StartingPoint` | Var Char | 14 | | | | `none`, `tires`, `tireswheels`, `allweather`. What is in the driveway today, and it gates everything after it: a household that already owns winter tires on wheels needs fitting, not tires |
| `TireLifeLeft` | Var Char | 10 | | | | `good`, `marginal`, `done`. Only asked when they already own winter tires, and it decides whether tires are on the order at all |
| `VehicleTrim` | Var Char | 80 | | | | the fitment label they picked, e.g. "Sport and EX, 17 inch". Two trims of one model take different sizes, so this is what makes the size auditable |
| `WinterSizeChosen` | Var Char | 20 | | | | the size they chose to BUY, which is not always the factory size: the tool offers a narrower or downsized winter option |
| `SizeDownsized` | Var Char | 5 | | | | `true` when the chosen size is not the factory one. A flag rather than a derivation, because the installer needs to know at a glance |
| `SizeAck` | Var Char | 5 | | | | **Keep this one.** `true` when they ticked that the suggested size is a suggestion, to be confirmed against their own car before anything is ordered. It is the record that the disclaimer was shown and accepted, and the only field here with a liability consequence |
| `Staggered` | Var Char | 5 | | | | `true` when front and rear differ. Staggered cars are sized by hand, never from the table |
| `TpmsPresent` | Var Char | 6 | | | | `yes`, `no`, `light`, `idk`. From the wheels tool. Decides whether four sensors are on the order |
| `RimsRecommendation` | Var Char | 6 | | | | `one`, `two`, `close`. What the arithmetic told them, which is not the same as what they will buy |

`SizeNormalized` from 35b keeps its meaning: the parsed factory size. It is now
the pair to `WinterSizeChosen`, not a duplicate of it.

### 36c. Columns to add to `TireWaitlistDetails`

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `BrandLine` | Var Char | 60 | | | | the specific model within the brand, e.g. `Blizzak WS90`. Filtered to what is sold in Canada this season and to winter or all-weather, so it is a real orderable line |
| `TravelRadius` | Var Char | 6 | | | | `5`, `15`, `30`, `any` km. This is what decides which installers may bid at all |
| `InstallerName` | Var Char | 120 | | | | only when they chose "a shop I already use". We invite that shop into the auction |
| `InstallerAddress` | Var Char | 200 | | | ✅ | as above. PII because a named shop plus a household postal code narrows to a person |
| `InstallerPostal` | Var Char | 7 | | | | |
| `InsuranceHelp` | Var Char | 5 | | | | `true` when they asked for what they need to claim the discount. It is a follow-up to send, not a preference |
| `InsurerProvince` | Var Char | 6 | | | | `ON`, `QC`, `BC`, `AB`, `OTHER`. From the insurance tool |
| `PremiumAnnual` | Int | 10 | | | ✅ | their annual auto premium, as typed into the estimator. **PII, and the most sensitive number on the form**: it is a financial fact about a household and it was given for an estimate, not for a file. Store it only if it will be used, and turn the validator on |

`Anchor` from 35c is now unused: v5 asks for a travel radius instead of home or
work. Leave the column, it costs nothing, or drop it. `InstallWindows` is
superseded by 36d and can hold the same value as a flat summary.

### 36d. `TireInstallWindows` (new table)

**The one new table.** v5 asks for up to five appointment windows, each a date
and a time of day, and keeps them in the order they were picked, because the
first is the one we chase hardest. That is one to many, and the ranking is the
information: flattening it into a string throws away the only part an installer
bids against.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `WindowKey` | Var Char | 40 | ✅ | ✅ | | `${ReferenceCode}:${Rank}`. The race guard, and what makes a resubmitted form replace rather than duplicate |
| `ReferenceCode` | Var Char | 24 | | ✅ | | |
| `Email` | Var Char | 254 | | ✅ | ✅ | denormalised: the Data Store has no joins |
| `WindowDate` | Var Char | 10 | | ✅ | | `YYYY-MM-DD` |
| `Slot` | Var Char | 10 | | ✅ | | `morning`, `midday`, `afternoon`, `evening`, `any` |
| `Rank` | Int | 10 | | ✅ | | 1 to 5, the order they picked. 1 is the one to chase |
| `SubmittedAt` | DateTime | - | | ✅ | | |

### 36e. `TireToolRuns`, from 35d, is worth more now than it was

Section 35 marked it optional and it still is. What changed is what it would
hold: v5's calculators are not a widget, they produce a dated statement to a
household about money. The insurance estimator in particular tells someone what
their discount is worth against a premium they typed in.

If that estimate is ever disputed, `OutputJson` is the only record of what was
said. Create it when the route is written, not later.

### 36f. Gate checks

```sql
SELECT Wave FROM TireWaitlistSignups LIMIT 1;
SELECT StartingPoint, VehicleTrim, WinterSizeChosen, SizeAck, Staggered FROM TireWaitlistVehicles LIMIT 1;
SELECT BrandLine, TravelRadius, InsurerProvince, PremiumAnnual FROM TireWaitlistDetails LIMIT 1;
SELECT ROWID FROM TireInstallWindows LIMIT 1;
```

Then submit the guided path with three appointment windows picked in a
deliberate order, and confirm three rows come back in that order:

```sql
SELECT WindowKey, WindowDate, Slot, Rank FROM TireInstallWindows LIMIT 10;
```

`Rank` 1, 2, 3 must match the order the dates were clicked, not the order of
the dates themselves. Someone whose first choice is the latest date is telling
you something, and a sort by date would lose it.

Then run the size tool, pick the downsized option rather than the factory one,
and finish the form: `WinterSizeChosen` differs from `SizeNormalized`,
`SizeDownsized` is `true`, and `SizeAck` is `true`. If `SizeAck` is empty the
form let someone past the acknowledgement, which is the one failure here with a
consequence outside the database.

## 37. Bring Whollar to my city: one table

The umbrella home page ends its city row with a dashed card, "Your city, bring
Whollar here", and a button under it. Both used to link to `/join`, which asks
a household in a place a cohort can form for a name, a mobile and a postal
code. Someone in a place we do not serve has nothing to do there. `POST
/city-request` on the **formSubmit** function records the answer to the only
question worth asking them: where should we open next.

**PascalCase, like every other formSubmit table.** Same warning as section 35:
rule 2 at the top of this document governs the auth tables, and this is not
one. `City`, not `city`. An unknown column throws at runtime, not at deploy.

**Silent-skip contract:** `FSA`, `PoolingFor` and `Marketing` are passed to
`insertTolerant` as optional, so the row still lands on a store that has only
the four mandatory columns. `City`, `Province`, `Email` and `SubmittedAt` are
not optional and the insert fails without them.

**Until this table exists the route returns an error and the modal keeps the
form on screen with what was typed still in it.** It never reports a save that
did not happen.

### 37a. `CityRequests` (new table)

One row per submission, and deliberately not one per person: someone who asks
twice, six months apart, is a stronger signal than someone who asks once, and
collapsing that on write throws the second ask away. Count distinct emails per
city when you want households rather than asks.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `City` | Var Char | 60 | | ✅ | | as typed, whitespace collapsed. Free text on purpose: there is no list of Canadian city names worth shipping in a function, and a stale one drops exactly the small places this question exists to find. Shape-validated and capped, so it cannot carry markup or a URL |
| `Province` | Var Char | 2 | | ✅ | | a closed list of thirteen, because this is the dimension the answers get counted on |
| `Email` | Var Char | 254 | | ✅ | ✅ | lowercased on write, like every other table here |
| `FSA` | Var Char | 3 | | | | first three of the postal code if one was given. The field is optional on the form: a city and a province already answer the question |
| `PoolingFor` | Var Char | 10 | | | | `internet`, `tires` or `both`. Same closed list as `WaitlistSignups.PoolingFor` and for the same reason: it becomes a CRM picklist |
| `Marketing` | Var Char | 5 | | | | `yes` or `no`, whether to write when the city opens. Catalyst offers no boolean type |
| `SubmittedAt` | Date Time | | | ✅ | | |

### 37b. What to run once it exists

```sql
SELECT City, Province, COUNT(ROWID) FROM CityRequests
  GROUP BY City, Province ORDER BY COUNT(ROWID) DESC
```

ZCQL has no `LOWER()`, so two spellings of one city are two rows in that
result. Read the top of the list, not the tail.

---

## 38. The umbrella's show of hands: one table

The home page ends with "Internet was first. Winter tires are next", eight
buttons, and a vote. Until now the vote **saved nothing**: the button flipped
two `hidden` attributes and printed "Thanks, your vote is in." Nothing was sent
and nothing was recorded, so every vote cast since the page went up is gone.
`POST /product-vote` on the **formSubmit** function records them.

**Why not `product_interest` (section 23).** That table is a signed-in member
answering a detailed survey, keyed on `` `${user_id}:${product}` ``.
`whollar.ca` has no login, no session and no `/api/auth` rewrite, so there is
no `user_id` to key on. Reusing it would mean inventing an identity for an
anonymous click, and the two questions are not the same question: one is "how
much do you pay for the mobile plan you have", the other is a show of hands.

**PascalCase, like every other formSubmit table.** Same warning as sections 35
and 37: rule 2 at the top of this document governs the auth tables, and this is
not one. `Product`, not `product`.

**Silent-skip contract:** `OtherText` and `SourcePage` are passed to
`insertTolerant` as one optional group, so rows still land on a store that has
only the four mandatory columns. `VoteKey`, `VoteId`, `Product` and
`SubmittedAt` are not optional.

**Until this table exists the route returns a 500 and the page says the vote
did not save**, keeping the buttons as they were so it can be tried again. It
never thanks anyone for a vote that was dropped, which is the whole reason this
section exists.

### 38a. `ProductVotes` (new table)

**One row per pick, not one per submission.** The only question anyone will ask
this table is how many hands went up for each product, the Data Store has no
joins and caps a read at 300 rows, so the shape that answers it in one query is
`GROUP BY Product`. `VoteId` groups the picks of one submission, so counting
voters instead of picks stays one query as well.

| Column | Type | Length | Unique | Mandatory | PII | Notes |
|---|---|---|:--:|:--:|:--:|---|
| `VoteKey` | Var Char | 64 | ✅ | ✅ | | `` `${VoteId}:${Product}` ``: a flattened composite, the same trick as `campaign_members.membership_key`, because the store has no composite unique. It is what stops a double click counting twice |
| `VoteId` | Var Char | 16 | | ✅ | | server minted, 10 characters of the read-aloud alphabet. Groups the picks of one submission. Never comes from the client |
| `Product` | Var Char | 32 | | ✅ | | one of `home-insurance`, `mobile-plans`, `car-maintenance`, `home-services`, `energy`, `travel`, `pet-care`, `other`. **Values, never labels**: the copy on those buttons will be edited, and storing "Car maintenance" opens a second bucket the day it becomes "Car servicing" |
| `OtherText` | Var Char | 120 | | | | only meaningful when `Product` is `other`. The page has no text box for it yet, so it is null today and the column is here so that adding one is not a schema change |
| `SourcePage` | Var Char | 120 | | | | the path that asked, e.g. `/`. Two pages carry this section |
| `SubmittedAt` | Date Time | | | ✅ | | server clock, never the client's |

No email column, and that is deliberate: the section asks for a hand, not an
address, and a column nobody fills is a column someone later assumes is
populated. When the page grows a "tell me when it opens" box, it gets an
`Email` column and a `Marketing` flag in the same commit, the way
`CityRequests` has them.

### 38b. What to run once it exists

```sql
SELECT Product, COUNT(ROWID) FROM ProductVotes GROUP BY Product
  ORDER BY COUNT(ROWID) DESC
```

That is picks. For people rather than picks:

```sql
SELECT COUNT(DISTINCT VoteId) FROM ProductVotes
```

And to sanity check that anything is arriving at all, which is the check that
would have caught the silence this section fixes:

```sql
SELECT VoteId, Product, SubmittedAt FROM ProductVotes
  ORDER BY SubmittedAt DESC LIMIT 10
```
