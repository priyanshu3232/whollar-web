// QA gate for the blog launch. Run against a local `serve` instance:
//   npx serve -l 4173 .   (in another shell)
//   node scripts/qa-blog.mjs http://localhost:4173 2026-07-20
// Exits non-zero if any check fails. Also attempts a 380px render check via
// playwright-core using the system Chrome; reports SKIPPED if unavailable.

const BASE = (process.argv[2] || 'http://localhost:4173').replace(/\/$/, '');
const PUBLISH_DATE = process.argv[3];
const DOMAIN = 'https://www.whollar.ca'; // canonical host: apex 308s to www
const EM_DASH = '—';

const SLUGS = [
  'overpaying-internet-canada',
  'internet-price-increase-promo-cliff',
  'collective-switching-internet-canada',
  'teksavvy-vs-rogers-same-cable',
  'internet-bill-breakdown-canada',
  'negotiate-internet-bill-canada',
  'internet-retention-offer-win-back',
  'independent-internet-providers-canada',
  'collective-switching-energy-proof',
  'big-three-telecom-canada',
  'crtc-internet-prices-canada',
  'cheap-internet-chatham-ontario',
  'best-internet-toronto',
  'internet-speed-how-much-need',
  'rural-internet-ontario',
  'internet-providers-mississauga',
];

// Posts published after the 2026-07-20 launch carry their own dates.
const POST_DATES = {
  'overpaying-internet-canada': '2026-08-01',
  'internet-price-increase-promo-cliff': '2026-08-03',
  'collective-switching-internet-canada': '2026-08-05',
  'teksavvy-vs-rogers-same-cable': '2026-08-07',
  'internet-bill-breakdown-canada': '2026-08-09',
  'negotiate-internet-bill-canada': '2026-08-11',
  'internet-retention-offer-win-back': '2026-08-13',
  'independent-internet-providers-canada': '2026-08-15',
  'collective-switching-energy-proof': '2026-08-17',
  'big-three-telecom-canada': '2026-08-19',
  'crtc-internet-prices-canada': '2026-08-21',
  'cheap-internet-chatham-ontario': '2026-08-23',
  'best-internet-toronto': '2026-08-25',
  'internet-speed-how-much-need': '2026-08-27',
  'rural-internet-ontario': '2026-08-29',
  'internet-providers-mississauga': '2026-08-31',
};

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

async function get(path, redirect = 'follow') {
  const res = await fetch(BASE + path, { redirect });
  return { status: res.status, location: res.headers.get('location'), body: redirect === 'follow' ? await res.text() : '' };
}

// ---- per-post checks ----
for (const slug of SLUGS) {
  const prodUrl = `${DOMAIN}/blog/${slug}`;
  const { status, body } = await get(`/blog/${slug}`);
  console.log(`post /blog/${slug}`);
  check(`${slug}: 200`, status === 200, `got ${status}`);
  if (status !== 200) continue;

  const ld = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  check(`${slug}: exactly 2 JSON-LD`, ld.length === 2, `got ${ld.length}`);
  let blogPosting = null, faq = null, parseOk = true;
  for (const [, raw] of ld) {
    try {
      const p = JSON.parse(raw);
      if (p['@type'] === 'BlogPosting') blogPosting = p;
      if (p['@type'] === 'FAQPage') faq = p;
    } catch { parseOk = false; }
  }
  check(`${slug}: JSON-LD parses`, parseOk);
  check(`${slug}: BlogPosting + FAQPage present`, !!blogPosting && !!faq);
  check(`${slug}: @id = url#article`, blogPosting?.['@id'] === `${prodUrl}#article`, blogPosting?.['@id']);
  const postDate = POST_DATES[slug] || PUBLISH_DATE;
  check(`${slug}: datePublished = ${postDate}`, blogPosting?.datePublished === postDate, blogPosting?.datePublished);
  check(`${slug}: dateModified = ${postDate}`, blogPosting?.dateModified === postDate, blogPosting?.dateModified);

  const canonical = body.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
  check(`${slug}: canonical = url`, canonical === prodUrl, canonical);

  check(`${slug}: no class="prod"`, !body.includes('class="prod"'));
  check(`${slug}: no "Draft"`, !body.includes('Draft'));
  check(`${slug}: no em dash`, !body.includes(EM_DASH));

  for (const [, target] of body.matchAll(/href="\/blog\/([a-z0-9-]+)"/g)) {
    check(`${slug}: cross-link ${target} known`, SLUGS.includes(target), target);
  }
  check(`${slug}: no apex-domain links`, !body.includes('href="https://whollar.ca'));
}

// ---- route resolution (local equivalents of JOIN_ROUTE / CHECKUP_ROUTE) ----
for (const [route, label] of [['/join', 'JOIN_ROUTE /join'], ['/checkup', 'CHECKUP_ROUTE /checkup']]) {
  const { status } = await get(route);
  check(`${label} resolves (follows to 200)`, status === 200, `got ${status}`);
}

// ---- Resources page ----
{
  const { status, body } = await get('/blog/');
  console.log('page /blog/ (Resources)');
  check('/blog/: 200', status === 200, `got ${status}`);
  const tiles = [...body.matchAll(/<a class="tile(?: featured)?" href="\/blog\/([a-z0-9-]+)">/g)].map(m => m[1]);
  check(`/blog/: exactly ${SLUGS.length} tiles`, tiles.length === SLUGS.length, `got ${tiles.length}`);
  check('/blog/: tiles in SLUGS order', JSON.stringify(tiles) === JSON.stringify(SLUGS));
  check('/blog/: tile is the full-card anchor', /<a class="tile"[^>]*>[\s\S]*?<h2>/.test(body));
  check('/blog/: no em dash', !body.includes(EM_DASH));
  check('/blog/: no "Draft"', !body.includes('Draft'));
  for (const slug of SLUGS) {
    const r = await get(`/blog/${slug}`);
    check(`/blog/: tile target ${slug} loads`, r.status === 200, `got ${r.status}`);
  }
}

// ---- homepage nav ----
{
  const { status, body } = await get('/');
  check('homepage: 200', status === 200);
  const navHit = body.includes('href=\\"/blog/\\">Resources') || body.includes('href="/blog/">Resources');
  check('homepage: Resources nav link -> /blog/', navHit);
  check('homepage: no stale resources.html link', !body.includes('resources.html'));
}

// ---- /resources permanent redirect ----
{
  const { status, location } = await get('/resources', 'manual');
  check('/resources: 301/308', status === 301 || status === 308, `got ${status}`);
  check('/resources: Location -> /blog/', (location || '').replace(BASE, '') === '/blog/', location);
}

// ---- sitemap + robots ----
{
  const { status, body } = await get('/sitemap.xml');
  check('sitemap: 200', status === 200);
  const locs = [...body.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  const STATIC_PAGES = ['/', '/bill-checkup', '/become-a-partner', '/partners', '/waitlist/', '/contact', '/terms', '/privacy'];
  const expectedUrls = STATIC_PAGES.length + 1 + SLUGS.length; // static + /blog/ + posts
  check(`sitemap: exactly ${expectedUrls} URLs (${STATIC_PAGES.length} static + blog index + ${SLUGS.length} posts)`, locs.length === expectedUrls, `got ${locs.length}`);
  for (const p of STATIC_PAGES) check(`sitemap: includes ${p}`, locs.includes(`${DOMAIN}${p}`));
  check('sitemap: includes /blog/', locs.includes(`${DOMAIN}/blog/`));
  for (const slug of SLUGS) check(`sitemap: includes ${slug}`, locs.includes(`${DOMAIN}/blog/${slug}`));
  check('sitemap: excludes /resources', !locs.some(l => l.includes('/resources')));
  check('sitemap: all www, no apex', locs.every(l => l.startsWith(DOMAIN)));
  const knownDates = new Set([PUBLISH_DATE, ...Object.values(POST_DATES)]);
  check('sitemap: lastmod is a known publish date', [...body.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].every(m => knownDates.has(m[1])));
  check('sitemap: no em dash', !body.includes(EM_DASH));

  const robots = await get('/robots.txt');
  check('robots.txt: 200', robots.status === 200);
  check('robots.txt: references sitemap', robots.body.includes(`${DOMAIN}/sitemap.xml`));
}

// ---- 380px render check (system Chrome via playwright-core) ----
try {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 380, height: 800 } });
  for (const path of ['/blog/', ...SLUGS.map(s => `/blog/${s}`)]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
    check(`380px render ${path}: no horizontal overflow`, overflow <= 1, `overflow ${overflow}px`);
  }
  await browser.close();
} catch (e) {
  console.log(`SKIPPED 380px render check (${e.message.split('\n')[0]})`);
}

const passed = results.filter(r => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
