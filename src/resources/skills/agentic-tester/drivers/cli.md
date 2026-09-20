# CLI driver — agentic-tester

Driver playbook for a target surface that is a command-line program. The `agentic-tester` spine
(`SKILL.md`) resolves this file at its Step 1 "Resolve driver" whenever the surface under test is
CLI/bash. This playbook grounds every build and drive step in this repo's own documented harness
invocation contract (`ARCHITECTURE.md` §"How to run it") rather than in remembered CLI conventions.

## Preconditions

Check these, read-only, before driving anything. An unmet precondition is reported and the run
halts — it is never worked around by substituting a different runtime, package manager, or model.

- `node --version` satisfies the `engines.node` floor of `22.18.0` declared in the root
  `package.json`.
- `corepack pnpm --version` reports the `packageManager` pin `10.12.1`. pnpm is activated through
  corepack only, and never through a global npm install of pnpm, per this project's standing
  constraint.
- Only when the criteria under test require a real model call: the key file
  `~/.config/y-pi-gsd/openrouter.key` exists with mode `600`.

## Build

The recipe, run from the repository root against the current tree:

```bash
pnpm install --frozen-lockfile
pnpm run build
```

`--frozen-lockfile` is mandatory — the tester installs exactly what the committed lockfile pins
and never mutates it. The build output is read rather than assumed successful. `dist/` is the
runtime entry point, so a criterion driven against a stale `dist/` is testing a previous code
state and is therefore invalid evidence.

## Drive

The invocation contract is `node dist/bootstrap.js` invoked directly — there is no self-symlinked
`bin` for this package's own CLI. Flags that matter:

- `--print` (alias `-p`) — single-shot non-interactive mode.
- `--mode` — one of `text`, `json`, `rpc`, `mcp`.
- `--model` — a `provider/model-id`, e.g. `--model openrouter/deepseek/deepseek-v4.1-flash`.
- `--thinking <level>` — thinking-effort level.
- `--session <path|id>`, `--continue` (alias `-c`) — session persistence.
- `--web --host --port` — browser-backed mode.

Canonical single-shot invocation:

```bash
export OPENROUTER_API_KEY="$(cat ~/.config/y-pi-gsd/openrouter.key)"
node dist/bootstrap.js --print --mode json \
  --model openrouter/deepseek/deepseek-v4.1-flash \
  "<prompt>"
```

This playbook is self-contained: it cites only repository-relative paths such as `ARCHITECTURE.md`
and `dist/bootstrap.js`. It never cites a control-plane planning or workflow path from outside this
repository — the tester reads this file from a synced skills tree where such paths do not resolve.

## Observe

Four capture layers, each settling a different claim:

- **Exit status** — settles whether the invocation succeeded or failed.
- **Captured stdout** — settles output-content claims.
- **Captured stderr, kept separate from stdout** — settles error-content claims without
  contaminating the stdout stream.
- **The `--mode json` structured per-call event stream** — reveals which provider and model
  actually served a run.

Capture the exit status in the same shell statement as the command that produced it — a later
read of the status variable reports a different command's result.

## Evidence layer by claim type

| Claim type | Evidence layer |
|---|---|
| Exit-status claim ("did it succeed/fail") | The captured exit status |
| Output-content claim ("what did it print") | Captured stdout or stderr |
| "Which provider and model served this run" claim | The `--mode json` event stream |
| File-artifact claim ("did it write X") | Reading the produced file |

Exit-code and stdout claims are settled by captured command output, never by a screenshot.
Capture the exit status in the same statement as the command that produced it; a later read reports a different command.
Evidence produced before this build, or in a previous run, is stale and does not count.

## Gotchas

There is no self-symlinked bin for this package's own CLI; invoke node dist/bootstrap.js directly.
PI_TOKEN_TELEMETRY=1 is documented in docs/user-docs/configuration.md but is not implemented in this checkout; use the --mode json event stream instead.
The OpenRouter key value is never printed, never passed as a command-line argument, and never copied into the SELF-UAT log.

The key is sourced only by exporting it from the key file, as shown in the Drive section above —
never by echoing it, printing it, or passing it as a CLI argument. Driving before building tests
the previous code state, not the current tree.

## Halt conditions

Three surfaces stop the run, each owned by a specific spine step:

- **A missing or wrong-moded key file** halts at Step 2 (Preflight).
- **A failing build** halts at Step 3 (Build).
- **A target binary that cannot be invoked** halts at Step 3 (Build).

For each, the run reports the specific missing precondition and stops — it never substitutes a
different model, provider, package manager, or an already-built artifact. A halt at Step 1, 2, or
3 still writes the SELF-UAT log with the halt reason, per the spine's halt-persistence rule.
