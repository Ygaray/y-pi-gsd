// Project/App: gsd-pi
// File Purpose: Regression net for the stacked GSD statusline — the 4-tier context meter thresholds,
// the additive blink cue, and the row-per-meter FooterComponent.render() layout (one row each for
// base, context, session, and weekly, plus a conditional milestone row). Ports the `createSession` /
// `createFooterData` structural stubs and the per-row `visibleWidth(line) <= width` invariant out of the
// now-deleted `packages/pi-coding-agent/test/footer-width.test.ts` (dead since `FooterComponent` moved to
// this package), converting them from vitest to `node:test`.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@gsd/pi-tui";
import type { AgentSession } from "@gsd/agent-core";
import type { GitStatusInfo, ReadonlyFooterDataProvider } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { initTheme, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { FooterComponent, formatCwdForFooter } from "./footer.js";
import { resolveMeterTone } from "./gsd-statusline-format.js";

/**
 * `FooterComponent.render()` resolves `.planning/STATE.md` via `readPlanningState(gsdState?.cwd ??
 * process.cwd())`, and `findPlanningStatePath`'s walk-up does not stop at a git worktree boundary
 * (T-28-12, by design) — so leaving `process.cwd()` at its real value here would let every test in
 * this file pick up this repo's own ambient `.planning/STATE.md` (found by walking up past the
 * worktree root into the main checkout) and grow an unexpected row 3. `process.cwd` is monkey-patched
 * to a hermetic, `.planning`-free temp directory for the whole file; `withCwd` below temporarily
 * repoints it at a directory that DOES have a `.planning/STATE.md` for the row-3-specific tests.
 */
const NO_PLANNING_CWD = mkdtempSync(join(tmpdir(), "footer-statusline-no-planning-"));
const originalProcessCwd = process.cwd;

function withCwd<T>(dir: string, fn: () => T): T {
	process.cwd = () => dir;
	try {
		return fn();
	} finally {
		process.cwd = () => NO_PLANNING_CWD;
	}
}

function writeStateMd(dir: string, frontmatter: string): void {
	mkdirSync(join(dir, ".planning"), { recursive: true });
	writeFileSync(join(dir, ".planning", "STATE.md"), frontmatter, "utf8");
}

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type RateLimitWindow = { usedPercent: number; resetsAtEpochSec: number | null };
type RateLimitStatus = { session: RateLimitWindow | null; weekly: RateLimitWindow | null };

function createSession(options: {
	sessionName?: string;
	modelId?: string;
	provider?: string;
	contextPercent?: number | null;
	usage?: UsageTotals;
	rateLimitStatus?: RateLimitStatus | undefined;
}): AgentSession {
	const usage: UsageTotals = options.usage ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	const contextPercent = options.contextPercent === undefined ? 12.3 : options.contextPercent;

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
			},
		},
		sessionManager: {
			getUsageTotals: () => usage,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: contextPercent }),
		modelRegistry: {
			isUsingOAuth: () => false,
			getProviderAuthMode: () => undefined,
		},
		getRateLimitStatus: () => options.rateLimitStatus,
	};

	return session as unknown as AgentSession;
}

function createFooterData(
	providerCount = 1,
	options: { branch?: string | null; gitStatus?: GitStatusInfo | null } = {},
): ReadonlyFooterDataProvider {
	const branch = options.branch === undefined ? "main" : options.branch;
	const gitStatus = options.gitStatus === undefined ? null : options.gitStatus;
	return {
		getGitBranch: () => branch,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
		getGitStatus: () => gitStatus,
		onGitStatusChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};
}

before(() => {
	initTheme("dark", false);
	process.cwd = () => NO_PLANNING_CWD;
});

after(() => {
	process.cwd = originalProcessCwd;
	rmSync(NO_PLANNING_CWD, { recursive: true, force: true });
});

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		assert.equal(formatCwdForFooter("/home/user2", "/home/user"), "/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		assert.equal(formatCwdForFooter("/home/user", "/home/user"), "~");
		assert.equal(formatCwdForFooter("/home/user/project", "/home/user"), "~/project");
	});
});

describe("resolveMeterTone", () => {
	it("resolves the success tier below 50%", () => {
		assert.equal(resolveMeterTone(0), "success");
		assert.equal(resolveMeterTone(49.9), "success");
	});

	it("resolves the warning tier from 50% up to 65%", () => {
		assert.equal(resolveMeterTone(50), "warning");
		assert.equal(resolveMeterTone(64.9), "warning");
	});

	it("resolves the contextOrange tier from 65% up to 80%", () => {
		assert.equal(resolveMeterTone(65), "contextOrange");
		assert.equal(resolveMeterTone(79.9), "contextOrange");
	});

	it("resolves the error tier at 80% and above", () => {
		assert.equal(resolveMeterTone(80), "error");
		assert.equal(resolveMeterTone(100), "error");
		assert.equal(resolveMeterTone(1000), "error");
	});

	it("clamps non-finite and negative input to success without throwing", () => {
		assert.equal(resolveMeterTone(NaN), "success");
		assert.equal(resolveMeterTone(-5), "success");
	});
});

describe("FooterComponent stacked render", () => {
	it("keeps every row within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		assert.equal(lines.length, 4);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width);
		}
	});

	it("keeps every row within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			usage: { input: 12_345, output: 6_789, cacheRead: 0, cacheWrite: 0, cost: 1.234 },
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		assert.equal(lines.length, 4);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width);
		}
	});

	it("renders four full-width rows with a 10-cell context bar on row 2", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		assert.equal(lines.length, 4);
		for (const line of lines) {
			assert.equal(visibleWidth(line), width);
		}

		const row2Plain = stripVTControlCharacters(lines[1]!);
		const barMatch = row2Plain.match(/[█░]{10}/);
		assert.ok(barMatch, `expected a 10-cell bar drawn from the █/░ vocabulary, got: ${row2Plain}`);
	});

	it("renders context, session, and weekly meters each on their own row, honestly reporting session/weekly as unavailable", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		assert.equal(lines.length, 4);
		for (const line of lines) {
			assert.equal(visibleWidth(line), width);
		}

		const contextPlain = stripVTControlCharacters(lines[1]!);
		const sessionPlain = stripVTControlCharacters(lines[2]!);
		const weeklyPlain = stripVTControlCharacters(lines[3]!);
		assert.match(contextPlain, /context:/);
		assert.match(sessionPlain, /session:/);
		assert.match(weeklyPlain, /weekly:/);

		const unavailableCount =
			sessionPlain.split("unavailable").length - 1 + (weeklyPlain.split("unavailable").length - 1);
		assert.equal(
			unavailableCount,
			2,
			`expected exactly 2 "unavailable" literals across the session+weekly rows, got: ${sessionPlain} | ${weeklyPlain}`,
		);
		assert.doesNotMatch(contextPlain, /context: unavailable/);
	});

	it("renders real session and weekly windows with bar, percent, and reset countdown on their own rows when both are supplied", () => {
		const width = 120;
		const nowEpochSec = Math.floor(Date.now() / 1000);
		const session = createSession({
			sessionName: "demo",
			rateLimitStatus: {
				session: { usedPercent: 42, resetsAtEpochSec: nowEpochSec + 3600 },
				weekly: { usedPercent: 10, resetsAtEpochSec: nowEpochSec + 86400 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		assert.equal(lines.length, 4);
		for (const line of lines) {
			assert.equal(visibleWidth(line), width);
		}

		const sessionPlain = stripVTControlCharacters(lines[2]!);
		const weeklyPlain = stripVTControlCharacters(lines[3]!);
		assert.match(sessionPlain, /session: [█░]{10} 42% ↻1h/);
		assert.match(weeklyPlain, /weekly: [█░]{10} 10% ↻1d/);
		assert.equal(sessionPlain.includes("unavailable"), false);
		assert.equal(weeklyPlain.includes("unavailable"), false);
	});

	it("renders unavailable for both the session and weekly rows when getRateLimitStatus() returns undefined", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo", rateLimitStatus: undefined });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		const sessionPlain = stripVTControlCharacters(lines[2]!);
		const weeklyPlain = stripVTControlCharacters(lines[3]!);
		assert.match(sessionPlain, /session: unavailable/);
		assert.match(weeklyPlain, /weekly: unavailable/);
	});

	it("renders a real session row and unavailable weekly row when only the session window is supplied (A-28-01)", () => {
		const width = 120;
		const nowEpochSec = Math.floor(Date.now() / 1000);
		const session = createSession({
			sessionName: "demo",
			rateLimitStatus: {
				session: { usedPercent: 55, resetsAtEpochSec: nowEpochSec + 3600 },
				weekly: null,
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		const sessionPlain = stripVTControlCharacters(lines[2]!);
		const weeklyPlain = stripVTControlCharacters(lines[3]!);
		assert.match(sessionPlain, /session: [█░]{10} 55%/);
		assert.match(weeklyPlain, /weekly: unavailable/);
	});

	it("renders git dirty/staged/untracked/ahead/behind markers attached directly to the branch on row 1", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo" });
		const gitStatus: GitStatusInfo = { staged: 1, dirty: 3, untracked: 2, conflicts: 0, ahead: 4, behind: 5 };
		const footer = new FooterComponent(session, createFooterData(1, { gitStatus }));

		const lines = footer.render(width);
		assert.equal(lines.length, 4);
		for (const line of lines) {
			assert.equal(visibleWidth(line), width);
		}

		const row1Plain = stripVTControlCharacters(lines[0]!);
		assert.match(row1Plain, /main\+1~3\?2↑4↓5/, `expected markers attached to branch, got: ${row1Plain}`);
	});

	it("renders the bare branch name with no marker run for a clean, in-sync tree", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo" });
		const cleanStatus: GitStatusInfo = { staged: 0, dirty: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0 };
		const footer = new FooterComponent(session, createFooterData(1, { gitStatus: cleanStatus }));

		const lines = footer.render(width);
		const row1Plain = stripVTControlCharacters(lines[0]!);
		assert.match(row1Plain, /main/);
		assert.doesNotMatch(row1Plain, /main[+~?↑↓]/);
	});

	it("omits the branch+marker segment entirely outside a repo", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo" });
		const footer = new FooterComponent(session, createFooterData(1, { branch: null }));

		const lines = footer.render(width);
		const row1Plain = stripVTControlCharacters(lines[0]!);
		assert.doesNotMatch(row1Plain, /main/);
	});

	it("renders the context meter's filled cells in contextOrange at 72% — distinct from warning", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo", contextPercent: 72 });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		const row2 = lines[1]!;

		const contextOrangeAnsi = theme.getFgAnsi("contextOrange");
		const warningAnsi = theme.getFgAnsi("warning");
		assert.notEqual(contextOrangeAnsi, warningAnsi);
		assert.ok(
			row2.includes(contextOrangeAnsi),
			`expected row 2 to carry the contextOrange ANSI sequence at 72% context, got: ${JSON.stringify(row2)}`,
		);
	});
});

/** Byte-for-byte-shaped (not byte-for-byte content) `.planning/STATE.md` fixture — real field names, a
 * caller-supplied milestone name so the SC-5 comparison can vary just that one field. */
function stateMdFixture(milestoneName: string): string {
	return `---
milestone: v6
milestone_name: ${milestoneName}
current_phase: 28
status: planning
progress:
  total_phases: 6
  completed_phases: 0
  percent: 0
---
`;
}

describe("FooterComponent milestone row (row 5, SL-02/ROADMAP SC-4/SC-5)", () => {
	it("renders exactly 5 rows with the milestone line when .planning/STATE.md resolves", () => {
		const width = 120;
		const dir = mkdtempSync(join(tmpdir(), "footer-milestone-"));
		writeStateMd(dir, stateMdFixture("Operator-Surface Finish + Reliability Tail"));

		const session = createSession({ sessionName: "demo" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = withCwd(dir, () => footer.render(width));
		assert.equal(lines.length, 5);
		const row5Plain = stripVTControlCharacters(lines[4]!);
		assert.ok(row5Plain.startsWith("v6"), `expected row 5 to start with the milestone version, got: ${row5Plain}`);
		assert.ok(
			row5Plain.trimEnd().endsWith("Phase 28 planning"),
			`expected row 5 to end with the scene phrase (after trimming the row's full-width padding), got: ${JSON.stringify(row5Plain)}`,
		);
		assert.equal(visibleWidth(lines[4]!), width);

		rmSync(dir, { recursive: true, force: true });
	});

	it("renders exactly 4 rows when no .planning/STATE.md is resolvable", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo" });
		const footer = new FooterComponent(session, createFooterData(1));

		// Default process.cwd() override (NO_PLANNING_CWD) has no .planning anywhere up to the
		// filesystem root — the milestone row must be omitted entirely, never a blank fifth row.
		const lines = footer.render(width);
		assert.equal(lines.length, 4);
	});

	it(
		"SC-5: a 1000-character milestone name leaves rows 1 through 4 byte-identical and row 5 still measures exactly the width",
		{ timeout: 10_000 },
		async () => {
			const width = 120;
			// One fixed directory (and therefore one fixed displayed cwd) for both renders — SC-5 is
			// about the MILESTONE NAME's length not disturbing rows 1-4, so everything else (session,
			// footerData, displayed cwd) must be held constant; only the STATE.md content changes.
			const dir = mkdtempSync(join(tmpdir(), "footer-milestone-sc5-"));
			const statePath = join(dir, ".planning", "STATE.md");
			writeStateMd(dir, stateMdFixture("Short"));

			const session = createSession({ sessionName: "demo" });
			const footer = new FooterComponent(session, createFooterData(1));

			const shortLines = withCwd(dir, () => footer.render(width));

			// readPlanningState caches per-cwd for a 2s TTL (by design — render() runs every
			// keystroke). Wait past it before rewriting the fixture, or the second render would see
			// the stale (short-name) cached state instead of the freshly-written long name.
			await new Promise((resolve) => setTimeout(resolve, 2100));
			writeFileSync(statePath, stateMdFixture("x".repeat(1000)), "utf8");

			const longLines = withCwd(dir, () => footer.render(width));

			assert.equal(shortLines.length, 5);
			assert.equal(longLines.length, 5);
			for (let i = 0; i < 4; i++) {
				assert.equal(
					shortLines[i],
					longLines[i],
					`row ${i + 1} must be byte-identical regardless of milestone name length`,
				);
			}
			assert.notEqual(shortLines[4], longLines[4]);
			assert.equal(visibleWidth(shortLines[4]!), width);
			assert.equal(visibleWidth(longLines[4]!), width);

			rmSync(dir, { recursive: true, force: true });
		},
	);
});
