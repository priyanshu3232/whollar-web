// Whollar blog publish pipeline.
// Usage: node scripts/build-blog.mjs <PUBLISH_DATE as YYYY-MM-DD>
//
// Reads the 10 draft posts in blogs/, applies the publish edits (strip prod box,
// strip Draft badge, stamp dates, add canonical), writes each to blog/<slug>/index.html,
// then generates blog/index.html (Resources page), sitemap.xml and robots.txt.
// All metadata on the Resources page is parsed out of each post's own markup.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Canonical host is www — the apex 308-redirects to it, so sitemap/canonical/JSON-LD
// URLs must all be www or Google chases redirects.
const DOMAIN = 'https://www.whollar.ca';
const EM_DASH = '—';

const PUBLISH_DATE = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(PUBLISH_DATE || '')) {
  console.error('Usage: node scripts/build-blog.mjs YYYY-MM-DD');
  process.exit(1);
}

const SLUGS = [
  ['whollar-blog-01-the-487-problem.html', 'overpaying-internet-canada'],
  ['whollar-blog-02-promo-cliff.html', 'internet-price-increase-promo-cliff'],
  ['whollar-blog-03-collective-switching.html', 'collective-switching-internet-canada'],
  ['whollar-blog-04-teksavvy-vs-rogers.html', 'teksavvy-vs-rogers-same-cable'],
  ['whollar-blog-05-bill-breakdown.html', 'internet-bill-breakdown-canada'],
  ['whollar-blog-06-negotiate-bill.html', 'negotiate-internet-bill-canada'],
  ['whollar-blog-07-win-back-offer.html', 'internet-retention-offer-win-back'],
  ['whollar-blog-08-independents-flankers.html', 'independent-internet-providers-canada'],
  ['whollar-blog-09-energy-proof.html', 'collective-switching-energy-proof'],
  ['whollar-blog-10-big-three.html', 'big-three-telecom-canada'],
];
const slugSet = new Set(SLUGS.map(([, s]) => s));

function fail(file, msg) {
  console.error(`FAIL ${file}: ${msg}`);
  process.exit(1);
}

// Remove <div class="prod">...</div> by tracking div nesting from its start tag.
function stripProdBox(html, file) {
  const start = html.indexOf('<div class="prod">');
  if (start === -1) fail(file, 'prod box not found');
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0, end = -1, m;
  while ((m = tag.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { end = m.index + m[0].length; break; }
  }
  if (end === -1) fail(file, 'prod box close tag not found');
  return html.slice(0, start).replace(/[ \t]+$/, '') + html.slice(end).replace(/^\n/, '');
}

function extract(html, re, what, file) {
  const m = html.match(re);
  if (!m) fail(file, `could not extract ${what}`);
  return m[1].trim();
}

const posts = [];

for (const [file, slug] of SLUGS) {
  const src = readFileSync(join('blogs', file), 'utf8');
  const url = `${DOMAIN}/blog/${slug}`;
  let html = src;

  // 0. normalize domains: apex → www everywhere (JSON-LD @id/url included),
  //    then anchor hrefs to root-relative — internal links must never bounce
  //    through the apex 308.
  html = html.replace(/https:\/\/whollar\.ca/g, DOMAIN);
  html = html.replace(/href="https:\/\/www\.whollar\.ca(\/[^"]*)?"/g, (m, path) => `href="${path || '/'}"`);

  // 1. prod box out
  html = stripProdBox(html, file);

  // 2. Draft badge + its separator dot out
  const draftRe = /\s*<span class="dot">·<\/span>\s*<span class="draft">Draft<\/span>/;
  if (!draftRe.test(html)) fail(file, 'draft badge pattern not found');
  html = html.replace(draftRe, '');

  // 3. stamp dates inside BlogPosting JSON-LD
  for (const field of ['datePublished', 'dateModified']) {
    const needle = `"${field}": ""`;
    const count = html.split(needle).length - 1;
    if (count !== 1) fail(file, `expected exactly one empty ${field}, found ${count}`);
    html = html.replace(needle, `"${field}": "${PUBLISH_DATE}"`);
  }

  // 4. canonical straight after the meta description
  const descTag = html.match(/<meta name="description" content="[^"]*">/);
  if (!descTag) fail(file, 'meta description not found');
  html = html.replace(descTag[0], `${descTag[0]}\n<link rel="canonical" href="${url}">`);

  // Verification gates
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (ldBlocks.length !== 2) fail(file, `expected 2 JSON-LD blocks, found ${ldBlocks.length}`);
  let blogPosting;
  for (const [, raw] of ldBlocks) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { fail(file, `JSON-LD does not parse: ${e.message}`); }
    if (parsed['@type'] === 'BlogPosting') blogPosting = parsed;
  }
  if (!blogPosting) fail(file, 'no BlogPosting JSON-LD');
  if (blogPosting['@id'] !== `${url}#article`) fail(file, `@id mismatch: ${blogPosting['@id']}`);
  if (blogPosting.datePublished !== PUBLISH_DATE) fail(file, 'datePublished not stamped');
  if (html.includes(EM_DASH)) fail(file, 'em dash present');
  if (html.includes('class="prod"')) fail(file, 'prod box survived');
  if (html.includes('Draft')) fail(file, 'Draft string survived');

  // internal cross-links must target known slugs (root-relative after step 0)
  for (const [, target] of html.matchAll(/href="\/blog\/([a-z0-9-]+)"/g)) {
    if (!slugSet.has(target)) fail(file, `cross-link to unknown slug: ${target}`);
  }

  // metadata for the Resources page, parsed from the article markup itself
  posts.push({
    slug,
    eyebrow: extract(html, /<span class="eyebrow">([^<]*)<\/span>/, 'eyebrow', file),
    title: extract(html, /<h1>([\s\S]*?)<\/h1>/, 'h1', file),
    deck: extract(html, /<p class="deck">([\s\S]*?)<\/p>/, 'deck', file),
    read: extract(html, /<span>(~\d+ min read)<\/span>/, 'read time', file),
  });

  mkdirSync(join('blog', slug), { recursive: true });
  writeFileSync(join('blog', slug, 'index.html'), html);
  console.log(`ok  /blog/${slug}`);
}

// ---------- Resources page ----------

const tiles = posts.map((p, i) => `      <a class="tile" href="/blog/${p.slug}">
        <div class="tile-top">
          <span class="num">${String(i + 1).padStart(2, '0')}</span>
          <span class="eyebrow">${p.eyebrow}</span>
        </div>
        <h2>${p.title}</h2>
        <p class="deck">${p.deck}</p>
        <div class="meta"><span>${p.read}</span><span class="go">Read the article <span class="arr">&rarr;</span></span></div>
      </a>`).join('\n');

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resources: plain-language reads on internet pricing in Canada · Whollar</title>
<meta name="description" content="Ten plain-language reads from Whollar on internet pricing in Canada: how bills are built, why prices climb after the promo, and how collective switching works.">
<link rel="canonical" href="${DOMAIN}/blog/">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="Resources · Whollar">
<meta property="og:description" content="Ten plain-language reads from Whollar on internet pricing in Canada: how bills are built, why prices climb after the promo, and how collective switching works.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700;12..96,800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600;8..60,700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{
    --paper:#FAFAF5; --card:#FFFEFB; --ink:#0E2A20; --body:#27332C; --muted:#6E7B72;
    --accent:#12805A; --accent-2:#1E9E63; --wash:#EBF3ED; --line:#E5E4DA; --line-2:#D8D7CC;
    --r:22px;
    --sh-1:0 1px 2px rgba(16,40,34,.04),0 8px 24px rgba(16,40,34,.05);
    --sh-2:0 2px 6px rgba(16,40,34,.06),0 18px 44px rgba(16,40,34,.09);
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--paper);color:var(--body);font-family:'Source Serif 4',Georgia,serif;font-size:18px;line-height:1.6}
  a{color:var(--accent);text-decoration:none}

  .mast{border-bottom:1px solid var(--line);background:var(--paper);position:sticky;top:0;z-index:20;backdrop-filter:saturate(120%) blur(6px)}
  .mast .in{max-width:1080px;margin:0 auto;padding:14px 26px;display:flex;align-items:center;justify-content:space-between;gap:16px}
  .brand{display:inline-flex;align-items:center;gap:9px}
  .brand svg{width:30px;height:30px;display:block}
  .brand b{font-family:'Bricolage Grotesque';font-weight:800;font-size:19px;color:var(--ink);letter-spacing:-.01em}
  .mast .cta{font-family:'Space Mono';font-size:12px;font-weight:700;letter-spacing:.02em;color:#fff;background:var(--accent);padding:10px 16px;border-radius:10px;white-space:nowrap}
  .mast .cta:hover{background:var(--accent-2)}

  .hero{max-width:1080px;margin:0 auto;padding:64px 26px 12px}
  .hero .eyebrow{font-family:'Space Mono';font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);display:block;margin-bottom:14px}
  .hero h1{font-family:'Bricolage Grotesque';font-weight:800;font-size:clamp(34px,5.4vw,58px);line-height:1.04;letter-spacing:-.02em;color:var(--ink);margin:0;max-width:16ch}
  .hero .sub{font-size:clamp(18px,2.2vw,21px);color:var(--muted);font-style:italic;line-height:1.5;margin:18px 0 0;max-width:56ch}
  .hero .rule{height:1px;background:var(--line);margin:44px 0 0}

  .grid{max-width:1080px;margin:0 auto;padding:40px 26px 30px;display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:22px}
  .tile{display:flex;flex-direction:column;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:26px 26px 22px;box-shadow:var(--sh-1);transition:transform .25s cubic-bezier(.22,.61,.36,1),box-shadow .25s,border-color .25s}
  .tile:hover{transform:translateY(-4px);box-shadow:var(--sh-2);border-color:var(--accent-2)}
  .tile:first-child{grid-column:1/-1;background:linear-gradient(135deg,var(--card) 55%,var(--wash))}
  .tile:first-child h2{font-size:clamp(24px,3.4vw,34px);max-width:24ch}
  .tile-top{display:flex;align-items:baseline;gap:12px}
  .num{font-family:'Space Mono';font-size:12px;font-weight:700;color:var(--line-2)}
  .tile:hover .num{color:var(--accent-2)}
  .tile .eyebrow{font-family:'Space Mono';font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
  .tile h2{font-family:'Bricolage Grotesque';font-weight:700;font-size:21px;line-height:1.18;letter-spacing:-.01em;color:var(--ink);margin:0}
  .tile:hover h2{color:var(--accent)}
  .tile .deck{font-style:italic;color:var(--muted);font-size:16px;line-height:1.5;margin:0;flex:1}
  .tile .meta{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--line);padding-top:14px;font-family:'Space Mono';font-size:12px;color:var(--muted)}
  .tile .go{color:var(--accent);font-weight:700}
  .tile .arr{display:inline-block;transition:transform .25s cubic-bezier(.22,.61,.36,1)}
  .tile:hover .arr{transform:translateX(4px)}

  footer{margin-top:36px;border-top:1px solid var(--line);padding:26px 0 60px}
  footer .in{max-width:1080px;margin:0 auto;padding:0 26px;font-family:'Space Mono';font-size:12px;color:var(--muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}
  footer a{color:var(--accent)}

  @media(max-width:640px){.grid{grid-template-columns:1fr;padding-top:30px}.hero{padding-top:44px}}
</style>
</head>
<body>

<div class="mast">
  <div class="in">
    <a class="brand" href="/" aria-label="Whollar home">
      <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="wm" x1="18" y1="14" x2="102" y2="106" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0E2A20"/><stop offset="1" stop-color="#1E9E63"/></linearGradient></defs><rect x="6" y="6" width="108" height="108" rx="32" fill="url(#wm)"/><path d="M34 42h52M34 42l26 38M86 42l-26 38" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/><circle cx="34" cy="42" r="11" fill="#fff"/><circle cx="86" cy="42" r="11" fill="#fff"/><circle cx="60" cy="80" r="11" fill="#fff"/></svg>
      <b>Whollar</b>
    </a>
    <a class="cta" href="/join">Join the first cohort</a>
  </div>
</div>

<main>
  <section class="hero">
    <span class="eyebrow">Resources</span>
    <h1>Reading the fine print, so you do not have to.</h1>
    <p class="sub">Ten plain-language reads on internet pricing in Canada: how the bill is built, why the price climbs after the promo, and how collective switching works.</p>
    <div class="rule"></div>
  </section>

  <section class="grid" aria-label="Articles">
${tiles}
  </section>
</main>

<footer>
  <div class="in">
    <span>© 2026 Whollar, now forming the first cohorts.</span>
    <span><a href="/join">Join the first cohort</a> · <a href="/">whollar.ca</a></span>
  </div>
</footer>

</body>
</html>
`;
if (indexHtml.includes(EM_DASH)) fail('blog/index.html', 'em dash present');
writeFileSync(join('blog', 'index.html'), indexHtml);
console.log('ok  /blog/ (Resources page)');

// ---------- sitemap + robots ----------

// The sitemap covers the whole site, not just the blog — regenerating it must
// never drop the money/legal pages again. Static entries carry no lastmod (we
// don't know when they last changed; an invented date is worse than none).
const STATIC_PAGES = ['/', '/bill-checkup', '/become-a-partner', '/partners', '/waitlist/', '/terms', '/privacy'];
const entries = [
  ...STATIC_PAGES.map(p => `  <url><loc>${DOMAIN}${p}</loc></url>`),
  `  <url><loc>${DOMAIN}/blog/</loc><lastmod>${PUBLISH_DATE}</lastmod></url>`,
  ...SLUGS.map(([, s]) => `  <url><loc>${DOMAIN}/blog/${s}</loc><lastmod>${PUBLISH_DATE}</lastmod></url>`),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;
writeFileSync('sitemap.xml', sitemap);
writeFileSync('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${DOMAIN}/sitemap.xml\n`);
console.log(`ok  sitemap.xml (${entries.length} URLs) + robots.txt`);
