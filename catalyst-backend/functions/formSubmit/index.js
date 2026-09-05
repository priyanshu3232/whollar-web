'use strict';

const catalyst = require('zcatalyst-sdk-node');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const crypto = require('node:crypto');

const app = express();

/* ------------------------------------------------------------------ *
 * CONFIG: edit these two after your first deploy, then redeploy.
 * ------------------------------------------------------------------ */

// Domains allowed to call this function from a browser. Add every host
// the site is actually served from (apex + www + local dev if needed).
//
// The staging alias is the review link every pre-merge change is looked at on,
// and it is deployed from a personal Vercel account, so it matches neither the
// live domains nor isVercelOrigin's whollar-web pattern below. Without it every
// form on the review build failed the same way, a blocked fetch, which the
// frontend can only report as "we couldn't reach our servers", so changes read
// as broken during exactly the step meant to approve them. Listed as an exact
// host, not a pattern: the auth function's own allowlist carries this same
// origin (Catalyst env var, added 2026-08-06), and these three lists are only
// safe while they agree.
const ALLOWED_ORIGINS = [
  'https://whollar.com',
  'https://www.whollar.com',
  'https://whollar.ca',
  'https://www.whollar.ca',
  // The product host since the September 2026 restructure. Express answers CORS
  // for it until the console rule is widened; see GATEWAY_CORS_ORIGINS.
  'https://internet.whollar.ca',
  // The winter tire vertical, same treatment as the product host above:
  // Express answers CORS for it because the console rule does not name it yet.
  'https://tires.whollar.ca',
  // The .com twins. The cutover runbook has these becoming redirect domains,
  // at which point no request originates from them and these two lines come
  // out. They are here because that has not happened: tires.whollar.ca has no
  // DNS record yet, so tires.whollar.com is the ONLY way to reach the tire
  // site, and every form on it was failing CORS for want of these lines.
  'https://internet.whollar.com',
  'https://tires.whollar.com',
  'https://whollar-staging-1w.vercel.app',
  // The other two review aliases on the same personal Vercel account, added
  // 2026-09-05 for the same reason the staging one is here. Without them the
  // tire preview's sign-up posted and the browser threw the response away for
  // want of a CORS header, which the page can only report as "Failed to fetch"
  // while the row was never written. The three hosts are reviewed on three
  // aliases now, so all three belong on this list.
  'https://whollar-tires-1w.vercel.app',
  'https://whollar-home-1w.vercel.app'
];

// Origins the Catalyst gateway (ZGS) already answers for, and where Express
// must therefore stay quiet. A CORS rule was added in the Catalyst console on
// 2026-08-06; since then the gateway sets its own Access-Control-Allow-Origin
// on the way out, for the origins listed there and no others.
//
// Two Access-Control-Allow-Origin headers on one response do not combine. The
// browser rejects the response outright, fetch rejects with a TypeError, and
// the page can only report "we couldn't reach our servers", even though the
// request itself succeeded and the row is already written. That is the exact
// shape of the bug this list exists to prevent, and it fired on the live site
// only: the gateway rule holds one origin, so every other origin in the lists
// above reached the browser with Express's single header and was unaffected.
//
// This is console config mirrored into code, so the two are only safe while
// they agree, the same standing caveat as the allowlist above. Check either
// side with:
//   curl -sD- -o/dev/null -X POST -H 'Origin: https://www.whollar.ca' \
//     <function-url> | grep -i access-control-allow-origin
// Exactly one line back is the passing result. If the console rule is ever
// removed, empty this list in the same change and Express resumes the header.
// NOT YET https://internet.whollar.ca. Adding it here before the console rule
// names it would silence Express for an origin the gateway does not answer,
// and every form on the product host would fail CORS. The runbook's owner step
// widens the console rule first; this list follows in the same change.
// MEASURED TWICE ON 2026-09-04, and it changed between the two readings.
//
// Before the deploy the documented curl returned ZERO header lines for
// https://www.whollar.ca: this list was silencing Express, and the console
// rule was not answering, so the umbrella's forms reached the browser with no
// CORS header at all. On that evidence the origin was taken out of this list.
//
// Immediately after the deploy the same curl returned TWO, five times out of
// five: one capitalised from the gateway, one lowercase from Express. So the
// console rule answers again. It was restored, or re-enabled, in the console
// between the readings.
//
// Two headers is the worse failure of the two, and it is the one this list
// exists to prevent. The origin goes back in.
//
// THE STANDING TRAP, stated once more because it has now fired in both
// directions: this is console config mirrored into code, and each side is
// invisible from the other. Turning the console rule on breaks the site unless
// the origin is in this list; turning it off breaks the site unless the origin
// is out of it. Neither change announces itself. Run the curl after touching
// either side, and read the count, not just the value:
//   curl -sD- -o/dev/null -X POST -H 'Origin: https://www.whollar.ca' \
//     <function-url> | grep -ci access-control-allow-origin
// One is the passing result. Zero and two both mean every form on that origin
// is failing in the browser while the row is written on this side.
const GATEWAY_CORS_ORIGINS = ['https://www.whollar.ca'];

// Local development: the marketing pages are plain HTML files, opened either
// via a dev server on an arbitrary port (Live Server, http.server, …) or
// straight from disk (Origin: null). CORS is a browser-side gate only, the
// endpoint is reachable by curl regardless, so allowing these loses nothing.
const isDevOrigin = (origin) =>
  origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

// Vercel: only this project's own production + preview deploys, not the whole
// *.vercel.app suffix (which would let any attacker-hosted Vercel page drive
// browser requests at this backend). Preview URLs look like
// whollar-web-<hash>-<team>.vercel.app / whollar-web-git-<branch>-…
const isVercelOrigin = (origin) =>
  /^https:\/\/whollar-web[a-z0-9-]*\.vercel\.app$/.test(origin);

// Dev origins (localhost / Origin:null) are allowed only when this function is
// NOT running on its production Catalyst domain, so the live prod backend never
// reflects them. Detection is automatic from the request host, the prod domain
// is *.catalystserverless.ca without the `.development.` segment, with an
// optional CATALYST_ENV=production override.
const isProdRequest = (req) => {
  if (process.env.CATALYST_ENV === 'production') return true;
  const host = req.headers.host || '';
  return /catalystserverless/.test(host) && !/\.development\./.test(host);
};

// File Store folder ID that uploaded bills / deep-read attachments are
// saved into. Create a folder in the Catalyst console (File Store →
// New Folder) and paste its numeric ID here. Until this is set, file
// uploads are skipped (the rest of the submission still saves fine).
const UPLOADS_FOLDER_ID = '1258000000015979';

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowDev = !isProdRequest(req);
  const gatewayAnswers = GATEWAY_CORS_ORIGINS.includes(origin);
  if (origin && !gatewayAnswers && (ALLOWED_ORIGINS.includes(origin) || (allowDev && isDevOrigin(origin)) || isVercelOrigin(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Also parse text/plain as JSON: the Catalyst gateway answers CORS preflight
// (OPTIONS) itself with no CORS headers, so browser requests must stay
// preflight-free: the frontend posts JSON with a text/plain content type
// (CORS-safelisted) instead of application/json.
app.use(express.json({ limit: '1mb', type: ['application/json', 'text/plain'] }));

/* ------------------------------------------------------------------ *
 * Abuse controls: distributed rate limiting via Catalyst Cache.
 * Advanced I/O functions are horizontally scaled with no shared process
 * memory, so an in-process counter is useless; the Cache default segment
 * is shared across every instance. Fixed-window counters keyed by route
 * (+ client IP). Fails OPEN if the cache is unreachable: a broken limiter
 * must not take the forms down.
 * ------------------------------------------------------------------ */

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress || 'unknown';

async function withinLimit(req, { key, max, windowSec, perIp = true }) {
  try {
    const catalystApp = catalyst.initialize(req);
    const seg = catalystApp.cache().segment(); // default segment: no console setup needed
    const window = Math.floor(Date.now() / (windowSec * 1000));
    const bucket = perIp ? `rl:${key}:${clientIp(req)}:${window}` : `rl:${key}:${window}`;
    const ttlHours = Math.max(1, Math.ceil(windowSec / 3600));

    let count = 0;
    try { count = parseInt(await seg.getValue(bucket), 10) || 0; } catch { count = 0; }
    if (count >= max) return false;

    const next = String(count + 1);
    try { await seg.put(bucket, next, ttlHours); }
    catch { try { await seg.update(bucket, next, ttlHours); } catch { /* best effort */ } }
    return true;
  } catch {
    return true; // fail open
  }
}

// Express middleware: reject over-limit requests with 429 before the body is
// parsed, so an abusive upload never touches disk or the Data Store.
const limit = (opts) => async (req, res, next) => {
  if (await withinLimit(req, opts)) return next();
  res.setHeader('Retry-After', String(opts.windowSec));
  res.status(429).json({ ok: false, error: 'Too many requests. Please slow down and try again shortly.' });
};

// HEIC/HEIF is the iPhone camera default, so it is the single most likely
// upload from the households this site is for. The bill reader cannot parse it
// (the Claude vision API takes JPEG/PNG/GIF/WebP only, which is why billOcr's
// list is shorter), but there is no reason to refuse to STORE it: a person
// can open it later. Accept it here; the frontend skips the OCR call for it.
const ACCEPTED_UPLOAD_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'
]);

// Reject anything that isn't a bill (PDF/image) server-side: the frontend's
// accept="…" hint is trivially bypassed, and the File Store must not become
// free hosting for arbitrary uploads.
const rejectUnsupported = (req, file, cb) => {
  if (ACCEPTED_UPLOAD_TYPES.has((file.mimetype || '').toLowerCase())) return cb(null, true);
  const err = new Error('UNSUPPORTED_FILE_TYPE');
  err.code = 'UNSUPPORTED_FILE_TYPE';
  cb(err);
};

// Wrap a multer middleware so size/type/count rejections become clean 4xx JSON
// instead of a 500 or a silently dropped file.
const guardUpload = (mw) => (req, res, next) => mw(req, res, (err) => {
  if (!err) return next();
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  const tooMany = err.code === 'LIMIT_FILE_COUNT';
  const status = tooBig || tooMany ? 413 : 415;
  const msg = tooBig ? 'File too large.'
    : tooMany ? 'Too many files.'
    : 'Unsupported file type. Upload a PDF or an image.';
  res.status(status).json({ ok: false, error: msg });
});

// Single-file convenience attachments (/waitlist-details, /bill-checkup-join):
// the bill is a nice-to-have, the lead is not. A rejected file must not sink
// the submission: swallow the multer error, note why, and save the row bare.
// (The frontend appends text fields before the file, so req.body is already
// fully populated when a file-level rejection aborts the multipart parse.)
const tolerantUpload = (mw) => (req, res, next) => mw(req, res, (err) => {
  if (!err) return next();
  req.fileRejected = err.code === 'LIMIT_FILE_SIZE' ? 'too large'
    : err.code === 'UNSUPPORTED_FILE_TYPE' ? 'unsupported type'
    : err.code === 'LIMIT_FILE_COUNT' ? 'too many files'
    : 'upload error';
  console.error(`[formSubmit] attachment dropped (${req.fileRejected}) on ${req.path}`);
  req.file = undefined;
  next();
});

// Remove multer temp files when a request is rejected before the route runs
// its own storeFile/finally cleanup (validation 400s): /tmp on a warm
// instance must not accumulate orphans.
const discardUpload = (req) => {
  [req.file, ...(req.files || [])].filter(Boolean).forEach(f => fs.unlink(f.path, () => {}));
};

// Disk storage (not memory): the Catalyst SDK's uploadFile() appends the
// stream to form-data with no options, so it relies on the stream's `.path`
// to derive the filename, which only an fs.ReadStream has, not a Buffer.
const upload = multer({
  dest: '/tmp/whollar-uploads/',
  limits: { fileSize: 20 * 1024 * 1024, files: 5 },
  fileFilter: rejectUnsupported
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Keep byte-identical to WHOLLAR.EMAIL_RE in js/whollar-core.js. The pages used
// to carry a looser variant that accepted "a@b.c" and produced a 400 here.
const isEmail = v => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim());
const str = v => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
const orNull = v => (v === '' || v == null ? null : v);
const digits = v => str(v).replace(/\D/g, '');
const toNumber = v => {
  const n = parseFloat(str(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const json = v => JSON.stringify(v ?? null);
// Catalyst DateTime columns expect "YYYY-MM-DD HH:MM:SS" (UTC), not ISO 8601.
const catalystNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/* ---- The join page's "do you have any of these too?" list ----
 *
 * It arrives in two shapes and used to survive only one. With a bill attached
 * the request is multipart and submitForm() JSON-encodes every object field;
 * without one it is application/json and express.json has ALREADY parsed the
 * list into a real array. JSON.parse(array) stringifies its argument to
 * "[object Object]" and throws, so every submission without an attachment
 * stored an empty list: silently, because the throw was swallowed.
 */
const parseServices = v => {
  if (Array.isArray(v)) return v;
  const s = str(v);
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Keep in step with the data-svc keys in waitlist/index.html.
const SERVICE_LABELS = {
  ott: 'OTT / streaming channels',
  tv: 'TV plan',
  security: 'Home security',
  mobile: 'Cell phone plans',
  doorbell: 'Video doorbells',
  other: 'Something else'
};

/* One readable line for the CRM: "TV plan, Cell phone plans x3, Something else
 * (garage camera)". The rows are objects ({service, count, detail}), so the
 * old services.join(', ') handed sales "[object Object], [object Object]".
 * Bare strings are still accepted: older payloads sent them, and the Services
 * column holds whatever shape was current when the row was written. */
const servicesForCrm = list => (Array.isArray(list) ? list : [])
  .map(item => {
    if (typeof item === 'string') return SERVICE_LABELS[item] || str(item);
    if (!item || typeof item !== 'object') return '';
    const key = str(item.service);
    const label = SERVICE_LABELS[key] || key;
    if (!label) return '';
    const count = Number(item.count);
    const detail = str(item.detail);
    return label
      + (Number.isFinite(count) && count > 1 ? ` x${count}` : '')
      + (detail ? ` (${detail.slice(0, 80)})` : '');
  })
  .filter(Boolean)
  .join(', ');

/* ------------------------------------------------------------------ *
 * Canonical formats
 * ------------------------------------------------------------------
 * One concept, one shape. Before this, a postal code reached the CRM in four
 * different forms depending on the route: "M5V 3A8" from the calculator, the
 * bare FSA "M5V" from the checkup, and (within the same deep-read handler)
 * both an uppercased and a raw-case copy of the same value. That silently
 * fragments the dataset: you cannot join estimates to checkups on geography.
 * ------------------------------------------------------------------ */

// Canada Post never uses D, F, I, O, Q, U anywhere, nor W or Z as the first
// letter. Same rule as WHOLLAR.parsePostal on the frontend.
const PC_RE = /^[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVWXYZ]\d[ABCEGHJKLMNPRSTVWXYZ]\d$/;
const FSA_RE = /^[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVWXYZ]$/;

// Always "A1A 1A1" (full) or "A1A" (FSA only), uppercase, single space.
// Returns { fsa, full } with nulls when the input isn't a real Canadian code.
function normalizePostal(v) {
  const s = str(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fsa = s.slice(0, 3);
  if (!FSA_RE.test(fsa)) return { fsa: null, full: null };
  const full = s.length === 6 && PC_RE.test(s) ? `${fsa} ${s.slice(3)}` : null;
  return { fsa, full };
}

// E.164 for Canada. "5551234567" and "15551234567" are the same subscriber but
// were stored as two different strings, so the CRM saw two people.
function normalizePhone(v) {
  const d = digits(v);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

// Lowercased email is the join key everywhere. Zoho's
// (Email:equals:…) search is not reliably case-insensitive, so
// Genie@x.com and genie@x.com would otherwise create two Leads.
const emailKey = v => str(v).toLowerCase();

/* CASL: consent must be provable: what was agreed, when, and where. The
 * frontend sends these; they travel in the CRM payload (which is a free-form
 * JSON column) rather than as new Data Store columns, because adding a column
 * that does not exist in the console makes insertRow fail outright.
 * To persist them as first-class columns, create them in the Catalyst console
 * and add them to the row objects below. */
function consentFrom(b, req) {
  const granted = str(b.consentGranted) === 'true' || b.consentGranted === true;
  if (!granted) return { consentGranted: false };
  return {
    consentGranted: true,
    consentKind: str(b.consentKind) || null,
    consentText: str(b.consentText).slice(0, 500) || null,
    // Trust the server clock, not the browser's, for the record of when.
    consentAt: new Date().toISOString(),
    consentClientAt: str(b.consentAt) || null,
    consentSource: str(b.consentSource) || null,
    // CASL guidance is to keep the requesting IP as part of the consent record.
    consentIp: clientIp(req)
  };
}

function badRequest(res, message) {
  return res.status(400).json({ ok: false, error: message });
}

function serverError(res, err, context) {
  console.error(`[formSubmit] ${context} failed:`, err);
  return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
}

// Uploads one multer disk file to Catalyst File Store and returns
// { id, name }, or null if no folder is configured / the file is absent.
// The multer temp file is always removed, upload success or not.
async function storeFile(catalystApp, file) {
  if (!file || !UPLOADS_FOLDER_ID) {
    if (file) fs.unlink(file.path, () => {});
    return null;
  }
  try {
    const folder = catalystApp.filestore().folder(Number(UPLOADS_FOLDER_ID));
    const uploaded = await folder.uploadFile({
      code: fs.createReadStream(file.path),
      name: `${Date.now()}-${file.originalname}`.slice(0, 255)
    });
    const id = uploaded?.id ?? uploaded?.file_id ?? uploaded?.ID ?? null;
    return { id, name: file.originalname };
  } catch (err) {
    console.error('[formSubmit] file upload failed:', err);
    return null;
  } finally {
    fs.unlink(file.path, () => {});
  }
}

async function storeFiles(catalystApp, files) {
  if (!files || !files.length) return [];
  const stored = await Promise.all(files.map(f => storeFile(catalystApp, f)));
  return stored.filter(Boolean);
}

// The store's own spelling of every column, per table, so a row is written to
// the columns that exist rather than the columns the doc says should. The
// tables are created by hand and have drifted from create-tables.md in case
// alone more than once: CityRequests carries `province` where the code and
// section 37a say `Province`, and the Data Store rejects an unknown column at
// runtime, which serverError then hides, so one lower-case letter answered 500
// to every "Bring Whollar to your city" submission. A key that matches a live
// column exactly is used as it is; a key that matches one ignoring case is
// written to the live name, and the drift is logged once so it stays visible
// until the column is renamed; a key that matches nothing is passed through
// unchanged, so the store's own error still reaches insertTolerant and its
// optional groups. Names are cached per table for ten minutes and refreshed
// once when an insert fails, so a column added or renamed in the console is
// picked up without a redeploy.
const LIVE_COLUMNS_MS = 10 * 60 * 1000;
const liveColumns = new Map();
async function columnNames(catalystApp, tableName, refresh) {
  const hit = liveColumns.get(tableName);
  if (!refresh && hit && Date.now() - hit.at < LIVE_COLUMNS_MS) return hit.names;
  const cols = await catalystApp.datastore().table(tableName).getAllColumns();
  const names = (cols || []).map(c => c && c.column_name).filter(Boolean);
  // An empty list is not an answer, it is a read that told us nothing, and
  // caching it hands every insert on this table ten minutes of writing the
  // declared spelling. On a store that spells a column differently that is ten
  // minutes of 500s with no row saved, so leave the cache alone and re-read.
  if (!names.length) return names;
  liveColumns.set(tableName, { names, at: Date.now() });
  return names;
}
const driftLogged = new Set();
function toLiveColumns(tableName, row, names) {
  const byLower = new Map(names.map(n => [n.toLowerCase(), n]));
  const out = {};
  for (const key of Object.keys(row)) {
    const live = names.includes(key) ? key : (byLower.get(key.toLowerCase()) || key);
    if (live !== key && !driftLogged.has(`${tableName}.${key}`)) {
      driftLogged.add(`${tableName}.${key}`);
      console.error(`[formSubmit] ${tableName}: the store spells ${key} as ${live}; writing to the live name. ` +
        'Rename the column in the Catalyst console to match create-tables.md.');
    }
    out[live] = row[key];
  }
  return out;
}
async function insert(catalystApp, tableName, row) {
  const table = catalystApp.datastore().table(tableName);
  let names = null;
  try { names = await columnNames(catalystApp, tableName); } catch (err) {
    console.error(`[formSubmit] ${tableName}: could not read live columns, writing the row as declared:`, err);
  }
  // A read that returned nothing is as good as no read at all: fall through to
  // the retry below rather than trusting an empty list to map anything.
  if (names && !names.length) names = null;
  try {
    return await table.insertRow(names ? toLiveColumns(tableName, row, names) : row);
  } catch (err) {
    // The first attempt used a cached list, a stale one, or none at all, so ask
    // the store again before giving up. This retry used to be skipped entirely
    // when the first read had FAILED, which was the hole: a transient
    // getAllColumns() error sent the DECLARED spelling, and where the store
    // spells a column differently insertTolerant cannot recover, because
    // dropping optional columns never fixes the name of a mandatory one. That
    // cost /city-request a 500 with no row saved on 2026-09-05. The store's own
    // spelling is the fix for that, in the console; this retry is what keeps a
    // momentary read failure from losing a submission in the meantime.
    let fresh = null;
    try { fresh = await columnNames(catalystApp, tableName, true); } catch (e2) { /* the first error is the one to surface */ }
    const worthRetrying = fresh && fresh.length && !(names && fresh.join('\n') === names.join('\n'));
    if (!worthRetrying) throw err;
    return table.insertRow(toLiveColumns(tableName, row, fresh));
  }
}

// Same as insert(), but tolerant of named sets of columns not existing yet
// in the live table: a schema change routinely ships in code before the
// column is added by hand in the Catalyst console (see catalyst-backend/
// scripts/create-tables.md). Rather than fail the whole submission on a gap
// in optional columns, retry with them dropped, so the record is still
// captured; the original error is logged so the gap stays visible.
//
// `optional` is either a flat array (one group) or an array of arrays,
// NEWEST GROUP FIRST. Groups are dropped cumulatively: the first retry drops
// only the newest group, the next drops the next group too, and so on. The
// 2026-08-12 outage showed why: a single all-or-nothing strip meant one
// missing new column also discarded older optional columns that DID exist
// (ContractStartDate/ContractLength were lost to DiscountAmount's absence).
async function insertTolerant(catalystApp, tableName, row, optional) {
  try {
    return await insert(catalystApp, tableName, row);
  } catch (err) {
    const groups = (optional && optional.length && Array.isArray(optional[0])) ? optional
      : (optional && optional.length ? [optional] : []);
    if (!groups.length) throw err;
    const stripped = { ...row };
    const dropped = [];
    for (const group of groups) {
      for (const k of group) { delete stripped[k]; dropped.push(k); }
      try {
        const saved = await insert(catalystApp, tableName, stripped);
        console.error(
          `[formSubmit] ${tableName} insert only succeeded after dropping ${dropped.join(', ')}: ` +
          `add these columns in the Catalyst console (create-tables.md). Original error:`, err
        );
        return saved;
      } catch (err2) { /* drop the next group as well and retry */ }
    }
    throw err; // no attempt worked: surface the ORIGINAL error, it's the real one
  }
}

// Queue a submission for the CRM sync worker (the crmSync cron function reads
// CrmSyncQueue and pushes rows into Zoho CRM). Best-effort by design: it must
// NEVER throw into the request path: the submission is already saved, so a
// queue miss only delays that one lead's sync, it doesn't fail the user's form.
async function enqueueCrm(catalystApp, { source, rowId, email, leadType, data }) {
  try {
    await catalystApp.datastore().table('CrmSyncQueue').insertRow({
      Source: source,
      SourceRowId: rowId != null ? String(rowId) : null,
      Email: email,
      LeadType: leadType || 'consumer',
      Payload: JSON.stringify(data || {}),
      Status: 'PENDING',
      Attempts: 0
    });
  } catch (err) {
    console.error(`[formSubmit] CRM enqueue failed for ${source}:`, err);
  }
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// Waitlist: stage 1 (name/email/phone/postal code/referral).
// Table: WaitlistSignups
app.post('/waitlist-join', limit({ key: 'waitlist-join', max: 20, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};
  const firstName = str(b.firstName);
  const lastName = str(b.lastName);
  const email = str(b.email);
  const phone = normalizePhone(b.phone);
  const postal = normalizePostal(b.fsa || b.postalFull);
  // What /join asked: which product the household is pooling for. A closed
  // list, because it becomes a CRM picklist and a value the picklist does not
  // know is a field Zoho refuses. Not required and never a 400: the older
  // /waitlist/ page posts here too and has no such question, and a bad value
  // from anywhere is worth less than the row it would block.
  const poolingFor = ['internet', 'tires', 'both'].includes(str(b.poolingFor).toLowerCase())
    ? str(b.poolingFor).toLowerCase() : null;

  if (firstName.length < 2) return badRequest(res, 'firstName is required.');
  if (lastName.length < 2) return badRequest(res, 'lastName is required.');
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');
  if (!phone) return badRequest(res, 'A valid 10-digit Canadian phone number is required.');
  // Was `if (!fsa)`: any non-empty string passed, so "ZZZ" was accepted.
  if (!postal.fsa) return badRequest(res, 'A valid Canadian postal code is required.');

  try {
    const catalystApp = catalyst.initialize(req);

    // SELF REFERRAL, refused at the door rather than filtered out of the count
    // later. Somebody can hold a spot in the popup, receive their own share
    // link, click it, and arrive here carrying their own code. Only a code
    // shaped like ours costs a read, and only a match costs the value: an
    // ordinary referral, a typo, or a member code all fall straight through.
    let referral = orNull(str(b.referral));
    if (referral && SHARE_CODE_RE.test(referral.toUpperCase())) {
      const owner = await ownerOfShareCode(catalystApp, referral.toUpperCase());
      if (owner && owner === emailKey(email)) {
        console.log('[formSubmit] waitlist-join: own share code dropped');
        referral = null;
      }
    }

    // PoolingFor is the one column that may not exist yet (create-tables.md
    // and README.md name it); insertTolerant drops it and keeps the row.
    const row = await insertTolerant(catalystApp, 'WaitlistSignups', {
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      // Digits only: the Phone column predates E.164 normalisation, so keep the
      // stored shape stable and send the canonical form to the CRM.
      Phone: digits(b.phone),
      FSA: postal.fsa,
      ReferralCode: referral,
      PoolingFor: poolingFor,
      SubmittedAt: catalystNow()
    }, ['PoolingFor']);
    await enqueueCrm(catalystApp, {
      source: 'WaitlistSignups', rowId: row.ROWID, email, leadType: 'consumer',
      data: {
        firstName, lastName, phone,
        emailKey: emailKey(email),
        fsa: postal.fsa, postal: postal.full,
        province: str(b.province) || null, provinceCode: str(b.provinceCode) || null,
        referral: referral || '',
        poolingFor,
        ...consentFrom(b, req)
      }
    });
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'waitlist-join');
  }
});

// Waitlist: stage 2 (optional add-on details + optional bill attachment).
// Table: WaitlistDetails
app.post('/waitlist-details', limit({ key: 'waitlist-details', max: 20, windowSec: 3600 }), tolerantUpload(upload.single('billFile')), async (req, res) => {
  const b = req.body || {};
  const email = str(b.email);
  if (!isEmail(email)) { discardUpload(req); return badRequest(res, 'A valid email is required.'); }

  const services = parseServices(b.services);

  try {
    const catalystApp = catalyst.initialize(req);
    const file = await storeFile(catalystApp, req.file);
    const postal = normalizePostal(b.fsa || b.postalFull);
    // Deliberately NOT widened to match the form. Stage 2 only ever appears to
    // a member who signed up and verified a code seconds earlier, so every
    // answer it collects has an owner keyed on user_id: the bill fields go to
    // member_bills via POST /me/bill, the services checklist to user_prefs via
    // POST /me/prefs, and the name, postal code and province are already on
    // the users row that signup wrote. This table is the CRM's lead trail and
    // the fallback the auth function reads when that member write is lost:
    // copying identity columns into it would duplicate PII to no end, and
    // crmSync reads the payload below rather than these columns anyway.
    const row = await insert(catalystApp, 'WaitlistDetails', {
      // Lowercased for the same reason as BillCheckupSubmissions.Email: the
      // auth function's fallback finds this row by exact match against the
      // member's email_normalized, and ZCQL has no LOWER(). The CRM payload
      // below keeps the address exactly as they typed it.
      Email: emailKey(email),
      FSA: postal.fsa,
      Provider: orNull(str(b.provider)),
      MonthlyCost: toNumber(b.cost),
      DownloadSpeed: orNull(str(b.speed)),
      PromoEndDate: orNull(str(b.promoEnd)),
      SwitchThreshold: orNull(str(b.threshold)),
      Services: json(services),
      BillFileId: orNull(file?.id ?? null),
      BillFileName: orNull(file?.name ?? (req.fileRejected ? `[rejected: ${req.fileRejected}]` : null)),
      SubmittedAt: catalystNow()
    });
    await enqueueCrm(catalystApp, {
      source: 'WaitlistDetails', rowId: row.ROWID, email, leadType: 'consumer',
      data: {
        emailKey: emailKey(email),
        provider: str(b.provider), cost: toNumber(b.cost), speed: str(b.speed),
        promoEnd: str(b.promoEnd), threshold: str(b.threshold),
        discount: toNumber(b.discount),
        contractStart: str(b.contractStart) || null,
        contractLength: str(b.contractLength) || null,
        fsa: postal.fsa, postal: postal.full,
        province: str(b.province) || null, provinceCode: str(b.provinceCode) || null,
        services: servicesForCrm(services),
        billFileName: file?.name ?? (req.fileRejected ? `[rejected: ${req.fileRejected}]` : null),
        ...consentFrom(b, req)
      }
    });
    // Tell the caller the lead saved but the attachment did not, so the page can
    // say so. Previously the row stored "[rejected: too large]" and the visitor
    // saw an unqualified success.
    res.status(200).json({ ok: true, id: row.ROWID, fileRejected: req.fileRejected || null });
  } catch (err) {
    serverError(res, err, 'waitlist-details');
  }
});

/* ------------------------------------------------------------------ *
 * The winter tire cohort: tires.whollar.ca
 * ------------------------------------------------------------------ */

// One submission from the tire vertical writes up to five tables, because one
// household can bring several cars and several appointment windows and the
// ranking of those windows is what an installer bids against. Tables and
// columns: catalyst-backend/scripts/create-tables.md sections 35 and 36.
//
// WHY NOT /waitlist-join. That route is the internet product's and its shape
// is fixed: one row, one table, a mandatory phone. This form asks about a car,
// a tire size, a strategy, and up to five ranked dates, and the phone is
// optional here because the tire form says it is. Widening the internet route
// to carry all of that would make one handler serve two products with two
// different required fields, which is how the wrong validation ends up in
// front of the wrong household.
const TIRE_WAVE_SIZE = 250;                 // matches CFG.waveSize in tires/js/tire-kit.js
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no I, O, 0 or 1: these get read aloud
const CITY_CODES = { gta: 'GTA', ottawa: 'OTT', montreal: 'MTL', calgary: 'CAL',
  vancouver: 'VAN', edmonton: 'EDM', other: 'OTH' };
const bool = v => (v === true || str(v) === 'true' ? 'true' : 'false');

function tireRef(city) {
  let tail = '';
  for (let i = 0; i < 4; i++) tail += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  return `WHL-TIRE-${CITY_CODES[city] || 'OTH'}-${tail}`;
}

// The reference code is minted here and never in the browser: it is what a
// household quotes back to change anything, so two people holding the same one
// is a support problem with no clean answer. ReferenceCode is Unique in the
// console, which turns a collision into a failed insert rather than a
// duplicate, and this retries on that failure rather than trusting randomness.
// 32^4 is a million codes per city, so a second attempt is already unlikely and
// a fourth is a bug somewhere else.
async function insertSignupWithRef(catalystApp, city, row) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ReferenceCode = tireRef(city);
    try {
      const saved = await insertTolerant(catalystApp, 'TireWaitlistSignups',
        { ...row, ReferenceCode }, [['Wave']]);
      return { row: saved, ReferenceCode };
    } catch (err) {
      lastErr = err;
      console.error(`[formSubmit] tire reference collision or insert failure on attempt ${attempt + 1}:`, err);
    }
  }
  throw lastErr;
}

// The counter is a sidecar, exactly like cohort_counter in section 26: it must
// never fail a submission. Read, add one, write. Two submissions in the same
// second can read the same number and the count drifts low, which is why this
// is used for a wave and never for anything that has to be exact. It is also
// the only honest source of a count at all: ZCQL refuses any LIMIT over 300, so
// counting the rows tops out at "300+".
async function bumpTireCounter(catalystApp, city) {
  try {
    const key = `tires:${city}`;
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT ROWID, Joined FROM TireCohortCounter WHERE CounterKey = '${key}' LIMIT 1`);
    const found = rows && rows[0] && rows[0].TireCohortCounter;
    const joined = found ? Number(found.Joined || 0) + 1 : 1;
    const table = catalystApp.datastore().table('TireCohortCounter');
    if (found) await table.updateRow({ ROWID: found.ROWID, Joined: joined, UpdatedAt: catalystNow() });
    else await table.insertRow({ CounterKey: key, Vertical: 'tires', City: city, Joined: joined, UpdatedAt: catalystNow() });
    return joined;
  } catch (err) {
    console.error('[formSubmit] TireCohortCounter write skipped:', err);
    return null;
  }
}

// The side tables, written the same way whichever save carries them: the hold
// on the quick path, which arrives with everything at once, and the profile
// save on the guided path, which arrives later against a reference that already
// exists. Nothing in here may fail the request. The household is on the list
// either way, and losing a car to a bad column is not a reason to tell them
// they are not.
//
// Windows are capped because every one is its own concurrent insert; the page
// keeps the full list of days in details.payload.days so nothing is lost.
const TIRE_WINDOW_CAP = 31;
async function writeTireProfile(catalystApp, ReferenceCode, email, b, now) {
  const vehicles = Array.isArray(b.vehicles) ? b.vehicles.slice(0, 6) : [];
  const windows = Array.isArray(b.windows) ? b.windows.slice(0, TIRE_WINDOW_CAP) : [];
  const toolRuns = Array.isArray(b.toolRuns) ? b.toolRuns.slice(0, 4) : [];
  const details = b.details && typeof b.details === 'object' ? b.details : null;
  const later = [];
  vehicles.forEach((v, i) => {
    later.push(insertTolerant(catalystApp, 'TireWaitlistVehicles', {
      VehicleKey: `${ReferenceCode}:${i + 1}`,
      ReferenceCode,
      Email: emailKey(email),
      InputMode: str(v.inputMode) || 'unsure',
      VehicleYear: orNull(str(v.year)),
      VehicleMake: orNull(str(v.make)),
      VehicleModel: orNull(str(v.model)),
      Vin: orNull(str(v.vin).toUpperCase()),
      TireSize: orNull(str(v.tireSize)),
      SizeNormalized: orNull(str(v.sizeNormalized)),
      Strategy: orNull(str(v.strategy)),
      RunsWinterNow: orNull(str(v.runsWinterNow)),
      OwnsRims: orNull(str(v.ownsRims)),
      SubmittedAt: now,
      StartingPoint: orNull(str(v.startingPoint)),
      TireLifeLeft: orNull(str(v.tireLifeLeft)),
      VehicleTrim: orNull(str(v.trim).slice(0, 80)),
      WinterSizeChosen: orNull(str(v.winterSizeChosen)),
      SizeDownsized: v.sizeDownsized == null ? null : bool(v.sizeDownsized),
      // The record that the "confirm this against your own car" disclaimer
      // was shown and accepted. The one field here with a consequence
      // outside the database, so it is written even when it is false.
      SizeAck: v.sizeAck == null ? null : bool(v.sizeAck),
      Staggered: v.staggered == null ? null : bool(v.staggered),
      TpmsPresent: orNull(str(v.tpmsPresent)),
      RimsRecommendation: orNull(str(v.rimsRecommendation))
    }, [['StartingPoint', 'TireLifeLeft', 'VehicleTrim', 'WinterSizeChosen', 'SizeDownsized',
         'SizeAck', 'Staggered', 'TpmsPresent', 'RimsRecommendation']]));
  });

  if (details) {
    later.push(insertTolerant(catalystApp, 'TireWaitlistDetails', {
      ReferenceCode,
      Email: emailKey(email),
      Needs: orNull(str(details.needs)),
      Tier: orNull(str(details.tier)),
      Brand: orNull(str(details.brand)),
      Budget: orNull(str(details.budget)),
      Financing: orNull(str(details.financing)),
      InstallerType: orNull(str(details.installerType)),
      SplitPreference: orNull(str(details.splitPreference)),
      InstallWindows: orNull(str(details.installWindows).slice(0, 255)),
      NotBefore: orNull(str(details.notBefore)),
      MustBeOnBy: orNull(str(details.mustBeOnBy)),
      Memberships: orNull(str(details.memberships)),
      Priorities: orNull(str(details.priorities)),
      Readiness: orNull(str(details.readiness)),
      Notes: orNull(str(details.notes).slice(0, 4000)),
      // Everything the form asked that has no column of its own, so a new
      // question is not a schema change and a console visit.
      Payload: json(details.payload ?? null),
      SubmittedAt: now,
      BrandLine: orNull(str(details.brandLine)),
      TravelRadius: orNull(str(details.travelRadius)),
      InstallerName: orNull(str(details.installerName)),
      InstallerAddress: orNull(str(details.installerAddress)),
      InstallerPostal: orNull(str(details.installerPostal).toUpperCase()),
      InsuranceHelp: details.insuranceHelp == null ? null : bool(details.insuranceHelp),
      InsurerProvince: orNull(str(details.insurerProvince)),
      PremiumAnnual: toNumber(details.premiumAnnual)
    }, [['BrandLine', 'TravelRadius', 'InstallerName', 'InstallerAddress', 'InstallerPostal',
         'InsuranceHelp', 'InsurerProvince', 'PremiumAnnual']]));
  }

  windows.forEach((w, i) => {
    const rank = Number(w.rank) || i + 1;
    later.push(insertTolerant(catalystApp, 'TireInstallWindows', {
      WindowKey: `${ReferenceCode}:${rank}`,
      ReferenceCode,
      Email: emailKey(email),
      WindowDate: str(w.date),
      Slot: str(w.slot) || 'any',
      // The order they picked, not the order of the dates. Someone whose
      // first choice is the latest date is telling you something, and a sort
      // by date would lose it.
      Rank: rank,
      SubmittedAt: now
    }));
  });

  toolRuns.forEach((t) => {
    later.push(insertTolerant(catalystApp, 'TireToolRuns', {
      RunKey: `${ReferenceCode}:${str(t.tool)}`,
      ReferenceCode,
      Tool: str(t.tool),
      InputJson: json(t.input ?? null).slice(0, 2000),
      // What we told them, on a date, about their money. If an insurance
      // estimate is ever disputed this is the only record of what was said.
      OutputJson: json(t.output ?? null).slice(0, 2000),
      RanAt: now
    }));
  });

  const results = await Promise.allSettled(later);
  const failed = results.filter(r => r.status === 'rejected');
  return { total: later.length, failed: failed.length, reason: failed.length ? failed[0].reason : null };
}

// The guided path on tires.whollar.ca saves twice: once to hold the spot, which
// is a complete signup on its own, and again to attach the profile. The second
// save must not create a second household, so it carries the reference the
// first one returned. The email has to match the one on that row: without the
// check, knowing a reference (they are read aloud to support) would be enough
// to write a car and a set of dates onto somebody else's spot.
//
// It does not touch the counter: the position was taken at the hold, and
// finishing a profile must not move anybody. It does not enqueue for the CRM:
// the household is already queued from the hold.
async function tireProfile(req, res, b) {
  const email = str(b.email);
  const reference = str(b.reference).toUpperCase();
  if (!/^WHL-TIRE-[A-Z]{3}-[A-HJ-NP-Z2-9]{4}$/.test(reference)) return badRequest(res, 'That reference does not look right.');
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');
  try {
    const catalystApp = catalyst.initialize(req);
    const lit = reference.replace(/'/g, "''");
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT ROWID, Email, Wave FROM TireWaitlistSignups WHERE ReferenceCode = '${lit}' LIMIT 1`);
    const found = rows && rows[0] && rows[0].TireWaitlistSignups;
    if (!found || emailKey(found.Email) !== emailKey(email)) {
      return res.status(404).json({ ok: false, error: 'We could not find that spot. Check the reference and the email.' });
    }
    const now = catalystNow();
    const saved = await writeTireProfile(catalystApp, reference, email, b, now);
    if (saved.failed) {
      console.error(`[formSubmit] tire profile: ${saved.failed} of ${saved.total} ` +
        `side tables failed for ${reference}:`, saved.reason);
    }
    // The two consents the profile asks that the hold could not: whether the
    // installers may see the postal code, vehicle and dates, and whether the
    // household wants to hear about an internet cohort. Columns, not a blob,
    // because the installer-sharing rule reads the column. Best effort.
    try {
      await catalystApp.datastore().table('TireWaitlistSignups').updateRow({
        ROWID: found.ROWID,
        ConsentShare: bool(b.consentShare),
        AlsoInternet: bool(b.alsoInternet)
      });
    } catch (err) {
      console.error(`[formSubmit] tire profile: consent columns not updated for ${reference}:`, err);
    }
    return res.status(200).json({ ok: true, reference, wave: found.Wave == null ? null : Number(found.Wave) });
  } catch (err) {
    return serverError(res, err, 'tire-waitlist-join profile');
  }
}

app.post('/tire-waitlist-join', limit({ key: 'tire-waitlist-join', max: 20, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};
  const firstName = str(b.firstName);
  const lastName = str(b.lastName);
  const email = str(b.email);
  const city = str(b.city).toLowerCase();
  const path = str(b.path);
  const postal = normalizePostal(b.postalFull || b.fsa);

  // A profile save is the second half of the guided path. The household is
  // already on the list, so none of the identity rules below apply to it, and
  // none of them may run: re-validating a name could only refuse a save the
  // household cannot fix from where they are.
  if (str(b.stage) === 'profile') return tireProfile(req, res, b);

  // Mirrors what the page checks in its own words, so a form that would fail
  // here has already said so there. The phone is deliberately NOT required:
  // the tire form marks mobile optional and the page must not be made to lie.
  if (firstName.length < 2) return badRequest(res, 'firstName is required.');
  if (lastName.length < 2) return badRequest(res, 'lastName is required.');
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');
  if (!postal.fsa) return badRequest(res, 'A valid Canadian postal code is required.');
  if (!CITY_CODES[city]) return badRequest(res, 'Pick the area you park in.');
  if (path !== 'quick' && path !== 'guided') return badRequest(res, 'path must be quick or guided.');

  // Read here only for what the CRM payload counts. The rows themselves are
  // written by writeTireProfile, which reads the same fields off the same body.
  const vehicles = Array.isArray(b.vehicles) ? b.vehicles.slice(0, 6) : [];
  const windows = Array.isArray(b.windows) ? b.windows.slice(0, TIRE_WINDOW_CAP) : [];

  try {
    const catalystApp = catalyst.initialize(req);
    const now = catalystNow();
    const consent = consentFrom(b, req);
    const joined = await bumpTireCounter(catalystApp, city);
    const wave = joined ? Math.max(1, Math.ceil(joined / TIRE_WAVE_SIZE)) : null;

    const { row, ReferenceCode } = await insertSignupWithRef(catalystApp, city, {
      // Lowercased for the same reason as every other table here: the CRM and
      // the auth fallback both find a household by exact match, and ZCQL has
      // no LOWER().
      Email: emailKey(email),
      FirstName: firstName,
      LastName: lastName,
      Phone: digits(b.phone) || null,
      FSA: postal.fsa,
      PostalFull: postal.full,
      City: city,
      Path: path,
      Source: str(b.source) || 'tires-site',
      Language: orNull(str(b.language)) || 'en',
      ReferralCode: orNull(str(b.referral)),
      ConsentEmail: bool(b.consentEmail),
      ConsentSms: bool(b.consentSms),
      ConsentShare: bool(b.consentShare),
      AlsoInternet: bool(b.alsoInternet),
      ConsentText: str(b.consentText).slice(0, 4000) || null,
      ConsentAt: now,
      SubmittedAt: now,
      Wave: wave
    });

    const saved = await writeTireProfile(catalystApp, ReferenceCode, email, b, now);
    if (saved.failed) {
      console.error(`[formSubmit] tire-waitlist-join: ${saved.failed} of ${saved.total} ` +
        `side tables failed for ${ReferenceCode}:`, saved.reason);
    }

    await enqueueCrm(catalystApp, {
      source: 'TireWaitlistSignups', rowId: row.ROWID, email, leadType: 'consumer',
      data: {
        emailKey: emailKey(email),
        firstName, lastName,
        phone: normalizePhone(b.phone),
        fsa: postal.fsa, postal: postal.full,
        // Asked only for "Somewhere else"; everywhere else the city says it.
        province: orNull(str(b.province).toUpperCase().slice(0, 2)),
        city, path, wave,
        // The field the CRM already carries for which product a household is
        // here for. A tire household lands on the same record shape as one
        // that came through the umbrella's /join and ticked tires.
        pooling_for: 'tires',
        reference: ReferenceCode,
        vehicles: vehicles.length,
        tireSizes: vehicles.map(v => str(v.winterSizeChosen) || str(v.sizeNormalized) || str(v.tireSize)).filter(Boolean),
        windows: windows.length,
        alsoInternet: bool(b.alsoInternet) === 'true',
        ...consent
      }
    });

    // `joined` is the counted position. Returned so a later page can use it
    // and deliberately not printed by this one: the counter is a sidecar that
    // drifts low under concurrency, so it is good for a wave and never for a
    // number a household would quote.
    res.status(200).json({ ok: true, reference: ReferenceCode, wave, joined });
  } catch (err) {
    serverError(res, err, 'tire-waitlist-join');
  }
});

// Bill checkup: every "join the waitlist" entry point on the checkup tool
// (both the quick-join rails and the main check-button flow feed this).
// Table: BillCheckupSubmissions
//
// This route stores the LEAD, never the signed-in member's bill, and it cannot:
// the session cookie is host-only to internet.whollar.ca (see auth/lib/cookies.js)
// and this function is called cross-origin on the Catalyst domain, so the cookie
// is not in the request at all: there is no session here to read. A signed-in
// member's copy is written by the auth function, which owns sessions:
//   - the checkup POSTs it to /me/bill as the results render, and
//   - GET /me/bill adopts the newest row of THIS table for that member's email,
//     which is what covers the case where that POST never arrived.
// Making this route session-aware would mean proxying it same-origin and
// duplicating session verification into the public forms endpoint. Don't.
// ---------------------------------------------------------------------------
// The umbrella's show of hands: what should Whollar help you buy after tires
// ---------------------------------------------------------------------------
//
// ANONYMOUS BY DESIGN, and that is why this is not `product_interest`
// (create-tables.md section 23). That table is a signed-in member answering a
// detailed survey, keyed on `${user_id}:${product}`. whollar.ca has no login,
// no session and no /api/auth rewrite, so there is no user_id to key on. This
// is a show of hands on a public page.
//
// ONE ROW PER PICK, not one per submission. The only question anyone will ever
// ask this table is "how many hands for each", and the Data Store has no joins
// and caps a read at 300 rows, so the shape that answers it in one query is
// GROUP BY Product. VoteId groups the picks of one submission, so counting
// voters rather than picks stays one query too, and VoteKey is Unique so a
// double click cannot be counted twice.
//
// The keys are values, never labels, for the same reason the member survey
// gives: the copy on those buttons will be edited, and storing "Car
// maintenance" would open a second bucket the day it becomes "Car servicing".
const VOTE_PRODUCTS = [
  'home-insurance', 'mobile-plans', 'car-maintenance', 'home-services',
  'energy', 'travel', 'pet-care', 'other'
];

function voteId() {
  let id = '';
  for (let i = 0; i < 10; i++) id += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  return id;
}

app.post('/product-vote', limit({ key: 'product-vote', max: 30, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};
  // Unknown keys are dropped rather than refused, the same rule the member
  // survey uses: a stale tab contributes the picks that still exist instead of
  // having the whole vote thrown away.
  const picks = [...new Set(
    (Array.isArray(b.products) ? b.products : []).map(str).filter(p => VOTE_PRODUCTS.includes(p))
  )];
  if (!picks.length) return badRequest(res, 'Pick at least one.');

  const otherText = str(b.otherText).slice(0, 120);
  const sourcePage = str(b.sourcePage).slice(0, 120);

  try {
    const catalystApp = catalyst.initialize(req);
    const now = catalystNow();
    const id = voteId();

    const results = await Promise.allSettled(picks.map(product => insertTolerant(
      catalystApp,
      'ProductVotes',
      {
        VoteKey: `${id}:${product}`,
        VoteId: id,
        Product: product,
        OtherText: product === 'other' && otherText ? otherText : null,
        SourcePage: sourcePage || null,
        SubmittedAt: now
      },
      [['OtherText', 'SourcePage']]
    )));

    const counted = results.filter(r => r.status === 'fulfilled').length;
    for (const r of results) {
      if (r.status === 'rejected') console.error('[formSubmit] ProductVotes row failed:', r.reason);
    }
    // Every row here is equal, so unlike the waitlist there is no anchor row
    // whose failure should fail the request. Nothing saved is a real failure;
    // some saved is a vote, and the page is told how many so it cannot thank
    // someone for a vote that was entirely dropped.
    if (!counted) return serverError(res, new Error('no ProductVotes rows were written'), 'product-vote');
    res.json({ ok: true, counted, voteId: id });
  } catch (err) {
    return serverError(res, err, 'product-vote');
  }
});

app.post('/bill-checkup-join', limit({ key: 'bill-checkup-join', max: 30, windowSec: 3600 }), tolerantUpload(upload.single('billFile')), async (req, res) => {
  const b = req.body || {};
  const email = str(b.email);
  if (!isEmail(email)) { discardUpload(req); return badRequest(res, 'A valid email is required.'); }

  try {
    const catalystApp = catalyst.initialize(req);
    const file = await storeFile(catalystApp, req.file);
    const postal = normalizePostal(b.pc || b.postalFull);
    const row = await insertTolerant(catalystApp, 'BillCheckupSubmissions', {
      // Lowercased so GET /me/bill's exact-match adoption (ZCQL has no LOWER)
      // finds this row via the member's email_normalized. CRM keeps the raw
      // casing in its own payload below.
      Email: emailKey(email),
      Via: orNull(str(b.via)) || 'form',
      PostalFSA: postal.fsa,
      Provider: orNull(str(b.prov)),
      // The price paid TODAY, promo included (unchanged meaning since
      // 2026-08-08). The v17 checkup computes it from the promo structure
      // below; DiscountAmount is retired with the deleted discount field.
      MonthlyCost: toNumber(b.cost),
      DownloadSpeed: orNull(str(b.spd)),
      AccessTech: orNull(str(b.tech)),
      PromoEndDate: orNull(str(b.pdate)),
      MonthsToRenewal: b.pmo != null && b.pmo !== '' ? parseInt(b.pmo, 10) : null,
      PromoExpired: str(b.expired) === 'true',
      ContractStartDate: orNull(str(b.contractStart)),
      ContractLength: orNull(str(b.contractLength)),
      SwitchThreshold: orNull(str(b.switchFor)),
      // v17 checkup columns (create-tables.md section 19). Tolerated as a
      // group below until they exist in the console.
      PriceDuringPromo: toNumber(b.priceDuringPromo),
      PriceAfterPromo: toNumber(b.priceAfterPromo),
      PromoPeriods: orNull(str(b.promoPeriods) === '[]' ? null : str(b.promoPeriods)),
      PromoFallbackPrice: toNumber(b.promoFallbackPrice),
      IsMultiPromo: str(b.isMultiPromo) === 'true',
      StartDateUnknown: str(b.startUnknown) === 'true',
      PromoEndUnknown: str(b.promoUnknown) === 'true',
      ComputedWindowMonths: b.windowMonths != null && b.windowMonths !== '' ? parseInt(b.windowMonths, 10) : null,
      ComputedCurrentCost: toNumber(b.computedCurrentCost),
      ComputedBenchmarkMonthly: toNumber(b.computedBenchmarkMonthly),
      ComputedSavings: toNumber(b.computedSavings),
      ComputedOverpaidToDate: toNumber(b.computedOverpaidToDate),
      ComputedBasis: orNull(str(b.computedBasis)),
      ComputedTone: orNull(str(b.computedTone)),
      BillFileId: orNull(file?.id ?? null),
      BillFileName: orNull(file?.name ?? (req.fileRejected ? `[rejected: ${req.fileRejected}]` : null)),
      SubmittedAt: catalystNow()
      // DiscountAmount is absent from this insert on purpose, so it needs no
      // tolerance: the 2026-08-12 probe showed the column dropped from the
      // console, and v17 retired the discount question that fed it. The
      // groups below are the columns that may still be missing.
    }, [
      // newest group first: the v17 columns land in the console after this
      // code ships, and their absence must not cost the contract columns.
      ['PriceDuringPromo', 'PriceAfterPromo', 'PromoPeriods', 'PromoFallbackPrice',
       'IsMultiPromo', 'StartDateUnknown', 'PromoEndUnknown',
       'ComputedWindowMonths', 'ComputedCurrentCost', 'ComputedBenchmarkMonthly',
       'ComputedSavings', 'ComputedOverpaidToDate', 'ComputedBasis', 'ComputedTone'],
      ['ContractStartDate', 'ContractLength']
    ]);
    await enqueueCrm(catalystApp, {
      source: 'BillCheckupSubmissions', rowId: row.ROWID, email, leadType: 'consumer',
      data: {
        emailKey: emailKey(email),
        via: str(b.via) || 'form',
        fsa: postal.fsa, postal: postal.full,
        province: str(b.province) || null, provinceCode: str(b.provinceCode) || null,
        provider: str(b.prov), cost: toNumber(b.cost), speed: str(b.spd),
        tech: str(b.tech), promoEnd: str(b.pdate),
        monthsToRenewal: b.pmo != null && b.pmo !== '' ? parseInt(b.pmo, 10) : null,
        contractStart: str(b.contractStart) || null,
        contractLength: str(b.contractLength) || null,
        threshold: str(b.switchFor),
        effectiveCost: toNumber(b.effectiveCost),
        // What the household was actually shown (the v17 engine). Without
        // these, sales sees a single charge and has no idea which of the four
        // results appeared on screen: the number the conversation has to
        // start from. The benchmark figure is internal: it may appear in this
        // note for a rep, never in anything household-facing.
        priceDuringPromo: toNumber(b.priceDuringPromo),
        priceAfterPromo: toNumber(b.priceAfterPromo),
        isMultiPromo: str(b.isMultiPromo) === 'true' ? 'true' : null,
        promoPeriods: str(b.promoPeriods) === '[]' ? null : (str(b.promoPeriods) || null),
        promoFallbackPrice: toNumber(b.promoFallbackPrice),
        startUnknown: str(b.startUnknown) === 'true' ? 'true' : null,
        promoUnknown: str(b.promoUnknown) === 'true' ? 'true' : null,
        windowMonths: b.windowMonths != null && b.windowMonths !== '' ? parseInt(b.windowMonths, 10) : null,
        currentCost12: toNumber(b.computedCurrentCost),
        benchmarkMonthly: toNumber(b.computedBenchmarkMonthly),
        savings12: toNumber(b.computedSavings),
        overpaidToDate: toNumber(b.computedOverpaidToDate),
        basis: str(b.computedBasis) || null,
        tone: str(b.computedTone) || null,
        fallbackGeo: str(b.fallbackGeo) === 'true' ? 'true' : null,
        billFileName: file?.name ?? (req.fileRejected ? `[rejected: ${req.fileRejected}]` : null),
        ...consentFrom(b, req)
      }
    });
    res.status(200).json({ ok: true, id: row.ROWID, fileRejected: req.fileRejected || null });
  } catch (err) {
    serverError(res, err, 'bill-checkup-join');
  }
});

// Bill checkup: real pooling counts for the loading interstitial's
// "N households already pooling" / "N near you" line, which used to be a
// hardcoded placeholder (1,284 / 37) that never moved. Read-only, no PII in
// the response: counts only.
//
// ZCQL refuses any LIMIT over 300 (a hard Catalyst ceiling, not a choice
// made here), so a table past that size reports a capped "300+" rather than
// an exact count: the same convention the admin diagnostics endpoint uses
// for the same reason. That is an honest floor, not a wrong number.
// (FSA_RE, the real Canadian first/third-letter charset, is declared
// above, next to normalizePostal().)
const COUNT_CAP = 300;

async function countRows(catalystApp, table, whereSql) {
  const sql = `SELECT ROWID FROM ${table}${whereSql ? ' WHERE ' + whereSql : ''} LIMIT ${COUNT_CAP}`;
  const rows = await catalystApp.zcql().executeZCQLQuery(sql);
  const n = (rows || []).length;
  return { count: n, capped: n >= COUNT_CAP };
}

app.get('/pooling-count', limit({ key: 'pooling-count', max: 120, windowSec: 3600 }), async (req, res) => {
  try {
    const catalystApp = catalyst.initialize(req);
    const total = await countRows(catalystApp, 'BillCheckupSubmissions');

    let fsa = null;
    const fsaParam = str(req.query.fsa).toUpperCase();
    // Whitelisted against FSA_RE before it ever reaches the query string, so
    // this interpolation carries only 3 already-validated alphanumeric chars,
    // never raw user input.
    if (FSA_RE.test(fsaParam)) {
      const r = await countRows(catalystApp, 'BillCheckupSubmissions', `PostalFSA = '${fsaParam}'`);
      fsa = { code: fsaParam, ...r };
    }

    res.status(200).json({ ok: true, total, fsa });
  } catch (err) {
    serverError(res, err, 'pooling-count');
  }
});

// Bill checkup: "deep read" request (attach agreement/more bills + note).
// Table: DeepReadRequests
app.post('/deep-read', limit({ key: 'deep-read', max: 10, windowSec: 3600 }), guardUpload(upload.array('files', 5)), async (req, res) => {
  const b = req.body || {};
  const email = str(b.email);
  if (!isEmail(email)) { discardUpload(req); return badRequest(res, 'A valid email is required.'); }
  if (!req.files || !req.files.length) return badRequest(res, 'At least one file is required.');

  try {
    const catalystApp = catalyst.initialize(req);
    const files = await storeFiles(catalystApp, req.files);
    // One postal shape. This block used to store `pc` in whatever case the
    // browser sent while the CRM payload below uppercased the same value:
    // two spellings of one field, written by one handler.
    const postal = normalizePostal(b.pc || b.postalFull);
    const context = {
      fsa: postal.fsa, postal: postal.full,
      province: orNull(str(b.province)), provinceCode: orNull(str(b.provinceCode)),
      prov: orNull(str(b.prov)), cost: toNumber(b.cost),
      spd: orNull(str(b.spd)), tech: orNull(str(b.tech)), pdate: orNull(str(b.pdate)),
      contractStart: orNull(str(b.contractStart)), contractLength: orNull(str(b.contractLength)),
      effectiveCost: toNumber(b.effectiveCost),
      verdict: orNull(str(b.verdict))
    };
    const row = await insert(catalystApp, 'DeepReadRequests', {
      Email: email,
      Note: orNull(str(b.note)),
      FileIds: json(files.map(f => f.id)),
      FileNames: json(files.map(f => f.name)),
      ContextSnapshot: json(context),
      SubmittedAt: catalystNow()
    });
    await enqueueCrm(catalystApp, {
      source: 'DeepReadRequests', rowId: row.ROWID, email, leadType: 'consumer',
      data: {
        emailKey: emailKey(email),
        note: str(b.note), files: files.map(f => f.name).join(', '),
        fsa: postal.fsa, postal: postal.full,
        province: str(b.province) || null, provinceCode: str(b.provinceCode) || null,
        provider: str(b.prov), cost: toNumber(b.cost),
        speed: str(b.spd), tech: str(b.tech), promoEnd: str(b.pdate),
        contractStart: str(b.contractStart) || null, contractLength: str(b.contractLength) || null,
        effectiveCost: toNumber(b.effectiveCost), verdict: str(b.verdict) || null,
        ...consentFrom(b, req)
      }
    });
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'deep-read');
  }
});

// Provider / partner application form.
// Table: PartnerApplications
app.post('/partner-application', limit({ key: 'partner-application', max: 10, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};
  const role = str(b.role);
  const firstName = str(b.firstName);
  const lastName = str(b.lastName);
  const company = str(b.company);
  const email = str(b.email);
  const phone = normalizePhone(b.phone);

  if (!role) return badRequest(res, 'role is required.');
  if (firstName.length < 2) return badRequest(res, 'firstName is required.');
  if (lastName.length < 2) return badRequest(res, 'lastName is required.');
  if (company.length < 2) return badRequest(res, 'company is required.');
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');
  if (!phone) return badRequest(res, 'A valid 10-digit Canadian phone number is required.');

  try {
    const catalystApp = catalyst.initialize(req);
    const row = await insert(catalystApp, 'PartnerApplications', {
      Role: role,
      FirstName: firstName,
      LastName: lastName,
      Company: company,
      Email: email,
      // Digits only: keep the existing column shape stable; the canonical
      // E.164 form goes to the CRM below.
      Phone: digits(b.phone),
      Provinces: json(Array.isArray(b.provinces) ? b.provinces : []),
      AccessTech: json(Array.isArray(b.tech) ? b.tech : []),
      LegalName: orNull(str(b.legalName)),
      ProviderType: orNull(str(b.providerType)),
      BusinessNumber: orNull(digits(b.businessNumber)),
      Brands: orNull(str(b.brands)),
      Signatory: orNull(str(b.signatory)),
      RepresentsBrands: orNull(str(b.representsBrands)),
      LOA: orNull(str(b.loa)),
      OtherType: orNull(str(b.otherType)),
      Note: orNull(str(b.note)),
      SubmittedAt: catalystNow()
    });
    await enqueueCrm(catalystApp, {
      source: 'PartnerApplications', rowId: row.ROWID, email, leadType: 'partner',
      data: {
        firstName, lastName, company, phone, role,
        emailKey: emailKey(email),
        provinces: (Array.isArray(b.provinces) ? b.provinces : []).join(', '),
        techs: (Array.isArray(b.tech) ? b.tech : []).join(', '),
        note: str(b.note),
        ...consentFrom(b, req)
      }
    });
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'partner-application');
  }
});

// Savings calculator: anonymous estimate snapshot (postal code + monthly
// bill → projected annual savings shown to the visitor).
// Table: CalculatorEstimates
app.post('/calculator-estimate', limit({ key: 'calculator-estimate', max: 40, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};

  // This was the one route with no input validation at all: it accepted any
  // body, so a junk postal code or an arbitrary "savings" number went straight
  // into the table. The per-IP rate limit was the only gate.
  const postal = normalizePostal(b.postal || b.fsa);
  if (!postal.fsa) return badRequest(res, 'A valid Canadian postal code is required.');

  const monthlyBill = toNumber(b.monthlyBill);
  if (monthlyBill == null || monthlyBill < 15 || monthlyBill > 500) {
    return badRequest(res, 'monthlyBill must be between 15 and 500.');
  }
  const savings = toNumber(b.estimatedAnnualSavings);
  // Bounded by what the widget can actually produce. The estimator now
  // compares the bill against the cheapest tracked plan at 100 Mbps or
  // better (js/whollar-estimate-bench.js), so the ceiling is
  // floor(maxBill - cheapestBenchmark) * 12 = floor(400 - 35) * 12 = 4380,
  // not the 1260 the retired flat-21%-of-bill formula could reach. A bound
  // left at 2000 would 400 every estimate above a ~$200 bill.
  if (savings == null || savings < 0 || savings > 5000) {
    return badRequest(res, 'estimatedAnnualSavings is out of range.');
  }

  try {
    const catalystApp = catalyst.initialize(req);
    const row = await insert(catalystApp, 'CalculatorEstimates', {
      // "A1A 1A1" when the full code is present, otherwise null, never a
      // half-normalised mix of spaced and unspaced values.
      PostalCode: postal.full,
      FSA: postal.fsa,
      MonthlyBill: monthlyBill,
      EstimatedAnnualSavings: savings,
      SubmittedAt: catalystNow()
    });
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'calculator-estimate');
  }
});

// Contact form on /contact.
// Table: ContactSubmissions
const CONTACT_TOPICS = ['sales', 'support', 'partnership', 'press', 'other'];
const CONTACT_INBOX = 'info@whollar.com';

// Best-effort copy of a submission to the team inbox, same ZeptoMail API the
// auth mailer uses (see functions/auth/src/lib/mailer.js: its regional-DC
// note applies here too). Mirror ZEPTOMAIL_TOKEN / ZEPTOMAIL_FROM (and
// ZEPTOMAIL_API_BASE if set) from the auth function's config onto this one;
// until they exist the message is logged instead, and either way a mail
// failure must NEVER fail the visitor's request: the row is already saved.
async function notifyTeam(subject, text) {
  const token = (process.env.ZEPTOMAIL_TOKEN || '').trim().replace(/^Bearer\s+/i, '');
  const from = (process.env.ZEPTOMAIL_FROM || '').trim();
  if (!token || !from) {
    console.log(`[formSubmit] notifyTeam (no mail transport) ${subject}\n${text}`);
    return;
  }
  try {
    const base = (process.env.ZEPTOMAIL_API_BASE || 'https://api.zeptomail.com').replace(/\/+$/, '');
    const res = await fetch(`${base}/v1.1/email`, {
      method: 'POST',
      headers: {
        Authorization: /^Zoho-enczapikey\s/i.test(token) ? token : `Zoho-enczapikey ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        from: { address: from, name: 'Whollar' },
        to: [{ email_address: { address: CONTACT_INBOX } }],
        subject,
        textbody: text
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`zeptomail ${res.status}: ${body.slice(0, 300)}`);
    }
  } catch (err) {
    console.error('[formSubmit] notifyTeam failed:', err);
  }
}

app.post('/contact', limit({ key: 'contact', max: 10, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};
  const firstName = str(b.firstName);
  const lastName = str(b.lastName);
  const email = str(b.email);
  const message = str(b.message);
  const topic = CONTACT_TOPICS.includes(str(b.topic)) ? str(b.topic) : 'other';

  if (firstName.length < 2) return badRequest(res, 'firstName is required.');
  if (lastName.length < 2) return badRequest(res, 'lastName is required.');
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');
  if (message.length < 10) return badRequest(res, 'A message of at least 10 characters is required.');
  if (message.length > 5000) return badRequest(res, 'message must be at most 5000 characters.');
  // Phone is optional here, unlike the join forms, but if one is given it
  // must parse, so the table never holds an uncallable number.
  if (str(b.phone) && !normalizePhone(b.phone)) {
    return badRequest(res, 'A valid 10-digit Canadian phone number is required.');
  }

  try {
    const catalystApp = catalyst.initialize(req);
    const row = await insert(catalystApp, 'ContactSubmissions', {
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      Phone: digits(b.phone) || null,
      Company: orNull(str(b.company).slice(0, 150)),
      Topic: topic,
      Message: message,
      SubmittedAt: catalystNow()
    });
    await enqueueCrm(catalystApp, {
      source: 'ContactSubmissions', rowId: row.ROWID, email, leadType: 'consumer',
      data: {
        firstName, lastName, topic,
        emailKey: emailKey(email),
        phone: normalizePhone(b.phone),
        company: str(b.company),
        message
      }
    });
    await notifyTeam(
      `[whollar.ca] Contact form: ${topic}: ${firstName} ${lastName}`,
      [
        `Topic: ${topic}`,
        `Name: ${firstName} ${lastName}`,
        `Email: ${email}`,
        `Phone: ${normalizePhone(b.phone) || 'n/a'}`,
        `Company: ${str(b.company) || 'n/a'}`,
        '',
        message
      ].join('\n')
    );
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'contact');
  }
});

// Bring Whollar to my city: the demand signal from a place we do not serve.
// Table: CityRequests (create-tables.md section 37)
//
// WHAT THIS IS NOT. It is not a join and it is not a waitlist row. /waitlist-join
// records a household in a place a cohort can actually form, and it asks for the
// name, the mobile and the postal code that make that possible. This asks one
// question, "where should we open next", of someone we cannot serve today, and
// asking them for a phone number to answer it is how you get no answer.
//
// THE CITY IS FREE TEXT, THE PROVINCE IS NOT. There is no list of Canadian city
// names worth shipping inside a function: it changes, it disagrees with itself
// about what is a city and what is a borough, and the day it goes stale it drops
// exactly the small places this question exists to find. So the city is validated
// by shape, capped, and off a charset that cannot carry markup or a URL. The
// province is a closed list because it is the dimension the answers get counted
// on, and thirteen values that never change cost nothing to enforce.
//
// NO MAIL. Every sibling route here tells the team by email; this one does not,
// on purpose. It is a one-click answer to a one-line question, so the volume is
// nothing like a contact form's, and a mailbox filling with "Ottawa" teaches
// less than one ZCQL count does.
const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
// A place name and nothing else: letters, spaces, hyphens, apostrophes, periods.
// Accents included, because Montreal and Trois-Rivieres are spelled with them.
const CITY_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ '.\-]{1,59}$/;

app.post('/city-request', limit({ key: 'city-request', max: 20, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};
  const city = str(b.city).replace(/\s+/g, ' ').trim();
  const province = str(b.province).toUpperCase();
  const email = str(b.email);
  const postal = normalizePostal(b.postal);
  // Same closed list and the same reasoning as /waitlist-join: it becomes a CRM
  // picklist, and a value the picklist does not know is a field Zoho refuses.
  const poolingFor = ['internet', 'tires', 'both'].includes(str(b.poolingFor).toLowerCase())
    ? str(b.poolingFor).toLowerCase() : null;

  if (!CITY_RE.test(city)) return badRequest(res, 'A city name is required.');
  if (!PROVINCES.includes(province)) return badRequest(res, 'A province is required.');
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');

  try {
    const catalystApp = catalyst.initialize(req);
    // FSA and PoolingFor are the columns most likely to be missing on a store
    // that has not caught up with section 37 yet, and a city with no postal code
    // is still worth counting. insertTolerant drops them and keeps the row.
    const row = await insertTolerant(catalystApp, 'CityRequests', {
      City: city,
      Province: province,
      Email: email,
      FSA: postal.fsa,
      PoolingFor: poolingFor,
      Marketing: b.marketing ? 'yes' : 'no',
      SubmittedAt: catalystNow()
    }, ['FSA', 'PoolingFor', 'Marketing']);
    await enqueueCrm(catalystApp, {
      source: 'CityRequests', rowId: row.ROWID, email, leadType: 'consumer',
      data: {
        city, province,
        emailKey: emailKey(email),
        fsa: postal.fsa, postal: postal.full,
        poolingFor,
        ...consentFrom(b, req)
      }
    });
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'city-request');
  }
});

/* ------------------------------------------------------------------ *
 * THE WAITLIST SHARE CODE
 * ------------------------------------------------------------------
 * A code that belongs to an EMAIL ADDRESS, and to nothing else.
 *
 * WHY THIS IS NOT lib/referral.js. That module mints into `referral_token`,
 * resolves only rows whose owner_type is 'member', and is the ledger behind
 * every member's referral count. A marketing code has no member behind it and
 * can never pay out, so putting it in that table would leave one guard doing
 * the load bearing work of telling the two kinds apart forever. They are kept
 * apart at the table level instead: this code lives in WaitlistShareCodes, is
 * never resolved by lib/referral.js, and is SHAPED so it cannot be mistaken
 * for a member code even by accident. See the two rules below.
 *
 * WHAT "EMAIL IDENTITY SPECIFIC" MEANS HERE. The registry is keyed on the
 * address, not on a submission and not on a product. WaitlistEmails already
 * holds one row per address PER PRODUCT, on purpose, so somebody who holds a
 * spot on the tire page and again on the internet page is two rows there. They
 * are one person, so they get one code, and that is why this is a second table
 * rather than a column on the first one.
 * ------------------------------------------------------------------ */

// Same alphabet as tireRef: no I, O, 0 or 1, because these get read aloud.
const SHARE_ALPHABET = REF_ALPHABET;
// The last character is drawn from the letters that CANNOT be read as hex.
// This is rule two below, and it is the whole reason the subset exists.
const SHARE_TAIL_ALPHABET = 'GHJKLMNPQRSTVWXYZ';
const SHARE_PREFIX = 'WS';
const SHARE_BODY_LEN = 8;
const SHARE_CODE_RE = /^WS[A-HJ-NP-Z2-9]{8}$/;

// The one place the share URL is spelled. Not the request origin: the code
// belongs to the person, not to the host they happened to be reading, and
// www.whollar.ca/join is the only join form that exists and answers 200
// without a redirect. internet.whollar.ca/join is 301'd away to www, and
// W.referral.link() in whollar-core.js builds /waitlist, which is a 404 on
// both www and tires. Neither is usable.
const SHARE_BASE = 'https://www.whollar.ca/join?ref=';

/* One character, drawn without modulo bias.
 *
 * Math.random() is what tireRef uses and it is wrong for anything anyone can
 * guess their way into: a share code is a name a stranger can type. 256 % 32
 * is 0 so the rejection ceiling is the whole byte for the 32 symbol alphabet,
 * and 256 - (256 % 17) = 255 for the 17 symbol tail.
 */
function pickFrom(alphabet) {
  const n = alphabet.length;
  const ceiling = 256 - (256 % n);
  for (;;) {
    const b = crypto.randomBytes(1)[0];
    if (b < ceiling) return alphabet[b % n];
  }
}

/* WS + 7 body characters + 1 non hex tail character. Ten in total.
 *
 * TWO SHAPING RULES, and both of them are load bearing:
 *
 *   1. TEN CHARACTERS. lib/token.js normalises to exactly 8 and rejects every
 *      other length, so a member token reader can never accept this. It also
 *      carries no `whl` substring, so referral.normalize's legacy branch is
 *      never entered on the way past.
 *
 *   2. THE LAST CHARACTER IS NEVER HEX. referral.js reads a legacy code with
 *      a forgiving TRAILING hex scan (coreOf), so a code ending in eight hex
 *      readable characters is claimed by it and normalised into a plausible
 *      WHL- code, which would then attribute a signup to whichever member's
 *      user_id happened to start with those digits.
 *
 *      THIS IS MEASURED, NOT FEARED. Drawing the last character from the full
 *      alphabet and running 200,000 codes through the real referral.normalize
 *      claimed 260 of them, one in 770: WS4FACE762 comes back as
 *      WHL-4FACE762. Drawing it from the 17 letters that cannot be read as
 *      hex claimed none in 50,000.
 *
 * 32^7 * 17 is about 5.8 x 10^11 codes.
 */
function mintShareCode() {
  let body = '';
  for (let i = 0; i < SHARE_BODY_LEN - 1; i++) body += pickFrom(SHARE_ALPHABET);
  return SHARE_PREFIX + body + pickFrom(SHARE_TAIL_ALPHABET);
}

/* Read the code for an address, or mint one.
 *
 * The EmailKey Unique in the console is what makes this safe under a double
 * submit: two simultaneous first submissions of one address cannot both
 * insert, and the loser re-reads rather than retrying, so both requests answer
 * with the SAME code. Retrying on that path is what would produce two.
 *
 * Never throws. A store that cannot answer costs the reader a share link, not
 * their place on the list, and the caller carries on with null.
 */
async function readShareCode(catalystApp, key) {
  // ZCQL has no parameter binding, so the literal is escaped by doubling the
  // quote. `key` has already been through isEmail.
  const lit = String(key).replace(/'/g, "''");
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ShareCode FROM WaitlistShareCodes WHERE EmailKey = '${lit}' LIMIT 1`);
  const found = rows && rows[0] && rows[0].WaitlistShareCodes;
  return (found && found.ShareCode) || null;
}

async function ensureShareCode(catalystApp, key) {
  try {
    const existing = await readShareCode(catalystApp, key);
    if (existing) return existing;
  } catch (err) {
    // A read that failed is not a read that said "no row". Minting now would
    // risk a second code for somebody who already has one, and the Unique on
    // EmailKey would refuse it anyway, so stop here and let them share later.
    console.error('[formSubmit] share code read failed, not minting:', err);
    return null;
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const ShareCode = mintShareCode();
    try {
      await insert(catalystApp, 'WaitlistShareCodes', {
        EmailKey: key, ShareCode, CreatedAt: catalystNow()
      });
      return ShareCode;
    } catch (err) {
      // Two Uniques can fire here and they mean opposite things, so ask the
      // store which one it was rather than reading the error text. Catalyst
      // does not word a unique violation the way a regex expects: that is the
      // lesson /waitlist-email's own duplicate path learned on 2026-09-05.
      let mine = null;
      try { mine = await readShareCode(catalystApp, key); } catch (e2) { /* fall through to retry */ }
      if (mine) return mine;   // EmailKey fired: another request minted for this same person
      console.error(`[formSubmit] share code collision or insert failure on attempt ${attempt + 1}:`, err);
    }
  }
  console.error('[formSubmit] share code could not be minted after 4 attempts');
  return null;
}

/* Who is the code for. Used by the self referral guard, and by nothing else.
 * Returns the address that owns a code, or null. */
async function ownerOfShareCode(catalystApp, code) {
  if (!SHARE_CODE_RE.test(String(code || ''))) return null;
  try {
    const lit = String(code).replace(/'/g, "''");
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT EmailKey FROM WaitlistShareCodes WHERE ShareCode = '${lit}' LIMIT 1`);
    const found = rows && rows[0] && rows[0].WaitlistShareCodes;
    return (found && found.EmailKey) || null;
  } catch (err) {
    console.error('[formSubmit] share code owner read failed:', err);
    return null;
  }
}

/* The two fields the card reads, added only when there is something to add.
 * A response with no shareCode is not an error: the card falls back to a done
 * state with no link, and the address is on the list either way. */
function shareResponse(base, code) {
  if (!code) return base;
  return { ...base, shareCode: code, shareUrl: SHARE_BASE + encodeURIComponent(code) };
}

/* The confirmation mail.
 *
 * WHY THIS CALLS THE AUTH FUNCTION INSTEAD OF SENDING. Everything that makes a
 * marketing send lawful and repeatable already lives over there and only over
 * there: the CASL category table, the suppression list, unsubscribe tokens,
 * the notify_key that stops a double submit sending twice, and a transport
 * with an SMTP fallback that works while ZeptoMail is refusing. This function's
 * only sender is notifyTeam, which is ZeptoMail only and addressed to the team
 * inbox. Rebuilding any of that here would be a second copy of the rules that
 * decide whether we are allowed to write to somebody.
 *
 * So one HTTPS call carries the ask across, and the auth route does the
 * enqueue and the drain with the real machinery. Best effort in every
 * direction: no URL configured, no secret, auth cold or unreachable, all of it
 * costs the mail and nothing else. The row is saved and the response is
 * already decided before this runs.
 */
async function sendWaitlistWelcome(key, product, shareCode) {
  const base = (process.env.AUTH_FUNCTION_URL || '').trim().replace(/\/+$/, '');
  const secret = (process.env.NOTIFY_CRON_SECRET || '').trim();
  if (!base || !secret) {
    console.log('[formSubmit] waitlist welcome not sent: AUTH_FUNCTION_URL or NOTIFY_CRON_SECRET is unset');
    return;
  }
  try {
    const res = await fetch(`${base}/internal/waitlist-welcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': secret },
      body: JSON.stringify({
        email: key,
        product,
        shareCode: shareCode || null,
        shareUrl: shareCode ? SHARE_BASE + encodeURIComponent(shareCode) : null
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`waitlist-welcome ${res.status}: ${body.slice(0, 300)}`);
    }
  } catch (err) {
    console.error('[formSubmit] waitlist welcome failed:', err);
  }
}

// The waitlist popup's one field. Table: WaitlistEmails (create-tables.md 39).
//
// WHY THIS IS NOT /waitlist-join. That route asks for a first name, a last
// name, a phone number and a postal code, and refuses the submission without
// all four, because a household joining a cohort in a place we serve needs
// every one of them. The popup asks for an address and nothing else, so it
// would 400 on four fields it never collected. Two doors, two shapes, and the
// popup's door is deliberately the smaller one.
//
// WHAT THIS ROUTE IS NOT. It is not a referral system. `Referral` is stored
// exactly as it arrived, for reporting, and no code is minted here: a referral
// code in this backend belongs to a member row, is issued by lib/referral.js
// into `referral_token`, and is spent by signup writing users.referral_code.
// An address in a popup is none of those things. The popup's done state says
// so and points at /join.
//
// EmailKey is `${email}:${product}`, the flattened composite the store needs
// because it has no composite unique, the same trick as ProductVotes.VoteKey.
// One row per address per product: somebody who holds a spot on the tire page
// and again on the internet page is two rows and one person, and somebody who
// submits the same page twice is one row and one ok.
app.post('/waitlist-email', limit({ key: 'waitlist-email', max: 20, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};
  const email = str(b.email);
  // A closed list for the same reason every other closed list here exists: it
  // becomes a reporting bucket, and a value nobody knows about is a bucket
  // nobody counts. Anything unrecognised is the umbrella.
  const product = ['home', 'tires', 'internet'].includes(str(b.product).toLowerCase())
    ? str(b.product).toLowerCase() : 'home';
  // 1 or 2: which of the popup's two asks converted. The one number that says
  // whether the second ask earns its place.
  const ctaStep = ['1', '2'].includes(str(b.ctaStep)) ? str(b.ctaStep) : '1';

  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');

  const key = emailKey(email);
  // Declared out here because the duplicate path in the catch answers with it
  // too, and a person who submits twice must see one code, never two.
  let shareCode = null;

  try {
    const catalystApp = catalyst.initialize(req);

    // MINTED BEFORE THE INSERT, and that ordering is the point. When the
    // EmailKey Unique on WaitlistEmails fires because somebody held the same
    // spot twice, the catch below re-reads the row and answers ok:true. The
    // code is already in hand by then, so that answer carries the SAME code as
    // the first submission did. Minting after the insert would have left the
    // duplicate path with nothing to say, or with a second code.
    shareCode = await ensureShareCode(catalystApp, key);

    // Referral, CtaStep, SourcePage and Host are one optional group: a store
    // that has only the mandatory columns still records the address, which is
    // the thing that must not be lost. ConsentText and ConsentAt are NOT
    // optional, because an address kept without the sentence agreed to is an
    // address we cannot lawfully mail.
    const row = await insertTolerant(catalystApp, 'WaitlistEmails', {
      EmailKey: `${key}:${product}`,
      Email: key,
      Product: product,
      CtaStep: ctaStep,
      Referral: str(b.referral).slice(0, 64) || null,
      SourcePage: str(b.sourcePage).slice(0, 120) || null,
      Host: str(req.headers.origin).replace(/^https?:\/\//, '').slice(0, 64) || null,
      ConsentText: str(b.consentText).slice(0, 4000),
      ConsentAt: catalystNow(),
      SubmittedAt: catalystNow()
    }, [['Referral', 'SourcePage', 'Host', 'CtaStep']]);

    await enqueueCrm(catalystApp, {
      source: 'WaitlistEmails', rowId: row.ROWID, email: key, leadType: 'consumer',
      data: {
        emailKey: key,
        product,
        ctaStep,
        referral: str(b.referral).slice(0, 64) || null,
        shareCode,
        ...consentFrom(b, req)
      }
    });

    // The confirmation the card promises. Best effort in both directions: it
    // never fails the request, and a reader who never gets the mail still has
    // their place and their link on screen.
    await sendWaitlistWelcome(key, product, shareCode);

    return res.status(200).json(shareResponse({ ok: true, id: row.ROWID }, shareCode));
  } catch (err) {
    // The unique on EmailKey firing is somebody holding the same spot twice,
    // which is a success from where they are sitting: they are on the list and
    // they were already on it. Answering 500 would tell them their submission
    // failed and invite a third attempt.
    //
    // WHY THIS RE-READS INSTEAD OF MATCHING THE ERROR. It matched
    // /duplicate|unique|already.?exists/ on the error text first, and a live
    // double submission on 2026-09-05 answered 500: Catalyst words it as
    // something else, and this backend has never had a reason to learn which
    // words. Asking the store whether the row is there answers the real
    // question, and it keeps answering it if Zoho ever rewrites the message.
    //
    // The read-after-write hazard that bit the notify outbox does not apply:
    // the row being looked for was written by an EARLIER request, not by this
    // one, so there is nothing to be eventually consistent about.
    try {
      const catalystApp = catalyst.initialize(req);
      // ZCQL has no parameter binding, so the literal is escaped by doubling
      // the quote. `key` came through isEmail and `product` off a closed list,
      // and this is the belt to that pair of braces.
      const lit = `${key}:${product}`.replace(/'/g, "''");
      const rows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT ROWID FROM WaitlistEmails WHERE EmailKey = '${lit}' LIMIT 1`);
      const found = rows && rows[0] && rows[0].WaitlistEmails;
      if (found) {
        return res.status(200).json(
          shareResponse({ ok: true, duplicate: true, id: found.ROWID }, shareCode));
      }
    } catch (err2) {
      console.error('[formSubmit] waitlist-email duplicate re-read failed:', err2);
    }
    // Not a duplicate, so the insert failed for a reason worth seeing. The
    // shape is logged in full because a missing column and an unreachable
    // store read identically from the popup, which only ever says that the
    // submission did not go through.
    console.error('[formSubmit] waitlist-email insert error shape:', {
      code: err && err.code, message: String((err && err.message) || err).slice(0, 300)
    });
    return serverError(res, err, 'waitlist-email');
  }
});

/* ------------------------------------------------------------------ *
 * A CLICK ON A SHARE LINK. Table: ReferralClicks (create-tables.md 40).
 * ------------------------------------------------------------------
 * The share link is https://www.whollar.ca/join?ref=CODE, which never touches
 * this backend, so the landing page reports the arrival instead. That is the
 * price of a clean link with no redirect hop in it, and it was the trade the
 * owner chose.
 *
 * WHY NOT auth's invite_click, WHICH ALREADY DOES THIS. Because its writer is
 * GET /r/:token on the auth function, and that lane is routed on internet and
 * on www but NOT on tires, whose vercel.json has no rewrite for it at all.
 * The auth function's ALLOWED_ORIGINS also has a standing production gap. This
 * function's allowlist already covers all three hosts, both .com twins and the
 * three preview aliases, so the click rides the door that already works
 * everywhere rather than the one that would have to be widened first.
 *
 * WHAT IT STORES ABOUT A PERSON: nothing. A peppered hash of address and user
 * agent, and only so that a reader refreshing the page ten times counts once.
 * That is the same standard invite_click holds itself to, and the hash is the
 * whole record: there is no column here that could later be joined to anybody.
 */
const CLICK_PEPPER = (process.env.CLICK_PEPPER || 'whollar-referral-clicks').trim();

function clickKey(code, req) {
  const day = new Date().toISOString().slice(0, 10);
  const who = crypto.createHash('sha256')
    .update(`${clientIp(req)}|${str(req.headers['user-agent'])}|${CLICK_PEPPER}`)
    .digest('hex').slice(0, 12);
  return `${code}:${day}:${who}`;
}

app.post('/ref-click', limit({ key: 'ref-click', max: 120, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};
  const code = str(b.code).toUpperCase();

  // ALWAYS ok:true, for a real code and for one somebody invented. A route
  // that answers differently for the two is a route that tells a stranger
  // which codes exist, one guess at a time.
  if (!SHARE_CODE_RE.test(code)) return res.status(200).json({ ok: true });

  try {
    const catalystApp = catalyst.initialize(req);
    await insert(catalystApp, 'ReferralClicks', {
      ClickKey: clickKey(code, req),
      ShareCode: code,
      Host: str(req.headers.origin).replace(/^https?:\/\//, '').slice(0, 64) || null,
      SourcePage: str(b.sourcePage).slice(0, 120) || null,
      ClickedAt: catalystNow()
    });
  } catch (err) {
    // The ClickKey Unique firing IS the ordinary case: the same reader, the
    // same code, the same day, a second look. Nothing to record and nothing
    // wrong. Anything else is worth a log line and still not worth an error,
    // because a counter that cannot write must not break the page it sits on.
    console.log('[formSubmit] ref-click not recorded (duplicate or store error):',
      String((err && err.message) || err).slice(0, 200));
  }
  return res.status(200).json({ ok: true });
});

module.exports = app;
