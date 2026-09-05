# Deploy readiness, September 2026 restructure

The brief asked for two `whollar-deploy-check` runs, one per project. That
skill was not available in the session that did the work, so this is the
scripted equivalent: every check that could be run without Vercel access to
the owning team was run, with the numbers, and every check that needs a
preview URL is listed as pending with the exact command to run against it.
Branch `domain-restructure`, 2026-09-02.

## Run against the repository (both projects)

| Check | Umbrella `home/` | Internet site | Result |
| --- | --- | --- | --- |
| Inline scripts parse (`check-inline-scripts.mjs`) | 5 pages | 37 pages | 75 blocks, all pass |
| Copy rules (`check-console-copy.mjs`) | 4 pages, 1 script, llms | registered set | 52 files, no em dashes, no banned terms |
| Host gate (`check-site-host.mjs`) | n/a, own host | deployable set | 0 references to the old host |
| Redirect map (`check-redirect-map.mjs`) | 34 rules | n/a | 62 of 62: every sitemap URL and every unlisted path resolves to the same path on the product host, umbrella paths never swallowed, blog per slug, one hop from www |
| Mobile drift (`build-mobile-pages.mjs --check`) | n/a | 6 pages | in sync with swept sources |
| Footer drift (`build-footer.mjs --check`) | hand copy, absolute links | 50 pages | current |
| Console bundle (`build-console.mjs --check`) | n/a | partner/ | OK, 34 modules |
| Terminology on price surfaces (`check-terms.mjs`) | n/a | 7 files | clean |
| Shared core byte-identical (`cmp`) | `home/js/whollar-core.js` | `js/whollar-core.js` | identical |
| Self-containment | every local src/href in the 5 pages exists under `home/` | n/a | clean, 80 files, 3.3 MB |
| Metadata | canonical `https://www.whollar.ca/`, og:url, og:image 1200x630, twitter card, Organization + WebSite JSON-LD both parse | 46 canonicals, 48 og urls, 199 JSON-LD lines on the product host | present and valid |
| Link audit (browser) | 21 links: 9 to the product host, 5 to `/join`, the rest in-page, none off pattern | n/a | pass |
| Browser smoke (playwright) | index, join, welcome, 404: no page errors; the form page loads the shared core and targets the absolute form host | n/a | pass |
| Notify copy gate | n/a | 23 templates, 39 messages | clean on the new host |
| Backend suites | n/a | test-notify 111, test-notices 19, test-referral, six CRM suites 212 | all passing |

## Pending: needs a preview URL from the owning Vercel team

The MCP connection in the session was authorised against a different team,
so no preview was deployed. Run these against the two preview URLs before
any domain changes (runbook step 4):

```
# umbrella preview
curl -sI $HOME_PREVIEW/            | grep -i "^HTTP\|x-robots-tag\|content-security-policy"
curl -sI $HOME_PREVIEW/join        | grep -i "^HTTP"
curl -sI $HOME_PREVIEW/blog/best-internet-toronto | grep -i "^HTTP\|^location"   # 301 to the product host
curl -s  $HOME_PREVIEW/sitemap.xml | grep -c "www.whollar.ca"                     # 2
curl -sI $HOME_PREVIEW/nope        | grep -i "^HTTP"                              # 404, real

# internet preview
curl -sI $NET_PREVIEW/             | grep -i "^HTTP\|x-robots-tag"
curl -sI $NET_PREVIEW/blog/        | grep -i "^HTTP"
curl -s  $NET_PREVIEW/sitemap.xml  | grep -c "internet.whollar.ca"               # 26
curl -s  $NET_PREVIEW/ | grep -o 'rel="canonical" href="[^"]*"'                   # internet host
curl -sI $NET_PREVIEW/join         | grep -i "^location"                          # 301 to www
```

Expected on both: `x-robots-tag: noindex` (Vercel previews), the CSP header
present, a real 404 with `noindex` in the page.

## Known gaps, stated rather than scored

- The deploy-check checklist's canonical-host expectation reads apex. For
  the internet site the expected canonical is `internet.whollar.ca`; for the
  umbrella it is `www.whollar.ca`, not the apex. Both differ from the
  checklist and the workbook until runbook step 15 updates them.
- `admin.whollar.ca` does not resolve (NXDOMAIN) as of 2026-09-02. Nothing
  in this restructure touches it.
- The root copies of the umbrella pages remain on the internet project,
  unreachable behind 301s, until runbook step 18.
- The Catalyst rewrites target the Development environment. Pre-existing,
  unrelated, visible.
