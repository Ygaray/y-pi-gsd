import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAssistantMessageEventStream, registerProviderApiProvider, unregisterApiProviders } from "@gsd/pi-ai";
import type { Api, Model, ProviderResponse } from "@gsd/pi-ai";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import type { AgentSession } from "./agent-session.ts";
import { createAgentSession } from "./sdk.ts";

/**
 * CR-03 / WR-01 regression coverage (28-REVIEW-FIX.md, commits 99b1f49a / 97deec75).
 *
 * These exercise the REAL `onResponse` closure `createAgentSession` binds via
 * `new Agent({ onResponse })` in sdk.ts, and the real `AgentSession.getRateLimitStatus()`
 * method -- not a reimplementation of their logic. Calling `session.agent.onResponse?.(...)`
 * directly (rather than driving a full streamed turn through a registered fake provider) is
 * the smallest seam that still runs the exact production code path: `Agent` stores whatever
 * `onResponse` callback it was constructed with as a public property, and `onResponse`'s own
 * body only reads `response.headers` and `model.provider` -- no other agent-loop machinery is
 * involved for either of these two fixes.
 */

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

describe("rate-limit status: CR-03 provider-switch invalidation + WR-01 per-window merge", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(
			tmpdir(),
			`gsd-agent-core-ratelimit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(model: Model<Api>, extraAuthProviders: string[] = []): Promise<AgentSession> {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		for (const provider of extraAuthProviders) {
			authStorage.setRuntimeApiKey(provider, "test-api-key");
		}
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.inMemory(cwd);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
		});
		return session;
	}

	test("(a) a provider switch makes getRateLimitStatus() go from populated to undefined", async () => {
		const modelA = createModel("provider-a");
		const modelB = createModel("provider-b");
		const session = await createSession(modelA, [modelB.provider]);
		try {
			const response: ProviderResponse = {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-used-percent": "40",
					"anthropic-ratelimit-unified-7d-used-percent": "10",
				},
			};
			await session.agent.onResponse?.(response, modelA);

			assert.ok(session.getRateLimitStatus(), "expected a populated rate-limit status after provider A's response");
			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 40);

			// Switch the active model to a different provider (Ctrl+P / setModel / cycleModel).
			await session.setModel(modelB, { persist: false });

			// Provider B's responses never carry the Anthropic-only unified headers this
			// pipeline parses, so the cached status still belongs to provider A. Per CR-03, a
			// stale reading from a since-switched-away-from provider must report "unavailable"
			// rather than keep echoing provider A's now-misattributed figures.
			assert.equal(session.getRateLimitStatus(), undefined);
		} finally {
			session.dispose();
		}
	});

	test("(b) a later same-provider response missing the weekly header does not blank a still-valid weekly figure", async () => {
		const modelA = createModel("provider-a");
		const session = await createSession(modelA);
		try {
			const firstResponse: ProviderResponse = {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-used-percent": "40",
					"anthropic-ratelimit-unified-7d-used-percent": "10",
				},
			};
			await session.agent.onResponse?.(firstResponse, modelA);
			assert.equal(session.getRateLimitStatus()?.weekly?.usedPercent, 10);

			// A second response from the SAME provider carries only the session (5h) window --
			// a real, common case: providers don't necessarily resend the weekly figure on
			// every turn.
			const secondResponse: ProviderResponse = {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-used-percent": "55",
				},
			};
			await session.agent.onResponse?.(secondResponse, modelA);

			// The session window updates to the new response's value...
			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 55);
			// ...but the weekly window must retain its previously known value, not blank to null.
			assert.equal(session.getRateLimitStatus()?.weekly?.usedPercent, 10);
		} finally {
			session.dispose();
		}
	});

	test("(c) WR-01's same-provider merge does not leak a stale window across a provider switch (CR-03 still applies)", async () => {
		const modelA = createModel("provider-a");
		const modelB = createModel("provider-b");
		const session = await createSession(modelA, [modelB.provider]);
		try {
			const response: ProviderResponse = {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-used-percent": "40",
					"anthropic-ratelimit-unified-7d-used-percent": "10",
				},
			};
			await session.agent.onResponse?.(response, modelA);
			assert.equal(session.getRateLimitStatus()?.weekly?.usedPercent, 10);

			await session.setModel(modelB, { persist: false });

			// Provider B sends its own (non-Anthropic-shaped) unified 5h header. WR-01's merge
			// must not fill the missing weekly slot from provider A's stale reading, since the
			// previous reading came from a different provider.
			const providerBResponse: ProviderResponse = {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-used-percent": "5",
				},
			};
			await session.agent.onResponse?.(providerBResponse, modelB);

			assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 5);
			assert.equal(session.getRateLimitStatus()?.weekly, null);
		} finally {
			session.dispose();
		}
	});
});

describe("rate_limit_event producer: per-window merge + CR-03 invalidation (same sink as the header path)", () => {
	// These reach the sink the same way the header-path cases above do: register a capture
	// provider, invoke the real `streamFn`, and call the captured `onRateLimitEvent` directly --
	// the smallest seam that still runs the real closure sdk.ts's `streamFn` builds.
	test("(d) a session event followed by a weekly event leaves both windows populated; a second session event updates session while weekly retains its value", async () => {
		const tempDir = join(
			tmpdir(),
			`gsd-agent-core-ratelimit-event-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		try {
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
			const cwd = join(tempDir, "project");
			const agentDir = join(tempDir, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			authStorage.setRuntimeApiKey(model.provider, "test-api-key");
			const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
			const settingsManager = SettingsManager.create(cwd, agentDir);
			const sessionManager = SessionManager.inMemory(cwd);
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				authStorage,
				modelRegistry,
				settingsManager,
				sessionManager,
			});
			try {
				let captured: ((window: { usedPercent: number; resetsAtEpochSec: number | null }, windowKey: "session" | "weekly") => void) | undefined;
				const sourceId = `rate-limit-event-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				registerProviderApiProvider(
					model.provider,
					{
						api: "openai-completions",
						stream: () => {
							throw new Error("unexpected non-simple dispatch");
						},
						streamSimple: (_streamModel, _context, options) => {
							captured = (options as any)?.onRateLimitEvent;
							const fakeStream = createAssistantMessageEventStream();
							fakeStream.push({ type: "done", reason: "stop", message: {} } as any);
							return fakeStream;
						},
					},
					sourceId,
				);
				try {
					const stream = await session.agent.streamFn?.(model, { messages: [] } as any, {} as any);
					for await (const _event of stream as AsyncIterable<unknown>) {
						// drain
					}
					assert.equal(typeof captured, "function");

					captured?.({ usedPercent: 10, resetsAtEpochSec: null }, "session");
					assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 10);
					assert.equal(session.getRateLimitStatus()?.weekly, null);

					captured?.({ usedPercent: 20, resetsAtEpochSec: null }, "weekly");
					assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 10);
					assert.equal(session.getRateLimitStatus()?.weekly?.usedPercent, 20);

					captured?.({ usedPercent: 15, resetsAtEpochSec: null }, "session");
					assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 15);
					assert.equal(session.getRateLimitStatus()?.weekly?.usedPercent, 20);
				} finally {
					unregisterApiProviders(sourceId);
				}
			} finally {
				session.dispose();
			}
		} finally {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("(e) after setModel to a different provider, getRateLimitStatus() returns undefined even though the claude-code reading is still in the ref (CR-03 applies to this producer too)", async () => {
		const tempDir = join(
			tmpdir(),
			`gsd-agent-core-ratelimit-event-cr03-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		try {
			const modelA: Model<Api> = {
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
			const modelB = createModel("provider-b");
			const cwd = join(tempDir, "project");
			const agentDir = join(tempDir, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			authStorage.setRuntimeApiKey(modelA.provider, "test-api-key");
			authStorage.setRuntimeApiKey(modelB.provider, "test-api-key");
			const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
			const settingsManager = SettingsManager.create(cwd, agentDir);
			const sessionManager = SessionManager.inMemory(cwd);
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: modelA,
				authStorage,
				modelRegistry,
				settingsManager,
				sessionManager,
			});
			try {
				let captured: ((window: { usedPercent: number; resetsAtEpochSec: number | null }, windowKey: "session" | "weekly") => void) | undefined;
				const sourceId = `rate-limit-event-cr03-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				registerProviderApiProvider(
					modelA.provider,
					{
						api: "openai-completions",
						stream: () => {
							throw new Error("unexpected non-simple dispatch");
						},
						streamSimple: (_streamModel, _context, options) => {
							captured = (options as any)?.onRateLimitEvent;
							const fakeStream = createAssistantMessageEventStream();
							fakeStream.push({ type: "done", reason: "stop", message: {} } as any);
							return fakeStream;
						},
					},
					sourceId,
				);
				try {
					const stream = await session.agent.streamFn?.(modelA, { messages: [] } as any, {} as any);
					for await (const _event of stream as AsyncIterable<unknown>) {
						// drain
					}
					captured?.({ usedPercent: 33, resetsAtEpochSec: null }, "session");
					assert.equal(session.getRateLimitStatus()?.session?.usedPercent, 33);

					await session.setModel(modelB, { persist: false });
					assert.equal(session.getRateLimitStatus(), undefined);
				} finally {
					unregisterApiProviders(sourceId);
				}
			} finally {
				session.dispose();
			}
		} finally {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
