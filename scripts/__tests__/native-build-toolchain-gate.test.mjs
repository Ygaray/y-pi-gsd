// Project/App: gsd-pi
// File Purpose: Hermetic, host-independent regression coverage for the
// cargo-presence gate in native/scripts/build.js and the widened
// hasNativeAddon() helper in run-package-tests.cjs (GREEN-04).

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const {
	hasNativeAddon,
	hasLocalNativeAddon,
	hasPrebuiltNativeAddonPackage,
	PLATFORM_PACKAGE_MAP,
} = require_('../run-package-tests.cjs')

const __dirname_ = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname_, '..', '..')
const BUILD_SCRIPT = join(REPO_ROOT, 'native', 'scripts', 'build.js')

function withTempDir(callback) {
	const dir = mkdtempSync(join(tmpdir(), 'gsd-native-gate-'))
	try {
		return callback(dir)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// process.execPath is absolute and Node invokes `/bin/sh` (for the shebang
// stub) by absolute path, so emptying PATH here only affects the `cargo`
// lookup inside build.js's own commandExists('cargo') probe — it does not
// break spawning node itself or the stub script.
function spawnBuild(scriptPath, { pathValue, extraEnv = {}, extraArgv = [] } = {}) {
	const result = spawnSync(process.execPath, [scriptPath, '--dev', ...extraArgv], {
		encoding: 'utf8',
		timeout: 60_000,
		env: { ...process.env, PATH: pathValue, ...extraEnv },
	})
	return { status: result.status, combined: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

// A "cargo is installed but the build genuinely fails" fixture: exits 0 for
// `--version` (so commandExists('cargo') reports present) and exits 101
// (a real rustc-style compile-error exit code) for any other invocation.
function makeCargoStub(dir) {
	const cargoPath = join(dir, 'cargo')
	const script = [
		'#!/bin/sh',
		'if [ "$1" = "--version" ]; then',
		'  echo "cargo 1.0.0-stub"',
		'  exit 0',
		'fi',
		'echo "error: stub cargo build failure" >&2',
		'exit 101',
		'',
	].join('\n')
	writeFileSync(cargoPath, script, { mode: 0o755 })
	return cargoPath
}

// ── Pure-function tests (run everywhere, including win32) ──────────────────

test('hasLocalNativeAddon finds a dev build', () => {
	withTempDir((tempDir) => {
		const addonDir = join(tempDir, 'native', 'addon')
		mkdirSync(addonDir, { recursive: true })
		writeFileSync(join(addonDir, 'gsd_engine.dev.node'), 'stub')
		assert.equal(hasLocalNativeAddon(tempDir), true)
	})
})

test('hasLocalNativeAddon finds a platform-tagged build', () => {
	withTempDir((tempDir) => {
		const addonDir = join(tempDir, 'native', 'addon')
		mkdirSync(addonDir, { recursive: true })
		writeFileSync(join(addonDir, `gsd_engine.${process.platform}-${process.arch}.node`), 'stub')
		assert.equal(hasLocalNativeAddon(tempDir), true)
	})
})

test('hasLocalNativeAddon on an empty root returns false', () => {
	withTempDir((tempDir) => {
		assert.equal(hasLocalNativeAddon(tempDir), false)
	})
})

test('hasPrebuiltNativeAddonPackage matches an independently computed oracle', () => {
	const platformTag = `${process.platform}-${process.arch}`
	const packageSuffix = PLATFORM_PACKAGE_MAP[platformTag]
	let expected = false
	if (packageSuffix) {
		try {
			require_.resolve(`@opengsd/engine-${packageSuffix}`)
			expected = true
		} catch {
			expected = false
		}
	}
	assert.equal(hasPrebuiltNativeAddonPackage(), expected)
})

test('hasNativeAddon is exactly the disjunction of its two sources', () => {
	assert.equal(hasNativeAddon(), hasLocalNativeAddon() || hasPrebuiltNativeAddonPackage())
})

test('PLATFORM_PACKAGE_MAP matches native.ts platformPackageMap (drift guard)', () => {
	const nativeTsPath = join(REPO_ROOT, 'packages', 'native', 'src', 'native.ts')
	const content = readFileSync(nativeTsPath, 'utf8')
	const startIdx = content.indexOf('platformPackageMap')
	assert.ok(startIdx !== -1, 'platformPackageMap declaration not found in native.ts')
	const endIdx = content.indexOf('};', startIdx)
	assert.ok(endIdx !== -1, 'closing "};" not found after platformPackageMap declaration')
	const region = content.slice(startIdx, endIdx)

	const pairPattern = /"([^"]+)":\s*"([^"]+)"/g
	const extracted = {}
	let match
	while ((match = pairPattern.exec(region)) !== null) {
		extracted[match[1]] = match[2]
	}

	// A silently-emptied regex match must not pass the deepEqual vacuously.
	assert.equal(Object.keys(extracted).length, 5, 'expected exactly 5 platform-map entries')
	assert.deepEqual(PLATFORM_PACKAGE_MAP, extracted)
})

// ── Spawn-based tests (POSIX-only: shell stub + emptied-PATH fixtures) ─────

test('build.js skips the rebuild and reuses a prebuilt addon when cargo is absent (SC-2/SC-3)', (t) => {
	if (process.platform === 'win32') {
		t.skip('POSIX-only PATH/stub-script fixtures')
		return
	}
	withTempDir((emptyBinDir) => {
		const { status, combined } = spawnBuild(BUILD_SCRIPT, { pathValue: emptyBinDir })
		assert.equal(status, 0)
		assert.match(combined, /native rebuild SKIPPED/)
		assert.match(combined, /native\/addon\/gsd_engine|@opengsd\/engine-/)
		assert.match(combined, /not verified/i)
	})
})

test('build.js still fails hard when cargo is present but the build genuinely fails (SC-1/Pitfall 1)', (t) => {
	if (process.platform === 'win32') {
		t.skip('POSIX-only PATH/stub-script fixtures')
		return
	}
	withTempDir((binDir) => {
		makeCargoStub(binDir)
		// Runs the REAL build script against the repo's actual engineDir. The
		// stub cargo exits 101 before any copy step runs, so this test writes
		// nothing to disk — it only needs to prove the skip path never
		// absorbs a genuine compile failure.
		const { status, combined } = spawnBuild(BUILD_SCRIPT, { pathValue: binDir })
		assert.notEqual(status, 0)
		assert.doesNotMatch(combined, /native rebuild SKIPPED/)
	})
})

test('build.js hard-fails with IMPOSSIBLE when nothing usable is found', (t) => {
	if (process.platform === 'win32') {
		t.skip('POSIX-only PATH/stub-script fixtures')
		return
	}
	withTempDir((copyRoot) => {
		const destDir = join(copyRoot, 'native', 'scripts')
		mkdirSync(destDir, { recursive: true })
		const destScript = join(destDir, 'build.js')
		// Copy only build.js — it imports nothing but Node builtins. Because
		// the copy derives nativeRoot from its own __dirname, its addonDir is
		// the non-existent <copyRoot>/native/addon, and require_.resolve
		// walking up from <copyRoot>/native/scripts cannot reach the repo's
		// node_modules, so neither prebuilt source resolves.
		writeFileSync(destScript, readFileSync(BUILD_SCRIPT, 'utf8'))

		withTempDir((emptyBinDir) => {
			const { status, combined } = spawnBuild(destScript, { pathValue: emptyBinDir })
			assert.equal(status, 1)
			assert.match(combined, /native rebuild IMPOSSIBLE/)
		})
	})
})

test('build.js refuses fault-injection when cargo is absent, even with a usable prebuilt addon', (t) => {
	if (process.platform === 'win32') {
		t.skip('POSIX-only PATH/stub-script fixtures')
		return
	}
	withTempDir((emptyBinDir) => {
		// .github/workflows/coverage-report.yml:70-74: the pinned
		// @opengsd/engine-* binary is built WITHOUT the test-fault-injection
		// cargo feature, so it can never stand in for a
		// --test-fault-injection build even when otherwise usable.
		const { status, combined } = spawnBuild(BUILD_SCRIPT, {
			pathValue: emptyBinDir,
			extraArgv: ['--test-fault-injection'],
		})
		assert.notEqual(status, 0)
		assert.match(combined, /native fault-injection rebuild IMPOSSIBLE/)
	})
})
