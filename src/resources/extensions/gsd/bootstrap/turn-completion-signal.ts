// Project/App: gsd-pi
// File Purpose: Fires the interactive turn-completion signal (bell + notification-store
// entry) and dispatches the mode-independent StopEvent from the agent_end handler.

import type { AgentAbortOrigin, AgentEndEvent, ExtensionContext } from "@gsd/pi-coding-agent";

import { isAutoActive } from "../auto-runtime-state.js";
import { playNotificationBell } from "../notifications.js";
import { appendNotification } from "../notification-store.js";
import { logWarning } from "../workflow-logger.js";
import { emitNotification, emitStop } from "../hook-emitter.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const TURN_COMPLETE_NOTIFICATION_KIND = "turn-complete";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TurnEndStopReason = "completed" | "cancelled" | "error" | "blocked";

export interface TurnEndClassificationInput {
  abortOrigin?: AgentAbortOrigin | string;
  approvalGateBlocking?: boolean;
  destructiveConfirmationBlocking?: boolean;
  lastToolCallSucceeded?: boolean | null;
}

/** Seam for tests; production callers use the defaults. */
export interface TurnCompletionSignalDeps {
  autoActive(): boolean;
  playBell(kind: "attention"): boolean;
  appendNotification(
    message: string,
    severity: "info",
    source: "notify",
    meta: { kind: string; scope?: string },
  ): void;
  emitStop(args: {
    reason: TurnEndStopReason;
    abortOrigin?: AgentAbortOrigin;
    sessionId?: string;
    turnId?: string;
  }): Promise<void>;
  emitNotification(kind: "idle", message: string, details?: Record<string, unknown>): Promise<void>;
}

const defaultTurnCompletionSignalDeps: TurnCompletionSignalDeps = {
  autoActive: () => isAutoActive(),
  playBell: (kind) => playNotificationBell(kind),
  appendNotification: (message, severity, source, meta) => appendNotification(message, severity, source, meta),
  emitStop: (args) => emitStop(args),
  emitNotification: (kind, message, details) => emitNotification(kind, message, details),
};

// ─── Pure Helpers ───────────────────────────────────────────────────────────

/**
 * True when the last message in `messages` carries an unanswered tool call
 * (a `toolCall` content block) — i.e. the turn is not actually done, the
 * model is still waiting on a tool result. Empty/absent `messages` is not
 * pending.
 */
export function hasPendingToolCallInLastMessage(messages: unknown[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as { content?: unknown } | undefined;
  if (!last || !Array.isArray(last.content)) return false;
  return last.content.some((block: unknown) => (block as { type?: unknown })?.type === "toolCall");
}

/**
 * D-01's fire-gate expressed as one testable predicate: fire the interactive
 * completion signal only when auto-mode is not active, the turn is not being
 * retried, there is no queued steering/follow-up work, and no unanswered
 * tool call is pending.
 */
export function shouldFireInteractiveCompletionSignal(args: {
  autoActive: boolean;
  willRetry: boolean;
  hasPendingMessages: boolean;
  hasPendingToolCall: boolean;
}): boolean {
  return !args.autoActive && !args.willRetry && !args.hasPendingMessages && !args.hasPendingToolCall;
}

/**
 * Folds the abortOrigin × blocking-flag × tool-outcome vocabularies down to
 * the four StopEvent.reason literals. Locked mapping table (Task 2 decision,
 * option-a — "RESEARCH's seeded table, mechanically exhaustive"): blocking
 * flags win over every abortOrigin arm (a turn halted waiting on a human
 * answer is blocked, whatever aborted it); absent abortOrigin is a clean
 * completion; user/timeout both collapse to cancelled (mirrors the existing
 * category:"timeout"/isTransient:true treatment at
 * agent-end-recovery.ts:617-624); error maps to error; extension/programmatic
 * classify by whether the turn's last tool call succeeded (strict `=== true`
 * — null/false both stay conservative, i.e. cancelled, never a false
 * success); an unrecognized abortOrigin never silently reports completed —
 * it warns (naming the raw value) and returns error, and a compile-time
 * `never` assertion makes a newly-added AgentAbortOrigin member a
 * typecheck:extensions failure rather than a silent runtime fallthrough.
 */
export function mapTurnEndToStopReason(
  input: TurnEndClassificationInput,
  onUnrecognized?: (message: string) => void,
): TurnEndStopReason {
  if (input.approvalGateBlocking || input.destructiveConfirmationBlocking) return "blocked";

  if (input.abortOrigin === undefined) return "completed";

  const origin = input.abortOrigin as AgentAbortOrigin;
  switch (origin) {
    case "user":
      return "cancelled";
    case "timeout":
      return "cancelled";
    case "error":
      return "error";
    case "extension":
    case "programmatic":
      return input.lastToolCallSucceeded === true ? "completed" : "cancelled";
    default: {
      const _exhaustive: never = origin;
      const warn = onUnrecognized ?? ((m: string) => logWarning("bootstrap", m));
      warn(`mapTurnEndToStopReason: unrecognized abortOrigin ${JSON.stringify(_exhaustive)}`);
      return "error";
    }
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Single call site for the agent_end handler: fires the interactive
 * completion signal (bell + notification-store entry + idle notification)
 * when the gate is satisfied, then unconditionally (auto and interactive
 * alike) dispatches a StopEvent classified by `mapTurnEndToStopReason`.
 * Ordering within one tick is an acceptance criterion: bell -> store append
 * -> emitStop.
 */
export async function signalTurnEnd(
  event: Pick<AgentEndEvent, "messages" | "willRetry" | "abortOrigin">,
  ctx: ExtensionContext,
  signal: {
    approvalGateBlocking?: boolean;
    destructiveConfirmationBlocking?: boolean;
    lastToolCallSucceeded?: boolean | null;
  } = {},
  deps: TurnCompletionSignalDeps = defaultTurnCompletionSignalDeps,
): Promise<void> {
  if (event.willRetry) return;

  // Read synchronously, before any await, so this cannot race a concurrent
  // stopAuto() bell (Pitfall 2).
  const autoActive = deps.autoActive();

  try {
    let hasPendingMessages = false;
    try {
      if (typeof ctx.hasPendingMessages === "function") {
        hasPendingMessages = ctx.hasPendingMessages();
      }
    } catch (err) {
      // A stale runner context throws from assertActive(); treat as no
      // pending messages rather than letting the signal crash agent_end.
      logWarning(
        "bootstrap",
        `signalTurnEnd: ctx.hasPendingMessages() threw (stale runner): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const hasPendingToolCall = hasPendingToolCallInLastMessage(event.messages ?? []);

    if (
      shouldFireInteractiveCompletionSignal({
        autoActive,
        willRetry: false,
        hasPendingMessages,
        hasPendingToolCall,
      })
    ) {
      deps.playBell("attention");
      deps.appendNotification("Turn complete — waiting for you.", "info", "notify", {
        kind: TURN_COMPLETE_NOTIFICATION_KIND,
        scope: "",
      });
      await deps.emitNotification("idle", "Turn complete — waiting for you.");
    }

    const reason = mapTurnEndToStopReason({
      abortOrigin: event.abortOrigin,
      approvalGateBlocking: signal.approvalGateBlocking,
      destructiveConfirmationBlocking: signal.destructiveConfirmationBlocking,
      lastToolCallSucceeded: signal.lastToolCallSucceeded,
    });
    await deps.emitStop({
      reason,
      ...(event.abortOrigin ? { abortOrigin: event.abortOrigin } : {}),
    });
  } catch (err) {
    logWarning(
      "bootstrap",
      `signalTurnEnd failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
