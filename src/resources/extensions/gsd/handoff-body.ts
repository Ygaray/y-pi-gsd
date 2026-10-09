// Project/App: gsd-pi
// File Purpose: pure builder of the five-section yahir-handoff body y-pi-gsd registers on an
// explicit pause (HANDOFF-01, D-02). No I/O: callers pass canonical state, paused-session
// metadata and any folded notes; the result is a title plus a template-valid body.

import { sanitizeCliText } from "./commands-doc.js";
import type { PausedSessionMetadata } from "./interrupted-session.js";

export const HANDOFF_TITLE_MAX = 100;
/** The five canonical `## ` sections yahir-handoff's template requires, in order. */
export const HANDOFF_SECTIONS = ["Goal", "State", "Next steps", "Open decisions", "Gotchas"] as const;

export interface HandoffNotes {
  text: string;
  /** ISO timestamp of the notes file's last write */
  mtime: string;
}

export interface HandoffRef {
  id: string;
  title?: string;
}

export interface HandoffBodyInput {
  source: "pause" | "pause-work";
  projectName: string;
  milestone: HandoffRef | null;
  slice: HandoffRef | null;
  task: HandoffRef | null;
  phase: string | null;
  nextAction: string | null;
  blockers: string[];
  recentDecisions: string[];
  paused: PausedSessionMetadata | null;
  autoActiveAtRegistration: boolean;
  notes: HandoffNotes | null;
  now: Date;
}

export interface BuiltHandoffBody {
  title: string;
  body: string;
}

/** Sanitize, collapse whitespace to a single line and cut to `max` characters (with an ellipsis). */
export function oneLine(text: string, max: number): string {
  const flat = sanitizeCliText(String(text)).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function refLabel(ref: HandoffRef): string {
  const title = ref.title ? oneLine(ref.title, 120) : "";
  return title ? `${oneLine(ref.id, 60)} — ${title}` : oneLine(ref.id, 60);
}

/** DP-14: always starts with "y-pi-gsd", one line, at most HANDOFF_TITLE_MAX characters. */
export function buildHandoffTitle(input: HandoffBodyInput): string {
  const ids = [input.milestone?.id, input.slice?.id, input.task?.id].filter(
    (id): id is string => typeof id === "string" && id !== "",
  );
  const subject = input.paused?.unitId || (ids.length > 0 ? ids.join("/") : input.projectName);
  const milestoneTitle = input.milestone?.title ? ` — ${input.milestone.title}` : "";
  return oneLine(`y-pi-gsd paused: ${subject}${milestoneTitle}`, HANDOFF_TITLE_MAX);
}

export function buildHandoffBody(input: HandoffBodyInput): BuiltHandoffBody {
  const title = buildHandoffTitle(input);
  const paused = input.paused;

  const goal = [title, "", `Pick up where the paused y-pi-gsd session stopped (source: /gsd ${input.source}).`];

  const state: string[] = [`- Project: ${oneLine(input.projectName, 120)}`];
  if (input.milestone) state.push(`- Milestone: ${refLabel(input.milestone)}`);
  if (input.slice) state.push(`- Slice: ${refLabel(input.slice)}`);
  if (input.task) state.push(`- Task: ${refLabel(input.task)}`);
  if (input.phase) state.push(`- Phase: ${oneLine(input.phase, 60)}`);
  if (paused?.unitType || paused?.unitId) {
    state.push(`- Paused unit: ${oneLine(`${paused.unitType ?? "unit"} ${paused.unitId ?? ""}`, 200)}`);
  }
  if (paused?.pausedAt) state.push(`- Paused at: ${oneLine(paused.pausedAt, 60)}`);

  const resumeLine = paused
    ? paused.stepMode
      ? "1. Run `/gsd resume-work` in y-pi-gsd: it takes this handoff and re-enters `/gsd next`."
      : "1. Run `/gsd resume-work` in y-pi-gsd: it takes this handoff and re-enters `/gsd auto`."
    : "1. Run `/gsd resume-work` in y-pi-gsd: it takes this handoff and resumes from canonical project state.";
  const nextSteps = [resumeLine, "2. Or run `/gsd auto` / `/gsd next` directly."];
  if (input.nextAction && input.nextAction.trim() !== "") {
    nextSteps.push(`3. Next action from state: ${oneLine(input.nextAction, 300)}`);
  }

  const open = input.blockers.length > 0 ? input.blockers.map((b) => `- ${oneLine(b, 300)}`) : ["None recorded."];
  const gotchas = ["None recorded."];

  const sections: Array<readonly [string, string[]]> = [
    ["Goal", goal],
    ["State", state],
    ["Next steps", nextSteps],
    ["Open decisions", open],
    ["Gotchas", gotchas],
  ];
  const body = sections.map(([name, lines]) => `## ${name}\n${lines.join("\n")}`).join("\n\n") + "\n";
  return { title, body };
}
