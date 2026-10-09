import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Must be set before anything loads the MCP server package: its registry path is computed from GSD_HOME at load.
const gsdHome = mkdtempSync(join(tmpdir(), 'cli-driver-control-home-'))
process.env.GSD_HOME = gsdHome

import { createDriverControlPort } from '../cli-driver-control.js'

test('OBS-01 the cli port stops a real registered process through the real SessionManager', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'cli-driver-control-proj-'))
  const canon = realpathSync.native(projectDir)
  const startTime = new Date(Date.now() - 1000).toISOString()
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    assert.ok(child.pid, 'child spawned')
    const pid = child.pid as number
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not exit within 5s')), 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    mkdirSync(gsdHome, { recursive: true })
    const registryPath = join(gsdHome, 'session-instances.json')
    writeFileSync(
      registryPath,
      JSON.stringify({ [canon]: { sessionId: 'uat-42-06', projectDir: canon, pid, startTime, status: 'running' } }, null, 2),
    )

    const result = await createDriverControlPort().stopDriver(canon, { pid, startTime })
    assert.deepEqual(result, { outcome: 'stopped', pid })
    await exited
    const after = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf-8')) : {}
    assert.equal(after[canon], undefined, 'registry row removed after the process is gone')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(projectDir, { recursive: true, force: true })
  }
})
