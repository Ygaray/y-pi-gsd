// Project/App: gsd-pi
// File Purpose: Tests for opt-in GSD tool surface reduction.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { registerToolCompatibility } from "@gsd/pi-coding-agent";

import { DISCUSS_TOOLS_ALLOWLIST } from "../constants.ts";
import { buildMinimalAutoGsdToolSet, buildMinimalGsdToolSet, buildMinimalGsdWorkflowToolSet, buildRequestScopedGsdToolSet, buildRunUatGsdToolSet, MINIMAL_AUTO_BASE_TOOL_NAMES, MINIMAL_GSD_TOOL_NAMES, requestHasGsdCustomType, restoreGsdWorkflowTools, scopeGsdWorkflowToolsForDispatch } from "../bootstrap/register-hooks.ts";
import * as registerHooks from "../bootstrap/register-hooks.ts";
import { DRIVER_PLANE_TOOL_NAMES, excludeDriverPlaneTools, isDriverPlaneToolName, resolveFallbackToolSetAdjustment } from "../driver-plane-tools.ts";
import { filterToolsForProvider } from "../model-router.ts";
import { applyUnitSkillVisibility } from "../skill-scope.ts";
import { drainLogs } from "../workflow-logger.ts";

// Source-text check for register-hooks.ts, used by wiring-gate tests below —
// there is no test seam for internal call-site wiring, so reading the file's
// text is the durable substitute (mirrors the Task 3 source wiring gate).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTER_HOOKS_PATH = join(__dirname, "..", "bootstrap", "register-hooks.ts");
function readRegisterHooksSource(): string {
  return readFileSync(REGISTER_HOOKS_PATH, "utf-8");
}

test("buildMinimalGsdToolSet preserves non-GSD tools and replaces broad GSD surface", () => {
  const result = buildMinimalGsdToolSet([
    "bash",
    "read",
    "browser_open",
    "gsd_plan_milestone",
    "gsd_plan_slice",
    "gsd_task_complete",
    "gsd_task_recovery_resume",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "memory_query",
    "gsd_memory_query",
    "capture_thought",
    "gsd_capture_thought",
    "gsd_graph",
  ]);

  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("browser_open"));
  for (const toolName of MINIMAL_GSD_TOOL_NAMES) {
    assert.ok(result.includes(toolName), `expected ${toolName}`);
  }
  assert.ok(result.includes("gsd_plan_milestone"));
  assert.ok(!result.includes("gsd_task_complete"));
  assert.ok(!result.includes("gsd_graph"));
});

test("buildMinimalGsdToolSet deduplicates preserved and minimal tools", () => {
  const result = buildMinimalGsdToolSet(["bash", "bash", "memory_query"]);

  assert.deepEqual(result.filter((toolName) => toolName === "bash"), ["bash"]);
  assert.deepEqual(result.filter((toolName) => toolName === "memory_query"), ["memory_query"]);
});

test("buildMinimalGsdToolSet does not reintroduce provider-filtered GSD tools", () => {
  const result = buildMinimalGsdToolSet(["bash", "read", "memory_query"]);

  assert.deepEqual(result, ["bash", "read", "memory_query", "ToolSearch"]);
  assert.ok(!result.includes("gsd_exec"));
});

test("buildMinimalGsdToolSet always preserves ToolSearch shim", () => {
  const result = buildMinimalGsdToolSet(["bash", "read"]);
  assert.ok(result.includes("ToolSearch"));
});

test("requestHasGsdCustomType detects GSD-driven requests (drives interactive default scoping)", () => {
  // Plain interactive chat → no gsd-* customType → scoped to the minimal set.
  assert.equal(requestHasGsdCustomType(undefined), false);
  assert.equal(requestHasGsdCustomType([]), false);
  assert.equal(requestHasGsdCustomType([{ customType: "user" }, {}]), false);
  // GSD workflow commands carry a gsd-* customType → keep their full surface.
  assert.equal(requestHasGsdCustomType([{ customType: "gsd-quick-task" }]), true);
  assert.equal(requestHasGsdCustomType([{}, { customType: "gsd-workflow-template" }]), true);
  assert.equal(requestHasGsdCustomType([{ customType: "gsd-run" }]), true);
});

test("buildMinimalAutoGsdToolSet keeps unit-specific completion tools without aliases", () => {
  const result = buildMinimalAutoGsdToolSet([
    "ask_user_questions",
    "bash",
    "read",
    "lsp",
    "browser_click",
    "gsd_task_complete",
    "gsd_task_recovery_resume",
    "gsd_complete_task",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "gsd_slice_complete",
    "gsd_complete_slice",
    "memory_query",
    "capture_thought",
  ], "execute-task");

  assert.ok(result.includes("ask_user_questions"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_task_recovery_resume"));
  assert.ok(result.includes("memory_query"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("browser_click"));
  assert.ok(!result.includes("gsd_complete_task"));
  assert.ok(!result.includes("gsd_slice_complete"));
  assert.ok(!result.includes("gsd_complete_slice"));
});

test("buildMinimalAutoGsdToolSet warns when plan-milestone required tools are unresolved", () => {
  drainLogs();
  const result = buildMinimalAutoGsdToolSet(
    [
      "ask_user_questions",
      "bash",
      "read",
      "gsd_milestone_status",
      "gsd_plan_milestone",
    ],
    "plan-milestone",
    [
      "ask_user_questions",
      "bash",
      "read",
      "gsd_milestone_status",
      "gsd_plan_milestone",
    ],
  );

  assert.ok(result.includes("gsd_plan_milestone"));
  assert.ok(!result.includes("gsd_plan_slice"));

  const logs = drainLogs();
  assert.ok(
    logs.some((entry) =>
      entry.component === "bootstrap" &&
      entry.message.includes("buildMinimalAutoGsdToolSet(plan-milestone)") &&
      entry.message.includes("gsd_plan_slice")
    ),
    `expected missing gsd_plan_slice bootstrap warning, got ${JSON.stringify(logs)}`,
  );
});

test("buildMinimalAutoGsdToolSet scopes run-uat to UAT-specific and read-only tools", () => {
  const active = ["ask_user_questions", "bash", "read", "edit", "write", "gsd_summary_save"];
  const registered = [
    ...active,
    "gsd_uat_exec",
    "gsd_uat_result_save",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_journal_query",
    "gsd_exec",
    "gsd_save_gate_result",
    "search-the-web",
    "browser_navigate",
    "browser_click",
    "browser_snapshot_refs",
  ];
  const result = buildMinimalAutoGsdToolSet(active, "run-uat", registered);
  assert.ok(result.includes("gsd_uat_exec"));
  assert.ok(result.includes("gsd_uat_result_save"));
  assert.ok(result.includes("gsd_resume"));
  assert.ok(result.includes("gsd_milestone_status"));
  assert.ok(result.includes("gsd_journal_query"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("browser_navigate"), "run-uat needs browser_navigate");
  assert.ok(result.includes("browser_click"), "run-uat needs browser_click");
  assert.ok(!result.includes("ToolSearch"));
  assert.ok(!result.includes("bash"));
  assert.ok(!result.includes("edit"));
  assert.ok(!result.includes("write"));
  assert.ok(!result.includes("gsd_exec"));
  assert.ok(!result.includes("gsd_summary_save"));
  assert.ok(!result.includes("gsd_save_gate_result"));
  assert.ok(!result.includes("search-the-web"));
});

test("buildMinimalAutoGsdToolSet keeps only the auto base non-GSD tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "ask_user_questions",
    "bash",
    "bg_shell",
    "browser_wait_for",
    "edit",
    "find",
    "glob",
    "grep",
    "fetch_page",
    "search-the-web",
    "lsp",
    "ls",
    "mac_find",
    "read",
    "subagent",
    "write",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "memory_query",
    "capture_thought",
  ], "execute-task");

  for (const toolName of MINIMAL_AUTO_BASE_TOOL_NAMES) {
    assert.ok(result.includes(toolName), `expected ${toolName}`);
  }
  assert.ok(!result.includes("browser_wait_for"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("mac_find"));
  assert.ok(result.includes("subagent"));
});

test("buildMinimalAutoGsdToolSet re-injects registered base tools filtered from the active set", () => {
  const registered = [
    "bash",
    "read",
    "grep",
    "find",
    "fetch_page",
    "search-the-web",
    "gsd_task_complete",
    "memory_query",
  ];
  const result = buildMinimalAutoGsdToolSet(
    ["bash", "read", "gsd_task_complete", "memory_query"],
    "execute-task",
    registered,
  );

  assert.ok(result.includes("grep"));
  assert.ok(result.includes("find"));
  assert.ok(result.includes("fetch_page"));
  assert.ok(result.includes("search-the-web"));
});

test("buildMinimalAutoGsdToolSet preserves compatible browser add-ons for run-uat", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "edit",
    "write",
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_assert",
    "browser_screenshot",
    "browser_wait_for",
    "gsd_uat_exec",
    "gsd_uat_result_save",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_journal_query",
    "subagent",
    "gsd_summary_save",
    "gsd_exec",
    "gsd_save_gate_result",
    "gsd_task_complete",
    "memory_query",
    "capture_thought",
  ], "run-uat");

  assert.ok(result.includes("browser_navigate"));
  assert.ok(result.includes("browser_click"));
  assert.ok(result.includes("browser_type"));
  assert.ok(result.includes("browser_assert"));
  assert.ok(result.includes("browser_screenshot"));
  assert.ok(result.includes("browser_wait_for"));
  assert.ok(result.includes("gsd_uat_exec"));
  assert.ok(result.includes("gsd_uat_result_save"));
  assert.ok(result.includes("subagent"));
  assert.ok(result.includes("read"));
  assert.ok(!result.includes("ToolSearch"));
  assert.ok(!result.includes("bash"));
  assert.ok(!result.includes("edit"));
  assert.ok(!result.includes("write"));
  assert.ok(!result.includes("gsd_exec"));
  assert.ok(!result.includes("gsd_summary_save"));
  assert.ok(!result.includes("gsd_save_gate_result"));
  assert.ok(!result.includes("gsd_task_complete"));
});

test("buildMinimalAutoGsdToolSet prefers MCP browser tools for run-uat when available", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "browser_navigate",
    "browser_click",
    "mcp__gsd-browser__browser_navigate",
    "mcp__gsd-browser__browser_click",
    "gsd_summary_save",
  ], "run-uat");

  assert.ok(result.includes("mcp__gsd-browser__browser_navigate"));
  assert.ok(result.includes("mcp__gsd-browser__browser_click"));
  assert.ok(!result.includes("browser_navigate"));
  assert.ok(!result.includes("browser_click"));
});

test("buildMinimalAutoGsdToolSet honors provider-compatible registered tools for run-uat", () => {
  registerToolCompatibility("browser_screenshot", { producesImages: true });
  const registered = [
    "bash",
    "read",
    "ToolSearch",
    "browser_navigate",
    "browser_click",
    "browser_screenshot",
    "gsd_uat_exec",
    "gsd_uat_result_save",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_journal_query",
    "gsd_exec",
    "gsd_summary_save",
    "gsd_save_gate_result",
  ];
  const providerCompatible = filterToolsForProvider(registered, "openai-responses").compatible;
  const result = buildMinimalAutoGsdToolSet(["gsd_uat_exec"], "run-uat", providerCompatible);

  assert.ok(result.includes("gsd_uat_exec"));
  assert.ok(result.includes("gsd_uat_result_save"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("browser_navigate"));
  assert.ok(result.includes("browser_click"));
  assert.ok(!result.includes("browser_screenshot"), "provider-filtered screenshot tool must stay filtered");
  assert.ok(!result.includes("ToolSearch"));
  assert.ok(!result.includes("bash"));
  assert.ok(!result.includes("gsd_exec"));
  assert.ok(!result.includes("gsd_summary_save"));
  assert.ok(!result.includes("gsd_save_gate_result"));
});

test("buildMinimalAutoGsdToolSet includes discuss-slice persistence tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "gsd_summary_save",
    "gsd_decision_save",
    "gsd_plan_slice",
    "gsd_task_complete",
    "memory_query",
    "capture_thought",
  ], "discuss-slice");

  assert.ok(result.includes("gsd_summary_save"));
  assert.ok(result.includes("gsd_decision_save"));
  assert.ok(!result.includes("gsd_plan_slice"));
  assert.ok(!result.includes("gsd_task_complete"));
});

test("buildMinimalAutoGsdToolSet includes closeout tool for complete-slice", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "subagent",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "gsd_task_complete",
    "gsd_task_reopen",
    "gsd_replan_slice",
    "gsd_slice_complete",
    "gsd_slice_reopen",
    "gsd_journal_query",
    "gsd_complete_slice",
    "memory_query",
    "capture_thought",
    "gsd_capture_thought",
  ], "complete-slice");

  assert.ok(result.includes("gsd_slice_complete"));
  assert.ok(result.includes("gsd_slice_reopen"));
  assert.ok(result.includes("gsd_task_reopen"));
  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_journal_query"));
  assert.ok(result.includes("gsd_replan_slice"));
  assert.ok(result.includes("subagent"));
  assert.ok(result.includes("gsd_capture_thought"));
  assert.ok(!result.includes("gsd_complete_slice"));
});

test("buildMinimalAutoGsdToolSet preserves workflow MCP-namespaced closeout tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "mcp__gsd-workflow__gsd_task_reopen",
    "mcp__gsd-workflow__gsd_task_complete",
    "mcp__gsd-workflow__gsd_replan_slice",
    "mcp__gsd-workflow__gsd_slice_complete",
    "mcp__gsd-workflow__gsd_slice_reopen",
    "mcp__gsd-workflow__gsd_journal_query",
    "mcp__gsd-workflow__gsd_complete_slice",
    "mcp__gsd-workflow__gsd_exec",
    "mcp__gsd-workflow__memory_query",
    "mcp__gsd-workflow__capture_thought",
    "mcp__gsd-workflow__gsd_capture_thought",
  ], "complete-slice");

  assert.ok(result.includes("mcp__gsd-workflow__gsd_task_reopen"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_task_complete"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_replan_slice"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_slice_complete"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_slice_reopen"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_journal_query"));
  assert.ok(!result.includes("mcp__gsd-workflow__gsd_complete_slice"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_exec"));
  assert.ok(result.includes("mcp__gsd-workflow__memory_query"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_capture_thought"));
});

test("buildMinimalAutoGsdToolSet covers execute-task-simple", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "gsd_task_complete",
    "gsd_decision_save",
    "gsd_plan_task",
    "memory_query",
    "capture_thought",
  ], "execute-task-simple");

  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_decision_save"));
  assert.ok(!result.includes("gsd_plan_task"));
});

test("buildMinimalGsdWorkflowToolSet keeps workflow GSD tools but drops broad non-GSD tools", () => {
  const result = buildMinimalGsdWorkflowToolSet([
    "ask_user_questions",
    "bash",
    "bg_shell",
    "browser_wait_for",
    "edit",
    "lsp",
    "mac_find",
    "read",
    "subagent",
    "write",
    "gsd_plan_milestone",
    "gsd_complete_milestone",
    "gsd_task_complete",
    "gsd_summary_save",
    "memory_query",
    "capture_thought",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "gsd_graph",
  ]);

  assert.ok(result.includes("ask_user_questions"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("bg_shell"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("write"));
  assert.ok(result.includes("gsd_plan_milestone"));
  assert.ok(result.includes("gsd_complete_milestone"));
  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_summary_save"));
  assert.ok(!result.includes("browser_wait_for"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("mac_find"));
  assert.ok(result.includes("subagent"));
  assert.ok(!result.includes("gsd_graph"));
});

test("buildMinimalGsdWorkflowToolSet pulls investigation tools from registered names", () => {
  const result = buildMinimalGsdWorkflowToolSet(
    ["bash", "read", "write", "gsd_summary_save"],
    ["bash", "read", "write", "grep", "find", "ls", "gsd_summary_save"],
  );

  assert.ok(result.includes("grep"));
  assert.ok(result.includes("find"));
  assert.ok(result.includes("ls"));
});

test("buildRequestScopedGsdToolSet keeps grep for guided discuss-milestone requests", () => {
  const result = buildRequestScopedGsdToolSet(
    ["bash", "read", "write", "gsd_summary_save"],
    [{ customType: "gsd-discuss" }],
    ["bash", "read", "write", "grep", "find", "ls", "gsd_summary_save", "gsd_requirement_update"],
    "discuss-milestone",
  );

  assert.ok(result?.includes("grep"));
  assert.ok(result?.includes("gsd_requirement_update"));
  assert.ok(!result?.includes("gsd_task_complete"));
});

test("buildRequestScopedGsdToolSet scopes queued workflow custom-message requests", () => {
  const result = buildRequestScopedGsdToolSet([
    "ask_user_questions",
    "bash",
    "browser_wait_for",
    "lsp",
    "read",
    "write",
    "gsd_plan_milestone",
    "gsd_complete_milestone",
    "gsd_task_complete",
    "gsd_graph",
    "memory_query",
    "capture_thought",
  ], [{ customType: "gsd-run" }, { customType: "gsd-memory" }]);

  assert.ok(result);
  assert.ok(result.includes("ask_user_questions"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("write"));
  assert.ok(result.includes("gsd_plan_milestone"));
  assert.ok(result.includes("gsd_complete_milestone"));
  assert.ok(!result.includes("browser_wait_for"));
  assert.ok(!result.includes("lsp"));
  assert.ok(!result.includes("gsd_graph"));
});

test("buildRequestScopedGsdToolSet ignores stale workflow messages outside the current request tail", () => {
  assert.equal(buildRequestScopedGsdToolSet(["bash", "gsd_plan_milestone"], []), undefined);
});

test("discuss-milestone dispatch keeps required headless milestone tools after two-stage scoping", () => {
  let activeTools = [
    "ask_user_questions",
    "bash",
    "read",
    "write",
    "gsd_summary_save",
    "gsd_decision_save",
    "gsd_requirement_save",
    "gsd_requirement_update",
    "gsd_plan_milestone",
    "gsd_milestone_generate_id",
    "gsd_complete_milestone",
    "gsd_task_complete",
  ];

  activeTools = activeTools.filter((toolName) =>
    !toolName.startsWith("gsd_") ||
    DISCUSS_TOOLS_ALLOWLIST.includes(toolName)
  );

  scopeGsdWorkflowToolsForDispatch({
    getActiveTools: () => activeTools,
    setActiveTools: (tools) => {
      activeTools = tools;
    },
  }, "discuss-milestone");

  assert.ok(activeTools.includes("ask_user_questions"));
  assert.ok(activeTools.includes("gsd_summary_save"));
  assert.ok(activeTools.includes("gsd_requirement_save"));
  assert.ok(activeTools.includes("gsd_requirement_update"));
  assert.ok(activeTools.includes("gsd_plan_milestone"));
  assert.ok(activeTools.includes("gsd_milestone_generate_id"));
  assert.ok(!activeTools.includes("gsd_task_complete"));
  assert.ok(!activeTools.includes("gsd_complete_milestone"));
});

test("#1157: validate-milestone dispatch surface removes generic write and bash tools", () => {
  const result = buildMinimalAutoGsdToolSet([
    "ask_user_questions",
    "bash",
    "bg_shell",
    "edit",
    "find",
    "glob",
    "grep",
    "ls",
    "read",
    "subagent",
    "write",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_validate_milestone",
    "gsd_reassess_roadmap",
  ], "validate-milestone");

  assert.ok(result.includes("read"));
  assert.ok(result.includes("find"));
  assert.ok(result.includes("subagent"));
  assert.ok(result.includes("gsd_validate_milestone"));
  assert.ok(result.includes("gsd_milestone_status"));
  assert.ok(result.includes("gsd_exec"));
  assert.ok(result.includes("gsd_reassess_roadmap"));
  assert.ok(!result.includes("bash"));
  assert.ok(!result.includes("bg_shell"));
  assert.ok(!result.includes("write"));
  assert.ok(!result.includes("edit"));
  assert.ok(!result.includes("ask_user_questions"));
});

test("scopeGsdWorkflowToolsForDispatch applies and restores per-unit skill visibility", () => {
  const calls: Array<{ kind: "tools" | "skills"; value: string[] | undefined }> = [];
  let activeTools = [
    "bash",
    "read",
    "lsp",
    "gsd_plan_milestone",
    "gsd_decision_save",
    "memory_query",
    "capture_thought",
  ];
  let visibleSkills: string[] | undefined = ["previous-skill"];

  const state = scopeGsdWorkflowToolsForDispatch({
    getActiveTools: () => activeTools,
    setActiveTools: (names) => {
      activeTools = names;
      calls.push({ kind: "tools", value: names });
    },
    getVisibleSkills: () => visibleSkills,
    setVisibleSkills: (names) => {
      visibleSkills = names;
      calls.push({ kind: "skills", value: names });
    },
  }, "plan-milestone");

  assert.ok(state);
  assert.deepEqual(visibleSkills, [
    "write-milestone-brief",
    "decompose-into-slices",
    "design-an-interface",
    "grill-me",
    "write-docs",
    "api-design",
    "tdd",
    "verify-before-complete",
  ]);
  assert.ok(!activeTools.includes("lsp"));

  restoreGsdWorkflowTools({
    setActiveTools: (names) => {
      activeTools = names;
      calls.push({ kind: "tools", value: names });
    },
    setVisibleSkills: (names) => {
      visibleSkills = names;
      calls.push({ kind: "skills", value: names });
    },
  }, state);

  assert.deepEqual(activeTools, [
    "bash",
    "read",
    "lsp",
    "gsd_plan_milestone",
    "gsd_decision_save",
    "memory_query",
    "capture_thought",
  ]);
  assert.deepEqual(visibleSkills, ["previous-skill"]);
  assert.equal(calls.filter((call) => call.kind === "skills").length, 2);
});

// ── Regression #534: auto-mode subprocess cannot call gsd_memory_query / gsd_capture_thought ──
// MCP-workflow subprocesses register the gsd_-prefixed variants, not the pi-native names.
// MINIMAL_GSD_TOOL_NAMES must include both so resolveScopedToolNames exposes them.

test("MINIMAL_GSD_TOOL_NAMES includes gsd_memory_query and gsd_capture_thought (regression #534)", () => {
  assert.ok(
    (MINIMAL_GSD_TOOL_NAMES as readonly string[]).includes("gsd_memory_query"),
    "MINIMAL_GSD_TOOL_NAMES must include gsd_memory_query for MCP-workflow surface parity",
  );
  assert.ok(
    (MINIMAL_GSD_TOOL_NAMES as readonly string[]).includes("gsd_capture_thought"),
    "MINIMAL_GSD_TOOL_NAMES must include gsd_capture_thought for MCP-workflow surface parity",
  );
});

test("buildMinimalAutoGsdToolSet resolves MCP-scoped gsd_memory_query and gsd_capture_thought when subprocess only registers gsd_-prefixed variants (regression #534)", () => {
  // Simulate a subprocess that only exposes gsd_-prefixed MCP tool names,
  // not the pi-native memory_query / capture_thought variants.
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "mcp__gsd-workflow__gsd_exec",
    "mcp__gsd-workflow__gsd_memory_query",
    "mcp__gsd-workflow__gsd_capture_thought",
  ], "execute-task");

  assert.ok(
    result.includes("mcp__gsd-workflow__gsd_memory_query"),
    "mcp__gsd-workflow__gsd_memory_query must be included when only the gsd_-prefixed variant is available",
  );
  assert.ok(
    result.includes("mcp__gsd-workflow__gsd_capture_thought"),
    "mcp__gsd-workflow__gsd_capture_thought must be included when only the gsd_-prefixed variant is available",
  );
});

// ── Regression #627: auto-mode cannot run plan-milestone because gsd_plan_slice is missing ──
// gsd_plan_slice is in AUTO_UNIT_SCOPED_TOOLS["plan-milestone"] (via unit-tool-contracts).
// buildMinimalAutoGsdToolSet must expose it when unitType is "plan-milestone".

test("buildMinimalAutoGsdToolSet includes gsd_plan_slice for plan-milestone (regression #627)", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "gsd_plan_milestone",
    "gsd_plan_slice",
    "gsd_milestone_status",
    "gsd_checkpoint_db",
    "memory_query",
    "capture_thought",
  ], "plan-milestone");

  assert.ok(
    result.includes("gsd_plan_slice"),
    "gsd_plan_slice must be included in plan-milestone auto-mode tool set",
  );
});

test("buildMinimalAutoGsdToolSet resolves MCP-scoped gsd_plan_slice for plan-milestone when subprocess only registers prefixed variant (regression #627)", () => {
  const result = buildMinimalAutoGsdToolSet([
    "bash",
    "read",
    "mcp__gsd-workflow__gsd_plan_milestone",
    "mcp__gsd-workflow__gsd_plan_slice",
    "mcp__gsd-workflow__gsd_milestone_status",
    "mcp__gsd-workflow__gsd_checkpoint_db",
    "mcp__gsd-workflow__memory_query",
    "mcp__gsd-workflow__capture_thought",
  ], "plan-milestone");

  assert.ok(
    result.includes("mcp__gsd-workflow__gsd_plan_slice"),
    "mcp__gsd-workflow__gsd_plan_slice must be included when only the MCP-scoped variant is available",
  );
});

test("applyUnitSkillVisibility sets manifest or clears for wildcard", () => {
  const calls: Array<string[] | undefined> = [];
  applyUnitSkillVisibility({
    setVisibleSkills: (names) => {
      calls.push(names);
    },
  }, "plan-milestone");
  assert.ok(Array.isArray(calls[0]));
  assert.ok(calls[0]!.includes("tdd"));

  applyUnitSkillVisibility({
    setVisibleSkills: (names) => {
      calls.push(names);
    },
  }, "execute-task");
  assert.equal(calls[1], undefined);
});

// ── SURF-01: the interactive agent's advertised tool surface must never
// include the 6 external-driver-plane MCP tools (gsd_execute, gsd_status,
// gsd_result, gsd_cancel, gsd_query, gsd_resolve_blocker). See 36-CONTEXT.md
// D-01..D-04 and driver-plane-tools.ts. ──

test("DRIVER_PLANE_TOOL_NAMES is the hand-picked 6-entry roster from mcp-server/src/server.ts (SURF-01 D-01)", () => {
  assert.equal(DRIVER_PLANE_TOOL_NAMES.length, 6);
  assert.deepEqual([...DRIVER_PLANE_TOOL_NAMES], [
    "gsd_execute",
    "gsd_status",
    "gsd_result",
    "gsd_cancel",
    "gsd_query",
    "gsd_resolve_blocker",
  ]);
});

test("excludeDriverPlaneTools drops the 6 driver-plane tools and keeps gsd_exec (SURF-01 D-01/D-02)", () => {
  const fixture = [
    ...DRIVER_PLANE_TOOL_NAMES.map((name) => `mcp__gsd-workflow__${name}`),
    "bash",
    "read",
    "gsd_exec",
    "gsd_exec_search",
    "mcp__gsd-workflow__gsd_exec",
  ];
  const result = excludeDriverPlaneTools(fixture);

  for (const name of DRIVER_PLANE_TOOL_NAMES) {
    assert.ok(!result.includes(`mcp__gsd-workflow__${name}`), `expected mcp__gsd-workflow__${name} to be excluded`);
  }
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("gsd_exec"));
  assert.ok(result.includes("gsd_exec_search"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_exec"));
});

test("buildMinimalGsdToolSet excludes driver-plane tools on an idle/menu turn (SC-1)", () => {
  const fixture = [
    "bash",
    "read",
    ...DRIVER_PLANE_TOOL_NAMES.map((name) => `mcp__gsd-workflow__${name}`),
    "gsd_exec",
    "gsd_exec_search",
    "mcp__gsd-workflow__gsd_exec",
  ];
  const result = buildMinimalGsdToolSet(fixture);

  for (const name of DRIVER_PLANE_TOOL_NAMES) {
    assert.ok(!result.includes(`mcp__gsd-workflow__${name}`), `expected mcp__gsd-workflow__${name} to be excluded`);
  }
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("gsd_exec"));
  assert.ok(result.includes("gsd_exec_search"));
  assert.ok(result.includes("mcp__gsd-workflow__gsd_exec"));
});

test("excludeDriverPlaneTools match matrix: exact canonical base name only, no substring/case/whitespace match", () => {
  const excluded = ["gsd_execute", "mcp__gsd-workflow__gsd_execute", "mcp__some-other-server__gsd_execute"];
  const kept = [
    "gsd_exec",
    "gsd_exec_search",
    "gsd_executor",
    "gsd_execute_plan",
    "my_gsd_execute",
    "GSD_EXECUTE",
    "gsd_execute ",
    "mcp____gsd_execute",
    "mcp__a__mcp__b__gsd_execute",
  ];

  for (const name of excluded) {
    assert.equal(isDriverPlaneToolName(name), true, `expected ${name} to be excluded`);
  }
  for (const name of kept) {
    assert.equal(isDriverPlaneToolName(name), false, `expected ${name} to survive`);
  }

  assert.deepEqual(excludeDriverPlaneTools([...excluded, ...kept]), kept);
});

test("excludeDriverPlaneTools edge contract: empty, single-element, order-preserving, idempotent, non-mutating", () => {
  assert.deepEqual(excludeDriverPlaneTools([]), []);
  assert.deepEqual(excludeDriverPlaneTools(["mcp__gsd-workflow__gsd_cancel"]), []);
  assert.deepEqual(excludeDriverPlaneTools(["bash"]), ["bash"]);

  const mixed = [
    "bash",
    "mcp__gsd-workflow__gsd_execute",
    "read",
    "mcp__gsd-workflow__gsd_status",
    "gsd_exec",
  ];
  const mixedCopy = [...mixed];
  const result = excludeDriverPlaneTools(mixed);

  assert.deepEqual(result, ["bash", "read", "gsd_exec"]);
  assert.equal(new Set(result).size, result.length);
  assert.deepEqual(mixed, mixedCopy);

  const twice = excludeDriverPlaneTools(result);
  assert.deepEqual(twice, result);
});

test("excludeDriverPlaneTools returns its input unchanged under PI_GSD_FULL_TOOLS=1 (D-04)", () => {
  const fixture = [
    "bash",
    ...DRIVER_PLANE_TOOL_NAMES.map((name) => `mcp__gsd-workflow__${name}`),
    "gsd_exec",
  ];

  process.env.PI_GSD_FULL_TOOLS = "1";
  try {
    assert.deepEqual(excludeDriverPlaneTools(fixture), fixture);
  } finally {
    delete process.env.PI_GSD_FULL_TOOLS;
  }
});

test("excludeDriverPlaneTools preserves every non-driver-plane adapter tool (over-filter regression)", () => {
  const nonDriverAdapterTools = [
    "gsd_doctor",
    "ask_user_questions",
    "gsd_roadmap",
    "gsd_progress",
    "gsd_history",
    "gsd_knowledge",
    "gsd_captures",
    "gsd_graph",
  ];

  for (const prefix of ["", "mcp__gsd-workflow__"]) {
    const fixture = [
      ...nonDriverAdapterTools.map((name) => `${prefix}${name}`),
      ...DRIVER_PLANE_TOOL_NAMES.map((name) => `${prefix}${name}`),
    ];
    const result = excludeDriverPlaneTools(fixture);

    for (const name of nonDriverAdapterTools) {
      assert.ok(result.includes(`${prefix}${name}`), `expected ${prefix}${name} to survive`);
    }
    for (const name of DRIVER_PLANE_TOOL_NAMES) {
      assert.ok(!result.includes(`${prefix}${name}`), `expected ${prefix}${name} to be excluded`);
    }
  }
});

// ── SURF-01 Task 2: every dispatched-unit tool-set path subtracts the
// driver plane too (D-03), while each unit's own required tools survive. ──

const SEEDED_DRIVER_PLANE_NAMES = DRIVER_PLANE_TOOL_NAMES.map((name) => `mcp__gsd-workflow__${name}`);

test("buildMinimalAutoGsdToolSet excludes driver-plane tools for execute-task while keeping unit tools (SC-3)", () => {
  const active = [
    "ask_user_questions",
    "bash",
    "read",
    "gsd_task_complete",
    "gsd_task_recovery_resume",
    "memory_query",
    ...SEEDED_DRIVER_PLANE_NAMES,
  ];
  const registered = [...active];
  const result = buildMinimalAutoGsdToolSet(active, "execute-task", registered);

  for (const name of SEEDED_DRIVER_PLANE_NAMES) {
    assert.ok(!result.includes(name), `expected ${name} to be excluded`);
  }
  assert.ok(result.includes("gsd_task_complete"));
  assert.ok(result.includes("gsd_task_recovery_resume"));
  assert.ok(result.includes("ask_user_questions"));
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("memory_query"));
});

test("buildMinimalAutoGsdToolSet excludes driver-plane tools for the run-uat early-return path (SC-3)", () => {
  const active = [
    "read",
    "gsd_uat_exec",
    "gsd_uat_result_save",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_journal_query",
    ...SEEDED_DRIVER_PLANE_NAMES,
  ];
  const registered = [...active];
  const result = buildMinimalAutoGsdToolSet(active, "run-uat", registered);

  for (const name of SEEDED_DRIVER_PLANE_NAMES) {
    assert.ok(!result.includes(name), `expected ${name} to be excluded`);
  }
  assert.ok(result.includes("gsd_uat_exec"));
  assert.ok(result.includes("gsd_uat_result_save"));
});

test("buildRunUatGsdToolSet excludes driver-plane tools while keeping run-uat workflow tools (SC-3)", () => {
  const active = [
    "read",
    "gsd_uat_exec",
    "gsd_uat_result_save",
    "gsd_resume",
    "gsd_milestone_status",
    "gsd_journal_query",
    ...SEEDED_DRIVER_PLANE_NAMES,
  ];
  const registered = [...active];
  const result = buildRunUatGsdToolSet(active, registered);

  for (const name of SEEDED_DRIVER_PLANE_NAMES) {
    assert.ok(!result.includes(name), `expected ${name} to be excluded`);
  }
  assert.ok(result.includes("gsd_uat_exec"));
  assert.ok(result.includes("gsd_uat_result_save"));
  assert.ok(result.includes("gsd_resume"));
  assert.ok(result.includes("gsd_milestone_status"));
  assert.ok(result.includes("gsd_journal_query"));
});

test("buildMinimalGsdWorkflowToolSet excludes driver-plane tools while keeping base tools (SC-3)", () => {
  const active = [
    "bash",
    "read",
    "gsd_plan_milestone",
    "gsd_task_complete",
    ...SEEDED_DRIVER_PLANE_NAMES,
  ];
  const registered = [...active];
  const result = buildMinimalGsdWorkflowToolSet(active, registered);

  for (const name of SEEDED_DRIVER_PLANE_NAMES) {
    assert.ok(!result.includes(name), `expected ${name} to be excluded`);
  }
  assert.ok(result.includes("bash"));
  assert.ok(result.includes("read"));
  assert.ok(result.includes("gsd_plan_milestone"));
});

test("buildRequestScopedGsdToolSet excludes driver-plane tools for a gsd-run customType (SC-3)", () => {
  const active = [
    "bash",
    "read",
    "gsd_plan_milestone",
    ...SEEDED_DRIVER_PLANE_NAMES,
  ];
  const registered = [...active];
  const result = buildRequestScopedGsdToolSet(active, [{ customType: "gsd-run" }], registered);

  assert.ok(result);
  for (const name of SEEDED_DRIVER_PLANE_NAMES) {
    assert.ok(!result!.includes(name), `expected ${name} to be excluded`);
  }
});

test("buildMinimalAutoGsdToolSet, buildRunUatGsdToolSet, and buildMinimalGsdWorkflowToolSet route their returns through excludeDriverPlaneTools (source wiring gate, D-03)", () => {
  // Behavioral fixtures alone cannot distinguish "wired" from "unwired" here:
  // RESEARCH.md confirmed by grep that unit-tool-contracts.ts and
  // unit-registry.ts contain zero references to any of the 6 driver-plane
  // tool names, so these three allowlist-based builders never happen to
  // pull one in regardless of wiring. The source-text check is the durable
  // substitute that actually proves D-03's call-site requirement.
  const source = readRegisterHooksSource();

  const autoStart = source.indexOf("export function buildMinimalAutoGsdToolSet(");
  const runUatStart = source.indexOf("export function buildRunUatGsdToolSet(");
  const workflowStart = source.indexOf("export function buildMinimalGsdWorkflowToolSet(");
  const requestScopedStart = source.indexOf("export function buildRequestScopedGsdToolSet(");

  assert.ok(autoStart !== -1, "buildMinimalAutoGsdToolSet not found in register-hooks.ts");
  assert.ok(runUatStart !== -1, "buildRunUatGsdToolSet not found in register-hooks.ts");
  assert.ok(workflowStart !== -1, "buildMinimalGsdWorkflowToolSet not found in register-hooks.ts");
  assert.ok(requestScopedStart !== -1, "buildRequestScopedGsdToolSet not found in register-hooks.ts");

  const autoBody = source.slice(autoStart, runUatStart);
  const runUatBody = source.slice(runUatStart, workflowStart);
  const workflowBody = source.slice(workflowStart, requestScopedStart);

  assert.ok(
    autoBody.includes("excludeDriverPlaneTools("),
    "buildMinimalAutoGsdToolSet must route its return through excludeDriverPlaneTools",
  );
  assert.ok(
    runUatBody.includes("excludeDriverPlaneTools("),
    "buildRunUatGsdToolSet must route its return through excludeDriverPlaneTools",
  );
  assert.ok(
    workflowBody.includes("excludeDriverPlaneTools("),
    "buildMinimalGsdWorkflowToolSet must route its return through excludeDriverPlaneTools",
  );
});

test("buildMinimalAutoGsdToolSet does not warn about driver-plane tools when only driver-plane names are seeded", () => {
  drainLogs();
  buildMinimalAutoGsdToolSet(
    [...SEEDED_DRIVER_PLANE_NAMES, "bash", "read"],
    "execute-task",
    [...SEEDED_DRIVER_PLANE_NAMES, "bash", "read"],
  );
  const logs = drainLogs();

  assert.ok(
    !logs.some((entry) => DRIVER_PLANE_TOOL_NAMES.some((name) => entry.message.includes(name))),
    `expected no warning naming a driver-plane tool, got ${JSON.stringify(logs)}`,
  );
});

// ── SURF-01 Task 3: the adjust_tool_set fallback branch and the drift gate. ──

test("resolveFallbackToolSetAdjustment forces a defined toolNames return when the driver plane is removed (D-03)", () => {
  assert.deepEqual(
    resolveFallbackToolSetAdjustment(["bash", "read", "mcp__gsd-workflow__gsd_execute"], false),
    { toolNames: ["bash", "read"] },
  );
});

test("resolveFallbackToolSetAdjustment returns undefined when nothing driver-plane is present and surfaceReduced is false", () => {
  assert.equal(resolveFallbackToolSetAdjustment(["bash", "read"], false), undefined);
});

test("resolveFallbackToolSetAdjustment preserves existing surfaceReduced semantics when no driver-plane tool is present", () => {
  assert.deepEqual(resolveFallbackToolSetAdjustment(["bash", "read"], true), { toolNames: ["bash", "read"] });
});

test("resolveFallbackToolSetAdjustment subtracts the driver plane when surfaceReduced is already true", () => {
  assert.deepEqual(
    resolveFallbackToolSetAdjustment(["bash", "mcp__gsd-workflow__gsd_query"], true),
    { toolNames: ["bash"] },
  );
});

test("resolveFallbackToolSetAdjustment's internal D-04 guard makes the subtraction a no-op under PI_GSD_FULL_TOOLS=1", () => {
  process.env.PI_GSD_FULL_TOOLS = "1";
  try {
    assert.equal(
      resolveFallbackToolSetAdjustment(["bash", "mcp__gsd-workflow__gsd_execute"], false),
      undefined,
    );
    assert.deepEqual(
      resolveFallbackToolSetAdjustment(["bash", "mcp__gsd-workflow__gsd_execute"], true),
      { toolNames: ["bash", "mcp__gsd-workflow__gsd_execute"] },
    );
  } finally {
    delete process.env.PI_GSD_FULL_TOOLS;
  }
});

test("adjust_tool_set's fallback return routes through resolveFallbackToolSetAdjustment (source wiring guard)", () => {
  // A behavioral test cannot reach the hook body directly — there is no test
  // seam for the handler and building one would need a full ExtensionAPI
  // mock — so this source-text assertion is the durable substitute.
  const source = readRegisterHooksSource();
  assert.ok(
    source.includes("return resolveFallbackToolSetAdjustment(providerCompatible, surfaceReduced)"),
    "adjust_tool_set's fallback return must route through resolveFallbackToolSetAdjustment",
  );
});

test("every exported build…ToolSet in register-hooks.ts is covered by the driver-plane exclusion gate (drift guard)", () => {
  const COVERED_BUILDERS = new Set([
    "buildMinimalGsdToolSet",
    "buildMinimalAutoGsdToolSet",
    "buildRunUatGsdToolSet",
    "buildMinimalGsdWorkflowToolSet",
    "buildRequestScopedGsdToolSet",
  ]);
  const actualBuilders = new Set(
    Object.keys(registerHooks).filter((name) => /^build.*ToolSet$/.test(name)),
  );

  for (const name of COVERED_BUILDERS) {
    assert.ok(actualBuilders.has(name), `expected register-hooks.ts to still export ${name}`);
  }
  for (const name of actualBuilders) {
    assert.ok(
      COVERED_BUILDERS.has(name),
      `register-hooks.ts exports a new build*ToolSet function (${name}) not yet wired through ` +
        "excludeDriverPlaneTools — add it to this test's COVERED_BUILDERS set and wire the call site",
    );
  }
});
