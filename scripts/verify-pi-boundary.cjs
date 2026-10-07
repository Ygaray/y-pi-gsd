#!/usr/bin/env node
'use strict'

const { readFileSync, readdirSync, existsSync } = require('fs')
const { join } = require('path')
const PI_SEAM = require('./pi-seam.json')

const ROOT = join(__dirname, '..')
const PI_PACKAGES = ['pi-agent-core', 'pi-ai', 'pi-tui', 'pi-coding-agent']

const FORBIDDEN_IMPORT = /@gsd\/agent-(core|modes)|@opengsd\//
const FORBIDDEN_PATHS = [
  'src/modes',
  'src/cli',
  'src/main.ts',
  'src/core/agent-session.ts',
  'src/core/sdk.ts',
  'src/core/compaction',
  'src/core/compaction-orchestrator.ts',
  'src/core/bash-executor.ts',
  'src/export-html',
]
const ALLOWLIST = new Set([
  join(ROOT, 'packages/pi-coding-agent/src/core/gsd-seam-types.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/gsd-extension-types.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/extensions/loader.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/extensions/types.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/extensions/runner.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/retry-handler.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/retry-handler.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/session-manager.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/tools/bash.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/model-resolver.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/package-commands.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/skill-tool.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/core/skills.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/system-prompt-skill-filter.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/system-prompt-file-safety.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/system-prompt-cache-stability.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/path-display.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/harness.test.ts'),
  join(ROOT, 'packages/pi-coding-agent/src/tests/utilities.test.ts'),
])

function walk(dir, fn) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, fn)
    else if (e.name.endsWith('.ts')) fn(p)
  }
}

const failures = []
for (const pkg of PI_PACKAGES) {
  const src = join(ROOT, 'packages', pkg, 'src')
  walk(src, (file) => {
    if (ALLOWLIST.has(file)) return
    const content = readFileSync(file, 'utf8')
    if (FORBIDDEN_IMPORT.test(content)) {
      failures.push(file.replace(ROOT + '/', ''))
    }
  })
}

if (failures.length) {
  process.stderr.write('Pi boundary violations (GSD imports inside vendored pi packages):\n')
  for (const f of failures) process.stderr.write(`  - ${f}\n`)
  process.exit(1)
}

const pathViolations = []
for (const pkg of PI_PACKAGES) {
  if (pkg !== 'pi-coding-agent') continue
  const pkgRoot = join(ROOT, 'packages', pkg)
  for (const rel of FORBIDDEN_PATHS) {
    const p = join(pkgRoot, rel)
    if (existsSync(p)) pathViolations.push(`packages/${pkg}/${rel}`)
  }
}

if (pathViolations.length) {
  process.stderr.write('Pi seam violations (GSD-owned paths still in pi-coding-agent):\n')
  for (const p of pathViolations) process.stderr.write(`  - ${p}\n`)
  process.exit(1)
}

// WR-02 (35-REVIEW.md): cheap consistency assertion tying pi-seam.json's
// protectedPiCoreFiles to this script's own ALLOWLIST, scoped to the 6 facades
// Phase 35 (EXEC-02) relocated from gsd-agent-core into pi-coding-agent/src/core/.
// NOTE: a general "protected implies never allowlisted" rule is FALSE for this
// repo (several unrelated GSD-authored files, e.g. gsd-seam-types.ts, are both
// protected and legitimately allowlisted for reasons outside this phase) — so
// this check is intentionally narrow, not repo-wide. For exactly these 6 names,
// pi-seam.json protection + ALLOWLIST absence together are what prove the
// relocation is real (no shim exception) and permanent (protected from a future
// upstream vendoring overwrite). Catches a future PR that re-adds one of them to
// ALLOWLIST (reintroducing a shim-shaped exception) while pi-seam.json still
// (correctly) protects it.
const RELOCATED_FACADES = [
  'keybindings.ts',
  'fallback-resolver.ts',
  'lifecycle-hooks.ts',
  'blob-store.ts',
  'artifact-manager.ts',
  'system-prompt.ts',
]
const missingProtection = RELOCATED_FACADES.filter((f) => !PI_SEAM.protectedPiCoreFiles.includes(f))
const staleAllowlisted = RELOCATED_FACADES.filter((f) => ALLOWLIST.has(join(ROOT, 'packages/pi-coding-agent/src/core', f)))
if (missingProtection.length || staleAllowlisted.length) {
  process.stderr.write('Pi seam/boundary drift in Phase 35 relocated facades:\n')
  for (const f of missingProtection) process.stderr.write(`  - ${f}: no longer listed in pi-seam.json protectedPiCoreFiles\n`)
  for (const f of staleAllowlisted) process.stderr.write(`  - ${f}: re-added to ALLOWLIST (shim-shaped exception reintroduced)\n`)
  process.exit(1)
}

process.stderr.write('Pi package boundary check passed.\n')
