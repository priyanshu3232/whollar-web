'use strict';

/**
 * Outbound email, behind a transport interface.
 *
 * Two implementations, chosen by whether the `mail` config group is set:
 *
 *   zeptomail  real delivery, once a sending domain is verified
 *   log        writes the message to the function log instead of sending
 *
 * The `log` transport is not a placeholder to be replaced later — it is what
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
    note: 'MAIL NOT SENT — no mail provider configured. Message logged instead.',
    to: message.to,
    subject: message.subject,
    // The whole point: without this the dev flow cannot be completed.
    body_text: message.text,
  }));
  return { ok: true, transport: 'log', delivered: false };
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
      // ZeptoMail's scheme, not Bearer. The token already carries its own
      // prefix, so it is passed through verbatim rather than re-prefixed.
      Authorization: cfg.ZEPTOMAIL_TOKEN,
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

/** Which transport is active. Exposed so /health can report it honestly. */
const transportName = (cfg) => (cfg.FEATURES && cfg.FEATURES.mail ? 'zeptomail' : 'log');

async function send(cfg, message) {
  return transportName(cfg) === 'zeptomail'
    ? sendViaZeptoMail(cfg, message)
    : sendViaLog(cfg, message);
}

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * The one-time code email.
 *
 * Plain text is not an afterthought. Some clients render it in preference to
 * HTML, and a login code that only exists inside a <table> is a login code some
 * people cannot use.
 *
 * The copy states the code is never asked for by staff. Code-relay phishing —
 * "hi, this is Whollar support, read me the number we just sent" — is the
 * common attack against every OTP system, and the email is the only place the
 * warning reliably lands.
 */
function otpEmail({ code, purpose, ttlMinutes }) {
  const action = purpose === 'signup' ? 'finish creating your Whollar account' : 'sign in to Whollar';
  const safeCode = escapeHtml(code);

  const text = [
    `Your Whollar code is ${code}`,
    '',
    `Enter this code to ${action}. It expires in ${ttlMinutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email — nobody can sign in without the code.',
    '',
    'Whollar will never phone, text or email you to ask for this code. Anyone who does is not us.',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F4F6F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#102822">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:32px">
    <tr><td>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.5">Enter this code to ${escapeHtml(action)}.</p>
      <p style="margin:0 0 18px;font-size:34px;font-weight:700;letter-spacing:.16em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${safeCode}</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#4A5D57">It expires in ${ttlMinutes} minutes and can only be used once.</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#4A5D57">If you didn't request this, you can ignore this email — nobody can sign in without the code.</p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#6B7C77;border-top:1px solid #E3E8E6;padding-top:16px">Whollar will never phone, text or email you to ask for this code. Anyone who does is not us.</p>
    </td></tr>
  </table></body></html>`;

  return {
    subject: `${code} is your Whollar code`,
    text,
    html,
  };
}

module.exports = { send, transportName, otpEmail, escapeHtml, DEFAULT_API_BASE };
