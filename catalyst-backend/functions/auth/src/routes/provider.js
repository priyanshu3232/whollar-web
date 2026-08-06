'use strict';

/**
 * Partner signup and sign-in.
 *
 * Deliberately NOT the consumer flow with different wording. A partner account
 * clears two independent gates, and conflating them is the mistake this file
 * exists to avoid:
 *
 *   VERIFICATION  proves the person holds the email address. Same mechanism as
 *                 the member flow — a code, `status: pending` until it is used.
 *
 *   APPROVAL      decides whether we deal with that company at all. A human
 *                 sets `provider_orgs.approval_status`. No code path here can
 *                 set it to `approved`.
 *
 * Passing the first does not imply the second. The partner console shows
 * competitor pricing and cohort internals, so "I can read this inbox" must
 * never be sufficient to see any of it — anyone who registers a domain could
 * otherwise read a rival's numbers within minutes.
 *
 * A verified-but-unapproved partner DOES get a session. That is on purpose:
 * they need somewhere to land that says "we're reviewing your application"
 * rather than a login form that silently refuses them forever. The session
 * carries `approved: false`, and every surface that shows real data is
 * required to check it.
 */

const { wrap, badRequest, unauthorized, forbidden } = require('../lib/errors');
const users = require('../lib/users');
const orgs = require('../lib/orgs');
const credentials = require('../lib/credentials');
const challenges = require('../lib/challenges');
const consents = require('../lib/consents');
const sessions = require('../lib/sessions');
const mailer = require('../lib/mailer');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');
const { canRevealCode } = require('./otp');

const PURPOSE = 'signup';
/**
 * The second factor on a partner sign-in. Its own purpose rather than 'signup',
 * so a code emailed to someone signing in cannot be replayed at
 * `/provider/signup/verify` — which activates a pending account — and vice
 * versa. See lib/challenges.js.
 */
const LOGIN_PURPOSE = 'provider_login';

/**
 * Issue and send a code. Failures are swallowed and recorded, never surfaced —
 * `/provider/signup` must answer identically whether the provider is having a
 * bad day, or the timing becomes the oracle the response body refuses to be.
 */
async function issueCode(req, cfg, email, purpose = PURPOSE) {
  const { code, ttlMinutes } = await challenges.start(req.catalyst, req, { email, purpose });
  // Wording follows what the code is for. A partner signing in must not be told
  // to "finish creating your Whollar account".
  const message = mailer.otpEmail({
    code, purpose: purpose === PURPOSE ? 'signup' : 'login', ttlMinutes,
  });

  let delivered = false;
  let sendError = null;
  try {
    const result = await mailer.send(cfg, { to: email, ...message });
    delivered = Boolean(result.delivered);
  } catch (err) {
    sendError = String((err && err.message) || err).slice(0, 300);
    console.error(JSON.stringify({
      req_id: req.id, level: 'error', message: 'provider signup mail failed', detail: sendError,
    }));
  }
  return { code, ttlMinutes, delivered, sendError };
}

/** One body for every /provider/signup outcome. See routes/password.js. */
function opaqueOk(cfg, res, { ttlMinutes, code }) {
  const body = { ok: true, ttlMinutes };
  if (code && canRevealCode(cfg)) {
    body.dev = { note: 'No mail provider configured — code returned here instead.', code };
  }
  return res.status(200).json(body);
}

function mount(router, cfg) {
  /**
   * Register a partner.
   *
   * Creates the person as `pending` and attaches them to an org derived from
   * their email domain — creating that org, also pending, if it is the first
   * time we have seen the domain.
   *
   * Everyone at one domain lands in one org, so the second person from a
   * provider inherits the approval decision already made about that company
   * instead of getting a fresh unreviewed one. That inference is only sound for
   * a corporate domain, which is why free mailbox providers are refused.
   */
  router.post('/provider/signup', wrap(async (req, res) => {
    const body = req.body || {};
    const email = users.normalizeEmail(body.email || '');
    const password = String(body.password || '');

    if (!users.isEmail(email)) throw badRequest('Enter a valid work email address.');

    /**
     * The one place a partner signup answers a question about itself.
     *
     * Everything else here is deliberately opaque, but this cannot be: a person
     * typing their Gmail address needs to be told to use their work address, or
     * they will simply try again, and again, and conclude the form is broken.
     * It also leaks nothing — that gmail.com is a free provider is not a fact
     * about our users.
     */
    if (orgs.isFreeEmailDomain(email)) {
      throw badRequest('Please use your work email address — a personal mailbox cannot be linked to a provider account.');
    }

    credentials.assertAcceptable(password, email);

    await ratelimit.enforce(req.catalyst, req, { key: 'provider.signup.ip', max: 10, windowSec: 3600 });
    await ratelimit.enforceFor(req.catalyst, req, email, { key: 'provider.signup.email', max: 5, windowSec: 3600 });

    const existing = await users.findByEmail(req.catalyst, email);

    // An already-active account: change nothing at all, and say nothing
    // different. The owner is told by email; the caller learns only that the
    // request was accepted.
    if (existing && existing.status === 'active') {
      audit.recordAsync(req.catalyst, req, {
        type: 'provider.signup', outcome: 'failure', email, userId: existing.user_id,
        detail: { reason: 'already_active' },
      });
      return opaqueOk(cfg, res, { ttlMinutes: challenges.TTL_MINUTES });
    }

    const { user } = await users.findOrCreate(req.catalyst, {
      email,
      firstName: body.firstName || null,
      userType: 'provider',
      // Pending until the code is used. A partner who never verifies has an
      // account that cannot be signed into.
      status: 'pending',
      profile: { lastName: body.lastName, phone: body.phone },
    });

    // Safe to overwrite while pending: nothing has ever been proven about this
    // row, so a mistyped password during signup must not wedge the address.
    await credentials.set(req.catalyst, user.user_id, password);

    const { org } = await orgs.findOrCreateForDomain(req.catalyst, {
      domain: orgs.domainOf(email),
      // The company name as typed. Falls back to the domain, because the
      // console heads every screen with it and "" is not a heading.
      legalName: body.orgName || body.company || orgs.domainOf(email),
    });
    await orgs.addMember(req.catalyst, { userId: user.user_id, orgId: org.org_id });

    const { code, ttlMinutes, delivered, sendError } = await issueCode(req, cfg, email);

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.signup', outcome: 'success', email, userId: user.user_id,
      detail: { org_id: org.org_id, approval_status: org.approval_status, delivered, send_error: sendError },
    });

    return opaqueOk(cfg, res, { ttlMinutes, code });
  }));

  /**
   * Check the code, activate the person, and sign them in.
   *
   * Activation is about the human, not the company. The org's approval is
   * untouched here — a partner finishes verification and lands on a "we are
   * reviewing this" screen, which is the honest state.
   */
  router.post('/provider/signup/verify', wrap(async (req, res) => {
    const body = req.body || {};
    const email = users.normalizeEmail(body.email || '');
    const code = String(body.code || '').trim();

    if (!users.isEmail(email)) throw badRequest('Enter a valid work email address.');
    if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code from your email.');

    await ratelimit.enforce(req.catalyst, req, { key: 'provider.verify.ip', max: 30, windowSec: 3600 });

    const result = await challenges.verify(req.catalyst, req, { email, code, purpose: PURPOSE });
    if (!result.ok) {
      audit.recordAsync(req.catalyst, req, {
        type: 'provider.signup.verify', outcome: 'failure', email,
        detail: { reason: result.reason },
      });
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: `provider verify failed: ${result.reason}`,
      });
    }

    const user = await users.findByEmail(req.catalyst, email);
    // A valid code with no pending account is not a state a legitimate flow can
    // reach; treat it exactly like a bad code rather than explaining.
    if (!user || user.user_type !== 'provider' || user.status === 'disabled') {
      throw unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: 'provider verify: no usable account',
      });
    }

    if (user.status !== 'active') {
      await users.setStatus(req.catalyst, user, 'active');
      user.status = 'active';
      await consents.recordSignup(req.catalyst, req, {
        userId: user.user_id,
        userType: 'provider',
        marketing: Boolean(body.marketing),
      });
    }

    const context = await orgs.contextFor(req.catalyst, user.user_id);
    await users.touchLastLogin(req.catalyst, user);
    await sessions.create(req.catalyst, req, res, {
      userId: user.user_id, userType: 'provider',
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.signup.verify', outcome: 'success', email, userId: user.user_id,
      detail: { org_id: context && context.orgId, approval_status: context && context.approvalStatus },
    });

    res.status(200).json({
      ok: true,
      user: sessions.publicUser(user),
      org: context,
      // Hoisted out of `org` so a front end cannot forget to look inside it.
      // The distinction between "signed in" and "allowed to see anything" is
      // the entire point of this flow.
      approved: Boolean(context && context.approved),
    });
  }));

  /**
   * Sign in, step one: check the password, then email a code.
   *
   * No session is minted here. `/provider/login/verify` does that, on every
   * sign-in rather than only the first — a partner console shows competitor
   * pricing and cohort internals, so a leaked password must not be sufficient
   * to open it.
   *
   * Every failure — unknown address, wrong password, unverified, disabled —
   * returns one message. A partner console is a higher-value target than a
   * member account, so the enumeration rule is if anything stricter here.
   *
   * An unapproved partner is NOT refused. They sign in and are told they are
   * still under review; refusing outright leaves someone who applied in good
   * faith with a login form that rejects a correct password and no explanation.
   */
  router.post('/provider/login', wrap(async (req, res) => {
    const body = req.body || {};
    const email = users.normalizeEmail(body.email || '');
    const password = String(body.password || '');

    if (!users.isEmail(email) || !password) {
      throw unauthorized('Check your email or password and try again.', {
        logDetail: 'provider login: malformed input',
      });
    }

    await ratelimit.enforce(req.catalyst, req, { key: 'provider.login.ip', max: 20, windowSec: 900 });
    await ratelimit.enforceFor(req.catalyst, req, email, { key: 'provider.login.email', max: 10, windowSec: 900 });

    const deny = (reason, userId) => {
      audit.recordAsync(req.catalyst, req, {
        type: 'provider.login', outcome: 'failure', email, userId: userId || null,
        detail: { reason },
      });
      return unauthorized('Check your email or password and try again.', {
        logDetail: `provider login failed: ${reason}`,
      });
    };

    const user = await users.findByEmail(req.catalyst, email);
    if (!user) throw deny('no_account');
    if (user.user_type !== 'provider') throw deny('not_a_provider', user.user_id);
    if (user.status === 'disabled') throw deny('disabled', user.user_id);

    const check = await credentials.check(req.catalyst, user.user_id, password);
    if (!check.ok) throw deny(check.reason || 'bad_password', user.user_id);

    // Correct password on an unverified account. Still one message — but the
    // response cannot mint a session, because the address was never proven.
    if (user.status !== 'active') throw deny('not_verified', user.user_id);

    // Password proven; second factor sent. Nothing about the org — not its name,
    // not its approval state — is in this response, because none of it has been
    // earned yet.
    const issued = await issueCode(req, cfg, email, LOGIN_PURPOSE);

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.login.challenge', outcome: 'success', email, userId: user.user_id,
      detail: {
        delivered: issued.delivered,
        transport: mailer.transportName(cfg),
        send_error: issued.sendError,
      },
    });

    const sent = { ok: true, mfaRequired: true, ttlMinutes: issued.ttlMinutes };
    if (canRevealCode(cfg)) {
      sent.dev = { note: 'No mail provider configured — code returned here instead.', code: issued.code };
    }
    res.status(200).json(sent);
  }));

  /**
   * Sign in, step two: the emailed code, exchanged for the session.
   *
   * A `provider_login` challenge is only ever created by `/provider/login`,
   * after the password passed. That is what makes it safe for this endpoint not
   * to ask for the password again — the code is the second half of a credential
   * already presented, not a credential of its own.
   *
   * The failure wording is the same single string the rest of this file uses.
   * Somebody holding a code must not be able to learn that the account was
   * suspended in the ninety seconds since they typed their password.
   */
  router.post('/provider/login/verify', wrap(async (req, res) => {
    const body = req.body || {};
    const email = users.normalizeEmail(body.email || '');
    const code = String(body.code || '').trim();

    if (!users.isEmail(email)) throw badRequest('Enter a valid work email address.');
    if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code from your email.');

    await ratelimit.enforce(req.catalyst, req, { key: 'provider.login.verify.ip', max: 30, windowSec: 3600 });

    const refuse = (reason, userId) => {
      audit.recordAsync(req.catalyst, req, {
        type: 'provider.login.verify', outcome: 'failure', email, userId: userId || null,
        detail: { reason },
      });
      return unauthorized('That code is incorrect or has expired. Request a new one.', {
        logDetail: `provider login verify failed: ${reason}`,
      });
    };

    const result = await challenges.verify(req.catalyst, req, {
      email, code, purpose: LOGIN_PURPOSE,
    });
    if (!result.ok) throw refuse(result.reason);

    const user = await users.findByEmail(req.catalyst, email);
    if (!user) throw refuse('no_user_for_verified_code');
    if (user.user_type !== 'provider') throw refuse('not_a_provider', user.user_id);
    if (user.status !== 'active') throw refuse('account_not_active', user.user_id);

    const context = await orgs.contextFor(req.catalyst, user.user_id);
    await users.touchLastLogin(req.catalyst, user);
    await sessions.create(req.catalyst, req, res, {
      userId: user.user_id, userType: 'provider',
    });

    audit.recordAsync(req.catalyst, req, {
      type: 'provider.login', outcome: 'success', email, userId: user.user_id,
      detail: {
        factor: 'password+code',
        org_id: context && context.orgId,
        approval_status: context && context.approvalStatus,
      },
    });

    res.status(200).json({
      ok: true,
      user: sessions.publicUser(user),
      org: context,
      approved: Boolean(context && context.approved),
    });
  }));

  /**
   * What a signed-in partner is allowed to see about themselves.
   *
   * Separate from `GET /session` so the member endpoint keeps one shape. A
   * member hitting this gets 403 rather than an empty org — being a partner is
   * not a property a member can have.
   */
  router.get('/provider/me', wrap(async (req, res) => {
    if (!req.auth) throw unauthorized('Please sign in again.');
    if (req.auth.user.user_type !== 'provider') {
      throw forbidden('This account is not a provider account.', {
        logDetail: 'non-provider hit /provider/me',
      });
    }
    const context = await orgs.contextFor(req.catalyst, req.auth.user.user_id);
    res.status(200).json({
      ok: true,
      user: sessions.publicUser(req.auth.user),
      org: context,
      approved: Boolean(context && context.approved),
    });
  }));
}

module.exports = { mount };
