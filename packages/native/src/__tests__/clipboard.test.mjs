import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { native, isNativeAddonLoaded } = require_("../../dist/native.js");

const addonSkip = isNativeAddonLoaded()
  ? undefined
  : "native addon not loadable: no local native/addon build and no resolvable @opengsd/engine-<platform> package";

function isClipboardUnavailableError(error) {
  if (!(error instanceof Error)) return false;
  const message = error.message ?? "";
  return (
    message.includes("Failed to access clipboard") &&
    (
      message.includes("X11 server connection timed out") ||
      message.includes("X11 server connection") ||
      message.includes("wl-clipboard") ||
      message.includes("No display") ||
      message.includes("DISPLAY") ||
      message.includes("selected clipboard is not supported")
    )
  );
}

function skipIfClipboardUnavailable(t, error) {
  if (isClipboardUnavailableError(error)) {
    t.skip(`system clipboard unavailable in this environment: ${error.message}`);
    return;
  }
  throw error;
}

describe("native clipboard: copyToClipboard()", { skip: addonSkip }, () => {
  test("copies text without throwing", (t) => {
    try {
      native.copyToClipboard("GSD clipboard test");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });

  test("accepts empty string", (t) => {
    try {
      native.copyToClipboard("");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });

  test("accepts unicode text", (t) => {
    try {
      native.copyToClipboard("Hello 世界");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
});

describe("native clipboard: readTextFromClipboard()", { skip: addonSkip }, () => {
  test("reads back text that was copied", (t) => {
    try {
      const testText = `GSD clipboard roundtrip ${Date.now()}`;
      native.copyToClipboard(testText);
      const result = native.readTextFromClipboard();
      assert.equal(result, testText);
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });

  test("returns a string or null", (t) => {
    try {
      const result = native.readTextFromClipboard();
      assert.ok(result === null || typeof result === "string");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
});

describe("native clipboard: readImageFromClipboard()", { skip: addonSkip }, () => {
  test("returns a promise", async (t) => {
    const result = native.readImageFromClipboard();
    assert.ok(result instanceof Promise);
    try {
      await result;
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });

  test("resolves to ClipboardImage or null", async (t) => {
    try {
      const result = await native.readImageFromClipboard();
      if (result !== null) {
        assert.ok(result.data instanceof Uint8Array, "data should be Uint8Array");
        assert.equal(result.mimeType, "image/png");
      }
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
});
