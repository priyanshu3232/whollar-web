# MVP gap audit: what is left, sector by sector

> Written 2026-08-30 against `main` at f6044fb plus the uncommitted notifications
> work in the tree. Every claim is cited to file and line. Nothing here was
> built; this is the punch list, not the fix.
>
> Companions: `MASTER_PLAN.md` (architecture), `PHASE0-NOTIFICATIONS-AUDIT.md`
> (email and calendar), `DELIVERY_AUDIT.md`, `MULTI_CAMPAIGN_AUDIT.md`.

---

## The short version

The marketplace core is built and mostly good. What is missing clusters in
three places, and only one of them is a feature list:

1. **Nothing is scheduled and nothing is in production.** The site's own
   production traffic runs against the Catalyst **Development** environment,
   and no cron job exists anywhere in the stack. Three finished features are
   inert for that one reason.
2. **The admin console is behind its own backend.** Staff cannot see the price
   book, the awards, the orders, the money, or a single member. The half of the
   product that carries revenue has no operator surface.
3. **CRM knows about forms and nothing else.** Five pre-account form sources
   sync. Accounts, seats, offers, acceptances, activations, approved partners,
   cohorts and the three product surveys do not.

Everything else is smaller than these.

---

## 0. Cross-cutting blockers

These gate MVP no matter which sector you work on first.

### 0.1 Production runs on the Development environment

`vercel.json:91-103` and `js/whollar-core.js:40` both point `www.whollar.ca` at
`whollar-110003037934.development.catalystserverless.ca`. Every live signup,
sealed bid, offer read, acceptance and order writes to development tables. The
admin console does the same (`admin-console/vercel.json` rewrites).

There is no production Catalyst environment. Creating one needs a manual SSL
request with a stated 48-hour turnaround, so this is lead-time work, not a flag
flip. Start it before anything else on this list.

### 0.2 No cron job exists, anywhere

- `crmSync` has never been scheduled. `CRM_SYNC_RUNBOOK.md` Step 3 is
  unperformed. The queue drains only when someone curls it by hand.
- `authCronCleanup` is named in `lib/sessions.js` and `create-tables.md` and
  has no code. Sessions are never swept.
- The notification outbox now in the tree (`lib/notify/outbox.js`) has no drain.

Three separate, finished features are dark for the same missing reason.
`catalyst-backend/catalyst.json` declares four function targets and zero jobs.

### 0.3 CASL exposure, live, today

Four surfaces promise unsubscribe and `privacy.html` states every message
carries one. No email Whollar sends carries one. Full detail in
`PHASE0-NOTIFICATIONS-AUDIT.md`. The fix is written and uncommitted
(`lib/notify/`, `routes/notify.js`, 2,481 lines). Three tables are owed and are
**not yet in `create-tables.md`**: `notification_outbox`, `email_suppressions`,
`unsubscribe_tokens`.

### 0.4 No SMS sender

`dashboard.html:2232` says "reply to any of our texts". `dashboard.html:4413-4414`
says the visit window "is confirmed by text" and the installer "proposes visit
times by text". `lib/notify/registry.js:48` describes an SMS toggle. Nothing in
the stack sends SMS. Either build it or rewrite the copy; today the copy is a
promise with no sender behind it.

### 0.5 No payment rail

`routes/billing.js:29-31` states it plainly: there is no payment service
provider, and what a partner puts on file is an invoicing arrangement. That is
defensible for founding partners. Make it an explicit MVP decision rather than
something discovered at the first invoice.

### 0.6 CI does not parse the new notify modules

`.github/workflows/deploy-functions.yml` checks `src/lib/*.js`, a
non-recursive glob. `src/lib/notify/*.js` (8 files) and
`src/lib/notify/templates/*.js` (3 files) are not matched. A syntax error in
any of them makes `index.js` mount the degraded app and every `/api/auth/*`
call 503s. Fix the glob in the same PR that lands the notify work.

---

## 1. Admin dashboard and CRM

### What is built

Seven views: overview, site config, campaigns, providers, leads, deep reads,
audit. Behind them, 25 admin endpoints including campaign create/edit/transition,
coverage, bid review, reconcile, provider approve/reject/suspend, coverage
verification and org merge. Admin identity is server-enforced on `user_type`
(`routes/admin.js` `requireAdmin`). This is real, working ops tooling.

### 1a. The bids sheet reads fields the endpoint no longer returns

`admin-console/index.html:696` renders `b.won`. The endpoint returns
`won_tiers`, an array (`routes/admin.js:1202-1205`). **The "Won" pill therefore
never renders on any campaign.**

Worse, the response carries `book.sealed`, `book.computed` and `book.drifted`
(`routes/admin.js:1170-1185`) and the console ignores all three. A cohort is
decided tier by tier now; the console still shows one headline price per
partner and no winner at all. `drifted` exists precisely so an operator can see
that a sealed book and the live rows have diverged, which is what a late price
correction looks like, and nothing displays it.

This is the highest-value admin fix on the list: the data is already there.

### 1b. No delivery or money surface at all

There is no `/admin/orders`, `/admin/awards`, `/admin/statements`,
`/admin/billing`. Awards, orders, install slots, exceptions, activations,
disputes and accrued success fees are all in the data and invisible to staff.
This is the half of the marketplace that bills.

### 1c. No member or household surface

`/admin/leads/:table` reads eight form-submission tables. There is no view of a
registered member, their seat claim, their bill, their offer window, or their
order. The overview shows one number: a member count.

### 1d. No notifications surface

Once the outbox lands, staff need to see what was sent, what bounced and what
is suppressed. Nothing is planned for it in the console.

### 1e. Deep read files cannot be opened

The console says the authed download proxy "ships next". Until then staff open
bills from the Catalyst console.

### CRM, specifically

**1f. The cron does not exist.** Everything below is moot until it does. This is
0.2, restated because it is the whole of "CRM integration" today.

**1g. Only form submissions sync.** `crmSync/index.js:214-219` names five
sources, all of them pre-account: waitlist, waitlist details, bill checkup,
deep read, partner application. A person who registers, joins a cohort, is
shown an offer, accepts it and gets switched produces exactly one CRM record:
the form they filled before any of that happened. Your item 1, "integrate all
the data into the dashboard", is really "give the CRM the account lifecycle".

**1h. Partners sync as an application and never as a partner.** Approval,
declared coverage regions, terms acceptance, bids placed, tiers won, orders
delivered and fees accrued reach nothing. `CRM_PARTNER_MODULE` still defaults to
`Leads` (`crmSync/index.js:46`), so partner records may not even be in their own
module yet. That is a console config step, not code. Your item 2.

**1i. There is no cohort object in CRM.** Your item 3 has no target to write to.
This needs a decision before it can be scoped: a custom Cohorts module in Zoho
with member and partner relations, or campaign fields flattened onto the Lead.
The first is right and slower. Decide it before building either.

**1j. Mobile, streaming and tires never reach CRM.** `routes/interest.js` writes
`product_interest` and nothing reads it back. `enqueueCrm` is called from
`formSubmit` only (six call sites, `functions/formSubmit/index.js`), never from
the auth function. Your item 4 is the cheapest thing on this entire audit: one
enqueue call plus one `SOURCE_META` entry. Note the survey stores values not
labels by design, so the CRM mapping needs the label table alongside it.

---

## 2. Consumer

### What is built

Five views: Home, My bills, Knowledge centre, Campaign history, Contact us. The
cohort seat lifecycle is live (`/me/seat`, join, leave, move, pass). The offer
flow reads the server's sealed per-tier price book and records the household's
window. Acceptance books an install with address, phone and slot. Data export
and account deletion are real. This is further along than the sector list
implies.

### 2a. The notification toggles lie

`dashboard.html:5158-5161` catches `change` on `.tog` and toasts "Preference
saved." No write happens. `POST /me/prefs` exists (`routes/me.js:388`) and
`W.session` already wraps it (`js/whollar-core.js:2089`). This is an hour of
work, and until it is done the product makes a false statement to a member
about their own consent settings. Fix it with 0.3, not after.

### 2b. The activity feed is thin where it is honest

`feedItems()` (`dashboard.html:2405`) walks `DEMO_FEED` under `?demo=1` and,
live, emits one line plus campaign date milestones. `user_events` exists and
`POST /me/event` writes it. Nothing reads it back. A member who joined, was
shown an offer, accepted and booked sees a feed that says none of that.

### 2c. The page still describes itself as a prototype

`dashboard.html:7-10`: the HTML comment says "running on demo data" and the
meta description reads "Whollar member dashboard prototype ... Demo data."
`noindex` keeps it out of search, not out of View Source or an accessibility
tree.

### 2d. The post-acceptance promise cannot be kept

See 0.4. The order state itself is readable and correct
(`routes/campaigns.js:588-601` returns `orderNo`, `status`, `slotAt`), so the
screen is right. The sentence beside it, promising a text, is not.

### 2e. Knowledge centre is a hardcoded list

Ten blog links at `dashboard.html:2956-2962`, duplicated from the blog. Fine for
MVP; it will drift, and it is a second place to update when a post is added.

### 2f. The checklist offers an "Add" for a product that does not exist

`dashboard.html:5151` renders an Add button for a mobile bill. Mobile is a
survey, not a product. Either suppress the affordance or route it at the survey.

---

## 3. Provider

### What is built

Nine views, all real: overview, bid desk, my bids, ticket with sealed per-tier
bids and append-only revisions, coverage, contracts with terms acceptance,
delivery board, billing, performance, account. The intimation boundary is
enforced server side in one file with three preconditions and a full audit
trail (`routes/delivery.js:15-36`). **This is the most finished sector in the
product.**

### 3a. Team and access is half-built and marked "Soon"

`GET /provider/team` exists (`routes/desk.js:229`). There is no invite, no role,
no removal, no write path of any kind. `partner/index.html:137` shows the nav
item disabled. One person per partner company holds the entire relationship,
including the sealed bid and the household roster. For a founding-partner MVP
that may hold; past that it does not.

### 3b. API integration is unstarted

`partner/index.html:136`, disabled. No endpoint, no key issuance, no docs.
Probably right to defer past MVP. Say so deliberately rather than leaving a
"Soon" pill to answer for it.

### 3c. The campaign plan view is the one honest placeholder

`partner/views/placeholders.js`: the per-cohort timeline has no route behind it.
The empty state says what it will hold, which is the right way to ship a gap.

### 3d. Cohort search in the frame is markup with no handler

`docs/console/functional-parity.md` G4 and G5. The search box is visible in the
frame and does nothing when typed into. Either wire it or hide it; a dead
control is worse than no control.

### 3e. No calendar and no ICS

The prototype had per-campaign ICS export and a five-event auction calendar
(B23, B24, O10). Neither was ported. This matters to a partner planning install
capacity around close dates, and it is the piece of the notifications brief that
`PHASE0-NOTIFICATIONS-AUDIT.md` flags as having no data behind it.

### 3f. "Connect" has no referent in the code

Worth pinning down before it gets scoped, because it reads three ways:
- **partner reaches the household**: already built and correctly gated
  (`routes/delivery.js`).
- **partner's own systems reach Whollar**: that is 3b.
- **partner records reach the CRM**: that is 1h.

---

## 4. General: blog SEO and images

### 4a. Not one page on the site has an og:image

Checked `index.html`, `bill-checkup.html`, `partners.html`,
`become-a-partner.html`, `contact.html` and all 11 blog posts. Only
`blog/crtc-internet-prices-canada` carries the tag. Ten posts and every
marketing page do not.

Every share to LinkedIn, Facebook, Slack, WhatsApp or iMessage renders as a
bare grey link. For a product whose growth loop is a member sharing a cohort
with their street, this is the single highest-leverage SEO item in this
document.

The art mostly exists: `images/resources/` holds 11 pairs at 1x and 2x, used on
the blog index cards and nowhere else.

### 4b. Blog posts contain zero images

`grep -c "<img"` returns 0 on all 11 posts. The hero art appears on the index
card only; the article body is unbroken text end to end. That is your "images
not looking good" item, and the answer is that on the post page there are none.

### 4c. Sitemap is thin and stale

21 URLs. Nine posts carry `lastmod` of 2026-07-20. No MobileVersion pages are
listed at all, which is correct only if the canonical strategy says so, and
nothing states that it does.

### 4d. Two images are heavy for what they are

`whole-street-switch@2x.webp` at 178KB and `who-sells-you-internet@2x.webp` at
118KB, against a set that otherwise averages under 70KB.

### 4e. The blog cannot be rebuilt, so every fix is a hand-patch to two files

Built pages carry post-build edits the drafts lack, so `scripts/build-blog.mjs`
must not be run. Fixing og:images and hero art by hand means touching 22 files
twice. **Reconcile the drafts with the built pages first.** It is one focused
job and it makes every item above a generator change instead of 22 edits.

### 4f. `disclosures.html` content is still owed

`/disclosures` currently redirects to `/terms` (`vercel.json:108-109`).

---

## 5. Cross-platform

### 5a. Signed-in surfaces have no mobile route

`js/device-router.js:19-25` pairs six marketing pages plus 11 posts.
`/dashboard`, `/partner` and the admin console are not paired. They rely on
responsive CSS: 33 media queries in `dashboard.html`, 8 in `partner/app.css`
plus a drawer under 940px. That may well be the right call, but nobody has
stated it, tested it on a phone, or written down what "good enough" means for a
member accepting an offer on mobile.

### 5b. Six public pages have no mobile twin either

`/contact`, `/terms`, `/privacy`, `/thank-you`, and both login pages. A member
signing in on a phone gets the desktop login form.

### 5c. No PWA surface at all

No `manifest`, no service worker, no `apple-touch-icon`, no `theme-color` on any
page checked. On iOS, "Add to Home Screen" yields a screenshot icon and a
browser chrome. For a product people check once a month around a promo cliff,
a home-screen icon is most of what "app" needs to mean.

### 5d. The desktop and mobile split is a doubling tax

Every blog fix is 22 files. Footers are generated and safe; content is not. This
is 4e restated at site scale, and it is the structural reason the general sector
keeps getting expensive.

---

## Suggested sequence

Ordered by what unblocks the most, not by size.

**Now, in parallel, because they have lead time or are live exposure:**

1. Request the Catalyst production environment and SSL. Nothing else ships
   truly until this exists (0.1).
2. Land the notify work with its three tables, the runbook section, the CI glob
   fix, and wire the dashboard toggles to `POST /me/prefs` (0.3, 0.6, 2a).
3. Create the crmSync cron. One console step; it turns a finished feature on
   (0.2, 1f).

**Then, one focused week each:**

4. Admin: fix the bids sheet to render the price book, `won_tiers` and
   `drifted` (1a). Add the delivery and money surface (1b).
5. CRM: decide the cohort object (1i), then enqueue from the auth function for
   accounts, seats, acceptances and activations (1g), partner lifecycle (1h),
   and the three product surveys (1j, an afternoon).
6. Blog: reconcile drafts with built pages, then generate og:images and post
   hero art for all 11 (4e, then 4a and 4b).

**Then decide, do not drift into:**

7. SMS: build it or rewrite the copy (0.4).
8. Payments: founding-partner invoicing is the MVP answer; write it down (0.5).
9. Partner team and access: needed the day a partner has two people (3a).
10. PWA and mobile routing for signed-in surfaces: state the standard, then
    meet it (5a, 5c).
