/**
 * Native git queries using N-API, backed by libgit2 (no shelled-out `git` process).
 *
 * These are thin wrappers over the compiled Rust addon's `git_*` napi bindings
 * (`native/crates/engine/src/git.rs`). All are synchronous — libgit2 calls run
 * on the calling thread, no subprocess spawn, no async I/O.
 */

import { native } from "../native.js";

/**
 * Current branch name for `repoPath`, or `null` on detached HEAD.
 *
 * Throws on an "unborn" branch (a freshly-`git init`'d repo with zero commits,
 * where HEAD points at a ref that does not yet exist as an object) and on any
 * repo libgit2 cannot open. Callers that need a HEAD-file-content read for the
 * unborn/no-repo case (e.g. `FooterDataProvider`'s primary resolution path)
 * should not route through this function — it is intended for cases where a
 * real, non-degenerate repository is already known to exist.
 */
export function gitCurrentBranch(repoPath: string): string | null {
	return native.gitCurrentBranch(repoPath) as string | null;
}

/** Name of the repository's configured main/default branch (e.g. "main" or "master"). */
export function gitMainBranch(repoPath: string): string {
	return native.gitMainBranch(repoPath) as string;
}

/**
 * Working-tree status lines for `repoPath`, in a **custom compact format** —
 * NOT `git status --porcelain` v1 or v2. Each line is:
 *
 *   "<indexChar><worktreeChar> <path>"
 *
 * where `indexChar` and `worktreeChar` are each one of `A`, `M`, `D`, `R`, `T`,
 * or `' '` (unchanged), except `worktreeChar` can also be `?` for an untracked
 * path (rendered as `" ? path"` — a space then `?`, never porcelain's `"??"`).
 *
 * There is no branch/ahead-behind header line (unlike
 * `git status --porcelain=v2 --branch`) and no conflict marker ('U'/'u') —
 * conflicts are never represented here. Use `gitConflictFiles()` separately
 * to get the conflicted-path list/count.
 */
export function gitWorkingTreeStatus(repoPath: string): string {
	return native.gitWorkingTreeStatus(repoPath) as string;
}

/** True if `repoPath` has any uncommitted working-tree or index changes. */
export function gitHasChanges(repoPath: string): boolean {
	return native.gitHasChanges(repoPath) as boolean;
}

/**
 * Number of commits reachable from `toRef` but not from `fromRef` (i.e. `git rev-list
 * --count fromRef..toRef`), via libgit2 revspecs. Both `fromRef`/`toRef` accept anything
 * `Repository::revparse_single` understands, including `"HEAD@{upstream}"`.
 *
 * Throws when a revspec cannot be resolved — most commonly `"HEAD@{upstream}"` when the
 * current branch has no configured upstream (`branch.<name>.remote` unset). Callers that
 * want ahead/behind against upstream should catch this and default to 0, matching how
 * `git status --porcelain=v2 --branch` simply omits its `branch.ab` line in that case.
 */
export function gitCommitCountBetween(repoPath: string, fromRef: string, toRef: string): number {
	return native.gitCommitCountBetween(repoPath, fromRef, toRef) as number;
}

/** Paths currently in a merge/rebase conflict state. Empty array when there are none. */
export function gitConflictFiles(repoPath: string): string[] {
	return native.gitConflictFiles(repoPath) as string[];
}
