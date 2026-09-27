/**
 * Parses Anthropic provider rate-limit response headers into a session/weekly usage struct.
 *
 * D-03 (28-CONTEXT.md): session/weekly usage figures come from the provider's own rate-limit
 * response headers, delivered in-process to `onResponse` — never from stdin JSON, never a new
 * network call.
 *
 * IMPORTANT — deliberately excludes the *documented* per-minute header family
 * (`anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`,
 * plus the `anthropic-priority-*` mirror). Those describe per-minute token buckets, not
 * "session" (5-hour) or "weekly" (7-day) subscription quota. Mapping a per-minute bucket onto
 * a session/weekly label would be a wrong figure presented as a right one — the honest
 * `unavailable` (this function returning `null` for that window) is the correct outcome.
 *
 * The `anthropic-ratelimit-unified-*` family that the `claude-code` subscription backend
 * actually sends (the 5-hour + 7-day windows this footer wants) is NOT documented on the
 * public rate-limits page (28-RESEARCH.md Assumption A1 / 28-03-PLAN.md A-28-02) — its exact
 * key spelling and value encoding are unverified at authoring time. The two prefix tables below
 * are seeded with plausible spellings and are deliberately table-driven (not hard-coded into
 * the parsing logic) so correcting the real spelling, once observed via the
 * `GSD_DEBUG_RATELIMIT_HEADERS=1` one-shot capture (Task 2), is a one-line data edit rather than
 * a logic rewrite.
 */

export interface RateLimitWindow {
	usedPercent: number;
	resetsAtEpochSec: number | null;
}

export interface RateLimitStatus {
	session: RateLimitWindow | null;
	weekly: RateLimitWindow | null;
}

/**
 * Candidate header-key prefixes for the "session" (5-hour) rate-limit window, tried in order.
 * Sourced from the unverified `anthropic-ratelimit-unified-*` subscription surface (A-28-02) —
 * NOT the publicly documented per-minute families, which are deliberately excluded (see module
 * doc above). Unverified; correct the spelling here once real header names are observed.
 */
export const SESSION_WINDOW_HEADER_PREFIXES: readonly string[] = [
	"anthropic-ratelimit-unified-5h",
	"anthropic-ratelimit-unified-five-hour",
	"anthropic-ratelimit-unified-session",
];

/**
 * Candidate header-key prefixes for the "weekly" (7-day) rate-limit window, tried in order.
 * Sourced from the unverified `anthropic-ratelimit-unified-*` subscription surface (A-28-02) —
 * NOT the publicly documented per-minute families, which are deliberately excluded (see module
 * doc above). Unverified; correct the spelling here once real header names are observed.
 */
export const WEEKLY_WINDOW_HEADER_PREFIXES: readonly string[] = [
	"anthropic-ratelimit-unified-7d",
	"anthropic-ratelimit-unified-seven-day",
	"anthropic-ratelimit-unified-weekly",
];

/** Plausible explicit-percent header suffixes, tried before falling back to limit-minus-remaining. */
const PERCENT_SUFFIXES: readonly string[] = ["-used-percent", "-percent", "-utilization"];

/**
 * Clamps a derived/explicit percent into [0, 100].
 *
 * `NaN` (e.g. a 0/0 division, or genuinely non-numeric input) carries no directional
 * information about which bound it should snap to, so it is treated as "no usable percent" —
 * the caller returns `null` for that window rather than manufacturing a `0` (a real reading)
 * from absence. `Infinity`/`-Infinity` DO carry directional information (unambiguously over or
 * under the valid range) and are clamped to the corresponding bound.
 */
function clampPercent(value: number): number | null {
	if (Number.isNaN(value)) return null;
	if (value === Number.POSITIVE_INFINITY) return 100;
	if (value === Number.NEGATIVE_INFINITY) return 0;
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

/**
 * Parses a reset value in either encoding this phase must accept:
 * - a finite number: epoch milliseconds when above 1e12, epoch seconds otherwise
 * - an RFC-3339 string (the documented per-minute headers' format), parsed via `Date.parse`
 *   and converted to seconds
 *
 * Anything else (empty, garbage, non-finite) yields `null`, never `NaN`.
 */
function parseResetValue(raw: string): number | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) {
		return Math.round(numeric > 1e12 ? numeric / 1000 : numeric);
	}

	const parsedDate = Date.parse(trimmed);
	if (Number.isFinite(parsedDate)) {
		return Math.round(parsedDate / 1000);
	}

	return null;
}

/**
 * Resolves a used-percent for one candidate prefix: prefer an explicit percent-style header,
 * otherwise derive from `-limit`/`-remaining` when the limit is a positive finite number (never
 * dividing by zero). Returns `null` when neither path yields a usable percent for this prefix —
 * the caller tries the next candidate prefix in that case.
 */
function resolvePercentForPrefix(headers: Record<string, string>, prefix: string): number | null {
	for (const suffix of PERCENT_SUFFIXES) {
		const raw = headers[`${prefix}${suffix}`];
		if (raw === undefined || raw.trim() === "") continue;
		const clamped = clampPercent(Number(raw));
		if (clamped !== null) return clamped;
	}

	const limitRaw = headers[`${prefix}-limit`];
	const remainingRaw = headers[`${prefix}-remaining`];
	if (limitRaw !== undefined && remainingRaw !== undefined) {
		const limit = Number(limitRaw);
		const remaining = Number(remainingRaw);
		if (Number.isFinite(limit) && limit > 0) {
			const used = ((limit - remaining) / limit) * 100;
			const clamped = clampPercent(used);
			if (clamped !== null) return clamped;
		}
	}

	return null;
}

/** Resolves one window (session or weekly) by trying each candidate prefix in order. */
function resolveWindow(headers: Record<string, string>, prefixes: readonly string[]): RateLimitWindow | null {
	for (const prefix of prefixes) {
		const usedPercent = resolvePercentForPrefix(headers, prefix);
		if (usedPercent === null) continue;
		const resetRaw = headers[`${prefix}-reset`];
		const resetsAtEpochSec = resetRaw !== undefined ? parseResetValue(resetRaw) : null;
		return { usedPercent, resetsAtEpochSec };
	}
	return null;
}

/**
 * Parses a provider response header record into `{ session, weekly }` rate-limit windows.
 *
 * Returns `null` when neither window can be resolved at all (empty header record, or a record
 * containing only unrelated/documented-per-minute headers) — the honest `unavailable` case.
 * When at least one window resolves, returns a `RateLimitStatus` whose other field may still be
 * `null` (a supported provider that genuinely lacks that window, per A-28-01).
 *
 * Never throws for any input, including malformed/empty-string header values — the whole body
 * degrades to `null` on any unexpected error, matching `FooterDataProvider.resolveGitBranchSync`'s
 * never-throw contract (this runs on the provider-response hot path).
 */
export function parseAnthropicRateLimitHeaders(headers: Record<string, string>): RateLimitStatus | null {
	try {
		if (!headers || typeof headers !== "object") return null;

		const normalized: Record<string, string> = {};
		for (const key of Object.keys(headers)) {
			normalized[key.toLowerCase()] = String(headers[key] ?? "");
		}

		const session = resolveWindow(normalized, SESSION_WINDOW_HEADER_PREFIXES);
		const weekly = resolveWindow(normalized, WEEKLY_WINDOW_HEADER_PREFIXES);

		if (session === null && weekly === null) return null;
		return { session, weekly };
	} catch {
		return null;
	}
}
