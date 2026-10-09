// Project/App: gsd-pi
// File Purpose: Shared shape of y-pi-gsd's driver session registry (`$GSD_HOME/session-instances.json`),
// written by mcp-server (the single writer) and read by gsd-agent-modes (the read-only TUI), plus the
// typed stop vocabulary both sides share. Types only: consumers load this through Node type stripping
// and must never need this package's dist at runtime.

/**
 * The death record of a driver, consumed by Phase 42's died-with-reason
 * widget. `reason` is a short human-readable string built ONLY from the exit
 * code/signal or a fixed reconcile phrase - never stderr, prompt text, or
 * agent output.
 */
export interface SessionExitRecord {
	reason: string;
	code: number | null;
	signal: string | null;
	/** ISO timestamp of when the exit was observed. */
	at: string;
}

export interface SessionRegistryEntry {
	sessionId: string;
	projectDir: string;
	pid: number;
	/** ISO timestamp recorded when we learned the child's pid. */
	startTime: string;
	/**
	 * Values used from Phase 41 on: 'starting' (registered right after
	 * start() resolves, before init), 'running', 'exited' (death tombstone).
	 */
	status: string;
	/**
	 * `process.pid` of the MCP server that spawned the driver. Advisory only -
	 * never authorises a signal. Optional so pre-Phase-41 rows stay valid.
	 */
	ownerPid?: number;
	/** Present only on a death tombstone. */
	exit?: SessionExitRecord;
}

export type SessionRegistry = Record<string, SessionRegistryEntry>;

/**
 * Outcome of a registry-first, pid-targeted driver stop.
 * - stopped: death confirmed and the row removed.
 * - dead-reconciled: the pid was already dead/recycled or the row already a tombstone; nothing signalled.
 * - kill-failed: the signal failed; the row is kept for a retry.
 * - no-entry: no row exists for the worktree.
 * - row-changed: the row's pid or startTime differs from what the caller expected; nothing signalled.
 * - busy: a start, reap or stop holds the per-worktree lock; nothing signalled.
 */
export type DriverStopOutcome =
	| "stopped"
	| "dead-reconciled"
	| "kill-failed"
	| "no-entry"
	| "row-changed"
	| "busy";

export interface DriverStopResult {
	outcome: DriverStopOutcome;
	pid?: number;
	error?: string;
}
