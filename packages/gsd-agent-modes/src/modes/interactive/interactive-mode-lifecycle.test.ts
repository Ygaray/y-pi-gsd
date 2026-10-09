// gsd-pi + packages/pi-coding-agent/src/modes/interactive/interactive-mode-lifecycle.test.ts - InteractiveMode lifecycle regression coverage.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InteractiveMode } from "./interactive-mode.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

initTheme("dark", false);

type RuntimeInteractiveMode = {
	[key: string]: unknown;
	stop(): void;
	_themeChangeUnsub?: () => void;
	_rateLimitChangeUnsub?: () => void;
	subscribeToRateLimitStatus(): void;
	getMarkdownThemeWithSettings(): unknown;
};

describe("InteractiveMode lifecycle", () => {
	it("calls and clears the theme-change unsubscriber on stop", () => {
		const mode = Object.create(InteractiveMode.prototype) as RuntimeInteractiveMode;
		let unsubscribeCount = 0;

		mode.loadingAnimation = undefined;
		mode.extensionTerminalInputUnsubscribers = new Set();
		mode.clearExtensionTerminalInputListeners = () => {};
		mode._branchChangeUnsub = undefined;
		mode._themeChangeUnsub = () => {
			unsubscribeCount++;
		};
		mode.onInputCallback = undefined;
		mode.clearExtensionWidgets = () => {};
		mode.customFooter = undefined;
		mode.customHeader = undefined;
		mode.footer = { dispose() {} };
		mode.footerDataProvider = { dispose() {} };
		mode.unsubscribe = undefined;
		mode.isInitialized = false;

		mode.stop();

		assert.equal(unsubscribeCount, 1);
		assert.equal(mode._themeChangeUnsub, undefined);
	});

	it("subscribeToRateLimitStatus requests a render on every rate-limit change", () => {
		const mode = Object.create(InteractiveMode.prototype) as RuntimeInteractiveMode;
		let captured: (() => void) | undefined;
		let unsubCount = 0;
		let renders = 0;
		mode.session = {
			onRateLimitStatusChange(cb: () => void) {
				captured = cb;
				return () => {
					unsubCount++;
				};
			},
		};
		mode.ui = {
			requestRender() {
				renders++;
			},
		};

		mode.subscribeToRateLimitStatus();
		assert.equal(typeof mode._rateLimitChangeUnsub, "function");
		captured?.();
		captured?.();
		assert.equal(renders, 2);
		assert.equal(unsubCount, 0);

		mode.subscribeToRateLimitStatus();
		assert.equal(unsubCount, 1, "a re-subscribe releases the previous subscription first");
	});

	it("calls and clears the rate-limit change unsubscriber on stop", () => {
		const mode = Object.create(InteractiveMode.prototype) as RuntimeInteractiveMode;
		let unsubscribeCount = 0;

		mode.loadingAnimation = undefined;
		mode.extensionTerminalInputUnsubscribers = new Set();
		mode.clearExtensionTerminalInputListeners = () => {};
		mode._branchChangeUnsub = undefined;
		mode._themeChangeUnsub = undefined;
		mode._rateLimitChangeUnsub = () => {
			unsubscribeCount++;
		};
		mode.onInputCallback = undefined;
		mode.clearExtensionWidgets = () => {};
		mode.customFooter = undefined;
		mode.customHeader = undefined;
		mode.footer = { dispose() {} };
		mode.footerDataProvider = { dispose() {} };
		mode.unsubscribe = undefined;
		mode.isInitialized = false;

		mode.stop();

		assert.equal(unsubscribeCount, 1);
		assert.equal(mode._rateLimitChangeUnsub, undefined);
	});

	it("stop disposes the driver liveness widget", () => {
		const mode = Object.create(InteractiveMode.prototype) as RuntimeInteractiveMode;
		let disposeCount = 0;
		let monitorDisposeCount = 0;

		mode.loadingAnimation = undefined;
		mode.extensionTerminalInputUnsubscribers = new Set();
		mode.clearExtensionTerminalInputListeners = () => {};
		mode._branchChangeUnsub = undefined;
		mode._themeChangeUnsub = undefined;
		mode.onInputCallback = undefined;
		mode.clearExtensionWidgets = () => {};
		mode.customFooter = undefined;
		mode.customHeader = undefined;
		mode.footer = { dispose() {} };
		mode.driverLivenessWidget = {
			dispose() {
				disposeCount++;
			},
		};
		mode.driverLivenessMonitor = {
			dispose() {
				monitorDisposeCount++;
			},
		};
		mode.footerDataProvider = { dispose() {} };
		mode.unsubscribe = undefined;
		mode.isInitialized = false;

		mode.stop();

		assert.equal(disposeCount, 1);
		assert.equal(monitorDisposeCount, 1, "the monitor is disposed so a late refresh cannot alert a stopped TUI");
	});

	it("getDriverControl returns the injected port and undefined by default", () => {
		const fake = { stopDriver: async () => ({ outcome: "stopped" }) };
		const withPort = Object.create(InteractiveMode.prototype) as RuntimeInteractiveMode;
		withPort.options = { driverControl: fake };
		assert.equal((withPort as unknown as InteractiveMode).getDriverControl(), fake);

		const without = Object.create(InteractiveMode.prototype) as RuntimeInteractiveMode;
		without.options = {};
		assert.equal((without as unknown as InteractiveMode).getDriverControl(), undefined);
	});

	it("caches markdown theme settings until the code block indent changes", () => {
		const mode = Object.create(InteractiveMode.prototype) as RuntimeInteractiveMode;
		let codeBlockIndent = "  ";
		mode.session = {
			settingsManager: {
				getCodeBlockIndent: () => codeBlockIndent,
			},
		};

		const first = mode.getMarkdownThemeWithSettings();
		assert.equal(mode.getMarkdownThemeWithSettings(), first);

		codeBlockIndent = "    ";
		const updated = mode.getMarkdownThemeWithSettings() as { codeBlockIndent: string };

		assert.notEqual(updated, first);
		assert.equal(updated.codeBlockIndent, "    ");
		assert.equal(mode.getMarkdownThemeWithSettings(), updated);
	});
});
