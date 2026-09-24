// gsd-pi · schema-version literal drift guard
//
// Standing guard for GREEN-03/D-02: none of the four schema-boundary
// refuse-newer test files may reintroduce a hardcoded schema-version
// integer literal. Every expected pattern here is derived at runtime from
// the live `SCHEMA_VERSION` export and a real `SchemaTooNewError` instance
// -- never typed as a literal digit sequence in this file -- so the guard
// itself never goes stale across a future schema bump.
//
// RED-phase stub (#19-01 Task 2): the version-marker predicate is not yet
// implemented -- it always reports "no violation" so Test 4 (the guard has
// teeth) fails for real before any implementation exists.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { SCHEMA_VERSION } from "../resources/extensions/gsd/db/engine.ts";

const testsDir = dirname(fileURLToPath(import.meta.url));

const SCHEMA_BOUNDARY_RELATIVE_PATHS = [
  "headless-recover.test.ts",
  "read-cli-schema-too-new.test.ts",
  "graph-build-version-gate.test.ts",
  "headless-query-db-open.test.ts",
] as const;

function resolveBoundaryFile(relativePath: string): string {
  return join(testsDir, relativePath);
}

function readBoundaryFileSource(relativePath: string): string {
  return readFileSync(resolveBoundaryFile(relativePath), "utf8");
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** RED-phase stub: TODO(GREEN) derive markers from a real SchemaTooNewError message. */
function findBakedInVersionViolations(_source: string): Array<{ line: number; text: string }> {
  return [];
}

/** RED-phase stub: TODO(GREEN) reuse the real marker-derived pattern. */
function hasBakedInVersionLiteral(_source: string): boolean {
  return false;
}

function findBareIntegerRecordSchemaVersionCalls(
  source: string,
): Array<{ line: number; call: string }> {
  const pattern = /recordSchemaVersion\(([^)]*)\)/g;
  const violations: Array<{ line: number; call: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const args = (match[1] ?? "").split(",").map((part) => part.trim());
    const versionArg = args[args.length - 1] ?? "";
    if (/^\d+$/.test(versionArg)) {
      violations.push({ line: lineNumberAt(source, match.index), call: match[0] });
    }
  }
  return violations;
}

test("each schema-boundary file imports SCHEMA_VERSION", () => {
  for (const relativePath of SCHEMA_BOUNDARY_RELATIVE_PATHS) {
    const source = readBoundaryFileSource(relativePath);
    assert.ok(
      source.includes("SCHEMA_VERSION"),
      `${relativePath} must import/reference SCHEMA_VERSION -- a dropped import lets a stale literal creep back in`,
    );
  }
});

test("no schema-boundary file re-templates a baked-in version integer", () => {
  for (const relativePath of SCHEMA_BOUNDARY_RELATIVE_PATHS) {
    const source = readBoundaryFileSource(relativePath);
    const violations = findBakedInVersionViolations(source);
    assert.deepEqual(
      violations,
      [],
      `${relativePath} reintroduced a baked-in schema-version literal: ${
        violations.map((v) => `line ${v.line} ("${v.text}")`).join(", ")
      }`,
    );
  }
});

test("no schema-boundary file stamps recordSchemaVersion with a bare integer literal", () => {
  for (const relativePath of SCHEMA_BOUNDARY_RELATIVE_PATHS) {
    const source = readBoundaryFileSource(relativePath);
    const violations = findBareIntegerRecordSchemaVersionCalls(source);
    assert.deepEqual(
      violations,
      [],
      `${relativePath} stamps recordSchemaVersion with a bare integer literal: ${
        violations.map((v) => `line ${v.line} ("${v.call}")`).join(", ")
      }`,
    );
  }
});

test("the baked-in-version predicate is fail-first against a synthetic violation", () => {
  const stampedCurrent = SCHEMA_VERSION + 1;
  const stampedSupported = SCHEMA_VERSION;
  const synthetic =
    `const STALE_MESSAGE = "gsd.db schema is v${stampedCurrent}, newer than the v${stampedSupported} this gsd-pi supports.";`;
  assert.equal(
    hasBakedInVersionLiteral(synthetic),
    true,
    "predicate must flag a synthetic re-templated version literal",
  );
});
