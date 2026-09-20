/**
 * browser-tools — session_start registration contract regression coverage.
 *
 * Reproduces the defect that blocked the browser surface of TEST-09
 * (08-VERIFICATION.md): the extension's `session_start` hook fired tool
 * registration as unawaited fire-and-forget whenever `ctx.hasUI` was true, so
 * a dispatched RPC session's `browser_*` tools were never callable by the
 * time the handler resolved.
 *
 * Drives the REAL in-tree entry point (`jiti("../index.ts")`) through a
 * hand-rolled fake ExtensionAPI/ExtensionContext — not a copy of the
 * registration logic — so a regression here means the shipped extension is
 * broken, not just a test double.
 *
 * Ordering trap: `registeredEngine`, `legacyRegistrationPromise`, and
 * `managedRegistrationPromise` are module-level singletons inside index.ts.
 * A single shared module instance across every test in this file would let
 * an earlier test's registration (run against ITS OWN fake ExtensionAPI)
 * silently short-circuit a later test's own registration attempt -- the
 * later test's `registerTool` calls would never fire because the module
 * already considers the engine registered. A plain new `jiti(dir, opts)`
 * factory is NOT enough to avoid this: jiti's default module cache is keyed
 * by resolved file path, not by factory instance, so two separate factories
 * loading "../index.ts" still return module-level state backed by the SAME
 * underlying evaluation (confirmed empirically -- a `commitBrowserEngineResolution`
 * call made through one factory's copy was visible through a second factory's
 * copy of the same module). `moduleCache: false` is what actually forces a
 * fresh evaluation (and therefore fresh singletons) per factory. To keep each
 * test an independent, diagnostic reproduction of its own scenario, every
 * test loads its OWN fresh copy of index.ts via `loadFreshBrowserToolsIndex()`.
 * Test 3 (the probe-resolved managed-engine scenario) is still run first and
 * documented as such, matching the source order this defect was diagnosed in
 * -- but isolation, not ordering, is what actually guarantees each test's
 * correctness here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Fresh jiti factory per call -> fresh module instance -> fresh module-level
 * singletons in index.ts. Do NOT hoist this to a single shared instance; see
 * the ordering-trap note above the imports.
 */
function loadFreshBrowserToolsIndex() {
  const freshJiti = require("jiti")(__dirname, { interopDefault: true, debug: false, moduleCache: false });
  return freshJiti("../index.ts");
}

function makeProject({ webApp }) {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-start-reg-"));
  const pkg = webApp ? { dependencies: { react: "^18.0.0" } } : { name: "cli-tool" };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

function makeFakeCli() {
  const dir = mkdtempSync(join(tmpdir(), "gsd-fake-cli-"));
  const cliPath = join(dir, "gsd-browser");
  writeFileSync(cliPath, "#!/bin/sh\n");
  return cliPath;
}

/** Fake ExtensionAPI: records `on(event, handler)` registrations and `registerTool(definition)` names. */
function makeFakeExtensionAPI() {
  const handlers = new Map();
  const registeredToolNames = [];
  return {
    handlers,
    registeredToolNames,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(definition) {
      registeredToolNames.push(definition.name);
    },
  };
}

/** Fake ExtensionContext: carries cwd, hasUI, and a ui.notify recorder. */
function makeFakeExtensionContext({ cwd, hasUI }) {
  const notifications = [];
  return {
    cwd,
    hasUI,
    notifications,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };
}

async function invokeSessionStart(pi, ctx) {
  const handlers = pi.handlers.get("session_start") ?? [];
  assert.equal(handlers.length, 1, "expected exactly one session_start handler registered");
  await handlers[0]({ type: "session_start" }, ctx);
}

describe("browser-tools session_start registration contract", () => {
  // Test 3 runs FIRST — see the ordering-trap note above the imports.
  it("Test 3: on a probe-resolved managed engine, deferring the warm-up returns before the daemon-connect work settles", async () => {
    const fakeCliPath = makeFakeCli();
    const previousCliPath = process.env.GSD_BROWSER_CLI_PATH;
    process.env.GSD_BROWSER_CLI_PATH = fakeCliPath;
    try {
      const { registerBrowserTools } = loadFreshBrowserToolsIndex();
      const projectRoot = makeProject({ webApp: true });
      const pi = makeFakeExtensionAPI();
      const ctx = makeFakeExtensionContext({ cwd: projectRoot, hasUI: true });

      const result = await registerBrowserTools(pi, ctx, { deferProbeWarmUp: true });

      assert.ok(result && typeof result === "object", "registerBrowserTools should resolve to an object");
      assert.ok(
        result.deferred && typeof result.deferred.then === "function",
        "expected a deferred promise for the probe daemon-connect warm-up",
      );

      let settled = false;
      const drain = result.deferred.then(
        () => { settled = true; },
        () => { settled = true; },
      );

      // Give the microtask queue a chance to run without awaiting the
      // deferred promise itself — the assertion is about pendingness at the
      // moment registerBrowserTools resolves, not a wall-clock duration.
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(settled, false, "the deferred warm-up must still be pending when registerBrowserTools resolves");

      // Drain it fully so the fake CLI subprocess attempt doesn't leak into
      // later tests in this file (or leave an unhandled rejection).
      await drain;
    } finally {
      if (previousCliPath === undefined) delete process.env.GSD_BROWSER_CLI_PATH;
      else process.env.GSD_BROWSER_CLI_PATH = previousCliPath;
    }
  });

  // Test 1 — the regression. Currently RED: pre-fix, this records zero tools
  // because the session_start handler fires registration fire-and-forget
  // whenever ctx.hasUI is true, and returns before it lands.
  it("Test 1 (regression): awaiting session_start with ctx.hasUI true still registers browser_navigate", async () => {
    const { default: registerExtension } = loadFreshBrowserToolsIndex();
    const projectRoot = makeProject({ webApp: false }); // no web dependency -> resolves to the legacy engine
    const pi = makeFakeExtensionAPI();
    const ctx = makeFakeExtensionContext({ cwd: projectRoot, hasUI: true });

    registerExtension(pi);
    await invokeSessionStart(pi, ctx);

    assert.ok(
      pi.registeredToolNames.includes("browser_navigate"),
      `expected browser_navigate among registered tools, got: ${JSON.stringify(pi.registeredToolNames)}`,
    );
  });

  // Test 2 — non-regression on the already-correct branch.
  it("Test 2 (non-regression): awaiting session_start with ctx.hasUI false also registers browser_navigate", async () => {
    const { default: registerExtension } = loadFreshBrowserToolsIndex();
    const projectRoot = makeProject({ webApp: false });
    const pi = makeFakeExtensionAPI();
    const ctx = makeFakeExtensionContext({ cwd: projectRoot, hasUI: false });

    registerExtension(pi);
    await invokeSessionStart(pi, ctx);

    assert.ok(
      pi.registeredToolNames.includes("browser_navigate"),
      `expected browser_navigate among registered tools, got: ${JSON.stringify(pi.registeredToolNames)}`,
    );
  });
});
