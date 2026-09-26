/**
 * Model UnitType Mapping — behavior tests for #2865 / #2900 / ADR-011.
 *
 * Verifies model routing, metrics/dashboard labels, and artifact resolution
 * through exported runtime APIs instead of inspecting source text.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { resolveExpectedArtifactPath } from "../auto-artifact-paths.ts";
import { unitPhaseLabel, unitVerb } from "../auto-dashboard.ts";
import { classifyUnitPhase } from "../metrics.ts";
import { resolveDefaultSessionModel, resolveModelWithFallbacksForUnit } from "../preferences-models.ts";
import { KNOWN_UNIT_LABELS } from "../preferences-types.ts";

function withModelPreferences<T>(
  fn: (home: string) => T,
  opts?: { chdirToHome?: boolean },
): T {
  const oldHome = process.env.GSD_HOME;
  // Group A isolation (22-03): resolution also consults the agent-dir settings.json
  // (getAgentDir(), via GSD_CODING_AGENT_DIR) and a project-scope .gsd/PREFERENCES.md
  // relative to process.cwd(). Pin BOTH to the clean temp home alongside GSD_HOME so
  // this box's real ~/.gsd/agent/settings.json pin and any ambient-cwd project prefs
  // cannot bleed past the models this helper writes.
  const oldAgentDir = process.env.GSD_CODING_AGENT_DIR;
  const oldCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "gsd-model-map-"));
  // CR-02: `chdirToHome` defaults to true (unchanged behavior for every existing
  // call site). The "Group A isolation guard" test below passes `false` so it can
  // keep `cwd` pinned at its decoy directory for the whole call and instead prove
  // isolation via the explicit `basePath` parameter every production call site
  // (auto-start.ts / auto.ts) actually uses -- `fn` receives `home` so it can
  // thread that basePath through itself.
  const chdirToHome = opts?.chdirToHome ?? true;
  try {
    process.env.GSD_HOME = home;
    process.env.GSD_CODING_AGENT_DIR = home;
    if (chdirToHome) process.chdir(home);
    writeFileSync(join(home, "preferences.md"), [
      "---",
      "models:",
      "  research: research-model",
      "  planning: planning-model",
      "  discuss: discuss-model",
      "  execution: execution-model",
      "  execution_simple: simple-model",
      "  completion: completion-model",
      "  validation: validation-model",
      "  subagent: subagent-model",
      "  uat: uat-model",
      "---",
      "",
    ].join("\n"));
    return fn(home);
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    if (oldAgentDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
    else process.env.GSD_CODING_AGENT_DIR = oldAgentDir;
    process.chdir(oldCwd);
    rmSync(home, { recursive: true, force: true });
  }
}

test("discuss unit types route to the discuss model bucket", () => {
  withModelPreferences(() => {
    assert.equal(resolveModelWithFallbacksForUnit("discuss-milestone")?.primary, "discuss-model");
    assert.equal(resolveModelWithFallbacksForUnit("discuss-slice")?.primary, "discuss-model");
  });
});

// Group A isolation guard (22-03): the six Group A assertions inject their own model
// registry / write their own preferences into a GSD_HOME-scoped temp dir, but preference
// resolution also reads a PROJECT-scope `.gsd/PREFERENCES.md` relative to process.cwd().
// A real host with an on-disk project preferences file in the ambient cwd would leak its
// `models` block past the injected values (this is the dormant seam behind the v4 19-06
// Group A reds, which returned this box's real claude-code/claude-sonnet-5 pin). This guard
// simulates that contamination in a temp sandbox and proves resolution stays hermetic.
//
// CR-02: `withModelPreferences` used to unconditionally `chdir(home)` before invoking
// `fn`, so by the time `resolveModelWithFallbacksForUnit` ran, `cwd` was already `home`
// -- the decoy directory (set as cwd just above) was never actually live at call time,
// and this assertion passed trivially regardless of whether the ambient-cwd leak it
// claims to guard against was present. Fixed by keeping `cwd` pinned at `decoy` for the
// whole test (`chdirToHome: false`) and instead proving isolation the way every real
// call site does it: pass the resolved `home` in as an explicit `basePath`. Verified
// empirically (scratchpad probe) that with `cwd` left at `decoy` and NO explicit
// `basePath`, this exact call leaks `"leaked-from-cwd"` -- so this guard can now
// actually go red if a future change stops threading `basePath` through.
test("discuss unit resolution is hermetic against an ambient-cwd project .gsd/PREFERENCES.md (Group A isolation guard)", () => {
  const oldCwd = process.cwd();
  const decoy = mkdtempSync(join(tmpdir(), "gsd-decoy-project-"));
  mkdirSync(join(decoy, ".gsd"), { recursive: true });
  writeFileSync(join(decoy, ".gsd", "PREFERENCES.md"), [
    "---",
    "models:",
    "  discuss: leaked-from-cwd",
    "---",
    "",
  ].join("\n"));
  try {
    process.chdir(decoy);
    withModelPreferences(
      (home) => {
        assert.equal(process.cwd(), decoy, "cwd must still be the decoy at assertion time");
        assert.equal(
          resolveModelWithFallbacksForUnit("discuss-milestone", home)?.primary,
          "discuss-model",
        );
      },
      { chdirToHome: false },
    );
  } finally {
    process.chdir(oldCwd);
    rmSync(decoy, { recursive: true, force: true });
  }
});

test("validation unit types route to the validation model bucket", () => {
  withModelPreferences(() => {
    assert.equal(resolveModelWithFallbacksForUnit("validate-milestone")?.primary, "validation-model");
    assert.equal(resolveModelWithFallbacksForUnit("gate-evaluate")?.primary, "validation-model");
  });
});

test("worktree-merge routes to completion and is recognized as a unit label", () => {
  withModelPreferences(() => {
    assert.ok(KNOWN_UNIT_LABELS.includes("worktree-merge"));
    assert.equal(resolveModelWithFallbacksForUnit("worktree-merge")?.primary, "completion-model");
  });
});

test("run-uat routes to uat model bucket when configured", () => {
  withModelPreferences(() => {
    assert.equal(resolveModelWithFallbacksForUnit("run-uat")?.primary, "uat-model");
  });
});

test("run-uat falls back to completion when uat bucket is not configured", () => {
  const oldHome = process.env.GSD_HOME;
  const home = mkdtempSync(join(tmpdir(), "gsd-model-map-uat-fallback-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "preferences.md"), [
      "---",
      "models:",
      "  completion: completion-model",
      "---",
      "",
    ].join("\n"));
    assert.equal(resolveModelWithFallbacksForUnit("run-uat")?.primary, "completion-model");
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("default session model resolves from the explicit project base path", () => {
  const oldHome = process.env.GSD_HOME;
  const originalCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "gsd-model-map-home-"));
  const base = mkdtempSync(join(tmpdir(), "gsd-model-map-project-"));

  try {
    process.env.GSD_HOME = home;
    mkdirSync(join(base, ".gsd"), { recursive: true });
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), [
      "---",
      "models:",
      "  execution: gpt-5.5",
      "---",
      "",
    ].join("\n"));
    process.chdir(home);

    assert.deepEqual(resolveDefaultSessionModel("openai-codex", base), {
      provider: "openai-codex",
      id: "gpt-5.5",
    });
  } finally {
    process.chdir(originalCwd);
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test("every known unit label with a dispatch phase resolves when all model buckets are configured", () => {
  withModelPreferences(() => {
    const missing = KNOWN_UNIT_LABELS.filter((unitType) => !resolveModelWithFallbacksForUnit(unitType));
    assert.deepEqual(missing, []);
  });
});

test("discuss-slice has discussion metrics and dashboard labels", () => {
  assert.equal(classifyUnitPhase("discuss-slice"), "discussion");
  assert.equal(unitVerb("discuss-slice"), "discussing");
  assert.equal(unitPhaseLabel("discuss-slice"), "DISCUSS");
});

test("discuss-slice resolves to the slice context artifact path", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-discuss-artifact-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    const path = resolveExpectedArtifactPath("discuss-slice", "M001/S01", base);
    assert.ok(path);
    assert.equal(
      join(realpathSync(dirname(path)), basename(path)),
      join(realpathSync(base), ".gsd", "milestones", "M001", "slices", "S01", "S01-CONTEXT.md"),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
