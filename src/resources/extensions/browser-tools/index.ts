/** browser-tools — Pi Browser Automation Contract adapter. */
import { importExtensionModule, type ExtensionAPI, type ExtensionContext } from "@gsd/pi-coding-agent";

import { closeManagedGsdBrowser, registerManagedGsdBrowserTools, warmUpManagedGsdBrowser } from "./engine/managed-gsd-browser.js";
import { commitBrowserEngineResolution, resolveAmbientBrowserEngineResolution, type BrowserEngineMode } from "./engine/selection.js";
import { setArtifactRootForCwd } from "./state.js";
import { detectWebApp } from "./web-app-detect.js";

let legacyRegistrationPromise: Promise<void> | null = null;
let managedRegistrationPromise: Promise<void> | null = null;
let registeredEngine: Exclude<BrowserEngineMode, "off"> | null = null;

async function registerLegacyBrowserTools(pi: ExtensionAPI): Promise<void> {
  if (!legacyRegistrationPromise) {
    legacyRegistrationPromise = (async () => {
      const [
        lifecycle,
        capture,
        settle,
        refs,
        utils,
        navigation,
        screenshot,
        interaction,
        inspection,
        session,
        assertions,
        refTools,
        wait,
        pages,
        forms,
        intent,
        pdf,
        statePersistence,
        networkMock,
        device,
        extract,
        visualDiff,
        zoom,
        codegen,
        actionCache,
        injectionDetection,
        verify,
      ] = await Promise.all([
        importExtensionModule<typeof import("./lifecycle.js")>(import.meta.url, "./lifecycle.js"),
        importExtensionModule<typeof import("./capture.js")>(import.meta.url, "./capture.js"),
        importExtensionModule<typeof import("./settle.js")>(import.meta.url, "./settle.js"),
        importExtensionModule<typeof import("./refs.js")>(import.meta.url, "./refs.js"),
        importExtensionModule<typeof import("./utils.js")>(import.meta.url, "./utils.js"),
        importExtensionModule<typeof import("./tools/navigation.js")>(import.meta.url, "./tools/navigation.js"),
        importExtensionModule<typeof import("./tools/screenshot.js")>(import.meta.url, "./tools/screenshot.js"),
        importExtensionModule<typeof import("./tools/interaction.js")>(import.meta.url, "./tools/interaction.js"),
        importExtensionModule<typeof import("./tools/inspection.js")>(import.meta.url, "./tools/inspection.js"),
        importExtensionModule<typeof import("./tools/session.js")>(import.meta.url, "./tools/session.js"),
        importExtensionModule<typeof import("./tools/assertions.js")>(import.meta.url, "./tools/assertions.js"),
        importExtensionModule<typeof import("./tools/refs.js")>(import.meta.url, "./tools/refs.js"),
        importExtensionModule<typeof import("./tools/wait.js")>(import.meta.url, "./tools/wait.js"),
        importExtensionModule<typeof import("./tools/pages.js")>(import.meta.url, "./tools/pages.js"),
        importExtensionModule<typeof import("./tools/forms.js")>(import.meta.url, "./tools/forms.js"),
        importExtensionModule<typeof import("./tools/intent.js")>(import.meta.url, "./tools/intent.js"),
        importExtensionModule<typeof import("./tools/pdf.js")>(import.meta.url, "./tools/pdf.js"),
        importExtensionModule<typeof import("./tools/state-persistence.js")>(import.meta.url, "./tools/state-persistence.js"),
        importExtensionModule<typeof import("./tools/network-mock.js")>(import.meta.url, "./tools/network-mock.js"),
        importExtensionModule<typeof import("./tools/device.js")>(import.meta.url, "./tools/device.js"),
        importExtensionModule<typeof import("./tools/extract.js")>(import.meta.url, "./tools/extract.js"),
        importExtensionModule<typeof import("./tools/visual-diff.js")>(import.meta.url, "./tools/visual-diff.js"),
        importExtensionModule<typeof import("./tools/zoom.js")>(import.meta.url, "./tools/zoom.js"),
        importExtensionModule<typeof import("./tools/codegen.js")>(import.meta.url, "./tools/codegen.js"),
        importExtensionModule<typeof import("./tools/action-cache.js")>(import.meta.url, "./tools/action-cache.js"),
        importExtensionModule<typeof import("./tools/injection-detect.js")>(import.meta.url, "./tools/injection-detect.js"),
        importExtensionModule<typeof import("./tools/verify.js")>(import.meta.url, "./tools/verify.js"),
      ]);

      const deps = {
        ensureBrowser: lifecycle.ensureBrowser,
        closeBrowser: lifecycle.closeBrowser,
        getActivePage: lifecycle.getActivePage,
        getActiveTarget: lifecycle.getActiveTarget,
        getActivePageOrNull: lifecycle.getActivePageOrNull,
        attachPageListeners: lifecycle.attachPageListeners,
        captureCompactPageState: capture.captureCompactPageState,
        postActionSummary: capture.postActionSummary,
        constrainScreenshot: capture.constrainScreenshot,
        captureErrorScreenshot: capture.captureErrorScreenshot,
        formatCompactStateSummary: utils.formatCompactStateSummary,
        getRecentErrors: utils.getRecentErrors,
        settleAfterActionAdaptive: settle.settleAfterActionAdaptive,
        ensureMutationCounter: settle.ensureMutationCounter,
        buildRefSnapshot: refs.buildRefSnapshot,
        resolveRefTarget: refs.resolveRefTarget,
        parseRef: utils.parseRef,
        formatVersionedRef: utils.formatVersionedRef,
        staleRefGuidance: utils.staleRefGuidance,
        beginTrackedAction: utils.beginTrackedAction,
        finishTrackedAction: utils.finishTrackedAction,
        truncateText: utils.truncateText,
        verificationFromChecks: utils.verificationFromChecks,
        verificationLine: utils.verificationLine,
        collectAssertionState: (page: any, checks: any, target?: any) =>
          utils.collectAssertionState(page, checks, capture.captureCompactPageState, target),
        formatAssertionText: utils.formatAssertionText,
        formatDiffText: utils.formatDiffText,
        getUrlHash: utils.getUrlHash,
        captureClickTargetState: utils.captureClickTargetState,
        readInputLikeValue: utils.readInputLikeValue,
        firstErrorLine: utils.firstErrorLine,
        captureAccessibilityMarkdown: (selector?: string) =>
          utils.captureAccessibilityMarkdown(lifecycle.getActiveTarget(), selector),
        resolveAccessibilityScope: utils.resolveAccessibilityScope,
        getLivePagesSnapshot: utils.createGetLivePagesSnapshot(lifecycle.ensureBrowser),
        getSinceTimestamp: utils.getSinceTimestamp,
        getConsoleEntriesSince: utils.getConsoleEntriesSince,
        getNetworkEntriesSince: utils.getNetworkEntriesSince,
        writeArtifactFile: utils.writeArtifactFile,
        copyArtifactFile: utils.copyArtifactFile,
        ensureSessionArtifactDir: utils.ensureSessionArtifactDir,
        buildSessionArtifactPath: utils.buildSessionArtifactPath,
        getSessionArtifactMetadata: utils.getSessionArtifactMetadata,
        sanitizeArtifactName: utils.sanitizeArtifactName,
        formatArtifactTimestamp: utils.formatArtifactTimestamp,
      };

      const cwdScopedPi = withBrowserArtifactCwdScope(pi);
      navigation.registerNavigationTools(cwdScopedPi, deps);
      screenshot.registerScreenshotTools(cwdScopedPi, deps);
      interaction.registerInteractionTools(cwdScopedPi, deps);
      inspection.registerInspectionTools(cwdScopedPi, deps);
      session.registerSessionTools(cwdScopedPi, deps);
      assertions.registerAssertionTools(cwdScopedPi, deps);
      refTools.registerRefTools(cwdScopedPi, deps);
      wait.registerWaitTools(cwdScopedPi, deps);
      pages.registerPageTools(cwdScopedPi, deps);
      forms.registerFormTools(cwdScopedPi, deps);
      intent.registerIntentTools(cwdScopedPi, deps);
      pdf.registerPdfTools(cwdScopedPi, deps);
      statePersistence.registerStatePersistenceTools(cwdScopedPi, deps);
      networkMock.registerNetworkMockTools(cwdScopedPi, deps);
      device.registerDeviceTools(cwdScopedPi, deps);
      extract.registerExtractTools(cwdScopedPi, deps);
      visualDiff.registerVisualDiffTools(cwdScopedPi, deps);
      zoom.registerZoomTools(cwdScopedPi, deps);
      codegen.registerCodegenTools(cwdScopedPi, deps);
      actionCache.registerActionCacheTools(cwdScopedPi, deps);
      injectionDetection.registerInjectionDetectionTools(cwdScopedPi, deps);
      verify.registerVerifyTools(cwdScopedPi, deps);
    })().catch((error) => {
      legacyRegistrationPromise = null;
      throw error;
    });
  }

  return legacyRegistrationPromise;
}

function withBrowserArtifactCwdScope(pi: ExtensionAPI): ExtensionAPI {
  return {
    ...pi,
    registerTool(definition) {
      pi.registerTool({
        ...definition,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          if (ctx?.cwd) setArtifactRootForCwd(ctx.cwd);
          return definition.execute(toolCallId, params, signal, onUpdate, ctx);
        },
      });
    },
  };
}

/** Daemon-connect budget when the probe-resolved managed engine is verified at session start. */
const PROBE_WARMUP_TIMEOUT_MS = 10_000;

interface RegisterBrowserToolsOptions {
  /**
   * Defer the probe-resolved managed daemon-connect warm-up (and the
   * registration that depends on its outcome) instead of awaiting it inline.
   * Only takes effect when the warm-up gate is actually reached (a
   * probe-resolved gsd-browser engine with nothing registered yet in this
   * process) — every other path is fast, local, and always awaited
   * regardless of this option.
   */
  deferProbeWarmUp?: boolean;
}

interface RegisterBrowserToolsResult {
  /** Present only when the daemon-connect warm-up (and its dependent registration) was deferred. */
  deferred?: Promise<void>;
}

/**
 * Run the daemon-connect warm-up gate for a probe-resolved managed engine:
 * prove the daemon actually connects before committing the session's tool
 * registrations to it, falling back to legacy Playwright (the failure mode
 * that made ADR-024 freeze the old default) and committing the outcome so
 * ambient readers see the engine actually in use. When eager warm-up is
 * disabled the daemon-connect proof cannot run, so the probe default treats
 * the managed engine as unprovable and falls back to legacy rather than
 * registering it unverified.
 */
async function runProbeWarmUpGate(
  ctx: ExtensionContext,
  projectRoot: string,
  engine: Exclude<BrowserEngineMode, "off">,
): Promise<Exclude<BrowserEngineMode, "off">> {
  if (isWarmUpDisabled()) {
    return commitLegacyFallback(projectRoot, "warm-up disabled; managed engine unverifiable; using legacy Playwright");
  }

  const warmUp = await warmUpManagedGsdBrowser(ctx, AbortSignal.timeout(PROBE_WARMUP_TIMEOUT_MS));
  if (!warmUp.ok) {
    const fallbackEngine = commitLegacyFallback(
      projectRoot,
      `gsd-browser daemon connect failed (${warmUp.error}); using legacy Playwright`,
    );
    if (ctx.hasUI) {
      ctx.ui.notify(
        `gsd-browser engine unavailable (${warmUp.error}); using Playwright browser tools for this session.`,
        "warning",
      );
    }
    return fallbackEngine;
  }
  if (warmUp.coverageWarning && ctx.hasUI) {
    ctx.ui.notify(warmUp.coverageWarning, "warning");
  }
  return engine;
}

/**
 * Local, synchronous-ish registration step: adopt an already-registered
 * engine if one exists (browser tool registrations are process-global and
 * cannot be swapped once live — see the comment below), then register and
 * await the resolved engine's tools.
 */
async function adoptAndRegister(
  pi: ExtensionAPI,
  projectRoot: string,
  engine: Exclude<BrowserEngineMode, "off">,
): Promise<void> {
  let resolvedEngine = engine;

  // Browser tool registrations are process-global and cannot be swapped once
  // live. When an earlier session in this process already registered an engine
  // and this project resolved a different one (per-project probe resolution can
  // diverge across projects in a multi-session process), adopt the registered
  // engine rather than throwing — a throw surfaces as "browser-tools failed to
  // load" and leaves this session with no browser tools at all. Commit the
  // adoption so ambient readers (UAT guidance, warm-up) describe the engine
  // actually in use.
  if (registeredEngine && registeredEngine !== resolvedEngine) {
    resolvedEngine = registeredEngine;
    commitBrowserEngineResolution(projectRoot, {
      engine: resolvedEngine,
      source: "probe",
      reason: `browser tools already registered with ${resolvedEngine} earlier in this process; adopting it`,
    });
  }

  let registration: Promise<void>;
  if (resolvedEngine === "legacy") {
    registration = registerLegacyBrowserTools(pi);
  } else if (!managedRegistrationPromise) {
    managedRegistrationPromise = Promise.resolve()
      .then(() => {
        registerManagedGsdBrowserTools(pi);
      })
      .catch((error) => {
        managedRegistrationPromise = null;
        throw error;
      });
    registration = managedRegistrationPromise;
  } else {
    registration = managedRegistrationPromise;
  }

  registeredEngine = resolvedEngine;
  try {
    await registration;
  } catch (error) {
    if (registeredEngine === resolvedEngine) registeredEngine = null;
    throw error;
  }
}

/**
 * Register browser-tools for a session. Everything except the probe-resolved
 * managed daemon-connect warm-up is local module loading plus synchronous
 * `pi.registerTool()` calls — always awaited before returning. The
 * daemon-connect warm-up is the one slow, networked step; when it is reached
 * and `options.deferProbeWarmUp` is true, this returns immediately with a
 * `deferred` promise that performs that same warm-up, fallback, notify, and
 * registration sequence in the background, so an interactive terminal
 * session never waits out the daemon-connect budget.
 */
export async function registerBrowserTools(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: RegisterBrowserToolsOptions = {},
): Promise<RegisterBrowserToolsResult> {
  const projectRoot = ctx.cwd || process.cwd();
  const resolution = resolveAmbientBrowserEngineResolution(projectRoot);
  let engine = resolution.engine;
  if (engine === "off") return {};

  const reachesProbeWarmUpGate = engine === "gsd-browser" && resolution.source === "probe" && !registeredEngine;

  if (reachesProbeWarmUpGate && options.deferProbeWarmUp) {
    const warmUpEngine = engine;
    const deferred = (async () => {
      const resolvedEngine = await runProbeWarmUpGate(ctx, projectRoot, warmUpEngine);
      await adoptAndRegister(pi, projectRoot, resolvedEngine);
    })();
    return { deferred };
  }

  if (reachesProbeWarmUpGate) {
    engine = await runProbeWarmUpGate(ctx, projectRoot, engine);
  }

  await adoptAndRegister(pi, projectRoot, engine);
  return {};
}

function commitLegacyFallback(projectRoot: string, reason: string): "legacy" {
  commitBrowserEngineResolution(projectRoot, { engine: "legacy", source: "probe", reason });
  return "legacy";
}

function isWarmUpDisabled(): boolean {
  const value = process.env.GSD_BROWSER_WARMUP?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off";
}

/**
 * Auto-initialize the managed gsd-browser engine when it was selected via the
 * explicit GSD_BROWSER_ENGINE override, which registers without the
 * daemon-connect gate. Best-effort and non-blocking: warm-up runs in the
 * background and only surfaces a warning if it fails. Probe-resolved sessions
 * already connected (or fell back) during registration, so they are excluded
 * to avoid re-warming and double-notifying.
 */
function maybeWarmUpManagedEngine(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (isWarmUpDisabled()) return;

  const projectRoot = ctx.cwd || process.cwd();
  const resolution = resolveAmbientBrowserEngineResolution(projectRoot);
  if (resolution.engine !== "gsd-browser" || resolution.source !== "env") return;
  if (!detectWebApp(projectRoot)) return;

  void warmUpManagedGsdBrowser(ctx).then((result) => {
    if (!ctx.hasUI) return;
    if (!result.ok) {
      ctx.ui.notify(
        `gsd-browser auto-init failed: ${result.error}. Browser UAT tools will retry on first use; run /gsd doctor if this persists.`,
        "warning",
      );
    } else if (result.coverageWarning) {
      ctx.ui.notify(result.coverageWarning, "warning");
    }
  });
}

async function closeActiveBrowserEngines(): Promise<void> {
  await closeManagedGsdBrowser();
  if (legacyRegistrationPromise) {
    const { closeBrowser } = await importExtensionModule<typeof import("./lifecycle.js")>(import.meta.url, "./lifecycle.js");
    await closeBrowser();
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Registration itself is always awaited on both branches below — only the
    // probe-resolved managed daemon-connect warm-up is ever deferred, and
    // only for a session carrying a UI context (ctx.hasUI), which is what
    // deferProbeWarmUp: ctx.hasUI selects. This is the fix: the old code
    // fired registration itself as fire-and-forget whenever ctx.hasUI was
    // true, so a dispatched RPC session's browser_* tools were never
    // callable by the time this handler resolved.
    let result: RegisterBrowserToolsResult;
    try {
      result = await registerBrowserTools(pi, ctx, { deferProbeWarmUp: ctx.hasUI });
    } catch (error) {
      // Preserve today's failure semantics: a registration failure on a
      // session carrying a UI context is reported through ctx.ui.notify at
      // warning level rather than rejecting this hook (and surfacing as an
      // extension_error for the whole bindExtensions() batch); a session
      // without one keeps today's rejecting behavior.
      if (ctx.hasUI) {
        ctx.ui.notify(`browser-tools failed to load: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return;
      }
      throw error;
    }

    if (result.deferred) {
      void result.deferred
        .then(() => maybeWarmUpManagedEngine(pi, ctx))
        .catch((error) => {
          ctx.ui.notify(`browser-tools failed to load: ${error instanceof Error ? error.message : String(error)}`, "warning");
        });
      return;
    }

    // maybeWarmUpManagedEngine is already best-effort and non-blocking, and
    // is gated on an env-sourced managed engine plus detectWebApp — safe to
    // call directly whether or not this session carries a UI context.
    maybeWarmUpManagedEngine(pi, ctx);
  });

  pi.on("session_shutdown", async () => {
    await closeActiveBrowserEngines();
  });

  pi.on("session_switch", async () => {
    await closeActiveBrowserEngines();
  });
}
