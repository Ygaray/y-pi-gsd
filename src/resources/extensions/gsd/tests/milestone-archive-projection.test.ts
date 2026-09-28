// Project/App: gsd-pi
// File Purpose: Immutability contract for the ARCHIVE artifact (15-04 Task
// 2). Tests 1-2 are the plan's reason to exist: they mutate slices,
// statuses, and requirements underneath an already-shipped milestone and
// demand byte-identical output from both a direct renderer call and the real
// full render sweep — the only assertions in Phase 15 that can catch an
// archive that silently follows live state instead of the immutable
// milestone.shipped event it must read (T-15-16). The remaining tests prove
// the projection read refuses a corrupt or absent event rather than
// rendering a stub (T-15-17), a hostile title cannot forge a table row
// (T-15-04), and the render sweep touches nothing beyond its own artifact
// (T-15-18) or another milestone's projection key/file (T-15-19).

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { rebuildMarkdownProjectionsFromDb } from "../commands-maintenance.ts";
import type { DomainJsonValue, DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getMilestone,
  insertMilestone,
  insertRequirement,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
  updateSliceFields,
  updateSliceStatus,
  upsertRequirement,
} from "../gsd-db.ts";
import { renderMilestoneArchive, stripProjectionStamp } from "../markdown-renderer.ts";
import {
  readMilestoneArchiveProjection,
  renderMilestoneArchiveMarkdown,
} from "../milestone-archive-projection.ts";
import {
  shipMilestone,
  type ShipMilestoneInput,
} from "../milestone-ship-domain-operation.ts";
import { clearPathCache, targetMilestoneFile } from "../paths.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "archive-projection-test",
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
  event: () => {
    eventType: string;
    entityType: string;
    entityId: string;
    payload: Record<string, DomainJsonValue>;
  },
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{ ...event(), destinations: ["test"] }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function recordVerdict(
  eventType: string,
  operationType: string,
  idempotencyKey: string,
  overallVerdict: string,
  milestoneId: string,
): void {
  executeAtFence(operationType, idempotencyKey, () => {}, () => ({
    eventType,
    entityType: "milestone",
    entityId: milestoneId,
    payload: { overallVerdict },
  }));
}

function recordPassingCertify(milestoneId: string): void {
  recordVerdict(
    "milestone.certify.recorded",
    "milestone.certify",
    `fixture/archive/certify/${milestoneId}`,
    "pass",
    milestoneId,
  );
}

function recordPassingAudit(milestoneId: string): void {
  recordVerdict(
    "milestone.audit.recorded",
    "milestone.audit",
    `fixture/archive/audit/${milestoneId}`,
    "pass",
    milestoneId,
  );
}

interface FixtureOptions {
  milestoneTitle?: string;
  sliceTitle?: string;
}

/** Already-completed, ship-ready single-slice milestone — mirrors 15-01's
 * `milestone-ship-domain-operation.test.ts` `makeBase()`, parametrized over
 * `milestoneId` so Test 7 can seed a second, independent milestone in the
 * same database. Requirements are NOT milestone-scoped in the schema
 * (`getActiveRequirements()` reads every active row project-wide), so each
 * milestone gets its own requirement id to avoid a primary-key collision. */
function makeShippableMilestone(milestoneId: string, opts: FixtureOptions = {}): void {
  const sliceId = "S01";
  const taskId = "T01";
  const requirementId = `REQ-${milestoneId}`;

  insertMilestone({
    id: milestoneId,
    title: opts.milestoneTitle ?? "Ship archive stage",
    status: "active",
  });
  insertSlice({
    id: sliceId,
    milestoneId,
    title: opts.sliceTitle ?? "Slice one",
    status: "complete",
  });
  insertTask({ id: taskId, sliceId, milestoneId, status: "complete" });
  insertRequirement({
    id: requirementId,
    class: "must",
    status: "active",
    description: "Ship works end to end.",
    why: "Proves the gate.",
    source: "test",
    primary_owner: sliceId,
    supporting_slices: sliceId,
    validation: "test",
    notes: "",
    full_content: requirementId,
    superseded_by: null,
    // Phase 33 / RELY-05 / D-04: the archive snapshot now scopes by this
    // schema-level column, not by primary_owner/supporting_slices matching.
    milestone_id: milestoneId,
  });

  // Adopt the milestone lifecycle to "ready" first, under its own fence — the
  // causal-provenance trigger requires last_project_revision to strictly
  // advance across an UPDATE, so the ready->completed transition below must
  // be a separate operation (15-01 precedent).
  executeAtFence(
    "test.ship.fixture",
    `fixture/archive/ready/${milestoneId}`,
    (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "milestone", milestoneId, lifecycleStatus: "ready",
      });
    },
    () => ({
      eventType: "test.ship.fixture",
      entityType: "milestone",
      entityId: milestoneId,
      payload: {},
    }),
  );

  // Bring the milestone to canonical+legacy "completed" the same way a real
  // completeMilestone would — the lifecycle transition and the legacy status
  // write happen under a fence whose operation_type is 'milestone.complete'.
  executeAtFence(
    "milestone.complete",
    `fixture/archive/complete/${milestoneId}`,
    (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "milestone", milestoneId, lifecycleStatus: "completed",
      });
      db().prepare(`
        UPDATE milestones SET status = 'complete', completed_at = :completed_at WHERE id = :id
      `).run({ ":completed_at": "2026-09-22T00:00:00.000Z", ":id": milestoneId });
    },
    () => ({
      eventType: "milestone.complete",
      entityType: "milestone",
      entityId: milestoneId,
      payload: {},
    }),
  );
}

function makeBase(opts: FixtureOptions = {}): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-archive-"));
  tempDirs.add(basePath);
  // Deliberately does NOT pre-create a `.gsd/milestones/M001` legacy-layout
  // directory (15-03 precedent) — several tests here drive the real
  // `rebuildMarkdownProjectionsFromDb` full-sweep entry point, and resolving
  // a canonical flat-phase layout consistently from the very first write is
  // what keeps every `targetMilestoneFile(...)` read-back call pointed at
  // the SAME path the sweep actually wrote.
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  makeShippableMilestone("M001", opts);
  return basePath;
}

function shipInput(milestoneId: string, idempotencyKey: string): ShipMilestoneInput {
  return { invocation: invocation(idempotencyKey), milestoneId };
}

/**
 * `workflow_domain_events` is immutable (UPDATE/DELETE both raise ABORT), so
 * a malformed event can only be produced at INSERT time. This inserts a
 * fresh `workflow_operations` + `workflow_domain_events` row pair directly
 * (bypassing `executeDomainOperation`'s normal payload construction) with a
 * payload missing one required field, mirroring
 * `milestone-ship-gate-refusals.test.ts`'s `insertMalformedEvent` precedent.
 */
function insertShippedEventWithPayload(
  milestoneId: string,
  payload: Record<string, unknown>,
): void {
  const authority = row(`
    SELECT project_id, revision, authority_epoch FROM project_authority WHERE singleton = 1
  `);
  const projectIdValue = String(authority["project_id"]);
  const revision = Number(authority["revision"]);
  const authorityEpoch = Number(authority["authority_epoch"]);
  const newRevision = revision + 1;
  const operationId = randomUUID();
  const eventId = randomUUID();
  const now = new Date().toISOString();

  db().prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision, expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES (
      :operation_id, :project_id, 'milestone.ship', :idempotency_key,
      :expected_revision, :resulting_revision, :expected_authority_epoch, :resulting_authority_epoch,
      'test', 'test', 'test-hash', :created_at
    )
  `).run({
    ":operation_id": operationId,
    ":project_id": projectIdValue,
    ":idempotency_key": `fixture/archive/corrupt/${operationId}`,
    ":expected_revision": revision,
    ":resulting_revision": newRevision,
    ":expected_authority_epoch": authorityEpoch,
    ":resulting_authority_epoch": authorityEpoch,
    ":created_at": now,
  });

  db().prepare(`
    INSERT INTO workflow_domain_events (
      event_id, operation_id, event_index, project_id, project_revision, authority_epoch,
      event_type, entity_type, entity_id, payload_json, created_at
    ) VALUES (
      :event_id, :operation_id, 0, :project_id, :project_revision, :authority_epoch,
      'milestone.shipped', 'milestone', :milestone_id, :payload_json, :created_at
    )
  `).run({
    ":event_id": eventId,
    ":operation_id": operationId,
    ":project_id": projectIdValue,
    ":project_revision": newRevision,
    ":authority_epoch": authorityEpoch,
    ":milestone_id": milestoneId,
    ":payload_json": JSON.stringify(payload),
    ":created_at": now,
  });

  db().prepare(`UPDATE project_authority SET revision = :revision WHERE singleton = 1`).run({
    ":revision": newRevision,
  });
}

/**
 * Content hash with the trailing `<!-- gsd:state-version=R:E -->` projection
 * stamp stripped first. Every full sweep re-stamps every artifact it renders
 * with the CURRENT project revision, regardless of whether that artifact's
 * semantic content changed — and `shipMilestone` always advances the
 * revision (it is a Domain Operation). Comparing raw bytes would therefore
 * flag every pre-existing artifact as "changed" on any ship, which is a
 * property of the stamping system, not a D-04 scope violation. Hashing the
 * stamp-stripped content isolates the actual record (15-03's
 * `stripProjectionStamp` "(stamp aside)" precedent for this exact reason).
 */
function contentHash(path: string): string {
  return createHash("sha256").update(stripProjectionStamp(readFileSync(path, "utf-8"))).digest("hex");
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

function requirementFixture(id: string, status: string): Parameters<typeof insertRequirement>[0] {
  return {
    id,
    class: "must",
    status,
    description: "Ship works end to end.",
    why: "Proves the gate.",
    source: "test",
    primary_owner: "S01",
    supporting_slices: "S01",
    validation: "test",
    notes: "",
    full_content: id,
    superseded_by: null,
    // Phase 33 / RELY-05 / D-01: both call sites re-upsert "REQ-M001" against
    // milestone M001 — the composite PK means an upsert with a different (or
    // omitted, i.e. NULL) milestone_id would INSERT a second row instead of
    // replacing this one.
    milestone_id: "M001",
  };
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("mutating slices, statuses, and requirements after ship leaves a direct renderer call byte-identical", () => {
  makeBase();
  recordPassingCertify("M001");
  recordPassingAudit("M001");
  shipMilestone(shipInput("M001", "archive/ship/mutate-direct"));

  const before = readMilestoneArchiveProjection("M001");
  assert.ok(before);
  const beforeBytes = renderMilestoneArchiveMarkdown("M001", before!);

  // Mutate live state through the same write helpers the fixture used to
  // seed the rows — a real title change, a real status change, a real new
  // slice, and a real requirement status change.
  updateSliceFields("M001", "S01", { title: "Slice one, retitled after ship" });
  updateSliceStatus("M001", "S01", "in_progress");
  insertSlice({ id: "S02", milestoneId: "M001", title: "Inserted after ship", status: "complete" });
  upsertRequirement(requirementFixture("REQ-M001", "deferred"));

  // Prove the mutation genuinely landed, so an unchanged archive below isn't
  // an accident of a mutation that silently failed.
  const liveSlice = row(`SELECT title, status FROM slices WHERE milestone_id = 'M001' AND id = 'S01'`);
  assert.equal(liveSlice["title"], "Slice one, retitled after ship");
  assert.equal(liveSlice["status"], "in_progress");
  const liveSliceCount = Number(
    row(`SELECT COUNT(*) AS c FROM slices WHERE milestone_id = 'M001'`)["c"],
  );
  assert.equal(liveSliceCount, 2);
  const liveRequirement = row(`SELECT status FROM requirements WHERE id = 'REQ-M001'`);
  assert.equal(liveRequirement["status"], "deferred");

  const after = readMilestoneArchiveProjection("M001");
  assert.ok(after);
  const afterBytes = renderMilestoneArchiveMarkdown("M001", after!);

  assert.equal(afterBytes, beforeBytes);
});

test("mutating slices, statuses, and requirements after ship leaves the on-disk ARCHIVE byte-identical through a real full sweep", async () => {
  const basePath = makeBase();
  recordPassingCertify("M001");
  recordPassingAudit("M001");
  shipMilestone(shipInput("M001", "archive/ship/mutate-sweep"));

  const beforeResult = await rebuildMarkdownProjectionsFromDb(basePath);
  assert.deepEqual(beforeResult.errors, []);
  const archivePath = targetMilestoneFile(basePath, "M001", "ARCHIVE", "Ship archive stage");
  const beforeBytes = stripProjectionStamp(readFileSync(archivePath, "utf-8"));

  updateSliceFields("M001", "S01", { title: "Retitled via sweep test" });
  updateSliceStatus("M001", "S01", "in_progress");
  insertSlice({ id: "S02", milestoneId: "M001", title: "Inserted via sweep test", status: "complete" });
  upsertRequirement(requirementFixture("REQ-M001", "deferred"));

  const afterResult = await rebuildMarkdownProjectionsFromDb(basePath);
  assert.deepEqual(afterResult.errors, []);
  const afterBytes = stripProjectionStamp(readFileSync(archivePath, "utf-8"));

  assert.equal(afterBytes, beforeBytes);
});

test("a milestone with no shipped event yields null from the projection read, and the render call writes no file", async () => {
  const basePath = makeBase();
  assert.equal(readMilestoneArchiveProjection("M001"), null);

  // Force the legacy status to `shipped` directly (bypassing shipMilestone)
  // to exercise renderMilestoneArchive's own guard with no backing event —
  // the scenario a genuinely corrupt or partially-migrated status row could
  // produce.
  db().prepare(`UPDATE milestones SET status = 'shipped' WHERE id = 'M001'`).run();
  assert.equal(getMilestone("M001")!.status, "shipped");
  assert.equal(readMilestoneArchiveProjection("M001"), null);

  const rendered = await renderMilestoneArchive(basePath, "M001");
  assert.equal(rendered, false);

  const archivePath = targetMilestoneFile(basePath, "M001", "ARCHIVE", "Ship archive stage");
  assert.equal(existsSync(archivePath), false);
});

test("a structurally corrupt shipped payload throws a descriptive error naming the missing field", () => {
  makeBase();
  insertShippedEventWithPayload("M001", {
    shippedAt: "2026-09-22T00:00:00.000Z",
    previousLegacyStatus: "complete",
    legacyStatus: "shipped",
    certifyRevision: 1,
    auditEventId: "audit-event-1",
    auditRevision: 1,
    snapshot: {
      milestone: { id: "M001", title: "x", status: "shipped", completedAt: null },
      slices: [],
      requirements: [],
      capturedAt: "2026-09-22T00:00:00.000Z",
    },
    // certifyEventId deliberately omitted.
  });

  assert.throws(() => readMilestoneArchiveProjection("M001"), /certifyEventId/);
});

test("a slice title containing a pipe and a newline survives ship, render, and re-read as one escaped table row", async () => {
  const basePath = makeBase({ sliceTitle: "Danger | Zone\nSecond line" });
  recordPassingCertify("M001");
  recordPassingAudit("M001");
  shipMilestone(shipInput("M001", "archive/ship/hostile-title"));

  const rendered = await renderMilestoneArchive(basePath, "M001");
  assert.equal(rendered, true);
  const archivePath = targetMilestoneFile(basePath, "M001", "ARCHIVE", "Ship archive stage");
  const content = readFileSync(archivePath, "utf-8");

  const roadmapSection = content.split("## Roadmap Snapshot")[1]!.split("## Requirements Snapshot")[0]!;
  const sliceLines = roadmapSection.split("\n").filter((line) => line.includes("S01"));
  assert.equal(sliceLines.length, 1, "a hostile title must render as exactly one line");
  const sliceLine = sliceLines[0]!;
  assert.match(sliceLine, /Danger \\\| Zone Second line/);
  assert.ok(sliceLine.startsWith("| S01 |"));
  assert.ok(sliceLine.endsWith("|"));
});

test("a milestone title containing a double quote produces parseable YAML frontmatter", async () => {
  const basePath = makeBase({ milestoneTitle: 'Ship the "v2" API' });
  recordPassingCertify("M001");
  recordPassingAudit("M001");
  shipMilestone(shipInput("M001", "archive/ship/hostile-milestone-title"));

  const rendered = await renderMilestoneArchive(basePath, "M001");
  assert.equal(rendered, true);
  const archivePath = targetMilestoneFile(basePath, "M001", "ARCHIVE", "Ship archive stage");
  const content = readFileSync(archivePath, "utf-8");

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatterMatch, "frontmatter delimiters must be present");
  const frontmatter = frontmatterMatch![1]!;
  const titleLine = frontmatter.split("\n").find((line) => line.startsWith("title:"));
  assert.ok(titleLine, "title line must be present in frontmatter");
  assert.equal(titleLine, 'title: "Ship the \\"v2\\" API"');

  // The frontmatter block itself must contain exactly one un-escaped
  // (unpreceded by a backslash) double quote pair around the title value —
  // proof the embedded quotes did not terminate the YAML scalar early.
  const unescapedQuoteCount = (frontmatter.match(/(?<!\\)"/g) ?? []).length;
  assert.equal(unescapedQuoteCount, 2, "title value's embedded quotes must be escaped, not terminate the scalar");
});

test("shipping and rendering the archive adds exactly one file to the milestone directory, changing no pre-existing file's bytes", async () => {
  const basePath = makeBase();
  recordPassingCertify("M001");
  recordPassingAudit("M001");

  const beforeResult = await rebuildMarkdownProjectionsFromDb(basePath);
  assert.deepEqual(beforeResult.errors, []);
  const milestoneDir = dirname(
    targetMilestoneFile(basePath, "M001", "ARCHIVE", "Ship archive stage"),
  );
  const beforeFiles = listFilesRecursive(milestoneDir).sort();
  const beforeHashes = new Map(beforeFiles.map((file) => [file, contentHash(file)]));

  shipMilestone(shipInput("M001", "archive/ship/directory-scope"));
  const afterResult = await rebuildMarkdownProjectionsFromDb(basePath);
  assert.deepEqual(afterResult.errors, []);
  const afterFiles = listFilesRecursive(milestoneDir).sort();

  const added = afterFiles.filter((file) => !beforeFiles.includes(file));
  const removed = beforeFiles.filter((file) => !afterFiles.includes(file));
  assert.deepEqual(removed, []);
  assert.equal(added.length, 1);
  assert.match(added[0]!, /ARCHIVE/);

  for (const file of afterFiles) {
    if (added.includes(file)) continue;
    assert.equal(contentHash(file), beforeHashes.get(file), `unexpected byte change: ${file}`);
  }
});

test("two shipped milestones each produce their own archive artifact, no key or file collision", async () => {
  const basePath = makeBase();
  makeShippableMilestone("M002", { milestoneTitle: "Second ship stage" });

  recordPassingCertify("M001");
  recordPassingAudit("M001");
  shipMilestone(shipInput("M001", "archive/ship/two-milestones-first"));

  recordPassingCertify("M002");
  recordPassingAudit("M002");
  shipMilestone(shipInput("M002", "archive/ship/two-milestones-second"));

  const projectionKeys = rows(`
    SELECT DISTINCT projection_key FROM workflow_projection_work
    WHERE projection_kind = 'milestone-archive'
    ORDER BY projection_key
  `).map((entry) => String(entry["projection_key"]));
  assert.deepEqual(projectionKeys, ["archive/m001", "archive/m002"]);

  const result = await rebuildMarkdownProjectionsFromDb(basePath);
  assert.deepEqual(result.errors, []);

  const archive1 = targetMilestoneFile(basePath, "M001", "ARCHIVE", "Ship archive stage");
  const archive2 = targetMilestoneFile(basePath, "M002", "ARCHIVE", "Second ship stage");
  assert.notEqual(archive1, archive2);
  assert.ok(existsSync(archive1));
  assert.ok(existsSync(archive2));

  const content1 = readFileSync(archive1, "utf-8");
  const content2 = readFileSync(archive2, "utf-8");
  assert.notEqual(content1, content2);
  assert.match(content1, /# M001: /);
  assert.match(content2, /# M002: /);
});

test("shipping one milestone while a second, unrelated milestone's requirement is active excludes it from the snapshot", () => {
  makeBase();
  // A second, unstarted/mid-flight milestone with its OWN active requirement
  // — exactly the CR-02 scenario ("requirements belonging to milestones that
  // are still unstarted or mid-flight" leaking into M001's immutable
  // archive). Phase 33 / RELY-05 / D-04: the snapshot now scopes by the
  // schema-level `milestone_id` column directly, not by matching
  // primary_owner/supporting_slices against the shipping milestone's slice
  // ids — closing the residual limitation the old filter had when slice ids
  // collided across milestones (SC-3).
  insertMilestone({ id: "M002", title: "Second, unrelated milestone", status: "active" });
  insertSlice({ id: "S99", milestoneId: "M002", title: "Unrelated slice", status: "active" });
  insertRequirement({
    id: "REQ-M002",
    class: "must",
    status: "active",
    description: "Belongs to a different, unstarted milestone.",
    why: "Proves cross-milestone requirements do not leak.",
    source: "test",
    primary_owner: "S99",
    supporting_slices: "S99",
    validation: "test",
    notes: "",
    full_content: "REQ-M002",
    superseded_by: null,
    milestone_id: "M002",
  });

  recordPassingCertify("M001");
  recordPassingAudit("M001");
  shipMilestone(shipInput("M001", "archive/ship/cross-milestone-requirement"));

  const projection = readMilestoneArchiveProjection("M001");
  assert.ok(projection, "M001 must have a readable archive projection after shipping");
  const requirementIds = projection!.snapshot.requirements.map((requirement) => requirement.id);
  assert.deepEqual(requirementIds, ["REQ-M001"]);
  assert.ok(
    !requirementIds.includes("REQ-M002"),
    "M001's immutable archive snapshot must not embed M002's still-active requirement",
  );
});
