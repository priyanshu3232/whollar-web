#!/usr/bin/env node
/* The partner console build: ES module source in, one classic script out.
 *
 *   node scripts/build-console.mjs           write partner/console.build.js
 *   node scripts/build-console.mjs --check    fail if it is stale (CI)
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT ESBUILD.
 *
 * CLAUDE.md carries two standing rules this touches: no build step, and no ESM
 * in any browser-loaded file. Both are now scoped to exclude partner/, and the
 * scoping only holds if the exception is small enough to read. So:
 *
 *   - No dependency. .github/workflows/check-frontend.yml has no `npm ci` step
 *     and every gate in it runs plain `node`. Adding esbuild or rollup would
 *     put an install on the critical path of every check in the repo, to save
 *     writing the 120 lines below.
 *   - The OUTPUT is a classic script. Nothing a browser loads contains an
 *     `import`, so the second standing rule survives intact rather than being
 *     traded away. partner/ source is authored as modules and never served.
 *   - --check, like every other generator here (build-footer, build-mobile-
 *     pages, build-benchmarks, build-signal-lookup). A generated file that is
 *     not checked is a generated file that silently goes stale.
 *
 * THE MODULE SUBSET. This is a linker, not a compiler, and it accepts a narrow
 * dialect on purpose: anything it cannot parse is a build error naming the
 * file and line, never a silent mistranslation. Supported:
 *
 *   import { a, b as c } from './rel.js';     one line, named only
 *   export function f() {}
 *   export const|let|var NAME = ...
 *   export { a, b };
 *
 * Rejected, loudly: default exports, namespace imports, dynamic import, side
 * effect imports, and multi-line import lists.
 *
 * TWO SEMANTIC DIFFERENCES from real ESM, both deliberate and both guarded:
 *
 *   1. Imported bindings are copies, not live views. Every module here exports
 *      functions and frozen constants, for which a copy is identical. A module
 *      that exported a reassigned `let` would behave differently, so the build
 *      refuses to export a `let` at all.
 *   2. Circular imports are refused rather than half-initialised. ESM would
 *      hand back a partly-filled namespace; that is a debugging cost nobody
 *      here should pay, and a cycle in a console this size is a design error.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'partner');
const ENTRY = 'app.js';
const OUT = join(SRC, 'console.build.js');
const PAGE = join(SRC, 'index.html');

const check = process.argv.includes('--check');
const problems = [];

/* ------------------------------------------------------------------ *
 * parse one module
 * ------------------------------------------------------------------ */

const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/;
const BAD_IMPORT_RE = /^\s*import\b/;
const EXPORT_DECL_RE = /^(\s*)export\s+(function|const|let|var|class)\s+/;
const EXPORT_LIST_RE = /^\s*export\s*\{([^}]*)\}\s*;?\s*$/;

/** Resolve './core/api.js' from 'views/desk.js' to 'core/api.js'. */
function resolveId(fromId, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = resolvePath(dirname(join(SRC, fromId)), spec);
  return relative(SRC, abs).split('\\').join('/');
}

function parseModule(id) {
  const file = join(SRC, id);
  if (!existsSync(file)) {
    problems.push(`${id}: imported but does not exist`);
    return null;
  }
  const lines = readFileSync(file, 'utf8').split('\n');
  const deps = [];
  const exports = [];
  const body = [];
  let nsCount = 0;

  lines.forEach((line, i) => {
    const where = `${id}:${i + 1}`;

    const imp = line.match(IMPORT_RE);
    if (imp) {
      const dep = resolveId(id, imp[2]);
      if (!dep) { problems.push(`${where}: only relative imports are supported, got "${imp[2]}"`); return; }
      deps.push(dep);
      const ns = `__ns${nsCount++}`;
      const names = imp[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const m = s.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
        if (!m) { problems.push(`${where}: cannot parse import specifier "${s}"`); return null; }
        return `${m[2] || m[1]} = ${ns}.${m[1]}`;
      }).filter(Boolean);
      body.push(`  var ${ns} = __require(${JSON.stringify(dep)});`);
      if (names.length) body.push(`  var ${names.join(', ')};`);
      return;
    }

    if (BAD_IMPORT_RE.test(line)) {
      problems.push(`${where}: unsupported import form. Named single-line imports only: ${line.trim()}`);
      return;
    }

    const list = line.match(EXPORT_LIST_RE);
    if (list) {
      list[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => {
        if (!/^\w+$/.test(s)) { problems.push(`${where}: cannot parse export "${s}"`); return; }
        exports.push(s);
      });
      body.push('');
      return;
    }

    const decl = line.match(EXPORT_DECL_RE);
    if (decl) {
      if (decl[2] === 'let') {
        problems.push(`${where}: cannot export a let. Imported bindings are copies here, so a reassignment would not propagate.`);
      }
      const name = line.slice(decl[0].length).match(/^(\w+)/);
      if (!name) { problems.push(`${where}: cannot read the exported name`); return; }
      exports.push(name[1]);
      body.push('  ' + line.replace(/^(\s*)export\s+/, '$1'));
      return;
    }

    if (/^\s*export\b/.test(line)) {
      problems.push(`${where}: unsupported export form: ${line.trim()}`);
      return;
    }

    body.push(line ? '  ' + line : '');
  });

  return { id, deps, exports, body };
}

/* ------------------------------------------------------------------ *
 * walk the graph, depth first, refusing cycles
 * ------------------------------------------------------------------ */

const modules = new Map();
const order = [];
const state = new Map();   /* id -> 'open' | 'done' */

function walk(id, stack) {
  if (state.get(id) === 'done') return;
  if (state.get(id) === 'open') {
    problems.push(`circular import: ${stack.concat(id).join(' -> ')}`);
    return;
  }
  state.set(id, 'open');
  const mod = parseModule(id);
  if (mod) {
    modules.set(id, mod);
    mod.deps.forEach((d) => walk(d, stack.concat(id)));
    order.push(id);
  }
  state.set(id, 'done');
}

walk(ENTRY, []);

/* Every .js under partner/ must be reachable from the entry. An unreferenced
   module is either dead code or a file someone forgot to import, and both are
   worth a red build rather than a shrug. demo/ is exempt: it is loaded on
   demand from the fixture path and is not in the deployed bundle at all. */
function allModules(dir = SRC, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...allModules(p, prefix + name + '/')); continue; }
    if (name.endsWith('.js') && name !== 'console.build.js') out.push(prefix + name);
  }
  return out;
}
allModules().forEach((id) => {
  if (id.startsWith('demo/')) return;
  if (!modules.has(id)) problems.push(`${id}: never imported. Import it from the entry graph or delete it.`);
});

if (problems.length) {
  console.error('build-console: cannot build partner/\n');
  problems.forEach((p) => console.error('  ' + p));
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * emit
 * ------------------------------------------------------------------ */

const HEADER = `/* GENERATED by scripts/build-console.mjs. Do not edit.
 *
 * Source is partner/*.js, authored as ES modules. This file is the only one a
 * browser loads, and it is a classic script: CLAUDE.md's no-ESM rule applies
 * to browser-loaded files and is not waived here.
 *
 * Regenerate with: node scripts/build-console.mjs
 * CI fails if this file does not match its source.
 */`;

const RUNTIME = `(function (root) {
  "use strict";
  var __defs = {}, __cache = {};
  function __require(id) {
    if (__cache[id]) return __cache[id];
    var def = __defs[id];
    if (!def) throw new Error('partner console: no module "' + id + '"');
    var exports = __cache[id] = {};
    def(exports, __require, root);
    return exports;
  }`;

const parts = [HEADER, RUNTIME];
for (const id of order) {
  const mod = modules.get(id);
  const tail = mod.exports.map((n) => `  __exports.${n} = ${n};`).join('\n');
  parts.push(
    `\n  /* ${'='.repeat(66)}\n     ${id}\n     ${'='.repeat(66)} */`,
    `  __defs[${JSON.stringify(id)}] = function (__exports, __require, root) {`,
    mod.body.join('\n').replace(/\s+$/, ''),
    tail ? '\n' + tail : '',
    '  };'
  );
}
parts.push(`\n  __require(${JSON.stringify(ENTRY)});`);
parts.push(`})(typeof window !== 'undefined' ? window : globalThis);\n`);

const built = parts.join('\n');
const stamp = createHash('sha256').update(built).digest('hex').slice(0, 8);

/* The cache stamp, in the one place that references the bundle. /js and the
   console bundle are cached 24 hours, so shipping new markup against an
   unbumped stamp serves old JavaScript to every returning partner for a day.
   This is the same failure the retired build-console-stamp.mjs guarded; it is
   simpler here because there is now exactly one script to stamp. */
const pageSrc = existsSync(PAGE) ? readFileSync(PAGE, 'utf8') : '';
const STAMP_RE = /(src="\/partner\/console\.build\.js\?v=)([a-f0-9]+)(")/;
if (pageSrc && !STAMP_RE.test(pageSrc)) {
  console.error('build-console: partner/index.html does not reference console.build.js?v=<stamp>');
  process.exit(1);
}
const pageNext = pageSrc.replace(STAMP_RE, `$1${stamp}$3`);

if (check) {
  const stale = [];
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== built) stale.push('partner/console.build.js');
  if (pageSrc !== pageNext) stale.push('partner/index.html cache stamp');
  if (stale.length) {
    console.error('build-console: STALE\n');
    stale.forEach((s) => console.error('  ' + s));
    console.error('\nRun: node scripts/build-console.mjs, then commit the result.');
    process.exit(1);
  }
  console.log(`build-console: OK, ${order.length} modules, stamp ${stamp}`);
} else {
  writeFileSync(OUT, built);
  if (pageSrc) writeFileSync(PAGE, pageNext);
  console.log(`build-console: wrote partner/console.build.js (${order.length} modules, stamp ${stamp})`);
  order.forEach((id) => console.log('  ' + id));
}
