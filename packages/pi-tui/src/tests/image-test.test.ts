import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, type Plugin } from "esbuild";

type RuntimeState = {
	children: Array<{ kind: string; text?: string; data?: string; dims?: { width: number; height: number } }>;
	focus?: { handleInput(data: string): void };
	started: boolean;
	stopped: boolean;
};

const root = process.cwd();

async function importImageTest(imagePath: string): Promise<RuntimeState> {
	const cacheDir = join(root, ".cache");
	await mkdir(cacheDir, { recursive: true });
	const outdir = await mkdtemp(join(cacheDir, "pi-tui-image-test-"));
	const outfile = join(outdir, "entry.mjs");
	const plugin: Plugin = {
		name: "image-test-stubs",
		setup(buildApi) {
			buildApi.onResolve(
				{
					filter:
						/^\.\.\/src\/(?:terminal|terminal-image|tui)\.ts$|^\.\.\/src\/components\/(?:image|spacer|text)\.ts$/,
				},
				(args) => ({ path: args.path, namespace: "image-test-stub" }),
			);
			buildApi.onLoad({ filter: /.*/, namespace: "image-test-stub" }, (args) => {
				const stubs: Record<string, string> = {
					"../src/components/image.ts": `
						export class Image {
							constructor(data, mimeType, colors, options, dims) {
								this.kind = "image";
								this.data = data;
								this.mimeType = mimeType;
								this.options = options;
								this.dims = dims;
							}
						}
					`,
					"../src/components/spacer.ts": `
						export class Spacer {
							constructor(lines) {
								this.kind = "spacer";
								this.lines = lines;
							}
						}
					`,
					"../src/components/text.ts": `
						export class Text {
							constructor(text) {
								this.kind = "text";
								this.text = text;
							}
						}
					`,
					"../src/terminal-image.ts": `
						export function getCapabilities() { return { inlineImages: true }; }
						export function getImageDimensions() { return { width: 2, height: 1 }; }
					`,
					"../src/terminal.ts": `
						export class ProcessTerminal {}
					`,
					"../src/tui.ts": `
						globalThis.__imageTestState = { children: [], started: false, stopped: false };
						export class TUI {
							constructor(terminal) {
								this.terminal = terminal;
								this.children = globalThis.__imageTestState.children;
							}
							addChild(child) { this.children.push(child); }
							setFocus(child) { globalThis.__imageTestState.focus = child; }
							start() { globalThis.__imageTestState.started = true; }
							stop() { globalThis.__imageTestState.stopped = true; }
						}
					`,
				};
				return { contents: stubs[args.path], loader: "js", resolveDir: root };
			});
		},
	};
	await build({
		entryPoints: [join(root, "packages/pi-tui/test/image-test.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		plugins: [plugin],
	});
	const originalArgv = process.argv;
	process.argv = [process.argv[0]!, process.argv[1]!, imagePath];
	const previousExit = process.exit;
	process.exit = (() => undefined) as typeof process.exit;
	try {
		await import(pathToFileURL(outfile).href);
		return (globalThis as typeof globalThis & { __imageTestState: RuntimeState }).__imageTestState;
	} finally {
		process.exit = previousExit;
		process.argv = originalArgv;
	}
}

test("image test loads a provided image and starts the TUI preview", async () => {
	const cacheDir = join(root, ".cache");
	await mkdir(cacheDir, { recursive: true });
	const imageDir = await mkdtemp(join(cacheDir, "pi-tui-image-fixture-"));
	const imagePath = join(imageDir, "fixture.png");
	await writeFile(imagePath, Buffer.from("not-a-real-png-but-readable"));

	const state = await importImageTest(imagePath);
	assert.equal(state.started, true);
	assert.equal(state.children[0]?.text, "Image Rendering Test");
	assert.equal(state.children[2]?.kind, "image");
	assert.equal(state.children[2]?.data, Buffer.from("not-a-real-png-but-readable").toString("base64"));
	assert.deepEqual(state.children[2]?.dims, { width: 2, height: 1 });
	assert.equal(state.children.at(-1)?.text, "Press Ctrl+C to exit");
	assert.equal(typeof state.focus?.handleInput, "function");
});
