// Project/App: gsd-pi
// File Purpose: TUI-side port for stopping a registered y-pi-gsd driver (Phase 42, RD-RESEARCH-OPEN 2).

import type { DriverStopOutcome, DriverStopResult } from "@opengsd/contracts";

export type { DriverStopOutcome, DriverStopResult };

/**
 * The TUI's only way to stop a driver.
 *
 * Implemented by the composition root (src/cli.ts) over SessionManager.stopRegisteredDriverByDir
 * (Phase 41 registry-first, single-pid stop). This package never imports the MCP server package; the
 * port is types-only from @opengsd/contracts. It is undefined in entry points that do not bind it, where
 * `/drivers stop` must say so loudly. A rejected promise means the stop could not be attempted.
 */
export interface DriverControlPort {
	stopDriver(projectDir: string, expect: { pid: number; startTime: string }): Promise<DriverStopResult>;
}
