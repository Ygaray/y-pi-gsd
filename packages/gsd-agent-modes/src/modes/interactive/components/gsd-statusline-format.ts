// Project/App: gsd-pi
// File Purpose: Shared pure formatters for the interactive TUI's stacked statusline (context/session/
// weekly usage meters, reset countdowns). Threshold values and glyph vocabulary are ported from the
// external, untracked reference implementation `~/.claude/hooks/gsd-statusline.js` (spec reference
// only — never `require()`d, never installed as a dependency, and its raw-escape colouring is
// deliberately NOT ported; every colour here goes through `theme.fg` except the one documented
// `applyBlinkCue` SGR exception).

import { theme, type ThemeColor } from "@gsd/pi-coding-agent/theme/theme.js";
import { renderProgressBar, type StatusTone } from "./transcript-design.js";

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

/**
 * Format the countdown to a rate-limit window reset, ported near-verbatim from the external
 * reference implementation's own pure formatter (it has no colour output to port).
 * Non-finite input on either side yields the empty string; `<= 0` yields `now`; under an hour
 * yields whole minutes with a floor of 1 (`12m`); under a day yields whole hours (`3h`);
 * otherwise whole days (`2d`).
 */
export function formatResetIn(resetsAtEpochSec: number, nowEpochSec: number): string {
	if (!Number.isFinite(resetsAtEpochSec) || !Number.isFinite(nowEpochSec)) return "";
	const secs = resetsAtEpochSec - nowEpochSec;
	if (secs <= 0) return "now";
	if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}m`;
	if (secs < 86400) return `${Math.round(secs / 3600)}h`;
	return `${Math.round(secs / 86400)}d`;
}

/**
 * Render one labelled usage-meter row segment (context/session/weekly), following the UI-SPEC
 * Copywriting Contract: when `window` is present, a dim label + 10-cell bar + colour-tiered percent
 * + an optional `↻{resetIn}` reset countdown; when `window` is `null` (no data source wired yet, or
 * the provider doesn't support rate-limit headers), the dim literal `unavailable` — never a silent
 * gap, per this project's "make failures loud and visible" convention.
 */
export function formatMeterRowSegment(
	label: string,
	window: { usedPercent: number; resetsAtEpochSec: number | null } | null,
	nowEpochSec: number,
): string {
	const labelSegment = theme.fg("dim", `${label}:`);
	if (!window) {
		return `${labelSegment} ${theme.fg("dim", "unavailable")}`;
	}

	const tone = resolveMeterTone(window.usedPercent);
	const bar = renderProgressBar(window.usedPercent, 100, METER_BAR_WIDTH, tone);
	// resolveMeterTone only ever returns success/warning/contextOrange/error — a literal subset of
	// both StatusTone and ThemeColor (RESEARCH Pitfall 3; see the matching cast in footer.ts).
	const pctLabel = theme.fg(tone as ThemeColor, `${Math.round(window.usedPercent)}%`);
	let metric = `${bar} ${pctLabel}`;
	if (tone === "error") metric = applyBlinkCue(metric);

	if (window.resetsAtEpochSec != null) {
		const resetIn = formatResetIn(window.resetsAtEpochSec, nowEpochSec);
		if (resetIn) metric += ` ${theme.fg("dim", `↻${resetIn}`)}`;
	}

	return `${labelSegment} ${metric}`;
}
