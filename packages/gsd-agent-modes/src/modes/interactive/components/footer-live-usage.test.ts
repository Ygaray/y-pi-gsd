// Project/App: gsd-pi
// File Purpose: USAGE-01 end-to-end - a real agent-core session fed only by the UsageDashboard
// producer renders its session and weekly meter rows through the UNCHANGED FooterComponent. Also
// proves D-04: rendering is a pure read and never requests the dashboard. The dashboard and the
// claude CLI are injected fakes; the global fetch trips if anything reaches for the live service.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@gsd/pi-ai";
import { createAgentSession } from "@gsd/agent-core";
import type { AgentSession, UsageDashboardOptions } from "@gsd/agent-core";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import type { GitStatusInfo, ReadonlyFooterDataProvider } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { FooterComponent } from "./footer.js";

type DashboardFakes = Exclude<UsageDashboardOptions, false>;
type FetchImpl = NonNullable<DashboardFakes["fetchImpl"]>;
type ExecFileImpl = NonNullable<DashboardFakes["execFileImpl"]>;

/** Same hermetic process.cwd patch as footer-statusline.test.ts: no ambient .planning/STATE.md row. */
const NO_PLANNING_CWD = mkdtempSync(join(tmpdir(), "footer-live-usage-no-planning-"));
const originalProcessCwd = process.cwd;
const REAL_FETCH = globalThis.fetch;

before(() => {
	initTheme("dark", false);
	process.cwd = () => NO_PLANNING_CWD;
	globalThis.fetch = (() => {
		throw new Error("live dashboard fetch attempted in a test");
	}) as unknown as typeof fetch;
});

after(() => {
	process.cwd = originalProcessCwd;
	globalThis.fetch = REAL_FETCH;
	rmSync(NO_PLANNING_CWD, { recursive: true, force: true });
});

function createFooterData(providerCount = 1): ReadonlyFooterDataProvider {
	const gitStatus: GitStatusInfo | null = null;
	return {
		getGitBranch: () => "main",
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

const claudeCodeModel: Model<Api> = {
	id: "claude-code-test-model",
	name: "claude-code Test Model",
	api: "openai-completions",
	provider: "claude-code",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const LOGGED_IN = JSON.stringify({ loggedIn: true, orgId: "org-test-uuid", email: "me@example.test" });

function payload(options: { stale: boolean }): Record<string, unknown> {
	const nowMs = Date.now();
	return {
		schema_version: 1,
		status: "ok",
		stale: options.stale,
		age_s: 0,
		claude_org_uuid: "org-test-uuid",
		windows: [
			{ name: "5h", used_pct: 8, resets_at: new Date(nowMs + 3_600_000).toISOString(), credit: false },
			{ name: "weekly", used_pct: 29, resets_at: new Date(nowMs + 2 * 86_400_000).toISOString(), credit: false },
		],
	};
}

async function withDashboardSession(
	body: Record<string, unknown>,
	run: (ctx: { session: AgentSession; fetchCalls: string[]; exec: { count: number } }) => Promise<void>,
): Promise<void> {
	const tempDir = join(tmpdir(), `gsd-footer-live-usage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	try {
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(claudeCodeModel.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));

		const fetchCalls: string[] = [];
		const exec = { count: 0 };
		const fetchImpl: FetchImpl = async (url) => {
			fetchCalls.push(url);
			return new Response(JSON.stringify(body), { status: 200 });
		};
		const execFileImpl: ExecFileImpl = async () => {
			exec.count++;
			return { stdout: LOGGED_IN };
		};

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: claudeCodeModel,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
			usageDashboard: { fetchImpl, execFileImpl, env: {}, platform: "linux" },
		});
		try {
			await run({ session, fetchCalls, exec });
		} finally {
			session.dispose();
		}
	} finally {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	}
}

function rows(session: AgentSession): { session: string; weekly: string } {
	const lines = new FooterComponent(session, createFooterData(1)).render(120);
	return {
		session: stripVTControlCharacters(lines[2] ?? ""),
		weekly: stripVTControlCharacters(lines[3] ?? ""),
	};
}

describe("USAGE-01 live usage through the unchanged footer", () => {
	it("USAGE-01 the unchanged footer renders dashboard-fed session and weekly rows from a real claude-code session", async () => {
		await withDashboardSession(payload({ stale: false }), async ({ session }) => {
			session.onRateLimitStatusChange(() => {});
			await session._rateLimitFallbackProducer?.refresh();

			const { session: sessionRow, weekly } = rows(session);
			assert.match(sessionRow, /session: [█░]{10} 8% ↻/);
			assert.match(weekly, /weekly: [█░]{10} 29% ↻/);
			assert.equal(sessionRow.includes("unavailable"), false);
			assert.equal(weekly.includes("unavailable"), false);
		});
	});

	it("the unchanged footer shows unavailable on both rows when the dashboard reports stale", async () => {
		await withDashboardSession(payload({ stale: true }), async ({ session }) => {
			session.onRateLimitStatusChange(() => {});
			await session._rateLimitFallbackProducer?.refresh();

			const { session: sessionRow, weekly } = rows(session);
			assert.match(sessionRow, /session: unavailable/);
			assert.match(weekly, /weekly: unavailable/);
		});
	});

	it("rendering the footer never requests the dashboard", async () => {
		await withDashboardSession(payload({ stale: false }), async ({ session, fetchCalls, exec }) => {
			session.onRateLimitStatusChange(() => {});
			await session._rateLimitFallbackProducer?.refresh();
			const fetchBefore = fetchCalls.length;
			const execBefore = exec.count;
			assert.equal(fetchBefore, 1);

			for (let i = 0; i < 5; i++) rows(session);

			assert.equal(fetchCalls.length, fetchBefore);
			assert.equal(exec.count, execBefore);
		});
	});
});
