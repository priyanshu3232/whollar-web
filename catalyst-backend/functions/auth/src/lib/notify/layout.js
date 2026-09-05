'use strict';

/**
 * The two base layouts, and the block renderer that feeds them.
 *
 * WHY BLOCKS AND NOT STRINGS. A template here returns a list of blocks, not
 * HTML. The HTML and the plain text are both rendered from that same list, so
 * the text part cannot drift from the HTML part and cannot be a stripped
 * approximation of it. Some clients render text in preference to HTML, and a
 * sign-in code that only exists inside a <table> is a code some people cannot
 * use. That was already true of lib/mailer.js; this makes it structural
 * rather than a habit each template has to remember.
 *
 * WHY TABLES AND INLINE STYLES. Outlook has no flexbox, no grid, and strips
 * <style> blocks. Gmail clips a message over roughly 102 KB. Every rule here
 * is inline, every layout is a table, and there is no web font: the stack
 * names Satoshi and General Sans because a handful of clients will honour a
 * locally installed copy, and the fallback is what almost everyone sees, so
 * the design is drawn for the fallback.
 *
 * WHY EVERY CELL CARRIES AN EXPLICIT BACKGROUND. Apple Mail and Gmail invert
 * dark mode differently, and both of them invert a cell with no declared
 * background while leaving declared text colour alone. That produces black
 * text on a black card, which is not a theming imperfection, it is an
 * unreadable email. Declaring both ends on every cell is the only thing that
 * survives both engines.
 *
 * WHY THE FOOTER IS NOT OPTIONAL. CASL exempts transactional mail from the
 * unsubscribe requirement. It does not exempt anything from sender
 * identification or a physical mailing address. None of the eight templates
 * this replaces carried either.
 */

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* Hosted PNG, not the site's inline SVG: Outlook does not render SVG, and a
   remote image is the only form Gmail and Outlook both accept. Pinned to the
   production host because an email is read days after it is sent, long after
   any preview deployment is gone. Clients that block remote images show the
   alt text, so the mark can only ever be decoration. */
const LOGO_URL = 'https://internet.whollar.ca/images/email/whollar-mark.png';

const FONT = "Satoshi,'General Sans',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/* The palette, per audience. Member and partner share the ground and differ
   in accent; admin is deliberately plain, because it is read as a log. */
const PALETTE = Object.freeze({
  member:  { ground: '#F1EFE8', card: '#FFFFFF', ink: '#0E2A20', soft: '#4A5D57',
             faint: '#6B7C77', rule: '#E3E8E6', accent: '#1E9E63', link: '#178A5A',
             warn: '#C2643B', chip: '#FAF8F3' },
  partner: { ground: '#EEF2F0', card: '#FFFFFF', ink: '#0E2A20', soft: '#41544E',
             faint: '#65766F', rule: '#DFE6E3', accent: '#0E2A20', link: '#178A5A',
             warn: '#C2643B', chip: '#F4F7F5' },
  admin:   { ground: '#F4F4F4', card: '#FFFFFF', ink: '#1A1A1A', soft: '#444444',
             faint: '#6A6A6A', rule: '#E0E0E0', accent: '#0E2A20', link: '#1155CC',
             warn: '#B3452B', chip: '#F7F7F7' },
});

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/* ------------------------------------------------------------------ *
 * Blocks
 *
 * A template returns an array of these. Anything not in this list cannot be
 * rendered, which is the point: the shape of a Whollar email is a decision
 * made once here, not eight times in eight template files.
 * ------------------------------------------------------------------ */

const B = Object.freeze({
  /** The one sentence that says what happened. Every email has exactly one. */
  hero: (text) => ({ t: 'hero', text }),
  /** A short paragraph. */
  para: (text) => ({ t: 'para', text }),
  /** A quieter paragraph: context, not the news. */
  soft: (text) => ({ t: 'soft', text }),
  /** The single action. One per email, or none. */
  action: (label, url, deadline) => ({ t: 'action', label, url, deadline: deadline || null }),
  /** A bare link where a button would be too loud. */
  link: (label, url) => ({ t: 'link', label, url }),
  /** Label and value rows. */
  rows: (items) => ({ t: 'rows', items }),
  /** Bulleted list. */
  list: (items) => ({ t: 'list', items }),
  /** A one-time code. Large, selectable, and present in the text part. */
  code: (value) => ({ t: 'code', value }),
  /** Set off above the signature: a caution or a security note. */
  note: (text) => ({ t: 'note', text }),
  /** Same, in the warning colour. */
  alert: (text, url, label) => ({ t: 'alert', text, url: url || null, label: label || null }),
  /** A card, for an offer. `lines` are label/value pairs. */
  card: (title, subtitle, lines, badge) => ({ t: 'card', title, subtitle: subtitle || null,
    lines: lines || [], badge: badge || null }),
  /** A horizontal rule. */
  rule: () => ({ t: 'rule' }),
});

/* ------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------ */

function htmlBlock(b, p) {
  const cell = (inner, style) => `<tr><td style="background:${p.card};${style || ''}">${inner}</td></tr>`;
  const base = `font-family:${FONT};`;

  switch (b.t) {
    case 'hero':
      return cell(escapeHtml(b.text),
        `${base}padding:0 0 14px;font-size:19px;line-height:1.35;font-weight:700;color:${p.ink}`);
    case 'para':
      return cell(escapeHtml(b.text),
        `${base}padding:0 0 16px;font-size:15px;line-height:1.55;color:${p.ink}`);
    case 'soft':
      return cell(escapeHtml(b.text),
        `${base}padding:0 0 16px;font-size:14px;line-height:1.55;color:${p.soft}`);
    case 'note':
      return cell(escapeHtml(b.text),
        `${base}padding:16px 0 0;margin-top:4px;border-top:1px solid ${p.rule};font-size:13px;line-height:1.55;color:${p.faint}`);
    case 'alert': {
      const link = b.url && b.label
        ? ` <a href="${escapeHtml(b.url)}" style="color:${p.warn};text-decoration:underline">${escapeHtml(b.label)}</a>`
        : '';
      return cell(escapeHtml(b.text) + link,
        `${base}padding:16px 0 0;border-top:1px solid ${p.rule};font-size:14px;line-height:1.55;color:${p.warn}`);
    }
    case 'code':
      return cell(escapeHtml(b.value),
        `padding:4px 0 16px;font-family:${MONO};font-size:32px;line-height:1.2;font-weight:700;letter-spacing:.16em;color:${p.ink}`);
    case 'link':
      return cell(
        `<a href="${escapeHtml(b.url)}" style="${base}font-size:15px;line-height:1.5;color:${p.link};text-decoration:underline">${escapeHtml(b.label)}</a>`,
        'padding:0 0 16px');
    case 'action': {
      /* A table, not a padded anchor: Outlook ignores padding on an inline
         element, which collapses the button to bare underlined text. */
      const btn = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
        + `<td style="background:${p.accent};border-radius:8px">`
        + `<a href="${escapeHtml(b.url)}" style="${base}display:inline-block;padding:12px 22px;`
        + `font-size:15px;font-weight:700;line-height:1;color:#FFFFFF;text-decoration:none">`
        + `${escapeHtml(b.label)}</a></td></tr></table>`;
      const by = b.deadline
        ? `<div style="${base}padding-top:10px;font-size:13px;line-height:1.5;color:${p.faint}">${escapeHtml(b.deadline)}</div>`
        : '';
      return cell(btn + by, 'padding:2px 0 20px');
    }
    case 'rows': {
      const rows = b.items.map(([k, v]) =>
        `<tr><td style="background:${p.card};${base}padding:7px 0;font-size:13px;line-height:1.4;color:${p.faint};white-space:nowrap">${escapeHtml(k)}</td>`
        + `<td style="background:${p.card};${base}padding:7px 0 7px 16px;font-size:14px;line-height:1.4;color:${p.ink};text-align:right">${escapeHtml(v)}</td></tr>`
      ).join('');
      return cell(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid ${p.rule};border-bottom:1px solid ${p.rule}">${rows}</table>`,
        'padding:0 0 18px');
    }
    case 'list':
      return cell(
        `<ul style="${base}margin:0;padding-left:20px;font-size:14px;line-height:1.7;color:${p.soft}">`
        + b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('') + '</ul>',
        'padding:0 0 18px');
    case 'card': {
      const badge = b.badge
        ? `<span style="${base}display:inline-block;padding:3px 9px;border-radius:999px;background:${p.accent};font-size:11px;font-weight:700;color:#FFFFFF">${escapeHtml(b.badge)}</span>`
        : '';
      const lines = b.lines.map(([k, v]) =>
        `<tr><td style="background:${p.chip};${base}padding:5px 0;font-size:13px;line-height:1.4;color:${p.faint}">${escapeHtml(k)}</td>`
        + `<td style="background:${p.chip};${base}padding:5px 0 5px 14px;font-size:14px;line-height:1.4;font-weight:700;color:${p.ink};text-align:right">${escapeHtml(v)}</td></tr>`
      ).join('');
      return cell(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${p.chip};border-radius:10px">`
        + `<tr><td style="background:${p.chip};padding:16px 16px 4px">`
        + `<div style="${base}font-size:15px;font-weight:700;line-height:1.3;color:${p.ink}">${escapeHtml(b.title)} ${badge}</div>`
        + (b.subtitle ? `<div style="${base}padding-top:3px;font-size:13px;line-height:1.4;color:${p.faint}">${escapeHtml(b.subtitle)}</div>` : '')
        + `</td></tr><tr><td style="background:${p.chip};padding:6px 16px 14px">`
        + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${lines}</table>`
        + '</td></tr></table>',
        'padding:0 0 14px');
    }
    case 'rule':
      return cell(`<div style="height:1px;background:${p.rule};line-height:1px;font-size:0">&nbsp;</div>`,
        'padding:2px 0 18px');
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ *
 * Plain text
 *
 * Rendered from the same blocks, and it has to read as a complete message on
 * its own. A URL is printed in full: a text part that says "click here" is a
 * text part nobody can act on.
 * ------------------------------------------------------------------ */

function textBlock(b) {
  switch (b.t) {
    case 'hero':  return b.text;
    case 'para':  return b.text;
    case 'soft':  return b.text;
    case 'note':  return b.text;
    case 'alert': return b.url && b.label ? `${b.text} ${b.label}: ${b.url}` : b.text;
    case 'code':  return b.value;
    case 'link':  return `${b.label}: ${b.url}`;
    case 'action':
      return b.deadline ? `${b.label}: ${b.url}\n${b.deadline}` : `${b.label}: ${b.url}`;
    case 'rows':  return b.items.map(([k, v]) => `${k}: ${v}`).join('\n');
    case 'list':  return b.items.map((i) => `· ${i}`).join('\n');
    case 'card': {
      const head = b.badge ? `${b.title} (${b.badge})` : b.title;
      return [head, b.subtitle || null]
        .concat(b.lines.map(([k, v]) => `  ${k}: ${v}`))
        .filter(Boolean).join('\n');
    }
    case 'rule':  return '---';
    default:      return '';
  }
}

/* ------------------------------------------------------------------ *
 * The footer
 * ------------------------------------------------------------------ */

/**
 * Sender identification, the address, why this arrived, and the way out.
 *
 * `unsubscribeUrl` is present only for a commercial electronic message.
 * `preferencesUrl` is present on both, always: CASL does not require an
 * opt-out on transactional mail, and that is not a reason to hide the place
 * where the choices live.
 *
 * `postalAddress` comes from configuration and has no fallback. An invented
 * address in a compliance footer is worse than a missing one, so a cem send
 * with no address configured is refused upstream rather than sent with a
 * plausible-looking placeholder.
 */
function footerBlocks({ legalName, postalAddress, contactEmail, whyLine,
                        unsubscribeUrl, preferencesUrl, calendarUrl }) {
  const lines = [];
  if (whyLine) lines.push(whyLine);
  lines.push(`${legalName}${postalAddress ? `, ${postalAddress}` : ''}`);
  if (contactEmail) lines.push(contactEmail);
  return { lines, unsubscribeUrl, preferencesUrl, calendarUrl };
}

function footerHtml(f, p) {
  const base = `font-family:${FONT};`;
  const linkStyle = `color:${p.faint};text-decoration:underline`;
  const links = [];
  if (f.preferencesUrl) links.push(`<a href="${escapeHtml(f.preferencesUrl)}" style="${linkStyle}">Notification settings</a>`);
  if (f.unsubscribeUrl) links.push(`<a href="${escapeHtml(f.unsubscribeUrl)}" style="${linkStyle}">Unsubscribe</a>`);
  if (f.calendarUrl) links.push(`<a href="${escapeHtml(f.calendarUrl)}" style="${linkStyle}">Add Whollar dates to your calendar</a>`);

  return `<tr><td style="background:${p.ground};${base}padding:22px 28px 6px;`
    + `font-size:12px;line-height:1.6;color:${p.faint}">`
    + f.lines.map((l) => escapeHtml(l)).join('<br>')
    + (links.length ? `<br><br>${links.join(' &nbsp;&middot;&nbsp; ')}` : '')
    + '</td></tr>';
}

function footerText(f) {
  const links = [];
  if (f.preferencesUrl) links.push(`Notification settings: ${f.preferencesUrl}`);
  if (f.unsubscribeUrl) links.push(`Unsubscribe: ${f.unsubscribeUrl}`);
  if (f.calendarUrl) links.push(`Add Whollar dates to your calendar: ${f.calendarUrl}`);
  return f.lines.concat(links.length ? [''] : [], links).join('\n');
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

/**
 * Blocks plus a footer, as one message.
 *
 * The preheader is the text a client shows beside the subject in the list
 * view. Left out, the client takes the first words of the body, which for a
 * card layout is often the alt text of the logo. It is hidden twice over:
 * zero-height with `display:none` for the clients that honour it, and padded
 * with a run of zero-width non-joiners so the ones that ignore `display:none`
 * do not spill the following sentence into the preview.
 */
function assemble({ audience, subject, preheader, blocks, footer, greeting }) {
  const p = PALETTE[audience] || PALETTE.member;
  const base = `font-family:${FONT};`;
  const body = (greeting ? [B.para(greeting)] : []).concat(blocks);

  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">`
      + escapeHtml(preheader) + '‌ '.repeat(60) + '</div>'
    : '';

  const html = `<!doctype html><html lang="en"><head>`
    + `<meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="color-scheme" content="light">`
    + `<meta name="supported-color-schemes" content="light">`
    + `<title>${escapeHtml(subject)}</title>`
    + `</head>`
    + `<body style="margin:0;padding:0;background:${p.ground};${base}color:${p.ink}">`
    + pre
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${p.ground}">`
    + `<tr><td align="center" style="background:${p.ground};padding:24px 12px">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px">`
    + `<tr><td style="background:${p.ground};padding:0 28px 14px">`
    + `<img src="${LOGO_URL}" width="36" height="36" alt="Whollar" style="display:block;border:0;width:36px;height:36px">`
    + `</td></tr>`
    + `<tr><td style="background:${p.ground};padding:0">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${p.card};border-radius:14px">`
    + `<tr><td style="background:${p.card};padding:28px 28px 12px">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">`
    + body.map((b) => htmlBlock(b, p)).join('')
    + `</table></td></tr></table></td></tr>`
    + footerHtml(footer, p)
    + `</table></td></tr></table></body></html>`;

  /* The same block list, so the text part is a rendering rather than a
     stripped copy. Blank line between blocks, and the footer last. */
  const text = body
    .map(textBlock)
    .filter(Boolean)
    .join('\n\n')
    .concat('\n\n', footerText(footer))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { subject, preheader: preheader || null, html, text };
}

module.exports = {
  B, PALETTE, FONT, LOGO_URL, escapeHtml,
  assemble, footerBlocks, htmlBlock, textBlock,
};
