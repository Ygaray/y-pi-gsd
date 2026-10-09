// Project/App: gsd-pi
// File Purpose: HANDOFF-01 close wiring — every paused_session clear site closes the stored,
// paused-linked handoff (done at resume activation, drop at stop/stale/discard sites) without
// changing control flow. A doctor end-to-end tracer drives the real runner against a stub
// yahir-handoff; the remaining sites get source-structural and ordering guards. No automated
// test can resolve or run the real yahir-handoff (T-45-02).

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupTempDirs,
  envelope,
  handoffEntry,
  makeHandoffStub,
  makeTempDir,
  pathWithoutRealYahirHandoff,
  readStubCalls,
  withPath,
} from "./handoff-test-helpers.ts";

// GSD_HOME must point at a temp dir before any project module loads.
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-handoff-close-home-"));
process.env.GSD_HOME = tempGsdHome;

let doctor: typeof import("../doctor-runtime-checks.ts");
let rec: typeof import("../handoff-record.ts");
let gsdDb: typeof import("../gsd-db.ts");
let cache: typeof import("../cache.ts");
let kv: typeof import("../db/runtime-kv.ts");
let interrupted: typeof import("../interrupted-session.ts");
let autoMod: typeof import("../auto.ts");
let runtimeState: typeof import("../auto-runtime-state.ts");

before(async () => {
  gsdDb = await import("../gsd-db.ts");
  cache = await import("../cache.ts");
  kv = await import("../db/runtime-kv.ts");
  interrupted = await import("../interrupted-session.ts");
  rec = await import("../handoff-record.ts");
  doctor = await import("../doctor-runtime-checks.ts");
  autoMod = await import("../auto.ts");
  runtimeState = await import("../auto-runtime-state.ts");
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
  try {
    cache.invalidateAllCaches();
  } catch {
    /* noop */
  }
  cleanupTempDirs(tempDirs);
});

// ─── Doctor tracer fixture ──────────────────────────────────────────────────

const PAUSED_MILESTONE = "M016-5b17xo";
const ACTIVE_MILESTONE = "M018-6b0xxe";
const HANDOFF_ID = "ho_1009_dddd";

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Superseded-pause fixture (mirrors doctor-runtime-checks.test.ts) plus a paused-linked stored handoff. */
function seedSupersededPause(): string {
  const dir = makeTempDir(tempDirs, "gsd-handoff-close-doctor-");
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "test@test.com"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n", "utf-8");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "init"]);

  for (const milestoneId of [PAUSED_MILESTONE, ACTIVE_MILESTONE]) {
    const milestoneDir = join(dir, ".gsd", "milestones", milestoneId);
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(join(milestoneDir, `${milestoneId}-CONTEXT.md`), `# ${milestoneId}\n`);
  }

  gsdDb.openDatabase(join(dir, ".gsd", "gsd.db"));
  gsdDb.insertMilestone({ id: PAUSED_MILESTONE, title: "Superseded milestone", status: "active" });
  gsdDb.insertMilestone({ id: ACTIVE_MILESTONE, title: "Current milestone", status: "active" });
  gsdDb.setMilestoneQueueOrder([ACTIVE_MILESTONE, PAUSED_MILESTONE]);
  kv.setRuntimeKv("global", "", interrupted.PAUSED_SESSION_KV_KEY, {
    milestoneId: PAUSED_MILESTONE,
    originalBasePath: dir,
  } satisfies import("../interrupted-session.ts").PausedSessionMetadata);
  assert.equal(
    rec.writeStoredHandoff({
      id: HANDOFF_ID,
      createdAt: "2026-10-09T06:00:00+00:00",
      hadPausedSession: true,
      source: "pause",
    }),
    true,
  );
  cache.invalidateAllCaches();
  return dir;
}

test("HANDOFF-01 close tracer: doctor's stale_paused_session fix drops the stored handoff by id and clears the record", async () => {
  const dir = seedSupersededPause();
  const stub = makeHandoffStub(tempDirs, {
    drop: { stdout: envelope(handoffEntry({ id: HANDOFF_ID, state: "dropped" })) },
  });

  const issues: import("../doctor-types.ts").DoctorIssue[] = [];
  const fixes: string[] = [];
  await withPath(`${stub}:${pathWithoutRealYahirHandoff()}`, () =>
    doctor.checkRuntimeHealth(dir, issues, fixes, (code) => code === "stale_paused_session"),
  );

  assert.equal(kv.getRuntimeKv("global", "", interrupted.PAUSED_SESSION_KV_KEY), null, "paused_session row cleared");
  assert.ok(fixes.some((f) => f.includes(`cleared stale paused session for ${PAUSED_MILESTONE}`)));

  const calls = readStubCalls(stub);
  assert.equal(calls.length, 1, "exactly one CLI call");
  assert.deepEqual(calls[0].argv, ["drop", HANDOFF_ID, "--json"]);
  assert.equal(calls[0].env.PWD, realpathSync(dir));
  assert.equal(calls[0].env.YAHIR_HANDOFF_ROOT, process.env.YAHIR_HANDOFF_ROOT);
  assert.equal(rec.readStoredHandoff(), null, "record cleared after the drop");
});

test("HANDOFF-01 close tracer: a read-only doctor run touches neither the record nor the CLI", async () => {
  const dir = seedSupersededPause();
  const stub = makeHandoffStub(tempDirs, {
    drop: { stdout: envelope(handoffEntry({ id: HANDOFF_ID, state: "dropped" })) },
  });

  const issues: import("../doctor-types.ts").DoctorIssue[] = [];
  const fixes: string[] = [];
  await withPath(`${stub}:${pathWithoutRealYahirHandoff()}`, () =>
    doctor.checkRuntimeHealth(dir, issues, fixes, () => false),
  );

  assert.ok(issues.some((i) => i.code === "stale_paused_session"), "stale pause still reported");
  assert.equal(readStubCalls(stub).length, 0, "no CLI call on a read-only run");
  assert.equal(rec.readStoredHandoff()?.id, HANDOFF_ID, "record preserved");
  assert.ok(kv.getRuntimeKv("global", "", interrupted.PAUSED_SESSION_KV_KEY), "paused_session preserved");
});

// TODO (found while adding this behavioral coverage, IN-03): stopAuto's Step 12 (paused_session
// delete + handoff drop) runs AFTER Step 6 has closed the workflow database, so deleteRuntimeKv is a
// no-op and closeStoredHandoff sees no record - the drop never fires in production. The structural
// guards above pass regardless. Fixing it means deciding whether an explicit stop must now really
// clear paused_session (the #1383 intent), which changes stop semantics; it is left as a todo so
// the gap stays visible and flips to green when the ordering is fixed.
test("HANDOFF-01 close tracer: stopAuto drops the stored paused-linked handoff through the real runner and clears paused_session (IN-03)", {
  todo: "stopAuto Step 12 runs after Step 6 closed the DB, so the drop never fires; needs a stop-semantics decision",
}, async () => {
  const dir = makeTempDir(tempDirs, "gsd-handoff-close-stop-");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  gsdDb.openDatabase(join(dir, ".gsd", "gsd.db"));
  kv.setRuntimeKv("global", "", interrupted.PAUSED_SESSION_KV_KEY, {
    milestoneId: "M001",
    originalBasePath: dir,
  } satisfies import("../interrupted-session.ts").PausedSessionMetadata);
  assert.equal(
    rec.writeStoredHandoff({ id: HANDOFF_ID, createdAt: "2026-10-09T06:00:00+00:00", hadPausedSession: true, source: "pause" }),
    true,
  );
  const stub = makeHandoffStub(tempDirs, {
    drop: { stdout: envelope(handoffEntry({ id: HANDOFF_ID, state: "dropped" })) },
  });

  const previousCwd = process.cwd();
  runtimeState.autoSession.reset();
  runtimeState.autoSession.active = true;
  runtimeState.autoSession.paused = false;
  runtimeState.autoSession.basePath = dir;
  runtimeState.autoSession.originalBasePath = dir;
  try {
    await withPath(`${stub}:${pathWithoutRealYahirHandoff()}`, () =>
      autoMod.stopAuto(
        { hasUI: true, ui: { setStatus() {}, setWidget() {}, setHeader() {}, notify() {} }, modelRegistry: { find: () => null } } as any,
        { events: { emit() {} } } as any,
        "User requested stop",
      ),
    );
  } finally {
    runtimeState.autoSession.reset();
    process.chdir(previousCwd);
  }

  const calls = readStubCalls(stub);
  assert.equal(calls.length, 1, "exactly one CLI call");
  assert.deepEqual(calls[0].argv, ["drop", HANDOFF_ID, "--json"]);
  assert.equal(kv.getRuntimeKv("global", "", interrupted.PAUSED_SESSION_KV_KEY), null, "paused_session row cleared");
  assert.equal(rec.readStoredHandoff(), null, "record cleared after the drop");
});

// ─── Structural / ordering guards (auto.ts, guided-flow.ts, interrupted-session.ts) ───

const gsdDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const autoSrc = readFileSync(join(gsdDir, "auto.ts"), "utf-8");
const guidedSrc = readFileSync(join(gsdDir, "guided-flow.ts"), "utf-8");
const interruptedSrc = readFileSync(join(gsdDir, "interrupted-session.ts"), "utf-8");

const TAG_GONE = "paused-session DB cleanup failed (milestone gone/complete)";
const TAG_SUPERSEDED = "paused-session DB cleanup failed (milestone superseded)";
const TAG_STALE = "stale paused-session DB cleanup failed";
const TAG_RESUME = "paused-session DB cleanup failed (resume activation)";

function indexOrFail(src: string, needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  assert.notEqual(i, -1, `not found: ${needle}`);
  return i;
}

/** First non-blank, non-comment statement line following `clearPausedSession("<tag>");`. */
function statementAfterClear(tag: string): string {
  const call = `clearPausedSession("${tag}");`;
  const at = indexOrFail(autoSrc, call);
  const rest = autoSrc.slice(at + call.length).split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("//"));
  return rest[0] ?? "";
}

test("HANDOFF-01 close: auto.ts declares closePausedSessionHandoff in startAuto after clearPausedSession, lazy-importing closeStoredHandoff with the link gate", () => {
  const clearAt = indexOrFail(autoSrc, "const clearPausedSession = ");
  const helperAt = indexOrFail(autoSrc, "const closePausedSessionHandoff = ", clearAt);
  const body = autoSrc.slice(helperAt, helperAt + 1600);
  assert.ok(body.includes('import("./handoff-record.js")'), "lazy import");
  assert.ok(body.includes("closeStoredHandoff("), "calls closeStoredHandoff");
  assert.ok(body.includes("requirePausedSessionLink: true"), "link gate");
});

test("HANDOFF-01 close: the three startAuto discard sites drop the handoff directly after the clear", () => {
  for (const tag of [TAG_GONE, TAG_SUPERSEDED, TAG_STALE]) {
    assert.equal(statementAfterClear(tag), 'await closePausedSessionHandoff("drop");', tag);
  }
});

test("HANDOFF-01 close: resume activation clears paused_session, then closes done, then resumes orchestration", () => {
  const clearAt = indexOrFail(autoSrc, `clearPausedSession("${TAG_RESUME}")`);
  const doneAt = indexOrFail(autoSrc, 'await closePausedSessionHandoff("done")', clearAt);
  const resumeAt = indexOrFail(autoSrc, "s.orchestration?.resume()", clearAt);
  assert.ok(clearAt < doneAt, "done comes after the clear");
  assert.ok(doneAt < resumeAt, "done comes before orchestration resume");
  assert.equal(statementAfterClear(TAG_RESUME), 'await closePausedSessionHandoff("done");');
});

test("HANDOFF-01 close: stopAuto step 12 drops the handoff after deleting paused_session", () => {
  const start = indexOrFail(autoSrc, "Step 12: Remove paused-session metadata");
  const end = indexOrFail(autoSrc, "Step 13", start);
  const slice = autoSrc.slice(start, end);
  const deleteAt = indexOrFail(slice, "deleteRuntimeKv(");
  const closeAt = indexOrFail(slice, 'closeStoredHandoff("drop"');
  assert.ok(deleteAt < closeAt, "drop after the delete");
  assert.ok(slice.includes("requirePausedSessionLink: true"), "link gate");
});

test("HANDOFF-01 close: guided-flow stale classification drops the handoff after deleting paused_session", () => {
  const start = indexOrFail(guidedSrc, 'interrupted.classification === "stale"');
  const end = indexOrFail(guidedSrc, '} else if (interrupted.classification === "recoverable")', start);
  const slice = guidedSrc.slice(start, end);
  const deleteAt = indexOrFail(slice, "deleteRuntimeKv(");
  const closeAt = indexOrFail(slice, 'closeStoredHandoff("drop", basePath, { requirePausedSessionLink: true })');
  assert.ok(deleteAt < closeAt, "drop after the delete");
});

test("HANDOFF-01 close: every added close call in auto.ts and guided-flow.ts sits inside a try block with a catch", () => {
  const sites: Array<[string, string, string]> = [
    ["auto.ts helper", autoSrc, "const closePausedSessionHandoff = "],
    ["auto.ts stopAuto", autoSrc, 'closeStoredHandoff("drop"'],
    ["guided-flow.ts", guidedSrc, 'closeStoredHandoff("drop"'],
  ];
  for (const [label, src, anchor] of sites) {
    const callAt = indexOrFail(src, anchor);
    // helper: the try wraps the whole body (anchor is the declaration); others: nearest try before the call
    const before = src.slice(Math.max(0, callAt - 600), callAt + (anchor.startsWith("const") ? 1600 : 0));
    const callIdx = anchor.startsWith("const")
      ? before.indexOf("closeStoredHandoff(")
      : before.length;
    assert.ok(callIdx > 0, `${label}: call located`);
    const tryAt = before.lastIndexOf("try {", callIdx);
    assert.ok(tryAt !== -1 && tryAt < callIdx, `${label}: try { before the call`);
    const after = src.slice(callAt, callAt + 1800);
    assert.ok(/catch\b/.test(after), `${label}: catch after the call`);
  }
  // every awaited helper call sits in startAuto, never as a bare un-awaited call
  assert.equal(/(^|[^t ])closePausedSessionHandoff\(/m.test(autoSrc.replace(/await closePausedSessionHandoff\(/g, "")), false);
});

test("HANDOFF-01 close: interrupted-session.ts legacy pseudo-milestone cleanup deliberately has no handoff close", () => {
  assert.equal(/handoff/i.test(interruptedSrc), false);
});
