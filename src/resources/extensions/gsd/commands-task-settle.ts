// Project/App: gsd-pi
// File Purpose: /gsd task settle — operator CLI surface for gsd_task_settle (#1749),
// including the `blocker-accepted` closeout disposition (#2202).

import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import {
  applyBlockerAcceptedDisposition,
  applyOperatorAttestedDisposition,
  applyTaskSettle,
  isOperatorSettleInterruptedResidue,
  planBlockerAcceptedDisposition,
  planOperatorAttestedDisposition,
  planTaskSettle,
  type TaskSettleTask,
} from "./task-settle.js";
import type { DomainJsonValue } from "./db/domain-operation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

function parseTaskSettleArgs(args: string): {
  task: TaskSettleTask;
  reason: string;
  apply: boolean;
  reconcileLifecycle: boolean;
  blockerAccepted: boolean;
  operatorAttested: boolean;
  /** Raw --evidence value, unparsed. Parsing (and its error reporting) belongs to the handler. */
  evidenceRaw: string | null;
} | null {
  const apply = /(?:^|\s)--apply(?:\s|$)/.test(args);
  const reconcileLifecycle = /(?:^|\s)--reconcile-lifecycle(?:\s|$)/.test(args);
  const blockerAccepted = /(?:^|\s)--blocker-accepted(?:\s|$)/.test(args);
  const operatorAttested = /(?:^|\s)--operator-attested(?:\s|$)/.test(args);
  const reasonMatch = args.match(/--reason\s+"([^"]+)"|--reason\s+'([^']+)'|--reason\s+(\S+)/);
  const evidenceMatch = args.match(/--evidence\s+"([^"]+)"|--evidence\s+'([^']+)'|--evidence\s+(\S+)/);
  const evidenceRaw = evidenceMatch?.[1] ?? evidenceMatch?.[2] ?? evidenceMatch?.[3] ?? null;
  const positional = args
    .replace(/--apply/g, "")
    .replace(/--reconcile-lifecycle/g, "")
    .replace(/--blocker-accepted/g, "")
    .replace(/--operator-attested/g, "")
    .replace(/--reason\s+"[^"]*"|\s--reason\s+'[^']*'|--reason\s+\S+/g, "")
    .replace(/--evidence\s+"[^"]*"|\s--evidence\s+'[^']*'|--evidence\s+\S+/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const unit = (positional[0] ?? "").replace(/^execute-task\//, "");
  const parts = unit.split("/");
  const reason = reasonMatch?.[1] ?? reasonMatch?.[2] ?? reasonMatch?.[3] ?? "";
  if (parts.length !== 3 || parts.some((part) => part.length === 0) || reason.length === 0) return null;
  return {
    task: { milestoneId: parts[0], sliceId: parts[1], taskId: parts[2] },
    reason,
    apply,
    reconcileLifecycle,
    blockerAccepted,
    operatorAttested,
    evidenceRaw,
  };
}

/**
 * RELY-03 recurrence (INC-2026-09-27-01): a plain settle applied to an
 * already-settled/interrupted/operator-settle Attempt with no recovery route
 * used to report a bare "nothing to do" — the exact dead-end that forced a
 * re-entry into `/gsd auto`. Append the `--operator-attested` next step when
 * that shape applies so the CLI's own idle-repeat surfaces the escape hatch.
 */
function operatorAttestedHint(task: TaskSettleTask): string {
  return isOperatorSettleInterruptedResidue(task)
    ? " No recovery route was ever recorded for this settled Attempt — if the deliverable is " +
      "verifiably complete, re-run with --operator-attested --evidence " +
      '\'{"command":"...","exitCode":0,"verdict":"pass"}\'.'
    : "";
}

function cliInvocation(): ExecutionInvocation {
  const id = randomUUID();
  return {
    idempotencyKey: `cli:gsd_task_settle:${id}`,
    sourceTransport: "internal",
    actorType: "user",
    traceId: id,
  };
}

export async function handleTaskSettle(
  args: string,
  ctx: ExtensionCommandContext,
  basePath: string,
): Promise<void> {
  const parsed = parseTaskSettleArgs(args);
  if (!parsed) {
    ctx.ui.notify(
      'Usage: /gsd task settle <M001/S01/T01> --reason "why" [--apply] [--reconcile-lifecycle] ' +
      '[--blocker-accepted] [--operator-attested --evidence \'{"command":"...","exitCode":0,"verdict":"pass"}\']\n' +
      "Dry-run by default: prints the exact Attempt, lifecycle, or disposition rows it would change. " +
      "--apply performs the settle. --blocker-accepted closes a Task whose latest Attempt failed as " +
      "blocker-discovered at the route stage (no rerun; then replan the slice). --operator-attested closes a " +
      "Task whose latest Attempt failed as retry-classified at the route stage, given the required --evidence " +
      "JSON object (fields: command, exitCode, verdict).",
      "warning",
    );
    return;
  }
  if (parsed.blockerAccepted && parsed.operatorAttested) {
    ctx.ui.notify(
      "gsd task settle: --blocker-accepted and --operator-attested are mutually exclusive.",
      "error",
    );
    return;
  }
  const dispositionFlag = parsed.blockerAccepted
    ? "--blocker-accepted"
    : parsed.operatorAttested
    ? "--operator-attested"
    : null;
  if (dispositionFlag && parsed.reconcileLifecycle) {
    ctx.ui.notify(
      `gsd task settle: ${dispositionFlag} and --reconcile-lifecycle are mutually exclusive.`,
      "error",
    );
    return;
  }
  if (parsed.evidenceRaw !== null && !parsed.blockerAccepted && !parsed.operatorAttested) {
    ctx.ui.notify(
      "gsd task settle: --evidence is only used with --operator-attested and will be ignored here.",
      "warning",
    );
  }
  if (!await ensureDbOpen(basePath)) {
    ctx.ui.notify("gsd task settle: GSD database is not available.", "error");
    return;
  }
  const unit = `${parsed.task.milestoneId}/${parsed.task.sliceId}/${parsed.task.taskId}`;
  try {
    if (parsed.operatorAttested) {
      if (parsed.evidenceRaw === null) {
        ctx.ui.notify(
          "gsd task settle: --operator-attested requires --evidence with a JSON object " +
          '(fields: command, exitCode, verdict), e.g. --evidence \'{"command":"npm test","exitCode":0,"verdict":"pass"}\'.',
          "error",
        );
        return;
      }
      let evidence: DomainJsonValue;
      try {
        evidence = JSON.parse(parsed.evidenceRaw) as DomainJsonValue;
      } catch (parseError) {
        ctx.ui.notify(
          `gsd task settle: --evidence is not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          "error",
        );
        return;
      }
      if (!parsed.apply) {
        const plan = planOperatorAttestedDisposition(parsed.task, evidence, parsed.reason);
        if (plan.alreadyAttested) {
          ctx.ui.notify(`gsd task settle (dry run): ${unit} is already closed as operator-attested — nothing to do.`, "info");
          return;
        }
        const row = plan.rows[0];
        ctx.ui.notify(
          `gsd task settle (dry run) — operator-attested disposition, no changes made:\n` +
          `  lifecycle ${row.lifecycleFrom} → operator-attested (legacy tasks.status ${row.currentStatus} → operator-attested)\n` +
          `  attempt ${row.attemptId} Result ${row.resultId} preserved; route Kernel head consumed with a closeout decision\n` +
          `  recovery action ${row.supersededRecoveryActionId ?? "(none)"} superseded\n` +
          "Re-run with --apply to attest.",
          "info",
        );
        return;
      }
      const result = applyOperatorAttestedDisposition({
        invocation: cliInvocation(),
        task: parsed.task,
        evidence,
        reason: parsed.reason,
      });
      if (result.alreadyAttested) {
        ctx.ui.notify(`gsd task settle: ${unit} is already closed as operator-attested — nothing to do.`, "info");
        return;
      }
      ctx.ui.notify(
        `${unit} closed on operator attestation: Task is closed on operator attestation; the attestation ` +
        `evidence is recorded on the event log. Attempt ${result.attemptId} and its failed Result remain ` +
        "history and the route head is consumed (no re-route).",
        "info",
      );
      return;
    }
    if (parsed.blockerAccepted) {
      if (!parsed.apply) {
        const plan = planBlockerAcceptedDisposition(parsed.task, parsed.reason);
        if (plan.alreadyAccepted) {
          ctx.ui.notify(`gsd task settle (dry run): ${unit} is already closed as blocker-accepted — nothing to do.`, "info");
          return;
        }
        const row = plan.rows[0];
        ctx.ui.notify(
          `gsd task settle (dry run) — blocker-accepted disposition, no changes made:\n` +
          `  lifecycle ${row.lifecycleFrom} → blocker-accepted (legacy tasks.status ${row.currentStatus} → blocker-accepted)\n` +
          `  attempt ${row.attemptId} Result ${row.resultId} preserved; route Kernel head consumed with a closeout decision\n` +
          `  provenance: ${row.blockerSummary || "(failed Result carries no summary)"}` +
          `${row.supersededRecoveryActionId ? `; supersedes Recovery Action ${row.supersededRecoveryActionId}` : ""}\n` +
          `  next: gsd_replan_slice with blockerTaskId ${parsed.task.taskId}\n` +
          "Re-run with --apply to accept the blocker.",
          "info",
        );
        return;
      }
      const result = applyBlockerAcceptedDisposition({
        invocation: cliInvocation(),
        task: parsed.task,
        reason: parsed.reason,
      });
      if (result.alreadyAccepted) {
        ctx.ui.notify(`gsd task settle: ${unit} is already closed as blocker-accepted — nothing to do.`, "info");
        return;
      }
      ctx.ui.notify(
        `Accepted blocker for ${unit}: Task closed as blocker-accepted; Attempt ${result.attemptId} and its ` +
        `failed Result remain history and the route head is consumed (no re-route). ` +
        `Replan with gsd_replan_slice (blockerTaskId ${parsed.task.taskId}) — the Task will not execute again.`,
        "info",
      );
      return;
    }
    const settleOptions = { reconcileLifecycle: parsed.reconcileLifecycle };
    if (!parsed.apply) {
      const plan = planTaskSettle(parsed.task, parsed.reason, settleOptions);
      if (plan.rows.length === 0 && plan.lifecycleRows.length === 0) {
        ctx.ui.notify(
          `gsd task settle (dry run): ${unit} has no running Attempt — nothing to do.` +
          operatorAttestedHint(parsed.task),
          "info",
        );
        return;
      }
      const lines = [
        ...plan.rows.map(
          (row) => `  attempt ${row.attemptId}: ${row.currentStatus} → ${row.targetStatus} — ${row.rationale}`,
        ),
        ...plan.lifecycleRows.map(
          (row) => `  lifecycle ${row.currentStatus} → ${row.targetStatus} — ${row.rationale}`,
        ),
        ...(plan.proof ? [`  proof: ${plan.proof.note}`] : []),
      ];
      ctx.ui.notify(
        `gsd task settle (dry run) — no changes made:\n${lines.join("\n")}\nRe-run with --apply to settle.`,
        "info",
      );
      return;
    }
    const result = applyTaskSettle({
      invocation: cliInvocation(),
      task: parsed.task,
      reason: parsed.reason,
      ...settleOptions,
    });
    if (!result.settled && !result.reconciled) {
      ctx.ui.notify(
        `gsd task settle: ${unit} has no running Attempt — nothing to do.` +
        operatorAttestedHint(parsed.task),
        "info",
      );
      return;
    }
    const parts: string[] = [];
    if (result.settled) {
      parts.push(`Settled Attempt ${result.rows[0].attemptId} as interrupted (${unit}).`);
    }
    if (result.reconciled) {
      const target = result.lifecycleRows[result.lifecycleRows.length - 1]?.targetStatus;
      parts.push(`Reconciled lifecycle to ${target} (${unit}) without deleting SUMMARYs.`);
    }
    ctx.ui.notify(parts.join(" "), "info");
  } catch (error) {
    ctx.ui.notify(`gsd task settle: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
