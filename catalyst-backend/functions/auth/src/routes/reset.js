'use strict';

/**
 * Forgotten passwords.
 *
 * THE SHAPE. `POST /password/forgot` emails a `password_reset` code;
 * `POST /password/reset` checks that code, replaces the password, kills every
 * existing session, and signs the person in on the spot.
 *
 * WHY THE CODE IS THE WHOLE CREDENTIAL. There is no reset *link* and no reset
 * token in a URL. A link in an email is a bearer credential that leaks through
 * referrers, shoulder-surfing, corporate mail scanners that dereference every
 * URL they see, and browser history. A six-digit code typed back into a page the
 * user already has open leaks through none of those, and the existing challenge
 * machinery already bounds it: ten minutes, five attempts, single use.
 *
 * WHAT IS DELIBERATELY NOT HERE. `/password/forgot` never reveals whether an
 * address has an account, and `/password/reset` collapses every failure into one
 * message. Both properties match `routes/password.js` and exist for the same
 * reason: this pair must not become a way to ask "does this person bank here?"
 */

const { wrap, badRequest, unauthorized } = require('../lib/errors');
const users = require('../lib/users');
const credentials = require('../lib/credentials');
const challenges = require('../lib/challenges');
const sessions = require('../lib/sessions');
const notify = require('../lib/notify');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');
const { canRevealCode } = require('./otp');

const PURPOSE = 'password_reset';

/**
 * Send a message, swallowing failure.
 *
 * Every send on this path is best-effort by design. `/password/forgot` must
 * answer identically whether the mail provider is healthy or on fire, or the
 * timing difference alone becomes the oracle the response body is careful not
 * to be. The failure is recorded on the audit row, which is where it is
 * actually useful.
 */
async function sendQuietly(req, spec) {
  const sent = await notify.dispatch(req, spec);
  return {
    delivered: Boolean(sent.delivered),
    error: sent.status === 'failed' ? 'send_failed' : null,
    status: sent.status,
  };
}

/** The site's own origin, with any trailing slash removed. */
const base = (cfg) => String(cfg.APP_BASE_URL || '').replace(/\/+$/, '');

function mount(router, cfg) {
  /**
   * Ask for a reset code.
   *
   * Two branches, one response. A registered address gets a code; an
   * unregistered one gets an email explaining that there is no account here.
   * The caller cannot tell which happened, but in both cases the person who
   * owns the address is told something true, which is what stops the silence
   * being mistaken for a fault.
   */
  router.post('/password/forgot', wrap(async (req, res) => {
    const email = users.normalizeEmail((req.body && req.body.email) || '');
    if (!users.isEmail(email)) throw badRequest('Enter a valid email address.');

    // Mirrors /signup. Per-IP stops one machine working through many addresses;
    // per-email stops many machines converging on one, which NAT makes the IP
    // limit blind to.
    await ratelimit.enforce(req.catalyst, req, {
      key: 'password.forgot.ip', max: 10, windowSec: 3600,
    });
    await ratelimit.enforceFor(req.catalyst, req, email, {
      key: 'password.forgot.email', max: 5, windowSec: 3600,
    });

    const user = await users.findByEmail(req.catalyst, email);

    if (!user) {
      const sent = await sendQuietly(req, {
        templateKey: 'account.no_account',
        eventKey: `password.forgot.no_account:${req.id}`,
        to: email,
        context: { sign_up_url: `${base(cfg)}/whollar-login-consumer` },
      });
      audit.recordAsync(req.catalyst, req, {
        type: 'password.forgot', outcome: 'failure', email,
        detail: { branch: 'no_account', delivered: sent.delivered, send_error: sent.error },
      });
      return res.status(200).json({ ok: true, ttlMinutes: challenges.TTL_MINUTES });
    }

    const { code, ttlMinutes } = await challenges.start(req.catalyst, req, {
      email, purpose: PURPOSE,
    });
    const sent = await sendQuietly(req, {
      templateKey: 'account.password_reset',
      eventKey: `password.forgot:${req.id}`,
      to: email,
      user,
      context: { code, ttl_minutes: ttlMinutes },
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'password.forgot', outcome: 'success', email, userId: user.user_id,
      detail: { branch: 'code_sent', delivered: sent.delivered, send_error: sent.error },
    });

    const body = { ok: true, ttlMinutes };
    if (canRevealCode(cfg)) {
      body.dev = { note: 'No mail provider configured: code returned here instead.', code };
    }
    return res.status(200).json(body);
  }));

  /**
   * Use the code, set a new password.
   *
   * Also the recovery path for a locked-out account: `credentials.set` clears
   * `failed_count` and `locked_until` as a side effect, so someone who has
   * locked themselves out by forgetting their password is unlocked by the very
   * act of remembering it differently. That is deliberate: a lockout is meant
   * to stop guessing, not to punish the account's owner for fifteen minutes.
   */
  router.post('/password/reset', wrap(async (req, res) => {
    const body = req.body || {};
    const email = users.normalizeEmail(body.email || '');
    const code = String(body.code || '').trim();
    const password = String(body.password || '');

    if (!users.isEmail(email)) throw badRequest('Enter a valid email address.');
    if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code from your email.');
    // Throws 400 with its own message on length or password-equals-email.
    credentials.assertAcceptable(password, email);

    await ratelimit.enforce(req.catalyst, req, {
      key: 'password.reset.ip', max: 30, windowSec: 3600,
    });

    const deny = (reason, userId) => {
      audit.recordAsync(req.catalyst, req, {
        type: 'password.reset', outcome: 'failure', email, userId: userId || null,
        detail: { reason },
      });
      return unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: `password reset failed: ${reason}`,
      });
    };

    const result = await challenges.verify(req.catalyst, req, { email, code, purpose: PURPOSE });
    if (!result.ok) throw deny(result.reason);

    const user = await users.findByEmail(req.catalyst, email);
    // A valid code with no account is not a state a legitimate flow reaches:
    // the challenge is only ever issued for an address that has one. Treat it
    // exactly like a bad code rather than explaining the difference.
    if (!user) throw deny('no_account');
    if (user.status === 'disabled') throw deny('disabled', user.user_id);

    await credentials.set(req.catalyst, user.user_id, password);

    // Holding the code proves the address, which is precisely the proof signup
    // verification asks for. Someone who abandoned signup and then reset their
    // password has therefore done the work, and should not be sent back to a
    // verification step they have just completed by another name.
    if (user.status !== 'active') {
      await users.setStatus(req.catalyst, user, 'active');
      user.status = 'active';
    }

    // BEFORE sessions.create, not after. A password change that leaves existing
    // sessions alive does not actually lock anyone out, which is the entire
    // point of resetting it after a compromise, and reversing the order would
    // revoke the session this request is about to mint.
    const revoked = await sessions.revokeAllForUser(req.catalyst, user.user_id);

    const session = await sessions.create(req.catalyst, req, res, {
      userId: user.user_id, userType: user.user_type,
    });

    // Unconditional, even for the person who just reset their own password.
    // This is the only message that reaches a victim after a takeover has
    // already succeeded; making it conditional would remove it from exactly
    // the case it exists for.
    const sent = await sendQuietly(req, {
      templateKey: 'account.password_changed',
      eventKey: `password.changed:${req.id}`,
      to: email,
      user,
      context: {
        reset_url: `${base(cfg)}/whollar-login-consumer`,
        changed_at: Date.now(),
      },
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'password.reset', outcome: 'success', email, userId: user.user_id,
      detail: { sessions_revoked: revoked, notified: sent.delivered },
    });

    res.status(200).json({
      ok: true,
      user: sessions.publicUser(user),
      expiresAt: session.expiresAt,
    });
  }));
}

module.exports = { mount };
