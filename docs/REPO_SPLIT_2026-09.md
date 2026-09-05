# The repo split, September 2026

Written 2026-09-03. What moved, what stayed, and the four obligations that now
cross a repo boundary.

## The three repos

| Repo | Host | What it holds |
|---|---|---|
| this one | `internet.whollar.ca` | the internet product, the member dashboard, `partner/`, `admin-console/`, **`catalyst-backend/`**, `scripts/`, `docs/` |
| `whollar-home` | `www.whollar.ca` (apex 308s to www) | the umbrella page, the common waitlist, the two welcome screens, and the permanent redirect map |
| `whollar-tires` | `tires.whollar.ca` | the winter tire landing page, its six forms, its `/join`, and `design/`, the canvas the page is generated from |

`admin-console/` was already its own Vercel project and is untouched.

Both new repos were made with `git subtree split`, so they carry the history of
the files they took, and both were verified standing alone: served from their
own root, gates green, and for tires the 102 check browser harness passes.

## The backend did not move, and must not

One Catalyst app, three frontends. The waitlist is one identity row whichever
door it arrives through, and the CRM lane, the notify outbox and the admin
routes are one pipeline. A copy of any of it in another repo forks the
waitlist, which is the one thing the single waitlist design exists to prevent.

## Four things now cross a repo boundary

**1. The shared module.** `js/whollar-core.js` here is the original. Both new
repos carry a byte-identical copy, checked in their CI by the checksum in
`js/whollar-core.sha256`. The `cmp` that used to hold `home/js/whollar-core.js`
equal cannot reach across repos, so **changing this file is now three commits**:
here, and a copy plus a new checksum in each repo that carries one.

**2. The Origin allowlist.** `ALLOWED_ORIGINS` in
`catalyst-backend/functions/formSubmit/index.js` decides whether a POST from a
host is answered. A host missing from it 403s every write while every GET keeps
working, which reads as a frontend bug and is not one. All three product hosts
are in it today. The console CORS rule and `GATEWAY_CORS_ORIGINS` are the other
two places the same fact is written, and they must agree: two
`Access-Control-Allow-Origin` headers is a rejected response.

**3. The submit contract.** The tire forms build a body that
`POST /tire-waitlist-join` reads field by field, and the umbrella's waitlist
does the same against `/waitlist-join`. Renaming a field is a change in two
repos, and nothing in either one will tell you.

**4. The redirect map.** `whollar-home/vercel.json` is what keeps every legacy
`www.whollar.ca/...` URL alive after the apex stops being the internet product.
Emails and printed links minted before the cutover depend on it.
`scripts/check-redirect-map.mjs` here is the gate that proves it, and it now
checks a file in another repo: keep a copy of that config in sync or move the
gate.

## The step that is NOT done

`home/` and `tires/` are still in this repo. Nothing serves them from here
(both are in `.vercelignore`, and each is its own Vercel project rooted at its
own repo), but two copies of a file drift. Once the new repos are pushed and
their Vercel projects are building from GitHub, remove them here:

```
git rm -r home tires
```

and with them: the `home/` and `tires/` entries in `scripts/check-inline-scripts.mjs`
and `scripts/check-console-copy.mjs`, the five tire and umbrella steps in
`.github/workflows/check-frontend.yml`, `scripts/port-tires.mjs` and
`scripts/qa-tire-kit.mjs` (they live in `whollar-tires` now), and the `home`
and `tires` lines in `.vercelignore`. `scripts/check-site-host.mjs` needs its
`SKIP_DIRS` trimmed in the same commit.

`scripts/port-landing.mjs` and `scripts/port-waitlist.mjs` stay: they are the
frozen record of how the umbrella pages were ported, and both already refuse to
run without `--force` because their output moved.

## One decision still open

The umbrella's canonical host. This repo's `docs/DOMAIN_CUTOVER_RUNBOOK.md`
says `www.whollar.ca` stays canonical and the apex 308s to it, as it does
today, and `whollar-home` is built that way: canonicals, og:urls and its
sitemap all name www. The multi-domain guide of 2026-09-03 says the opposite,
apex canonical with www as a redirect domain. Either is workable and mixing
them is not. Settle it before the domains move, because it is four files and a
Vercel setting on the day and an SEO cleanup afterwards.
