// Project/App: gsd-pi
// File Purpose: Contract for certify/audit's own quality_gates writer, proving
// it never touches MV01-MV04/Q3-Q8 rows and sources every gate id from the
// registry rather than a bare string literal (14-01-PLAN.md Task 2).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
  upsertQualityGate,
} from "../gsd-db.ts";
import { insertAuditGates, insertCertifyGates } from "../milestone-close-gates.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function row(sql: string): Record<string, unknown> | undefined {
  return db().prepare(sql).get();
}

function makeBase(withSlices = true): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-close-gates-"));
  tempDirs.add(basePath);
  assert.equal(openDatabase(join(basePath, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Certify/audit gates", status: "active" });
  if (withSlices) {
    insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", status: "complete" });
  }
  return basePath;
}

function seedMv03(sliceId: string): void {
  upsertQualityGate({
    milestoneId: "M001",
    sliceId,
    gateId: "MV03",
    scope: "milestone",
    taskId: "",
    status: "complete",
    verdict: "pass",
    rationale: "MV03 pre-seeded rationale — must not change.",
    findings: "",
    evaluatedAt: "2026-09-22T00:00:00.000Z",
  });
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("insertCertifyGates writes one CERT01 row per slice and one CERT02 row anchored to the first slice", () => {
  makeBase();
  insertCertifyGates(
    "M001",
    [
      { sliceId: "S01", verdict: "pass", rationale: "S01 gates all pass.", findings: "" },
      { sliceId: "S02", verdict: "flag", rationale: "S02 has a stale gate row.", findings: "MV02 stale" },
    ],
    "flag",
    "2026-09-22T01:00:00.000Z",
  );

  const cert01Rows = rows(`SELECT * FROM quality_gates WHERE gate_id = 'CERT01' ORDER BY slice_id`);
  assert.equal(cert01Rows.length, 2);
  assert.equal(cert01Rows[0]!["slice_id"], "S01");
  assert.equal(cert01Rows[0]!["scope"], "slice");
  assert.equal(cert01Rows[0]!["task_id"], "");
  assert.equal(cert01Rows[1]!["slice_id"], "S02");

  const cert02Rows = rows(`SELECT * FROM quality_gates WHERE gate_id = 'CERT02'`);
  assert.equal(cert02Rows.length, 1);
  assert.equal(cert02Rows[0]!["scope"], "milestone");
  assert.equal(cert02Rows[0]!["slice_id"], "S01");
  assert.equal(cert02Rows[0]!["verdict"], "flag");
});

test("insertAuditGates writes exactly one AUD01 and one AUD02 row, both milestone-scoped, anchored to the first slice", () => {
  makeBase();
  insertAuditGates(
    "M001",
    {
      wiring: { verdict: "pass", rationale: "Traced S01->S02 flow end-to-end.", findings: "" },
      coverage: { verdict: "flag", rationale: "CERT-02 claims coverage with no artifact.", findings: "REQ-99 unsupported" },
    },
    "flag",
    "2026-09-22T02:00:00.000Z",
  );

  const aud01Rows = rows(`SELECT * FROM quality_gates WHERE gate_id = 'AUD01'`);
  assert.equal(aud01Rows.length, 1);
  assert.equal(aud01Rows[0]!["scope"], "milestone");
  assert.equal(aud01Rows[0]!["slice_id"], "S01");
  assert.equal(aud01Rows[0]!["verdict"], "pass");

  const aud02Rows = rows(`SELECT * FROM quality_gates WHERE gate_id = 'AUD02'`);
  assert.equal(aud02Rows.length, 1);
  assert.equal(aud02Rows[0]!["scope"], "milestone");
  assert.equal(aud02Rows[0]!["slice_id"], "S01");
  assert.equal(aud02Rows[0]!["verdict"], "flag");
  assert.match(String(aud02Rows[0]!["findings"]), /REQ-99 unsupported/);
});

test("certify and audit writes leave a pre-seeded MV03 row byte-identical", () => {
  makeBase();
  seedMv03("S01");
  const before = row(`SELECT * FROM quality_gates WHERE gate_id = 'MV03'`);
  assert.ok(before);

  insertCertifyGates(
    "M001",
    [{ sliceId: "S01", verdict: "pass", rationale: "S01 gates all pass.", findings: "" }],
    "pass",
    "2026-09-22T03:00:00.000Z",
  );
  insertAuditGates(
    "M001",
    {
      wiring: { verdict: "pass", rationale: "Independent wiring check passed.", findings: "" },
      coverage: { verdict: "pass", rationale: "Independent coverage check passed.", findings: "" },
    },
    "pass",
    "2026-09-22T03:00:01.000Z",
  );

  const after = row(`SELECT * FROM quality_gates WHERE gate_id = 'MV03'`);
  assert.deepEqual(after, before);
  // Only MV03 + the four new certify/audit gate ids should exist — no other
  // MV0x/Q3-Q8 id was ever touched.
  const allGateIds = rows(`SELECT DISTINCT gate_id FROM quality_gates ORDER BY gate_id`)
    .map((r) => String(r["gate_id"]));
  assert.deepEqual(allGateIds, ["AUD01", "AUD02", "CERT01", "CERT02", "MV03"]);
});

test("on a milestone with zero slices, both functions are a no-op and throw nothing", () => {
  makeBase(false);

  assert.doesNotThrow(() => {
    insertCertifyGates("M001", [], "pass", "2026-09-22T04:00:00.000Z");
  });
  assert.doesNotThrow(() => {
    insertAuditGates(
      "M001",
      {
        wiring: { verdict: "pass", rationale: "n/a", findings: "" },
        coverage: { verdict: "pass", rationale: "n/a", findings: "" },
      },
      "pass",
      "2026-09-22T04:00:01.000Z",
    );
  });

  assert.equal(Number(row(`SELECT COUNT(*) AS count FROM quality_gates`)!["count"]), 0);
});

test("calling insertCertifyGates twice with different verdicts leaves one current row per (milestone, slice, gate)", () => {
  makeBase();
  insertCertifyGates(
    "M001",
    [{ sliceId: "S01", verdict: "pass", rationale: "First pass.", findings: "" }],
    "pass",
    "2026-09-22T05:00:00.000Z",
  );
  insertCertifyGates(
    "M001",
    [{ sliceId: "S01", verdict: "flag", rationale: "Second run found a gap.", findings: "gap found" }],
    "flag",
    "2026-09-22T05:01:00.000Z",
  );

  const cert01Rows = rows(`SELECT * FROM quality_gates WHERE gate_id = 'CERT01'`);
  assert.equal(cert01Rows.length, 1, "quality_gates is INSERT OR REPLACE — current status only");
  assert.equal(cert01Rows[0]!["verdict"], "flag");
  assert.equal(cert01Rows[0]!["rationale"], "Second run found a gap.");

  const cert02Rows = rows(`SELECT * FROM quality_gates WHERE gate_id = 'CERT02'`);
  assert.equal(cert02Rows.length, 1);
  assert.equal(cert02Rows[0]!["verdict"], "flag");
});

test("per-slice CERT01 rationale and findings text for a slice with findings is non-empty and names the slice id", () => {
  makeBase();
  insertCertifyGates(
    "M001",
    [{
      sliceId: "S02",
      verdict: "flag",
      rationale: "Slice S02: MV02 gate row is stale, self-fix candidate.",
      findings: "Slice S02 findings: quality_gates row for MV02 predates the latest source revision.",
    }],
    "flag",
    "2026-09-22T06:00:00.000Z",
  );

  const cert01Row = row(`SELECT * FROM quality_gates WHERE gate_id = 'CERT01' AND slice_id = 'S02'`);
  assert.ok(cert01Row);
  assert.ok(String(cert01Row!["rationale"]).length > 0);
  assert.match(String(cert01Row!["rationale"]), /S02/);
  assert.ok(String(cert01Row!["findings"]).length > 0);
  assert.match(String(cert01Row!["findings"]), /S02/);
});
