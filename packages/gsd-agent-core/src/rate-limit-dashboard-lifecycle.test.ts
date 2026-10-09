import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Api, Model } from "@gsd/pi-ai";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import type { AgentSession } from "./agent-session.ts";
import { createAgentSession } from "./sdk.ts";
import type { ExecFileLike, FetchLike } from "./usage-dashboard-poller.ts";

/**
 * USAGE-01 (43-03): the dashboard producer is tied to the session lifecycle. A model switch onto
 * claude-code polls at once (D-01), only an observed session polls, and observers come and go
 * without leaks. Every test injects fetchImpl / execFileImpl, and the global fetch trips, so the
 * live dashboard and the real claude CLI are never reached.
 */

const REAL_FETCH = globalThis.fetch;

before(() => {
	globalThis.fetch = (() => {
		throw new Error("live dashboard fetch attempted in a test");
	}) as unknown as typeof fetch;
});

after(() => {
	globalThis.fetch = REAL_FETCH;
});

const LOGGED_IN = JSON.stringify({ loggedIn: true, orgId: "org-test-uuid", email: "me@example.test" });

function okPayload(session = 8, weekly = 29): Record<string, unknown> {
	return {
		schema_version: 1,
		status: "ok",
		stale: false,
		age_s: 0,
		claude_org_uuid: "org-test-uuid",
		windows: [
			{ name: "5h", used_pct: session, resets_at: null, credit: false },
			{ name: "weekly", used_pct: weekly, resets_at: null, credit: false },
		],
	};
}

function okResponse(payload: Record<string, unknown> = okPayload()): Response {
	return new Response(JSON.stringify(payload), { status: 200 });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.ok(condition(), "condition never became true");
}

function createModel(provider: string): Model<Api> {
	return {
		id: `${provider}-test-model`,
		name: `${provider} Test Model`,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

const claudeCodeModel = createModel("claude-code");
const otherModel = createModel("provider-b");

interface Ctx {
	session: AgentSession;
	fetchCalls: string[];
	exec: { count: number };
	fetchSignals: Array<AbortSignal | undefined>;
	setFetch: (respond: (call: number) => Promise<Response> | Response) => void;
}

async function withSession(
	run: (ctx: Ctx) => Promise<void>,
	options: { start?: Model<Api>; scoped?: boolean; usageDashboard?: false } = {},
): Promise<void> {
	const tempDir = join(tmpdir(), `gsd-agent-core-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	try {
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(claudeCodeModel.provider, "test-api-key");
		authStorage.setRuntimeApiKey(otherModel.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));

		const fetchCalls: string[] = [];
		const fetchSignals: Array<AbortSignal | undefined> = [];
		const exec = { count: 0 };
		let respond: (call: number) => Promise<Response> | Response = () => okResponse();
		const fetchImpl: FetchLike = async (url, init) => {
			fetchCalls.push(url);
			fetchSignals.push(init?.signal ?? undefined);
			return respond(fetchCalls.length);
		};
		const execFileImpl: ExecFileLike = async () => {
			exec.count++;
			return { stdout: LOGGED_IN };
		};

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: options.start ?? claudeCodeModel,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
			...(options.scoped ? { scopedModels: [{ model: otherModel }, { model: claudeCodeModel }] } : {}),
			usageDashboard:
				options.usageDashboard === false
					? false
					: { fetchImpl, execFileImpl, env: {}, platform: "linux" },
		});
		try {
			await run({
				session,
				fetchCalls,
				exec,
				fetchSignals,
				setFetch: (fn) => {
					respond = fn;
				},
			});
		} finally {
			session.dispose();
		}
	} finally {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("USAGE-01 model switch", () => {
	test("USAGE-01 model switch: a session that starts on another provider polls the dashboard as soon as setModel switches it to claude-code", async () => {
		await withSession(
			async ({ session, fetchCalls, exec }) => {
				let notified = 0;
				session.onRateLimitStatusChange(() => {
					notified++;
				});
				await session._rateLimitFallbackProducer?.refresh();
				assert.equal(fetchCalls.length, 0, "idle on another provider: no dashboard request");
				assert.equal(exec.count, 0, "idle on another provider: no CLI spawn");

				await session.setModel(claudeCodeModel, { persist: false });
				// No manual refresh here: the model-change hook alone must start the request.
				await waitFor(() => notified === 1);

				assert.equal(fetchCalls.length, 1);
				assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 8);
				assert.equal(session.getRateLimitStatus()?.weekly?.usedPercent, 29);
			},
			{ start: otherModel },
		);
	});

	test("switching away from claude-code hides the dashboard values and makes no further request", async () => {
		await withSession(async ({ session, fetchCalls }) => {
			session.onRateLimitStatusChange(() => {});
			await session._rateLimitFallbackProducer?.refresh();
			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 8);
			const before = fetchCalls.length;

			await session.setModel(otherModel, { persist: false });
			assert.equal(session.getRateLimitStatus(), undefined);
			await session._rateLimitFallbackProducer?.refresh();
			assert.equal(fetchCalls.length, before, "no request while another provider is active");
			assert.equal(session.getRateLimitStatus(), undefined);
		});
	});

	test("cycleModel onto claude-code triggers an immediate poll", async () => {
		await withSession(
			async ({ session, fetchCalls }) => {
				session.onRateLimitStatusChange(() => {});
				await session._rateLimitFallbackProducer?.refresh();
				assert.equal(fetchCalls.length, 0);

				const result = await session.cycleModel();
				assert.equal(result?.model.provider, "claude-code");
				await waitFor(() => session.getRateLimitStatus()?.session?.usedPercent === 8);
				assert.equal(fetchCalls.length, 1);
			},
			{ start: otherModel, scoped: true },
		);
	});
});
