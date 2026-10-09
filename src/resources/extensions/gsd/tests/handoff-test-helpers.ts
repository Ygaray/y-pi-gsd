// Project/App: gsd-pi
// File Purpose: shared fixtures for the HANDOFF-01 tests — a stub yahir-handoff on PATH,
// a fake HandoffRunner, ctx/pi mocks and envelope builders. Node built-ins plus type-only
// imports so each test file keeps control of module-load order. No automated test may
// resolve or run the real yahir-handoff (it writes the operator's real handoff store).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { HandoffRun, HandoffRunner, HandoffRunOpts } from "../handoff-client.ts";

// ─── Temp dirs ──────────────────────────────────────────────────────────────

export function makeTempDir(registry: Set<string>, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registry.add(dir);
  return dir;
}

export function cleanupTempDirs(registry: Set<string>): void {
  for (const dir of registry) rmSync(dir, { recursive: true, force: true });
  registry.clear();
}

/** Temp project with .gsd/ and an empty .git (so projectRoot resolves to itself), or a real repo. */
export function makeTempGsdProject(registry: Set<string>, opts: { git?: "empty" | "real" } = {}): string {
  const root = makeTempDir(registry, "gsd-handoff-");
  mkdirSync(join(root, ".gsd"), { recursive: true });
  if (opts.git === "real") {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], {
      cwd: root,
    });
  } else {
    mkdirSync(join(root, ".git"));
  }
  return root;
}

// ─── Stub yahir-handoff ─────────────────────────────────────────────────────

export interface StubReply {
  stdout?: string;
  stderr?: string;
  code?: number;
  sleepSeconds?: number;
  ignoreTerm?: boolean;
  selfSignal?: "KILL";
}

function writeReply(dir: string, prefix: string, reply: StubReply): void {
  writeFileSync(join(dir, `${prefix}.present`), "1");
  writeFileSync(join(dir, `${prefix}.stdout`), reply.stdout ?? "");
  writeFileSync(join(dir, `${prefix}.stderr`), reply.stderr ?? "");
  writeFileSync(join(dir, `${prefix}.code`), String(reply.code ?? 0));
  writeFileSync(join(dir, `${prefix}.sleep`), String(reply.sleepSeconds ?? 0));
  writeFileSync(join(dir, `${prefix}.ignoreterm`), reply.ignoreTerm ? "1" : "0");
  writeFileSync(join(dir, `${prefix}.selfsignal`), reply.selfSignal ?? "");
}

/**
 * Stub yahir-handoff in its own temp dir (returned; put it first on PATH). Per invocation it
 * logs argv, copies stdin to stdin.<n>, dumps the identity env and cwd to env.<n>, then
 * replays the reply configured for the subcommand (call-indexed first, then the plain one;
 * for array replies the plain one is the last element, so the last reply repeats).
 */
export function makeHandoffStub(
  registry: Set<string>,
  replies: Record<string, StubReply | StubReply[]>,
  opts: { executable?: boolean } = {},
): string {
  const dir = makeTempDir(registry, "gsd-handoff-stub-");
  for (const [sub, spec] of Object.entries(replies)) {
    if (Array.isArray(spec)) {
      spec.forEach((reply, i) => writeReply(dir, `reply.${sub}.${i + 1}`, reply));
      if (spec.length > 0) writeReply(dir, `reply.${sub}`, spec[spec.length - 1]);
    } else {
      writeReply(dir, `reply.${sub}`, spec);
    }
  }
  const lines = [
    "#!/bin/sh",
    `D="${dir}"`,
    'n=$(( $(/bin/cat "$D/.n" 2>/dev/null || echo 0) + 1 ))',
    'echo "$n" > "$D/.n"',
    'for a in "$@"; do printf \'%s\\n\' "$a" >> "$D/argv.log"; done',
    "printf '%s\\n' '--end--' >> \"$D/argv.log\"",
    '/bin/cat > "$D/stdin.$n"',
    "{",
    "  printf 'YAHIR_HANDOFF_SESSION_ID=%s\\n' \"${YAHIR_HANDOFF_SESSION_ID-<unset>}\"",
    "  printf 'CLAUDE_CODE_SESSION_ID=%s\\n' \"${CLAUDE_CODE_SESSION_ID-<unset>}\"",
    "  printf 'YAHIR_HANDOFF_ROOT=%s\\n' \"${YAHIR_HANDOFF_ROOT-<unset>}\"",
    "  printf 'YAHIR_HANDOFF_STATE=%s\\n' \"${YAHIR_HANDOFF_STATE-<unset>}\"",
    "  printf 'PWD=%s\\n' \"$(pwd -P)\"",
    '} > "$D/env.$n"',
    'sub="$1"',
    'k=$(( $(/bin/cat "$D/.k.$sub" 2>/dev/null || echo 0) + 1 ))',
    'echo "$k" > "$D/.k.$sub"',
    'if [ -e "$D/reply.$sub.$k.present" ]; then p="$D/reply.$sub.$k"',
    'elif [ -e "$D/reply.$sub.present" ]; then p="$D/reply.$sub"',
    "else exit 0; fi",
    'if [ "$(/bin/cat "$p.ignoreterm")" = "1" ]; then trap \'\' TERM; fi',
    's=$(/bin/cat "$p.sleep")',
    'if [ "$s" != "0" ]; then exec /bin/sleep "$s"; fi',
    'if [ "$(/bin/cat "$p.selfsignal")" = "KILL" ]; then kill -KILL $$; fi',
    '/bin/cat "$p.stdout"',
    '/bin/cat "$p.stderr" >&2',
    'exit "$(/bin/cat "$p.code")"',
  ];
  writeFileSync(join(dir, "yahir-handoff"), lines.join("\n") + "\n", { mode: opts.executable === false ? 0o644 : 0o755 });
  return dir;
}

export interface StubCall {
  argv: string[];
  stdin: string;
  env: Record<string, string>;
}

/** Recorded stub invocations in order ([] when nothing ran). */
export function readStubCalls(stubDir: string): StubCall[] {
  const log = join(stubDir, "argv.log");
  if (!existsSync(log)) return [];
  const calls: StubCall[] = [];
  let cur: string[] = [];
  for (const line of readFileSync(log, "utf-8").split("\n")) {
    if (line === "--end--") {
      const n = calls.length + 1;
      const stdinFile = join(stubDir, `stdin.${n}`);
      const envFile = join(stubDir, `env.${n}`);
      const env: Record<string, string> = {};
      if (existsSync(envFile)) {
        for (const l of readFileSync(envFile, "utf-8").split("\n")) {
          const i = l.indexOf("=");
          if (i > 0) env[l.slice(0, i)] = l.slice(i + 1);
        }
      }
      calls.push({ argv: cur, stdin: existsSync(stdinFile) ? readFileSync(stdinFile, "utf-8") : "", env });
      cur = [];
    } else {
      cur.push(line);
    }
  }
  return calls;
}

// ─── PATH / env swapping ────────────────────────────────────────────────────

/** Current PATH minus every directory that holds an entry named yahir-handoff. */
export function pathWithoutRealYahirHandoff(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d !== "" && !existsSync(join(d, "yahir-handoff")))
    .join(delimiter);
}

export async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function withPath<T>(value: string, fn: () => Promise<T> | T): Promise<T> {
  return withEnv({ PATH: value }, fn);
}

// ─── ctx / pi mocks ─────────────────────────────────────────────────────────

export interface Note {
  message: string;
  level: string;
}

export function makeHandoffCtx(cwd: string, opts: { hasUI?: boolean; sessionId?: string | null } = {}) {
  const notifications: Note[] = [];
  return {
    cwd,
    hasUI: opts.hasUI ?? true,
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
      setWidget() {},
      setStatus() {},
      setHeader() {},
    },
    sessionManager: {
      getSessionId: () => opts.sessionId ?? null,
      getSessionFile: () => null,
    },
  };
}

export function makeRecordingPi() {
  const sent: Array<{ message: any; options: any }> = [];
  return {
    sent,
    sendMessage(message: any, options?: any) {
      sent.push({ message, options });
    },
    registerCommand() {},
    registerTool() {},
    registerShortcut() {},
    on() {},
    events: { emit() {} },
  };
}

// ─── Envelopes and entries ──────────────────────────────────────────────────

export const FIVE_SECTION_BODY = [
  "## Goal",
  "Finish the handoff wiring.",
  "",
  "## State",
  "Phase 45 plan 01 is in progress.",
  "",
  "## Next steps",
  "1. Run /gsd resume-work",
  "",
  "## Open decisions",
  "None.",
  "",
  "## Gotchas",
  "Tests use an isolated store.",
  "",
].join("\n");

export function envelope(result: unknown): string {
  return JSON.stringify({ schema_version: 1, generated_at: "2026-10-09T08:00:00+00:00", result }, null, 2);
}

export function errorEnvelope(code: number, message: string, hint: string | null = null): string {
  return JSON.stringify({ error: { code, message, hint } });
}

export function handoffEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ho_1009_abcd",
    state: "open",
    title: "y-pi-gsd paused: test",
    project: "proj",
    to: null,
    kind: "handoff",
    created_at: "2026-10-09T06:00:00+00:00",
    taken_by: null,
    closed_at: null,
    harness: "y-pi-gsd",
    resume_cmd: "/gsd resume-work",
    body: FIVE_SECTION_BODY,
    ...overrides,
  };
}

// ─── Fake runner ────────────────────────────────────────────────────────────

export function runOk(result: unknown): HandoffRun {
  return { ok: true, exitCode: 0, stdout: envelope(result), stderr: "" };
}

export function runExit(code: number, message: string, hint?: string): HandoffRun {
  return { ok: false, exitCode: code, stdout: "", stderr: errorEnvelope(code, message, hint ?? null) };
}

export function runEnoent(): HandoffRun {
  return { ok: false, exitCode: null, stdout: "", stderr: "", spawnError: "ENOENT" };
}

export function runTimeout(): HandoffRun {
  return { ok: false, exitCode: null, stdout: "", stderr: "", timedOut: true };
}

type FakeReply = HandoffRun | ((argv: readonly string[], opts: HandoffRunOpts) => HandoffRun | Promise<HandoffRun>);

/** Injected runner: picks the reply by argv[0]; array replies are consumed in order, the last one repeating. */
export function fakeHandoffRunner(script: Record<string, FakeReply | FakeReply[]>): {
  run: HandoffRunner;
  calls: Array<{ argv: string[]; opts: HandoffRunOpts }>;
} {
  const calls: Array<{ argv: string[]; opts: HandoffRunOpts }> = [];
  const counters: Record<string, number> = {};
  const run: HandoffRunner = async (argv, opts) => {
    calls.push({ argv: [...argv], opts });
    const sub = argv[0] ?? "";
    const spec = script[sub];
    if (spec === undefined) return runExit(99, `unscripted ${sub}`);
    let reply: FakeReply;
    if (Array.isArray(spec)) {
      const i = counters[sub] ?? 0;
      counters[sub] = i + 1;
      reply = spec[Math.min(i, spec.length - 1)];
    } else {
      reply = spec;
    }
    return typeof reply === "function" ? await reply(argv, opts) : reply;
  };
  return { run, calls };
}
