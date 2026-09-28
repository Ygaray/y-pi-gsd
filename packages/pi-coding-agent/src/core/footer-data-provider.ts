import { existsSync, type FSWatcher, readFileSync, statSync, unwatchFile, watchFile } from "fs";
import { dirname, join, resolve } from "path";
import { gitCommitCountBetween, gitConflictFiles, gitCurrentBranch, gitWorkingTreeStatus } from "@gsd/native/git";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../utils/fs-watch.js";

type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/** Working-tree git status counts, computed off the render path (D-01). */
export type GitStatusInfo = {
	staged: number;
	dirty: number;
	untracked: number;
	conflicts: number;
	ahead: number;
	behind: number;
};

function gitStatusEqual(a: GitStatusInfo | null, b: GitStatusInfo | null): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	return (
		a.staged === b.staged &&
		a.dirty === b.dirty &&
		a.untracked === b.untracked &&
		a.conflicts === b.conflicts &&
		a.ahead === b.ahead &&
		a.behind === b.behind
	);
}

/**
 * Parse the native `gitWorkingTreeStatus()` compact format into counts only — never a
 * path, per the never-retain-a-path contract (threat register T-28-04/T-28-05).
 *
 * Each line is `"<indexChar><worktreeChar> <path>"` — NOT `git status --porcelain` v1
 * or v2. `indexChar`/`worktreeChar` are each one of `A`, `M`, `D`, `R`, `T`, or `' '`
 * (unchanged), except `worktreeChar` can also be `?` for untracked (`" ? path"`, a
 * space then `?` — never porcelain's `"??"`). There is no branch/ahead-behind header
 * line and no conflict marker; conflicts come from `gitConflictFiles()` separately.
 */
function parseNativeGitStatus(statusText: string): Pick<GitStatusInfo, "staged" | "dirty" | "untracked"> {
	let staged = 0;
	let dirty = 0;
	let untracked = 0;

	for (const rawLine of statusText.split("\n")) {
		if (rawLine.length < 2) continue;
		const indexChar = rawLine[0];
		const worktreeChar = rawLine[1];

		if (worktreeChar === "?") {
			untracked++;
			continue;
		}
		if (indexChar !== " ") staged++;
		if (worktreeChar !== " ") dirty++;
	}

	return { staged, dirty, untracked };
}

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Ask the native git addon for the current branch (used only for the reftable
 * `.invalid` HEAD-content fallback — see `resolveGitBranchSync`/`resolveGitBranchAsync`).
 * Returns "detached" on any thrown error or a null branch, since `gitCurrentBranch()`
 * throws on an unborn branch and on repos it cannot open, unlike a plain HEAD-content
 * read.
 */
function resolveBranchWithNativeGit(repoDir: string): string {
	try {
		return gitCurrentBranch(repoDir) ?? "detached";
	} catch {
		return "detached";
	}
}

/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Token stats, model info available via ctx.sessionManager and ctx.model.
 */
export class FooterDataProvider {
	private cwd: string;
	private static readonly WATCH_DEBOUNCE_MS = 500;

	private extensionStatuses = new Map<string, string>();
	private cachedBranch: string | null | undefined = undefined;
	private cachedGitStatus: GitStatusInfo | null | undefined = undefined;
	private gitStatusChangeCallbacks = new Set<() => void>();
	private gitStatusRefreshInFlight = false;
	private gitStatusRefreshPending = false;
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private reftableTablesListWatcher: FSWatcher | null = null;
	private reftableTablesListPath: string | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private gitWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshInFlight = false;
	private refreshPending = false;
	private disposed = false;
	/**
	 * Bumped on every `setCwd()` call (WR-02). A debounced refresh in flight for the *previous*
	 * cwd captures this value before awaiting its subprocess/readFileSync result; if the
	 * generation has since moved on by the time it resolves, the result is discarded instead of
	 * being written into `cachedBranch`/`cachedGitStatus` — otherwise a stale directory's git
	 * data could land in the new directory's cache slot.
	 */
	private cwdGeneration = 0;

	constructor(cwd: string) {
		this.cwd = cwd;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
	}

	/** Current git branch, null if not in repo, "detached" if detached HEAD */
	getGitBranch(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveGitBranchSync();
		}
		return this.cachedBranch;
	}

	/** Extension status texts set via ctx.ui.setStatus() */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** Subscribe to git branch changes. Returns unsubscribe function. */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/**
	 * Working-tree git status counts, null outside a repo. Cache-only and never blocks:
	 * on a cold cache it returns null and schedules the debounced async refresh, since
	 * unlike HEAD, working-tree status cannot be resolved synchronously without a
	 * subprocess and render() must never pay for one.
	 */
	getGitStatus(): GitStatusInfo | null {
		if (!this.gitPaths) {
			this.cachedGitStatus = null;
			return null;
		}
		if (this.cachedGitStatus === undefined) {
			this.cachedGitStatus = null;
			this.scheduleRefresh();
		}
		return this.cachedGitStatus;
	}

	/** Subscribe to git status changes. Returns unsubscribe function. */
	onGitStatusChange(callback: () => void): () => void {
		this.gitStatusChangeCallbacks.add(callback);
		return () => this.gitStatusChangeCallbacks.delete(callback);
	}

	/** Internal: set extension status */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** Internal: clear extension statuses */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** Number of unique providers with available models (for footer display) */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** Internal: update available provider count */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	setCwd(cwd: string): void {
		if (this.cwd === cwd) {
			return;
		}

		this.cwd = cwd;
		this.cwdGeneration++;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.cachedBranch = undefined;
		this.cachedGitStatus = undefined;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
		this.notifyBranchChange();
	}

	/** Internal: cleanup */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.branchChangeCallbacks.clear();
		this.gitStatusChangeCallbacks.clear();
	}

	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	private notifyGitStatusChange(): void {
		for (const cb of this.gitStatusChangeCallbacks) cb();
	}

	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshGitBranchAsync();
			void this.refreshGitStatusAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	private async refreshGitBranchAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}

		this.refreshInFlight = true;
		const gen = this.cwdGeneration;
		try {
			const nextBranch = await this.resolveGitBranchAsync();
			if (this.disposed) return;
			// WR-02: `setCwd()` may have run while the await above was pending. Its result belongs
			// to a directory we've since navigated away from — discard rather than caching it.
			if (gen !== this.cwdGeneration) return;
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				this.cachedBranch = nextBranch;
				this.notifyBranchChange();
				return;
			}
			this.cachedBranch = nextBranch;
		} finally {
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	private async refreshGitStatusAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.gitStatusRefreshInFlight) {
			this.gitStatusRefreshPending = true;
			return;
		}

		this.gitStatusRefreshInFlight = true;
		const gen = this.cwdGeneration;
		try {
			let nextStatus: GitStatusInfo | null;
			try {
				nextStatus = await this.resolveGitStatusAsync();
			} catch {
				// Never-throw contract (mirrors resolveGitBranchSync): on any error, timeout,
				// or parse failure, keep the previous cached value in place.
				return;
			}
			if (this.disposed) return;
			// WR-02: discard a result whose cwd generation has since moved on — see
			// refreshGitBranchAsync's matching guard for the full rationale.
			if (gen !== this.cwdGeneration) return;
			if (this.cachedGitStatus !== undefined && !gitStatusEqual(this.cachedGitStatus, nextStatus)) {
				this.cachedGitStatus = nextStatus;
				this.notifyGitStatusChange();
				return;
			}
			this.cachedGitStatus = nextStatus;
		} finally {
			this.gitStatusRefreshInFlight = false;
			if (this.gitStatusRefreshPending && !this.disposed) {
				this.gitStatusRefreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	/**
	 * Reads working-tree status + conflicts from the native git addon (no subprocess).
	 * The main status/conflicts calls are left to throw on failure — the caller
	 * (`refreshGitStatusAsync`) already wraps this in try/catch and preserves the
	 * "never overwrite cache on error" contract. Ahead/behind are computed separately
	 * via `HEAD@{upstream}`, each independently defaulted to 0 on failure since "no
	 * upstream configured" is an expected, common condition rather than a real error.
	 */
	private async resolveGitStatusAsync(): Promise<GitStatusInfo | null> {
		if (!this.gitPaths) return null;
		const repoDir = this.gitPaths.repoDir;
		const statusText = gitWorkingTreeStatus(repoDir);
		const conflictFiles = gitConflictFiles(repoDir);
		const counts = parseNativeGitStatus(statusText);

		let ahead = 0;
		try {
			ahead = gitCommitCountBetween(repoDir, "HEAD@{upstream}", "HEAD");
		} catch {
			ahead = 0;
		}
		let behind = 0;
		try {
			behind = gitCommitCountBetween(repoDir, "HEAD", "HEAD@{upstream}");
		} catch {
			behind = 0;
		}

		return { ...counts, conflicts: conflictFiles.length, ahead, behind };
	}

	private resolveGitBranchSync(): string | null {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid" ? resolveBranchWithNativeGit(this.gitPaths.repoDir) : branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	/**
	 * `gitCurrentBranch()` is synchronous (no subprocess, no async I/O), so this no
	 * longer performs any real async work — it stays `async` to keep the public
	 * signature and call sites (`await this.resolveGitBranchAsync()`) unchanged.
	 */
	private async resolveGitBranchAsync(): Promise<string | null> {
		return this.resolveGitBranchSync();
	}

	private clearGitWatchers(): void {
		closeWatcher(this.headWatcher);
		this.headWatcher = null;
		closeWatcher(this.reftableWatcher);
		this.reftableWatcher = null;
		closeWatcher(this.reftableTablesListWatcher);
		this.reftableTablesListWatcher = null;
		if (this.reftableTablesListPath) {
			unwatchFile(this.reftableTablesListPath);
			this.reftableTablesListPath = null;
		}
		if (this.gitWatcherRetryTimer) {
			clearTimeout(this.gitWatcherRetryTimer);
			this.gitWatcherRetryTimer = null;
		}
	}

	private scheduleGitWatcherRetry(): void {
		if (this.disposed || this.gitWatcherRetryTimer) {
			return;
		}

		this.gitWatcherRetryTimer = setTimeout(() => {
			this.gitWatcherRetryTimer = null;
			this.setupGitWatcher();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private handleGitWatcherError(): void {
		this.clearGitWatchers();
		this.scheduleGitWatcherRetry();
	}

	private setupGitWatcher(): void {
		this.clearGitWatchers();
		if (!this.gitPaths) return;

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes. `index` lives in the
		// same directory and is watched here too: staging/unstaging a file (`git add`)
		// rewrites `index`, and the footer's staged/dirty markers need the same debounced
		// refresh that a HEAD change already triggers.
		this.headWatcher = watchWithErrorHandler(
			dirname(this.gitPaths.headPath),
			(_eventType, filename) => {
				if (!filename || filename === "HEAD" || filename === "index") {
					this.scheduleRefresh();
				}
			},
			() => this.handleGitWatcherError(),
		);
		if (!this.headWatcher) {
			return;
		}

		// In reftable repos, branch switches update files in the reftable directory
		// instead of HEAD. Watch it separately so the footer picks up those changes.
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			this.reftableWatcher = watchWithErrorHandler(
				reftableDir,
				() => {
					this.scheduleRefresh();
				},
				() => this.handleGitWatcherError(),
			);
			if (!this.reftableWatcher) {
				return;
			}

			const tablesListPath = join(reftableDir, "tables.list");
			if (existsSync(tablesListPath)) {
				this.reftableTablesListPath = tablesListPath;
				this.reftableTablesListWatcher = watchWithErrorHandler(
					tablesListPath,
					() => {
						this.scheduleRefresh();
					},
					() => this.handleGitWatcherError(),
				);
				if (!this.reftableTablesListWatcher) {
					return;
				}
				watchFile(tablesListPath, { interval: 250 }, (current, previous) => {
					if (
						current.mtimeMs !== previous.mtimeMs ||
						current.ctimeMs !== previous.ctimeMs ||
						current.size !== previous.size
					) {
						this.scheduleRefresh();
					}
				});
			}
		}
	}
}

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	| "getGitBranch"
	| "getExtensionStatuses"
	| "getAvailableProviderCount"
	| "onBranchChange"
	| "getGitStatus"
	| "onGitStatusChange"
>;
