// Project/App: gsd-pi
// File Purpose: HANDOFF-01 resume side — /gsd resume-work takes y-pi-gsd's own handoff by its
// stored id and resumes from it (SC3), picks up `any` handoffs only by explicit id as untrusted
// prose (D-14) and refuses claude-code / unrecorded ones (D-08, DP-3). Temp project DBs and
// injected fake runners; the real yahir-handoff is never resolved.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupTempDirs,
  runEnoent,
  runExit,
  fakeHandoffRunner,
  FIVE_SECTION_BODY,
  handoffEntry,
  makeHandoffCtx,
  makeRecordingPi,
  makeTempGsdProject,
  runOk,
} from "./handoff-test-helpers.ts";

// GSD_HOME must point at a temp dir before any project module loads.
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-handoff-resume-home-"));
process.env.GSD_HOME = tempGsdHome;

let core: typeof import("../commands-gsd-core.ts");
let rec: typeof import("../handoff-record.ts");
let cmdContext: typeof import("../commands/context.ts");
let gsdDb: typeof import("../gsd-db.ts");
let runtimeKv: typeof import("../db/runtime-kv.ts");
let interrupted: typeof import("../interrupted-session.ts");
let resume: typeof import("../handoff-resume.ts");

before(async () => {
  runtimeKv = await import("../db/runtime-kv.ts");
  interrupted = await import("../interrupted-session.ts");
  resume = await import("../handoff-resume.ts");
  gsdDb = await import("../gsd-db.ts");
  cmdContext = await import("../commands/context.ts");
  rec = await import("../handoff-record.ts");
  core = await import("../commands-gsd-core.ts");
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

// ─── Fixtures ───────────────────────────────────────────────────────────────

const OWN_ID = "ho_1009_aaaa";

/** Temp project whose DB already holds a stored own-handoff record, then closed (the handler reopens it). */
function projectWithRecord(
  id: string | null = OWN_ID,
  extra: Record<string, unknown> = {},
  paused: Record<string, unknown> | null = null,
): string {
  const root = makeTempGsdProject(tempDirs);
  gsdDb.openDatabase(join(root, ".gsd", "gsd.db"));
  if (id !== null) {
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
  if (paused !== null) {
    runtimeKv.setRuntimeKv("global", "", interrupted.PAUSED_SESSION_KV_KEY, {
      milestoneId: "M001",
      pausedAt: "2026-10-09T05:00:00.000Z",
      ...paused,
    });
  }
  gsdDb.closeDatabase();
  return root;
}

/** Run /gsd resume-work against a temp project with an injected runner and dispatchCommand recorder. */
async function resumeWork(root: string, args: string, run: any, opts: { sessionId?: string; throwOnSend?: boolean } = {}) {
  const ctx = makeHandoffCtx(root, { sessionId: opts.sessionId ?? null });
  const pi = makeRecordingPi();
  if (opts.throwOnSend) {
    pi.sendMessage = () => {
      throw new Error("send failed");
    };
  }
  const dispatched: string[] = [];
  await cmdContext.withCommandCwd(root, () =>
    core.handleResumeWork(args, ctx as any, pi as any, {
      run,
      dispatchCommand: async (c) => {
        dispatched.push(c);
      },
    }),
  );
  return { ctx, pi, dispatched };
}

/** Re-open the project DB to inspect state after the handler (afterEach closes it). */
function reopen(root: string): void {
  gsdDb.openDatabase(join(root, ".gsd", "gsd.db"));
}

const warningsOf = (ctx: { notifications: Array<{ message: string; level: string }> }) =>
  ctx.notifications.filter((n) => n.level === "warning");
const infosOf = (ctx: { notifications: Array<{ message: string; level: string }> }) =>
  ctx.notifications.filter((n) => n.level === "info");
const NO_HANDOFF = "No yahir-handoff entry was taken";

test("HANDOFF-01 resume tracer: /gsd resume-work takes this project's own open handoff by id, feeds its body into the resume prompt and closes it with done", async () => {
  const root = projectWithRecord();
  const { run, calls } = fakeHandoffRunner({
    show: runOk(handoffEntry({ id: OWN_ID, state: "open", body: FIVE_SECTION_BODY })),
    take: runOk(handoffEntry({ id: OWN_ID, state: "taken", taken_by: "sess-r", body: FIVE_SECTION_BODY })),
    done: runOk(handoffEntry({ id: OWN_ID, state: "done" })),
  });
  const ctx = makeHandoffCtx(root, { sessionId: "sess-r" });
  const pi = makeRecordingPi();

  await cmdContext.withCommandCwd(root, () => core.handleResumeWork("", ctx as any, pi as any, { run }));

  assert.deepEqual(
    calls.map((c) => c.argv),
    [
      ["show", OWN_ID, "--json"],
      ["take", OWN_ID, "--json"],
      ["done", OWN_ID, "--json"],
    ],
  );
  const take = calls.find((c) => c.argv[0] === "take");
  assert.equal(take?.opts.env.YAHIR_HANDOFF_SESSION_ID, "sess-r");

  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].message.customType, "gsd-resume-work");
  const content: string = pi.sent[0].message.content;
  assert.ok(content.includes(OWN_ID));
  assert.ok(content.includes("1. Run /gsd resume-work"), "the Next steps text reaches the prompt");
  assert.equal(
    content.split("\n").filter((l) => l.startsWith("## Goal")).length,
    0,
    "body headings are demoted so they cannot open a prompt section",
  );

  gsdDb.openDatabase(join(root, ".gsd", "gsd.db"));
  assert.equal(rec.readStoredHandoff(), null, "the record is cleared once done succeeded");
});

// ─── Own-handoff matrix (D-05, D-06, D-11, DP-1, DP-13, DP-15) ─────────────

const openEntry = (extra: Record<string, unknown> = {}) => handoffEntry({ id: OWN_ID, state: "open", ...extra });
const doneOk = runOk(handoffEntry({ id: OWN_ID, state: "done" }));
const callNames = (calls: Array<{ argv: string[] }>) => calls.map((c) => c.argv[0]);

for (const stepMode of [false, true]) {
  test(`HANDOFF-01 resume: paused session (stepMode ${stepMode}) re-enters /gsd ${stepMode ? "next" : "auto"} mechanically and links the record`, async () => {
    const root = projectWithRecord(OWN_ID, {}, { stepMode });
    const { run, calls } = fakeHandoffRunner({
      show: runOk(openEntry()),
      take: runOk(openEntry({ state: "taken" })),
      done: doneOk,
    });
    const { ctx, pi, dispatched } = await resumeWork(root, "", run);
    assert.deepEqual(callNames(calls), ["show", "take"]);
    assert.deepEqual(dispatched, [stepMode ? "next" : "auto"]);
    assert.equal(pi.sent.length, 0, "no LLM prompt in the paused branch");
    const resuming = infosOf(ctx).filter((n) => n.message.includes(`Resuming handoff ${OWN_ID}`));
    assert.equal(resuming.length, 1);
    assert.ok(resuming[0].message.includes("y-pi-gsd paused: test"));
    assert.ok(resuming[0].message.includes("Next steps:\n1. Run /gsd resume-work"));
    reopen(root);
    const record = rec.readStoredHandoff();
    assert.equal(record?.id, OWN_ID);
    assert.equal(record?.hadPausedSession, true, "re-linked so resume activation closes it");
  });
}

test("HANDOFF-01 resume: an own entry that is already taken is resumable without a re-take", async () => {
  const root = projectWithRecord();
  const { run, calls } = fakeHandoffRunner({ show: runOk(openEntry({ state: "taken" })), take: runExit(3, "taken"), done: doneOk });
  const { ctx, pi } = await resumeWork(root, "", run);
  assert.deepEqual(callNames(calls), ["show", "done"]);
  assert.equal(pi.sent.length, 1);
  assert.ok(pi.sent[0].message.content.includes(OWN_ID));
  assert.equal(warningsOf(ctx).length, 0);
  reopen(root);
  assert.equal(rec.readStoredHandoff(), null);
});

test("HANDOFF-01 resume: a take conflict on our own open entry still resumes, with one warning", async () => {
  const root = projectWithRecord();
  const { run, calls } = fakeHandoffRunner({ show: runOk(openEntry()), take: runExit(3, "already taken"), done: doneOk });
  const { ctx, pi } = await resumeWork(root, "", run);
  assert.deepEqual(callNames(calls), ["show", "take", "done"]);
  assert.equal(pi.sent.length, 1);
  const warns = warningsOf(ctx);
  assert.equal(warns.length, 1);
  assert.ok(warns[0].message.includes("another session"));
  reopen(root);
  assert.equal(rec.readStoredHandoff(), null);
});

for (const state of ["done", "dropped", "superseded", "archived"]) {
  test(`HANDOFF-01 resume: a stale stored id (${state}) is cleared and the resume proceeds from project state`, async () => {
    const root = projectWithRecord();
    const { run, calls } = fakeHandoffRunner({ show: runOk(openEntry({ state })), take: doneOk, done: doneOk });
    const { ctx, pi } = await resumeWork(root, "", run);
    assert.deepEqual(callNames(calls), ["show"]);
    assert.equal(infosOf(ctx).filter((n) => n.message.includes(`already ${state}`)).length, 1);
    assert.equal(pi.sent.length, 1);
    assert.ok(pi.sent[0].message.content.includes(NO_HANDOFF));
    reopen(root);
    assert.equal(rec.readStoredHandoff(), null);
  });
}

test("HANDOFF-01 resume: an unknown stored id (exit 9) is cleared and the prompt carries the no-handoff context", async () => {
  const root = projectWithRecord();
  const { run, calls } = fakeHandoffRunner({ show: runExit(9, "no such handoff") });
  const { ctx, pi } = await resumeWork(root, "", run);
  assert.deepEqual(callNames(calls), ["show"]);
  assert.equal(pi.sent.length, 1);
  assert.ok(pi.sent[0].message.content.includes(NO_HANDOFF));
  assert.equal(warningsOf(ctx).length, 0);
  reopen(root);
  assert.equal(rec.readStoredHandoff(), null);
});

test("HANDOFF-01 resume: CLI not installed with a record - one warning, prompt dispatched, record kept", async () => {
  const root = projectWithRecord();
  const { run, calls } = fakeHandoffRunner({ show: runEnoent() });
  const { ctx, pi } = await resumeWork(root, "", run);
  assert.deepEqual(callNames(calls), ["show"]);
  assert.equal(warningsOf(ctx).length, 1);
  assert.equal(pi.sent.length, 1);
  assert.ok(pi.sent[0].message.content.includes(NO_HANDOFF));
  reopen(root);
  assert.equal(rec.readStoredHandoff()?.id, OWN_ID);
});

test("HANDOFF-01 resume: a busy CLI with a record and a paused session still re-enters auto and keeps the record", async () => {
  const root = projectWithRecord(OWN_ID, {}, { stepMode: false });
  const { run } = fakeHandoffRunner({ show: runExit(11, "store busy") });
  const { ctx, pi, dispatched } = await resumeWork(root, "", run);
  const warns = warningsOf(ctx);
  assert.equal(warns.length, 1);
  assert.ok(warns[0].message.includes("exit 11"));
  assert.deepEqual(dispatched, ["auto"]);
  assert.equal(pi.sent.length, 0);
  reopen(root);
  assert.equal(rec.readStoredHandoff()?.id, OWN_ID);
});

test("HANDOFF-01 resume: a failing prompt dispatch never closes the handoff and keeps the record", async () => {
  const root = projectWithRecord();
  const { run, calls } = fakeHandoffRunner({ show: runOk(openEntry()), take: runOk(openEntry({ state: "taken" })), done: doneOk });
  const { ctx } = await resumeWork(root, "", run, { throwOnSend: true });
  assert.deepEqual(callNames(calls), ["show", "take"], "no done after a failed dispatch");
  assert.equal(ctx.notifications.filter((n) => n.level === "error" && n.message.includes("Failed to dispatch resume work")).length, 1);
  reopen(root);
  assert.equal(rec.readStoredHandoff()?.id, OWN_ID);
});

test("HANDOFF-01 resume: a done failure after a good prompt warns once and keeps the record", async () => {
  const root = projectWithRecord();
  const { run } = fakeHandoffRunner({ show: runOk(openEntry()), take: runOk(openEntry({ state: "taken" })), done: runExit(11, "store busy") });
  const { ctx, pi } = await resumeWork(root, "", run);
  assert.equal(pi.sent.length, 1);
  assert.equal(warningsOf(ctx).length, 1);
  reopen(root);
  assert.equal(rec.readStoredHandoff()?.id, OWN_ID);
});

test("HANDOFF-01 resume: no record and no id makes zero CLI calls and dispatches the prompt exactly as before", async () => {
  const root = projectWithRecord(null);
  const { run, calls } = fakeHandoffRunner({});
  const { ctx, pi, dispatched } = await resumeWork(root, "", run);
  assert.equal(calls.length, 0);
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].message.customType, "gsd-resume-work");
  assert.ok(pi.sent[0].message.content.includes(NO_HANDOFF));
  assert.equal(dispatched.length, 0);
  assert.equal(warningsOf(ctx).length, 0);
});

for (const args of ["ho_1009_aaaa extra", "--all", "not-an-id"]) {
  test(`HANDOFF-01 resume: a non-id argument (${JSON.stringify(args)}) is a usage error with no CLI call and no prompt`, async () => {
    const root = projectWithRecord();
    const { run, calls } = fakeHandoffRunner({});
    const { ctx, pi, dispatched } = await resumeWork(root, args, run);
    assert.equal(calls.length, 0);
    assert.equal(pi.sent.length, 0);
    assert.equal(dispatched.length, 0);
    const errors = ctx.notifications.filter((n) => n.level === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes(resume.RESUME_WORK_USAGE));
  });
}

test("HANDOFF-01 resume: parseResumeArgs accepts nothing or one valid id only", () => {
  assert.deepEqual(resume.parseResumeArgs("  "), { ok: true, id: null });
  assert.deepEqual(resume.parseResumeArgs(" ho_1009_bbbb "), { ok: true, id: "ho_1009_bbbb" });
  assert.equal(resume.parseResumeArgs("a b").ok, false);
});
