// Project/App: gsd-pi
// File Purpose: Hand-picked external-driver-plane MCP tool roster and the
// exclusion filter that keeps it off the interactive agent's model-facing
// tool surface (SURF-01).

import { mcpToolMatchesBaseName } from "./mcp-tool-name.js";

/**
 * The 6 external-driver-plane "Session tools" from
 * `packages/mcp-server/src/server.ts:5` ("Session tools (6): gsd_execute,
 * gsd_status, gsd_result, gsd_cancel, gsd_query, gsd_resolve_blocker").
 *
 * Deliberately independent of both `delegation-policy.ts` (a
 * backgroundability verdict covering only `gsd_execute`) and
 * `WORKFLOW_MCP_ADAPTER_TOOL_NAMES` (a 14-entry superset that would
 * over-filter the interactive surface — see 36-CONTEXT.md D-01).
 */
export const DRIVER_PLANE_TOOL_NAMES = [
  "gsd_execute",
  "gsd_status",
  "gsd_result",
  "gsd_cancel",
  "gsd_query",
  "gsd_resolve_blocker",
] as const;

/**
 * True when `toolName` names one of the 6 driver-plane tools, matching
 * either the bare canonical name (`toolName === driverName`) or any
 * `mcp__<server>__`-prefixed form via `mcpToolMatchesBaseName` (server-
 * agnostic — `mcp__any-server__gsd_execute` matches). Per D-02: strict
 * `===` / canonical base-name match only — never `.includes()` or
 * `.startsWith()`, no case folding, no trimming. Mirrors the two-arm shape
 * `hasResolvedWorkflowTool` already uses in register-hooks.ts.
 *
 * The bare-name arm is required, not optional polish: `parseMcpToolName`
 * returns `null` for an unprefixed name, so `mcpToolMatchesBaseName` alone
 * would miss a bare `gsd_execute`, which is reachable through
 * `adjust_tool_set`'s fallback branch.
 */
export function isDriverPlaneToolName(toolName: string): boolean {
  return DRIVER_PLANE_TOOL_NAMES.some(
    (driverName) => toolName === driverName || mcpToolMatchesBaseName(toolName, driverName),
  );
}

/**
 * True when the `PI_GSD_FULL_TOOLS=1` operator escape hatch is set — the
 * uniform "restore literally everything" bypass (D-04). Single definition;
 * relocated here from register-hooks.ts, which re-exports it so
 * `guided-flow.ts`'s existing import path keeps resolving.
 */
export function isFullGsdToolSurfaceRequested(): boolean {
  return process.env.PI_GSD_FULL_TOOLS === "1";
}

/**
 * Removes the 6 driver-plane tools from `toolNames`. Under
 * `PI_GSD_FULL_TOOLS=1` (D-04) returns a shallow, unfiltered copy in input
 * order — the bypass lives inside this helper so the five call sites need
 * no redundant guard. Otherwise a single `Array.prototype.filter` pass:
 * preserves input order, adds no duplicates, does not mutate the input;
 * pure and synchronous.
 */
export function excludeDriverPlaneTools(toolNames: readonly string[]): string[] {
  if (isFullGsdToolSurfaceRequested()) return [...toolNames];
  return toolNames.filter((name) => !isDriverPlaneToolName(name));
}

/**
 * Computes `adjust_tool_set`'s fallback-branch return value — the one
 * bare-return site with no `build*` call to patch into.
 *
 * The length comparison below is the only genuinely new control flow this
 * phase introduces, and is load-bearing: `surfaceReduced`
 * (register-hooks.ts `adjust_tool_set`, computed from alias and browser
 * removal only) cannot be reused to decide this return, because doing so
 * would leave the driver plane advertised whenever no alias/browser tool
 * happened to be present in `providerCompatible`. Comparing the filtered
 * length against the input length instead tells us, independently of
 * `surfaceReduced`, whether the driver-plane subtraction itself removed
 * anything — and forces a defined `{ toolNames }` return whenever it did.
 *
 * Returns a structural `{ toolNames } | undefined` shape (deliberately not
 * importing `AdjustToolSetResult` — keeping this module dependency-light).
 */
export function resolveFallbackToolSetAdjustment(
  providerCompatible: readonly string[],
  surfaceReduced: boolean,
): { toolNames: string[] } | undefined {
  const filtered = excludeDriverPlaneTools(providerCompatible);
  if (filtered.length !== providerCompatible.length) {
    return { toolNames: filtered };
  }
  return surfaceReduced ? { toolNames: [...providerCompatible] } : undefined;
}
