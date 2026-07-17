'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from this function's env vars

/* ------------------------------------------------------------------ *
 * CONFIG — keep in sync with functions/formSubmit/index.js
 * ------------------------------------------------------------------ */

const ALLOWED_ORIGINS = [
  'https://whollar.ca',
  'https://www.whollar.ca',
  'http://localhost:3000'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const upload = multer({ dest: '/tmp/whollar-bill-ocr/' });

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
          "ISO 8601 date (YYYY-MM-DD) the promo/discount ends, from a line like 'Savings ... ends " +
          "May 21/26'. Null if there is no promo or no end date shown."
      },
      discountAmountDollars: {
        ...nullable({ type: 'number' }),
        description: 'Monthly discount amount in dollars, if shown as its own line item.'
      }
    },
    required: [
      'provider', 'monthlyChargeDollars', 'downloadSpeedMbps',
      'accessTechnology', 'promoEndDate', 'discountAmountDollars'
    ],
    additionalProperties: false
  }
};

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Builds the content block for the uploaded bill. Claude reads the bill
// directly — images via a vision block, PDFs via a document block — so there
// is no separate OCR step and no text lost to OCR before extraction.
function billContentBlock(file) {
  const data = fs.readFileSync(file.path).toString('base64');
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
      'rather than guessing — a wrong auto-filled value is worse than an empty form field.',
    tools: [BILL_EXTRACTION_TOOL],
    tool_choice: { type: 'tool', name: 'extract_bill_fields' },
    messages: [
      {
        role: 'user',
        content: [
          billContentBlock(file),
          { type: 'text', text: "This is a household's internet bill. Extract the fields." }
        ]
      }
    ]
  });

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
// #prov/#cost/#spd/#tech/#pdate/#disc.
// Frontend must POST multipart/form-data with the file under "billFile".
app.post('/extract-bill', upload.single('billFile'), async (req, res) => {
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
});

module.exports = app;
