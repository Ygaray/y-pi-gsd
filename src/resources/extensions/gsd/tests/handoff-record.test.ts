// Project/App: gsd-pi
// File Purpose: HANDOFF-01 record — the y_pi_gsd_handoff ownership record in runtime_kv and
// closeStoredHandoff (done/drop by stored id, link-gated), on a temp project DB with an
// injected fake runner. No real yahir-handoff is ever resolved.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupTempDirs,
  fakeHandoffRunner,
  handoffEntry,
  makeTempGsdProject,
  runEnoent,
  runExit,
  runOk,
  runTimeout,
} from "./handoff-test-helpers.ts";

// GSD_HOME must point at a temp dir before any project module loads.
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-handoff-record-home-"));
process.env.GSD_HOME = tempGsdHome;

let rec: typeof import("../handoff-record.ts");
let gsdDb: typeof import("../gsd-db.ts");

before(async () => {
  gsdDb = await import("../gsd-db.ts");
  rec = await import("../handoff-record.ts");
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

function openProject(): string {
  const project = makeTempGsdProject(tempDirs);
  gsdDb.openDatabase(join(project, ".gsd", "gsd.db"));
  return project;
}

const RECORD = {
  id: "ho_1009_abcd",
  createdAt: "2026-10-09T06:00:00+00:00",
  hadPausedSession: true,
  source: "pause" as const,
};

function seed(record: Partial<typeof RECORD> | Record<string, unknown> = {}): void {
  assert.equal(rec.writeStoredHandoff({ ...RECORD, ...record } as any), true);
}

test("HANDOFF-01 record: write/read/clear round trip under the y_pi_gsd_handoff key", () => {
  openProject();
  assert.equal(rec.HANDOFF_KV_KEY, "y_pi_gsd_handoff");
  assert.equal(rec.writeStoredHandoff(RECORD), true);
  assert.deepEqual(rec.readStoredHandoff(), RECORD);
  const row = gsdDb._getAdapter()!
    .prepare("SELECT key FROM runtime_kv WHERE scope = 'global' AND key = :k")
    .get({ ":k": "y_pi_gsd_handoff" });
  assert.ok(row, "raw runtime_kv row exists under the key");
  rec.clearStoredHandoff();
  assert.equal(rec.readStoredHandoff(), null);
});

test("HANDOFF-01 record: malformed rows read as null", () => {
  openProject();
  for (const bad of [{ id: "nope" }, { hadPausedSession: "yes" }, { source: "other" }, { createdAt: 5 }]) {
    assert.equal(rec.writeStoredHandoff({ ...RECORD, ...bad } as any), true);
    assert.equal(rec.readStoredHandoff(), null, JSON.stringify(bad));
  }
});

test("HANDOFF-01 record: without a DB writes return false and reads return null without throwing", () => {
  openProject();
  gsdDb.closeDatabase();
  assert.equal(rec.writeStoredHandoff(RECORD), false);
  assert.equal(rec.readStoredHandoff(), null);
  assert.doesNotThrow(() => rec.clearStoredHandoff());
});

for (const [outcome, verb, state] of [
  ["done", "done", "done"],
  ["drop", "drop", "dropped"],
] as const) {
  test(`HANDOFF-01 record: ${outcome} closes the stored id and clears the record`, async () => {
    const project = openProject();
    seed();
    const fake = fakeHandoffRunner({ [verb]: runOk(handoffEntry({ state })) });
    const out = await rec.closeStoredHandoff(outcome, project, { run: fake.run });
    assert.equal(out.status, "closed");
    assert.deepEqual(fake.calls.map((c) => c.argv), [[verb, "ho_1009_abcd", "--json"]]);
    assert.equal(rec.readStoredHandoff(), null);
  });
}

test("HANDOFF-01 record: exit 6 and exit 9 mean already-closed and clear the record", async () => {
  for (const code of [6, 9]) {
    const project = openProject();
    seed();
    const fake = fakeHandoffRunner({ done: runExit(code, "gone") });
    const out = await rec.closeStoredHandoff("done", project, { run: fake.run });
    assert.equal(out.status, "already-closed");
    assert.equal(rec.readStoredHandoff(), null);
    gsdDb.closeDatabase();
  }
});

test("HANDOFF-01 record: other failures keep the record and warn exactly once", async () => {
  for (const reply of [runExit(11, "busy store"), runTimeout(), runEnoent()]) {
    const project = openProject();
    seed();
    const warnings: string[] = [];
    const fake = fakeHandoffRunner({ done: reply });
    const out = await rec.closeStoredHandoff("done", project, { run: fake.run, onWarning: (m) => warnings.push(m) });
    assert.equal(out.status, "failed");
    assert.deepEqual(rec.readStoredHandoff(), RECORD);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /yahir-handoff/);
    assert.equal(warnings[0], out.message);
    gsdDb.closeDatabase();
  }
});

test("HANDOFF-01 record: no record means no CLI call", async () => {
  const project = openProject();
  const fake = fakeHandoffRunner({ done: runOk(handoffEntry()) });
  const out = await rec.closeStoredHandoff("done", project, { run: fake.run });
  assert.equal(out.status, "no-record");
  assert.equal(fake.calls.length, 0);
});

test("HANDOFF-01 record: the paused-session link gate skips records registered without a paused_session", async () => {
  const project = openProject();
  seed({ hadPausedSession: false });
  const fake = fakeHandoffRunner({ drop: runOk(handoffEntry({ state: "dropped" })) });
  const gated = await rec.closeStoredHandoff("drop", project, { run: fake.run, requirePausedSessionLink: true });
  assert.equal(gated.status, "skipped-unlinked");
  assert.equal(fake.calls.length, 0);
  assert.equal(rec.readStoredHandoff()?.id, "ho_1009_abcd");
  const open = await rec.closeStoredHandoff("drop", project, { run: fake.run });
  assert.equal(open.status, "closed");
  assert.equal(fake.calls.length, 1);
});

test("HANDOFF-01 record: a vanished base path falls back to process.cwd()", async () => {
  openProject();
  seed();
  const fake = fakeHandoffRunner({ done: runOk(handoffEntry({ state: "done" })) });
  const out = await rec.closeStoredHandoff("done", join(tmpdir(), "gsd-handoff-definitely-missing-dir"), { run: fake.run });
  assert.equal(out.status, "closed");
  assert.equal(fake.calls[0].opts.cwd, process.cwd());
});

test("HANDOFF-01 record: a rejecting runner is failed with the record kept and never throws", async () => {
  const project = openProject();
  seed();
  const out = await rec.closeStoredHandoff("done", project, {
    run: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(out.status, "failed");
  assert.deepEqual(rec.readStoredHandoff(), RECORD);
});
