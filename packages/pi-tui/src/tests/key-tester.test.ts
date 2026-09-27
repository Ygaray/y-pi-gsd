import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, type Plugin } from "esbuild";

type RuntimeState = {
	children: Array<{ handleInput(data: string): void; render(width: number): string[] }>;
	requestRenderCount: number;
	started: boolean;
};

const root = process.cwd();

async function importKeyTester(): Promise<RuntimeState> {
	const cacheDir = join(root, ".cache");
	await mkdir(cacheDir, { recursive: true });
	const outdir = await mkdtemp(join(cacheDir, "pi-tui-key-tester-"));
	const outfile = join(outdir, "entry.mjs");
	const plugin: Plugin = {
		name: "key-tester-stubs",
		setup(buildApi) {
			buildApi.onResolve({ filter: /^\.\.\/src\/(?:keys|terminal|tui)\.ts$/ }, (args) => ({
				path: args.path,
				namespace: "key-tester-stub",
			}));
			buildApi.onLoad({ filter: /.*/, namespace: "key-tester-stub" }, (args) => {
				const stubs: Record<string, string> = {
					"../src/keys.ts": `
						export function matchesKey(data, key) {
							return key === "ctrl+c" && data === "\\u0003";
						}
					`,
					"../src/terminal.ts": `
						export class ProcessTerminal {}
					`,
					"../src/tui.ts": `
						globalThis.__keyTesterState = { children: [], requestRenderCount: 0, started: false };
						export class TUI {
							constructor(terminal) { this.terminal = terminal; }
							addChild(child) { globalThis.__keyTesterState.children.push(child); }
							setFocus(child) { globalThis.__keyTesterState.focus = child; }
							requestRender() { globalThis.__keyTesterState.requestRenderCount += 1; }
							start() { globalThis.__keyTesterState.started = true; }
							stop() { globalThis.__keyTesterState.stopped = true; }
						}
					`,
				};
				return { contents: stubs[args.path], loader: "js", resolveDir: root };
			});
		},
	};
	await build({
		entryPoints: [join(root, "packages/pi-tui/test/key-tester.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		plugins: [plugin],
	});
	const previousExit = process.exit;
	const sigintListenersBefore = process.listeners("SIGINT");
	process.exit = (() => undefined) as typeof process.exit;
	try {
		await import(pathToFileURL(outfile).href);
	} finally {
		process.exit = previousExit;
		for (const listener of process.listeners("SIGINT")) {
			if (!sigintListenersBefore.includes(listener)) {
				process.removeListener("SIGINT", listener);
			}
		}
	}
	return (globalThis as typeof globalThis & { __keyTesterState: RuntimeState }).__keyTesterState;
}

test("key tester starts a TUI logger that records key bytes", async () => {
	const state = await importKeyTester();
	assert.equal(state.started, true);
	assert.equal(state.children.length, 1);

	const logger = state.children[0]!;
	assert.match(logger.render(72).join("\n"), /Key Code Tester - Press keys to see their codes/);

	logger.handleInput("A");
	assert.equal(state.requestRenderCount, 1);
	assert.match(logger.render(72).join("\n"), /Hex: 41/);
	assert.match(logger.render(72).join("\n"), /Chars: \[65/);
	assert.match(logger.render(72).join("\n"), /Repr: "A"/);
});
