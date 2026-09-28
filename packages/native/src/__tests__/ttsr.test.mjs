import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { native, isNativeAddonLoaded } = require_("../../dist/native.js");

const addonSkip = isNativeAddonLoaded()
  ? undefined
  : "native addon not loadable: no local native/addon build and no resolvable @opengsd/engine-<platform> package";

describe("native ttsr: ttsrCompileRules()", { skip: addonSkip }, () => {
  test("compiles rules and returns a numeric handle", () => {
    const handle = native.ttsrCompileRules([
      { name: "rule1", conditions: ["foo", "bar"] },
    ]);
    assert.equal(typeof handle, "number");
    assert.ok(handle > 0);
    native.ttsrFreeRules(handle);
  });

  test("rejects empty conditions", () => {
    assert.throws(() => {
      native.ttsrCompileRules([]);
    });
  });

  test("rejects invalid regex patterns", () => {
    assert.throws(() => {
      native.ttsrCompileRules([
        { name: "bad", conditions: ["(unclosed"] },
      ]);
    });
  });
});

describe("native ttsr: ttsrCheckBuffer()", { skip: addonSkip }, () => {
  test("returns matching rule names", () => {
    const handle = native.ttsrCompileRules([
      { name: "greet", conditions: ["hello\\s+world"] },
      { name: "farewell", conditions: ["goodbye"] },
    ]);

    const matches = native.ttsrCheckBuffer(handle, "say hello world please");
    assert.deepEqual(matches, ["greet"]);

    native.ttsrFreeRules(handle);
  });

  test("returns multiple matching rules", () => {
    const handle = native.ttsrCompileRules([
      { name: "a", conditions: ["alpha"] },
      { name: "b", conditions: ["beta"] },
      { name: "c", conditions: ["gamma"] },
    ]);

    const matches = native.ttsrCheckBuffer(handle, "alpha and beta together");
    assert.ok(matches.includes("a"));
    assert.ok(matches.includes("b"));
    assert.ok(!matches.includes("c"));

    native.ttsrFreeRules(handle);
  });

  test("returns empty array on no match", () => {
    const handle = native.ttsrCompileRules([
      { name: "x", conditions: ["zzz_no_match"] },
    ]);

    const matches = native.ttsrCheckBuffer(handle, "nothing here");
    assert.deepEqual(matches, []);

    native.ttsrFreeRules(handle);
  });

  test("deduplicates when multiple conditions of same rule match", () => {
    const handle = native.ttsrCompileRules([
      { name: "multi", conditions: ["foo", "bar"] },
    ]);

    const matches = native.ttsrCheckBuffer(handle, "foo and bar");
    assert.deepEqual(matches, ["multi"]);

    native.ttsrFreeRules(handle);
  });

  test("handles large buffers efficiently", () => {
    const handle = native.ttsrCompileRules([
      { name: "needle", conditions: ["NEEDLE_PATTERN_XYZ"] },
    ]);

    // 1MB buffer with the needle near the end
    const bigBuffer = "x".repeat(1024 * 1024) + "NEEDLE_PATTERN_XYZ";
    const matches = native.ttsrCheckBuffer(handle, bigBuffer);
    assert.deepEqual(matches, ["needle"]);

    native.ttsrFreeRules(handle);
  });
});

describe("native ttsr: ttsrFreeRules()", { skip: addonSkip }, () => {
  test("frees handle without error", () => {
    const handle = native.ttsrCompileRules([
      { name: "temp", conditions: ["tmp"] },
    ]);
    native.ttsrFreeRules(handle);
  });

  test("rejects invalid handle on check", () => {
    assert.throws(() => {
      native.ttsrCheckBuffer(99999, "test");
    });
  });
});
