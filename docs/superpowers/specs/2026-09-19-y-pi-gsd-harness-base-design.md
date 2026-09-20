# y-pi-gsd — Harness Base (Increment 1) Design

**Date:** 2026-09-19
**Status:** Draft for review
**Author:** Yahir + Claude

## Context & motivation

Long-term goal: build an agent **harness Yahir fully controls** — agnostic across
models/providers, modular, owned end-to-end. Claude Code remains the *primary* harness;
this is a parallel track into **harness engineering**.

`open-gsd/gsd-pi` is chosen as the on-ramp (rather than bare Pi) because the **GSD
workflow** — a favorite — is already wired onto the Pi agent runtime. Starting here gives
both the harness internals *and* the GSD methodology in one base.

`gsd-pi` is a standalone TypeScript pnpm-workspace monorepo (`@opengsd/gsd-pi`): its own
CLI, agent loop, TUI, RPC layer, web UI, and native binaries — a full runtime, distinct
from the existing `yahir-gsd` fork (which is a Claude-Code skill/agent/workflow pack that
installs into `~/.claude/`). Owning this means owning the runtime, not just the skill layer.

## Scope of this increment

**Deliver a live, understood base:** the repo is home here, the monorepo builds, the
harness runs once against a real model, and its architecture is mapped well enough to build
on next.

**Explicitly out of scope (later milestones):** any custom code changes / rebrand,
permanent tailnet hosting, memory-system or incident-log wiring, provider abstraction work.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Upstream relationship | **Fork + track upstream** — mirrors the `yahir-gsd` pattern |
| GitHub fork | `Ygaray/y-pi-gsd` (renamed fork; upstream = `open-gsd/gsd-pi`) |
| Local home directory | `~/Projects/yahir-agentic-tools/y-pi-gsd` |
| Model backend (first run) | **OpenRouter**, model `deepseek/deepseek-v4.1-flash` ("DeepSeek V4.1 Flash") |
| Package manager | `pnpm` via `corepack` (present: corepack 0.35.0) |

## Design

### 1. Repo & home layout
- `gh repo fork open-gsd/gsd-pi --fork-name y-pi-gsd` (no clone), then clone
  `Ygaray/y-pi-gsd` into `~/Projects/yahir-agentic-tools/y-pi-gsd`.
- Remotes: `origin` = `Ygaray/y-pi-gsd`, `upstream` = `open-gsd/gsd-pi`.
- Remove the two accidental empty dirs `pi-gsd/` and `gsd-pi/`.
- Result matches the established 3-layer mental model: a personal fork that can still
  `git merge upstream` for improvements.

### 2. Build
- `corepack enable` / activate the `packageManager` version the repo declares.
- `pnpm install`, then the repo's own build script(s) for the workspace.
- **Gate:** if a non-Node toolchain is required (native binaries, Rust/Go), stop and
  surface it rather than guessing. Report exactly what's needed.

### 3. Run against a model
- **Prerequisite gate (satisfied):** OpenRouter key lives in `~/.config/y-pi-gsd/openrouter.key`
  (mode 600, project-scoped), read at run time — not an env var, not committed. Execution
  loads it from there into whatever the harness expects (env export for the run, or gsd-pi's config).
- Configure gsd-pi's provider/model routing to OpenRouter + `deepseek/deepseek-v4.1-flash`.
- Drive the harness once (CLI/TUI) on a trivial task to prove it runs end-to-end.
- If the **web UI** is the natural surface to verify, serve it over the tailnet
  (`*.ts.net` mounted path) — never a bare `localhost` (per operator rule).

### 4. Understand it
- Write `ARCHITECTURE.md` mapping the workspace packages (`cli`, `agent`, `tui`, `rpc`,
  `web`, `native`, others as found): what each does, how the agent loop + tool execution +
  model routing connect, and where the GSD workflow layer plugs in.
- Depth: enough to build on next — not an exhaustive audit.

## Success criteria

1. `~/Projects/yahir-agentic-tools/y-pi-gsd` is a clone of `Ygaray/y-pi-gsd` with `origin`
   + `upstream` remotes correctly set; stray empty dirs gone.
2. `pnpm install` + build complete with no errors (or a clearly reported toolchain gate).
3. The harness completes one real task against `deepseek/deepseek-v4.1-flash` via OpenRouter.
4. `ARCHITECTURE.md` exists and accurately describes the package layout and core wiring.

## Risks / unknowns

- **Toolchain surprises:** native/`packages/native` may need platform build tooling. Gated.
- **Provider config shape:** exact way gsd-pi expects OpenRouter creds/model routing is
  unverified — resolved during execution against the repo's own docs/config.
- **Model-slug drift:** `deepseek/deepseek-v4.1-flash` confirmed live on OpenRouter today;
  re-verify at run time.
- **Build weight:** full monorepo (web + native) may be heavy; a partial build sufficient
  for a first run is acceptable if the full build stalls (report the trade-off).

## Prerequisites for execution
- OpenRouter key present at `~/.config/y-pi-gsd/openrouter.key` (mode 600) — confirmed in place.
- (Available) `gh` authed as `Ygaray` with `repo`+`workflow` scopes; corepack 0.35.0.
