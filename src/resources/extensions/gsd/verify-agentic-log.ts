/**
 * SELF-UAT log formatter for `/gsd verify-agentic`.
 *
 * `src/resources/skills/agentic-tester/SKILL.md` Step 6 is the contract this
 * module implements: the per-criterion block shape, the `.gsd/verify-agentic/`
 * write location, and the `-SELF-UAT.md` filename suffix are all restated here
 * byte-identically from that step. This module performs NO filesystem,
 * network, or process-spawning I/O of its own — the actual write happens
 * inside the spawned `agentic-tester` child, via its own `write` tool, never
 * here. `renderSelfUat` and `selfUatLogFileName` are pure functions: plain
 * data in, a string out.
 *
 * IMPORTANT — this is a contract/reference implementation, not a runtime
 * enforcement mechanism: nothing in the actual `/gsd verify-agentic` dispatch
 * path calls `renderSelfUat` or `selfUatLogFileName`. The spawned
 * `agentic-tester` child's tool surface (`read, bash, write, grep, find, ls,
 * browser_*`) writes the real SELF-UAT log as freeform markdown by following
 * the plain-text template in `SKILL.md` Step 6, not by invoking this module.
 * The four rejection guards below (`validateResults`) are exercised only by
 * this file's own unit tests — they describe what a compliant log looks like
 * and are a reference a future enforcement pass (e.g. a post-write
 * `/gsd verify-agentic --check <path>` step) could call, but today they do
 * not reject anything the agent actually writes. Do not read test coverage
 * of these functions as evidence that a bad real-world log gets rejected.
 */

export const SELF_UAT_LOG_DIR_RELATIVE = ".gsd/verify-agentic/";
export const SELF_UAT_SUFFIX = "-SELF-UAT.md";

/**
 * Matches any patch/diff marker that would let a rendered gap-closure route
 * or root cause read as a ready-to-apply change (D-02). Built from an array
 * of alternation sources so each marker is individually readable and
 * individually testable:
 *   - a fenced code-block opener tagged `diff` or `patch`
 *   - a unified-diff file header line (`+++ `/`--- `)
 *   - a hunk-range line (`@@ `)
 *   - an `Index: ` header line
 */
const PATCH_MARKER_SOURCES = [
  "^```(?:diff|patch)\\b",
  "^(?:\\+\\+\\+|---) ",
  "^@@ ",
  "^Index: ",
];
export const PATCH_MARKER_PATTERN = new RegExp(PATCH_MARKER_SOURCES.join("|"), "im");

/** One evaluated criterion's verdict, evidence, and (for FAIL) diagnosis. */
export interface SelfUatCriterionResult {
  criterion: string;
  verdict: "PASS" | "FAIL";
  evidence: string;
  rootCause?: string;
  gapClosureRoute?: string;
}

/** Run-level metadata rendered into the SELF-UAT log header. */
export interface SelfUatMeta {
  target: string;
  surface: string;
  timestampIso: string;
}

/** Thrown when a result cannot be rendered without violating a rendering guard. */
export class SelfUatRenderError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SelfUatRenderError";
  }
}

/**
 * The four rejection guards, run over every result BEFORE any string
 * building so a single bad entry can never produce a half-rendered
 * document:
 *   1. Evidence guard — every result, regardless of verdict, must carry
 *      structurally non-empty evidence. A verdict with no evidence reads as
 *      authoritative while resting on nothing.
 *   2. Root-cause presence guard — a FAIL must carry a structurally
 *      non-empty root cause.
 *   3. Rubber-stamp guard — a FAIL's root cause may not merely restate its
 *      criterion (SKILL.md Step 5's named unacceptable shape).
 *   4. Prose-only guard — neither rootCause nor gapClosureRoute may match
 *      {@link PATCH_MARKER_PATTERN} (D-02): the route is a pointer and a
 *      diagnosis, never a ready-to-apply change.
 */
function validateResults(results: SelfUatCriterionResult[]): void {
  for (const result of results) {
    const evidence = result.evidence ?? "";
    if (evidence.trim().length === 0) {
      throw new SelfUatRenderError(
        `renderSelfUat: result for "${result.criterion}" has empty evidence — a verdict with no evidence cannot render`,
      );
    }

    if (result.verdict === "FAIL") {
      const rootCause = result.rootCause ?? "";
      const trimmedRootCause = rootCause.trim();
      if (trimmedRootCause.length === 0) {
        throw new SelfUatRenderError(
          `renderSelfUat: FAIL for "${result.criterion}" has no root cause — a FAIL cannot render without one`,
        );
      }
      if (trimmedRootCause.toLowerCase() === result.criterion.trim().toLowerCase()) {
        throw new SelfUatRenderError(
          `renderSelfUat: FAIL for "${result.criterion}" has a root cause that merely restates the criterion`,
        );
      }
    }

    if (result.rootCause && PATCH_MARKER_PATTERN.test(result.rootCause)) {
      throw new SelfUatRenderError(
        `renderSelfUat: root cause for "${result.criterion}" contains a patch/diff marker — the route must stay prose-only`,
      );
    }
    if (result.gapClosureRoute && PATCH_MARKER_PATTERN.test(result.gapClosureRoute)) {
      throw new SelfUatRenderError(
        `renderSelfUat: gap-closure route for "${result.criterion}" contains a patch/diff marker — the route must stay prose-only`,
      );
    }
  }
}

/**
 * Render the SELF-UAT log document for a completed verification run.
 *
 * Pure function: takes plain data, returns a markdown string. Performs no
 * filesystem, network, or process-spawning I/O — the actual write happens
 * inside the spawned `agentic-tester` child, never here (SKILL.md Step 6).
 *
 * Guards (Task 2) run over every result before any string building, so a
 * single bad entry can never produce a half-rendered document.
 */
export function renderSelfUat(
  results: SelfUatCriterionResult[],
  meta: SelfUatMeta,
): string {
  validateResults(results);

  const lines: string[] = [];
  lines.push(`# SELF-UAT — ${meta.target}`);
  lines.push("");
  lines.push(`target: ${meta.target}`);
  lines.push(`surface: ${meta.surface}`);
  lines.push(`timestamp: ${meta.timestampIso}`);
  lines.push(`log location: ${SELF_UAT_LOG_DIR_RELATIVE}`);
  lines.push("");

  if (results.length === 0) {
    lines.push("(no criteria were evaluated)");
    return `${lines.join("\n")}\n`;
  }

  results.forEach((result, index) => {
    const n = index + 1;
    lines.push(`### ${n}. ${result.criterion}`);
    lines.push(`verdict: ${result.verdict}`);
    lines.push(`evidence: ${result.evidence}`);
    if (result.verdict === "FAIL") {
      lines.push(`root_cause: ${result.rootCause}`);
    }
    if (result.gapClosureRoute) {
      lines.push(`gap_closure: ${result.gapClosureRoute}`);
    }
    lines.push("");
  });

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Lowercase-alphanumeric-and-dashes slug used by {@link selfUatLogFileName}. */
function slugifyTarget(target: string): string {
  const slug = target
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Fall back to a fixed literal, never the raw input -- a target composed
  // entirely of non-alphanumeric characters (e.g. "..." or "---") would
  // otherwise produce a "slug" that violates the lowercase-alphanumeric-
  // and-dashes invariant this function guarantees, and could start with a
  // "." in the resulting filename.
  return slug.length > 0 ? slug : "target";
}

/** Strips the fractional-seconds group and replaces colons with dashes. */
function filesystemSafeTimestamp(timestampIso: string): string {
  return timestampIso.replace(/\.\d+/, "").replace(/:/g, "-");
}

/**
 * Compute the SELF-UAT log filename for a given target and ISO timestamp.
 *
 * Produces the colon-free `<slug>-<filesystem-safe-timestamp>-SELF-UAT.md`
 * shape SKILL.md Step 6's own example uses
 * (`cli-2026-09-20T12-00-00Z-SELF-UAT.md`).
 */
export function selfUatLogFileName(target: string, timestampIso: string): string {
  const slug = slugifyTarget(target);
  const safeTimestamp = filesystemSafeTimestamp(timestampIso);
  return `${slug}-${safeTimestamp}${SELF_UAT_SUFFIX}`;
}
