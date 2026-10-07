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

/**
 * Strips terminal control characters from a value before it is interpolated into a
 * `GSD_DEBUG_RATELIMIT_EVENT` line destined for `console.error` (WR-03, 38-REVIEW.md).
 *
 * `status`/`rateLimitType`/etc. are typed off `SDKRateLimitInfo`, but that typing is just a cast —
 * at runtime these fields can be any JSON value the SDK process sends, including a string carrying
 * ANSI/terminal escape sequences. Mirrors `sanitizeFooterText`'s (`gsd-statusline-format.ts`)
 * CR/LF/TAB-and-ESC stripping discipline for "untrusted-ish value -> terminal" — kept as a local
 * copy rather than a cross-package import since this extension has no dependency on the
 * `gsd-agent-modes` UI package.
 */
function sanitizeDebugField(value: unknown): string {
	if (value === undefined) return "undefined";
	const text = typeof value === "string" ? value : String(value);
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/\x1b/g, "")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Formats one `GSD_DEBUG_RATELIMIT_EVENT` observation line (D-03/D-05, 38-CONTEXT.md).
 *
 * Reads only six named `rate_limit_info` fields off the payload individually -- `status`,
 * `rateLimitType`, `utilization`, `resetsAt`, `isUsingOverage`, `surpassedThreshold` -- plus the
 * mapping outcome. It never serialises the object it was handed and never reads the SDK message
 * envelope (`uuid`, `session_id`): that envelope carries per-session identifiers with no business
 * in an operator's terminal, exactly the scoping discipline the `GSD_DEBUG_RATELIMIT_HEADERS`
 * prefix allowlist enforces for the header path (T-38-02).
 *
 * Never throws for any input, including a non-object payload -- this is a debug-only formatter
 * that must not be able to abort the turn it is observing.
 */
export function formatRateLimitEventDebugLine(
	seq: number,
	elapsedMs: number,
	info: unknown,
	mapped: ClaudeCodeRateLimitMapping | null,
): string {
	try {
		const payload = info !== null && typeof info === "object" ? (info as SDKRateLimitInfo) : undefined;
		const status = payload?.status;
		const rateLimitType = payload?.rateLimitType;
		const utilization = payload?.utilization;
		const resetsAt = payload?.resetsAt;
		const isUsingOverage = payload?.isUsingOverage;
		const surpassedThreshold = payload?.surpassedThreshold;
		const mappingText = mapped
			? `windowKey=${mapped.windowKey} usedPercent=${mapped.window.usedPercent}`
			: "mapping=none";
		return (
			`[GSD_DEBUG_RATELIMIT_EVENT] seq=${seq} elapsedMs=${elapsedMs} status=${sanitizeDebugField(status)} ` +
			`rateLimitType=${sanitizeDebugField(rateLimitType)} utilization=${sanitizeDebugField(utilization)} ` +
			`resetsAt=${sanitizeDebugField(resetsAt)} isUsingOverage=${sanitizeDebugField(isUsingOverage)} ` +
			`surpassedThreshold=${sanitizeDebugField(surpassedThreshold)} ${mappingText}`
		);
	} catch {
		return "[GSD_DEBUG_RATELIMIT_EVENT] <unformattable payload>";
	}
}
