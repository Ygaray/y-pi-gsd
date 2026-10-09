// Project/App: gsd-pi
// File Purpose: HANDOFF-01 client — the real runner against a stub yahir-handoff on a
// filtered PATH (tracer, failure taxonomy) plus an injected runner for argv/parse cases.
// No automated test can resolve or run the real yahir-handoff (T-45-02).

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIVE_SECTION_BODY,
  cleanupTempDirs,
  envelope,
  fakeHandoffRunner,
  handoffEntry,
  makeHandoffStub,
  makeTempGsdProject,
  pathWithoutRealYahirHandoff,
  readStubCalls,
  withEnv,
  withPath,
} from "./handoff-test-helpers.ts";

// GSD_HOME must point at a temp dir before any project module loads.
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-handoff-home-"));
process.env.GSD_HOME = tempGsdHome;

let client: typeof import("../handoff-client.ts");

before(async () => {
  client = await import("../handoff-client.ts");
});

after(() => {
  if (savedGsdHome === undefined) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = savedGsdHome;
  rmSync(tempGsdHome, { recursive: true, force: true });
});

const tempDirs = new Set<string>();

afterEach(() => cleanupTempDirs(tempDirs));

test("HANDOFF-01 client tracer: createHandoff pipes the body on stdin to yahir-handoff create with the y-pi-gsd harness, the project cwd, a scrubbed session env and the isolated store", async () => {
  const project = makeTempGsdProject(tempDirs);
  const stub = makeHandoffStub(tempDirs, { create: { stdout: envelope(handoffEntry({ id: "ho_1009_abcd" })) } });
  const result = await withPath(`${stub}:${pathWithoutRealYahirHandoff()}`, () =>
    withEnv({ CLAUDE_CODE_SESSION_ID: "cc-outer" }, () =>
      client.createHandoff(
        { title: "y-pi-gsd paused: tracer", body: FIVE_SECTION_BODY },
        { cwd: project, sessionId: "sess-1" },
      ),
    ),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, "ho_1009_abcd");
  assert.equal(result.value.harness, "y-pi-gsd");

  const calls = readStubCalls(stub);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, [
    "create",
    "--json",
    "--harness",
    "y-pi-gsd",
    "--resume-cmd",
    "/gsd resume-work",
    "--title=y-pi-gsd paused: tracer",
  ]);
  assert.equal(calls[0].stdin, FIVE_SECTION_BODY);
  assert.equal(calls[0].env.YAHIR_HANDOFF_SESSION_ID, "sess-1");
  assert.equal(calls[0].env.CLAUDE_CODE_SESSION_ID, "<unset>");
  assert.equal(calls[0].env.YAHIR_HANDOFF_ROOT, process.env.YAHIR_HANDOFF_ROOT);
  assert.equal(calls[0].env.PWD, realpathSync(project));
});
