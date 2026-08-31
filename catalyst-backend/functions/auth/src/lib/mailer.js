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
 * exists. Domain verification is a 24 to 48h DNS wait plus, for a fresh account,
 * a provider signup; blocking every line of auth on that would be letting a
 * DNS record set the schedule.
 *
 * The API host is configuration rather than a constant because ZeptoMail is
 * regional and this project is on Zoho's Canadian DC. Hard-coding
 * the US host would send Canadian households' addresses to a US endpoint,
 * which is exactly the thing the rest of this schema is careful about.
 */

/* The Canadian host, matching the fallback in lib/config.js. Both exist
 * because either one alone can be reached first: config supplies the value,
 * this catches a caller that hands over a cfg with the key stripped. Neither
 * may be the US host. */
const DEFAULT_API_BASE = 'https://api.zeptomail.ca';

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

  /* `from` is per message, not per function, because transactional and
     commercial mail send from different Mail Agents on different subdomains
     so that a complaint on an announcement cannot damage the deliverability
     of a sign-in code. Falls back to the single configured sender, which is
     what every caller wanted before the split existed. */
  const from = message.from || cfg.ZEPTOMAIL_FROM;

  const payload = {
    from: { address: from, name: message.fromName || 'Whollar' },
    to: [{ email_address: { address: message.to } }],
    subject: message.subject,
    htmlbody: message.html,
    textbody: message.text,
  };
  const replyTo = message.replyTo || cfg.MAIL_REPLY_TO;
  if (replyTo) payload.reply_to = [{ address: replyTo }];

  /* The outbox row id, echoed back on every webhook event. Matching a
     delivery report by message id alone means depending on a value the
     provider chose; this is a value we chose, so a report can always be tied
     to the row that asked for it. */
  if (message.clientReference) payload.client_reference = String(message.clientReference).slice(0, 100);

  /* List-Unsubscribe and List-Unsubscribe-Post (RFC 8058) live here, and a
     stable Message-ID derived from the outbox row so that a resend is a
     visible duplicate in the reader's client rather than a silent one. */
  const mime = Object.assign({}, message.headers || {});
  if (message.messageId) mime['Message-Id'] = message.messageId;
  if (Object.keys(mime).length) payload.mime_headers = mime;

  if (Array.isArray(message.attachments) && message.attachments.length) {
    payload.attachments = message.attachments.map((a) => ({
      name: a.name,
      mime_type: a.mimeType,
      content: a.contentBase64,
    }));
  }

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
    const err = new Error(`zeptomail ${res.status}: ${body.slice(0, 300)}`);
    /* The drain needs to tell a 429 from a 550: one is worth retrying and the
       other never is. Carried on the error rather than parsed back out of the
       message, which would be reading our own log line as an API. */
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  /* The provider's own id, for the webhook that matches on it when a
     client_reference did not survive. Absent on some responses; null is a
     legitimate answer and the delivery row records it as one. */
  let messageId = null;
  try {
    const body = await res.json();
    const first = body && Array.isArray(body.data) ? body.data[0] : null;
    messageId = (first && (first.message_id || first.additional_info)) || body.request_id || null;
    if (messageId && typeof messageId !== 'string') messageId = JSON.stringify(messageId).slice(0, 200);
  } catch {
    /* A 2xx with an unparseable body is still a send. */
  }
  return { ok: true, transport: 'zeptomail', delivered: true, messageId };
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
    const info = await transporter.sendMail({
      from: { address: message.from || cfg.SMTP_FROM, name: message.fromName || 'Whollar' },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo || cfg.MAIL_REPLY_TO || undefined,
      messageId: message.messageId || undefined,
      headers: message.headers || undefined,
      attachments: Array.isArray(message.attachments)
        ? message.attachments.map((a) => ({
          filename: a.name, contentType: a.mimeType, content: a.contentBase64, encoding: 'base64',
        }))
        : undefined,
    });
    return { ok: true, transport: 'smtp', delivered: true, messageId: (info && info.messageId) || null };
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
 * Templates live in lib/notify, not here
 * ------------------------------------------------------------------ */

/**
 * THE EIGHT TEMPLATES THAT USED TO SIT BELOW THIS LINE ARE GONE, and their
 * absence is the point.
 *
 * They moved to `lib/notify/templates/`, behind the registry, because a
 * template needs five things this module could not give it: a CASL class, a
 * preference category, a required-context contract that fails closed, a
 * footer carrying sender identification and a postal address, and a plain
 * text part rendered from the same block list as the HTML rather than written
 * twice. `lib/notify/layout.js` owns the layout; nothing here does.
 *
 * What stayed is the part that was always this module's job: choosing a
 * transport and getting bytes to it. Everything above this comment is that.
 *
 * They were NOT left in place as a fallback. Two copies of a letter is how
 * the copy in one of them goes stale while the other ships, and this file's
 * own header made that argument about inline styles before it was true of
 * whole templates. `escapeHtml` is exported because `lib/notify/layout.js`
 * uses the same one.
 */

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

module.exports = { send, transportName, escapeHtml, DEFAULT_API_BASE };
