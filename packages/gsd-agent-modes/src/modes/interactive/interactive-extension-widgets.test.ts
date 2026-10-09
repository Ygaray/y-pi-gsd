import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import { Container } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { SessionRegistry, SessionRegistryEntry } from "@opengsd/contracts";
import { renderWidgets, setExtensionWidget } from "./interactive-extension-widgets.js";
import { DriverLivenessMonitor } from "./components/gsd-driver-liveness-monitor.js";
import { DriverLivenessWidget } from "./components/gsd-driver-liveness-widget.js";

function createWidgetHost() {
	const renderCalls: Array<true | undefined> = [];
	return {
		host: {
			extensionWidgetsAbove: new Map(),
			extensionWidgetsBelow: new Map(),
			// Leave widget containers undefined so renderWidgets() returns early,
			// isolating only the gsd-outcome force-render path under test.
			widgetContainerAbove: undefined,
			widgetContainerBelow: undefined,
			pinnedMessageContainer: { children: [] },
			ui: {
				requestRender(force?: boolean) {
					if (force) renderCalls.push(true);
				},
			},
		} as any,
		renderCalls,
	};
}

test("setExtensionWidget: forces viewport realign when key is gsd-outcome", () => {
	initTheme("dark", false);
	const { host, renderCalls } = createWidgetHost();
	setExtensionWidget(host, "gsd-outcome", ["Step complete"]);
	assert.equal(renderCalls.length, 1, "requestRender(true) should be called once for gsd-outcome");
});

test("setExtensionWidget: does not force viewport realign for non-gsd-outcome keys", () => {
	initTheme("dark", false);
	const { host, renderCalls } = createWidgetHost();
	setExtensionWidget(host, "gsd-other", ["Working..."]);
	assert.equal(renderCalls.length, 0, "requestRender(true) should not be called for non-gsd-outcome keys");
});

test("setExtensionWidget: does not force viewport realign when removing a widget (content undefined)", () => {
	initTheme("dark", false);
	const { host, renderCalls } = createWidgetHost();
	setExtensionWidget(host, "gsd-outcome", undefined);
	assert.equal(renderCalls.length, 0, "requestRender(true) should not be called when content is undefined");
});

function createMountHost(extra: Record<string, unknown>) {
	return {
		extensionWidgetsAbove: new Map<string, unknown>(),
		extensionWidgetsBelow: new Map<string, unknown>(),
		widgetContainerAbove: new Container(),
		widgetContainerBelow: new Container(),
		pinnedMessageContainer: { children: [] },
		ui: { requestRender() {} },
		...extra,
	} as any;
}

test("renderWidgets mounts the driver liveness widget right after the GSD status widget", () => {
	initTheme("dark", false);
	const status = { render: () => ["status"], invalidate() {} };
	const driver = { render: () => ["driver"], invalidate() {} };
	const extension = { render: () => ["extension"], invalidate() {} };
	const host = createMountHost({ gsdStatusWidget: status, driverLivenessWidget: driver });
	host.extensionWidgetsAbove.set("ext", extension);

	renderWidgets(host);

	const children = host.widgetContainerAbove.children;
	assert.equal(children.length, 4);
	assert.equal(children[1], status);
	assert.equal(children[2], driver);
	assert.equal(children[3], extension);

	// Re-parenting on every call keeps the same order (no duplicates).
	renderWidgets(host);
	assert.deepEqual(host.widgetContainerAbove.children.slice(1), [status, driver, extension]);
});

test("OBS-01 a mounted driver widget renders a running line from a temp registry through renderWidgets", async () => {
	initTheme("dark", false);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-driver-mount-")));
	try {
		const registryPath = join(root, "session-instances.json");
		const now = Date.parse("2026-10-08T12:00:00.000Z");
		const row: SessionRegistryEntry = {
			sessionId: "9f3c0a1e",
			projectDir: root,
			pid: 4242,
			ownerPid: 4100,
			startTime: new Date(now - 12 * 60_000).toISOString(),
			status: "running",
		};
		const registry: SessionRegistry = { [root]: row };
		writeFileSync(registryPath, JSON.stringify(registry, null, 2));
		const alive = new Set([4242, 4100]);
		const monitor = new DriverLivenessMonitor({
			projectRoot: root,
			registryPath,
			now: () => now,
			probes: {
				isPidAlive: (pid) => alive.has(pid),
				isOwnerAlive: (pid) => alive.has(pid),
				getStartTimeMs: () => null,
				async prefetchStartTimes() {},
			},
		});
		const widget = new DriverLivenessWidget(monitor);
		await monitor.refresh();

		const host = createMountHost({ driverLivenessWidget: widget });
		renderWidgets(host);

		const lines = host.widgetContainerAbove.render(100).map((l: string) => stripAnsi(l));
		assert.ok(
			lines.some((l: string) => l.startsWith("● DRIVER running · pid 4242")),
			JSON.stringify(lines),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
