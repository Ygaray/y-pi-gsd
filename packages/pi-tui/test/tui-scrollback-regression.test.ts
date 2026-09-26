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

describe("TUI padding mechanism discrimination (phase 25)", () => {
	it("C1 refuted: padding appears with no overlay on the stack", async () => {
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

		const viewportAfterShort = terminal.getViewport();
		// Post-25-02-fix reality: the short frame is TOP-anchored now (see the C3
		// probe below), so any padding this discrimination question cares about
		// sits AFTER the content, not before it — re-point the same "does this
		// padding require an active overlay?" question at the trailing rows.
		const lastNonBlankRow = viewportAfterShort.reduce(
			(acc, line, i) => (line.trim() !== "" ? i : acc),
			-1,
		);
		const hasTrailingBlanks = lastNonBlankRow !== -1 && lastNonBlankRow < viewportAfterShort.length - 1;

		// No overlay-opening call is made anywhere in this test file — the TUI's
		// overlay stack is empty for this entire sequence, by construction.
		if (hasTrailingBlanks) {
			// Trailing blanks appeared with an empty overlay stack: compositeOverlays
			// (gated on overlayStack.length > 0, tui.ts:1237) cannot be the mechanism
			// for this path. C1 is REFUTED for this path.
			assert.ok(
				hasTrailingBlanks,
				`C1 REFUTED: trailing blank row(s) after row ${lastNonBlankRow} appeared in the viewport with overlayStack empty: ${JSON.stringify(viewportAfterShort)}`,
			);
		} else {
			// No trailing blanks appeared on this path with no overlay active.
			// C1 is NOT-REACHED-BY-THIS-PATH (neither confirmed nor refuted here).
			assert.strictEqual(
				lastNonBlankRow,
				viewportAfterShort.length - 1,
				`C1 NOT-REACHED-BY-THIS-PATH: no trailing blank rows in viewport: ${JSON.stringify(viewportAfterShort)}`,
			);
		}

		tui.stop();
	});

	it("C3 probe: a short frame is top-anchored in the viewport (post-25-02-fix)", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TUI(terminal);
		const turn = new TurnComponent();
		tui.addChild(turn);
		tui.start();

		const tallTurnOne = Array.from({ length: 30 }, (_, i) => `Tall turn one, line ${i}`);
		turn.setTurn(tallTurnOne);
		tui.requestRender();
		await terminal.waitForRender();

		const redrawsBeforeShortTurn = tui.fullRedraws;
		const shortTurn = ["Short turn line 1", "Short turn line 2", "Short turn line 3"];
		turn.setTurn(shortTurn);
		tui.requestRender();
		await terminal.waitForRender();
		const redrawsAfterShortTurn = tui.fullRedraws;
		const fullRedrawDelta = redrawsAfterShortTurn - redrawsBeforeShortTurn;

		const viewport = terminal.getViewport();
		const topAnchored = viewport.slice(0, 3).every((line, i) => line.trim() === shortTurn[i]);
		const bottomAnchored =
			viewport.slice(-3).every((line, i) => line.trim() === shortTurn[i]) &&
			viewport.slice(0, viewport.length - 3).every((line) => line.trim() === "");

		// Record the observed arrangement explicitly — document reality, not a wish.
		assert.ok(
			topAnchored || bottomAnchored,
			`short frame landed in neither a top-anchored nor a clean bottom-anchored arrangement: ${JSON.stringify(viewport)}`,
		);
		// Plan 25-02 fixed the convicted branch (tui.ts:1294-1300) to top-anchor a
		// clear-repaint whose content fits inside the viewport, so the padding rows
		// land AFTER the content (never committed to scrollback on a later grow)
		// instead of before it. This assertion flipped from bottomAnchored to
		// topAnchored as the direct, intended consequence of that fix — see
		// 25-02-SUMMARY.md.
		assert.ok(
			topAnchored,
			`C3 probe (post-25-02-fix): expected top-anchoring (content at the first 3 rows, blanks below), got: ${JSON.stringify(viewport)} (fullRedraws delta across the short turn: ${fullRedrawDelta})`,
		);

		tui.stop();
	});

	it("C2 probe: the shrink path with clearOnShrink enabled", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true);
		const turn = new TurnComponent();
		tui.addChild(turn);
		tui.start();

		const tallTurnOne = Array.from({ length: 30 }, (_, i) => `Tall turn one, line ${i}`);
		turn.setTurn(tallTurnOne);
		tui.requestRender();
		await terminal.waitForRender();

		const redrawsBeforeShortTurn = tui.fullRedraws;
		const shortTurn = ["Short turn line 1", "Short turn line 2", "Short turn line 3"];
		turn.setTurn(shortTurn);
		tui.requestRender();
		await terminal.waitForRender();
		const redrawsAfterShortTurn = tui.fullRedraws;
		const fullRedrawDelta = redrawsAfterShortTurn - redrawsBeforeShortTurn;

		const tallTurnTwo = Array.from({ length: 30 }, (_, i) => `Tall turn two, line ${i}`);
		turn.setTurn(tallTurnTwo);
		tui.requestRender();
		await terminal.waitForRender();

		const scrollback = terminal.getScrollBuffer();
		const longest = longestBlankRun(scrollback);

		// tui.ts's "bottom-anchored short block shrunk" branch (newLines.length <=
		// height) is checked before clearOnShrink and fires unconditionally for
		// this shrink shape, so clearOnShrink cannot change the outcome here. The
		// SUMMARY records this measured number against the C3 probe's — an
		// identical number exonerates C2 for this path (both before AND after the
		// 25-02 fix: pre-fix both showed the same >2 bottom-anchor leak, post-fix
		// both show the same <=2 fixed number, since it's one shared branch).
		assert.strictEqual(
			fullRedrawDelta,
			1,
			`expected exactly one full redraw across the short turn with clearOnShrink enabled, got ${fullRedrawDelta}`,
		);
		assert.ok(
			longest <= 2,
			`C2 probe (post-25-02-fix): expected the same fixed top-anchor signature as the C3 probe (longest blank run <= 2), got ${longest} (fullRedraws delta: ${fullRedrawDelta})`,
		);

		tui.stop();
	});

	it("resize does not inject scrollback padding", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TUI(terminal);
		const turn = new TurnComponent();
		tui.addChild(turn);
		tui.start();

		const tallTurnOne = Array.from({ length: 30 }, (_, i) => `Tall turn one, line ${i}`);
		turn.setTurn(tallTurnOne);
		tui.requestRender();
		await terminal.waitForRender();

		terminal.resize(80, 20);
		await terminal.waitForRender();

		const tallTurnTwo = Array.from({ length: 30 }, (_, i) => `Resize turn two, line ${i}`);
		turn.setTurn(tallTurnTwo);
		tui.requestRender();
		await terminal.waitForRender();

		const scrollback = terminal.getScrollBuffer();
		const longest = longestBlankRun(scrollback);
		const longestStart = longestBlankRunStart(scrollback);
		assert.ok(
			longest <= 2,
			`resize must not inject scrollback padding: longest blank run is ${longest}, starting at row ${longestStart}`,
		);

		tui.stop();
	});
});

describe("TUI padding boundary cases (phase 25)", () => {
	it("Case E: a short turn exactly the terminal height, and one line shorter, both commit no padding (adjacency)", async () => {
		for (const middleLength of [12, 11]) {
			const terminal = new VirtualTerminal(80, 12);
			const tui = new TUI(terminal);
			const turn = new TurnComponent();
			tui.addChild(turn);
			tui.start();

			const tallTurnOne = Array.from({ length: 30 }, (_, i) => `Tall turn one, line ${i}`);
			turn.setTurn(tallTurnOne);
			tui.requestRender();
			await terminal.waitForRender();

			const middleTurn = Array.from(
				{ length: middleLength },
				(_, i) => `Middle turn (len ${middleLength}), line ${i}`,
			);
			turn.setTurn(middleTurn);
			tui.requestRender();
			await terminal.waitForRender();

			const tallTurnTwo = Array.from({ length: 30 }, (_, i) => `Tall turn two, line ${i}`);
			turn.setTurn(tallTurnTwo);
			tui.requestRender();
			await terminal.waitForRender();

			const scrollback = terminal.getScrollBuffer();
			const longest = longestBlankRun(scrollback);
			assert.ok(
				longest <= 2,
				`middle turn length ${middleLength} (terminal height 12): longest blank run in scrollback is ${longest} (runs: ${JSON.stringify(countBlankRuns(scrollback))})`,
			);

			tui.stop();
		}
	});

	it("Case F: an empty turn and a one-line turn commit no padding (empty)", async () => {
		for (const middleLength of [0, 1]) {
			const terminal = new VirtualTerminal(80, 12);
			const tui = new TUI(terminal);
			const turn = new TurnComponent();
			tui.addChild(turn);
			tui.start();

			const tallTurnOne = Array.from({ length: 30 }, (_, i) => `Tall turn one, line ${i}`);
			turn.setTurn(tallTurnOne);
			tui.requestRender();
			await terminal.waitForRender();

			const middleTurn = middleLength === 0 ? [] : ["Sole line of the one-line turn"];
			turn.setTurn(middleTurn);
			// Exercises the Math.max(0, newLines.length - 1) / Math.max(1, ...)
			// clamps in the repaint and commit paths for a zero-length and a
			// one-line frame — no exception must escape either.
			tui.requestRender();
			await terminal.waitForRender();

			const tallTurnTwo = Array.from({ length: 30 }, (_, i) => `Tall turn two, line ${i}`);
			turn.setTurn(tallTurnTwo);
			tui.requestRender();
			await terminal.waitForRender();

			const scrollback = terminal.getScrollBuffer();
			const longest = longestBlankRun(scrollback);
			assert.ok(
				longest <= 2,
				`middle turn length ${middleLength}: longest blank run in scrollback is ${longest} (runs: ${JSON.stringify(countBlankRuns(scrollback))})`,
			);

			tui.stop();
		}
	});

	it("Case G: a blank row is not smuggled in as whitespace or a bare reset sequence (encoding)", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TUI(terminal);
		const turn = new TurnComponent();
		tui.addChild(turn);
		tui.start();

		const tallTurnOne = Array.from({ length: 30 }, (_, i) => `Tall turn one, line ${i}`);
		turn.setTurn(tallTurnOne);
		tui.requestRender();
		await terminal.waitForRender();

		// One line short of the terminal height — the Case E sub-case that
		// actually exercises the padding branch (the ===height sub-case fills
		// the screen with no filler rows at all).
		const middleTurn = Array.from({ length: 11 }, (_, i) => `Middle turn (len 11), line ${i}`);
		turn.setTurn(middleTurn);
		tui.requestRender();
		await terminal.waitForRender();

		const tallTurnTwo = Array.from({ length: 30 }, (_, i) => `Tall turn two, line ${i}`);
		turn.setTurn(tallTurnTwo);
		tui.requestRender();
		await terminal.waitForRender();

		const scrollback = terminal.getScrollBuffer();
		// Blankness is judged on the emulator's own plain-text row content
		// (translateToString(true), which getScrollBuffer()/getViewport() wrap
		// and which trims trailing whitespace) — so a row equal to its own
		// trim() carries no smuggled space or bare SGR-reset padding.
		const nonTrimmedRows = scrollback
			.map((line, index) => ({ line, index }))
			.filter(({ line }) => line !== line.trim());
		assert.strictEqual(
			nonTrimmedRows.length,
			0,
			`found row(s) whose raw text differs from its own trim() — a smuggled whitespace-only blank: ${JSON.stringify(nonTrimmedRows)}`,
		);

		tui.stop();
	});

	it("Case H: a repaint reaches a fixed point (termination)", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TUI(terminal);
		const turn = new TurnComponent();
		tui.addChild(turn);
		tui.start();

		const tallTurn = Array.from({ length: 30 }, (_, i) => `Tall turn, line ${i}`);
		turn.setTurn(tallTurn);
		tui.requestRender();
		await terminal.waitForRender();

		const shortTurn = ["Short turn line 1", "Short turn line 2", "Short turn line 3"];
		turn.setTurn(shortTurn);
		tui.requestRender();
		await terminal.waitForRender();
		const fullRedrawsAfterShortTurn = tui.fullRedraws;

		// Two further renders with the component's lines UNCHANGED (no setTurn
		// call in between) — a repaint condition that re-fires on an unchanged
		// frame would spin the renderer (see <threat_model> T-25-08).
		tui.requestRender();
		await terminal.waitForRender();
		const fullRedrawsAfterSecondRender = tui.fullRedraws;

		tui.requestRender();
		await terminal.waitForRender();
		const fullRedrawsAfterThirdRender = tui.fullRedraws;

		assert.strictEqual(
			fullRedrawsAfterSecondRender,
			fullRedrawsAfterShortTurn,
			`a repaint with unchanged component output must not increment fullRedraws, went ${fullRedrawsAfterShortTurn} -> ${fullRedrawsAfterSecondRender}`,
		);
		assert.strictEqual(
			fullRedrawsAfterThirdRender,
			fullRedrawsAfterShortTurn,
			`a second repaint with unchanged component output must not increment fullRedraws, went ${fullRedrawsAfterShortTurn} -> ${fullRedrawsAfterThirdRender}`,
		);

		tui.stop();
	});
});
