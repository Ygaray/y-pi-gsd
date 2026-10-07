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
import { isProvisionalPreToolProse } from "./chat-handoff-filter.js";

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

// ── Task 2: RENDER-02 SC-5 mixed-stream ───────────────────────────────
//
// Structural-then-textual assertion ordering is deliberate and is the
// mechanical arbiter D-03 requires: if the structural ToolExecutionComponent
// instance-count assertion fails, RENDER-02 is a duplicate/orphaned instance
// surviving in chatContainer with no removeChild cleanup (fixed in
// chat-segment-walker.ts). If that assertion PASSES but a textual assertion
// (BODYMARK/ARGSMARK row count) fails, RENDER-02 is body accumulation inside
// tool-execution.ts instead.
test("RENDER-02 SC-5: mixed-stream thinking+text+tool-call+tool-result survives shrink+regrow (RED at HEAD)", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	// Load-bearing: all four content.id / pendingTools lookups below use the
	// literal "tool-sc5-1" (not a shared variable) so the identical-id reuse
	// across the shrink and regrow deltas is grep-verifiable in the file text.

	// 1. Deliver thinking + text + toolCall (three blocks).
	await driveDelta(host, rs, tui, terminal, [
		{ type: "thinking", thinking: "THINKMARK considering the request" },
		{ type: "text", text: "PROSEMARK working on it" },
		{ type: "toolCall", id: "tool-sc5-1", name: "bash", arguments: { command: "echo ARGSMARK" } },
	]);

	// 2. Complete the tool.
	const pendingComponent = host.pendingTools.get("tool-sc5-1");
	assert.ok(pendingComponent, "sanity: the tool call must have registered a pending component");
	pendingComponent!.updateResult({ content: [{ type: "text", text: "BODYMARK line one" }], isError: false });
	tui.requestRender();
	await terminal.waitForRender();

	// 3. Shrink: strictly shorter blocks array that still contains the SAME
	// tool-call block (identical id "tool-sc5-1"), plus one new pre-tool
	// prose block — reusing the identical id exercises
	// registerPendingToolComponent's host.pendingTools.get(toolCallId)
	// existing-match branch.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "NEWPROSE after shrink" },
		{ type: "toolCall", id: "tool-sc5-1", name: "bash", arguments: { command: "echo ARGSMARK" } },
	]);

	// 4. Regrow: longer blocks array restoring thinking, prose, the same
	// tool-call block (id "tool-sc5-1" again), and a trailing ANSWERMARK
	// text block.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "thinking", thinking: "THINKMARK considering the request" },
		{ type: "text", text: "PROSEMARK working on it" },
		{ type: "toolCall", id: "tool-sc5-1", name: "bash", arguments: { command: "echo ARGSMARK" } },
		{ type: "text", text: "ANSWERMARK final answer appended" },
	]);

	// 5. Re-apply the tool result on the regrown component, then render.
	const regrownComponent = host.pendingTools.get("tool-sc5-1");
	assert.ok(regrownComponent, "sanity: the tool component must still be registered after regrow");
	regrownComponent!.updateResult({ content: [{ type: "text", text: "BODYMARK line one" }], isError: false });
	tui.requestRender();
	await terminal.waitForRender();

	const scrollback = terminal.getScrollBuffer();

	// STRUCTURAL first (the D-03 discriminator).
	const toolInstanceCount = chatContainer.children.filter((c) => c instanceof ToolExecutionComponent).length;
	assert.strictEqual(
		toolInstanceCount,
		1,
		`expected exactly one ToolExecutionComponent in chatContainer, observed ${toolInstanceCount}`,
	);

	// TEXTUAL second.
	const bodyCount = countRowsContaining(scrollback, "BODYMARK");
	const argsCount = countRowsContaining(scrollback, "ARGSMARK");
	assert.strictEqual(bodyCount, 1, `expected BODYMARK to appear exactly once, observed ${bodyCount}`);
	assert.strictEqual(argsCount, 1, `expected ARGSMARK to appear exactly once, observed ${argsCount}`);

	// Then the RENDER-01 companions in the same turn.
	const answerCount = countRowsContaining(scrollback, "ANSWERMARK");
	assert.strictEqual(answerCount, 1, `expected ANSWERMARK to appear exactly once, observed ${answerCount}`);
	const textRunSegmentCount = rs.renderedSegments.filter((s) => s.kind === "text-run").length;
	const assistantComponentCount = chatContainer.children.filter((c) => c instanceof AssistantMessageComponent).length;
	assert.strictEqual(
		assistantComponentCount,
		textRunSegmentCount,
		`AssistantMessageComponent count in chatContainer (${assistantComponentCount}) must match tracked text-run segment count (${textRunSegmentCount}) — a mismatch is the orphan leak`,
	);

	tui.stop();
});

// ── Task 3: D-02 Pitfall-10 non-regression ────────────────────────────
//
// This case must be green BOTH at this plan's HEAD and after plan 37-02's
// drain change — a green-to-red transition here means the drain gate lost
// its generational clause (D-02's identity/generation check must gate
// removal ALONGSIDE the isProvisionalPreToolProse content-pattern match,
// never the content-pattern match alone).
test("D-02 Pitfall-10 non-regression: a provisional-sounding final answer is never pruned when no tool call fires", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	// Genuinely satisfies isProvisionalPreToolProse: starts with "Let me
	// check" (a FIRST_PERSON_PROVISIONAL_PRE_TOOL_RE match), does not end in
	// a question mark, and does not invite a user reply.
	const finalAnswer = "Let me check the KEEPMARK settings one more time before finishing.";
	assert.ok(
		isProvisionalPreToolProse(finalAnswer),
		"sanity: the fixture text must genuinely match isProvisionalPreToolProse's pattern so this case cannot silently drift out of the pattern it represents",
	);

	// Drive a turn with NO tool-call block at any point, so
	// getProvisionalPreToolPrunePlan returns shouldPrune: false for the whole
	// lifecycle and firstToolIdx stays -1. Drive a shrink+regrow cycle on a
	// DECOY segment (longer, then strictly shorter, then longer again) so
	// rs.orphanedSegments is genuinely populated and the (at-HEAD-inert,
	// gated-off) drain pass has a real code path to run against — then
	// introduce finalAnswer as a brand-new trailing text run grown onto the
	// regrown decoy component, so finalAnswer itself is never the segment
	// that gets orphaned (it has exactly one rendered occurrence by
	// construction, isolating this case from RENDER-01's own orphan-duplicate
	// defect, which SC-4 already pins independently).
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "DECOY lead-in content" },
		{ type: "thinking", thinking: "DECOYTHINK a thinking block to separate runs" },
	]);
	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "DECOY lead-in content" }]);
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "DECOY lead-in content" },
		{ type: "text", text: finalAnswer },
	]);

	const keepCount = countRowsContaining(terminal.getScrollBuffer(), "KEEPMARK");
	assert.strictEqual(
		keepCount,
		1,
		`KEEPMARK must appear exactly once — neither dropped (Pitfall-10) nor duplicated (RENDER-01), observed ${keepCount}`,
	);

	tui.stop();
});
