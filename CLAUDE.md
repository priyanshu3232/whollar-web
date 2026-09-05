# Whollar: standing rules

Read on every session. Only things that must never drift belong here.

Reference prototype: `docs/prototype/provider-console-v12.html` (demo data, do not deploy)
Plan and porting notes: `docs/console/`

## Three repos, one backend

This repo is the internet product at `internet.whollar.ca`, and it holds the
one Catalyst backend all three hosts write to. The other two are siblings on
disk and their own GitHub repos, each with its own CLAUDE.md:

| Repo | Folder | Host |
|---|---|---|
| this one | `~/1whollar` | `internet.whollar.ca` |
| `whollar-home` | `~/whollar-home` | `www.whollar.ca` |
| `whollar-tires` | `~/whollar-tires` | `tires.whollar.ca` |

`docs/REPO_SPLIT_2026-09.md` is the record: what moved, what did not, and the
four facts that are now written in two places and agreed by nothing. The one
that bites: **changing `js/whollar-core.js` is three commits**, here and a copy
plus a new checksum in each sibling, because the `cmp` that used to hold them
equal cannot reach across repos.

`home/` and `tires/` are still in this repo and are now duplicates. Nothing
serves them from here. The removal, gates and `.vercelignore` lines included,
is written out in the split document.

## The stack, in one line each

- The site is **static HTML at repo root**. No framework, no bundler, **no build step**,
  with one scoped exception: **`partner/`**, the partner console, is authored as ES modules
  and compiled to a single classic script by `scripts/build-console.mjs`. That script has no
  dependencies, so CI stays install-free, and it has a `--check` mode like every other
  generator here. The exception covers `partner/` and nothing else.
- The backend is **Zoho Catalyst** (`catalyst-backend/`), Express 4, reached same-origin
  through the `/api/auth/*` rewrite in `vercel.json`.
- The data store is **Zoho Data Store**: no DDL API (tables are created by hand in the Zoho
  console and documented in `catalyst-backend/scripts/create-tables.md`), no joins, no
  composite keys, no parameter binding, `LIMIT 300`, ~15k rows via `queryAll`.
- `js/whollar-core.js` is the one shared module. It exposes `window.WHOLLAR`.

## Terminology, in code as well as copy

Use: founding partner, partner / household, member / cohort / promo cliff / sealed bid /
intimation / FSA

Never: client, customer, lead, lead generator, prospect, group, batch, pool, handover,
lead delivery

Applies to variable names, table names, event names, and API paths, not only to visible
strings. A `LeadService` leaks into copy eventually.

## Never

- **No em dashes.** Anywhere: copy, code, comments, content files. Use commas or colons.
- **No ESM in any browser-loaded file.** `scripts/check-inline-scripts.mjs` deliberately
  lets `type="module"` through to `node --check`, which parses it as a classic script, so
  an `import` turns the gate red. Classic scripts attaching to a global, always.
  This rule is unchanged by the `partner/` build: `partner/*.js` is **source**, never
  served, and the file a browser loads (`partner/console.build.js`) is a classic script
  that `node --check` parses. Put an `import` in any file outside `partner/` and the gate
  still turns red, which is the point.
- **No `eval`, `new Function`, or in-browser template compilation.** The global CSP has no
  `'unsafe-eval'`. Only `/partners` and two mobile pages carry that grant.
- **No withdraw path for a sealed bid.** No delete endpoint, no code path that removes a bid
  record. Bids are append-only and versioned.
- **No billable line from a confirmation, an offer acceptance, or a booking.** Only an
  activation with a clean line test creates a fee.
- **No campaign stage derived on the client.** The server owns stage. Client countdowns
  offset from the `serverTime` captured at fetch, never from a bare `Date.now()`.
- **No partner sees another partner's bid, count, or reference**, in any response, including
  error payloads.
- **The success fee is configuration on the agreement record, never a constant in code.**
  The $95 figure is an unconfirmed planning number.
- **No campaign card from anything but the server.** No seed array, fixture, or fallback
  catalog in a member, partner, or admin render path; `lib/cohorts.js` is the one read
  layer for campaign state and seat counts, and `source:'code'` is an empty list on every
  non-admin route. No seed baseline in any household count.

## Before adding a page or a js/ module

Every gate in `.github/workflows/check-frontend.yml` iterates a **hardcoded list**, so a new
file is not failing, it is simply unchecked. Register it:

- `scripts/build-footer.mjs` PAGES, then run the generator and commit the diff, or the
  `--check` gate reports STALE.
- `scripts/check-inline-scripts.mjs` PAGES.
- A `node --check` step in `check-frontend.yml` for any new `js/` file.
- `?v=` cache stamp on every `/js` reference: `/js` is cached 24h, so an unbumped stamp
  ships new markup against old JavaScript. Everything outside `partner/` is stamped by hand.

Inside `partner/` none of that applies, and nothing needs registering: the build walks the
import graph from `partner/app.js`, so a new module is picked up by being imported, and
**an unimported module is a build error** rather than an unchecked file. The bundle's cache
stamp is written into `partner/index.html` by the same build. Run
`node scripts/build-console.mjs` and commit both outputs, or the `--check` gate reports
STALE. `partner/demo/` is the one exception the build skips, and it is in `.vercelignore`
so fixtures cannot reach a deployed environment.

Signed-in surfaces additionally carry `<meta name="robots" content="noindex,nofollow">`, no
canonical, no Clarity, and stay out of `sitemap.xml`. An unguarded prototype must be added
to `.vercelignore`: `cleanUrls: true` means any committed `.html` publishes at its own path.

## Porting from the v12 prototype

It was built by successive patching. **16 functions are declared more than once** and the
last declaration wins by hoisting, so port the last one.

**But 7 more are wrapping decorators that call the previous version, and for those the last
definition replaces nothing.** `renderOverviewBits` is wrapped four times; `renderAll`,
`renderBids`, and `renderBilling` once each. Port the **composition**. See
`docs/console/render-inventory.md`.

## Working style

Terse reports. Structural opinions welcome, not just execution. If something in a brief is
wrong for this codebase, say so before building it.
