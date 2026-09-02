'use strict';

/**
 * Account and security mail, both audiences.
 *
 * Audience is `auto`: these are facts about a person's account, and a partner
 * signing in gets the partner palette without a second copy of the words.
 *
 * Every one of these is `security` priority, which means the outbox drains it
 * inline rather than on the next sweep. A member standing at a login form
 * cannot wait a minute for a scheduler, and a sign-in code that arrives after
 * it expires is worse than no code at all.
 *
 * None of them carries an unsubscribe link, because none of them is a
 * commercial electronic message. All of them carry sender identification, the
 * legal name, the postal address and a link to notification settings, because
 * CASL exempts transactional mail from the opt-out and from nothing else.
 */

module.exports = [

  /* ---------------------------------------------------------------- *
   * The one-time code
   *
   * The copy states that staff never ask for the code. Code-relay phishing,
   * "hi, this is Whollar support, read me the number we just sent", is the
   * common attack against every system like this, and the email is the only
   * place the warning reliably lands.
   * ---------------------------------------------------------------- */
  {
    key: 'account.otp',
    fixture: { code: '481920', purpose: 'login', ttl_minutes: 10, first_name: 'Sam' },
    audience: 'auto',
    casl: 'transactional',
    priority: 'security',
    category: 'security',
    collapse: null,
    required: ['code', 'ttl_minutes'],
    locales: {
      en: (c, h) => {
        const signup = c.purpose === 'signup';
        const lead = signup
          ? 'Your code to finish creating your Whollar account:'
          : 'Your sign-in code:';
        const ignore = signup
          ? "If you didn't request this, ignore this email and nothing happens."
          : "If you didn't try to sign in, ignore this email.";
        return {
          subject: signup ? `${c.code} is your Whollar code` : `${c.code} is your Whollar sign-in code`,
          preheader: `Expires in ${c.ttl_minutes} minutes and works once.`,
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.para(lead),
            h.B.code(c.code),
            h.B.soft(`It expires in ${c.ttl_minutes} minutes and works once.`),
            h.B.note(`${ignore} Never share this code. Whollar will never ask you for it.`),
          ],
        };
      },
    },
  },

  /* ---------------------------------------------------------------- *
   * Somebody tried to sign up with an address that already has an account.
   *
   * This email is the reason the signup route can answer identically in both
   * cases. Telling the browser "that address is taken" turns the form into an
   * account enumeration oracle. The person who owns the address learns what
   * happened; the person who typed it into the form does not.
   *
   * It carries NO code and NO link that grants anything. If the attempt came
   * from an attacker, the owner needs to know without that attempt having
   * produced a credential of any kind.
   * ---------------------------------------------------------------- */
  {
    key: 'account.signup_collision',
    fixture: { sign_in_url: 'https://internet.whollar.ca/whollar-login-consumer', first_name: 'Sam' },
    audience: 'auto',
    casl: 'transactional',
    priority: 'security',
    category: 'security',
    collapse: null,
    required: ['sign_in_url'],
    locales: {
      en: (c, h) => ({
        subject: 'You already have a Whollar account',
        preheader: 'Nothing changed, and we did not create a second account.',
        greeting: h.greet(c.first_name),
        blocks: [
          h.B.hero('Someone just tried to create a Whollar account with this email address.'),
          h.B.soft('You already have one, so we did not create a second, and nothing about your account has changed. Your password is untouched.'),
          h.B.action('Sign in instead', c.sign_in_url),
          h.B.soft('If it was not you, you can ignore this email. Nobody can get into your account from a signup attempt, and we have not sent them any code or link.'),
          h.B.note('Whollar will never phone, text or email you to ask for your password.'),
        ],
      }),
    },
  },

  /* ---------------------------------------------------------------- *
   * The password reset code.
   *
   * Kept separate from `account.otp` rather than reusing it with a different
   * purpose, because the reassurance a person needs here is specific and load
   * bearing: someone who did NOT ask for this has to be told, in the message
   * itself, that their password has not changed. A generic "here is your
   * code" reads as though something already happened to their account.
   * ---------------------------------------------------------------- */
  {
    key: 'account.password_reset',
    fixture: { code: '481920', ttl_minutes: 10, first_name: 'Sam' },
    audience: 'auto',
    casl: 'transactional',
    priority: 'security',
    category: 'security',
    collapse: null,
    required: ['code', 'ttl_minutes'],
    locales: {
      en: (c, h) => ({
        subject: 'Reset your Whollar password',
        preheader: `Expires in ${c.ttl_minutes} minutes and works once.`,
        greeting: h.greet(c.first_name),
        blocks: [
          h.B.para('We received a request to reset the password on your Whollar account. Use this code to choose a new one:'),
          h.B.code(c.code),
          h.B.soft(`It expires in ${c.ttl_minutes} minutes and works once.`),
          h.B.soft('Did not request this? Ignore this email. Your password stays as it is.'),
          h.B.note('Never share this code. Whollar will never ask you for it.'),
        ],
      }),
    },
  },

  /* ---------------------------------------------------------------- *
   * Sent after a password actually changes.
   *
   * This is the control that makes a stolen account noticeable. Every other
   * defence is preventive; this one is the only thing that reaches a victim
   * after a takeover has succeeded, and without it the theft is silent. It is
   * sent unconditionally, even though the person who just reset their own
   * password does not need it.
   * ---------------------------------------------------------------- */
  {
    key: 'account.password_changed',
    fixture: { reset_url: 'https://internet.whollar.ca/whollar-login-consumer', changed_at: 1787000000000, first_name: 'Sam' },
    audience: 'auto',
    casl: 'transactional',
    priority: 'security',
    category: 'security',
    collapse: null,
    required: ['reset_url'],
    locales: {
      en: (c, h) => {
        const at = c.changed_at ? ` on ${h.when(c.changed_at)}` : ' just now';
        return {
          subject: 'Your Whollar password was changed',
          preheader: 'Every other signed-in device has been signed out.',
          greeting: h.greet(c.first_name),
          blocks: [
            h.B.hero(`The password on your Whollar account was changed${at}.`),
            h.B.soft('Every other device that was signed in has been signed out, so you will need to sign in again with the new password.'),
            h.B.soft('If this was you, you are all set.'),
            h.B.alert('If it was not you, reset your password right away and reply to this email so we can help secure your account.',
              c.reset_url, 'Reset your password'),
          ],
        };
      },
    },
  },

  /* ---------------------------------------------------------------- *
   * A reset was asked for on an address with no account.
   *
   * The mirror of the signup collision: the forgot-password route answers
   * identically whether or not an account exists, so the response body cannot
   * say "no account here" without becoming an oracle for who is registered.
   * Telling the address owner by email keeps the person who typed it in none
   * the wiser, while explaining the silence to someone who expected a code.
   * ---------------------------------------------------------------- */
  {
    key: 'account.no_account',
    fixture: { sign_up_url: 'https://internet.whollar.ca/whollar-login-consumer' },
    audience: 'auto',
    casl: 'transactional',
    priority: 'security',
    category: 'security',
    collapse: null,
    required: ['sign_up_url'],
    locales: {
      en: (c, h) => ({
        subject: 'No Whollar account for this email address',
        preheader: 'There was nothing to reset, and we created nothing.',
        greeting: 'Hi,',
        blocks: [
          h.B.hero('Someone asked to reset a Whollar password for this email address.'),
          h.B.soft('There is no Whollar account here, so there was nothing to reset and we have not created anything.'),
          h.B.action('Create an account', c.sign_up_url),
          h.B.note('If this was not you, you can ignore this email. No account exists at this address and nothing has been sent to anyone else.'),
        ],
      }),
    },
  },
];
