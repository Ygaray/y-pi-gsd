import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolvedBranch = "main";
type GitStatusFixture = { kind: "ok"; statusText: string; conflicts?: string[] } | { kind: "error" };
let gitStatusFixture: GitStatusFixture = { kind: "ok", statusText: "" };

/**
 * `gitCommitCountBetween` mock, keyed on its `(repoPath, fromRef, toRef)` args:
 * `fromRef === "HEAD@{upstream}", toRef === "HEAD"` -> ahead value;
 * `fromRef === "HEAD", toRef === "HEAD@{upstream}"` -> behind value;
 * throws to simulate "no upstream configured" when `hasUpstream` is false.
 */
let hasUpstream = true;
let aheadCount = 0;
let behindCount = 0;
/**
 * Per-repoPath ahead override, for tests that need to distinguish two different
 * repos' status data (the WR-02 stale-cwd race test) rather than sharing one
 * global `aheadCount` across every repo the mock is asked about.
 */
let aheadByRepo: Record<string, number> = {};

vi.mock("@gsd/native/git", () => ({
	gitCurrentBranch: vi.fn((_repoPath: string) => (resolvedBranch ? resolvedBranch : null)),
	gitWorkingTreeStatus: vi.fn((_repoPath: string) => {
		if (gitStatusFixture.kind === "error") throw new Error("boom");
		return gitStatusFixture.statusText;
	}),
	gitHasChanges: vi.fn(() => false),
	gitCommitCountBetween: vi.fn((repoPath: string, fromRef: string, toRef: string) => {
		if (!hasUpstream) throw new Error("Failed to resolve ref 'HEAD@{upstream}'");
		const ahead = aheadByRepo[repoPath] ?? aheadCount;
		if (fromRef === "HEAD@{upstream}" && toRef === "HEAD") return ahead;
		if (fromRef === "HEAD" && toRef === "HEAD@{upstream}") return behindCount;
		return 0;
	}),
	gitConflictFiles: vi.fn((_repoPath: string) => {
		if (gitStatusFixture.kind === "error") throw new Error("boom");
		return gitStatusFixture.conflicts ?? [];
	}),
}));

import { gitCurrentBranch } from "@gsd/native/git";
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
 * Count only `gitCurrentBranch` calls (the reftable `.invalid` fallback path). Since
 * Plan 02, the shared debounce window fires a status refresh alongside the branch
 * refresh, so a raw call count on any single mock no longer isolates branch-refresh
 * behavior on its own — this helper narrows to just the branch-resolution calls.
 */
function gitCurrentBranchCallCount(): number {
	return vi.mocked(gitCurrentBranch).mock.calls.length;
}

describe("FooterDataProvider reftable branch detection", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-"));
		resolvedBranch = "main";
		vi.mocked(gitCurrentBranch).mockClear();
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
			expect(vi.mocked(gitCurrentBranch)).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via the native addon when HEAD is .invalid in a reftable repo", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(gitCurrentBranch)).toHaveBeenCalledWith(expect.stringMatching(/repo$/));
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via the native addon in a reftable-backed worktree", () => {
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
			vi.mocked(gitCurrentBranch).mockClear();
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			await waitFor(() => gitCurrentBranchCallCount() === 1);

			expect(gitCurrentBranchCallCount()).toBe(1);
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
			vi.mocked(gitCurrentBranch).mockClear();

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			writeFileSync(join(reftableDir, "tables.list"), "2\n");
			writeFileSync(join(reftableDir, "tables.list"), "3\n");
			await waitFor(() => gitCurrentBranchCallCount() === 1);
			await new Promise((resolve) => setTimeout(resolve, 650));

			expect(gitCurrentBranchCallCount()).toBe(1);
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
			vi.mocked(gitCurrentBranch).mockClear();
			resolvedBranch = "foo";
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			await waitFor(() => gitCurrentBranchCallCount() === 1);
			await waitFor(() => provider.getGitBranch() === "foo");

			expect(gitCurrentBranchCallCount()).toBe(1);
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

/** Native status-line format: "<indexChar><worktreeChar> <path>" per line, no header. */
const CLEAN_STATUS_TEXT = "";

const MIXED_ENTRIES_STATUS_TEXT = ["M  staged-file.txt", " M dirty-file.txt", " ? untracked-file.txt", ""].join("\n");

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
		gitStatusFixture = { kind: "ok", statusText: CLEAN_STATUS_TEXT };
		hasUpstream = true;
		aheadCount = 0;
		behindCount = 0;
		aheadByRepo = {};
		vi.mocked(gitCurrentBranch).mockClear();
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
		} finally {
			provider.dispose();
		}
	});

	it("parses ahead/behind counts via gitCommitCountBetween against HEAD@{upstream}", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", statusText: CLEAN_STATUS_TEXT };
		aheadCount = 3;
		behindCount = 0;

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

	it("defaults ahead/behind to 0 (never undefined/NaN) when there is no upstream", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", statusText: CLEAN_STATUS_TEXT };
		hasUpstream = false;

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

	it("classifies staged (M ), dirty ( M), untracked (?), and conflict entries", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = {
			kind: "ok",
			statusText: MIXED_ENTRIES_STATUS_TEXT,
			conflicts: ["conflict-file.txt"],
		};

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
		gitStatusFixture = { kind: "ok", statusText: CLEAN_STATUS_TEXT };

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

	it("refreshes git status when .git/index changes (staging a file)", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", statusText: CLEAN_STATUS_TEXT };

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

			// Simulate `git add`: the underlying status changes and `.git/index` is rewritten.
			gitStatusFixture = { kind: "ok", statusText: MIXED_ENTRIES_STATUS_TEXT };
			writeFileSync(join(repoDir, ".git", "index"), "fake index bytes");

			await waitFor(() => provider.getGitStatus()?.staged === 1);
			expect(provider.getGitStatus()).toEqual({
				staged: 1,
				dirty: 1,
				untracked: 1,
				conflicts: 0,
				ahead: 0,
				behind: 0,
			});
		} finally {
			provider.dispose();
		}
	});

	it("does not refresh git status when an unrelated untracked file is created outside .git", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", statusText: CLEAN_STATUS_TEXT };

		const provider = new FooterDataProvider(repoDir);
		try {
			await waitFor(() => provider.getGitStatus() !== null);

			const onGitStatusChange = vi.fn();
			provider.onGitStatusChange(onGitStatusChange);

			// A plain new file in the working tree (not under .git/) must not trigger a
			// refresh — full recursive working-tree watching is explicitly out of scope;
			// this fix is scoped to `.git/index` only.
			gitStatusFixture = { kind: "ok", statusText: MIXED_ENTRIES_STATUS_TEXT };
			writeFileSync(join(repoDir, "untracked-elsewhere.txt"), "hello");

			await new Promise((resolve) => setTimeout(resolve, 650));
			expect(onGitStatusChange).not.toHaveBeenCalled();
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
		gitStatusFixture = { kind: "ok", statusText: CLEAN_STATUS_TEXT };

		const provider = new FooterDataProvider(repoDir);
		try {
			await waitFor(() => provider.getGitStatus() !== null);
			const beforeError = provider.getGitStatus();

			gitStatusFixture = { kind: "error" };
			scheduleRefresh(provider);
			// give the errored refresh's microtask chain a chance to settle
			await new Promise((resolve) => setTimeout(resolve, 550));

			expect(() => provider.getGitStatus()).not.toThrow();
			expect(provider.getGitStatus()).toEqual(beforeError);
		} finally {
			provider.dispose();
		}
	});

	it("fires onGitStatusChange only when the computed struct differs from the cached one", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		gitStatusFixture = { kind: "ok", statusText: CLEAN_STATUS_TEXT };

		const provider = new FooterDataProvider(repoDir);
		try {
			await waitFor(() => provider.getGitStatus() !== null);

			const onGitStatusChange = vi.fn();
			provider.onGitStatusChange(onGitStatusChange);

			// Same fixture again -> no change -> no notification
			scheduleRefresh(provider);
			await new Promise((resolve) => setTimeout(resolve, 550));
			expect(onGitStatusChange).not.toHaveBeenCalled();

			// Different fixture -> change -> notification fires
			aheadCount = 3;
			scheduleRefresh(provider);
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
		gitStatusFixture = { kind: "ok", statusText: CLEAN_STATUS_TEXT };

		const provider = new FooterDataProvider(repoDir);
		try {
			scheduleRefresh(provider);
			const callsBefore = vi.mocked(gitCurrentBranch).mock.calls.length;
			provider.dispose();
			await vi.advanceTimersByTimeAsync(1000);
			expect(vi.mocked(gitCurrentBranch).mock.calls.length).toBe(callsBefore);
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * WR-02 regression attempt: a `setCwd()` call interleaving with an in-flight
	 * refresh's cache write. Since the native calls are synchronous, the actual async
	 * window is now just the microtask tick between `await this.resolveGitStatusAsync()`
	 * returning and its continuation running (an async function still yields at least
	 * one microtask to its awaiter) — the race is real but narrow.
	 */
	it("discards a stale-cwd status refresh that resolves after setCwd() moves to a new directory (WR-02)", async () => {
		vi.useFakeTimers();
		const oldRepoDir = createPlainRepo(tempDir);
		const newRepoDir = join(tempDir, "repo-new");
		mkdirSync(join(newRepoDir, ".git"), { recursive: true });
		writeFileSync(join(newRepoDir, ".git", "HEAD"), "ref: refs/heads/other\n");

		gitStatusFixture = { kind: "ok", statusText: CLEAN_STATUS_TEXT };
		resolvedBranch = "main";
		// Only the OLD repo's status refresh reports ahead:9 — the new repo (absent
		// from the map) falls back to aheadCount (0). This lets the assertion tell
		// "stale old-cwd data landed" apart from "correct new-cwd data landed",
		// which a single shared ahead value could not distinguish.
		aheadByRepo[oldRepoDir] = 9;

		const provider = new FooterDataProvider(oldRepoDir);
		try {
			// Prime the old cwd's cache so it's non-null before the race begins.
			scheduleRefresh(provider);
			await vi.advanceTimersByTimeAsync(500);
			expect(provider.getGitStatus()?.ahead).toBe(9);

			// Trigger a second debounced refresh for the OLD cwd. Fire its timer with
			// the SYNC advance (not the async variant) so the timer callback runs and
			// `refreshGitStatusAsync` suspends at its internal `await
			// this.resolveGitStatusAsync()` WITHOUT yielding the microtask queue back
			// to the test — an async function's continuation only runs once the
			// enclosing synchronous stack (this test body, up to its next `await`)
			// finishes. This is the narrow real race window (#WR-02): the native call
			// itself is synchronous now, so the only async gap left is that one
			// microtask tick between the promise settling and its continuation.
			scheduleRefresh(provider);
			vi.advanceTimersByTime(500);

			// Switch cwd in this same synchronous tick, before the suspended
			// continuation above has any chance to run.
			resolvedBranch = "other";
			provider.setCwd(newRepoDir);

			// setCwd() clears the cache; confirm nothing was written synchronously.
			expect(provider.getGitStatus()).toBeNull();

			// Now let everything settle: the discarded old-cwd continuation (guarded
			// by the cwdGeneration check) and a fresh debounced refresh for the new cwd.
			await vi.advanceTimersByTimeAsync(500);
			await vi.runAllTimersAsync();

			const finalStatus = provider.getGitStatus();
			// The old cwd's stale refresh (ahead: 9) must never land in the new cwd's
			// cache slot.
			expect(finalStatus?.ahead).not.toBe(9);
			expect(provider.getGitBranch()).toBe("other");
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});
});
