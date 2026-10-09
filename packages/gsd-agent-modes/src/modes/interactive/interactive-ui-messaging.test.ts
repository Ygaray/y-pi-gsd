// Project/App: gsd-pi
// File Purpose: Tests for the non-blocking driver alert helper (Phase 42, D-02 / UI-SPEC U8).

import assert from "node:assert/strict";
import test from "node:test";
import stripAnsi from "strip-ansi";
import { Container } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { showNonBlockingAlert } from "./interactive-ui-messaging.js";

initTheme("dark", false);

test("showNonBlockingAlert appends an error-toned block without an Error prefix and never sets lastBlockingError", () => {
	let renders = 0;
	const host = {
		chatContainer: new Container(),
		lastBlockingError: undefined as string | undefined,
		ui: {
			requestRender() {
				renders++;
			},
		},
	} as any;

	showNonBlockingAlert(host, "✕ Driver died: boom", ["  pid 4242 · project p · /drivers for details"]);

	assert.equal(host.chatContainer.children.length, 2);
	const rendered = host.chatContainer.children.flatMap((c: { render(w: number): string[] }) => c.render(80));
	const raw = rendered.join("\n");
	const plain = stripAnsi(raw);
	assert.ok(plain.includes("✕ Driver died: boom"), plain);
	assert.ok(plain.includes("pid 4242 · project p"), plain);
	assert.ok(!plain.includes("Error:"), plain);
	assert.equal(host.lastBlockingError, undefined);
	assert.equal(renders, 1);
	assert.ok(!raw.includes("\x07"), "no BEL");
	assert.ok(!raw.includes("\x1b]"), "no OSC");
});
