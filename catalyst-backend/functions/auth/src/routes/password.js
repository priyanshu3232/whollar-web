'use strict';

/**
 * Email + password signup, with the address proven before the account works.
 *
 * THE SHAPE. `POST /signup` creates the account in `status: 'pending'` and
 * emails a code; `POST /signup/verify` checks the code and flips it to
 * 'active', which is also the moment the session is minted. Until that flip,
 * the password is stored but will not let anyone in, so registering with an
 * address you do not control gets you nothing, which is the point.
 *
 * WHY PENDING RATHER THAN NO ROW. The account has to exist before verification,
 * because `email_normalized` is the unique column that stops two people
 * claiming one address in a race. Holding the signup in a side table until the
 * code is checked would move that race somewhere with no constraint to win it.
 *
 * SIGNING IN IS ALSO TWO REQUESTS. `POST /login` checks the password and emails
 * a code; `POST /login/verify` checks the code and mints the session. Every
 * sign-in, not only the first: the password alone never opens the account, so
 * one that leaks is not enough on its own. The two steps reuse the same
 * challenge machinery as signup under their own purpose (`login_mfa`), for the
 * reason set out in lib/challenges.js.
 *
 * WHAT IS DELIBERATELY NOT HERE. No response anywhere tells the caller whether
 * an address already has an account. `/signup` answers identically either way
 * and the owner of the address is told by email instead: see
 * `mailer.existingAccountEmail`. Login collapses every failure into one
 * message. Both rules exist so that this pair cannot be used to ask "does this
 * person bank here?", the same property `routes/otp.js` is built around.
 */

const { AppError, wrap, badRequest, unauthorized, rateLimited } = require('../lib/errors');
const users = require('../lib/users');
const credentials = require('../lib/credentials');
const challenges = require('../lib/challenges');
const consents = require('../lib/consents');
const sessions = require('../lib/sessions');
const mailer = require('../lib/mailer');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');
const referral = require('../lib/referral');
const { canRevealCode } = require('./otp');

/**
 * Issue a verification code and send it.
 *
 * Returns what the response body needs. Send failures are swallowed on purpose:
 * `/signup` must answer identically whether or not the mail provider is having
 * a bad day, or the timing alone becomes the oracle. The failure is recorded on
 * the audit row instead, which is where `/dev/events` will show it.
 */
async function issueCode(req, cfg, email, purpose, firstName = null) {
  const { code, ttlMinutes } = await challenges.start(req.catalyst, req, { email, purpose });
  // The wording follows what the code is FOR, not the challenge purpose string.
  // 'login_mfa' is a second factor on a sign-in, and an email telling someone to
  // "finish creating your Whollar account" when they were signing into an
  // account they have had for a year reads as though something is wrong.
  const message = mailer.otpEmail({
    code, purpose: purpose === 'signup' ? 'signup' : 'login', ttlMinutes, firstName,
  });

  let delivered = false;
  let sendError = null;
  try {
    const result = await mailer.send(cfg, { to: email, ...message });
    delivered = Boolean(result.delivered);
  } catch (err) {
    sendError = String((err && err.message) || err).slice(0, 300);
    console.error(JSON.stringify({
      req_id: req.id, level: 'error', message: 'signup mail send failed', detail: sendError,
    }));
  }

  return { code, ttlMinutes, delivered, sendError };
}

/**
 * The one body every /signup answer returns, whatever actually happened.
 *
 * In production the branches are indistinguishable: no `code` is ever revealed,
 * so all three return `{ok, ttlMinutes}` exactly. The dev-only `dev.code` block
 * IS asymmetric, an existing-account attempt has no code to show, but that
 * asymmetry exists only where `canRevealCode` is true, which is a non-production
 * deploy with no mail provider, and is precisely the signal you want while
 * testing. Do not "fix" it by inventing a code for that branch.
 *
 * Timing is not fully equalised: the create path runs an scrypt hash the
 * already-active path does not. Closing that would mean hashing a throwaway
 * password on every duplicate attempt; it is noted here rather than done,
 * because the remaining signal is small next to network jitter and the
 * defence that matters is that the response body says nothing.
 */
function opaqueOk(cfg, res, { ttlMinutes, code }) {
  const body = { ok: true, ttlMinutes };
  if (code && canRevealCode(cfg)) {
    body.dev = {
      note: 'No mail provider configured: code returned here instead of being sent.',
      code,
    };
  }
  return res.status(200).json(body);
}

function mount(router, cfg) {
  /**
   * Create an account, or appear to.
   *
   * Three cases, one response:
   *   no account      create it pending, store the password, send a code
   *   pending account replace the password, send a fresh code
   *   active account  change NOTHING, email the owner that someone tried
   *
   * The middle case is safe to overwrite precisely because a pending account
   * has never been proven: nobody has signed in with it, nothing is attached to
   * it, and the address owner still has to hold the code to finish. Without it,
   * mistyping a password during signup would permanently wedge the address.
   */
  router.post('/signup', wrap(async (req, res) => {
    const body = req.body || {};
    const email = users.normalizeEmail(body.email || '');
    const password = String(body.password || '');
    const firstName = body.firstName || null;

    // Everything the signup form collects beyond identity. Sanitised and
    // length-capped in users.profileFrom; the FSA is derived there from the
    // postal code rather than accepted from the caller.
    const profile = {
      lastName: body.lastName,
      postalCode: body.postalCode,
      provinceCode: body.provinceCode,
      phone: body.phone,
      referralCode: null,
    };

    if (!users.isEmail(email)) throw badRequest('Enter a valid email address.');
    // Throws a message written to be shown as-is.
    credentials.assertAcceptable(password, email);

    await ratelimit.enforce(req.catalyst, req, {
      key: 'signup.ip', max: 10, windowSec: 3600,
    });
    await ratelimit.enforceFor(req.catalyst, req, email, {
      key: 'signup.email', max: 5, windowSec: 3600,
    });

    const existing = await users.findByEmail(req.catalyst, email);

    if (existing && existing.status === 'active') {
      // Tell the owner, not the caller. Best-effort: a failure here must not
      // change the response, or the timing difference reinstates the oracle.
      try {
        await mailer.send(cfg, {
          to: email,
          ...mailer.existingAccountEmail({
            appBaseUrl: cfg.APP_BASE_URL, firstName: existing.first_name,
          }),
        });
      } catch (err) {
        console.error(JSON.stringify({
          req_id: req.id, level: 'error', message: 'existing-account notice failed',
          detail: String((err && err.message) || err).slice(0, 300),
        }));
      }
      audit.recordAsync(req.catalyst, req, {
        type: 'signup.start', outcome: 'success', email, userId: existing.user_id,
        detail: { branch: 'already_active', notified: true },
      });
      // Same body, same shape, same TTL as a real signup.
      return opaqueOk(cfg, res, { ttlMinutes: challenges.TTL_MINUTES });
    }

    if (existing && existing.status !== 'pending') {
      // Suspended or disabled. Do not resurrect it and do not say so.
      audit.recordAsync(req.catalyst, req, {
        type: 'signup.start', outcome: 'failure', email, userId: existing.user_id,
        detail: { branch: 'not_signupable', status: existing.status },
      });
      return opaqueOk(cfg, res, { ttlMinutes: challenges.TTL_MINUTES });
    }

    /* The referral code, resolved and normalised before it is stored.
     *
     * Normalising is what makes the referrer's count an exact string match
     * instead of a guess: `whl 3f9a2c1d` typed into the field is the same
     * referral as the link that produced it, and only one of the two forms can
     * ever be counted. Resolving is what stops a member crediting themselves,
     * the one abuse the field invites and the only one worth a query.
     *
     * An unparseable value, including the neighbour's email address the field
     * also invites, stores as null rather than as text nothing will ever match.
     * The audit line below records that it happened without keeping a third
     * party's address in a detail blob.
     */
    const referredBy = await referral.resolve(req.catalyst, body.referralCode);
    const referralCode = referral.normalize(body.referralCode);
    const selfReferred = Boolean(referredBy && referredBy.email_normalized === email);
    profile.referralCode = selfReferred ? null : referralCode;

    // An unfinished signup being repeated: take the newer details. They may be
    // correcting the postal code that decides their cohort.
    const { user } = existing
      ? { user: await users.updateProfile(req.catalyst, existing, { firstName, profile }) }
      : await users.findOrCreate(req.catalyst, {
        email, firstName, profile, userType: 'member', status: 'pending',
      });

    await credentials.set(req.catalyst, user.user_id, password);
    const issued = await issueCode(req, cfg, email, 'signup', user.first_name);

    audit.recordAsync(req.catalyst, req, {
      type: 'signup.start', outcome: 'success', email, userId: user.user_id,
      detail: {
        branch: existing ? 'pending_retry' : 'created',
        delivered: issued.delivered,
        transport: mailer.transportName(cfg),
        send_error: issued.sendError,
        referral_code: profile.referralCode,
        referred_by: (!selfReferred && referredBy) ? referredBy.user_id : null,
        referral_rejected: selfReferred ? 'self'
          : (body.referralCode && !referralCode) ? 'unparseable' : null,
      },
    });

    return opaqueOk(cfg, res, { ttlMinutes: issued.ttlMinutes, code: issued.code });
  }));

  /**
   * Prove the address, activate the account, sign in.
   *
   * The session is minted here rather than making the visitor sign in again
   * with the password they set ninety seconds ago: they have just demonstrated
   * both the password and control of the mailbox, which is strictly more than
   * `/login` asks for.
   */
  router.post('/signup/verify', wrap(async (req, res) => {
    const email = users.normalizeEmail((req.body && req.body.email) || '');
    const code = String((req.body && req.body.code) || '').trim();

    if (!users.isEmail(email)) throw badRequest('Enter a valid email address.');
    if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code from your email.');

    await ratelimit.enforce(req.catalyst, req, {
      key: 'signup.verify.ip', max: 30, windowSec: 3600,
    });

    const result = await challenges.verify(req.catalyst, req, { email, code, purpose: 'signup' });

    if (!result.ok) {
      audit.recordAsync(req.catalyst, req, {
        type: 'signup.verify', outcome: 'failure', email,
        detail: { reason: result.reason, remaining: result.remaining },
      });
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: `signup verify failed: ${result.reason}`,
      });
    }

    let user = await users.findByEmail(req.catalyst, email);

    // A consumed code with no account behind it means the row was removed
    // between the two requests. Nothing to activate, and the same message a
    // wrong code gets: the caller learns nothing either way.
    if (!user) {
      audit.recordAsync(req.catalyst, req, {
        type: 'signup.verify', outcome: 'failure', email,
        detail: { reason: 'no_user_for_verified_code' },
      });
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: 'verified signup code had no user row',
      });
    }

    if (user.status === 'pending') {
      user = await users.setStatus(req.catalyst, user, 'active');
      await users.linkIdentity(req.catalyst, {
        userId: user.user_id, provider: 'password',
        providerUid: user.user_id, emailAtProvider: email,
      });
      await consents.recordSignup(req.catalyst, req, {
        userId: user.user_id,
        userType: 'member',
        marketing: Boolean(req.body && req.body.marketing),
      });
    } else if (user.status !== 'active') {
      audit.recordAsync(req.catalyst, req, {
        type: 'signup.verify', outcome: 'failure', email, userId: user.user_id,
        detail: { reason: 'account_not_active', status: user.status },
      });
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: `account status ${user.status}`,
      });
    }

    await users.touchLastLogin(req.catalyst, user);
    const session = await sessions.create(req.catalyst, req, res, {
      userId: user.user_id, userType: user.user_type,
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'signup.complete', outcome: 'success', email, userId: user.user_id,
    });

    res.status(200).json({
      ok: true,
      created: true,
      user: sessions.publicUser(user),
      expiresAt: session.expiresAt,
    });
  }));

  /**
   * Step one of signing in: check the password, then email a code.
   *
   * THIS ROUTE NO LONGER MINTS A SESSION. A correct password gets you a code in
   * your inbox and nothing else; `/login/verify` is what turns that code into a
   * session. Every sign-in goes through both, not just the first one after
   * signup: a password that leaks is then not enough to reach the account,
   * which is the entire reason the second step exists.
   *
   * Every failure below, no such account, no password set, wrong password,
   * locked out, answers with one message. The distinctions are real and they
   * all go to the audit row; none of them reach the caller, because together
   * they would say "this address exists, keep guessing".
   *
   * The unverified case is the single exception, and only AFTER a correct
   * password: at that point the caller has already proven they are the person
   * who signed up, so telling them why they cannot get in reveals nothing they
   * did not already know, and leaving them staring at "incorrect password"
   * when their password is right is how a signup is abandoned.
   */
  router.post('/login', wrap(async (req, res) => {
    const email = users.normalizeEmail((req.body && req.body.email) || '');
    const password = String((req.body && req.body.password) || '');

    if (!users.isEmail(email) || !password) {
      throw badRequest('Enter your email address and password.');
    }

    await ratelimit.enforce(req.catalyst, req, {
      key: 'login.ip', max: 30, windowSec: 3600,
    });
    await ratelimit.enforceFor(req.catalyst, req, email, {
      key: 'login.email', max: 20, windowSec: 3600,
    });

    const wrong = () => unauthorized('That email or password is incorrect.');

    const user = await users.findByEmail(req.catalyst, email);
    if (!user) {
      audit.recordAsync(req.catalyst, req, {
        type: 'login', outcome: 'failure', email, detail: { reason: 'no_user' },
      });
      throw wrong();
    }

    const check = await credentials.check(req.catalyst, user.user_id, password);

    if (!check.ok) {
      audit.recordAsync(req.catalyst, req, {
        type: 'login', outcome: 'failure', email, userId: user.user_id,
        detail: { reason: check.reason },
      });
      if (check.reason === 'locked' || check.reason === 'locked_now') {
        // The one failure that gets its own message. A lockout the user cannot
        // see is indistinguishable from a broken password, and they will spend
        // the window guessing, which is what the lock is there to stop.
        const waitMs = check.retryAfterMs || credentials.LOCK_MS;
        const minutes = Math.max(1, Math.ceil(waitMs / 60000));
        throw rateLimited(
          `Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          { headers: { 'Retry-After': String(Math.ceil(waitMs / 1000)) } }
        );
      }
      throw wrong();
    }

    if (user.status === 'pending') {
      // Correct password, unproven address. Send a fresh code so the dead end
      // comes with the way out of it.
      const issued = await issueCode(req, cfg, email, 'signup', user.first_name);
      audit.recordAsync(req.catalyst, req, {
        type: 'login', outcome: 'failure', email, userId: user.user_id,
        detail: { reason: 'email_unverified', delivered: issued.delivered },
      });
      throw new AppError(
        'EMAIL_UNVERIFIED',
        'Your email address still needs confirming. We’ve sent you a new code.',
        { logDetail: 'login blocked: pending verification' }
      );
    }

    if (user.status !== 'active') {
      audit.recordAsync(req.catalyst, req, {
        type: 'login', outcome: 'failure', email, userId: user.user_id,
        detail: { reason: 'account_not_active', status: user.status },
      });
      throw wrong();
    }

    // The password is proven. Deliberately no session, no cookie, and nothing
    // in the response that a later step could be talked out of requiring: the
    // only thing this hands back is "we emailed you".
    const issued = await issueCode(req, cfg, email, 'login_mfa', user.first_name);

    audit.recordAsync(req.catalyst, req, {
      type: 'login.challenge', outcome: 'success', email, userId: user.user_id,
      detail: {
        rehashed: Boolean(check.rehashed),
        delivered: issued.delivered,
        transport: mailer.transportName(cfg),
        send_error: issued.sendError,
      },
    });

    const body = { ok: true, mfaRequired: true, ttlMinutes: issued.ttlMinutes };
    if (canRevealCode(cfg)) {
      body.dev = {
        note: 'No mail provider configured: code returned here instead of being sent.',
        code: issued.code,
      };
    }
    res.status(200).json(body);
  }));

  /**
   * Step two of signing in: the emailed code, exchanged for the session.
   *
   * The password is NOT re-sent here, and that is safe for exactly one reason:
   * a `login_mfa` challenge is only ever created by `/login`, which reaches
   * that line only after `credentials.check` passed. The code is therefore not
   * a credential on its own: it is the second half of one that has already
   * been presented. If any other route ever starts issuing `login_mfa`
   * challenges, this endpoint becomes a passwordless login, so don't.
   *
   * Every failure answers with the wording a wrong code gets, including an
   * account that stopped being active between the two requests. Someone holding
   * a valid code should not be able to learn that the account was suspended.
   */
  router.post('/login/verify', wrap(async (req, res) => {
    const email = users.normalizeEmail((req.body && req.body.email) || '');
    const code = String((req.body && req.body.code) || '').trim();

    if (!users.isEmail(email)) throw badRequest('Enter a valid email address.');
    if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code from your email.');

    await ratelimit.enforce(req.catalyst, req, {
      key: 'login.verify.ip', max: 30, windowSec: 3600,
    });

    const result = await challenges.verify(req.catalyst, req, {
      email, code, purpose: 'login_mfa',
    });

    if (!result.ok) {
      audit.recordAsync(req.catalyst, req, {
        type: 'login.verify', outcome: 'failure', email,
        detail: { reason: result.reason, remaining: result.remaining },
      });
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: `login verify failed: ${result.reason}`,
      });
    }

    const user = await users.findByEmail(req.catalyst, email);

    if (!user || user.status !== 'active') {
      audit.recordAsync(req.catalyst, req, {
        type: 'login.verify', outcome: 'failure', email,
        userId: (user && user.user_id) || null,
        detail: { reason: user ? 'account_not_active' : 'no_user', status: user && user.status },
      });
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: user ? `account status ${user.status}` : 'verified login code had no user row',
      });
    }

    await users.touchLastLogin(req.catalyst, user);
    const session = await sessions.create(req.catalyst, req, res, {
      userId: user.user_id, userType: user.user_type,
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'login', outcome: 'success', email, userId: user.user_id,
      detail: { factor: 'password+code' },
    });

    res.status(200).json({
      ok: true,
      user: sessions.publicUser(user),
      expiresAt: session.expiresAt,
    });
  }));
}

module.exports = { mount };
