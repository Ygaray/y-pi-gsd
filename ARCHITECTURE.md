# ARCHITECTURE.md — y-pi-gsd harness map

This document maps the `gsd-pi` harness as it actually exists in this checkout, so future work
has a live, verified base to build on. It is not exhaustive — it covers the package layout, the
core wiring from CLI entrypoint to model call, where the GSD workflow layer plugs in, and how to
run the thing.

## Provenance

`y-pi-gsd` (`Ygaray/y-pi-gsd` on GitHub) is a fork of `open-gsd/gsd-pi`, forked at upstream commit
`fa83b795` (2026-09-18). The product identifies itself as **GSD v1.20.1 "Git Ship Done"**
(https://opengsd.net). Root package name: `@opengsd/gsd-pi`. Remotes in this checkout:
`origin` → `Ygaray/y-pi-gsd`, `upstream` → `open-gsd/gsd-pi`.

## Workspace layout

pnpm workspace (`pnpm-workspace.yaml`): `packages/*`, `extensions/*`, `web`. Root `src/` holds the
GSD-branded CLI/product layer that sits above all of it. Below is every real package, one
paragraph each — no assumed `cli/agent/tui/rpc/web/native` set, only what's on disk.

- **`packages/pi-ai`** (`@gsd/pi-ai`) — "Unified LLM API with automatic model discovery and
  provider configuration." This is the model-routing layer: a generated provider/model registry
  (`models.generated.json`, hundreds of models across providers including a first-class
  `openrouter` block), an `api-registry.ts` mapping API shapes (e.g. `openai-completions`) to
  request/stream handlers, `env-api-keys.ts` for reading provider credentials from environment
  variables, plus OAuth and Bedrock-specific providers. Has zero `@gsd`/`@opengsd` dependencies —
  it's the base of the stack.

- **`packages/pi-agent-core`** (`@gsd/pi-agent-core`) — "General-purpose agent with transport
  abstraction, state management, and attachment support." The transport-agnostic agent loop
  primitive (session state, message/attachment plumbing) that everything else builds on. Also has
  zero `@gsd`/`@opengsd` dependencies.

- **`packages/pi-coding-agent`** (`@gsd/pi-coding-agent`) — "Coding agent CLI (vendored from
  earendil-works/pi)." The coding-specific agent runtime: tool execution, the extension
  loader/virtual-module system (`core/extensions/loader.js`), theming, and a Bun-binary build
  path. Depends on `pi-ai`, `pi-agent-core`, `pi-tui`, `native`, and (despite being lower in the
  stack conceptually) `@gsd/agent-core` — this is the vendored upstream "pi" agent that GSD is
  built on top of.

- **`packages/gsd-agent-core`** (`@gsd/agent-core`) — "GSD session orchestration layer on top of
  `@gsd/pi-coding-agent`." Owns the actual agent session lifecycle used in day-to-day runs:
  `agent-session.ts`/`agent-session-runtime.ts` (the loop that drives turns), `bash-executor.ts`
  (tool execution for the bash tool), `compaction/` (context compaction), `transcript-store.ts`,
  `system-prompt.ts`, and lifecycle hooks. This is where GSD's own behavior on top of the vendored
  "pi" agent lives.

- **`packages/gsd-agent-modes`** (`@gsd/agent-modes`) — "GSD run modes and CLI layer." Implements
  the CLI-facing run modes: `modes/interactive`, `modes/print-mode.ts` (the `--print` path used in
  Task 3), `modes/rpc`, plus `cli/` helpers (`args.ts`, `list-models.ts`,
  `prepare-model-registry.ts`, `session-picker.ts`). This is the layer that turns parsed CLI flags
  into a running agent session in a specific mode.

- **`packages/contracts`** (`@opengsd/contracts`) — "Shared public contracts for GSD workspace
  boundaries." Type/interface definitions shared across packages (notably consumed by
  `rpc-client`, `mcp-server`, `daemon`).

- **`packages/rpc-client`** (`@opengsd/rpc-client`) — "Standalone RPC client SDK for GSD — zero
  internal dependencies [besides `contracts`]." The client side of the `--mode rpc` surface.

- **`packages/mcp-server`** (`@opengsd/mcp-server`) — "MCP server exposing GSD orchestration tools
  for compatible clients." Ships its own bin (`gsd-mcp-server`), separate from the main `gsd`
  entrypoint — lets external MCP clients drive GSD orchestration.

- **`packages/daemon`** (`@opengsd/daemon`) — "GSD daemon — background process for project
  monitoring and Discord integration." A separate long-running process, not part of the
  request/response CLI path.

- **`packages/native`** (`@gsd/native`) — "Native Rust bindings for GSD — high-performance native
  modules via N-API." The built N-API addon consumed by `pi-tui` and `pi-coding-agent`. Note: a
  **second**, unrelated top-level `native/` directory (Cargo workspace: `Cargo.toml`, `crates/`,
  `npm/`) also exists at the repo root — that's the Rust source workspace that `packages/native`'s
  prebuilt/`dist` output is built from. Don't confuse the two.

- **`packages/pi-tui`** (`@gsd/pi-tui`) — "Terminal UI library (vendored from earendil-works/pi)."
  The interactive terminal rendering layer used by `modes/interactive`. Depends on `native`.

- **`packages/db`** — has no `package.json` at all (the outlier: a bare `src`/`tests` layout, so
  no `name`/`description`). Contents confirm it's a small Drizzle ORM client (`neon-http` driver) —
  a Postgres/Neon data-access layer, most likely consumed by `web`, not by the CLI harness path.

- **`extensions/google-search`** (`@gsd-extensions/google-search`) — "Web search via Google with
  AI-synthesized answers and source citations." A standalone, publishable extension package
  (distinct from the *bundled* extensions under `src/resources/extensions/`, see below).

- **`web/`** (`gsd-web`) — The Next.js 16 web UI/API surface, built to a standalone server bundle
  (`dist/web/standalone`) by the root build script. Backs `--web`/browser mode.

## Core wiring: entrypoint → agent loop → model call

Trace, starting from the harness entrypoint (`bin.gsd` = `bin.gsd-cli` → `dist/bootstrap.js`,
**not** `bin.gsd-pi`, which is only the npm-global installer wizard — see Task 2):

1. **`src/bootstrap.ts`** — thin shim. On direct invocation it repairs `node_modules/@gsd/*`
   symlinks for installs that skipped lifecycle scripts (protects against `ERR_MODULE_NOT_FOUND`
   when `@gsd/*` workspace packages aren't linked), then `import('./loader.js')`.

2. **`src/loader.ts`** — the real startup sequence, run before any heavy imports: fast-paths
   `--version`/`--help`; checks Node/git availability; sets process env that downstream code
   depends on (`PI_PACKAGE_DIR`, `GSD_CODING_AGENT_DIR`, `GSD_PKG_ROOT`, `GSD_WORKFLOW_PATH`,
   `GSD_BUNDLED_EXTENSION_PATHS`, proxy dispatcher); discovers and links the workspace `@gsd/*`
   packages into `node_modules/@gsd/`; validates `@gsd/pi-coding-agent` is resolvable; calls
   `registerAgentBundles()` (registers `@gsd/agent-core`/`@gsd/agent-modes` as virtual modules for
   the Bun extension-loader path only — a no-op on the normal Node path, where the loader resolves
   the same specifiers by file path); then `await import('./cli.js')`.

3. **`src/cli.ts`** — the GSD product layer (branding, onboarding, resource/tool bootstrap,
   session management, update checks, model-override/validation, the `--print`/`--mode` and
   subcommand dispatch). This is where flags parsed via `gsd-agent-modes`'s `cli/args.ts` route
   into a concrete run mode.

4. **`packages/gsd-agent-modes`** — turns the resolved mode (`interactive` / `print-mode` /
   `rpc`) into a running session, using `prepare-model-registry.ts` (builds the resolved
   provider/model list, e.g. for `--list-models`) and `config-selector.ts`.

5. **`packages/gsd-agent-core`** (`agent-session.ts` / `agent-session-runtime.ts`) — drives the
   actual turn loop: sends messages, executes tool calls (`bash-executor.ts` for the bash tool),
   handles compaction, and persists the transcript. This is GSD's own orchestration layer sitting
   on top of the vendored `pi-coding-agent`.

6. **`packages/pi-coding-agent`** — supplies the underlying coding-agent primitives (tool
   definitions, the extension loader that the `gsd` bundled extension registers hooks/tools
   through) and, transitively, `pi-agent-core`'s transport-agnostic loop.

7. **`packages/pi-ai`** — the model call itself. Resolves `<provider>/<model-id>` (e.g.
   `openrouter/deepseek/deepseek-v4.1-flash`) against `models.generated.json`, picks the API
   shape via `api-registry.ts` (OpenRouter uses `api: "openai-completions"`, `baseUrl:
   "https://openrouter.ai/api/v1"`), and reads the credential via `env-api-keys.ts` — for
   OpenRouter this is the `OPENROUTER_API_KEY` environment variable, checked directly, no
   provider-specific config file required.

## Where the GSD workflow layer plugs in

GSD's actual workflow behavior (milestone planning/execution/tracking, the skills library, slash
commands like `/gsd:*`) is **not** hardcoded into the packages above — it's delivered as a bundled
**extension** plus a **workflow document**, loaded through the same generic extension mechanism
`pi-coding-agent` exposes to any extension:

- **`src/resources/extensions/gsd/`** — the `gsd` extension itself (`extension-manifest.json`:
  `id: "gsd"`, tier `core`). It provides tools (`bash`, `write`, `read`, `edit`,
  `gsd_decision_save`, `gsd_summary_save`, `gsd_requirement_update`,
  `gsd_milestone_generate_id`), commands (`gsd`, `kill`, `worktree`, `exit`), and hooks into the
  agent loop (`session_start`, `before_agent_start`, `agent_end`, `tool_call`, `tool_result`,
  `model_select`, `before_provider_request`, etc.) — this is how GSD-specific behavior observes
  and steers the generic agent loop without modifying it. Implementation files include the `auto*`
  modules (autonomous milestone execution/dashboard/dispatch/recovery) and more.
- **`src/resources/GSD-WORKFLOW.md`** — the bundled workflow document. `loader.ts` sets
  `GSD_WORKFLOW_PATH` to its resolved location; the `gsd` extension reads it to dispatch workflow
  prompts (e.g. what `/gsd:*` commands actually instruct the agent to do).
- **`src/resources/skills/`** — the bundled skills library (`tdd`, `review`,
  `security-review`, `handoff`, `create-gsd-extension`, etc.), synced into `~/.gsd/agent/` at
  startup by `initResources()`/`resource-loader.ts` in `src/cli.ts`, alongside other bundled and
  third-party extensions (`extensions/google-search`, `browser-tools`, `mcp-client`, `ollama`,
  `subagent`, and more) discovered via `extension-discovery.ts`/`extension-registry.ts`.

In short: **runtime = vendored `pi` agent (agent-core/agent-modes/pi-agent-core/pi-ai/pi-tui/pi-coding-agent)
+ GSD product shell (root `src/`) + the `gsd` extension and its workflow doc/skills, loaded like
any other extension.**

## How to run it

Build once (`pnpm install --frozen-lockfile && pnpm run build`, see Task 2 report), then invoke the
built entrypoint directly (there is no self-symlinked `bin` for the package's own CLI in
`node_modules/.bin`):

```bash
export OPENROUTER_API_KEY="$(cat ~/.config/y-pi-gsd/openrouter.key)"
node dist/bootstrap.js --print --mode json \
  --model openrouter/deepseek/deepseek-v4.1-flash \
  "<prompt>"
```

- `--print`/`-p` — single-shot mode (no interactive TUI).
- `--mode text|json|rpc|mcp` — output shape; `json` gives a structured per-call event stream
  (useful for verifying which provider/model actually served a run — see Task 3 report).
- `--model <provider/model-id>` — override the model; OpenRouter is a first-class built-in
  provider, so no extra config file is needed for models already in
  `packages/pi-ai/src/models.generated.json` (`deepseek/deepseek-v4.1-flash` already is).
- Other relevant flags: `--web --host --port` (browser mode, backed by `web/`), `--thinking
  <level>`, `--worktree`/`-w`, `--session <path|id>`/`--continue`/`-c` (session persistence).

**The OpenRouter API key lives at `~/.config/y-pi-gsd/openrouter.key` (mode 600) and is loaded
into `OPENROUTER_API_KEY` fresh for each invocation — it is never committed to this repo and
never written into any config file inside it.**

## Known gaps (flagged, not yet resolved)

- `docs/user-docs/configuration.md` documents `PI_TOKEN_TELEMETRY=1` as writing per-call token/cost
  telemetry to stderr; no implementation of it was found anywhere in this checkout (`src/`,
  `packages/`, `dist/`, `node_modules/`). `--mode json`'s event stream is the reliable substitute
  for the moment (see Task 3 report, §5).
