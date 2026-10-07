import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mapSdkRateLimitInfo } from "../rate-limit-event.ts";

describe("mapSdkRateLimitInfo — window-key resolution", () => {
	test("five_hour maps to the session key", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5 });
		assert.equal(mapped?.windowKey, "session");
	});

	test("seven_day maps to the weekly key", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "seven_day", utilization: 0.5 });
		assert.equal(mapped?.windowKey, "weekly");
	});

	test("seven_day_opus maps to the weekly key", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.5 });
		assert.equal(mapped?.windowKey, "weekly");
	});

	test("seven_day_sonnet maps to the weekly key", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "seven_day_sonnet", utilization: 0.5 });
		assert.equal(mapped?.windowKey, "weekly");
	});

	test("overage maps to null", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "overage", utilization: 0.5 });
		assert.equal(mapped, null);
	});

	test("an unrecognised rateLimitType string maps to null", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "something_else", utilization: 0.5 });
		assert.equal(mapped, null);
	});

	test("an absent rateLimitType maps to null", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", utilization: 0.5 });
		assert.equal(mapped, null);
	});

	test("status: rejected still maps -- being at or over the limit is a real reading, not an error", () => {
		const mapped = mapSdkRateLimitInfo({ status: "rejected", rateLimitType: "five_hour", utilization: 1 });
		assert.equal(mapped?.windowKey, "session");
		assert.equal(mapped?.window.usedPercent, 100);
	});
});

describe("mapSdkRateLimitInfo — utilization scale and clamping", () => {
	test("bottom-of-scale utilization (0) yields a real usedPercent of 0, not null", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0 });
		assert.notEqual(mapped, null);
		assert.equal(mapped?.window.usedPercent, 0);
	});

	test("utilization of 1 yields 100 (full-scale fraction reading)", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 1 });
		assert.equal(mapped?.window.usedPercent, 100);
	});

	test("utilization of 0.455 yields 45.5 with no rounding applied in the mapper", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0.455 });
		assert.equal(mapped?.window.usedPercent, 45.5);
	});

	test("utilization above 1 is read as an already-scaled percentage; 150 clamps to 100", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 150 });
		assert.equal(mapped?.window.usedPercent, 100);
	});

	test("utilization above 1 is read as an already-scaled percentage; -5 clamps to 0", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: -5 });
		assert.equal(mapped?.window.usedPercent, 0);
	});

	test("NaN utilization yields null for the whole mapping", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: Number.NaN });
		assert.equal(mapped, null);
	});

	test("a string-valued utilization yields null for the whole mapping", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: "42" });
		assert.equal(mapped, null);
	});

	test("a null utilization yields null for the whole mapping", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: null });
		assert.equal(mapped, null);
	});

	test("an absent utilization yields null for the whole mapping", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour" });
		assert.equal(mapped, null);
	});
});

describe("mapSdkRateLimitInfo — resetsAt magnitude resolution", () => {
	test("a millisecond-magnitude resetsAt and a second-magnitude resetsAt resolve to the same epoch-second value", () => {
		const nowSec = Math.round(Date.now() / 1000) + 3600;
		const nowMs = nowSec * 1000;
		const mappedSec = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: nowSec });
		const mappedMs = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: nowMs });
		assert.equal(mappedSec?.window.resetsAtEpochSec, nowSec);
		assert.equal(mappedMs?.window.resetsAtEpochSec, nowSec);
	});

	test("a non-finite resetsAt yields resetsAtEpochSec: null while the percent survives", () => {
		const mapped = mapSdkRateLimitInfo({
			status: "allowed",
			rateLimitType: "five_hour",
			utilization: 0.5,
			resetsAt: Number.POSITIVE_INFINITY,
		});
		assert.equal(mapped?.window.resetsAtEpochSec, null);
		assert.equal(mapped?.window.usedPercent, 50);
	});

	test("a non-numeric resetsAt yields resetsAtEpochSec: null while the percent survives", () => {
		const mapped = mapSdkRateLimitInfo({
			status: "allowed",
			rateLimitType: "five_hour",
			utilization: 0.5,
			resetsAt: "not-a-number" as unknown as number,
		});
		assert.equal(mapped?.window.resetsAtEpochSec, null);
		assert.equal(mapped?.window.usedPercent, 50);
	});

	test("an absent resetsAt yields resetsAtEpochSec: null while the percent survives", () => {
		const mapped = mapSdkRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5 });
		assert.equal(mapped?.window.resetsAtEpochSec, null);
		assert.equal(mapped?.window.usedPercent, 50);
	});
});

describe("mapSdkRateLimitInfo — never-throw contract on non-object payloads", () => {
	test("undefined yields null and throws nothing", () => {
		let result: unknown;
		assert.doesNotThrow(() => {
			result = mapSdkRateLimitInfo(undefined);
		});
		assert.equal(result, null);
	});

	test("null yields null and throws nothing", () => {
		let result: unknown;
		assert.doesNotThrow(() => {
			result = mapSdkRateLimitInfo(null);
		});
		assert.equal(result, null);
	});

	test("a string payload yields null and throws nothing", () => {
		let result: unknown;
		assert.doesNotThrow(() => {
			result = mapSdkRateLimitInfo("not an object");
		});
		assert.equal(result, null);
	});

	test("an array payload yields null and throws nothing", () => {
		let result: unknown;
		assert.doesNotThrow(() => {
			result = mapSdkRateLimitInfo([1, 2, 3]);
		});
		assert.equal(result, null);
	});
});
