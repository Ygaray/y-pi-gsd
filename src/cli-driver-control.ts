import type { DriverControlPort } from '@gsd/agent-modes/modes/interactive/driver-control.js'
import type { DriverStopOutcome } from '@opengsd/contracts'

/**
 * CLI-side implementation of the TUI's DriverControlPort (Phase 42, `/drivers stop`).
 *
 * Bound only in src/cli.ts (the composition root). It maps the operator's stop request 1:1 onto
 * SessionManager.stopRegisteredDriverByDir (Phase 41's registry-first, single-pid stop) and never
 * signals, spawns or reads files itself. The MCP server package is loaded lazily on the first stop,
 * and one SessionManager is reused so its per-worktree lock serializes concurrent stops.
 */

export interface DriverStopSessionManager {
  stopRegisteredDriverByDir(
    projectDir: string,
    opts?: { expectedPid?: number; expectedStartTime?: string },
  ): Promise<{ outcome: DriverStopOutcome; entry?: { pid: number }; error?: string }>
}

export type LoadDriverStopManager = () => Promise<DriverStopSessionManager>

async function loadMcpSessionManager(): Promise<DriverStopSessionManager> {
  const { SessionManager } = await import('@opengsd/mcp-server')
  return new SessionManager()
}

export function createDriverControlPort(load: LoadDriverStopManager = loadMcpSessionManager): DriverControlPort {
  let manager: Promise<DriverStopSessionManager> | undefined

  function getManager(): Promise<DriverStopSessionManager> {
    if (!manager) {
      const pending = load()
      manager = pending
      // A failed load must not be cached: clear it so the next stop retries.
      pending.catch(() => {
        if (manager === pending) manager = undefined
      })
    }
    return manager
  }

  return {
    async stopDriver(projectDir, expect) {
      const sessionManager = await getManager()
      const result = await sessionManager.stopRegisteredDriverByDir(projectDir, {
        expectedPid: expect.pid,
        expectedStartTime: expect.startTime,
      })
      return {
        outcome: result.outcome,
        pid: result.entry?.pid ?? expect.pid,
        ...(result.error !== undefined ? { error: result.error } : {}),
      }
    },
  }
}
