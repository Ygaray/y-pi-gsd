// Project/App: gsd-pi
// File Purpose: `node --test` suite pinning the locked 50/65/80 context-meter thresholds and the
// additive-blink contract for `gsd-statusline-format.ts` (Phase 28 D-02). These assertions fail loudly
// if a future edit drifts either the thresholds or the "blink is a bonus cue, never the sole signal"
// prohibition.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { GitStatusInfo } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { initTheme, loadThemeFromPath, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { builtinThemes } from "@gsd/pi-coding-agent/theme/themes.js";
import { renderProgressBar, type StatusTone } from "./transcript-design.js";
import {
	applyBlinkCue,
	formatGitMarkers,
	formatMilestoneRow,
	formatResetIn,
	METER_BAR_WIDTH,
	resolveMeterTone,
	sanitizeFooterText,
} from "./gsd-statusline-format.js";
import type { GsdPlanningState } from "./gsd-state-reader.js";

before(() => {
	initTheme("dark", false);
});

/** Compose the row-2 context-meter segment exactly as `footer.ts` does. */
function composeContextMeter(percent: number): string {
	const tone = resolveMeterTone(percent);
	const bar = renderProgressBar(percent, 100, METER_BAR_WIDTH, tone as StatusTone);
	const label = theme.fg(tone as Parameters<typeof theme.fg>[0], `${percent}%`);
	let metric = `${bar} ${label}`;
	if (tone === "error") metric = applyBlinkCue(metric);
	return `${theme.fg("dim", "context:")} ${metric}`;
}

describe("resolveMeterTone boundary sweep (locked 50/65/80 thresholds, SC-2)", () => {
	it('resolveMeterTone(49) -> "success"', () => {
		assert.equal(resolveMeterTone(49), "success");
	});

	it('resolveMeterTone(50) -> "warning"', () => {
		assert.equal(resolveMeterTone(50), "warning");
	});

	it('resolveMeterTone(64) -> "warning"', () => {
		assert.equal(resolveMeterTone(64), "warning");
	});

	it('resolveMeterTone(65) -> "contextOrange"', () => {
		assert.equal(resolveMeterTone(65), "contextOrange");
	});

	it('resolveMeterTone(79) -> "contextOrange"', () => {
		assert.equal(resolveMeterTone(79), "contextOrange");
	});

	it('resolveMeterTone(80) -> "error"', () => {
		assert.equal(resolveMeterTone(80), "error");
	});

	it("clamps NaN, -1, and Infinity to success, and treats 1000 as error", () => {
		assert.equal(resolveMeterTone(NaN), "success");
		assert.equal(resolveMeterTone(-1), "success");
		assert.equal(resolveMeterTone(Infinity), "success");
		assert.equal(resolveMeterTone(1000), "error");
	});
});

describe("applyBlinkCue additivity", () => {
	it("wraps text in the SGR-5/SGR-25 pair and is byte-identical once that exact pair is removed", () => {
		const original = theme.fg("error", "80%");
		const wrapped = applyBlinkCue(original);

		assert.ok(wrapped.includes("\x1b[5m"), "expected the blink-start sequence");
		assert.ok(wrapped.includes("\x1b[25m"), "expected the blink-stop sequence");

		const unwrapped = wrapped.replace("\x1b[5m", "").replace("\x1b[25m", "");
		assert.equal(unwrapped, original);
	});
});

describe("blink is a bonus cue, never the sole >=80% signal", () => {
	it("stripped text stays format-consistent across the danger threshold — only the value-derived digits/bar differ", () => {
		const below = stripVTControlCharacters(composeContextMeter(40));
		const above = stripVTControlCharacters(composeContextMeter(85));

		assert.match(below, /^context: [█░]{10} 40%$/);
		assert.match(above, /^context: [█░]{10} 85%$/);
		assert.notEqual(below, above);
	});

	it("the >=80% tier is still distinguishable by colour alone once the blink sequences are removed", () => {
		const above = composeContextMeter(85);
		const blinkStripped = above.replaceAll("\x1b[5m", "").replaceAll("\x1b[25m", "");
		assert.ok(
			blinkStripped.includes(theme.getFgAnsi("error")),
			"expected the error-tier colour to survive removal of just the blink sequences",
		);
	});
});

describe("formatResetIn", () => {
	it("returns the empty string for non-finite input on either side", () => {
		assert.equal(formatResetIn(NaN, 1000), "");
		assert.equal(formatResetIn(1000, NaN), "");
		assert.equal(formatResetIn(Infinity, 1000), "");
	});

	it("returns 'now' at or below zero seconds remaining", () => {
		assert.equal(formatResetIn(1000, 1000), "now");
		assert.equal(formatResetIn(999, 1000), "now");
	});

	it("returns whole minutes, floored at 1, under an hour", () => {
		assert.equal(formatResetIn(1000 + 12 * 60, 1000), "12m");
		assert.equal(formatResetIn(1010, 1000), "1m");
	});

	it("returns whole hours under a day", () => {
		assert.equal(formatResetIn(1000 + 3 * 3600, 1000), "3h");
	});

	it("returns whole days at a day or beyond", () => {
		assert.equal(formatResetIn(1000 + 2 * 86400, 1000), "2d");
	});
});

function gitStatus(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
	return { staged: 0, dirty: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, ...overrides };
}

describe("formatGitMarkers", () => {
	it("returns the empty string for null status", () => {
		assert.equal(formatGitMarkers(null), "");
	});

	it("returns the empty string when every count is zero", () => {
		assert.equal(formatGitMarkers(gitStatus()), "");
	});

	it("renders a single non-zero marker alone", () => {
		const stripped = stripVTControlCharacters(formatGitMarkers(gitStatus({ staged: 2 })));
		assert.equal(stripped, "+2");
	});

	it("renders all five markers in the locked order +N~N?N↑N↓N with no separator", () => {
		const status = gitStatus({ staged: 1, dirty: 3, untracked: 2, ahead: 4, behind: 5 });
		const stripped = stripVTControlCharacters(formatGitMarkers(status));
		assert.equal(stripped, "+1~3?2↑4↓5");
	});

	it("colors each marker with its locked tone", () => {
		const status = gitStatus({ staged: 1, dirty: 3, untracked: 2, ahead: 4, behind: 5 });
		const rendered = formatGitMarkers(status);
		assert.ok(rendered.includes(theme.fg("success", "+1")), "staged should be success-toned");
		assert.ok(rendered.includes(theme.fg("warning", "~3")), "dirty should be warning-toned");
		assert.ok(rendered.includes(theme.fg("error", "?2")), "untracked should be error-toned");
		assert.ok(rendered.includes(theme.fg("success", "↑4")), "ahead should be success-toned");
		assert.ok(rendered.includes(theme.fg("error", "↓5")), "behind should be error-toned");
	});

	it("never emits a checkmark or other clean-state glyph", () => {
		assert.doesNotMatch(formatGitMarkers(gitStatus()), /✓/);
		assert.doesNotMatch(formatGitMarkers(gitStatus({ staged: 1 })), /✓/);
	});

	it("omits a zero count entirely rather than rendering a zero-valued marker", () => {
		const stripped = stripVTControlCharacters(formatGitMarkers(gitStatus({ staged: 1, ahead: 0 })));
		assert.equal(stripped, "+1");
		assert.doesNotMatch(stripped, /↑0/);
	});
});

describe("sanitizeFooterText", () => {
	it("strips CR/LF/TAB and collapses runs of spaces, mirroring footer.ts's sanitizeStatusText", () => {
		assert.equal(sanitizeFooterText("main\r\n\tbranch"), "main branch");
		assert.equal(sanitizeFooterText("a   b"), "a b");
	});

	it("removes the escape character itself, neutralising an embedded escape sequence before theme.fg", () => {
		const malicious = "main\x1b[31mFAKE\x1b[0m";
		const sanitized = sanitizeFooterText(malicious);
		assert.ok(!sanitized.includes("\x1b"), `expected no ESC byte, got: ${JSON.stringify(sanitized)}`);
	});
});

describe("custom-theme fallback (pre-existing theme JSON without contextOrange)", () => {
	it("theme.fg('contextOrange', ...) resolves to the theme's warning colour and never throws", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "gsd-legacy-theme-"));
		const tmpThemePath = join(tmpDir, "legacy.json");
		try {
			// Simulate a custom theme JSON authored before this phase: byte-for-byte the shipped
			// "dark" theme, minus the new optional `contextOrange` key.
			const legacyThemeJson = JSON.parse(JSON.stringify(builtinThemes.dark));
			delete legacyThemeJson.colors.contextOrange;
			writeFileSync(tmpThemePath, JSON.stringify(legacyThemeJson));

			const legacyTheme = loadThemeFromPath(tmpThemePath);

			assert.doesNotThrow(() => legacyTheme.fg("contextOrange", "x"));
			assert.equal(legacyTheme.fg("contextOrange", "x"), legacyTheme.fg("warning", "x"));
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("formatMilestoneRow", () => {
	const IN_FLIGHT_STATE: GsdPlanningState = {
		milestone: "v6",
		milestoneName: "Operator-Surface Finish + Reliability Tail",
		currentPhase: "28",
		status: "planning",
		completedPhases: 0,
		totalPhases: 6,
		percent: 0,
	};

	it("returns the empty string for a null state", () => {
		assert.equal(formatMilestoneRow(null), "");
	});

	it("returns the empty string when the scene cannot be resolved (no current_phase/status signal)", () => {
		const state: GsdPlanningState = {
			milestone: "v6",
			milestoneName: "Test",
			currentPhase: null,
			status: null,
			completedPhases: null,
			totalPhases: null,
			percent: null,
		};
		assert.equal(formatMilestoneRow(state), "");
	});

	it("renders '{version} {name} {10-cell bar} {scene}' for an in-flight state", () => {
		const plain = stripVTControlCharacters(formatMilestoneRow(IN_FLIGHT_STATE));
		assert.equal(plain, "v6 Operator-Surface Finish + Reliability Tail ░░░░░░░░░░ Phase 28 planning");
	});

	it("draws the bar via the shared renderProgressBar 10-cell block-glyph vocabulary at half progress", () => {
		const state: GsdPlanningState = { ...IN_FLIGHT_STATE, completedPhases: 3 };
		const plain = stripVTControlCharacters(formatMilestoneRow(state));
		const barMatch = plain.match(/[█░]{10}/);
		assert.ok(barMatch, `expected a 10-cell bar drawn from the █/░ vocabulary, got: ${plain}`);
		assert.equal(barMatch![0], "█████░░░░░");
	});

	it("falls back to percent out of 100 when phase counts are absent", () => {
		const state: GsdPlanningState = {
			milestone: "v6",
			milestoneName: "Test",
			currentPhase: "28",
			status: "executing",
			completedPhases: null,
			totalPhases: null,
			percent: 50,
		};
		const plain = stripVTControlCharacters(formatMilestoneRow(state));
		const barMatch = plain.match(/[█░]{10}/);
		assert.equal(barMatch![0], "█████░░░░░");
	});

	it("renders the literal 'milestone complete' scene", () => {
		const state: GsdPlanningState = { ...IN_FLIGHT_STATE, completedPhases: 6, percent: 100 };
		const plain = stripVTControlCharacters(formatMilestoneRow(state));
		assert.match(plain, /milestone complete$/);
	});

	it("neutralises an escape sequence embedded in the milestone name before it reaches theme.fg", () => {
		const state: GsdPlanningState = {
			...IN_FLIGHT_STATE,
			milestoneName: "Evil\x1b[31mHACKED\x1b[0mName",
		};
		const row = formatMilestoneRow(state);
		assert.ok(
			!row.includes("\x1b[31mHACKED"),
			`expected the embedded escape sequence to be neutralised, got: ${JSON.stringify(row)}`,
		);
	});

	it("keeps the milestone name uncoloured beyond 'text' (no accent tone reserved for it)", () => {
		const plain = formatMilestoneRow(IN_FLIGHT_STATE);
		const textAnsi = theme.getFgAnsi("text");
		assert.ok(
			plain.includes(textAnsi),
			`expected the milestone name to use the 'text' tone, got: ${JSON.stringify(plain)}`,
		);
	});
});
