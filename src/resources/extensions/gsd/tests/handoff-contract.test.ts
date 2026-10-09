// Project/App: gsd-pi
// File Purpose: HANDOFF-01 contract tests against the REAL yahir-handoff CLI with an isolated
// store (D-12). Every spawn and every handler/lifecycle call carries ISOLATED_ENV (temp
// YAHIR_HANDOFF_ROOT, YAHIR_HANDOFF_STATE and HOME); the operator's real store is never touched.
// The suite skips (never fails, never spawns) when the CLI or its --harness/--resume-cmd flags
// are absent (SC4).

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupTempDirs,
  FIVE_SECTION_BODY,
  makeHandoffCtx,
  makeRecordingPi,
  makeTempGsdProject,
} from "./handoff-test-helpers.ts";

// GSD_HOME must point at a temp dir before any project module loads.
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-handoff-contract-home-"));
process.env.GSD_HOME = tempGsdHome;

// ─── Isolated environment (module top, synchronous: node:test reads `skip` at registration) ──

const CONTRACT_ROOT = mkdtempSync(join(tmpdir(), "ho-contract-"));
const CONTRACT_STORE = join(CONTRACT_ROOT, "store");
const CONTRACT_STATE = join(CONTRACT_ROOT, "state");
const CONTRACT_HOME = join(CONTRACT_ROOT, "home");
mkdirSync(CONTRACT_STORE, { recursive: true });
mkdirSync(CONTRACT_STATE, { recursive: true });
mkdirSync(CONTRACT_HOME, { recursive: true });

const ISOLATED_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  YAHIR_HANDOFF_ROOT: CONTRACT_STORE,
  YAHIR_HANDOFF_STATE: CONTRACT_STATE,
  HOME: CONTRACT_HOME,
};
delete ISOLATED_ENV.CLAUDE_CODE_SESSION_ID;
delete ISOLATED_ENV.YAHIR_HANDOFF_SESSION_ID;

function detectCli(): boolean {
  try {
    const out = execFileSync("yahir-handoff", ["create", "--help"], {
      encoding: "utf-8",
      env: ISOLATED_ENV,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.includes("--harness") && out.includes("--resume-cmd");
  } catch {
    return false;
  }
}

const CLI_READY = detectCli();
const SKIP_REASON = "yahir-handoff with --harness/--resume-cmd is not on PATH";

let core: typeof import("../commands-gsd-core.ts");
let notice: typeof import("../handoff-notice.ts");
let rec: typeof import("../handoff-record.ts");
let client: typeof import("../handoff-client.ts");
let cmdContext: typeof import("../commands/context.ts");
let gsdDb: typeof import("../gsd-db.ts");
let runtimeKv: typeof import("../db/runtime-kv.ts");
let interrupted: typeof import("../interrupted-session.ts");

before(async () => {
  if (!CLI_READY) return;
  runtimeKv = await import("../db/runtime-kv.ts");
  interrupted = await import("../interrupted-session.ts");
  gsdDb = await import("../gsd-db.ts");
  cmdContext = await import("../commands/context.ts");
  rec = await import("../handoff-record.ts");
  client = await import("../handoff-client.ts");
  notice = await import("../handoff-notice.ts");
  core = await import("../commands-gsd-core.ts");
});

after(() => {
  if (savedGsdHome === undefined) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = savedGsdHome;
  rmSync(tempGsdHome, { recursive: true, force: true });
  rmSync(CONTRACT_ROOT, { recursive: true, force: true });
});

const tempDirs = new Set<string>();

afterEach(() => {
  try {
    gsdDb?.closeDatabase();
  } catch {
    /* noop */
  }
  cleanupTempDirs(tempDirs);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const ID_RE = /^ho_[0-9]{4}_[0-9a-f]{4}$/;

function makeProject(): string {
  return makeTempGsdProject(tempDirs, { git: "real" });
}

function inProject<T>(proj: string, fn: () => Promise<T>): Promise<T> {
  return cmdContext.withCommandCwd(proj, fn);
}

/** Run /gsd pause-work through the real handler and the real CLI; returns the stored record. */
async function pauseWork(proj: string, sessionId: string) {
  const ctx = makeHandoffCtx(proj, { sessionId });
  const pi = makeRecordingPi();
  await inProject(proj, () => core.handlePauseWork("", ctx as any, pi as any, { env: ISOLATED_ENV }));
  return { ctx, pi, record: rec.readStoredHandoff() };
}

async function show(proj: string, id: string) {
  const result = await client.showHandoff(id, { cwd: proj, env: ISOLATED_ENV });
  assert.equal(result.ok, true, `show ${id} ok: ${JSON.stringify(result)}`);
  if (result.ok !== true) throw new Error("unreachable");
  return result.value;
}

/** Create an entry written by another harness (or plain `any`) with the real CLI; returns its id. */
function createForeign(proj: string, extraArgs: string[], title: string): string {
  const out = execFileSync("yahir-handoff", ["create", "--json", `--title=${title}`, ...extraArgs], {
    encoding: "utf-8",
    input: FIVE_SECTION_BODY,
    env: ISOLATED_ENV,
    cwd: proj,
    timeout: 15_000,
  });
  const id = JSON.parse(out)?.result?.id;
  assert.match(id, ID_RE);
  return id;
}

function warnings(ctx: { notifications: Array<{ message: string; level: string }> }) {
  return ctx.notifications.filter((n) => n.level === "warning");
}

// ─── Tracer ─────────────────────────────────────────────────────────────────

test(
  "HANDOFF-01 e2e tracer: pause-work registers a real handoff, a fresh startup notice lists it, and resume-work takes it and leaves it done",
  { skip: CLI_READY ? false : SKIP_REASON },
  async () => {
    const proj = makeProject();

    // (1) pause-work registers through the real CLI
    const { pi: piA, record } = await pauseWork(proj, "sess-A");
    assert.equal(piA.sent.length, 1, "pause-work dispatches its prompt once");
    assert.ok(record, "ownership record stored");
    assert.match(record.id, ID_RE);
    assert.equal(record.hadPausedSession, false);

    // (2) the real template validator accepted a y-pi-gsd entry
    const shown = await show(proj, record.id);
    assert.equal(shown.state, "open");
    assert.equal(shown.harness, "y-pi-gsd");
    assert.equal(shown.resumeCmd, "/gsd resume-work");
    for (const heading of ["## Goal", "## State", "## Next steps", "## Open decisions", "## Gotchas"]) {
      assert.ok(shown.body?.includes(heading), `body has ${heading}`);
    }

    // (3) a fresh startup notice (a different session) lists it
    const ctxB = makeHandoffCtx(proj, { sessionId: "sess-B", hasUI: true });
    await notice.showStartupNotice({ reason: "startup", autoActive: false, autoPaused: false }, ctxB as any, proj, {
      env: ISOLATED_ENV,
    });
    const infos = ctxB.notifications.filter((n) => n.level === "info");
    assert.equal(infos.length, 1, JSON.stringify(ctxB.notifications));
    assert.ok(infos[0].message.startsWith("Handoff waiting: "), infos[0].message);
    assert.ok(infos[0].message.endsWith(`— /gsd resume-work (${record.id})`), infos[0].message);
    assert.ok(!infos[0].message.includes("/handoff take"));
    assert.ok(!infos[0].message.includes("/gsd-resume-work"));

    // (4) resume-work from another session takes it, dispatches the prompt and leaves it done
    const ctxC = makeHandoffCtx(proj, { sessionId: "sess-B" });
    const piC = makeRecordingPi();
    await inProject(proj, () => core.handleResumeWork("", ctxC as any, piC as any, { env: ISOLATED_ENV }));
    assert.equal(piC.sent.length, 1, JSON.stringify(ctxC.notifications));
    assert.ok(String(piC.sent[0].message.content).includes(record.id));
    assert.equal((await show(proj, record.id)).state, "done");
    assert.equal(rec.readStoredHandoff(), null, "record cleared");
  },
);

// ─── Contract matrix ────────────────────────────────────────────────────────

test("HANDOFF-01 contract: re-pausing supersedes an open stored entry", { skip: CLI_READY ? false : SKIP_REASON }, async () => {
  const proj = makeProject();
  const first = (await pauseWork(proj, "sess-1")).record;
  assert.ok(first);
  const second = (await pauseWork(proj, "sess-1")).record;
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  assert.equal((await show(proj, first.id)).state, "superseded");
  assert.equal((await show(proj, second.id)).state, "open");
  assert.equal(rec.readStoredHandoff()?.id, second.id);
});

test("HANDOFF-01 contract: re-pausing supersedes a taken stored entry", { skip: CLI_READY ? false : SKIP_REASON }, async () => {
  const proj = makeProject();
  const first = (await pauseWork(proj, "sess-1")).record;
  assert.ok(first);
  const taken = await client.takeHandoff(first.id, { cwd: proj, env: ISOLATED_ENV, sessionId: "sess-X" });
  assert.equal(taken.ok, true);
  const second = (await pauseWork(proj, "sess-1")).record;
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  assert.equal((await show(proj, first.id)).state, "superseded");
});

test("HANDOFF-01 contract: a done stored entry leads to a plain create", { skip: CLI_READY ? false : SKIP_REASON }, async () => {
  const proj = makeProject();
  const first = (await pauseWork(proj, "sess-1")).record;
  assert.ok(first);
  const done = await client.doneHandoff(first.id, { cwd: proj, env: ISOLATED_ENV });
  assert.equal(done.ok, true);
  const again = await pauseWork(proj, "sess-1");
  assert.deepEqual(warnings(again.ctx), [], "no warning when the old entry is already done");
  assert.ok(again.record);
  assert.notEqual(again.record.id, first.id);
  assert.equal((await show(proj, first.id)).state, "done");
  assert.equal(rec.readStoredHandoff()?.id, again.record.id);
});

test("HANDOFF-01 contract: exit codes map to typed failures and a same-session retake is idempotent", { skip: CLI_READY ? false : SKIP_REASON }, async () => {
  const proj = makeProject();
  const created = await client.createHandoff({ title: "y-pi-gsd paused: exit codes", body: FIVE_SECTION_BODY }, {
    cwd: proj,
    env: ISOLATED_ENV,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (created.ok !== true) return;
  const id = created.value.id;
  const base = { cwd: proj, env: ISOLATED_ENV };

  assert.equal((await client.takeHandoff(id, { ...base, sessionId: "s1" })).ok, true);
  assert.equal((await client.takeHandoff(id, { ...base, sessionId: "s1" })).ok, true, "same session retake (D-13 C)");
  const conflict = await client.takeHandoff(id, { ...base, sessionId: "s2" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ok === false && conflict.kind, "conflict");

  assert.equal((await client.doneHandoff(id, base)).ok, true);
  const twice = await client.doneHandoff(id, base);
  assert.equal(twice.ok === false && twice.kind, "not-allowed");

  const missing = await client.showHandoff("ho_0101_0000", base);
  assert.equal(missing.ok === false && missing.kind, "not-found");

  const empty = await client.createHandoff({ title: "y-pi-gsd paused: empty", body: "" }, base);
  assert.equal(empty.ok === false && empty.kind, "usage");
});

test("HANDOFF-01 contract: a paused-session resume re-enters auto without closing, and activation close leaves it done", { skip: CLI_READY ? false : SKIP_REASON }, async () => {
  const proj = makeProject();
  gsdDb.openDatabase(join(proj, ".gsd", "gsd.db"));
  runtimeKv.setRuntimeKv("global", "", interrupted.PAUSED_SESSION_KV_KEY, {
    milestoneId: "M001",
    pausedAt: new Date().toISOString(),
    stepMode: false,
  });
  gsdDb.closeDatabase();

  const { record } = await pauseWork(proj, "sess-A");
  assert.ok(record);
  assert.equal(record.hadPausedSession, true);

  const ctx = makeHandoffCtx(proj, { sessionId: "sess-B" });
  const pi = makeRecordingPi();
  const dispatched: string[] = [];
  await inProject(proj, () =>
    core.handleResumeWork("", ctx as any, pi as any, {
      env: ISOLATED_ENV,
      dispatchCommand: async (c) => {
        dispatched.push(c);
      },
    }),
  );
  assert.deepEqual(dispatched, ["auto"], JSON.stringify(ctx.notifications));
  assert.equal(pi.sent.length, 0, "no prompt on mechanical re-entry");
  assert.equal((await show(proj, record.id)).state, "taken");

  // the activation close wired in auto.ts (45-04)
  const closed = await rec.closeStoredHandoff("done", proj, {
    requirePausedSessionLink: true,
    env: ISOLATED_ENV,
    sessionId: "sess-B",
  });
  assert.equal(closed.status, "closed", JSON.stringify(closed));
  assert.equal((await show(proj, record.id)).state, "done");
  assert.equal(rec.readStoredHandoff(), null);
});

test("HANDOFF-01 contract: an any-harness handoff is listed as another harness, never taken id-less, and taken by explicit id as untrusted prose", { skip: CLI_READY ? false : SKIP_REASON }, async () => {
  const proj = makeProject();
  const id = createForeign(proj, [], "Other harness work");

  const ctxN = makeHandoffCtx(proj, { sessionId: "sess-N", hasUI: true });
  await notice.showStartupNotice({ reason: "startup", autoActive: false, autoPaused: false }, ctxN as any, proj, {
    env: ISOLATED_ENV,
  });
  const note = ctxN.notifications.find((n) => n.level === "info");
  assert.ok(note, JSON.stringify(ctxN.notifications));
  assert.ok(note.message.includes("Handoff waiting (written by another harness): Other harness work"), note.message);
  assert.ok(note.message.includes(`/gsd resume-work ${id}`), note.message);

  // id-less resume-work with no stored record never touches it
  const ctxR = makeHandoffCtx(proj, { sessionId: "sess-R" });
  const piR = makeRecordingPi();
  await inProject(proj, () => core.handleResumeWork("", ctxR as any, piR as any, { env: ISOLATED_ENV }));
  assert.equal((await show(proj, id)).state, "open");

  // explicit id picks it up as untrusted prose and closes it done
  const ctxP = makeHandoffCtx(proj, { sessionId: "sess-P" });
  const piP = makeRecordingPi();
  await inProject(proj, () => core.handleResumeWork(id, ctxP as any, piP as any, { env: ISOLATED_ENV }));
  assert.equal(piP.sent.length, 1, JSON.stringify(ctxP.notifications));
  assert.ok(String(piP.sent[0].message.content).includes("BEGIN (untrusted)"));
  assert.equal((await show(proj, id)).state, "done");
});

test("HANDOFF-01 contract: a claude-code handoff is refused and stays open", { skip: CLI_READY ? false : SKIP_REASON }, async () => {
  const proj = makeProject();
  const id = createForeign(proj, ["--harness", "claude-code", "--resume-cmd", "claude --resume {id}"], "Claude Code work");

  const ctx = makeHandoffCtx(proj, { sessionId: "sess-R" });
  const pi = makeRecordingPi();
  await inProject(proj, () => core.handleResumeWork(id, ctx as any, pi as any, { env: ISOLATED_ENV }));
  const warns = warnings(ctx);
  assert.equal(warns.length, 1, JSON.stringify(ctx.notifications));
  assert.ok(warns[0].message.includes("claude-code"), warns[0].message);
  assert.equal(pi.sent.length, 0);
  assert.equal((await show(proj, id)).state, "open");

  const ctxN = makeHandoffCtx(proj, { sessionId: "sess-N", hasUI: true });
  await notice.showStartupNotice({ reason: "startup", autoActive: false, autoPaused: false }, ctxN as any, proj, {
    env: ISOLATED_ENV,
  });
  const note = ctxN.notifications.find((n) => n.level === "info");
  assert.ok(note, JSON.stringify(ctxN.notifications));
  assert.ok(note.message.includes(`yahir-handoff show ${id}`), note.message);
});

test("HANDOFF-01 contract: a y-pi-gsd handoff this project did not record is refused and stays open", { skip: CLI_READY ? false : SKIP_REASON }, async () => {
  const proj = makeProject();
  const own = (await pauseWork(proj, "sess-A")).record;
  assert.ok(own, "a different stored record exists");
  const other = await client.createHandoff({ title: "y-pi-gsd paused: unrecorded", body: FIVE_SECTION_BODY }, {
    cwd: proj,
    env: ISOLATED_ENV,
  });
  assert.equal(other.ok, true, JSON.stringify(other));
  if (other.ok !== true) return;

  const ctx = makeHandoffCtx(proj, { sessionId: "sess-B" });
  const pi = makeRecordingPi();
  await inProject(proj, () => core.handleResumeWork(other.value.id, ctx as any, pi as any, { env: ISOLATED_ENV }));
  const warns = warnings(ctx);
  assert.equal(warns.length, 1, JSON.stringify(ctx.notifications));
  assert.ok(warns[0].message.includes("did not record"), warns[0].message);
  assert.equal(pi.sent.length, 0);
  assert.equal((await show(proj, other.value.id)).state, "open");
  assert.equal((await show(proj, own.id)).state, "open", "own entry untouched");
});
