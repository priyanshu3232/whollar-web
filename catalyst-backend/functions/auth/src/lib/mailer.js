'use strict';

/**
 * Outbound email, behind a transport interface.
 *
 * Two implementations, chosen by whether the `mail` config group is set:
 *
 *   zeptomail  real delivery, once a sending domain is verified
 *   log        writes the message to the function log instead of sending
 *
 * The `log` transport is not a placeholder to be replaced later: it is what
 * makes the whole login flow buildable and testable before a sending domain
 * exists. Domain verification is a 24–48h DNS wait plus, for a fresh account,
 * a provider signup; blocking every line of auth on that would be letting a
 * DNS record set the schedule.
 *
 * The API host is configuration rather than a constant because ZeptoMail is
 * regional and this project is on Zoho's Canadian DC. Hard-coding
 * `api.zeptomail.com` would send Canadian customers' addresses to a US
 * endpoint, which is exactly the thing the rest of this schema is careful about.
 */

const DEFAULT_API_BASE = 'https://api.zeptomail.com';

/* ------------------------------------------------------------------ *
 * Transports
 * ------------------------------------------------------------------ */

/**
 * Development transport.
 *
 * Logs the code deliberately and prominently. That is safe here and nowhere
 * else: it is only ever selected when no mail provider is configured, and the
 * routes that surface a code in an HTTP response additionally require
 * NODE_ENV !== production.
 */
async function sendViaLog(cfg, message) {
  console.log(JSON.stringify({
    level: 'info',
    transport: 'log',
    note: 'MAIL NOT SENT: no mail provider configured. Message logged instead.',
    to: message.to,
    subject: message.subject,
    // The whole point: without this the dev flow cannot be completed.
    body_text: message.text,
  }));
  return { ok: true, transport: 'log', delivered: false };
}

/**
 * ZeptoMail's auth scheme is `Zoho-enczapikey <token>`, not Bearer, and the
 * console presents the value inconsistently: sometimes with the prefix
 * included, sometimes as the bare key. Pasting the wrong one produces a 401
 * with no hint as to which half is missing.
 *
 * So normalise instead of documenting: accept either form, and also tolerate
 * `Bearer ` being pasted in front by muscle memory.
 */
function zeptoAuthHeader(raw) {
  const token = String(raw || '').trim().replace(/^Bearer\s+/i, '');
  return /^Zoho-enczapikey\s/i.test(token) ? token : `Zoho-enczapikey ${token}`;
}

async function sendViaZeptoMail(cfg, message) {
  const base = (cfg.ZEPTOMAIL_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');

  const payload = {
    from: { address: cfg.ZEPTOMAIL_FROM, name: 'Whollar' },
    to: [{ email_address: { address: message.to } }],
    subject: message.subject,
    htmlbody: message.html,
    textbody: message.text,
  };
  if (cfg.MAIL_REPLY_TO) payload.reply_to = [{ address: cfg.MAIL_REPLY_TO }];

  const res = await fetch(`${base}/v1.1/email`, {
    method: 'POST',
    headers: {
      Authorization: zeptoAuthHeader(cfg.ZEPTOMAIL_TOKEN),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Truncated and thrown, never returned to the caller's caller: a provider
    // error body can echo the recipient address back.
    throw new Error(`zeptomail ${res.status}: ${body.slice(0, 300)}`);
  }
  return { ok: true, transport: 'zeptomail', delivered: true };
}

/**
 * SMTP relay, via the mailbox provider the domain's SPF already authorizes.
 *
 * The connection is created per send rather than pooled. In a serverless
 * function a pooled connection outlives nothing useful: the container may be
 * frozen between invocations, and a socket held across that comes back dead.
 * Reconnecting costs a round trip; a stale pool costs a failed login.
 */
async function sendViaSmtp(cfg, message) {
  const nodemailer = require('nodemailer');

  const transporter = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    // 587 is STARTTLS: connect in the clear, then upgrade. `secure: true` here
    // would attempt implicit TLS on a port that does not speak it and hang
    // until timeout.
    secure: cfg.SMTP_PORT === 465,
    requireTLS: cfg.SMTP_PORT !== 465,
    auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
    // Bounded, because the caller is a person waiting on a login form. Failing
    // in 10s and telling them to retry beats a 2-minute hang.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  try {
    await transporter.sendMail({
      from: { address: cfg.SMTP_FROM, name: 'Whollar' },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: cfg.MAIL_REPLY_TO || undefined,
    });
    return { ok: true, transport: 'smtp', delivered: true };
  } finally {
    // Not optional: an open connection can keep the invocation alive to its
    // timeout after the response has already been sent.
    try { transporter.close(); } catch { /* ignore */ }
  }
}

/**
 * Which transport is active. Exposed so /health can report it honestly:
 * "why did no email arrive" should be answerable without reading logs.
 *
 * Order is deliberate. ZeptoMail is a transactional service with real
 * deliverability handling, so it wins when configured. SMTP needs no DNS work
 * and is therefore what makes email possible before a domain is verified.
 * `log` is the floor, so the flow is always testable.
 */
function transportName(cfg) {
  const f = cfg.FEATURES || {};
  if (f.mail) return 'zeptomail';
  if (f.smtp) return 'smtp';
  return 'log';
}

/**
 * Send, falling through to the next configured transport on failure.
 *
 * A provider outage on this path is not a degraded experience, it is a locked
 * door: a member with no code cannot sign in at all. So if both ZeptoMail and
 * SMTP are configured, a ZeptoMail failure retries over SMTP rather than
 * surfacing. Keeping the SMTP credentials set after migrating is therefore
 * worth doing, not leftover clutter.
 *
 * It deliberately does NOT fall back to `log` when a real transport exists and
 * fails. Logging the code and reporting success would look like delivery while
 * the user's inbox stayed empty: the failure has to stay visible.
 */
async function send(cfg, message) {
  const f = cfg.FEATURES || {};
  const chain = [];
  if (f.mail) chain.push(['zeptomail', sendViaZeptoMail]);
  if (f.smtp) chain.push(['smtp', sendViaSmtp]);
  if (!chain.length) return sendViaLog(cfg, message);

  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const [name, fn] = chain[i];
    try {
      return await fn(cfg, message);
    } catch (err) {
      lastErr = err;
      const next = chain[i + 1];
      console.error(JSON.stringify({
        level: 'error',
        message: 'mail transport failed',
        transport: name,
        falling_back_to: next ? next[0] : null,
        detail: String((err && err.message) || err).slice(0, 200),
      }));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * The brand mark, as a hosted PNG rather than the site's inline SVG: email
 * clients don't render SVG, and remote images are the only form Gmail and
 * Outlook both accept. Pinned to the production host on purpose: an email is
 * read days after it is sent, long after any preview deployment is gone.
 *
 * Clients that block remote images show the alt text instead, so the mark can
 * only ever be decoration here: nothing a recipient needs may live in it.
 */
const LOGO_URL = 'https://www.whollar.ca/images/email/whollar-mark.png';
const logoImg = () =>
  `<img src="${LOGO_URL}" width="40" height="40" alt="Whollar" style="display:block;border:0;width:40px;height:40px;margin:0 0 20px">`;

/**
 * One set of inline styles shared by every template, so six emails cannot
 * drift into six slightly different cards. Inline because email clients strip
 * <style> blocks; string constants because that is the only reuse mechanism
 * inline styles allow.
 */
const S = {
  body: "margin:0;padding:24px;background:#F4F6F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#102822",
  card: 'max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:32px',
  p: 'margin:0 0 18px;font-size:15px;line-height:1.5',
  sub: 'margin:0 0 18px;font-size:14px;line-height:1.5;color:#4A5D57',
  code: 'margin:0 0 18px;font-size:34px;font-weight:700;letter-spacing:.16em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
  note: 'margin:0 0 14px;font-size:13px;line-height:1.5;color:#6B7C77;border-top:1px solid #E3E8E6;padding-top:16px',
  alert: 'margin:0 0 14px;font-size:14px;line-height:1.5;color:#A34F2B;border-top:1px solid #E3E8E6;padding-top:16px',
  signoff: 'margin:0;font-size:13px;line-height:1.5;color:#6B7C77',
  link: 'color:#178A5A',
};

const renderCard = (inner) => `<!doctype html><html><body style="${S.body}">
  <table role="presentation" cellpadding="0" cellspacing="0" style="${S.card}">
    <tr><td>
      ${logoImg()}
${inner}
    </td></tr>
  </table></body></html>`;

/**
 * "Hi Sam," when a name is on file, "Hi," when it is not: the same bare
 * greeting the copy deck itself uses where no name exists. The name passes
 * through user input on the signup path, so it is flattened and capped here
 * rather than trusted: escaping protects the HTML, this protects the text
 * part, and both protect the reader from a two-hundred-character "name".
 */
function greeting(firstName) {
  const name = String(firstName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name ? `Hi ${name},` : 'Hi,';
}

/**
 * "August 6, 2026 at 1:05 p.m. ET". Eastern time by choice, not accident:
 * the service is Canadian and a raw UTC timestamp in a security email reads
 * as "was that me?" confusion, which is the one question this line exists to
 * answer. Falls back to ISO if ICU is missing rather than sending nothing.
 */
function formatWhen(d) {
  const date = d instanceof Date ? d : new Date(d);
  try {
    const s = new Intl.DateTimeFormat('en-CA', {
      dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Toronto',
    }).format(date);
    return `${s} ET`;
  } catch {
    return date.toISOString();
  }
}

/**
 * The one-time code email.
 *
 * Plain text is not an afterthought. Some clients render it in preference to
 * HTML, and a login code that only exists inside a <table> is a login code some
 * people cannot use.
 *
 * The copy states the code is never asked for by staff. Code-relay phishing,
 * "hi, this is Whollar support, read me the number we just sent", is the
 * common attack against every OTP system, and the email is the only place the
 * warning reliably lands.
 */
function otpEmail({ code, purpose, ttlMinutes, firstName }) {
  const signup = purpose === 'signup';
  const hi = greeting(firstName);
  const lead = signup ? 'Your code to finish creating your Whollar account:' : 'Your sign-in code:';
  const ignore = signup
    ? "If you didn't request this, ignore this email and nothing happens."
    : "If you didn't try to sign in, ignore this email.";
  const never = 'Never share this code. Whollar will never ask you for it.';
  const safeCode = escapeHtml(code);

  const text = [
    hi,
    '',
    lead,
    '',
    code,
    '',
    `It expires in ${ttlMinutes} minutes and works once.`,
    '',
    `${ignore} ${never}`,
    '',
    'The Whollar team',
  ].join('\n');

  const html = renderCard(`      <p style="${S.p}">${escapeHtml(hi)}</p>
      <p style="${S.p}">${escapeHtml(lead)}</p>
      <p style="${S.code}">${safeCode}</p>
      <p style="${S.sub}">It expires in ${ttlMinutes} minutes and works once.</p>
      <p style="${S.note}">${escapeHtml(ignore)} ${escapeHtml(never)}</p>
      <p style="${S.signoff}">The Whollar team</p>`);

  return {
    subject: signup ? `${code} is your Whollar code` : `${code} is your Whollar sign-in code`,
    text,
    html,
  };
}

/**
 * Sent when somebody tries to sign up with an address that already has an
 * active account.
 *
 * This email is the reason `POST /signup` can answer identically in both cases.
 * The alternative, telling the browser "that address is taken", turns the
 * signup form into an account-enumeration oracle, which is exactly what the
 * emailed-code routes were built to avoid. The person who owns the address
 * learns what happened; the person who typed it into the form does not.
 *
 * It deliberately carries NO code and NO link that grants anything. If the
 * attempt came from an attacker, the owner needs to know without that attempt
 * having produced a credential of any kind.
 */
/**
 * `signInPath` because there are two sign-in pages and sending a partner to the
 * member one is a dead end: their credentials do not work there, so the mail
 * that exists to say "you already have an account" would prove the opposite.
 * Defaults to the member page, which is what the one pre-existing caller
 * (password.js) wants.
 */
function existingAccountEmail({ appBaseUrl, firstName, signInPath }) {
  const url = String(appBaseUrl || '').replace(/\/+$/, '');
  const signIn = `${url}${signInPath || '/whollar-login-consumer'}`;
  const hi = greeting(firstName);

  const text = [
    hi,
    '',
    'Someone just tried to create a Whollar account with this email address.',
    '',
    'You already have one, so we did not create a second, and nothing about your',
    'account has changed. Your password is untouched.',
    '',
    `If that was you, sign in instead: ${signIn}`,
    '',
    'If it was not you, you can ignore this email. Nobody can get into your account',
    'from a signup attempt, and we have not sent them any code or link.',
    '',
    'Whollar will never phone, text or email you to ask for your password.',
    '',
    'The Whollar team',
  ].join('\n');

  const html = renderCard(`      <p style="${S.p}">${escapeHtml(hi)}</p>
      <p style="${S.p}">Someone just tried to create a Whollar account with this email address.</p>
      <p style="${S.sub}">You already have one, so we didn't create a second, and nothing about your account has changed. Your password is untouched.</p>
      <p style="${S.p}"><a href="${escapeHtml(signIn)}" style="${S.link}">Sign in instead</a></p>
      <p style="${S.sub}">If it wasn't you, you can ignore this email. Nobody can get into your account from a signup attempt, and we haven't sent them any code or link.</p>
      <p style="${S.note}">Whollar will never phone, text or email you to ask for your password.</p>
      <p style="${S.signoff}">The Whollar team</p>`);

  return { subject: 'You already have a Whollar account', text, html };
}

/**
 * The password-reset code.
 *
 * Kept separate from `otpEmail` rather than reusing it with a different
 * `purpose` string, because the reassurance a person needs here is specific and
 * load-bearing: someone who did NOT ask for this needs to be told, in the
 * message itself, that their password has not changed. A generic "here is your
 * code" reads as though something already happened to their account.
 */
function passwordResetEmail({ code, ttlMinutes, firstName }) {
  const safeCode = escapeHtml(code);
  const hi = greeting(firstName);

  const text = [
    hi,
    '',
    'We received a request to reset the password on your Whollar account. Use this',
    'code to choose a new one:',
    '',
    code,
    '',
    `It expires in ${ttlMinutes} minutes and works once.`,
    '',
    "Didn't request this? Ignore this email. Your password stays as it is.",
    '',
    'Never share this code. Whollar will never ask you for it.',
    '',
    'The Whollar team',
  ].join('\n');

  const html = renderCard(`      <p style="${S.p}">${escapeHtml(hi)}</p>
      <p style="${S.p}">We received a request to reset the password on your Whollar account. Use this code to choose a new one:</p>
      <p style="${S.code}">${safeCode}</p>
      <p style="${S.sub}">It expires in ${ttlMinutes} minutes and works once.</p>
      <p style="${S.sub}">Didn't request this? Ignore this email. Your password stays as it is.</p>
      <p style="${S.note}">Never share this code. Whollar will never ask you for it.</p>
      <p style="${S.signoff}">The Whollar team</p>`);

  return { subject: 'Reset your Whollar password', text, html };
}

/**
 * Sent after a password actually changes.
 *
 * This is the control that makes a stolen account noticeable. Every other
 * defence here is preventive; this one is the only thing that reaches a victim
 * *after* a takeover has succeeded, and without it the theft is silent. It is
 * therefore sent unconditionally, even though the person who just reset their
 * own password does not need it.
 *
 * Carries no code and no link that grants anything: a notification that could
 * itself be used to take the account over would defeat its own purpose.
 */
function passwordChangedEmail({ appBaseUrl, firstName, changedAt }) {
  const url = String(appBaseUrl || '').replace(/\/+$/, '');
  const resetLink = `${url}/whollar-login-consumer`;
  const hi = greeting(firstName);
  // With no timestamp the sentence still stands on its own; "on undefined"
  // would not.
  const when = changedAt ? ` on ${formatWhen(changedAt)}` : ' just now';

  const text = [
    hi,
    '',
    `The password on your Whollar account was changed${when}.`,
    '',
    'Every other device that was signed in has been signed out, so you will need',
    'to sign in again with the new password.',
    '',
    "If this was you, you're all set.",
    '',
    `If it wasn't, reset your password right away (${resetLink}) and reply to this`,
    'email so we can help secure your account.',
    '',
    'The Whollar team',
  ].join('\n');

  const html = renderCard(`      <p style="${S.p}">${escapeHtml(hi)}</p>
      <p style="${S.p}">The password on your Whollar account was changed${escapeHtml(when)}.</p>
      <p style="${S.sub}">Every other device that was signed in has been signed out, so you'll need to sign in again with the new password.</p>
      <p style="${S.sub}">If this was you, you're all set.</p>
      <p style="${S.alert}">If it <b>wasn't</b>, <a href="${escapeHtml(resetLink)}" style="color:#A34F2B">reset your password right away</a> and reply to this email so we can help secure your account.</p>
      <p style="${S.signoff}">The Whollar team</p>`);

  return { subject: 'Your Whollar password was changed', text, html };
}

/**
 * Sent when a reset is requested for an address that has no account.
 *
 * The mirror of `existingAccountEmail`: `/password/forgot` answers identically
 * whether or not an account exists, so the response body cannot say "no account
 * here" without becoming an oracle for who is registered. Telling the address
 * owner by email keeps the person who typed it in none the wiser, while still
 * explaining the silence to someone who genuinely expected a code.
 */
function noAccountEmail({ appBaseUrl }) {
  const url = String(appBaseUrl || '').replace(/\/+$/, '');
  const signUp = `${url}/whollar-login-consumer`;

  const text = [
    'Hi,',
    '',
    'Someone asked to reset a Whollar password for this email address.',
    '',
    'There is no Whollar account here, so there was nothing to reset and we have',
    'not created anything.',
    '',
    `If you meant to join, you can create an account: ${signUp}`,
    '',
    'If this was not you, you can ignore this email. No account exists at this',
    'address and nothing has been sent to anyone else.',
    '',
    'The Whollar team',
  ].join('\n');

  const html = renderCard(`      <p style="${S.p}">Hi,</p>
      <p style="${S.p}">Someone asked to reset a Whollar password for this email address.</p>
      <p style="${S.sub}">There's no Whollar account here, so there was nothing to reset and we haven't created anything.</p>
      <p style="${S.p}"><a href="${escapeHtml(signUp)}" style="${S.link}">Create an account</a></p>
      <p style="${S.note}">If this wasn't you, you can ignore this email. No account exists at this address and nothing has been sent to anyone else.</p>
      <p style="${S.signoff}">The Whollar team</p>`);

  return { subject: 'No Whollar account for this email address', text, html };
}

/**
 * The provider approval / rejection notice: what the admin console sends to
 * every person in an org when a human decides about the company.
 *
 * One template with a branch rather than two templates, so the two outcomes
 * can never drift into different framings of the same decision. The rejection
 * carries the reason verbatim: it was written to be read by the applicant,
 * and a rejection with no reason generates a support thread, not an ending.
 */
function providerDecisionEmail({ approved, orgName, reason, appBaseUrl, firstName }) {
  const url = String(appBaseUrl || '').replace(/\/+$/, '');
  const console_ = `${url}/partner`;
  const name = String(orgName || 'your company').trim();
  const hi = greeting(firstName);

  if (approved) {
    const bullets = [
      'See cohorts forming in your footprint',
      'Submit and update bids on your own terms',
      'Track completed switches and success fees',
    ];

    const text = [
      hi,
      '',
      `Your Whollar partner account for ${name} is approved and live.`,
      '',
      'From your dashboard you can:',
      '',
      ...bullets.map((b) => `· ${b}`),
      '',
      'A reminder of how the model works: you pay only on a completed, retained',
      'switch. No winning bid, no fee. You control your volume and can pause any time.',
      '',
      `Sign in: ${console_}`,
      '',
      'Questions? Reply to this email. A real person reads these.',
      '',
      'The Whollar team',
    ].join('\n');

    const html = renderCard(`      <p style="${S.p}">${escapeHtml(hi)}</p>
      <p style="${S.p}"><b>Your Whollar partner account for ${escapeHtml(name)} is approved and live.</b></p>
      <p style="${S.sub}">From your dashboard you can:</p>
      <ul style="margin:0 0 18px;padding-left:20px;font-size:14px;line-height:1.7;color:#4A5D57">
        ${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('\n        ')}
      </ul>
      <p style="${S.sub}">A reminder of how the model works: you pay only on a completed, retained switch. No winning bid, no fee. You control your volume and can pause any time.</p>
      <p style="${S.p}"><a href="${escapeHtml(console_)}" style="${S.link}">Sign in to your partner dashboard</a></p>
      <p style="${S.note}">Questions? Reply to this email. A real person reads these.</p>
      <p style="${S.signoff}">The Whollar team</p>`);

    return { subject: 'Welcome to Whollar · your partner account is live', text, html };
  }

  const why = String(reason || '').trim();
  const text = [
    hi,
    '',
    `We reviewed ${name}'s Whollar partner application and can't approve it right now.`,
    '',
    why ? `Why: ${why}` : '',
    '',
    'If something here is wrong or has changed, reply to this email. A person',
    'reads it, and a review can be reopened.',
    '',
    'The Whollar team',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');

  const html = renderCard(`      <p style="${S.p}">${escapeHtml(hi)}</p>
      <p style="${S.p}">We reviewed <b>${escapeHtml(name)}</b>'s Whollar partner application and can't approve it right now.</p>
      ${why ? `<p style="${S.sub}"><b>Why:</b> ${escapeHtml(why)}</p>` : ''}
      <p style="${S.note}">If something here is wrong or has changed, reply to this email. A person reads it, and a review can be reopened.</p>
      <p style="${S.signoff}">The Whollar team</p>`);

  return { subject: `About ${name}'s Whollar partner application`, text, html };
}


/* ------------------------------------------------------------------ *
 * The cohort stage email
 * ------------------------------------------------------------------ */

/**
 * One email per stage a cohort reaches, to every household in it.
 *
 * SEVEN STAGES, SEVEN LETTERS, ONE TEMPLATE. The vocabulary is the member's
 * (lib/catalog.js MEMBER_STAGES), not the partner's: a household is told what
 * has happened to its own cohort and what, if anything, it now has to do. The
 * two surfaces already share one derived stage, and this shares it too, so an
 * email can never announce a step the dashboard disagrees with.
 *
 * `doing` is the honest half. Four of the seven stages ask nothing of the
 * household, and saying so plainly is better than manufacturing an action:
 * an email that ends "no action needed" is one the next email is still
 * trusted after.
 */
const STAGE_MAIL = Object.freeze({
  forming: {
    subject: (r) => `${r} is gathering`,
    lead: (r) => `Your cohort in ${r} is open and gathering households.`,
    body: 'The more households join before it locks, the more a partner is bidding for, and the better the price they put forward.',
    doing: 'Nothing to do. We will write again the day joining closes.',
  },
  locked: {
    subject: (r) => `${r} is locked, and the brief is fixed`,
    lead: (r) => `Joining has closed on ${r}. Your cohort's roster is final.`,
    body: 'Partners now receive the brief: how many households, which area, and what you asked for. Nothing about you personally goes to any of them.',
    doing: 'Nothing to do. Sealed bidding opens next.',
  },
  bidding: {
    subject: (r) => `Sealed bidding is live for ${r}`,
    lead: (r) => `Partners are bidding for ${r} now, and every bid is sealed.`,
    body: 'No partner can see another partner\u2019s price, their count, or whether they bid at all. That is what makes them price against your cohort rather than against each other\u2019s guesses.',
    doing: 'Nothing to do. We will send you the winning offer when bidding closes.',
  },
  offers: {
    subject: (r) => `Your offer for ${r} is in`,
    lead: (r) => `Bidding has closed on ${r} and the winning offer is on your dashboard.`,
    body: 'One offer, the lowest headline price your cohort drew. Compare it against your own bill, which is the only comparison that matters.',
    doing: 'Open your dashboard to read it. Accepting is what creates your switch order, and nothing is charged for switching.',
  },
  confirm: {
    subject: (r) => `Confirmations are closing for ${r}`,
    lead: (r) => `The window to accept your offer for ${r} is closing.`,
    body: 'Households that have accepted are counted for the install schedule. Households that have not simply stay where they are, and nothing is owed either way.',
    doing: 'If you want the offer, accept it on your dashboard before the deadline.',
  },
  switching: {
    subject: (r) => `Installs are running for ${r}`,
    lead: (r) => `Your cohort in ${r} has reached its switch window.`,
    body: 'Your partner books your visit from here and carries out the line test. You are not billed for switching, and your old service stays up until the new line passes.',
    doing: 'Watch for your installer to get in touch. Reply to this email if anything looks wrong.',
  },
  done: {
    subject: (r) => `${r} is complete`,
    lead: (r) => `Your cohort in ${r} has finished and the final counts have settled.`,
    body: 'Thank you for going in with your neighbours. A cohort only works because enough households moved at once, and yours did.',
    doing: 'Nothing to do. We will tell you when a new cohort opens near you.',
  },
});

/**
 * The letter for one household about one stage.
 *
 * `when` is the next dated moment on the cohort's calendar, printed only when
 * the row actually carries one. A cohort with a partial calendar says less
 * rather than inventing a date, for the same reason the dashboard does.
 */
function cohortStageEmail({ stage, region, sub, firstName, appBaseUrl, when }) {
  const copy = STAGE_MAIL[stage];
  if (!copy) return null;

  const place = String(region || 'your area').slice(0, 100);
  const label = sub ? `${place}, ${String(sub).slice(0, 100)}` : place;
  const base = String(appBaseUrl || '').replace(/\/+$/, '');
  const link = `${base}/dashboard`;
  const dated = when ? `Next: ${formatWhen(when)}.` : '';

  const text = [
    greeting(firstName),
    '',
    copy.lead(label),
    '',
    copy.body,
    '',
    copy.doing,
    dated,
    '',
    `Your dashboard: ${link}`,
    '',
    'Whollar',
  ].filter((l) => l !== '').join('\n');

  const html = renderCard([
    `      <p style="${S.p}">${escapeHtml(greeting(firstName))}</p>`,
    `      <p style="${S.p}">${escapeHtml(copy.lead(label))}</p>`,
    `      <p style="${S.sub}">${escapeHtml(copy.body)}</p>`,
    `      <p style="${S.p}">${escapeHtml(copy.doing)}</p>`,
    dated ? `      <p style="${S.sub}">${escapeHtml(dated)}</p>` : '',
    `      <p style="${S.p}"><a href="${escapeHtml(link)}" style="${S.link}">Open your dashboard</a></p>`,
    `      <p style="${S.signoff}">Whollar</p>`,
  ].filter(Boolean).join('\n'));

  return { subject: copy.subject(place), text, html };
}

module.exports = {
  send, transportName, otpEmail, existingAccountEmail,
  passwordResetEmail, passwordChangedEmail, noAccountEmail,
  providerDecisionEmail, cohortStageEmail, STAGE_MAIL,
  escapeHtml, DEFAULT_API_BASE,
};
