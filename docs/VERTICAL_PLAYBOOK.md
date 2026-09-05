# Vertical playbook: adding a service host under whollar.ca

Written 2026-09-02 from the pattern that moved the internet product to
`internet.whollar.ca`. The next vertical is `tires.whollar.ca`; its landing
page is a separate design task. This document is the wiring, not the page.

## The shape

One vertical is one directory, one Vercel project, one CNAME. It owns its own
crawl surface. The umbrella at `www.whollar.ca` links to it and never proxies
it.

```
<vertical>/                 own Vercel project, Root Directory = this folder
  index.html                canonical https://<vertical>.whollar.ca/
  vercel.json               cleanUrls, headers, its own redirects, its own rewrites
  robots.txt                allow all, names its sitemap
  sitemap.xml               its pages only
  llms.txt                  what the vertical is, linking back to the umbrella
  404.html                  noindex
  og/                       a produced 1200x630 image
  js/, fonts/, images/      self-contained; nothing loaded from another host
```

## Steps, in order

1. **Directory and project.** Create `<vertical>/` in this repository.
   **OWNER:** import the repo as a new Vercel project on the same team, Root
   Directory `<vertical>`, Framework `Other`, no build. Add
   `<vertical>` to the ROOT `.vercelignore` so the internet project cannot
   publish it at `/<vertical>/...` under cleanUrls (that line exists for
   `home` today; copy it).
2. **Self-contained.** Copy what the pages need into the directory. If the
   vertical uses the shared core, copy `js/whollar-core.js` and add a
   `cmp` step to `.github/workflows/check-frontend.yml` holding it
   byte-identical to the root copy, as `home/` does. A copy that drifts is a
   second implementation nobody remembers to fix.
3. **Metadata.** Canonical on the vertical's own host, og and twitter with the
   produced image, `Organization` JSON-LD pointing `@id` at the umbrella's
   `https://www.whollar.ca/#org` (one organisation, many hosts) and a
   `WebSite` or `Service` node for the vertical itself. House terminology:
   household, member, cohort, partner. No em dashes anywhere.
4. **The umbrella side.** A card and a nav link on `home/index.html` pointing
   at `https://<vertical>.whollar.ca/`. Add the host to `home/llms.txt`. If the
   vertical has a "join" that differs from the umbrella's `/join`, decide
   which one owns the household before either ships; today `/join` on the
   umbrella asks for internet, tires or both, and the welcome screen for a
   tire household is `home/join-welcome-tires.html`, whose content the tire
   build owns.
5. **Backend, only if it calls one.** A vertical that posts to formSubmit or
   the auth function needs its origin in `ALLOWED_ORIGINS` (env on auth, the
   arrays in formSubmit and billOcr) and, for the forms, the Catalyst console
   CORS rule and `GATEWAY_CORS_ORIGINS` together, in that order. A vertical
   that is a landing page with links needs none of this.
6. **Gates before domains.** Register its pages in
   `scripts/check-inline-scripts.mjs` and `scripts/check-console-copy.mjs`.
   Run the host gate pattern: the vertical's canonicals must name its own
   host and no other. Deploy to a preview and run the curl matrix from
   `docs/DOMAIN_CUTOVER_RUNBOOK.md` step 4 against it.
7. **Domain.** **OWNER:** attach `<vertical>.whollar.ca` to the project; at
   IONOS add `CNAME <vertical> -> cname.vercel-dns.com`. Verify 200 on the
   root, robots, sitemap, 404. Search Console: add the property, submit its
   sitemap.
8. **Its own blog, eventually.** Same as the internet site: `blog/<slug>/`
   under the vertical, its own `llms.txt` entries, and a mobile generator only
   if the layout is not already fluid.

## What a vertical never does

- Redirect through the umbrella. Old links to a vertical are that vertical's
  own redirect map, in its own `vercel.json`.
- Share a session with another host. Cookies are host-only by design.
- Load scripts, fonts or images from another whollar host. The CSP is
  `'self'` for scripts and fonts; keep it that way and copy the files.
- Publish a page from `docs/` or a design source. `.vercelignore` is per file
  for documents and per directory for design sources; follow the entries that
  exist.

## For tires.whollar.ca specifically

The full build, step by step, with the Catalyst tables its waitlist needs:
`docs/TIRE_VERTICAL_BUILD.md`. What follows is the summary it expands.

- The design is owed. When it arrives as a canvas bundle, port it the way
  `scripts/port-landing.mjs` did for the umbrella: decode assets to files,
  resolve the canvas syntax, re-implement any behaviour as a classic script.
  The runtime in those bundles compiles itself with `new Function`, which the
  CSP forbids, so the bundle can never ship as it is.
- A tire household today already lands on `home/join-welcome-tires.html`.
  When the vertical exists, that screen's button and step link point at it.
- `Whollar_Pooling_For` on the CRM record already carries `tires`; the
  vertical inherits the household without new backend work.

## Since the split (2026-09-03)

The umbrella and the tire vertical are their own repos now, so a vertical that
copies `js/whollar-core.js` cannot be held equal by a `cmp` in this repo's CI.
Each copy carries a `js/whollar-core.sha256` its own CI checks, which catches a
local edit but not this file changing underneath it. **Changing
`js/whollar-core.js` is three commits**: here, and a copy plus a new checksum
in `whollar-home` and `whollar-tires`. See `docs/REPO_SPLIT_2026-09.md`.
