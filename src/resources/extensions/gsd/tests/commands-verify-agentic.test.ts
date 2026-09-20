/**
 * Unit tests for `/gsd verify-agentic` (commands-verify-agentic.ts).
 *
 * Organized one `describe` per exported function, mirroring
 * `commands-eval-review.test.ts`. Every malformed-invocation shape is
 * asserted against the `VerifyAgenticArgError` class, never message text
 * (mirrors the `EvalReviewArgError` precedent).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  SURFACES,
  TARGET_ID_PATTERN,
  VerifyAgenticArgError,
  parseVerifyAgenticArgs,
  resolveTarget,
} from "../commands-verify-agentic.js";
import { GSD_COMMAND_DESCRIPTION, TOP_LEVEL_SUBCOMMANDS } from "../commands/catalog.js";
import { _clearGsdRootCache } from "../paths.js";

// ─── parseVerifyAgenticArgs ───────────────────────────────────────────────────

describe("parseVerifyAgenticArgs", () => {
  it("parses a bare target with criteria and surface left undefined", () => {
    const result = parseVerifyAgenticArgs("S07");
    assert.equal(result.target, "S07");
    assert.equal(result.criteria, undefined);
    assert.equal(result.surface, undefined);
  });

  it("returns all fields undefined for an empty string (inference is the handler's job)", () => {
    const result = parseVerifyAgenticArgs("");
    assert.equal(result.target, undefined);
    assert.equal(result.criteria, undefined);
    assert.equal(result.surface, undefined);
  });

  it("preserves internal spaces in a quoted --criteria value", () => {
    const result = parseVerifyAgenticArgs('S07 --criteria "login works end to end"');
    assert.equal(result.criteria, "login works end to end");
  });

  it("parses --surface android", () => {
    const result = parseVerifyAgenticArgs("S07 --surface android");
    assert.equal(result.surface, "android");
  });

  it("round-trips every member of SURFACES", () => {
    for (const surface of SURFACES) {
      const result = parseVerifyAgenticArgs(`S07 --surface ${surface}`);
      assert.equal(result.surface, surface);
    }
  });

  it("throws on a --surface value outside SURFACES", () => {
    assert.throws(() => parseVerifyAgenticArgs("S07 --surface desktop"), VerifyAgenticArgError);
  });

  it("throws when --criteria has no following value", () => {
    assert.throws(() => parseVerifyAgenticArgs("S07 --criteria"), VerifyAgenticArgError);
  });

  it("throws when --surface has no following value", () => {
    assert.throws(() => parseVerifyAgenticArgs("S07 --surface"), VerifyAgenticArgError);
  });

  it("throws on an unrecognized --* token instead of silently stripping it (regression: typo must never fall back to the default surface)", () => {
    assert.throws(() => parseVerifyAgenticArgs("S07 --surfce android"), VerifyAgenticArgError);
  });

  it("throws on a second bare token", () => {
    assert.throws(() => parseVerifyAgenticArgs("S07 S08"), VerifyAgenticArgError);
  });

  it("rejects a target containing a path separator", () => {
    assert.throws(() => parseVerifyAgenticArgs("S01/../etc"), VerifyAgenticArgError);
  });

  it("rejects a target containing a newline", () => {
    assert.throws(() => parseVerifyAgenticArgs("S01\nrm -rf /"), VerifyAgenticArgError);
  });

  it("rejects a target containing a backtick", () => {
    assert.throws(() => parseVerifyAgenticArgs("S01`whoami`"), VerifyAgenticArgError);
  });

  it("rejects a target containing a markdown heading marker", () => {
    assert.throws(() => parseVerifyAgenticArgs("##S01"), VerifyAgenticArgError);
  });
});

// ─── TARGET_ID_PATTERN export ─────────────────────────────────────────────────

describe("TARGET_ID_PATTERN", () => {
  it("accepts alphanumerics, dots, underscores, and hyphens up to 64 chars", () => {
    assert.ok(TARGET_ID_PATTERN.test("S07"));
    assert.ok(TARGET_ID_PATTERN.test("cli-2026-09-20T12-00-00Z"));
    assert.ok(!TARGET_ID_PATTERN.test("S01/../etc"));
    assert.ok(!TARGET_ID_PATTERN.test("S01\nrm -rf /"));
    assert.ok(!TARGET_ID_PATTERN.test("S01`whoami`"));
    assert.ok(!TARGET_ID_PATTERN.test("##S01"));
  });
});

// ─── resolveTarget ─────────────────────────────────────────────────────────────

describe("resolveTarget", () => {
  let basePath: string;

  beforeEach(() => {
    basePath = join(tmpdir(), `gsd-verify-agentic-test-${randomUUID()}`);
    mkdirSync(basePath, { recursive: true });
    _clearGsdRootCache();
  });

  afterEach(() => {
    _clearGsdRootCache();
    rmSync(basePath, { recursive: true, force: true });
  });

  it("returns the explicit target unchanged without reading the filesystem", () => {
    // basePath has no .gsd/ tree at all — a filesystem read would throw or
    // return null; returning "S02" proves the explicit branch short-circuits.
    assert.equal(resolveTarget(basePath, "M001", "S02"), "S02");
  });

  it("infers the newest summarised slice from a temp-dir fixture", () => {
    const slicesDir = join(basePath, ".gsd", "milestones", "M001", "slices");
    for (const slice of ["S01", "S02", "S03"]) {
      mkdirSync(join(slicesDir, slice), { recursive: true });
    }
    writeFileSync(join(slicesDir, "S01", "S01-SUMMARY.md"), "# S01");
    writeFileSync(join(slicesDir, "S02", "S02-SUMMARY.md"), "# S02");
    // S03 deliberately has no SUMMARY.md — it must not be selected.

    assert.equal(resolveTarget(basePath, "M001"), "S02");
  });

  it("returns null when no slices directory exists", () => {
    assert.equal(resolveTarget(basePath, "M001"), null);
  });
});

// ─── Catalog registration (regression: catalog registration must not be forgotten) ──

describe("catalog registration", () => {
  it("includes verify-agentic in TOP_LEVEL_SUBCOMMANDS", () => {
    const entry = TOP_LEVEL_SUBCOMMANDS.find((c) => c.cmd === "verify-agentic");
    assert.ok(entry, "verify-agentic must be present in TOP_LEVEL_SUBCOMMANDS");
    assert.ok((entry?.desc ?? "").length > 0, "verify-agentic entry must have a non-empty description");
  });

  it("appends verify-agentic to the GSD_COMMAND_DESCRIPTION pipe-separated list", () => {
    assert.ok(
      GSD_COMMAND_DESCRIPTION.includes("|verify-agentic"),
      "GSD_COMMAND_DESCRIPTION must include the verify-agentic token (pipe-prefixed)",
    );
  });
});
