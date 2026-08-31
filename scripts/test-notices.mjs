/* Cohort stage notices: one letter per stage, once, to the households in it.
 *
 * Drives lib/notices.js against the same in-memory Data Store the
 * multi-campaign suite uses, so the unique constraint on notice_key is
 * enforced exactly as the console-built table enforces it. The mailer is
 * replaced by a recorder: what is asserted is who was written to, about what,
 * and how many times.
 *
 *   N-1  a cohort never swept before is SEEDED, not announced. Shipping this
 *        must not mail every household about a stage they watched days ago.
 *   N-2  a stage change after that mails every joined household, once.
 *   N-3  a second sweep at the same stage sends nothing. This is the one that
 *        matters: the read path fires it on every dashboard load.
 *   N-4  waitlist places and bells are interest, not membership, and are not
 *        written to.
 *   N-5  the seat ledger counts as membership, the same union cohorts.js uses.
 *   N-6  two campaigns do not contaminate each other's notices.
 *   N-7  every one of the seven member stages has a letter, and each names
 *        its own cohort.
 *
 * Run: node scripts/test-notices.mjs
 */

import { backend } from './backend-module.mjs';

const schema = backend('lib/schema.js');
const ds = backend('lib/datastore.js');
const catalog = backend('lib/catalog.js');
const mailer = backend('lib/mailer.js');
const registry = backend('lib/notify/registry.js');
const layout = backend('lib/notify/layout.js');
const notices = backend('lib/notices.js');
const users = backend('lib/users.js');

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}`); }
}

const TABLES = {};
let nextRowId = 1000;

function tableOf(name) {
  if (!TABLES[name]) TABLES[name] = [];
  return TABLES[name];
}

/** Unique columns per table, straight from the schema declaration, so the
    race guard under test is the one the console-built table enforces. */
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
  const stored = { ...row, ROWID: String(nextRowId++) };
  rows.push(stored);
  return { ...stored };
}

/* The one ZCQL shape lib/datastore.js emits. Lifted from
   scripts/test-multicampaign.mjs rather than rewritten: two fake stores that
   parse slightly differently is two suites that disagree about the database. */
function runSelect(sql) {
  const m = sql.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)\s+WHERE\s+(.+?)(?:\s+ORDER BY ROWID)?(?:\s+LIMIT\s+(\d+))?\s*$/i);
  if (!m) throw new Error(`fake zcql cannot parse: ${sql}`);
  const [, colsRaw, table, whereRaw, limitRaw] = m;
  const clauses = whereRaw.split(/\s+AND\s+/).map((c) => {
    const cm = c.match(/^(\w+)\s*(=|>)\s*(NULL|'[^']*'|[0-9.]+)$/);
    if (!cm) throw new Error(`fake zcql cannot parse clause: ${c}`);
    const val = cm[3] === 'NULL' ? null
      : cm[3].startsWith("'") ? cm[3].slice(1, -1) : Number(cm[3]);
    return { col: cm[1], op: cm[2], val };
  });
  let rows = tableOf(table).filter((r) => clauses.every(({ col, op, val }) => {
    const have = r[col];
    if (op === '=') return val === null ? have == null : String(have) === String(val);
    return Number(have) > Number(val);
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

const app = {
  zcql() { return { executeZCQLQuery: async (sql) => runSelect(sql) }; },
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
        };
      },
    };
  },
};

/* ------------------------------------------------------------------ *
 * The mailer, recorded rather than sent
 * ------------------------------------------------------------------ */

let SENT = [];
const realSend = mailer.send;
mailer.send = async (cfg, message) => {
  SENT.push({ to: message.to, subject: message.subject, text: message.text });
  return { ok: true, transport: 'test', delivered: true };
};

const CFG = { APP_BASE_URL: 'https://www.whollar.ca' };

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function campaign(id, region, kind, dates = {}) {
  return { id, region, sub: 'Autumn cohort', kind, target: 100, biddingOpen: false,
    sortOrder: 0, dates: { announce_at: null, bidding_opens_at: null, bidding_closes_at: null,
      offers_at: null, decision_at: null, switch_window_at: null, reconcile_at: null, ...dates } };
}

function stateOf(c, now) {
  const member = catalog.publicMemberStage(c, now);
  return { id: c.id, memberStage: member.stage, campaign: c };
}

async function addUser(id, email, first) {
  await ds.insertRow(app, 'users', { user_id: id, email_normalized: email, first_name: first });
}

async function addMember(campaignId, userId, status) {
  await ds.insertRow(app, 'campaign_members', {
    membership_key: `${campaignId}:${userId}`, campaign_id: campaignId,
    user_id: userId, status, joined_at: ds.nowDb(),
  });
}

async function addClaim(cohortId, memberId) {
  await ds.insertRow(app, 'seat_claim', {
    claim_key: `${memberId}:internet`, member_id: memberId,
    cohort_id: cohortId, status: 'active',
  });
}

/* users.findById must read our fake table. */
users.findById = async (a, id) => {
  const rows = tableOf('users').filter((r) => r.user_id === String(id));
  return rows[0] || null;
};

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

async function run() {
  console.log('\nN-1/N-2/N-3  seed once, announce once, never twice');
  {
    const c = campaign('alpha', 'Scarborough East', 'forming');
    await addUser('u1', 'one@example.ca', 'Ada');
    await addUser('u2', 'two@example.ca', 'Ben');
    await addMember('alpha', 'u1', 'joined');
    await addMember('alpha', 'u2', 'joined');

    SENT = [];
    let r = await notices.sweep(app, CFG, [stateOf(c, NOW)], NOW);
    ok(r.seeded === 1 && r.sent === 0, `first sight seeds and mails nobody (seeded ${r.seeded}, sent ${r.sent})`);
    ok(SENT.length === 0, 'N-1 no household hears about a stage it already watched happen');

    /* Move it: announce_at in the past makes the member stage `locked`. */
    const moved = campaign('alpha', 'Scarborough East', 'forming', { announce_at: NOW - 1000 });
    SENT = [];
    r = await notices.sweep(app, CFG, [stateOf(moved, NOW)], NOW);
    ok(r.sent === 2, `N-2 the stage change mails both households (sent ${r.sent})`);
    ok(SENT.every((m) => /Scarborough East/.test(m.subject)), 'and the subject names their cohort');
    ok(/locked/i.test(SENT[0].subject) || /brief is fixed/i.test(SENT[0].subject),
      `the letter is the locked one (${SENT[0].subject})`);

    SENT = [];
    r = await notices.sweep(app, CFG, [stateOf(moved, NOW)], NOW);
    ok(r.sent === 0 && SENT.length === 0,
      'N-3 a second sweep at the same stage sends nothing, which is every dashboard load');
  }

  console.log('\nN-4  a bell is never written to, and a waitlist place depends on the cohort');
  {
    /* GATHERING kinds only. On a `planned` region a stored `waitlist` really
       is a waitlist, so neither of these two is a household yet. */
    const c = campaign('beta', 'North York Central', 'planned');
    await addUser('u3', 'three@example.ca', 'Cy');
    await addUser('u4', 'four@example.ca', 'Dee');
    await addMember('beta', 'u3', 'waitlist');
    await addMember('beta', 'u4', 'alert');

    await notices.sweep(app, CFG, [stateOf(c, NOW)], NOW);   // seed
    const moved = campaign('beta', 'North York Central', 'planned', { announce_at: NOW - 1000 });
    SENT = [];
    let r = await notices.sweep(app, CFG, [stateOf(moved, NOW)], NOW);
    ok(r.sent === 0 && SENT.length === 0,
      'on a gathering region, a waitlist place and a bell are both interest, and neither is mailed');

    /* THE SAME TWO ROWS on a cohort that has FORMED. catalog.standingOf
       derives the waitlist place into a real membership the moment the region
       stops gathering, which is the repair that rescued households who joined
       a `planned` region. The notice path must follow that derivation rather
       than read the stored status, or exactly those households are the ones
       who never hear their cohort moved. */
    const formed = campaign('beta', 'North York Central', 'forming', { bidding_opens_at: NOW - 1000 });
    SENT = [];
    r = await notices.sweep(app, CFG, [stateOf(formed, NOW)], NOW);
    ok(r.sent === 1, `once the region forms, the waitlist place is a household and is mailed (sent ${r.sent})`);
    ok(SENT.length === 1 && SENT[0].to === 'three@example.ca',
      'and it is the waitlist place, not the bell');
  }

  console.log('\nN-5  the seat ledger is membership too');
  {
    const c = campaign('gamma', 'Etobicoke Centre', 'forming');
    await addUser('u5', 'five@example.ca', 'Eve');
    await addClaim('gamma', 'u5');                            // ledger only, no snapshot row

    await notices.sweep(app, CFG, [stateOf(c, NOW)], NOW);   // seed
    const moved = campaign('gamma', 'Etobicoke Centre', 'forming', { announce_at: NOW - 1000 });
    SENT = [];
    const r = await notices.sweep(app, CFG, [stateOf(moved, NOW)], NOW);
    ok(r.sent === 1 && SENT[0].to === 'five@example.ca',
      'an active seat claim is a household, the same union cohorts.js counts');
  }

  console.log('\nN-6  two cohorts do not contaminate each other');
  {
    const alphaRows = tableOf('campaign_notices').filter((r) => r.campaign_id === 'alpha');
    const betaRows = tableOf('campaign_notices').filter((r) => r.campaign_id === 'beta');
    ok(alphaRows.length === 2, `alpha carries its own two notices (${alphaRows.length})`);
    ok(betaRows.length === 3, `beta carries its own three notices (${betaRows.length})`);
    ok(alphaRows.every((r) => r.notice_key.startsWith('alpha:')),
      'and every key is scoped to its campaign');
  }

  console.log('\nN-7  seven stages, seven letters, each naming its cohort');
  {
    /* Against the registry, not the old mailer templates. The letters moved
       into lib/notify when the outbox landed, and a test still driving the
       previous copy would go green over dead code while the live copy rotted. */
    const stages = catalog.MEMBER_STAGES;
    ok(stages.length === 7, `catalog names seven member stages (${stages.length})`);

    const entry = registry.get('member.campaign.stage');
    ok(Boolean(entry), 'the stage letter is registered');

    const renderStage = (stage) => {
      const out = registry.render(entry, {
        stage,
        region_label: 'Scarborough East',
        cohort_label: 'Autumn cohort',
        dashboard_url: 'https://www.whollar.ca/dashboard',
        first_name: 'Ada',
      }, { locale: 'en', timezone: 'America/Toronto' });
      return layout.assemble({
        audience: 'member',
        subject: out.subject,
        preheader: out.preheader,
        greeting: out.greeting,
        blocks: out.blocks,
        footer: layout.footerBlocks({
          legalName: 'Whollar',
          postalAddress: '1 Test Street, Toronto ON',
          contactEmail: 'info@whollar.com',
          whyLine: 'You are getting this because you have a Whollar account.',
          preferencesUrl: 'https://www.whollar.ca/dashboard#settings',
        }),
      });
    };

    const missing = [];
    for (const stage of stages) {
      let m = null;
      try { m = renderStage(stage); } catch { missing.push(`${stage} (threw)`); continue; }
      if (!m.subject || !m.text || !m.html) { missing.push(stage); continue; }
      if (!/Scarborough East/.test(m.subject)) missing.push(`${stage} (subject)`);
      if (!/dashboard/i.test(m.text)) missing.push(`${stage} (no link)`);
      if (!m.preheader) missing.push(`${stage} (no preheader)`);
      /* CASL: identification and a postal address on every message, including
         a transactional one. The unsubscribe link is the only part an opt-out
         exemption covers. */
      if (!/Whollar, 1 Test Street/.test(m.text)) missing.push(`${stage} (no address)`);
      if (!/Notification settings/.test(m.text)) missing.push(`${stage} (no settings link)`);
    }
    ok(missing.length === 0, `every stage has a complete letter${missing.length ? ': missing ' + missing.join(', ') : ''}`);

    const em = stages
      .map(renderStage)
      .filter((m) => /[\u2014\u2013]/.test(m.text) || /[\u2014\u2013]/.test(m.subject) || /[\u2014\u2013]/.test(m.html));
    ok(em.length === 0, 'and no letter carries an em or en dash');

    /* Member-facing copy never says the word. Sealed bidding is what partners
       do here; "auction" is the partner console's vocabulary. */
    const auction = stages.map(renderStage).filter((m) => /auction/i.test(m.text));
    ok(auction.length === 0, 'and no letter says the word the member surface never uses');

    let threw = false;
    try { renderStage('not_a_stage'); } catch { threw = true; }
    ok(threw, 'an unknown stage throws rather than rendering an empty letter');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  mailer.send = realSend;
  process.exit(fail ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
