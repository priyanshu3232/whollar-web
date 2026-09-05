/* The notification outbox: what may be sent, when, and never twice.
 *
 * Drives lib/notify against the same in-memory Data Store the multi-campaign
 * and notices suites use, so the unique constraints under test are the ones
 * the console-built tables enforce. The transport is replaced by a recorder:
 * what is asserted is who was written to, when it was allowed to go, and how
 * many times.
 *
 *   O-1   the same fact enqueued twice is one row and one letter
 *   O-2   a suppressed address is refused, and which suppression matters
 *   O-3   quiet hours hold informational mail and never hold a sign-in code
 *   O-4   partner contacts are business inboxes and are never held
 *   O-5   a missing required key fails the row rather than sending a blank
 *   O-6   two stage letters in one burst supersede rather than both arriving
 *   O-7   the claim is what stops two drains sending the same letter
 *   O-8   CASL: identification and an address on everything, an unsubscribe
 *         only where an opt-out applies, and a commercial send refused
 *         outright when no postal address is configured
 *   O-9   an unsubscribe token resolves, applies once, and applies again
 *         without erroring
 *   O-10  the privacy scrubber blocks a partner letter naming another partner
 *   O-11  the webhook suppresses on a hard bounce and a complaint, and drops
 *         an open
 *   O-21  each transport sends as an address it is actually allowed to use,
 *         and a failed send tells the caller why
 *   O-23  a sign-in code that outlived its own TTL is cancelled, never sent
 *   O-24  a store that cannot find a row it just wrote still sends the code
 *
 * Run: node scripts/test-notify.mjs
 */

import { backend } from './backend-module.mjs';

const schema = backend('lib/schema.js');
const ds = backend('lib/datastore.js');
const mailer = backend('lib/mailer.js');
const outbox = backend('lib/notify/outbox.js');
const unsub = backend('lib/notify/unsub.js');
const suppress = backend('lib/notify/suppress.js');
const optoken = backend('lib/notify/optoken.js');
const notifyRoutes = backend('routes/notify.js');
const registry = backend('lib/notify/registry.js');
const layout = backend('lib/notify/layout.js');

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}`); }
}

let TABLES = {};
let nextRowId = 1000;
const tableOf = (name) => (TABLES[name] || (TABLES[name] = []));

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

/* The one ZCQL shape lib/datastore.js emits, lifted from the notices suite so
   two fake stores cannot disagree about the database. */
function runSelect(sql) {
  const m = sql.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)\s+WHERE\s+(.+?)(?:\s+ORDER BY ROWID)?(?:\s+LIMIT\s+(\d+))?\s*$/i);
  if (!m) throw new Error(`fake zcql cannot parse: ${sql}`);
  const [, colsRaw, table, whereRaw, limitRaw] = m;
  const known = new Set(Object.keys(schema.TABLES[table] || {}).concat(['ROWID']));
  const clauses = whereRaw.split(/\s+AND\s+/).map((c) => {
    const cm = c.match(/^(\w+)\s*(=|>)\s*(NULL|'[^']*'|[0-9.]+)$/);
    if (!cm) throw new Error(`fake zcql cannot parse clause: ${c}`);
    const val = cm[3] === 'NULL' ? null
      : cm[3].startsWith("'") ? cm[3].slice(1, -1) : Number(cm[3]);
    return { col: cm[1], op: cm[2], val };
  });
  /* A column the declared schema does not have is what a missing console
     column looks like from here, so the fake store throws exactly as the real
     one does and the column ladders are actually exercised. */
  for (const c of (colsRaw.trim() === '*' ? [] : colsRaw.split(',').map((x) => x.trim()))) {
    if (!known.has(c)) throw new Error(`no column ${table}.${c}`);
  }
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

/* PRODUCTION, 2026-08-31: `insertRow` reported success and a SELECT by
   `notify_key` a millisecond later returned nothing, so every inline send had
   no row to send and no email left the product for a day. Whether the cause
   was ZCQL lagging its own write or a console column narrower than the
   64-character key, the store behaved exactly like this. */
let BLIND_KEY_LOOKUP = false;

const app = {
  zcql() {
    return {
      executeZCQLQuery: async (sql) => (
        BLIND_KEY_LOOKUP && /WHERE\s+notify_key\s*=/i.test(sql) ? [] : runSelect(sql)
      ),
    };
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
          deleteRow: async (rowId) => {
            const rows = tableOf(name);
            const i = rows.findIndex((r) => String(r.ROWID) === String(rowId));
            if (i >= 0) rows.splice(i, 1);
            return true;
          },
        };
      },
    };
  },
};

/* ------------------------------------------------------------------ *
 * The transport, recorded rather than sent
 * ------------------------------------------------------------------ */

let SENT = [];
let FAIL_NEXT = null;
const realSend = mailer.send;
mailer.send = async (cfg, message) => {
  if (FAIL_NEXT) {
    const err = new Error(FAIL_NEXT.message);
    err.retryable = FAIL_NEXT.retryable;
    FAIL_NEXT = null;
    throw err;
  }
  SENT.push({
    to: message.to, subject: message.subject, text: message.text, html: message.html,
    headers: message.headers || {}, clientReference: message.clientReference,
    messageId: message.messageId, from: message.from,
  });
  return { ok: true, transport: 'test', delivered: true, messageId: `pm-${SENT.length}` };
};

const CFG = {
  APP_BASE_URL: 'https://www.whollar.ca',
  MAIL_LEGAL_NAME: 'Whollar',
  MAIL_POSTAL_ADDRESS: '1 Example Street, Toronto ON M5V 0A1',
  MAIL_REPLY_TO: 'info@whollar.com',
  MAIL_FROM_TRANSACTIONAL: 'no-reply@mail.whollar.com',
  MAIL_FROM_CEM: 'news@news.whollar.com',
  MAIL_WEBHOOK_SECRET: 'hook-secret-value',
  FEATURES: { mail: false },
};

const reset = () => { TABLES = {}; SENT = []; FAIL_NEXT = null; BLIND_KEY_LOOKUP = false; };

const events = backend('lib/notify/events.js');
const reminders = backend('lib/notify/reminders.js');
const csrf = backend('lib/csrf.js');

/* A request object with only what lib/notify needs off it. */
const fakeReq = () => ({
  id: 'test-req',
  catalyst: app,
  app: { get: (k) => (k === 'cfg' ? CFG : null) },
});

const FOOTER = layout.footerBlocks({
  legalName: 'Whollar',
  postalAddress: '1 Example Street, Toronto ON M5V 0A1',
  contactEmail: 'info@whollar.com',
  whyLine: 'You are getting this because you are a founding partner.',
  preferencesUrl: 'https://www.whollar.ca/partner#account',
});

const renderWith = (entry, ctx) => {
  const out = registry.render(entry, ctx, { locale: 'en', timezone: 'America/Toronto' });
  return { subject: out.subject, preheader: out.preheader, greeting: out.greeting, blocks: out.blocks };
};

const member = (id, email, extra = {}) => ({
  type: 'member', id, email, locale: 'en', timezone: 'America/Toronto',
  firstName: 'Sam', ...extra,
});

const stageCtx = (stage = 'locked') => ({
  stage,
  region_label: 'Brampton East',
  cohort_label: 'Winter cohort',
  dashboard_url: 'https://www.whollar.ca/dashboard',
  first_name: 'Sam',
});

/* Deterministic clocks, both expressed as the recipient's own local time.
   14:00 in Toronto is the middle of the working day; 02:00 is inside quiet
   hours in every month, whichever side of the daylight change we are on. */
const NOON_ET = Date.UTC(2026, 7, 27, 18, 0, 0);   // 14:00 America/Toronto
const NIGHT_ET = Date.UTC(2026, 7, 27, 6, 0, 0);   // 02:00 America/Toronto

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function run() {

  console.log('\nO-1  the same fact enqueued twice is one row and one letter');
  {
    reset();
    const spec = {
      templateKey: 'member.campaign.stage',
      eventKey: 'campaign.stage:brampton-east:locked',
      recipient: member('u1', 'one@example.ca'),
      campaignId: 'brampton-east',
      context: stageCtx(),
      now: NOON_ET,
    };
    const a = await outbox.enqueue(app, CFG, spec);
    const b = await outbox.enqueue(app, CFG, spec);
    ok(a.created === true && b.created === false, 'the second enqueue writes nothing');
    ok(tableOf('notification_outbox').length === 1, 'one row in the outbox');
    ok(a.notifyKey === b.notifyKey, 'and both agree on the key');

    const r = await outbox.drain(app, CFG, { now: NOON_ET });
    ok(r.sent === 1 && SENT.length === 1, `drained once (sent ${r.sent})`);
    const r2 = await outbox.drain(app, CFG, { now: NOON_ET });
    ok(r2.sent === 0 && SENT.length === 1, 'a second drain sends nothing');
    ok(SENT[0].clientReference === a.notifyKey, 'the send carries the row key as its reference');
    ok(/^<.+@mail\.whollar\.com>$/.test(SENT[0].messageId), 'and a stable Message-ID on the sending domain');
  }

  console.log('\nO-2  a suppressed address is refused, and which suppression matters');
  {
    reset();
    await suppress.add(app, { email: 'gone@example.ca', reason: 'hard_bounce', source: 'test' });
    await suppress.add(app, { email: 'quiet@example.ca', reason: 'unsubscribed_all', source: 'test' });

    const hard = await outbox.enqueue(app, CFG, {
      templateKey: 'account.otp',
      eventKey: 'otp:1',
      recipient: { type: 'address', id: 'gone@example.ca', email: 'gone@example.ca' },
      context: { code: '123456', purpose: 'login', ttl_minutes: 10 },
      now: NOON_ET,
    });
    ok(hard.status === 'suppressed', 'a hard bounce stops even a sign-in code');

    const soft = await outbox.enqueue(app, CFG, {
      templateKey: 'account.otp',
      eventKey: 'otp:2',
      recipient: { type: 'address', id: 'quiet@example.ca', email: 'quiet@example.ca' },
      context: { code: '123456', purpose: 'login', ttl_minutes: 10 },
      now: NOON_ET,
    });
    ok(soft.status === 'queued', 'an unsubscribe does not stop a sign-in code, which is not marketing');

    /* Upgrade: an address that opted out and then died is a dead address. */
    await suppress.add(app, { email: 'quiet@example.ca', reason: 'hard_bounce', source: 'test' });
    const after = await suppress.lookup(app, 'quiet@example.ca');
    ok(after.reason === 'hard_bounce' && after.blocksTransactional === true,
      'a soft reason is upgraded by a hard one');
    ok(tableOf('email_suppressions').length === 2, 'and it is still one row per address');
  }

  console.log('\nO-3  quiet hours hold informational mail and never hold a sign-in code');
  {
    reset();
    const held = await outbox.enqueue(app, CFG, {
      templateKey: 'member.campaign.stage',
      eventKey: 'campaign.stage:brampton-east:locked',
      recipient: member('u1', 'one@example.ca'),
      campaignId: 'brampton-east',
      context: stageCtx(),
      now: NIGHT_ET,
    });
    ok(held.status === 'held', 'a stage letter at two in the morning is held');

    const at = ds.fromDb(held.row.earliest_send_at).getTime();
    const localHour = outbox.localHour(at, 'America/Toronto');
    ok(localHour === outbox.QUIET_TO, `and released at ${outbox.QUIET_TO}:00 local (got ${localHour}:00)`);

    const r = await outbox.drain(app, CFG, { now: NIGHT_ET });
    ok(r.sent === 0 && SENT.length === 0, 'the drain leaves it alone until then');
    const r2 = await outbox.drain(app, CFG, { now: at });
    ok(r2.sent === 1 && SENT.length === 1, 'and sends it when the hour comes');

    const code = await outbox.enqueue(app, CFG, {
      templateKey: 'account.otp',
      eventKey: 'otp:night',
      recipient: member('u2', 'two@example.ca'),
      context: { code: '778899', purpose: 'login', ttl_minutes: 10 },
      now: NIGHT_ET,
    });
    ok(code.status === 'queued', 'a sign-in code at the same hour is not held');
  }

  console.log('\nO-4  partner contacts are business inboxes and are never held');
  {
    reset();
    const q = await outbox.enqueue(app, CFG, {
      templateKey: 'partner.account.decision',
      eventKey: 'provider.decision:northline:approved',
      recipient: { type: 'partner', id: 'p1', email: 'desk@northline.example',
        locale: 'en', timezone: 'America/Toronto', firstName: 'Riya' },
      context: { approved: true, org_name: 'Northline Fibre',
        console_url: 'https://www.whollar.ca/partner' },
      now: NIGHT_ET,
    });
    ok(q.status === 'queued', 'a partner letter at two in the morning goes straight into the queue');
  }

  console.log('\nO-5  a missing required key fails the row rather than sending a blank');
  {
    reset();
    const bad = await outbox.enqueue(app, CFG, {
      templateKey: 'member.campaign.stage',
      eventKey: 'campaign.stage:brampton-east:offers',
      recipient: member('u1', 'one@example.ca'),
      campaignId: 'brampton-east',
      context: { stage: 'offers', region_label: 'Brampton East' },   // no dashboard_url
      now: NOON_ET,
    });
    ok(bad.status === 'failed', 'the row fails');
    ok(/missing:dashboard_url/.test(bad.row.last_error), `and names the key (${bad.row.last_error})`);
    const r = await outbox.drain(app, CFG, { now: NOON_ET });
    ok(r.sent === 0 && SENT.length === 0, 'and nothing is sent');
  }

  console.log('\nO-6  two stage letters in one burst supersede rather than both arriving');
  {
    reset();
    await outbox.enqueue(app, CFG, {
      templateKey: 'member.campaign.stage',
      eventKey: 'campaign.stage:brampton-east:bidding',
      recipient: member('u1', 'one@example.ca'),
      campaignId: 'brampton-east',
      context: stageCtx('bidding'),
      now: NOON_ET,
    });
    await outbox.enqueue(app, CFG, {
      templateKey: 'member.campaign.stage',
      eventKey: 'campaign.stage:brampton-east:offers',
      recipient: member('u1', 'one@example.ca'),
      campaignId: 'brampton-east',
      context: stageCtx('offers'),
      now: NOON_ET,
    });
    const r = await outbox.drain(app, CFG, { now: NOON_ET });
    ok(r.superseded === 1 && r.sent === 1, `one superseded, one sent (${r.superseded}/${r.sent})`);
    ok(SENT.length === 1 && /offer for Brampton East is in/.test(SENT[0].subject),
      `and the one that went is the newer (${SENT[0] && SENT[0].subject})`);

    const rows = tableOf('notification_outbox');
    ok(rows.some((x) => x.status === 'superseded'), 'the older row says so rather than vanishing');
  }

  console.log('\nO-7  the claim is what stops two drains sending the same letter');
  {
    reset();
    const q = await outbox.enqueue(app, CFG, {
      templateKey: 'member.campaign.stage',
      eventKey: 'campaign.stage:brampton-east:done',
      recipient: member('u1', 'one@example.ca'),
      campaignId: 'brampton-east',
      context: stageCtx('done'),
      now: NOON_ET,
    });
    /* Somebody else got there first: the row is already claimed. */
    const row = await outbox.find(app, q.notifyKey);
    await ds.updateRow(app, outbox.TABLE, { ROWID: row.ROWID, status: 'sending' });
    const r = await outbox.drain(app, CFG, { now: NOON_ET });
    ok(r.sent === 0 && SENT.length === 0, 'a row already in flight is not picked up again');

    /* And it blocks its lane, so the next stage's letter cannot overtake it.
       Without this the drain reads only queued and held, the in-flight row is
       invisible to the ordering rule, and "bidding is open" arrives after
       "your offer is in", which is the one sequence ordering exists for. */
    await outbox.enqueue(app, CFG, {
      templateKey: 'account.otp',
      eventKey: 'lane:blocked',
      recipient: member('u1', 'one@example.ca'),
      campaignId: 'brampton-east',
      /* A TTL wider than STALE_CLAIM_MS on purpose: this row has to survive
         the wait so that what is being tested is the stale claim and not the
         expiry guard, which would cancel a ten-minute code fifteen minutes
         later and quite rightly. */
      context: { code: '111222', purpose: 'login', ttl_minutes: 45 },
      now: NOON_ET,
    });
    SENT = [];
    const behind = await outbox.drain(app, CFG, { now: NOON_ET });
    ok(behind.sent === 0 && SENT.length === 0, 'and the next letter in that lane waits behind it');

    /* Unless the claim is stale, which is what a crashed drain leaves. A lane
       blocked forever by a row nobody is working on is a household that never
       hears from us again. */
    SENT = [];
    const unstuck = await outbox.drain(app, CFG, { now: NOON_ET + outbox.STALE_CLAIM_MS + 1000 });
    ok(unstuck.sent === 1, 'a claim older than the stale window stops blocking');

    /* And a transport failure schedules a retry rather than losing the row. */
    reset();
    await outbox.enqueue(app, CFG, {
      templateKey: 'member.campaign.stage',
      eventKey: 'campaign.stage:brampton-east:done',
      recipient: member('u1', 'one@example.ca'),
      campaignId: 'brampton-east',
      context: stageCtx('done'),
      now: NOON_ET,
    });
    FAIL_NEXT = { message: 'zeptomail 429: slow down', retryable: true };
    const r2 = await outbox.drain(app, CFG, { now: NOON_ET });
    const after = tableOf('notification_outbox')[0];
    ok(r2.failed === 1 && after.status === 'queued' && Number(after.attempts) === 1,
      `a retryable failure requeues with a backoff (status ${after.status}, attempts ${after.attempts})`);
    ok(tableOf('notification_deliveries').some((d) => d.status === 'failed'),
      'and the attempt is recorded in the delivery ledger');
  }

  console.log('\nO-8  CASL: identification on everything, an unsubscribe only where it applies');
  {
    reset();
    await outbox.enqueue(app, CFG, {
      templateKey: 'member.campaign.stage',
      eventKey: 'campaign.stage:brampton-east:locked',
      recipient: member('u1', 'one@example.ca'),
      campaignId: 'brampton-east',
      context: stageCtx(),
      now: NOON_ET,
    });
    await outbox.drain(app, CFG, { now: NOON_ET });
    const m = SENT[0];
    ok(m.text.includes('Whollar, 1 Example Street'), 'the footer identifies the sender and gives an address');
    ok(m.text.includes('Notification settings'), 'and links to the settings');
    ok(!/\/u\//.test(m.text), 'a transactional letter offers no unsubscribe it would not honour');
    ok(!m.headers['List-Unsubscribe'], 'and carries no List-Unsubscribe header');
    ok(m.from === 'no-reply@mail.whollar.com', 'and goes out as the transactional sender');

    /* No postal address configured: a commercial send is refused outright.
       This used to assert that the registry held NO cem template, with a note
       that adding one is what would make the assertion bite. It bit on
       2026-09-05 when waitlist.welcome arrived, so the guard is exercised
       through that template now rather than through its absence: the first
       commercial letter, refused for want of an address, then sent with the
       unsubscribe the transactional letter above correctly does without. */
    const cem = backend('lib/notify/registry.js').all().filter((e) => e.casl === 'cem');
    ok(cem.length >= 1 && cem.some((e) => e.key === 'waitlist.welcome'),
      'a commercial template exists now, and it is the waitlist welcome');

    const address = { type: 'address', id: 'two@example.ca', email: 'two@example.ca',
      locale: 'en', timezone: 'America/Toronto' };

    reset();
    const noAddress = { ...CFG, MAIL_POSTAL_ADDRESS: '' };
    const refused = await outbox.enqueue(app, noAddress, {
      templateKey: 'waitlist.welcome',
      eventKey: 'waitlist.welcome:two@example.ca',
      recipient: address,
      context: { product_label: 'winter tires', join_url: 'https://www.whollar.ca/join' },
      now: NOON_ET,
    });
    ok(refused.status === 'failed',
      'with no postal address, a commercial send is refused rather than sent without one');
    const refusedRow = tableOf(outbox.TABLE).find((r) => r.template_key === 'waitlist.welcome');
    ok(Boolean(refusedRow) && refusedRow.last_error === 'no_postal_address', 'and the row names the missing key');
    await outbox.drain(app, noAddress, { now: NOON_ET });
    ok(SENT.length === 0, 'and nothing leaves');

    reset();
    const welcomed = await outbox.enqueue(app, CFG, {
      templateKey: 'waitlist.welcome',
      eventKey: 'waitlist.welcome:two@example.ca',
      recipient: address,
      context: { product_label: 'winter tires', join_url: 'https://www.whollar.ca/join',
        share_url: 'https://www.whollar.ca/join?ref=WS7KMQT4WB', share_code: 'WS7KMQT4WB' },
      now: NOON_ET,
    });
    ok(welcomed.status === 'queued', 'with an address configured, the welcome queues');
    await outbox.drain(app, CFG, { now: NOON_ET });
    const w = SENT[0];
    ok(Boolean(w), 'and the drain sends it');
    ok(Boolean(w) && /\/u\//.test(w.text), 'a commercial letter carries the unsubscribe link');
    ok(Boolean(w) && Boolean(w.headers['List-Unsubscribe']), 'and the List-Unsubscribe header');
    ok(Boolean(w) && w.from === 'news@news.whollar.com', 'and goes out as the commercial sender, not the transactional one');
    ok(Boolean(w) && w.text.includes('Whollar, 1 Example Street'), 'with the sender identified and addressed');
    ok(Boolean(w) && w.text.includes('WS7KMQT4WB'), 'and the share code in the body');
  }

  console.log('\nO-9  an unsubscribe token resolves, applies once, and applies again cleanly');
  {
    reset();
    await ds.insertRow(app, 'users', {
      user_id: 'u1', email_normalized: 'one@example.ca', first_name: 'Sam',
    });
    const t = await unsub.tokenFor(app, { recipientType: 'member', recipientId: 'u1' });
    ok(typeof t === 'string' && t.length === optoken.LEN, `a token is minted (${t})`);
    ok(optoken.normalize(t) === t, 'and it verifies its own checksums');

    const again = await unsub.tokenFor(app, { recipientType: 'member', recipientId: 'u1' });
    ok(again === t, 'the same recipient and scope reuse one row, so an old link keeps working');

    const row = await unsub.resolve(app, t);
    ok(Boolean(row) && row.recipient_id === 'u1', 'it resolves back to the recipient');
    ok(await unsub.resolve(app, 'NOTAREALTOKEN0') === null, 'and a wrong one resolves to nothing');

    const applied = await unsub.apply(app, row, { source: 'page' });
    ok(applied.ok === true, 'applying it works');
    const s = await suppress.lookup(app, 'one@example.ca');
    ok(s.listed && s.reason === 'unsubscribed_all', 'the address is on the suppression list');
    ok(s.blocksTransactional === false, 'but a sign-in code still reaches them');

    const twice = await unsub.apply(app, await unsub.resolve(app, t), { source: 'one_click' });
    ok(twice.ok === true, 'a second press is a no-op rather than an error');
  }

  console.log('\nO-10  the scrubber blocks a partner letter naming another partner');
  {
    reset();
    await ds.insertRow(app, 'provider_orgs', {
      org_id: 'rival', legal_name: 'Rival Networks Incorporated', email_domain: 'rival.example',
    });
    await ds.insertRow(app, 'provider_bids', {
      bid_key: 'brampton-east:rival', campaign_id: 'brampton-east', org_id: 'rival',
      user_id: 'x', price: '55', status: 'sealed',
    });
    await outbox.enqueue(app, CFG, {
      templateKey: 'partner.account.decision',
      eventKey: 'provider.decision:leak:approved',
      recipient: { type: 'partner', id: 'p1', email: 'desk@northline.example',
        locale: 'en', timezone: 'America/Toronto' },
      campaignId: 'brampton-east',
      /* The org name is the leak: a partner letter that names another
         partner in this campaign must not go out, whatever put it there. */
      context: { approved: true, org_name: 'Rival Networks Incorporated',
        console_url: 'https://www.whollar.ca/partner', org_id: 'northline' },
      now: NOON_ET,
    });
    const r = await outbox.drain(app, CFG, { now: NOON_ET });
    ok(r.sent === 0 && SENT.length === 0, 'nothing is sent');
    const row = tableOf('notification_outbox')[0];
    ok(row.status === 'failed' && /scrubbed:other_partner_name/.test(row.last_error),
      `the row fails and names the rule (${row.last_error})`);

    /* The counterpart, and the one that is easy to get wrong: a partner's OWN
       name must go straight through. An allow list built from the context
       rather than from the recipient's own rows passes both of these and
       catches neither, which is what this pair exists to distinguish. */
    SENT = [];
    await ds.insertRow(app, 'provider_orgs', {
      org_id: 'northline', legal_name: 'Northline Fibre', email_domain: 'northline.example',
      approval_status: 'approved',
    });
    await ds.insertRow(app, 'provider_users', {
      user_id: 'p2', org_id: 'northline', role: 'admin',
    });
    await outbox.enqueue(app, CFG, {
      templateKey: 'partner.account.decision',
      eventKey: 'provider.decision:northline:approved',
      recipient: { type: 'partner', id: 'p2', email: 'ops@northline.example',
        locale: 'en', timezone: 'America/Toronto' },
      campaignId: 'brampton-east',
      context: { approved: true, org_name: 'Northline Fibre',
        console_url: 'https://www.whollar.ca/partner' },
      now: NOON_ET,
    });
    const r2 = await outbox.drain(app, CFG, { now: NOON_ET });
    ok(r2.sent === 1 && /Northline Fibre/.test(SENT[0].text),
      'a partner reading their own name is not a leak, and is not blocked');
  }

  console.log('\nO-11  the webhook suppresses on a bounce and a complaint, and drops an open');
  {
    reset();
    const events = notifyRoutes.normalizeEvents({
      events: [{
        event_name: 'hardbounce',
        event_message: {
          client_reference: 'abc',
          details: [{
            bounce_code: '550',
            reason: 'mailbox does not exist',
            email_info: { to: [{ email_address: { address: 'Gone@Example.CA' } }] },
          }],
        },
      }],
    });
    ok(events.length === 1 && events[0].email === 'Gone@Example.CA',
      'a batched provider event is read whichever shape it arrives in');
    ok(notifyRoutes.statusFor('hardbounce', '550') === 'bounced_hard', 'a 5xx bounce is permanent');
    ok(notifyRoutes.statusFor('softbounce', '451') === 'bounced_soft', 'a 4xx bounce is not');
    ok(notifyRoutes.statusFor('bounce', null) === 'bounced_soft',
      'and an unknown code is treated as soft, because a wrongly dead address cannot sign in');
    ok(notifyRoutes.statusFor('spamcomplaint', null) === 'complained', 'a complaint is a complaint');
    ok(notifyRoutes.statusFor('email_open', null) === 'opened',
      'an open is recognised, and the handler drops it rather than storing it');

    await suppress.add(app, { email: 'gone@example.ca', reason: 'hard_bounce', source: 'webhook:hardbounce' });
    const s = await suppress.lookup(app, 'GONE@example.ca');
    ok(s.listed && s.blocksTransactional, 'the address is suppressed, case insensitively');
  }

  console.log('\nO-12  a sign-in code does not wait for a drain');
  {
    reset();
    /* Every login in the system depends on this. `security` priority is
       dispatched inline, in the request that created the row, because a
       person is standing at a form: a code that arrives on the next sweep is
       a code that arrives after it expires. */
    const sent = await outbox.dispatch(app, CFG, {
      templateKey: 'account.otp',
      eventKey: 'otp.start:req-1',
      recipient: { type: 'address', id: 'new@example.ca', email: 'new@example.ca' },
      context: { code: '447281', purpose: 'login', ttl_minutes: 10 },
      now: NIGHT_ET,
    });
    ok(sent.delivered === true && sent.inline === true, 'the code goes out in the same request');
    ok(SENT.length === 1 && SENT[0].text.includes('447281'),
      'the code is in the plain text part, which some clients render in preference to the HTML');
    ok(SENT[0].subject === '447281 is your Whollar sign-in code', `and in the subject (${SENT[0].subject})`);

    /* And the same request twice is one code, which is what a double-clicked
       button looks like from here. */
    const again = await outbox.dispatch(app, CFG, {
      templateKey: 'account.otp',
      eventKey: 'otp.start:req-1',
      recipient: { type: 'address', id: 'new@example.ca', email: 'new@example.ca' },
      context: { code: '447281', purpose: 'login', ttl_minutes: 10 },
      now: NIGHT_ET,
    });
    ok(SENT.length === 1 && again.delivered === false,
      'a double-submitted form sends one code, not two');

    /* An informational message dispatched the same way is queued, not sent:
       only security jumps the queue. */
    reset();
    const later = await outbox.dispatch(app, CFG, {
      templateKey: 'member.campaign.stage',
      eventKey: 'campaign.stage:brampton-east:forming',
      recipient: member('u1', 'one@example.ca'),
      campaignId: 'brampton-east',
      context: stageCtx('forming'),
      now: NOON_ET,
    });
    ok(later.inline === false && SENT.length === 0, 'a stage letter waits for the drain');
  }

  console.log('\nO-13  the result letters keep the seal');
  {
    /* The one invariant a losing partner's email can break, and the only way
       to check it is to render the letter and read it. A losing price
       disclosed here is the whole field's pricing reconstructed over three
       cohorts, so the not-awarded letter carries a tier name and nothing. */
    const lost = registry.get('partner.tier.not_awarded');
    const m = layout.assemble({
      audience: 'partner',
      ...renderWith(lost, registry.fixturesOf(lost)[0]),
      footer: FOOTER,
    });
    ok(!/\$/.test(m.text), 'the not-awarded letter carries no money at all');
    /* The meaningful version of "names no winner": render it with a context
       that CARRIES one and prove the template ignores it. A keyword test
       fails on the copy that explains we do not disclose the winning price,
       which is exactly the sentence that should be there. This tests the
       property instead: extra context cannot leak through a template that
       does not read it, so a future caller passing the wrong object is a
       no-op rather than a disclosure. */
    const poisoned = layout.assemble({
      audience: 'partner',
      ...renderWith(lost, {
        ...registry.fixturesOf(lost)[0],
        winner_name: 'Rival Networks Incorporated',
        winning_price: '58.00',
        bidder_count: 4,
        margin: '6.99',
      }),
      footer: FOOTER,
    });
    ok(!/Rival Networks/.test(poisoned.text) && !/58\.00/.test(poisoned.text)
      && !/\b4 bidders?\b/.test(poisoned.text) && !/6\.99/.test(poisoned.text),
      'and a context carrying a winner, a price, a count and a margin leaks none of them');
    ok(/500 Mbps/.test(m.text) && /Brampton East/.test(m.text),
      'it says which tier on which cohort, which is the whole permitted content');

    /* The award letter may carry the partner's OWN price and count. */
    const won = registry.get('partner.tier.awarded');
    const w = layout.assemble({
      audience: 'partner',
      ...renderWith(won, registry.fixturesOf(won)[0]),
      footer: FOOTER,
    });
    ok(/64\.99/.test(w.text), 'the award letter carries this partner\u2019s own price');
    ok(!/bidder|other partner|instead of/i.test(w.text), 'and says nothing about the field');
  }

  console.log('\nO-14  a household that passes is not also told its install was cancelled');
  {
    reset();
    await ds.insertRow(app, 'users', {
      user_id: 'm9', email_normalized: 'nine@example.ca', first_name: 'Nia', status: 'active',
    });
    const row = {
      order_key: 'brampton-east:m9', campaign_id: 'brampton-east',
      member_user_id: 'm9', org_id: 'northline', state: 'rel',
    };
    const req = fakeReq();

    const passed = await events.orderReleased(req, { row, reason: 'household_passed' });
    ok(passed === null, 'the household\u2019s own pass emits no released letter');

    const partnerReleased = await events.orderReleased(req, { row, reason: 'no_plant' });
    ok(partnerReleased !== null, 'a partner release does emit one');
    const written = tableOf('notification_outbox');
    ok(written.length === 1 && written[0].template_key === 'member.order.released',
      `one row, and it is the released letter (${written.length})`);
  }

  console.log('\nO-15  role routing degrades to everyone while the column is absent');
  {
    reset();
    await ds.insertRow(app, 'provider_users', { user_id: 'p7', org_id: 'northline', role: 'admin' });
    await ds.insertRow(app, 'provider_users', { user_id: 'p8', org_id: 'northline', role: 'viewer' });
    await ds.insertRow(app, 'users', { user_id: 'p7', email_normalized: 'a@n.example', status: 'active' });
    await ds.insertRow(app, 'users', { user_id: 'p8', email_normalized: 'b@n.example', status: 'active' });

    const to = await events.partnerContacts(app, 'northline', 'billing');
    ok(to.length === 2, `both contacts, because notify_roles does not exist yet (${to.length})`);
    ok(to.every((r) => r.type === 'partner'), 'and both are partner recipients');

    /* An inactive person is never written to, column or no column. */
    await ds.insertRow(app, 'provider_users', { user_id: 'p9', org_id: 'northline', role: 'viewer' });
    await ds.insertRow(app, 'users', { user_id: 'p9', email_normalized: 'c@n.example', status: 'disabled' });
    const again = await events.partnerContacts(app, 'northline', 'billing');
    ok(again.length === 2, 'a disabled account is not a contact');
  }

  console.log('\nO-16  an offset fires once, at the moment it names');
  {
    const deadline = Date.UTC(2026, 8, 10, 12, 0, 0);
    const at24 = deadline - 24 * 3600e3;
    ok(reminders.due(at24, deadline, 24), 'exactly 24 hours out is due');
    ok(reminders.due(at24 + 60e3, deadline, 24), 'and a minute later still is');
    ok(!reminders.due(at24 - 60e3, deadline, 24), 'a minute early is not');
    ok(!reminders.due(at24 + reminders.WINDOW_MS + 1000, deadline, 24),
      'and past the window it stops, so the 24 hour offset does not fire at 22 hours');
    ok(!reminders.due(deadline + 1000, deadline, 24), 'nothing is due after the deadline');
    ok(reminders.WINDOW_MS >= 60 * 60 * 1000,
      'the window is at least an hour, or an hourly timer would step over an offset');
  }

  console.log('\nO-17  a reminder cancels itself when its reason has gone');
  {
    reset();
    await ds.insertRow(app, 'users', {
      user_id: 'r1', email_normalized: 'r1@example.ca', first_name: 'Rae', status: 'active',
    });
    const entry = registry.get('member.offer.reminder');
    ok(typeof entry.stillRelevant === 'function', 'the offer reminder declares a predicate');

    /* No order: the household has not decided, so the reminder stands. */
    const ctx = {
      region_label: 'Brampton East', decide_by_at: NOON_ET + 24 * 3600e3, hours_left: 24,
      campaign_id: 'brampton-east', user_id: 'r1',
      dashboard_url: 'https://www.whollar.ca/dashboard',
    };
    ok(await entry.stillRelevant(ctx, { catalystApp: app, cfg: CFG, now: NOON_ET }) === true,
      'with no order, the household has not decided and the reminder stands');

    /* An order IS the decision in this product. */
    await ds.insertRow(app, 'provider_orders', {
      order_key: 'brampton-east:r1', campaign_id: 'brampton-east', org_id: 'northline',
      member_user_id: 'r1', state: 'bkd', created_at: ds.nowDb(), updated_at: ds.nowDb(),
      order_no: 'WH-1', fsa: 'L6P', address_line: '1 Test', slot_at: ds.nowDb(),
      note: null, release_reason: null, activated_at: null,
    });
    ok(await entry.stillRelevant(ctx, { catalystApp: app, cfg: CFG, now: NOON_ET }) === false,
      'once an order stands the household has decided, and the reminder cancels');

    /* And the drain honours it rather than sending anyway. */
    await outbox.enqueue(app, CFG, {
      templateKey: 'member.offer.reminder',
      eventKey: 'offer.reminder:brampton-east',
      slot: 't-24h',
      recipient: member('r1', 'r1@example.ca'),
      campaignId: 'brampton-east',
      context: ctx,
      now: NOON_ET,
    });
    const r = await outbox.drain(app, CFG, { now: NOON_ET });
    ok(r.cancelled === 1 && SENT.length === 0,
      `the drain cancels it instead of nagging somebody who already acted (${r.cancelled})`);
    ok(tableOf('notification_outbox')[0].status === 'cancelled', 'and the row says why');
  }

  console.log('\nO-18  the install reminder will not name a day that moved');
  {
    reset();
    await ds.insertRow(app, 'users', {
      user_id: 'r2', email_normalized: 'r2@example.ca', status: 'active',
    });
    const slot = NOON_ET + 24 * 3600e3;
    await ds.insertRow(app, 'provider_orders', {
      order_key: 'brampton-east:r2', campaign_id: 'brampton-east', org_id: 'northline',
      member_user_id: 'r2', state: 'bkd', slot_at: ds.toDb(new Date(slot)),
      order_no: 'WH-2', fsa: 'L6P', address_line: '2 Test', note: null,
      release_reason: null, activated_at: null, created_at: ds.nowDb(), updated_at: ds.nowDb(),
    });
    const entry = registry.get('member.install.reminder');
    const ctx = { order_key: 'brampton-east:r2', slot_at: slot, partner_name: 'Northline Fibre',
      dashboard_url: 'https://www.whollar.ca/dashboard' };
    ok(await entry.stillRelevant(ctx, { catalystApp: app, cfg: CFG, now: NOON_ET }) === true,
      'a booked order on the day the reminder names is relevant');

    /* Rebooked to another day. Reminding about the old one would have somebody
       take a morning off for a visit nobody is making. */
    const row = tableOf('provider_orders')[0];
    await ds.updateRow(app, 'provider_orders', {
      ROWID: row.ROWID, slot_at: ds.toDb(new Date(slot + 48 * 3600e3)),
    });
    ok(await entry.stillRelevant(ctx, { catalystApp: app, cfg: CFG, now: NOON_ET }) === false,
      'a rebooked order makes the old day\u2019s reminder wrong, and it cancels');

    await ds.updateRow(app, 'provider_orders', { ROWID: row.ROWID, state: 'rel' });
    ok(await entry.stillRelevant(ctx, { catalystApp: app, cfg: CFG, now: NOON_ET }) === false,
      'and a released order is not an appointment at all');
  }

  console.log('\nO-19  the sweep enqueues each offset once, whatever the cadence');
  {
    reset();
    await ds.insertRow(app, 'users', {
      user_id: 'r3', email_normalized: 'r3@example.ca', first_name: 'Roo', status: 'active',
    });
    await ds.insertRow(app, 'campaign_members', {
      membership_key: 'brampton-east:r3', campaign_id: 'brampton-east',
      user_id: 'r3', status: 'joined', joined_at: ds.nowDb(),
    });
    const decideBy = NOON_ET + 24 * 3600e3;
    const campaign = {
      id: 'brampton-east', region: 'Brampton East', sub: 'Winter cohort', kind: 'auction',
      target: 100, biddingOpen: false, sortOrder: 0,
      dates: { announce_at: null, bidding_opens_at: null, bidding_closes_at: null,
        offers_at: null, decision_at: decideBy, switch_window_at: null, reconcile_at: null },
    };
    const states = [{ id: campaign.id, memberStage: 'offers', campaign }];

    const a = await reminders.sweep(app, CFG, states, NOON_ET);
    ok(a.queued === 1, `one reminder queued at the 24 hour mark (${a.queued})`);

    /* The read-driven trigger runs on every dashboard load. Sweeping again a
       minute later must write nothing: the idempotency key carries the offset,
       so this is the table refusing rather than a flag anybody set. */
    const b = await reminders.sweep(app, CFG, states, NOON_ET + 60e3);
    ok(b.queued === 0, 'a second sweep inside the same window queues nothing');
    ok(tableOf('notification_outbox').length === 1, 'and there is still one row');

    /* A household that has since decided is not swept at all. */
    reset();
    await ds.insertRow(app, 'users', { user_id: 'r4', email_normalized: 'r4@example.ca', status: 'active' });
    await ds.insertRow(app, 'campaign_members', {
      membership_key: 'brampton-east:r4', campaign_id: 'brampton-east',
      user_id: 'r4', status: 'joined', joined_at: ds.nowDb(),
    });
    await ds.insertRow(app, 'provider_orders', {
      order_key: 'brampton-east:r4', campaign_id: 'brampton-east', org_id: 'northline',
      member_user_id: 'r4', state: 'acc', slot_at: ds.nowDb(), order_no: 'WH-4',
      fsa: 'L6P', address_line: '4 Test', note: null, release_reason: null,
      activated_at: null, created_at: ds.nowDb(), updated_at: ds.nowDb(),
    });
    const c = await reminders.sweep(app, CFG, states, NOON_ET);
    ok(c.queued === 0, 'a household that already accepted is never reminded to decide');
  }

  console.log('\nO-20  the timer can reach its own route, and nothing else can');
  {
    /* A timer sends no Origin, so an unconditional origin check refuses every
       run and does it quietly: the job reports 403, nobody reads a scheduler's
       run history, and the reminder lane simply never fires. This was live for
       one deploy and the curl that found it is the only reason it is not still
       live. */
    const ex = (path, headers = {}) => csrf.isExempt({ path, headers });
    const CRON = { 'x-cron-secret': 'anything' };

    ok(ex('/admin/notify/tick', CRON), 'the timer reaches the tick route');
    ok(ex('/auth/admin/notify/tick', CRON), 'and under the /auth mount too');
    ok(!ex('/admin/notify/tick', {}),
      'without the header it stays origin-checked, so a signed-in admin cannot be made to tick from another origin');
    ok(!ex('/admin/notify/drain', CRON), 'drain is not exempt, header or not');
    ok(!ex('/otp/start', CRON), 'and the header exempts nothing else anywhere');
    ok(ex('/hooks/zeptomail', {}) && ex('/u/ABCD1234EFGH5678', {}) && ex('/google/callback', {}),
      'the three unconditional exemptions still stand');
    ok(!ex('/campaigns/join', {}), 'an ordinary route is still checked');
  }

  console.log('\nO-21  each transport sends as an address it may actually use');
  {
    /* THE OUTAGE THIS EXISTS FOR. `build()` puts the ZeptoMail sender on every
       message. The SMTP relay authenticates as one mailbox and refuses any
       other From, so the day the fallback started being handed
       no-reply@mail.whollar.com it started answering 550, and because
       ZeptoMail was already failing, every sign-in code in the product stopped
       arriving. The audit line said `delivered: false, send_error: null`. */
    const CFG2 = {
      ZEPTOMAIL_FROM: 'info@whollar.com',
      MAIL_FROM_TRANSACTIONAL: 'no-reply@mail.whollar.com',
      SMTP_FROM: 'login@whollar.ca',
    };
    const wire = { from: 'no-reply@mail.whollar.com' };

    ok(mailer.senderFor(CFG2, 'zeptomail', wire) === 'no-reply@mail.whollar.com',
      'ZeptoMail honours the sender the message asked for');
    ok(mailer.senderFor(CFG2, 'zeptomail', {}) === 'info@whollar.com',
      'and falls back to the one configured sender');
    ok(mailer.senderFor(CFG2, 'smtp', wire) === 'login@whollar.ca',
      'the relay sends as its own mailbox, never as the address ZeptoMail was given');
    ok(mailer.senderFor(CFG2, 'smtp', { from: 'login@whollar.ca' }) === 'login@whollar.ca',
      'and asking for that same mailbox changes nothing');
    ok(mailer.senderFor(CFG2, 'smtp', {}) === 'login@whollar.ca',
      'with no request at all it is still its own mailbox');
  }

  console.log('\nO-22  a refused send reaches the caller as a reason, not a bare false');
  {
    reset();
    FAIL_NEXT = { message: 'smtp 550: sender address not allowed', retryable: false };
    const sent = await outbox.dispatch(app, CFG, {
      templateKey: 'account.otp',
      eventKey: 'otp.start:req-outage',
      recipient: member('u-locked', 'locked-out@example.ca'),
      context: { code: '481920', purpose: 'login', ttl_minutes: 10 },
      now: NOON_ET,
    });
    ok(sent.delivered === false, 'the send failed');
    ok(/550/.test(String(sent.sendError)),
      'and the caller is handed the relay\u2019s own words, which is what the audit line writes');
    const row = tableOf('notification_outbox').find((r) => r.event_key === 'otp.start:req-outage');
    ok(row && /550/.test(String(row.last_error)), 'the row records it too');
  }

  console.log('\nO-23  a sign-in code that outlived its own TTL is never sent late');
  {
    /* The other half of the outage. Fourteen codes sat queued and retryable
       for a day. Fixing the transport without this would have delivered all
       fourteen, each one announcing that it expires in ten minutes. */
    reset();
    FAIL_NEXT = { message: 'smtp 550: sender address not allowed', retryable: true };
    await outbox.dispatch(app, CFG, {
      templateKey: 'account.otp',
      eventKey: 'otp.start:req-stale',
      recipient: member('u-stale', 'stale@example.ca'),
      context: { code: '481920', purpose: 'login', ttl_minutes: 10 },
      now: NOON_ET,
    });
    const row = tableOf('notification_outbox').find((r) => r.event_key === 'otp.start:req-stale');
    ok(row && row.status === 'queued', 'the refused code is left queued for the drain');

    SENT = [];
    const later = await outbox.drain(app, CFG, { now: NOON_ET + 40 * 60000 });
    ok(SENT.length === 0, 'forty minutes on, the drain sends nothing');
    ok(later.cancelled === 1, 'and counts it cancelled rather than sent');
    const after = tableOf('notification_outbox').find((r) => r.event_key === 'otp.start:req-stale');
    ok(after.status === 'cancelled' && after.last_error === 'code_expired',
      'the row says why, in words an operator can act on');

    /* And the guard must not touch a code that is still good. */
    reset();
    await outbox.dispatch(app, CFG, {
      templateKey: 'account.otp',
      eventKey: 'otp.start:req-fresh',
      recipient: member('u-fresh', 'fresh@example.ca'),
      context: { code: '481921', purpose: 'login', ttl_minutes: 10 },
      now: NOON_ET,
    });
    ok(SENT.length === 1, 'a code inside its TTL still goes out at once');
  }

  console.log('\nO-24  a store that cannot find a row it just wrote still sends the code');
  {
    reset();
    BLIND_KEY_LOOKUP = true;
    const sent = await outbox.dispatch(app, CFG, {
      templateKey: 'account.otp',
      eventKey: 'otp.start:req-blind',
      recipient: member('u-blind', 'blind@example.ca'),
      context: { code: '481922', purpose: 'login', ttl_minutes: 10 },
      now: NOON_ET,
    });
    ok(sent.delivered === true, 'the code goes out on the handle the insert returned');
    ok(SENT.length === 1 && /481922/.test(SENT[0].text), 'and it is the right code');
    ok(!sent.sendError, 'with nothing to report');
    const row = tableOf('notification_outbox').find((r) => r.event_key === 'otp.start:req-blind');
    ok(row.status === 'sent', 'the row is marked sent, claimed and confirmed by ROWID');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  mailer.send = realSend;
  process.exit(fail ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
