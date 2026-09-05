/* Load a backend (Catalyst) module from a test, without installing the
 * Catalyst SDK.
 *
 * WHY. catalyst-backend/functions/auth has its own package.json and its own
 * node_modules, installed by deploy-functions.yml with `npm ci`.
 * check-frontend.yml has no install step at all, deliberately: every one of
 * its gates is stdlib-only, which is what keeps it fast enough that nobody
 * turns it off. So a test that requires a backend module cannot assume the SDK
 * is on disk, and the first version of these tests passed locally only because
 * an earlier `npm install` had left it there. A clean checkout failed.
 *
 * The stub is honest rather than a workaround. lib/datastore.js touches the
 * SDK in exactly one place, `catalyst.initialize(req)`, reached only through
 * datastore.app(). The functions worth unit-testing here (the route guards,
 * the derived campaign stage) are pure and never go near it. Anything that
 * DOES call it will fail loudly rather than silently pretending to work.
 */

import Module from 'node:module';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const AUTH_SRC = join(ROOT, 'catalyst-backend/functions/auth/src');

/* Why express and nodemailer are here too.
 *
 * The stub list is not "the SDK": it is every dependency that lives in
 * functions/auth/node_modules, because this gate has no install step. Two of
 * them are reached by REQUIRE alone, before any test decides what to exercise:
 * routes/desk.js requires routes/application.js, which requires express at
 * module scope, and lib/notices.js reaches lib/mailer.js, which requires
 * nodemailer. Neither is called by the pure functions these tests cover, but a
 * missing module throws at load, so the whole suite died on an import it never
 * used. That is what turned check-frontend red on main and kept it red.
 *
 * Same discipline as the SDK stub below: the shape exists so a require
 * succeeds, and every entry point throws if a test actually calls it, so this
 * can never quietly pretend a body was parsed or a mail was sent.
 */
const refuse = (what) => () => {
  throw new Error(
    `${what} is stubbed in tests. check-frontend has no install step, so ` +
    'functions/auth/node_modules is not on disk. A test that needs the real ' +
    'one belongs in deploy-functions.yml, which does run npm ci.'
  );
};

const STUBS = {
  express: { raw: refuse('express.raw'), json: refuse('express.json'), urlencoded: refuse('express.urlencoded') },
  nodemailer: { createTransport: refuse('nodemailer.createTransport') },
  'zcatalyst-sdk-node': {
    initialize() {
      throw new Error(
        'zcatalyst-sdk-node is stubbed in tests. Something under test called ' +
        'datastore.app(), which means it is not the pure function it claims ' +
        'to be, or the test needs a real fixture rather than a stub.'
      );
    },
  },
};

let patched = false;
function patchOnce() {
  if (patched) return;
  patched = true;
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return load.call(this, request, ...rest);
  };
}

const require = createRequire(import.meta.url);

/** Require a backend module by its path under functions/auth/src. */
export function backend(relative) {
  patchOnce();
  return require(join(AUTH_SRC, relative));
}
