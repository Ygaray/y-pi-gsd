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
 */

export const SELF_UAT_LOG_DIR_RELATIVE = ".gsd/verify-agentic/";
export const SELF_UAT_SUFFIX = "-SELF-UAT.md";
// TODO(Task 2): implement.
export const PATCH_MARKER_PATTERN = /$^/;

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

// TODO(Task 2): implement the four rejection guards ahead of any rendering.
function validateResults(_results: SelfUatCriterionResult[]): void {
  // no-op until Task 2
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
  return slug.length > 0 ? slug : target;
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
