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

