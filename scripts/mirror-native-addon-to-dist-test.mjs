#!/usr/bin/env node

/**
 * Mirror the from-source native addon into dist-test/ for the compiled-test loader.
 *
 * Why this exists: the compiled-test native loader
 * (dist-test/packages/native/dist/native.js) resolves its addon directory
 * relative to its own location, i.e. dist-test/native/addon — not the
 * repo-root native/addon that `pnpm run build:native:test` writes to. CI has
 * performed this mirror inline as an anonymous step since it was added
 * (.github/workflows/ci.yml, "Mirror native addon into dist-test (compiled-test
 * loader path)"); this script is that same step, made a committed, reusable,
 * local command.
 *
 * Must run AFTER `pnpm run test:compile` — compile-tests.mjs prunes stale
 * dist-test entries whose source has no counterpart, and the mirror destination
 * has no src/ counterpart of its own.
 *
 * Usage:
 *   node scripts/mirror-native-addon-to-dist-test.mjs
 *   pnpm run native:addon:mirror
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const sourceDir = path.join(repoRoot, "native", "addon");
const destDir = path.join(repoRoot, "dist-test", "native", "addon");

function fail(message) {
  console.error(`[mirror-native-addon-to-dist-test] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(sourceDir)) {
  fail(
    `No built native addon found at ${sourceDir} (directory does not exist). ` +
      "Run `pnpm run build:native:test` first. If that command also fails, the " +
      "likely cause is that no Rust toolchain (cargo/rustc) is installed on this machine.",
  );
}

const nodeFiles = fs.readdirSync(sourceDir).filter((name) => name.endsWith(".node"));

if (nodeFiles.length === 0) {
  fail(
    `${sourceDir} exists but contains no .node file. ` +
      "Run `pnpm run build:native:test` first. If that command also fails, the " +
      "likely cause is that no Rust toolchain (cargo/rustc) is installed on this machine.",
  );
}

fs.mkdirSync(destDir, { recursive: true });

for (const name of nodeFiles) {
  const source = path.join(sourceDir, name);
  const dest = path.join(destDir, name);
  fs.copyFileSync(source, dest);
  console.log(`Copied: ${source} -> ${dest}`);
}

console.log(`\n${destDir}:`);
for (const name of fs.readdirSync(destDir)) {
  console.log(`  ${name}`);
}
