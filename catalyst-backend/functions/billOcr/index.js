'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const catalyst = require('zcatalyst-sdk-node');

const app = express();
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from this function's env vars

/* ------------------------------------------------------------------ *
 * CONFIG — keep in sync with functions/formSubmit/index.js
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Abuse controls — distributed rate limiting via Catalyst Cache.
 * Advanced I/O functions are horizontally scaled with no shared process
 * memory, so an in-process counter is useless; the Cache default segment
 * is shared across every instance. Fixed-window counters keyed by route
 * (+ client IP for per-IP limits). Fails OPEN if the cache is unreachable
 * — a broken limiter must not take the endpoint down. Because a cache
 * outage lets requests through, set an account-level spend cap in the
 * Anthropic console as the hard backstop for this paid endpoint.
 * ------------------------------------------------------------------ */

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress || 'unknown';

async function withinLimit(req, { key, max, windowSec, perIp = true }) {
  try {
    const app = catalyst.initialize(req);
    const seg = app.cache().segment(); // default segment — no console setup needed
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

// Express middleware: reject over-limit requests with 429 *before* the body is
// parsed, so an abusive upload never touches disk or the paid API.
const limit = (opts) => async (req, res, next) => {
  if (await withinLimit(req, opts)) return next();
  res.setHeader('Retry-After', String(opts.windowSec));
  res.status(429).json({ ok: false, error: 'Too many requests. Please slow down and try again shortly.' });
};

const ACCEPTED_UPLOAD_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'
]);

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

// The bill is read fully into memory and base64-encoded for the Claude call,
// so bound size (15 MB) and count (1) and reject non-PDF/image types before
// anything touches disk.
const MAX_BILL_BYTES = 15 * 1024 * 1024;
const upload = multer({
  dest: '/tmp/whollar-bill-ocr/',
  limits: { fileSize: MAX_BILL_BYTES, files: 1 },
  fileFilter: rejectUnsupported
});

/* ------------------------------------------------------------------ *
 * Structured extraction — enums here must stay byte-identical to the
 * <select> options in whollar-bill checkup-v6.html (#prov, #spd, #tech)
 * so the frontend can set .value directly with no translation step.
 * ------------------------------------------------------------------ */

// Nullable fields use anyOf rather than a ["string","null"] type array: strict
// schema validation rejects a null member inside an enum whose type is a type
// array ("Enum value None does not match declared type"). anyOf is the
// supported construct for "one of these values, or null".
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

const BILL_EXTRACTION_TOOL = {
  name: 'extract_bill_fields',
  description:
    'Extract structured fields from an image or PDF of a Canadian home-internet bill. ' +
    'Only fill a field when the bill clearly supports it — return null rather than guessing.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      provider: {
        ...nullable({
          type: 'string',
          enum: [
            'Rogers', 'Bell', 'Telus', 'Shaw', 'Vidéotron', 'Cogeco', 'Eastlink', 'SaskTel',
            'An independent (oxio, TekSavvy…)', 'Other / not sure'
          ]
        }),
        description: 'Current ISP, matched exactly to one of the enum values.'
      },
      monthlyChargeDollars: {
        ...nullable({ type: 'number' }),
        description: 'Total monthly charge before tax, in dollars (e.g. 89.99).'
      },
      downloadSpeedMbps: {
        ...nullable({
          type: 'string',
          enum: ['25', '50', '100', '150', '300', '500', '1000', '1500', '0']
        }),
        description:
          "Download speed tier next to the plan name. '1000' = 1 Gig, '1500' = 1.5 Gig or faster, " +
          "'0' = plan explicitly says 'not sure' or unspecified tier. Null if no speed appears anywhere."
      },
      accessTechnology: {
        ...nullable({
          type: 'string',
          enum: [
            'Cable (TV coax jack)', 'Fibre (thin glass line)', 'DSL (old phone line)',
            'Fixed wireless (5G antenna)', 'Satellite (dish)', 'Not sure'
          ]
        }),
        description: 'How the connection reaches the house.'
      },
      promoEndDate: {
        ...nullable({ type: 'string' }),
        description:
          "ISO 8601 date (YYYY-MM-DD) the time-limited promotional discount ends, from a line " +
          "like 'Savings ... ends May 21/26'. Null if there is no promo or no end date shown. " +
          "Bundle, autopay and loyalty discounts are not promos — never infer an end date from them."
      },
      discountAmountDollars: {
        ...nullable({ type: 'number' }),
        // Feeds the "jump" math on the frontend (regular price = charge + this),
        // so it must only ever hold credits that disappear when a promo ends.
        description:
          'Monthly PROMOTIONAL discount in dollars — only time-limited promo/savings credits ' +
          'that expire, e.g. a "Savings", "Promotional credit" or "12-month discount" line. ' +
          'Sum them if there are several. EXCLUDE discounts not tied to a promo period: ' +
          'bundle / multi-service discounts, autopay or pre-authorized payment discounts, ' +
          'loyalty, employee or accessibility discounts, and one-time credits or adjustments. ' +
          'Null if the only discounts on the bill are of the excluded kinds.'
      },
      postalCode: {
        ...nullable({ type: 'string' }),
        description:
          'Canadian postal code of the service/billing address on the bill, formatted "A1A 1A1". ' +
          'Null if not confidently found.'
      }
    },
    required: [
      'provider', 'monthlyChargeDollars', 'downloadSpeedMbps',
      'accessTechnology', 'promoEndDate', 'discountAmountDollars', 'postalCode'
    ],
    additionalProperties: false
  }
};

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Builds the content block for the uploaded bill. Claude reads the bill
// directly — images via a vision block, PDFs via a document block — so there
// is no separate OCR step and no text lost to OCR before extraction.
async function billContentBlock(file) {
  const data = (await fs.promises.readFile(file.path)).toString('base64');
  const mime = (file.mimetype || '').toLowerCase();

  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  if (IMAGE_TYPES.has(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  }
  throw new Error(`Unsupported file type "${file.mimetype}". Upload a PDF or an image.`);
}

async function extractBillFields(file) {
  const billBlock = await billContentBlock(file);
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    // Sonnet 5 runs adaptive thinking when `thinking` is omitted, and max_tokens
    // caps thinking + output together — 1024 risked truncating the tool call.
    // Set both explicitly so behaviour doesn't ride on model defaults.
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system:
      'You extract structured billing fields from Canadian home-internet bills. ' +
      'If a field is ambiguous, missing, or you are not confident, return null for that field ' +
      'rather than guessing — a wrong auto-filled value is worse than an empty form field. ' +
      'Treat discounts carefully: only time-limited promotional credits count as the discount ' +
      'and promo end date. Bundle/multi-service, autopay, loyalty and one-time credits are ' +
      'permanent or unrelated to a promo period — leave them out of both fields entirely.',
    tools: [BILL_EXTRACTION_TOOL],
    tool_choice: { type: 'tool', name: 'extract_bill_fields' },
    messages: [
      {
        role: 'user',
        content: [
          billBlock,
          { type: 'text', text: "This is a household's internet bill. Extract the fields." }
        ]
      }
    ]
  }, { timeout: 45000, maxRetries: 1 });

  if (response.stop_reason === 'refusal') {
    throw new Error('Extraction declined by model safety classifiers.');
  }

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse) throw new Error('Model returned no extraction.');
  return toolUse.input; // strict:true guarantees this already matches the schema exactly
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// Drives the "Shortcut: attach your bill" upload (#bill-file) on the bill
// checkup tool — Claude reads the bill directly (vision for images, native PDF
// support for PDFs) and returns fields the frontend drops straight into
// #prov/#cost/#spd/#tech/#pdate/#disc, plus postalCode (the bill's
// service/billing address postal code, "A1A 1A1", null if not found).
// Frontend must POST multipart/form-data with the file under "billFile".
app.post(
  '/extract-bill',
  limit({ key: 'ocr-ip', max: 15, windowSec: 3600, perIp: true }),        // 15 / hour / IP — every attempt counts (even 4xx rejects), so leave room for retries
  limit({ key: 'ocr-global', max: 800, windowSec: 86400, perIp: false }), // 800 / day total — denial-of-wallet ceiling
  guardUpload(upload.single('billFile')),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded under field "billFile".' });
    }

    try {
      const fields = await extractBillFields(req.file);
      res.status(200).json({ ok: true, fields });
    } catch (err) {
      console.error('[billOcr] /extract-bill failed:', err);
      res.status(502).json({ ok: false, error: 'Bill extraction failed.' });
    } finally {
      fs.unlink(req.file.path, () => {});
    }
  }
);

module.exports = app;
