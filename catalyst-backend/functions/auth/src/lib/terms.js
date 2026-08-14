'use strict';

/**
 * The standard cohort terms: the one agreement every sealed bid runs on.
 *
 * WHY THIS IS A GATE AND NOT A CHECKBOX. One agreement covers every auction,
 * which is the whole reason a household can read one page and compare two
 * bids line by line. If an org could bid without accepting it, the comparison
 * would be between offers made under different rules, and the page a household
 * reads would be describing terms nobody agreed to. So acceptance is checked
 * server side on every bid write, in requireAccepted() below, whatever the
 * console rendered.
 *
 * VERSIONED, AND A NEW VERSION PAUSES BIDDING. The version in force is
 * `cohort_terms_version` in site_config, so an operator publishes a new one by
 * editing a config row rather than by shipping code. Every org that has not
 * accepted THAT version is paused at the next bid attempt: acceptance is
 * keyed on the version, not on a boolean, because "they accepted something at
 * some point" is not a defensible answer to which terms a bid was made under.
 *
 * APPEND-ONLY, like consents and like bids. A row is written once and never
 * updated: the history is the evidence, and accepting v2 must not erase the
 * proof that v1 was accepted when the v1 bids were placed.
 *
 * THIS FAILS CLOSED. If the table cannot be read, requireAccepted refuses the
 * bid rather than waving it through. An unreadable table means we cannot prove
 * acceptance, and a bid placed without provable acceptance is exactly the
 * thing this module exists to prevent. The consequence is real and is called
 * out in scripts/create-tables.md: `provider_terms` must exist before this
 * code is deployed, or no bid can be placed.
 */

const datastore = require('./datastore');
const siteconfig = require('./siteconfig');
const { hashIp } = require('./crypto');
const { clientIp } = require('./request');
const { ms } = require('./envelope');
const { AppError } = require('./errors');

const TABLE = 'provider_terms';

/** The only document this module governs. Named rather than assumed, because
    the partner agreement and the application agreement are different records
    with different lifecycles, and one table serving all three would need this
    column to tell them apart anyway. */
const DOC_TYPE = 'cohort_terms';

const COLUMNS = Object.freeze(['ROWID', 'acceptance_key', 'org_id', 'doc_type',
  'doc_version', 'accepted_at', 'accepted_by', 'accepted_email', 'consent_hash']);

/* A version string reaches an acceptance key and a ZCQL literal. lit() escapes
   it either way, but a version with a space or a quote in it would also make
   the key unreadable to a human reading the table, which is where an operator
   settles a dispute. Anything outside this charset is treated as a misconfigured
   row rather than as the version in force. */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** What the shipped default says when site_config has no row and no answer. */
const FALLBACK_VERSION = 'v1';

/**
 * The version in force right now.
 *
 * A malformed config value falls back rather than throwing: bidding must not
 * stop because someone typed a version with a space in it, and the fallback is
 * the version every existing acceptance is already against.
 */
async function currentVersion(catalystApp) {
  let value;
  try {
    value = await siteconfig.getValue(catalystApp, 'cohort_terms_version');
  } catch {
    value = undefined;
  }
  const v = String(value == null ? '' : value).trim();
  if (VERSION_RE.test(v)) return v;
  if (v) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'cohort_terms_version is not a usable version string; falling back',
      value: v.slice(0, 40),
    }));
  }
  return FALLBACK_VERSION;
}

/** `${orgId}:${docType}:${version}`, the flattened composite key. Catalyst's
    unique constraint is per column and has no composite form, which is the
    same reason coverage_key and bid_key exist. */
function acceptanceKey(orgId, version) {
  return `${orgId}:${DOC_TYPE}:${version}`.slice(0, 200);
}

/**
 * Every acceptance this org has on record, newest first.
 *
 * Returns null, not [], when the table cannot be read. The difference is the
 * whole point: [] means "this org has never accepted", null means "we do not
 * know", and only one of those may ever be rendered as a decision.
 */
async function history(catalystApp, orgId) {
  try {
    const rows = await datastore.queryAll(catalystApp, TABLE, COLUMNS,
      `org_id = ${datastore.lit(orgId)}`);
    return (rows || []).slice().sort((a, b) => String(b.accepted_at || '').localeCompare(String(a.accepted_at || '')));
  } catch {
    return null;
  }
}

/**
 * Where this org stands against the version in force.
 *
 * `current` is the only field a caller should gate on, and it is false
 * whenever we could not read the table: see the header.
 */
async function status(catalystApp, orgId) {
  const version = await currentVersion(catalystApp);
  const rows = await history(catalystApp, orgId);
  if (rows === null) {
    return { docType: DOC_TYPE, version, acceptedVersion: null, acceptedAt: null,
      acceptedBy: null, current: false, live: false };
  }
  const mine = rows.filter((r) => r.doc_type === DOC_TYPE);
  const match = mine.find((r) => r.doc_version === version) || null;
  /* The row that answers "when did you accept, and who": the acceptance of the
     version in force if there is one, otherwise the most recent acceptance of
     any version, which is what makes the "changed to v2" refusal legible. */
  const row = match || mine[0] || null;
  return {
    docType: DOC_TYPE,
    version,
    acceptedVersion: row ? row.doc_version : null,
    acceptedAt: row ? ms(row.accepted_at) : null,
    acceptedBy: row ? (row.accepted_email || null) : null,
    current: !!match,
    live: true,
  };
}

/**
 * Record acceptance of the version in force.
 *
 * Idempotent by key: accepting twice returns the standing row rather than
 * writing a second one, so a double-tapped button and a network retry are the
 * same acceptance. Accepting a NEW version writes a new row and leaves the old
 * one standing, which is the append-only rule.
 */
async function accept(catalystApp, req, { orgId, userId, email, consentHash }) {
  const version = await currentVersion(catalystApp);
  const key = acceptanceKey(orgId, version);

  let existing;
  try {
    existing = await datastore.findBy(catalystApp, TABLE, 'acceptance_key', key, COLUMNS);
  } catch (err) {
    throw new AppError('SERVER_ERROR', 'We could not record that. Please try again shortly.', {
      logDetail: `${TABLE} read failed: ${String((err && err.message) || err).slice(0, 200)}`,
    });
  }
  if (existing) return { version, alreadyAccepted: true };

  const cfg = req.app.get('cfg');
  try {
    await datastore.insertRow(catalystApp, TABLE, {
      acceptance_key: key,
      org_id: orgId,
      doc_type: DOC_TYPE,
      doc_version: version,
      accepted_at: datastore.nowDb(),
      accepted_by: userId,
      accepted_email: email || null,
      /* The hash of the text that was on screen, not just the version number.
         A version number is a label someone can edit later; a hash is what
         makes "this is what they agreed to" provable. Same reasoning as
         endpoint 12 on the application agreement. */
      consent_hash: consentHash || null,
      ip_hash: hashIp(clientIp(req), cfg),
    });
  } catch (err) {
    throw new AppError('SERVER_ERROR', 'We could not record that. Please try again shortly.', {
      logDetail: `${TABLE} write failed: ${String((err && err.message) || err).slice(0, 200)}`,
    });
  }
  return { version, alreadyAccepted: false };
}

/**
 * The bid gate. Throws unless this org has accepted the version in force.
 *
 * Two refusals, because they ask for different acts: an org that has never
 * accepted needs to read and accept, and an org that accepted an older version
 * needs to read what changed. Both land on Contracts, and neither says
 * anything about any other org.
 */
async function requireAccepted(catalystApp, orgId) {
  const st = await status(catalystApp, orgId);
  if (st.current) return st;

  if (!st.live) {
    throw new AppError('SERVER_ERROR',
      'Bidding is not available right now. Please try again shortly.', {
        logDetail: `${TABLE} unreadable: terms gate failed closed for org ${orgId}`,
      });
  }
  if (st.acceptedVersion) {
    throw new AppError('CONFLICT',
      `The standard cohort terms changed to ${st.version}. Accept the new version in Contracts and your desk reopens.`, {
        logDetail: `terms gate: org on ${st.acceptedVersion}, in force ${st.version}`,
      });
  }
  throw new AppError('CONFLICT',
    'Accept the standard cohort terms in Contracts before your first bid. One agreement covers every auction.', {
      logDetail: 'terms gate: no acceptance on record',
    });
}

module.exports = {
  TABLE, DOC_TYPE, COLUMNS, FALLBACK_VERSION,
  currentVersion, acceptanceKey, history, status, accept, requireAccepted,
};
