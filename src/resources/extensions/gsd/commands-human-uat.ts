// Project/App: gsd-pi
// File Purpose: /gsd human-uat command surface — list outstanding Gate-2
// entries and sign one off (LEDGER-03). The only sign-off entry point;
// never register a corresponding workflow tool, MCP tool, or auto-dispatch
// rule (must_haves.prohibitions, T-13-11).

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { join } from "node:path";

import { projectRoot } from "./commands/context.js";
import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import { internalExecutionInvocation } from "./execution-invocation.js";
import {
  HUMAN_UAT_PENDING_PROJECTION_FILENAME,
  readHumanUatPendingLedger,
  renderHumanUatPendingLedger,
} from "./human-uat-pending-projection.js";
import { resolveGate2HumanUatPending } from "./milestone-gate2-human-uat-domain-operation.js";
import { gsdProjectionRoot } from "./paths.js";
import { logWarning } from "./workflow-logger.js";

const USAGE = 'Usage: /gsd human-uat [list] | /gsd human-uat sign-off <entry-id> [--gap] [--note "..."]';

interface ListArgs {
  kind: "list";
}

interface SignOffArgs {
  kind: "sign-off";
  entryId: string;
  gap: boolean;
  note?: string;
}

type ParsedHumanUatArgs = ListArgs | SignOffArgs | { error: string };

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    tokens.push(match[1] ?? match[2]);
  }
  return tokens;
}

function parseArgs(raw: string): ParsedHumanUatArgs {
  const tokens = tokenize(raw);
  if (tokens.length === 0 || tokens[0] === "list") {
    return { kind: "list" };
  }
  if (tokens[0] !== "sign-off") {
    return { error: USAGE };
  }
  const entryId = tokens[1];
  if (!entryId || entryId.startsWith("--")) {
    return { error: "sign-off requires an entry id — run /gsd human-uat list to see them." };
  }
  let gap = false;
  let note: string | undefined;
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--gap") {
      gap = true;
    } else if (t === "--note") {
      const next = tokens[++i];
      if (next === undefined) return { error: "--note requires a value" };
      note = next;
    } else {
      return { error: USAGE };
    }
  }
  if (gap && !note) {
    return { error: "sign-off --gap requires --note \"...\" describing the accepted gap." };
  }
  return { kind: "sign-off", entryId, gap, note };
}

/**
 * The read surface: outstanding (status = 'pending') Gate-2 entries, plus a
 * pointer to the full-detail projection.
 */
async function listOutstanding(ctx: ExtensionCommandContext): Promise<void> {
  const basePath = projectRoot();
  try {
    const opened = await ensureDbOpen(basePath);
    if (!opened) {
      ctx.ui.notify("No outstanding Gate-2 human-UAT entries.", "info");
      return;
    }
    const outstanding = readHumanUatPendingLedger().filter((entry) => entry.status === "pending");
    if (outstanding.length === 0) {
      ctx.ui.notify("No outstanding Gate-2 human-UAT entries.", "info");
      return;
    }
    const lines = outstanding.map((entry) =>
      `${entry.entryId} — ${entry.milestoneId}/${entry.sliceId} (raised ${entry.createdAt}): ${entry.reason}`
    );
    const projectionPath = join(gsdProjectionRoot(basePath), HUMAN_UAT_PENDING_PROJECTION_FILENAME);
    ctx.ui.notify(
      `${lines.join("\n")}\n\nFull detail: ${projectionPath}`,
      "info",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to read Gate-2 human-UAT ledger: ${msg}`, "error");
  }
}

/** The sign-off/drain path: resolves one entry and re-renders the projection so it matches (D-04). */
async function signOff(
  ctx: ExtensionCommandContext,
  args: SignOffArgs,
): Promise<void> {
  const basePath = projectRoot();
  try {
    const opened = await ensureDbOpen(basePath);
    if (!opened) {
      ctx.ui.notify(`No GSD database found at ${basePath} — nothing to sign off.`, "warning");
      return;
    }
    const disposition = args.gap ? "signed-off-with-gap" : "signed-off";
    const resolution = resolveGate2HumanUatPending({
      invocation: internalExecutionInvocation(`human-uat-signoff:${args.entryId}`),
      entryId: args.entryId,
      disposition,
      ...(args.note ? { note: args.note } : {}),
    });
    try {
      renderHumanUatPendingLedger(basePath);
    } catch (err) {
      // A projection-render failure must NOT lose the already-committed
      // resolution -- log and still report success (mirrors
      // rule-registry.ts's _registerGate2HumanUat pattern).
      const msg = err instanceof Error ? err.message : String(err);
      logWarning("command", `human-uat sign-off projection render failed after sign-off ${resolution.entryId}: ${msg}`);
    }
    ctx.ui.notify(
      `Signed off ${resolution.entryId} (${resolution.disposition}) — `
        + `${resolution.milestoneId}/${resolution.sliceId} no longer blocks close.`,
      "info",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to sign off ${args.entryId}: ${msg}`, "error");
  }
}

export async function handleHumanUat(
  args: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
): Promise<void> {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    ctx.ui.notify(parsed.error, "warning");
    return;
  }
  if (parsed.kind === "list") {
    await listOutstanding(ctx);
    return;
  }
  await signOff(ctx, parsed);
}
