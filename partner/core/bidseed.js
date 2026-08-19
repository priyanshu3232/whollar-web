/* The terms a partner last sealed, kept so the next cohort's form opens on
 * them instead of on the house defaults.
 *
 * WHY THIS IS NOT A SERVER PREFERENCE. A partner's rate card is already on the
 * server, once per sealed bid, and /provider/bids returns it. What the server
 * does NOT keep is the custom discount schedule: readBid() takes a single
 * mechanismLabel and drops discountMix on the floor (see desk.js headFields),
 * so a mix rebuilt from a sealed head is one row, not the steps that were
 * typed. This module keeps the whole draft locally so the schedule survives a
 * reload; views/ticket.js falls back to the sealed head when it does not.
 *
 * NO PARTNER SEES ANOTHER PARTNER'S TERMS. The record carries the org it was
 * written by and read() refuses it to any other org, so a shared browser
 * cannot leak one org's pricing into another org's form. Sign-out clears it
 * outright rather than relying on that check.
 *
 * Nothing here is authoritative. It is a starting point for a form; the bid is
 * whatever the DOM says at seal time, and the server validates that.
 */

var KEY = 'whollar.partner.bidseed';

/* A seed older than this is not offered. A rate card from three months ago is
   not a convenience, it is a wrong number wearing a familiar face. */
var MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

function store() {
  try { return window.localStorage; } catch (e) { return null; }
}

/**
 * The stored seed for this org, or null.
 * `orgId` is the org asking; a mismatch reads as no seed, never as someone
 * else's terms.
 */
export function readSeed(orgId) {
  var ls = store();
  if (!ls || !orgId) return null;
  var raw;
  try { raw = ls.getItem(KEY); } catch (e) { return null; }
  if (!raw) return null;
  var rec;
  try { rec = JSON.parse(raw); } catch (e) { clearSeed(); return null; }
  if (!rec || rec.orgId !== orgId || !rec.draft) return null;
  if (!(rec.savedAt > 0) || (Date.now() - rec.savedAt) > MAX_AGE_MS) return null;
  return { draft: rec.draft, from: rec.from || null, savedAt: rec.savedAt };
}

/** Remember these terms for the next cohort. Failure is silent on purpose:
    a full disk or a private window must not break sealing a bid. */
export function writeSeed(orgId, draft, from) {
  var ls = store();
  if (!ls || !orgId || !draft) return;
  try {
    ls.setItem(KEY, JSON.stringify({ orgId: orgId, draft: draft, from: from || null, savedAt: Date.now() }));
  } catch (e) { /* not worth a toast */ }
}

export function clearSeed() {
  var ls = store();
  if (!ls) return;
  try { ls.removeItem(KEY); } catch (e) { /* nothing to do */ }
}
