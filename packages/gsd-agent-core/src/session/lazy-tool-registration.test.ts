import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AgentSessionExtensionsModule } from "./agent-session-extensions.ts";
import { createSyntheticSourceInfo } from "@gsd/pi-coding-agent/core/source-info.js";
import { createAllToolDefinitions } from "@gsd/pi-coding-agent/core/tools/index.js";

// ---------------------------------------------------------------------------
// Regression coverage for the second, independent defect 08-05 found: a tool
// registered LAZILY from inside an extension's `session_start` handler (the
// pattern `browser-tools/index.ts` uses, because it needs `ctx` to resolve
// the project's browser engine) never reaches the session's active tool set,
// because `refreshToolRegistry()`'s "newly registered tool names" comparison
// set is computed AFTER the registry has already been rebuilt to include the
// new tool -- making the incremental-activation branch a permanent no-op.
//
// Modelled on `tool-definition-cache.test.ts`'s `makeHost()` fake-host
// harness (kept module-local here, matching that file's own pattern).
// ---------------------------------------------------------------------------

/**
 * Build a minimal host that satisfies the AgentSessionHost surface needed by
 * refreshToolRegistry() / setActiveToolsByName() without touching the real
 * agent, session-manager, or provider layers.
 */
function makeLazyRegistrationHost(cwd = "/tmp/lazy-registration-project", allowedToolNames?: string[]) {
	const agentStateTools: Array<{ name: string }> = [];
	const systemPromptChunks: string[] = [];

	const baseTools = createAllToolDefinitions(cwd);
	const baseToolDefinitions = new Map(
		Object.entries(baseTools).map(([name, tool]) => [name, tool as any]),
	);

	const host = {
		_cwd: cwd,
		_allowedToolNames: allowedToolNames ? new Set(allowedToolNames) : undefined,
		_customTools: [] as any[],
		_baseToolsOverride: undefined as Record<string, any> | undefined,
		_baseToolDefinitions: baseToolDefinitions,
		_extensionRunner: {
			getAllRegisteredTools: () => [] as any[],
			hasHandlers: () => false,
			getFlagValues: () => new Map(),
			createContext: () => ({}),
		} as any,
		agent: {
			state: {
				get tools() {
					return agentStateTools;
				},
				set tools(val: Array<{ name: string }>) {
					agentStateTools.length = 0;
					agentStateTools.push(...val);
				},
				get systemPrompt() {
					return systemPromptChunks[systemPromptChunks.length - 1] ?? "";
				},
				set systemPrompt(val: string) {
					systemPromptChunks.push(val);
				},
			},
		},
		getActiveToolNames: () => agentStateTools.map((t) => t.name),
		setActiveToolsByName: (toolNames: string[]) => {
			agentStateTools.length = 0;
			for (const name of toolNames) {
				const tool = host._toolRegistry.get(name);
				if (tool) agentStateTools.push({ name: tool.name });
			}
		},
		_toolRegistry: new Map() as Map<string, any>,
		_toolDefinitions: new Map() as Map<string, any>,
		_toolPromptSnippets: new Map() as Map<string, string>,
		_toolPromptGuidelines: new Map() as Map<string, string[]>,
		_visibleSkillNames: [] as string[],
		resourceLoader: {
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			getSkills: () => ({ skills: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
		},
	} as any;

	return host;
}

/**
 * Simulate a `pi.registerTool()` call landing mid-session (the shape a
 * `session_start` handler uses, e.g. browser-tools registering once it has
 * resolved `ctx`). Mutates the fake host's `_extensionRunner.getAllRegisteredTools`
 * to append a new fake tool on top of whatever was already registered.
 */
function registerFakeExtensionTool(host: any, name: string): void {
	const existing = host._extensionRunner.getAllRegisteredTools();
	const fakeTool = {
		definition: {
			name,
			description: `fake lazily-registered extension tool: ${name}`,
			parameters: {},
			promptSnippet: undefined,
			promptGuidelines: undefined,
			execute: async () => {},
		},
		sourceInfo: createSyntheticSourceInfo(`<test-ext:${name}>`, { source: "extension" }),
	};
	const updated = [...existing, fakeTool];
	host._extensionRunner.getAllRegisteredTools = () => updated;
}

describe("Lazy tool registration reaches the active tool set", () => {
	test("1. a tool registered lazily inside session_start, via a bare refreshTools() call, becomes active", () => {
		const host = makeLazyRegistrationHost();
		const mod = new AgentSessionExtensionsModule(host);

		// Stand in for the constructor's one-time sweep (AgentSession's
		// buildRuntime({ includeAllExtensionTools: true }) call, before any
		// extension has loaded).
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });

		// Stand in for pi.registerTool() firing inside a session_start handler,
		// after ctx became available (the browser-tools shape).
		registerFakeExtensionTool(host, "browser_navigate");

		// The exact zero-option call actions.refreshTools makes:
		// `refreshTools: () => this.refreshToolRegistry()`.
		mod.refreshToolRegistry();

		assert.ok(
			host.getActiveToolNames().includes("browser_navigate"),
			`expected active tool names to include "browser_navigate" after a lazy pi.registerTool() + bare refreshTools() call, got: ${JSON.stringify(host.getActiveToolNames())}`,
		);
	});

	test("2. successive lazy registrations both become active, with no duplicate entries", () => {
		const host = makeLazyRegistrationHost();
		const mod = new AgentSessionExtensionsModule(host);

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });

		registerFakeExtensionTool(host, "browser_navigate");
		mod.refreshToolRegistry();

		registerFakeExtensionTool(host, "browser_screenshot");
		mod.refreshToolRegistry();

		const active = host.getActiveToolNames();
		assert.ok(active.includes("browser_navigate"), `expected "browser_navigate" active, got: ${JSON.stringify(active)}`);
		assert.ok(active.includes("browser_screenshot"), `expected "browser_screenshot" active, got: ${JSON.stringify(active)}`);
		assert.strictEqual(active.length, new Set(active).size, "active tool name list must contain no duplicates");
	});

	test("3. activation-time registration (the async-jobs shape) is unaffected", () => {
		const host = makeLazyRegistrationHost();

		// The async-jobs shape: the tool is already registered BEFORE any
		// refresh runs (top-level pi.registerTool() calls at extension
		// activation time), well before AgentSession's constructor sweep.
		registerFakeExtensionTool(host, "async_job_status");

		const mod = new AgentSessionExtensionsModule(host);
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });

		assert.ok(
			host.getActiveToolNames().includes("async_job_status"),
			`expected "async_job_status" active after the one-time full sweep, got: ${JSON.stringify(host.getActiveToolNames())}`,
		);
	});

	test("4. allowedToolNames still governs which lazily-registered tools become active", () => {
		const host = makeLazyRegistrationHost("/tmp/lazy-registration-project", [
			"read",
			"bash",
			"browser_navigate",
		]);
		const mod = new AgentSessionExtensionsModule(host);

		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"], includeAllExtensionTools: true });

		registerFakeExtensionTool(host, "browser_navigate"); // allowlisted
		registerFakeExtensionTool(host, "browser_screenshot"); // NOT allowlisted
		mod.refreshToolRegistry();

		const active = host.getActiveToolNames();
		assert.ok(active.includes("browser_navigate"), `expected allowlisted "browser_navigate" active, got: ${JSON.stringify(active)}`);
		assert.ok(!active.includes("browser_screenshot"), `expected non-allowlisted "browser_screenshot" to stay inactive, got: ${JSON.stringify(active)}`);
	});

	test("5. the cache-hit early return stays stable, and a first-ever bare call never sweeps in every builtin", () => {
		// First-call safety net: a truly first-ever zero-option call, made
		// before any options-carrying call has established a baseline, must
		// NOT silently activate every builtin tool.
		const freshHost = makeLazyRegistrationHost();
		const freshMod = new AgentSessionExtensionsModule(freshHost);
		freshMod.refreshToolRegistry();
		assert.deepStrictEqual(
			freshHost.getActiveToolNames(),
			[],
			`a bare refreshTools() call with no prior baseline must not activate every builtin, got: ${JSON.stringify(freshHost.getActiveToolNames())}`,
		);

		// The cache-hit fast path: with a stable tool set (nothing newly
		// registered), repeated bare calls must not grow or reorder the
		// active set.
		const host = makeLazyRegistrationHost();
		const mod = new AgentSessionExtensionsModule(host);
		mod.refreshToolRegistry({ activeToolNames: ["read", "bash"] });

		mod.refreshToolRegistry();
		const first = [...host.getActiveToolNames()];
		mod.refreshToolRegistry();
		const second = [...host.getActiveToolNames()];

		assert.deepStrictEqual(
			second,
			first,
			`active tool name list must be byte-identical across repeated no-option calls, got first=${JSON.stringify(first)} second=${JSON.stringify(second)}`,
		);
	});
});
