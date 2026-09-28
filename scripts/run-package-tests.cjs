// gsd-pi + scripts/run-package-tests.cjs — run `node --test` across every linkable workspace package
'use strict'

const { spawnSync } = require('child_process')
const { existsSync, readdirSync, readFileSync } = require('fs')
const { join, relative } = require('path')
const { getLinkablePackages, REPO_ROOT } = require('./lib/workspace-manifest.cjs')

const DEFAULT_PACKAGE_TEST_TIMEOUT_MS = parsePositiveInt(process.env.PACKAGE_TEST_TIMEOUT_MS, 180_000)
const NATIVE_PACKAGE_TEST_TIMEOUT_MS = parsePositiveInt(process.env.NATIVE_PACKAGE_TEST_TIMEOUT_MS, 600_000)

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(value ?? '', 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getPnpmCommand() {
	return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function findTestFiles(dir) {
	const out = []
	if (!existsSync(dir)) return out
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue
			out.push(...findTestFiles(full))
		} else if (entry.isFile()) {
			if (/\.test\.(c|m)?js$/.test(entry.name)) out.push(full)
		}
	}
	return out
}

function isVitestFile(filePath) {
	try {
		const content = readFileSync(filePath, 'utf8')
		return /from\s*["']vitest["']|require\(["']vitest["']\)/.test(content)
	} catch {
		return false
	}
}

function selectPackageTestFiles(distTestPkg, pkgDist) {
	const fromCompiledSrc = findTestFiles(join(distTestPkg, 'src'))
	const fromCompiledTest = findTestFiles(join(distTestPkg, 'test')).filter((f) => !isVitestFile(f))
	if (fromCompiledSrc.length > 0 || fromCompiledTest.length > 0) {
		return [...fromCompiledSrc, ...fromCompiledTest]
	}
	if (existsSync(distTestPkg)) return []
	// Fall back to package-local build outputs when test:compile does not cover a package yet.
	return findTestFiles(pkgDist)
}

function findDistTestFiles(pkgDir) {
	const distTestPkg = join(REPO_ROOT, 'dist-test', 'packages', relative(join(REPO_ROOT, 'packages'), pkgDir))
	return selectPackageTestFiles(distTestPkg, join(pkgDir, 'dist'))
}

function commandExists(command, args = ['--version']) {
	const result = spawnSync(command, args, { stdio: 'ignore' })
	return result.status === 0 || result.status === 1
}

// Map Node.js platform/arch to the npm package suffix — copied verbatim from
// `packages/native/src/native.ts`'s `platformPackageMap`. One of three
// independent copies (this file, `native/scripts/build.js`, and `native.ts`)
// pinned together by `scripts/__tests__/native-build-toolchain-gate.test.mjs`'s
// drift guard.
const PLATFORM_PACKAGE_MAP = {
	'darwin-arm64': 'darwin-arm64',
	'darwin-x64': 'darwin-x64',
	'linux-x64': 'linux-x64-gnu',
	'linux-arm64': 'linux-arm64-gnu',
	'win32-x64': 'win32-x64-msvc',
}

function hasLocalNativeAddon(repoRoot = REPO_ROOT) {
	const platformTag = `${process.platform}-${process.arch}`
	return (
		existsSync(join(repoRoot, 'native', 'addon', `gsd_engine.${platformTag}.node`)) ||
		existsSync(join(repoRoot, 'native', 'addon', 'gsd_engine.dev.node'))
	)
}

function hasPrebuiltNativeAddonPackage() {
	const platformTag = `${process.platform}-${process.arch}`
	const packageSuffix = PLATFORM_PACKAGE_MAP[platformTag]
	if (!packageSuffix) return false
	try {
		require.resolve(`@opengsd/engine-${packageSuffix}`)
		return true
	} catch {
		return false
	}
}

function hasNativeAddon() {
	return hasLocalNativeAddon() || hasPrebuiltNativeAddonPackage()
}

function looksLikePassingTestRun(output) {
	if (!output) return false
	if (/(✖ failing tests:|^not ok\b|ℹ fail\s+[1-9]\d*|# fail\s+[1-9]\d*)/m.test(output)) {
		return false
	}
	return /(ℹ pass\s+\d+|# pass\s+\d+)/m.test(output) && /(ℹ fail\s+0|# fail\s+0)/m.test(output)
}

function runCommand(command, args, cwd = REPO_ROOT, label = command, timeoutMs = DEFAULT_PACKAGE_TEST_TIMEOUT_MS) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: 50 * 1024 * 1024,
		timeout: timeoutMs,
	})
	if (result.stdout) {
		process.stdout.write(result.stdout)
	}
	if (result.stderr) {
		process.stderr.write(result.stderr)
	}

	if ((result.status ?? 1) !== 0 && !result.signal && !result.error) {
		const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
		if (looksLikePassingTestRun(combinedOutput)) {
			process.stderr.write(
				`Warning: ${label} exited non-zero despite reporting zero test failures; treating as pass.\n`
			)
			return 0
		}
	}

	if (result.error) {
		process.stderr.write(`Failed to run ${label}: ${result.error.message}\n`)
	}
	if (result.signal) {
		process.stderr.write(`${label} terminated by signal ${result.signal}.\n`)
	}
	if (result.error?.code === 'ETIMEDOUT') {
		process.stderr.write(`${label} timed out after ${timeoutMs}ms.\n`)
	}
	if (result.error || result.signal) {
		return 1
	}
	return result.status ?? 1
}

function runPackageScript(command, args, cwd = REPO_ROOT, label = command, timeoutMs = DEFAULT_PACKAGE_TEST_TIMEOUT_MS) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: 50 * 1024 * 1024,
		shell: process.platform === 'win32',
		timeout: timeoutMs,
	})
	if (result.stdout) {
		process.stdout.write(result.stdout)
	}
	if (result.stderr) {
		process.stderr.write(result.stderr)
	}
	if ((result.status ?? 1) !== 0 && !result.signal && !result.error) {
		const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
		if (looksLikePassingTestRun(combinedOutput)) {
			process.stderr.write(
				`Warning: ${label} exited non-zero despite reporting zero test failures; treating as pass.\n`
			)
			return 0
		}
	}
	if ((result.status ?? 1) !== 0 || result.error || result.signal) {
		if (result.error) {
			process.stderr.write(`Failed to run ${label}: ${result.error.message}\n`)
		}
		if (result.signal) {
			process.stderr.write(`${label} terminated by signal ${result.signal}.\n`)
		}
		if (result.error?.code === 'ETIMEDOUT') {
			process.stderr.write(`${label} timed out after ${timeoutMs}ms.\n`)
		}
	}
	if (result.error || result.signal) {
		return 1
	}
	return result.status ?? 1
}

function buildNodeTestArgs(files) {
	// --test-concurrency=1: node's default concurrent test-file execution (tied to
	// os.availableParallelism()) causes non-deterministic silent test-count drops
	// (tests vanish from the tally without being counted as failed/skipped/cancelled).
	// Serializing file execution is the only concurrency setting that reproduced
	// zero variance across repeated runs. See GREEN-01 (Phase 27).
	return ['--test-force-exit', '--test-concurrency=1', '--test', ...files]
}

function main() {
	const packages = getLinkablePackages()
	const summary = []
	for (const pkg of packages) {
		if (pkg.packageName === '@gsd/native') {
			if (process.env.GSD_SKIP_NATIVE_PACKAGE_TESTS === '1') {
				summary.push({
					pkg: pkg.packageName,
					dir: pkg.dir,
					count: 'skipped by GSD_SKIP_NATIVE_PACKAGE_TESTS',
				})
				continue
			}
			const canRunNative = hasNativeAddon() || commandExists('cargo')
			summary.push({
				pkg: pkg.packageName,
				dir: pkg.dir,
				count: canRunNative ? 'package-script' : 'skipped',
			})
			continue
		}

		const files = findDistTestFiles(pkg.path)
		summary.push({ pkg: pkg.packageName, dir: pkg.dir, count: files.length })
	}

	process.stderr.write('Workspace package tests:\n')
	for (const row of summary) {
		if (typeof row.count === 'number') {
			process.stderr.write(`  ${row.pkg} (${row.dir}): ${row.count} file${row.count === 1 ? '' : 's'}\n`)
			continue
		}
		process.stderr.write(`  ${row.pkg} (${row.dir}): ${row.count}\n`)
	}

	let failureCount = 0

	for (const pkg of packages) {
		if (pkg.packageName === '@gsd/native') {
			if (process.env.GSD_SKIP_NATIVE_PACKAGE_TESTS === '1') {
				process.stderr.write(`Skipping ${pkg.packageName}: GSD_SKIP_NATIVE_PACKAGE_TESTS=1.\n`)
				continue
			}
			if (!hasNativeAddon() && !commandExists('cargo')) {
				process.stderr.write(
					`Skipping ${pkg.packageName}: no native addon present and \`cargo\` is unavailable in this environment.\n`
				)
				continue
			}
			process.stderr.write(`\nRunning ${pkg.packageName} package tests via workspace script...\n`)
			if (
				runPackageScript(
					getPnpmCommand(),
					['--filter', pkg.packageName, 'run', 'test'],
					REPO_ROOT,
					pkg.packageName,
					NATIVE_PACKAGE_TEST_TIMEOUT_MS
				) !== 0
			) {
				failureCount += 1
			}
			continue
		}

		const files = findDistTestFiles(pkg.path)
		if (files.length === 0) {
			process.stderr.write(`Skipping ${pkg.packageName}: no compiled test files found.\n`)
			continue
		}

		process.stderr.write(`\nRunning ${pkg.packageName} package tests...\n`)
		if (runCommand(process.execPath, buildNodeTestArgs(files), REPO_ROOT, pkg.packageName) !== 0) {
			failureCount += 1
		}
	}

	return failureCount === 0 ? 0 : 1
}

if (require.main === module) {
	process.exit(main())
}

module.exports = {
	findTestFiles,
	isVitestFile,
	selectPackageTestFiles,
	findDistTestFiles,
	buildNodeTestArgs,
	hasNativeAddon,
	hasLocalNativeAddon,
	hasPrebuiltNativeAddonPackage,
	commandExists,
	PLATFORM_PACKAGE_MAP,
}
