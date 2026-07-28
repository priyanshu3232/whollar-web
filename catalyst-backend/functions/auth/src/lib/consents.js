'use strict';

/**
 * Versioned consent records.
 *
 * One row per document, never a single boolean and never a bundled flag. CASL
 * and Quebec Law 25 both want consent that is provable, versioned and
 * timestamped, and marketing consent has to be withdrawable independently of
 * agreeing to the terms — a single `agreed: true` column can express none of
 * that.
 *
 * Rows are append-only. A withdrawal is a new row, not an update: the history
 * is the evidence, and an UPDATE destroys exactly the thing being relied on.
 */

const datastore = require('./datastore');
const { hashIp } = require('./crypto');
const { clientIp } = require('./request');

const TABLE = 'consents';

const DOC_TYPES = Object.freeze(['terms', 'privacy', 'partner_terms', 'marketing']);

/**
 * Which document versions apply right now.
 *
 * Returns null when the `consents` config group is unset, which the caller must
 * treat as "cannot record consent" rather than "no consent needed".
 */
function currentVersions(cfg, userType) {
  if (!cfg.FEATURES || !cfg.FEATURES.consents) return null;
  const docs = [
    { doc_type: 'terms', doc_version: cfg.TERMS_VERSION },
    { doc_type: 'privacy', doc_version: cfg.PRIVACY_VERSION },
  ];
  if (userType === 'provider') {
    docs.push({ doc_type: 'partner_terms', doc_version: cfg.PARTNER_TERMS_VERSION });
  }
  return docs;
}

/**
 * Record acceptance of the documents in force, at signup.
 *
 * Best-effort per row, and deliberately so: a failed consent write must not
 * cost someone their account creation, because the account already exists by
 * the time this runs. The failure is logged loudly instead — a gap in the
 * consent record is a compliance problem, and a silent one is worse.
 */
async function recordSignup(catalystApp, req, { userId, userType, marketing = false }) {
  const cfg = req.app.get('cfg');
  const docs = currentVersions(cfg, userType);

  if (!docs) {
    console.warn(JSON.stringify({
      req_id: req.id,
      level: 'warn',
      message: 'consent NOT recorded — the consents config group is unset',
      user_id: userId,
    }));
    return { recorded: 0, skipped: true };
  }

  if (marketing) {
    // Marketing gets its own row and its own version so it can be withdrawn on
    // its own. Bundling it with terms is precisely what CASL does not allow.
    docs.push({ doc_type: 'marketing', doc_version: cfg.PRIVACY_VERSION });
  }

  const acceptedAt = datastore.nowDb();
  const ipHash = hashIp(clientIp(req), cfg);
  let recorded = 0;

  for (const doc of docs) {
    try {
      await datastore.insertRow(catalystApp, TABLE, {
        user_id: userId,
        doc_type: doc.doc_type,
        doc_version: doc.doc_version,
        accepted_at: acceptedAt,
        ip_hash: ipHash,
      });
      recorded++;
    } catch (err) {
      console.error(JSON.stringify({
        req_id: req.id,
        level: 'error',
        message: 'consent row failed to write',
        doc_type: doc.doc_type,
        detail: String((err && err.message) || err).slice(0, 200),
      }));
    }
  }
  return { recorded, skipped: false };
}

/** Every consent row for a user, newest first. For a data-access request. */
async function listForUser(catalystApp, userId) {
  return datastore.queryAll(
    catalystApp, TABLE, ['user_id', 'doc_type', 'doc_version', 'accepted_at'],
    `user_id = ${datastore.lit(userId)}`
  );
}

module.exports = { TABLE, DOC_TYPES, currentVersions, recordSignup, listForUser };
