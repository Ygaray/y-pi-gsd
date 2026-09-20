# Agentic Tester Port — Integration Contract

This document pins the four pi-gsd extension points the agentic-tester port (milestone v2,
phases 6-8) depends on. Every symbol below was RE-VERIFIED against live source in this checkout
at execution time of Phase 5 Plan 1 — not copied from the 2026-09-20 research snapshot
(`.planning/research/STACK.md`, `.planning/research/ARCHITECTURE.md`). Where an observed line
number differs from the research snapshot, that divergence is called out explicitly.

Discharges requirement TEST-01 and locks in decisions D-01 and D-02 from
`.planning/phases/05-tester-core/05-CONTEXT.md`.

## 1. Subagent dispatch

The registered tool name is literally `subagent` — `pi.registerTool({ name: "subagent", ... })`
at `src/resources/extensions/subagent/index.ts:886` (the `pi.registerTool` call itself opens at
`index.ts:885`). This is the ONLY dispatch mechanism Phase 7 may wire into a `/gsd verify-agentic`
command handler; there is no separate programmatic dispatch API.

Single-mode argument shape is `{ agent, task }`: the `agent` and `task` fields of the
`SubagentParams` Type.Object schema (`index.ts:837-838`), also mirrored in the `TaskParam`
interface (`index.ts:342-349`). Other modes (`tasks: [...]` for parallel, `chain: [...]` for
sequential) exist but are out of scope for a single-shot agentic-tester dispatch.

Execution flow: the tool's `execute()` calls `discoverAgents(ctx.cwd, agentScope)`
(`agents.ts:141`, invoked at `index.ts:902`) to resolve the named agent from
`~/.gsd/agent/agents/` (user scope) or `.gsd/agents/`/`.pi/agents/` (project scope, both
synonyms via `PROJECT_AGENT_DIR_CANDIDATES`, `agents.ts:9`). The resolved `AgentConfig`
(`agents.ts:13-24`) is passed into `runSingleAgent` (`index.ts:438`), which spawns an isolated
child `pi` process via `spawn(process.execPath, [...], { cwd, env, shell: false, stdio: [...] })`
(`index.ts:551-555`).

The agent markdown body (`agent.systemPrompt`, i.e. everything after the frontmatter) is written
to a temp file (`writePromptToTempFile`, `index.ts:281-287`, invoked at `index.ts:526-530`) and
passed to the child as `--append-system-prompt <tmpPath>` — the exact push happens in
`buildSubagentProcessArgs` at `launch.ts:112`.

**Load-bearing for D-02** — `buildSubagentProcessArgs` (`launch.ts:90-115`) contains this exact
conditional at **`launch.ts:111`**:

```ts
if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
```

This line number (`launch.ts:111`) matches the STACK.md snapshot exactly — no drift observed.
`--tools` is emitted on the spawned child ONLY when `agent.tools` is a non-empty array. An agent
file with no `tools:` frontmatter line therefore inherits the full default tool set, including
`edit`. This is precisely why the port ships its own `agentic-tester.md` agent file rather than
reusing `tester.md` (see `## Corrections to the authority docs` below) — `tester.md` today has NO
`tools:` field (verified: `src/resources/agents/tester.md`, full file read, no `tools:` key in
frontmatter) and so silently runs with Edit access.

The child launches in JSON mode, non-interactive, single-shot: `args: string[] = ["--mode", "json",
"-p"]` (`launch.ts:98`), with `--no-session` in the fresh-context case (`launch.ts:103`, the
default path for a single dispatch with no `context: "fork"` override).

The accepted tool vocabulary — the literal `ToolName` union — is defined at
`packages/pi-coding-agent/src/core/tools/index.ts:83-84`:

```ts
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
```

Seven names total: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

`AgentConfig.tools` is parsed from the agent frontmatter's `tools:` line by `parseAgentTools()`
(`agents.ts:46-64`) — a comma-separated string (or array) is split, trimmed, and filtered for
non-empty entries; there is no validation against `allToolNames` at parse time, so a typo'd tool
name silently produces a `--tools` flag the child CLI will itself reject or ignore. `agentic-tester.md`
must spell all six of its tool names exactly as the `ToolName` union defines them.

## 2. Command registration

This section documents the routing chain as it actually exists in this checkout. **Phase 5 writes
no TypeScript** — this is documentation for Phase 7 to consume when it wires `/gsd verify-agentic`.

`handleGSDCommand` (`src/resources/extensions/gsd/commands/dispatcher.ts:40`) runs a fixed handler
chain built at `dispatcher.ts:47-55`:

```ts
const handlers = [
  () => handleGsdCoreAlias(trimmed, ctx, pi),
  () => handleCoreCommand(trimmed, ctx, pi),
  () => handleAutoCommand(trimmed, ctx, pi),
  () => handleParallelCommand(trimmed, ctx, pi),
  () => handleWorkflowCommand(trimmed, ctx, pi),
  () => handleOpsCommand(trimmed, ctx, pi),
];
```

Handlers are tried in this fixed order (`dispatcher.ts:83-87`) until one returns `true`.

`src/resources/extensions/gsd/commands/handlers/ops.ts` is where new single-shot subcommands like
`add-tests` and `eval-review` are actually wired — by literal string-match blocks that
dynamic-import a SIBLING TOP-LEVEL `commands-<name>.ts` file (NOT a file inside `handlers/`).
Observed real pattern, `ops.ts:340-347`:

```ts
if (trimmed === "add-tests" || trimmed.startsWith("add-tests ")) {
  const { handleAddTests } = await import("../../commands-add-tests.js");
  await handleAddTests(trimmed.replace(/^add-tests\s*/, "").trim(), ctx, pi);
  ...
}
if (trimmed === "eval-review" || trimmed.startsWith("eval-review ")) {
  const { handleEvalReview } = await import("../../commands-eval-review.js");
  await handleEvalReview(trimmed.replace(/^eval-review\s*/, "").trim(), ctx, pi);
  ...
}
```

The relative import `../../commands-add-tests.js` resolves (from
`handlers/ops.ts`) to `src/resources/extensions/gsd/commands-add-tests.js` — i.e. a file living
two levels up from `handlers/`, directly under `extensions/gsd/`, sibling to `commands/` itself.
Phase 7's `/gsd verify-agentic` handler must follow this exact shape: a string-match block added
to `ops.ts`, dynamic-importing a new top-level `commands-verify-agentic.ts`.

`src/resources/extensions/gsd/commands/catalog.ts` — `TOP_LEVEL_SUBCOMMANDS`
(`catalog.ts:24-112`) is a `readonly GsdCommandDefinition[]` array of `{ cmd, desc }` pairs
consumed ONLY by `getGsdArgumentCompletions` (`catalog.ts:453` onward) for shell-completion and
`/gsd help` text. It routes nothing — `handleGSDCommand` never reads `TOP_LEVEL_SUBCOMMANDS`.
Adding `verify-agentic` to this array is a documentation/completion nicety for Phase 7, not a
functional requirement; the real routing happens in `ops.ts`.

## 3. Skill loading

`initResources(agentDir, skillsDir)` is defined at `src/resource-loader.ts:723-787`. On every
launch it calls `syncResourceDir` (defined at `src/resource-loader.ts:413-432`) once per bundled
resource category, including the skills call at **`src/resource-loader.ts:769`**:

```ts
syncResourceDir(join(resourcesDir, 'skills'), skillsDir)
```

This copies `src/resources/skills/**` (the bundled source tree) into `skillsDir`, which defaults
to `join(agentDir, 'skills')` i.e. `~/.gsd/agent/skills/` (`initResources` signature,
`resource-loader.ts:723`). `src/resources/skills/agentic-tester/` is therefore the CORRECT home
for the spine skill this port creates in Plan 05-03.

`src/resources/extensions/gsd/skills/` is a DIFFERENT, narrower directory — confirmed to exist on
disk in this checkout (`ls src/resources/extensions/gsd/skills` succeeds) — and it is NOT touched
by the `initResources` → `syncResourceDir` call chain above (that call only ever reads from
`resourcesDir/skills`, i.e. `src/resources/skills/`, never from
`src/resources/extensions/gsd/skills/`). A skill placed in
`src/resources/extensions/gsd/skills/` silently never loads into the agent's skill set — there is
no error, no warning, just an unreachable file. Phase 5-03 must place the spine skill at
`src/resources/skills/agentic-tester/SKILL.md`.

## 4. .gsd/ write contract

`gsdRoot(basePath)` (`src/resources/extensions/gsd/paths.ts:516-535`) is the project-scoped `.gsd/`
resolver: it probes `basePath/.gsd` directly, then falls back to `git rev-parse --show-toplevel`
plus a bounded walk-up, caching the result per normalized `basePath` for the process lifetime.
This is explicitly DIFFERENT from the global `getAgentDir()` (`packages/pi-coding-agent/src/config.ts:191`,
used e.g. at `agents.ts:142` for the USER-scope agents directory `~/.gsd/agent/agents/`) — `gsdRoot`
resolves the project's own `.gsd/`, never the global agent home. The SELF-UAT log write must go
through the `gsdRoot`-anchored project path, not `getAgentDir()`.

`classifyGsdLogicalPath(logicalPath)` (`src/resources/extensions/gsd/projection-path-policy.ts:56-77`)
returns one of `"control" | "invalid" | "managed" | "unmanaged"` based ONLY on the first path
segment (`projection-path-policy.ts:67`, `const first = normalized[0]`):

- `reservedDirectories` / `reservedNames` (lines 11-19, 1-9) → `"control"`
- `managedDirectories` / `managedRootFiles` (lines 21-41, 43-54) → `"managed"`
- everything else → `"unmanaged"`

`verification` IS a literal member of `managedDirectories` (`projection-path-policy.ts:40`) and is
therefore the WRONG target for this pilot — a managed path is subject to DB-projection
overwrite on the next `state/derive/` cycle, which would silently clobber a plain-file SELF-UAT
log write from inside the spawned `agentic-tester` child.

`.gsd/verify-agentic/` is NOT a member of `reservedDirectories`, `reservedNames`,
`managedDirectories`, or `managedRootFiles` — it therefore classifies as `unmanaged`, confirmed at
runtime by this task's verify command (see `## Re-verification` below), which printed
`PATH_POLICY_OK` after asserting `classifyGsdLogicalPath('verify-agentic/demo-SELF-UAT.md') === 'unmanaged'`
and `classifyGsdLogicalPath('verification/demo.md') === 'managed'`. An `unmanaged` path is a plain
file write with NO DB-projection guard and NO involvement from any `db/writers/` or
`state/derive/` module — exactly the advisory, out-of-band write surface the SELF-UAT log needs.

## Corrections to the authority docs

Three supersessions to the design/implementation-plan authority docs
(`docs/superpowers/specs/2026-09-20-agentic-tester-port-design.md`,
`docs/superpowers/plans/2026-09-20-agentic-tester-port.md`), each per D-01 or the
`ARCHITECTURE.md` research findings:

1. **Agent id.** Both authority docs assume the persona rides on the existing `tester` agent id.
   Per `05-CONTEXT.md` D-01 this is superseded: the persona ships as a NEW file
   `src/resources/agents/agentic-tester.md` with frontmatter `name: agentic-tester`, and all
   dispatch uses `{ agent: "agentic-tester" }`. Reason, concretely: the `tester` id is already
   live-wired into `gate-evaluate` Q3/Q4 dispatch — confirmed by grep of
   `src/resources/extensions/gsd/prompts/gate-evaluate.md:27,33-34`, which literally dispatches
   `subagent` with `{ agent: "tester", task: "<Q3 prompt...>" }` / `{ agent: "tester", task: "<Q4
   prompt...>" }` — and into `allowedSubagents` lists in
   `src/resources/extensions/gsd/unit-context-manifest.ts` at lines 317, 328, and 416 (all three
   list `"tester"`). Overwriting `tester.md` would silently change shipped GSD-internal behavior.
   Hard rule: `src/resources/agents/tester.md` is never mutated by this milestone (PROHIB-05-02).
   D-01's reversibility rating is `costly`: a later phase (7's prompt template, 8's pilot) that
   dispatches `{agent: "tester"}` by habit would silently run the generic full-Edit-access
   test-writing persona instead of the DIAGNOSE-ONLY one. Every dispatch site in Phases 7 and 8
   must reference `agentic-tester`, never `tester`.

2. **Persona delivery mechanism.** STACK.md's "Load-bearing finding" recommended carrying the
   persona as task-content layered onto the existing `tester` agent id (i.e. prose injected into
   the `task` string of a `{agent: "tester", task: "..."}` dispatch). D-01 supersedes this in
   favour of a real, separate agent FILE. The practical consequence is a HARD tool restriction
   rather than a prose one: `buildSubagentProcessArgs` (`launch.ts:111`, see `## 1` above) reads
   `tools:` off the discovered `AgentConfig`, which comes from the agent file's frontmatter — a
   restriction expressed only in a task-string prompt has no enforcement mechanism at the process
   level and could be ignored by the model.

3. **Command-routing location and `.gsd/` write scope.** The implementation-plan doc targeted a
   handler file directly under the command handlers directory (`commands/handlers/`) and a mocked
   programmatic `ctx.dispatch()` seam. The real pattern (see `## 2` above) is a top-level
   `commands-<name>.ts` file routed by a string match added to `commands/handlers/ops.ts`, with
   the handler injecting a prompt into the current turn rather than calling any dispatch function
   — there is no `ctx.dispatch()` API in this codebase. Likewise, the plan's instruction to
   investigate the DB writer and state-derive directories for the SELF-UAT log write is
   superseded: per `## 4` above, the log target `.gsd/verify-agentic/` is `unmanaged`, so the
   write is a plain advisory file write with no `db/writers/` or `state/derive/` involvement at
   all. Both corrections are Phase 7 obligations — documented here only; Phase 5 implements
   neither.

## Port decisions pinned here

**D-02, implementable form.** The `agentic-tester.md` agent frontmatter `tools:` line must read
exactly:

```
tools: read, bash, write, grep, find, ls
```

`edit` is deliberately omitted from this list — that omission IS the entire DIAGNOSE-ONLY
enforcement mechanism (per `## 1` above, `launch.ts:111` only forwards the tools that are
present; there is no separate "block edit" flag). The list is a POSITIVE, all-or-nothing
allowlist: it excludes every extension tool not named on the line, including any future
`browser_*` tool names. Phase 6 must GROW this line with the specific browser tool names it needs
when the browser driver lands — it cannot rely on a wildcard or an implicit default. The spawned
`agentic-tester` child never needs the `subagent` tool itself (it does not dispatch further
sub-subagents in this milestone's scope).

A skill-level `allowed-tools:` field (or any skill frontmatter field resembling a tool
restriction) is DECORATIVE and is NOT enforced anywhere in this runtime — `parseAgentTools()` /
`buildSubagentProcessArgs` only ever read the AGENT file's `tools:` field (see `## 1`). Nothing in
Phases 6-8 may rely on a skill-level tool field for enforcement.

**Deferred item** (recorded here per `05-CONTEXT.md` `<deferred>`, not resolved by this phase): a
hard, tool-level Edit restriction enforced at the `subagent` launch API itself (beyond the agent
`tools:` frontmatter parsed from a markdown file, which a sufficiently adversarial change to that
file could alter) is a real follow-on gap. It is explicitly NOT a v2 blocker — DIAGNOSE-ONLY is
enforced by the `tools:` allowlist plus Phase 8's `git status` pilot check — and belongs in a
later hardening milestone.

## Re-verification

verified as of 3081fcfa15ab56ef5dae19365e8da0d7a1d88fba

This contract is a snapshot, not a permanent authority. Phases 6, 7, and 8 MUST re-run the block
below at the point they consume any signature documented above, and treat a mismatch (a symbol
that no longer resolves, or a `BAD_PATH_CLASS` result) as a blocker — not as a reason to silently
patch around the drift.

```bash
cd /home/yahir/Projects/yahir-agentic-tools/y-pi-gsd && for pair in "pi.registerTool:src/resources/extensions/subagent/index.ts" "function discoverAgents:src/resources/extensions/subagent/agents.ts" "parseAgentTools:src/resources/extensions/subagent/agents.ts" "function buildSubagentProcessArgs:src/resources/extensions/subagent/launch.ts" "function createSubagentLaunchPlan:src/resources/extensions/subagent/launch.ts" "allToolNames:packages/pi-coding-agent/src/core/tools/index.ts" "function gsdRoot:src/resources/extensions/gsd/paths.ts" "function classifyGsdLogicalPath:src/resources/extensions/gsd/projection-path-policy.ts" "function initResources:src/resource-loader.ts" "TOP_LEVEL_SUBCOMMANDS:src/resources/extensions/gsd/commands/catalog.ts" "handleGSDCommand:src/resources/extensions/gsd/commands/dispatcher.ts"; do s="${pair%%:*}"; f="${pair#*:}"; grep -qF -- "$s" "$f" || { echo "UNRESOLVED_SYMBOL $s in $f"; exit 1; }; done; node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types -e "import('./src/resources/extensions/gsd/projection-path-policy.ts').then(m=>{const u=m.classifyGsdLogicalPath('verify-agentic/demo-SELF-UAT.md');const g=m.classifyGsdLogicalPath('verification/demo.md');if(u!=='unmanaged'||g!=='managed'){console.log('BAD_PATH_CLASS verify-agentic='+u+' verification='+g);process.exit(1);}console.log('PATH_POLICY_OK');});" && echo CONTRACT_SYMBOLS_RESOLVE
```

Consumption rule: re-run this block before quoting any symbol from `## 1`-`## 4` above; a mismatch
is a blocker for the consuming phase, not something to route around.
