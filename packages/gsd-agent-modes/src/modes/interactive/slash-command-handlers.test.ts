// gsd-pi - Slash command tests for interactive TUI settings commands

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import stripAnsi from "strip-ansi";
import { Container, type Component } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import { dispatchSlashCommand, type SlashCommandContext } from "./slash-command-handlers.js";

initTheme("dark", false);

function makeContext(settingsManager = SettingsManager.inMemory()): SlashCommandContext {
	const statuses: string[] = [];
	const warnings: string[] = [];
	const renders: string[] = [];
	const blocks: Component[] = [];
	const alerts: Array<{ headline: string; details: readonly string[] }> = [];
	return {
		session: {} as never,
		ui: {} as never,
		keybindings: {} as never,
		chatContainer: new Container(),
		statusContainer: new Container(),
		editorContainer: new Container(),
		headerContainer: new Container(),
		pendingMessagesContainer: new Container(),
		editor: {} as never,
		defaultEditor: {} as never,
		sessionManager: {} as never,
		settingsManager,
		driverLiveness: {
			listAll: async () => ({ kind: "ok" as const, path: "/tmp/session-instances.json", drivers: [] }),
			dismissDied: () => 0,
		},
		appendChatBlock(component: Component) {
			blocks.push(component);
		},
		showDriverAlert(headline: string, details: readonly string[] = []) {
			alerts.push({ headline, details });
		},
		invalidateFooter() {},
		showStatus(message: string) {
			statuses.push(message);
		},
		showError(message: string) {
			throw new Error(message);
		},
		showWarning(message: string) {
			warnings.push(message);
		},
		showSelector() {},
		updateEditorBorderColor() {},
		getMarkdownThemeWithSettings: () => ({} as never),
		requestRender() {
			renders.push("render");
		},
		updateTerminalTitle() {},
		showSettingsSelector() {},
		showModelsSelector: async () => {},
		handleModelCommand: async () => {},
		showUserMessageSelector() {},
		showTreeSelector() {},
		showProviderManager() {},
		showOAuthSelector: async () => {},
		showSessionSelector() {},
		handleClearCommand: async () => {},
		handleReloadCommand: async () => {},
		handleDebugCommand() {},
		shutdown: async () => {},
		executeCompaction: async () => undefined,
		handleBashCommand: async () => {},
		_testStatuses: statuses,
		_testWarnings: warnings,
		_testRenders: renders,
		_testBlocks: blocks,
		_testAlerts: alerts,
	} as SlashCommandContext & {
		_testStatuses: string[];
		_testWarnings: string[];
		_testRenders: string[];
		_testBlocks: Component[];
		_testAlerts: Array<{ headline: string; details: readonly string[] }>;
	};
}

describe("dispatchSlashCommand /tui", () => {
	it("persists /tui mode validation to terminal adaptive mode", async () => {
		const settingsManager = SettingsManager.inMemory();
		const ctx = makeContext(settingsManager) as SlashCommandContext & {
			_testStatuses: string[];
			_testRenders: string[];
		};

		const handled = await dispatchSlashCommand("/tui mode validation", ctx);

		assert.equal(handled, true);
		assert.equal(settingsManager.getAdaptiveMode(), "validation");
		assert.deepEqual(ctx._testStatuses, ["TUI mode: validation"]);
		assert.equal(ctx._testRenders.length, 1);
	});

	it("rejects unknown TUI modes without changing settings", async () => {
		const settingsManager = SettingsManager.inMemory({ terminal: { adaptiveMode: "workflow" } });
		const ctx = makeContext(settingsManager) as SlashCommandContext & {
			_testWarnings: string[];
		};

		const handled = await dispatchSlashCommand("/tui mode poster", ctx);

		assert.equal(handled, true);
		assert.equal(settingsManager.getAdaptiveMode(), "workflow");
		assert.match(ctx._testWarnings[0], /Usage: \/tui mode/);
	});
});

describe("dispatchSlashCommand /drivers", () => {
	it("dispatchSlashCommand handles /drivers and prints the empty listing", async () => {
		const ctx = makeContext() as SlashCommandContext & { _testBlocks: Component[]; _testWarnings: string[] };

		const handled = await dispatchSlashCommand("/drivers", ctx);

		assert.equal(handled, true);
		assert.equal(ctx._testBlocks.length, 1);
		const text = stripAnsi(ctx._testBlocks[0].render(120).join("\n"));
		assert.ok(text.includes("Drivers \u00b7 this machine (0)"), text);
		assert.ok(text.includes("No drivers registered. Nothing to stop."), text);
		assert.deepEqual(ctx._testWarnings, []);
	});
});
