#!/usr/bin/env node
/* Build the INTERNET_PLANS constant in js/checkup-savings.js from
 * "PlanSavvy-Pricing.xlsx" > 'Internet Plans'.
 *
 *   node scripts/build-plan-pool.mjs          # write INTERNET_PLANS
 *   node scripts/build-plan-pool.mjs --check  # CI: fail if it is stale
 *
 * Reads the sheet's header row (row 4: Province, #, Provider, Plan, Download,
 * Price / mo) and the 12 rows per province beneath it, already sorted
 * cheapest-first by the sheet itself, and serialises them into the
 * INTERNET_PLANS object between the GENERATED:PLANS markers below. Nothing
 * outside those markers is touched — HIGH_SPEED_TIERS is hand-maintained
 * reference data, not sheet data, and must never be regenerated.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const XLSX = join(ROOT, 'PlanSavvy-Pricing.xlsx');
const OUT = join(ROOT, 'js/checkup-savings.js');
const CHECK = process.argv.includes('--check');

const START = '/* GENERATED:PLANS start */';
const END = '/* GENERATED:PLANS end */';

/* ---------- minimal xlsx reader (same approach as build-benchmarks.mjs) --- */

function unzip(file, member) {
  return execFileSync('unzip', ['-p', file, member], { maxBuffer: 1 << 28 }).toString('utf8');
}
const decode = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');

function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(file, member) {
  const xml = unzip(file, member);
  const out = [];
  for (const rowM of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of rowM[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const idx = colIndex(c[1]);
      const inline = c[3].match(/<is>([\s\S]*?)<\/is>/);
      let val = '';
      if (inline) val = decode([...inline[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));
      else {
        const v = c[3].match(/<v>([\s\S]*?)<\/v>/);
        if (v) val = decode(v[1]);
      }
      cells[idx] = val;
    }
    out.push(cells);
  }
  return out;
}

/* Find the sheet part for a sheet name, via workbook.xml + its rels — the
   sheetN.xml files are not guaranteed to match tab order. */
function sheetPartFor(file, name) {
  const wb = unzip(file, 'xl/workbook.xml');
  const m = [...wb.matchAll(/<sheet name="([^"]*)"[^>]*r:id="(rId\d+)"/g)].find(x => x[1] === name);
  if (!m) throw new Error(`no sheet named "${name}" in ${file}`);
  const rels = unzip(file, 'xl/_rels/workbook.xml.rels');
  const relM = [...rels.matchAll(/<Relationship\b[^>]*>/g)]
    .map(tag => ({ id: tag[0].match(/Id="([^"]*)"/)?.[1], target: tag[0].match(/Target="([^"]*)"/)?.[1] }))
    .find(x => x.id === m[2]);
  if (!relM) throw new Error(`no relationship for ${m[2]}`);
  return relM.target.replace(/^\//, '');
}

/* ---------- parse the sheet ---------- */

const part = sheetPartFor(XLSX, 'Internet Plans');
const rows = sheetRows(XLSX, part);

const headerRow = rows.find(r => r[0] === 'Province' && r[2] === 'Provider');
if (!headerRow) throw new Error('"Internet Plans" sheet is missing its header row (Province, #, Provider, Plan, Download, Price / mo)');
const col = Object.fromEntries(headerRow.map((h, i) => [h, i]));
for (const need of ['Province', 'Provider', 'Plan', 'Download', 'Price / mo']) {
  if (col[need] === undefined) throw new Error(`"Internet Plans" sheet is missing column "${need}"`);
}

function parseMbps(s) {
  const m = String(s || '').trim().match(/^([\d.]+)\s*(Mbps|Gbps)$/i);
  if (!m) throw new Error(`unparseable Download value "${s}"`);
  const n = parseFloat(m[1]);
  return /gbps/i.test(m[2]) ? n * 1000 : n;
}

const headerIdx = rows.indexOf(headerRow);
const provinces = new Map(); // province -> plan[], first-seen order preserved
for (const r of rows.slice(headerIdx + 1)) {
  const province = (r[col['Province']] || '').trim();
  if (!province) continue;
  const plan = {
    provider: (r[col['Provider']] || '').trim(),
    plan: (r[col['Plan']] || '').trim(),
    mbps: parseMbps(r[col['Download']]),
    price: parseFloat(r[col['Price / mo']])
  };
  if (!plan.provider || !plan.plan || !Number.isFinite(plan.price)) {
    throw new Error(`incomplete row for ${province}: ${JSON.stringify(r)}`);
  }
  if (!provinces.has(province)) provinces.set(province, []);
  provinces.get(province).push(plan);
}

for (const [province, plans] of provinces) {
  if (plans.length !== 12) {
    throw new Error(`${province} has ${plans.length} plans, expected exactly 12 — sheet is inconsistent`);
  }
}

/* ---------- serialize, matching the file's existing hand-written style --- */

const quote = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const fmtPrice = p => (p % 1 === 0 ? p.toFixed(1) : String(p));

function serialize() {
  const lines = ['var INTERNET_PLANS = {'];
  const entries = [...provinces.entries()];
  entries.forEach(([province, plans], pi) => {
    lines.push(`  ${quote(province)}: [`);
    plans.forEach((p, i) => {
      const comma = i < plans.length - 1 ? ',' : '';
      lines.push(`    { provider: ${quote(p.provider)}, plan: ${quote(p.plan)}, mbps: ${p.mbps}, price: ${fmtPrice(p.price)} }${comma}`);
    });
    lines.push(`  ]${pi < entries.length - 1 ? ',' : ''}`);
  });
  lines.push('};');
  return lines.join('\n');
}

const body = `${START}\n${serialize()}\n${END}`;

/* ---------- splice into js/checkup-savings.js ---------- */

const src = readFileSync(OUT, 'utf8');
const startIdx = src.indexOf(START);
const endIdx = src.indexOf(END);
if (startIdx === -1 || endIdx === -1) {
  throw new Error(`${OUT.replace(ROOT + '/', '')} is missing the ${START} / ${END} markers`);
}
const next = src.slice(0, startIdx) + body + src.slice(endIdx + END.length);

if (CHECK) {
  if (src === next) { console.log(`ok      ${OUT.replace(ROOT + '/', '')}`); process.exit(0); }

  /* Diff per-province, per-row, so drift reads as "what changed" rather than
     a wall of regenerated JS. */
  const prevBlock = src.slice(startIdx, endIdx + END.length);
  console.error(`STALE   ${OUT.replace(ROOT + '/', '')} — regenerate with: node scripts/build-plan-pool.mjs\n`);
  for (const [province, plans] of provinces) {
    const sheetLine = plans.map(p => `${p.provider} ${p.plan} @ $${fmtPrice(p.price)}`).join(' | ');
    const re = new RegExp(`${quote(province).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: \\[([\\s\\S]*?)\\]`);
    const m = prevBlock.match(re);
    const currentLine = m
      ? [...m[1].matchAll(/provider: '([^']*)', plan: '([^']*)', mbps: \d+(?:\.\d+)?, price: ([\d.]+)/g)]
        .map(x => `${x[1]} ${x[2]} @ $${x[3]}`).join(' | ')
      : '(missing)';
    if (sheetLine !== currentLine) {
      console.error(`${province}:`);
      console.error(`  constant: ${currentLine}`);
      console.error(`  sheet:    ${sheetLine}`);
    }
  }
  process.exit(1);
}

writeFileSync(OUT, next);
console.log(`written ${OUT.replace(ROOT + '/', '')}`);
console.log(`  ${provinces.size} provinces, ${[...provinces.values()].reduce((a, p) => a + p.length, 0)} plans`);
