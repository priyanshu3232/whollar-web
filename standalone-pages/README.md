# Standalone pages

One fully self-contained HTML file per page. Every local asset (lottie library,
animation JSON, CSS, fonts, video, images, favicon) is inlined, so each file can
be opened, moved, or edited on its own — no sibling folders needed.

| File | Page |
|---|---|
| `home-consumer.html` | Home landing page (consumer) — copy of `/index.html` |
| `partners-distributor.html` | Distributor/provider landing page — copy of `/partners.html` |
| `bill-checkup-overpaying.html` | "Check if I'm overpaying" tool — from `/bill-checkup.html` |
| `become-a-partner-book-a-call.html` | Partner application + book-a-call — from `/become-a-partner.html` |
| `resources.html` | Resources (blog) landing page — from `/blog/index.html` |
| `join-the-first-cohort.html` | Join the first cohort (waitlist) — from `/waitlist/index.html` |

Notes:

- These were generated on 2026-07-23. They are snapshots — edits here do NOT
  flow back to the live site files, and edits to the live files do not update these.
- `home-consumer.html` and `partners-distributor.html` were already
  self-unpacking single-file bundles; they are byte-for-byte copies.
- Web fonts on most pages load from Fontshare/Google Fonts CDNs, and forms/OCR
  still POST to the live Catalyst backend — so those features need internet,
  but no local files.
- Navigation links between pages (e.g. `/join`, `/blog/...`) are root-relative
  site routes and won't resolve when a file is opened from disk. Everything
  within each page works standalone.
