/**
 * SELF-UAT log formatter for `/gsd verify-agentic`.
 *
 * `src/resources/skills/agentic-tester/SKILL.md` Step 6 is the contract this
 * module implements: the per-criterion block shape, the `.gsd/verify-agentic/`
 * write location, and the `-SELF-UAT.md` filename suffix are all restated here
 * byte-identically from that step. This module performs NO filesystem,
 * network, or process-spawning I/O of its own — `renderSelfUat` and
 * `selfUatLogFileName` are pure functions: plain data in, a string out.
 *
 * `src/resources/skills/agentic-tester/write-self-uat.mjs` is the real
 * invoker: for a completed run, the spawned `agentic-tester` child
 * constructs its typed results and invokes that script via its own `bash`
 * tool, which imports and calls `renderSelfUat` (and therefore the guards
 * below) against the actual payload before ever writing the real on-disk
 * log — the write itself happens inside that script, not inside this
 * module. `src/resources/extensions/gsd/tests/write-self-uat-enforcement.test.ts`
 * is the coverage proving this: it spawns a genuine
 * `node --experimental-strip-types` subprocess running that script, never an
 * in-process call to the functions this file exports.
 *
 * This module's `result`/`verdict` frontmatter channel (see
 * {@link SelfUatVerdict}) exists ONLY for a completed run (WR-03). A halted
 * run — SKILL.md Steps 1-3's "Halt persistence" shape — is written directly
 * by the agent's own `write` tool, carries no `verdict` key, and is never
 * rendered or validated by anything in this module.
 */

export const SELF_UAT_LOG_DIR_RELATIVE = ".gsd/verify-agentic/";
export const SELF_UAT_SUFFIX = "-SELF-UAT.md";

/**
 * Closed set of aggregate outcomes `aggregateSelfUat` can derive from a
 * graded `SelfUatCriterionResult[]` (GATE-01). `no_criteria` is distinct
 * from `all_pass` by construction (D-02) — a run that checked nothing can
 * never render as a run where everything passed.
 */
export const SELF_UAT_RESULTS = ["all_pass", "has_fail", "has_partial", "no_criteria"] as const;
export type SelfUatResult = (typeof SELF_UAT_RESULTS)[number];

/** Check whether a string is a valid {@link SelfUatResult} aggregate. */
export function isSelfUatResult(value: string): value is SelfUatResult {
  return (SELF_UAT_RESULTS as readonly string[]).includes(value);
}

/**
 * Closed set of hook-facing verdicts `aggregateSelfUat` can derive. This is
 * the enum Phase 11's blocking gate and Phase 13's Gate-2 ledger route on —
 * for a COMPLETED run only (WR-03). A halted run (SKILL.md's "Halt
 * persistence" shape: a top-level `halted: true` plus a `reason:` block) is
 * written directly by the agent's own `write` tool and carries no `verdict`
 * key at all; nothing in this module renders or validates that shape. A
 * downstream gate consumer MUST treat a missing `verdict` key as fail-closed
 * (i.e. blocking, the same outcome as `needs-rework`), never as pass-through
 * or as evidence the run completed — a halted run is arguably the worst
 * outcome (the surface never became testable), so silently passing it would
 * be worse than misreading a real `needs-rework`.
 *
 * There are now FOUR closed outcomes, not three: `pass` (all_pass),
 * `needs-rework` (has_fail), `needs-attention` (has_partial), and `advisory`
 * (no_criteria only). `advisory` no longer covers `has_partial` (WR-02,
 * resolved) — an all-PARTIAL run gets its own distinct `needs-attention`
 * verdict so a blocking gate consumer routes it through a human-pause path
 * instead of silently clearing.
 */
export const SELF_UAT_VERDICTS = ["pass", "needs-rework", "needs-attention", "advisory"] as const;
export type SelfUatVerdict = (typeof SELF_UAT_VERDICTS)[number];

/** Check whether a string is a valid {@link SelfUatVerdict}. */
export function isSelfUatVerdict(value: string): value is SelfUatVerdict {
  return (SELF_UAT_VERDICTS as readonly string[]).includes(value);
}

/** The aggregate outcome `aggregateSelfUat` derives from graded per-criterion results. */
export interface SelfUatAggregate {
  result: SelfUatResult;
  verdict: SelfUatVerdict;
}

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
  "^[ \\t]*```(?:diff|patch)\\b",
  "^[ \\t]*(?:\\+\\+\\+|---) ",
  "^[ \\t]*@@ ",
  "^[ \\t]*Index: ",
];
export const PATCH_MARKER_PATTERN = new RegExp(PATCH_MARKER_SOURCES.join("|"), "im");

/**
 * Closed, exactly-cased three-literal accept-set for the per-criterion
 * verdict (GATE-01). Exported as the single source of truth so
 * `write-self-uat.mjs`'s real-write-path validation imports this array
 * rather than independently redeclaring the same literal set (IN-01) — a
 * future addition (e.g. a `SKIP` verdict) now only needs to change here.
 */
export const SELF_UAT_CRITERION_VERDICTS = ["PASS", "FAIL", "PARTIAL"] as const;
export type SelfUatCriterionVerdict = (typeof SELF_UAT_CRITERION_VERDICTS)[number];

/** One evaluated criterion's verdict, evidence, and (for FAIL) diagnosis. */
export interface SelfUatCriterionResult {
  criterion: string;
  verdict: SelfUatCriterionVerdict;
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
 * Generic, non-diagnostic root-cause phrasing the rubber-stamp guard rejects
 * even when it does not literally restate the criterion (WR-01). SKILL.md
 * Step 5 names this exact shape as unacceptable ("a root cause that merely
 * restates the criterion (e.g. 'criterion failed' or 'the button did not
 * work as expected')") — the literal-equality check alone does not catch the
 * second named example, since it is rarely equal to the criterion string
 * itself. Matched as a case-insensitive substring so a real diagnosis that
 * happens to also name a broken component (e.g. "the button did not work as
 * expected: onClick threw TypeError") is unaffected by design — this list is
 * for phrasing that carries NO diagnostic content on its own, not a ban on a
 * phrase ever appearing.
 */
const GENERIC_ROOT_CAUSE_PHRASES = [
  "criterion failed",
  "did not work as expected",
  "didn't work as expected",
  "failed as expected",
  "not working as expected",
  "test failed",
] as const;

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
 *      criterion, verbatim or via one of the generic non-diagnostic phrases
 *      SKILL.md Step 5 names by example (WR-01), such as "did not work as
 *      expected".
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

    // PARTIAL is deliberately excluded from the root-cause-presence and
    // rubber-stamp guards below (GATE-01) — following uat-policy.ts's
    // precedent, PARTIAL is an aggregate-level concept here, not a
    // per-criterion root-cause trigger. It remains subject to the
    // verdict-agnostic evidence guard above and the prose-only guard below.
    if (result.verdict === "FAIL") {
      const rootCause = result.rootCause ?? "";
      const trimmedRootCause = rootCause.trim();
      if (trimmedRootCause.length === 0) {
        throw new SelfUatRenderError(
          `renderSelfUat: FAIL for "${result.criterion}" has no root cause — a FAIL cannot render without one`,
        );
      }
      const lowerRootCause = trimmedRootCause.toLowerCase();
      if (lowerRootCause === result.criterion.trim().toLowerCase()) {
        throw new SelfUatRenderError(
          `renderSelfUat: FAIL for "${result.criterion}" has a root cause that merely restates the criterion`,
        );
      }
      if (GENERIC_ROOT_CAUSE_PHRASES.some((phrase) => lowerRootCause.includes(phrase))) {
        throw new SelfUatRenderError(
          `renderSelfUat: FAIL for "${result.criterion}" has a root cause that is generic, non-diagnostic phrasing rather than a specific cause`,
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

    // Gap-closure/root-cause guard (IN-03, WR-01): a PASS has no gap to
    // close and nothing to diagnose, so a gapClosureRoute or rootCause
    // attached to one is semantically incoherent — it would either render a
    // `gap_closure:` line under a passing criterion, or (for rootCause) get
    // silently swallowed by the render loop's FAIL/PARTIAL-only condition,
    // hiding a caller-payload mistake instead of surfacing it. Scoped to
    // PASS only; FAIL and PARTIAL are exactly the verdicts these fields are
    // meaningful for.
    if (result.verdict === "PASS" && (result.gapClosureRoute || result.rootCause?.trim())) {
      throw new SelfUatRenderError(
        `renderSelfUat: PASS for "${result.criterion}" carries a rootCause/gapClosureRoute — routing and root-cause fields only apply to FAIL/PARTIAL`,
      );
    }
  }
}

/**
 * Derive the aggregate outcome from graded per-criterion results (GATE-01).
 * This is the ONLY producer of {@link SelfUatResult} / {@link SelfUatVerdict}
 * values inside this module — `renderSelfUat` takes no aggregate parameter,
 * so a caller has no channel to self-declare its own outcome (T-09-04).
 *
 * Four closed outcomes, one verdict each: `no_criteria` -> `advisory`,
 * `has_fail` -> `needs-rework`, `has_partial` -> `needs-attention` (WR-02,
 * resolved), `all_pass` -> `pass`. `advisory` is reserved for the true
 * "nothing to check" case — an all-PARTIAL run (`has_partial`) is NOT
 * `advisory`: it gets its own `needs-attention` verdict so a blocking gate
 * consumer routes it through a human-pause path rather than treating it as
 * equivalent to a clean pass.
 */
export function aggregateSelfUat(results: SelfUatCriterionResult[]): SelfUatAggregate {
  // D-02: zero graded criteria is its own distinct non-pass aggregate — it
  // must never share the all-PASS path. "Nothing was checked" can never
  // render as "everything passed".
  if (results.length === 0) {
    return { result: "no_criteria", verdict: "advisory" };
  }
  // FAIL takes precedence over PARTIAL, which takes precedence over PASS.
  // Scan every entry rather than short-circuiting on the first non-PASS, so
  // a FAIL appearing after a PARTIAL still wins.
  if (results.some((result) => result.verdict === "FAIL")) {
    return { result: "has_fail", verdict: "needs-rework" };
  }
  if (results.some((result) => result.verdict === "PARTIAL")) {
    return { result: "has_partial", verdict: "needs-attention" };
  }
  return { result: "all_pass", verdict: "pass" };
}

/**
 * WR-02 (12-REVIEW.md): every per-criterion field renderSelfUat emits as a
 * single `field: value` line (`criterion`, `evidence`, `rootCause`,
 * `gapClosureRoute`) is collapsed to one physical line first. Realistic
 * diagnostic content — command output, stack traces — routinely contains
 * embedded newlines; left unnormalized, only the first line would land
 * after the field's prefix and every subsequent line would land as bare,
 * unprefixed prose in the document body, silently truncating what
 * `parseSelfUatCriteria` reads back for gap-closure. Collapsing at the
 * render boundary (rather than making the parser continuation-aware) keeps
 * the on-disk format's one-line-per-field invariant exact, so the parser
 * never has to guess where a continuation line belongs.
 */
function collapseNewlines(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ");
}

/**
 * Render the SELF-UAT log document for a completed verification run.
 *
 * Pure function: takes plain data, returns a markdown string. Performs no
 * filesystem, network, or process-spawning I/O — the actual write happens
 * inside the spawned `agentic-tester` child, never here (SKILL.md Step 6).
 *
 * Guards (Task 2) run over every result before any string building, so a
 * single bad entry can never produce a half-rendered document. The rendered
 * document opens with a `---`-fenced frontmatter block naming the aggregate
 * `result`/`verdict` derived by {@link aggregateSelfUat} (GATE-01).
 */
export function renderSelfUat(
  results: SelfUatCriterionResult[],
  meta: SelfUatMeta,
): string {
  validateResults(results);

  const aggregate = aggregateSelfUat(results);

  const lines: string[] = [];
  lines.push("---");
  lines.push(`result: ${aggregate.result}`);
  lines.push(`verdict: ${aggregate.verdict}`);
  lines.push("---");
  lines.push("");
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
    lines.push(`### ${n}. ${collapseNewlines(result.criterion)}`);
    lines.push(`verdict: ${result.verdict}`);
    lines.push(`evidence: ${collapseNewlines(result.evidence)}`);
    if (result.verdict === "FAIL" || (result.verdict === "PARTIAL" && result.rootCause?.trim())) {
      lines.push(`root_cause: ${collapseNewlines(result.rootCause?.trim() ?? "")}`);
    }
    if (result.gapClosureRoute) {
      lines.push(`gap_closure: ${collapseNewlines(result.gapClosureRoute)}`);
    }
    lines.push("");
  });

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Parse a SELF-UAT log document's body back into per-criterion results
 * (Phase 12, GATE-04), inverting {@link renderSelfUat}'s own per-criterion
 * emission line-for-line: a `### N. <criterion>` heading (with a leading
 * ordinal) opens a new record; while a record is open, `verdict: `,
 * `evidence: `, `root_cause: `, and `gap_closure: ` prefixed lines fill the
 * corresponding field (value = remainder of the line, trimmed); the next
 * `### ` heading (ordinal or not) closes the current record, but only an
 * ordinal-prefixed heading opens a new one. A record is accepted into the
 * returned array only when its criterion and evidence are non-empty after
 * trimming and its verdict is an exact-case member of
 * {@link SELF_UAT_CRITERION_VERDICTS} — any other record is dropped
 * silently. Frontmatter and the header block (`target:`/`surface:`/
 * `timestamp:`/`log location:` lines) are never mistaken for criterion
 * fields because they appear before any `### N.` heading opens a record, so
 * the field-line checks below (gated on a record being open) never fire for
 * them.
 *
 * This function must never throw: it reads a file written by a separate
 * process (the spawned `agentic-tester` child, or a halted/truncated run),
 * so malformed or truncated input yields the records it can trust
 * (possibly an empty array), never an exception.
 */
export function parseSelfUatCriteria(content: string): SelfUatCriterionResult[] {
  const results: SelfUatCriterionResult[] = [];
  let current: {
    criterion: string;
    verdict?: string;
    evidence?: string;
    rootCause?: string;
    gapClosureRoute?: string;
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    const record = current;
    current = null;
    const criterion = record.criterion.trim();
    const evidence = (record.evidence ?? "").trim();
    const verdict = record.verdict;
    if (
      criterion.length === 0 ||
      evidence.length === 0 ||
      typeof verdict !== "string" ||
      !(SELF_UAT_CRITERION_VERDICTS as readonly string[]).includes(verdict)
    ) {
      return;
    }
    const rootCause = record.rootCause?.trim();
    const gapClosureRoute = record.gapClosureRoute?.trim();
    results.push({
      criterion,
      verdict: verdict as SelfUatCriterionVerdict,
      evidence,
      ...(rootCause ? { rootCause } : {}),
      ...(gapClosureRoute ? { gapClosureRoute } : {}),
    });
  };

  for (const line of content.split("\n")) {
    const orderedHeading = line.match(/^### (\d+)\. (.*)$/);
    if (orderedHeading) {
      flush();
      current = { criterion: orderedHeading[2] ?? "" };
      continue;
    }
    if (line.startsWith("### ")) {
      // A `### ` heading with no ordinal prefix never opens a record; it
      // only closes whatever record (if any) was already open.
      flush();
      continue;
    }
    if (!current) continue;
    if (line.startsWith("verdict: ")) {
      current.verdict = line.slice("verdict: ".length).trim();
    } else if (line.startsWith("evidence: ")) {
      current.evidence = line.slice("evidence: ".length).trim();
    } else if (line.startsWith("root_cause: ")) {
      current.rootCause = line.slice("root_cause: ".length).trim();
    } else if (line.startsWith("gap_closure: ")) {
      current.gapClosureRoute = line.slice("gap_closure: ".length).trim();
    }
  }
  flush();

  return results;
}

/** Lowercase-alphanumeric-and-dashes slug used by {@link selfUatLogFileName}. */
export function slugifyTarget(target: string): string {
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
