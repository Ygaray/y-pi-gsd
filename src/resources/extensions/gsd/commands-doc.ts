// Project/App: gsd-pi
// File Purpose: /gsd doc command surface — publishes one project .md file to the
// tailnet by calling the yahir-tn doc CLI contract (DOCS-01). Operator-triggered
// only (D-01): never register a workflow tool, LLM tool, or auto-publish hook for it.

import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { projectRoot } from "./commands/context.js";
import { externalProjectsRoot } from "./repo-identity.js";

export const YAHIR_TN_BIN = "yahir-tn";
/** yahir-tn spends up to 30 s on yahir-docs plus a 3 s loopback probe (D-08). */
export const DEFAULT_DOC_TIMEOUT_MS = 45_000;
export const YAHIR_TN_INSTALL_HINT =
  "Install it by running the yahir-tn repo's install.sh (for example ~/Projects/yahir-agentic-tools/yahir-tn/install.sh, which links ~/.local/bin/yahir-tn), and make sure ~/.local/bin is on the PATH of the process running y-pi-gsd.";
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
  // A canonical URL is printable ASCII. Anything else (bidi overrides, zero-width or
  // other format characters, raw IDN) can make the displayed link differ from what a
  // browser opens, so the raw string is only shown when it is plain ASCII (WR-03).
  if (/[^\u0021-\u007e]/.test(url)) {
    return { ok: false, reason: "result.url contains non-ASCII or non-printable characters" };
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
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "result.url contains credentials (user info before the host)" };
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
  // Allowed real roots: the project itself, plus .gsd and .planning ONLY when they are
  // symlinks into GSD's own external state area (ensureGsdSymlink points .gsd at
  // <gsd home>/projects/<hash>). A repo-shipped .planning/.gsd symlink aimed anywhere
  // else (for example `.gsd -> ~`) must not widen the boundary (WR-01). A missing or
  // dangling candidate is skipped.
  const allowedRoots: string[] = [];
  const tryRealpath = (p: string): string | null => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const projectReal = tryRealpath(root);
  if (projectReal) allowedRoots.push(projectReal);
  const stateHome = tryRealpath(externalProjectsRoot());
  if (stateHome) {
    for (const dir of [join(root, ".gsd"), join(root, ".planning")]) {
      const real = tryRealpath(dir);
      if (real && isWithin(stateHome, real)) allowedRoots.push(real);
    }
  }
  if (!allowedRoots.some((allowed) => isWithin(allowed, realPath))) {
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

/**
 * Coerce a directory name into a yahir-docs project slug (store.py rules): runs of
 * disallowed characters become "-", leading non-alphanumerics are dropped, the result
 * is cut to 64 characters, then trailing .html/.htm is stripped. Case is preserved
 * (URL paths are case-sensitive and existing docs are keyed by original case).
 */
export function sanitizeProjectSlug(name: string): string | null {
  let s = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  while (HTML_SUFFIX_RE.test(s)) s = s.replace(HTML_SUFFIX_RE, "");
  return PROJECT_SLUG_RE.test(s) && !HTML_SUFFIX_RE.test(s) ? s : null;
}

// ─── Args / argv ────────────────────────────────────────────────────────────

export type DocArgs = { ok: true; path: string; keep: boolean } | { ok: false; reason: string };

export function parseDocArgs(args: string): DocArgs {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(args)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  let keep = false;
  const paths: string[] = [];
  for (const token of tokens) {
    if (token === "--keep") {
      keep = true;
    } else if (token.startsWith("-")) {
      return { ok: false, reason: `Unknown option "${token}". ${DOC_USAGE}` };
    } else {
      paths.push(token);
    }
  }
  if (paths.length === 0) return { ok: false, reason: DOC_USAGE };
  if (paths.length > 1) {
    return {
      ok: false,
      reason: `Expected exactly one path (quote a path that contains spaces). ${DOC_USAGE}`,
    };
  }
  return { ok: true, path: paths[0], keep };
}

export function buildYahirTnArgv(slug: string, realPath: string, keep: boolean): string[] {
  return ["doc", slug, realPath, ...(keep ? ["--keep"] : []), "--json"];
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences (CSI, OSC, other ESC pairs) and control characters
 * other than newline and tab, plus zero-width and bidi format characters, from
 * CLI-originated text before it reaches notify.
 */
export function sanitizeCliText(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[\s\S]?/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    // zero-width, bidi and other invisible format characters (WR-03)
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "");
}

function tailChars(text: string, n: number): string {
  const t = text.trim();
  return t.length > n ? t.slice(t.length - n) : t;
}

export interface CliError {
  code: number | null;
  message: string;
  hint: string | null;
}

function asCliError(value: unknown): CliError | null {
  if (typeof value !== "object" || value === null) return null;
  const err = (value as Record<string, unknown>).error;
  if (typeof err !== "object" || err === null) return null;
  const e = err as Record<string, unknown>;
  if (typeof e.message !== "string") return null;
  return {
    code: typeof e.code === "number" ? e.code : null,
    message: e.message,
    hint: typeof e.hint === "string" ? e.hint : null,
  };
}

/** Parse the CLI's one-line {"error":{code,message,hint}} from stderr (whole text, else its last non-empty line). */
export function parseCliError(stderr: string): CliError | null {
  const trimmed = stderr.trim();
  if (trimmed === "") return null;
  const candidates = [trimmed];
  const lines = trimmed.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length > 0) candidates.push(lines[lines.length - 1]);
  for (const c of candidates) {
    try {
      const parsed = asCliError(JSON.parse(c));
      if (parsed) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** One message per failure class; no URL is ever presented as openable here. */
export function formatRunFailure(run: YahirTnRun, timeoutMs: number): string {
  if (run.spawnError === "ENOENT") {
    return `yahir-tn is not installed or not on PATH, so nothing was published. ${YAHIR_TN_INSTALL_HINT}`;
  }
  if (run.spawnError) {
    return `Could not run yahir-tn or read its output (${sanitizeCliText(run.spawnError)}). If it ran, the doc may have been published: check \`yahir-tn ps\`.`;
  }
  if (run.timedOut) {
    return `yahir-tn doc did not finish within ${String(timeoutMs / 1000)} s and was stopped. The doc may still have been published: check \`yahir-tn ps\`.`;
  }
  if (run.signal) {
    return `yahir-tn doc was killed by ${sanitizeCliText(run.signal)}. The doc may or may not have been published: check \`yahir-tn ps\`.`;
  }
  const cli = parseCliError(run.stderr);
  if (run.exitCode === 5) {
    const message = cli ? cli.message : tailChars(run.stderr, 300) || "(no output)";
    const lines = [
      "Published but NOT served: yahir-tn wrote the doc, but the docs server did not answer for it, so there is no URL to open.",
      `Diagnostic (host-side loopback check, not openable from your laptop): ${sanitizeCliText(message)}`,
    ];
    if (cli?.hint) lines.push(`Hint: ${sanitizeCliText(cli.hint)}`);
    return lines.join("\n");
  }
  if (cli) {
    const head = `yahir-tn doc failed (exit ${run.exitCode}): ${sanitizeCliText(cli.message)}`;
    return cli.hint ? `${head}\nHint: ${sanitizeCliText(cli.hint)}` : head;
  }
  const tail = tailChars(run.stderr, 300);
  return `yahir-tn doc failed (exit ${run.exitCode}). Last output: ${tail ? sanitizeCliText(tail) : "(no output)"}`;
}

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
      ctx.ui.notify(formatRunFailure(result, timeoutMs), "error");
      return;
    }
    const published = parsePublishResult(result.stdout, checked.realPath);
    if (!published.ok) {
      ctx.ui.notify(
        `yahir-tn doc finished but its output cannot be used (${sanitizeCliText(published.reason)}), so no URL is shown. The doc may have been published: check \`yahir-tn ps\`.`,
        "error",
      );
      return;
    }
    const d = published.doc;
    ctx.ui.notify(
      formatPublishSuccess({
        url: sanitizeCliText(d.url),
        source: sanitizeCliText(d.source),
        name: d.name === null ? null : sanitizeCliText(d.name),
        expiresAt: d.expiresAt === null ? null : sanitizeCliText(d.expiresAt),
        pinned: d.pinned,
      }),
      "success",
    );
  } catch (err) {
    ctx.ui.notify(`/gsd doc failed unexpectedly: ${errMessage(err)}`, "error");
  }
}
