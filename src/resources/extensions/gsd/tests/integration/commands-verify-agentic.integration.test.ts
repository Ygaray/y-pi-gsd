// Project/App: gsd-pi
// File Purpose: TEST-07 — `/gsd verify-agentic` real `ops.ts` routing proof.
//
// Calls the real `handleOpsCommand` with a spy `pi.sendMessage` — no mocked
// dispatch seam, per D-01's reversibility note (none exists in this codebase).
// Mirrors `tests/db-restore-backup-routing.test.ts`'s scaffold.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleOpsCommand } from "../../commands/handlers/ops.ts";
import { withCommandCwd } from "../../commands/context.ts";

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
