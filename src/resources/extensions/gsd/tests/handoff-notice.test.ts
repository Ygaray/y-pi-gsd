// Project/App: gsd-pi
// File Purpose: HANDOFF-01 startup notice — a hook-level tracer (the real session_start handler
// with a stub yahir-handoff on PATH) plus the gating/labelling/failure matrix driven through an
// injected fake runner. No real yahir-handoff is ever resolved.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  cleanupTempDirs,
  envelope,
  handoffEntry,
  makeHandoffCtx,
  makeHandoffStub,
  makeTempGsdProject,
  pathWithoutRealYahirHandoff,
  readStubCalls,
  withPath,
} from "./handoff-test-helpers.ts";

// GSD_HOME must point at a temp dir before any project module loads.
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-handoff-notice-home-"));
process.env.GSD_HOME = tempGsdHome;

let hooks: typeof import("../bootstrap/register-hooks.ts");
let notice: typeof import("../handoff-notice.ts");
let rec: typeof import("../handoff-record.ts");
let gsdDb: typeof import("../gsd-db.ts");

before(async () => {
  gsdDb = await import("../gsd-db.ts");
  rec = await import("../handoff-record.ts");
  notice = await import("../handoff-notice.ts");
  hooks = await import("../bootstrap/register-hooks.ts");
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

// ─── Tracer: the real session_start handler ─────────────────────────────────

/** The session-start-footer ctx shape plus hasUI/cwd, recording notify calls. */
function makeHookCtx(root: string) {
  const base = makeHandoffCtx(root, { hasUI: true });
  return {
    ...base,
    ui: {
      notify: base.ui.notify,
      setStatus: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
      setWidget: () => {},
    },
    sessionManager: { getSessionId: () => null },
    model: null,
    setCompactionThresholdOverride: () => {},
  };
}

function captureSessionStart(): (event: unknown, ctx: any) => Promise<void> | void {
  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as any;
  hooks.registerHooks(pi, []);
  const handler = handlers.get("session_start");
  assert.ok(handler, "session_start handler must be registered");
  return handler!;
}

/** Temp project whose DB holds a stored y-pi-gsd record (DB closed again before the hook runs). */
function projectWithStoredRecord(id: string): string {
  const root = makeTempGsdProject(tempDirs);
  gsdDb.openDatabase(join(root, ".gsd", "gsd.db"));
  assert.equal(
    rec.writeStoredHandoff({ id, createdAt: new Date().toISOString(), hadPausedSession: true, source: "pause" }),
    true,
  );
  gsdDb.closeDatabase();
  return root;
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

test("HANDOFF-01 notice tracer: a fresh interactive session_start shows one y-pi-gsd-written Handoff waiting line without blocking startup", async () => {
  const root = projectWithStoredRecord("ho_1009_aaaa");
  const createdAt = new Date(Date.now() - (2 * 60 + 5) * 60_000).toISOString();
  const stub = makeHandoffStub(tempDirs, {
    notice: {
      stdout: envelope({
        project: "proj",
        text: "Run /handoff take ho_1009_aaaa",
        handoffs: [handoffEntry({ id: "ho_1009_aaaa", title: "y-pi-gsd paused: M001/S01/T01", created_at: createdAt })],
      }),
    },
  });
  const sessionStart = captureSessionStart();
  const ctx = makeHookCtx(root);

  await withPath(`${stub}${delimiter}${pathWithoutRealYahirHandoff()}`, () =>
    withCwd(root, async () => {
      await sessionStart({ reason: "startup" }, ctx);
      const arrived = await waitFor(() => ctx.notifications.some((n) => n.message.includes("Handoff waiting")), 5_000);
      assert.ok(arrived, `no notice arrived; saw ${JSON.stringify(ctx.notifications)}`);
    }),
  );

  const waiting = ctx.notifications.filter((n) => n.message.includes("Handoff waiting"));
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].level, "info");
  assert.equal(waiting[0].message, "Handoff waiting: y-pi-gsd paused: M001/S01/T01 · 2h ago — /gsd resume-work (ho_1009_aaaa)");
  assert.ok(!ctx.notifications.some((n) => n.message.includes("/handoff take")), "the CLI's own text is never shown");
  const calls = readStubCalls(stub);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ["notice", "--json"]);
  assert.equal(calls[0].env.PWD, realpathSync(root));
});

test("HANDOFF-01 notice tracer: the session_start handler does not wait for the notice", async () => {
  const root = projectWithStoredRecord("ho_1009_aaaa");
  const stub = makeHandoffStub(tempDirs, { notice: { stdout: "", sleepSeconds: 3 } });
  const sessionStart = captureSessionStart();
  const ctx = makeHookCtx(root);

  await withPath(`${stub}${delimiter}${pathWithoutRealYahirHandoff()}`, () =>
    withCwd(root, async () => {
      const t0 = Date.now();
      await sessionStart({ reason: "startup" }, ctx);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 2_500, `session_start took ${elapsed} ms; it must not wait for the CLI`);
      assert.ok(!ctx.notifications.some((n) => n.message.includes("andoff")), "no Handoff notify exists yet");
      const arrived = await waitFor(() => ctx.notifications.some((n) => n.level === "warning"), 6_000);
      assert.ok(arrived, "the bad-output warning arrives after the CLI replies");
    }),
  );
  assert.match(ctx.notifications.find((n) => n.level === "warning")!.message, /yahir-handoff notice failed/);
});
