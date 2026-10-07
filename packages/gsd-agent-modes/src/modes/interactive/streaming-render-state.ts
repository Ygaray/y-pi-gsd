import type { Markdown, TUI } from "@gsd/pi-tui";

import type { AssistantMessageComponent } from "./components/assistant-message.js";
import type { DynamicBorder } from "./components/dynamic-border.js";
import {
	ToolExecutionComponent,
	ToolPhaseSummaryComponent,
	type ToolExecutionPhase,
} from "./components/tool-execution.js";

/** Cache for buildDesiredSegmentsForMessage — avoids O(n) block iteration during streaming. */
export interface DesiredSegmentsCache {
	count: number;
	hideThinkingBlock: boolean;
	segments: DesiredSegment[];
}

/** Per streaming assistant turn — text runs, tools, and rollup summaries. */
export type RenderedSegment =
	| {
			kind: "text-run";
			startIndex: number;
			endIndex: number;
			contentType: "text" | "thinking";
			component: AssistantMessageComponent;
			/** Snapshot for redundant sub-turn detection after content[] shrinks. */
			cachedText?: string;
			/** Cached text length — fast O(1) comparison to avoid string allocation. */
			cachedTextLength?: number;
			/** `rs.shrinkGeneration` at the moment this segment was minted or reclaimed into `rs.renderedSegments`. */
			createdAtGeneration?: number;
			/** `rs.shrinkGeneration` at the moment this segment was displaced into `rs.orphanedSegments`. */
			orphanedAtGeneration?: number;
	  }
	| {
			kind: "tool";
			contentIndex: number;
			component: ToolExecutionComponent;
			/** `rs.shrinkGeneration` at the moment this segment was minted or reclaimed into `rs.renderedSegments`. */
			createdAtGeneration?: number;
			/** `rs.shrinkGeneration` at the moment this segment was displaced into `rs.orphanedSegments`. */
			orphanedAtGeneration?: number;
	  }
	| { kind: "tool-summary"; component: ToolPhaseSummaryComponent; phases: ToolExecutionPhase[] };

export type DesiredSegment =
	| { kind: "text-run"; startIndex: number; endIndex: number; contentType: "text" | "thinking" }
	| { kind: "tool"; contentIndex: number; toolId: string };

export type ToolRegistrationSource = "content" | "standalone";

/**
 * Per InteractiveMode instance: streaming transcript walker + pinned message zone.
 * Replaces module-level globals in chat-controller.ts.
 */
export class StreamingRenderState {
	lastProcessedContentIndex = 0;
	lastContentLength = 0;
	renderedSegments: RenderedSegment[] = [];
	/** Displaced segments when provider sub-turn shrinks content[] mid-lifecycle. */
	orphanedSegments: RenderedSegment[] = [];
	/**
	 * Monotonically-incrementing per-shrink generation counter, bumped once per
	 * `applySubTurnContentShrink()` call that actually displaces segments into
	 * `orphanedSegments` (either the primary shrink arm or the
	 * `isSubTurnTextReplacement` arm). Scoped to sub-turn shrink events, NOT
	 * whole-turn boundaries — deliberately distinct from `assistantTurnSeq`
	 * below, which cannot serve this purpose because it only advances at
	 * `resetForNewAssistantMessage()` (once per whole new assistant message,
	 * never per in-turn shrink). Stamped onto displaced `RenderedSegment`
	 * entries' `orphanedAtGeneration` field so a later drain pass can prove
	 * generational supersession rather than relying on content pattern alone.
	 */
	shrinkGeneration = 0;
	readonly toolRegistrationSources = new WeakMap<ToolExecutionComponent, Set<ToolRegistrationSource>>();

	lastPinnedText = "";
	hasToolsInTurn = false;
	pinnedBorder: DynamicBorder | undefined;
	pinnedTextComponent: Markdown | undefined;
	pinnedZoneNeedsViewportRealign = false;

	/** Cache for buildDesiredSegmentsForMessage — avoids O(n) block iteration during streaming. */
	_desiredSegmentsCache?: DesiredSegmentsCache;

	/**
	 * Monotonically-incrementing turn-boundary counter, bumped only by
	 * `resetForNewAssistantMessage()` — i.e. only when a `message_start` for
	 * an assistant message (or a session-change reset) actually begins a new
	 * lifecycle. This is the PRIMARY signal chat-controller.ts's message_end
	 * handler uses to detect a genuinely bare repeated `message_end` (no new
	 * turn began since the last finalization) — never content equality
	 * alone, so a genuinely new turn whose content coincidentally matches a
	 * prior turn's content is never mistaken for a repeat (25-05).
	 */
	assistantTurnSeq = 0;
	/** Snapshot of `assistantTurnSeq` taken at the last message_end finalization. */
	finalizedTurnSeq = -1;
	/** Content fingerprint taken at the last message_end finalization — defense-in-depth second check alongside `finalizedTurnSeq`, never the only signal. */
	finalizedContentFingerprint: string | undefined = undefined;

	resetStreamingSegments(): void {
		this.lastProcessedContentIndex = 0;
		this.lastContentLength = 0;
		this.renderedSegments = [];
		this.orphanedSegments = [];
		this.shrinkGeneration = 0;
	}

	resetPinnedZone(): void {
		if (this.pinnedBorder) {
			this.pinnedBorder.stopSpinner();
		}
		this.pinnedBorder = undefined;
		this.pinnedTextComponent = undefined;
		this.lastPinnedText = "";
		this.hasToolsInTurn = false;
		this.pinnedZoneNeedsViewportRealign = false;
	}

	resetForNewAssistantMessage(): void {
		this.assistantTurnSeq++;
		this.resetStreamingSegments();
		this.resetPinnedZone();
	}

	resetForSessionChange(): void {
		this.resetForNewAssistantMessage();
	}

	/**
	 * Request an immediate render at stream boundaries (message_end, agent_end)
	 * so the final state paints without any delay.
	 */
	flushPendingStreamingWork(ui: TUI): void {
		// Not forced: force-realigning the viewport here would break the
		// "no force-render when pinned zone was never shown" contract.
		ui.requestRender();
	}
}

export function createStreamingRenderState(): StreamingRenderState {
	return new StreamingRenderState();
}
