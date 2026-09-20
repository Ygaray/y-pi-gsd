/**
 * Real-subprocess coverage for `write-self-uat.mjs` — the bash-invocable
 * script that wires the real `renderSelfUat`/`validateResults` guards onto
 * the actual SELF-UAT write path (T-07-01, T-07-06).
 *
 * Every case here spawns a GENUINE `node --experimental-strip-types` child
 * process against the script under test. This file never calls the script's
 * internal logic in-process — that in-process shortcut is precisely what
 * `verify-agentic-log.test.ts` already does, and it is not evidence the
 * mechanism enforces anything on a real invocation. Mirrors the
 * `spawnSync(process.execPath, [...])` shape from `lazy-pi-tui-import.test.ts`.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { renderSelfUat, type SelfUatCriterionResult, type SelfUatMeta } from "../verify-agentic-log.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname is src/resources/extensions/gsd/tests; the script lives at
// src/resources/skills/agentic-tester/write-self-uat.mjs — three levels up
// to src/resources, then down into skills/agentic-tester.
const scriptPath = join(__dirname, "../../../skills/agentic-tester/write-self-uat.mjs");

const REJECTION_PREFIX = "SELF_UAT_ENFORCEMENT_REJECTED:";

// Build the patch-marker fixture via array-join/char-code construction rather
// than pasting a raw diff marker inline, mirroring verify-agentic-log.test.ts's
// own fixture-construction convention.
const BACKTICK = String.fromCharCode(96);
function fencedDiffBlock(): string {
  return [BACKTICK, BACKTICK, BACKTICK, "diff", "\n", "+line", "\n", BACKTICK, BACKTICK, BACKTICK].join("");
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "write-self-uat-"));
  tmpDirs.push(tmp);
  return tmp;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface Invocation {
  status: number | null;
  stdout: string;
  stderr: string;
  tmpDir: string;
}

function invoke(payload: unknown): Invocation {
  const tmpDir = makeTmpDir();
  const result = spawnSync(process.execPath, ["--experimental-strip-types", scriptPath], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf-8",
    cwd: tmpDir,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, tmpDir };
}

function assertRejectedNoWrite(inv: Invocation): void {
  assert.notEqual(inv.status, 0, `expected non-zero exit; stderr:\n${inv.stderr}`);
  assert.ok(
    inv.stderr.includes(REJECTION_PREFIX),
    `expected stderr to contain "${REJECTION_PREFIX}"; got:\n${inv.stderr}`,
  );
  let entries: string[] = [];
  try {
    entries = readdirSync(join(inv.tmpDir, ".gsd", "verify-agentic"));
  } catch {
    entries = [];
  }
  assert.deepEqual(entries, [], "expected no .gsd/verify-agentic entries after a rejection");
}

describe("write-self-uat.mjs — real subprocess enforcement", () => {
  it("rejects a result with empty evidence and writes nothing", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [{ criterion: "login works", verdict: "PASS", evidence: "" }],
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects a FAIL with rootCause omitted and writes nothing", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [{ criterion: "logout works", verdict: "FAIL", evidence: "exit 1" }],
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects a FAIL with rootCause empty string and writes nothing", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [{ criterion: "logout works", verdict: "FAIL", evidence: "exit 1", rootCause: "" }],
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects a FAIL with rootCause whitespace-only and writes nothing", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [{ criterion: "logout works", verdict: "FAIL", evidence: "exit 1", rootCause: "   " }],
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects a FAIL whose rootCause restates its criterion (case-insensitive) and writes nothing", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [
        { criterion: "logout works", verdict: "FAIL", evidence: "exit 1", rootCause: "LOGOUT WORKS" },
      ],
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects a FAIL whose gapClosureRoute carries a fenced diff block and writes nothing", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [
        {
          criterion: "logout works",
          verdict: "FAIL",
          evidence: "exit 1",
          rootCause: "exit 1, stderr: ENOENT — the binary was never built",
          gapClosureRoute: fencedDiffBlock(),
        },
      ],
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects a result with a verdict outside PASS/FAIL and writes nothing", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [{ criterion: "login works", verdict: "maybe", evidence: "exit 0" }],
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects a result with an empty criterion and writes nothing", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [{ criterion: "", verdict: "PASS", evidence: "exit 0" }],
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects malformed JSON on stdin without an uncaught exception and writes nothing", () => {
    const inv = invoke('{"target":"S07","surface":"cli","results":[');
    assertRejectedNoWrite(inv);
    assert.ok(
      !/at .*\(.*write-self-uat\.mjs/.test(inv.stderr) && !inv.stderr.includes("Traceback"),
      `expected no stack trace in stderr; got:\n${inv.stderr}`,
    );
  });

  it("rejects a payload missing target and writes nothing", () => {
    const inv = invoke({
      surface: "cli",
      results: [{ criterion: "login works", verdict: "PASS", evidence: "exit 0" }],
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects a payload missing surface and writes nothing", () => {
    const inv = invoke({
      target: "S07",
      results: [{ criterion: "login works", verdict: "PASS", evidence: "exit 0" }],
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects a payload whose results is not an array and writes nothing", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: "not-an-array",
    });
    assertRejectedNoWrite(inv);
  });

  it("rejects a result with a non-string (numeric) evidence and writes nothing, no stack trace", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [{ criterion: "login works", verdict: "PASS", evidence: 123 }],
    });
    assertRejectedNoWrite(inv);
    assert.ok(
      !/at .*\(.*write-self-uat\.mjs/.test(inv.stderr) && !inv.stderr.includes("verify-agentic-log.ts"),
      `expected no stack trace in stderr; got:\n${inv.stderr}`,
    );
  });

  it("rejects a FAIL with a non-string (boolean) rootCause and writes nothing, no stack trace", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [
        { criterion: "logout works", verdict: "FAIL", evidence: "exit 1", rootCause: false },
      ],
    });
    assertRejectedNoWrite(inv);
    assert.ok(
      !/at .*\(.*write-self-uat\.mjs/.test(inv.stderr) && !inv.stderr.includes("verify-agentic-log.ts"),
      `expected no stack trace in stderr; got:\n${inv.stderr}`,
    );
  });

  it("writes the real renderSelfUat output for a conforming payload, byte-identical to an in-process call", () => {
    const results: SelfUatCriterionResult[] = [
      { criterion: "login works", verdict: "PASS", evidence: "exit 0" },
      {
        criterion: "logout works",
        verdict: "FAIL",
        evidence: "exit 1, stderr: ENOENT",
        rootCause: "exit 1, stderr: ENOENT — the binary was never built",
        gapClosureRoute: "Rebuild and re-run; see src/bootstrap.ts",
      },
    ];
    const payload = { target: "S07", surface: "cli", results };
    const inv = invoke(payload);

    assert.equal(inv.status, 0, `expected exit 0; stderr:\n${inv.stderr}`);
    const wroteLine = inv.stdout.split("\n").find((line) => line.startsWith("WROTE "));
    assert.ok(wroteLine, `expected a line beginning "WROTE "; got stdout:\n${inv.stdout}`);
    const relPath = wroteLine!.slice("WROTE ".length).trim();
    assert.match(relPath, /^\.gsd\/verify-agentic\//);

    const absPath = join(inv.tmpDir, relPath);
    const written = readFileSync(absPath, "utf-8");

    // Recover the exact timestampIso the script generated by reading it back
    // out of the written content's own `timestamp:` line, so the comparison
    // does not require controlling the script's clock. Reversing the
    // filename's colon-for-dash substitution is not sufficient here:
    // `selfUatLogFileName` strips fractional seconds for filesystem safety,
    // but `renderSelfUat` embeds the full millisecond-precision ISO string in
    // the rendered content, so only the content itself carries the exact
    // value the script actually rendered with.
    const timestampMatch = written.match(/^timestamp: (.+)$/m);
    assert.ok(timestampMatch, `expected a "timestamp: " line in written content; got:\n${written}`);
    const timestampIso = timestampMatch![1];

    const meta: SelfUatMeta = { target: "S07", surface: "cli", timestampIso };
    const expected = renderSelfUat(results, meta);
    assert.equal(written, expected);
  });

  it("renders numbered criteria in input order for a three-result conforming payload", () => {
    const results: SelfUatCriterionResult[] = [
      { criterion: "first", verdict: "PASS", evidence: "e1" },
      { criterion: "second", verdict: "PASS", evidence: "e2" },
      { criterion: "third", verdict: "PASS", evidence: "e3" },
    ];
    const inv = invoke({ target: "S07", surface: "cli", results });
    assert.equal(inv.status, 0, `expected exit 0; stderr:\n${inv.stderr}`);
    const wroteLine = inv.stdout.split("\n").find((line) => line.startsWith("WROTE "));
    assert.ok(wroteLine);
    const relPath = wroteLine!.slice("WROTE ".length).trim();
    const written = readFileSync(join(inv.tmpDir, relPath), "utf-8");
    assert.match(written, /^### 1\. first$/m);
    assert.match(written, /^### 2\. second$/m);
    assert.match(written, /^### 3\. third$/m);
  });

  it("names a colon-free <slug>-<timestamp>-SELF-UAT.md filename in both the WROTE line and on disk", () => {
    const inv = invoke({
      target: "S07",
      surface: "cli",
      results: [{ criterion: "login works", verdict: "PASS", evidence: "exit 0" }],
    });
    assert.equal(inv.status, 0, `expected exit 0; stderr:\n${inv.stderr}`);
    const wroteLine = inv.stdout.split("\n").find((line) => line.startsWith("WROTE "));
    assert.ok(wroteLine);
    const relPath = wroteLine!.slice("WROTE ".length).trim();
    assert.doesNotMatch(relPath, /:/);
    assert.match(relPath, /^\.gsd\/verify-agentic\/s07-.+-SELF-UAT\.md$/);
    const entries = readdirSync(join(inv.tmpDir, ".gsd", "verify-agentic"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0], relPath.split("/").pop());
  });
});
