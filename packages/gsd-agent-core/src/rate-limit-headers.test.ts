import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAnthropicRateLimitHeaders } from "./rate-limit-headers.ts";

describe("parseAnthropicRateLimitHeaders", () => {
	it("populates both session and weekly windows from the unified shape (percent-style + numeric epoch reset)", () => {
		const result = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-used-percent": "42.5",
			"anthropic-ratelimit-unified-5h-reset": "1735300000",
			"anthropic-ratelimit-unified-7d-used-percent": "10",
			"anthropic-ratelimit-unified-7d-reset": "5000000000000",
		});

		assert.ok(result);
		assert.deepEqual(result?.session, { usedPercent: 42.5, resetsAtEpochSec: 1735300000 });
		assert.deepEqual(result?.weekly, { usedPercent: 10, resetsAtEpochSec: 5000000000 });
	});

	it("populates only the session window when only the 5-hour headers are present", () => {
		const result = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-used-percent": "55",
		});

		assert.ok(result);
		assert.equal(result?.session?.usedPercent, 55);
		assert.equal(result?.weekly, null);
	});

	it("returns null for the documented per-minute-only shape (never maps a per-minute bucket onto session/weekly)", () => {
		const result = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-tokens-limit": "40000",
			"anthropic-ratelimit-tokens-remaining": "10000",
			"anthropic-ratelimit-tokens-reset": "2026-09-28T00:00:00Z",
		});

		assert.equal(result, null);
	});

	it("accepts an RFC-3339 reset string and converts it to epoch seconds", () => {
		const isoReset = "2026-09-28T00:00:00Z";
		const result = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-7d-used-percent": "20",
			"anthropic-ratelimit-unified-7d-reset": isoReset,
		});

		assert.ok(result);
		assert.equal(result?.weekly?.resetsAtEpochSec, Math.round(Date.parse(isoReset) / 1000));
	});

	it("accepts a numeric epoch-milliseconds reset (treated as ms above 1e12)", () => {
		const nowMs = Date.now() + 3_600_000;
		const result = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-used-percent": "30",
			"anthropic-ratelimit-unified-5h-reset": String(nowMs),
		});

		assert.ok(result);
		assert.equal(result?.session?.resetsAtEpochSec, Math.round(nowMs / 1000));
	});

	it("derives the used percent from limit-minus-remaining when no explicit percent header is present", () => {
		const result = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-limit": "100",
			"anthropic-ratelimit-unified-5h-remaining": "20",
		});

		assert.ok(result);
		assert.equal(result?.session?.usedPercent, 80);
	});

	it("matches header keys case-insensitively", () => {
		const result = parseAnthropicRateLimitHeaders({
			"Anthropic-RateLimit-Unified-5h-Used-Percent": "33",
		});

		assert.ok(result);
		assert.equal(result?.session?.usedPercent, 33);
	});

	it("clamps an out-of-range explicit percent into [0, 100], including the literal string Infinity and a negative value", () => {
		const over100 = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-used-percent": "150",
		});
		assert.equal(over100?.session?.usedPercent, 100);

		const infinity = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-used-percent": "Infinity",
		});
		assert.equal(infinity?.session?.usedPercent, 100);

		const negative = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-used-percent": "-30",
		});
		assert.equal(negative?.session?.usedPercent, 0);
	});

	it("clamps a derived limit-minus-remaining percent that overflows past 100 into 100", () => {
		const result = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-limit": "10",
			"anthropic-ratelimit-unified-5h-remaining": "-1000",
		});

		assert.ok(result);
		assert.equal(result?.session?.usedPercent, 100);
	});

	it("never divides by a zero limit — a zero limit yields no usable percent for that prefix rather than NaN/Infinity", () => {
		const result = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-limit": "0",
			"anthropic-ratelimit-unified-5h-remaining": "0",
		});

		assert.equal(result, null);
	});

	it("yields resetsAtEpochSec: null (not NaN) for a non-finite or unparseable reset", () => {
		const result = parseAnthropicRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-used-percent": "50",
			"anthropic-ratelimit-unified-5h-reset": "not-a-date",
		});

		assert.ok(result);
		assert.equal(result?.session?.resetsAtEpochSec, null);
		assert.notEqual(Number.isNaN(result?.session?.resetsAtEpochSec as number), true);
	});

	it("returns null for an empty header record", () => {
		assert.equal(parseAnthropicRateLimitHeaders({}), null);
	});

	it("returns null for a record with only unrelated headers", () => {
		const result = parseAnthropicRateLimitHeaders({
			"content-type": "application/json",
			"x-request-id": "abc-123",
		});

		assert.equal(result, null);
	});

	it("never throws for malformed input, including empty-string header values", () => {
		assert.doesNotThrow(() => {
			const result = parseAnthropicRateLimitHeaders({
				"anthropic-ratelimit-unified-5h-used-percent": "",
				"anthropic-ratelimit-unified-5h-reset": "",
			});
			assert.equal(result, null);
		});
	});
});
