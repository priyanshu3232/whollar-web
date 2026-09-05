'use strict';

/**
 * The template registry: metadata and copy, in code.
 *
 * WHY NOT A TABLE. The Phase 0 brief proposed `notification_templates` as a
 * Data Store row per template, with the body in a column. The argument for
 * rendering locally rather than in ZeptoMail is that version control, the
 * em-dash gate, the vocabulary gate, the privacy scrubber and plain-text
 * generation all have to run before the body leaves the platform. Every one
 * of those is a property of code in the repository. A body in a hand-created
 * table is a body outside CI, outside code review, and outside
 * scripts/check-notify-copy.mjs, which is the same failure the local-render
 * decision was made to avoid. So: modules, a manifest, and site_config for
 * the rare value that must move without a deploy.
 *
 * WHAT AN ENTRY OWES.
 *   key        stable, dotted, audience first
 *   audience   member | partner | admin | auto (auto takes the recipient's)
 *   casl       transactional | cem. A cem may not send without consent, an
 *              unsubscribe link and a postal address.
 *   priority   security | action_required | informational | reminder.
 *              `security` sends inline rather than waiting for the drain: a
 *              member is standing at a login form.
 *   category   the preference category this belongs to (see prefs below)
 *   required   context keys. A missing one fails the row, never sends a blank.
 *   collapse   group name, or null. Only informational and reminder collapse.
 *   render     (ctx, h) -> { subject, preheader, greeting, blocks }
 *
 * LOCALE. Every entry is a map of locale to render function. English exists
 * today; `fr` slots are absent rather than aliased to English, so a French
 * recipient falls back to `en` visibly and the gallery shows the gap instead
 * of presenting English as though it were French.
 */

const { B } = require('./layout');

/* ------------------------------------------------------------------ *
 * Preference categories
 * ------------------------------------------------------------------ */

/**
 * `locked` categories have no off switch. Security and account mail is how a
 * person keeps control of their account, and campaign steps are the service
 * the household signed up for; an opt-out there is an opt-out of being told
 * their own offer arrived.
 *
 * The dashboard toggle labelled "campaign steps" therefore governs the SMS
 * channel once one exists, and the copy has to say so. It currently promises
 * a text nothing sends.
 */
const CATEGORIES = Object.freeze({
  security:         { locked: true,  casl: 'transactional', label: 'Security' },
  account:          { locked: true,  casl: 'transactional', label: 'Account' },
  campaign_steps:   { locked: true,  casl: 'transactional', label: 'Campaign steps' },
  referrals:        { locked: false, casl: 'transactional', label: 'Referrals' },
  promo_cliff:      { locked: false, casl: 'transactional', label: 'Promo cliff reminders' },
  outage:           { locked: false, casl: 'transactional', label: 'Outage updates' },
  delivery:         { locked: true,  casl: 'transactional', label: 'Install and delivery' },
  /* A partner's own bids and results. Locked, because a partner who could
     switch off "you won a tier" would have households confirming against a
     partner that does not know it owes them an install. */
  bidding:          { locked: true,  casl: 'transactional', label: 'Bids and results' },
  billing:          { locked: true,  casl: 'transactional', label: 'Billing' },
  region_openings:  { locked: false, casl: 'cem',           label: 'New region openings' },
  product_interest: { locked: false, casl: 'cem',           label: 'Product updates' },
});

const PRIORITIES = Object.freeze(['security', 'action_required', 'informational', 'reminder']);
const COLLAPSIBLE = Object.freeze(['informational', 'reminder']);

/* ------------------------------------------------------------------ *
 * Render helpers handed to every template
 * ------------------------------------------------------------------ */

/**
 * Money. Cents in, formatted out, and never re-derived: the value on a card
 * is the seal's own, carried as an integer so no rounding happens twice.
 */
function money(cents, locale) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA',
      { style: 'currency', currency: 'CAD' }).format(n / 100);
  } catch {
    return `$${(n / 100).toFixed(2)}`;
  }
}

/**
 * "Tue 14 Oct, 9:00 a.m. ET". UTC in, recipient timezone out, zone named once
 * so nobody has to guess. A raw UTC timestamp in a security email reads as
 * "was that me?", which is the one question the line exists to answer.
 */
function when(value, timezone, locale) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const tz = timezone || 'America/Toronto';
  try {
    const s = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', timeZone: tz,
    }).format(d);
    return `${s} ${zoneAbbr(tz, d)}`;
  } catch {
    return d.toISOString();
  }
}

/** Date only, for a deadline that is a day rather than a moment. */
function day(value, timezone, locale) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
      weekday: 'short', day: 'numeric', month: 'long',
      timeZone: timezone || 'America/Toronto',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** ET, PT, and so on. Falls back to the IANA name rather than inventing one. */
function zoneAbbr(tz, d) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA',
      { timeZone: tz, timeZoneName: 'short' }).formatToParts(d);
    const name = parts.find((x) => x.type === 'timeZoneName');
    return name ? name.value : tz;
  } catch {
    return tz;
  }
}

/**
 * "Hi Sam," when a name is on file, "Hi," when it is not.
 *
 * The name passes through user input at signup, so it is flattened and capped
 * rather than trusted: escaping protects the HTML, this protects the text
 * part, and both protect the reader from a two hundred character "name".
 */
function greet(firstName) {
  const name = String(firstName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name ? `Hi ${name},` : 'Hi,';
}

const helpers = (locale, timezone) => ({
  money: (c) => money(c, locale),
  when: (v) => when(v, timezone, locale),
  day: (v) => day(v, timezone, locale),
  greet,
  B,
});

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

const MODULES = [
  require('./templates/account'),
  require('./templates/campaign'),
  require('./templates/member'),
  require('./templates/partner'),
  require('./templates/reminders'),
  require('./templates/marketing'),
];

const TEMPLATES = new Map();

for (const mod of MODULES) {
  for (const entry of mod) {
    if (TEMPLATES.has(entry.key)) {
      throw new Error(`notify: duplicate template key ${entry.key}`);
    }
    validate(entry);
    TEMPLATES.set(entry.key, Object.freeze(entry));
  }
}

/** Fail at require time, not at send time. A bad entry is a deploy problem. */
function validate(e) {
  const bad = (why) => { throw new Error(`notify template ${e.key || '(no key)'}: ${why}`); };
  if (!e.key || !/^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(e.key)) bad('key must be dotted lowercase');
  if (!['member', 'partner', 'admin', 'auto'].includes(e.audience)) bad('bad audience');
  if (!CATEGORIES[e.category]) bad(`unknown category ${e.category}`);
  if (!PRIORITIES.includes(e.priority)) bad(`unknown priority ${e.priority}`);
  if (!['transactional', 'cem'].includes(e.casl)) bad('bad casl class');
  if (e.casl !== CATEGORIES[e.category].casl) {
    bad(`casl ${e.casl} disagrees with category ${e.category} (${CATEGORIES[e.category].casl})`);
  }
  if (e.collapse && !COLLAPSIBLE.includes(e.priority)) {
    bad('only informational and reminder may collapse');
  }
  if (!Array.isArray(e.required)) bad('required must be an array');
  if (!e.locales || typeof e.locales.en !== 'function') bad('needs an en render function');
  if (e.collapse && !['digest', 'supersede'].includes(e.collapseMode || 'digest')) {
    bad('collapseMode must be digest or supersede');
  }
  /* A template with no fixture is a template scripts/check-notify-copy.mjs
     cannot render, and an unrenderable template is unchecked copy. */
  if (!fixturesOf(e).length) bad('needs a fixture or fixtures');
}

/** Every context this template should be rendered against by the gate. */
function fixturesOf(entry) {
  if (Array.isArray(entry.fixtures)) return entry.fixtures;
  return entry.fixture ? [entry.fixture] : [];
}

/* ------------------------------------------------------------------ *
 * Lookup and render
 * ------------------------------------------------------------------ */

const get = (key) => TEMPLATES.get(key) || null;
const keys = () => Array.from(TEMPLATES.keys()).sort();
const all = () => Array.from(TEMPLATES.values());

/**
 * Which required keys the context does not carry.
 *
 * Fails closed by design: a template that needs `decide_by_at` and does not
 * get it must not send "decide by " with nothing after it. The outbox row
 * goes to `failed` with the missing key named, and an operator can see
 * exactly which one.
 */
function missing(entry, ctx) {
  const out = [];
  for (const k of entry.required) {
    const v = ctx ? ctx[k] : undefined;
    if (v === undefined || v === null || v === '') out.push(k);
  }
  return out;
}

/**
 * Render one template. Returns { subject, preheader, greeting, blocks },
 * still blocks: the layout turns them into HTML and text, and the scrubber
 * runs between the two.
 */
function render(entry, ctx, { locale = 'en', timezone = 'America/Toronto' } = {}) {
  const fn = entry.locales[locale] || entry.locales.en;
  const used = entry.locales[locale] ? locale : 'en';
  const out = fn(ctx, helpers(used, timezone));
  if (!out || !out.subject || !Array.isArray(out.blocks)) {
    throw new Error(`notify template ${entry.key}: render returned no subject or blocks`);
  }
  return { ...out, locale: used };
}

module.exports = {
  CATEGORIES, PRIORITIES, COLLAPSIBLE,
  get, keys, all, missing, render, helpers, fixturesOf,
  money, when, day, greet,
};
