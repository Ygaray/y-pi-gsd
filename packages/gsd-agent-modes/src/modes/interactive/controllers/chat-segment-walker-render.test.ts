// gsd-pi — Phase 37 (Streaming Transcript Dedup) regression harness.
//
// Mounts a real TUI over a VirtualTerminal (@xterm/headless) and drives the
// real applySubTurnContentShrink/scanNewContentBlocks/runSegmentWalker
// against a real chatContainer, reading back terminal.getScrollBuffer() for
// assertions. This is the first cross-package consumer of
// packages/pi-tui/test/virtual-terminal.ts outside packages/pi-tui itself
// (D-04) — the relative import below must stay a `.js` extension with
// exactly five `..` segments so it resolves under both the repo-root
// quick-run loader (dist-redirect.mjs rule 3, which rewrites a `.js`
// specifier to its `.ts` sibling only inside a `/src/`-containing path) and
// the dist-test mirror (scripts/compile-tests.mjs, which copies
// packages/pi-tui/test/ into dist-test/packages/pi-tui/test/ as real .js).
//
// Case RENDER-01 SC-4 and RENDER-02 SC-5 are RED BY DESIGN at this plan's
// HEAD — they exist to prove the harness reaches the real defects with an
// observable duplication signal, not to pass. They are turned GREEN by plans
// 37-02 (RENDER-01) and 37-03 (RENDER-02's D-03-diagnosed fix location).

import assert from "node:assert/strict";
import test from "node:test";
import { Container, TUI } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { VirtualTerminal } from "../../../../../pi-tui/test/virtual-terminal.js";
import { applySubTurnContentShrink, runSegmentWalker, scanNewContentBlocks } from "./chat-segment-walker.js";
import { createStreamingRenderState } from "../streaming-render-state.js";
import { AssistantMessageComponent } from "../components/assistant-message.js";
import { ToolExecutionComponent } from "../components/tool-execution.js";

initTheme();

// ── helpers ──────────────────────────────────────────────────────────

/** Mounts a real TUI + chatContainer over a VirtualTerminal. */
function mountVirtualTranscript(cols = 100, rows = 40) {
	const terminal = new VirtualTerminal(cols, rows);
	const tui = new TUI(terminal);
	const chatContainer = new Container();
	tui.addChild(chatContainer);
	tui.start();
	return { terminal, tui, chatContainer };
}

/**
 * Copied in shape from chat-message-end-retry.test.ts's makeMinimalHost, with
 * deltas per Task 1's action spec: `ui` is the REAL tui instance (so
 * requestRender() drives the actual render pipeline), a mutable
 * `streamingMessage` seeded to an empty claude-code assistant message,
 * `hideThinkingBlock: false` (the mixed-stream case needs thinking blocks
 * rendered), and `toolOutputExpanded: true`.
 */
function makeRenderHost(chatContainer: Container, tui: TUI, streamingRenderState = createStreamingRenderState()) {
	return {
		isInitialized: true,
		streamingRenderState,
		streamingMessage: { role: "assistant", provider: "claude-code", content: [] as Array<any> },
		footer: { invalidate() {} },
		settingsManager: {
			getTimestampFormat() {
				return "date-time-iso" as const;
			},
			getShowImages() {
				return false;
			},
		},
		getMarkdownThemeWithSettings() {
			return undefined;
		},
		getRegisteredToolDefinition() {
			return undefined;
		},
		formatWebSearchResult() {
			return "";
		},
		session: { messages: [] as any[], retryAttempt: 0 },
		chatContainer,
		pendingTools: new Map<string, ToolExecutionComponent>(),
		pendingMessagesContainer: { clear() {} },
		pinnedMessageContainer: new Container(),
		statusContainer: new Container(),
		hideThinkingBlock: false,
		toolOutputExpanded: true,
		defaultWorkingMessage: "Working...",
		clearBlockingError() {},
		compactionQueuedMessages: [],
		ui: tui,
		init: async () => {},
		addMessageToChat() {},
		checkShutdownRequested: async () => {},
		rebuildChatFromMessages() {},
		flushCompactionQueue: async () => {},
		showStatus() {},
		showError() {},
		updatePendingMessagesDisplay() {},
		updateTerminalTitle() {},
		updateEditorBorderColor() {},
	};
}

/** How many scrollback rows contain `token`. */
function countRowsContaining(scrollback: string[], token: string): number {
	return scrollback.filter((line) => line.includes(token)).length;
}

/**
 * Drives one streaming delta through the real production order: assign the
 * new content[], shrink-detect, scan new blocks, walk segments, then render
 * and wait for the VirtualTerminal's throttled pipeline to settle.
 */
async function driveDelta(
	host: ReturnType<typeof makeRenderHost>,
	rs: ReturnType<typeof createStreamingRenderState>,
	tui: TUI,
	terminal: VirtualTerminal,
	blocks: Array<any>,
) {
	host.streamingMessage.content = blocks;
	applySubTurnContentShrink(rs, blocks);
	scanNewContentBlocks(host as any, rs, blocks);
	runSegmentWalker(host as any, rs, "date-time-iso");
	tui.requestRender();
	await terminal.waitForRender();
}

// ── Task 1: harness smoke + RENDER-01 SC-4 ────────────────────────────

test("harness: VirtualTerminal transcript mount renders one assistant text block", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "SMOKEMARK hello" }]);

	assert.ok(
		countRowsContaining(terminal.getScrollBuffer(), "SMOKEMARK") >= 1,
		"the smoke fixture's sentinel text must appear in the rendered scroll buffer",
	);
	tui.stop();
});

// This case is expected to FAIL at this plan's HEAD (RED by design) and is
// turned GREEN by plan 37-02's D-01 reclaim-before-replace fix. Do not weaken
// either assertion below to the duplicated count observed at HEAD.
test("RENDER-01 SC-4: collapse+regrow reuses the assistant component (RED at HEAD)", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	// Delta 1: two text blocks, the pure thinking/text turn shape (no tool
	// call anywhere) for which getProvisionalPreToolPrunePlan returns
	// shouldPrune: false for the whole lifecycle (firstToolIdx === -1).
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "GROWTEXT alpha" },
	]);
	const componentAfterDelta1 = rs.renderedSegments.find((s) => s.kind === "text-run")?.component;

	// Delta 2: strictly SHORTER blocks array (one text block, retaining
	// GROWTEXT) — fires the primary shrink branch at chat-segment-walker.ts:36-43
	// (contentBlocks.length < rs.lastContentLength).
	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "GROWTEXT alpha" }]);

	// Delta 3: strictly LONGER array (two blocks) whose GROWTEXT block carries
	// the same prefix plus appended text — the regrow.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "GROWTEXT alpha beta" },
	]);
	const componentAfterDelta3 = rs.renderedSegments.find((s) => s.kind === "text-run")?.component;

	// D-01's reuse-in-place contract in its most direct, non-textual form:
	// the SAME AssistantMessageComponent instance must back the segment
	// before and after the shrink+regrow cycle.
	assert.strictEqual(
		componentAfterDelta3,
		componentAfterDelta1,
		"collapse+regrow must reuse the same AssistantMessageComponent instance, not mint a new one",
	);

	const scrollback = terminal.getScrollBuffer();
	assert.strictEqual(
		countRowsContaining(scrollback, "GROWTEXT"),
		1,
		"GROWTEXT must appear exactly once in scrollback — a duplicate row means the orphaned original was never cleaned up",
	);
	assert.strictEqual(
		chatContainer.children.filter((c) => c instanceof AssistantMessageComponent).length,
		1,
		"exactly one AssistantMessageComponent must remain a live child of chatContainer",
	);

	tui.stop();
});
