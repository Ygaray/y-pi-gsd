// Project/App: gsd-pi
// File Purpose: pure builder of the five-section yahir-handoff body y-pi-gsd registers on an
// explicit pause (HANDOFF-01, D-02). No I/O: callers pass canonical state, paused-session
// metadata and any folded notes; the result is a title plus a template-valid, capped,
// redacted body. Time comes only from the input.

import { sanitizeCliText } from "./commands-doc.js";
import type { PausedSessionMetadata } from "./interrupted-session.js";
import { redactSecrets } from "./redact-secrets.js";

/** Folded `.gsd/HANDOFF.md` excerpt in State, including its label. */
export const HANDOFF_NOTES_MAX_BYTES = 6144;
/** Gotcha-like sections routed from the notes into Gotchas. */
export const HANDOFF_GOTCHAS_MAX_BYTES = 2048;
/** Whole body (yahir-handoff warns past ~1500 words; the next session pays to read all of it). */
export const HANDOFF_BODY_MAX_BYTES = 12288;
export const HANDOFF_TITLE_MAX = 100;
/** The five canonical `## ` sections yahir-handoff's template requires, in order. */
export const HANDOFF_SECTIONS = ["Goal", "State", "Next steps", "Open decisions", "Gotchas"] as const;

const MAX_BLOCKERS = 10;
const MAX_DECISIONS = 5;
const NONE = "None recorded.";
const TRUNCATED_MARKER = "[truncated]";
const GOTCHA_HEADING_RE = /gotcha|caveat|pitfall|warning/i;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

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

// ─── Text helpers ───────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function byteLen(text: string): number {
  return encoder.encode(text).length;
}

/** Longest prefix of `text` that fits in `max` UTF-8 bytes (never splits a surrogate pair). */
function truncateBytes(text: string, max: number): string {
  if (max <= 0) return "";
  const head = text.length > max ? text.slice(0, max) : text;
  if (byteLen(head) <= max) return head;
  let lo = 0;
  let hi = head.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (byteLen(head.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  let out = head.slice(0, lo);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Sanitize, collapse whitespace to a single line and cut to `max` characters (with an ellipsis). */
export function oneLine(text: string, max: number): string {
  const flat = sanitizeCliText(String(text)).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** Multi-line free text: control characters and escape sequences removed, secrets redacted. */
function cleanText(text: string): string {
  return redactSecrets(sanitizeCliText(String(text)));
}

/**
 * Turn every markdown heading line into a `####` heading so folded text can never open a
 * canonical `## ` section in the receiving template.
 */
export function demoteHeadings(text: string): string {
  return text
    .split("\n")
    .map((line) => (HEADING_RE.test(line) ? "#### " + line.replace(HEADING_RE, "") : line))
    .join("\n");
}

/**
 * Close a code fence left open at the end of `text`, using the same fence rules as
 * yahir-handoff's template parser (an opener's marker character and length decide the closer).
 */
export function balanceFences(text: string): string {
  let fenced: string | null = null;
  for (const line of text.split("\n")) {
    const fm = FENCE_RE.exec(line);
    if (!fm) continue;
    const mark = fm[1];
    const rest = fm[2];
    if (fenced === null) {
      if (mark[0] !== "`" || !rest.includes("`")) fenced = mark;
    } else if (mark[0] === fenced[0] && mark.length >= fenced.length && rest.trim() === "") {
      fenced = null;
    }
  }
  if (fenced === null) return text;
  return text.endsWith("\n") ? text + fenced : `${text}\n${fenced}`;
}

/** Demote, fence-balance and cap `text` to `budget` bytes; a cut ends with a marker line. */
function foldText(text: string, budget: number): string {
  if (budget <= 0) return "";
  const demoted = demoteHeadings(text).trimEnd();
  const whole = balanceFences(demoted);
  if (byteLen(whole) <= budget) return whole;
  let reserve = 64;
  for (;;) {
    const cut = balanceFences(truncateBytes(demoted, Math.max(0, budget - reserve)).trimEnd());
    const out = `${cut}\n${TRUNCATED_MARKER}`;
    if (byteLen(out) <= budget || reserve >= budget) return byteLen(out) <= budget ? out : TRUNCATED_MARKER;
    reserve *= 2;
  }
}

/** Gotcha-like sections of the notes (heading plus content), fences respected. */
function gotchaSections(notesText: string): string {
  const picked: string[] = [];
  let current: string[] | null = null;
  let fenced: string | null = null;
  const flush = (): void => {
    if (current) picked.push(current.join("\n").trimEnd());
    current = null;
  };
  for (const line of notesText.split("\n")) {
    const fm = FENCE_RE.exec(line);
    if (fm) {
      if (fenced === null) {
        if (fm[1][0] !== "`" || !fm[2].includes("`")) fenced = fm[1];
      } else if (fm[1][0] === fenced[0] && fm[1].length >= fenced.length && fm[2].trim() === "") {
        fenced = null;
      }
    }
    if (fenced === null && !fm && HEADING_RE.test(line)) {
      flush();
      if (GOTCHA_HEADING_RE.test(line.replace(HEADING_RE, ""))) current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  flush();
  return picked.join("\n\n");
}

// ─── Title ──────────────────────────────────────────────────────────────────

function refLabel(ref: HandoffRef, scale: number): string {
  const title = ref.title ? oneLine(ref.title, lim(120, scale)) : "";
  const id = oneLine(ref.id, lim(60, scale));
  return title ? `${id} — ${title}` : id;
}

function lim(n: number, scale: number): number {
  return Math.max(20, Math.floor(n * scale));
}

/** DP-14: always starts with "y-pi-gsd", one line, at most HANDOFF_TITLE_MAX characters. */
export function buildHandoffTitle(input: HandoffBodyInput): string {
  const ids = [input.milestone?.id, input.slice?.id, input.task?.id].filter(
    (id): id is string => typeof id === "string" && id !== "",
  );
  const subject = input.paused?.unitId || (ids.length > 0 ? ids.join("/") : input.projectName);
  const milestoneTitle = input.milestone?.title ? ` — ${input.milestone.title}` : "";
  // The title travels separately from the body (argv, manifest, ls, notice), so it needs its own redaction.
  return oneLine(redactSecrets(sanitizeCliText(`y-pi-gsd paused: ${subject}${milestoneTitle}`)), HANDOFF_TITLE_MAX);
}

// ─── Assembly ───────────────────────────────────────────────────────────────

interface Knobs {
  notesBudget: number;
  blockers: number;
  decisions: number;
  /** length scale applied to the one-line fields when the body is still over the cap */
  scale: number;
}

function assemble(input: HandoffBodyInput, title: string, k: Knobs): string {
  const paused = input.paused;
  const scale = k.scale;
  const notes = input.notes;
  const mtime = notes ? oneLine(notes.mtime, 60) : "";

  const goal = [title, "", `Pick up where the paused y-pi-gsd session stopped (source: /gsd ${input.source}).`];

  const state: string[] = [`- Project: ${oneLine(input.projectName, lim(120, scale))}`];
  if (input.milestone) state.push(`- Milestone: ${refLabel(input.milestone, scale)}`);
  if (input.slice) state.push(`- Slice: ${refLabel(input.slice, scale)}`);
  if (input.task) state.push(`- Task: ${refLabel(input.task, scale)}`);
  if (input.phase) state.push(`- Phase: ${oneLine(input.phase, lim(60, scale))}`);
  if (paused) {
    if (paused.unitType || paused.unitId) {
      state.push(`- Paused unit: ${oneLine(`${paused.unitType ?? "unit"} ${paused.unitId ?? ""}`, lim(200, scale))}`);
    }
    if (paused.pausedAt) state.push(`- Paused at: ${oneLine(paused.pausedAt, 60)}`);
    if (paused.pauseReason) state.push(`- Pause reason: ${oneLine(paused.pauseReason, lim(300, scale))}`);
    state.push(
      paused.stepMode
        ? "- Mode: step (resume re-enters /gsd next)"
        : "- Mode: auto (resume re-enters /gsd auto)",
    );
    if (paused.worktreePath) state.push(`- Worktree: ${oneLine(paused.worktreePath, lim(300, scale))}`);
  }
  if (input.autoActiveAtRegistration) {
    state.push("- auto-mode was active at registration (this pause-work did not pause it)");
  }
  for (const d of input.recentDecisions.slice(0, k.decisions)) {
    state.push(`- Decision: ${oneLine(d, lim(200, scale))}`);
  }

  let gotchaText = "";
  if (notes) {
    const label = `Notes from .gsd/HANDOFF.md (last written ${mtime}; may predate this pause):`;
    state.push("");
    if (k.notesBudget > 0) {
      const room = k.notesBudget - byteLen(label) - 2;
      state.push(label, "", foldText(cleanText(notes.text), room));
      const gotchas = gotchaSections(cleanText(notes.text));
      if (gotchas !== "") gotchaText = foldText(gotchas, Math.min(HANDOFF_GOTCHAS_MAX_BYTES, k.notesBudget));
    } else {
      state.push(`Notes from .gsd/HANDOFF.md (last written ${mtime}) omitted: handoff size cap.`);
    }
  }

  const resumeLine = paused
    ? paused.stepMode
      ? "1. Run `/gsd resume-work` in y-pi-gsd: it takes this handoff and re-enters `/gsd next`."
      : "1. Run `/gsd resume-work` in y-pi-gsd: it takes this handoff and re-enters `/gsd auto`."
    : "1. Run `/gsd resume-work` in y-pi-gsd: it takes this handoff and resumes from canonical project state.";
  const nextSteps = [resumeLine, "2. Or run `/gsd auto` / `/gsd next` directly."];
  if (input.nextAction && input.nextAction.trim() !== "") {
    nextSteps.push(`3. Next action from state: ${oneLine(input.nextAction, lim(300, scale))}`);
  }

  const blockers = input.blockers.slice(0, k.blockers).map((b) => `- ${oneLine(b, lim(300, scale))}`);
  const open = blockers.length > 0 ? blockers : [NONE];

  const gotchas: string[] = [];
  if (notes) gotchas.push(`- .gsd/HANDOFF.md was last written ${mtime}; it may predate this pause.`);
  if (gotchaText !== "") gotchas.push("", gotchaText);
  if (gotchas.length === 0) gotchas.push(NONE);

  const sections: Array<readonly [string, string[]]> = [
    ["Goal", goal],
    ["State", state],
    ["Next steps", nextSteps],
    ["Open decisions", open],
    ["Gotchas", gotchas],
  ];
  const body = sections.map(([name, lines]) => `## ${name}\n${lines.join("\n")}`).join("\n\n") + "\n";
  // Defense in depth: nothing control-like or secret-shaped survives, whatever the pieces did.
  return redactSecrets(sanitizeCliText(body));
}

export function buildHandoffBody(input: HandoffBodyInput): BuiltHandoffBody {
  const title = buildHandoffTitle(input);
  const knobs: Knobs = {
    notesBudget: input.notes ? HANDOFF_NOTES_MAX_BYTES : 0,
    blockers: MAX_BLOCKERS,
    decisions: MAX_DECISIONS,
    scale: 1,
  };
  let body = assemble(input, title, knobs);
  // Fit the byte cap by shedding the least important content first: the folded notes, then
  // blockers, then decisions, then shortening every one-line field. Headings and the Next
  // steps lines are never cut.
  for (let guard = 0; guard < 40 && byteLen(body) > HANDOFF_BODY_MAX_BYTES; guard++) {
    const over = byteLen(body) - HANDOFF_BODY_MAX_BYTES;
    if (knobs.notesBudget > 0) {
      const next = knobs.notesBudget - over - 32;
      knobs.notesBudget = next < 256 ? 0 : next;
    } else if (knobs.blockers > 0) {
      knobs.blockers -= 1;
    } else if (knobs.decisions > 0) {
      knobs.decisions -= 1;
    } else if (knobs.scale > 0.1) {
      knobs.scale /= 2;
    } else {
      break;
    }
    body = assemble(input, title, knobs);
  }
  return { title, body };
}
