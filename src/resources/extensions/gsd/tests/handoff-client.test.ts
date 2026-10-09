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
  errorEnvelope,
  fakeHandoffRunner,
  handoffEntry,
  makeHandoffStub,
  makeTempGsdProject,
  pathWithoutRealYahirHandoff,
  readStubCalls,
  runEnoent,
  runExit,
  runOk,
  runTimeout,
  withEnv,
  withPath,
} from "./handoff-test-helpers.ts";
import type { StubReply } from "./handoff-test-helpers.ts";

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

// ─── Real runner against the stub: failure taxonomy ─────────────────────────

/** Call `op` through the REAL runner against a stub (or no stub) with the real binary filtered off PATH. */
async function viaStub(
  replies: Record<string, StubReply | StubReply[]> | null,
  call: (cwd: string) => Promise<unknown>,
  opts: { executable?: boolean; cwd?: string } = {},
): Promise<{ result: any; stub: string | null; project: string }> {
  const project = makeTempGsdProject(tempDirs);
  const stub = replies ? makeHandoffStub(tempDirs, replies, { executable: opts.executable }) : null;
  const path = stub ? `${stub}:${pathWithoutRealYahirHandoff()}` : pathWithoutRealYahirHandoff();
  const result = await withPath(path, () => call(opts.cwd ?? project));
  return { result, stub, project };
}

const TITLE = "y-pi-gsd paused: t";
const mk = (cwd: string) => client.createHandoff({ title: TITLE, body: FIVE_SECTION_BODY }, { cwd });

test("HANDOFF-01 client: not installed (ENOENT) is a typed not-installed failure", async () => {
  const { result } = await viaStub(null, mk);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "not-installed");
  assert.match(result.message, /not on PATH/);
});

test("HANDOFF-01 client: a missing project directory is cwd-missing, not not-installed, and nothing spawns", async () => {
  const gone = makeTempGsdProject(tempDirs);
  rmSync(gone, { recursive: true, force: true });
  const { result, stub } = await viaStub({ create: { stdout: envelope(handoffEntry()) } }, mk, { cwd: gone });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "cwd-missing");
  assert.ok(result.message.includes(gone));
  assert.equal(readStubCalls(stub!).length, 0);
});

test("HANDOFF-01 client: a slow CLI is stopped at the timeout and reported as timeout", async () => {
  const started = Date.now();
  const { result } = await viaStub({ create: { sleepSeconds: 5 } }, (cwd) =>
    client.createHandoff({ title: TITLE, body: FIVE_SECTION_BODY }, { cwd, timeoutMs: 300 }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, "timeout");
  assert.ok(Date.now() - started < 3000, "settled quickly");
});

test("HANDOFF-01 client: a CLI that ignores SIGTERM is cut off by the SIGKILL hard deadline", async () => {
  const project = makeTempGsdProject(tempDirs);
  const stub = makeHandoffStub(tempDirs, { create: { sleepSeconds: 5, ignoreTerm: true } });
  const started = Date.now();
  const run = await withPath(`${stub}:${pathWithoutRealYahirHandoff()}`, () =>
    client.runYahirHandoff(["create", "--json"], {
      cwd: project,
      env: client.buildChildEnv(process.env, null),
      timeoutMs: 200,
      graceMs: 300,
    }),
  );
  assert.equal(run.timedOut, true);
  assert.ok(Date.now() - started < 2000, "settled by the hard deadline");
});

for (const [code, kind] of [
  [1, "internal"],
  [2, "usage"],
  [3, "conflict"],
  [6, "not-allowed"],
  [9, "not-found"],
  [11, "busy"],
  [130, "interrupted"],
] as const) {
  test(`HANDOFF-01 client: exit ${code} maps to ${kind} with the CLI message and hint`, async () => {
    const { result } = await viaStub(
      { take: { code, stderr: errorEnvelope(code, `m${code}`, `h${code}`) } },
      (cwd) => client.takeHandoff("ho_1009_abcd", { cwd }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.kind, kind);
    assert.equal(result.code, code);
    assert.equal(result.message, `m${code}`);
    assert.equal(result.hint, `h${code}`);
  });
}

test("HANDOFF-01 client: another non-zero exit with unparsable stderr is unexpected-exit carrying the last 300 characters", async () => {
  const tail = "z".repeat(300);
  const { result } = await viaStub({ create: { code: 42, stderr: "HEADMARK" + "a".repeat(400) + tail } }, mk);
  assert.equal(result.kind, "unexpected-exit");
  assert.equal(result.code, 42);
  assert.equal(result.message, tail);
  assert.ok(!result.message.includes("HEADMARK"));
});

test("HANDOFF-01 client: exit 0 with unusable output is bad-output (non-JSON, wrong schema, no result, bad id, bad state)", async () => {
  const outputs = [
    "this is not json",
    JSON.stringify({ schema_version: 2, result: handoffEntry() }),
    JSON.stringify({ schema_version: 1 }),
    envelope(handoffEntry({ id: "not-an-id" })),
    envelope(handoffEntry({ state: "weird" })),
  ];
  for (const stdout of outputs) {
    const { result } = await viaStub({ create: { stdout } }, mk);
    assert.equal(result.ok, false, stdout);
    assert.equal(result.kind, "bad-output", stdout);
  }
});

test("HANDOFF-01 client: output over 1 MiB is bad-output (maxBuffer)", async () => {
  const { result } = await viaStub({ create: { stdout: "x".repeat(1.2 * 1024 * 1024) } }, mk);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "bad-output");
});

test("HANDOFF-01 client: a CLI killed by a signal is reported as signal", async () => {
  const { result } = await viaStub({ create: { selfSignal: "KILL" } }, mk);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "signal");
});

test("HANDOFF-01 client: an unexecutable CLI is reported as spawn-error", async () => {
  const { result } = await viaStub({ create: { stdout: envelope(handoffEntry()) } }, mk, { executable: false });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "spawn-error");
});

// ─── Injected runner: ids, argv shapes, parsing ─────────────────────────────

test("HANDOFF-01 client: show/take/done/drop refuse an empty or invalid id without spawning", async () => {
  const fake = fakeHandoffRunner({ show: runOk(handoffEntry()), take: runOk(handoffEntry()), done: runOk(handoffEntry()), drop: runOk(handoffEntry()) });
  const ops = [client.showHandoff, client.takeHandoff, client.doneHandoff, client.dropHandoff];
  for (const op of ops) {
    for (const id of ["", "--json", "ho_x;rm -rf", "HO_1009_ab", "ho_"]) {
      const result = await op(id, { cwd: process.cwd(), run: fake.run });
      assert.equal(result.ok, false);
      assert.equal((result as any).kind, "invalid-id");
    }
  }
  assert.equal(fake.calls.length, 0);
});

test("HANDOFF-01 client: argv shapes are exactly the pinned contract", async () => {
  const fake = fakeHandoffRunner({
    show: runOk(handoffEntry()),
    take: runOk(handoffEntry({ state: "taken" })),
    done: runOk(handoffEntry({ state: "done" })),
    drop: runOk(handoffEntry({ state: "dropped" })),
    notice: runOk({ project: "p", text: "x", handoffs: [] }),
    create: runOk(handoffEntry()),
  });
  const o = { cwd: process.cwd(), run: fake.run };
  for (const op of [client.showHandoff, client.takeHandoff, client.doneHandoff, client.dropHandoff]) {
    assert.equal((await op("ho_1009_abcd", o)).ok, true);
  }
  assert.equal((await client.noticeHandoffs(o)).ok, true);
  assert.equal((await client.createHandoff({ title: TITLE, body: FIVE_SECTION_BODY, supersedes: "ho_1009_0001" }, o)).ok, true);
  const argvs = fake.calls.map((c) => c.argv);
  assert.deepEqual(argvs.slice(0, 4), [
    ["show", "ho_1009_abcd", "--json"],
    ["take", "ho_1009_abcd", "--json"],
    ["done", "ho_1009_abcd", "--json"],
    ["drop", "ho_1009_abcd", "--json"],
  ]);
  assert.deepEqual(argvs[4], ["notice", "--json"]);
  assert.equal(argvs[5][argvs[5].length - 1], "--supersedes=ho_1009_0001");
  assert.equal(fake.calls[5].opts.input, FIVE_SECTION_BODY);
  assert.ok(!argvs[5].some((a) => a.includes("## Goal")), "body never in argv");
  for (const argv of argvs) if (argv[0] === "take") assert.ok(client.isValidHandoffId(argv[1]));
  const bad = await client.createHandoff({ title: TITLE, body: "b", supersedes: "bogus" }, o);
  assert.equal((bad as any).kind, "invalid-id");
  assert.equal(fake.calls.length, 6);
});

test("HANDOFF-01 client: notice parsing normalizes harness, skips malformed entries and never exposes text", async () => {
  const fake = fakeHandoffRunner({
    notice: runOk({
      project: "proj",
      text: "RENDERED TEXT",
      handoffs: [
        handoffEntry({ id: "ho_1009_0001", harness: "y-pi-gsd" }),
        handoffEntry({ id: "ho_1009_0002", harness: "any" }),
        handoffEntry({ id: "ho_1009_0003", harness: "Claude Code!" }),
        (() => {
          const e = handoffEntry({ id: "ho_1009_0004" });
          delete e.harness;
          return e;
        })(),
        { title: "no id", state: "open" },
      ],
    }),
  });
  const result = await client.noticeHandoffs({ cwd: process.cwd(), run: fake.run });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.handoffs.map((h) => h.harness), ["y-pi-gsd", "any", "claude-code", "claude-code"]);
  assert.equal(result.value.project, "proj");
  assert.ok(!("text" in result.value));
  assert.ok(!JSON.stringify(result.value).includes("RENDERED TEXT"));

  const bad = await client.noticeHandoffs({ cwd: process.cwd(), run: fakeHandoffRunner({ notice: runOk({ handoffs: "nope" }) }).run });
  assert.equal((bad as any).kind, "bad-output");
});

test("HANDOFF-01 client: take/show parse the body, done without a body yields null", async () => {
  const fake = fakeHandoffRunner({
    take: runOk(handoffEntry({ state: "taken", body: "THE BODY" })),
    done: runOk(handoffEntry({ state: "done", body: undefined })),
  });
  const o = { cwd: process.cwd(), run: fake.run };
  const taken = await client.takeHandoff("ho_1009_abcd", o);
  assert.ok(taken.ok && taken.value.body === "THE BODY");
  const done = await client.doneHandoff("ho_1009_abcd", o);
  assert.ok(done.ok && done.value.body === null);
});

test("HANDOFF-01 client: buildChildEnv scrubs the Claude session id and sets or removes the y-pi-gsd one", () => {
  const input = { CLAUDE_CODE_SESSION_ID: "cc", YAHIR_HANDOFF_SESSION_ID: "old", YAHIR_HANDOFF_ROOT: "/r" };
  const snapshot = { ...input };
  const withId = client.buildChildEnv(input, "s1");
  assert.equal(withId.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(withId.YAHIR_HANDOFF_SESSION_ID, "s1");
  assert.equal(withId.YAHIR_HANDOFF_ROOT, "/r");
  for (const none of ["", null, undefined]) {
    const e = client.buildChildEnv(input, none);
    assert.equal(e.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(e.YAHIR_HANDOFF_SESSION_ID, undefined);
  }
  assert.deepEqual(input, snapshot);
});

test("HANDOFF-01 client: the runtime belt refuses to spawn from a test process without an isolated store", async () => {
  assert.equal(client.isTestProcess(), true);
  const project = makeTempGsdProject(tempDirs);
  const stub = makeHandoffStub(tempDirs, { create: { stdout: envelope(handoffEntry()) } });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${stub}:${pathWithoutRealYahirHandoff()}` };
  delete env.YAHIR_HANDOFF_ROOT;
  const run = await client.runYahirHandoff(["create", "--json"], { cwd: project, env, timeoutMs: 2000 });
  assert.ok(run.refused, "refused is set");
  assert.equal(client.classifyHandoffRun("create", run)?.kind, "refused-test-isolation");
  assert.equal(readStubCalls(stub).length, 0);
});

test("HANDOFF-01 client: a rejecting or throwing runner yields spawn-error and never throws", async () => {
  const rejecting = await client.createHandoff({ title: TITLE, body: "b" }, { cwd: process.cwd(), run: async () => { throw new Error("rejected!"); } });
  const throwing = await client.createHandoff({ title: TITLE, body: "b" }, { cwd: process.cwd(), run: (() => { throw new Error("thrown!"); }) as any });
  assert.equal((rejecting as any).kind, "spawn-error");
  assert.match((rejecting as any).message, /rejected!/);
  assert.equal((throwing as any).kind, "spawn-error");
  assert.match((throwing as any).message, /thrown!/);
});

test("HANDOFF-01 client: describeHandoffFailure is one sanitized line per class", async () => {
  const busy = client.classifyHandoffRun("take", runExit(11, "store is busy", "retry"))!;
  const text = client.describeHandoffFailure(busy);
  assert.ok(text.includes("exit 11") && text.includes("store is busy") && text.includes("retry"));
  const dirty = client.classifyHandoffRun("take", runExit(1, "\u001b[31mx\u001b[0m\u0007"))!;
  const dirtyText = client.describeHandoffFailure(dirty);
  assert.ok(!dirtyText.includes("\u001b") && !dirtyText.includes("\u0007"));
  assert.match(client.describeHandoffFailure(client.classifyHandoffRun("create", runEnoent())!), /not on PATH/);
  assert.equal(client.classifyHandoffRun("create", runTimeout())?.kind, "timeout");
  assert.equal(client.classifyHandoffRun("create", { ok: true, exitCode: 0, stdout: "", stderr: "" }), null);
});
