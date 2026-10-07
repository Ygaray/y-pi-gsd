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

	// Phase 37 Plan 03, Task 1 (D-03 branch C — VERDICT: no-separate-defect,
	// per 37-01-SUMMARY.md's `## D-03 Diagnosis`): RENDER-02's real-session
	// duplication was downstream of RENDER-01's text-run orphan leak, closed
	// by plan 37-02's reclaim + unconditional generation-gated drain — not an
	// independent duplicate/orphaned ToolExecutionComponent instance and not
	// body-accumulation inside tool-execution.ts. This plan lands no
	// production fix in either chat-segment-walker.ts or tool-execution.ts;
	// this assertion makes that green status load-bearing rather than
	// incidental by pinning the SAME component instance across the shrink.
	assert.strictEqual(
		regrownComponent,
		pendingComponent,
		"D-03 branch C: the identical ToolExecutionComponent instance must back the tool across the whole shrink+regrow cycle — no new instance is ever minted for a reused content.id",
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

// ── Review Fix: CR-01 (37-REVIEW.md) ──────────────────────────────────
//
// CR-01: a reclaimed text-run segment whose startIndex drifts across a
// subsequent GROWTH (non-shrink) delta was never re-orphaned when the
// turn's tool call is NOT an MCP tool — the old prune-and-reconcile block
// only ever ran when shouldPruneProvisionalPreToolProse was true, which
// requires isMcpToolBlock (chat-handoff-filter.ts) to match, so a plain
// `bash` tool call closed that gate and the stale component leaked as an
// untracked, blank chatContainer child. Note: a same-count assertion like
// "AssistantMessageComponent count === tracked text-run segment count"
// (used by RENDER-01/RENDER-02 above) does NOT catch this leak — the
// reviewer's own repro showed both counts at 4 — because the leaked
// component stays tracked in rs.renderedSegments under its stale
// pre-drift startIndex (a "ghost" entry, not a truly untracked one).
// This case instead asserts component identity continuity at the
// drifted slot and the absence of the stale ghost entry.
test("CR-01: non-MCP tool call — a growth delta that shifts a reclaimed text-run's startIndex reclaims the stale component rather than leaking it as a ghost entry", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	// Delta 1: thinking@0, text@1, toolCall@2 — a non-MCP tool ("bash"),
	// so isMcpToolBlock is false and shouldPruneProvisionalPreToolProse
	// stays false for the whole lifecycle below.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "thinking", thinking: "CR01THINK considering the request" },
		{ type: "text", text: "PROSEMARK working on it" },
		{ type: "toolCall", id: "tool-cr01-1", name: "bash", arguments: { command: "echo hi" } },
	]);

	// Delta 2 (shrink, 2 < 3): drops the thinking block, introduces a new
	// pre-tool prose text, keeps the same tool-call id — the primary shrink
	// branch orphans everything, and the append loop's reclaim picks up the
	// old PROSEMARK component for this new text at startIndex 0.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "NEWPROSE after shrink" },
		{ type: "toolCall", id: "tool-cr01-1", name: "bash", arguments: { command: "echo hi" } },
	]);
	const reclaimedAtDelta2 = rs.renderedSegments.find(
		(s) => s.kind === "text-run" && s.contentType === "text",
	)?.component;
	assert.ok(reclaimedAtDelta2, "sanity: delta 2 must reclaim a text component at startIndex 0");

	// Delta 3 (growth, 4 > 2, NOT a shrink): the thinking block reappears at
	// index 0, shifting the live text segment's true desired slot from
	// startIndex 0 to startIndex 1 — the exact drift CR-01 describes. A
	// trailing ANSWERMARK text block (its own run, split by the tool call)
	// is also introduced.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "thinking", thinking: "CR01THINK considering the request" },
		{ type: "text", text: "PROSEMARK working on it" },
		{ type: "toolCall", id: "tool-cr01-1", name: "bash", arguments: { command: "echo hi" } },
		{ type: "text", text: "ANSWERMARK final answer" },
	]);

	// No stale ghost entry may remain pinned at the pre-drift startIndex 0
	// under contentType "text" — desired no longer wants anything there
	// (thinking now occupies startIndex 0).
	assert.ok(
		!rs.renderedSegments.some((s) => s.kind === "text-run" && s.contentType === "text" && s.startIndex === 0),
		"CR-01: no stale ghost text-run entry may remain pinned at the pre-drift startIndex 0",
	);

	// The delta-2 reclaimed component must be reclaimed AGAIN for the
	// drifted startIndex 1 slot — never left behind while a second,
	// brand-new component is minted for the same logical content.
	const textComponentAfterDelta3 = rs.renderedSegments.find(
		(s) => s.kind === "text-run" && s.contentType === "text" && s.startIndex === 1,
	)?.component;
	assert.strictEqual(
		textComponentAfterDelta3,
		reclaimedAtDelta2,
		"CR-01: the delta-2 reclaimed component must be reclaimed again for the drifted startIndex 1 slot, never leaked as a second stale component",
	);

	// Exactly two live "text" contentType text-run segments must exist
	// (PROSEMARK's run at startIndex 1, ANSWERMARK's run at startIndex 3) —
	// a third ("ghost") entry is the leak this finding targets.
	const liveTextSegs = rs.renderedSegments.filter((s) => s.kind === "text-run" && s.contentType === "text");
	assert.strictEqual(
		liveTextSegs.length,
		2,
		`CR-01: expected exactly 2 live "text" contentType text-run segments, observed ${liveTextSegs.length}`,
	);
	assert.ok(
		liveTextSegs.every((s) => (s.cachedText ?? "").length > 0),
		"CR-01: no live text-run segment may carry blank cachedText — a blank ghost is the leak's own signature (getTextFromContentBlocks silently skips a mismatched block type)",
	);

	assert.strictEqual(rs.orphanedSegments.length, 0, "every displaced segment must be fully reconciled by this pass, not left dangling in rs.orphanedSegments");

	const assistantComponentCount = chatContainer.children.filter((c) => c instanceof AssistantMessageComponent).length;
	assert.strictEqual(
		assistantComponentCount,
		3,
		`expected exactly 3 live AssistantMessageComponent children (thinking, PROSEMARK, ANSWERMARK), observed ${assistantComponentCount}`,
	);

	const scrollback = terminal.getScrollBuffer();
	assert.strictEqual(countRowsContaining(scrollback, "PROSEMARK"), 1, "PROSEMARK must appear exactly once");
	assert.strictEqual(countRowsContaining(scrollback, "ANSWERMARK"), 1, "ANSWERMARK must appear exactly once");

	tui.stop();
});

// ── Review Fix: WR-01 (37-REVIEW.md) ──────────────────────────────────
//
// WR-01: a reused tool id whose contentIndex shifts across a GROWTH
// (non-shrink) delta left TWO "tool" bookkeeping entries in
// rs.renderedSegments — one under the stale pre-shift contentIndex, one
// under the new one — both referencing the SAME ToolExecutionComponent
// instance. No visible duplication results (chatContainer still holds
// only one physical component), so this is purely live-tracking-state
// drift, not a DOM-visible defect — the assertion below targets
// rs.renderedSegments directly rather than chatContainer/scrollback.
test("WR-01: a reused tool id whose contentIndex shifts leaves exactly one bookkeeping entry per component, never a stale duplicate", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	// Delta 1: text@0, toolCall@1.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "WR01LEAD one" },
		{ type: "toolCall", id: "tool-wr01-1", name: "bash", arguments: { command: "echo hi" } },
	]);
	const component = host.pendingTools.get("tool-wr01-1");
	assert.ok(component, "sanity: the tool call must have registered a pending component");

	// Delta 2 (shrink, 1 < 2): tool-call alone, now at contentIndex 0 — the
	// primary shrink branch clears rs.renderedSegments entirely, so the
	// append loop re-registers the SAME component under its new index.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "toolCall", id: "tool-wr01-1", name: "bash", arguments: { command: "echo hi" } },
	]);

	// Delta 3 (growth, 2 > 1, NOT a shrink): a new leading text block shifts
	// the SAME tool-call id back to contentIndex 1 — rs.renderedSegments
	// still carries the delta-2 entry at contentIndex 0 (growth never
	// clears tool-kind entries), so the contentIndex-keyed `existing`
	// lookup in the append loop misses and would (pre-fix) push a SECOND
	// entry for the identical component.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "WR01LEAD two" },
		{ type: "toolCall", id: "tool-wr01-1", name: "bash", arguments: { command: "echo hi" } },
	]);

	const toolBookkeepingEntries = rs.renderedSegments.filter((s) => s.kind === "tool" && s.component === component);
	assert.strictEqual(
		toolBookkeepingEntries.length,
		1,
		`WR-01: expected exactly 1 rs.renderedSegments bookkeeping entry for the reused tool component, observed ${toolBookkeepingEntries.length}`,
	);
	assert.strictEqual(
		toolBookkeepingEntries[0]?.contentIndex,
		1,
		"WR-01: the single surviving entry must reflect the CURRENT contentIndex, not the stale pre-shift one",
	);

	const toolInstanceCount = chatContainer.children.filter((c) => c instanceof ToolExecutionComponent).length;
	assert.strictEqual(toolInstanceCount, 1, "sanity: exactly one physical ToolExecutionComponent must exist");

	tui.stop();
});

// ── Phase 37 Plan 03, Task 1: D-03 verdict `no-separate-defect` (branch C) ──
//
// 37-01-SUMMARY.md's `## D-03 Diagnosis` section records VERDICT:
// no-separate-defect — every RENDER-02-specific arbiter in the SC-5 case
// above (the ToolExecutionComponent instance count, and the BODYMARK/ARGSMARK
// row counts) already passed at 37-01's HEAD; the only failure was the
// RENDER-01 orphan-leak assertion, closed by plan 37-02 as a byproduct (see
// 37-02-SUMMARY.md). Branch C therefore fires: no production fix lands in
// this plan, in either chat-segment-walker.ts or tool-execution.ts. The
// cases below make that green status load-bearing (not incidental) and lock
// in P-03/edge coverage for the no-fix-needed decision.

test("RENDER-02 P-03: an in-flight tool component (no result yet) survives a shrink that drops its block from the desired list", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEAD prose" },
		{ type: "toolCall", id: "tool-p03-1", name: "bash", arguments: { command: "echo P03MARK" } },
	]);
	const component = host.pendingTools.get("tool-p03-1");
	assert.ok(component, "sanity: the tool call must have registered a pending component");
	assert.ok(component!.isInFlight(), "sanity: no result has been applied yet — the component must report in-flight");

	// Shrink: strictly shorter blocks array that drops the tool-call block
	// entirely from the desired list (desiredToolIndices no longer names it).
	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "LEAD prose" }]);

	assert.ok(
		chatContainer.children.includes(component!),
		"P-03: an in-flight tool component must never be removed from chatContainer, even when its block is dropped from the desired list",
	);
	assert.strictEqual(
		host.pendingTools.get("tool-p03-1"),
		component,
		"P-03: an in-flight tool component must remain reachable through host.pendingTools",
	);

	tui.stop();
});

// Test 3, as the plan's Task 1 <behavior> literally describes it ("a
// completed tool component whose block is genuinely absent from the regrown
// desired list IS detached from chatContainer"), is Branch A's fix-location
// guarantee (see this task's acceptance_criteria: "Branch A only: a tool
// segment dropped ... also has host.chatContainer.removeChild(...) called").
// Branch C fired instead, per the VERDICT above, so no removeChild cleanup
// was added for this path. Empirically probing the real HEAD behavior (no
// production file touched by this probe) confirms the walker's tool branch
// never removes any tool segment — in-flight or completed — once a block
// disappears from content entirely: the component stays a live
// chatContainer child, stays in host.pendingTools, and its body stays in
// scrollback. This is the SAME retention-over-removal default Task 2's own
// action text names as the established safe direction (plan 37-02's P-01:
// "retain rather than remove"), so this is pinned here as a deliberate
// regression lock on the real no-fix behavior, not a defect this plan is
// authorized to change. See this plan's SUMMARY.md for the full finding.
test("RENDER-02 Test 3 (documents D-03 branch-C behavior): a completed tool genuinely absent from the regrown desired list is retained, not duplicated", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEAD prose" },
		{ type: "toolCall", id: "tool-absent-1", name: "bash", arguments: { command: "echo ABSENTMARK" } },
	]);
	const component = host.pendingTools.get("tool-absent-1");
	assert.ok(component, "sanity: the tool call must have registered a pending component");
	component!.updateResult({ content: [{ type: "text", text: "ABSENTBODY" }], isError: false });
	tui.requestRender();
	await terminal.waitForRender();

	// Shrink, then regrow WITHOUT the tool block anywhere in the new content
	// — genuinely absent, not reused under the same id.
	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "LEAD prose" }]);
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEAD prose" },
		{ type: "text", text: "TRAILING prose, no tool" },
	]);

	assert.ok(
		chatContainer.children.includes(component!),
		"as-shipped (D-03 no-separate-defect, no Branch-A cleanup added): a genuinely-dropped completed tool's component is retained, never removed",
	);
	assert.strictEqual(
		host.pendingTools.get("tool-absent-1"),
		component,
		"the retained component stays the SAME instance reachable through host.pendingTools — never a stale pointer, never a duplicate",
	);
	const toolInstanceCount = chatContainer.children.filter((c) => c instanceof ToolExecutionComponent).length;
	assert.strictEqual(
		toolInstanceCount,
		1,
		"exactly one ToolExecutionComponent must exist — retained-but-orphaned is acceptable, a SECOND instance for the same id is not",
	);

	tui.stop();
});

test("RENDER-02 Test 4: two distinct tool calls in one turn each end with exactly one component after shrink+regrow", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	// Delta 1: thinking + two distinct tool calls + trailing text.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "thinking", thinking: "T4THINK considering two tools" },
		{ type: "toolCall", id: "tool-t4-a", name: "bash", arguments: { command: "echo T4ARGSA" } },
		{ type: "toolCall", id: "tool-t4-b", name: "bash", arguments: { command: "echo T4ARGSB" } },
	]);
	const componentA = host.pendingTools.get("tool-t4-a");
	const componentB = host.pendingTools.get("tool-t4-b");
	assert.ok(componentA, "sanity: tool A must have registered a pending component");
	assert.ok(componentB, "sanity: tool B must have registered a pending component");
	assert.notStrictEqual(componentA, componentB, "sanity: the two distinct tool ids must back distinct components");
	componentA!.updateResult({ content: [{ type: "text", text: "T4BODYA" }], isError: false });
	componentB!.updateResult({ content: [{ type: "text", text: "T4BODYB" }], isError: false });
	tui.requestRender();
	await terminal.waitForRender();

	// Shrink: strictly shorter, retaining both ids.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "toolCall", id: "tool-t4-a", name: "bash", arguments: { command: "echo T4ARGSA" } },
		{ type: "toolCall", id: "tool-t4-b", name: "bash", arguments: { command: "echo T4ARGSB" } },
	]);

	// Regrow: both tool ids again, plus a trailing answer.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "thinking", thinking: "T4THINK considering two tools" },
		{ type: "toolCall", id: "tool-t4-a", name: "bash", arguments: { command: "echo T4ARGSA" } },
		{ type: "toolCall", id: "tool-t4-b", name: "bash", arguments: { command: "echo T4ARGSB" } },
		{ type: "text", text: "T4ANSWER final answer" },
	]);
	host.pendingTools.get("tool-t4-a")!.updateResult({ content: [{ type: "text", text: "T4BODYA" }], isError: false });
	host.pendingTools.get("tool-t4-b")!.updateResult({ content: [{ type: "text", text: "T4BODYB" }], isError: false });
	tui.requestRender();
	await terminal.waitForRender();

	const scrollback = terminal.getScrollBuffer();
	const toolInstanceCount = chatContainer.children.filter((c) => c instanceof ToolExecutionComponent).length;
	assert.strictEqual(
		toolInstanceCount,
		2,
		`exactly two ToolExecutionComponent instances must exist (one per distinct id) — cleanup must never collapse two legitimate tools into one, observed ${toolInstanceCount}`,
	);
	assert.strictEqual(countRowsContaining(scrollback, "T4BODYA"), 1, "tool A's body must appear exactly once");
	assert.strictEqual(countRowsContaining(scrollback, "T4BODYB"), 1, "tool B's body must appear exactly once");
	assert.strictEqual(countRowsContaining(scrollback, "T4ARGSA"), 1, "tool A's args/command echo must appear exactly once");
	assert.strictEqual(countRowsContaining(scrollback, "T4ARGSB"), 1, "tool B's args/command echo must appear exactly once");

	// Test 5 (RENDER-01 non-regression in this richer two-tool mixed scenario):
	assert.strictEqual(countRowsContaining(scrollback, "T4ANSWER"), 1, "the trailing final answer must appear exactly once");
	const textRunSegmentCount = rs.renderedSegments.filter((s) => s.kind === "text-run").length;
	const assistantComponentCount = chatContainer.children.filter((c) => c instanceof AssistantMessageComponent).length;
	assert.strictEqual(
		assistantComponentCount,
		textRunSegmentCount,
		`AssistantMessageComponent count (${assistantComponentCount}) must match tracked text-run segment count (${textRunSegmentCount}) — RENDER-01 must not regress in a two-tool mixed turn`,
	);

	tui.stop();
});

// ── Phase 37 Plan 03, Task 2: spec-less edge-coverage probe, resolved ──
//
// Empty/single-element input and the length/equality definition for both
// RENDER-01 (text-run reclaim) and RENDER-02 (tool identity), per the
// frontmatter must_haves "RENDER-01 / empty input", "RENDER-02 / empty
// input", and "RENDER-02 / encoding". Any production change here is at most
// a defensive early-return guard, or a strictly MORE conservative removal
// condition (prohibition P-01 — retain rather than remove) — never a
// relaxation of an existing removal condition.

test("Edge Test 1: a zero-length contentBlocks shrink, then runSegmentWalker, throws nothing and leaves no duplicate components", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "GROWTEXT alpha" },
	]);

	await assert.doesNotReject(async () => {
		await driveDelta(host, rs, tui, terminal, []);
	});

	// A zero-length regrow has nothing desired, so nothing is appended and
	// nothing supersedes the displaced orphan — per P-01 (retain rather than
	// remove), it stays a live, untracked child rather than being dropped.
	// The must-hold guarantee here is "no duplicate", not "zero children":
	// exactly the ONE pre-shrink component, never a second instance minted
	// for the same content.
	const assistantComponentCount = chatContainer.children.filter((c) => c instanceof AssistantMessageComponent).length;
	assert.strictEqual(
		assistantComponentCount,
		1,
		"a zero-length contentBlocks shrink must never duplicate a component — the single pre-shrink orphan is retained (P-01), not minted again",
	);

	tui.stop();
});

test("Edge Test 2: a shrink to a single-element contentBlocks array, then a regrow, reclaims rather than mints", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "SOLOTEXT alpha" },
	]);
	const componentBefore = rs.renderedSegments.find((s) => s.kind === "text-run" && s.contentType === "text" && s.cachedText?.includes("SOLOTEXT"))
		?.component;
	assert.ok(componentBefore, "sanity: delta 1 must render the SOLOTEXT text-run");

	// Shrink to a single-element array (strictly shorter: 1 < 2).
	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "SOLOTEXT alpha" }]);

	// Regrow restoring the original two-block shape.
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: "SOLOTEXT alpha beta" },
	]);
	const componentAfter = rs.renderedSegments.find((s) => s.kind === "text-run" && s.contentType === "text" && s.cachedText?.includes("SOLOTEXT"))
		?.component;

	assert.strictEqual(
		componentAfter,
		componentBefore,
		"the pre-shrink component object must be reclaimed in place, not re-minted, across a single-element-array shrink",
	);

	tui.stop();
});

test("Edge Test 3: drainOrphanedSegments (via runSegmentWalker) with an empty rs.orphanedSegments is a no-op and throws nothing", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);
	host.streamingMessage.content = [{ type: "text", text: "EDGESOLO content" }];

	assert.strictEqual(rs.orphanedSegments.length, 0, "sanity: no orphans exist before this pass");

	assert.doesNotThrow(() => {
		runSegmentWalker(host as any, rs, "date-time-iso");
	});

	assert.strictEqual(rs.orphanedSegments.length, 0, "the existing length guard must still short-circuit to a no-op");

	tui.stop();
});

test("Edge Test 4: reclaimOrphanedTextRun (via the append loop) with an empty rs.orphanedSegments mints exactly as at HEAD", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	assert.strictEqual(rs.orphanedSegments.length, 0, "sanity: no orphans exist before the first delta");

	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: "EDGEFRESH no orphan to reclaim" }]);

	assert.strictEqual(
		countRowsContaining(terminal.getScrollBuffer(), "EDGEFRESH"),
		1,
		"a fresh segment with no orphan candidates must still mint and render normally",
	);
	assert.strictEqual(rs.orphanedSegments.length, 0, "no orphan is fabricated by a no-match reclaim attempt");

	tui.stop();
});

test("Edge Test 5 (RENDER-02 empty input): empty arguments object + empty result content array, driven through shrink+regrow with the same content.id, yields exactly one component and raises no exception", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	await assert.doesNotReject(async () => {
		await driveDelta(host, rs, tui, terminal, [
			{ type: "text", text: "LEAD prose" },
			{ type: "toolCall", id: "tool-empty-1", name: "bash", arguments: {} },
		]);
		const component = host.pendingTools.get("tool-empty-1");
		assert.ok(component, "sanity: the empty-arguments tool call must still register a pending component");
		component!.updateResult({ content: [], isError: false });
		tui.requestRender();
		await terminal.waitForRender();

		// Shrink, then regrow with the identical id.
		await driveDelta(host, rs, tui, terminal, [{ type: "toolCall", id: "tool-empty-1", name: "bash", arguments: {} }]);
		await driveDelta(host, rs, tui, terminal, [
			{ type: "text", text: "LEAD prose" },
			{ type: "toolCall", id: "tool-empty-1", name: "bash", arguments: {} },
		]);
		host.pendingTools.get("tool-empty-1")!.updateResult({ content: [], isError: false });
		tui.requestRender();
		await terminal.waitForRender();
	});

	const toolInstanceCount = chatContainer.children.filter((c) => c instanceof ToolExecutionComponent).length;
	assert.strictEqual(
		toolInstanceCount,
		1,
		`exactly one ToolExecutionComponent must exist for the empty-arguments/empty-result tool, observed ${toolInstanceCount}`,
	);

	tui.stop();
});

test("Edge Test 6 (RENDER-01 encoding): an astral-plane character + combining mark is reclaimed and re-rendered with its adjacent ASCII sentinel present exactly once", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	// Built from explicit escape sequences (astral-plane code point + a
	// combining acute accent), not pasted glyphs, so the file stays
	// ASCII-safe in a diff. The assertion below targets the adjacent ASCII
	// sentinels, never this multi-code-unit region itself — row-level
	// scroll-buffer matching over wide/combining characters is
	// terminal-width-dependent and would make the case flaky.
	const multiCodeUnitRegion = "\u{1F600}́";
	const encodingText = `ENCSENTBEFORE ${multiCodeUnitRegion} ENCSENTAFTER`;

	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: encodingText },
	]);
	const componentBefore = rs.renderedSegments.find((s) => s.kind === "text-run" && s.contentType === "text")?.component;
	assert.ok(componentBefore, "sanity: delta 1 must render the encoding text-run");

	// Shrink (strictly shorter) then regrow (strictly longer), reusing the
	// same multi-code-unit content — reclaim must turn on contentType
	// equality only, never on byte-length or a normalized comparison.
	await driveDelta(host, rs, tui, terminal, [{ type: "text", text: encodingText }]);
	await driveDelta(host, rs, tui, terminal, [
		{ type: "text", text: "LEADTEXT one" },
		{ type: "text", text: encodingText },
	]);
	const componentAfter = rs.renderedSegments.find((s) => s.kind === "text-run" && s.contentType === "text")?.component;

	assert.strictEqual(
		componentAfter,
		componentBefore,
		"the multi-code-unit content must not perturb reclaim — same component instance across the shrink+regrow cycle",
	);

	const scrollback = terminal.getScrollBuffer();
	assert.strictEqual(
		countRowsContaining(scrollback, "ENCSENTBEFORE"),
		1,
		"the ASCII sentinel immediately before the multi-code-unit region must appear exactly once",
	);
	assert.strictEqual(
		countRowsContaining(scrollback, "ENCSENTAFTER"),
		1,
		"the ASCII sentinel immediately after the multi-code-unit region must appear exactly once",
	);

	tui.stop();
});

test("Edge Test 7 (RENDER-02 encoding): two tool-call ids differing only by letter case are distinct identities, each with its own component", async () => {
	const { terminal, tui, chatContainer } = mountVirtualTranscript();
	const rs = createStreamingRenderState();
	const host = makeRenderHost(chatContainer, tui, rs);

	await driveDelta(host, rs, tui, terminal, [
		{ type: "toolCall", id: "tool-case-a", name: "bash", arguments: { command: "echo lower" } },
		{ type: "toolCall", id: "tool-case-A", name: "bash", arguments: { command: "echo upper" } },
	]);

	const componentLower = host.pendingTools.get("tool-case-a");
	const componentUpper = host.pendingTools.get("tool-case-A");
	assert.ok(componentLower, "sanity: the lowercase-id tool call must register a pending component");
	assert.ok(componentUpper, "sanity: the uppercase-id tool call must register a pending component");
	assert.notStrictEqual(
		componentLower,
		componentUpper,
		"a Map-key exact-equality lookup must never fold case — ids differing only by case are distinct identities",
	);

	const toolInstanceCount = chatContainer.children.filter((c) => c instanceof ToolExecutionComponent).length;
	assert.strictEqual(
		toolInstanceCount,
		2,
		`exactly two ToolExecutionComponent instances must exist for the two case-distinct ids, observed ${toolInstanceCount}`,
	);

	tui.stop();
});
