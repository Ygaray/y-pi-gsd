import { execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolvedBranch = "main";
type GitStatusFixture = { kind: "ok"; stdout: string } | { kind: "error" };
let gitStatusFixture: GitStatusFixture = { kind: "ok", stdout: "" };

vi.mock("child_process", () => ({
	execFile: vi.fn(
		(
			_command: string,
			args: readonly string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			if (args[1] === "symbolic-ref") {
				setTimeout(
					() =>
						callback(
							resolvedBranch ? null : new Error("detached"),
							resolvedBranch ? `${resolvedBranch}\n` : "",
							"",
						),
					0,
				);
				return;
			}
			if (args[1] === "status") {
				setTimeout(() => {
					if (gitStatusFixture.kind === "error") {
						callback(new Error("boom"), "", "");
						return;
					}
					callback(null, gitStatusFixture.stdout, "");
				}, 0);
				return;
			}
			setTimeout(() => callback(new Error("unsupported"), "", ""), 0);
		},
	),
	spawnSync: vi.fn((_command: string, args: readonly string[]) => {
		if (args[1] === "symbolic-ref") {
			return { status: resolvedBranch ? 0 : 1, stdout: resolvedBranch ? `${resolvedBranch}\n` : "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: "" };
	}),
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

type WorktreeFixture = {
	worktreeDir: string;
	reftableDir: string;
};

function createPlainReftableRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git", "reftable"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
	return repoDir;
}

function createPlainRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
	return repoDir;
}

function createReftableWorktree(tempDir: string): WorktreeFixture {
	const repoDir = join(tempDir, "repo");
	const commonGitDir = join(repoDir, ".git");
	const gitDir = join(commonGitDir, "worktrees", "src");
	const worktreeDir = join(tempDir, "worktree");
	const reftableDir = join(commonGitDir, "reftable");

	mkdirSync(gitDir, { recursive: true });
	mkdirSync(reftableDir, { recursive: true });
	mkdirSync(worktreeDir, { recursive: true });

	writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/.invalid\n");
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	writeFileSync(join(reftableDir, "tables.list"), "0\n");

	return { worktreeDir, reftableDir };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * Count only the branch-resolution (`symbolic-ref`) execFile invocations. Since Plan 02, the
 * shared debounce window fires a `git status` call alongside the branch call (RESEARCH Pattern 2
 * / PATTERNS.md "one debounce window, not two systems"), so a raw `execFile` call count no longer
 * isolates branch-refresh behavior on its own.
 */
function symbolicRefCallCount(): number {
	return vi.mocked(execFile).mock.calls.filter((call) => call[1]?.[1] === "symbolic-ref").length;
}

describe("FooterDataProvider reftable branch detection", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-"));
		resolvedBranch = "main";
		vi.mocked(spawnSync).mockClear();
		vi.mocked(execFile).mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses HEAD directly in a regular repo from a nested directory", () => {
		const repoDir = createPlainRepo(tempDir);
		const nestedDir = join(repoDir, "src", "nested");
		mkdirSync(nestedDir, { recursive: true });
		process.chdir(nestedDir);

		const provider = new FooterDataProvider(nestedDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git when HEAD is .invalid in a reftable repo", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
				"git",
				["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
				expect.objectContaining({
					cwd: expect.stringMatching(/repo$/),
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			);
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git in a reftable-backed worktree", () => {
		const { worktreeDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
		} finally {
			provider.dispose();
		}
	});

	it("treats an unresolved .invalid reftable HEAD as detached", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);
		resolvedBranch = "";

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("detached");
		} finally {
			provider.dispose();
		}
	});

	it("does not notify listeners when reftable updates keep the same branch", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			vi.mocked(spawnSync).mockClear();
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			await waitFor(() => symbolicRefCallCount() === 1);

			expect(symbolicRefCallCount()).toBe(1);
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
			expect(provider.getGitBranch()).toBe("main");
			expect(onBranchChange).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("debounces rapid reftable updates into a single async refresh", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			vi.mocked(execFile).mockClear();

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			writeFileSync(join(reftableDir, "tables.list"), "2\n");
			writeFileSync(join(reftableDir, "tables.list"), "3\n");
			await waitFor(() => symbolicRefCallCount() === 1);
			await new Promise((resolve) => setTimeout(resolve, 650));

			expect(symbolicRefCallCount()).toBe(1);
		} finally {
			provider.dispose();
		}
	});

	it("updates the cached branch when the reftable directory changes", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			resolvedBranch = "foo";
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			await waitFor(() => symbolicRefCallCount() === 1);
			await waitFor(() => provider.getGitBranch() === "foo");

			expect(symbolicRefCallCount()).toBe(1);
			expect(provider.getGitBranch()).toBe("foo");
			expect(onBranchChange).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
		}
	});

	it("retries git watchers 5 seconds after an async fs.watch error", async () => {
		vi.useFakeTimers();
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			const providerWithInternals = provider as unknown as {
				headWatcher: FSWatcher | null;
			};
			const originalWatcher = providerWithInternals.headWatcher;
			expect(originalWatcher).not.toBeNull();
			expect(originalWatcher?.listenerCount("error")).toBeGreaterThan(0);

			originalWatcher?.emit("error", new Error("simulated EMFILE"));
			expect(providerWithInternals.headWatcher).toBeNull();

			await vi.advanceTimersByTimeAsync(4999);
			expect(providerWithInternals.headWatcher).toBeNull();

			await vi.advanceTimersByTimeAsync(1);
			expect(providerWithInternals.headWatcher).not.toBeNull();
			expect(providerWithInternals.headWatcher).not.toBe(originalWatcher);
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});
});

const CLEAN_STATUS_STDOUT = ["# branch.oid abc123", "# branch.head main", "# branch.ab +0 -0", ""].join("\n");

const AHEAD_BEHIND_STATUS_STDOUT = ["# branch.oid abc123", "# branch.head main", "# branch.ab +3 -0", ""].join("\n");

const NO_UPSTREAM_STATUS_STDOUT = ["# branch.oid abc123", "# branch.head main", ""].join("\n");

const MIXED_ENTRIES_STATUS_STDOUT = [
	"# branch.oid abc123",
	"# branch.head main",
	"# branch.ab +0 -0",
	"1 M. N... 100644 100644 100644 abc123 def456 staged-file.txt",
	"1 .M N... 100644 100644 100644 abc123 def456 dirty-file.txt",
	"? untracked-file.txt",
	"u UU N... 100644 100644 100644 100644 abc123 def456 ghi789 conflict-file.txt",
	"",
].join("\n");

type ProviderInternals = { scheduleRefresh: () => void };

function scheduleRefresh(provider: FooterDataProvider): void {
	(provider as unknown as ProviderInternals).scheduleRefresh();
}

describe("FooterDataProvider git status", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-status-"));
		resolvedBranch = "main";
		gitStatusFixture = { kind: "ok", stdout: CLEAN_STATUS_STDOUT };
		vi.mocked(spawnSync).mockClear();
		vi.mocked(execFile).mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns null outside a repo and never schedules a refresh", () => {
		const outsideDir = join(tempDir, "not-a-repo");
		mkdirSync(outsideDir, { recursive: true });
		process.chdir(outsideDir);

		const provider = new FooterDataProvider(outsideDir);
		try {
			expect(provider.getGitStatus()).toBeNull();
			expect(vi.mocked(execFile)).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("parses ahead/behind counts from the branch.ab header", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", stdout: AHEAD_BEHIND_STATUS_STDOUT };

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitStatus()).toBeNull();
			await waitFor(() => provider.getGitStatus() !== null);
			expect(provider.getGitStatus()).toEqual({
				staged: 0,
				dirty: 0,
				untracked: 0,
				conflicts: 0,
				ahead: 3,
				behind: 0,
			});
		} finally {
			provider.dispose();
		}
	});

	it("defaults ahead/behind to 0 (never undefined/NaN) when branch.ab header is absent", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", stdout: NO_UPSTREAM_STATUS_STDOUT };

		const provider = new FooterDataProvider(repoDir);
		try {
			await waitFor(() => provider.getGitStatus() !== null);
			const status = provider.getGitStatus();
			expect(status?.ahead).toBe(0);
			expect(status?.behind).toBe(0);
			expect(Number.isNaN(status?.ahead)).toBe(false);
			expect(Number.isNaN(status?.behind)).toBe(false);
		} finally {
			provider.dispose();
		}
	});

	it("classifies staged (1 M.), dirty (1 .M), untracked (?), and conflict (u) entries", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", stdout: MIXED_ENTRIES_STATUS_STDOUT };

		const provider = new FooterDataProvider(repoDir);
		try {
			await waitFor(() => provider.getGitStatus() !== null);
			expect(provider.getGitStatus()).toEqual({
				staged: 1,
				dirty: 1,
				untracked: 1,
				conflicts: 1,
				ahead: 0,
				behind: 0,
			});
		} finally {
			provider.dispose();
		}
	});

	it("reports all-zero counts for a clean, in-sync tree", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", stdout: CLEAN_STATUS_STDOUT };

		const provider = new FooterDataProvider(repoDir);
		try {
			await waitFor(() => provider.getGitStatus() !== null);
			expect(provider.getGitStatus()).toEqual({
				staged: 0,
				dirty: 0,
				untracked: 0,
				conflicts: 0,
				ahead: 0,
				behind: 0,
			});
		} finally {
			provider.dispose();
		}
	});

	it("keeps the previous cached value when a git invocation errors, without throwing", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", stdout: CLEAN_STATUS_STDOUT };

		const provider = new FooterDataProvider(repoDir);
		try {
			await waitFor(() => provider.getGitStatus() !== null);
			const beforeError = provider.getGitStatus();

			gitStatusFixture = { kind: "error" };
			const callsBefore = vi.mocked(execFile).mock.calls.length;
			scheduleRefresh(provider);
			await waitFor(() => vi.mocked(execFile).mock.calls.length > callsBefore);
			// give the errored refresh's microtask chain a chance to settle
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(() => provider.getGitStatus()).not.toThrow();
			expect(provider.getGitStatus()).toEqual(beforeError);
		} finally {
			provider.dispose();
		}
	});

	it("fires onGitStatusChange only when the computed struct differs from the cached one", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", stdout: CLEAN_STATUS_STDOUT };

		const provider = new FooterDataProvider(repoDir);
		try {
			await waitFor(() => provider.getGitStatus() !== null);

			const onGitStatusChange = vi.fn();
			provider.onGitStatusChange(onGitStatusChange);

			// Same fixture again -> no change -> no notification
			const callsBefore = vi.mocked(execFile).mock.calls.length;
			scheduleRefresh(provider);
			await waitFor(() => vi.mocked(execFile).mock.calls.length > callsBefore);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(onGitStatusChange).not.toHaveBeenCalled();

			// Different fixture -> change -> notification fires
			gitStatusFixture = { kind: "ok", stdout: AHEAD_BEHIND_STATUS_STDOUT };
			const callsBefore2 = vi.mocked(execFile).mock.calls.length;
			scheduleRefresh(provider);
			await waitFor(() => vi.mocked(execFile).mock.calls.length > callsBefore2);
			await waitFor(() => provider.getGitStatus()?.ahead === 3);
			expect(onGitStatusChange).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
		}
	});

	it("does not fire a refresh from a pending debounce timer after dispose()", async () => {
		vi.useFakeTimers();
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", stdout: CLEAN_STATUS_STDOUT };

		const provider = new FooterDataProvider(repoDir);
		try {
			scheduleRefresh(provider);
			const callsBefore = vi.mocked(execFile).mock.calls.length;
			provider.dispose();
			await vi.advanceTimersByTimeAsync(1000);
			expect(vi.mocked(execFile).mock.calls.length).toBe(callsBefore);
		} finally {
			vi.useRealTimers();
		}
	});
});
