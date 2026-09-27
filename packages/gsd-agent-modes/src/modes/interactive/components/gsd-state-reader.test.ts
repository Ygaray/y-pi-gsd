// Project/App: gsd-pi
// File Purpose: Regression net for the `.planning/STATE.md` reader (SL-02) — the walk-up resolver,
// the minimal frontmatter parser (incl. the never-throw contract on malformed/oversized content), the
// locked lifecycle-scene mapping, and the short-TTL cache. Mirrors `footer-data-provider.test.ts`'s
// `mkdtempSync` temp-dir fixture idiom.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findPlanningStatePath,
	formatGsdStateScene,
	parseStateMd,
	readPlanningState,
	type GsdPlanningState,
} from "./gsd-state-reader.js";

/**
 * Byte-for-byte copy of this repo's own `.planning/STATE.md` frontmatter, frozen at the moment
 * 28-RESEARCH.md's Pitfall 1 quoted it verbatim (`status: planning`). This is deliberately a fixed
 * historical snapshot, not a live re-read of the (now-advanced) STATE.md — the plan's own
 * acceptance criteria pin the expected scene string to this exact content.
 */
const REAL_STATE_MD_FIXTURE = `---
gsd_state_version: "1.0"
milestone: v6
milestone_name: Operator-Surface Finish + Reliability Tail
current_phase: 28
current_phase_name: Statusline Bar
status: planning
stopped_at: Phase 28 UI-SPEC approved
last_updated: "2026-09-27T20:53:29.412Z"
last_activity: 2026-09-27
last_activity_desc: v6 ROADMAP.md created (6 phases, 28-33), 8/8 requirements mapped, 0 orphans
state_head: b160c89e768358a559790495199427f97f73a8c8
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State
`;

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("findPlanningStatePath", () => {
	it("resolves a directory that directly contains .planning/STATE.md", () => {
		const root = makeTempDir("gsd-state-reader-direct-");
		mkdirSync(join(root, ".planning"));
		writeFileSync(join(root, ".planning", "STATE.md"), REAL_STATE_MD_FIXTURE, "utf8");

		assert.equal(findPlanningStatePath(root), join(root, ".planning", "STATE.md"));
	});

	it("resolves a nested subdirectory by walking up", () => {
		const root = makeTempDir("gsd-state-reader-nested-");
		mkdirSync(join(root, ".planning"));
		writeFileSync(join(root, ".planning", "STATE.md"), REAL_STATE_MD_FIXTURE, "utf8");
		const nested = join(root, "a", "b", "c");
		mkdirSync(nested, { recursive: true });

		assert.equal(findPlanningStatePath(nested), join(root, ".planning", "STATE.md"));
	});

	it("returns null when no .planning/STATE.md exists anywhere up to the filesystem root", () => {
		const root = makeTempDir("gsd-state-reader-none-");
		const nested = join(root, "x", "y");
		mkdirSync(nested, { recursive: true });

		assert.equal(findPlanningStatePath(nested), null);
	});
});

describe("parseStateMd", () => {
	it("parses this repo's own real frontmatter and preserves every scalar field", () => {
		const state = parseStateMd(REAL_STATE_MD_FIXTURE);
		assert.ok(state, "expected a non-null parse of the real frontmatter fixture");
		assert.deepEqual(state, {
			milestone: "v6",
			milestoneName: "Operator-Surface Finish + Reliability Tail",
			currentPhase: "28",
			status: "planning",
			completedPhases: 0,
			totalPhases: 6,
			percent: 0,
		} satisfies GsdPlanningState);
	});

	it("returns null for a file with no frontmatter delimiters", () => {
		assert.equal(parseStateMd("# Just a heading\n\nNo frontmatter here.\n"), null);
	});

	it("returns null for truncated frontmatter (no closing fence)", () => {
		assert.equal(parseStateMd("---\nmilestone: v6\ncurrent_phase: 28\nstatus: planning\n"), null);
	});

	it("returns null for a nested block at the wrong indent (defeats column-0 key matching)", () => {
		// Every "top-level" key is itself indented by 2 spaces, so nothing matches the column-0
		// regex and milestone/currentPhase/status all stay null.
		const wrongIndent = "---\n  milestone: v6\n  current_phase: 28\n  status: planning\n---\n";
		assert.equal(parseStateMd(wrongIndent), null);
	});

	it("returns null for binary garbage and does not throw", () => {
		const garbage = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]).toString("utf8");
		assert.doesNotThrow(() => parseStateMd(garbage));
		assert.equal(parseStateMd(garbage), null);
	});

	it("is refused without scanning unboundedly when the frontmatter is far larger than any real STATE.md", () => {
		const huge = `---\nmilestone: v6\n${"x".repeat(200_000)}\n`;
		const start = Date.now();
		assert.doesNotThrow(() => parseStateMd(huge));
		assert.equal(parseStateMd(huge), null);
		assert.ok(Date.now() - start < 1000, "expected the bounded parse to return promptly");
	});

	it("a completed_phases === total_phases fixture yields the fields needed for milestone complete even when percent is absent", () => {
		const fixture = `---
milestone: v6
current_phase: 28
status: executing
progress:
  total_phases: 6
  completed_phases: 6
---
`;
		const state = parseStateMd(fixture);
		assert.ok(state);
		assert.equal(state.totalPhases, 6);
		assert.equal(state.completedPhases, 6);
		assert.equal(state.percent, null);
	});

	it("a status of executing is preserved verbatim, not frozen to one value", () => {
		const fixture = `---
milestone: v6
current_phase: 28
status: executing
progress:
  total_phases: 6
  completed_phases: 1
  percent: 17
---
`;
		const state = parseStateMd(fixture);
		assert.ok(state);
		assert.equal(state.status, "executing");
	});
});

describe("formatGsdStateScene", () => {
	it("renders 'Phase {N} {status}' for this repo's own real (in-flight) frontmatter", () => {
		const state = parseStateMd(REAL_STATE_MD_FIXTURE);
		assert.ok(state);
		assert.equal(formatGsdStateScene(state), "Phase 28 planning");
	});

	it("renders the literal 'milestone complete' when percent is 100", () => {
		const state: GsdPlanningState = {
			milestone: "v6",
			milestoneName: "Test",
			currentPhase: "28",
			status: "executing",
			completedPhases: 5,
			totalPhases: 6,
			percent: 100,
		};
		assert.equal(formatGsdStateScene(state), "milestone complete");
	});

	it("renders 'milestone complete' when completed_phases === total_phases even without percent", () => {
		const state: GsdPlanningState = {
			milestone: "v6",
			milestoneName: "Test",
			currentPhase: "28",
			status: "executing",
			completedPhases: 6,
			totalPhases: 6,
			percent: null,
		};
		assert.equal(formatGsdStateScene(state), "milestone complete");
	});

	it("tracks status across values rather than freezing to one phrase", () => {
		const executing: GsdPlanningState = {
			milestone: "v6",
			milestoneName: "Test",
			currentPhase: "28",
			status: "executing",
			completedPhases: 1,
			totalPhases: 6,
			percent: 17,
		};
		const verifying: GsdPlanningState = { ...executing, status: "verifying" };
		assert.equal(formatGsdStateScene(executing), "Phase 28 executing");
		assert.equal(formatGsdStateScene(verifying), "Phase 28 verifying");
		assert.notEqual(formatGsdStateScene(executing), formatGsdStateScene(verifying));
	});

	it("complete takes precedence over in-flight when both conditions hold", () => {
		const state: GsdPlanningState = {
			milestone: "v6",
			milestoneName: "Test",
			currentPhase: "28",
			status: "executing",
			completedPhases: 6,
			totalPhases: 6,
			percent: 100,
		};
		assert.equal(formatGsdStateScene(state), "milestone complete");
	});
});

describe("readPlanningState", () => {
	it("resolves this repo's own real frontmatter end to end from a temp-dir copy", () => {
		const root = makeTempDir("gsd-state-reader-e2e-");
		mkdirSync(join(root, ".planning"));
		writeFileSync(join(root, ".planning", "STATE.md"), REAL_STATE_MD_FIXTURE, "utf8");

		const state = readPlanningState(root, 1000);
		assert.ok(state);
		assert.equal(state.milestone, "v6");
		assert.equal(state.milestoneName, "Operator-Surface Finish + Reliability Tail");
		assert.equal(formatGsdStateScene(state), "Phase 28 planning");
	});

	it("returns null from a temp dir with no .planning/ anywhere up to the filesystem root", () => {
		const root = makeTempDir("gsd-state-reader-e2e-none-");
		assert.equal(readPlanningState(root, 1000), null);
	});

	it("never throws on a corrupt file", () => {
		const root = makeTempDir("gsd-state-reader-e2e-corrupt-");
		mkdirSync(join(root, ".planning"));
		writeFileSync(join(root, ".planning", "STATE.md"), Buffer.from([0x00, 0xff, 0xfe]), "binary");

		assert.doesNotThrow(() => readPlanningState(root, 1000));
		assert.equal(readPlanningState(root, 2000), null);
	});

	it("performs one filesystem read within the TTL, then re-reads after it expires", () => {
		const root = makeTempDir("gsd-state-reader-ttl-");
		mkdirSync(join(root, ".planning"));
		const statePath = join(root, ".planning", "STATE.md");
		writeFileSync(statePath, REAL_STATE_MD_FIXTURE, "utf8");

		const first = readPlanningState(root, 1_000_000);
		assert.ok(first);
		assert.equal(first.status, "planning");

		// Rewrite the file with a different status; a cache hit within the TTL must not see it.
		const rewritten = REAL_STATE_MD_FIXTURE.replace("status: planning", "status: executing");
		writeFileSync(statePath, rewritten, "utf8");

		const withinTtl = readPlanningState(root, 1_000_000 + 500);
		assert.ok(withinTtl);
		assert.equal(withinTtl.status, "planning", "expected the cached (stale) value within the TTL window");

		const afterTtl = readPlanningState(root, 1_000_000 + 2_500);
		assert.ok(afterTtl);
		assert.equal(afterTtl.status, "executing", "expected a fresh read once the TTL has expired");
	});
});
