// Project/App: gsd-pi
// File Purpose: y-pi-gsd client for the harness-agnostic yahir-handoff CLI contract
// (HANDOFF-01). The only place that spawns yahir-handoff: async execFile, argv array, no
// shell, body on stdin, never throws. Handlers and lifecycle code call the typed ops here.

import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { parseCliError, sanitizeCliText, tailChars } from "./commands-doc.js";

export const YAHIR_HANDOFF_BIN = "yahir-handoff";
/** Default wall-clock budget for one CLI call (SIGTERM at this point). */
export const DEFAULT_HANDOFF_TIMEOUT_MS = 8_000;
/** Extra time after the SIGTERM timeout before escalating to SIGKILL and giving up on the child. */
export const HANDOFF_HARD_DEADLINE_GRACE_MS = 5_000;
/** stdout/stderr cap per call (1 MiB). */
export const HANDOFF_MAX_OUTPUT_BYTES = 1024 * 1024;
export const Y_PI_GSD_HARNESS = "y-pi-gsd";
export const Y_PI_GSD_RESUME_CMD = "/gsd resume-work";
export const HANDOFF_ID_RE = /^ho_[A-Za-z0-9_]{1,40}$/;
export const HARNESS_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const HANDOFF_STATES = ["open", "taken", "done", "dropped", "superseded", "archived"] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HandoffRun {
  /** true only for exit code 0 */
  ok: boolean;
  /** numeric process exit code when the child ran to completion */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** set when the child could not be spawned or its output could not be read (ENOENT, EACCES, ...) */
  spawnError?: string;
  /** set when our timeout fired and the child was killed */
  timedOut?: boolean;
  /** set when the child died from a signal we did not send */
  signal?: string;
  /** set when the runner refused to spawn at all (test run without an isolated store) */
  refused?: string;
}

export interface HandoffRunOpts {
  input?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  graceMs?: number;
}

export type HandoffRunner = (argv: readonly string[], opts: HandoffRunOpts) => Promise<HandoffRun>;

export type HandoffState = (typeof HANDOFF_STATES)[number];

export interface HandoffEntry {
  id: string;
  state: HandoffState;
  title: string;
  harness: string;
  resumeCmd: string | null;
  createdAt: string | null;
  takenBy: string | null;
  closedAt: string | null;
  body: string | null;
}

export interface HandoffNotice {
  project: string | null;
  handoffs: HandoffEntry[];
}

export type HandoffFailureKind =
  | "not-installed"
  | "cwd-missing"
  | "timeout"
  | "busy"
  | "conflict"
  | "not-allowed"
  | "not-found"
  | "usage"
  | "interrupted"
  | "internal"
  | "unexpected-exit"
  | "bad-output"
  | "signal"
  | "spawn-error"
  | "invalid-id"
  | "refused-test-isolation";

export interface HandoffFailure {
  ok: false;
  op: string;
  kind: HandoffFailureKind;
  code: number | null;
  message: string;
  hint: string | null;
}

export type HandoffResult<T> = { ok: true; value: T } | HandoffFailure;

export interface HandoffCallOpts {
  cwd: string;
  sessionId?: string | null;
  env?: NodeJS.ProcessEnv;
  run?: HandoffRunner;
  timeoutMs?: number;
}

export interface CreateHandoffInput {
  title: string;
  body: string;
  supersedes?: string | null;
}

// ─── Child environment ──────────────────────────────────────────────────────

/**
 * Child env for a yahir-handoff call (D-11, D-13 C): the Claude Code session id is always
 * removed (it would mis-attribute the handoff to an unrelated Claude session) and
 * YAHIR_HANDOFF_SESSION_ID carries the y-pi-gsd session id when one is known. Store paths
 * and PATH pass through untouched. Never mutates its input.
 */
export function buildChildEnv(base: NodeJS.ProcessEnv, sessionId: string | null | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (typeof sessionId === "string" && sessionId !== "") env.YAHIR_HANDOFF_SESSION_ID = sessionId;
  else delete env.YAHIR_HANDOFF_SESSION_ID;
  return env;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/**
 * True inside a node:test process (parent or isolated child). Mirrors the predicate of the
 * resolve-ts.mjs / dist-test-resolve.mjs preloads, including a `*.test.[cm]?[jt]s` entry script.
 */
export function isTestProcess(): boolean {
  return (
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.execArgv.some((arg) => arg === "--test" || arg.startsWith("--test-")) ||
    /\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? "")
  );
}

/** Marker the test preloads put in the isolated store directory name. */
export const HANDOFF_TEST_STORE_MARKER = "gsd-test-yahir-handoff-";

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * True when a store path is demonstrably a test store: it carries the preload marker, or sits
 * under the OS temp dir. An operator-exported real store path (under their home) is not.
 */
export function isIsolatedHandoffPath(p: string | undefined): boolean {
  if (!p) return false;
  const abs = resolve(p);
  if (abs.includes(HANDOFF_TEST_STORE_MARKER)) return true;
  const candidate = realOrResolved(abs);
  for (const tmp of new Set([resolve(tmpdir()), realOrResolved(tmpdir())])) {
    const rel = relative(tmp, candidate);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return true;
  }
  return false;
}

/**
 * Async, result-returning spawn of yahir-handoff. The returned promise never rejects and
 * always settles: SIGTERM at the timeout, then SIGKILL plus a forced result after a grace
 * period. No shell; cwd is the project directory (checked first so a missing directory is
 * reported as such, not as "not installed"); the body goes on stdin, which is always ended.
 */
export const runYahirHandoff: HandoffRunner = (argv, opts) =>
  new Promise<HandoffRun>((resolvePromise) => {
    let settled = false;
    let hardDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (run: HandoffRun): void => {
      if (settled) return;
      settled = true;
      if (hardDeadline !== undefined) clearTimeout(hardDeadline);
      resolvePromise(run);
    };
    const spawnFailure = (code: string): HandoffRun => ({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      spawnError: code,
    });
    try {
      // Runtime belt (DP-5, T-45-02): under node:test never spawn without an isolated store.
      if (
        isTestProcess() &&
        !(isIsolatedHandoffPath(opts.env.YAHIR_HANDOFF_ROOT) && isIsolatedHandoffPath(opts.env.YAHIR_HANDOFF_STATE))
      ) {
        finish({
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          refused: "test run without an isolated yahir-handoff store (YAHIR_HANDOFF_ROOT/YAHIR_HANDOFF_STATE unset or not a temp-dir test store)",
        });
        return;
      }
      let cwdIsDir = false;
      try {
        cwdIsDir = statSync(opts.cwd).isDirectory();
      } catch {
        cwdIsDir = false;
      }
      if (!cwdIsDir) {
        finish(spawnFailure("CWD_MISSING"));
        return;
      }
      const spawnOpts = {
        encoding: "utf-8" as const,
        timeout: opts.timeoutMs,
        maxBuffer: HANDOFF_MAX_OUTPUT_BYTES,
        cwd: opts.cwd,
        env: opts.env,
      };
      const child = execFile(YAHIR_HANDOFF_BIN, [...argv], spawnOpts,
        (err, stdout, stderr) => {
          const out = String(stdout ?? "");
          const errText = String(stderr ?? "");
          if (!err) {
            finish({ ok: true, exitCode: 0, stdout: out, stderr: errText });
            return;
          }
          const e = err as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string | null;
            code?: string | number | null;
          };
          if (e.killed && e.signal === "SIGTERM") {
            finish({ ok: false, exitCode: null, stdout: out, stderr: errText, timedOut: true });
          } else if (typeof e.code === "string") {
            finish({ ok: false, exitCode: null, stdout: out, stderr: errText, spawnError: e.code });
          } else if (typeof e.code === "number") {
            finish({ ok: false, exitCode: e.code, stdout: out, stderr: errText });
          } else {
            finish({ ok: false, exitCode: null, stdout: out, stderr: errText, signal: e.signal ?? undefined });
          }
        },
      );
      child.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        finish(spawnFailure(typeof code === "string" ? code : "SPAWN_FAILED"));
      });
      // execFile's timeout sends SIGTERM once. A child that traps or ignores it would leave
      // this promise pending forever, so a hard deadline escalates to SIGKILL and settles.
      hardDeadline = setTimeout(
        () => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          finish({ ok: false, exitCode: null, stdout: "", stderr: "", timedOut: true });
        },
        opts.timeoutMs + (opts.graceMs ?? HANDOFF_HARD_DEADLINE_GRACE_MS),
      );
      hardDeadline.unref?.();
      if (settled) clearTimeout(hardDeadline);
      // EPIPE when the CLI exits before reading its stdin must not become an uncaught error.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input ?? "");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      finish(spawnFailure(typeof code === "string" ? code : "SPAWN_FAILED"));
    }
  });

// ─── Parsing ────────────────────────────────────────────────────────────────

export function parseEnvelope(stdout: string): { ok: true; result: unknown } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "non-JSON output" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "output is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema_version !== 1) {
    return { ok: false, reason: `unsupported schema_version ${String(obj.schema_version)} (expected 1)` };
  }
  if (!("result" in obj)) return { ok: false, reason: "envelope has no result" };
  return { ok: true, result: obj.result };
}

/** Mirrors yahir-handoff notice.py harness_of: anything missing or malformed counts as claude-code. */
export function normalizeHarness(value: unknown): string {
  return typeof value === "string" && HARNESS_SLUG_RE.test(value) ? value : "claude-code";
}

export function isValidHandoffId(value: unknown): value is string {
  return typeof value === "string" && HANDOFF_ID_RE.test(value);
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Reads only the pinned entry fields; returns null for a malformed entry. */
export function parseHandoffEntry(value: unknown): HandoffEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isValidHandoffId(v.id)) return null;
  if (typeof v.state !== "string" || !(HANDOFF_STATES as readonly string[]).includes(v.state)) return null;
  if (typeof v.title !== "string") return null;
  return {
    id: v.id,
    state: v.state as HandoffState,
    title: v.title,
    harness: normalizeHarness(v.harness),
    resumeCmd: strOrNull(v.resume_cmd),
    createdAt: strOrNull(v.created_at),
    takenBy: strOrNull(v.taken_by),
    closedAt: strOrNull(v.closed_at),
    body: strOrNull(v.body),
  };
}

// ─── Failure classification ─────────────────────────────────────────────────

const EXIT_KINDS: Record<number, HandoffFailureKind> = {
  1: "internal",
  2: "usage",
  3: "conflict",
  6: "not-allowed",
  9: "not-found",
  11: "busy",
  130: "interrupted",
};

/**
 * Map a non-ok run to one typed, sanitized failure (null when the run succeeded). A missing
 * cwd carries a placeholder message; the caller, which knows the cwd, refines it.
 */
export function classifyHandoffRun(op: string, run: HandoffRun): HandoffFailure | null {
  if (run.ok) return null;
  const fail = (kind: HandoffFailureKind, message: string, code: number | null = null, hint: string | null = null): HandoffFailure => ({
    ok: false,
    op,
    kind,
    code,
    message: sanitizeCliText(message),
    hint: hint === null ? null : sanitizeCliText(hint),
  });
  if (run.refused) return fail("refused-test-isolation", run.refused);
  if (run.spawnError === "CWD_MISSING") return fail("cwd-missing", "project directory does not exist");
  if (run.spawnError === "ENOENT") return fail("not-installed", "yahir-handoff not on PATH");
  if (run.spawnError === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return fail("bad-output", "output exceeded 1 MiB");
  if (run.spawnError) return fail("spawn-error", run.spawnError);
  if (run.timedOut) return fail("timeout", `yahir-handoff ${op} timed out`);
  if (typeof run.exitCode === "number") {
    const kind = EXIT_KINDS[run.exitCode] ?? "unexpected-exit";
    const cli = parseCliError(run.stderr);
    if (cli) return fail(kind, cli.message, run.exitCode, cli.hint);
    return fail(kind, tailChars(run.stderr, 300) || "(no output)", run.exitCode);
  }
  return fail("signal", run.signal ?? "unknown signal");
}

/** One sanitized line describing a failure, for notify/log text. */
export function describeHandoffFailure(f: HandoffFailure): string {
  let text: string;
  switch (f.kind) {
    case "not-installed":
      text = "yahir-handoff not on PATH";
      break;
    case "cwd-missing":
      text = `project directory missing (${f.message})`;
      break;
    case "timeout":
      text = `yahir-handoff ${f.op} timed out`;
      break;
    case "refused-test-isolation":
      text = f.message;
      break;
    case "bad-output":
      text = `yahir-handoff ${f.op} returned unusable output (${f.message})`;
      break;
    case "signal":
    case "spawn-error":
    case "invalid-id":
      text = `yahir-handoff ${f.op} failed (${f.kind}): ${f.message}`;
      break;
    default:
      text = `yahir-handoff ${f.op} failed (exit ${String(f.code)}, ${f.kind}): ${f.message}`;
      if (f.hint) text += ` Hint: ${f.hint}`;
  }
  return sanitizeCliText(text);
}

// ─── Ops ────────────────────────────────────────────────────────────────────

function failure(op: string, kind: HandoffFailureKind, message: string): HandoffFailure {
  return { ok: false, op, kind, code: null, message: sanitizeCliText(message), hint: null };
}

/**
 * Run one op through the (injectable) runner and return the parsed envelope result.
 * Never throws: a rejecting or throwing runner becomes a spawn-error failure.
 */
async function callOp(
  op: string,
  argv: readonly string[],
  callOpts: HandoffCallOpts,
  input?: string,
): Promise<{ ok: true; result: unknown } | HandoffFailure> {
  let run: HandoffRun;
  try {
    const env = buildChildEnv(callOpts.env ?? process.env, callOpts.sessionId);
    run = await (callOpts.run ?? runYahirHandoff)(argv, {
      input,
      cwd: callOpts.cwd,
      env,
      timeoutMs: callOpts.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS,
    });
  } catch (err) {
    return failure(op, "spawn-error", err instanceof Error ? err.message : String(err));
  }
  const failed = classifyHandoffRun(op, run);
  if (failed) {
    if (failed.kind === "cwd-missing") return { ...failed, message: sanitizeCliText(`project directory ${callOpts.cwd} does not exist`) };
    return failed;
  }
  const env = parseEnvelope(run.stdout);
  if (!env.ok) return failure(op, "bad-output", env.reason);
  return { ok: true, result: env.result };
}

async function entryOp(op: string, argv: readonly string[], callOpts: HandoffCallOpts, input?: string): Promise<HandoffResult<HandoffEntry>> {
  const out = await callOp(op, argv, callOpts, input);
  if (out.ok === false) return out;
  const entry = parseHandoffEntry(out.result);
  if (!entry) return failure(op, "bad-output", "result is not a valid handoff entry");
  return { ok: true, value: entry };
}

export async function createHandoff(input: CreateHandoffInput, callOpts: HandoffCallOpts): Promise<HandoffResult<HandoffEntry>> {
  if (input.supersedes && !isValidHandoffId(input.supersedes)) return failure("create", "invalid-id", "not a handoff id");
  const argv = [
    "create",
    "--json",
    "--harness",
    Y_PI_GSD_HARNESS,
    "--resume-cmd",
    Y_PI_GSD_RESUME_CMD,
    `--title=${input.title}`,
  ];
  if (input.supersedes) argv.push(`--supersedes=${input.supersedes}`);
  return entryOp("create", argv, callOpts, input.body);
}

/** Id-addressed verbs only ever spawn with an explicit, validated id (D-04, D-14). */
function idOp(verb: "show" | "take" | "done" | "drop", id: string, callOpts: HandoffCallOpts): Promise<HandoffResult<HandoffEntry>> {
  if (!isValidHandoffId(id)) return Promise.resolve(failure(verb, "invalid-id", "not a handoff id"));
  return entryOp(verb, [verb, id, "--json"], callOpts);
}

export const showHandoff = (id: string, callOpts: HandoffCallOpts): Promise<HandoffResult<HandoffEntry>> => idOp("show", id, callOpts);
export const takeHandoff = (id: string, callOpts: HandoffCallOpts): Promise<HandoffResult<HandoffEntry>> => idOp("take", id, callOpts);
export const doneHandoff = (id: string, callOpts: HandoffCallOpts): Promise<HandoffResult<HandoffEntry>> => idOp("done", id, callOpts);
export const dropHandoff = (id: string, callOpts: HandoffCallOpts): Promise<HandoffResult<HandoffEntry>> => idOp("drop", id, callOpts);

/**
 * Open handoffs for the startup notice. Reads only result.project and result.handoffs[];
 * the CLI's human-readable rendering field is deliberately never read (D-07).
 */
export async function noticeHandoffs(callOpts: HandoffCallOpts): Promise<HandoffResult<HandoffNotice>> {
  const out = await callOp("notice", ["notice", "--json"], callOpts);
  if (out.ok === false) return out;
  const result = out.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return failure("notice", "bad-output", "result is not an object");
  }
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.handoffs)) return failure("notice", "bad-output", "result.handoffs is not an array");
  const handoffs: HandoffEntry[] = [];
  for (const raw of r.handoffs) {
    const entry = parseHandoffEntry(raw);
    if (entry) handoffs.push(entry);
  }
  return { ok: true, value: { project: strOrNull(r.project), handoffs } };
}
