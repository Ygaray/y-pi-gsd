/**
 * GSD Command — additional workflows (implemented, prompt-driven)
 *
 * Each command here is implemented as a real prompt-driven workflow (not an alias).
 * Commands load a prompt template and dispatch it to the agent via `pi.sendMessage`,
 * mirroring how /gsd scan and /gsd quick work. Prompt templates work against the
 * milestone / slice / `.gsd/` model.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { loadPrompt } from "./prompt-loader.js";
import type { PauseHandoffDeps } from "./handoff-lifecycle.js";
import type { HandoffRunner } from "./handoff-client.js";
import { currentDirectoryRoot, GSDNoProjectError, projectRoot, withCommandCwd } from "./commands/context.js";
import { getUnmergedMilestoneBlockMessageForBase } from "./unmerged-milestone-guard.js";
import { getValidationBlockMessageForBase } from "./validation-block-guard.js";
import { getActiveMilestoneId } from "./state.js";
import {
  type ActiveMilestoneRunDetection,
  detectActiveMilestoneRun,
  failStaleMilestoneRunLogRow,
  isConclusiveNotActiveReason,
} from "./session-lock.js";
import { recordMilestoneRunLifecycle } from "./milestone-run-log-domain-operation.js";
import { getActiveMilestoneRun, renderMilestoneRunLog } from "./run-log-projection.js";
import { internalExecutionInvocation } from "./execution-invocation.js";
import {
  type AutonomousScope,
  deriveMilestoneOrdinal,
  describeAutonomousScope,
  isUnitInAutonomousScope,
  parseAutonomousScopeFlags,
  resolveEffectiveAutonomousScope,
} from "./autonomous-scope.js";
import { autoSession } from "./auto-runtime-state.js";
import { getActiveMilestoneFromDb, getActiveSliceFromDb, savePlanReviewCycle } from "./gsd-db.js";
import { planReviewCycleSummaryFileName } from "./plan-review-cycle-summary.js";
import { resolvePlanReviewMaxCycles } from "./preferences.js";
import { PLAN_REVIEW_MAX_CYCLES_BOUNDS } from "./preferences-validation.js";

/**
 * Catalog entries for commands IMPLEMENTED natively in this module.
 * Spread into TOP_LEVEL_SUBCOMMANDS so autocomplete surfaces them.
 * Keep in sync with the handlers below and the help section in core.ts.
 */
export const GSD_CORE_IMPLEMENTED_CATALOG: ReadonlyArray<{ cmd: string; desc: string }> = [
  { cmd: "explore", desc: "Socratic ideation — think an idea through before committing" },
  { cmd: "spike", desc: "Validate an idea through focused throwaway experiments" },
  { cmd: "sketch", desc: "Explore UI/design ideas with throwaway HTML mockups" },
  { cmd: "map-codebase", desc: "Analyze the codebase into structured reference docs under .gsd/codebase/" },
  { cmd: "docs-update", desc: "Generate, update, and verify project docs against the live codebase" },
  { cmd: "graphify", desc: "Build/query/inspect a lightweight project knowledge graph in .gsd/knowledge/" },
  { cmd: "stats", desc: "Display project statistics — milestones, slices, git metrics, timeline" },
  { cmd: "progress", desc: "Situational awareness — recent work and what's next" },
  { cmd: "health", desc: "Validate .gsd/ directory integrity and optionally repair" },
  { cmd: "surface", desc: "Manage which skills/extensions are surfaced in the session" },
  { cmd: "code-review", desc: "Review changed source for bugs, security, and quality" },
  { cmd: "review", desc: "Peer review of recent work across reviewer perspectives" },
  { cmd: "audit-milestone", desc: "Verify a milestone met its definition of done" },
  { cmd: "audit-uat", desc: "Cross-milestone audit of outstanding UAT/verification items" },
  { cmd: "audit-fix", desc: "Audit-to-fix pipeline — classify, fix, test, commit" },
  { cmd: "ui-review", desc: "Retroactive 6-pillar visual audit of frontend code" },
  { cmd: "secure-phase", desc: "Verify threat mitigations for completed work" },
  { cmd: "validate-phase", desc: "Audit and fill validation/test coverage gaps" },
  { cmd: "verify-work", desc: "Conversational UAT of built features" },
  { cmd: "plan-review-convergence", desc: "Iterate a plan through review cycles until concerns resolve" },
  { cmd: "discuss-phase", desc: "Gather milestone/slice context through adaptive questioning" },
  { cmd: "plan-phase", desc: "Create a detailed slice plan with a verification loop" },
  { cmd: "execute-phase", desc: "Execute slice tasks with wave-based parallelization" },
  { cmd: "spec-phase", desc: "Clarify WHAT a milestone delivers, with ambiguity scoring" },
  { cmd: "mvp-phase", desc: "Plan a milestone as a vertical MVP slice" },
  { cmd: "ui-phase", desc: "Produce a UI design contract (UI-SPEC) for a frontend milestone" },
  { cmd: "ai-integration-phase", desc: "Produce an AI design contract (AI-SPEC) for AI milestones" },
  { cmd: "ultraplan-phase", desc: "Extended-reasoning plan pass, review, then import" },
  { cmd: "autonomous", desc: "Run all remaining lifecycle work continuously" },
  { cmd: "pause-work", desc: "Create a context handoff (registered with yahir-handoff) when pausing mid-stream" },
  { cmd: "resume-work", desc: "Resume work with full context restoration (takes this project's yahir-handoff; optional <handoff-id>)" },
  { cmd: "manager", desc: "Interactive command center for multiple milestones" },
  { cmd: "phase", desc: "CRUD for milestone queue ordering" },
  { cmd: "thread", desc: "Persistent context threads for cross-session work" },
  { cmd: "workstreams", desc: "Manage parallel workstreams via /gsd parallel" },
  { cmd: "workspace", desc: "Manage isolated workspaces via /gsd worktree" },
  { cmd: "milestone-summary", desc: "Comprehensive project/milestone summary for onboarding" },
  { cmd: "review-backlog", desc: "Review and promote backlog items to milestones" },
  { cmd: "inbox", desc: "Triage open GitHub issues and PRs against conventions" },
  { cmd: "import", desc: "Ingest external plans with conflict detection" },
  { cmd: "ingest-docs", desc: "Bootstrap .gsd/ from existing ADRs/PRDs/SPECs/docs" },
  { cmd: "profile-user", desc: "Generate and persist a developer behavioral profile" },
  { cmd: "settings", desc: "Configure workflow toggles and model profile" },
];

// ─── Shared flag parsing ─────────────────────────────────────────────────────

export interface ParsedFlags {
  /** Remaining text after flags are stripped. */
  text: string;
  quick: boolean;
  textMode: boolean;
  frontier: boolean;
}

const FLAG_RE = /(^|\s)--(quick|text|wrap-up|force|verbose|dry-run|all|auto|interactive|tdd|research|skip-research|gaps-only)(?=\s|$)/g;

/**
 * Parse the common workflow flags out of a raw arg string.
 * `frontier` is detected as a bare token or empty input.
 * Exported for unit testing.
 */
export function parseCoreFlags(raw: string): ParsedFlags {
  let text = raw;
  const quick = /(^|\s)--quick(?=\s|$)/.test(text);
  const textMode = /(^|\s)--text(?=\s|$)/.test(text);
  // Strip recognized --flags so they don't pollute the idea text.
  text = text.replace(FLAG_RE, " ").replace(/\s+/g, " ").trim();
  const frontier = text === "" || text.toLowerCase() === "frontier";
  return { text, quick, textMode, frontier };
}

/** Boolean → human-readable phrase for prompt interpolation. */
function flagPhrase(on: boolean): string {
  return on ? "ON" : "off";
}

/** Slugify text into a URL/path-safe form (max 40 chars). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

/**
 * Return the next zero-padded 3-digit id for a numbered artifact directory.
 * Looks at existing `<dir>/[0-9][0-9][0-9]-*` entries.
 * Exported for unit testing.
 */
export function nextArtifactId(dir: string): string {
  let max = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = entry.name.match(/^(\d{3})-/);
      if (m) max = Math.max(max, Number.parseInt(m[1], 10));
    }
  } catch {
    // dir does not exist yet
  }
  return String(max + 1).padStart(3, "0");
}

// ─── Dispatch helpers ────────────────────────────────────────────────────────

interface DispatchOptions {
  /** Prompt template name (under prompts/<name>.md). */
  prompt: string;
  /** customType for the sendMessage payload. */
  customType: string;
  /** User-facing label, e.g. "Spiking". */
  verb: string;
  /** Variables to interpolate into the prompt (omitted when the template has none). */
  vars?: Record<string, string>;
  /** Optional pre-dispatch notification override (default: "Running <verb>…"). */
  notify?: string;
}

/** Returns true when the prompt was handed to the agent, false when the dispatch failed. */
function dispatchPrompt(
  args: DispatchOptions,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): boolean {
  ctx.ui.notify(args.notify ?? `Running ${args.verb.toLowerCase()}…`, "info");
  try {
    const prompt = loadPrompt(args.prompt, args.vars ?? {});
    pi.sendMessage(
      { customType: args.customType, content: prompt, display: false },
      { triggerTurn: true },
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to dispatch ${args.verb.toLowerCase()}: ${msg}`, "error");
    return false;
  }
}

function splitAction(args: string): { action: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "", rest: "" };
  const [action = "", ...rest] = trimmed.split(/\s+/);
  return { action: action.toLowerCase(), rest: rest.join(" ") };
}

const MANAGER_ACTIONS_NORMAL = [
  "3. **Offer actions**, one at a time:",
  "   - Switch the active milestone (`/gsd queue`).",
  "   - Reorder queued milestones (`/gsd queue`).",
  "   - Park or unpark a milestone (`/gsd park` / `/gsd unpark`).",
  "   - Start/stop auto-mode on the active milestone (`/gsd auto` / `/gsd stop`).",
  "   - Run parallel milestones (`/gsd parallel`).",
].join("\n");

const MANAGER_SUCCESS_NORMAL = [
  "- The dashboard reflects canonical milestone state, not memory.",
  "- Actions route to the real gsd-pi commands, not duplicates.",
  "- Dependency analysis (when requested) is grounded in actual file/API overlap.",
].join("\n");

const MANAGER_SUCCESS_READ_ONLY = [
  "- The dashboard reflects canonical milestone state, not memory.",
  "- Read-only mode does not route to any gsd-pi command.",
  "- Dependency analysis (when requested) is grounded in actual file/API overlap.",
].join("\n");

const MANAGER_SELECTION_NORMAL =
  "5. **Act on the selection** by routing to the matching gsd-pi command — do not reimplement queue/park/parallel logic inline.";

const MANAGER_SELECTION_READ_ONLY =
  "5. **Skip action routing.** Do not act on selections or invoke gsd-pi commands while this blocker is present.";

async function dispatchGSDCommand(
  command: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const { handleGSDCommand } = await import("./commands/dispatcher.js");
  await handleGSDCommand(command, ctx, pi);
}

function managerReadOnlyActions(blocker: string): string {
  return [
    "3. **Stay read-only.** Only display the dashboard and blockers.",
    "",
    "Do not offer actions or route to queue, park, auto-mode, or parallel commands until the blocker is resolved.",
    "",
    "Blocked state:",
    blocker,
  ].join("\n");
}

async function resolveManagerVars(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {
    analyzeDepsFlag: flagPhrase(/(?:^|\s)--analyze-deps(?=\s|$)/.test(args)),
    managerActions: MANAGER_ACTIONS_NORMAL,
    managerSelectionStep: MANAGER_SELECTION_NORMAL,
    managerSuccessCriteria: MANAGER_SUCCESS_NORMAL,
  };

  // Use ctx.cwd when set; when absent fall back to process.cwd() so that the read-only
  // downgrade still fires even if the caller did not populate ctx.cwd. Wrap in try/catch
  // so that a missing project context (no .gsd/) returns the normal vars gracefully.
  try {
    return await withCommandCwd(ctx.cwd, async () => {
      const base = projectRoot();
      const blocker =
        await getUnmergedMilestoneBlockMessageForBase(base, "manager") ??
        await getValidationBlockMessageForBase(base, "manager");
      if (!blocker) return vars;

      return {
        ...vars,
        managerActions: managerReadOnlyActions(blocker),
        managerSelectionStep: MANAGER_SELECTION_READ_ONLY,
        managerSuccessCriteria: MANAGER_SUCCESS_READ_ONLY,
      };
    });
  } catch (err) {
    if (err instanceof GSDNoProjectError) return vars;
    throw err;
  }
}

// ─── Individual command handlers ─────────────────────────────────────────────

/** /gsd explore [topic] — Socratic ideation. */
export async function handleExplore(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const topic = args.trim();
  dispatchPrompt(
    {
      prompt: "explore",
      customType: "gsd-explore",
      verb: "Explore",
      vars: { topic: topic || "(no topic — ask the developer what's on their mind)" },
    },
    ctx,
    pi,
  );
}

/** /gsd spike [idea] [--quick] [--text] | frontier */
export async function handleSpike(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const flags = parseCoreFlags(args);
  const basePath = currentDirectoryRoot();
  const spikesDir = join(basePath, ".gsd", "spikes");
  mkdirSync(spikesDir, { recursive: true });
  const spikeId = nextArtifactId(spikesDir);
  dispatchPrompt(
    {
      prompt: "spike",
      customType: "gsd-spike",
      verb: "Spike",
      vars: {
        input: flags.text || "(frontier mode — propose what to spike next)",
        quickFlag: flagPhrase(flags.quick),
        textFlag: flagPhrase(flags.textMode),
        frontierFlag: flagPhrase(flags.frontier),
        spikeId,
      },
    },
    ctx,
    pi,
  );
}

/** /gsd sketch [idea] [--quick] [--text] | frontier */
export async function handleSketch(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const flags = parseCoreFlags(args);
  const basePath = currentDirectoryRoot();
  const sketchesDir = join(basePath, ".gsd", "sketches");
  mkdirSync(sketchesDir, { recursive: true });
  const sketchId = nextArtifactId(sketchesDir);
  dispatchPrompt(
    {
      prompt: "sketch",
      customType: "gsd-sketch",
      verb: "Sketch",
      vars: {
        input: flags.text || "(frontier mode — propose what to sketch next)",
        quickFlag: flagPhrase(flags.quick),
        textFlag: flagPhrase(flags.textMode),
        frontierFlag: flagPhrase(flags.frontier),
        sketchId,
      },
    },
    ctx,
    pi,
  );
}

// ─── Batch 2: codebase intelligence ──────────────────────────────────────────

/**
 * Parse a `--paths a,b,c` flag safely for map-codebase incremental remap.
 * Rejects values containing `..`, leading `/`, or shell metacharacters.
 * Exported for unit testing.
 */
export function parsePathsFlag(args: string): string {
  const m = args.match(/--paths\s+(\S+)/i);
  if (!m) return "";
  const raw = m[1];
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const bad = /[;`$&|<>]/;
  const safe = parts.filter((p) => !p.startsWith("/") && !p.includes("..") && !bad.test(p));
  return safe.length ? safe.join(",") : "";
}

/** /gsd map-codebase [--paths a,b] [--focus ...] — produce .gsd/codebase/ docs. */
export async function handleMapCodebase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const basePath = currentDirectoryRoot();
  const outputDir = join(basePath, ".gsd", "codebase");
  mkdirSync(outputDir, { recursive: true });
  const paths = parsePathsFlag(args);
  const focus = parseFlagValue(args, "--focus") ?? "";
  const scopeParts: string[] = [];
  if (paths) scopeParts.push(`Incremental remap — scope exploration to: ${paths}`);
  else scopeParts.push("Whole-repo scan.");
  if (focus) scopeParts.push(`Focus area: ${focus}`);
  dispatchPrompt(
    {
      prompt: "map-codebase",
      customType: "gsd-map-codebase",
      verb: "Map codebase",
      vars: { scope: scopeParts.join(" "), outputDir: outputDir.replaceAll("\\", "/") },
    },
    ctx,
    pi,
  );
}

/** /gsd docs-update [--force] [--verify-only] — generate/update/verify docs. */
export async function handleDocsUpdate(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const force = /(^|\s)--force(?=\s|$)/.test(args);
  const verifyOnly = /(^|\s)--verify-only(?=\s|$)/.test(args);
  const mode = verifyOnly
    ? "Verify-only — check existing docs against the codebase; do not write new docs."
    : force
      ? "Force — regenerate all canonical docs even if they look current."
      : "Default — generate missing docs, update stale ones, verify existing claims.";
  const docsProcess = verifyOnly
    ? [
        "1. **Detect the doc structure.** Find existing Markdown docs (README, docs/, ADRs, API docs, CONTRIBUTING, etc.) and any doc tooling (docusaurus, vitepress, mkdocs, storybook). Detect project type (monorepo, cli-tool, saas, open-source-library, generic) from manifests and routes.",
        "",
        "2. **Assemble a read-only review manifest.** List existing hand-written docs to review for accuracy. Note missing canonical docs as gaps only; do not create them.",
        "",
        "3. **Verify existing docs.** For each existing doc, check factual claims against the codebase: function signatures, file paths, configuration keys, CLI flags, environment variables. Flag inaccuracies and gaps.",
        "",
        "4. **Summarize.** Report verified docs, inaccuracies found, missing-doc gaps, and fixes that would need a writable follow-up. Do not edit files.",
      ].join("\n")
    : [
        "1. **Detect the doc structure.** Find existing Markdown docs (README, docs/, ADRs, API docs, CONTRIBUTING, etc.) and any doc tooling (docusaurus, vitepress, mkdocs, storybook). Detect project type (monorepo, cli-tool, saas, open-source-library, generic) from manifests and routes.",
        "",
        "2. **Assemble a work manifest.** List every doc item to touch: canonical doc types the project is missing, and existing hand-written docs to review for accuracy. Track each item so nothing is lost between steps.",
        "",
        "3. **Write missing canonical docs.** For the detected project type, create the docs that should exist (e.g. README, CONTRIBUTING, ARCHITECTURE, API reference, CHANGELOG). Ground every claim in the live code.",
        "",
        "4. **Verify existing docs.** For each existing doc, check factual claims against the codebase: function signatures, file paths, configuration keys, CLI flags, environment variables. Flag inaccuracies and gaps.",
        "",
        "5. **Fix loop (bounded).** Correct verified inaccuracies directly. Do not rewrite docs wholesale — fix the specific wrong claims.",
        "",
        "6. **Summarize.** Report: docs created, docs updated, inaccuracies fixed, gaps that need a human decision.",
      ].join("\n");
  const docsSuccessCriteria = verifyOnly
    ? [
        "- Every existing doc claim that references code (paths, signatures, flags, env vars) is checked against the live codebase.",
        "- Missing docs and inaccuracies are reported as findings only.",
        "- No documentation files are created, edited, renamed, or deleted.",
        "- No work item from the manifest is silently dropped.",
      ].join("\n")
    : [
        "- Every doc claim that references code (paths, signatures, flags, env vars) is verified against the live codebase.",
        "- New docs match the project's detected type and existing style.",
        "- Fixes are surgical, not rewrites.",
        "- No work item from the manifest is silently dropped.",
      ].join("\n");
  dispatchPrompt(
    {
      prompt: "docs-update",
      customType: "gsd-docs-update",
      verb: "Docs update",
      vars: { mode, process: docsProcess, successCriteria: docsSuccessCriteria },
    },
    ctx,
    pi,
  );
}

/** /gsd graphify [build|query <term>|status|diff] — knowledge graph. */
export async function handleGraphify(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const basePath = currentDirectoryRoot();
  const knowledgeDir = join(basePath, ".gsd", "knowledge");
  if (!existsSync(knowledgeDir)) mkdirSync(knowledgeDir, { recursive: true });
  const action = args.trim() || "build";
  dispatchPrompt(
    { prompt: "graphify", customType: "gsd-graphify", verb: "Graphify", vars: { action } },
    ctx,
    pi,
  );
}

/** /gsd stats — project statistics. */
export async function handleStats(_args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  dispatchPrompt(
    { prompt: "stats", customType: "gsd-stats", verb: "Stats" },
    ctx,
    pi,
  );
}

/**
 * Resolve the progress mode from flags. Exported for unit testing.
 */
export function parseProgressMode(args: string): string {
  if (/(?:^|\s)--forensic(?=\s|$)/.test(args)) return "forensic";
  const doMatch = args.match(/--do\s+"([^"]*)"/);
  if (doMatch) return `do: ${doMatch[1]}`;
  if (/(?:^|\s)--next(?=\s|$)/.test(args)) return "next";
  return "default";
}

/** /gsd progress [--forensic|--next|--do "..."] — situational awareness. */
export async function handleProgress(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (/(?:^|\s)--next(?=\s|$)/.test(args)) {
    await dispatchGSDCommand("next", ctx, pi);
    return;
  }
  const doMatch = args.match(/--do\s+"([^"]*)"/);
  if (doMatch) {
    // Re-dispatch as a quick task so the task actually runs.
    // `quick` is not in either blocked-command set, so the re-dispatch passes guards cleanly.
    await dispatchGSDCommand(`quick ${doMatch[1]}`, ctx, pi);
    return;
  }
  const mode = parseProgressMode(args);
  dispatchPrompt(
    { prompt: "progress", customType: "gsd-progress", verb: "Progress", vars: { mode } },
    ctx,
    pi,
  );
}

/** /gsd health [--repair] [--context] — .gsd/ integrity check. */
export async function handleHealth(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const repair = /(^|\s)--repair(?=\s|$)/.test(args);
  const contextMode = /(^|\s)--context(?=\s|$)/.test(args);
  dispatchPrompt(
    {
      prompt: "health",
      customType: "gsd-health",
      verb: "Health check",
      vars: {
        repairFlag: flagPhrase(repair),
        contextFlag: flagPhrase(contextMode),
      },
    },
    ctx,
    pi,
  );
}

/** /gsd surface [list|status|profile <name>|disable <cluster>|enable <cluster>|reset] */
export async function handleSurface(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const action = args.trim() || "status";
  dispatchPrompt(
    { prompt: "surface", customType: "gsd-surface", verb: "Surface", vars: { action } },
    ctx,
    pi,
  );
}

// ─── Batch 3: review / audit ─────────────────────────────────────────────────

/**
 * Extract a comma-separated value list for a `--flag value1,value2` option.
 * Exported for unit testing.
 */
export function parseListFlag(args: string, flag: string): string {
  const re = new RegExp(`(?:^|\\s)${flag}\\s+([^\\s]+)`, "i");
  const m = args.match(re);
  return m ? m[1] : "";
}

/**
 * Determine the review id (zero-padded) for the next review artifact under
 * `.gsd/reviews/`. Exported for unit testing.
 */
export function nextReviewId(reviewsDir: string): string {
  return nextArtifactId(reviewsDir);
}

/** /gsd code-review [target] [--depth quick|standard|deep] [--files ...] [--fix] */
export async function handleCodeReview(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const depthMatch = args.match(/--depth\s+(quick|standard|deep)/i);
  const depth = depthMatch ? depthMatch[1].toLowerCase() : "standard";
  const files = parseListFlag(args, "--files");
  const fix = /(?:^|\s)--fix(?=\s|$)/.test(args);
  const scope = files
    ? `Explicit files: ${files}`
    : "Changed source files for the active slice (derived from recent commits / SUMMARY), excluding .gsd/, lockfiles, generated, and docs.";
  const basePath = currentDirectoryRoot();
  const reviewsDir = join(basePath, ".gsd", "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  const reviewId = nextReviewId(reviewsDir);
  dispatchPrompt(
    {
      prompt: "code-review",
      customType: "gsd-code-review",
      verb: "Code review",
      vars: {
        scope,
        depth,
        fixMode: flagPhrase(fix),
        reviewId,
      },
    },
    ctx,
    pi,
  );
}

const REVIEWER_FLAGS = ["--gemini", "--claude", "--codex", "--opencode", "--qwen", "--cursor", "--agy", "--all"];

/** /gsd review [--milestone Mxxx] [--claude] [--codex] ... [--all] */
export async function handleReview(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const milestoneMatch = args.match(/--milestone\s+(\S+)/i);
  const target = milestoneMatch ? `Milestone ${milestoneMatch[1]}` : "Active slice (plan + recent execution)";
  const requested = REVIEWER_FLAGS.filter((f) => new RegExp(`(?:^|\\s)${f}(?=\\s|$)`).test(args));
  const reviewers = requested.length ? requested.map((f) => f.slice(2)).join(", ") : "default (single internal reviewer)";
  dispatchPrompt(
    {
      prompt: "review",
      customType: "gsd-review",
      verb: "Review",
      vars: { target, reviewers },
    },
    ctx,
    pi,
  );
}

/** /gsd audit-milestone [Mxxx] */
export async function handleAuditMilestone(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const id = args.trim();
  const target = id ? `Milestone ${id}` : "Active or most-recently-completed milestone";
  dispatchPrompt(
    { prompt: "audit-milestone", customType: "gsd-audit-milestone", verb: "Audit milestone", vars: { target } },
    ctx,
    pi,
  );
}

/** /gsd audit-uat [--verify] */
export async function handleAuditUat(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const verify = /(?:^|\s)--verify(?=\s|$)/.test(args);
  dispatchPrompt(
    {
      prompt: "audit-uat",
      customType: "gsd-audit-uat",
      verb: "Audit UAT",
      vars: { verifyMode: flagPhrase(verify) },
    },
    ctx,
    pi,
  );
}

/** /gsd audit-fix [--source <audit>] [--severity medium|high|all] [--max N] [--dry-run] */
export async function handleAuditFix(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const sourceMatch = args.match(/--source\s+(\S+)/i);
  const sevMatch = args.match(/--severity\s+(medium|high|all)/i);
  const maxMatch = args.match(/--max\s+(\d+)/);
  const dryRun = /(?:^|\s)--dry-run(?=\s|$)/.test(args);
  dispatchPrompt(
    {
      prompt: "audit-fix",
      customType: "gsd-audit-fix",
      verb: "Audit-fix",
      vars: {
        source: sourceMatch ? sourceMatch[1] : "most recent audit-uat / scan findings",
        severity: sevMatch ? sevMatch[1] : "all",
        maxFixes: maxMatch ? maxMatch[1] : "(no cap)",
        dryRun: flagPhrase(dryRun),
      },
    },
    ctx,
    pi,
  );
}

/** /gsd ui-review [target] */
export async function handleUiReview(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = args.trim() || "Implemented frontend for the active milestone/slice";
  const basePath = currentDirectoryRoot();
  const reviewsDir = join(basePath, ".gsd", "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  const reviewId = nextReviewId(reviewsDir);
  dispatchPrompt(
    { prompt: "ui-review", customType: "gsd-ui-review", verb: "UI review", vars: { target, reviewId } },
    ctx,
    pi,
  );
}

/** /gsd secure-phase [target] */
export async function handleSecurePhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = args.trim() || "Active milestone/slice";
  dispatchPrompt(
    { prompt: "secure-phase", customType: "gsd-secure-phase", verb: "Security audit", vars: { target } },
    ctx,
    pi,
  );
}

/** /gsd validate-phase [target] */
export async function handleValidatePhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = args.trim() || "Active milestone/slice";
  dispatchPrompt(
    { prompt: "validate-phase", customType: "gsd-validate-phase", verb: "Validation audit", vars: { target } },
    ctx,
    pi,
  );
}

/** /gsd verify-work [target] */
export async function handleVerifyWork(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = args.trim() || "Active milestone/slice";
  dispatchPrompt(
    { prompt: "verify-work", customType: "gsd-verify-work", verb: "Verify work (UAT)", vars: { target } },
    ctx,
    pi,
  );
}

/**
 * Resolve the effective plan-review-convergence cycle cap for one invocation:
 * `--max-cycles N` flag > `plan_review.max_cycles` config > default (CONV-02).
 * This is the ONLY expression of that precedence chain — nowhere else in the
 * feature re-resolves or re-hardcodes the cap (RESEARCH.md Pitfall 4).
 *
 * A matched flag is parsed digits-only (mirroring `handleAuditFix`'s
 * `--max`/`--severity` regex style), rounded, then clamped against the
 * shared `PLAN_REVIEW_MAX_CYCLES_BOUNDS` record imported from
 * `preferences-validation.ts` — the same bounds the config resolver itself
 * clamps against, so this feature has exactly one range and one default. An
 * unmatched flag, or a match that somehow yields a non-finite number, falls
 * through to `resolvePlanReviewMaxCycles(basePath)`, which already clamps
 * and already defaults — this function never restates that default itself.
 *
 * Exported so `commands-gsd-core.test.ts` can exercise the precedence chain
 * directly, in addition to through `handlePlanReviewConvergence`.
 */
export function resolveEffectivePlanReviewMaxCycles(args: string, basePath?: string): number {
  const maxMatch = args.match(/--max-cycles\s+(\d+)/);
  if (maxMatch) {
    const parsed = Math.round(Number(maxMatch[1]));
    if (Number.isFinite(parsed)) {
      return Math.max(
        PLAN_REVIEW_MAX_CYCLES_BOUNDS.min,
        Math.min(PLAN_REVIEW_MAX_CYCLES_BOUNDS.max, parsed),
      );
    }
  }
  return resolvePlanReviewMaxCycles(basePath);
}

/**
 * /gsd plan-review-convergence [--milestone Mxxx] [--claude] [--codex] ... [--max-cycles N]
 *
 * Rewritten for CONV-01 (Phase 20): this handler resolves the target and the
 * effective cycle cap, persists a durable cycle-1 row, and dispatches ONE
 * review turn. It does not itself loop — the reactive decide-and-redispatch
 * driver in `plan-review-convergence.ts` (wired into `handleAgentEnd`) reads
 * the CYCLE_SUMMARY that turn writes and decides converged/reround/cap-hit
 * host-side (D-01/D-02), never inside one self-driving simulated-loop prompt.
 *
 * Rewritten again for CONV-02 (Phase 20-04): the cap is now resolved via
 * `resolveEffectivePlanReviewMaxCycles` (flag > config > default) instead of
 * a bare flag-vs-hardcoded-`3` fallback, and persisted onto the cycle-1 row
 * exactly as before — nothing downstream re-resolves it (see
 * `plan-review-convergence.ts`'s enforcement comparison, which reads the
 * row's `max_cycles` column, never a fresh resolve).
 */
export async function handlePlanReviewConvergence(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const milestoneMatch = args.match(/--milestone\s+(\S+)/i);
  const requested = REVIEWER_FLAGS.filter((f) => new RegExp(`(?:^|\\s)${f}(?=\\s|$)`).test(args));
  const reviewers = requested.length ? requested.map((f) => f.slice(2)).join(", ") : "default (single internal reviewer)";

  const basePath = currentDirectoryRoot();

  // Resolve the effective cap ONCE (flag > config > default) and clamp
  // before it is ever persisted or compared (RESEARCH.md Security Domain
  // V5 / T-20-01).
  const effectiveCap = resolveEffectivePlanReviewMaxCycles(args, basePath);

  const activeMilestone = getActiveMilestoneFromDb();
  const milestoneId = milestoneMatch ? milestoneMatch[1] : activeMilestone?.id;
  if (!milestoneId) {
    ctx.ui.notify("No active milestone found — cannot start plan-review convergence.", "error");
    return;
  }
  const target = milestoneMatch ? `Milestone ${milestoneMatch[1]}` : "Active slice/milestone plan";
  const slice = getActiveSliceFromDb(milestoneId);
  const sliceId = slice?.id ?? "";

  const cycle = 1;
  const artifactDir = join(basePath, ".gsd", "plan-review");
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, planReviewCycleSummaryFileName(target, cycle));

  savePlanReviewCycle({ milestoneId, sliceId, cycle, maxCycles: effectiveCap, artifactPath });

  dispatchPrompt(
    {
      prompt: "plan-review-convergence-review",
      customType: "gsd-plan-review-convergence-review",
      verb: "Plan convergence",
      vars: {
        target,
        reviewers,
        maxCycles: String(effectiveCap),
        cycle: String(cycle),
        summaryPath: artifactPath,
      },
    },
    ctx,
    pi,
  );
}

// ─── Batch 4: workflow phases ────────────────────────────────────────────────

/** Resolve a milestone/slice target from --milestone/--slice flags. */
function resolveMsTarget(args: string, fallback: string): string {
  const m = args.match(/--milestone\s+(\S+)/i);
  if (m) return `Milestone ${m[1]}`;
  const s = args.match(/--slice\s+(\S+)/i);
  if (s) return `Slice ${s[1]}`;
  return fallback;
}

/** /gsd discuss-phase [--milestone Mxxx] [--auto] [--text] */
export async function handleDiscussPhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = resolveMsTarget(args, "Active milestone/slice");
  dispatchPrompt(
    {
      prompt: "discuss-phase",
      customType: "gsd-discuss-phase",
      verb: "Discuss phase",
      vars: {
        target,
        autoFlag: flagPhrase(/(?:^|\s)--auto(?=\s|$)/.test(args)),
        textFlag: flagPhrase(parseCoreFlags(args).textMode),
      },
    },
    ctx,
    pi,
  );
}

/** /gsd plan-phase [--milestone Mxxx] [--auto] [--research|--skip-research] [--tdd] */
export async function handlePlanPhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = resolveMsTarget(args, "Active milestone/slice");
  const research = /(?:^|\s)--research(?=\s|$)/.test(args);
  const skipResearch = /(?:^|\s)--skip-research(?=\s|$)/.test(args);
  const researchFlag = skipResearch ? "skip-research" : research ? "research" : "off";
  dispatchPrompt(
    {
      prompt: "plan-phase",
      customType: "gsd-plan-phase",
      verb: "Plan phase",
      vars: {
        target,
        autoFlag: flagPhrase(/(?:^|\s)--auto(?=\s|$)/.test(args)),
        researchFlag,
        tddFlag: flagPhrase(/(?:^|\s)--tdd(?=\s|$)/.test(args)),
      },
    },
    ctx,
    pi,
  );
}

/** /gsd execute-phase [--milestone Mxxx] [--wave N] [--gaps-only] [--interactive] [--tdd] */
export async function handleExecutePhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = resolveMsTarget(args, "Active milestone/slice");
  const waveMatch = args.match(/--wave\s+(\d+)/);
  dispatchPrompt(
    {
      prompt: "execute-phase",
      customType: "gsd-execute-phase",
      verb: "Execute phase",
      vars: {
        target,
        waveFlag: waveMatch ? waveMatch[1] : "(sequential)",
        gapsOnlyFlag: flagPhrase(/(?:^|\s)--gaps-only(?=\s|$)/.test(args)),
        interactiveFlag: flagPhrase(/(?:^|\s)--interactive(?=\s|$)/.test(args)),
        tddFlag: flagPhrase(/(?:^|\s)--tdd(?=\s|$)/.test(args)),
      },
    },
    ctx,
    pi,
  );
}

/** /gsd spec-phase [--milestone Mxxx] [--auto] [--text] */
export async function handleSpecPhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = resolveMsTarget(args, "Active milestone/slice");
  dispatchPrompt(
    {
      prompt: "spec-phase",
      customType: "gsd-spec-phase",
      verb: "Spec phase",
      vars: {
        target,
        autoFlag: flagPhrase(/(?:^|\s)--auto(?=\s|$)/.test(args)),
        textFlag: flagPhrase(parseCoreFlags(args).textMode),
      },
    },
    ctx,
    pi,
  );
}

/** /gsd mvp-phase [--milestone Mxxx] */
export async function handleMvpPhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = resolveMsTarget(args, "Active milestone");
  dispatchPrompt(
    { prompt: "mvp-phase", customType: "gsd-mvp-phase", verb: "MVP phase", vars: { target } },
    ctx,
    pi,
  );
}

/** /gsd ui-phase [--milestone Mxxx] */
export async function handleUiPhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = resolveMsTarget(args, "Active frontend milestone/slice");
  dispatchPrompt(
    { prompt: "ui-phase", customType: "gsd-ui-phase", verb: "UI phase", vars: { target } },
    ctx,
    pi,
  );
}

/** /gsd ai-integration-phase [--milestone Mxxx] */
export async function handleAiIntegrationPhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = resolveMsTarget(args, "Active AI milestone/slice");
  dispatchPrompt(
    { prompt: "ai-integration-phase", customType: "gsd-ai-integration-phase", verb: "AI integration phase", vars: { target } },
    ctx,
    pi,
  );
}

/** /gsd ultraplan-phase [--milestone Mxxx] */
export async function handleUltraplanPhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const target = resolveMsTarget(args, "Active milestone/slice");
  dispatchPrompt(
    { prompt: "ultraplan-phase", customType: "gsd-ultraplan-phase", verb: "Ultraplan phase", vars: { target } },
    ctx,
    pi,
  );
}

/**
 * Parse autonomous scope flags (--from/--to/--only) into today's exact prose.
 * Exported for unit testing. Now a projection of the structured
 * `AutonomousScope` value (`autonomous-scope.js`) rather than the source of
 * truth -- `describeAutonomousScope(parseAutonomousScopeFlags(args))` keeps
 * this function's exported name/signature and output string unchanged for
 * existing callers (the `gsd-autonomous` prompt template's `scope` variable,
 * this file's own unit tests) while the structured value now backs
 * mechanical enforcement (D-02, ROADMAP SC2).
 */
export function parseAutonomousScope(args: string): string {
  return describeAutonomousScope(parseAutonomousScopeFlags(args));
}

/**
 * Record the durable `--from N` pointer (D-02) as a `running` row before
 * dispatching the prompt. Never throws or blocks dispatch -- a run-log
 * write failure is a diagnostics gap, not a reason to refuse to run,
 * mirroring `src/headless-run-log.ts`'s never-throws host wrapper
 * philosophy.
 */
function startMilestoneRunLogEntry(
  basePath: string,
  milestoneId: string,
  scope: AutonomousScope,
  detection: ActiveMilestoneRunDetection,
): void {
  try {
    // Any non-active detection may still leave a leftover `running` row
    // behind (a dead lock owner, or no lock at all) that would collide with
    // the fresh insert below via idx_milestone_run_log_one_active --
    // failStaleMilestoneRunLogRow no-ops when there is nothing to clean up.
    failStaleMilestoneRunLogRow(milestoneId, detection.pid);
    const runId = randomUUID();
    recordMilestoneRunLifecycle({
      invocation: internalExecutionInvocation(`autonomous-start:${milestoneId}:${runId}`),
      milestoneId,
      runId,
      attempt: 1,
      status: "running",
      resumeFrom: scope.from,
    });
    renderMilestoneRunLog(basePath);
  } catch {
    // Non-fatal: see docstring above.
  }
}

/** /gsd autonomous [--from N] [--to N] [--only N] [--interactive] [--converge] */
export async function handleAutonomous(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const basePath = currentDirectoryRoot();
  const milestoneId = await getActiveMilestoneId(basePath);

  let scope: AutonomousScope;
  try {
    // Durable re-read (D-02): with no explicit flag, the effective scope
    // resolves from the active milestone's own run-log row rather than
    // defaulting to "all remaining work" -- the resume point survives the
    // process that set it. An explicit flag always overrides the stored
    // pointer.
    const priorRun = milestoneId ? getActiveMilestoneRun(milestoneId) : null;
    scope = resolveEffectiveAutonomousScope(
      args,
      priorRun ? { resumeFrom: priorRun.resumeFrom } : null,
    );
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    return;
  }

  if (milestoneId) {
    const detection = detectActiveMilestoneRun(basePath, milestoneId);
    if (detection.active) {
      ctx.ui.notify(
        `Milestone ${milestoneId} already has a live autonomous run (PID ${detection.pid}). `
          + "Run `/gsd stop` first, or wait for it to finish before starting another.",
        "warning",
      );
      return;
    }

    // CR-02: a non-active detection is only safe to act on when the reason
    // is a CONCLUSIVE proof that nothing is running. An ambiguous "I could
    // not tell" reason (a transient DB/lock read failure) must refuse
    // rather than silently treating "unknown" as "safe to force-restart" --
    // the other process may still be alive and still holds the lock.
    if (!isConclusiveNotActiveReason(detection.reason)) {
      ctx.ui.notify(
        `Could not confirm milestone ${milestoneId} has no live autonomous run `
          + `(${detection.reason ?? "unknown"}). Try again.`,
        "warning",
      );
      return;
    }

    // Mechanical dispatch-path enforcement (D-02, must_haves): `--only N`
    // names the SOLE unit this run may touch. When the active milestone's
    // own ordinal does not match, there is nothing valid for this dispatch
    // to do -- refuse outright rather than handing the model a sentence and
    // hoping it infers the same thing. `--from`/`--to` scope work WITHIN a
    // milestone (a phase/slice position this command does not resolve), so
    // they are not checked against the milestone's own ordinal here.
    if (scope.only !== null) {
      const ordinal = deriveMilestoneOrdinal(milestoneId);
      if (ordinal !== null && !isUnitInAutonomousScope(ordinal, scope)) {
        ctx.ui.notify(
          `Milestone ${milestoneId} (unit ${ordinal}) does not match the requested scope `
            + `(${describeAutonomousScope(scope)}) -- refusing to dispatch.`,
          "warning",
        );
        return;
      }
    }

    startMilestoneRunLogEntry(basePath, milestoneId, scope, detection);
  }

  // Mechanical slice-scope enforcement (ROADMAP SC2 fix spec): stash the
  // effective scope on the shared AutoSession singleton so the per-slice
  // dispatch gate in decideOrchestratorDispatch (auto/orchestrator.ts) can
  // consult it once the model invokes `/gsd auto` -- that command parses no
  // scope flags of its own, so this in-process handoff (plus the durable
  // resume_from fallback for a restarted process) is the only channel
  // `--from`/`--to`/`--only` have to reach the mechanical loop.
  autoSession.autonomousScope = scope;

  dispatchPrompt(
    {
      prompt: "autonomous",
      customType: "gsd-autonomous",
      verb: "Autonomous",
      vars: {
        scope: describeAutonomousScope(scope),
        interactiveFlag: flagPhrase(/(?:^|\s)--interactive(?=\s|$)/.test(args)),
        convergeFlag: flagPhrase(/(?:^|\s)--converge(?=\s|$)/.test(args)),
      },
    },
    ctx,
    pi,
  );
}

/** /gsd pause-work [--report] */
export async function handlePauseWork(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  deps: PauseHandoffDeps = {},
): Promise<void> {
  // HANDOFF-01 (D-01/D-03): register the handoff mechanically, in code, before the prompt is
  // dispatched. Fail-open (D-09): a registration problem never blocks the pause-work prompt.
  try {
    const { registerPauseHandoff } = await import("./handoff-lifecycle.js");
    await registerPauseHandoff(ctx, "pause-work", deps);
  } catch {
    /* fail-open */
  }
  dispatchPrompt(
    {
      prompt: "pause-work",
      customType: "gsd-pause-work",
      verb: "Pause work",
      vars: { reportFlag: flagPhrase(/(?:^|\s)--report(?=\s|$)/.test(args)) },
    },
    ctx,
    pi,
  );
}

/** Injectable seams for /gsd resume-work (tests); production uses the real CLI and dispatcher. */
export interface ResumeWorkDeps {
  run?: HandoffRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  dispatchCommand?: (command: string) => Promise<void>;
}

/**
 * /gsd resume-work [<handoff-id>]
 *
 * HANDOFF-01 SC3: takes this project's own yahir-handoff by its stored id (never at
 * session_start, never id-less) and resumes from it. Fail-open (D-09): whatever happens with the
 * handoff, the resume-work prompt is still dispatched exactly once when nothing else resumed.
 */
export async function handleResumeWork(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  deps: ResumeWorkDeps = {},
): Promise<void> {
  let promptDispatched = false;
  const sendPrompt = (handoffContext: string): boolean => {
    promptDispatched = true;
    return dispatchPrompt(
      { prompt: "resume-work", customType: "gsd-resume-work", verb: "Resume work", vars: { handoffContext } },
      ctx,
      pi,
    );
  };
  try {
    const resume = await import("./handoff-resume.js");
    const parsed = resume.parseResumeArgs(args);
    if (!parsed.ok) {
      ctx.ui.notify(parsed.message, "error");
      promptDispatched = true;
      return;
    }

    let basePath: string | null = null;
    try {
      basePath = projectRoot();
    } catch {
      basePath = null;
    }
    if (basePath === null) {
      sendPrompt(resume.formatNoHandoffContext());
      return;
    }
    try {
      const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
      await ensureDbOpen(basePath);
    } catch {
      /* a closed DB just means no stored record is readable */
    }
    const rawSessionId = (ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager?.getSessionId?.();
    const sessionId = typeof rawSessionId === "string" && rawSessionId !== "" ? rawSessionId : null;
    const callOpts = { cwd: basePath, sessionId, run: deps.run, env: deps.env, timeoutMs: deps.timeoutMs };

    const decision = await resume.resolveResumeHandoff(parsed.id, callOpts);
    const closeOpts = {
      sessionId,
      run: deps.run,
      env: deps.env,
      timeoutMs: deps.timeoutMs,
      onWarning: (m: string) => ctx.ui.notify(m, "warning"),
    };

    if (decision.kind === "refused") {
      ctx.ui.notify(decision.message, "warning");
      promptDispatched = true;
      return;
    }

    if (decision.kind === "own" || decision.kind === "own-stale" || decision.kind === "own-unavailable") {
      if (decision.kind === "own" && decision.warning) ctx.ui.notify(decision.warning, "warning");
      if (decision.kind === "own-unavailable") ctx.ui.notify(decision.warning, "warning");
      if (decision.kind === "own-stale") {
        ctx.ui.notify(`handoff ${decision.id} was already ${decision.state}; resuming from project state`, "info");
      }

      let paused: { stepMode?: boolean } | null = null;
      try {
        const { readPausedSessionMetadata } = await import("./interrupted-session.js");
        paused = readPausedSessionMetadata(basePath);
      } catch {
        paused = null;
      }

      if (paused !== null) {
        // DP-1: a paused session re-enters auto mechanically (no triggerTurn prompt racing
        // startAutoDetached); the handoff is closed by resume activation (45-04), which
        // requires the record to be linked to the paused session.
        if (decision.kind === "own") {
          const { readStoredHandoff, writeStoredHandoff } = await import("./handoff-record.js");
          const record = readStoredHandoff();
          if (record && !record.hadPausedSession) writeStoredHandoff({ ...record, hadPausedSession: true });
        }
        ctx.ui.notify(
          decision.kind === "own" ? resume.summarizeHandoffForNotify(decision.entry) : "Resuming the paused session.",
          "info",
        );
        promptDispatched = true;
        const command = paused.stepMode ? "next" : "auto";
        try {
          await (deps.dispatchCommand ?? ((c: string) => dispatchGSDCommand(c, ctx, pi)))(command);
        } catch (err) {
          ctx.ui.notify(`Failed to resume: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      const ok = sendPrompt(
        decision.kind === "own" ? resume.formatOwnHandoffContext(decision.entry) : resume.formatNoHandoffContext(),
      );
      if (ok && decision.kind === "own") {
        const { closeStoredHandoff } = await import("./handoff-record.js");
        await closeStoredHandoff("done", basePath, closeOpts);
      }
      return;
    }
    sendPrompt(resume.formatNoHandoffContext());
  } catch {
    if (!promptDispatched) {
      try {
        dispatchPrompt(
          {
            prompt: "resume-work",
            customType: "gsd-resume-work",
            verb: "Resume work",
            vars: { handoffContext: "No yahir-handoff entry was taken for this resume; rely on .gsd/HANDOFF.md and canonical state." },
          },
          ctx,
          pi,
        );
      } catch {
        /* dispatchPrompt reports its own failures */
      }
    }
  }
}

// ─── Batch 5: project management ─────────────────────────────────────────────

/** /gsd manager [--analyze-deps] */
export async function handleManager(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const vars = await resolveManagerVars(args, ctx);
  dispatchPrompt(
    {
      prompt: "manager",
      customType: "gsd-manager",
      verb: "Manager",
      vars,
    },
    ctx,
    pi,
  );
}

/** /gsd phase [add|insert|remove|edit|list] <target> */
export async function handlePhase(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const action = args.trim() || "list";
  const parsed = splitAction(action);
  if (parsed.action === "list" || parsed.action === "status") {
    await dispatchGSDCommand("queue", ctx, pi);
    return;
  }
  if (["add", "create", "new"].includes(parsed.action) && !parsed.rest) {
    await dispatchGSDCommand("new-milestone", ctx, pi);
    return;
  }
  dispatchPrompt(
    { prompt: "phase", customType: "gsd-phase", verb: "Phase", vars: { action } },
    ctx,
    pi,
  );
}

/** /gsd thread [list|close <slug>|status <slug>|<name>] */
export async function handleThread(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const action = args.trim() || "list";
  dispatchPrompt(
    { prompt: "thread", customType: "gsd-thread", verb: "Thread", vars: { action } },
    ctx,
    pi,
  );
}

/** /gsd workstreams [list|create|switch|progress|pause|resume|complete] [milestone] */
export async function handleWorkstreams(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const action = args.trim() || "list";
  const parsed = splitAction(action);
  let parallelAction = "";
  if (parsed.action === "list" || parsed.action === "status" || parsed.action === "progress") {
    parallelAction = "status";
  } else if (parsed.action === "create") {
    parallelAction = "start";
  } else if (parsed.action === "complete") {
    parallelAction = "merge";
  } else if (parsed.action === "switch") {
    parallelAction = "watch";
  } else if (["start", "stop", "pause", "resume", "merge", "watch"].includes(parsed.action)) {
    parallelAction = parsed.action;
  }
  if (parallelAction) {
    if ((parsed.action === "create" || parsed.action === "start") && parsed.rest) {
      ctx.ui.notify(
        "workstreams create does not accept a milestone target. Run /gsd parallel start to start all eligible milestones.",
        "warning",
      );
      return;
    }
    if (parsed.action === "progress" && parsed.rest) {
      ctx.ui.notify(
        "workstreams progress does not accept a milestone target. Run /gsd parallel status to show worker status.",
        "warning",
      );
      return;
    }
    if (parsed.action === "switch" && parsed.rest) {
      ctx.ui.notify(
        "workstreams switch does not accept a milestone target. Run /gsd parallel watch to monitor workers.",
        "warning",
      );
      return;
    }
    await dispatchGSDCommand(`parallel ${parallelAction} ${parsed.rest}`.trim(), ctx, pi);
    return;
  }
  dispatchPrompt(
    { prompt: "workstreams", customType: "gsd-workstreams", verb: "Workstreams", vars: { action } },
    ctx,
    pi,
  );
}

/** /gsd workspace [--list|--remove|--merge|--clean] [name] */
export async function handleWorkspace(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const action = args.trim() || "--list";
  const parsed = splitAction(action);
  if (parsed.action === "--list" || parsed.action === "list" || parsed.action === "ls") {
    await dispatchGSDCommand("worktree list", ctx, pi);
    return;
  }
  if (parsed.action === "--remove" || parsed.action === "remove" || parsed.action === "rm") {
    await dispatchGSDCommand(`worktree remove ${parsed.rest}`.trim(), ctx, pi);
    return;
  }
  if (parsed.action === "--merge" || parsed.action === "merge") {
    await dispatchGSDCommand(`worktree merge ${parsed.rest}`.trim(), ctx, pi);
    return;
  }
  if (parsed.action === "--clean" || parsed.action === "clean") {
    await dispatchGSDCommand("worktree clean", ctx, pi);
    return;
  }
  if (parsed.action === "--new" || parsed.action === "new" || parsed.action === "create") {
    ctx.ui.notify("Unsupported workspace action. Use /gsd worktree list, remove, merge, or clean.", "warning");
    return;
  }
  dispatchPrompt(
    { prompt: "workspace", customType: "gsd-workspace", verb: "Workspace", vars: { action } },
    ctx,
    pi,
  );
}

/** /gsd milestone-summary [Mxxx] */
export async function handleMilestoneSummary(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const id = args.trim();
  const target = id ? `Milestone ${id}` : "Whole project (all milestones)";
  dispatchPrompt(
    { prompt: "milestone-summary", customType: "gsd-milestone-summary", verb: "Milestone summary", vars: { target } },
    ctx,
    pi,
  );
}

/** /gsd review-backlog */
export async function handleReviewBacklog(_args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  dispatchPrompt(
    { prompt: "review-backlog", customType: "gsd-review-backlog", verb: "Review backlog" },
    ctx,
    pi,
  );
}

/**
 * Parse inbox focus flags. Exported for unit testing.
 */
export function parseInboxFocus(args: string): string {
  const issues = /(?:^|\s)--issues(?=\s|$)/.test(args);
  const prs = /(?:^|\s)--prs(?=\s|$)/.test(args);
  if (issues && prs) return "issues and PRs";
  if (issues) return "issues only";
  if (prs) return "PRs only";
  return "issues and PRs (default)";
}

function parseFlagValue(args: string, flag: string): string | null {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|\\s)${escaped}\\s+` +
      `(?!--)` +
      `(?:"([^"]*)"|'([^']*)'|([^\\s].*?))` +
      `(?=\\s--[\\w-]+|$)`,
  );
  const match = args.match(pattern);
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/** /gsd inbox [--issues|--prs] [--label <name>] [--close-incomplete] [--repo owner/repo] */
export async function handleInbox(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const repo = parseFlagValue(args, "--repo");
  const label = parseFlagValue(args, "--label");
  if (/(?:^|\s)--repo(?=\s|$)/.test(args) && !repo) {
    ctx.ui.notify("--repo requires a value. Example: /gsd inbox --repo owner/repo", "warning");
    return;
  }
  if (/(?:^|\s)--label(?=\s|$)/.test(args) && !label) {
    ctx.ui.notify("--label requires a value. Example: /gsd inbox --label \"help wanted\"", "warning");
    return;
  }
  dispatchPrompt(
    {
      prompt: "inbox",
      customType: "gsd-inbox",
      verb: "Inbox",
      vars: {
        focusFlag: parseInboxFocus(args),
        labelFlag: label ?? "(none)",
        closeIncompleteFlag: flagPhrase(/(?:^|\s)--close-incomplete(?=\s|$)/.test(args)),
        repo: repo ?? "the project's repo",
      },
    },
    ctx,
    pi,
  );
}

/** /gsd import --from <filepath> | --from-gsd2 [--resolve auto|interactive] */
export async function handleImport(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const fromMatch = args.match(/--from\s+(\S+)/);
  const isGsd2 = /(?:^|\s)--from-gsd2(?=\s|$)/.test(args);
  const resolveMatch = args.match(/--resolve\s+(auto|interactive)/i);
  const source = fromMatch
    ? `External plan file: ${fromMatch[1]}`
    : isGsd2
      ? "legacy .planning/ directory (migration source)"
      : "(no source specified — ask for --from <filepath> or --from-gsd2)";
  dispatchPrompt(
    {
      prompt: "import",
      customType: "gsd-import",
      verb: "Import",
      vars: {
        source,
        resolveFlag: resolveMatch ? resolveMatch[1] : "interactive",
      },
    },
    ctx,
    pi,
  );
}

/** /gsd ingest-docs [path] [--mode new|merge] [--manifest <file>] [--resolve auto|interactive] */
export async function handleIngestDocs(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const modeMatch = args.match(/--mode\s+(new|merge)/i);
  const manifestMatch = args.match(/--manifest\s+(\S+)/);
  const resolveMatch = args.match(/--resolve\s+(auto|interactive)/i);
  const flagStripped = args.replace(/--\S+(\s+\S+)?/g, "").trim();
  dispatchPrompt(
    {
      prompt: "ingest-docs",
      customType: "gsd-ingest-docs",
      verb: "Ingest docs",
      vars: {
        path: flagStripped || "(repo root)",
        modeFlag: modeMatch ? modeMatch[1] : "new",
        manifestFlag: manifestMatch ? manifestMatch[1] : "(none — discover all)",
        resolveFlag: resolveMatch ? resolveMatch[1] : "interactive",
      },
    },
    ctx,
    pi,
  );
}

/** /gsd profile-user [--questionnaire] [--refresh] */
export async function handleProfileUser(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  dispatchPrompt(
    {
      prompt: "profile-user",
      customType: "gsd-profile-user",
      verb: "Profile user",
      vars: {
        questionnaireFlag: flagPhrase(/(?:^|\s)--questionnaire(?=\s|$)/.test(args)),
        refreshFlag: flagPhrase(/(?:^|\s)--refresh(?=\s|$)/.test(args)),
      },
    },
    ctx,
    pi,
  );
}

/** /gsd settings */
export async function handleSettings(_args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const { formatConfigText, buildCollectConfigOptions } = await import("./config-overlay.js");
  const { getPreferencesReferencePath } = await import("./prompt-loader.js");
  const configOptions = buildCollectConfigOptions(ctx, projectRoot());
  dispatchPrompt(
    {
      prompt: "settings",
      customType: "gsd-settings",
      verb: "Settings",
      vars: {
        effectiveConfig: formatConfigText(configOptions),
        preferencesReferencePath: getPreferencesReferencePath(),
      },
    },
    ctx,
    pi,
  );
}
