'use strict';

/**
 * Billing: the method on file, and the statement a cohort's orders imply.
 *
 * THE STATEMENT IS DERIVED, NOT STORED. Every line on it is a fact about an
 * order: a success fee is an activation, a credit is a no-show, a held amount
 * is a failed line test. Storing the lines as well would create a second
 * source of truth for the same events, and the two would disagree the first
 * time an exception was logged after an invoice run. So the statement is
 * computed from provider_orders on every read, and the only thing the
 * statements table holds is SETTLEMENT: the moment an operator issued it, the
 * totals frozen at that moment, and payment. What is owed is arithmetic; what
 * was invoiced is a record.
 *
 * NOTHING BILLS BEFORE AN ACTIVATION. Not a bid, not a win, not a confirmed
 * household, not a booked install. lib/orders.js enforces that on the write
 * side by making 'act' the only state that requires a clean line test; this
 * module enforces it on the money side by never reading any other state as a
 * fee.
 *
 * A HELD LINE IS NOT A BILLED LINE. A failed line test holds the fee: it is
 * shown so a partner can see what a clean retest is worth, and it is excluded
 * from the subtotal. Reading the held figure as revenue is exactly the mistake
 * the separate state exists to prevent.
 *
 * MONEY IS A STRING, EVERYWHERE. The Catalyst console's Int column has no
 * cents, so every amount in this system is a varchar, and lib/money.js owns
 * how a number becomes one. Nothing here does its own rounding.
 */

const datastore = require('./datastore');
const siteconfig = require('./siteconfig');
const orders = require('./orders');
const { sum, times } = require('./money');
const { ms } = require('./envelope');

const BILLING = 'provider_billing';
const STATEMENTS = 'provider_statements';

const BILLING_COLS = Object.freeze(['org_id', 'method', 'billing_email', 'billing_contact',
  'state', 'added_by', 'added_at', 'updated_at']);
const STATEMENT_COLS = Object.freeze(['statement_key', 'campaign_id', 'org_id', 'state',
  'activated_count', 'fee_each', 'subtotal', 'tax', 'total', 'issued_at', 'due_at', 'paid_at']);

/* Mirrors partner/core/contract.js STATEMENT_STATE. 'accruing' is never
   stored: it is the absence of a settlement row, which is why a statement can
   accrue for a cohort whose table row does not exist yet. */
const STATEMENT_STATES = Object.freeze(['accruing', 'issued', 'paid', 'disputed']);

/* Mirrors LINE_STATE. A line is an order, so these live on the order row. */
const LINE_STATES = Object.freeze(['accrued', 'held', 'disputed', 'upheld', 'credited']);

/**
 * Invoice, not card.
 *
 * There is no payment service provider wired into this stack, and pretending
 * otherwise would put a fake card on a real screen. What a partner actually
 * puts on file today is an invoicing arrangement: who receives the statement,
 * and an acceptance of net-15 pre-authorized debit against it. That is a real
 * record, it satisfies the roster gate honestly, and it is the row a PSP
 * integration would later extend rather than replace.
 */
const METHODS = Object.freeze(['invoice']);

const DAY = 24 * 60 * 60 * 1000;
const NET_DAYS = 15;

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------------------------------------------ *
 * The method on file
 * ------------------------------------------------------------------ */

/**
 * The org's billing method, or null when there is none or the table cannot be
 * read. Both mean the same thing to the roster gate: not on file. Failing
 * closed here is deliberate, and it is the safe direction: the cost is a
 * partner who has to re-add a method, and the alternative cost is a household
 * address released against a billing record nobody could confirm.
 */
async function methodFor(catalystApp, orgId) {
  let row = null;
  try {
    row = await datastore.findBy(catalystApp, BILLING, 'org_id', orgId, ['ROWID'].concat(BILLING_COLS));
  } catch {
    return null;
  }
  if (!row) return null;
  return {
    ROWID: row.ROWID,
    orgId: row.org_id,
    method: METHODS.indexOf(row.method) >= 0 ? row.method : 'invoice',
    email: row.billing_email || null,
    contact: row.billing_contact || null,
    state: row.state || 'active',
    onFile: String(row.state || 'active') === 'active' && Boolean(row.billing_email),
    addedAt: ms(row.added_at),
  };
}

/** What the console renders. Null stays null: "could not read" is a state. */
function publicMethod(m) {
  if (!m) return { onFile: false, method: null, email: null, contact: null, state: null };
  return {
    onFile: m.onFile,
    method: m.method,
    email: m.email,
    contact: m.contact,
    state: m.state,
    addedAt: m.addedAt,
  };
}

/** Add or replace the method. One row per org, keyed on org_id. */
async function putMethod(catalystApp, { orgId, email, contact, userId, at }) {
  const stamp = datastore.toDb(new Date(at || Date.now()));
  const existing = await methodFor(catalystApp, orgId);
  if (existing) {
    await datastore.updateRow(catalystApp, BILLING, {
      ROWID: existing.ROWID,
      method: 'invoice',
      billing_email: email,
      billing_contact: contact,
      state: 'active',
      updated_at: stamp,
    });
  } else {
    await datastore.insertRow(catalystApp, BILLING, {
      org_id: orgId,
      method: 'invoice',
      billing_email: email,
      billing_contact: contact,
      state: 'active',
      added_by: userId,
      added_at: stamp,
      updated_at: stamp,
    });
  }
  return methodFor(catalystApp, orgId);
}

/* ------------------------------------------------------------------ *
 * The numbers behind a statement
 * ------------------------------------------------------------------ */

/**
 * The fee and the two rates, read from configuration and never from a
 * constant in code. The success fee in particular is an unconfirmed planning
 * number, and a hard-coded 95 is how an unconfirmed number becomes a promise.
 */
async function terms(catalystApp) {
  const fee = await siteconfig.getValue(catalystApp, 'success_fee');
  const credit = await siteconfig.getValue(catalystApp, 'missed_visit_credit');
  const taxPct = await siteconfig.getValue(catalystApp, 'tax_rate_pct');
  const registration = await siteconfig.getValue(catalystApp, 'tax_registration');
  return {
    fee: String(Number(fee) > 0 ? Number(fee) : 95),
    missedVisitCredit: String(Number(credit) >= 0 ? Number(credit) : 25),
    taxPct: Number(taxPct) >= 0 ? Number(taxPct) : 13,
    taxRegistration: registration ? String(registration) : null,
  };
}

/** Cents, so a statement cannot inherit a float's rounding. */
const cents = (v) => Math.round(Number(v || 0) * 100);
const fromCents = (c) => String(c / 100);

/**
 * One cohort's statement, derived from its orders.
 *
 * The line set is fixed and each line names its count, so a partner can check
 * every figure against the board they were just looking at. A line with a zero
 * count is omitted rather than shown as zero: "0 missed visits" reads as a
 * complaint that did not happen.
 */
function statementFor({ campaign, rows, t, settlement }) {
  const c = orders.counts(rows || []);

  const feeTotal = times(t.fee, c.act) || '0';
  const creditTotal = times(t.missedVisitCredit, c.noshow) || '0';
  const heldTotal = times(t.fee, c.linefail) || '0';

  const subtotalCents = cents(feeTotal) - cents(creditTotal);
  const taxCents = Math.round(subtotalCents * (t.taxPct / 100));
  const totalCents = subtotalCents + taxCents;

  const lines = [];
  lines.push({
    key: 'success_fees',
    title: 'Success fees',
    detail: `$${t.fee} per activated household, line test clean`,
    count: c.act,
    amount: feeTotal,
    state: 'accrued',
  });
  if (c.noshow) {
    lines.push({
      key: 'missed_visit_credits',
      title: 'Missed-visit credits',
      detail: `Passed through to each household, $${t.missedVisitCredit} each`,
      count: c.noshow,
      amount: '-' + creditTotal,
      state: 'credited',
    });
  }
  if (c.linefail) {
    lines.push({
      key: 'held_line_test',
      title: 'Held, line test open',
      detail: 'Below the bid tier. Held out of the total until a clean retest',
      count: c.linefail,
      amount: heldTotal,
      state: 'held',
    });
  }

  const disputed = (rows || []).filter((r) => String(r.dispute_state || '') === 'open').length;

  return {
    campaignId: campaign.id,
    region: campaign.region,
    sub: campaign.sub || '',
    state: settlement ? settlement.state : 'accruing',
    counts: c,
    feeEach: t.fee,
    lines,
    /* Held sits outside the subtotal on purpose. See the header. */
    held: c.linefail ? heldTotal : null,
    subtotal: fromCents(subtotalCents),
    taxPct: t.taxPct,
    taxRegistration: t.taxRegistration,
    tax: fromCents(taxCents),
    total: fromCents(totalCents),
    disputedLines: disputed,
    cycleEndsAt: (campaign.dates || {}).reconcile_at || null,
    dueAt: settlement ? settlement.dueAt : ((campaign.dates || {}).reconcile_at
      ? (campaign.dates || {}).reconcile_at + NET_DAYS * DAY
      : null),
    issuedAt: settlement ? settlement.issuedAt : null,
    paidAt: settlement ? settlement.paidAt : null,
  };
}

/** The current cycle across every cohort: what is accruing, right now. */
function cycleFor(statements, t) {
  const activated = statements.reduce((n, s) => n + s.counts.act, 0);
  const accruing = statements.filter((s) => s.state === 'accruing');
  return {
    activated,
    feeEach: t.fee,
    accruing: sum(accruing.map((s) => s.subtotal)),
    cohorts: accruing.length,
    netDays: NET_DAYS,
  };
}

/* ------------------------------------------------------------------ *
 * Settlement records
 * ------------------------------------------------------------------ */

/** Settlement rows for an org, keyed by campaign. Empty when unreadable: an
    absent settlement reads as accruing, which is the state before any run. */
async function settlementsFor(catalystApp, orgId) {
  let rows = [];
  try {
    rows = await datastore.queryAll(catalystApp, STATEMENTS, STATEMENT_COLS,
      `org_id = ${datastore.lit(orgId)}`);
  } catch {
    return {};
  }
  const by = {};
  (rows || []).forEach((r) => {
    by[r.campaign_id] = {
      state: STATEMENT_STATES.indexOf(r.state) >= 0 ? r.state : 'issued',
      activatedCount: toInt(r.activated_count),
      feeEach: r.fee_each || null,
      subtotal: r.subtotal || null,
      tax: r.tax || null,
      total: r.total || null,
      issuedAt: ms(r.issued_at),
      dueAt: ms(r.due_at),
      paidAt: ms(r.paid_at),
    };
  });
  return by;
}

module.exports = {
  BILLING, STATEMENTS, BILLING_COLS, STATEMENT_COLS,
  METHODS, STATEMENT_STATES, LINE_STATES, NET_DAYS,
  methodFor, publicMethod, putMethod,
  terms, statementFor, cycleFor, settlementsFor,
};
