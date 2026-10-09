// Project/App: gsd-pi
// File Purpose: HANDOFF-01 pause side — /gsd pause-work and /gsd pause register a five-section
// y-pi-gsd handoff mechanically (D-01/D-03), supersede only open/taken entries (D-04) and fail
// open (D-09). Temp project DBs and injected fake runners (or a stub CLI on PATH); the real
// yahir-handoff is never resolved.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupTempDirs,
  fakeHandoffRunner,
  handoffEntry,
  makeHandoffCtx,
  makeRecordingPi,
  makeTempGsdProject,
  runOk,
} from "./handoff-test-helpers.ts";

// GSD_HOME must point at a temp dir before any project module loads.
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-handoff-pause-home-"));
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
