// Project/App: gsd-pi
// File Purpose: /gsd track command surface for the per-project tracker
// (TRACK-03). Unlike the Gate-2 human-UAT sign-off surface, this command
// intentionally HAS a companion agent-callable tool surface (17-04) --
// TRACK-03 requires both the /gsd command AND the MCP tool to reach
// identical DB state through the same writer.

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { join } from "node:path";

import { projectRoot } from "./commands/context.js";
import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import {
  createTrackerItem,
  resolveTrackerItem,
  updateTrackerItem,
  type TrackerItemRefInput,
  type TrackerItemRefKind,
  type TrackerItemSeverity,
  type TrackerItemStatus,
  type TrackerItemType,
  type UpdateTrackerItemInput,
} from "./db/writers/tracker-item.js";
import {
  TRACKER_BACKLOG_PROJECTION_FILENAME,
  TRACKER_INCIDENTS_PROJECTION_FILENAME,
} from "./tracker-projection.js";
import { gsdProjectionRoot } from "./paths.js";

const USAGE = 'Usage: /gsd track add --type <backlog|incident> --title "..." '
  + "[--severity HIGH|MEDIUM|LOW] [--detail \"...\"] [--tag <tag>] [--ref <kind>:<value>]\n"
  + '       /gsd track update <id> [--title "..."] [--severity HIGH|MEDIUM|LOW] '
  + '[--detail "..."] [--status <status>] [--tag <tag>] [--ref <kind>:<value>]\n'
  + '       /gsd track close <id> [--status resolved|closed|wont-fix] [--note "..."]';

const TRACKER_ITEM_TYPES: readonly TrackerItemType[] = ["backlog", "incident"];
const TRACKER_ITEM_SEVERITIES: readonly TrackerItemSeverity[] = ["HIGH", "MEDIUM", "LOW"];
const TRACKER_ITEM_STATUSES: readonly TrackerItemStatus[] = [
  "open",
  "in-progress",
  "resolved",
  "closed",
  "wont-fix",
];
const TRACKER_CLOSE_STATUSES: readonly TrackerItemStatus[] = ["resolved", "closed", "wont-fix"];
const TRACKER_ITEM_REF_KINDS: readonly TrackerItemRefKind[] = [
  "phase",
  "requirement",
  "reviews_md",
  "track_item",
  "control_plane_incident",
];

interface AddArgs {
  kind: "add";
  type: TrackerItemType;
  title: string;
  severity?: TrackerItemSeverity;
  detail?: string;
  tags: string[];
  refs: TrackerItemRefInput[];
}

interface UpdateArgs {
  kind: "update";
  trackId: string;
  title?: string;
  severity?: TrackerItemSeverity;
  detail?: string;
  status?: TrackerItemStatus;
  tags: string[];
  refs: TrackerItemRefInput[];
}

interface CloseArgs {
  kind: "close";
  trackId: string;
  status: "resolved" | "closed" | "wont-fix";
  note?: string;
}

type ParsedTrackArgs = AddArgs | UpdateArgs | CloseArgs | { error: string };

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    tokens.push(match[1] ?? match[2]);
  }
  return tokens;
}

function parseRef(value: string): TrackerItemRefInput | { error: string } {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return { error: `--ref must be <kind>:<value>, got "${value}"` };
  }
  const refKind = value.slice(0, separatorIndex);
  const refValue = value.slice(separatorIndex + 1);
  if (!TRACKER_ITEM_REF_KINDS.includes(refKind as TrackerItemRefKind)) {
    return { error: `--ref kind must be one of ${TRACKER_ITEM_REF_KINDS.join(", ")}, got "${refKind}"` };
  }
  return { refKind: refKind as TrackerItemRefKind, refValue };
}

function parseUpdateArgs(tokens: string[]): UpdateArgs | { error: string } {
  const trackId = tokens[1];
  if (!trackId || trackId.startsWith("--")) {
    return { error: "update requires a tracker id — run /gsd track list to see them." };
  }

  let title: string | undefined;
  let severity: TrackerItemSeverity | undefined;
  let detail: string | undefined;
  let status: TrackerItemStatus | undefined;
  const tags: string[] = [];
  const refs: TrackerItemRefInput[] = [];

  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case "--title": {
        const next = tokens[++i];
        if (!next) return { error: "--title requires a value" };
        title = next;
        break;
      }
      case "--severity": {
        const next = tokens[++i];
        if (!next || !TRACKER_ITEM_SEVERITIES.includes(next as TrackerItemSeverity)) {
          return { error: `--severity must be one of ${TRACKER_ITEM_SEVERITIES.join(", ")}` };
        }
        severity = next as TrackerItemSeverity;
        break;
      }
      case "--detail": {
        const next = tokens[++i];
        if (!next) return { error: "--detail requires a value" };
        detail = next;
        break;
      }
      case "--status": {
        const next = tokens[++i];
        if (!next || !TRACKER_ITEM_STATUSES.includes(next as TrackerItemStatus)) {
          return { error: `--status must be one of ${TRACKER_ITEM_STATUSES.join(", ")}` };
        }
        status = next as TrackerItemStatus;
        break;
      }
      case "--tag": {
        const next = tokens[++i];
        if (!next) return { error: "--tag requires a value" };
        tags.push(next);
        break;
      }
      case "--ref": {
        const next = tokens[++i];
        if (!next) return { error: "--ref requires a value" };
        const parsed = parseRef(next);
        if ("error" in parsed) return parsed;
        refs.push(parsed);
        break;
      }
      default:
        return { error: `Unknown flag "${t}". ${USAGE}` };
    }
  }

  return {
    kind: "update",
    trackId,
    ...(title !== undefined ? { title } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(status !== undefined ? { status } : {}),
    tags,
    refs,
  };
}

function parseCloseArgs(tokens: string[]): CloseArgs | { error: string } {
  const trackId = tokens[1];
  if (!trackId || trackId.startsWith("--")) {
    return { error: "close requires a tracker id — run /gsd track list to see them." };
  }

  let status: "resolved" | "closed" | "wont-fix" = "closed";
  let note: string | undefined;

  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case "--status": {
        const next = tokens[++i];
        if (!next || !TRACKER_CLOSE_STATUSES.includes(next as TrackerItemStatus)) {
          return { error: `--status must be one of ${TRACKER_CLOSE_STATUSES.join(", ")}` };
        }
        status = next as "resolved" | "closed" | "wont-fix";
        break;
      }
      case "--note": {
        const next = tokens[++i];
        if (next === undefined) return { error: "--note requires a value" };
        note = next;
        break;
      }
      default:
        return { error: `Unknown flag "${t}". ${USAGE}` };
    }
  }

  return { kind: "close", trackId, status, ...(note !== undefined ? { note } : {}) };
}

function parseArgs(raw: string): ParsedTrackArgs {
  const tokens = tokenize(raw);
  if (tokens[0] === "update") {
    return parseUpdateArgs(tokens);
  }
  if (tokens[0] === "close") {
    return parseCloseArgs(tokens);
  }
  if (tokens[0] !== "add") {
    return { error: USAGE };
  }

  let type: TrackerItemType | undefined;
  let title: string | undefined;
  let severity: TrackerItemSeverity | undefined;
  let detail: string | undefined;
  const tags: string[] = [];
  const refs: TrackerItemRefInput[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case "--type": {
        const next = tokens[++i];
        if (!next || !TRACKER_ITEM_TYPES.includes(next as TrackerItemType)) {
          return { error: `--type must be one of ${TRACKER_ITEM_TYPES.join(", ")}` };
        }
        type = next as TrackerItemType;
        break;
      }
      case "--title": {
        const next = tokens[++i];
        if (!next) return { error: "--title requires a value" };
        title = next;
        break;
      }
      case "--severity": {
        const next = tokens[++i];
        if (!next || !TRACKER_ITEM_SEVERITIES.includes(next as TrackerItemSeverity)) {
          return { error: `--severity must be one of ${TRACKER_ITEM_SEVERITIES.join(", ")}` };
        }
        severity = next as TrackerItemSeverity;
        break;
      }
      case "--detail": {
        const next = tokens[++i];
        if (!next) return { error: "--detail requires a value" };
        detail = next;
        break;
      }
      case "--tag": {
        const next = tokens[++i];
        if (!next) return { error: "--tag requires a value" };
        tags.push(next);
        break;
      }
      case "--ref": {
        const next = tokens[++i];
        if (!next) return { error: "--ref requires a value" };
        const parsed = parseRef(next);
        if ("error" in parsed) return parsed;
        refs.push(parsed);
        break;
      }
      default:
        return { error: `Unknown flag "${t}". ${USAGE}` };
    }
  }

  if (!type) return { error: `--type is required. ${USAGE}` };
  if (!title) return { error: `--title is required. ${USAGE}` };

  return {
    kind: "add",
    type,
    title,
    ...(severity ? { severity } : {}),
    ...(detail ? { detail } : {}),
    tags,
    refs,
  };
}

async function add(args: AddArgs, ctx: ExtensionCommandContext): Promise<void> {
  const basePath = projectRoot();
  try {
    const opened = await ensureDbOpen(basePath);
    if (!opened) {
      ctx.ui.notify(`No GSD database found at ${basePath} — cannot file a tracker item.`, "warning");
      return;
    }
    const { trackId } = createTrackerItem(
      {
        type: args.type,
        title: args.title,
        ...(args.severity ? { severity: args.severity } : {}),
        ...(args.detail ? { detail: args.detail } : {}),
        dispositionTags: args.tags,
        refs: args.refs,
      },
      basePath,
    );
    const paneFilename = args.type === "backlog"
      ? TRACKER_BACKLOG_PROJECTION_FILENAME
      : TRACKER_INCIDENTS_PROJECTION_FILENAME;
    const panePath = join(gsdProjectionRoot(basePath), paneFilename);
    ctx.ui.notify(`Filed ${trackId}: "${args.title}" — see ${panePath}`, "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to file tracker item: ${msg}`, "warning");
  }
}

/**
 * Update one or more fields, and/or replace the whole back-reference set,
 * for one tracker item. Every field-level rule (including the status
 * whitelist pre-check) lives in `updateTrackerItem` — this handler only
 * parses flags and formats the notification.
 */
async function update(args: UpdateArgs, ctx: ExtensionCommandContext): Promise<void> {
  const basePath = projectRoot();
  try {
    const opened = await ensureDbOpen(basePath);
    if (!opened) {
      ctx.ui.notify(`No GSD database found at ${basePath} — cannot update ${args.trackId}.`, "warning");
      return;
    }
    const input: UpdateTrackerItemInput = { trackId: args.trackId };
    if (args.title !== undefined) input.title = args.title;
    if (args.severity !== undefined) input.severity = args.severity;
    if (args.detail !== undefined) input.detail = args.detail;
    if (args.status !== undefined) input.status = args.status;
    if (args.tags.length > 0) input.dispositionTags = args.tags;
    if (args.refs.length > 0) input.refs = args.refs;
    updateTrackerItem(input, basePath);
    ctx.ui.notify(`Updated ${args.trackId}.`, "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to update ${args.trackId}: ${msg}`, "warning");
  }
}

/** Settle a tracker item exactly once via `resolveTrackerItem`. */
async function close(args: CloseArgs, ctx: ExtensionCommandContext): Promise<void> {
  const basePath = projectRoot();
  try {
    const opened = await ensureDbOpen(basePath);
    if (!opened) {
      ctx.ui.notify(`No GSD database found at ${basePath} — cannot close ${args.trackId}.`, "warning");
      return;
    }
    const { status } = resolveTrackerItem(
      {
        trackId: args.trackId,
        status: args.status,
        ...(args.note !== undefined ? { resolutionNote: args.note } : {}),
      },
      basePath,
    );
    ctx.ui.notify(`${args.trackId} is now ${status}.`, "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to close ${args.trackId}: ${msg}`, "warning");
  }
}

export async function handleTrack(
  args: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
): Promise<void> {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    ctx.ui.notify(parsed.error, "warning");
    return;
  }
  if (parsed.kind === "add") {
    await add(parsed, ctx);
    return;
  }
  if (parsed.kind === "update") {
    await update(parsed, ctx);
    return;
  }
  await close(parsed, ctx);
}
