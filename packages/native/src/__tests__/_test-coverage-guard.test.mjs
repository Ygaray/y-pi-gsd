// Regression guard for #4814 (filed under #4784).
//
// The `test` script in `package.json` used to hardcode a list of individual
// test files. When new test files were added without updating the list,
// they were silently skipped by `npm test` — 7 files / 99 tests went
// unrun in CI, including regression guards for #2861 (Node v24 ESM/CJS
// crash) and a napi state-array crash. See #4814 for the audit.
//
// This test fails if either of two things regresses:
//   1. The `test` script stops using a directory / glob invocation and
//      goes back to naming individual files.
//   2. Some mechanism is introduced that lists files and misses one.
//
// Mechanics: we parse the `test` script from package.json. A script that
// lists individual files (`src/__tests__/foo.test.mjs`) is REJECTED. A
// script that passes the directory (`src/__tests__` or `src/__tests__/`)
// is ACCEPTED. Either way we double-check by comparing the set of
// discoverable `*.test.mjs` files on disk against what the script
// actually invokes, so even a creative future construction is covered.
//
// The filename is prefixed `_` so it runs first in alphabetical order —
// a coverage-problem report precedes any noise from the tests whose
// coverage it is guarding.
//
// GREEN-04 / Phase 30: a third guard below makes permanent the removal of
// the ~13 hard-exit (`require()`-or-`process.exit(1)`) preambles this phase
// converted to a loader-backed, describe-level `{ skip }` shape. A
// module-scope `process.exit(` call under `node --test` kills the whole
// test-file's runner process the way a crash would — the runner cannot
// distinguish "this file intentionally terminated" from "this file
// crashed," so the file's own tests, and every file `node --test` was still
// queued to run after it, are silently never reported. This guard scans
// every sibling `*.test.mjs` (excluding itself) for that pattern and fails
// loudly, by name, the moment it reappears. A companion assertion catches
// the inverse mistake: a new file that reaches for the raw addon object
// (`native.<member>`) without going through the compiled
// `dist/native.js` loader, which throws a bare "not a function" / "is not
// a constructor" error instead of degrading to a visible skip.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "..", "package.json");
const SELF_FILENAME = basename(fileURLToPath(import.meta.url));

// Files that legitimately reach for `native.<member>` (or the loader's raw
// destructure) without going through the `dist/native.js` loader in their
// own source text. Each is deliberately reviewed here rather than silently
// exempted inline — adding to this list is a load-bearing, reviewed act.
const ADDON_ACCESS_LOADER_EXEMPTIONS = new Set([
  // ESM/CJS resolution config test — asserts on package.json fields and
  // spawns a subprocess that requires the compiled output; never touches
  // the addon object directly in this file's own source.
  "module-compat.test.mjs",
  // Spawns a subprocess that requires compiled loader-backed modules
  // (dist/grep, dist/xxhash) via a script string, not a direct import.
  "function-fallback.test.mjs",
  // Spawns a subprocess that requires a compiled loader-backed module
  // (dist/text) via a script string, not a direct import.
  "text-fallback.test.mjs",
  // Imports via the `@gsd/native/xxhash` subpath export, not the
  // `dist/native.js` loader's `native` object.
  "xxhash.test.mjs",
  // Drives the loader through a spawned subprocess script string (which
  // itself references `native.<member>` as text inside that string, not
  // as live code in this file), not a direct `dist/native.js` require in
  // this file's own top-level source.
  "file-identity-fallback.test.mjs",
]);

function loadTestScript() {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.scripts?.test ?? "";
}

function discoverTestFiles() {
  return readdirSync(__dirname)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();
}

test("test script discovers every *.test.mjs file in src/__tests__/", () => {
  const script = loadTestScript();
  const onDisk = discoverTestFiles();

  // Accept self-healing invocation patterns (any of):
  //   node --test src/__tests__/*.test.mjs    (glob — Node resolves even without shell expansion)
  //   node --test "src/__tests__/*.test.mjs"  (quoted glob)
  //   node --test src/__tests__                (directory — some Node versions only)
  //   node --test src/__tests__/               (directory with trailing slash)
  // All four are structural: a new test file is picked up automatically.
  const selfHealingPattern = /\bnode\s+--test\b[^|&;]*\bsrc\/__tests__(?:\/(?:\*\.test\.mjs)?)?(?:\s|$|"|')/;
  if (selfHealingPattern.test(script)) {
    // Self-healing invocation; no further enumeration needed.
    assert.ok(true);
    return;
  }

  // Otherwise, the script must list every on-disk file individually.
  // Extract the set of files it names.
  const listedMatches = script.match(/src\/__tests__\/[A-Za-z0-9._-]+\.test\.mjs/g) || [];
  const listed = new Set(listedMatches.map((s) => s.split("/").pop()));

  const missing = onDisk.filter((f) => !listed.has(f));
  assert.deepEqual(
    missing,
    [],
    [
      "npm test does not invoke every *.test.mjs in src/__tests__/.",
      `Missing: ${missing.join(", ")}`,
      "Fix: replace the hardcoded list in packages/native/package.json",
      "with `node --test src/__tests__` (the directory form recursively",
      "discovers test files and is the boring-tech choice per McKinley).",
      "See #4814.",
    ].join("\n"),
  );
});

test("every *.test.mjs file is a valid ES module that exports nothing weird", () => {
  // Cheap sanity check: every test file can at least be statically
  // read. This catches accidental binary writes / zero-byte files that
  // would silently pass `--test` with zero cases.
  const files = discoverTestFiles();
  assert.ok(files.length > 0, "src/__tests__/ contains no test files");

  for (const f of files) {
    const body = readFileSync(join(__dirname, f), "utf-8");
    assert.ok(body.length > 0, `${f} is empty`);
    assert.match(
      body,
      /\bimport\s+.*\bfrom\s+['"]node:test['"]|test\s*\(/,
      `${f} does not import node:test or declare any test() — it will run zero cases`,
    );
  }
});

// GREEN-04 / Phase 30: makes the removed hard-exit pattern permanently
// unable to return. See the head comment for why this matters.
test("no test file terminates the node --test runner on addon-load failure", () => {
  const files = discoverTestFiles().filter((f) => f !== SELF_FILENAME);

  // Assertion 1: no sibling file may hard-exit the runner process at
  // module scope on addon-load failure. Collect every offender so a
  // violation reports everyone at once, not just the first alphabetically.
  const processExitOffenders = [];
  for (const f of files) {
    const body = readFileSync(join(__dirname, f), "utf-8");
    if (body.includes("process.exit(")) {
      processExitOffenders.push(f);
    }
  }
  assert.deepEqual(
    processExitOffenders,
    [],
    [
      `${processExitOffenders.join(", ")} call(s) process.exit( at module scope.`,
      "A module-scope process.exit() under `node --test` kills the entire",
      "test-file process the runner cannot distinguish from a crash — the",
      "file's own tests, and every file still queued to run after it in the",
      "same invocation, silently never get reported.",
      "Replace it with the loader-backed shape: `const { native,",
      'isNativeAddonLoaded } = require_("../../dist/native.js");` then',
      "compute `const addonSkip = isNativeAddonLoaded() ? undefined :",
      '"<reason>";` and pass `{ skip: addonSkip }` to each top-level',
      "describe(). See GREEN-04 / Phase 30.",
    ].join("\n"),
  );

  // Assertion 2 (companion, catches the inverse mistake): a file whose
  // source reaches for the addon object directly (`native.<member>`)
  // must also route through the compiled `dist/native.js` loader —
  // otherwise a raw `native/addon/*.node` require fails with a bare
  // require error instead of degrading to a visible skip. Exempted files
  // are reviewed above in ADDON_ACCESS_LOADER_EXEMPTIONS.
  const loaderMissingOffenders = [];
  for (const f of files) {
    if (ADDON_ACCESS_LOADER_EXEMPTIONS.has(f)) continue;
    const body = readFileSync(join(__dirname, f), "utf-8");
    if (body.includes("native.") && !body.includes("dist/native.js")) {
      loaderMissingOffenders.push(f);
    }
  }
  assert.deepEqual(
    loaderMissingOffenders,
    [],
    [
      `${loaderMissingOffenders.join(", ")} use(s) the \`native.\` addon`,
      "object directly but never requires `dist/native.js` — this reaches",
      "for a raw `native/addon/*.node` require, which fails with a bare",
      "require error on a toolchain-less host instead of degrading to a",
      "visible skip. Route through the loader, or add a reviewed entry to",
      "ADDON_ACCESS_LOADER_EXEMPTIONS if this file has a legitimate reason",
      "not to. See GREEN-04 / Phase 30.",
    ].join("\n"),
  );
});
