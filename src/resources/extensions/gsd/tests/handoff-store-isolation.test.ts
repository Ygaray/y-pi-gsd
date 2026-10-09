// Project/App: gsd-pi
// File Purpose: HANDOFF-01 isolation guard — every test process started through the test
// preloads gets a per-process temp yahir-handoff store (SC4, D-12, DP-5), while a non-test
// run through the same preload (the `pnpm gsd` dev CLI path) is left untouched.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupTempDirs, makeTempDir } from "./handoff-test-helpers.ts";

const tempDirs = new Set<string>();

after(() => cleanupTempDirs(tempDirs));

const RESOLVE_TS = fileURLToPath(new URL("./resolve-ts.mjs", import.meta.url));
const DIST_TEST_RESOLVE = resolve(fileURLToPath(new URL("../../../../../scripts/dist-test-resolve.mjs", import.meta.url)));

const PROBE = [
  "console.log(JSON.stringify({",
  "  root: process.env.YAHIR_HANDOFF_ROOT ?? null,",
  "  state: process.env.YAHIR_HANDOFF_STATE ?? null,",
  "}));",
  "",
].join("\n");

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.YAHIR_HANDOFF_ROOT;
  delete env.YAHIR_HANDOFF_STATE;
  return env;
}

function probe(preload: string, fileName: string, extraArgs: string[] = []): { root: string | null; state: string | null } {
  const dir = makeTempDir(tempDirs, "gsd-handoff-probe-");
  const file = join(dir, fileName);
  writeFileSync(file, PROBE);
  const res = spawnSync(process.execPath, ["--import", preload, ...extraArgs, file], {
    env: cleanEnv(),
    encoding: "utf-8",
    cwd: dir,
  });
  assert.equal(res.status, 0, `probe exited ${String(res.status)}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim().split("\n").pop() ?? "{}");
}

test("HANDOFF-01 isolation: test processes get a temp yahir-handoff store", () => {
  const root = process.env.YAHIR_HANDOFF_ROOT;
  const state = process.env.YAHIR_HANDOFF_STATE;
  assert.ok(root && isAbsolute(root), "YAHIR_HANDOFF_ROOT is set and absolute");
  assert.ok(state && isAbsolute(state), "YAHIR_HANDOFF_STATE is set and absolute");
  assert.ok(existsSync(root) && statSync(root).isDirectory(), "root exists as a directory");
  assert.ok(existsSync(state) && statSync(state).isDirectory(), "state exists as a directory");
  const tmpReal = realpathSync(tmpdir());
  assert.ok(realpathSync(root).startsWith(tmpReal), `${root} is under ${tmpReal}`);
  assert.ok(realpathSync(state).startsWith(tmpReal), `${state} is under ${tmpReal}`);
  assert.ok(root.includes("gsd-test-yahir-handoff-"));
  assert.ok(state.includes("gsd-test-yahir-handoff-"));
  const realStore = join(homedir(), ".local/share/yahir-handoff");
  const realState = join(homedir(), ".local/state/yahir-handoff");
  assert.notEqual(root, realStore);
  assert.notEqual(state, realState);
});

test("HANDOFF-01 isolation: a non-test run through resolve-ts.mjs is not redirected", () => {
  const plain = probe(RESOLVE_TS, "probe.mjs", ["--experimental-strip-types"]);
  assert.deepEqual(plain, { root: null, state: null });
  const asTest = probe(RESOLVE_TS, "probe.test.mjs", ["--experimental-strip-types"]);
  assert.ok(asTest.root?.includes("gsd-test-yahir-handoff-"), `test-named entry is isolated: ${String(asTest.root)}`);
  assert.ok(asTest.state?.includes("gsd-test-yahir-handoff-"), `test-named entry is isolated: ${String(asTest.state)}`);
});

test("HANDOFF-01 isolation: the compiled-test preload isolates the store too", () => {
  const plain = probe(DIST_TEST_RESOLVE, "probe.mjs");
  assert.deepEqual(plain, { root: null, state: null });
  const asTest = probe(DIST_TEST_RESOLVE, "probe.test.mjs");
  assert.ok(asTest.root?.includes("gsd-test-yahir-handoff-"), `isolated: ${String(asTest.root)}`);
  assert.ok(asTest.state?.includes("gsd-test-yahir-handoff-"), `isolated: ${String(asTest.state)}`);
});
