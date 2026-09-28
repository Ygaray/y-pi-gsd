#!/usr/bin/env node

/**
 * Build script for the GSD native Rust addon.
 *
 * Usage:
 *   node native/scripts/build.js          # release build
 *   node native/scripts/build.js --dev    # debug build
 *   node native/scripts/build.js --dev --test-fault-injection
 *
 * Runs `cargo build` in the engine crate directory and copies the resulting
 * shared library to `native/addon/` with a `.node` extension so Node.js
 * can load it via `require()`.
 *
 * When `cargo` is not installed, this script probes for a usable prebuilt
 * addon (a local `native/addon/*.node` build, or the resolvable
 * `@opengsd/engine-<platform>` npm optional dependency) and, when one is
 * found, visibly skips the rebuild and exits 0 instead of dying on
 * `cargo: not found`.
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nativeRoot = path.resolve(__dirname, "..");
const engineDir = path.join(nativeRoot, "crates", "engine");
const addonDir = path.join(nativeRoot, "addon");
const platformTag = `${process.platform}-${process.arch}`;
const require_ = createRequire(import.meta.url);

/**
 * Map Node.js platform/arch to the npm package suffix — copied verbatim
 * from `packages/native/src/native.ts`'s `platformPackageMap`. This is one
 * of three independent copies (this file, `scripts/run-package-tests.cjs`,
 * and `native.ts`) pinned together by
 * `scripts/__tests__/native-build-toolchain-gate.test.mjs`'s drift guard.
 */
const PLATFORM_PACKAGE_MAP = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "win32-x64": "win32-x64-msvc",
};

const releaseCandidatePath = path.join(addonDir, `gsd_engine.${platformTag}.node`);
const devCandidatePath = path.join(addonDir, "gsd_engine.dev.node");

/**
 * Verbatim duplication of `scripts/run-package-tests.cjs`'s `commandExists`,
 * per this repo's established per-file-duplication convention for this
 * helper (this file is ESM, `run-package-tests.cjs` is CJS). A status of 1
 * counts as "exists" too — some tools (notably `cargo --version` failure
 * modes on odd PATH setups) exit 1 while still being present — matching the
 * harness's own probe so the two never silently disagree.
 */
function commandExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0 || result.status === 1;
}

/**
 * Resolve a usable prebuilt addon WITHOUT loading it. Checks in the same
 * order `native.ts`'s loader prefers: the platform-tagged local build, the
 * dev local build, then the resolvable `@opengsd/engine-<platform>` npm
 * optional dependency. Returns a human-readable source string (an absolute
 * path or a bare package spec), or `null` when nothing resolves.
 */
function resolveUsablePrebuiltAddon() {
  if (fs.existsSync(releaseCandidatePath)) return releaseCandidatePath;
  if (fs.existsSync(devCandidatePath)) return devCandidatePath;

  const packageSuffix = PLATFORM_PACKAGE_MAP[platformTag];
  if (packageSuffix) {
    const packageSpec = `@opengsd/engine-${packageSuffix}`;
    try {
      require_.resolve(packageSpec);
      return packageSpec;
    } catch {
      // Not resolvable — fall through to null.
    }
  }

  return null;
}

const isDev = process.argv.includes("--dev");
const testFaultInjection = process.argv.includes("--test-fault-injection");
const profile = isDev ? "debug" : "release";
const cargoArgs = ["build"];
if (!isDev) cargoArgs.push("--release");
if (testFaultInjection) cargoArgs.push("--features", "test-fault-injection");

// Cargo-presence gate. When cargo IS available, every line below runs
// byte-for-byte as it always has — including the try/catch around the real
// `cargo build` invocation, which must stay a hard failure (a real build
// failure must never be absorbed by the toolchain-absence path below).
if (!commandExists("cargo")) {
  if (testFaultInjection) {
    // `pnpm run test:packages` never passes --test-fault-injection — only
    // the separate root `build:native:test` script does — so this branch
    // does not affect the harness's SC-1..SC-4. The pinned
    // @opengsd/engine-* binary is built WITHOUT the test-fault-injection
    // cargo feature (see .github/workflows/coverage-report.yml), so a
    // prebuilt addon can never stand in for this build.
    console.error(
      "native fault-injection rebuild IMPOSSIBLE: cargo is unavailable and a prebuilt " +
        "@opengsd/engine-* binary cannot satisfy --test-fault-injection (the pinned binary " +
        "is built without the test-fault-injection cargo feature — see " +
        ".github/workflows/coverage-report.yml).",
    );
    process.exit(1);
  }

  const reused = resolveUsablePrebuiltAddon();
  if (reused) {
    // No staleness detector exists in this codebase (and building one is
    // out of scope) — the honest wording that freshness is unverified IS
    // the mitigation. Written to stderr so it interleaves with the
    // harness's own stderr skip reporting instead of getting buried in
    // captured stdout.
    console.error(
      `native rebuild SKIPPED: cargo is unavailable; reusing prebuilt addon from ${reused}. ` +
        "Freshness of this addon against the current Rust source is NOT verified.",
    );
    process.exit(0);
  }

  const packageSuffix = PLATFORM_PACKAGE_MAP[platformTag];
  const packageSpecForMessage = packageSuffix
    ? `@opengsd/engine-${packageSuffix}`
    : `@opengsd/engine-* (no package mapping for ${platformTag})`;
  console.error(
    "native rebuild IMPOSSIBLE: cargo is unavailable and no usable prebuilt addon was found " +
      `(checked ${releaseCandidatePath}, ${devCandidatePath}, and the ${packageSpecForMessage} package).`,
  );
  process.exit(1);
}

console.log(`Building gsd-engine (${profile})...`);

try {
  execSync(`cargo ${cargoArgs.join(" ")}`, {
    cwd: engineDir,
    stdio: "inherit",
    env: {
      ...process.env,
      // Optimize for native CPU when building locally
      RUSTFLAGS: process.env.RUSTFLAGS || "-C target-cpu=native",
    },
  });
} catch {
  process.exit(1);
}

// Locate the built library
const cargoTargetRoot = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(nativeRoot, "target");

const targetDir = path.join(cargoTargetRoot, profile);

const libraryNames = {
  darwin: "libgsd_engine.dylib",
  linux: "libgsd_engine.so",
  win32: "gsd_engine.dll",
};

const libName = libraryNames[process.platform];
if (!libName) {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

const sourcePath = path.join(targetDir, libName);
if (!fs.existsSync(sourcePath)) {
  console.error(`Built library not found at: ${sourcePath}`);
  process.exit(1);
}

fs.mkdirSync(addonDir, { recursive: true });

const destFilename = isDev
  ? "gsd_engine.dev.node"
  : `gsd_engine.${platformTag}.node`;
const destPath = path.join(addonDir, destFilename);

fs.copyFileSync(sourcePath, destPath);
console.log(`Installed: ${destPath}`);
console.log("Build complete.");
