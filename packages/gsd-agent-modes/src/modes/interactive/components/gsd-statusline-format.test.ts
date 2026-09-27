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
import { initTheme, loadThemeFromPath, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { builtinThemes } from "@gsd/pi-coding-agent/theme/themes.js";
import { renderProgressBar, type StatusTone } from "./transcript-design.js";
import { applyBlinkCue, formatResetIn, METER_BAR_WIDTH, resolveMeterTone } from "./gsd-statusline-format.js";

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
