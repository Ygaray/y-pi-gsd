---
status: needs-confirmation
platform: cli-library
authored_by: gsd-verify-work-agentic (autonomous, headless bootstrap)
authored_at: 2026-09-21
---

<!--
UAT driver playbook for y-pi-gsd's CLI/library-shaped surfaces (Node/TypeScript
pure functions and stdin/stdout scripts with no GUI, browser, or device
surface — e.g. renderers, parsers, validators, hook engines).

BOOTSTRAP NOTE: authored headlessly (no human present) by the Gate-1 agentic
tester during Phase 9 (verdict-channel) verification, per
verify-work-agentic.md's <bootstrap_driver> headless path: "generate a
best-effort draft from detection alone, stamp status: needs-confirmation, and
raise a SETUP escalation so the owner confirms it at the next human
touchpoint." Detected from: package.json (`type: module`, Node >=22.18),
`tsconfig.extensions.json`, and this repo's existing test-runner conventions
(`node --experimental-strip-types --test`). Confirm or correct at the next
human touchpoint; until then this is a draft, not a signed-off contract.
-->

## D1 — Target + preflight

The "running app" for a CLI/library-shaped phase is the Node.js runtime
itself (`node >= 22.18.0`, per `package.json` `engines`), executing the
CURRENT source tree directly — no GUI, browser, or device to bring up.

Preflight: confirm `node --version` satisfies the engines constraint, and
that `pnpm run typecheck:extensions` (see D2) exits 0 against HEAD. A
missing/wrong Node version, or a typecheck failure caused by a broken
toolchain (not the code under test), is `INFRA`.

## D2 — Build / install / launch

There is no compiled artifact to install/launch for TypeScript-under-test:
this codebase runs `.ts`/`.mjs` sources directly via
`node --experimental-strip-types` (see `package.json` scripts), so "build"
means:
- `pnpm run typecheck:extensions` (`tsc --noEmit --project
  tsconfig.extensions.json`) — proves the CURRENT tree compiles (ladder
  rung 0).
- Build identity = `git rev-parse --short HEAD` + `sha256sum` of the
  specific file(s) under test. Record both so a run is never against a
  stale tree.

No separate "launch" step exists — each ladder rung invokes the real
module/script fresh per command.

## D3 — Act

Two invocation shapes, chosen per the surface actually being tested:
- **In-process (pure functions/modules):** `node --import
  ./src/resources/extensions/gsd/tests/resolve-ts.mjs
  --experimental-strip-types <script>.mjs` importing the real exported
  symbols directly (no test framework required for an ad hoc probe; the
  `resolve-ts.mjs` loader is required so a `.js`-suffixed import resolves to
  its sibling `.ts` file, matching the project's own test convention).
- **Real subprocess (stdin/stdout scripts):** `spawnSync(process.execPath,
  ["--experimental-strip-types", scriptPath], { input: JSON.stringify(payload),
  cwd: freshTmpDir })` — mirrors the project's own
  `write-self-uat-enforcement.test.ts` `invoke()` helper. Always run with a
  fresh `mkdtempSync` cwd so writes never touch the real project tree.

## D4 — Observe (the four layers)

- (a) UI state/structure tree — N/A, no UI.
- (b) visual capture — N/A, no visual surface. Never reach for a screenshot
  on this platform; if a claim seems to need one, it is out of scope for a
  CLI/library phase.
- (c) runtime logs/errors — stdout/stderr from the invocation (rung 3):
  `spawnSync(...).stdout` / `.stderr`, exit `status`.
- (d) data/byte-level inspection — read the file(s) actually written to disk
  (`readFileSync`) and parse them through the project's own real parsers
  (`splitFrontmatter`, `extractFrontmatterVerdict`, etc.) where such parsers
  exist and are the artifact's documented consumer contract — OR, when
  falsifying that very parser pair is part of the claim, reimplement a
  minimal independent parse in the probe script so the check cannot share a
  bug with the code under test.

The ladder therefore tops out at **rung 3** (headless data/log checks) for
essentially all claims on this platform — rungs 4-5 (UI tree, visual
capture) do not apply. Coverage (rung 2) is `pnpm run typecheck:extensions`
plus reading the relevant `*.test.ts` file's case count before/after.

## D5 — Fixture/seed integrity + programmatic seeding

No shared fixture/database exists. Each probe invocation seeds its own
prerequisites inline as the JSON payload / function arguments passed to the
call under test — there is no setup road to walk via any "UI" (there is
none), so every invocation IS the Act on the SUT. Subprocess-writing scripts
MUST be invoked with a fresh `mkdtempSync` cwd per call so one probe's
on-disk output can never leak into or be mistaken for another's.

## D6 — Ladder commands

| Rung | Command |
|---|---|
| 0 | `pnpm run typecheck:extensions` |
| 1 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test <file>.test.ts` |
| 2 | Compare `ℹ tests N` in the rung-1 output against the pre-change count named in the plan's `<verify>` block |
| 3 | Ad hoc probe script per D3/D4(c)/(d) — real subprocess or in-process invocation with independently authored inputs, parsed via the real consumer functions (or an independently reimplemented parser when the parser itself is under test) |
| 4-5 | N/A on this platform |

## D7 — Gotchas

- Importing a `.ts` module directly with plain `node --experimental-strip-types`
  (no `--import resolve-ts.mjs`) fails on any `.js`-suffixed intra-repo import
  (`ERR_MODULE_NOT_FOUND`) because the source imports its siblings with a
  `.js` extension per ESM convention while the files on disk are `.ts`. Always
  load the project's `resolve-ts.mjs` import loader for in-process probes.
- A subprocess script that both imports a `.ts` module AND is invoked
  directly (not via the loader) still works IF the script's own import
  specifiers already resolve correctly under Node's native `.ts` extension
  resolution (this is `write-self-uat.mjs`'s case — it imports
  `../../extensions/gsd/verify-agentic-log.ts` with an explicit `.ts`
  suffix, so no loader is needed for that specific script).
- Never trust a shipped test file's own fixtures as the sole adversarial
  check — construct independent payloads/orderings/injection strings so a
  rubber-stamped assertion in the phase's own tests can't hide a defect.

## D8 — Target arbitration

N/A. No shared/physical target exists for this platform (no device, no
single-instance dev server) — every invocation is a fresh, independent
process.
