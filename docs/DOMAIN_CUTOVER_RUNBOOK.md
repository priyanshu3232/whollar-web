# Domain cutover runbook: whollar.ca becomes the umbrella, the product moves to internet.whollar.ca

Written 2026-09-02 for the domain restructure on branch `domain-restructure`.
Sequenced so the product is never unreachable: the new host is proven before
the old one changes hands. Steps marked **OWNER** need an account only the
owner holds (Vercel team, IONOS DNS, Catalyst console, ZeptoMail, Search
Console). Everything else is code already in the branch.

Decisions this runbook assumes, locked on 2026-09-02:

- `www.whollar.ca` stays the canonical host. The umbrella's canonical is
  `https://www.whollar.ca/`; the apex 308s to www, as it does today.
- `/join`, `/join-welcome` and `/join-welcome-tires` live on the umbrella.
- Everything else, blog included, lives at `https://internet.whollar.ca`.
- The 301 map in `home/vercel.json` and `docs/REDIRECT_MAP_2026-09.md` is
  **permanent**. Rules are added, never removed.

## 0. Before the window

1. **Merge order.** `landing-page-port` first (the second session's work), then
   `domain-restructure`. The restructure branch keeps the root copies of the
   umbrella pages and redirects them rather than deleting them, precisely so
   this merge has no modify/delete conflict. Delete them in step 11.
2. **OWNER: Vercel access for the session.** The MCP connection is currently
   authorised against a Hobby team, not the team that owns `whollar-web`.
   Reconnect it to that team, or run the `vercel` commands below yourself.
3. **OWNER: create the umbrella project.** Vercel, same team as `whollar-web`:
   import this repository again as a project named `whollar-home`, Root
   Directory `home`, Framework Preset `Other`, no build command, output `.`.
   No production domain yet. The first deploy of `main` after the merge gives
   it a preview URL; keep that URL for step 5.
4. **Preview gates, both projects.** Run `node scripts/check-redirect-map.mjs`
   and `node scripts/check-site-host.mjs` locally (both are CI gates), then
   against the previews:

   ```
   curl -sI <home-preview>/            | grep -i "x-robots-tag\|content-security"
   curl -sI <home-preview>/join        | grep -i "^HTTP"
   curl -sI <home-preview>/blog/x      | grep -i "^HTTP\|^location"
   curl -sI <internet-preview>/blog/   | grep -i "^HTTP"
   curl -s  <internet-preview>/sitemap.xml | grep -c internet.whollar.ca
   ```

   Previews carry `x-robots-tag: noindex` by Vercel default; the 301 on the
   home preview will point at the real internet host, which is expected.

## 1. Backend first: the product host must be allowed before it exists

These are environment and console changes on Catalyst. Do them BEFORE any
domain moves; nothing here breaks the current site.

5. **OWNER: auth function environment** (Development and Production alike):

   | Variable | Change |
   | --- | --- |
   | `ALLOWED_ORIGINS` | **append** `https://internet.whollar.ca`. Keep `https://www.whollar.ca` and `https://whollar.ca` (step 10 removes them later). |
   | `APP_BASE_URL` | `https://internet.whollar.ca` |
   | `API_BASE_URL` | `https://internet.whollar.ca` |
   | `COOKIE_DOMAIN` | unchanged. Cookies are host-only and follow the serving host. |

   The code fallback for notify links is already the internet host, so a
   missing `APP_BASE_URL` no longer points mail at www.
6. **OWNER: Catalyst console CORS rule.** The gateway rule that today names
   `https://www.whollar.ca` alone must ALSO name `https://internet.whollar.ca`.
   Then, in the same change, add the internet host to `GATEWAY_CORS_ORIGINS`
   in `functions/formSubmit/index.js` and `functions/billOcr/index.js` and
   redeploy both. Not before: the code comment above that constant explains
   why the order matters (two `Access-Control-Allow-Origin` headers, or none).
   Until this step, Express answers CORS for the internet host itself, which
   works, so this step is correctness, not a blocker.
7. **Deploy the three functions** (`catalyst deploy`): auth (notify fallbacks
   and the origin comments), formSubmit and billOcr (the widened allowlists).
   Verify with `curl -sI https://<function-url>/health` and, for the forms,
   the curl in the `GATEWAY_CORS_ORIGINS` comment with
   `-H 'Origin: https://internet.whollar.ca'`: exactly one
   `access-control-allow-origin` line back.

## 2. The new host, proven while the old one still serves

8. **OWNER: attach `internet.whollar.ca` to `whollar-web`** in Vercel. DNS is
   external at IONOS: add `CNAME internet -> cname.vercel-dns.com` there.
   Wait for the certificate. Nothing about www changes yet.
9. **Verify the product host fully** before touching www:

   ```
   node scripts/check-redirect-map.mjs           # still green
   curl -sI https://internet.whollar.ca/                       | grep "^HTTP"
   curl -sI https://internet.whollar.ca/blog/best-internet-toronto | grep "^HTTP"
   curl -s  https://internet.whollar.ca/api/auth/health        # the rewrite works
   curl -s  https://internet.whollar.ca/sitemap.xml | grep -c internet.whollar.ca   # 26
   ```

   Then a **login round trip in a browser** on the internet host: request a
   code, verify it, land on the dashboard. That proves `ALLOWED_ORIGINS`, the
   cookie on the new host, and the rewrite together. A referral link and an
   unsubscribe link from a real email should also resolve there.

## 3. The cutover: one domain move, in the agreed window

10. **OWNER: move `whollar.ca` and `www.whollar.ca` from `whollar-web` to
    `whollar-home`.** In the home project set `www.whollar.ca` as the primary
    domain and the apex to redirect to it (the config also carries this as a
    host rule, so a missed setting cannot break it). The product host stays
    attached to `whollar-web` throughout. Vercel handles the certificate; the
    IONOS records do not change.
11. **Immediately, the live matrix:**

    ```
    node scripts/check-redirect-map.mjs --live   # every legacy URL, <= 2 hops, 200 on the new host
    curl -sI https://whollar.ca/                 | grep "^HTTP\|^location"   # 308 -> www
    curl -sI https://www.whollar.ca/             | grep "^HTTP"              # 200, the umbrella
    curl -sI https://www.whollar.ca/join         | grep "^HTTP"              # 200
    curl -sI https://www.whollar.ca/blog/rural-internet-ontario | grep "^location"
    curl -sI https://www.whollar.ca/waitlist/    | grep "^location"
    curl -sI https://www.whollar.ca/r/ABCDEF     | grep "^location"          # emails still work
    ```

    `admin.whollar.ca` does not resolve today (NXDOMAIN); it is not touched by
    any step here and its project is separate.

## 4. Same day, and the two weeks after

12. **OWNER: Search Console.** Add the `internet.whollar.ca` property. Submit
    `https://www.whollar.ca/sitemap.xml` (2 URLs) and
    `https://internet.whollar.ca/sitemap.xml` (26). Request indexing for the
    umbrella page and the top blog posts. No Change of Address tool: this is a
    same-domain restructure and the 301s plus sitemaps are the mechanism.
13. **Sessions are per host.** Members and partners sign in once more on the
    new host. Accepted; not engineered around.
14. **Monitor for two weeks.** Vercel 404 logs on `whollar-home`: each 404 is
    a missing rule. Add it to `docs/REDIRECT_MAP_2026-09.md` and to
    `home/vercel.json` together, run `node scripts/check-redirect-map.mjs`,
    commit. GSC coverage on both properties. Expect a ranking dip of roughly
    two to eight weeks; the answer is patience and 404 patching, never a
    revert.
15. **OWNER: the audit workbook and the deploy-check mirror.** The canonical
    host for every blog and product check is now `internet.whollar.ca`; the
    www canonical applies to the umbrella page and `/join` only. Without this
    every future audit false-fails canonical parity. The workbook is not in
    the repository; the deploy-check skill was not available in the session
    that wrote this, so its mirror is a note to whoever runs it next.

## 5. Later, deliberate

16. **OWNER: ZeptoMail webhook.** Repoint it from
    `https://www.whollar.ca/hooks/zeptomail` to the same path on the internet
    host. Then remove the `/hooks/zeptomail` rewrite from `home/vercel.json`.
    Until then the umbrella rewrites the POST to the function, so nothing is
    lost.
17. **OWNER: trim the auth allowlist.** Once traffic confirms nothing on the
    umbrella calls the auth function (it does not: the welcome screens tolerate
    a missing session and `home/` has no `/api/auth` rewrite), remove
    `https://www.whollar.ca` and `https://whollar.ca` from the auth function's
    `ALLOWED_ORIGINS`. Do NOT remove them from formSubmit or billOcr: `/join`
    on the umbrella posts to formSubmit.
18. **Delete the root copies.** After `landing-page-port` is retired: remove
    `landing.html`, `join.html`, `join-welcome.html`, `join-welcome-tires.html`,
    `js/landing.js`, `js/waitlist-join.js`, `js/join-welcome.js`,
    `images/landing/`, `images/waitlist/`, `fonts/landing-*`, `fonts/waitlist-*`
    from the repo root, and their entries in `scripts/check-inline-scripts.mjs`,
    `scripts/check-console-copy.mjs`, `scripts/build-footer.mjs` and the three
    parse steps in `.github/workflows/check-frontend.yml`. Keep the four
    redirects in `vercel.json`. `scripts/port-landing.mjs` and
    `scripts/port-waitlist.mjs` are already guarded against recreating them.
19. Unrelated but visible from here: the Catalyst rewrites still target the
    Development environment and `NODE_ENV` is still `development`. Not part of
    this cutover; noted so nobody attributes it to the domain move.

**The 301 map is permanent.** It is recorded as such in
`docs/REDIRECT_MAP_2026-09.md`, enforced by a CI gate, and not subject to
cleanup.
