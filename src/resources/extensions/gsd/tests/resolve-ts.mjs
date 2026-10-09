import { mkdirSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as distRedirect from './dist-redirect.mjs';

// HANDOFF-01 store isolation (SC4, D-12, DP-5): a TEST process must never reach the
// operator's real yahir-handoff store. scripts/dev-cli.js (`pnpm gsd`) ALSO preloads this
// file to run the real product from source, so the override is predicate-guarded: it only
// applies when this process is a test run, and a real dev run keeps its real store.
const isTestRun =
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test-')) ||
  /\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? '');

if (isTestRun) {
  const handoffTestDir = join(tmpdir(), `gsd-test-yahir-handoff-${process.pid}`);
  mkdirSync(join(handoffTestDir, 'store'), { recursive: true });
  mkdirSync(join(handoffTestDir, 'state'), { recursive: true });
  // Unconditional: a test process must never inherit an operator-set store path.
  process.env.YAHIR_HANDOFF_ROOT = join(handoffTestDir, 'store');
  process.env.YAHIR_HANDOFF_STATE = join(handoffTestDir, 'state');
  process.on('exit', () => {
    try {
      rmSync(handoffTestDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}

// Register hook to redirect imports to the dist directory
registerHooks({
  resolve: distRedirect.resolve,
  load: distRedirect.load,
});
