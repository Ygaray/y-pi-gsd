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

before(async () => {
  gsdDb = await import("../gsd-db.ts");
  cache = await import("../cache.ts");
  kv = await import("../db/runtime-kv.ts");
  interrupted = await import("../interrupted-session.ts");
  rec = await import("../handoff-record.ts");
  doctor = await import("../doctor-runtime-checks.ts");
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
