'use strict';

/**
 * Email one-time-code login: the member sign-in path.
 *
 * There is deliberately no separate "sign up" endpoint. `/otp/start` issues a
 * code for any well-formed address, whether or not an account exists, and
 * `/otp/verify` creates the account if there wasn't one. That single flow is
 * what makes the pair non-enumerable: no timing difference, no status
 * difference, nothing an attacker can use to ask "does this person bank here?"
 *
 * The frontend keeps its Sign in / Create account toggle: that is a copy
 * decision about what the visitor is told, and it costs nothing. The server
 * behaves identically either way.
 */

const { wrap, badRequest, unauthorized } = require('../lib/errors');
const users = require('../lib/users');
const challenges = require('../lib/challenges');
const consents = require('../lib/consents');
const sessions = require('../lib/sessions');
const mailer = require('../lib/mailer');
const notify = require('../lib/notify');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');
const referral = require('../lib/referral');
const share = require('./share');
const datastore = require('../lib/datastore');

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

    // Best-effort personalisation: an existing member gets their name, anyone
    // else gets the bare greeting. A lookup failure falls through to the bare
    // greeting: it must never change the response or block the send.
    const known = await users.findByEmail(req.catalyst, email).catch(() => null);

    /* Through the outbox rather than straight at the transport, so the send is
       recorded, deduplicated and refused to a suppressed address. `security`
       priority means it drains inline, in this request: a person is standing
       at a login form and a queued code is a locked door.

       The event key is the request id, so a double-submitted form is one row
       and one code rather than two of each. Not surfaced to the caller either
       way: a provider outage must not reveal whether this particular address
       was accepted for delivery, which is the same reason /otp/start answers
       identically whether or not an account exists. */
    const sent = await notify.dispatch(req, {
      templateKey: 'account.otp',
      eventKey: `otp.start:${req.id}`,
      to: email,
      user: known,
      context: { code, purpose: 'login', ttl_minutes: ttlMinutes },
    });
    const delivered = Boolean(sent.delivered);

    audit.recordAsync(req.catalyst, req, {
      type: 'otp.start', outcome: 'success', email,
      detail: {
        delivered,
        transport: mailer.transportName(cfg),
        outbox_status: sent.status,
        send_error: sent.status === 'failed' ? (sent.row && sent.row.last_error) || 'send_failed' : null,
      },
    });

    const body = { ok: true, ttlMinutes };
    if (canRevealCode(cfg)) {
      body.dev = {
        note: 'No mail provider configured: code returned here instead of being sent.',
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
      // auth_identities alongside google, rather than being the one
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

      /* An account can be born here as well as at /signup, so the referral a
       * visitor arrived with has to be attached here too, or a neighbour who
       * followed a share link and then signed in with a code instead of a
       * password credits nobody.
       *
       * Written directly rather than through users.updateProfile, which
       * rewrites every profile column and would blank the postal code this
       * account may already have. Best-effort: an unattributed referral is not
       * worth failing a sign-in that has already succeeded.
       */
      /* Two lanes, body first. The body carries whatever the client had: a
       * typed code, or the ?ref= parameter whollar-core banked in localStorage.
       * The cookie is the fallback lane for the visitor whose storage did not
       * survive the trip: set HttpOnly by GET /r/:token, readable only here.
       * Body wins because a typed code is an explicit human statement and the
       * cookie is an inference. */
      const typed = referral.normalize(req.body && req.body.referralCode);
      const banked = typed ? null : share.readRefCookie(req);
      const code = typed || banked;
      if (code && !user.referral_code) {
        const owner = await referral.resolve(req.catalyst, code);
        if (!owner || owner.email_normalized !== email) {
          try {
            await datastore.updateRow(req.catalyst, users.USERS, {
              ROWID: user.ROWID, referral_code: code,
            });
            user.referral_code = code;
            /* The carrier, in its own guarded write: users.referral_carrier
             * (create-tables.md 24b) may not exist yet, and a missing column
             * fails the whole update it rides in, which must never cost the
             * attribution itself. */
            try {
              await datastore.updateRow(req.catalyst, users.USERS, {
                ROWID: user.ROWID,
                referral_carrier: typed ? 'typed_code' : 'link_cookie',
              });
            } catch { /* column not provisioned yet */ }
          } catch { /* the session matters more than the attribution */ }
        }
      }
      /* Spent, suppressed as self-referral, or the account already carries an
       * attribution: in every case the cookie has nothing left to say, and an
       * expired cookie cannot be replayed onto some other account later. */
      if (share.readRefCookie(req)) share.clearRefCookie(req, res);
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
