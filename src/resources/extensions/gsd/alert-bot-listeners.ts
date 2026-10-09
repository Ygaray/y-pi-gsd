// GSD Extension — GSD-alert-bot event-bus listeners
// Turns a pending ask_user_questions prompt into a `needs_input` alert when nobody is watching.
//
// ask_user_questions is a separate root extension with its own module instances, so it can't
// read auto-mode state; it announces on QUESTION_CHANNELS.PENDING and this listener — inside
// the gsd extension, sharing auto.ts's autoSession — applies gsd's own state and project root.

import { basename } from "node:path";
import type { EventBus } from "@gsd/pi-coding-agent";
import { QUESTION_CHANNELS, type QuestionPendingEvent } from "../shared/question-events.js";
import { autoSession, isAutoActive } from "./auto-runtime-state.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { emitAlertBotEvent, type AlertBotFields } from "./alert-bot.js";

export interface AlertBotListenerDeps {
  isAutoActive: () => boolean;
  /** The project the run belongs to — the original root, not an auto worktree. */
  projectRoot: () => string;
  alertBotEnabled: () => boolean;
  emit: (fields: AlertBotFields) => void;
}

const defaultDeps: AlertBotListenerDeps = {
  isAutoActive,
  projectRoot: () => autoSession.originalBasePath || autoSession.basePath || process.cwd(),
  alertBotEnabled: () => loadEffectiveGSDPreferences()?.preferences.notifications?.alert_bot !== false,
  emit: emitAlertBotEvent,
};

/**
 * Subscribe synchronously during gsd bootstrap (see register-extension.ts — the bus does not
 * buffer events for late subscribers). Best-effort: the handler never throws.
 */
export function initAlertBotListeners(events: EventBus, deps: AlertBotListenerDeps = defaultDeps): void {
  events.on(QUESTION_CHANNELS.PENDING, (data) => {
    try {
      const pending = data as QuestionPendingEvent;
      // Interactive chat with nobody running auto-mode: the operator is right there.
      if (pending.hasUI && !deps.isAutoActive()) return;
      if (!deps.alertBotEnabled()) return;
      deps.emit({
        event: "needs_input",
        project: basename(deps.projectRoot()),
        title: pending.questions[0]?.question ?? "Question waiting for an answer",
      });
    } catch {
      // Best-effort: a question must never depend on alert delivery.
    }
  });
}
