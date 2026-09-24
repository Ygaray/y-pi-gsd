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
  type TrackerItemRefInput,
  type TrackerItemRefKind,
  type TrackerItemSeverity,
  type TrackerItemType,
} from "./db/writers/tracker-item.js";
import {
  TRACKER_BACKLOG_PROJECTION_FILENAME,
  TRACKER_INCIDENTS_PROJECTION_FILENAME,
} from "./tracker-projection.js";
import { gsdProjectionRoot } from "./paths.js";

const USAGE = 'Usage: /gsd track add --type <backlog|incident> --title "..." '
  + "[--severity HIGH|MEDIUM|LOW] [--detail \"...\"] [--tag <tag>] [--ref <kind>:<value>]";

const TRACKER_ITEM_TYPES: readonly TrackerItemType[] = ["backlog", "incident"];
const TRACKER_ITEM_SEVERITIES: readonly TrackerItemSeverity[] = ["HIGH", "MEDIUM", "LOW"];
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

type ParsedTrackArgs = AddArgs | { error: string };

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

function parseArgs(raw: string): ParsedTrackArgs {
  const tokens = tokenize(raw);
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
  await add(parsed, ctx);
}
