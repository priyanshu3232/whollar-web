/* Multi-campaign concurrency: API-level isolation tests.
 *
 * Two or more campaigns at different lifecycle stages, different partners
 * bidding each, members moving between them, with zero cross-contamination.
 * This drives the REAL route handlers and the real lib code end to end; the
 * only fake is the Catalyst app itself, an in-memory Data Store speaking the
 * ZCQL subset lib/datastore.js emits. Unique-column enforcement comes from
 * lib/schema.js, so the race guards (bid_key, event_key, award_key,
 * membership_key) behave the way the console-built tables do.
 *
 * What is asserted, by number:
 *   EC-10  two partners on two campaigns: zero cross-visibility at the API
 *          response level, both directions.
 *   INV-1  one seat per address per vertical, enforced on the LEGACY join
 *          door as well as the seat routes, with the seat swapping cleanly.
 *   INV-2  one sealed bid per (org, campaign): duplicate place refused,
 *          improve updates in place and appends a revision.
 *   INV-3  seat counts derive from the ledger, per campaign.
 *   P0     the award seals with the winning org's id on it (the org_id
 *          projection regression: a seal that fails here fails silently in
 *          production, so this is the test that keeps it loud).
 *   EC-17/18-lite  a full member-and-bid workout on campaigns A/B/D leaves
 *          campaign C's rows byte-identical.
 *
 * Run: node scripts/test-multicampaign.mjs
 */

import { backend } from './backend-module.mjs';

process.env.ADMIN_EMAIL_DOMAIN = process.env.ADMIN_EMAIL_DOMAIN || 'whollar.com';

const schema = backend('lib/schema.js');
const ds = backend('lib/datastore.js');
const catalog = backend('lib/catalog.js');

/* ------------------------------------------------------------------ *
 * The in-memory Data Store
 * ------------------------------------------------------------------ */

const TABLES = {};
let nextRowId = 1000;

function tableOf(name) {
  if (!TABLES[name]) TABLES[name] = [];
  return TABLES[name];
}

/** Unique columns per table, straight from the schema declaration. */
const UNIQUE = {};
for (const [t, cols] of Object.entries(schema.TABLES || {})) {
  UNIQUE[t] = Object.keys(cols).filter((c) => /\bunique\b/.test(cols[c]));
}

function insert(table, row) {
  const rows = tableOf(table);
  for (const u of UNIQUE[table] || []) {
    if (row[u] == null) continue;
    if (rows.some((r) => String(r[u]) === String(row[u]))) {
      throw new Error(`unique constraint on ${table}.${u}`);
    }
  }
  const stored = { ...row, ROWID: String(nextRowId++), CREATEDTIME: new Date().toISOString() };
  rows.push(stored);
  return { ...stored };
}

/* The one ZCQL shape lib/datastore.js emits:
   SELECT cols FROM t WHERE <conj>[ ORDER BY ROWID][ LIMIT n] */
function runSelect(sql) {
  const m = sql.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)\s+WHERE\s+(.+?)(?:\s+ORDER BY ROWID)?(?:\s+LIMIT\s+(\d+))?\s*$/i);
  if (!m) throw new Error(`fake zcql cannot parse: ${sql}`);
  const [, colsRaw, table, whereRaw, limitRaw] = m;
  const clauses = whereRaw.split(/\s+AND\s+/).map((c) => {
    const cm = c.match(/^(\w+)\s*(=|>)\s*(NULL|'[^']*'|[0-9.]+)$/);
    if (!cm) throw new Error(`fake zcql cannot parse clause: ${c} (in: ${sql})`);
    const val = cm[3] === 'NULL' ? null
      : cm[3].startsWith("'") ? cm[3].slice(1, -1) : Number(cm[3]);
    return { col: cm[1], op: cm[2], val };
  });
  let rows = tableOf(table).filter((r) => clauses.every(({ col, op, val }) => {
    const have = r[col];
    if (op === '=') return val === null ? have == null : String(have) === String(val);
    return Number(have) > Number(val); // ROWID > cursor
  }));
  rows = rows.slice().sort((a, b) => Number(a.ROWID) - Number(b.ROWID));
  if (limitRaw) rows = rows.slice(0, Number(limitRaw));
  const cols = colsRaw.trim() === '*' ? null : colsRaw.split(',').map((s) => s.trim());
  return rows.map((r) => {
    if (!cols) return { ...r };
    const out = {};
    for (const c of cols) out[c] = r[c];
    return out;
  });
}

const fakeApp = {
  zcql() {
    return { executeZCQLQuery: async (sql) => runSelect(sql) };
  },
  datastore() {
    return {
      table(name) {
        return {
          insertRow: async (row) => insert(name, row),
          updateRow: async (row) => {
            const rows = tableOf(name);
            const i = rows.findIndex((r) => String(r.ROWID) === String(row.ROWID));
            if (i < 0) throw new Error(`no row ${row.ROWID} in ${name}`);
            rows[i] = { ...rows[i], ...row };
            return { ...rows[i] };
          },
          deleteRow: async (id) => {
            const rows = tableOf(name);
            const i = rows.findIndex((r) => String(r.ROWID) === String(id));
            if (i >= 0) rows.splice(i, 1);
            return true;
          },
        };
      },
    };
  },
  cache() { throw new Error('no cache in the fake app'); },
};

/* ------------------------------------------------------------------ *
 * Route plumbing
 * ------------------------------------------------------------------ */

function fakeRouter() {
  const routes = {};
  const reg = (m) => (path, h) => { routes[`${m} ${path}`] = h; };
  return { routes, get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
}

function makeReq(user, { params = {}, body = {}, query = {}, headers = {} } = {}) {
  return {
    catalyst: fakeApp,
    auth: user ? { user, session: { session_id: 's-' + user.user_id } } : null,
    params, body, query, headers,
    id: 'req-test',
    ip: '127.0.0.1',
    path: '/test',
    /* audit.record reads the app config for the ip pepper; an empty cfg is
       enough for a best-effort audit row in a test. */
    app: { get: () => ({}) },
    get: (h) => headers[String(h).toLowerCase()],
  };
}

function invoke(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); },
    };
    const next = (err) => {
      if (!err) return resolve({ status: 500, body: { error: { code: 'NO_RESPONSE' } } });
      const status = err.status || 500;
      resolve({
        status,
        body: { error: { code: err.code || 'SERVER_ERROR', message: err.message, ...(err.extra || {}) } },
      });
    };
    try {
      handler(req, res, next);
    } catch (err) { next(err); }
  });
}

/* ------------------------------------------------------------------ *
 * Seed: three concurrent campaigns, two partners, two members
 * ------------------------------------------------------------------ */

const NOW = Date.now();
const H = 3600 * 1000;
const D = 24 * H;

function campaignRow(id, region, kind, extra = {}) {
  return {
    campaign_id: id, region, sub: 'Autumn cohort', kind,
    target: 100, seed_members: 0, seed_households: 0,
    bidding_open: kind === 'auction', sort_order: 50,
    updated_by: 'seed', updated_at: ds.nowDb(),
    announce_at: null, bidding_opens_at: null, bidding_closes_at: null,
    offers_at: null, decision_at: null, switch_window_at: null, reconcile_at: null,
    ...extra,
  };
}

/* A: auction, open, P1's region. C: auction, open, P2's region. B and D:
   forming, joinable, for the member seat tests. */
insert('campaigns', campaignRow('camp-a', 'Etobicoke Centre', 'auction', {
  bidding_opens_at: ds.toDb(new Date(NOW - 2 * H)),
  bidding_closes_at: ds.toDb(new Date(NOW + 2 * H)),
}));
insert('campaigns', campaignRow('camp-c', 'Kleinburg', 'auction', {
  bidding_opens_at: ds.toDb(new Date(NOW - 2 * H)),
  bidding_closes_at: ds.toDb(new Date(NOW + 3 * H)),
}));
insert('campaigns', campaignRow('camp-b', 'Scarborough Southwest', 'forming', {
  announce_at: ds.toDb(new Date(NOW + 2 * D)),
}));
insert('campaigns', campaignRow('camp-d', 'North York Central', 'forming', {
  announce_at: ds.toDb(new Date(NOW + 3 * D)),
}));

const userRow = (id, type, extra = {}) => insert('users', {
  user_id: id, email_normalized: `${id}@example.ca`, email_display: `${id}@example.ca`,
  user_type: type, status: 'active', fsa: 'M9C', ...extra,
});
const M1 = userRow('m1', 'member');
const M2 = userRow('m2', 'member', { referral_code: 'WHL-REFERRER1' });
const P1U = userRow('p1u', 'provider');
const P2U = userRow('p2u', 'provider');

insert('provider_orgs', { org_id: 'org-p1', legal_name: 'NorthGrid Fibre', email_domain: 'northgrid.ca', approval_status: 'approved' });
insert('provider_orgs', { org_id: 'org-p2', legal_name: 'Maple Broadband', email_domain: 'maplebb.ca', approval_status: 'approved' });
insert('provider_users', { user_id: 'p1u', org_id: 'org-p1', role: 'admin' });
insert('provider_users', { user_id: 'p2u', org_id: 'org-p2', role: 'admin' });
insert('provider_coverage', { coverage_key: 'org-p1:etobicoke-centre', org_id: 'org-p1', region: 'Etobicoke Centre', techs: 'fibre', status: 'active', updated_at: ds.nowDb() });
insert('provider_coverage', { coverage_key: 'org-p2:kleinburg', org_id: 'org-p2', region: 'Kleinburg', techs: 'cable', status: 'active', updated_at: ds.nowDb() });
for (const org of ['org-p1', 'org-p2']) {
  insert('provider_terms', {
    acceptance_key: `${org}:cohort_terms:v1`, org_id: org, doc_type: 'cohort_terms',
    doc_version: 'v1', accepted_at: ds.nowDb(), accepted_by: org === 'org-p1' ? 'p1u' : 'p2u',
  });
}
/* m1 joined camp-a while it was forming: the membership the offer read needs. */
insert('campaign_members', {
  membership_key: 'camp-a:m1', campaign_id: 'camp-a', user_id: 'm1',
  status: 'joined', fsa: 'M9C', joined_at: ds.nowDb(),
});

/* ------------------------------------------------------------------ *
 * Mount the real routes
 * ------------------------------------------------------------------ */

const router = fakeRouter();
backend('routes/campaigns.js').mount(router);
backend('routes/desk.js').mount(router);
backend('routes/seat.js').mount(router);
backend('routes/admin.js').mount(router, { FEATURES: { admin: true }, ADMIN_EMAIL_DOMAIN: 'whollar.com' });
const cohorts = backend('lib/cohorts.js');

const R = router.routes;

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

let passed = 0; let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}

const bidBody = (campaign, price, cap) => ({
  campaign,
  tiers: [{ name: '300 Mbps', uploadMbps: '50', technology: 'fibre', stickerPrice: String(price + 20), effectivePrice: String(price) }],
  guaranteeMonths: 24, afterMode: 'none', reductionPresentation: 'member',
  equipment: 'inc', committedHouseholds: cap,
});

/* The response minus its clocks. serverTime is not the only one: the campaign
   dates are epoch-ms too, and any such run of digits can contain the two-digit
   price under test, which made the leak checks below fail at random rather than
   on a real leak. So blank every long digit run, not serverTime alone. Prices,
   org ids and campaign ids are all short, so nothing a leak check hunts for is
   masked by this. */
const blobOf = (body) => JSON.stringify({ ...body, serverTime: undefined }).replace(/\d{9,}/g, '<clock>');

const snapshot = (campaignId) => JSON.stringify({
  bids: tableOf('provider_bids').filter((r) => r.campaign_id === campaignId),
  revisions: tableOf('bid_revisions').filter((r) => r.campaign_id === campaignId),
  members: tableOf('campaign_members').filter((r) => r.campaign_id === campaignId),
  awards: tableOf('campaign_awards').filter((r) => r.campaign_id === campaignId),
});

async function main() {
  console.log('\n1. two partners, two auctions: sealed bids land on the right campaign');
  let r = await invoke(R['POST /provider/bids'], makeReq(P1U, { body: bidBody('camp-a', 58, 1) }));
  ok(r.status === 200 && r.body.ok, `P1 places on camp-a (${r.status} ${r.body.error ? r.body.error.message : 'ok'})`);
  r = await invoke(R['POST /provider/bids'], makeReq(P2U, { body: bidBody('camp-c', 61, 1) }));
  ok(r.status === 200 && r.body.ok, `P2 places on camp-c (${r.status})`);
  ok(tableOf('provider_bids').length === 2, 'two head rows, one per (org, campaign)');
  const keys = tableOf('provider_bids').map((b) => b.bid_key).sort().join(',');
  ok(keys === 'camp-a:org-p1,camp-c:org-p2', `bid keys carry their own campaign (${keys})`);

  console.log('\n2. INV-2: the duplicate place is refused, the improve updates in place');
  r = await invoke(R['POST /provider/bids'], makeReq(P1U, { body: bidBody('camp-a', 57, 1) }));
  ok(r.status === 409, `second place on the same cohort is a 409 (${r.status})`);
  r = await invoke(R['POST /provider/bids/:campaign/improve'], makeReq(P1U, { params: { campaign: 'camp-a' }, body: bidBody('camp-a', 55, 1) }));
  ok(r.status === 200 && r.body.ok, `the improve lands (${r.status})`);
  const heads = tableOf('provider_bids').filter((b) => b.bid_key === 'camp-a:org-p1');
  ok(heads.length === 1, 'still one head row after improving');
  ok(String(heads[0].price) === '55' && heads[0].status === 'improved', `head updated in place ($${heads[0].price}, ${heads[0].status})`);
  ok(tableOf('bid_revisions').filter((v) => v.bid_key === 'camp-a:org-p1').length === 2, 'and the trail holds two revisions');

  console.log('\n3. EC-10: zero cross-visibility at the API response level');
  r = await invoke(R['GET /provider/bids'], makeReq(P1U));
  let blob = blobOf(r.body);
  ok(r.status === 200 && (r.body.bids || []).length === 1, 'P1 sees exactly their own bid list');
  ok(!blob.includes('camp-c') && !blob.includes('61') && !blob.includes('org-p2'),
    'P1 response carries no trace of camp-c, P2, or P2 price');
  r = await invoke(R['GET /provider/bids'], makeReq(P2U));
  blob = blobOf(r.body);
  ok(!blob.includes('camp-a') && !blob.includes('55') && !blob.includes('org-p1'),
    'P2 response carries no trace of camp-a, P1, or P1 price');
  r = await invoke(R['GET /provider/campaigns/:id/brief'], makeReq(P2U, { params: { id: 'camp-a' } }));
  blob = blobOf(r.body);
  ok(r.status === 200 && !blob.includes('55') && !blob.includes('org-p1') && (!r.body.bid),
    'P2 reading camp-a\'s brief sees the cohort, never P1\'s bid');

  console.log('\n4. the seal: award carries the winning org (the silent-failure regression)');
  const snapC1 = snapshot('camp-c');
  const aRow = tableOf('campaigns').find((c) => c.campaign_id === 'camp-a');
  aRow.bidding_closes_at = ds.toDb(new Date(NOW - 60 * 1000));
  catalog.invalidate();
  r = await invoke(R['GET /campaigns/:id/offer'], makeReq(M1, { params: { id: 'camp-a' } }));
  ok(r.status === 200 && r.body.sealed === false, `the member offer opens after the close (${r.status})`);
  const award = tableOf('campaign_awards').find((a) => a.campaign_id === 'camp-a');
  ok(Boolean(award), 'the award row sealed');
  ok(award && award.org_id === 'org-p1', `and it names the winning org (${award && award.org_id})`);
  ok(r.body.offer && r.body.offer.partner === 'NorthGrid Fibre', `the household reads the winner's name (${r.body.offer && r.body.offer.partner})`);
  ok(typeof r.body.serverTime === 'number', 'and the offer response carries serverTime');
  ok(tableOf('campaign_awards').filter((a) => a.campaign_id === 'camp-c').length === 0,
    'camp-c, still open, sealed nothing');

  console.log('\n5. INV-1 through the LEGACY join door');
  r = await invoke(R['POST /campaigns/join'], makeReq(M2, { body: { campaign: 'camp-b' } }));
  ok(r.status === 200, `m2 joins camp-b through POST /campaigns/join (${r.status})`);
  ok(typeof r.body.serverTime === 'number', 'the join response carries serverTime');
  const claim = tableOf('seat_claim').find((c) => c.address_id === 'm2/1');
  ok(claim && claim.status === 'active' && claim.cohort_id === 'camp-b',
    `the legacy door wrote the seat claim (${claim && claim.cohort_id})`);
  const mrow = tableOf('campaign_members').find((m) => m.membership_key === 'camp-b:m2');
  ok(mrow && mrow.referral_code === 'WHL-REFERRER1',
    'and stamped the referral attribution with the campaign actually joined');
  r = await invoke(R['POST /campaigns/join'], makeReq(M2, { body: { campaign: 'camp-d' } }));
  ok(r.status === 409 && r.body.error.code === 'SEAT_HELD',
    `a second forming cohort refuses with SEAT_HELD (${r.status} ${r.body.error && r.body.error.code})`);
  ok(r.body.error.held_cohort && r.body.error.held_cohort.id === 'camp-b',
    'naming the held cohort');
  ok(!tableOf('campaign_members').some((m) => m.membership_key === 'camp-d:m2'),
    'and no camp-d membership row leaked through');

  console.log('\n6. leave releases the seat on the right ledger, then the other cohort takes it');
  r = await invoke(R['POST /campaigns/leave'], makeReq(M2, { body: { campaign: 'camp-b' } }));
  ok(r.status === 200, `m2 leaves camp-b (${r.status})`);
  ok(claim.status !== 'active' || tableOf('seat_claim').find((c) => c.address_id === 'm2/1').status === 'released',
    'the claim is released, not orphaned');
  const counterB = tableOf('cohort_counter').find((c) => c.cohort_id === 'camp-b');
  ok(counterB && Number(counterB.roster_count) === 0, `camp-b's ledger says 0 (${counterB && counterB.roster_count})`);
  r = await invoke(R['POST /campaigns/join'], makeReq(M2, { body: { campaign: 'camp-d' } }));
  ok(r.status === 200, `and camp-d now takes the join (${r.status})`);
  const claim2 = tableOf('seat_claim').find((c) => c.address_id === 'm2/1');
  ok(claim2 && claim2.status === 'active' && claim2.cohort_id === 'camp-d',
    'one claim row, swapped to the new cohort');
  const counterD = tableOf('cohort_counter').find((c) => c.cohort_id === 'camp-d');
  ok(counterD && Number(counterD.roster_count) === 1, `camp-d's ledger says 1 (${counterD && counterD.roster_count})`);
  ok(tableOf('claim_event').filter((e) => e.address_id === 'm2/1').length >= 3,
    'every transition appended to the claim spine');

  console.log('\n7. the bystander: camp-c\'s rows are byte-identical through all of it');
  ok(snapshot('camp-c') === snapC1, 'camp-c rows unchanged through A\'s close and B/D\'s member churn');

  console.log('\n8. member list: per-campaign standing, one payload');
  r = await invoke(R['GET /campaigns'], makeReq(M2));
  const you = {};
  (r.body.campaigns || []).forEach((c) => { you[c.id] = c.you; });
  ok(you['camp-d'] === 'joined' && !you['camp-b'] && !you['camp-a'],
    `m2's standing is per campaign (d=${you['camp-d']}, b=${you['camp-b']}, a=${you['camp-a']})`);
  ok(typeof r.body.serverTime === 'number' && (r.body.campaigns || []).length === 4,
    'one clock, all four campaigns in one answer');

  console.log('\n9. SYNC: N members join, and every surface answers N from one read layer');
  /* A fresh forming cohort with a target, so the count starts at zero and the
     roster cap is exercised too. Three members through the two doors that
     exist: the legacy POST /campaigns/join and POST /cohorts/:id/join. */
  insert('campaigns', campaignRow('camp-e', 'Vaughan Woodbridge', 'forming', {
    announce_at: ds.toDb(new Date(NOW + 4 * D)), target: 3,
    /* Seed baselines on the row, deliberately: they must reach NO count. */
    seed_members: 64, seed_households: 112,
  }));
  catalog.invalidate();
  const M3 = userRow('m3', 'member');
  const M4 = userRow('m4', 'member');
  const M5 = userRow('m5', 'member');
  const M6 = userRow('m6', 'member');
  const ADMIN = userRow('staff', 'admin', { email_normalized: 'staff@whollar.com' });

  r = await invoke(R['GET /provider/campaigns'], makeReq(P1U));
  let e = (r.body.campaigns || []).find((c) => c.id === 'camp-e');
  ok(e && e.households === 0 && e.members === 0, `before any join the partner sees 0, not the 112 seed (${e && e.households})`);
  r = await invoke(R['GET /campaigns'], makeReq(M3));
  e = (r.body.campaigns || []).find((c) => c.id === 'camp-e');
  ok(e && e.households === 0, `and so does the member (${e && e.households})`);
  ok(r.body.source === 'table', 'the member payload names its source');

  r = await invoke(R['POST /campaigns/join'], makeReq(M3, { body: { campaign: 'camp-e' } }));
  ok(r.status === 200 && r.body.campaign.households === 1, `m3 joins by the legacy door: the reply already says 1 (${r.body.campaign && r.body.campaign.households})`);
  r = await invoke(R['POST /cohorts/:id/join'], makeReq(M4, { params: { id: 'camp-e' }, headers: { 'idempotency-key': 'join-m4-camp-e-0001' } }));
  ok(r.status === 200 && r.body.cohort && r.body.cohort.roster_count === 2, `m4 joins by the seat route: the ledger reply says 2 (${r.body.cohort && r.body.cohort.roster_count})`);
  r = await invoke(R['POST /campaigns/join'], makeReq(M5, { body: { campaign: 'camp-e' } }));
  ok(r.status === 200, `m5 joins (${r.status})`);

  /* Within the memo window, without waiting: the writes invalidated it. */
  r = await invoke(R['GET /provider/campaigns'], makeReq(P1U));
  e = (r.body.campaigns || []).find((c) => c.id === 'camp-e');
  ok(e && e.households === 3 && e.signups === 3, `the partner desk reads 3 immediately (${e && e.households})`);
  r = await invoke(R['GET /provider/campaigns/:id/brief'], makeReq(P1U, { params: { id: 'camp-e' } }));
  ok(r.status === 200 && r.body.brief.households === 3 && r.body.campaign.households === 3, `the brief reads 3 (${r.body.brief && r.body.brief.households})`);
  r = await invoke(R['GET /campaigns'], makeReq(M4));
  e = (r.body.campaigns || []).find((c) => c.id === 'camp-e');
  ok(e && e.households === 3 && e.you === 'joined', `the member dashboard reads 3 and m4's own standing (${e && e.households}, ${e && e.you})`);
  r = await invoke(R['GET /me/seat'], makeReq(M4));
  ok(r.status === 200 && r.body.cohort && r.body.cohort.roster_count === 3, `the seat ledger reads 3 (${r.body.cohort && r.body.cohort.roster_count})`);
  r = await invoke(R['POST /campaigns/join'], makeReq(M6, { body: { campaign: 'camp-e' } }));
  ok(r.status === 409 && r.body.error.code === 'ROSTER_FULL', `a fourth join against target 3 is ROSTER_FULL, on the real count (${r.status} ${r.body.error && r.body.error.code})`);

  /* The memo really is a memo: a row written behind its back is invisible
     for up to 60s, and visible the moment the layer is invalidated. */
  insert('campaign_members', { membership_key: 'camp-e:ghost', campaign_id: 'camp-e', user_id: 'ghost', status: 'joined', joined_at: ds.nowDb() });
  ok((await cohorts.seatCount(fakeApp, 'camp-e')).seats === 3, 'a write that bypassed the layer is not seen inside the memo window');
  cohorts.invalidate('camp-e');
  ok((await cohorts.seatCount(fakeApp, 'camp-e')).seats === 4, 'and is seen the moment the memo is invalidated');
  tableOf('campaign_members').splice(tableOf('campaign_members').findIndex((m) => m.user_id === 'ghost'), 1);
  cohorts.invalidate('camp-e');

  /* A legacy row: joined before the ledger existed, no claim. Counted once. */
  insert('campaign_members', { membership_key: 'camp-e:legacy', campaign_id: 'camp-e', user_id: 'legacy', status: 'joined', joined_at: ds.nowDb() });
  /* And a bell: interest, never a seat. */
  insert('campaign_members', { membership_key: 'camp-e:m6', campaign_id: 'camp-e', user_id: 'm6', status: 'alert', joined_at: ds.nowDb() });
  cohorts.invalidate('camp-e');
  const cnt = await cohorts.seatCount(fakeApp, 'camp-e');
  ok(cnt.seats === 4 && cnt.watching === 1, `a pre-ledger joined row counts, a bell does not (${cnt.seats} seats, ${cnt.watching} watching)`);

  r = await invoke(R['GET /admin/campaigns/reconcile'], makeReq(ADMIN));
  ok(r.status === 200 && r.body.ok, `the drift check answers (${r.status})`);
  ok(r.body.surfaces.member_only.length === 0 && r.body.surfaces.partner_only.length === 0, 'members and partners see the same campaign set');
  const re = (r.body.campaigns || []).find((c) => c.id === 'camp-e');
  ok(re && re.households_member === 4 && re.households_partner === 4, `both projections of camp-e say 4 (${re && re.households_member}/${re && re.households_partner})`);
  ok(re && re.seat_claims === 3 && re.joined_rows === 4, `raw reads: 3 claims, 4 joined rows (${re && re.seat_claims}/${re && re.joined_rows})`);
  const legacyFlag = (r.body.mismatches || []).find((m) => m.kind === 'legacy_rows' && m.campaign === 'camp-e');
  ok(Boolean(legacyFlag), 'and the pre-ledger row is named as a legacy row');
  ok(!(r.body.mismatches || []).some((m) => m.kind === 'surface_count'), 'no surface disagrees with another');
  ok(r.body.surfaces.partner_biddable.join(',') === 'camp-a,camp-c' || r.body.surfaces.partner_biddable.sort().join(',') === 'camp-a,camp-c',
    `open for sealed bidding is exactly the two auctions (${r.body.surfaces.partner_biddable.join(',')})`);
  ok(!blobOf(r.body).includes('m3@') && !blobOf(r.body).includes('m4'), 'no member identity in the drift report');

  /* Drift in the sidecar counter is reported, never rendered. */
  const counterE = tableOf('cohort_counter').find((c) => c.cohort_id === 'camp-e');
  counterE.roster_count = 99;
  r = await invoke(R['GET /provider/campaigns'], makeReq(P1U));
  e = (r.body.campaigns || []).find((c) => c.id === 'camp-e');
  ok(e && e.households === 4, `a drifted cohort_counter reaches no partner (${e && e.households})`);
  r = await invoke(R['GET /admin/campaigns/reconcile'], makeReq(ADMIN));
  ok((r.body.mismatches || []).some((m) => m.kind === 'counter_drift' && m.campaign === 'camp-e'), 'but the drift check names it');
  counterE.roster_count = 3;

  console.log('\n10. GHOSTS: the shipped code catalog never reaches a member or a partner');
  const saved = tableOf('campaigns').splice(0);
  catalog.invalidate(); cohorts.invalidate();
  r = await invoke(R['GET /campaigns'], makeReq(M3));
  ok(r.status === 200 && r.body.source === 'code' && r.body.campaigns.length === 0, `empty table: the member list is empty and says source=code (${r.body.source}, ${r.body.campaigns.length})`);
  r = await invoke(R['GET /provider/campaigns'], makeReq(P1U));
  ok(r.status === 200 && r.body.source === 'code' && r.body.campaigns.length === 0, `and so is the partner list (${r.body.source}, ${r.body.campaigns.length})`);
  r = await invoke(R['GET /admin/campaigns'], makeReq(ADMIN));
  ok(r.status === 200 && r.body.source === 'code' && r.body.campaigns.length === 6, `the admin still sees the six to import (${r.body.campaigns.length})`);
  r = await invoke(R['GET /admin/campaigns/reconcile'], makeReq(ADMIN));
  ok((r.body.mismatches || []).some((m) => m.kind === 'code_catalog'), 'and the drift check says the table is empty');
  ok((r.body.mismatches || []).some((m) => m.kind === 'orphan_memberships' && m.campaign === 'camp-e'), 'and names the membership rows now pointing at no campaign');
  tableOf('campaigns').push(...saved);
  catalog.invalidate(); cohorts.invalidate();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
