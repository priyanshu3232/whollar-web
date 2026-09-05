# Phase 0: notifications, email workflow and calendar

> Audit only. No production code was written. Classifications are
> implemented-correct / implemented-broken / partially-implemented / absent,
> each cited to file and line.
>
> Written 2026-08-30 against `main` at f6044fb.
>
> The brief asked for this in `/mnt/user-data/outputs/`. That path does not
> exist on this machine; repo convention is `docs/`, beside `DELIVERY_AUDIT.md`
> and `MULTI_CAMPAIGN_AUDIT.md`, so it is here.

---

## The short version

Five things matter more than the rest of this document.

1. **There is no event spine and there is no scheduler.** `campaign_events`
   does not exist, `account_events` does not exist, and no Catalyst cron or Job
   Scheduling target is wired to the `auth` function. The stack is built the
   other way round on purpose: stage notices, award sealing and delivery
   sealing all compare **on read**, and say so in their own headers
   (`lib/notices.js:8-19`, `lib/awards.js:34`, `lib/catalog.js:159`,
   `routes/delivery.js:77`). The brief's section 3.1 assumes all three exist.
   That gap is the single largest piece of work in the build and it changes
   the shape of the enqueue path.

2. **CASL is being promised and not delivered, today, in production.** Four
   live surfaces tell people they can unsubscribe at any time, `privacy.html`
   states every message carries an easy way to unsubscribe, and no email
   Whollar sends carries one. There is no suppression list, no unsubscribe
   token, no bounce handling, and `marketing: true` is hardcoded at signup with
   no separate checkbox. This is a live compliance exposure and it outranks the
   calendar work.

3. **A working stage-email layer already exists and is good.** `lib/notices.js`
   plus `campaign_notices` is claim-before-send, idempotent on a unique key,
   seeded so a deploy does not blast anyone, and already covers all seven
   member stages. It should be migrated into the outbox, not replaced by it.

4. **The dashboard lies about preferences.** The four notification toggles are
   unnamed checkboxes wired to a toast that says "Preference saved." No write
   happens. `dashboard.html:5159-5161`.

5. **The calendar work has no data behind it.** "Coming cohorts" with an
   `expected` date, "Notify me", and the client-side ICS generator exist only
   in the v12 prototype and the legacy dashboard. None of it was ported into
   `partner/`, and `expected` was never a column, only a demo fixture field.

---

## 1.1 Existing sending code

| Item | Class | Cite | Migration action |
|---|---|---|---|
| ZeptoMail transport | implemented-correct | `lib/mailer.js:64-92` | Keep. Wrap with outbox, add `client_reference` and `Message-ID`. |
| Endpoint host is configuration, not a constant | implemented-correct | `lib/mailer.js:15-20`, `lib/config.js:208-215` | Keep. |
| **Default endpoint is the US DC** | **implemented-broken** | `lib/config.js:214` fallback `https://api.zeptomail.com` | Change the fallback to `https://api.zeptomail.ca`. Production sets `.ca` explicitly (`docs/MAIL_AUTH_RUNBOOK.md:22`), so this is latent, but an unset env var silently routes Canadian personal data to a US endpoint. That is exactly the residency failure the module's own comment describes. |
| Auth scheme normalisation | implemented-correct | `lib/mailer.js:50-62` | Keep. |
| Mail Agent split (transactional vs commercial) | absent | one `From`, `ZEPTOMAIL_FROM`, currently `info@whollar.com` | H1. Two agents, two subdomains. |
| `client_reference` or any idempotency key | absent | `lib/mailer.js:67-73` payload has neither | Outbox ROWID becomes `client_reference`. |
| Stable `Message-ID` | absent | same | Derive from outbox ROWID. |
| `List-Unsubscribe` / RFC 8058 headers | absent | same | Required for every `cem`. |
| Bounce address configured | absent | no `bounce_address` field anywhere | H1. |
| Webhook receiver | absent | no route matches `hooks` | Build. |
| Reply-To | implemented-correct | `lib/config.js:173`, fallback `info@whollar.com` | Split by audience. |
| SMTP fallback chain | implemented-correct, but masks failure | `lib/mailer.js:168-192` | Keep the chain. The runbook already flags that a ZeptoMail rejection looks like a delivered email from outside (`docs/MAIL_AUTH_RUNBOOK.md:38-44`). The outbox must record which transport actually carried it. |
| `log` transport floor | implemented-correct | `lib/mailer.js:37-47` | Keep. |
| Delivery record | partially-implemented | `auth_events` rows carry `detail.delivered` and `detail.transport`; `/health/mail` aggregates them (`src/app.js:158-200`) | Superseded by `notification_deliveries`. Keep `/health/mail` reading the new table. |
| Retry policy | absent | no backoff, no dead letter | Build. |
| Rate limiting against ZeptoMail account limits | absent | | Build into the drain. |
| Open / click tracking | absent | | Recommendation: leave opens off. See H5 notes. |

### Inline body builders, all of them candidates for the registry

Every template is a local function in one module. There is no ZeptoMail-hosted
template anywhere, which means **H2 is already answered B in practice**.

| Function | Cite | Audience | Class today |
|---|---|---|---|
| `otpEmail` | `lib/mailer.js:284-320` | both | implemented-correct |
| `existingAccountEmail` | `lib/mailer.js:343-384` | both | implemented-correct |
| `passwordResetEmail` | `lib/mailer.js:386-428` | member | implemented-correct |
| `passwordChangedEmail` | `lib/mailer.js:430-471` | both | implemented-correct |
| `noAccountEmail` | `lib/mailer.js:473-509` | both | implemented-correct |
| `providerDecisionEmail` | `lib/mailer.js:512-596` | partner | implemented-correct |
| `cohortStageEmail` + `STAGE_MAIL` | `lib/mailer.js:600-690` | member | implemented-correct, seven stages |
| `renderCard` shared layout | `lib/mailer.js:234-240` | both | partially-implemented: one layout, no audience split, no preheader, no footer block, no unsubscribe, no address |

Shared inline style constants at `lib/mailer.js:222-232`. Logo is a hosted PNG
pinned to `https://www.whollar.ca/images/email/whollar-mark.png`
(`lib/mailer.js:212-214`).

Eight templates, zero of them carry: a preheader, a physical mailing address,
sender legal identification, a preferences link, an unsubscribe link, a
`casl_class`, a locale key, or a `required_context_keys` contract.

### Call sites

| Caller | Cite | Event it stands for |
|---|---|---|
| `routes/otp.js:69,76` | member and partner OTP | `session.magic_link_requested` equivalent |
| `routes/provider.js:60,67` | partner OTP | same |
| `routes/provider.js:150-152` | partner signup collision | `account.created` collision notice |
| `routes/password.js:58,65` | signup OTP | `account.created` |
| `routes/password.js:152-154` | signup collision | same |
| `routes/reset.js:85,99,186` | reset, no-account, changed | `account.*` and `security` |
| `routes/admin.js:212,220` | admin OTP | `security` |
| `routes/admin.js:1373` via `notifyOrgUsers` | `routes/admin.js:1364-1385` | `partner.onboarding.*` approve / reject |
| `lib/notices.js:129,140` | cohort stage letters | `campaign.stage_changed`, all seven |

Nine call sites. Every one of them sends directly, inside the request. None is
replayable, deduplicated, or recorded beyond an audit row.

### Placeholder wire-up points

The brief expected a set of `console.log('[whollar-... placeholder]')` triggers.
There are four, and they are all in one file that **is not deployed**:

| Line | Would-be event | Live? |
|---|---|---|
| `overpaying.html:823` | `checkup.inputs` | no, `.vercelignore:42` |
| `overpaying.html:824` | `checkup.completed` | no |
| `overpaying.html:1015` | `cohort.join.handoff` | no |
| `overpaying.html:1054` | `checkup.deep_read.received` | no |

The live pages are past that. What they do instead is worse for this brief:
they post real data to `formSubmit` and **nothing sends an acknowledgement**.

| Live surface | Posts to | Acknowledgement email | Class |
|---|---|---|---|
| `bill-checkup.html` checkup | `/checkup` | none | absent |
| `bill-checkup.html:1309` deep read | `/deep-read` | none | absent |
| `waitlist/index.html` | `/waitlist` | none | absent |
| `contact.html` | `/contact` | none | absent |
| Cohort join | `/campaigns/join`, `/cohorts/:id/join` | none | absent |
| Offer accept and booking | `routes/campaigns.js:664` | none | absent |
| Seat pass | `routes/seat.js:449` | none | absent |
| Install slot booked | `routes/delivery.js:291` | none | absent |
| Install activated | `routes/delivery.js:323` | none | absent |
| Install exception | `routes/delivery.js:360` | none | absent |
| Household released | `routes/delivery.js:396` | none | absent |
| Statement generated | `routes/billing.js:129-185` | none | absent |
| Line dispute raised | `routes/billing.js:186` | none | absent |
| Bid sealed | `routes/desk.js` | none | absent |
| Tier awarded | `lib/awards.js` sealing | none | absent |

`catalyst-backend/functions/formSubmit/index.js` sends no email of any kind.
Grep confirms: no mailer import, no transport, 983 lines.

**So the honest count is: 9 event types have an email, roughly 60 in the brief's
catalogue do not, and 15 of the missing ones already have a working server
route that would be the natural trigger.**

---

## 1.2 Existing calendar code

| Item | Class | Cite |
|---|---|---|
| Client-side ICS generator, v12 prototype | implemented-correct as a prototype, **not ported** | `docs/prototype/provider-console-v12.html:1061-1075` |
| Same generator, legacy dashboard | implemented-correct, **legacy file** | `provider-dashboard.legacy.html:1041-1078` |
| UID scheme | `'UID:'+cid+'-'+i+'@whollar'` | `docs/prototype/provider-console-v12.html:1072`, `provider-dashboard.legacy.html:1063` |
| PRODID | `-//Whollar//Partner console//EN` | same lines |
| DTSTAMP / DTSTART helper | `icsStamp`, UTC, no VTIMEZONE | `provider-dashboard.legacy.html:1041` |
| SEQUENCE, STATUS, LAST-MODIFIED, VALARM | absent | not emitted at all |
| Google Calendar deep link | implemented-correct | `provider-dashboard.legacy.html:1078` |
| Subscribable feed | absent | the toast promising one is prototype copy |
| **Any calendar code in the shipped `partner/` console** | **absent** | grep over `partner/app.js`, `partner/views/*`, `partner/core/*` finds only the word "calendar" as a heading in `partner/views/overview.js:287-290`, which renders an HTML list, not ICS |
| Server-side ICS | absent | no route |
| `campaignCalendar` API | declared as a stub | `partner/core/api.js:264` `api.campaignCalendar = todo('GET /provider/campaigns/:id/calendar')` |

**Migration note on UIDs.** The prototype UID is `<campaign-id>-<index>@whollar`,
positional and unstable: inserting a milestone renumbers every event after it.
It also uses the bare `@whollar` domain, not `@whollar.com`. The real feed
cannot update anything already imported from the prototype, because the index
is not recoverable from a milestone name. Anyone who used the prototype gets
duplicates. Accept that, document it, and move to
`campaign:<campaign_id>:<milestone>@whollar.com`. The blast radius is small:
the prototype is `docs/prototype/`, not deployed, and the legacy dashboard is
`.vercelignore`d.

### Member dashboard "Notify me" and "Add to calendar"

| Affordance | Cite | What it does today | Class |
|---|---|---|---|
| Region bell, `[data-bell]` on a cohort card | `dashboard.html:5095-5120` | Real `POST /campaigns/notify`, writes an `alert` standing on `campaign_members`. Idempotent server-side, never downgrades a join (`routes/campaigns.js:1033`). Then toasts **"We'll text you the day X opens."** | implemented-correct write, **broken promise** |
| Product bells, Mobile cohorts / Streaming tracking | `dashboard.html:2051,2057`, handler `5108-5119` | Logs a `user_events` interest row. Toasts "We'll text you when X is ready." | implemented-correct write, broken promise |
| "Notify me when I can move" | `dashboard.html:8963-8967` | `sTrack('seat_move_notify')`, an interest event. Toasts "We'll text you when your seat can move again." | partially-implemented, broken promise |
| "Add to calendar" on a member cohort | absent | no such control on `dashboard.html` | absent |

There is no `calendar_subscriptions` equivalent. `campaign_members.status =
'alert'` is the only stored form of "notify me", and it is per campaign only:
no reminder offsets, no subject types beyond a campaign.

---

## 1.3 Event spine and state

### The spine

**Absent.** `campaign_events` does not exist. `account_events` does not exist.
Grep over `catalyst-backend/` for both names returns nothing, and neither is
declared in `lib/schema.js` (34 tables, listed at `lib/schema.js:33-570`).

What exists instead, five append-only ledgers, none of them a domain spine:

| Table | Cite | What it records | Usable as a spine? |
|---|---|---|---|
| `auth_events` | `create-tables.md:210`, `lib/audit.js` | auth outcomes, including `detail.delivered` for mail | No. Auth only, and it is the debugging tool. |
| `user_events` | `create-tables.md:392` | ratings, feedback, outage, interest, provider-notify | No. Five closed kinds, member-written. |
| `claim_event` | `create-tables.md:1459` | seat claim actions, `event_key` unique | Partially. Seat lifecycle only. |
| `share_event` | `create-tables.md:1373` | referral share actions | No. |
| `bid_revisions` | `create-tables.md:756` | sealed bid versions | No. |
| `campaign_notices` | `create-tables.md:1642` | which stage letters have been sent | Not a spine, a sent-ledger. |

**Consequence for the build.** The brief's `domain write -> spine row -> Signal
-> rules engine -> outbox` chain has no first two links. Building them means
either (a) creating the spine and adding a write to every route that changes
state, which touches `campaigns.js`, `seat.js`, `delivery.js`, `billing.js`,
`desk.js`, `admin.js` and `member.js`, or (b) keeping the read-time comparison
this codebase already uses and enqueueing from it.

### Transitions that write nothing an email could hang on

Every one of these is a gap. None writes an event row.

| Transition | Where it happens | Writes an event? |
|---|---|---|
| Campaign stage change | a hand-written date in the `campaigns` row, or `POST /admin/campaigns/:id/transition` which changes `kind` alone | No. This is the reason `lib/notices.js` exists at all (`lib/notices.js:5-19`). |
| Cohort seat claimed | `routes/seat.js:191` | `claim_event` yes, no domain event |
| Cohort seat released or passed | `routes/seat.js:280,449` | `claim_event` yes |
| Offer accepted, order booked | `routes/campaigns.js:664` | No |
| Bid sealed or improved | `routes/desk.js` | `bid_revisions` yes, no domain event |
| Tier awarded | `lib/awards.js` sealing on read | No |
| Install slot booked or rebooked | `routes/delivery.js:291` | No |
| Install activated | `routes/delivery.js:323` | No |
| Install exception, noshow / access / linefail | `routes/delivery.js:360` | No |
| Household released | `routes/delivery.js:396` | No |
| Statement generated | `routes/billing.js:129` on read | No |
| Line disputed | `routes/billing.js:186` | No |
| Billing method saved | `routes/billing.js:238` | No |
| Partner approved or rejected | `routes/admin.js:1386+` | `auth_events` yes |
| Account created, verified, password changed | `routes/password.js`, `routes/reset.js` | `auth_events` yes |
| Account deleted | `routes/me.js:521` | `auth_events` yes |

### The state machines, reconciled

The brief says "seven state machines" and asks for one canonical enum. There
are **four** that matter to notifications, and three of them are already
reconciled in code and derived from the same seven date columns.

**1. Campaign lifecycle, stored.** `campaigns.kind`, six values.
`lib/catalog.js:65`:
`planned | waitlist | forming | auction | closed | archived`
Legal moves at `lib/catalog.js:77-86`, including two operational reversals.

**2. Partner stage, derived, six values.** `lib/catalog.js:174`:
`planned | announced | open | closing | offers_out | decided`
Derived by `stageOf()` at `lib/catalog.js:179-215`. Labels at
`lib/catalog.js:217-220`.

> The brief says "the partner plan view has seven milestones". It has **six**
> stages and seven **dates**. Do not conflate them.

**3. Member stage, derived, seven values.** `lib/catalog.js:236`:
`forming | locked | bidding | offers | confirm | switching | done`
Derived by `memberStageOf()` at `lib/catalog.js:256-290`, gated by
`MEMBER_GATES` at `lib/catalog.js:246-253`. Labels at `lib/catalog.js:241`.
**This is the canonical member enum and `STAGE_MAIL` already covers all seven**
(`lib/mailer.js:600-650`).

**4. Order / install state, stored, seven values.** `lib/orders.js:41`:
`acc | bkd | act | rel | noshow | access | linefail`
Transitions at `lib/orders.js:69-80`. `act` and `rel` are terminal.
Release reasons at `lib/orders.js:45-50`.

**5. Member standing, derived.** `standingOf()` at `lib/catalog.js:317-320`:
`joined | waitlist | alert | null`.

**Mismatches found.**

- Partner has 6 stages, member has 7, `kind` has 6. All three are correct and
  all three are already computed server-side and reconciled through
  `lib/cohorts.js:285-288`, which returns both stages on one object. There is
  no drift to fix. The brief's reconciliation work is **already done**; the
  notification layer should consume `lib/cohorts.js` state objects, exactly as
  `lib/notices.js:160-186` already does.
- The brief's `bidding_closed` stage does not exist in either enum. Partner
  `offers_out` is the nearest, member `offers` is the nearest.
- The brief's `campaign.cancelled` has no representation. `kind = 'archived'`
  is the nearest and it means something else.

### Campaign timestamps

Present, all seven, all optional, all `DateTime`.
`create-tables.md:449-461`, projected at `lib/catalog.js:35-37`,
ordered at `lib/catalog.js:63-64`.

| Brief name | Actual column | Class |
|---|---|---|
| `t_announce` | `announce_at` | implemented-correct |
| `t_open` | `bidding_opens_at` | implemented-correct |
| `t_close` | `bidding_closes_at` | implemented-correct, **the only one with teeth**: `requireBiddingOpen()` refuses a bid past it |
| `t_offers` | `offers_at` | implemented-correct |
| `t_decide` | `decision_at` | implemented-correct |
| `t_switch_start` | `switch_window_at` | implemented-correct |
| `t_switch_end` | absent | there is one switch date, not a window pair |
| `t_reconcile` | `reconcile_at` | implemented-correct |
| `expected_open` | **absent** | never a column. `expected` is a demo fixture field in the prototype only (`docs/prototype/provider-console-v12.html:864-865`) |
| `expected_open_prev` | absent | |

**UTC or dates?** They are `DateTime` columns read through
`datastore.fromDb()` into epoch milliseconds (`lib/datastore.js:55`) and
written through `datastore.toDb()`. Timestamps, not dates. Calendar
correctness is fine on that axis.

**Do not rename them.** Seven columns, hand-created, read by
`lib/catalog.js`, `lib/cohorts.js`, `lib/notices.js`, the admin console and
both dashboards. Renaming to the brief's `t_*` names buys nothing and risks
exactly the failure `docs/console` and the column-ladder rule warn about.

---

## 1.4 Unscoped-query grep

Every read the notification layer would touch, checked for a `campaign_id`
predicate.

| Read | Cite | Scope | Class |
|---|---|---|---|
| `bids.campaignBidRows` | `lib/bids.js:451-453` | `campaign_id` | implemented-correct, and its header names the three sanctioned readers |
| `bids.bidRows` | `lib/bids.js:435-437` | `org_id` only | **caution, not broken.** Correct for "this partner's own bids across every campaign". Would fan out across campaigns if a per-campaign email used it. Do not call it from a rule. |
| `bids.revisionRows` | `lib/bids.js:461-467` | `bid_key`, which embeds `campaign_id` | implemented-correct |
| `awards.rowsForOrg` | `lib/awards.js:324-326` | `org_id` only | same caution as `bidRows` |
| `awards.findForOrg` | `lib/awards.js:308-321` | `award_key` = `campaign:org` | implemented-correct |
| `orders.rowsForCampaign` | `lib/orders.js:302-305` | `org_id AND campaign_id` | implemented-correct |
| `offers` reads | `lib/offers.js` | `offer_key` = campaign + user | implemented-correct |
| `billing` statement rows | `lib/billing.js:331` | statement key | implemented-correct |
| `notices.announced` | `lib/notices.js:51-53` | `campaign_id` | implemented-correct |
| `notices.recipients` seat claims | `lib/notices.js:89-91` | `cohort_id` | implemented-correct |
| `notices.recipients` memberships | `lib/notices.js:96-98` | `campaign_id` | implemented-correct |
| `cohorts` counting reads | `lib/cohorts.js:115,122` | `campaign_id` / `cohort_id` | implemented-correct |
| `catalog.load` | `lib/catalog.js:374` | `ROWID > 0`, whole catalog | implemented-correct by design: this is the catalog itself, not campaign-scoped data |

**No implemented-broken reads found.** The two `org_id`-only reads are correct
for their callers and become a hazard only if a rule reaches for them. Record
that as a rule-authoring constraint, not a fix.

One genuine hazard worth naming: `lib/bids.js:441-449` explicitly documents
that `campaignBidRows` must never be called from a `/provider` route. A
notification rule resolving partner recipients is close enough to a provider
route that the same discipline applies. The privacy scrubber in the brief's
section 6.4 is the right belt to the code's existing braces.

---

## 1.5 Preferences and consent

| Item | Class | Cite |
|---|---|---|
| `user_prefs` table, JSON blob per account | implemented-correct | `create-tables.md:372-390`, `lib/prefs.js` |
| Writable top-level keys | implemented-correct | `routes/me.js:388-398`: `alerts`, `interests`, `notify`, `services` |
| `GET /me/prefs`, `POST /me/prefs` | implemented-correct | `routes/me.js:372,388` |
| **The four dashboard toggles persist nothing** | **implemented-broken** | `dashboard.html:2190-2193` are unnamed, id-less checkboxes. The only handler is `dashboard.html:5159-5161`: `if(e.target.closest('.tog'))toast('Preference saved.')`. No API call, no state, no read back. Every reload resets them. The layer has a working prefs API and the UI does not use it. |
| Toggle copy promises SMS | implemented-broken | "Text me at every campaign step" (`dashboard.html:2190`) plus the footnote at `:2194`, and nine further "we'll text you" strings at `:4206, 4207, 4980, 5029, 5105, 5106, 7182, 8937, 8965`. Nothing sends SMS. |
| Category model (`campaign_steps`, `promo_cliff`, ...) | absent | `alerts` is an untyped blob |
| Partner-side preference surface | absent | no equivalent card in `partner/views/account.js` |
| Versioned consent records | implemented-correct | `lib/consents.js`, `consents` table `create-tables.md:167` |
| Consent is append-only, withdrawal is a new row | implemented-correct | `lib/consents.js:12-14` |
| Marketing consent separable in the data model | implemented-correct | `lib/consents.js:64-68`, its own `doc_type` and version |
| **Marketing consent is not separable in the UI** | **implemented-broken** | `whollar-login-consumer.html:330` is one checkbox covering terms, privacy and marketing. Worse, `marketing: true` is **hardcoded at three call sites**: `whollar-login-consumer.html:781,793,836`. Nobody can decline it, and a consent record that could not have been declined is not consent. The file's own comment at :325-327 admits the bundling. |
| `consent_source`, `consent_at`, `consent_ip` | partially-implemented | `accepted_at` and a **hashed** IP are recorded (`lib/consents.js:73-74`, `lib/crypto.js hashIp`). No `consent_source`, no `consent_evidence` (the exact checkbox text and form version). |
| Consent captured at checkup / waitlist / product interest | partially-implemented | `W.consentPayload('checkup',true)` is sent (`bill-checkup.html:1309`) but lands in `formSubmit`, which does not write `consents` |
| Suppression list | **absent** | grep finds no table, no code |
| Unsubscribe token | **absent** | |
| Unsubscribe route or landing page | **absent** | |
| Bounce handling | **absent** | |
| Complaint handling | **absent** | |

### The live exposure, stated plainly

These four surfaces tell a person they can unsubscribe at any time:

- `whollar-login-consumer.html:330`
- `bill-checkup.html:525`
- `waitlist/index.html:125` and `MobileVersion/join-the-first-cohort-mobile.html:711`
- `MobileVersion/bill-checkup-mobile.html:528`

And `privacy.html:309` says: "every message includes an easy way to
unsubscribe". `privacy.html:403` repeats it.

No email Whollar sends contains an unsubscribe link, a preferences link, a
physical mailing address, or sender legal identification. There is no
suppression list, so a withdrawal could not be honoured even if someone asked.

That is the highest-priority item in this brief. It is not the calendar.

---

## 1.6 Identity and contact data

| Field | Where | Class |
|---|---|---|
| Member email | `users.email_normalized` unique, `users.email_display` | implemented-correct, `create-tables.md:68-69` |
| Member mobile | `users.phone`, Var Char 32 | partially-implemented. Present, described in the runbook as "for the 'bids landed' text", **never verified and never used**. `create-tables.md:78` |
| Member first / last name | `users.first_name`, `users.last_name` | implemented-correct. Signup only. |
| `display_name` | absent | greeting falls back to "Hi," (`lib/mailer.js:249-252`), which is the right behaviour |
| Member locale | **absent** | no column, no code path |
| Member timezone | **absent** | every date is formatted `America/Toronto` unconditionally (`lib/mailer.js:264`) |
| `email_verified_at` | **absent** | verification is implicit: an OTP round trip proves the address at signup, but no column records it, so no query can find an unverified address |
| Member region / FSA | `users.fsa`, `users.postal_code`, `users.province_code` | implemented-correct, `create-tables.md:75-77` |
| Partner org | `provider_orgs` | implemented-correct, `create-tables.md:185` |
| Partner contacts | partially-implemented | `provider_users` maps user to org with `role` in `admin | bidder | viewer` (`create-tables.md:196-203`). Contact email comes from the linked `users` row. `user_id` deliberately not unique. |
| Role routing for bids / delivery / billing | **absent** | the three existing roles are permission roles, not routing roles. Today `notifyOrgUsers` mails **every active person in the org** regardless of role (`routes/admin.js:1364-1385`). |
| Partner coverage | `provider_coverage`, keyed `org_id:region-slug` | implemented-correct, `create-tables.md:511` |
| Email verification mechanism | partially-implemented | OTP proves the address at signup; nothing re-verifies, nothing records it, no re-verification on change |
| Admin address | implemented-correct, in config | `ADMIN_EMAILS` and `ADMIN_EMAIL_DOMAIN`, `lib/config.js:239-240`. Not hardcoded. H12 is already satisfied. |

---

## 1.7 Platform and CI facts the build depends on

| Item | Class | Cite |
|---|---|---|
| Catalyst environments configured | **Development only** | `.catalystrc` lists one env, `110003037934 Development`. Production exists (the runbook reads `/api/auth/health` on it) but is not in this rc file. |
| Project timezone | `America/Vancouver` | `.catalystrc`. Mail formats in `America/Toronto`. Not a bug, but a scheduler that inherits the project timezone will be three hours off the brief's "daily 09:00 America/Toronto". |
| Function types | all four `advancedio` | `functions/*/catalyst-config.json` |
| Job Scheduling wired to anything | **absent** | `crmSync` is written to be cron-invoked (`functions/crmSync/index.js:16-17`) and memory plus `docs/CRM_SYNC_RUNBOOK.md` record that **no cron job was ever created**. So the pattern is proven in code and unproven in the console. |
| Signals | absent | no import, no usage |
| Stratus | absent | no import, no usage |
| File Store | in use for partner documents | `create-tables.md:1057`, folder id recorded. The brief says File Store is deprecated; the docs folder is live and this build should not touch it. |
| ZCQL write discipline, ROWID-keyed | implemented-correct throughout | `lib/datastore.js:187` `updateRow` is ROWID-keyed by construction |
| `queryAll` pagination | implemented-correct | `lib/datastore.js:144`, 300-row pages, 50-page cap |
| Column ladder pattern | implemented-correct, and load-bearing | `lib/catalog.js:40-58` documents the exact production failure a missing ladder caused on 2026-08-29 |
| Em dash gate | partially-implemented, **scoped to a hardcoded list** | `scripts/check-terms.mjs:26-34` (7 files), `scripts/check-console-copy.mjs:23` (console only). `lib/mailer.js` is in **neither list**. Every new template file must be registered or it is unchecked. |
| Banned vocabulary gate | same | `scripts/check-terms.mjs:36-42`: em or en dash, customer, lead, ISP, group buy. Member-facing files additionally may not say "auction". |
| Notices unit tests | implemented-correct | `scripts/test-notices.mjs`, wired at `.github/workflows/check-frontend.yml:163` |
| `partner/` build step | implemented-correct | any partner-side calendar UI goes through `scripts/build-console.mjs` and both outputs get committed |

### Law 25 and PIPEDA gaps in the existing delete path

`routes/me.js:521-573` purges `credentials`, `auth_identities`, `member_bills`,
`campaign_members`, `user_events`, `user_prefs`, then scrubs the `users` row
and sets `email_normalized` to `deleted:<user_id>`.

It does **not** purge: `seat_claim`, `claim_event`, `household_offers`,
`provider_orders`, `consents`, `referral_token`, `invite_click`,
`share_event`. Some of those are deliberate (consent records are the evidence),
some are gaps.

Concretely for this brief: a deleted member's `seat_claim` row survives, so
`notices.recipients()` still returns their user id
(`lib/notices.js:88-93`), `users.findById` returns the scrubbed row, and
`mailer.send` is handed `deleted:<uuid>` as a recipient address. That is a
guaranteed ZeptoMail 4xx per deleted member per stage, and with no suppression
list nothing stops it repeating. The brief's section 9.5 suppression-on-delete
is the right fix and it is needed regardless of the rest.

---

## Where the brief collides with this codebase

Seven structural notes, per the working-style rule. These are opinions, not
blockers.

**1. The Signals plus spine architecture is a bigger build than the brief
implies, and this stack deliberately went the other way.**
Three separate modules (`notices`, `awards`, delivery sealing) each open with a
paragraph explaining that there is no cron and that comparison therefore
happens on read. That is a coherent design and it works. Grafting Signals onto
it means writing a spine row from every state-changing route first. My
recommendation: build the **outbox and the drain**, which is the part that
delivers replayability, deduplication, suppression and ordering, and let the
**enqueue trigger stay read-time sweep initially**, exactly as `notices.js`
does now. Add Job Scheduling as a second trigger for the events no read path
covers (reminders, promo cliff, statement due). Treat the spine as phase 2, and
do not make Signals a dependency of shipping anything.

**2. Ten new tables is a very large hand-created console session, and the
column-ladder failure mode is real and recent.**
Every table here is created by hand and CLAUDE.md plus `lib/catalog.js:40-58`
record that one missing column emptied every cohort surface at once on
2026-08-29. Ten tables plus three alters in one pass is how that happens again.
Recommend three phases: **A**, `notification_outbox`, `notification_deliveries`,
`email_suppressions`, `unsubscribe_tokens` (four tables, closes the live CASL
exposure); **B**, `calendar_feeds`, `calendar_events`, `calendar_subscriptions`
(three); **C**, preferences and the spine.

**3. `notification_templates` as a Data Store table contradicts H2's own
reasoning, and I would drop it.**
The brief argues for local rendering so that version control, the em-dash
linter, the privacy scrubber and plain-text generation all run before the body
leaves the platform. All four of those are properties of **code in the repo**.
Putting the body in a hand-created table puts it back outside CI, outside code
review and outside the gates. Recommend: templates are modules under
`lib/notify/templates/`, registered in a manifest, with `casl_class`,
`priority`, `locale`, `required_context_keys` and `ics_policy` as exported
metadata. Same for `notification_rules`. That removes two tables and puts the
copy where `scripts/check-terms.mjs` can see it.

**4. The existing stage layer should be migrated, not replaced.**
`lib/notices.js` plus `campaign_notices` already solves claim-before-send,
seeding, batching at 120 and per-address failure isolation. Its `notice_key`
unique constraint is the same mechanism as the brief's `idempotency_key`.
Migrate it into the outbox by making the sweep an **enqueuer** instead of a
sender, keep `campaign_notices` as the per-campaign-per-stage claim, and reuse
`STAGE_MAIL` as seven registry entries.

**5. H10 has nothing behind it.**
`expected_open` was never a column and "Coming cohorts" was never ported into
`partner/`. There is no expected date to drift. Either add the column and the
surface, which is a feature, not a notification, or drop H10 from scope. I
recommend dropping it and revisiting when Coming cohorts ships.

**6. Nine places in the member dashboard promise a text, and nothing sends
one.**
This is not a copy nit. `dashboard.html:2190` sells a toggle, and nine separate
strings toast or render "we'll text you": lines 4206, 4207, 4980, 5029, 5105,
5106, 7182, 8937, 8965. A member who relies on that misses their offer window.
The copy fix is small and should ship in this build regardless of what H3
decides.

**7. The privacy scrubber should be built as a test, not only a runtime guard.**
The brief wants a denylist derived from the campaign's actual data. That is
right at runtime. It is also the natural shape of a CI test: render every
template against a two-partner, two-household fixture and assert absence. This
repo already has that habit (`scripts/test-notices.mjs`,
`scripts/test-multicampaign.mjs`). Do both.

---

## Hard-stop decisions

Answers needed before any production code. Recommendation first in each case.

### H1 · ZeptoMail data centre and sender identity

**Already answered by the repo, in part.** Production reports
`mail_endpoint: https://api.zeptomail.ca`, the Canadian DC, sender
`info@whollar.com` (`docs/MAIL_AUTH_RUNBOOK.md:19-24`). Residency is correct
today.

Two things are not.

- The code default is the **US** host (`lib/config.js:214`). Unset the env var
  and Canadian personal data routes to `api.zeptomail.com`. Recommend changing
  the fallback to `.ca`. This is a one-line change and I would make it in the
  first commit of the build.
- SPF, DKIM and DMARC are **still absent on both domains** as of the last probe
  (`docs/MAIL_AUTH_RUNBOOK.md:28-33`), and the SMTP fallback masks ZeptoMail
  failures so the outside view looks healthy. The runbook has the stepwise fix.

**Decisions needed.**

1. Confirm production `ZEPTOMAIL_API_BASE` is `.ca` and that the same is true
   in the Development environment.
2. Sending domains. Recommendation: `mail.whollar.com` for transactional,
   `news.whollar.com` for cem, each its own Mail Agent, so a complaint on a
   region-opening announcement cannot damage sign-in code deliverability.
   Note the standing decision that mixed `info@whollar.com` and
   `partners@whollar.ca` is deliberate: this adds subdomains, it does not
   change that.
3. A monitored bounce mailbox. Recommendation: `bounces@mail.whollar.com`,
   and it must be a real mailbox, not an alias to `info@`.
4. Whether phases 1 to 5 of `MAIL_AUTH_RUNBOOK.md` run **before** this build
   ships anything, or in parallel. Recommendation: before. Adding sixty new
   message types to an unauthenticated sending domain is how a domain gets
   filtered.

### H2 · Where templates render

**Recommendation: B, render locally, and go further than the brief.**

B is already the built state: eight templates are code in `lib/mailer.js`,
zero are hosted in ZeptoMail. Use ZeptoMail as a delivery API only.

The extension: **do not move template bodies into a Data Store table either.**
See structural note 3. Templates as code modules, metadata as exported
constants, `notification_templates` dropped from the schema. If a subject line
must be tunable without a deploy, `site_config` already exists for exactly that
(`lib/siteconfig.js`) and is the right lever.

Decision needed: accept dropping `notification_templates` and
`notification_rules` as tables, or keep them.

### H3 · SMS scope

**Recommendation: (c), channel-agnostic architecture, no SMS adapter now, and
fix the copy in this build.**

Reasoning: `users.phone` exists but is never verified and never used. Verified
mobile is a prerequisite for SMS and it is not a small piece of work. But the
member dashboard already promises a text in eleven places, so the copy is wrong
today and stays wrong under (a) or (c) unless it is changed.

Concrete copy changes needed, all in `dashboard.html`:

| Line | Today |
|---|---|
| 2190 | toggle label "Text me at every campaign step" |
| 2194 | footnote "The texts are how you'll know to look" |
| 4206, 4207 | "We'll text you when it does" / "the day bidding opens" |
| 4980 | "We'll text you the day it opens" |
| 5029 | "You're on the X list. We'll text you the day it opens." |
| 5105, 5106 | region bell and product bell toasts |
| 7182 | join confirmation toast |
| 8937 | seat address-frees-up toast |
| 8965 | seat can-move-again toast |

Every one becomes "email". `dashboard.html` is in the `scripts/check-terms.mjs`
file list, so the change is gated.

Decision needed: confirm (c), and confirm the copy changes ship in this build.

### H4 · Language

**Recommendation: bilingual-ready registry, English copy now, and check the
beachhead.**

I can answer the Quebec question from the repo. The launch footprint is the
GTA six (`lib/catalog.js:103-110`): Scarborough Southwest, North York Central,
Etobicoke Centre, Mississauga City Centre, Brampton East, Vaughan Woodbridge.
The coverage vocabulary in `lib/places.js` is Ontario. **No Quebec FSA is in
the beachhead list**, so French is not blocking today.

So: `locale` on every template and every recipient, fallback `en`, French copy
written before any Quebec region opens, and the gallery shows empty `fr` slots
rather than silently presenting English as French.

Note this needs a `users.locale` column, which does not exist.

Decision needed: confirm English now, and confirm that opening a Quebec region
is gated on French copy existing.

### H5 · CASL classification per message type

**Recommendation** for the grey areas, with reasoning:

| Message | Proposed class | Why |
|---|---|---|
| Promo cliff reminders | **transactional** | The member gave us their promo end date so we would tell them about it. It is the service they asked for, it names no product and makes no offer. Keep it that way in the copy: the moment it says "and here is a cohort you could join", it is a cem. |
| New region openings | **cem** | It is promotion of a service to someone not currently in it. Needs consent and unsubscribe. |
| Product interest follow-ups: mobile, streaming, tires | **acknowledgement is transactional, launch is cem** | The ack answers a request. The launch email promotes a new service. |
| Referral nudges | **cem** | Encouraging someone to recruit is promotional. The referral **result** ("someone joined with your link") is transactional. |
| "Your cohort needs N more households" | **transactional** | Status of a cohort they are already in. |
| Cohort milestone at 25 / 50 / 75 / 90 percent | **transactional**, with a caution | Status of their own cohort. If it acquires a "share your link" call to action it becomes a cem. Recommend keeping it status-only. |
| Outage updates | **transactional** | Service information about an area they told us about. |
| Tire swap events | **cem** | |

Two additional recommendations.

- **Every message carries sender identification, the legal entity name, the
  physical mailing address and a preferences link, transactional included.**
  CASL only exempts transactional from the unsubscribe requirement, not from
  identification. None of the eight current templates carries any of it.
- **Disable open tracking for member email.** Under Law 25 a tracking pixel
  needs a stated purpose, opens are unreliable behind privacy proxies, and no
  logic in this brief depends on them. Keep click tracking on Whollar-domain
  links only.

Decisions needed: confirm the eight classifications above, confirm the
identification footer on transactional, confirm opens off.

### H6 · Digest and burst policy

**Recommendation: 10-minute per-recipient collapse window, `informational` and
`reminder` only.** Never collapse `action_required` or `security`.

One codebase-specific caution. `lib/notices.js` sweeps on read, so a campaign
whose dates were written by hand can cross two stages between one dashboard
load and the next, and both letters enqueue in the same second. That is
precisely the burst the collapse window is for, and it argues for the window
existing on day one rather than later.

Decisions needed: confirm 10 minutes; confirm which classes collapse; confirm
that a digest never merges two campaigns into one email unless the template has
a per-campaign section.

### H7 · Quiet hours

**Recommendation: 22:00 to 07:00 recipient local, `informational` and
`reminder` only. Partners are exempt.**

Two blockers to flag.

- **There is no recipient timezone.** No `users.timezone` column. Until one
  exists, quiet hours are `America/Toronto` for everyone, which is correct for
  the GTA beachhead and wrong the day a BC household joins. Recommend adding
  the column with default `America/Toronto`.
- **The Catalyst project timezone is `America/Vancouver`** (`.catalystrc`). Any
  scheduled job must set its zone explicitly rather than inherit.

Decisions needed: confirm the window; confirm partners are exempt; confirm
adding `users.timezone`.

### H8 · Calendar surface set

**Recommendation: all three, in this order, and phase them.**

The brief's reasoning is right: Google refreshes subscribed feeds on its own
schedule, often 12 to 24 hours, so an attachment covers the gap.

But note the state: the shipped `partner/` console has **no calendar code at
all**, and the member dashboard has no "Add to calendar" affordance anywhere.
This is a build from zero on the surface side, not a port. Recommend:
attachment first (it is server-side only and needs no UI), then per-event and
per-campaign download, then the subscribable feed with its setup page.

Decision needed: confirm all three, and confirm the phasing.

### H9 · Reminder cadence

**Recommendation as briefed**, with one change.

- Member Notify-me on a coming cohort: T-7d, T-1d, plus day-of. VALARM T-1d and
  T-1h. **Blocked**: coming cohorts do not exist in the shipped console and
  there is no expected date. See H10.
- Member offer decision: T-72h and T-24h before `decision_at`, only if no
  decision is recorded.
- Member install slot: T-24h, VALARM T-1d and T-2h.
- Partner bid close: T-24h and T-2h before `bidding_closes_at`.

The change: **the partner T-2h reminder should send whether or not a bid is
sealed.** Bids are revisable until close (`bid_revisions`, and the console sells
"can improve until"), so "you have two hours left to improve" is useful to a
partner who has already bid. It is also the one reminder that cannot be read as
pressure, because it names no other partner and no other bid.

Decision needed: confirm the cadence and confirm the partner nudge-anyway.

### H10 · Expected-date drift

**Recommendation: drop it from scope.**

There is no `expected_open` column, there never was one, and "Coming cohorts"
exists only in the unported prototype. There is nothing to drift. Revisit when
Coming cohorts ships in `partner/`.

If you want it anyway, the threshold recommendation stands: silent SEQUENCE
bump under 7 days, email over.

Decision needed: drop, or add the column and the surface as part of this build.

### H11 · Partner recipient model

**Recommendation: extend `provider_users`, do not create a new table.**

`provider_users` already exists with `role` in `admin | bidder | viewer`
(`create-tables.md:196-203`) and `user_id` deliberately left non-unique so one
person can serve two orgs. Contact email comes from the linked `users` row,
which means one identity, one verified address, one suppression entry.

A separate `partner_contacts` table with its own emails would create a second
address book that is not an account, cannot sign in, cannot be suppressed
coherently, and cannot verify its own address.

So: add a `notify_roles` column to `provider_users`, a CSV of
`bids | delivery | billing`, defaulting to all three for existing rows so
nothing goes quiet on deploy. Permission roles stay separate from routing
roles, which is the correct separation anyway: a billing contact should not
gain bid-desk permissions by being told about statements.

Today `notifyOrgUsers` mails every active person in the org
(`routes/admin.js:1364-1385`). That is the current, and acceptable, default.

Decision needed: extend `provider_users`, or create `partner_contacts` as
briefed.

### H12 · Admin self-notification

**Already satisfied in part.** The admin address is config, not hardcoded:
`ADMIN_EMAILS` and `ADMIN_EMAIL_DOMAIN` at `lib/config.js:239-240`.

**Recommendation** on scope: take the brief's section 4.5 list as written, with
these adjustments.

- The `S` alerts on bounce rate over 2 percent and complaint rate over 0.1
  percent need a baseline before they can fire meaningfully. Recommend they log
  from day one and alert once thirty days of volume exist.
- "ZeptoMail webhook silent for over 6h while sends occurred" is a good check
  and it is also the single most likely thing to be broken first, because the
  webhook is a new surface. Recommend it ships with the webhook, not after.
- Add one the brief does not list: **SMTP fallback engaged**. Today a ZeptoMail
  failure silently succeeds over IONOS and the outside view looks healthy
  (`docs/MAIL_AUTH_RUNBOOK.md:38-44`). That should be an `A` alert.

On the admin calendar feed: recommend yes, `admin_all` scope, every milestone of
every campaign. It is the operator's whole job.

Decisions needed: confirm the event list plus the three adjustments; confirm
the admin feed.

---

## What is blocked on what

| Blocked item | Blocked by |
|---|---|
| Any `cem` send at all | H1 sending domains, H5 classifications, suppression and unsubscribe tables |
| Quiet hours per recipient | `users.timezone` column |
| French copy | `users.locale` column, H4 |
| Reminder scheduling | Job Scheduling target created in the console, which has never been done in this project |
| Notify-me reminders for coming cohorts | H10, and Coming cohorts existing in `partner/` |
| Partner role routing | H11, and a `notify_roles` column |
| Verified-address queries | `users.email_verified_at` column |
| Install and statement emails | nothing. The routes exist and are ready to enqueue. |
| Stage emails | nothing. Already live. Migrate into the outbox. |
| Unsubscribe, suppression, bounce handling | nothing but the four phase-A tables. This is the fastest path to closing the live exposure. |

---

## Column and table summary

**New tables recommended for phase A, four:**
`notification_outbox`, `notification_deliveries`, `email_suppressions`,
`unsubscribe_tokens`.

**New tables recommended for phase B, three:**
`calendar_feeds`, `calendar_events`, `calendar_subscriptions`.

**New tables recommended for phase C, two:**
`notification_preferences`, and the spine, whichever single form it takes.

**Dropped from the brief's ten, two:** `notification_templates` and
`notification_rules` become code. See structural note 3.

**Columns to add:**

| Table | Column | Why |
|---|---|---|
| `users` | `locale` | H4 |
| `users` | `timezone` | H7, default `America/Toronto` |
| `users` | `email_verified_at` | H12 alerting, and the brief's "recipient is active" test |
| `provider_users` | `notify_roles` | H11 |
| `campaigns` | `expected_open` | only if H10 is kept |

**Config change, one line:** `lib/config.js:214` fallback to `.ca`.

Every one of these needs a column ladder in its reader, per
`lib/catalog.js:40-58`, and a `create-tables.md` section with gate checks in
the ZCQL tab, per the house pattern.

---

## Decisions, 2026-08-30

All twelve hard stops answered. Recorded here because a decision that lives only
in a chat log is a decision the next session re-litigates.

| # | Decision |
|---|---|
| H1 | Two subdomains, two Mail Agents: `mail.whollar.com` transactional, `news.whollar.com` cem. `bounces@mail.whollar.com` a real monitored mailbox. **Phases 1 to 5 of `docs/MAIL_AUTH_RUNBOOK.md` complete before Phase A ships.** Code default corrected to the Canadian host. |
| H2 | **Render locally, and templates and rules are code**, not tables. `notification_templates` and `notification_rules` dropped from the schema. Modules under `lib/notify/`. ZeptoMail is a delivery API only. |
| H3 | **(c)** channel-agnostic architecture, no SMS adapter. All eleven "we'll text you" strings in `dashboard.html` become email in this build. |
| H4 | Bilingual-ready registry, `locale` on every template and recipient, fallback `en`. English copy now. No Quebec FSA in the beachhead, so nothing is blocked. Opening a Quebec region is gated on French copy existing. |
| H5 | Proposed classification table accepted. Transactional: promo cliff, cohort milestone, needs-N-more, outage, referral results, product-interest acknowledgements. CEM: region openings, referral nudges, product-interest launches, tire swap. **Every message carries sender identification, legal entity name and physical address, transactional included.** Open tracking off for member email; clicks on Whollar domains only. |
| H6 | 10 minute per-recipient collapse window. `informational` and `reminder` only. Never `action_required` or `security`. No cross-campaign digest without a per-campaign section in the template. |
| H7 | 22:00 to 07:00 recipient local for `informational` and `reminder`. `users.timezone` added, default `America/Toronto`. Partner contacts exempt. Scheduled jobs set their zone explicitly. |
| H8 | All three surfaces, phased: **attachment first**, then per-event and per-campaign download, then the subscribable feed and its setup page. |
| H9 | As briefed, plus: **the partner T-2h bid-close reminder sends whether or not a bid is sealed**, because bids stay revisable until close. Notify-me reminders deferred with H10. |
| H10 | **Dropped from scope.** No `expected_open` column, no Coming cohorts in `partner/`. Revisit when that surface ships. |
| H11 | **Extend `provider_users`** with a `notify_roles` CSV of `bids | delivery | billing`, defaulting to all three. No `partner_contacts` table. Permission roles stay separate from routing roles. |
| H12 | Section 4.5 as briefed, plus three adjustments: rate alerts log from day one and alert only after thirty days of volume; the webhook-silent check ships with the webhook; and **SMTP fallback engaged becomes an action-required alert**. Admin gets the `admin_all` feed. |

### Phase A, the agreed first ship

Four tables: `notification_outbox`, `notification_deliveries`,
`email_suppressions`, `unsubscribe_tokens`.

Migrate the nine existing send sites and `lib/notices.js` into the outbox.
Close the live CASL exposure: footer identification on every template,
unsubscribe on every cem, suppression list, one-click landing, bounce and
complaint webhook. Quiet hours and the collapse window. The eleven SMS copy
fixes. The `.ca` config default.

No calendar, no new event catalogue, no spine. Those are phase B and C.
