#!/usr/bin/env node
/** vendor-pi-coding-agent-core.cjs — sync pi-coding-agent core/utils from upstream v0.75.5. */
'use strict'

const { cpSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')

const ROOT = join(__dirname, '..')
const UP = join(ROOT, '.cache/pi-upstream/packages/coding-agent/src')
const CORE = join(ROOT, 'packages/pi-coding-agent/src/core')
const UTILS = join(ROOT, 'packages/pi-coding-agent/src/utils')

// WR-02 (35-REVIEW.md): single source of truth — derived from pi-seam.json's
// protectedPiCoreFiles instead of a hand-duplicated literal, so this list and
// scripts/pi-seam.json cannot silently drift apart. scripts/verify-pi-boundary.cjs
// asserts the same list is also a superset-consistent subset of its ALLOWLIST.
const PI_SEAM = require('./pi-seam.json')
const PROTECTED = new Set(PI_SEAM.protectedPiCoreFiles)

function backupProtected() {
  const out = {}
  for (const f of PROTECTED) {
    const p = join(CORE, f)
    if (existsSync(p)) out[f] = readFileSync(p, 'utf8')
  }
  return out
}

function restoreProtected(backups) {
  for (const [f, content] of Object.entries(backups)) {
    writeFileSync(join(CORE, f), content)
  }
}

const backups = backupProtected()
rmSync(CORE, { recursive: true, force: true })
cpSync(join(UP, 'core'), CORE, { recursive: true })
rmSync(UTILS, { recursive: true, force: true })
cpSync(join(UP, 'utils'), UTILS, { recursive: true })

restoreProtected(backups)

// Remove seam-migrated modules from pi-coding-agent core
for (const f of [
  'agent-session.ts',
  'agent-session-services.ts',
  'agent-session-runtime.ts',
  'sdk.ts',
  'compaction-orchestrator.ts',
  'contextual-tips.ts',
  'image-overflow-recovery.ts',
]) {
  const p = join(CORE, f)
  if (existsSync(p)) rmSync(p)
}
const compactionDir = join(CORE, 'compaction')
const exportHtmlDir = join(CORE, 'export-html')
if (existsSync(compactionDir)) rmSync(compactionDir, { recursive: true })
if (existsSync(exportHtmlDir)) rmSync(exportHtmlDir, { recursive: true })

execSync('node scripts/normalize-pi-imports.cjs', { cwd: ROOT, stdio: 'inherit' })
execSync('node scripts/apply-seam.cjs --imports-only', { cwd: ROOT, stdio: 'inherit' })
execSync('node scripts/generate-pi-coding-agent-index.cjs', { cwd: ROOT, stdio: 'inherit' })

process.stderr.write('vendor-pi-coding-agent-core: done\n')
