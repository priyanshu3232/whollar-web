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

const ACCEPTED_UPLOAD_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'
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
const isEmail = v => typeof v === 'string' && EMAIL_RE.test(v.trim());
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
  const phone = digits(b.phone);
  const fsa = str(b.fsa).toUpperCase();

  if (firstName.length < 2) return badRequest(res, 'firstName is required.');
  if (lastName.length < 2) return badRequest(res, 'lastName is required.');
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');
  if (phone.length < 10 || phone.length > 11) return badRequest(res, 'A valid phone number is required.');
  if (!fsa) return badRequest(res, 'fsa is required.');

  try {
    const catalystApp = catalyst.initialize(req);
    const row = await insert(catalystApp, 'WaitlistSignups', {
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      Phone: phone,
      FSA: fsa,
      ReferralCode: orNull(str(b.referral)),
      SubmittedAt: catalystNow()
    });
    await enqueueCrm(catalystApp, {
      source: 'WaitlistSignups', rowId: row.ROWID, email, leadType: 'consumer',
      data: { firstName, lastName, phone, fsa, referral: str(b.referral) }
    });
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'waitlist-join');
  }
});

// Waitlist — stage 2 (optional add-on details + optional bill attachment).
// Table: WaitlistDetails
app.post('/waitlist-details', limit({ key: 'waitlist-details', max: 20, windowSec: 3600 }), guardUpload(upload.single('billFile')), async (req, res) => {
  const b = req.body || {};
  const email = str(b.email);
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');

  let services = [];
  try { services = b.services ? JSON.parse(b.services) : []; } catch { services = []; }

  try {
    const catalystApp = catalyst.initialize(req);
    const file = await storeFile(catalystApp, req.file);
    const row = await insert(catalystApp, 'WaitlistDetails', {
      Email: email,
      FSA: orNull(str(b.fsa).toUpperCase() || null),
      Provider: orNull(str(b.provider)),
      MonthlyCost: toNumber(b.cost),
      DownloadSpeed: orNull(str(b.speed)),
      PromoEndDate: orNull(str(b.promoEnd)),
      SwitchThreshold: orNull(str(b.threshold)),
      Services: json(services),
      BillFileId: orNull(file?.id ?? null),
      BillFileName: orNull(file?.name ?? null),
      SubmittedAt: catalystNow()
    });
    await enqueueCrm(catalystApp, {
      source: 'WaitlistDetails', rowId: row.ROWID, email, leadType: 'consumer',
      data: {
        provider: str(b.provider), cost: toNumber(b.cost), speed: str(b.speed),
        promoEnd: str(b.promoEnd), threshold: str(b.threshold),
        fsa: str(b.fsa).toUpperCase(),
        services: Array.isArray(services) ? services.join(', ') : '',
        billFileName: file?.name ?? null
      }
    });
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'waitlist-details');
  }
});

// Bill checkup — every "join the waitlist" entry point on the checkup tool
// (both the quick-join rails and the main check-button flow feed this).
// Table: BillCheckupSubmissions
app.post('/bill-checkup-join', limit({ key: 'bill-checkup-join', max: 30, windowSec: 3600 }), guardUpload(upload.single('billFile')), async (req, res) => {
  const b = req.body || {};
  const email = str(b.email);
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');

  try {
    const catalystApp = catalyst.initialize(req);
    const file = await storeFile(catalystApp, req.file);
    const row = await insert(catalystApp, 'BillCheckupSubmissions', {
      Email: email,
      Via: orNull(str(b.via)) || 'form',
      PostalFSA: orNull(str(b.pc).toUpperCase() || null),
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
      BillFileName: orNull(file?.name ?? null),
      SubmittedAt: catalystNow()
    });
    await enqueueCrm(catalystApp, {
      source: 'BillCheckupSubmissions', rowId: row.ROWID, email, leadType: 'consumer',
      data: {
        via: str(b.via) || 'form', postal: str(b.pc).toUpperCase(),
        provider: str(b.prov), cost: toNumber(b.cost), speed: str(b.spd),
        tech: str(b.tech), promoEnd: str(b.pdate),
        monthsToRenewal: b.pmo != null && b.pmo !== '' ? parseInt(b.pmo, 10) : null,
        discount: toNumber(b.disc), threshold: str(b.switchFor),
        billFileName: file?.name ?? null
      }
    });
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'bill-checkup-join');
  }
});

// Bill checkup — "deep read" request (attach agreement/more bills + note).
// Table: DeepReadRequests
app.post('/deep-read', limit({ key: 'deep-read', max: 10, windowSec: 3600 }), guardUpload(upload.array('files', 5)), async (req, res) => {
  const b = req.body || {};
  const email = str(b.email);
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');
  if (!req.files || !req.files.length) return badRequest(res, 'At least one file is required.');

  try {
    const catalystApp = catalyst.initialize(req);
    const files = await storeFiles(catalystApp, req.files);
    const context = {
      pc: orNull(str(b.pc)), prov: orNull(str(b.prov)), cost: toNumber(b.cost),
      spd: orNull(str(b.spd)), tech: orNull(str(b.tech)), pdate: orNull(str(b.pdate)),
      disc: toNumber(b.disc)
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
        note: str(b.note), files: files.map(f => f.name).join(', '),
        postal: str(b.pc).toUpperCase(), provider: str(b.prov), cost: toNumber(b.cost),
        speed: str(b.spd), tech: str(b.tech), promoEnd: str(b.pdate), discount: toNumber(b.disc)
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
  const phone = digits(b.phone);

  if (!role) return badRequest(res, 'role is required.');
  if (firstName.length < 2) return badRequest(res, 'firstName is required.');
  if (lastName.length < 2) return badRequest(res, 'lastName is required.');
  if (company.length < 2) return badRequest(res, 'company is required.');
  if (!isEmail(email)) return badRequest(res, 'A valid email is required.');
  if (phone.length < 10 || phone.length > 11) return badRequest(res, 'A valid phone number is required.');

  try {
    const catalystApp = catalyst.initialize(req);
    const row = await insert(catalystApp, 'PartnerApplications', {
      Role: role,
      FirstName: firstName,
      LastName: lastName,
      Company: company,
      Email: email,
      Phone: phone,
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
        provinces: (Array.isArray(b.provinces) ? b.provinces : []).join(', '),
        techs: (Array.isArray(b.tech) ? b.tech : []).join(', '),
        note: str(b.note)
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

  try {
    const catalystApp = catalyst.initialize(req);
    const row = await insert(catalystApp, 'CalculatorEstimates', {
      PostalCode: orNull(str(b.postal).toUpperCase() || null),
      FSA: orNull(str(b.fsa).toUpperCase() || null),
      MonthlyBill: toNumber(b.monthlyBill),
      EstimatedAnnualSavings: toNumber(b.estimatedAnnualSavings),
      SubmittedAt: catalystNow()
    });
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'calculator-estimate');
  }
});

module.exports = app;
