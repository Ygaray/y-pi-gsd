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

before(async () => {
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
function projectWithRecord(id = OWN_ID, extra: Record<string, unknown> = {}): string {
  const root = makeTempGsdProject(tempDirs);
  gsdDb.openDatabase(join(root, ".gsd", "gsd.db"));
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
  gsdDb.closeDatabase();
  return root;
}

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
