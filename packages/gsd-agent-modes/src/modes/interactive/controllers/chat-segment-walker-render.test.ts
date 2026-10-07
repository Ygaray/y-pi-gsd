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

// ── Phase 37 Plan 02, Task 2: D-01 reclaim-before-replace tests 2-6 ───

test("D-01 Test 2: reclaimed component is not re-added to chatContainer (no duplicate addChild)", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "GROWTEXT alpha" },
	]);
	const component = rs.renderedSegments.find((s) => s.kind === "text-run")?.component;
	assert.ok(component, "sanity: delta 1 must render a text-run component");

	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "GROWTEXT alpha" }]);
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "GROWTEXT alpha beta" },
	]);

	const occurrences = chatContainer.children.filter((c) => c === component).length;
	assert.strictEqual(
		occurrences,
		1,
		"the reclaimed component must be a child of chatContainer exactly once — reclaim must never call addChild on a component that is already a live child",
	);

	tui.stop();
});

test("D-01 Test 3: reclaimed component's range reflects the regrown startIndex/endIndex (not truncated)", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "GROWTEXT alpha" },
	]);
	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "GROWTEXT alpha" }]);
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "GROWTEXT alpha beta" },
	]);

	const scrollback = terminal.getScrollBuffer();
	assert.ok(
		countRowsContaining(scrollback, "GROWTEXT alpha beta") >= 1,
		"the fully regrown text must appear in scrollback — truncation at the pre-shrink length means setRange()/updateContent() did not run on the reclaimed component",
	);

	tui.stop();
});

test("D-01 Test 4 (P-02): shrink orphaning both a thinking run and a text run never cross-reclaims across contentType", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	// Delta 1: thinking@0 + text@1 — two distinct text-run segments.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "thinking", thinking: "THINKSENTINEL alpha" },
		{ type: "text", text: "TEXTSENTINEL alpha" },
	]);
	const thinkingComponentBefore = rs.renderedSegments.find((s) => s.kind === "text-run" && s.contentType === "thinking")?.component;
	const textComponentBefore = rs.renderedSegments.find((s) => s.kind === "text-run" && s.contentType === "text")?.component;
	assert.ok(thinkingComponentBefore, "sanity: delta 1 must render a thinking text-run");
	assert.ok(textComponentBefore, "sanity: delta 1 must render a text text-run");
	assert.notStrictEqual(thinkingComponentBefore, textComponentBefore, "sanity: thinking and text components must be distinct");

	// Delta 2: shrink to ONE block (thinking only) — strictly shorter (1 < 2),
	// fires the primary shrink branch, orphaning BOTH segments. The orphan
	// array is then [thinkingOrphan, textOrphan] in that order (push order
	// mirrors rs.renderedSegments' creation order) — textOrphan is LAST, so an
	// end-backwards scan that ignored contentType would wrongly reclaim it for
	// this thinking-only desired segment. The contentType gate must skip it
	// and find thinkingOrphan instead.
	await driveDelta(host, rs, tui, terminal, [{ type: "thinking", thinking: "THINKSENTINEL alpha" }]);

	// Delta 3: regrow to thinking@0 + text@1, same original shape — the text
	// segment (still orphaned, untouched by delta 2) must now be reclaimed.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "thinking", thinking: "THINKSENTINEL alpha" },
		{ type: "text", text: "TEXTSENTINEL alpha" },
	]);

	const thinkingComponentAfter = rs.renderedSegments.find((s) => s.kind === "text-run" && s.contentType === "thinking")?.component;
	const textComponentAfter = rs.renderedSegments.find((s) => s.kind === "text-run" && s.contentType === "text")?.component;

	assert.strictEqual(
		thinkingComponentAfter,
		thinkingComponentBefore,
		"the thinking segment's component must never be displaced by the text reclaim",
	);
	assert.strictEqual(
		textComponentAfter,
		textComponentBefore,
		"the text segment must be reclaimed from its own orphan, never minted fresh nor cross-reclaimed from the thinking orphan",
	);
	assert.notStrictEqual(
		thinkingComponentAfter,
		textComponentAfter,
		"P-02: a thinking orphan must never be reclaimed for a text desired segment, or the reverse",
	);

	const scrollback = terminal.getScrollBuffer();
	assert.strictEqual(countRowsContaining(scrollback, "THINKSENTINEL"), 1, "THINKSENTINEL must appear exactly once");
	assert.strictEqual(countRowsContaining(scrollback, "TEXTSENTINEL"), 1, "TEXTSENTINEL must appear exactly once");

	tui.stop();
});

test("D-01 Test 5: an empty rs.orphanedSegments leaves the append loop minting exactly as at HEAD (no-op, not a throw)", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	assert.strictEqual(rs.orphanedSegments.length, 0, "sanity: no orphans exist before the first delta");

	await assert.doesNotReject(async () => {
		await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "FRESHMARK no orphan to reclaim" }]);
	});

	assert.strictEqual(
		countRowsContaining(terminal.getScrollBuffer(), "FRESHMARK"),
		1,
		"a fresh segment with no orphan candidates must still mint and render normally",
	);

	tui.stop();
});

test("D-01 Test 6: a reclaimed segment is removed from rs.orphanedSegments and present in rs.renderedSegments", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "GROWTEXT alpha" },
	]);
	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "GROWTEXT alpha" }]);
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "GROWTEXT alpha beta" },
	]);

	assert.strictEqual(
		rs.orphanedSegments.length,
		0,
		"the reclaimed segment must be spliced out of rs.orphanedSegments by reclaimOrphanedTextRun itself",
	);
	assert.ok(
		rs.renderedSegments.some((s) => s.kind === "text-run" && s.contentType === "text"),
		"the reclaimed segment must be present in rs.renderedSegments so Task 3's drain can never remove a component that is live again",
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

// ── Phase 37 Plan 02, Task 3: unconditional generation-gated drain (D-02, SC-2) ──
//
// These tests construct rs.orphanedSegments/rs.renderedSegments directly
// (rather than deriving them purely through multi-delta shrink/regrow
// arithmetic) so each case pins ONE specific drain behavior precisely —
// runSegmentWalker and the drain helper it calls are the real production
// code under test; only the setup is synthetic.

test("D-02 Test 1 (SC-2): a pure thinking/text turn leaves zero orphaned components live — a generationally-superseded orphan is drained", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);
	host.streamingMessage.content = [
		{ type: "thinking", thinking: "MIDTHINK content" },
		{ type: "text", text: "GAMMA NEW content" },
	];

	// A stale text orphan from an earlier shrink (generation 1) that was never
	// reclaimed because the pass that reclaimed the sibling thinking orphan had
	// no text desired segment that round.
	const orphanComponent = new AssistantMessageComponent(
		undefined,
		host.hideThinkingBlock,
		host.getMarkdownThemeWithSettings(),
		"date-time-iso",
		{ startIndex: 0, endIndex: 0 },
	);
	host.chatContainer.addChild(orphanComponent);
	rs.orphanedSegments = [
		{
			kind: "text-run",
			startIndex: 0,
			endIndex: 0,
			contentType: "text",
			component: orphanComponent,
			cachedText: "ALPHA stale content",
			cachedTextLength: 19,
			orphanedAtGeneration: 1,
		},
	];

	// The current live turn: a thinking segment and a text segment, both
	// reclaimed/minted at a LATER generation (2) than the stale orphan above.
	const thinkingComponent = new AssistantMessageComponent(
		undefined,
		host.hideThinkingBlock,
		host.getMarkdownThemeWithSettings(),
		"date-time-iso",
		{ startIndex: 0, endIndex: 0 },
	);
	host.chatContainer.addChild(thinkingComponent);
	const textComponent = new AssistantMessageComponent(
		undefined,
		host.hideThinkingBlock,
		host.getMarkdownThemeWithSettings(),
		"date-time-iso",
		{ startIndex: 1, endIndex: 1 },
	);
	host.chatContainer.addChild(textComponent);
	rs.renderedSegments = [
		{
			kind: "text-run",
			startIndex: 0,
			endIndex: 0,
			contentType: "thinking",
			component: thinkingComponent,
			cachedText: "MIDTHINK content",
			cachedTextLength: 17,
			createdAtGeneration: 2,
		},
		{
			kind: "text-run",
			startIndex: 1,
			endIndex: 1,
			contentType: "text",
			component: textComponent,
			cachedText: "GAMMA NEW content",
			cachedTextLength: 18,
			createdAtGeneration: 2,
		},
	];
	rs.lastContentLength = 2;
	rs.shrinkGeneration = 2;

	runSegmentWalker(host as any, rs, "date-time-iso");

	assert.strictEqual(
		rs.orphanedSegments.length,
		0,
		"Condition A (superseded-slot) must drain the stale text orphan — a live text-run of the same contentType exists at a strictly later generation",
	);
	const assistantComponentCount = chatContainer.children.filter((c) => c instanceof AssistantMessageComponent).length;
	const textRunSegmentCount = rs.renderedSegments.filter((s) => s.kind === "text-run").length;
	assert.strictEqual(
		assistantComponentCount,
		textRunSegmentCount,
		"zero orphaned components must remain live in chatContainer — count must equal tracked text-run segments (SC-2)",
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

test("D-02 Test 3 (P-01): an orphan neither superseded nor provisional-matching is retained, never dropped", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);
	host.streamingMessage.content = [];

	const orphanComponent = new AssistantMessageComponent(
		undefined,
		host.hideThinkingBlock,
		host.getMarkdownThemeWithSettings(),
		"date-time-iso",
		{ startIndex: 0, endIndex: 0 },
	);
	host.chatContainer.addChild(orphanComponent);
	const plainText = "plain content, nothing special here, no supersession, no provisional pattern";
	assert.ok(!isProvisionalPreToolProse(plainText), "sanity: fixture text must NOT match isProvisionalPreToolProse");
	const orphanSeg = {
		kind: "text-run" as const,
		startIndex: 0,
		endIndex: 0,
		contentType: "text" as const,
		component: orphanComponent,
		cachedText: plainText,
		cachedTextLength: plainText.length,
		orphanedAtGeneration: 1,
	};
	rs.orphanedSegments = [orphanSeg];
	rs.shrinkGeneration = 1;

	runSegmentWalker(host as any, rs, "date-time-iso");

	assert.strictEqual(rs.orphanedSegments.length, 1, "an orphan matching neither condition must be retained, never dropped (P-01)");
	assert.strictEqual(rs.orphanedSegments[0], orphanSeg, "the retained entry must be the same object, untouched");
	assert.ok(chatContainer.children.includes(orphanComponent), "the orphan's component must remain a live child of chatContainer");

	tui.stop();
});

test("D-02 Test 4: an empty rs.orphanedSegments makes the drain a no-op, not a throw", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);
	host.streamingMessage.content = [{ type: "text", text: "SOLO content" }];

	assert.strictEqual(rs.orphanedSegments.length, 0, "sanity: no orphans exist before this pass");

	assert.doesNotThrow(() => {
		runSegmentWalker(host as any, rs, "date-time-iso");
	});

	assert.strictEqual(rs.orphanedSegments.length, 0);

	tui.stop();
});

test("D-02 Test 5: removing a drained orphan clears host.streamingComponent when it pointed at that component", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);
	host.streamingMessage.content = [];

	const orphanComponent = new AssistantMessageComponent(
		undefined,
		host.hideThinkingBlock,
		host.getMarkdownThemeWithSettings(),
		"date-time-iso",
		{ startIndex: 0, endIndex: 0 },
	);
	host.chatContainer.addChild(orphanComponent);
	const provisionalText = "Let me check the stale settings one more time before finishing.";
	assert.ok(isProvisionalPreToolProse(provisionalText), "sanity: fixture text must genuinely match isProvisionalPreToolProse");
	rs.orphanedSegments = [
		{
			kind: "text-run",
			startIndex: 0,
			endIndex: 0,
			contentType: "text",
			component: orphanComponent,
			cachedText: provisionalText,
			cachedTextLength: provisionalText.length,
			orphanedAtGeneration: 1,
		},
	];
	(host as any).streamingComponent = orphanComponent;
	// A later shrink has occurred since this orphan was displaced — Condition
	// B's generational clause (the whole of Pitfall-10's protection).
	rs.shrinkGeneration = 2;

	runSegmentWalker(host as any, rs, "date-time-iso");

	assert.strictEqual(
		rs.orphanedSegments.length,
		0,
		"sanity: Condition B (provisional-prose + a later shrink has occurred) must have drained the orphan",
	);
	assert.strictEqual(
		(host as any).streamingComponent,
		undefined,
		"host.streamingComponent must be cleared when the component it names is removed",
	);
	assert.ok(!chatContainer.children.includes(orphanComponent), "the removed orphan's component must no longer be a child of chatContainer");

	tui.stop();
});

test("D-02 Test 6: a turn WITH an MCP tool call still prunes provisional pre-tool prose (no regression)", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	const provisionalText = "Let me check the STALEMARK settings before running the tool.";
	assert.ok(isProvisionalPreToolProse(provisionalText), "sanity: fixture text must genuinely match isProvisionalPreToolProse");

	// Delta 1: the provisional text alone, before any tool call exists —
	// firstToolIdx is -1, shouldPrune is false, so it renders normally.
	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: provisionalText }]);

	// Delta 2: the SAME provisional text, now followed by a real MCP tool call
	// and post-tool text — shouldPruneProvisionalPreToolProse becomes true, and
	// the original (unchanged-by-this-plan) rendered-segment prune block must
	// still remove the now-superseded provisional segment.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: provisionalText },
		{ type: "toolCall", id: "tool-drain-6", name: "mcp__bash", arguments: { command: "echo hi" } },
		{ type: "text", text: "FINALMARK the real answer" },
	]);

	const scrollback = terminal.getScrollBuffer();
	assert.strictEqual(
		countRowsContaining(scrollback, "STALEMARK"),
		0,
		"the provisional pre-tool prose must still be pruned when a real MCP tool call confirms supersession",
	);
	assert.strictEqual(
		countRowsContaining(scrollback, "FINALMARK"),
		1,
		"the real final answer must still render exactly once",
	);

	tui.stop();
});
