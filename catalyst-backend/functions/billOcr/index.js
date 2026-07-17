'use strict';

const catalyst = require('zcatalyst-sdk-node');
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

const BILL_EXTRACTION_TOOL = {
  name: 'extract_bill_fields',
  description:
    "Extract structured fields from OCR'd text of a Canadian home-internet bill. " +
    'Only fill a field when the source text clearly supports it — return null rather than guessing.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      provider: {
        type: ['string', 'null'],
        enum: [
          null, 'Rogers', 'Bell', 'Telus', 'Shaw', 'Vidéotron', 'Cogeco', 'Eastlink', 'SaskTel',
          'An independent (oxio, TekSavvy…)', 'Other / not sure'
        ],
        description: 'Current ISP, matched exactly to one of the enum values.'
      },
      monthlyChargeDollars: {
        type: ['number', 'null'],
        description: 'Total monthly charge before tax, in dollars (e.g. 89.99).'
      },
      downloadSpeedMbps: {
        type: ['string', 'null'],
        enum: [null, '25', '50', '100', '150', '300', '500', '1000', '1500', '0'],
        description:
          "Download speed tier next to the plan name. '1000' = 1 Gig, '1500' = 1.5 Gig or faster, " +
          "'0' = plan explicitly says 'not sure' or unspecified tier. Null if no speed appears anywhere."
      },
      accessTechnology: {
        type: ['string', 'null'],
        enum: [
          null, 'Cable (TV coax jack)', 'Fibre (thin glass line)', 'DSL (old phone line)',
          'Fixed wireless (5G antenna)', 'Satellite (dish)', 'Not sure'
        ],
        description: 'How the connection reaches the house.'
      },
      promoEndDate: {
        type: ['string', 'null'],
        description:
          "ISO 8601 date (YYYY-MM-DD) the promo/discount ends, from a line like 'Savings ... ends " +
          "May 21/26'. Null if there is no promo or no end date shown."
      },
      discountAmountDollars: {
        type: ['number', 'null'],
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

async function extractBillFields(ocrText) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    system:
      'You extract structured billing fields from OCR text of Canadian home-internet bills. ' +
      'If a field is ambiguous, missing, or you are not confident, return null for that field ' +
      'rather than guessing — a wrong auto-filled value is worse than an empty form field.',
    tools: [BILL_EXTRACTION_TOOL],
    tool_choice: { type: 'tool', name: 'extract_bill_fields' },
    messages: [
      { role: 'user', content: `OCR text extracted from a household's internet bill:\n\n${ocrText}` }
    ]
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Extraction declined by model safety classifiers.');
  }

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  return toolUse.input; // strict:true guarantees this already matches the schema exactly
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// Drives the "Shortcut: attach your bill" upload (#bill-file) on the bill
// checkup tool — OCRs the file via Catalyst Zia, then extracts fields the
// frontend drops straight into #prov/#cost/#spd/#tech/#pdate/#disc.
// Frontend must POST multipart/form-data with the file under "billFile".
app.post('/extract-bill', upload.single('billFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No file uploaded under field "billFile".' });
  }

  const catalystApp = catalyst.initialize(req);
  const zia = catalystApp.zia();

  try {
    const ocr = await zia.extractOpticalCharacters(
      fs.createReadStream(req.file.path),
      { language: 'eng', modelType: 'OCR' }
    );
    const fields = await extractBillFields(ocr.text);
    res.status(200).json({ ok: true, confidence: ocr.confidence, fields });
  } catch (err) {
    console.error('[billOcr] /extract-bill failed:', err);
    res.status(502).json({ ok: false, error: 'Bill extraction failed.' });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

module.exports = app;
