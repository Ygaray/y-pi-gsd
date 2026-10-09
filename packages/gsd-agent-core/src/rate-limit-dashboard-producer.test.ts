import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createAssistantMessageEventStream, registerProviderApiProvider, unregisterApiProviders } from "@gsd/pi-ai";
import type { Api, Model } from "@gsd/pi-ai";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import type { AgentSession } from "./agent-session.ts";
import type { RateLimitWindow } from "./rate-limit-headers.ts";
import { SDK_FRESH_MS } from "./rate-limit-status-ref.ts";
import { createAgentSession } from "./sdk.ts";
import type { ExecFileLike, FetchLike } from "./usage-dashboard-poller.ts";

/**
 * SC3 / D-02 (43-01): a fresh SDK or header reading always beats the dashboard, decided per window
 * at write time. These reach the real producers the same way rate-limit-provider-switch.test.ts
 * does: the captured `onRateLimitEvent` closure from the real `streamFn`, and `agent.onResponse`.
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

type EventSink = (window: RateLimitWindow, windowKey: "session" | "weekly") => void;

const LOGGED_IN = JSON.stringify({ loggedIn: true, orgId: "org-test-uuid", email: "me@example.test" });

function okPayload(session = 8, weekly = 29, ageS = 0): Record<string, unknown> {
	return {
		schema_version: 1,
		status: "ok",
		stale: false,
		age_s: ageS,
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

const model: Model<Api> = {
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

async function withSession(
	run: (ctx: {
		session: AgentSession;
		fireSdkEvent: EventSink;
		fetchCalls: string[];
		setFetch: (respond: (call: number) => Promise<Response> | Response) => void;
	}) => Promise<void>,
	options: { now?: () => number } = {},
): Promise<void> {
	const tempDir = join(tmpdir(), `gsd-agent-core-sc3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sourceId = `sc3-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	try {
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));

		const fetchCalls: string[] = [];
		let respond: (call: number) => Promise<Response> | Response = () => okResponse();
		const fetchImpl: FetchLike = async (url) => {
			fetchCalls.push(url);
			return respond(fetchCalls.length);
		};
		const execFileImpl: ExecFileLike = async () => ({ stdout: LOGGED_IN });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
			usageDashboard: { fetchImpl, execFileImpl, env: {}, platform: "linux", ...(options.now ? { now: options.now } : {}) },
		});
		try {
			let captured: EventSink | undefined;
			registerProviderApiProvider(
				model.provider,
				{
					api: "openai-completions",
					stream: () => {
						throw new Error("unexpected non-simple dispatch");
					},
					streamSimple: (_streamModel, _context, streamOptions) => {
						captured = (streamOptions as { onRateLimitEvent?: EventSink })?.onRateLimitEvent;
						const fakeStream = createAssistantMessageEventStream();
						fakeStream.push({ type: "done", reason: "stop", message: {} } as never);
						return fakeStream;
					},
				},
				sourceId,
			);
			try {
				const stream = await session.agent.streamFn?.(model, { messages: [] } as never, {} as never);
				for await (const _event of stream as AsyncIterable<unknown>) {
					// drain
				}
				assert.equal(typeof captured, "function");
				await run({
					session,
					fireSdkEvent: (window, key) => captured?.(window, key),
					fetchCalls,
					setFetch: (fn) => {
						respond = fn;
					},
				});
			} finally {
				unregisterApiProviders(sourceId);
			}
		} finally {
			session.dispose();
		}
	} finally {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("rate-limit dashboard producer precedence (SC3)", () => {
	test("SC3a a fresh SDK session event followed by a dashboard poll keeps the SDK session value and fills the empty weekly window", async () => {
		await withSession(async ({ session, fireSdkEvent }) => {
			fireSdkEvent({ usedPercent: 55, resetsAtEpochSec: null }, "session");
			session.onRateLimitStatusChange(() => {});
			await session._rateLimitFallbackProducer?.refresh();
			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 55);
			assert.equal(session.getRateLimitStatus()?.weekly?.usedPercent, 29);
			assert.equal(session._rateLimitStatusRef?.meta?.session?.source, "sdk");
			assert.equal(session._rateLimitStatusRef?.meta?.weekly?.source, "dashboard");
		});
	});

	test("SC3b a dashboard reading followed by an SDK event is overwritten by the SDK event", async () => {
		await withSession(async ({ session, fireSdkEvent }) => {
			session.onRateLimitStatusChange(() => {});
			await session._rateLimitFallbackProducer?.refresh();
			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 8);
			assert.equal(session._rateLimitStatusRef?.meta?.session?.source, "dashboard");

			fireSdkEvent({ usedPercent: 55, resetsAtEpochSec: null }, "session");
			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 55);
			assert.equal(session._rateLimitStatusRef?.meta?.session?.source, "sdk");
			assert.equal(session.getRateLimitStatus()?.weekly?.usedPercent, 29);

			await session._rateLimitFallbackProducer?.refresh();
			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 55);
		});
	});

	test("SC3c race an SDK event that lands while the dashboard fetch is in flight survives the fetch resolving", async () => {
		await withSession(async ({ session, fireSdkEvent, fetchCalls, setFetch }) => {
			const pending = deferred<Response>();
			setFetch(() => pending.promise);
			session.onRateLimitStatusChange(() => {});
			await waitFor(() => fetchCalls.length === 1);

			fireSdkEvent({ usedPercent: 55, resetsAtEpochSec: null }, "session");
			pending.resolve(okResponse(okPayload(8, 29)));
			await session._rateLimitFallbackProducer?.refresh();

			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 55);
			assert.equal(session._rateLimitStatusRef?.meta?.session?.source, "sdk");
			assert.equal(session.getRateLimitStatus()?.weekly?.usedPercent, 29);
			assert.equal(session._rateLimitStatusRef?.meta?.weekly?.source, "dashboard");
		});
	});

	test("SC3d an SDK reading older than SDK_FRESH_MS is replaced by a newer dashboard observation", async () => {
		const later = Date.now() + SDK_FRESH_MS + 1000;
		await withSession(
			async ({ session, fireSdkEvent }) => {
				fireSdkEvent({ usedPercent: 55, resetsAtEpochSec: null }, "session");
				session.onRateLimitStatusChange(() => {});
				await session._rateLimitFallbackProducer?.refresh();
				assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 8);
				assert.equal(session._rateLimitStatusRef?.meta?.session?.source, "dashboard");
			},
			{ now: () => later },
		);
	});

	test("SC3e a header reading is stamped headers and protected like an SDK reading", async () => {
		await withSession(async ({ session }) => {
			await session.agent.onResponse?.(
				{ status: 200, headers: { "anthropic-ratelimit-unified-5h-used-percent": "40" } },
				model,
			);
			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 40);
			assert.equal(session._rateLimitStatusRef?.meta?.session?.source, "headers");

			session.onRateLimitStatusChange(() => {});
			await session._rateLimitFallbackProducer?.refresh();
			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 40);
			assert.equal(session._rateLimitStatusRef?.meta?.session?.source, "headers");
			assert.equal(session.getRateLimitStatus()?.weekly?.usedPercent, 29);
		});
	});
});
