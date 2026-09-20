// Project/App: gsd-pi
// File Purpose: TEST-07 — `/gsd verify-agentic` real `ops.ts` routing proof.
//
// Calls the real `handleOpsCommand` with a spy `pi.sendMessage` — no mocked
// dispatch seam, per D-01's reversibility note (none exists in this codebase).
// Mirrors `tests/db-restore-backup-routing.test.ts`'s scaffold.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleOpsCommand } from "../../commands/handlers/ops.ts";
import { withCommandCwd } from "../../commands/context.ts";
import { loadPrompt } from "../../prompt-loader.ts";
import { buildVerifyAgenticPrompt, DRIVER_PATHS, SURFACES } from "../../commands-verify-agentic.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeProjectDir(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-verify-agentic-routing-"));
  tempDirs.add(base);
  return base;
}

function makeCtx() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
  };
}

function makeMockPi() {
  const sent: unknown[] = [];
  return {
    sent,
    pi: {
      registerCommand() {},
      registerTool() {},
      registerShortcut() {},
      on() {},
      sendMessage(msg: unknown) {
        sent.push(msg);
      },
    },
  };
}

test("/gsd verify-agentic S07 --surface cli routes to the real handler and dispatches a prompt naming agentic-tester, the target, and the cli driver", async () => {
  const base = makeProjectDir();
  const ctx = makeCtx();
  const { sent, pi } = makeMockPi();

  const handled = await withCommandCwd(base, () =>
    handleOpsCommand("verify-agentic S07 --surface cli", ctx as any, pi as any));

  assert.equal(handled, true, "the ops dispatcher must claim `verify-agentic`");
  assert.equal(sent.length, 1, "exactly one pi.sendMessage call must be made");

  const prompt = (sent[0] as { content: string }).content;
  assert.match(prompt, /agentic-tester/);
  assert.match(prompt, /S07/);
  assert.match(prompt, /cli/);
  assert.match(prompt, /drivers\/cli\.md/);
});

test("/gsd verify-agentic S07 --surface android dispatches a prompt naming the android driver", async () => {
  const base = makeProjectDir();
  const ctx = makeCtx();
  const { sent, pi } = makeMockPi();

  const handled = await withCommandCwd(base, () =>
    handleOpsCommand("verify-agentic S07 --surface android", ctx as any, pi as any));

  assert.equal(handled, true);
  assert.equal(sent.length, 1);
  const prompt = (sent[0] as { content: string }).content;
  assert.match(prompt, /drivers\/android\.md/);
});

test("a prefix-adjacent command (verify-agenticx) is not claimed by the verify-agentic route", async () => {
  const ctx = makeCtx();
  const { pi } = makeMockPi();

  const handled = await handleOpsCommand("verify-agenticx", ctx as any, pi as any);

  assert.equal(handled, false);
  assert.deepEqual(ctx.notifications, []);
});

// ─── Block one: real-loader completeness (07-02 Task 1, D-01) ─────────────────
//
// Never mock loadPrompt — mocking it hides the single failure mode this block
// exists to catch (a template var declared on disk that the handler no longer
// supplies, or vice versa). Every case below calls the real loadPrompt against
// the real prompts/verify-agentic.md file on disk.

// Mirrors the handler's own DEFAULT_CRITERIA_NOTE literal (commands-verify-agentic.ts).
// Not exported by that module, so this is the fixed literal both sides must agree on.
const DEFAULT_CRITERIA_LITERAL =
  "(no explicit criteria supplied — verify every acceptance criterion stated for this target)";

const FIXTURE_WORKING_DIRECTORY = "/tmp/gsd-verify-agentic-loader-fixture";

for (const surface of SURFACES) {
  for (const criteria of ["login works end to end", undefined] as const) {
    const label = criteria === undefined ? "default criteria" : "explicit criteria";

    test(`loadPrompt("verify-agentic", ...) renders for surface=${surface} with ${label}`, () => {
      const vars = {
        target: "S07",
        criteria: criteria ?? DEFAULT_CRITERIA_LITERAL,
        surface,
        driverPath: DRIVER_PATHS[surface],
        workingDirectory: FIXTURE_WORKING_DIRECTORY,
      };

      let out = "";
      assert.doesNotThrow(() => {
        out = loadPrompt("verify-agentic", vars);
      });

      assert.match(out, /S07/);
      assert.match(out, new RegExp(surface));
      assert.ok(
        out.includes(DRIVER_PATHS[surface]),
        `expected driver path ${DRIVER_PATHS[surface]} in rendered prompt`,
      );
      assert.ok(out.includes(".gsd/verify-agentic/"));
      assert.ok(out.includes("-SELF-UAT.md"));
      assert.doesNotMatch(out, /\{\{[a-zA-Z]/);
    });
  }
}

test('loadPrompt("verify-agentic", {}) with no vars throws — the template genuinely declares its non-free placeholders', () => {
  assert.throws(() => loadPrompt("verify-agentic", {}));
});

test("buildVerifyAgenticPrompt output equals the direct loadPrompt output for the same five vars (D-01)", () => {
  const built = buildVerifyAgenticPrompt({
    target: "S07",
    criteria: "login works end to end",
    surface: "cli",
    basePath: FIXTURE_WORKING_DIRECTORY,
  });

  const direct = loadPrompt("verify-agentic", {
    target: "S07",
    criteria: "login works end to end",
    surface: "cli",
    driverPath: DRIVER_PATHS.cli,
    workingDirectory: FIXTURE_WORKING_DIRECTORY,
  });

  assert.equal(built, direct);
});

// ─── Block two: three-way write-path agreement (07-02 Task 1, T-07-08) ────────
//
// The mechanical answer to a template restating the SELF-UAT log path in its
// own words and drifting from the shipped convention.

test("prompts/verify-agentic.md, SKILL.md, and verify-agentic-log.ts all name the same SELF-UAT write path", () => {
  const files = [
    "src/resources/extensions/gsd/prompts/verify-agentic.md",
    "src/resources/skills/agentic-tester/SKILL.md",
    "src/resources/extensions/gsd/verify-agentic-log.ts",
  ];

  for (const file of files) {
    const content = readFileSync(join(process.cwd(), file), "utf-8");
    assert.ok(content.includes(".gsd/verify-agentic/"), `${file} must name .gsd/verify-agentic/`);
    assert.ok(content.includes("-SELF-UAT.md"), `${file} must name the -SELF-UAT.md suffix`);
  }
});
