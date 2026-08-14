'use strict';

/**
 * Referral codes: one member's code, the people who arrived with it.
 *
 * THE CODE IS DERIVED, NOT STORED.
 *
 * `WHL-` plus the first eight hex characters of the member's `user_id`. That
 * choice is what lets this feature ship without a console table: there is no
 * column holding "the code you own", so there is nothing to allocate, nothing
 * to collide, and nothing to migrate. The one column involved is the existing
 * `users.referral_code`, which holds the code a member ARRIVED with.
 *
 * Two properties make the derivation work in both directions:
 *
 *   forward   code = f(user_id)          rendered on the dashboard
 *   backward  user_id LIKE 'hex%'        a typed code resolved to its owner
 *
 * The backward direction is only possible because `user_id` is a v4 UUID whose
 * first dash sits at index 8: stripping dashes and taking eight characters is
 * the same string as taking eight characters raw, so the code is a literal
 * prefix of the stored id and a prefix match finds it.
 *
 * Eight characters is 4.3 billion codes. Six would have been friendlier to
 * read aloud and would have collided at roughly three percent by ten thousand
 * members, which is a member silently receiving someone else's credit.
 *
 * NOTHING HERE MAY THROW ON A BAD CODE. A code that cannot be parsed, a
 * resolution that fails because the store is unreachable, a LIKE that a future
 * ZCQL rejects: all of them return null, and the caller stores the normalised
 * string anyway. Counting is an exact match on that stored string and never
 * depends on resolution having worked, so the loop still closes if the lookup
 * half of this file stops working entirely.
 */

const datastore = require('./datastore');

const USERS = 'users';
const PREFIX = 'WHL-';
const CORE_LENGTH = 8;

/** The canonical core: lowercase hex, exactly CORE_LENGTH long. */
const CORE_RE = new RegExp(`^[0-9a-f]{${CORE_LENGTH}}$`);

/** The member's own code. Stable for the life of the account. */
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
 */
function normalize(input) {
  const core = coreOf(input);
  return core ? PREFIX + core.toUpperCase() : null;
}

/**
 * The member who owns a code, or null if it belongs to nobody.
 *
 * Reads at most a handful of rows: `user_id LIKE 'hex%'` is a prefix match on
 * an eight character hex string, so one row is the expected answer and more
 * than one means two accounts genuinely collided. That case returns null
 * rather than guessing, because crediting the wrong member is worse than
 * telling this one their code was not recognised.
 *
 * The literal is interpolated rather than passed through `datastore.lit`,
 * which rejects `%` by design. CORE_RE above is the guard, and it is asserted
 * again here so a future caller cannot reach the query with anything else.
 */
async function resolve(catalystApp, input) {
  const core = coreOf(input);
  if (!core || !CORE_RE.test(core)) return null;

  try {
    const rows = await datastore.query(
      catalystApp, USERS,
      'SELECT user_id, first_name, email_normalized, status FROM users ' +
      `WHERE user_id like '${core}%' LIMIT 5`
    );
    const live = (rows || []).filter((r) => r.status !== 'deleted');
    return live.length === 1 ? live[0] : null;
  } catch {
    // A store that cannot answer must not fail the signup that asked.
    return null;
  }
}

/**
 * How many accounts carry this member's code: { joined, pending }.
 *
 * `joined` is accounts that finished verification, which is the number the
 * dashboard shows. `pending` is signups that started and never proved their
 * address, tracked separately so the visible number cannot be inflated by
 * anyone typing an email into a signup form.
 *
 * Filtered on `referral_code`, so this reads the rows that used the code
 * rather than the users table. The self filter is belt and braces: signup
 * already refuses a member's own code.
 */
async function countFor(catalystApp, code, selfUserId) {
  const out = { joined: 0, pending: 0 };
  if (!code) return out;

  try {
    const rows = await datastore.queryAll(
      catalystApp, USERS, ['user_id', 'status'],
      `referral_code = ${datastore.lit(code)}`
    );
    for (const row of rows) {
      if (row.user_id === selfUserId) continue;
      if (row.status === 'active') out.joined += 1;
      else if (row.status === 'pending') out.pending += 1;
    }
  } catch { /* an unreadable count is zero, never an error */ }

  return out;
}

module.exports = { codeFor, coreOf, normalize, resolve, countFor, PREFIX, CORE_LENGTH };
