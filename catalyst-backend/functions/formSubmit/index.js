'use strict';

const catalyst = require('zcatalyst-sdk-node');
const express = require('express');
const multer = require('multer');
const fs = require('fs');

const app = express();

/* ------------------------------------------------------------------ *
 * CONFIG — edit these two after your first deploy, then redeploy.
 * ------------------------------------------------------------------ */

// Domains allowed to call this function from a browser. Add every host
// the site is actually served from (apex + www + local dev if needed).
const ALLOWED_ORIGINS = [
  'https://whollar.com',
  'https://www.whollar.com',
  'https://whollar.ca',
  'https://www.whollar.ca'
];

// Local development: the marketing pages are plain HTML files, opened either
// via a dev server on an arbitrary port (Live Server, http.server, …) or
// straight from disk (Origin: null). CORS is a browser-side gate only — the
// endpoint is reachable by curl regardless — so allowing these loses nothing.
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
// reflects them. Detection is automatic from the request host — the prod domain
// is *.catalystserverless.ca without the `.development.` segment — with an
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
  if (origin && (ALLOWED_ORIGINS.includes(origin) || (allowDev && isDevOrigin(origin)) || isVercelOrigin(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Also parse text/plain as JSON: the Catalyst gateway answers CORS preflight
// (OPTIONS) itself with no CORS headers, so browser requests must stay
// preflight-free — the frontend posts JSON with a text/plain content type
// (CORS-safelisted) instead of application/json.
app.use(express.json({ limit: '1mb', type: ['application/json', 'text/plain'] }));

/* ------------------------------------------------------------------ *
 * Abuse controls — distributed rate limiting via Catalyst Cache.
 * Advanced I/O functions are horizontally scaled with no shared process
 * memory, so an in-process counter is useless; the Cache default segment
 * is shared across every instance. Fixed-window counters keyed by route
 * (+ client IP). Fails OPEN if the cache is unreachable — a broken limiter
 * must not take the forms down.
 * ------------------------------------------------------------------ */

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress || 'unknown';

async function withinLimit(req, { key, max, windowSec, perIp = true }) {
  try {
    const catalystApp = catalyst.initialize(req);
    const seg = catalystApp.cache().segment(); // default segment — no console setup needed
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
// list is shorter), but there is no reason to refuse to STORE it — a person
// can open it later. Accept it here; the frontend skips the OCR call for it.
const ACCEPTED_UPLOAD_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'
]);

// Reject anything that isn't a bill (PDF/image) server-side — the frontend's
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
// the submission — swallow the multer error, note why, and save the row bare.
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
// its own storeFile/finally cleanup (validation 400s) — /tmp on a warm
// instance must not accumulate orphans.
const discardUpload = (req) => {
  [req.file, ...(req.files || [])].filter(Boolean).forEach(f => fs.unlink(f.path, () => {}));
};

// Disk storage (not memory): the Catalyst SDK's uploadFile() appends the
// stream to form-data with no options, so it relies on the stream's `.path`
// to derive the filename — which only an fs.ReadStream has, not a Buffer.
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

/* ------------------------------------------------------------------ *
 * Canonical formats
 * ------------------------------------------------------------------
 * One concept, one shape. Before this, a postal code reached the CRM in four
 * different forms depending on the route — "M5V 3A8" from the calculator, the
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

/* CASL: consent must be provable — what was agreed, when, and where. The
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

async function insert(catalystApp, tableName, row) {
  const table = catalystApp.datastore().table(tableName);
  return table.insertRow(row);
}

// Queue a submission for the CRM sync worker (the crmSync cron function reads
// CrmSyncQueue and pushes rows into Zoho CRM). Best-effort by design: it must
// NEVER throw into the request path — the submission is already saved, so a
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

// Waitlist — stage 1 (name/email/phone/postal code/referral).
// Table: WaitlistSignups
app.post('/waitlist-join', limit({ key: 'waitlist-join', max: 20, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};
  const firstName = str(b.firstName);
  const lastName = str(b.lastName);
  const email = str(b.email);
  const phone = normalizePhone(b.phone);
  const postal = normalizePostal(b.fsa || b.postalFull);

  if (firstName.length < 2) return badRequest(res, 'firstName is required.');
  if (lastName.length < 2) return badRequest(res, 'lastName is required.');
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');
  if (!phone) return badRequest(res, 'A valid 10-digit Canadian phone number is required.');
  // Was `if (!fsa)` — any non-empty string passed, so "ZZZ" was accepted.
  if (!postal.fsa) return badRequest(res, 'A valid Canadian postal code is required.');

  try {
    const catalystApp = catalyst.initialize(req);
    const row = await insert(catalystApp, 'WaitlistSignups', {
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      // Digits only: the Phone column predates E.164 normalisation, so keep the
      // stored shape stable and send the canonical form to the CRM.
      Phone: digits(b.phone),
      FSA: postal.fsa,
      ReferralCode: orNull(str(b.referral)),
      SubmittedAt: catalystNow()
    });
    await enqueueCrm(catalystApp, {
      source: 'WaitlistSignups', rowId: row.ROWID, email, leadType: 'consumer',
      data: {
        firstName, lastName, phone,
        emailKey: emailKey(email),
        fsa: postal.fsa, postal: postal.full,
        province: str(b.province) || null, provinceCode: str(b.provinceCode) || null,
        referral: str(b.referral),
        ...consentFrom(b, req)
      }
    });
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'waitlist-join');
  }
});

// Waitlist — stage 2 (optional add-on details + optional bill attachment).
// Table: WaitlistDetails
app.post('/waitlist-details', limit({ key: 'waitlist-details', max: 20, windowSec: 3600 }), tolerantUpload(upload.single('billFile')), async (req, res) => {
  const b = req.body || {};
  const email = str(b.email);
  if (!isEmail(email)) { discardUpload(req); return badRequest(res, 'A valid email is required.'); }

  let services = [];
  try { services = b.services ? JSON.parse(b.services) : []; } catch { services = []; }

  try {
    const catalystApp = catalyst.initialize(req);
    const file = await storeFile(catalystApp, req.file);
    const postal = normalizePostal(b.fsa || b.postalFull);
    const row = await insert(catalystApp, 'WaitlistDetails', {
      Email: email,
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
        fsa: postal.fsa, postal: postal.full,
        province: str(b.province) || null, provinceCode: str(b.provinceCode) || null,
        services: Array.isArray(services) ? services.join(', ') : '',
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

// Bill checkup — every "join the waitlist" entry point on the checkup tool
// (both the quick-join rails and the main check-button flow feed this).
// Table: BillCheckupSubmissions
app.post('/bill-checkup-join', limit({ key: 'bill-checkup-join', max: 30, windowSec: 3600 }), tolerantUpload(upload.single('billFile')), async (req, res) => {
  const b = req.body || {};
  const email = str(b.email);
  if (!isEmail(email)) { discardUpload(req); return badRequest(res, 'A valid email is required.'); }

  try {
    const catalystApp = catalyst.initialize(req);
    const file = await storeFile(catalystApp, req.file);
    const postal = normalizePostal(b.pc || b.postalFull);
    const row = await insert(catalystApp, 'BillCheckupSubmissions', {
      Email: email,
      Via: orNull(str(b.via)) || 'form',
      PostalFSA: postal.fsa,
      Provider: orNull(str(b.prov)),
      MonthlyCost: toNumber(b.cost),
      DownloadSpeed: orNull(str(b.spd)),
      AccessTech: orNull(str(b.tech)),
      PromoEndDate: orNull(str(b.pdate)),
      MonthsToRenewal: b.pmo != null && b.pmo !== '' ? parseInt(b.pmo, 10) : null,
      PromoExpired: str(b.expired) === 'true',
      DiscountAmount: toNumber(b.disc),
      SwitchThreshold: orNull(str(b.switchFor)),
      BillFileId: orNull(file?.id ?? null),
      BillFileName: orNull(file?.name ?? (req.fileRejected ? `[rejected: ${req.fileRejected}]` : null)),
      SubmittedAt: catalystNow()
    });
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
        discount: toNumber(b.disc), threshold: str(b.switchFor),
        // What the visitor was actually shown. Without these, sales sees the
        // gross charge and has no idea which of the four verdicts appeared on
        // screen — the number the conversation has to start from.
        effectiveCost: toNumber(b.effectiveCost),
        verdict: str(b.verdict) || null,
        verdictReason: str(b.verdictReason) || null,
        benchmarkScope: str(b.benchmarkScope) || null,
        benchmarkPrice: toNumber(b.benchmarkPrice),
        billFileName: file?.name ?? (req.fileRejected ? `[rejected: ${req.fileRejected}]` : null),
        ...consentFrom(b, req)
      }
    });
    res.status(200).json({ ok: true, id: row.ROWID, fileRejected: req.fileRejected || null });
  } catch (err) {
    serverError(res, err, 'bill-checkup-join');
  }
});

// Bill checkup — "deep read" request (attach agreement/more bills + note).
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
    // browser sent while the CRM payload below uppercased the same value —
    // two spellings of one field, written by one handler.
    const postal = normalizePostal(b.pc || b.postalFull);
    const context = {
      fsa: postal.fsa, postal: postal.full,
      province: orNull(str(b.province)), provinceCode: orNull(str(b.provinceCode)),
      prov: orNull(str(b.prov)), cost: toNumber(b.cost),
      spd: orNull(str(b.spd)), tech: orNull(str(b.tech)), pdate: orNull(str(b.pdate)),
      disc: toNumber(b.disc), effectiveCost: toNumber(b.effectiveCost),
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
        speed: str(b.spd), tech: str(b.tech), promoEnd: str(b.pdate), discount: toNumber(b.disc),
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

// Savings calculator — anonymous estimate snapshot (postal code + monthly
// bill → projected annual savings shown to the visitor).
// Table: CalculatorEstimates
app.post('/calculator-estimate', limit({ key: 'calculator-estimate', max: 40, windowSec: 3600 }), async (req, res) => {
  const b = req.body || {};

  // This was the one route with no input validation at all — it accepted any
  // body, so a junk postal code or an arbitrary "savings" number went straight
  // into the table. The per-IP rate limit was the only gate.
  const postal = normalizePostal(b.postal || b.fsa);
  if (!postal.fsa) return badRequest(res, 'A valid Canadian postal code is required.');

  const monthlyBill = toNumber(b.monthlyBill);
  if (monthlyBill == null || monthlyBill < 15 || monthlyBill > 500) {
    return badRequest(res, 'monthlyBill must be between 15 and 500.');
  }
  const savings = toNumber(b.estimatedAnnualSavings);
  // Bounded by what the widget can actually produce: 12 × 500 × 21% ≈ 1260.
  if (savings == null || savings < 0 || savings > 2000) {
    return badRequest(res, 'estimatedAnnualSavings is out of range.');
  }

  try {
    const catalystApp = catalyst.initialize(req);
    const row = await insert(catalystApp, 'CalculatorEstimates', {
      // "A1A 1A1" when the full code is present, otherwise null — never a
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

module.exports = app;
