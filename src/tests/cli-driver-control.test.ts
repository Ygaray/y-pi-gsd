import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DriverStopOutcome } from '@opengsd/contracts'

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

type StopResult = { outcome: DriverStopOutcome; entry?: { pid: number }; error?: string }

test('maps every SessionManager outcome to the port result and propagates thrown errors', async () => {
  const calls: Array<[string, { expectedPid?: number; expectedStartTime?: string } | undefined]> = []
  const queue: StopResult[] = [
    { outcome: 'stopped', entry: { pid: 99 } },
    { outcome: 'dead-reconciled', entry: { pid: 98 } },
    { outcome: 'kill-failed', entry: { pid: 97 }, error: 'EPERM' },
    { outcome: 'no-entry' },
    { outcome: 'row-changed' },
    { outcome: 'busy' },
  ]
  const expected = [
    { outcome: 'stopped', pid: 99 },
    { outcome: 'dead-reconciled', pid: 98 },
    { outcome: 'kill-failed', pid: 97, error: 'EPERM' },
    { outcome: 'no-entry', pid: 7 },
    { outcome: 'row-changed', pid: 7 },
    { outcome: 'busy', pid: 7 },
  ]
  const port = createDriverControlPort(async () => ({
    async stopRegisteredDriverByDir(projectDir, opts) {
      calls.push([projectDir, opts])
      return queue.shift() as StopResult
    },
  }))
  for (const want of expected) {
    assert.deepEqual(await port.stopDriver('/p', { pid: 7, startTime: 'T' }), want)
  }
  assert.equal(calls.length, expected.length)
  for (const call of calls) {
    assert.deepEqual(call, ['/p', { expectedPid: 7, expectedStartTime: 'T' }])
  }

  const throwing = createDriverControlPort(async () => ({
    async stopRegisteredDriverByDir() {
      throw new Error('registry exploded')
    },
  }))
  await assert.rejects(() => throwing.stopDriver('/p', { pid: 7, startTime: 'T' }), /registry exploded/)
})

test('loads the MCP server lazily and reuses one SessionManager', async () => {
  let loads = 0
  const manager = {
    async stopRegisteredDriverByDir(): Promise<StopResult> {
      return { outcome: 'stopped', entry: { pid: 5 } }
    },
  }
  const port = createDriverControlPort(async () => {
    loads++
    return manager
  })
  assert.equal(loads, 0, 'creating the port must not load the manager')
  await port.stopDriver('/p', { pid: 5, startTime: 'T' })
  await port.stopDriver('/p', { pid: 5, startTime: 'T' })
  assert.equal(loads, 1, 'one load reused across stops')

  let attempts = 0
  const flaky = createDriverControlPort(async () => {
    attempts++
    if (attempts === 1) throw new Error('load failed')
    return manager
  })
  await assert.rejects(() => flaky.stopDriver('/p', { pid: 5, startTime: 'T' }), /load failed/)
  assert.deepEqual(await flaky.stopDriver('/p', { pid: 5, startTime: 'T' }), { outcome: 'stopped', pid: 5 })
  assert.equal(attempts, 2, 'a failed load is retried on the next call')
})
