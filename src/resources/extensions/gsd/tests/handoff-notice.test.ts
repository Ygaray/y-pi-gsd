// Project/App: gsd-pi
// File Purpose: HANDOFF-01 startup notice — a hook-level tracer (the real session_start handler
// with a stub yahir-handoff on PATH) plus the gating/labelling/failure matrix driven through an
// injected fake runner. No real yahir-handoff is ever resolved.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  cleanupTempDirs,
  envelope,
  fakeHandoffRunner,
  handoffEntry,
  makeHandoffCtx,
  makeHandoffStub,
  makeTempGsdProject,
  pathWithoutRealYahirHandoff,
  readStubCalls,
  runEnoent,
  runExit,
  runOk,
  runTimeout,
  withPath,
} from "./handoff-test-helpers.ts";

// GSD_HOME must point at a temp dir before any project module loads.
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-handoff-notice-home-"));
process.env.GSD_HOME = tempGsdHome;

let hooks: typeof import("../bootstrap/register-hooks.ts");
let notice: typeof import("../handoff-notice.ts");
let rec: typeof import("../handoff-record.ts");
let gsdDb: typeof import("../gsd-db.ts");

before(async () => {
  gsdDb = await import("../gsd-db.ts");
  rec = await import("../handoff-record.ts");
  notice = await import("../handoff-notice.ts");
  hooks = await import("../bootstrap/register-hooks.ts");
});

after(() => {
  if (savedGsdHome === undefined) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = savedGsdHome;
  rmSync(tempGsdHome, { recursive: true, force: true });
});

const tempDirs = new Set<string>();

afterEach(() => {
  try {
    gsdDb.closeDatabase();
  } catch {
    /* noop */
  }
  cleanupTempDirs(tempDirs);
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

// ─── Tracer: the real session_start handler ─────────────────────────────────

/** The session-start-footer ctx shape plus hasUI/cwd, recording notify calls. */
function makeHookCtx(root: string) {
  const base = makeHandoffCtx(root, { hasUI: true });
  return {
    ...base,
    ui: {
      notify: base.ui.notify,
      setStatus: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
      setWidget: () => {},
    },
    sessionManager: { getSessionId: () => null },
    model: null,
    setCompactionThresholdOverride: () => {},
  };
}

function captureSessionStart(): (event: unknown, ctx: any) => Promise<void> | void {
  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as any;
  hooks.registerHooks(pi, []);
  const handler = handlers.get("session_start");
  assert.ok(handler, "session_start handler must be registered");
  return handler!;
}

/** Temp project whose DB holds a stored y-pi-gsd record (DB closed again before the hook runs). */
function projectWithStoredRecord(id: string): string {
  const root = makeTempGsdProject(tempDirs);
  gsdDb.openDatabase(join(root, ".gsd", "gsd.db"));
  assert.equal(
    rec.writeStoredHandoff({ id, createdAt: new Date().toISOString(), hadPausedSession: true, source: "pause" }),
    true,
  );
  gsdDb.closeDatabase();
  return root;
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

test("HANDOFF-01 notice tracer: a fresh interactive session_start shows one y-pi-gsd-written Handoff waiting line without blocking startup", async () => {
  const root = projectWithStoredRecord("ho_1009_aaaa");
  const createdAt = new Date(Date.now() - (2 * 60 + 5) * 60_000).toISOString();
  const stub = makeHandoffStub(tempDirs, {
    notice: {
      stdout: envelope({
        project: "proj",
        text: "Run /handoff take ho_1009_aaaa",
        handoffs: [handoffEntry({ id: "ho_1009_aaaa", title: "y-pi-gsd paused: M001/S01/T01", created_at: createdAt })],
      }),
    },
  });
  const sessionStart = captureSessionStart();
  const ctx = makeHookCtx(root);

  await withPath(`${stub}${delimiter}${pathWithoutRealYahirHandoff()}`, () =>
    withCwd(root, async () => {
      await sessionStart({ reason: "startup" }, ctx);
      const arrived = await waitFor(() => ctx.notifications.some((n) => n.message.includes("Handoff waiting")), 5_000);
      assert.ok(arrived, `no notice arrived; saw ${JSON.stringify(ctx.notifications)}`);
    }),
  );

  const waiting = ctx.notifications.filter((n) => n.message.includes("Handoff waiting"));
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].level, "info");
  assert.equal(waiting[0].message, "Handoff waiting: y-pi-gsd paused: M001/S01/T01 · 2h ago — /gsd resume-work (ho_1009_aaaa)");
  assert.ok(!ctx.notifications.some((n) => n.message.includes("/handoff take")), "the CLI's own text is never shown");
  const calls = readStubCalls(stub);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ["notice", "--json"]);
  assert.equal(calls[0].env.PWD, realpathSync(root));
});

test("HANDOFF-01 notice tracer: the session_start handler does not wait for the notice", async () => {
  const root = projectWithStoredRecord("ho_1009_aaaa");
  const stub = makeHandoffStub(tempDirs, { notice: { stdout: "", sleepSeconds: 3 } });
  const sessionStart = captureSessionStart();
  const ctx = makeHookCtx(root);

  await withPath(`${stub}${delimiter}${pathWithoutRealYahirHandoff()}`, () =>
    withCwd(root, async () => {
      const t0 = Date.now();
      await sessionStart({ reason: "startup" }, ctx);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 2_500, `session_start took ${elapsed} ms; it must not wait for the CLI`);
      assert.ok(!ctx.notifications.some((n) => n.message.includes("andoff")), "no Handoff notify exists yet");
      const arrived = await waitFor(() => ctx.notifications.some((n) => n.level === "warning"), 6_000);
      assert.ok(arrived, "the bad-output warning arrives after the CLI replies");
    }),
  );
  assert.match(ctx.notifications.find((n) => n.level === "warning")!.message, /yahir-handoff notice failed/);
});

// ─── Notice matrix: showStartupNotice with an injected runner ───────────────

const NOW = new Date("2026-10-09T08:00:00+00:00");
const STARTUP = { reason: "startup", autoActive: false, autoPaused: false };
/** Every argv[0] any matrix test ran (D-05: only notice/show may ever appear). */
const verbLog: string[] = [];

type Script = Parameters<typeof fakeHandoffRunner>[0];

function noticeReply(handoffs: Array<Record<string, unknown>>, text = "Run /handoff take ho_x") {
  return runOk({ project: "proj", text, handoffs });
}

async function runNotice(
  script: Script,
  opts: {
    input?: { reason?: string; autoActive: boolean; autoPaused: boolean };
    hasUI?: boolean;
    stored?: { id: string } | null | undefined;
  } = {},
) {
  const fake = fakeHandoffRunner(script);
  const run: typeof fake.run = async (argv, o) => {
    verbLog.push(argv[0] ?? "");
    return fake.run(argv, o);
  };
  const root = makeTempGsdProject(tempDirs);
  const ctx = makeHandoffCtx(root, { hasUI: opts.hasUI ?? true });
  const stored =
    opts.stored === undefined || opts.stored === null
      ? opts.stored
      : { id: opts.stored.id, createdAt: "2026-10-09T06:00:00+00:00", hadPausedSession: true, source: "pause" as const };
  await notice.showStartupNotice(opts.input ?? STARTUP, ctx as any, root, {
    run,
    now: () => NOW,
    readStored: () => stored,
  });
  return { ctx, calls: fake.calls, notes: ctx.notifications };
}

const ids = (n: number) => `ho_1009_x${n}`;

test("HANDOFF-01 notice: gating - only a fresh interactive startup with auto idle runs the CLI", async () => {
  const cases: Array<[string, { reason?: string; autoActive: boolean; autoPaused: boolean }, boolean]> = [
    ["reload", { reason: "reload", autoActive: false, autoPaused: false }, true],
    ["new", { reason: "new", autoActive: false, autoPaused: false }, true],
    ["resume", { reason: "resume", autoActive: false, autoPaused: false }, true],
    ["fork", { reason: "fork", autoActive: false, autoPaused: false }, true],
    ["undefined reason", { autoActive: false, autoPaused: false }, true],
    ["no UI", STARTUP, false],
    ["auto active", { reason: "startup", autoActive: true, autoPaused: false }, true],
    ["auto paused", { reason: "startup", autoActive: false, autoPaused: true }, true],
  ];
  for (const [label, input, hasUI] of cases) {
    const { calls, notes } = await runNotice({ notice: noticeReply([handoffEntry()]) }, { input, hasUI });
    assert.equal(calls.length, 0, `${label}: no CLI call`);
    assert.equal(notes.length, 0, `${label}: no notify`);
  }
  assert.equal(notice.shouldShowStartupNotice(STARTUP, true), true);
});

test("HANDOFF-01 notice: own, then any, then other harnesses, each labelled; the CLI text is never shown", async () => {
  const { notes, calls } = await runNotice(
    {
      notice: noticeReply([
        handoffEntry({ id: "ho_1009_cccc", title: "C", harness: "claude-code" }),
        handoffEntry({ id: "ho_1009_aaaa", title: "A", harness: "any" }),
        handoffEntry({ id: "ho_1009_yyyy", title: "Y", harness: "y-pi-gsd" }),
        handoffEntry({ id: "ho_1009_nnnn", title: "N", harness: undefined }),
      ]),
    },
    { stored: { id: "ho_1009_yyyy" } },
  );
  assert.equal(calls.length, 1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, "info");
  assert.deepEqual(notes[0].message.split("\n"), [
    "Handoff waiting: Y · 2h ago — /gsd resume-work (ho_1009_yyyy)",
    "Handoff waiting (written by another harness): A · 2h ago — /gsd resume-work ho_1009_aaaa",
    "Handoff for claude-code (not resumable here): C · 2h ago — yahir-handoff show ho_1009_cccc",
    "Handoff for claude-code (not resumable here): N · 2h ago — yahir-handoff show ho_1009_nnnn",
  ]);
  assert.ok(!notes[0].message.includes("/handoff take"));
});

test("HANDOFF-01 notice: a y-pi-gsd entry that is not the stored id is information only", async () => {
  const { notes } = await runNotice(
    { notice: noticeReply([handoffEntry({ id: "ho_1009_zzzz", title: "Stray" })]) },
    { stored: { id: "ho_1009_yyyy" } },
  );
  assert.equal(notes.length, 1);
  assert.equal(
    notes[0].message,
    "y-pi-gsd handoff not recorded by this project: Stray · 2h ago — yahir-handoff show ho_1009_zzzz",
  );
});

test("HANDOFF-01 notice: unreadable stored record shows y-pi-gsd entries as pickable", async () => {
  const { notes } = await runNotice({ notice: noticeReply([handoffEntry({ id: "ho_1009_zzzz", title: "Maybe mine" })]) }, { stored: undefined });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].message, "Handoff waiting: Maybe mine · 2h ago — /gsd resume-work (ho_1009_zzzz)");
});

test("HANDOFF-01 notice: a stored handoff that was taken but never completed stays visible", async () => {
  const { notes, calls } = await runNotice(
    {
      notice: noticeReply([]),
      show: runOk(handoffEntry({ id: "ho_1009_stor", state: "taken", title: "Half done" })),
    },
    { stored: { id: "ho_1009_stor" } },
  );
  assert.deepEqual(calls.map((c) => c.argv), [["notice", "--json"], ["show", "ho_1009_stor", "--json"]]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, "info");
  assert.equal(notes[0].message, "Handoff taken but not completed: Half done — /gsd resume-work (ho_1009_stor)");
});

test("HANDOFF-01 notice: a stored handoff that is closed adds no reminder and, alone, no notify", async () => {
  const { notes, calls } = await runNotice(
    { notice: noticeReply([]), show: runOk(handoffEntry({ id: "ho_1009_stor", state: "done" })) },
    { stored: { id: "ho_1009_stor" } },
  );
  assert.equal(calls.length, 2);
  assert.equal(notes.length, 0);
});

test("HANDOFF-01 notice: a stored id already in the open list needs no show call", async () => {
  const { calls, notes } = await runNotice(
    { notice: noticeReply([handoffEntry({ id: "ho_1009_stor", title: "Open one" })]) },
    { stored: { id: "ho_1009_stor" } },
  );
  assert.deepEqual(calls.map((c) => c.argv[0]), ["notice"]);
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /^Handoff waiting: Open one/);
});

test("HANDOFF-01 notice: a failing show is ignored, startup warns at most once", async () => {
  const { notes } = await runNotice(
    { notice: noticeReply([]), show: runExit(11, "busy") },
    { stored: { id: "ho_1009_stor" } },
  );
  assert.equal(notes.length, 0);
});

test("HANDOFF-01 notice: more than five open handoffs collapse into an overflow line", async () => {
  const entries = Array.from({ length: 8 }, (_, i) => handoffEntry({ id: ids(i), title: `Any ${i}`, harness: "any" }));
  const { notes } = await runNotice({ notice: noticeReply(entries) });
  assert.equal(notes.length, 1);
  const lines = notes[0].message.split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines.filter((l) => l.startsWith("Handoff waiting (written by another harness)")).length, 5);
  assert.equal(lines[5], "… and 3 more — yahir-handoff ls");
});

test("HANDOFF-01 notice: nothing open and no stored record means no notify and one CLI call", async () => {
  const { notes, calls } = await runNotice({ notice: noticeReply([]) }, { stored: null });
  assert.equal(notes.length, 0);
  assert.equal(calls.length, 1);
});

test("HANDOFF-01 notice: yahir-handoff not installed is silent", async () => {
  const { notes, calls } = await runNotice({ notice: runEnoent() });
  assert.equal(calls.length, 1);
  assert.equal(notes.length, 0);
});

test("HANDOFF-01 notice: an installed but failing CLI produces exactly one warning with the code or kind", async () => {
  const cases: Array<[string, ReturnType<typeof runExit>, RegExp]> = [
    ["busy", runExit(11, "store busy"), /exit 11/],
    ["timeout", runTimeout(), /timed out/],
    ["usage", runExit(2, "bad usage"), /exit 2/],
    ["bad output", { ok: true, exitCode: 0, stdout: "not json", stderr: "" }, /unusable output/],
  ];
  for (const [label, reply, pattern] of cases) {
    const { notes } = await runNotice({ notice: reply });
    assert.equal(notes.length, 1, `${label}: exactly one notify`);
    assert.equal(notes[0].level, "warning", label);
    assert.match(notes[0].message, /yahir-handoff notice failed/, label);
    assert.match(notes[0].message, pattern, label);
    assert.equal(notes.filter((n) => n.level === "info").length, 0, label);
  }
});

test("HANDOFF-01 notice: titles are sanitized, single-line and capped at 100 characters", async () => {
  const evil = "\u001b[31mEvil\u001b[0m\nsecond line\u202e" + "x".repeat(200);
  const { notes } = await runNotice({ notice: noticeReply([handoffEntry({ id: "ho_1009_evil", title: evil })]) });
  assert.equal(notes.length, 1);
  const message = notes[0].message;
  assert.ok(message.includes("Evil second line"));
  assert.ok(!message.includes("\u001b"), "no ESC");
  assert.ok(!message.includes("\u202e"), "no bidi override");
  assert.ok(!message.includes("\n"), "single line");
  const title = /^Handoff waiting: (.*) · 2h ago/.exec(message)![1];
  assert.ok(title.length <= 100, `title is ${title.length} chars`);
});

test("HANDOFF-01 notice: formatHandoffAge buckets", () => {
  const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  assert.equal(notice.formatHandoffAge(at(10_000), NOW), "just now");
  assert.equal(notice.formatHandoffAge(at(5 * 60_000), NOW), "5m ago");
  assert.equal(notice.formatHandoffAge(at(3 * 3_600_000 + 1), NOW), "3h ago");
  assert.equal(notice.formatHandoffAge(at(49 * 3_600_000), NOW), "2d ago");
  assert.equal(notice.formatHandoffAge("garbage", NOW), null);
  assert.equal(notice.formatHandoffAge(null, NOW), null);
});

// D-05 over the whole file: the shared call log only ever holds notice/show.
after(() => {
  assert.ok(verbLog.length > 0, "the matrix ran the CLI at least once");
  for (const verb of verbLog) assert.ok(verb === "notice" || verb === "show", `unexpected verb ${verb}`);
});
