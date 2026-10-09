// Project/App: gsd-pi
// File Purpose: HANDOFF-01 pause side — /gsd pause-work and /gsd pause register a five-section
// y-pi-gsd handoff mechanically (D-01/D-03), supersede only open/taken entries (D-04) and fail
// open (D-09). Temp project DBs and injected fake runners (or a stub CLI on PATH); the real
// yahir-handoff is never resolved.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupTempDirs,
  envelope,
  fakeHandoffRunner,
  handoffEntry,
  makeHandoffCtx,
  makeHandoffStub,
  makeRecordingPi,
  makeTempGsdProject,
  pathWithoutRealYahirHandoff,
  readStubCalls,
  runEnoent,
  runExit,
  runOk,
  runTimeout,
  withPath,
} from "./handoff-test-helpers.ts";
import type { HandoffRun } from "../handoff-client.ts";

// GSD_HOME must point at a temp dir before any project module loads.
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-handoff-pause-home-"));
process.env.GSD_HOME = tempGsdHome;

let core: typeof import("../commands-gsd-core.ts");
let rec: typeof import("../handoff-record.ts");
let cmdContext: typeof import("../commands/context.ts");
let gsdDb: typeof import("../gsd-db.ts");
let lifecycle: typeof import("../handoff-lifecycle.ts");
let runtimeKv: typeof import("../db/runtime-kv.ts");
let interrupted: typeof import("../interrupted-session.ts");
let runtimeState: typeof import("../auto-runtime-state.ts");
let autoHandlers: typeof import("../commands/handlers/auto.ts");

before(async () => {
  gsdDb = await import("../gsd-db.ts");
  cmdContext = await import("../commands/context.ts");
  rec = await import("../handoff-record.ts");
  core = await import("../commands-gsd-core.ts");
  lifecycle = await import("../handoff-lifecycle.ts");
  runtimeKv = await import("../db/runtime-kv.ts");
  interrupted = await import("../interrupted-session.ts");
  runtimeState = await import("../auto-runtime-state.ts");
  autoHandlers = await import("../commands/handlers/auto.ts");
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

test("HANDOFF-01 pause tracer: /gsd pause-work registers a five-section handoff from canonical state and still dispatches the pause-work prompt once", async () => {
  const root = makeTempGsdProject(tempDirs);
  const ctx = makeHandoffCtx(root, { sessionId: "sess-p" });
  const pi = makeRecordingPi();
  const created = handoffEntry({ id: "ho_1009_aaaa", title: "y-pi-gsd paused: proj" });
  const { run, calls } = fakeHandoffRunner({ create: runOk(created) });

  await cmdContext.withCommandCwd(root, () => core.handlePauseWork("", ctx as any, pi as any, { run }));

  assert.equal(calls.length, 1, "exactly one CLI call");
  const { argv, opts } = calls[0];
  assert.deepEqual(argv.slice(0, 6), ["create", "--json", "--harness", "y-pi-gsd", "--resume-cmd", "/gsd resume-work"]);
  assert.equal(argv.filter((a) => a.startsWith("--title=y-pi-gsd")).length, 1);
  assert.equal(argv.filter((a) => a.startsWith("--supersedes")).length, 0);

  const input = opts.input ?? "";
  let from = 0;
  for (const heading of ["## Goal", "## State", "## Next steps", "## Open decisions", "## Gotchas"]) {
    const at = input.indexOf(heading, from);
    assert.ok(at >= from, `${heading} present, in order`);
    assert.equal(input.split("\n").filter((l) => l === heading).length, 1, `${heading} exactly once`);
    from = at + heading.length;
  }
  assert.ok(input.includes("/gsd resume-work"));

  assert.equal(realpathSync(opts.cwd), realpathSync(root));
  assert.equal(opts.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(opts.env.YAHIR_HANDOFF_SESSION_ID, "sess-p");

  assert.deepEqual(rec.readStoredHandoff(), {
    id: "ho_1009_aaaa",
    createdAt: String(created.created_at),
    hadPausedSession: false,
    source: "pause-work",
  });

  const infos = ctx.notifications.filter((n) => n.level === "info");
  const registered = infos.findIndex((n) => n.message.includes("ho_1009_aaaa") && n.message.includes("/gsd resume-work"));
  const running = infos.findIndex((n) => n.message.startsWith("Running pause work"));
  assert.equal(infos.filter((n) => n.message.includes("ho_1009_aaaa")).length, 1, "exactly one registration notify");
  assert.ok(registered >= 0 && running >= 0 && registered < running, "registration notify precedes the prompt notify");

  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].message.customType, "gsd-pause-work");
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const OLD_ID = "ho_1009_0001";
const NEW_ID = "ho_1009_0002";
const NOT_ON_PATH = "pause saved; handoff not registered — yahir-handoff not on PATH";

/** Temp project with its workflow DB already open (the state /gsd pause relies on). */
function openProject(): string {
  const root = makeTempGsdProject(tempDirs);
  gsdDb.openDatabase(join(root, ".gsd", "gsd.db"));
  return root;
}

function seedRecord(id = OLD_ID, extra: Record<string, unknown> = {}): void {
  assert.equal(
    rec.writeStoredHandoff({
      id,
      createdAt: "2026-10-09T05:00:00+00:00",
      hadPausedSession: false,
      source: "pause-work",
      ...extra,
    } as any),
    true,
  );
}

/** /gsd pause-work against a temp project with an injected runner. */
async function pauseWork(root: string, run: any, opts: { sessionId?: string } = {}) {
  const ctx = makeHandoffCtx(root, { sessionId: opts.sessionId ?? null });
  const pi = makeRecordingPi();
  await cmdContext.withCommandCwd(root, () => core.handlePauseWork("", ctx as any, pi as any, { run }));
  return { ctx, pi };
}

/** registerPauseHandoff directly (the /gsd pause path: relies on the already-open DB). */
async function registerDirect(root: string, source: "pause" | "pause-work", run: any) {
  const ctx = makeHandoffCtx(root, { sessionId: null });
  const outcome = await cmdContext.withCommandCwd(root, () =>
    lifecycle.registerPauseHandoff(ctx as any, source, { run }),
  );
  return { ctx, outcome };
}

const warnings = (ctx: { notifications: Array<{ message: string; level: string }> }) =>
  ctx.notifications.filter((n) => n.level === "warning");

function createdArgv(calls: Array<{ argv: string[] }>): string[][] {
  return calls.filter((c) => c.argv[0] === "create").map((c) => c.argv);
}

// ─── Supersede (D-04, DP-12) ────────────────────────────────────────────────

for (const state of ["open", "taken"] as const) {
  test(`HANDOFF-01 pause: re-pausing supersedes the stored entry while it is ${state}`, async () => {
    const root = openProject();
    seedRecord();
    const { run, calls } = fakeHandoffRunner({
      show: runOk(handoffEntry({ id: OLD_ID, state })),
      create: runOk(handoffEntry({ id: NEW_ID })),
    });
    const { ctx, pi } = await pauseWork(root, run);
    assert.deepEqual(calls.map((c) => c.argv[0]), ["show", "create"]);
    assert.deepEqual(calls[0].argv, ["show", OLD_ID, "--json"]);
    assert.ok(calls[1].argv.includes(`--supersedes=${OLD_ID}`));
    assert.equal(rec.readStoredHandoff()?.id, NEW_ID);
    const info = ctx.notifications.find((n) => n.message.includes(NEW_ID));
    assert.ok(info?.message.includes(`replaces ${OLD_ID}`));
    assert.equal(pi.sent.length, 1);
  });
}

test("HANDOFF-01 pause: a closed stored entry is never superseded - a plain create follows", async () => {
  for (const state of ["done", "dropped", "superseded", "archived"] as const) {
    const root = openProject();
    seedRecord();
    const { run, calls } = fakeHandoffRunner({
      show: runOk(handoffEntry({ id: OLD_ID, state })),
      create: runOk(handoffEntry({ id: NEW_ID })),
    });
    await pauseWork(root, run);
    const creates = createdArgv(calls);
    assert.equal(creates.length, 1, state);
    assert.equal(creates[0].filter((a) => a.startsWith("--supersedes")).length, 0, `${state}: no --supersedes`);
    assert.equal(rec.readStoredHandoff()?.id, NEW_ID, state);
    gsdDb.closeDatabase();
  }
});

test("HANDOFF-01 pause: an unknown stored id (show exit 9) leads to a plain create and a new record", async () => {
  const root = openProject();
  seedRecord();
  const { run, calls } = fakeHandoffRunner({
    show: runExit(9, "no such handoff"),
    create: runOk(handoffEntry({ id: NEW_ID })),
  });
  await pauseWork(root, run);
  assert.equal(createdArgv(calls).length, 1);
  assert.equal(createdArgv(calls)[0].filter((a) => a.startsWith("--supersedes")).length, 0);
  assert.equal(rec.readStoredHandoff()?.id, NEW_ID);
});

test("HANDOFF-01 pause: a supersede race (create exit 6) is retried exactly once without --supersedes", async () => {
  const root = openProject();
  seedRecord();
  const { run, calls } = fakeHandoffRunner({
    show: runOk(handoffEntry({ id: OLD_ID, state: "open" })),
    create: [runExit(6, "entry is closed"), runOk(handoffEntry({ id: NEW_ID }))],
  });
  const { ctx } = await pauseWork(root, run);
  const creates = createdArgv(calls);
  assert.equal(creates.length, 2);
  assert.ok(creates[0].includes(`--supersedes=${OLD_ID}`));
  assert.equal(creates[1].filter((a) => a.startsWith("--supersedes")).length, 0);
  assert.equal(rec.readStoredHandoff()?.id, NEW_ID);
  assert.equal(warnings(ctx).length, 0);
});

test("HANDOFF-01 pause: a superseding create that keeps failing is retried only once", async () => {
  const root = openProject();
  seedRecord();
  const { run, calls } = fakeHandoffRunner({
    show: runOk(handoffEntry({ id: OLD_ID, state: "open" })),
    create: [runExit(9, "gone"), runExit(11, "store busy")],
  });
  const { ctx, pi } = await pauseWork(root, run);
  assert.equal(createdArgv(calls).length, 2);
  assert.equal(warnings(ctx).length, 1);
  assert.ok(warnings(ctx)[0].message.includes("exit 11"));
  assert.equal(rec.readStoredHandoff()?.id, OLD_ID, "old record kept");
  assert.equal(pi.sent.length, 1);
});

// ─── Fail-open matrix (D-09) ────────────────────────────────────────────────

test("HANDOFF-01 pause: show busy (exit 11) aborts registration, keeps the old record and still dispatches the prompt", async () => {
  const root = openProject();
  seedRecord();
  const { run, calls } = fakeHandoffRunner({ show: runExit(11, "store is busy") });
  const { ctx, pi } = await pauseWork(root, run);
  assert.equal(createdArgv(calls).length, 0, "no blind create after a failed show");
  assert.equal(warnings(ctx).length, 1);
  assert.ok(warnings(ctx)[0].message.includes("exit 11"));
  assert.deepEqual(rec.readStoredHandoff()?.id, OLD_ID);
  assert.equal(pi.sent.length, 1);
});

test("HANDOFF-01 pause: yahir-handoff not on PATH gives exactly one fixed warning and no record", async () => {
  const root = openProject();
  const { run } = fakeHandoffRunner({ create: runEnoent() });
  const { ctx, pi } = await pauseWork(root, run);
  assert.equal(warnings(ctx).length, 1);
  assert.equal(warnings(ctx)[0].message, NOT_ON_PATH);
  assert.equal(lifecycle.HANDOFF_NOT_ON_PATH_WARNING, NOT_ON_PATH);
  assert.equal(rec.readStoredHandoff(), null);
  assert.equal(ctx.notifications.filter((n) => n.level === "info" && n.message.includes("Handoff registered")).length, 0);
  assert.equal(pi.sent.length, 1);
});

test("HANDOFF-01 pause: not on PATH while checking a stored entry gives the same single warning and no create", async () => {
  const root = openProject();
  seedRecord();
  const { run, calls } = fakeHandoffRunner({ show: runEnoent() });
  const { ctx } = await pauseWork(root, run);
  assert.equal(warnings(ctx).length, 1);
  assert.equal(warnings(ctx)[0].message, NOT_ON_PATH);
  assert.equal(createdArgv(calls).length, 0);
  assert.equal(rec.readStoredHandoff()?.id, OLD_ID);
});

test("HANDOFF-01 pause: a usage error (create exit 2) warns once with the exit code and the CLI message", async () => {
  const root = openProject();
  const { run } = fakeHandoffRunner({ create: runExit(2, "handoff is missing section Goal") });
  const { ctx, pi } = await pauseWork(root, run);
  assert.equal(warnings(ctx).length, 1);
  assert.ok(warnings(ctx)[0].message.includes("exit 2"));
  assert.ok(warnings(ctx)[0].message.includes("handoff is missing section Goal"));
  assert.equal(rec.readStoredHandoff(), null);
  assert.equal(pi.sent.length, 1);
});

test("HANDOFF-01 pause: a create timeout warns that it may have been registered and points at yahir-handoff ls", async () => {
  const root = openProject();
  const { run } = fakeHandoffRunner({ create: runTimeout() });
  const { ctx } = await pauseWork(root, run);
  assert.equal(warnings(ctx).length, 1);
  assert.ok(warnings(ctx)[0].message.includes("may have been registered"));
  assert.ok(warnings(ctx)[0].message.includes("yahir-handoff ls"));
  assert.equal(rec.readStoredHandoff(), null);
});

test("HANDOFF-01 pause: a create that succeeds with unusable output warns once and stores nothing", async () => {
  const root = openProject();
  const garbage: HandoffRun = { ok: true, exitCode: 0, stdout: "not json at all", stderr: "" };
  const { run } = fakeHandoffRunner({ create: garbage });
  const { ctx } = await pauseWork(root, run);
  assert.equal(warnings(ctx).length, 1);
  assert.ok(warnings(ctx)[0].message.includes("unusable output"));
  assert.equal(rec.readStoredHandoff(), null);
});

test("HANDOFF-01 pause: a runner that throws or a state reader that throws never breaks the pause", async () => {
  const root = openProject();
  const throwing = async () => {
    throw new Error("runner exploded");
  };
  const first = await pauseWork(root, throwing);
  assert.equal(warnings(first.ctx).length, 1);
  assert.equal(first.pi.sent.length, 1);

  const ctx = makeHandoffCtx(root);
  const { run, calls } = fakeHandoffRunner({ create: runOk(handoffEntry({ id: NEW_ID })) });
  const outcome = await cmdContext.withCommandCwd(root, () =>
    lifecycle.registerPauseHandoff(ctx as any, "pause", {
      run,
      readState: async () => {
        throw new Error("state exploded");
      },
    }),
  );
  assert.equal(outcome.status, "registered");
  assert.equal(calls.length, 1);
});

test("HANDOFF-01 pause: a registered handoff that cannot be recorded warns with the drop command", async () => {
  const root = openProject();
  const closing = async () => {
    gsdDb.closeDatabase();
    return runOk(handoffEntry({ id: NEW_ID }));
  };
  const { ctx } = await pauseWork(root, closing);
  assert.equal(warnings(ctx).length, 1);
  assert.ok(warnings(ctx)[0].message.includes(`yahir-handoff drop ${NEW_ID}`));
});

// ─── DB gate (DP-16) ────────────────────────────────────────────────────────

test("HANDOFF-01 pause: no CLI call while the project database is unavailable", async () => {
  const root = makeTempGsdProject(tempDirs);
  gsdDb.closeDatabase();
  const { run, calls } = fakeHandoffRunner({ create: runOk(handoffEntry()) });
  const { ctx, outcome } = await registerDirect(root, "pause", run);
  assert.equal(calls.length, 0);
  assert.equal(outcome.status, "skipped");
  assert.equal(warnings(ctx).length, 1);
  assert.match(warnings(ctx)[0].message, /database/);
});

// ─── Body inputs ────────────────────────────────────────────────────────────

test("HANDOFF-01 pause: a paused session feeds the body and the record is linked to it", async () => {
  const root = openProject();
  runtimeKv.setRuntimeKv("global", "", interrupted.PAUSED_SESSION_KV_KEY, {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    pauseReason: "provider error: 529",
    stepMode: true,
    pausedAt: "2026-10-09T09:00:00.000Z",
  });
  const { run, calls } = fakeHandoffRunner({ create: runOk(handoffEntry({ id: NEW_ID })) });
  const { outcome } = await registerDirect(root, "pause", run);
  assert.equal(outcome.status, "registered");
  const input = calls[0].opts.input ?? "";
  for (const needle of ["execute-task", "M001/S01/T01", "provider error: 529", "/gsd next"]) {
    assert.ok(input.includes(needle), needle);
  }
  const stored = rec.readStoredHandoff();
  assert.equal(stored?.hadPausedSession, true);
  assert.equal(stored?.source, "pause");
});

test("HANDOFF-01 pause: .gsd/HANDOFF.md is folded into State when it is a file and ignored when it is not", async () => {
  const withNotes = openProject();
  writeFileSync(join(withNotes, ".gsd", "HANDOFF.md"), "## Progress\nhalf the wiring is done\n");
  const a = fakeHandoffRunner({ create: runOk(handoffEntry({ id: NEW_ID })) });
  await pauseWork(withNotes, a.run);
  const folded = a.calls[0].opts.input ?? "";
  assert.ok(folded.includes("half the wiring is done"));
  assert.ok(folded.includes("last written"));
  gsdDb.closeDatabase();

  const asDir = openProject();
  mkdirSync(join(asDir, ".gsd", "HANDOFF.md"));
  const b = fakeHandoffRunner({ create: runOk(handoffEntry({ id: NEW_ID })) });
  const { ctx } = await pauseWork(asDir, b.run);
  assert.equal(b.calls.length, 1);
  assert.ok(!(b.calls[0].opts.input ?? "").includes("Notes from .gsd/HANDOFF.md"));
  assert.equal(warnings(ctx).length, 0);
  assert.equal(lifecycle.readHandoffNotes(asDir), null);
});

test("HANDOFF-01 pause: pause-work while auto-mode is active states it and does not pause auto", async () => {
  const root = openProject();
  const { run, calls } = fakeHandoffRunner({ create: runOk(handoffEntry({ id: NEW_ID })) });
  const ctx = makeHandoffCtx(root);
  const pi = makeRecordingPi();
  await cmdContext.withCommandCwd(root, () =>
    core.handlePauseWork("", ctx as any, pi as any, { run, isAutoActive: () => true }),
  );
  assert.ok((calls[0].opts.input ?? "").includes("auto-mode was active at registration"));
  assert.equal(runtimeState.autoSession.paused, false);
});

// ─── D-01 / D-03 structure ──────────────────────────────────────────────────

test("HANDOFF-01 pause: registration lives only in the two operator handlers, never in pauseAuto or a prompt (D-01, D-03)", () => {
  const handlerSrc = readFileSync(fileURLToPath(new URL("../commands/handlers/auto.ts", import.meta.url)), "utf-8");
  const armStart = handlerSrc.indexOf('if (trimmed === "pause")');
  assert.ok(armStart >= 0, "pause arm found");
  const arm = handlerSrc.slice(armStart, handlerSrc.indexOf('if (trimmed === "rate"', armStart));
  const afterPause = arm.slice(arm.indexOf("await pauseAuto("));
  assert.ok(afterPause.includes("isAutoPaused()"));
  assert.ok(afterPause.indexOf("isAutoPaused()") < afterPause.indexOf("registerPauseHandoff"), "gated by isAutoPaused()");

  const autoSrc = readFileSync(fileURLToPath(new URL("../auto.ts", import.meta.url)), "utf-8");
  const fnStart = autoSrc.indexOf("export async function pauseAuto(");
  assert.ok(fnStart >= 0, "pauseAuto found");
  const nextFn = autoSrc.indexOf("\nexport async function ", fnStart + 10);
  assert.doesNotMatch(autoSrc.slice(fnStart, nextFn === -1 ? undefined : nextFn), /handoff/i);

  const prompt = readFileSync(fileURLToPath(new URL("../prompts/pause-work.md", import.meta.url)), "utf-8");
  assert.doesNotMatch(prompt, /yahir-handoff/i, "registration is code, not a prompt instruction");

  const coreSrc = readFileSync(fileURLToPath(new URL("../commands-gsd-core.ts", import.meta.url)), "utf-8");
  assert.ok(coreSrc.indexOf('registerPauseHandoff(ctx, "pause-work"') < coreSrc.indexOf('prompt: "pause-work"'));
});

// ─── /gsd pause end to end (stub CLI on PATH, real runner) ─────────────────

test("HANDOFF-01 pause: /gsd pause pauses auto-mode and then registers the handoff through the real runner", async () => {
  const root = openProject();
  const stub = makeHandoffStub(tempDirs, { create: { stdout: envelope(handoffEntry({ id: NEW_ID })) } });
  const previousCwd = process.cwd();
  const { autoSession } = runtimeState;
  autoSession.reset();
  autoSession.active = true;
  const ctx = {
    ...makeHandoffCtx(root, { sessionId: "sess-pause" }),
    isIdle: () => true,
    abort() {},
  };
  const pi = makeRecordingPi();
  try {
    process.chdir(root);
    await withPath([stub, pathWithoutRealYahirHandoff()].join(delimiter), () =>
      cmdContext.withCommandCwd(root, async () => {
        const handled = await autoHandlers.handleAutoCommand("pause", ctx as any, pi as any);
        assert.equal(handled, true);
      }),
    );
    assert.equal(autoSession.paused, true, "auto-mode is paused");
    const calls = readStubCalls(stub);
    assert.equal(calls.length, 1, "exactly one CLI call");
    assert.equal(calls[0].argv[0], "create");
    assert.equal(calls[0].env.YAHIR_HANDOFF_SESSION_ID, "sess-pause");
    const pausedRow = runtimeKv.getRuntimeKv("global", "", interrupted.PAUSED_SESSION_KV_KEY) !== null;
    const stored = rec.readStoredHandoff();
    assert.equal(stored?.id, NEW_ID);
    assert.equal(stored?.source, "pause");
    assert.equal(stored?.hadPausedSession, pausedRow);
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
  }
});
