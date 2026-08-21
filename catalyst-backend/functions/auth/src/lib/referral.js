'use strict';

/**
 * Referral codes: one member's code, the people who arrived with it.
 *
 * TWO FORMS OF CODE RESOLVE HERE, one legacy and one current.
 *
 * The legacy form is DERIVED, NOT STORED: `WHL-` plus the first eight hex
 * characters of the member's `user_id`. That choice let the feature ship
 * without a console table, but it has a cost the token form exists to remove:
 * the code is a literal prefix of the member's UUID, so every share link
 * discloses a third of the account's primary identifier. Legacy codes stay
 * resolvable forever, because links carrying them are already in the wild.
 *
 *   forward   code = f(user_id)          what old links carry
 *   backward  user_id LIKE 'hex*'        a typed legacy code, resolved
 *
 * The current form is an OPAQUE TOKEN from lib/token.js, issued into the
 * `referral_token` table at member creation (and lazily for members who
 * predate the table). It shares nothing about the account. Once the resolver
 * and the dashboard switch over, the token is the only form ever handed out;
 * this module keeps answering for both.
 *
 * Whichever form arrives, the joining member's row stores the normalised
 * string in `users.referral_code`, and the count is an exact match on that
 * column. One row per joining member means one referrer per joining member:
 * the first-touch lock is the column, not a constraint or a workflow.
 *
 * NOTHING HERE MAY THROW ON A BAD CODE. A code that cannot be parsed, a
 * resolution that fails because the store is unreachable, a LIKE that a future
 * ZCQL rejects: all of them return null, and the caller stores the normalised
 * string anyway. Counting is an exact match on that stored string and never
 * depends on resolution having worked, so the loop still closes if the lookup
 * half of this file stops working entirely.
 *
 * The one exported function allowed to throw is `issueToken`, and its callers
 * are required to treat issuance as best-effort: a missing or misbuilt
 * `referral_token` table must never fail a signup.
 */

const datastore = require('./datastore');
const token = require('./token');

const USERS = 'users';
const TOKENS = 'referral_token';
const PREFIX = 'WHL-';
const CORE_LENGTH = 8;

/** The canonical legacy core: lowercase hex, exactly CORE_LENGTH long. */
const CORE_RE = new RegExp(`^[0-9a-f]{${CORE_LENGTH}}$`);

/** The member's own legacy code. Stable for the life of the account. */
function codeFor(user) {
  const core = String((user && user.user_id) || '').replace(/-/g, '').slice(0, CORE_LENGTH);
  return PREFIX + core.toUpperCase();
}

/**
 * The hex core of whatever a human typed, or null.
 *
 * Deliberately forgiving about everything except the core itself. All of these
 * are the same code:
 *
 *   WHL-3F9A2C1D      whl 3f9a2c1d      3F9A2C1D      whl-priyanshu-3f9a2c1d
 *
 * The last form matters: if the card ever displays a friendlier code with the
 * member's name in it, codes already shared as links keep resolving, because
 * only the trailing hex is ever read.
 *
 * The join form's field also invites "a neighbour's email", which cannot
 * resolve to anyone. It parses to null here rather than to a wrong member.
 */
function coreOf(input) {
  const flat = String(input == null ? '' : input).toLowerCase().replace(/[^0-9a-z]/g, '');
  if (flat.length < CORE_LENGTH) return null;
  const tail = flat.slice(-CORE_LENGTH);
  return CORE_RE.test(tail) ? tail : null;
}

/**
 * A typed code in the one form that is ever stored, or null.
 *
 * Every write goes through here. The count is an exact string match, so a row
 * holding `whl 3f9a2c1d` is a referral that happened and will never be
 * counted; normalising at the boundary is what makes the match reliable.
 *
 * DISAMBIGUATION between the two forms, and why it is exact rather than
 * probabilistic. Anything carrying `whl` is read as a legacy code: the prefix
 * is an explicit statement of which system minted it. Anything whose token
 * reading comes out as eight hex characters is ALSO legacy, because
 * lib/token.js never mints an all-hex payload, precisely so this line can
 * exist: a bare `3f9b2c1d` is someone's legacy core, never a token, even on
 * the 1-in-31 occasions it would pass the checksum. Everything else is tried
 * as a token first (the checksum is a strong self-test), then falls back to
 * the legacy trailing-hex read.
 *
 * The one input this can still lose is a token hand-typed with an L standing
 * in for a 1 inside a W-H run (`WH1...` typed as `WHL...`): it routes legacy,
 * parses to null, and the person retypes. A displayed token never contains an
 * L, so nothing copied or clicked can hit this.
 *
 * Token form stored: canonical 8 characters, no hyphen (`K7MQT4WB`).
 * Legacy form stored: `WHL-` + 8 uppercase hex (`WHL-3F9A2C1D`).
 */
const HEX8_RE = /^[0-9A-F]{8}$/;

function normalize(input) {
  const raw = String(input == null ? '' : input);
  if (!/whl/i.test(raw)) {
    const t = token.normalize(raw);
    if (t && !HEX8_RE.test(t)) return t;
  }
  const core = coreOf(raw);
  return core ? PREFIX + core.toUpperCase() : null;
}

/** Is a normalised code the token form? (Anything else is legacy or null.) */
const isTokenForm = (code) =>
  typeof code === 'string' && code.length === token.TOKEN_LEN && !code.startsWith(PREFIX);

/* ------------------------------------------------------------------ *
 * Resolution: code -> the member who owns it
 * ------------------------------------------------------------------ */

/** The projection every resolve returns, whichever path answered. */
const OWNER_COLUMNS = ['user_id', 'first_name', 'email_normalized', 'status'];

/**
 * The member who owns a code, or null if it belongs to nobody.
 *
 * LEGACY PATH. Reads at most a handful of rows: `user_id LIKE 'hex*'` is a
 * prefix match on an eight character hex string, so one row is the expected
 * answer and more than one means two accounts genuinely collided. That case
 * returns null rather than guessing, because crediting the wrong member is
 * worse than telling this one their code was not recognised.
 *
 * ZCQL's LIKE wildcard is `*`, NOT SQL's `%`. Verified in the live console on
 * 2026-08-21: `LIKE 'bf93ebdc%'` returned nothing for a row an exact match
 * found, `LIKE '*bf93ebdc*'` returned it. The `%` spelling shipped 2026-08-14
 * and resolved nobody for a week, silently, because this function never
 * throws; counting survived it (exact match on the stored string), the inline
 * join-form check and the referred_by audit field did not. No unit test can
 * catch this class of bug: it lives in the store's dialect, so the check that
 * guards it is the live probe in create-tables.md section 24.
 *
 * The LIKE literal is interpolated rather than passed through `datastore.lit`,
 * whose charset rejects wildcards by design. CORE_RE above is the guard, and
 * it is asserted again here so a future caller cannot reach the query with
 * anything else.
 *
 * TOKEN PATH. Exact match on `referral_token.token`, then the owner read by
 * `user_id`. Only an `active` token resolves: a suspended or retired one is
 * indistinguishable from an unknown one, deliberately. Owner types other than
 * `member` do not resolve yet; when partner or staff tokens are issued, the
 * decision of what they attribute belongs to that build, not this fallthrough.
 */
async function resolve(catalystApp, input) {
  const norm = normalize(input);
  if (!norm) return null;

  if (isTokenForm(norm)) {
    try {
      const rows = await datastore.query(
        catalystApp, TOKENS,
        `SELECT owner_type, owner_id, status FROM ${TOKENS} ` +
        `WHERE token = ${datastore.lit(norm)} LIMIT 1`
      );
      const row = rows[0];
      if (!row || row.status !== 'active' || row.owner_type !== 'member') return null;
      const owner = await datastore.findBy(catalystApp, USERS, 'user_id', row.owner_id, OWNER_COLUMNS);
      return owner && owner.status !== 'deleted' ? owner : null;
    } catch {
      // A store that cannot answer must not fail the signup that asked.
      return null;
    }
  }

  const core = coreOf(norm);
  if (!core || !CORE_RE.test(core)) return null;

  try {
    const rows = await datastore.query(
      catalystApp, USERS,
      `SELECT ${OWNER_COLUMNS.join(', ')} FROM users ` +
      `WHERE user_id like '${core}*' LIMIT 5`
    );
    const live = (rows || []).filter((r) => r.status !== 'deleted');
    return live.length === 1 ? live[0] : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Issuance: minting a member's token
 * ------------------------------------------------------------------ */

/**
 * Does an insert failure look like the unique constraint firing? The repo has
 * never inspected a Catalyst duplicate error (the established pattern is
 * catch-and-re-read, which cannot apply here: the colliding value is ours to
 * regenerate, not re-read), so this matches broadly and `issueToken` logs the
 * real shape whenever an insert fails, which is how the match gets corrected
 * from Development logs if Catalyst words it differently.
 */
function looksDuplicate(err) {
  const text = `${(err && err.code) || ''} ${(err && err.message) || ''}`;
  return /duplicate|unique|already.?exists/i.test(text);
}

/** One structured line per failed insert: the error's shape, never the token. */
function logIssueFailure(err, attempt) {
  console.error(JSON.stringify({
    level: 'error',
    message: 'referral token insert failed',
    attempt,
    err_code: (err && err.code) != null ? String(err.code).slice(0, 100) : null,
    err_message: String((err && err.message) || err).slice(0, 300),
    err_keys: err && typeof err === 'object' ? Object.keys(err).slice(0, 20) : [],
  }));
}

/**
 * Mint a token for an owner. Returns the canonical 8-character token.
 *
 * On a duplicate-looking failure, regenerate and retry, up to 5 attempts: at
 * 30^7 tokens a collision is roughly one in 21.9 billion per live row, so one
 * retry is already overwhelming and five is paranoia, not a loop that can
 * spin. Any other failure throws immediately, because retrying a missing
 * table five times is five wasted round trips on somebody's signup.
 *
 * No pre-check SELECT: the unique constraint on `token` is the authority, and
 * a SELECT-then-INSERT would just turn one race into another.
 *
 * THROWS on exhaustion or a non-duplicate failure. Callers wrap it: issuance
 * is best-effort everywhere, because a signup is worth more than a token that
 * `tokenFor` will mint lazily on the next dashboard read anyway.
 */
async function issueToken(catalystApp, ownerType, ownerId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const t = token.generate();
    try {
      await datastore.insertRow(catalystApp, TOKENS, {
        token: t,
        owner_type: String(ownerType),
        owner_id: String(ownerId),
        status: 'active',
        clicks: 0,
        issued_at: datastore.nowDb(),
      });
      return t;
    } catch (err) {
      logIssueFailure(err, attempt);
      if (!looksDuplicate(err)) throw err;
    }
  }
  throw new Error('referral token issuance exhausted retries');
}

/**
 * The member's active token, minting one if they have none. Or null.
 *
 * This is the backfill: members who predate the `referral_token` table get a
 * token the first time anything asks for theirs, so no migration script ever
 * runs. Null comes back in two honest cases: the table cannot answer (issuance
 * is best-effort, the caller shows the legacy code or nothing), or the member
 * HAS tokens and none is active. That second case is deliberate: a suspended
 * token was suspended by somebody, and silently minting a replacement here
 * would undo their decision one dashboard read later.
 */
async function tokenFor(catalystApp, user) {
  const userId = user && user.user_id;
  if (!userId) return null;
  try {
    const rows = await datastore.query(
      catalystApp, TOKENS,
      `SELECT token, status FROM ${TOKENS} ` +
      `WHERE owner_type = 'member' AND owner_id = ${datastore.lit(userId)} ` +
      'ORDER BY ROWID LIMIT 5'
    );
    const active = (rows || []).find((r) => r.status === 'active');
    if (active) return active.token;
    if (rows && rows.length) return null;
    return await issueToken(catalystApp, 'member', userId);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Counting
 * ------------------------------------------------------------------ */

/**
 * How many accounts carry this member's code: { joined, pending }.
 *
 * `joined` is accounts that finished verification, which is the number the
 * dashboard shows. `pending` is signups that started and never proved their
 * address, tracked separately so the visible number cannot be inflated by
 * anyone typing an email into a signup form.
 *
 * `codes` is one code or several: a member who has both a legacy derived code
 * and a token is one referrer whose arrivals are split across two stored
 * strings, and both belong in one number. Each code is an exact match on
 * `users.referral_code`; a joining row stores exactly one string, so the
 * queries cannot double-count, but the Set on user_id asserts it anyway.
 *
 * The self filter is belt and braces: signup already refuses a member's own
 * code.
 */
async function countFor(catalystApp, codes, selfUserId) {
  const out = { joined: 0, pending: 0 };
  const list = (Array.isArray(codes) ? codes : [codes]).filter(Boolean);
  if (!list.length) return out;

  const seen = new Set();
  for (const code of list) {
    try {
      const rows = await datastore.queryAll(
        catalystApp, USERS, ['user_id', 'status'],
        `referral_code = ${datastore.lit(code)}`
      );
      for (const row of rows) {
        if (row.user_id === selfUserId || seen.has(row.user_id)) continue;
        seen.add(row.user_id);
        if (row.status === 'active') out.joined += 1;
        else if (row.status === 'pending') out.pending += 1;
      }
    } catch { /* an unreadable count is zero, never an error */ }
  }

  return out;
}

module.exports = {
  codeFor, coreOf, normalize, resolve, countFor,
  issueToken, tokenFor, isTokenForm,
  PREFIX, CORE_LENGTH,
};
