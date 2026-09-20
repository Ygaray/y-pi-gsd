// gsd-pi — Real-guard-wired, bash-invocable SELF-UAT write enforcement.
//
// Reads a JSON payload from stdin, imports the REAL `renderSelfUat`,
// `selfUatLogFileName`, `SELF_UAT_LOG_DIR_RELATIVE`, and `SelfUatRenderError`
// from `verify-agentic-log.ts` (never reimplemented here), validates the
// payload's shape, and — only on success — performs the write itself. This
// is the mechanical backstop T-07-01/T-07-06 named as missing: the guards
// already unit-tested in `verify-agentic-log.test.ts` now run on the real
// write path, invoked by the spawned `agentic-tester` child via its `bash`
// tool (SKILL.md Step 6), not merely described in prose.
//
// This script accepts no CLI argument, environment variable, or payload
// field that names or influences an output path. Its only possible write
// target is `SELF_UAT_LOG_DIR_RELATIVE` (imported, never restated) joined
// with a `selfUatLogFileName`-derived filename.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  renderSelfUat,
  selfUatLogFileName,
  SELF_UAT_LOG_DIR_RELATIVE,
  SelfUatRenderError,
} from "../../extensions/gsd/verify-agentic-log.ts";

const REJECTION_PREFIX = "SELF_UAT_ENFORCEMENT_REJECTED:";

function reject(reason) {
  process.stderr.write(`${REJECTION_PREFIX} ${reason}\n`);
  process.exit(1);
  // Unreachable in real execution — process.exit() halts the process
  // synchronously. This throw is a defensive backstop: it makes the control
  // flow explicit rather than relying solely on every call site's reader
  // knowing that process.exit() never returns, so a future refactor (e.g.
  // wrapping this logic in a function, or a test harness stubbing
  // process.exit to not actually terminate) cannot silently fall through
  // into code that assumes rejection already happened.
  throw new Error("unreachable: process.exit() did not terminate the process");
}

let raw;
try {
  raw = readFileSync(0, "utf8");
} catch (err) {
  reject(`failed to read stdin — ${err instanceof Error ? err.message : String(err)}`);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  reject(`stdin was not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
}

if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
  reject("payload must be a JSON object");
}

const { target, surface, results } = payload;

if (typeof target !== "string" || target.trim().length === 0) {
  reject("payload.target must be a non-empty string");
}
if (typeof surface !== "string" || surface.trim().length === 0) {
  reject("payload.surface must be a non-empty string");
}
if (!Array.isArray(results)) {
  reject("payload.results must be an array");
}

for (const result of results) {
  const criterion = result && typeof result === "object" ? result.criterion : undefined;
  if (typeof criterion !== "string" || criterion.trim().length === 0) {
    reject("a result has a missing or empty criterion");
  }
  const verdict = result.verdict;
  if (verdict !== "PASS" && verdict !== "FAIL") {
    reject(`result for "${criterion}" has a verdict that is not exactly "PASS" or "FAIL"`);
  }
  if (typeof result.evidence !== "string") {
    reject(`result for "${criterion}" has non-string evidence`);
  }
  if (result.rootCause !== undefined && typeof result.rootCause !== "string") {
    reject(`result for "${criterion}" has non-string rootCause`);
  }
  if (result.gapClosureRoute !== undefined && typeof result.gapClosureRoute !== "string") {
    reject(`result for "${criterion}" has non-string gapClosureRoute`);
  }
}

// Computed here, never accepted from the payload, so a written log's
// timestamp always reflects the moment of a validated write.
const timestampIso = new Date().toISOString();

let rendered;
try {
  rendered = renderSelfUat(results, { target, surface, timestampIso });
} catch (err) {
  if (err instanceof SelfUatRenderError) {
    reject(err.message);
  }
  throw err;
}

const dir = join(process.cwd(), SELF_UAT_LOG_DIR_RELATIVE);
mkdirSync(dir, { recursive: true });
const fileName = selfUatLogFileName(target, timestampIso);
const destPath = join(dir, fileName);
writeFileSync(destPath, rendered, "utf8");

process.stdout.write(`WROTE ${join(SELF_UAT_LOG_DIR_RELATIVE, fileName)}\n`);
process.exit(0);
