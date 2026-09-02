// Whollar mobile blog articles.
// Usage: node scripts/build-mobile-blog.mjs   (also imported at the end of build-blog.mjs)
//
// Reads the PUBLISHED articles in blog/<slug>/index.html and emits mobile-namespace
// copies at MobileVersion/blog/<slug>.html. The article layout is already a fluid
// 700px reading column, so the mobile version is the same document with its link
// namespace swapped to the /MobileVersion pages, the canonical pinned to the
// desktop article, and the device-router include added.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DOMAIN = 'https://internet.whollar.ca';
const ROUTER_TAG = '<script src="/js/device-router.js?v=20260831c"></script>';
const RETURN_TAG = '<script src="/js/blog-return.js?v=20260901a" defer></script>';

const slugs = readdirSync('blog').filter(
  (d) => statSync(join('blog', d)).isDirectory() && existsSync(join('blog', d, 'index.html'))
);
if (!slugs.length) {
  console.error('FAIL: no published articles found under blog/ - run build-blog.mjs first');
  process.exit(1);
}
const slugSet = new Set(slugs);

function fail(slug, msg) {
  console.error(`FAIL ${slug}: ${msg}`);
  process.exit(1);
}

mkdirSync(join('MobileVersion', 'blog'), { recursive: true });

for (const slug of slugs) {
  let html = readFileSync(join('blog', slug, 'index.html'), 'utf8');

  // 1. Pin the canonical to the ABSOLUTE desktop article URL first, so the
  //    generic /blog/ rewrite below can never touch it. Published files carry
  //    either the root-relative or the absolute-www form.
  const canonRe = /<link rel="canonical" href="[^"]*">/;
  if (!canonRe.test(html)) fail(slug, 'canonical not found');
  html = html.replace(canonRe, `<link rel="canonical" href="${DOMAIN}/blog/${slug}">`);

  // 2. Cross-links between articles -> mobile copies.
  html = html.replace(/href="\/blog\/([a-z0-9-]+)"/g, (m, target) => {
    if (!slugSet.has(target)) fail(slug, `cross-link to unknown slug: ${target}`);
    return `href="/MobileVersion/blog/${target}"`;
  });

  // 3. Site links -> mobile namespace. "/waitlist/" also appears inside the
  //    speculationrules JSON and the prefetch hint; a plain string swap covers
  //    all of them. "/bill-checkup" appears as an href and as a speculationrules
  //    href_matches pattern; same deal.
  html = html.split('"/waitlist/"').join('"/MobileVersion/join-the-first-cohort-mobile"');
  html = html.split('"/bill-checkup"').join('"/MobileVersion/bill-checkup-mobile"');
  html = html.split('"/blog/*"').join('"/MobileVersion/blog/*"');
  html = html.split('href="/blog/"').join('href="/MobileVersion/resources-mobile"');
  html = html.split('href="/"').join('href="/MobileVersion/consumer-mobile"');

  // 4. Device-router include (inherited from the desktop article when
  //    build-blog.mjs has already stamped it there; inserted otherwise).
  if (!html.includes(ROUTER_TAG)) {
    const viewport = html.match(/<meta name="viewport"[^>]*>/);
    if (!viewport) fail(slug, 'viewport meta not found');
    html = html.replace(viewport[0], `${viewport[0]}\n${ROUTER_TAG}`);
  }

  // 4b. blog-return include, same inherit-or-insert rule. It has to be here as
  //     well as on the desktop article: a phone reader arriving from the
  //     dashboard lands on this copy, whose back link is
  //     /MobileVersion/resources-mobile, and that page is no more a way back
  //     into the dashboard than /blog/ is.
  if (!html.includes(RETURN_TAG)) {
    html = html.replace(ROUTER_TAG, `${ROUTER_TAG}\n${RETURN_TAG}`);
  }

  // Gates: nothing desktop-namespace may survive outside the canonical/JSON-LD.
  if (html.split(ROUTER_TAG).length - 1 !== 1) fail(slug, 'router include count != 1');
  if (html.split(RETURN_TAG).length - 1 !== 1) fail(slug, 'blog-return include count != 1');
  if (html.includes('"/waitlist/"')) fail(slug, '/waitlist/ survived');
  if (html.includes('href="/"')) fail(slug, 'root href survived');
  if (/href="\/blog\//.test(html)) fail(slug, 'desktop article href survived');
  if (!html.includes(`<link rel="canonical" href="${DOMAIN}/blog/${slug}">`)) fail(slug, 'canonical lost');

  writeFileSync(join('MobileVersion', 'blog', `${slug}.html`), html);
  console.log(`ok  /MobileVersion/blog/${slug}`);
}

console.log(`mobile blog: ${slugs.length} articles written`);
