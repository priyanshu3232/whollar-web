# Whollar: Design guidelines for the admin console

> Hand-off for whoever designs/builds `admin.html`. Everything here is
> extracted from the shipped pages (dashboard.html, the two sign-in pages,
> bill-checkup.html, provider-dashboard.html) so the admin console reads as
> the same product. Written 2026-07-30.

---

## 1. Which theme the admin console should use

The repo has **two sibling themes**:

| | Member surfaces (LIVE canon) | Partner console (variant) |
|---|---|---|
| Pages | dashboard.html, both sign-ins, bill-checkup, index | provider-dashboard.html |
| Display font | **Satoshi** (Fontshare) | Bricolage Grotesque (Google) |
| Accent | Green `#1E9E63` | Forest `#12372B` + Gold `#C29B3C` |
| Mood | Warm, consumer, reassuring | Denser, B2B, "trading desk" |

**The admin console follows the member/live canon** (Satoshi + greens). That
is the direction `docs/ADMIN_PORTAL_PLAN.md` §8 already fixes ("same stack as
every other page… Satoshi/Inter, the existing design language"). The partner
console's gold is available as a *reference for dense table/desk UI patterns*
(§7 below), not as the admin palette. If the admin console wants its own
accent to distinguish "staff mode" at a glance, use the deep teal
`#0E2A20`/`#178A5A` end of the existing ramp rather than a new hue.

---

## 2. Color tokens (copy verbatim)

From the live pages' `:root` (dashboard.html + sign-in pages, which agree):

```css
:root{
  /* brand greens */
  --teal:#0E2A20;         /* darkest brand green: logo gradient start, dark tiles */
  --teal-deep:#0A2018;    /* near-black green */
  --teal-bright:#178A5A;  /* = --accent-deep / --accent-hover */
  --teal-soft:#7FE3B0;    /* glow: highlights on dark backgrounds only */
  --accent:#1E9E63;       /* THE green: primary buttons, active nav, progress */
  --accent-deep:#178A5A;  /* hover state, link color, eyebrows */
  --mint:#E4F4EC;         /* green tint: active-nav bg, chips, success wash */

  /* surfaces */
  --paper:#FAF8F3;        /* page background (warm cream) */
  --card:#ffffff;         /* cards, sidebar, tables */
  --mist:#F6F4EE;         /* secondary wash */
  --line:#e7ebe6;         /* hairline borders */

  /* text */
  --ink:#2B3A33;          /* body text */
  --ink2:#0A2018;         /* max-contrast headings when needed */
  --sub:#54625B;          /* secondary text */
  /* muted text floor: #5F6B64; do NOT go lighter for real copy;
     #8A968F is decorative only (it fails WCAG AA at small sizes) */

  /* warm counter-accent (urgency, warnings, "money at stake") */
  --terra:#C2643B;        /* strokes, fills, big numbers ≥24px */
  --terra-text:#A34F2B;   /* terra for TEXT; #C2643B is only 3.4:1 on cream */
  --terra-soft:#F7E7DD;   /* warm wash behind warnings/cliff content */
}
```

Accessibility rules already encoded in the codebase (keep them):
- Body copy at 11–13px must use `--ink`/`--sub`/`#5F6B64`, never `#8A968F`.
- Terra as **text** uses `#A34F2B`; `#C2643B` only for borders, strokes,
  icons, and large numerals.
- `:focus-visible{outline:2.5px solid var(--accent);outline-offset:2px;border-radius:8px}` on everything interactive.
- `@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}` verbatim.

### Semantic mapping for admin UI

| Meaning | Token | Example in admin |
|---|---|---|
| Confirm / approve / active / live | `--accent` on `--mint` | "Approved" pill, kill-switch ON |
| Destructive / suspend / reject / paused | `--terra-text` on `--terra-soft` | "Rejected" pill, bidding-paused banner |
| Pending / neutral | `--sub` on `--mist` | "Pending review" pill |
| Staff-only chrome | `--teal` dark tile (`.tile.dark` pattern) | "Admin" badge in the sidebar |

Never introduce a blue/red alert palette: urgency is terra, success is green,
neutral is mist. That triad is the entire signalling system of the site.

---

## 3. Typography

```css
--disp:'Satoshi',system-ui,sans-serif;        /* headings, nav, big numbers   */
--body:'Inter',system-ui,sans-serif;          /* everything else              */
--mono:'Space Mono',ui-monospace,monospace;   /* data: counts, dates, money,
                                                 ids, config values, audit    */
--label:'General Sans','Satoshi',...          /* (sign-in pages only; admin
                                                 can skip it)                 */
```

Loads (copy from dashboard.html head):
- Fontshare: `satoshi@500,700,900`
- Google: `Inter:wght@400;500;600;700` + `Space+Mono:wght@400;700`

Scale in use:
- Page body: `15.5px/1.55` on member pages, `14.5px` on the denser partner
  console; **admin, being table-heavy, should take 14.5px**.
- View heading `h2`: `clamp(21px,2.8vw,27px)`, weight 800, Satoshi,
  `letter-spacing:-.015em`, with a 14px `--sub` subline.
- Card heading `h3`: 17.5px weight 750.
- **Eyebrow** (the signature element; every card has one):
  `font-size:11.5px; font-weight:700; letter-spacing:.09em;
  text-transform:uppercase; color:var(--accent-deep)`.
- Data values (counts, money, timestamps, config values, audit ids): always
  `--mono`. This is how the site distinguishes "machine truth" from prose.

---

## 4. Layout: the app frame (reuse wholesale)

The two dashboards share one shell; the admin console should be the third
sibling. Steal it from dashboard.html:

- **Grid:** `.app{display:grid;grid-template-columns:264px 1fr}`, sidebar
  collapsible to 78px (`.app.collapsed`), off-canvas below 920px with a
  `rgba(26,37,32,.4)` overlay.
- **Sidebar (`.pane`):** white, right hairline, logo block on top, vertical
  nav of icon+label buttons (`border-radius:12px`; active =
  `--mint` bg + `--accent-deep` text + `inset 3px 0 0 var(--accent)` bar),
  profile card pinned at the bottom.
- **Top bar (`.top`):** sticky, blurred cream
  (`rgba(250,248,243,.92)` + `backdrop-filter:blur(8px)`), burger,
  Satoshi-800 greeting, search input, 38px round avatar
  (`linear-gradient(140deg,var(--ink),var(--accent))`).
- **Content:** `max-width:1180px`, centered, `padding:clamp(18px,2.8vw,30px)`;
  tab views toggled with `.view/.view.on`.
- **Two-column detail layouts:** `.grid2{grid-template-columns:1.62fr 1fr}`
  → single column below 920px.

Admin nav tabs (from the portal plan §8): Overview · Site config · Campaigns ·
Providers · Leads · Deep reads · Audit.

---

## 5. Component language

- **Card:** white, `border:1px solid var(--line)`, `border-radius:20px`,
  `padding:clamp(17px,2.5vw,25px)`, shadow
  `0 1px 2px rgba(26,37,32,.04), 0 8px 24px rgba(26,37,32,.05)`.
  Entry animation `rise` (fade + 10px lift, .5s, staggered ~60ms per card).
- **Buttons:** `border-radius:12px`, `padding:11px 20px`, weight 650.
  Primary = accent green→`--accent-deep` hover (partner console) or terra for
  money-moment CTAs (member). For admin: **green primary, terra reserved for
  destructive confirms** (reject, suspend, kill switch). Ghost variant =
  transparent, `1.5px` border, hover `#EDE8DB`. Disabled = `opacity:.45`.
- **Status pills:** `border-radius:999px`, 12.5px weight 700, leading 7px dot
  (`.statepill::before`); green-mint for good, `--terra-soft`/`#8C4622` for
  warm states. The partner console adds `.pill.won/.lost/.pending/.paid`,
  the right pattern for approval_status.
- **Tables** (from provider-dashboard `.tbl`): hairline row borders, 12px
  uppercase mono column headers in `--sub`, numeric columns right-aligned in
  `--mono`, expandable detail rows for review screens (the bid-desk
  `tr.dwr` expand pattern fits the provider-review screen exactly).
- **Toggles (`.tog`):** 38×22px pill track, `#D9D2BF` off / `--accent` on.
  Use for booleans in site config; the **global kill switch** should be this
  toggle at hero size with a step-up confirm.
- **Toast (`.toast`):** fixed bottom-center, `--ink` bg, white 13.5px text,
  `border-radius:12px`; the standard mutation feedback ("Saved", "Approved,
  email sent").
- **Modal sheet (`.rsheet`):** full-screen `rgba(10,32,24,.45)` scrim, white
  20px-radius panel, max-width 660px, × in a `#F1EEE5` circle; use for
  approve/reject/merge confirms.
- **Progress:** thin bars (`.miniprog`, 6px, `#E7E2D3` track / `--accent`
  fill) and SVG rings (dasharray trick) for anything "N of target".
- **Empty states (`.empty`):** centered line-art SVG (3px strokes, brand
  colors), h3 + one paragraph + one button. Never a bare "no data".
- **Icons:** inline SVG, `stroke:currentColor`, `stroke-width:1.9`, round
  caps, ~19px. No icon fonts, no emoji.

---

## 6. Voice & microcopy

The UI text is a feature. Rules visible across both dashboards:

- Plain, confident, Canadian English; sentence case everywhere (headings,
  buttons, pills). No "Submit", no "Error occurred".
- Buttons state the act: "Approve this company", "Pause all bidding",
  "Place sealed bid".
- Explanatory notes ride in `.fnote`/`.cardnote` (12.5–13px `--sub`) under
  the control, saying *why*, e.g. approval note: "Approval is what unlocks
  this company's console. They'll get an email the moment you do."
- In-progress verbs on async buttons: "Sealing your bid…", "Placing deposit…"
  → admin: "Approving…", "Saving…".
- Numbers and dates always mono, always concrete ("61 of 100 households",
  never "61%").

---

## 7. What to lift from the partner console (desk patterns)

The admin console is operationally closer to the partner console: reuse its
**table + expandable row** bid-desk pattern for the provider-approval queue,
its **stage minirail** (5 dots + connecting lines) for campaign lifecycle
(`planned → waitlist → forming → auction → closed → archived`), its
**stat tiles** (`.card.mt` label/number/subline) for the Overview counts, and
its **agenda list** date-block pattern for recent audit events, but recolour
all of it into the green/terra canon (§2), not forest/gold.

---

## 8. Hard don'ts

- No new fonts, no new hues, no dark mode (the site has none).
- No frameworks/CSS libraries: one static HTML file, inline `<style>`, same
  as every sibling page.
- Don't put prose in `--mono` or data in `--body`; that boundary is the
  design system.
- Don't use `--glow`/`--teal-soft` on light backgrounds (contrast).
- `noindex,nofollow` meta, excluded from sitemap.xml (plan §8).
- Desktop-first; responsive-enough at 920px, but no mobile twin and no
  device-router pairing (plan §8).
