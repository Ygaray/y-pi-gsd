// Project/App: gsd-pi
// File Purpose: Phase 42 mechanical guard for RD-SCOPE (driver observability is y-pi-gsd-only) and
// RD-RESEARCH-OPEN 2/3 (the TUI never imports the MCP server package and is read-only on the registry).
// It runs with every agent-modes driver test and discovers later plans' driver files by name. Forbidden
// tokens are assembled from fragments at runtime so this file never matches itself, and it is skipped in
// every scan.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// packages/gsd-agent-modes/src/modes/interactive -> repo root is five directories up.
const repoRoot = join(here, "..", "..", "..", "..", "..");
const agentModesRoot = join(repoRoot, "packages", "gsd-agent-modes");
const agentModesSrc = join(agentModesRoot, "src");
const SELF = basename(fileURLToPath(import.meta.url));

const MCP_SPECIFIER = ["@opengsd", "mcp-server"].join("/");

function walkTs(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walkTs(full, out);
		else if (entry.isFile() && entry.name.endsWith(".ts") && entry.name !== SELF) out.push(full);
	}
	return out;
}

function isTestFile(path: string): boolean {
	return /\.test\.ts$/.test(path);
}

function driverFiles(): string[] {
	const files = walkTs(agentModesSrc).filter((file) => /driver/i.test(basename(file)));
	const rootSrc = join(repoRoot, "src");
	if (existsSync(rootSrc)) {
		for (const entry of readdirSync(rootSrc, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".ts") && entry.name.startsWith("cli-driver")) {
				files.push(join(rootSrc, entry.name));
			}
		}
	}
	return files;
}

describe("driver-boundary", () => {
	it("locates the repository root", () => {
		assert.ok(existsSync(join(agentModesRoot, "package.json")), `expected ${agentModesRoot}/package.json`);
	});

	it("gsd-agent-modes never imports or depends on the MCP server package", () => {
		const offenders = walkTs(agentModesSrc).filter((file) => readFileSync(file, "utf8").includes(MCP_SPECIFIER));
		assert.deepEqual(offenders, []);

		const pkg = JSON.parse(readFileSync(join(agentModesRoot, "package.json"), "utf8")) as Record<string, unknown>;
		for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
			const deps = (pkg[field] ?? {}) as Record<string, unknown>;
			assert.equal(MCP_SPECIFIER in deps, false, `${field} must not list the MCP server package`);
		}
	});

	it("driver-phase files reference no path or tool outside the y-pi-gsd repo", () => {
		const files = driverFiles();
		assert.ok(
			files.some((file) => basename(file) === "gsd-driver-registry.ts"),
			"gsd-driver-registry.ts must be discovered",
		);
		const markers = [
			["yahir", "-tn"].join(""),
			["stop-stray", "-runs"].join(""),
			[".", "claude/"].join(""),
			["gsd", "-core"].join(""),
			["claude", "-config"].join(""),
		];
		const offenders: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8").toLowerCase();
			for (const marker of markers) {
				if (text.includes(marker.toLowerCase())) offenders.push(`${file}: ${marker}`);
			}
		}
		assert.deepEqual(offenders, []);
	});

	it("agent-modes driver files never write the filesystem or send a non-zero signal", () => {
		const writeCall =
			/\b(writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|mkdirSync|copyFileSync|truncateSync|writeFile|appendFile|rename|unlink|rm|mkdir)\s*\(/;
		const offenders: string[] = [];
		for (const file of driverFiles().filter((candidate) => !isTestFile(candidate) && candidate.startsWith(agentModesSrc))) {
			const text = readFileSync(file, "utf8");
			if (writeCall.test(text)) offenders.push(`${file}: filesystem write call`);
			const allKills = (text.match(/process\.kill\(/g) ?? []).length;
			const zeroKills = (text.match(/process\.kill\(\s*[^,()]+,\s*0\s*\)/g) ?? []).length;
			if (allKills !== zeroKills) offenders.push(`${file}: process.kill with a non-zero signal`);
		}
		assert.deepEqual(offenders, []);
	});
});
