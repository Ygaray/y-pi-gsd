// Project/App: gsd-pi
// File Purpose: /gsd doc command surface — publishes one project .md file to the
// tailnet by calling the yahir-tn doc CLI contract (DOCS-01). Operator-triggered
// only (D-01): never register a workflow tool, LLM tool, or auto-publish hook for it.

import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path";

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { projectRoot } from "./commands/context.js";

export const YAHIR_TN_BIN = "yahir-tn";
/** yahir-tn spends up to 30 s on yahir-docs plus a 3 s loopback probe (D-08). */
export const DEFAULT_DOC_TIMEOUT_MS = 45_000;
export const DOC_USAGE =
  "Usage: /gsd doc <path-to-.md> [--keep]  (relative to the current directory, or absolute; the file must be inside this project, its .gsd/ or its .planning/)";

// ─── Runner ─────────────────────────────────────────────────────────────────

export interface YahirTnRun {
  /** true only for exit code 0 */
  ok: boolean;
  /** numeric process exit code when the child ran to completion */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** set when the child could not be spawned or its output could not be read (ENOENT, EACCES, ...) */
  spawnError?: string;
  /** set when our timeout fired and the child was killed */
  timedOut?: boolean;
  /** set when the child died from a signal we did not send */
  signal?: string;
}

export type YahirTnRunner = (argv: readonly string[], timeoutMs: number) => Promise<YahirTnRun>;

/**
 * Async, result-returning spawn of yahir-tn. The returned promise never rejects.
 * No shell, no working-directory option (a bad cwd would also report ENOENT and be
 * mistaken for "not installed"), no env option (inherits process.env at call time).
 */
export const runYahirTn: YahirTnRunner = (argv, timeoutMs) =>
  new Promise<YahirTnRun>((resolvePromise) => {
    const spawnFailure = (code: string): YahirTnRun => ({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      spawnError: code,
    });
    try {
      const child = execFile(YAHIR_TN_BIN, [...argv], { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          const out = String(stdout ?? "");
          const errText = String(stderr ?? "");
          if (!err) {
            resolvePromise({ ok: true, exitCode: 0, stdout: out, stderr: errText });
            return;
          }
          const e = err as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string | null;
            code?: string | number | null;
          };
          if (e.killed && e.signal === "SIGTERM") {
            resolvePromise({ ok: false, exitCode: null, stdout: out, stderr: errText, timedOut: true });
          } else if (typeof e.code === "string") {
            resolvePromise({ ok: false, exitCode: null, stdout: out, stderr: errText, spawnError: e.code });
          } else if (typeof e.code === "number") {
            resolvePromise({ ok: false, exitCode: e.code, stdout: out, stderr: errText });
          } else {
            resolvePromise({
              ok: false,
              exitCode: null,
              stdout: out,
              stderr: errText,
              signal: e.signal ?? undefined,
            });
          }
        },
      );
      child.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        resolvePromise(spawnFailure(typeof code === "string" ? code : "SPAWN_FAILED"));
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      resolvePromise(spawnFailure(typeof code === "string" ? code : "SPAWN_FAILED"));
    }
  });

// ─── Envelope parser ────────────────────────────────────────────────────────

export interface PublishedDoc {
  url: string;
  source: string;
  name: string | null;
  expiresAt: string | null;
  pinned: boolean;
}

export type ParsedPublish = { ok: true; doc: PublishedDoc } | { ok: false; reason: string };

/**
 * Parse the schema_version 1 envelope. Reads only url, source, name, expires_at and
 * pinned from result; the row's lifecycle-status field is never read (D-08).
 */
export function parsePublishResult(stdout: string, sentPath: string): ParsedPublish {
  let env: unknown;
  try {
    env = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "yahir-tn printed non-JSON output" };
  }
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return { ok: false, reason: "yahir-tn output is not a JSON object" };
  }
  const e = env as Record<string, unknown>;
  if (e.schema_version !== 1) {
    return {
      ok: false,
      reason: `unsupported schema_version ${JSON.stringify(e.schema_version)} (expected 1)`,
    };
  }
  const r = e.result;
  if (typeof r !== "object" || r === null) {
    return { ok: false, reason: "the envelope has no result object" };
  }
  const res = r as Record<string, unknown>;
  const url = res.url;
  if (typeof url !== "string") {
    return {
      ok: false,
      reason: "result has no url (yahir-tn returned a raw docs item instead of a ps row)",
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(url)) {
    return { ok: false, reason: "result.url contains whitespace or control characters" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "result.url is not a valid URL" };
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "") {
    return { ok: false, reason: "result.url is not an https URL" };
  }
  return {
    ok: true,
    doc: {
      url,
      source: typeof res.source === "string" && res.source !== "" ? res.source : sentPath,
      name: typeof res.name === "string" && res.name !== "" ? res.name : null,
      expiresAt: typeof res.expires_at === "string" ? res.expires_at : null,
      pinned: res.pinned === true,
    },
  };
}

// ─── Path guard ─────────────────────────────────────────────────────────────

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  const traversesParent = rel === ".." || rel.startsWith(`..${sep}`);
  return rel === "" || (!traversesParent && !isAbsolute(rel) && !win32.isAbsolute(rel));
}

export type PathCheck = { ok: true; realPath: string } | { ok: false; reason: string };

/**
 * Validate a typed path and return its realpath (which is what gets published, so
 * what was validated is exactly what is sent). realpath comes first so a lexical
 * check can never be fooled by a symlink.
 */
export function checkPublishablePath(typedPath: string, baseDir: string, root: string): PathCheck {
  const abs = resolve(baseDir, typedPath);
  let realPath: string;
  try {
    realPath = realpathSync(abs);
  } catch {
    return { ok: false, reason: `File not found: ${abs}` };
  }
  let isFile = false;
  try {
    isFile = statSync(realPath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    return {
      ok: false,
      reason: `${realPath} is a directory or not a regular file; /gsd doc publishes a single .md file`,
    };
  }
  if (!/\.md$/i.test(basename(realPath))) {
    return { ok: false, reason: `Only .md files can be published (got ${basename(realPath)})` };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  if (!isWithin(realRoot, realPath)) {
    return {
      ok: false,
      reason: `${abs} resolves to ${realPath}, which is outside this project (${root}). /gsd doc only publishes files inside the project, its .gsd/ or its .planning/.`,
    };
  }
  return { ok: true, realPath };
}

// ─── Slug ───────────────────────────────────────────────────────────────────

// Mirrors yahir-docs store.py PROJECT_RE / HTML_PROJECT_RE (rejects .html AND .htm).
const PROJECT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HTML_SUFFIX_RE = /\.html?$/i;

export function sanitizeProjectSlug(name: string): string | null {
  return PROJECT_SLUG_RE.test(name) && !HTML_SUFFIX_RE.test(name) ? name : null;
}

// ─── Args / argv ────────────────────────────────────────────────────────────

export type DocArgs = { ok: true; path: string; keep: boolean } | { ok: false; reason: string };

export function parseDocArgs(args: string): DocArgs {
  const trimmed = args.trim();
  if (trimmed === "") return { ok: false, reason: DOC_USAGE };
  for (const token of trimmed.split(/\s+/)) {
    if (token.startsWith("-")) {
      return { ok: false, reason: `Unknown option "${token}". ${DOC_USAGE}` };
    }
  }
  return { ok: true, path: trimmed, keep: false };
}

export function buildYahirTnArgv(slug: string, realPath: string, keep: boolean): string[] {
  return ["doc", slug, realPath, ...(keep ? ["--keep"] : []), "--json"];
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function formatPublishSuccess(doc: PublishedDoc): string {
  const lines = [
    `Published: ${doc.url}`,
    `Source:    ${doc.source}`,
    doc.pinned ? "Pinned:    yes (no expiry)" : `Expires:   ${doc.expiresAt ?? "unknown"}`,
    `Name:      ${doc.name ?? "(not reported by yahir-tn)"}`,
  ];
  if (doc.name !== null) lines.push(`Pin it:    yahir-tn pin ${doc.name}`);
  return lines.join("\n");
}

// ─── Handler ────────────────────────────────────────────────────────────────

export interface HandleDocOptions {
  run?: YahirTnRunner;
  timeoutMs?: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleDoc(
  args: string,
  ctx: ExtensionCommandContext,
  opts: HandleDocOptions = {},
): Promise<void> {
  try {
    const parsed = parseDocArgs(args);
    if (!parsed.ok) {
      ctx.ui.notify(parsed.reason, "error");
      return;
    }
    const root = projectRoot();
    const baseDir = ctx.cwd || process.cwd();
    const checked = checkPublishablePath(parsed.path, baseDir, root);
    if (!checked.ok) {
      ctx.ui.notify(checked.reason, "error");
      return;
    }
    const slug = sanitizeProjectSlug(basename(root));
    if (slug === null) {
      ctx.ui.notify(
        `Cannot derive a yahir-docs project name from "${basename(root)}": it needs letters, digits, ".", "_" or "-", at most 64 characters, not ending in .html`,
        "error",
      );
      return;
    }
    const run = opts.run ?? runYahirTn;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_DOC_TIMEOUT_MS;
    const result = await run(buildYahirTnArgv(slug, checked.realPath, parsed.keep), timeoutMs);
    if (!result.ok) {
      const why = result.exitCode ?? result.spawnError ?? (result.timedOut ? "timeout" : result.signal);
      ctx.ui.notify(`yahir-tn doc failed (exit ${why}); no URL to open.`, "error");
      return;
    }
    const published = parsePublishResult(result.stdout, checked.realPath);
    if (!published.ok) {
      ctx.ui.notify(
        `yahir-tn doc returned output that cannot be used (${published.reason}), so no URL is shown.`,
        "error",
      );
      return;
    }
    ctx.ui.notify(formatPublishSuccess(published.doc), "success");
  } catch (err) {
    ctx.ui.notify(`/gsd doc failed unexpectedly: ${errMessage(err)}`, "error");
  }
}
