// Project/App: gsd-pi
// File Purpose: Segment walker and message_end rebuild for interactive chat streaming.
import type { InteractiveModeStateHost } from "../interactive-mode-state.js";
import type { DesiredSegment, RenderedSegment, StreamingRenderState } from "../streaming-render-state.js";
import { AssistantMessageComponent } from "../components/assistant-message.js";
import type { TimestampFormat } from "../components/timestamp.js";
import { reconcileChatTurnConnections } from "../components/chat-turn-connect.js";
import { ToolExecutionComponent, coerceToolNameForDisplay } from "../components/tool-execution.js";
import { markFirstVisibleAssistantOutput } from "./chat-controller-latency.js";
import {
	buildDesiredSegmentsForMessage,
	filterRedundantDiscussTextRuns,
	getProvisionalPreToolPrunePlan,
	getTextFromContentBlocks,
	getTextLengthFromContentBlocks,
	isProvisionalPreToolProse,
	isSubTurnTextReplacement,
	shouldSuppressRedundantHandoffText,
} from "./chat-handoff-filter.js";
import { registerPendingToolComponent } from "./chat-tool-rollup.js";

/** Host surface for streaming helpers — extends state host with mode methods. */
type ChatStreamHost = InteractiveModeStateHost & {
	formatWebSearchResult: (content: unknown) => string;
	getRegisteredToolDefinition: (toolName: string) => any;
	getMarkdownThemeWithSettings: () => any;
};

export function applySubTurnContentShrink(
	rs: StreamingRenderState,
	contentBlocks: Array<any>,
): void {
	const replacedAt = contentBlocks.length <= rs.lastContentLength
		? isSubTurnTextReplacement(contentBlocks, rs.renderedSegments)
		: null;
	if (contentBlocks.length < rs.lastContentLength) {
		// WR-02 fix (37-REVIEW.md): only bump shrinkGeneration and
		// accumulate orphans when there is something to actually displace —
		// matching this field's own doc comment in streaming-render-state.ts
		// ("bumped once per applySubTurnContentShrink() call that actually
		// displaces segments"). A shrink detected before anything has ever
		// been rendered (rs.renderedSegments empty) has nothing to orphan
		// and must not advance the generation counter.
		if (rs.renderedSegments.length > 0) {
			// Accumulate across successive shrinks — overwriting would drop
			// segments displaced by an earlier shrink, leaving them stranded
			// in chatContainer once the prune pass finally runs.
			rs.shrinkGeneration++;
			const newlyOrphaned = rs.renderedSegments.map((seg) => ({ ...seg, orphanedAtGeneration: rs.shrinkGeneration }));
			rs.orphanedSegments = [...rs.orphanedSegments, ...newlyOrphaned];
			rs.renderedSegments = [];
		}
		rs.lastPinnedText = "";
		rs.lastProcessedContentIndex = 0;
	} else if (replacedAt !== null) {
		// Same-index wholesale replacement: orphan only the replaced
		// text-run and any text-runs after it. Earlier unchanged text
		// and tool segments stay in rs.renderedSegments so they are not
		// re-rendered and duplicated in chatContainer.
		// WR-02 fix: only bump the generation when this branch actually
		// displaces a segment (see comment above).
		const displaced = rs.renderedSegments.filter((seg) => seg.kind === "text-run" && seg.startIndex >= replacedAt);
		if (displaced.length > 0) {
			rs.shrinkGeneration++;
			const newlyOrphaned = displaced.map((seg) => ({ ...seg, orphanedAtGeneration: rs.shrinkGeneration }));
			rs.orphanedSegments = [...rs.orphanedSegments, ...newlyOrphaned];
			rs.renderedSegments = rs.renderedSegments.filter(
				(seg) => !(seg.kind === "text-run" && seg.startIndex >= replacedAt),
			);
		}
		rs.lastPinnedText = "";
		rs.lastProcessedContentIndex = replacedAt;
	} else if (rs.lastProcessedContentIndex >= contentBlocks.length) {
		rs.lastProcessedContentIndex = 0;
	}
	rs.lastContentLength = contentBlocks.length;
}

export function scanNewContentBlocks(
	host: ChatStreamHost,
	rs: StreamingRenderState,
	contentBlocks: Array<any>,
): void {
	for (let i = rs.lastProcessedContentIndex; i < contentBlocks.length; i++) {
		const content = contentBlocks[i];
		if (content.type === "toolCall") {
			// Coerce BEFORE registration/construction, matching the invariant the
			// standalone path (chat-controller.ts's tool_execution_start handler)
			// already enforces — the "coerce before construction" half of D-02
			// applied consistently regardless of ingestion entry point (WR-04).
			const displayToolName = coerceToolNameForDisplay(content.name);
			const { component } = registerPendingToolComponent(
				host,
				content.id,
				displayToolName,
				content.arguments,
				"content",
				() =>
					new ToolExecutionComponent(
						displayToolName,
						content.arguments,
						{ showImages: host.settingsManager.getShowImages(), source: "content" },
						host.getRegisteredToolDefinition(content.name),
						host.ui,
					),
			);
			component.updateArgs(content.arguments);
		} else if (content.type === "serverToolUse") {
			registerPendingToolComponent(
				host,
				content.id,
				content.name,
				content.input ?? {},
				"content",
				() =>
					new ToolExecutionComponent(
						content.name,
						content.input ?? {},
						{ showImages: host.settingsManager.getShowImages(), source: "content" },
						undefined,
						host.ui,
					),
			);
		} else if (content.type === "webSearchResult") {
			const component = host.pendingTools.get(content.toolUseId);
			if (component) {
				if (process.env.PI_OFFLINE === "1") {
					component.updateResult({
						content: [{ type: "text", text: "Web search disabled (offline mode)" }],
						isError: false,
					});
				} else {
					const searchContent = content.content;
					const isError = searchContent && typeof searchContent === "object" && "type" in (searchContent as any) && (searchContent as any).type === "web_search_tool_result_error";
					component.updateResult({
						content: [{ type: "text", text: host.formatWebSearchResult(searchContent) }],
						isError: !!isError,
					});
				}
			}
		}
	}
}

/**
 * Scans `rs.orphanedSegments` from the END backwards for a text-run orphan
 * whose `contentType` exactly matches `desiredSeg`'s — the narrowest rule the
 * tests admit (RESEARCH Open Design Point 1). Last-in-first-reclaimed matches
 * the single-collapse-then-restream shape this bug targets, where one shrink
 * moves the whole `renderedSegments` array across in order. The `contentType`
 * equality clause is prohibition P-02's enforcement point — an exact `===` on
 * the two literal union values, never loose or normalized — so a `thinking`
 * orphan can never be reclaimed for a `text` desired segment, or the reverse.
 * Matching never considers `cachedText`, `startIndex`, or text length:
 * `startIndex` restarts at 0 after a collapse and `cachedText` is by
 * definition the pre-collapse snapshot, so neither survives the event this
 * matcher must see through.
 *
 * On a match, splices the entry out of `rs.orphanedSegments` (so it can never
 * be double-reclaimed and can never be seen by Task 3's drain), clears its
 * `orphanedAtGeneration`, and returns it. On no match, returns `undefined` and
 * leaves `rs.orphanedSegments` untouched.
 */
function reclaimOrphanedTextRun(
	rs: StreamingRenderState,
	desiredSeg: Extract<DesiredSegment, { kind: "text-run" }>,
): Extract<RenderedSegment, { kind: "text-run" }> | undefined {
	for (let i = rs.orphanedSegments.length - 1; i >= 0; i--) {
		const candidate = rs.orphanedSegments[i];
		if (candidate.kind === "text-run" && candidate.contentType === desiredSeg.contentType) {
			rs.orphanedSegments.splice(i, 1);
			candidate.orphanedAtGeneration = undefined;
			return candidate;
		}
	}
	return undefined;
}

/**
 * Drains `rs.orphanedSegments`, unconditionally on every walker pass — no
 * longer gated on `shouldPruneProvisionalPreToolProse` (D-02, SC-2). A pure
 * thinking/text turn with no tool call anywhere was the RENDER-01 leak this
 * closes: `shouldPruneProvisionalPreToolProse` is permanently `false` for
 * such a turn (`firstToolIdx === -1`), so the old gated-only drain never ran
 * and an unreclaimed orphan stayed a live, untracked child of
 * `chatContainer` forever.
 *
 * Removal requires EITHER of two disjoint conditions — never content pattern
 * alone (Pitfall 10's exact warning):
 *
 * - Condition A (superseded-slot): a LIVE `rs.renderedSegments` entry of the
 *   same `contentType` was created/reclaimed at a strictly later generation
 *   than this orphan was displaced. This is a pure non-content identity
 *   signal — no text is inspected — and is what actually closes SC-2: a
 *   newer component provably occupies the same logical content slot, so the
 *   orphan is a stale duplicate.
 * - Condition B (provisional-prose): the orphan's cached text matches
 *   `isProvisionalPreToolProse` AND at least one later shrink has occurred
 *   since this orphan was displaced (`orphanedAtGeneration < rs.shrinkGeneration`).
 *   The generational clause is the whole of Pitfall 10's protection — without
 *   it, a legitimate final answer that merely resembles provisional phrasing
 *   and was JUST orphaned by the shrink currently in flight would be eaten on
 *   the very same pass it was displaced, before it ever had a chance to
 *   regrow. Content pattern alone is never sufficient (P-01): deleting either
 *   clause reintroduces a real failure mode this gate exists to prevent — do
 *   not simplify this to a single condition believing the other redundant.
 *
 * A missing `orphanedAtGeneration` or `createdAtGeneration` never satisfies
 * either condition — absence of evidence must never authorise a removal
 * (P-01). Anything matching neither condition is pushed back, never dropped.
 * Only `kind: "text-run"` orphans are considered — `kind: "tool"` cleanup is
 * plan 37-03's scope, gated on the D-03 verdict recorded in 37-01-SUMMARY.
 */
function drainOrphanedSegments(host: ChatStreamHost, rs: StreamingRenderState): void {
	if (rs.orphanedSegments.length === 0) return;
	const remainingOrphans: RenderedSegment[] = [];
	for (const orphan of rs.orphanedSegments) {
		if (orphan.kind !== "text-run") {
			remainingOrphans.push(orphan);
			continue;
		}
		const supersededBySlot = rs.renderedSegments.some(
			(live) =>
				live.kind === "text-run"
				&& live.contentType === orphan.contentType
				&& live.createdAtGeneration !== undefined
				&& orphan.orphanedAtGeneration !== undefined
				&& live.createdAtGeneration > orphan.orphanedAtGeneration,
		);
		const supersededByProvisionalProse =
			orphan.contentType === "text"
			&& isProvisionalPreToolProse(orphan.cachedText ?? "")
			&& orphan.orphanedAtGeneration !== undefined
			&& orphan.orphanedAtGeneration < rs.shrinkGeneration;
		if (supersededBySlot || supersededByProvisionalProse) {
			host.chatContainer.removeChild(orphan.component);
			if (host.streamingComponent === orphan.component) {
				host.streamingComponent = undefined;
			}
			continue;
		}
		remainingOrphans.push(orphan);
	}
	rs.orphanedSegments = remainingOrphans;
}

export function runSegmentWalker(
	host: ChatStreamHost,
	rs: StreamingRenderState,
	timestampFormat: TimestampFormat,
): void {
	const blocks = host.streamingMessage.content;

	// NOTE: _desiredSegmentsCache is intentionally disabled — it causes
	// stale text length during streaming, resulting in blocked incremental
	// updates. Benchmark showed zero measurable CPU benefit for cache ON
	// vs OFF (both ~1-2%). Keeping cache OFF for correct streaming;
	// re-enable later with a proper invalidation strategy.
	const blockCount = blocks.length;
	let desired: ReturnType<typeof buildDesiredSegmentsForMessage>;
	let shouldPruneProvisionalPreToolProse = false;
	{
		const { shouldPrune: pruneFlag } =
			getProvisionalPreToolPrunePlan(host.streamingMessage);
		shouldPruneProvisionalPreToolProse = pruneFlag;
		desired = buildDesiredSegmentsForMessage(host.streamingMessage, {
			hideThinkingBlock: host.hideThinkingBlock,
		});
	}
	desired = filterRedundantDiscussTextRuns(desired, blocks);

	// CR-01 fix (37-REVIEW.md): generalized reconciliation that runs
	// UNCONDITIONALLY on every pass — never gated behind
	// shouldPruneProvisionalPreToolProse, which itself requires an MCP tool
	// block (isMcpToolBlock in chat-handoff-filter.ts) and therefore never
	// fires for a plain (non-MCP) tool call. Without this, a live text-run
	// segment whose startIndex drifts out from under it on a subsequent
	// GROWTH (non-shrink) delta — e.g. a reappearing leading `thinking`
	// block pushing a previously-reclaimed text segment's true slot from
	// startIndex 0 to startIndex 1 — was never re-validated against the
	// freshly-computed `desired` set, so it survived as a dangling,
	// untracked, blank AssistantMessageComponent in chatContainer (SC-2
	// violation). Any live text-run whose (contentType, startIndex) key no
	// longer appears in `desired` is demoted back into `rs.orphanedSegments`
	// (stamped with the current `rs.shrinkGeneration`) rather than removed
	// outright, so the append loop below (and, failing that,
	// drainOrphanedSegments) can still reclaim or clean it up — never a
	// destructive removeChild here, consistent with this phase's
	// reclaim-over-remove design (P-01/P-02). Must run BEFORE the append
	// loop so a displaced entry is reclaim-eligible for any desired segment
	// processed later in this same pass.
	const desiredTextKeys = new Set(
		desired
			.filter((seg): seg is Extract<typeof desired[number], { kind: "text-run" }> => seg.kind === "text-run")
			.map((seg) => `${seg.contentType}:${seg.startIndex}`),
	);
	{
		const stillLive: RenderedSegment[] = [];
		for (const seg of rs.renderedSegments) {
			if (seg.kind === "text-run" && !desiredTextKeys.has(`${seg.contentType}:${seg.startIndex}`)) {
				rs.orphanedSegments.push({ ...seg, orphanedAtGeneration: rs.shrinkGeneration });
				continue;
			}
			stillLive.push(seg);
		}
		rs.renderedSegments = stillLive;
	}

	// Claude Code MCP can emit provisional pre-tool prose that gets
	// superseded by post-tool output. Layered ON TOP of the generalized
	// reconciliation above (not the only gate): additionally drop stale
	// tool bookkeeping entries whose contentIndex no longer appears in
	// `desired` when an MCP tool call confirms supersession. This never
	// touches text-run segments — those were already reclassified above.
	if (shouldPruneProvisionalPreToolProse) {
		const desiredToolIndices = new Set(
			desired
				.filter((seg): seg is Extract<typeof desired[number], { kind: "tool" }> => seg.kind === "tool")
				.map((seg) => seg.contentIndex),
		);
		rs.renderedSegments = rs.renderedSegments.filter(
			(seg) => !(seg.kind === "tool" && !desiredToolIndices.has(seg.contentIndex)),
		);
	}

	// Append any newly needed segments (never reorder existing ones).
	for (const seg of desired) {
		if (seg.kind === "tool") {
			// Tool segments are already handled above via pendingTools; just
			// register them in rs.renderedSegments if not yet tracked.
			const existing = rs.renderedSegments.find(
				(s) => s.kind === "tool" && s.contentIndex === seg.contentIndex,
			);
			if (!existing) {
				const comp = host.pendingTools.get(seg.toolId);
				if (comp) {
					// WR-01 fix (37-REVIEW.md): a reused tool id can leave a stale
					// bookkeeping entry under its PRE-shrink contentIndex in both
					// rs.renderedSegments (the contentIndex-keyed `existing` lookup
					// above misses it after a shrink+regrow shifts the index) and
					// rs.orphanedSegments (tool-kind orphans are never drained —
					// see drainOrphanedSegments' own doc comment: "kind: tool
					// cleanup is plan 37-03's scope"). Strip both by COMPONENT
					// IDENTITY (not contentIndex) before pushing the fresh entry,
					// so at most one bookkeeping entry per live tool component
					// ever exists — this never calls removeChild, so an in-flight
					// or completed tool's actual chatContainer child is untouched.
					rs.renderedSegments = rs.renderedSegments.filter(
						(s) => !(s.kind === "tool" && s.component === comp),
					);
					rs.orphanedSegments = rs.orphanedSegments.filter(
						(o) => !(o.kind === "tool" && o.component === comp),
					);
					rs.renderedSegments.push({ kind: "tool", contentIndex: seg.contentIndex, component: comp });
				}
			}
		} else {
			// text-run segment
			const existing = rs.renderedSegments.find(
				(s) => s.kind === "text-run" && s.startIndex === seg.startIndex && s.contentType === seg.contentType,
			);
			if (!existing) {
				const segmentText = getTextFromContentBlocks(blocks, seg.startIndex, seg.endIndex, seg.contentType);
				if (
					seg.contentType === "text" &&
					shouldSuppressRedundantHandoffText(
						host.session.messages,
						segmentText,
						rs.orphanedSegments,
						rs.renderedSegments,
					)
				) {
					continue;
				}
				const reclaimed = reclaimOrphanedTextRun(rs, seg);
				if (reclaimed) {
					// D-01: reuse the orphaned component in place via the same
					// setRange()/updateContent() reconcile path the update loop
					// below already uses for never-orphaned segments — never
					// addChild (it is already a live child, per
					// applySubTurnContentShrink's own comment) and never
					// markFirstVisibleAssistantOutput (it was already visible).
					reclaimed.startIndex = seg.startIndex;
					reclaimed.endIndex = seg.endIndex;
					reclaimed.component.setRange({ startIndex: reclaimed.startIndex, endIndex: reclaimed.endIndex });
					reclaimed.component.updateContent(host.streamingMessage);
					reclaimed.cachedText = segmentText;
					reclaimed.cachedTextLength = segmentText.length;
					reclaimed.createdAtGeneration = rs.shrinkGeneration;
					rs.renderedSegments.push(reclaimed);
					host.streamingComponent = reclaimed.component;
					reconcileChatTurnConnections(host.chatContainer.children);
					continue;
				}
				const comp = new AssistantMessageComponent(
					undefined,
					host.hideThinkingBlock,
					host.getMarkdownThemeWithSettings(),
					timestampFormat,
					{ startIndex: seg.startIndex, endIndex: seg.endIndex },
				);
				host.chatContainer.addChild(comp);
				comp.updateContent(host.streamingMessage);
				markFirstVisibleAssistantOutput(host, seg.contentType, {
					contentIndex: seg.startIndex,
				});
				rs.renderedSegments.push({
					kind: "text-run",
					startIndex: seg.startIndex,
					endIndex: seg.endIndex,
					contentType: seg.contentType,
					component: comp,
					cachedText: segmentText,
					cachedTextLength: segmentText.length,
					createdAtGeneration: rs.shrinkGeneration,
				});
				host.streamingComponent = comp;
				reconcileChatTurnConnections(host.chatContainer.children);
			}
		}
	}

	// D-02/SC-2: drain whatever remains in rs.orphanedSegments unconditionally
	// — every walker pass, not gated on shouldPruneProvisionalPreToolProse —
	// now that the reclaim pass above has already pulled every matchable
	// orphan back out. See drainOrphanedSegments' own doc comment for the
	// two-condition removal gate.
	drainOrphanedSegments(host, rs);

	// Update all trailing text-run segments with the latest message so
	// streaming text grows in place.
	// Optimization: use getTextLengthFromContentBlocks as a fast O(1) cache
	// check to avoid allocating new strings via getTextFromContentBlocks on
	// every streaming delta.
	for (const seg of rs.renderedSegments) {
		if (seg.kind === "text-run") {
			// Find corresponding desired segment to get current endIndex
			const d = desired.find(
				(ds) => ds.kind === "text-run" && ds.startIndex === seg.startIndex && ds.contentType === seg.contentType,
			);
			if (d && d.kind === "text-run" && d.endIndex !== seg.endIndex) {
				seg.endIndex = d.endIndex;
				seg.component.setRange({ startIndex: seg.startIndex, endIndex: seg.endIndex });
			}
			// Fast length check — skip string allocation if unchanged
			const newLength = getTextLengthFromContentBlocks(blocks, seg.startIndex, seg.endIndex, seg.contentType);
			if (newLength !== seg.cachedTextLength) {
				seg.cachedTextLength = newLength;
				const newText = getTextFromContentBlocks(blocks, seg.startIndex, seg.endIndex, seg.contentType);
				seg.cachedText = newText;
				seg.component.updateContent(host.streamingMessage);
			}
		}
	}

	// Keep streamingComponent pointing at the last text-run for message_end compatibility.
	const lastTextSeg = [...rs.renderedSegments].reverse().find((s) => s.kind === "text-run");
	if (lastTextSeg && lastTextSeg.kind === "text-run") {
		host.streamingComponent = lastTextSeg.component;
	}
}

/**
 * Comparable identity for one `desired` or `rs.renderedSegments` entry.
 * Used only to detect an already-committed message_end repeat — never a
 * general resemblance check. Text is compared via exact string equality:
 * the rendered side reads the already-stored `cachedText` field (no
 * re-derivation), and the desired side reads a fresh
 * `getTextFromContentBlocks()` — neither is normalized or trimmed, so a
 * whitespace-differing rebuild is never mistaken for identical.
 */
function segmentFingerprint(
	seg: DesiredSegment | RenderedSegment,
	finalBlocks: Array<any>,
): string {
	if (seg.kind === "tool") return `tool:${seg.contentIndex}`;
	if (seg.kind !== "text-run") return `other:${seg.kind}`;
	const text = "cachedText" in seg
		? (seg.cachedText ?? "")
		: getTextFromContentBlocks(finalBlocks, seg.startIndex, seg.endIndex, seg.contentType);
	return `text-run:${seg.contentType}:${seg.startIndex}:${seg.endIndex}:${text}`;
}

/**
 * True only when `rs.renderedSegments` already reflects `desired` exactly —
 * same segments, in the same order, with identical text — so
 * `rebuildSegmentsOnMessageEnd` can skip its destructive remove-then-re-add
 * cycle for a repeated message_end whose final content did not change.
 * `shouldSuppressRedundantHandoffText`-suppressed text-runs are excluded
 * from the desired side first (same predicate the rebuild loop below
 * applies), so a segment that is legitimately never rendered is not
 * misread as "missing" and does not force a pointless rebuild. Position
 * matters: compared index-for-index, never as unordered sets, so a
 * reordering still counts as a change and still rebuilds.
 */
function renderedSegmentsMatchDesired(
	host: ChatStreamHost,
	rs: StreamingRenderState,
	desired: DesiredSegment[],
	finalBlocks: Array<any>,
): boolean {
	const expectedDesired = desired.filter((seg) => {
		if (seg.kind !== "text-run" || seg.contentType !== "text") return true;
		const segmentText = getTextFromContentBlocks(finalBlocks, seg.startIndex, seg.endIndex, seg.contentType);
		return !shouldSuppressRedundantHandoffText(
			host.session.messages,
			segmentText,
			rs.orphanedSegments,
			rs.renderedSegments,
		);
	});

	if (expectedDesired.length !== rs.renderedSegments.length) return false;

	for (let i = 0; i < expectedDesired.length; i++) {
		if (segmentFingerprint(expectedDesired[i], finalBlocks) !== segmentFingerprint(rs.renderedSegments[i], finalBlocks)) {
			return false;
		}
	}
	return true;
}

export function rebuildSegmentsOnMessageEnd(
	host: ChatStreamHost,
	rs: StreamingRenderState,
	timestampFormat: TimestampFormat,
): void {
	if (rs.renderedSegments.length === 0) return;

	const finalBlocks = host.streamingMessage.content;
	const desired = filterRedundantDiscussTextRuns(
		buildDesiredSegmentsForMessage(host.streamingMessage, {
			hideThinkingBlock: host.hideThinkingBlock,
		}),
		finalBlocks,
	);

	if (renderedSegmentsMatchDesired(host, rs, desired, finalBlocks)) return;

	const toolComponentsById = new Map<string, ToolExecutionComponent>();
	for (const [toolId, component] of host.pendingTools.entries()) {
		toolComponentsById.set(toolId, component);
	}

	for (const seg of rs.renderedSegments) {
		host.chatContainer.removeChild(seg.component);
		if (seg.kind === "tool") {
			// Defense-in-depth no-op (IN-01): `finalBlocks` (captured above from
			// host.streamingMessage.content, never reassigned in between) IS this
			// same array — there is no separate "prior" snapshot to recover here.
			// This backfill is guarded by `!toolComponentsById.has(...)`, and
			// toolComponentsById is pre-seeded from host.pendingTools, which (per
			// this file's own invariant that tool components are never removed
			// from pendingTools mid-turn) already contains every live tool id, so
			// this branch is unlikely to ever add anything new. Kept as a safety
			// net rather than removed outright, in case that invariant is ever
			// violated by a future change.
			const priorBlock = finalBlocks[seg.contentIndex] as any;
			if (priorBlock?.id && !toolComponentsById.has(priorBlock.id)) {
				toolComponentsById.set(priorBlock.id, seg.component);
			}
		}
	}
	rs.renderedSegments = [];
	host.streamingComponent = undefined;

	for (const seg of desired) {
		if (seg.kind === "tool") {
			const finalBlock = finalBlocks[seg.contentIndex] as any;
			let component = toolComponentsById.get(seg.toolId);
			if (!component && finalBlock?.id) {
				component = host.pendingTools.get(finalBlock.id);
			}
			if (!component && finalBlock?.type === "toolCall") {
				component = new ToolExecutionComponent(
					finalBlock.name,
					finalBlock.arguments,
					{ showImages: host.settingsManager.getShowImages(), source: "content" },
					host.getRegisteredToolDefinition(finalBlock.name),
					host.ui,
				);
				component.setExpanded(host.toolOutputExpanded);
				host.pendingTools.set(finalBlock.id, component);
				toolComponentsById.set(finalBlock.id, component);
			} else if (!component && finalBlock?.type === "serverToolUse") {
				component = new ToolExecutionComponent(
					finalBlock.name,
					finalBlock.input ?? {},
					{ showImages: host.settingsManager.getShowImages(), source: "content" },
					undefined,
					host.ui,
				);
				component.setExpanded(host.toolOutputExpanded);
				host.pendingTools.set(finalBlock.id, component);
				toolComponentsById.set(finalBlock.id, component);
			}
			if (component) {
				host.chatContainer.removeChild(component);
				host.chatContainer.addChild(component);
				rs.renderedSegments.push({ kind: "tool", contentIndex: seg.contentIndex, component });
			}
			continue;
		}

		const comp = new AssistantMessageComponent(
			undefined,
			host.hideThinkingBlock,
			host.getMarkdownThemeWithSettings(),
			timestampFormat,
			{ startIndex: seg.startIndex, endIndex: seg.endIndex },
		);
		comp.updateContent(host.streamingMessage);
		const segmentText = getTextFromContentBlocks(finalBlocks, seg.startIndex, seg.endIndex, seg.contentType);
		if (
			seg.contentType === "text" &&
			shouldSuppressRedundantHandoffText(
				host.session.messages,
				segmentText,
				rs.orphanedSegments,
				rs.renderedSegments,
			)
		) {
			continue;
		}
		host.chatContainer.addChild(comp);
		markFirstVisibleAssistantOutput(host, seg.contentType, {
			contentIndex: seg.startIndex,
			source: "message_end_rebuild",
		});
		rs.renderedSegments.push({
			kind: "text-run",
			startIndex: seg.startIndex,
			endIndex: seg.endIndex,
			contentType: seg.contentType,
			component: comp,
			cachedText: segmentText,
			cachedTextLength: segmentText.length,
		});
		host.streamingComponent = comp;
	}
	reconcileChatTurnConnections(host.chatContainer.children);
}
