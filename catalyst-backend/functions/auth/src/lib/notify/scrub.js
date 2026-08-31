'use strict';

/**
 * The privacy scrubber: the last thing that looks at a message before it
 * leaves, and the only one that assumes the templates are wrong.
 *
 * WHY A DENYLIST FROM REAL DATA, NOT A REGEX. "Does this partner email
 * mention another partner" cannot be answered by a pattern, because the thing
 * that must not appear is a company name, and company names look like words.
 * So the list is built from the campaign's own rows: the names of the other
 * partners actually in it, the seal references that are not this recipient's,
 * the addresses of households that have not confirmed. Absence of those exact
 * strings is a fact that can be asserted. Absence of "anything that looks
 * like a competitor" is not.
 *
 * WHY IT READS DATA A PARTNER ROUTE MAY NOT. lib/bids.js names three
 * sanctioned readers of campaignBidRows and says not to reach for it from a
 * /provider route. This is a fourth, and it is safe for the same reason the
 * admin review is: the rows are read to be asserted absent, nothing derived
 * from them is returned to the caller, and the only output is a boolean and a
 * log line naming which rule fired. If that ever changes, this comment is the
 * thing that was wrong.
 *
 * A HIT IS A FAILED SEND, NOT A REDACTION. Quietly stripping the offending
 * string would ship an email with a hole in it and no one would know. The row
 * fails, the operator gets a security alert, and a person decides.
 *
 * IT RUNS TWICE. Once over the finished context, because a value that reaches
 * the template has already escaped the boundary whether or not the template
 * prints it, and once over the rendered HTML and text, because a template can
 * assemble a forbidden string out of two harmless ones.
 */

const datastore = require('../datastore');

/* Shapes that must never reach any recipient, whatever the audience. */
const UNIVERSAL = Object.freeze([
  /* A Catalyst ROWID: 16 or more digits. Internal identity, and a member
     dashboard has never needed one. */
  [/\b\d{16,}\b/, 'rowid'],
  /* Our own stack talking. If one of these reaches an inbox, an error path
     has leaked into a template. */
  [/\bZCQL\b|\bexecuteZCQLQuery\b|\bCatalyst\b/i, 'internal_stack'],
  [/\bzeptomail \d{3}:/i, 'provider_error'],
  [/\bstack trace\b|\bat Object\.<anonymous>/i, 'stack_trace'],
  [/\bundefined\b|\bNaN\b|\[object Object\]/, 'render_hole'],
]);

/**
 * Everything this message may not contain, derived from what the campaign
 * actually holds.
 *
 *   -> { terms: [[string, rule]], patterns: [[regexp, rule]] }
 *
 * Best effort by design. A campaign whose bid table cannot be read produces a
 * shorter list, not a thrown error: the universal rules still run, and a
 * scrubber that fails the send because it could not build its own list would
 * take the whole notification layer down with one unreadable table.
 */
async function denylistFor(catalystApp, { campaignId, audience, recipient, allow = [] }) {
  const terms = [];

  /* THE ALLOW LIST IS RESOLVED, NEVER TAKEN FROM THE CONTEXT.
   *
   * The obvious shape is "allow whatever the context calls org_name", and it
   * is wrong in exactly the case this module exists for: a context that
   * carries the WRONG partner's name is the leak, and allowing it by name
   * would wave the leak through while blocking nothing. So the recipient's
   * own identifiers are looked up from their own rows, and the context is
   * treated as suspect throughout. */
  const keep = new Set((allow || []).filter(Boolean).map((s) => String(s).toLowerCase()));
  const mine = audience === 'partner'
    ? await ownOrgSafe(catalystApp, recipient)
    : null;
  if (mine && mine.name) keep.add(String(mine.name).toLowerCase());

  const add = (value, rule) => {
    const s = String(value || '').trim();
    if (s.length < 3) return;
    if (keep.has(s.toLowerCase())) return;
    terms.push([s, rule]);
  };

  if (campaignId && audience === 'partner') {
    /* Other partners in this campaign: their names, and their seal
       references. Never the prices, because a price is a number and a number
       cannot be asserted absent without false positives on the recipient's
       own figures. Prices are kept out by the templates and by the fact that
       no partner context is ever built from another partner's row. */
    const myOrgId = String((mine && mine.orgId) || '');
    for (const row of await bidRowsSafe(catalystApp, campaignId)) {
      if (myOrgId && String(row.org_id) === myOrgId) continue;
      add(row.org_name, 'other_partner_name');
      /* `bid_key` is `${campaign_id}:${org_id}`, so it carries the other
         partner's identifier in a form a template could paste whole. There is
         no `seal_ref` column on provider_bids: the receipt number lives on
         bid_revisions, and it joins this list when a partner template first
         has reason to print one. */
      add(row.bid_key, 'other_bid_key');
      add(row.org_id, 'other_org_id');
    }
    /* Households that have not confirmed: their addresses are not this
       partner's to know yet. */
    for (const row of await unconfirmedAddressesSafe(catalystApp, campaignId)) {
      add(row.address_line, 'unconfirmed_address');
    }
  }

  if (audience === 'member') {
    /* Another household's address or email. The recipient's own are allowed
       through by the `allow` list the caller passes. */
    for (const row of await memberContactsSafe(catalystApp, campaignId)) {
      add(row.email, 'other_member_email');
      add(row.address_line, 'other_member_address');
    }
  }

  return { terms, patterns: UNIVERSAL.slice() };
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

/**
 * Run the list over a rendered message, or over a context object.
 *   -> [] when clean, otherwise [{ rule, where, sample }]
 *
 * `sample` is the rule name and a truncated window, never the forbidden
 * string in full: this goes into a log, and a log that quotes the leak back
 * is a second copy of it.
 */
function check(subject, html, text, denylist) {
  const hits = [];
  const surfaces = [['subject', subject], ['html', html], ['text', text]];

  for (const [where, body] of surfaces) {
    if (!body) continue;
    const hay = String(body);
    const lower = hay.toLowerCase();

    for (const [term, rule] of denylist.terms) {
      const at = lower.indexOf(String(term).toLowerCase());
      if (at >= 0) hits.push({ rule, where, sample: window(hay, at) });
    }
    for (const [re, rule] of denylist.patterns) {
      const m = hay.match(re);
      if (m) hits.push({ rule, where, sample: window(hay, hay.indexOf(m[0])) });
    }
  }
  return hits;
}

/** The same rules over a context object, before it ever reaches a template. */
function checkContext(ctx, denylist) {
  const flat = [];
  const walk = (v, path) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number') { flat.push([path, String(v)]); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k); }
  };
  walk(ctx, '');

  const hits = [];
  for (const [path, value] of flat) {
    const lower = value.toLowerCase();
    for (const [term, rule] of denylist.terms) {
      if (lower.includes(String(term).toLowerCase())) hits.push({ rule, where: `context.${path}`, sample: '' });
    }
    for (const [re, rule] of denylist.patterns) {
      /* `render_hole` is a rendering rule, not a data rule: a context value of
         the literal string "undefined" is a legitimate thing to store. */
      if (rule === 'render_hole') continue;
      if (re.test(value)) hits.push({ rule, where: `context.${path}`, sample: '' });
    }
  }
  return hits;
}

/** Forty characters around the hit, with the hit itself masked out. */
function window(hay, at) {
  if (at < 0) return '';
  const from = Math.max(0, at - 20);
  const slice = hay.slice(from, at + 20).replace(/\s+/g, ' ');
  return `...${slice.slice(0, 12)}[redacted]${slice.slice(-12)}...`;
}

/* ------------------------------------------------------------------ *
 * The reads, each one degrading to an empty list
 * ------------------------------------------------------------------ */

/**
 * The org this partner contact actually belongs to, from provider_users, and
 * that org's own name from provider_orgs.
 *
 * Null when it cannot be read, and null is the SAFE answer here: with no
 * known org, every partner name in the campaign goes on the denylist, so the
 * message fails rather than going out unchecked. A scrubber that opened up
 * when its own lookup failed would be a scrubber that stops working exactly
 * when the database is having a bad day.
 */
async function ownOrgSafe(catalystApp, recipient) {
  const id = recipient && recipient.id;
  if (!id) return null;
  try {
    const rows = await datastore.queryAll(catalystApp, 'provider_users',
      ['user_id', 'org_id'], `user_id = ${datastore.lit(String(id))}`);
    const orgId = rows && rows[0] && rows[0].org_id;
    if (!orgId) return null;
    const org = await datastore.findBy(catalystApp, 'provider_orgs', 'org_id',
      orgId, ['legal_name', 'trade_name']);
    return { orgId, name: org ? (org.trade_name || org.legal_name) : null };
  } catch {
    return null;
  }
}

async function bidRowsSafe(catalystApp, campaignId) {
  try {
    const rows = await datastore.queryAll(catalystApp, 'provider_bids',
      ['bid_key', 'campaign_id', 'org_id'],
      `campaign_id = ${datastore.lit(campaignId)}`);
    const out = [];
    for (const r of rows || []) {
      /* eslint-disable-next-line no-await-in-loop */
      out.push({ ...r, org_name: await orgNameSafe(catalystApp, r.org_id) });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * A partner's name as it would appear in copy.
 *
 * `legal_name` is the required column and the only one that exists today.
 * `trade_name` is read first anyway, behind a ladder, because a company
 * emailed under one name and denied under another is a leak the gate would
 * not see: whichever name a template ever prints has to be the one asserted
 * absent from other partners' mail. Both go on the list when both exist.
 */
async function orgNameSafe(catalystApp, orgId) {
  if (!orgId) return null;
  for (const cols of [['legal_name', 'trade_name'], ['legal_name']]) {
    try {
      /* eslint-disable-next-line no-await-in-loop */
      const org = await datastore.findBy(catalystApp, 'provider_orgs', 'org_id', orgId, cols);
      if (!org) return null;
      return org.trade_name || org.legal_name || null;
    } catch {
      /* next, narrower list */
    }
  }
  return null;
}

async function unconfirmedAddressesSafe(catalystApp, campaignId) {
  try {
    const rows = await datastore.queryAll(catalystApp, 'provider_orders',
      ['campaign_id', 'state', 'address_line'],
      `campaign_id = ${datastore.lit(campaignId)}`);
    return (rows || []).filter((r) => r.state === 'acc' && r.address_line);
  } catch {
    return [];
  }
}

async function memberContactsSafe(catalystApp, campaignId) {
  if (!campaignId) return [];
  try {
    const rows = await datastore.queryAll(catalystApp, 'provider_orders',
      ['campaign_id', 'address_line'],
      `campaign_id = ${datastore.lit(campaignId)}`);
    return (rows || []).map((r) => ({ address_line: r.address_line, email: null }));
  } catch {
    return [];
  }
}

module.exports = { UNIVERSAL, denylistFor, check, checkContext, ownOrgSafe, orgNameSafe };
