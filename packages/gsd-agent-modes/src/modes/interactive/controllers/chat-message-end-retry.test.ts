// gsd-pi — TUI-01/TUI-02 regression: rebuildSegmentsOnMessageEnd idempotency
// and streaming segment-identity contracts.
//
// A1 disposition (see 25-03-PLAN.md <retry_trigger_disposition>): the exact
// retry mechanism that re-triggers message_end for an already-fully-rendered
// final message is NOT confirmed by this test file and stays open by design.
// The two candidate sites are packages/gsd-agent-core/src/session/
// agent-session-prompt.ts:489-566 (app-level retry, default maxRetries: 3)
// and packages/gsd-agent-core/src/sdk.ts:359-370 (SDK/provider-level retry).
// This file proves the CONSUMER-side invariant instead: whatever re-drives
// message_end for byte-identical final content, rebuildSegmentsOnMessageEnd
// must be a no-op for the repeat.
//
// Measured note (recorded in 25-03-SUMMARY.md): driving handleAgentEvent's
// "message_end" case unconditionally resets rs.renderedSegments to []
// (chat-controller.ts's rs.resetStreamingSegments(), run at the end of every
// assistant message_end, guard or not) and clears host.streamingComponent.
// A bare second message_end call with NOTHING in between therefore always
// hits rebuildSegmentsOnMessageEnd's PRE-EXISTING `rs.renderedSegments.length
// === 0` early return (a no-op already, at HEAD, inside chat-segment-walker.ts)
// rather than ever reaching the new guard — any further child added by that
// exact shape comes from chat-controller.ts's separate
// `!host.streamingComponent` whole-message fallback branch, which is out of
// this plan's file scope (owned by plan 25-04, already landed) and is not
// exercised by this file. To reach the new guard through the real production
// path, these tests drive a `message_update` carrying the SAME final content
// between the two `message_end` calls — repopulating rs.renderedSegments
// exactly as a retried delivery that re-streams before re-ending would. This
// is the shape rebuildSegmentsOnMessageEnd's guard is actually built to make
// idempotent, and it is confirmed empirically (not asserted from reading) by
// this file's own RED-before/GREEN-after runs.
//
// Two cases below (marked DIRECT-CALL) drive setup via handleAgentEvent but
// invoke rebuildSegmentsOnMessageEnd directly for the single call under test.
// This is necessary — not a shortcut — because chat-controller.ts's
// unconditional post-message_end reset (and its sibling fallback branch)
// erase exactly the internal state (rs.renderedSegments) those two cases need
// to inspect, and neither file is in this plan's scope to change. Every other
// case drives every event through handleAgentEvent end to end, proving the
// production-path, real-world behavior directly.

import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

import { handleAgentEvent } from "./chat-controller.js";
import { rebuildSegmentsOnMessageEnd } from "./chat-segment-walker.js";
import { createStreamingRenderState } from "../streaming-render-state.js";

initTheme();

// ── helpers ──────────────────────────────────────────────────────────

// Copied in shape from streaming-render-state.test.ts's makeMinimalHost
// (lines 8-56), which is itself the established fake-host surface for
// driving handleAgentEvent directly.
function makeMinimalHost(chatContainer: Container, streamingRenderState = createStreamingRenderState()) {
	return {
		isInitialized: true,
		streamingRenderState,
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
		pendingTools: new Map(),
		pendingMessagesContainer: { clear() {} },
		pinnedMessageContainer: new Container(),
		statusContainer: new Container(),
		hideThinkingBlock: true,
		toolOutputExpanded: false,
		defaultWorkingMessage: "Working...",
		clearBlockingError() {},
		compactionQueuedMessages: [],
		ui: {
			terminal: { rows: 60, columns: 100 },
			requestRender() {},
		},
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

function messageUpdate(content: Array<any>) {
	return {
		type: "message_update",
		message: { role: "assistant", content, provider: "test" },
		assistantMessageEvent: { type: "text" },
	} as any;
}

function messageEnd(content: Array<any>) {
	return {
		type: "message_end",
		message: { role: "assistant", content, provider: "test" },
	} as any;
}

/** Builds a text/tool/text three-segment message, streamed in over three updates. */
async function streamTwoTextRunsWithTool(host: any) {
	await handleAgentEvent(host, { type: "message_start", message: { role: "assistant", content: [] } } as any);
	await handleAgentEvent(host, messageUpdate([{ type: "text", text: "Hello" }]));
	await handleAgentEvent(
		host,
		messageUpdate([
			{ type: "text", text: "Hello" },
			{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "a.txt" } },
		]),
	);
	const finalContent = [
		{ type: "text", text: "Hello" },
		{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "a.txt" } },
		{ type: "text", text: "World" },
	];
	await handleAgentEvent(host, messageUpdate(finalContent));
	return finalContent;
}

// ── Task 1: idempotent rebuild for a repeated message_end ────────────

test("a repeated message_end for identical final content adds no children", async () => {
	const chatContainer = new Container();
	const rs = createStreamingRenderState();
	const host = makeMinimalHost(chatContainer, rs);

	const finalContent = await streamTwoTextRunsWithTool(host);

	// Finalize the turn once (the "real" delivery).
	await handleAgentEvent(host, messageEnd(finalContent));

	// Simulate a retried delivery re-streaming the identical final content
	// before re-ending it — the shape that repopulates rs.renderedSegments
	// through the real production path (see file header note).
	await handleAgentEvent(host, messageUpdate(finalContent));

	const childrenBefore = [...chatContainer.children];
	assert.ok(childrenBefore.length > 0, "sanity: something is rendered before the repeat");

	// The repeat under test — driven through the real handleAgentEvent path.
	await handleAgentEvent(host, messageEnd(finalContent));

	assert.equal(
		chatContainer.children.length,
		childrenBefore.length,
		"a repeated message_end for unchanged content must not add children",
	);
	for (let i = 0; i < childrenBefore.length; i++) {
		assert.equal(
			chatContainer.children[i],
			childrenBefore[i],
			`child at index ${i} must be the SAME object reference — a remove+re-add would replace it`,
		);
	}
	// chat-controller.ts's rs.resetStreamingSegments() runs unconditionally
	// after every assistant message_end (guard or not) — this is expected,
	// pre-existing architecture, not something the guard changes or defeats.
	assert.equal(rs.renderedSegments.length, 0);
});

test("a repeated message_end leaves renderedSegments element-for-element identical", async () => {
	const chatContainer = new Container();
	const rs = createStreamingRenderState();
	const host: any = makeMinimalHost(chatContainer, rs);

	const finalContent = await streamTwoTextRunsWithTool(host);
	await handleAgentEvent(host, messageEnd(finalContent));
	await handleAgentEvent(host, messageUpdate(finalContent));

	const before = rs.renderedSegments.map((seg) => ({ ...seg }));
	const beforeComponents = rs.renderedSegments.map((seg) => seg.component);
	assert.ok(before.length > 0, "sanity: something is rendered before the repeat");

	// DIRECT-CALL: chat-controller.ts's unconditional post-message_end reset
	// would erase rs.renderedSegments before this test could inspect it if
	// driven through handleAgentEvent a second time — see file header note.
	// This isolates rebuildSegmentsOnMessageEnd's own contract for the exact
	// same repeated-content scenario Case 1 already proves end-to-end.
	host.streamingMessage = { role: "assistant", content: finalContent, provider: "test" };
	rebuildSegmentsOnMessageEnd(host, rs, host.settingsManager.getTimestampFormat());

	assert.equal(rs.renderedSegments.length, before.length);
	for (let i = 0; i < before.length; i++) {
		const prev = before[i];
		const cur = rs.renderedSegments[i];
		assert.equal(cur.kind, prev.kind, `segment ${i} kind must be unchanged`);
		assert.equal(cur.component, beforeComponents[i], `segment ${i} component must be the SAME reference`);
		if (cur.kind === "text-run" && prev.kind === "text-run") {
			assert.equal(cur.startIndex, prev.startIndex);
			assert.equal(cur.endIndex, prev.endIndex);
			assert.equal(cur.contentType, prev.contentType);
			assert.equal(cur.cachedText, prev.cachedText);
		}
		if (cur.kind === "tool" && prev.kind === "tool") {
			assert.equal(cur.contentIndex, prev.contentIndex);
		}
	}
});

test("a message_end whose final content differs still rebuilds", async () => {
	const chatContainer = new Container();
	const rs = createStreamingRenderState();
	const host = makeMinimalHost(chatContainer, rs);

	const finalContent = await streamTwoTextRunsWithTool(host);
	await handleAgentEvent(host, messageEnd(finalContent));
	await handleAgentEvent(host, messageUpdate(finalContent));

	const childrenBefore = [...chatContainer.children];

	// A genuinely different final content: a NEW tool call inserted before
	// the trailing text run, so the desired segmentation cannot merge it
	// with an adjacent same-type text block (an earlier version of this test
	// appended a plain trailing text block, which buildDesiredSegments
	// legitimately merges into the existing run — a false negative, not a
	// real content-identity match).
	const differentContent = [
		finalContent[0],
		finalContent[1],
		finalContent[2],
		{ type: "toolCall", id: "t2", name: "write_file", arguments: { path: "b.txt" } },
	];
	await handleAgentEvent(host, messageEnd(differentContent));

	const childrenAfter = chatContainer.children;
	const sameShape = childrenAfter.length === childrenBefore.length
		&& childrenAfter.every((c, i) => c === childrenBefore[i]);
	assert.ok(!sameShape, "a genuinely different final content must trigger a real rebuild, not a no-op");
	assert.ok(
		Array.from((host as any).pendingTools.keys()).includes("t2"),
		"the new tool call must actually be registered, proving the extra segment was processed",
	);
});

test("a message_end with zero rendered segments is a no-op", () => {
	const chatContainer = new Container();
	const rs = createStreamingRenderState();
	const host: any = makeMinimalHost(chatContainer, rs);

	assert.equal(rs.renderedSegments.length, 0, "sanity: fresh rs has no rendered segments");

	// DIRECT-CALL: isolates rebuildSegmentsOnMessageEnd's own pinned early
	// return (chat-segment-walker.ts's pre-existing `rs.renderedSegments.length
	// === 0` check) from chat-controller.ts's sibling `!host.streamingComponent`
	// whole-message fallback, which would otherwise add an unrelated child for
	// ANY visible content and mask what this case is actually pinning — see
	// file header note.
	host.streamingMessage = { role: "assistant", content: [{ type: "text", text: "Hello" }], provider: "test" };
	assert.doesNotThrow(() => {
		rebuildSegmentsOnMessageEnd(host, rs, host.settingsManager.getTimestampFormat());
	});

	assert.equal(chatContainer.children.length, 0, "the early return must not touch chatContainer");
	assert.equal(rs.renderedSegments.length, 0, "the early return must not populate renderedSegments");
});

test("a tool row keeps its position across a suppressed repeat", async () => {
	const chatContainer = new Container();
	const rs = createStreamingRenderState();
	const host = makeMinimalHost(chatContainer, rs);

	const finalContent = await streamTwoTextRunsWithTool(host);
	await handleAgentEvent(host, messageEnd(finalContent));
	await handleAgentEvent(host, messageUpdate(finalContent));

	const orderBefore = [...chatContainer.children];
	// Sanity: this fixture actually has a tool row somewhere in the middle,
	// so a position-preserving assertion is meaningful.
	const toolIndexBefore = rs.renderedSegments.findIndex((seg) => seg.kind === "tool");
	assert.ok(
		toolIndexBefore > 0 && toolIndexBefore < rs.renderedSegments.length - 1,
		"sanity: tool row sits between two text runs",
	);

	await handleAgentEvent(host, messageEnd(finalContent));

	assert.equal(chatContainer.children.length, orderBefore.length);
	for (let i = 0; i < orderBefore.length; i++) {
		assert.equal(
			chatContainer.children[i],
			orderBefore[i],
			`position ${i} must be unchanged — a removeChild+addChild would move the tool row to the end`,
		);
	}
});

// ── Task 2: streaming segment-identity contracts (TUI-01, component half) ──

test("a growing text run reuses its component across deltas", async () => {
	const chatContainer = new Container();
	const rs = createStreamingRenderState();
	const host = makeMinimalHost(chatContainer, rs);

	await handleAgentEvent(host, { type: "message_start", message: { role: "assistant", content: [] } } as any);
	await handleAgentEvent(host, messageUpdate([{ type: "text", text: "Hel" }]));
	const compAfter1 = chatContainer.children.length === 1 ? chatContainer.children[0] : undefined;

	await handleAgentEvent(host, messageUpdate([{ type: "text", text: "Hello wor" }]));
	const compAfter2 = chatContainer.children.length === 1 ? chatContainer.children[0] : undefined;

	await handleAgentEvent(host, messageUpdate([{ type: "text", text: "Hello world!" }]));
	const compAfter3 = chatContainer.children.length === 1 ? chatContainer.children[0] : undefined;

	assert.equal(chatContainer.children.length, 1, "a single growing text run must stay a single component");
	assert.ok(compAfter1 && compAfter2 && compAfter3, "sanity: a component existed at every step");
	assert.equal(compAfter2, compAfter1, "growth must update the SAME component, not mint a second one");
	assert.equal(compAfter3, compAfter1, "growth must update the SAME component across all three deltas");
});

test("a text run interleaved with a thinking block keeps stable segment keys", async () => {
	const chatContainer = new Container();
	const rs = createStreamingRenderState();
	const host: any = makeMinimalHost(chatContainer, rs);
	host.hideThinkingBlock = false; // thinking must be visible to form its own segment boundary

	await handleAgentEvent(host, { type: "message_start", message: { role: "assistant", content: [] } } as any);

	await handleAgentEvent(host, messageUpdate([{ type: "text", text: "Investigating." }]));
	const keysStep1 = rs.renderedSegments
		.filter((s: any) => s.kind === "text-run")
		.map((s: any) => `${s.contentType}:${s.startIndex}`);

	await handleAgentEvent(
		host,
		messageUpdate([
			{ type: "text", text: "Investigating." },
			{ type: "thinking", thinking: "Let me check the file." },
		]),
	);
	const keysStep2 = rs.renderedSegments
		.filter((s: any) => s.kind === "text-run")
		.map((s: any) => `${s.contentType}:${s.startIndex}`);

	await handleAgentEvent(
		host,
		messageUpdate([
			{ type: "text", text: "Investigating." },
			{ type: "thinking", thinking: "Let me check the file." },
			{ type: "text", text: "Found it." },
		]),
	);
	const keysStep3 = rs.renderedSegments
		.filter((s: any) => s.kind === "text-run")
		.map((s: any) => `${s.contentType}:${s.startIndex}`);

	// Every key present at an earlier step must still be present, unmoved,
	// at every later step — growth, never removal-and-reindex.
	for (const key of keysStep1) assert.ok(keysStep2.includes(key), `key ${key} must survive step 2`);
	for (const key of keysStep2) assert.ok(keysStep3.includes(key), `key ${key} must survive step 3`);
	assert.ok(keysStep3.length >= keysStep1.length, "the key set must only grow across the interleaved stream");
});

test("exactly adjacent segments stay distinct", async () => {
	const chatContainer = new Container();
	const rs = createStreamingRenderState();
	const host: any = makeMinimalHost(chatContainer, rs);
	host.hideThinkingBlock = false;

	await handleAgentEvent(host, { type: "message_start", message: { role: "assistant", content: [] } } as any);

	// Two different contentTypes ("text" then "thinking") at consecutive
	// content-block indices — the boundary this test pins is that they never
	// merge into one run and never collide on the (contentType, startIndex)
	// identity key, even though the second segment starts exactly where the
	// first one's block range ends.
	await handleAgentEvent(
		host,
		messageUpdate([
			{ type: "text", text: "First." },
			{ type: "thinking", thinking: "Second." },
		]),
	);

	const textRuns = rs.renderedSegments.filter((s: any) => s.kind === "text-run") as any[];
	assert.equal(textRuns.length, 2, "two distinct contentTypes at adjacent indices must produce two segments");
	assert.notEqual(
		textRuns[0].component,
		textRuns[1].component,
		"the two adjacent segments must have distinct components",
	);
	assert.equal(textRuns[0].contentType, "text");
	assert.equal(textRuns[1].contentType, "thinking");
});

test("renderedSegments order matches chatContainer order", async () => {
	const chatContainer = new Container();
	const rs = createStreamingRenderState();
	const host = makeMinimalHost(chatContainer, rs);

	await streamTwoTextRunsWithTool(host);

	const componentOrder = rs.renderedSegments.map((seg) => seg.component);
	let cursor = -1;
	for (const comp of componentOrder) {
		const idx = chatContainer.children.indexOf(comp as any);
		assert.ok(
			idx > cursor,
			"each rendered segment's component must appear later in chatContainer than the previous one",
		);
		cursor = idx;
	}
});

test("an empty assistant message creates no component", async () => {
	const chatContainer = new Container();
	const rs = createStreamingRenderState();
	const host = makeMinimalHost(chatContainer, rs);

	await handleAgentEvent(host, { type: "message_start", message: { role: "assistant", content: [] } } as any);
	await assert.doesNotReject(async () => {
		await handleAgentEvent(host, messageEnd([]));
	});

	assert.equal(chatContainer.children.length, 0, "an empty message must create no component");
});
