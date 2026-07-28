'use strict';

/**
 * Email one-time-code login — the member sign-in path.
 *
 * There is deliberately no separate "sign up" endpoint. `/otp/start` issues a
 * code for any well-formed address, whether or not an account exists, and
 * `/otp/verify` creates the account if there wasn't one. That single flow is
 * what makes the pair non-enumerable: no timing difference, no status
 * difference, nothing an attacker can use to ask "does this person bank here?"
 *
 * The frontend keeps its Sign in / Create account toggle — that is a copy
 * decision about what the visitor is told, and it costs nothing. The server
 * behaves identically either way.
 */

const { wrap, badRequest, unauthorized } = require('../lib/errors');
const users = require('../lib/users');
const challenges = require('../lib/challenges');
const consents = require('../lib/consents');
const sessions = require('../lib/sessions');
const mailer = require('../lib/mailer');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');

/**
 * Codes are surfaced in the HTTP response only when BOTH are true: this is not
 * production, and no mail provider is configured so nothing was actually sent.
 * Two conditions rather than one, because either alone is a single edit away
 * from leaking every login code in the product.
 */
const canRevealCode = (cfg) => !cfg.IS_PRODUCTION && mailer.transportName(cfg) === 'log';

function mount(router, cfg) {
  /**
   * Issue a code.
   *
   * Answers 200 with the same body in every non-error case. A caller cannot
   * tell an existing account from a new one, a delivered mail from a suppressed
   * one, or a first attempt from a fifth.
   */
  router.post('/otp/start', wrap(async (req, res) => {
    const rawEmail = (req.body && req.body.email) || '';
    const email = users.normalizeEmail(rawEmail);

    if (!users.isEmail(email)) throw badRequest('Enter a valid email address.');

    // Two limits answering two different questions. Per-IP stops one machine
    // working through many addresses; per-email stops many machines converging
    // on one, which NAT and mobile carriers make the IP limit blind to.
    await ratelimit.enforce(req.catalyst, req, {
      key: 'otp.start.ip', max: 10, windowSec: 3600,
    });
    await ratelimit.enforceFor(req.catalyst, req, email, {
      key: 'otp.start.email', max: 5, windowSec: 3600,
    });

    const { code, ttlMinutes } = await challenges.start(req.catalyst, req, {
      email, purpose: 'login',
    });

    const message = mailer.otpEmail({ code, purpose: 'login', ttlMinutes });
    let delivered = false;
    try {
      const result = await mailer.send(cfg, { to: email, ...message });
      delivered = Boolean(result.delivered);
    } catch (err) {
      // Logged, not surfaced. A provider outage should not tell the caller
      // whether this particular address was accepted for delivery.
      console.error(JSON.stringify({
        req_id: req.id, level: 'error', message: 'otp mail send failed',
        detail: String((err && err.message) || err).slice(0, 200),
      }));
    }

    audit.recordAsync(req.catalyst, req, {
      type: 'otp.start', outcome: 'success', email,
      detail: { delivered, transport: mailer.transportName(cfg) },
    });

    const body = { ok: true, ttlMinutes };
    if (canRevealCode(cfg)) {
      body.dev = {
        note: 'No mail provider configured — code returned here instead of being sent.',
        code,
      };
    }
    res.status(200).json(body);
  }));

  /**
   * Check a code and start a session.
   *
   * Creates the account on first success. Consent rows are written in the same
   * request as the account, not on a later screen: consent that is recorded
   * "soon after" signing up is consent you cannot prove was given before the
   * data was collected.
   */
  router.post('/otp/verify', wrap(async (req, res) => {
    const email = users.normalizeEmail((req.body && req.body.email) || '');
    const code = String((req.body && req.body.code) || '').trim();

    if (!users.isEmail(email)) throw badRequest('Enter a valid email address.');
    if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code from your email.');

    await ratelimit.enforce(req.catalyst, req, {
      key: 'otp.verify.ip', max: 30, windowSec: 3600,
    });

    const result = await challenges.verify(req.catalyst, req, { email, code, purpose: 'login' });

    if (!result.ok) {
      audit.recordAsync(req.catalyst, req, {
        type: 'otp.verify', outcome: 'failure', email,
        // The real reason goes here, where it is useful, and nowhere else.
        detail: { reason: result.reason, remaining: result.remaining },
      });
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: `otp verify failed: ${result.reason}`,
      });
    }

    const { user, created } = await users.findOrCreate(req.catalyst, {
      email,
      firstName: (req.body && req.body.firstName) || null,
      userType: 'member',
    });

    if (user.status !== 'active') {
      audit.recordAsync(req.catalyst, req, {
        type: 'otp.verify', outcome: 'failure', email, userId: user.user_id,
        detail: { reason: 'account_not_active', status: user.status },
      });
      // Same wording a wrong code gets: a disabled account should not be
      // discoverable by anyone holding a valid code for it.
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: `account status ${user.status}`,
      });
    }

    if (created) {
      // The `otp` identity row exists so this login path is represented in
      // auth_identities alongside google/apple, rather than being the one
      // credential type that leaves no trace there.
      await users.linkIdentity(req.catalyst, {
        userId: user.user_id, provider: 'otp',
        providerUid: user.user_id, emailAtProvider: email,
      });
      await consents.recordSignup(req.catalyst, req, {
        userId: user.user_id,
        userType: 'member',
        marketing: Boolean(req.body && req.body.marketing),
      });
    }

    await users.touchLastLogin(req.catalyst, user);
    const session = await sessions.create(req.catalyst, req, res, {
      userId: user.user_id, userType: user.user_type,
    });

    audit.recordAsync(req.catalyst, req, {
      type: created ? 'otp.signup' : 'otp.login',
      outcome: 'success', email, userId: user.user_id,
    });

    res.status(200).json({
      ok: true,
      created,
      user: sessions.publicUser(user),
      expiresAt: session.expiresAt,
    });
  }));
}

module.exports = { mount, canRevealCode };
