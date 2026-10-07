import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@gsd/pi-agent-core";
import { clampThinkingLevel, type Message, type Model, type SimpleStreamOptions, streamSimple } from "@gsd/pi-ai";
import { getAgentDir } from "@gsd/pi-coding-agent/config.js";
import { resolvePath } from "@gsd/pi-coding-agent/utils/paths.js";
import { AgentSession } from "./agent-session.js";
import { parseAnthropicRateLimitHeaders, type RateLimitStatus, type RateLimitWindow } from "./rate-limit-headers.js";
import { formatNoModelsAvailableMessage } from "@gsd/pi-coding-agent/core/auth-guidance.js";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "@gsd/pi-coding-agent/core/defaults.js";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "@gsd/pi-coding-agent/core/extensions/index.js";
import { convertToLlm } from "@gsd/pi-coding-agent/core/messages.js";
import { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { findInitialModel } from "@gsd/pi-coding-agent/core/model-resolver.js";
import type { ResourceLoader } from "@gsd/pi-coding-agent/core/resource-loader.js";
import { DefaultResourceLoader } from "@gsd/pi-coding-agent/core/resource-loader.js";
import { getDefaultSessionDir, SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import { isInstallTelemetryEnabled } from "@gsd/pi-coding-agent/core/telemetry.js";
import { time } from "@gsd/pi-coding-agent/core/timings.js";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "@gsd/pi-coding-agent/core/tools/index.js";

/**
 * T-28-08: guards the `GSD_DEBUG_RATELIMIT_HEADERS` one-shot capture (see `onResponse` below) so
 * it fires at most once per process, even across multiple sessions/turns.
 */
let hasCapturedDebugRateLimitHeaders = false;

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	agentDir?: string;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, pi enables the default built-in tools (read, bash, edit, write)
	 * and leaves extension/custom tools enabled unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Additional tool names to enable beyond the default allowlist. */
	extraActiveToolNames?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.js";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "@gsd/pi-coding-agent/core/extensions/index.js";
export type { PromptTemplate } from "@gsd/pi-coding-agent/core/prompt-templates.js";
export type { Skill } from "@gsd/pi-coding-agent/core/skills.js";
export type { Tool } from "@gsd/pi-coding-agent/core/tools/index.js";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

function getAttributionHeaders(
	model: Model<any>,
	settingsManager: SettingsManager,
	sessionId?: string,
): Record<string, string> | undefined {
	const hasHostname = (expected: string): boolean => {
		try {
			return new URL(model.baseUrl).hostname === expected;
		} catch {
			return false;
		}
	};

	if (
		sessionId &&
		(model.provider === "opencode" || model.provider === "opencode-go" || hasHostname("opencode.ai"))
	) {
		return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
	}

	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (model.provider === "openrouter" || hasHostname("openrouter.ai")) {
		return {
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "pi",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		hasHostname("api.cloudflare.com") ||
		hasHostname("gateway.ai.cloudflare.com")
	) {
		return {
			"User-Agent": "pi-coding-agent",
		};
	}

	return undefined;
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@gsd/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const initialActiveToolNames: string[] = options.tools
		? [...options.tools]
		: options.noTools
			? []
			: defaultActiveToolNames;
	if (options.extraActiveToolNames?.length) {
		for (const name of options.extraActiveToolNames) {
			if (!initialActiveToolNames.includes(name)) {
				initialActiveToolNames.push(name);
			}
		}
	}

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const rateLimitStatusRef: { current?: RateLimitStatus; provider?: string } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const attributionHeaders = getAttributionHeaders(model, settingsManager, options?.sessionId);
			const headers =
				attributionHeaders || auth.headers || options?.headers
					? { ...attributionHeaders, ...auth.headers, ...options?.headers }
					: undefined;
			const requestModel = auth.headers ? { ...model, headers: { ...model.headers, ...auth.headers } } : model;
			// D-04 (38-CONTEXT.md): thread the rate_limit_event sink through a named options
			// const rather than an inline object literal passed directly to streamSimple --
			// TypeScript's excess-property check fires on a fresh object literal argument even
			// when it contains a spread (38-RESEARCH.md Pitfall A). Provider-gated: a non-
			// claude-code model never receives this callback, so the direct-API header path in
			// onResponse below is completely untouched (Pitfall 13).
			const streamOptions: SimpleStreamOptions & {
				onRateLimitEvent?: (window: RateLimitWindow, windowKey: "session" | "weekly") => void;
			} = {
				...options,
				apiKey: auth.apiKey,
				timeoutMs: options?.timeoutMs ?? providerRetrySettings.timeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				headers,
				onRateLimitEvent:
					model.provider === "claude-code"
						? (window, windowKey) => {
								// Mirrors onResponse's WR-01 per-window merge below exactly: the
								// previous reading is only eligible to fill the sibling window's
								// gap when it came from the *same* provider (CR-03) -- a provider
								// switch must never let a stale window leak through the merge.
								const previous =
									rateLimitStatusRef.provider === model.provider ? rateLimitStatusRef.current : undefined;
								rateLimitStatusRef.current = {
									session: windowKey === "session" ? window : (previous?.session ?? null),
									weekly: windowKey === "weekly" ? window : (previous?.weekly ?? null),
								};
								rateLimitStatusRef.provider = model.provider;
							}
						: undefined,
			};
			return streamSimple(requestModel, context, streamOptions);
		},
		onPayload: async (payload, model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			// Thread the resolved model into the event so extensions can gate on
			// provider/api (e.g. native web_search injection). Without this the
			// before_provider_request event carries no model and provider-shape
			// detection silently fails.
			return runner.emitBeforeProviderRequest(payload, model);
		},
		onResponse: async (response, model) => {
			const parsedRateLimitStatus = parseAnthropicRateLimitHeaders(response.headers);
			if (parsedRateLimitStatus) {
				// WR-01: a `null` field on `parsedRateLimitStatus` only means "this response's headers
				// didn't carry that window" (e.g. a weekly figure resent less often than every turn) —
				// it must not blank out a still-valid previously-known value for that window. Merge
				// per-window instead of replacing the whole struct. The previous reading is only
				// eligible to fill a gap when it came from the *same* provider (CR-03) — a provider
				// switch must never let a stale window leak through the merge.
				const previous = rateLimitStatusRef.provider === model.provider ? rateLimitStatusRef.current : undefined;
				rateLimitStatusRef.current = {
					session: parsedRateLimitStatus.session ?? previous?.session ?? null,
					weekly: parsedRateLimitStatus.weekly ?? previous?.weekly ?? null,
				};
				rateLimitStatusRef.provider = model.provider;
			}

			// A-28-02 / T-28-08: a one-shot, prefix-allowlisted capture of the real
			// `anthropic-ratelimit-*`/`anthropic-fast-*` header names, gated behind an explicit
			// env var and fired at most once per process. Never dumps the whole header record --
			// it also carries request ids and other provider metadata that has no business in an
			// operator's terminal.
			if (process.env.GSD_DEBUG_RATELIMIT_HEADERS === "1" && !hasCapturedDebugRateLimitHeaders) {
				hasCapturedDebugRateLimitHeaders = true;
				const captured = Object.entries(response.headers).filter(([key]) => {
					const lower = key.toLowerCase();
					return lower.startsWith("anthropic-ratelimit") || lower.startsWith("anthropic-fast");
				});
				if (captured.length > 0) {
					console.error("[GSD_DEBUG_RATELIMIT_HEADERS] captured headers:", Object.fromEntries(captured));
				}
			}

			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		cacheRetention: settingsManager.getCacheRetention(),
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		initialActiveToolNames,
		allowedToolNames,
		extensionRunnerRef,
		rateLimitStatusRef,
		sessionStartEvent: options.sessionStartEvent,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
