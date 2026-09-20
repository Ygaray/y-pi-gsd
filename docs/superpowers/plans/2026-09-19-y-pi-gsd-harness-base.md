# y-pi-gsd Harness Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `open-gsd/gsd-pi` as a personal fork that lives, builds, runs once against a model, and is documented well enough to build on.

**Architecture:** Fork `open-gsd/gsd-pi` → `Ygaray/y-pi-gsd`, clone into `~/Projects/yahir-agentic-tools/y-pi-gsd` with `origin`+`upstream` remotes (the `yahir-gsd` pattern). Enable pnpm via corepack, install and build the workspace, configure its model routing to OpenRouter + DeepSeek V4.1 Flash, run one real task end-to-end, then write `ARCHITECTURE.md`.

**Tech Stack:** TypeScript pnpm-workspace monorepo (`@opengsd/gsd-pi`); Node 24.20.0; corepack 0.35.0; `gh` CLI (authed as `Ygaray`); OpenRouter (`deepseek/deepseek-v4.1-flash`).

**Spec:** `/tmp/claude-1000/-home-yahir-Projects-yahir-agentic-tools-pi-gsd/e2b348c3-aa00-4dcd-944a-b4e4b8e29c5c/scratchpad/2026-09-19-y-pi-gsd-harness-base-design.md` (moves into the repo at `docs/superpowers/specs/` in Task 4).

## Global Constraints

- Upstream relationship: **fork + track upstream**. `origin` = `Ygaray/y-pi-gsd`, `upstream` = `open-gsd/gsd-pi`. History must stay mergeable with upstream — no rewriting imported history.
- Home directory: `~/Projects/yahir-agentic-tools/y-pi-gsd`. The accidental empty dirs `pi-gsd/` and `gsd-pi/` are removed.
- Model backend: OpenRouter, model slug exactly `deepseek/deepseek-v4.1-flash`.
- **The OpenRouter key never enters git.** It lives only in `~/.config/y-pi-gsd/openrouter.key` (mode 600). Any local harness config that references it is gitignored or points at the file/env — never the literal key.
- Package manager: `pnpm` via `corepack` only — no global npm install of pnpm.
- Any web UI handed to Yahir is served over the tailnet (`*.ts.net` path) — never a bare `localhost`/`127.0.0.1`.
- Do not run `/gsd-update`-style upstream clean-installs (irrelevant here, but the fork-safety rule stands).

---

### Task 1: Establish the fork, clone, and home layout

**Files:**
- Create: `~/Projects/yahir-agentic-tools/y-pi-gsd/` (populated by clone)
- Remove: `~/Projects/yahir-agentic-tools/pi-gsd/`, `~/Projects/yahir-agentic-tools/gsd-pi/` (empty)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a working clone at `~/Projects/yahir-agentic-tools/y-pi-gsd` with `origin`+`upstream` remotes — every later task runs inside this directory.

- [ ] **Step 1: Confirm the two twin dirs are empty before removing**

Run:
```bash
ls -A ~/Projects/yahir-agentic-tools/pi-gsd ~/Projects/yahir-agentic-tools/gsd-pi
```
Expected: no output (both empty). If either has content, STOP and report — do not delete.

- [ ] **Step 2: Fork upstream to the renamed fork (no clone yet)**

Run:
```bash
gh repo fork open-gsd/gsd-pi --fork-name y-pi-gsd --clone=false
```
Expected: reports the fork `Ygaray/y-pi-gsd` created (or "already exists", which is fine).

- [ ] **Step 3: Verify the fork exists on GitHub**

Run:
```bash
gh repo view Ygaray/y-pi-gsd --json name,parent -q '{name: .name, parent: .parent.nameWithOwner}'
```
Expected: `name` = `y-pi-gsd`, `parent` = `open-gsd/gsd-pi`.

- [ ] **Step 4: Remove the empty twin dirs**

Run:
```bash
rmdir ~/Projects/yahir-agentic-tools/pi-gsd ~/Projects/yahir-agentic-tools/gsd-pi
```
Expected: succeeds silently. (`rmdir` refuses non-empty dirs — a safety net.)

- [ ] **Step 5: Clone the fork into the home directory**

Run:
```bash
git clone https://github.com/Ygaray/y-pi-gsd.git ~/Projects/yahir-agentic-tools/y-pi-gsd
```
Expected: clone completes.

- [ ] **Step 6: Add the upstream remote**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && git remote add upstream https://github.com/open-gsd/gsd-pi.git && git remote -v
```
Expected: `origin` → `Ygaray/y-pi-gsd` (fetch+push), `upstream` → `open-gsd/gsd-pi` (fetch+push).

- [ ] **Step 7: Record the current upstream commit for provenance**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && git log -1 --format='%H %ci %s'
```
Expected: prints the HEAD commit. Note it in the eventual ARCHITECTURE.md (Task 4). No commit in this task — the repo already has its own history.

---

### Task 2: Toolchain, install, and build

**Files:**
- Modify: none of the repo's source. May create local build output (gitignored by the repo).

**Interfaces:**
- Consumes: the clone from Task 1.
- Produces: an installed + built workspace, or a clearly reported toolchain gate. Later tasks assume `pnpm` runs and the harness entrypoint is built.

- [ ] **Step 1: Read the repo's declared package manager and scripts**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && cat package.json | grep -E '"(packageManager|scripts|engines)"' -A 20 ; echo '---' ; cat pnpm-workspace.yaml 2>/dev/null ; echo '---' ; ls
```
Expected: shows the `packageManager` pin, the build/dev scripts, and workspace globs. Read the README/CONTRIBUTING for a documented build path before choosing commands.

- [ ] **Step 2: Activate pnpm via corepack at the declared version**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && corepack enable && corepack prepare --activate && pnpm --version
```
Expected: prints the pnpm version matching `packageManager` in `package.json`. If `packageManager` is absent, run `corepack enable && pnpm --version` and note the version used.

- [ ] **Step 3: Install workspace dependencies**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && pnpm install
```
Expected: install completes with no errors. **Gate:** if it fails on a native/toolchain dependency (Rust, Go, platform build tools, `native/` binaries), STOP and report exactly which tool + version is required rather than installing system packages unprompted.

- [ ] **Step 4: Build using the repo's declared build script**

Run the build script discovered in Step 1 (commonly `pnpm build` or `pnpm -r build`):
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && pnpm build
```
Expected: build completes with no errors. **Gate:** if the full monorepo build (e.g. `web`, `native`) stalls or fails but the core CLI/agent packages build, report the trade-off and proceed with the partial build sufficient to run the harness (per spec risk note).

- [ ] **Step 5: Verify the harness entrypoint is runnable**

Run (adjust to the entrypoint discovered in Step 1 — often the `cli` package bin):
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && pnpm gsd-pi --help 2>&1 | head -30 || node packages/cli/dist/index.js --help 2>&1 | head -30
```
Expected: the harness prints its help/usage. If neither works, report the actual bin path found in `package.json` bins and use it.

- [ ] **Step 6: Commit only if the repo expects committed build metadata**

Most monorepos gitignore build output — in that case there is nothing to commit here. Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && git status --short
```
Expected: clean (build output ignored). If a lockfile or generated file legitimately changed and the repo tracks it, commit that alone:
```bash
git add pnpm-lock.yaml && git commit -m "chore: refresh lockfile after install"
```
Otherwise skip the commit.

---

### Task 3: Configure OpenRouter and run against DeepSeek V4.1 Flash

**Files:**
- Create/Modify: gsd-pi's own model/provider config (path discovered from its docs), **gitignored or key-free**.

**Interfaces:**
- Consumes: the built harness from Task 2; the key at `~/.config/y-pi-gsd/openrouter.key`.
- Produces: a proven end-to-end run — evidence the harness works, cited in ARCHITECTURE.md.

- [ ] **Step 1: Discover how gsd-pi expects provider/model config**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && grep -rniE 'openrouter|OPENROUTER|provider|baseURL|model' --include='*.md' --include='*.ts' --include='*.json' docs packages src 2>/dev/null | grep -iE 'openrouter|provider config|api.?key' | head -40
```
Expected: surfaces the config file/env-var names and whether OpenRouter is a first-class provider or configured via an OpenAI-compatible base URL (`https://openrouter.ai/api/v1`). Read the matching docs before writing config.

- [ ] **Step 2: Load the key into the environment for this run (never into git)**

Run:
```bash
export OPENROUTER_API_KEY="$(cat ~/.config/y-pi-gsd/openrouter.key)"; [ -n "$OPENROUTER_API_KEY" ] && echo "key loaded (${#OPENROUTER_API_KEY} chars)"
```
Expected: `key loaded (73 chars)`. If gsd-pi wants a config file instead of an env var, write it to the path from Step 1 and confirm that path is gitignored (`git check-ignore <path>` returns the path); if it is not ignored, add it to `.gitignore` and reference the key via env/file, never inline.

- [ ] **Step 3: Point the harness at OpenRouter + the model slug**

Using the mechanism found in Step 1, set provider = OpenRouter (base URL `https://openrouter.ai/api/v1` if OpenAI-compatible) and model = `deepseek/deepseek-v4.1-flash`. Record the exact config used in a scratch note for Task 4.

- [ ] **Step 4: Confirm the model slug resolves on OpenRouter**

Run:
```bash
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" | grep -o 'deepseek/deepseek-v4.1-flash' | head -1
```
Expected: prints `deepseek/deepseek-v4.1-flash` (model is available to this key). If empty, STOP and report — the slug or key entitlement is wrong before spending a run.

- [ ] **Step 5: Drive one real task end-to-end**

Run the harness on a trivial, safe task in a throwaway location (exact invocation per the CLI help from Task 2 Step 5 — e.g. ask it to create and print a one-line file). Capture the transcript/output.
Expected: the harness calls the model via OpenRouter and completes the task without provider/auth errors. **If the natural verification surface is the web UI**, serve it over the tailnet per the Global Constraints and give Yahir the `*.ts.net` URL — never `localhost`.

- [ ] **Step 6: Verify the run actually hit DeepSeek via OpenRouter**

Confirm from the harness logs (or OpenRouter's activity/usage) that the request used `deepseek/deepseek-v4.1-flash`.
Expected: a logged request to the model. Note the evidence (log line or usage entry) for ARCHITECTURE.md.

- [ ] **Step 7: Commit any key-free config**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && git status --short && git diff --cached
```
Expected: verify no secret is staged. Commit only key-free config that belongs in the repo:
```bash
git add <config-file> && git commit -m "chore: configure OpenRouter provider (key read from ~/.config)"
```
If the only config holds the key, it must be gitignored instead — do not commit it.

---

### Task 4: Write ARCHITECTURE.md and land the planning docs

**Files:**
- Create: `~/Projects/yahir-agentic-tools/y-pi-gsd/ARCHITECTURE.md`
- Create: `~/Projects/yahir-agentic-tools/y-pi-gsd/docs/superpowers/specs/2026-09-19-y-pi-gsd-harness-base-design.md` (copy of the approved spec)
- Create: `~/Projects/yahir-agentic-tools/y-pi-gsd/docs/superpowers/plans/2026-09-19-y-pi-gsd-harness-base.md` (copy of this plan)

**Interfaces:**
- Consumes: findings from Tasks 1–3 (upstream commit, package layout, run evidence, provider config).
- Produces: the "understood" deliverable — the map future work builds on.

- [ ] **Step 1: Enumerate the actual workspace packages**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && for d in packages/* src web native; do [ -e "$d" ] && echo "== $d ==" && ([ -f "$d/package.json" ] && grep -E '"(name|description)"' "$d/package.json" || ls "$d" | head); done
```
Expected: lists each real package with its name/description. Base the doc on what exists, not the assumed `cli/agent/tui/rpc/web/native` set.

- [ ] **Step 2: Write ARCHITECTURE.md**

Write `ARCHITECTURE.md` covering, from the evidence gathered:
- Provenance: forked from `open-gsd/gsd-pi` at the commit recorded in Task 1 Step 7.
- One paragraph per real package (from Step 1): what it does.
- The core wiring: how the agent loop, tool execution, and model routing connect (trace it from the entrypoint found in Task 2).
- Where the GSD workflow layer plugs into the runtime.
- How to run it: the working invocation from Task 3, and that the OpenRouter key is read from `~/.config/y-pi-gsd/openrouter.key` (never committed).
Depth: enough to build on — not exhaustive.

- [ ] **Step 3: Verify the doc matches reality**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && for p in $(grep -oE 'packages/[a-z0-9-]+' ARCHITECTURE.md | sort -u); do [ -d "$p" ] && echo "OK $p" || echo "MISSING $p"; done
```
Expected: every package path named in the doc prints `OK`. Fix any `MISSING` (a described-but-absent package is a doc bug).

- [ ] **Step 4: Copy the spec and this plan into the repo**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && mkdir -p docs/superpowers/specs docs/superpowers/plans && cp /tmp/claude-1000/-home-yahir-Projects-yahir-agentic-tools-pi-gsd/e2b348c3-aa00-4dcd-944a-b4e4b8e29c5c/scratchpad/2026-09-19-y-pi-gsd-harness-base-design.md docs/superpowers/specs/ && cp /tmp/claude-1000/-home-yahir-Projects-yahir-agentic-tools-pi-gsd/e2b348c3-aa00-4dcd-944a-b4e4b8e29c5c/scratchpad/2026-09-19-y-pi-gsd-harness-base.md docs/superpowers/plans/
```
Expected: both files copied.

- [ ] **Step 5: Commit the documentation**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && git add ARCHITECTURE.md docs/superpowers && git commit -m "docs: architecture map + harness-base spec and plan"
```
Expected: commit succeeds.

- [ ] **Step 6: Push the branch to the fork**

Run:
```bash
cd ~/Projects/yahir-agentic-tools/y-pi-gsd && git push origin HEAD
```
Expected: pushes to `Ygaray/y-pi-gsd`. Confirm no secret was ever committed:
```bash
git log --all -p | grep -iE 'sk-or-[a-z0-9-]' && echo "SECRET FOUND — STOP" || echo "clean"
```
Expected: `clean`.

---

## Success criteria (from spec)

1. `y-pi-gsd` is a clone of `Ygaray/y-pi-gsd` with correct `origin`+`upstream`; stray dirs gone. (Task 1)
2. `pnpm install` + build complete, or a clearly reported toolchain gate. (Task 2)
3. The harness completes one real task against `deepseek/deepseek-v4.1-flash` via OpenRouter. (Task 3)
4. Accurate `ARCHITECTURE.md` exists. (Task 4)

## Notes for the executor

- This plan wires up existing software; there are no unit tests to write. Each task's "test" is its verification command + expected output. Honor the **Gate** callouts — stop and report rather than guessing when the repo's reality differs from assumptions.
- The single hardest rule: **the OpenRouter key never touches git.** Every commit step re-checks this.
