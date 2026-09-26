import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Plain-text visible prefix of the assistant header line. Composed in
// packages/gsd-agent-modes/src/modes/interactive/components/assistant-message.ts:11-14
// from CHAT_CORNER_TOP_LEFT (transcript-design.ts:368) plus the literal label
// and a middle-dot separator. Declared locally (not imported) because
// @gsd/agent-modes is downstream of @gsd/pi-tui — pi-tui must not import it.
const BANNER_PREFIX = "╭─ GSD · ";

/** Minimal test double: replays whatever `lines` currently holds. */
class TurnComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
	setTurn(lines: string[]): void {
		this.lines = lines;
	}
}

/** Number of entries whose trimmed text starts with `needle`. */
function countOccurrences(lines: string[], needle: string): number {
	return lines.filter((line) => line.trim().startsWith(needle)).length;
}

/** Lengths of every maximal run of entries whose trimmed text is empty. */
function countBlankRuns(lines: string[]): number[] {
	const runs: number[] = [];
	let current = 0;
	for (const line of lines) {
		if (line.trim() === "") {
			current += 1;
		} else if (current > 0) {
			runs.push(current);
			current = 0;
		}
	}
	if (current > 0) runs.push(current);
	return runs;
}

/** The longest blank run, or 0 when there is none. */
function longestBlankRun(lines: string[]): number {
	const runs = countBlankRuns(lines);
	return runs.length === 0 ? 0 : Math.max(...runs);
}

/** Row index (into `lines`) where the longest blank run starts, or -1 when there is none. */
function longestBlankRunStart(lines: string[]): number {
	const longest = longestBlankRun(lines);
	if (longest === 0) return -1;
	let currentLength = 0;
	let currentStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === "") {
			if (currentLength === 0) currentStart = i;
			currentLength += 1;
			if (currentLength === longest) return currentStart;
		} else {
			currentLength = 0;
		}
	}
	return currentStart;
}

describe("TUI scrollback regression (phase 25)", () => {
	it("a turn's banner reaches scrollback exactly once across a multi-flush stream", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TUI(terminal);
		const turn = new TurnComponent();
		tui.addChild(turn);
		tui.start();
		await terminal.waitForRender();

		const bannerLine = `${BANNER_PREFIX}claude-sonnet-5`;
		const proseFlushes = [
			"Working on the request.",
			"Working on the request. Gathering more context as it streams in.",
			"Working on the request. Gathering more context as it streams in. Composing the final answer.",
		];
		for (const prose of proseFlushes) {
			turn.setTurn([bannerLine, prose]);
			tui.requestRender();
			await terminal.waitForRender();
		}

		// Drive a tall tool-output block so content exceeds the 12-row terminal
		// and real scrollback is created, then flush once more.
		const toolLines = Array.from({ length: 20 }, (_, i) => `tool output line ${i}`);
		turn.setTurn([bannerLine, proseFlushes.at(-1) as string, ...toolLines]);
		tui.requestRender();
		await terminal.waitForRender();

		turn.setTurn([bannerLine, proseFlushes.at(-1) as string, ...toolLines, "done."]);
		tui.requestRender();
		await terminal.waitForRender();

		const scrollback = terminal.getScrollBuffer();
		const occurrences = countOccurrences(scrollback, BANNER_PREFIX);
		const occurrenceRows = scrollback
			.map((line, index) => (line.trim().startsWith(BANNER_PREFIX) ? index : -1))
			.filter((index) => index !== -1);
		assert.strictEqual(
			occurrences,
			1,
			`expected the banner to reach scrollback exactly once, got ${occurrences} occurrence(s) at rows ${JSON.stringify(occurrenceRows)}`,
		);

		tui.stop();
	});

	it("an empty turn and a single-flush turn commit the exact banner count they emitted", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TUI(terminal);
		const turn = new TurnComponent();
		tui.addChild(turn);
		turn.setTurn([]);
		tui.start();
		await terminal.waitForRender();

		let scrollback = terminal.getScrollBuffer();
		const emptyTurnBanners = countOccurrences(scrollback, BANNER_PREFIX);
		assert.strictEqual(emptyTurnBanners, 0, `an empty turn must commit zero banners, got ${emptyTurnBanners}`);
		// Measured (not assumed): a virgin 80x12 VirtualTerminal already reports
		// getScrollBuffer().length === 12, all-blank, BEFORE any write — that floor
		// is a property of the underlying xterm.js buffer (it always holds at least
		// `rows` lines), not something the TUI renderer "commits". longestBlankRun
		// therefore cannot be 0 for any render on this harness, empty or not; the
		// meaningful measurement for a zero-line turn is that it produces NO
		// scrollback GROWTH beyond that inherent floor and introduces no non-blank
		// content — i.e. nothing was actually written to the terminal.
		assert.strictEqual(
			scrollback.length,
			terminal.rows,
			`an empty turn must not grow the buffer past the terminal's own row count, got length ${scrollback.length} (rows=${terminal.rows})`,
		);
		assert.ok(
			scrollback.every((line) => line.trim() === ""),
			`an empty turn's buffer must remain entirely blank, got: ${JSON.stringify(scrollback)}`,
		);

		const bannerLine = `${BANNER_PREFIX}claude-sonnet-5`;
		const firstTurnProse = "First turn, single flush.";
		turn.setTurn([bannerLine, firstTurnProse]);
		tui.requestRender();
		await terminal.waitForRender();

		scrollback = terminal.getScrollBuffer();
		const singleFlushBanners = countOccurrences(scrollback, BANNER_PREFIX);
		assert.strictEqual(
			singleFlushBanners,
			1,
			`a single-flush turn must commit exactly one banner, got ${singleFlushBanners}`,
		);
		const blankRunCountBeforeSecondTurn = countBlankRuns(scrollback).length;

		const secondTurnFirstLine = "Second turn starts here, no separator.";
		turn.setTurn([bannerLine, firstTurnProse, secondTurnFirstLine, "Second turn continues."]);
		tui.requestRender();
		await terminal.waitForRender();

		scrollback = terminal.getScrollBuffer();
		const firstTurnLineCount = scrollback.filter((line) => line.trim() === firstTurnProse).length;
		const secondTurnLineCount = scrollback.filter((line) => line.trim() === secondTurnFirstLine).length;
		assert.strictEqual(
			firstTurnLineCount,
			1,
			`the first turn's distinct last line must appear exactly once, got ${firstTurnLineCount}`,
		);
		assert.strictEqual(
			secondTurnLineCount,
			1,
			`the second turn's distinct first line must appear exactly once, got ${secondTurnLineCount}`,
		);
		const blankRunCountAfterSecondTurn = countBlankRuns(scrollback).length;
		assert.strictEqual(
			blankRunCountAfterSecondTurn,
			blankRunCountBeforeSecondTurn,
			`adjacent turns must not acquire a separator blank run the component tree did not emit (before=${blankRunCountBeforeSecondTurn}, after=${blankRunCountAfterSecondTurn})`,
		);

		tui.stop();
	});

	it("a tall turn followed by a short turn does not bake blank padding into scrollback", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TUI(terminal);
		const turn = new TurnComponent();
		tui.addChild(turn);
		tui.start();

		const tallTurnOne = Array.from({ length: 30 }, (_, i) => `Tall turn one, line ${i}`);
		turn.setTurn(tallTurnOne);
		tui.requestRender();
		await terminal.waitForRender();

		const shortTurn = ["Short turn line 1", "Short turn line 2", "Short turn line 3"];
		turn.setTurn(shortTurn);
		tui.requestRender();
		await terminal.waitForRender();

		// Whatever the short frame left on screen is scrolled up into scrollback
		// once a second tall turn pushes past the viewport again.
		const tallTurnTwo = Array.from({ length: 30 }, (_, i) => `Tall turn two, line ${i}`);
		turn.setTurn(tallTurnTwo);
		tui.requestRender();
		await terminal.waitForRender();

		const scrollback = terminal.getScrollBuffer();
		const longest = longestBlankRun(scrollback);
		const longestStart = longestBlankRunStart(scrollback);
		// IMPORTANT: this case is expected to FAIL at HEAD — that is the point.
		// The component tree emitted zero blank lines in this whole sequence, so
		// any blank run at all is renderer-injected; the bound of 2 is deliberate
		// slack for the terminal's own line accounting, not a tolerance for padding.
		assert.ok(
			longest <= 2,
			`longest blank run in scrollback is ${longest}, starting at row ${longestStart} (runs: ${JSON.stringify(countBlankRuns(scrollback))})`,
		);

		tui.stop();
	});
});
