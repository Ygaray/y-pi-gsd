/**
 * Maps the Claude Agent SDK's own `rate_limit_event` message into the same
 * `RateLimitWindow`/`RateLimitStatus` shape `packages/gsd-agent-core/src/rate-limit-headers.ts`
 * already defines for the header-parsing path.
 *
 * D-02/D-03 (38-CONTEXT.md): this is an additive producer feeding the existing
 * `rateLimitStatusRef` sink `sdk.ts` owns — nothing here changes `rate-limit-headers.ts` or the
 * footer's consumer side.
 */

import type { SDKRateLimitInfo } from "./sdk-types.js";

/** Which footer row a mapped window belongs to. */
export type ClaudeCodeRateLimitWindowKey = "session" | "weekly";

/** Structurally identical to `rate-limit-headers.ts`'s `RateLimitWindow`, which this feeds. */
export interface ClaudeCodeRateLimitWindow {
	usedPercent: number;
	resetsAtEpochSec: number | null;
}

/** The resolved window-key + window pair for one `rate_limit_event`. */
export interface ClaudeCodeRateLimitMapping {
	windowKey: ClaudeCodeRateLimitWindowKey;
	window: ClaudeCodeRateLimitWindow;
}

/**
 * Resolves the footer row a `rateLimitType` belongs to.
 *
 * `five_hour` maps to `session`. Any `rateLimitType` whose value is exactly `seven_day` or
 * starts with that prefix — covering the `seven_day_opus` and `seven_day_sonnet` variants named
 * in the installed `.d.ts` — maps to `weekly`. Per 38-CONTEXT's deferred-ideas entry, all
 * `seven_day*` variants collapse into the single `weekly` bucket; no per-variant window is added.
 * `overage`, an unrecognised string, and `undefined` map to nothing (`null`) — the honest outcome
 * is leaving the consumer at the existing `unavailable` literal rather than attributing a number
 * to the wrong window.
 */
function resolveWindowKey(rateLimitType: unknown): ClaudeCodeRateLimitWindowKey | null {
	if (typeof rateLimitType !== "string") return null;
	if (rateLimitType === "five_hour") return "session";
	if (rateLimitType === "seven_day" || rateLimitType.startsWith("seven_day")) return "weekly";
	return null;
}

/**
 * Resolves a used-percent from the SDK's `utilization` field.
 *
 * The installed `.d.ts` annotates no unit (38-RESEARCH.md Assumptions A1/A2), so the scale is
 * resolved by magnitude: a value at or below 1 is read as a 0-1 fraction and multiplied by 100; a
 * value above 1 is already a percentage and passes through unchanged. The single genuinely
 * ambiguous input is exactly 1 (100% under the fraction reading, 1% under the percentage
 * reading) — the fraction reading is taken because the field sits beside `surpassedThreshold` and
 * is named `utilization`, and Task 3's live capture is what settles it.
 *
 * Clamping mirrors `clampPercent`'s three rules: below 0 becomes 0, above 100 becomes 100, `NaN`
 * yields `null` for the whole window rather than a manufactured 0. This is a `typeof`/
 * `Number.isFinite` check, never a truthiness test — a real 0 must survive.
 */
function resolveUsedPercent(utilization: unknown): number | null {
	if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
	const scaled = utilization <= 1 ? utilization * 100 : utilization;
	if (Number.isNaN(scaled)) return null;
	if (scaled < 0) return 0;
	if (scaled > 100) return 100;
	return scaled;
}

/**
 * Resolves the reset instant from the SDK's `resetsAt` field.
 *
 * Mirrors `parseResetValue`'s own magnitude rule verbatim: above 1e12 it is epoch milliseconds
 * and is divided by 1000, otherwise it is already epoch seconds. Anything else (absent,
 * non-finite, non-numeric) yields `null`, which `formatMeterRowSegment` already renders as a bar
 * with no countdown — an absent or unusable reset must not discard an otherwise-good percent.
 */
function resolveResetsAtEpochSec(resetsAt: unknown): number | null {
	if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
	return Math.round(resetsAt > 1e12 ? resetsAt / 1000 : resetsAt);
}

/**
 * Maps a raw SDK `rate_limit_info` payload into `{ windowKey, window }`, or `null` when the
 * payload is malformed, unmappable, or carries no usable percent.
 *
 * The whole body is wrapped in a `try` whose `catch` returns `null`, mirroring
 * `parseAnthropicRateLimitHeaders`'s documented never-throw contract — this runs on the live
 * stream hot path, where a throw would abort the operator's turn (T-38-01).
 */
export function mapSdkRateLimitInfo(info: unknown): ClaudeCodeRateLimitMapping | null {
	try {
		if (info === null || typeof info !== "object") return null;
		const payload = info as SDKRateLimitInfo;

		const windowKey = resolveWindowKey(payload.rateLimitType);
		if (windowKey === null) return null;

		const usedPercent = resolveUsedPercent(payload.utilization);
		if (usedPercent === null) return null;

		const resetsAtEpochSec = resolveResetsAtEpochSec(payload.resetsAt);

		return { windowKey, window: { usedPercent, resetsAtEpochSec } };
	} catch {
		return null;
	}
}
