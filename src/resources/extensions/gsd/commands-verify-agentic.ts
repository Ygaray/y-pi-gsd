/**
 * GSD Command — /gsd verify-agentic
 *
 * Dispatches the `agentic-tester` subagent to adversarially verify a target's
 * user-visible behavior against the real running surface (CLI, browser, or
 * Android). This handler builds and injects the dispatch prompt only — the
 * actual subagent spawn happens when the foreground turn calls the
 * `subagent` tool per the prompt's instructions, and the SELF-UAT log write
 * happens inside that spawned child (see `src/resources/skills/agentic-tester/SKILL.md`
 * Step 6). Nothing in this file performs either of those side effects.
 *
 * Structured as exported pure functions (parser, target resolver, prompt
 * builder) plus one thin async handler that wires them together and performs
 * the single side effect (`pi.sendMessage`) — mirroring `commands-eval-review.ts`,
 * not `commands-add-tests.ts`'s single-function shape, per 07-RESEARCH.md's
 * "Primary recommendation".
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { deriveState } from "./state.js";
import { gsdRoot } from "./paths.js";
import { projectRoot } from "./commands/context.js";
import { loadPrompt } from "./prompt-loader.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Supported `--surface` values for `/gsd verify-agentic`. */
export const SURFACES = ["cli", "browser", "android"] as const;

/** A validated `--surface` value. */
export type Surface = (typeof SURFACES)[number];

/** Surface used when `--surface` is omitted. */
export const DEFAULT_SURFACE: Surface = "cli";

/**
 * Driver playbook path for each surface, resolved by the Phase 6 artifacts
 * this slice consumes (`src/resources/skills/agentic-tester/drivers/*.md`).
 */
export const DRIVER_PATHS: Readonly<Record<Surface, string>> = {
  cli: "src/resources/skills/agentic-tester/drivers/cli.md",
  browser: "src/resources/skills/agentic-tester/drivers/browser.md",
  android: "src/resources/skills/agentic-tester/drivers/android.md",
};

/**
 * Validated `<target>` shape. Rejects path separators, newlines, backticks,
 * and markdown heading markers before the value reaches either the
 * filesystem or the dispatch prompt (T-07-04, defense in depth only — the
 * enforcement backstop remains the agent-file `tools:` allowlist).
 */
export const TARGET_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const USAGE = 'Usage: /gsd verify-agentic <target> [--criteria "..."] [--surface cli|browser|android]';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Typed error thrown by {@link parseVerifyAgenticArgs} on argument validation
 * failure. Tests assert on `instanceof VerifyAgenticArgError`, never on
 * message text (mirrors the `EvalReviewArgError` convention).
 */
export class VerifyAgenticArgError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "VerifyAgenticArgError";
  }
}

/** Parsed and validated arguments for the `/gsd verify-agentic` command. */
export interface VerifyAgenticArgs {
  target?: string;
  criteria?: string;
  surface?: Surface;
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

/**
 * Quote-aware tokenizer — copied verbatim in shape from
 * `commands-verdict.ts`'s `tokenize()` (lines 49-57), so `--criteria "two or
 * more words"` survives as one token with its internal spaces preserved.
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    tokens.push(match[1] ?? match[2]);
  }
  return tokens;
}

/**
 * Parse and validate the raw argument string.
 *
 * No silent flag-stripping: any token beginning with `--` that isn't
 * `--criteria`/`--surface`, a flag missing its following value, a
 * `--surface` value outside {@link SURFACES}, a second bare token, or a
 * target failing {@link TARGET_ID_PATTERN} all throw
 * {@link VerifyAgenticArgError} rather than being quietly dropped (T-07-02).
 *
 * Target inference from `.gsd/` state is NOT this function's job — an empty
 * `target` here just means "not supplied"; {@link handleVerifyAgentic} decides
 * whether and how to infer one.
 *
 * @param raw - The argument substring after the subcommand name.
 * @returns A validated {@link VerifyAgenticArgs}. Fields are `undefined` when
 *   not supplied.
 * @throws {VerifyAgenticArgError} per the rules above.
 */
export function parseVerifyAgenticArgs(raw: string): VerifyAgenticArgs {
  const tokens = tokenize(raw);
  const out: VerifyAgenticArgs = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === "--criteria") {
      const next = tokens[++i];
      if (next === undefined) {
        throw new VerifyAgenticArgError(`--criteria requires a value. ${USAGE}`);
      }
      out.criteria = next;
      continue;
    }

    if (token === "--surface") {
      const next = tokens[++i];
      if (next === undefined) {
        throw new VerifyAgenticArgError(`--surface requires a value. ${USAGE}`);
      }
      if (!(SURFACES as readonly string[]).includes(next)) {
        throw new VerifyAgenticArgError(
          `Invalid --surface '${next}'. Must be one of: ${SURFACES.join(", ")}. ${USAGE}`,
        );
      }
      out.surface = next as Surface;
      continue;
    }

    if (token.startsWith("--")) {
      throw new VerifyAgenticArgError(`Unknown flag: ${token}. ${USAGE}`);
    }

    if (out.target !== undefined) {
      throw new VerifyAgenticArgError(`Multiple targets supplied (${out.target}, ${token}). ${USAGE}`);
    }

    if (!TARGET_ID_PATTERN.test(token)) {
      throw new VerifyAgenticArgError(
        `Invalid target '${token}'. Expected pattern ${TARGET_ID_PATTERN}. ${USAGE}`,
      );
    }

    out.target = token;
  }

  return out;
}

// ─── Target resolution ────────────────────────────────────────────────────────

/**
 * Resolve the verification target: the explicit value when supplied,
 * otherwise the newest completed slice under
 * `.gsd/milestones/<milestoneId>/slices/` (mirroring
 * `findLastCompletedSlice()` in `commands-add-tests.ts`).
 *
 * @param basePath - project root.
 * @param milestoneId - active milestone ID (only consulted when `explicit`
 *   is absent).
 * @param explicit - the target the operator supplied, if any.
 * @returns the resolved target ID, or `null` when nothing resolves.
 */
export function resolveTarget(basePath: string, milestoneId: string, explicit?: string): string | null {
  if (explicit) return explicit;

  const slicesDir = join(gsdRoot(basePath), "milestones", milestoneId, "slices");
  if (!existsSync(slicesDir)) return null;

  try {
    const entries = readdirSync(slicesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^S\d+$/.test(e.name))
      .sort((a, b) => {
        // Numeric sort on the slice number, not lexicographic — a raw string
        // sort puts "S9" ahead of "S10" once a milestone has 10+ slices.
        const numA = parseInt(a.name.slice(1), 10);
        const numB = parseInt(b.name.slice(1), 10);
        return numB - numA; // descending — latest first
      });

    for (const entry of entries) {
      const summaryPath = join(slicesDir, entry.name, `${entry.name}-SUMMARY.md`);
      if (existsSync(summaryPath)) return entry.name;
    }
  } catch {
    // non-fatal
  }
  return null;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/** Criteria fallback text used when `--criteria` was not supplied. */
const DEFAULT_CRITERIA_NOTE = "(no explicit criteria supplied — verify every acceptance criterion stated for this target)";

/**
 * Build the dispatch prompt via `loadPrompt("verify-agentic", {...})`.
 *
 * The five non-free template vars (`target`, `criteria`, `surface`,
 * `driverPath`, `workingDirectory`) must exactly match what
 * `prompts/verify-agentic.md` declares — every other `{{var}}` the template
 * could reference comes free from `loadPrompt()` (`skillActivation`, etc.).
 *
 * @param input - resolved target/criteria/surface plus the project root.
 * @returns the fully-formed prompt as a single markdown string.
 */
export function buildVerifyAgenticPrompt(input: {
  target: string;
  criteria?: string;
  surface: Surface;
  basePath: string;
}): string {
  return loadPrompt("verify-agentic", {
    target: input.target,
    // A blank/whitespace-only value (e.g. an explicit `--criteria ""`) is
    // treated the same as "not supplied" -- `??` alone only substitutes on
    // null/undefined and would otherwise let an empty string silently
    // bypass the default-criteria fallback.
    criteria: input.criteria?.trim() ? input.criteria : DEFAULT_CRITERIA_NOTE,
    surface: input.surface,
    driverPath: DRIVER_PATHS[input.surface],
    workingDirectory: input.basePath,
  });
}

// ─── Handler entry ────────────────────────────────────────────────────────────

/**
 * Handle `/gsd verify-agentic <target> [--criteria "..."] [--surface cli|browser|android]`.
 *
 * Workflow:
 *   1. Parse args. `VerifyAgenticArgError` is caught and surfaced as a
 *      `ctx.ui.notify(..., "warning")`, never rethrown.
 *   2. Resolve the target LAZILY — `deriveState()` (a `.gsd/`-state read) is
 *      only invoked when `parsed.target` is absent, so an explicit target
 *      reaches dispatch without touching `.gsd/` state at all. This is what
 *      makes the routing test hermetic in a temp directory with no active
 *      milestone.
 *   3. Default the surface to {@link DEFAULT_SURFACE} when omitted.
 *   4. Build the prompt and dispatch it into the current turn via
 *      `pi.sendMessage(..., {triggerTurn:true})` — the only dispatch vehicle
 *      every existing single-shot `/gsd` command uses; no `ctx.dispatch()`
 *      seam exists in this codebase (D-01).
 *
 * @param args - the substring after `verify-agentic` in the slash command.
 * @param ctx - extension command context (notification surface).
 * @param pi - extension API (LLM dispatch).
 */
export async function handleVerifyAgentic(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  let parsed: VerifyAgenticArgs;
  try {
    parsed = parseVerifyAgenticArgs(args);
  } catch (err) {
    if (err instanceof VerifyAgenticArgError) {
      ctx.ui.notify(err.message, "warning");
      return;
    }
    throw err;
  }

  const basePath = projectRoot();

  let target: string | null;
  if (parsed.target) {
    target = parsed.target;
  } else {
    const state = await deriveState(basePath);
    if (!state.activeMilestone) {
      ctx.ui.notify(
        "No active milestone — start or resume one before running /gsd verify-agentic.",
        "warning",
      );
      return;
    }
    target = resolveTarget(basePath, state.activeMilestone.id);
  }

  if (!target) {
    ctx.ui.notify(
      "No completed slices found. Specify a target: /gsd verify-agentic <target>",
      "warning",
    );
    return;
  }

  const surface = parsed.surface ?? DEFAULT_SURFACE;

  ctx.ui.notify(`Dispatching agentic-tester for ${target} on the ${surface} surface...`, "info");

  try {
    const prompt = buildVerifyAgenticPrompt({
      target,
      criteria: parsed.criteria,
      surface,
      basePath,
    });

    pi.sendMessage(
      { customType: "gsd-verify-agentic", content: prompt, display: false },
      { triggerTurn: true },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to dispatch agentic verification: ${msg}`, "error");
  }
}
