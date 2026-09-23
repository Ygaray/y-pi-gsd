// Project/App: gsd-pi
// File Purpose: Full-table-regeneration and injection-safety coverage for the
// milestone run-log projection (DRIVER-01, T-16-01). Mirrors
// `human-uat-pending-projection.test.ts`'s structure: mkdtempSync temp base,
// real Domain-Operation-bound writes (never raw INSERTs), afterEach cleanup.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import {
  MILESTONE_RUN_LOG_OPERATION_TYPE,
  transitionMilestoneRunLogRow,
  type MilestoneRunLogStatus,
} from "../db/writers/milestone-run-log.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import {
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { recordMilestoneRunLifecycle } from "../milestone-run-log-domain-operation.ts";
import {
  getActiveMilestoneRun,
  readMilestoneRunLog,
  renderMilestoneRunLog,
  renderMilestoneRunLogMarkdown,
  RUN_LOG_PROJECTION_FILENAME,
} from "../run-log-projection.ts";

const tempDirs = new Set<string>();

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "test",
  };
}

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-log-projection-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Run log projection", status: "active" });
  return basePath;
}

function projectionPath(basePath: string): string {
  return join(basePath, ".gsd", RUN_LOG_PROJECTION_FILENAME);
}

/** Insert one row through the real writer/Domain Operation path (never a raw INSERT). */
function record(
  milestoneId: string,
  runId: string,
  attempt: number,
  status: MilestoneRunLogStatus,
  extra: { pauseKind?: string | null; reason?: string | null; resumeFrom?: number | null } = {},
): string {
  const receipt = recordMilestoneRunLifecycle({
    invocation: invocation(`fixture/run-log-projection/${milestoneId}/${runId}/a${attempt}/${status}`),
    milestoneId,
    runId,
    attempt,
    status,
    resumeFrom: extra.resumeFrom ?? null,
    pauseKind: extra.pauseKind ?? null,
    reason: extra.reason ?? null,
  });
  return receipt.entryId;
}

/** Transition an existing row through the real writer's own Domain Operation. */
function transition(
  entryId: string,
  status: MilestoneRunLogStatus,
  idempotencyKey: string,
  extra: { pauseKind?: string | null; reason?: string | null; resumeFrom?: number | null } = {},
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: MILESTONE_RUN_LOG_OPERATION_TYPE,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { entryId, status },
  }, (context: Readonly<DomainOperationContext>) => {
    transitionMilestoneRunLogRow(context, {
      entryId,
      status,
      resumeFrom: extra.resumeFrom ?? null,
      pauseKind: extra.pauseKind ?? null,
      reason: extra.reason ?? null,
    });
    return {
      events: [{
        eventType: "test.run-log.transitioned",
        entityType: "milestone",
        entityId: entryId,
        payload: { entryId },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

/** Count only real column-delimiter pipes (skip `\|`-escaped ones). */
function unescapedPipeCount(line: string): number {
  const matches = line.match(/(?<!\\)\|/g);
  return matches ? matches.length : 0;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

// ─── Task 1: escaping + full lifecycle-history renderer ────────────────────

test("a pipe in reason renders as exactly one table row, matching the header's delimiter count", () => {
  makeBase();
  record("M001", "R-pipe", 1, "failed", { reason: "blocked | forged column?" });
  const content = renderMilestoneRunLogMarkdown(readMilestoneRunLog());
  const lines = content.split("\n");
  const headerLine = lines.find((line) => line.startsWith("| Entry | Milestone | Run | Attempt | Status"));
  assert.ok(headerLine, "the Run history header row must exist");
  const matching = lines.filter((line) => line.includes("R-pipe"));
  assert.equal(matching.length, 1, "the injected pipe must not split into a second row");
  assert.equal(unescapedPipeCount(matching[0]!), unescapedPipeCount(headerLine!));
});

test("CRLF, LF, and CR in reason all collapse into a single rendered line", () => {
  makeBase();
  record("M001", "R-newline-clean", 1, "failed", { reason: "clean reason text" });
  const cleanContent = renderMilestoneRunLogMarkdown(readMilestoneRunLog());
  const cleanLineCount = cleanContent.split("\n").length;
  closeDatabase();

  makeBase();
  const dirtyReason = "line one\r\nline two\nline three\rline four";
  record("M001", "R-newline-dirty", 1, "failed", { reason: dirtyReason });
  const dirtyContent = renderMilestoneRunLogMarkdown(readMilestoneRunLog());
  const dirtyLineCount = dirtyContent.split("\n").length;

  assert.equal(dirtyLineCount, cleanLineCount, "embedded CR/LF/CRLF must not introduce extra rendered lines");
  assert.doesNotMatch(dirtyContent, /line one\nline two/, "raw newlines must not survive into the rendered document");
  assert.match(dirtyContent, /line one line two line three line four/);
});

test("a markdown table fragment embedded in reason cannot forge an extra header or row", () => {
  makeBase();
  const fragment = "| Fake Header | X |\n| --- | --- |\n| injected | row |";
  record("M001", "R-fragment", 1, "failed", { reason: fragment });
  const content = renderMilestoneRunLogMarkdown(readMilestoneRunLog());
  const lines = content.split("\n");
  assert.equal(
    lines.filter((line) => line.includes("R-fragment")).length,
    1,
    "the fragment must render as one row, not three",
  );
  assert.equal((content.match(/^## /gm) ?? []).length, 2, "no new section header was forged");
  assert.equal((content.match(/^# /gm) ?? []).length, 1, "no new top-level header was forged");
});

test("pause_kind, run_id, and milestone_id are each escaped when they contain a pipe", () => {
  makeBase();
  record("M001", "R-pausekind-pipe", 1, "failed", { pauseKind: "gap|closure-cap" });
  record("M001", "R-runid-pipe|tail", 2, "failed", {});
  record("M-pipe|002", "R-milestoneid-pipe", 1, "failed", {});

  const content = renderMilestoneRunLogMarkdown(readMilestoneRunLog());
  const lines = content.split("\n");
  const headerLine = lines.find((line) => line.startsWith("| Entry | Milestone | Run | Attempt | Status"))!;
  const headerPipes = unescapedPipeCount(headerLine);

  const pauseKindRow = lines.find((line) => line.includes("R-pausekind-pipe"));
  assert.ok(pauseKindRow, "the pause_kind row must render");
  assert.equal(unescapedPipeCount(pauseKindRow!), headerPipes);

  const runIdRow = lines.find((line) => line.includes("R-runid-pipe"));
  assert.ok(runIdRow, "the run_id row must render");
  assert.equal(unescapedPipeCount(runIdRow!), headerPipes);

  const milestoneIdRow = lines.find((line) => line.includes("R-milestoneid-pipe"));
  assert.ok(milestoneIdRow, "the milestone_id row must render");
  assert.equal(unescapedPipeCount(milestoneIdRow!), headerPipes);
});

test("a pause/resume cycle followed by a second attempt renders both attempt rows oldest-first with attempt numbers visible", () => {
  makeBase();
  const attempt1 = record("M001", "R-lifecycle", 1, "running");
  transition(attempt1, "paused", "fixture/run-log-projection/lifecycle/pause");
  transition(attempt1, "resumed", "fixture/run-log-projection/lifecycle/resume");
  const attempt2 = record("M001", "R-lifecycle", 2, "running");
  transition(attempt2, "completed", "fixture/run-log-projection/lifecycle/complete");

  const rows = readMilestoneRunLog();
  const lifecycleRows = rows.filter((row) => row.runId === "R-lifecycle");
  assert.equal(
    lifecycleRows.length,
    2,
    "one row per attempt -- the pause/resume cycle and the re-run are two attempt rows, not a collapsed single row",
  );
  assert.equal(lifecycleRows[0]!.attempt, 1);
  assert.equal(lifecycleRows[0]!.status, "resumed");
  assert.equal(lifecycleRows[1]!.attempt, 2);
  assert.equal(lifecycleRows[1]!.status, "completed");

  const content = renderMilestoneRunLogMarkdown(rows);
  const lines = content.split("\n");
  const attempt1Index = lines.findIndex((line) => line.includes(attempt1));
  const attempt2Index = lines.findIndex((line) => line.includes(attempt2));
  assert.ok(attempt1Index >= 0 && attempt2Index >= 0, "both attempt rows must render");
  assert.ok(attempt1Index < attempt2Index, "attempt 1 must render before attempt 2 (oldest-first)");
  assert.match(lines[attempt1Index]!, /\| 1 \|/, "attempt 1's row must show attempt number 1");
  assert.match(lines[attempt2Index]!, /\| 2 \|/, "attempt 2's row must show attempt number 2");
});

test("rendering twice from the same rows produces byte-identical output", () => {
  makeBase();
  record("M001", "R-determinism", 1, "completed", { reason: "steady state" });
  const rows = readMilestoneRunLog();
  const first = renderMilestoneRunLogMarkdown(rows);
  const second = renderMilestoneRunLogMarkdown(rows);
  assert.equal(first, second);
});

test("an empty run-log renders a complete document with active-run and history no-data markers", () => {
  const content = renderMilestoneRunLogMarkdown([]);
  assert.ok(content.length > 0, "the document must be non-empty even with zero rows");
  assert.match(content, /# Milestone Run Log/);
  assert.match(content, /generated,? read-only projection/i);
  assert.match(content, /manual edits are discarded/i);
  assert.match(content, /No run is currently active\./);
  assert.match(content, /No runs have been recorded\./);
});

test("renderMilestoneRunLog returns false and writes no file when no database is open", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-log-projection-nodb-"));
  tempDirs.add(basePath);
  let result: boolean | undefined;
  assert.doesNotThrow(() => {
    result = renderMilestoneRunLog(basePath);
  });
  assert.equal(result, false);
  assert.equal(existsSync(projectionPath(basePath)), false);
});

test("no .tmp sibling remains after a successful render", () => {
  const basePath = makeBase();
  record("M001", "R-atomic", 1, "completed", {});
  assert.equal(renderMilestoneRunLog(basePath), true);
  assert.equal(existsSync(`${projectionPath(basePath)}.tmp`), false);
  assert.equal(existsSync(projectionPath(basePath)), true);
});

// ─── Task 2: faithful-mirror proof (row-count fidelity, regeneration authority,
// active-run agreement, milestone scoping) ──────────────────────────────────

test("the rendered history row count matches readMilestoneRunLog()'s row count", () => {
  makeBase();
  record("M001", "R-count-a", 1, "completed", {});
  record("M001", "R-count-b", 1, "failed", {});
  const attempt = record("M001", "R-count-c", 1, "running");
  transition(attempt, "paused", "fixture/run-log-projection/count/pause");

  const rows = readMilestoneRunLog();
  const content = renderMilestoneRunLogMarkdown(rows);
  const historySection = content.split("## Run history")[1]!;
  const historyRowLines = historySection.split("\n").filter((line) => line.startsWith("| RUN-"));
  assert.equal(historyRowLines.length, rows.length);
});

test("a hand edit to RUN-LOG.md is discarded by the next real lifecycle write", () => {
  const basePath = makeBase();
  record("M001", "R-hand-edit", 1, "completed", {});
  assert.equal(renderMilestoneRunLog(basePath), true);
  writeFileSync(projectionPath(basePath), "HAND EDITED CONTENT", "utf-8");
  assert.equal(readFileSync(projectionPath(basePath), "utf-8"), "HAND EDITED CONTENT");

  const secondEntryId = record("M001", "R-hand-edit-2", 1, "completed", {});
  assert.equal(renderMilestoneRunLog(basePath), true);
  const content = readFileSync(projectionPath(basePath), "utf-8");
  assert.ok(!content.includes("HAND EDITED CONTENT"), "a hand edit must never survive the next render (T-16-10)");
  assert.match(content, new RegExp(secondEntryId));
});

test("getActiveMilestoneRun and the rendered Active run section agree as a run starts and then pauses", () => {
  makeBase();
  const entryId = record("M001", "R-active-agree", 1, "running");

  let rows = readMilestoneRunLog();
  const activeBefore = getActiveMilestoneRun("M001");
  assert.ok(activeBefore);
  assert.equal(activeBefore!.entryId, entryId);
  const activeSectionBefore = renderMilestoneRunLogMarkdown(rows).split("## Run history")[0]!;
  assert.match(activeSectionBefore, new RegExp(entryId));

  transition(entryId, "paused", "fixture/run-log-projection/active-agree/pause");
  rows = readMilestoneRunLog();
  const activeAfter = getActiveMilestoneRun("M001");
  assert.equal(activeAfter, null);
  const activeSectionAfter = renderMilestoneRunLogMarkdown(rows).split("## Run history")[0]!;
  assert.doesNotMatch(activeSectionAfter, new RegExp(entryId));
});

test("two milestones' active runs render as separate rows with no reason text bleeding across", () => {
  makeBase();
  insertMilestone({ id: "M002", title: "Second milestone", status: "active" });

  const entry1 = record("M001", "R-two-mil-a", 1, "running", { reason: "ALPHA-ONLY-MARKER" });
  const entry2 = record("M002", "R-two-mil-b", 1, "running", { reason: "BETA-ONLY-MARKER" });

  const content = renderMilestoneRunLogMarkdown(readMilestoneRunLog());
  const historySection = content.split("## Run history")[1]!;
  const historyLines = historySection.split("\n");
  const line1 = historyLines.find((line) => line.includes(entry1));
  const line2 = historyLines.find((line) => line.includes(entry2));
  assert.ok(line1 && line2, "both milestones' rows must render");
  assert.match(line1!, /ALPHA-ONLY-MARKER/);
  assert.doesNotMatch(line1!, /BETA-ONLY-MARKER/);
  assert.match(line2!, /BETA-ONLY-MARKER/);
  assert.doesNotMatch(line2!, /ALPHA-ONLY-MARKER/);
});
