import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Api, Model } from "@gsd/pi-ai";
import { registerProviderApiProvider, unregisterApiProviders } from "@gsd/pi-ai";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import type { AgentSession } from "./agent-session.ts";
import { createAgentSession } from "./sdk.ts";
// Established cross-tree test-import idiom (packages/mcp-server/src/workflow-tools.test.ts
// lines 27-33): resolves under both the repo-root quick-run loader and the dist-test mirror,
// and this package's tsconfig.json excludes **/*.test.ts so it is not typechecked into the
// package build.
import { streamViaClaudeCode } from "../../../src/resources/extensions/claude-code-cli/stream-adapter.ts";

/**
 * D-02/D-04 end-to-end wiring proof (38-CONTEXT.md): the only check in this phase that crosses
 * the extension/agent-core boundary, so the `onRateLimitEvent` callback contract cannot silently
 * diverge between its two independently declared shapes (the structural inline type in
 * `stream-adapter.ts` and the imported `RateLimitWindow` in `sdk.ts`).
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

describe("rate_limit_event wiring: the real adapter + the real sdk.ts sink", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(
			tmpdir(),
			`gsd-agent-core-ratelimit-event-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

	async function createSession(model: Model<Api>): Promise<AgentSession> {
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
		return session;
	}

	test("D-02/D-04 tracer: a five_hour rate_limit_event reaches getRateLimitStatus() through the real adapter and the real sdk.ts sink", async () => {
		const model = createModel("claude-code");
		const session = await createSession(model);
		const sourceId = `rate-limit-event-wiring-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		try {
			// D-05: before the first rate_limit_event of a session, no manufactured reading.
			assert.equal(session.getRateLimitStatus(), undefined);

			let receivedOptions: Record<string, unknown> | undefined;
			registerProviderApiProvider(
				model.provider,
				{
					api: "openai-completions",
					stream: () => {
						throw new Error("unexpected non-simple dispatch — this test only exercises streamSimple");
					},
					streamSimple: (streamModel, context, options) => {
						receivedOptions = options as unknown as Record<string, unknown>;
						return streamViaClaudeCode(
							streamModel as any,
							context,
							{
								...(options as any),
								_skipWorkflowMcpPreflightForTest: true,
								async *_sdkQueryForTest() {
									yield {
										type: "rate_limit_event",
										uuid: "rle-1",
										session_id: "session-1",
										rate_limit_info: {
											status: "allowed",
											rateLimitType: "five_hour",
											utilization: 0.42,
											resetsAt: Math.round(Date.now() / 1000) + 3600,
										},
									};
									yield {
										type: "result",
										subtype: "success",
										uuid: "result-1",
										session_id: "session-1",
										duration_ms: 1,
										duration_api_ms: 1,
										is_error: false,
										num_turns: 1,
										result: "done",
										stop_reason: "end_turn",
										total_cost_usd: 0,
										usage: {
											input_tokens: 0,
											output_tokens: 0,
											cache_read_input_tokens: 0,
											cache_creation_input_tokens: 0,
										},
									};
								},
							} as any,
						);
					},
				},
				sourceId,
			);

			const stream = await session.agent.streamFn?.(model, { messages: [] } as any, {} as any);
			assert.ok(stream, "expected streamFn to return a stream");
			for await (const _event of stream as AsyncIterable<unknown>) {
				// drain
			}

			assert.equal(
				typeof receivedOptions?.onRateLimitEvent,
				"function",
				"expected sdk.ts's streamFn to pass a function-valued onRateLimitEvent to streamSimple",
			);

			const status = session.getRateLimitStatus();
			assert.ok(status?.session, "expected a populated session window after the five_hour event");
			assert.equal(status?.session?.usedPercent, 42);
			assert.ok(status?.session?.resetsAtEpochSec !== null, "expected a non-null resetsAtEpochSec");
			assert.equal(status?.weekly, null, "expected weekly to stay null -- one window only, no fabricated sibling");
		} finally {
			unregisterApiProviders(sourceId);
			session.dispose();
		}
	});
});
