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
  'https://whollar.ca',
  'https://www.whollar.ca'
];

// Local development: the marketing pages are plain HTML files, opened either
// via a dev server on an arbitrary port (Live Server, http.server, …) or
// straight from disk (Origin: null). CORS is a browser-side gate only — the
// endpoint is reachable by curl regardless — so allowing these loses nothing.
const isDevOrigin = (origin) =>
  origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

// Vercel: the site's production domain and every preview deploy live under
// *.vercel.app. Allowing the whole suffix keeps preview URLs working without
// editing this list per deploy; the custom domains above stay canonical.
const isVercelOrigin = (origin) =>
  /^https:\/\/[a-z0-9][a-z0-9.-]*\.vercel\.app$/.test(origin);

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
  if (origin && (ALLOWED_ORIGINS.includes(origin) || isDevOrigin(origin) || isVercelOrigin(origin))) {
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

// Disk storage (not memory): the Catalyst SDK's uploadFile() appends the
// stream to form-data with no options, so it relies on the stream's `.path`
// to derive the filename — which only an fs.ReadStream has, not a Buffer.
const upload = multer({
  dest: '/tmp/whollar-uploads/',
  limits: { fileSize: 20 * 1024 * 1024, files: 5 }
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

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// Waitlist — stage 1 (name/email/phone/postal code/referral).
// Table: WaitlistSignups
app.post('/waitlist-join', async (req, res) => {
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
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'waitlist-join');
  }
});

// Waitlist — stage 2 (optional add-on details + optional bill attachment).
// Table: WaitlistDetails
app.post('/waitlist-details', upload.single('billFile'), async (req, res) => {
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
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'waitlist-details');
  }
});

// Bill checkup — every "join the waitlist" entry point on the checkup tool
// (both the quick-join rails and the main check-button flow feed this).
// Table: BillCheckupSubmissions
app.post('/bill-checkup-join', upload.single('billFile'), async (req, res) => {
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
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'bill-checkup-join');
  }
});

// Bill checkup — "deep read" request (attach agreement/more bills + note).
// Table: DeepReadRequests
app.post('/deep-read', upload.array('files', 5), async (req, res) => {
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
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'deep-read');
  }
});

// Provider / partner application form.
// Table: PartnerApplications
app.post('/partner-application', async (req, res) => {
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
    res.status(200).json({ ok: true, id: row.ROWID });
  } catch (err) {
    serverError(res, err, 'partner-application');
  }
});

module.exports = app;
