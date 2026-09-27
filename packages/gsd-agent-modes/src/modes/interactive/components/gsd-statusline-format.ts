// Project/App: gsd-pi
// File Purpose: Shared pure formatters for the interactive TUI's stacked statusline (context/session/
// weekly usage meters, reset countdowns). Threshold values and glyph vocabulary are ported from the
// external, untracked reference implementation `~/.claude/hooks/gsd-statusline.js` (spec reference
// only — never `require()`d, never installed as a dependency, and its raw-escape colouring is
// deliberately NOT ported; every colour here goes through `theme.fg` except the one documented
// `applyBlinkCue` SGR exception).

import type { StatusTone } from "./transcript-design.js";

/** Fixed width, in cells, for every meter this phase renders (context/session/weekly/milestone). */
export const METER_BAR_WIDTH = 10;

/**
 * Resolve a 0-100 percent value to the locked 4-tier status tone (D-02):
 * <50 success, <65 warning, <80 contextOrange, >=80 error.
 * Non-finite (NaN, +/-Infinity) or negative input clamps to "success" and never throws.
 */
export function resolveMeterTone(percent: number): StatusTone {
	if (!Number.isFinite(percent) || percent < 0) return "success";
	if (percent < 50) return "success";
	if (percent < 65) return "warning";
	if (percent < 80) return "contextOrange";
	return "error";
}

/**
 * Wrap already-`theme.fg`-coloured text in the additive SGR-5 (blink start) / SGR-25 (blink stop)
 * pair. This is D-02's one sanctioned raw-escape exception — it never carries the tier's meaning by
 * itself; stripping the two sequences it adds must leave the original (colour-carrying) text intact.
 */
export function applyBlinkCue(text: string): string {
	return `\x1b[5m${text}\x1b[25m`;
}
