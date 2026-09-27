// Project/App: gsd-pi
// File Purpose: Shared pure formatters for the interactive TUI's stacked statusline (context/session/
// weekly usage meters, reset countdowns). Threshold values and glyph vocabulary are ported from the
// external, untracked reference implementation `~/.claude/hooks/gsd-statusline.js` (spec reference
// only — never `require()`d, never installed as a dependency, and its raw-escape colouring is
// deliberately NOT ported; every colour here goes through `theme.fg` except the one documented
// `applyBlinkCue` SGR exception).

import type { GitStatusInfo } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { formatGsdStateScene, type GsdPlanningState } from "./gsd-state-reader.js";
import { renderProgressBar, toneColor, type StatusTone } from "./transcript-design.js";

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
 * Sanitize free-form text before it is interpolated into a terminal write (T-28-05) — a shared
 * version of `footer.ts`'s `sanitizeStatusText` scrub, widened to also remove the escape character
 * itself (not just CR/LF/TAB), so an embedded ANSI/SGR escape sequence is neutralised into inert
 * plain text rather than reaching the terminal as a live escape.
 */
export function sanitizeFooterText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/\x1b/g, "")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Render the git dirty/staged/untracked/ahead/behind markers for footer row 1 (D-01/D-02, UI-SPEC
 * "Git status marker tones"). Emits only the markers whose count is non-zero, in the fixed order
 * staged/dirty/untracked/ahead/behind, with no separator between them. Returns the empty string
 * when `status` is `null` or every count is zero — per the UI-SPEC Color table, a clean/in-sync
 * tree is signalled by absence, never a `✓` glyph. The `conflicts` count is captured by
 * `FooterDataProvider` (Task 1) but has no marker of its own this phase (see UI-SPEC's locked
 * marker table — only staged/dirty/untracked/ahead/behind are listed).
 */
export function formatGitMarkers(status: GitStatusInfo | null): string {
	if (!status) return "";
	const parts: string[] = [];
	if (status.staged) parts.push(theme.fg("success", `+${status.staged}`));
	if (status.dirty) parts.push(theme.fg("warning", `~${status.dirty}`));
	if (status.untracked) parts.push(theme.fg("error", `?${status.untracked}`));
	if (status.ahead) parts.push(theme.fg("success", `↑${status.ahead}`));
	if (status.behind) parts.push(theme.fg("error", `↓${status.behind}`));
	return parts.join("");
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
	// IN-01: route the percent label through the same toneColor() remap the bar fill uses (instead
	// of casting the tone literal directly to ThemeColor), so the two can never diverge for a tone
	// whose remap isn't the identity (e.g. "error" -> "toolError") in a custom theme.
	const pctLabel = theme.fg(toneColor(tone), `${Math.round(window.usedPercent)}%`);
	let metric = `${bar} ${pctLabel}`;
	if (tone === "error") metric = applyBlinkCue(metric);

	if (window.resetsAtEpochSec != null) {
		const resetIn = formatResetIn(window.resetsAtEpochSec, nowEpochSec);
		if (resetIn) metric += ` ${theme.fg("dim", `↻${resetIn}`)}`;
	}

	return `${labelSegment} ${metric}`;
}

/**
 * Resolve the milestone progress bar's done/total pair (SL-02, D-04's locked "Progress bar source"
 * clause): prefer `completedPhases`/`totalPhases` when both are present and `totalPhases` is
 * positive; otherwise fall back to `percent` out of 100 (defaulting to 0 when even that is absent),
 * so a state missing phase counts still renders a bar rather than nothing.
 */
function resolveMilestoneBarSegment(state: GsdPlanningState): string {
	if (state.totalPhases !== null && state.totalPhases > 0 && state.completedPhases !== null) {
		return renderProgressBar(state.completedPhases, state.totalPhases, METER_BAR_WIDTH, "success");
	}
	return renderProgressBar(state.percent ?? 0, 100, METER_BAR_WIDTH, "success");
}

/**
 * Render footer row 3 — the milestone/phase line (SL-02, ROADMAP SC-4): `{version} {name} {bar}
 * {scene}`. Returns the empty string for a `null` state or a state whose scene is `null` (per
 * `formatGsdStateScene`'s own "row 3 is omitted entirely, never blank" contract) — the caller
 * (`footer.ts`) treats an empty string as "do not render this row at all". Every STATE.md-sourced
 * string (version, name, scene) is routed through `sanitizeFooterText` before colouring (T-28-11) —
 * `.planning/STATE.md` is a repository file and a cloned repo can carry escape sequences in it. The
 * milestone name stays uncoloured beyond `text` — the UI-SPEC Color contract reserves accent tones
 * for the meters and the git markers only, never the milestone name.
 */
export function formatMilestoneRow(state: GsdPlanningState | null): string {
	if (!state) return "";
	const scene = formatGsdStateScene(state);
	if (scene === null) return "";

	const bar = resolveMilestoneBarSegment(state);
	const parts: string[] = [];
	if (state.milestone) parts.push(theme.fg("text", sanitizeFooterText(state.milestone)));
	if (state.milestoneName) parts.push(theme.fg("text", sanitizeFooterText(state.milestoneName)));
	parts.push(bar);
	parts.push(theme.fg("dim", sanitizeFooterText(scene)));

	return parts.join(" ");
}
