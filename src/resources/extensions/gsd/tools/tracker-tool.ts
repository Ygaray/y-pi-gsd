// Project/App: gsd-pi
// File Purpose: Agent-callable tracker handlers (TRACK-03's tool surface).
// These handlers deliberately share the exact writer functions the
// `/gsd track` command uses (`createTrackerItem` / `updateTrackerItem` /
// `resolveTrackerItem`) so the two surfaces cannot drift on validation rules
// or on whether they remember to regenerate the projection (RESEARCH
// Pitfall 5). Every handler coerces the incoming payload's shape and lets the
// writer validate -- it holds no field rule of its own.

import {
  createTrackerItem,
  resolveTrackerItem,
  updateTrackerItem,
  type TrackerItemRefInput,
  type TrackerItemRow,
  type TrackerItemSeverity,
  type TrackerItemStatus,
  type TrackerItemType,
  type UpdateTrackerItemInput,
} from "../db/writers/tracker-item.js";
import { getTrackerStatusSummary, type TrackerStatusSummaryRow } from "../db/queries.js";
import { readTrackerItems } from "../tracker-projection.js";
import { isNonEmptyString } from "../validation.js";

const NON_TERMINAL_STATUSES: readonly TrackerItemStatus[] = ["open", "in-progress"];

export interface TrackCreateParams {
  type: TrackerItemType;
  title: string;
  severity?: TrackerItemSeverity;
  detail?: string;
  dispositionTags?: string[];
  refs?: TrackerItemRefInput[];
}

export interface TrackCreateResult {
  trackId: string;
}

export interface TrackUpdateParams {
  trackId: string;
  title?: string;
  severity?: TrackerItemSeverity;
  detail?: string;
  dispositionTags?: string[];
  status?: TrackerItemStatus;
  refs?: TrackerItemRefInput[];
}

export interface TrackUpdateResult {
  trackId: string;
  changed: boolean;
}

export interface TrackCloseParams {
  trackId: string;
  status?: "resolved" | "closed" | "wont-fix";
  resolutionNote?: string;
}

export interface TrackCloseResult {
  trackId: string;
  status: TrackerItemStatus;
}

export interface TrackListParams {
  type?: TrackerItemType;
  status?: TrackerItemStatus;
  all?: boolean;
}

export interface TrackListResult {
  items: TrackerItemRow[];
  summary: TrackerStatusSummaryRow[];
}

/**
 * Trim only when the value is genuinely present and non-blank -- a purely
 * shape-level decision (whether it's safe to call `.trim()`), never a
 * rejection. Blank/absent titles still reach `createTrackerItem`/
 * `updateTrackerItem` untouched, which is the sole place that rejects them.
 */
function shapeTitle(title: string): string {
  return isNonEmptyString(title) ? title.trim() : title;
}

/**
 * File one tracker item and its back-references. Coerces the tool payload
 * into `CreateTrackerItemInput`'s shape (defaulting `dispositionTags`/`refs`
 * to empty arrays) and calls `createTrackerItem` inside a try/catch -- every
 * field rule (closed vocabularies, non-blank title, ref shape) lives in the
 * writer, so a rejected input here refuses with the exact same message the
 * `/gsd track add` command surface would produce for the same input.
 */
export async function handleTrackCreate(
  params: TrackCreateParams,
  basePath: string,
): Promise<TrackCreateResult | { error: string }> {
  try {
    const { trackId } = createTrackerItem(
      {
        type: params.type,
        title: shapeTitle(params.title),
        ...(params.severity !== undefined ? { severity: params.severity } : {}),
        ...(params.detail !== undefined ? { detail: params.detail } : {}),
        dispositionTags: params.dispositionTags ?? [],
        refs: params.refs ?? [],
      },
      basePath,
    );
    return { trackId };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Update one or more mutable fields and/or replace the whole back-reference
 * set on a tracker item. Only fields the caller actually supplied are
 * forwarded to `updateTrackerItem` -- an absent field is left untouched, not
 * defaulted to empty, mirroring the command surface's own flag-supplied
 * semantics (17-02's `/gsd track update`). The status-transition whitelist
 * check and "no change requested" rule both live in the writer.
 */
export async function handleTrackUpdate(
  params: TrackUpdateParams,
  basePath: string,
): Promise<TrackUpdateResult | { error: string }> {
  try {
    const input: UpdateTrackerItemInput = { trackId: params.trackId };
    if (params.title !== undefined) input.title = shapeTitle(params.title);
    if (params.severity !== undefined) input.severity = params.severity;
    if (params.detail !== undefined) input.detail = params.detail;
    if (params.dispositionTags !== undefined) input.dispositionTags = params.dispositionTags;
    if (params.status !== undefined) input.status = params.status;
    if (params.refs !== undefined) input.refs = params.refs;
    return updateTrackerItem(input, basePath);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Settle a tracker item exactly once via `resolveTrackerItem`. `status`
 * defaults to `"closed"` when the caller omits it, matching `/gsd track
 * close`'s own default. A repeat close on an already-terminal item refuses
 * with the writer's message naming the current status.
 */
export async function handleTrackClose(
  params: TrackCloseParams,
  basePath: string,
): Promise<TrackCloseResult | { error: string }> {
  try {
    return resolveTrackerItem(
      {
        trackId: params.trackId,
        status: params.status ?? "closed",
        ...(params.resolutionNote !== undefined ? { resolutionNote: params.resolutionNote } : {}),
      },
      basePath,
    );
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Read-only: filters `readTrackerItems()`'s full-table read exactly as the
 * command's `list` arm does (defaulting to non-terminal items unless `all`
 * is set), and pairs it with `getTrackerStatusSummary()` so an agent gets the
 * same deterministic summary an operator sees (D-02). A summary read failure
 * propagates into `{ error }` rather than reporting an empty summary --
 * an unreadable tracker must never read as zero open items (T-17-08).
 */
export async function handleTrackList(
  params: TrackListParams,
): Promise<TrackListResult | { error: string }> {
  try {
    const summary = getTrackerStatusSummary();
    const items = readTrackerItems()
      .filter((item) => (params.type ? item.type === params.type : true))
      .filter((item) => {
        if (params.status) return item.status === params.status;
        if (params.all) return true;
        return NON_TERMINAL_STATUSES.includes(item.status);
      });
    return { items, summary };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
