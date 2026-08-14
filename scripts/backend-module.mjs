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

const STUBS = {
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
