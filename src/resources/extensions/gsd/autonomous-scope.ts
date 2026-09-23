// Project/App: gsd-pi
// File Purpose: Structured, validated `--from N` autonomous-run scope
// (DRIVER-01, ROADMAP SC2). Replaces `parseAutonomousScope`'s
// prompt-text-only output with a structured, integer-validated value the
// dispatch path can mechanically enforce -- the prose the prompt template
// receives is now DERIVED from this structure, so it can never disagree
// with what is actually enforced.

/** Integer-or-null scope fields. `--only` takes precedence over `--from`/`--to`. */
export interface AutonomousScope {
  from: number | null;
  to: number | null;
  only: number | null;
}

/**
 * Named parse error (T-16-15): a non-integer, zero, negative, or
 * out-of-bound scope flag value is rejected here rather than silently
 * coerced into "no scope" or an off-by-one.
 */
export class InvalidAutonomousScopeFlagError extends Error {
  constructor(flag: "from" | "to" | "only", raw: string) {
    super(`--${flag} must be a positive integer (1-${MAX_AUTONOMOUS_SCOPE_VALUE}), got ${JSON.stringify(raw)}`);
    this.name = "InvalidAutonomousScopeFlagError";
  }
}

/** Sane upper bound -- rejects absurdly large values like `--from 1e9`. */
const MAX_AUTONOMOUS_SCOPE_VALUE = 100_000;

function parseScopeFlag(args: string, flag: "from" | "to" | "only"): number | null {
  const match = args.match(new RegExp(`--${flag}\\s+(\\S+)`));
  if (!match) return null;
  const raw = match[1]!;
  if (!/^\d+$/.test(raw)) throw new InvalidAutonomousScopeFlagError(flag, raw);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_AUTONOMOUS_SCOPE_VALUE) {
    throw new InvalidAutonomousScopeFlagError(flag, raw);
  }
  return value;
}

/**
 * Parse `--from`/`--to`/`--only` into a structured, validated
 * `AutonomousScope`. `--only` takes precedence over `--from`/`--to`,
 * matching today's `parseAutonomousScope` precedence exactly (Test 2). A
 * malformed value for ANY flag throws a named `InvalidAutonomousScopeFlagError`
 * instead of being silently dropped (Test 3) -- `--from abc`, `--from 0`,
 * `--from -1`, and `--from 1e9` are all rejected, never coerced into "all
 * remaining work" or an off-by-one.
 */
export function parseAutonomousScopeFlags(args: string): AutonomousScope {
  const only = parseScopeFlag(args, "only");
  if (only !== null) return { from: null, to: null, only };
  const from = parseScopeFlag(args, "from");
  const to = parseScopeFlag(args, "to");
  return { from, to, only: null };
}

/**
 * Project a structured `AutonomousScope` back into the exact prose string
 * `parseAutonomousScope` produced today -- the prompt template's `scope`
 * variable is now a PROJECTION of this structure, so the description and
 * the mechanical enforcement can never disagree (Test 4, T-16-16).
 */
export function describeAutonomousScope(scope: AutonomousScope): string {
  if (scope.only !== null) return `Only slice/milestone ${scope.only}`;
  const parts: string[] = [];
  if (scope.from !== null) parts.push(`from ${scope.from}`);
  if (scope.to !== null) parts.push(`to ${scope.to}`);
  return parts.length ? `All remaining work ${parts.join(" ")}` : "All remaining work on the active milestone";
}

/**
 * Mechanical in-scope predicate (D-02): given an ordinal below `from`,
 * above `to`, or different from `only`, returns false. Both `from`/`to`
 * bounds are INCLUSIVE. An absent bound is unbounded, never coerced to zero
 * -- that coercion is the classic off-by-one that would silently re-run a
 * completed unit (Test 12). `--only` takes precedence: when set, it is the
 * ONLY admitted ordinal, matching `parseAutonomousScopeFlags`'s own
 * precedence. Pure function of its two arguments -- testable without a
 * database, and safe for a future per-unit dispatch loop to consult
 * directly.
 */
export function isUnitInAutonomousScope(ordinal: number, scope: AutonomousScope): boolean {
  if (scope.only !== null) return ordinal === scope.only;
  if (scope.from !== null && ordinal < scope.from) return false;
  if (scope.to !== null && ordinal > scope.to) return false;
  return true;
}

/** The subset of a `milestone_run_log` row `resolveEffectiveAutonomousScope` needs. */
export interface AutonomousScopeResumeSource {
  resumeFrom: number | null;
}

/**
 * Resolve the EFFECTIVE scope for a `/gsd autonomous` invocation: parse the
 * flags, and when NONE of `from`/`to`/`only` were supplied explicitly, fall
 * back to the active run row's durable `resume_from` pointer instead of
 * defaulting to "all remaining work" (D-02) -- the resume point survives
 * the process that set it. An explicit flag on the invocation always wins
 * over the stored pointer, so an operator can override it without clearing
 * it first.
 */
export function resolveEffectiveAutonomousScope(
  args: string,
  activeRun: AutonomousScopeResumeSource | null,
): AutonomousScope {
  const parsed = parseAutonomousScopeFlags(args);
  if (parsed.from !== null || parsed.to !== null || parsed.only !== null) return parsed;
  if (activeRun && activeRun.resumeFrom !== null) {
    return { from: activeRun.resumeFrom, to: null, only: null };
  }
  return parsed;
}

/**
 * Extract the numeric suffix from a milestone id (`M001` -> `1`, `M042` ->
 * `42`). Returns null for anything that does not match the id shape --
 * callers must treat a null result as "no ordinal to check," never as 0.
 */
export function deriveMilestoneOrdinal(milestoneId: string): number | null {
  const match = milestoneId.match(/^M0*(\d+)$/i);
  if (!match) return null;
  return Number(match[1]);
}
