import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	injectAlertBotSessionContext,
	resolveAlertBotSessionContext,
} from "../stream-adapter.ts";

function withProject(fn: (root: string) => void): void {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "alert-ctx-")));
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("resolveAlertBotSessionContext", () => {
	test("interactive chat with a UI and no auto run is attended", () => {
		withProject((root) => {
			const ctx = resolveAlertBotSessionContext(root, true, {
				env: {},
				autoActive: () => false,
				autoRoots: () => [undefined, undefined],
				alertBotEnabled: () => true,
			});
			assert.deepEqual(ctx, { unattended: false, project: basename(root), enabled: true });
		});
	});

	test("auto-mode on this project is unattended even with a UI, and names the original root", () => {
		withProject((root) => {
			const ctx = resolveAlertBotSessionContext(root, true, {
				env: {},
				autoActive: () => true,
				autoRoots: () => [root, join(root, ".gsd", "worktrees", "M001")],
				alertBotEnabled: () => true,
			});
			assert.equal(ctx.unattended, true);
			assert.equal(ctx.project, basename(root));
		});
	});

	test("auto-mode on a different project does not mark this one unattended", () => {
		withProject((root) => {
			withProject((other) => {
				const ctx = resolveAlertBotSessionContext(root, true, {
					env: {},
					autoActive: () => true,
					autoRoots: () => [other, other],
					alertBotEnabled: () => true,
				});
				assert.equal(ctx.unattended, false);
			});
		});
	});

	test("headless (GSD_HEADLESS=1) or no UI is unattended", () => {
		withProject((root) => {
			const deps = { autoActive: () => false, autoRoots: () => [], alertBotEnabled: () => true };
			assert.equal(resolveAlertBotSessionContext(root, true, { ...deps, env: { GSD_HEADLESS: "1" } }).unattended, true);
			assert.equal(resolveAlertBotSessionContext(root, false, { ...deps, env: {} }).unattended, true);
		});
	});

	test("carries the alert_bot opt-out and survives throwing state readers", () => {
		withProject((root) => {
			const ctx = resolveAlertBotSessionContext(root, false, {
				env: {},
				autoActive: () => { throw new Error("boom"); },
				alertBotEnabled: () => false,
			});
			assert.deepEqual(ctx, { unattended: true, project: basename(root), enabled: false });
		});
	});
});

describe("injectAlertBotSessionContext", () => {
	const base = () => ({
		mcpServers: {
			"gsd-workflow": { command: "node", args: ["cli.js"], env: { KEEP: "1", GSD_UNATTENDED: "1", GSD_ALERT_BOT: "0" } },
			other: { command: "x" },
		},
	});

	test("writes unattended + project on the workflow server only", () => {
		const opts: Record<string, unknown> = base();
		injectAlertBotSessionContext(opts, "gsd-workflow", { unattended: true, project: "app", enabled: true });
		const servers = opts.mcpServers as Record<string, { env?: Record<string, string> }>;
		assert.deepEqual(servers["gsd-workflow"].env, { KEEP: "1", GSD_UNATTENDED: "1", GSD_ALERT_PROJECT: "app" });
		assert.equal(servers.other.env, undefined);
	});

	test("clears a stale unattended flag from a previous query and records the opt-out", () => {
		const opts: Record<string, unknown> = base();
		injectAlertBotSessionContext(opts, "gsd-workflow", { unattended: false, project: "app", enabled: false });
		const env = (opts.mcpServers as Record<string, { env: Record<string, string> }>)["gsd-workflow"].env;
		assert.equal(env.GSD_UNATTENDED, undefined);
		assert.equal(env.GSD_ALERT_BOT, "0");
	});

	test("is a no-op without a workflow server", () => {
		const opts: Record<string, unknown> = base();
		injectAlertBotSessionContext(opts, undefined, { unattended: true, project: "app", enabled: true });
		assert.deepEqual(opts, base());
	});
});
