// gsd-pi — Shared ask_user_questions event channel contract

/**
 * Neutral event channel module for ask_user_questions -> gsd IPC.
 * ask_user_questions is a separate root extension (its own module instances under jiti), so it
 * cannot read gsd's auto-mode state directly; it announces the pending question here and the gsd
 * extension decides what to do with it using its own state. Neither imports the other.
 */

export const QUESTION_CHANNELS = {
  PENDING: "ask-user-questions:pending",
} as const;

export interface QuestionPendingEvent {
  questions: ReadonlyArray<{ id: string; question: string }>;
  /** False when running headless — nobody is at a terminal to see the question. */
  hasUI: boolean;
}
