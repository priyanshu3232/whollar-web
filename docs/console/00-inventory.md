# Phase 0: every provider-facing surface, and what happens to it

Produced by sweeping the repo for `*partner*`, `*provider*`, `*dashboard*`,
`*console*`, `*bid*`, `*supply*`, then following every inbound link, route and
rewrite. This is the document §3 asks for and the branch had not produced.

The three buckets are the brief's: **Console** is replaced by `/partner`,
**Acquisition** stays and gets re-pointed, **Dead** is deleted.

---

## The replacement table

| Old path | Class | New path | Redirect | Data migration | Delete after |
| --- | --- | --- | --- | --- | --- |
| `provider-dashboard.html` → `/provider-dashboard` | Console | `/partner` | 308 once `/partner` reaches parity | None. It reads the same `provider_*` tables the new console reads | The delivery board and statements land, so a partner loses nothing by the switch |
| `provider-console.html` → `/provider-console` | Console | `/partner` | Not needed | None | **Already deleted** on this branch. It was four commits old and unlinked from anywhere |
| `partners.html` → `/partners` | Acquisition | unchanged | no | none | stays |
| `become-a-partner.html` → `/become-a-partner` | Acquisition | unchanged | no | none | stays, CTA re-pointed |
| `MobileVersion/become-a-partner-mobile.html` | Acquisition | unchanged | no | none | stays, CTA re-pointed. Generated: edit the desktop source, then `build-mobile-pages.mjs` |
| `whollar-login-provider.html` | Acquisition | unchanged | no | none | stays, `next` default re-pointed |
| `MobileVersion/provider-mobile.html` | Acquisition | unchanged | no | none | stays |
| `docs/prototype/provider-console-v12.html` | Reference | none | no | none | `.vercelignore`d, never deployed. Keep: it is the porting source of truth |

**No provider dashboard holds real partner data that a live partner is using.**
`provider-dashboard.html` is a signed-in surface reading live tables, but the
founding partner cohort has not been onboarded, so the §3.3 stop-and-ask
condition is not met and this proceeds.

---

## Inbound links to re-point when `/partner` reaches parity

Four, and all four are one-line changes. Listed here rather than done now
because re-pointing them before the console has a bid desk would send partners
to a less capable page than the one they have.

| File | Line | What it does |
| --- | --- | --- |
| `whollar-login-provider.html` | 466 | `W.safeNext(..., '/provider-dashboard')`, the post-sign-in default |
| `become-a-partner.html` | 552 | the "Open your partner console" CTA |
| `MobileVersion/become-a-partner-mobile.html` | 555 | same CTA, generated from the desktop source |
| `catalyst-backend/functions/auth/src/lib/mailer.js` | 507 | the console URL in the approval email |

One more that is a copy string rather than a link:
`provider-dashboard.html:1072` quotes `https://www.whollar.ca/provider-dashboard`
inside an FAQ answer. It dies with the page.

Two gate registrations still name the old page and must move at the same time:
`scripts/build-footer.mjs:158` and `scripts/check-inline-scripts.mjs:28`.

---

## Dead

Nothing. Every file the sweep found has either an inbound link or a documented
reason to exist. The one candidate, `provider-console.html`, was deleted as part
of this increment rather than left for a later pass.

---

## Backend inventory

**Platform.** Zoho Catalyst, Advanced I/O function `auth`, Express 4, reached
same-origin through the single `/api/auth/:path*` rewrite in `vercel.json`. One
function serves member, partner, admin and public routes; `src/app.js` mounts
twelve route modules onto one router.

**Auth.** Cookie sessions, SHA-256 token hash in `sessions`. Partner sessions
are 12 hours absolute and do **not** roll. Partner sign-in is password plus an
emailed code. Admin is email OTP against an allowlisted domain.

**Tables the console reads or writes**, all created by hand:
`provider_orgs`, `provider_users`, `provider_coverage`, `provider_bids`,
`campaigns`, `site_config`, `user_prefs`, `auth_events`, and the five added by
this increment (`provider_applications`, `application_tasks`,
`provider_documents`, `provider_references`, `coverage_verifications`).

**File store.** Not yet used by the partner surface. Endpoints 8 and 9, the
document presign and confirm, are the first callers and are still stubs.

### Where the brief conflicts with what exists

Three, resolved in favour of the codebase per §2.6, and recorded here so the
next reader does not re-litigate them.

**1. `provider_ref` does not exist.** §3.4 says to reuse "a `provider_ref`
table that resolves flanker ownership" and not to create a second one. There is
no such table. The nearest thing is `provider_orgs`, which carries
`email_domain` and is joined to applications by domain-suffix match in
JavaScript.

The consequence is not cosmetic. §6.1 requires that a campaign never show a bid
slot to two orgs resolving to the same `parent_group` where the parent has
already bid. **There is no parent_group and no flanker model, so that rule
currently has nothing to enforce against**, and two flanker brands of one
incumbent could both bid on one cohort today. That is a real gap in the auction's
integrity, not a missing convenience, and it needs its own increment: a
`provider_groups` table, a `parent_group_id` on `provider_orgs`, and the check
inside the visibility query rather than in the UI.

**2. Integer cents.** §2.4 mandates them. `lib/money.js` stores canonical
strings and documents why: the Catalyst console's Int column has no cents and
ZCQL cannot sum a varchar, so every amount in this system is a string and every
sum is done in JavaScript as integer cents. The arithmetic §2.4 is protecting is
already correct; the storage type it names is not available. Keep the strings.

**3. Singular table names.** §6 uses `provider_org`, `campaign`, `bid`. The live
tables are plural and hold data, and there is no DDL API, so a rename is manual
console work in two environments for no behavioural gain. New tables follow the
existing plural convention.

### The gap this increment closed

`provider_coverage.status` landed on `verifying` and **no route anywhere moved
it to `active`**. Since a cohort only reaches a bid desk from inside an active
region, every partner who declared coverage saw an empty desk forever, with no
way to tell that from having no cohorts. Most of §8's state matrix was
unreachable on live data for that one reason.

`POST /admin/providers/:orgId/coverage/:region/verify` and `.../reject` are now
the only writers of `active`, behind `requireAdmin`, appending to
`coverage_verifications` before they move the row.
