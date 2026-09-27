// Project/App: gsd-pi
// File Purpose: Regression net for the stacked GSD statusline — the 4-tier context meter thresholds,
// the additive blink cue, and the two-row FooterComponent.render() layout. Ports the `createSession` /
// `createFooterData` structural stubs and the per-row `visibleWidth(line) <= width` invariant out of the
// now-deleted `packages/pi-coding-agent/test/footer-width.test.ts` (dead since `FooterComponent` moved to
// this package), converting them from vitest to `node:test`.

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@gsd/pi-tui";
import type { AgentSession } from "@gsd/agent-core";
import type { GitStatusInfo, ReadonlyFooterDataProvider } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { initTheme, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { FooterComponent, formatCwdForFooter } from "./footer.js";
import { resolveMeterTone } from "./gsd-statusline-format.js";

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
		assert.equal(lines.length, 2);
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
		assert.equal(lines.length, 2);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width);
		}
	});

	it("renders exactly two full-width rows with a 10-cell context bar on row 2", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		assert.equal(lines.length, 2);
		for (const line of lines) {
			assert.equal(visibleWidth(line), width);
		}

		const row2Plain = stripVTControlCharacters(lines[1]!);
		const barMatch = row2Plain.match(/[█░]{10}/);
		assert.ok(barMatch, `expected a 10-cell bar drawn from the █/░ vocabulary, got: ${row2Plain}`);
	});

	it("renders the usage row's three labelled segments, honestly reporting session/weekly as unavailable", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		assert.equal(lines.length, 2);
		for (const line of lines) {
			assert.equal(visibleWidth(line), width);
		}

		const row2Plain = stripVTControlCharacters(lines[1]!);
		assert.match(row2Plain, /context:/);
		assert.match(row2Plain, /session:/);
		assert.match(row2Plain, /weekly:/);

		const unavailableCount = row2Plain.split("unavailable").length - 1;
		assert.equal(unavailableCount, 2, `expected exactly 2 "unavailable" literals, got: ${row2Plain}`);
		assert.doesNotMatch(row2Plain, /context: unavailable/);
	});

	it("renders real session and weekly windows with bar, percent, and reset countdown when both are supplied", () => {
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
		assert.equal(lines.length, 2);
		for (const line of lines) {
			assert.equal(visibleWidth(line), width);
		}

		const row2Plain = stripVTControlCharacters(lines[1]!);
		assert.match(row2Plain, /session: [█░]{10} 42% ↻1h/);
		assert.match(row2Plain, /weekly: [█░]{10} 10% ↻1d/);
		assert.equal(row2Plain.includes("unavailable"), false);
	});

	it("renders unavailable for both usage segments when getRateLimitStatus() returns undefined", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo", rateLimitStatus: undefined });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		const row2Plain = stripVTControlCharacters(lines[1]!);
		const unavailableCount = row2Plain.split("unavailable").length - 1;
		assert.equal(unavailableCount, 2, `expected exactly 2 "unavailable" literals, got: ${row2Plain}`);
	});

	it("renders a real session segment and unavailable weekly when only the session window is supplied (A-28-01)", () => {
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
		const row2Plain = stripVTControlCharacters(lines[1]!);
		assert.match(row2Plain, /session: [█░]{10} 55%/);
		const unavailableCount = row2Plain.split("unavailable").length - 1;
		assert.equal(unavailableCount, 1, `expected exactly 1 "unavailable" literal, got: ${row2Plain}`);
	});

	it("renders git dirty/staged/untracked/ahead/behind markers attached directly to the branch on row 1", () => {
		const width = 120;
		const session = createSession({ sessionName: "demo" });
		const gitStatus: GitStatusInfo = { staged: 1, dirty: 3, untracked: 2, conflicts: 0, ahead: 4, behind: 5 };
		const footer = new FooterComponent(session, createFooterData(1, { gitStatus }));

		const lines = footer.render(width);
		assert.equal(lines.length, 2);
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
