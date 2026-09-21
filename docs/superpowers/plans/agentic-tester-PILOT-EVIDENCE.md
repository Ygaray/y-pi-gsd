<!-- Project/App: gsd-pi -->
<!-- File Purpose: Phase 8 pilot verification evidence for the ported agentic-tester (TEST-09). -->

# Agentic Tester Port — Pilot Evidence (Phase 8 / TEST-09)

This document proves that Phases 5 through 7's ported `agentic-tester` was exercised live —
across the CLI, browser, and Android surfaces — by real dispatched `agentic-tester` children
driven through the actual `/gsd verify-agentic` command with real OpenRouter/DeepSeek tokens,
not by unit tests alone. Phase 7's own test suite could only prove the right dispatch prompt was
constructed and sent; it could not prove a spawned child actually drove a surface, graded a
criterion, and wrote its result through the guarded `write-self-uat.mjs` path. This document is
authored by the orchestrator (per D-03) from three durable artifacts each pilot run produced: a
`.gsd/verify-agentic/*-SELF-UAT.md` log, a captured `--mode rpc` event stream under
`/tmp/y-pi-gsd-pilot/`, and the executing plan's own `SUMMARY.md`. The `agentic-tester` child
itself never touches this file — its Write scope stays confined to `.gsd/verify-agentic/`, which
is what keeps the diagnose-only gate a plain full-repo `git status --porcelain` delta with no
per-run path carve-outs.

## Per-surface summary

| Surface | Known-good verdict | Known-bad verdict | Root cause (tight) | Guarded write path | Diagnose-only delta | SELF-UAT log |
| --- | --- | --- | --- | --- | --- | --- |
| CLI | PASS | FAIL | Criterion anchored to an event name (`turn_complete`) the `--mode json` emitter never uses; the harness's real completion event is `turn_end` | Yes — via `write-self-uat.mjs` | 0 new lines | `cli-pilot-2026-09-20T20-28-06Z-SELF-UAT.md` |
| Browser | PASS | FAIL | Document title metadata is set to the literal string `GSD` in `web/app/layout.tsx`; `GSD Dashboard` is never rendered | Yes — via `write-self-uat.mjs` | 0 new lines | `browser-pilot-2026-09-21T00-46-20Z-SELF-UAT.md` |
| Android | PASS | FAIL | ClockPackage's stock four-tab surface (Alarm, World clock, Stopwatch, Timer) has no Metronome entry point at all | Yes — via `write-self-uat.mjs` | 0 new lines | `android-pilot-2026-09-20T21-27-42Z-SELF-UAT.md` |

### CLI surface

**Dispatch command (RPC mode — the invocation recipe this plan established and 08-02/08-03 reused).**
The credential was exported by reading the key file, never as a literal value:
`export OPENROUTER_API_KEY="$(cat ~/.config/y-pi-gsd/openrouter.key)"`. The prompt was then
submitted as `{ printf '%s\n' "$RPC_CMD"; sleep 1800; } | node dist/bootstrap.js --mode rpc --model openrouter/deepseek/deepseek-v4.1-flash > /tmp/y-pi-gsd-pilot/pilot-cli-run.json 2> /tmp/y-pi-gsd-pilot/pilot-cli-run.stderr`,
where `$RPC_CMD` was the JSONL line
`{"id":"1","type":"prompt","message":"/gsd verify-agentic cli-pilot --surface cli --criteria \"KNOWN-GOOD: running the built harness as node dist/bootstrap.js --print --mode json --no-session with the single prompt say OK exits with status 0 and its stdout contains a JSON line whose type field is agent_end || KNOWN-BAD: that same stdout contains a JSON line whose type field is exactly turn_complete\""}`.

**Invocation mode.** The plan's literal `--print --mode json` command was tried first and exited
cleanly after only `message_start`/`message_end` events — zero `subagent` calls, no SELF-UAT file
— because print mode fires `pi.sendMessage(...,{triggerTurn:true})` unawaited and exits before the
turn (and any subagent dispatch inside it) can finish. Per the plan's own STEP 4 contingency, the
identical prompt was re-run through RPC mode (JSONL prompt on stdin, process held open, polled for
`agent_end`), which completed in ~370s and produced a genuine 375-line event stream. This RPC
recipe is what 08-02 and 08-03 reused directly (08-01-SUMMARY.md, "Invocation mode that worked").

**Known-good:** "running the built harness as `node dist/bootstrap.js --print --mode json --no-session`
with the single prompt "say OK" exits with status 0 and its stdout contains a JSON line whose
`type` field is `agent_end`." — **verdict: PASS**.

**Known-bad:** "that same stdout contains a JSON line whose `type` field is exactly `turn_complete`."
— **verdict: FAIL**. Root cause quoted verbatim from the log's `root_cause:` line: "the harness's
actual per-turn completion event is `turn_end` (line 10), followed by the run-terminating
`agent_end` (line 11)... the mismatch is in the criterion's vocabulary, not in an unreachable or
crashed surface (exit 0, stderr empty, model reply "OK" present)." This known-bad is subtle and
non-crash per D-01: the harness behaves completely normally (exit 0, empty stderr, real model
reply) and fails the criterion purely because the criterion names an event token the emitter never
produced — there is no error, crash, or exception anywhere in the run for the checker to latch
onto instead.

**SELF-UAT log and guarded-write evidence:** `.gsd/verify-agentic/cli-pilot-2026-09-20T20-28-06Z-SELF-UAT.md`.
The header byte-matches `renderSelfUat`'s exact emitted shape (`# SELF-UAT — cli-pilot` /
`target:` / `surface:` / `timestamp:` / `log location:`). The captured stream shows
`write-self-uat.mjs` genuinely invoked through the child's `bash` tool (44 occurrences in
`/tmp/y-pi-gsd-pilot/pilot-cli-run.json`), and a real `subagent` tool call fired (121 occurrences)
(08-01-SUMMARY.md).

**Diagnose-only delta:** `comm -13` between the pre-dispatch and post-dispatch full-repo
`git status --porcelain` snapshots produced zero new lines. The repository's pre-existing
`web/next-env.d.ts` dirty line was present in both snapshots and is therefore not part of any
delta (08-01-SUMMARY.md).

### Browser surface

**Dispatch command (RPC mode, the same recipe as CLI/Android, carrying the `PI_GSD_BROWSER_TOOLS=1`
opt-in per 08-07's handoff).** Credential exported by reading the key file, never as a literal:
`export OPENROUTER_API_KEY="$(cat ~/.config/y-pi-gsd/openrouter.key)"`; `export
PI_GSD_BROWSER_TOOLS=1` was also exported for this dispatch — 08-07's own live probe recorded
needing it for the tool to be advertised to the model at all. Prompt submitted as
`{ cat rpc-browser-rerun-cmd.json; sleep 1800; } | node dist/bootstrap.js --mode rpc --model openrouter/deepseek/deepseek-v4.1-flash > /tmp/y-pi-gsd-pilot/pilot-browser-rerun-run.json 2> /tmp/y-pi-gsd-pilot/pilot-browser-rerun-run.stderr`,
where the JSONL prompt line was
`{"id":"1","type":"prompt","message":"/gsd verify-agentic browser-pilot --surface browser --criteria \"KNOWN-GOOD: navigating to http://127.0.0.1:4173 renders a document whose title is exactly GSD || KNOWN-BAD: that same rendered document title is exactly GSD Dashboard\""}`.
The `web/` dashboard was served first via
`node dist/bootstrap.js --web --host 127.0.0.1 --port 4173`, confirmed ready on the first readiness
poll (1s).

**Invocation mode.** RPC mode was used directly (the recipe already proven by CLI/Android and by
08-02's own browser-surface dispatch). A real `subagent` tool call fired on the first attempt — no
STEP 4 retry needed (132 occurrences of `"subagent"` in the stream, `agent_end` reached after
~280s). STEP 2's preflight (`/gsd extensions info browser-tools`) again needed the same
print-to-RPC substitution 08-02 established; the RPC-mode form confirmed `browser-tools` `enabled`,
`bundled` tier, with its full `browser_*` tool list declared, before any credential was exported.

**Known-good:** "navigating to http://127.0.0.1:4173 renders a document whose title is exactly
`GSD`." — **verdict: PASS**. Evidence quoted from the log: `browser_navigate` to
`http://127.0.0.1:4173` reported `'Title: GSD'`; a `browser_evaluate` read of the live DOM returned
`{"title":"GSD","titleTag":"GSD","url":"http://127.0.0.1:4173/"}`; an independent `curl` of the
same URL cross-confirmed `<title>GSD</title>`; the log additionally records build provenance (the
`next-server` listener's PID, cwd, and start time, plus a `find web -type f -newer
dist/web/standalone/server.js` check returning nothing), ruling out a stale-code server.

**Known-bad:** "that same rendered document title is exactly `GSD Dashboard`." — **verdict: FAIL**.
Root cause quoted verbatim from the log's `root_cause:` line: "Observed document.title = \"GSD\";
expected exactly \"GSD Dashboard\". Proximate cause: the served application sets its document
title metadata to the literal string \"GSD\" (declared in web/app/layout.tsx metadata.title), so
the emitted <title> text is \"GSD\" and the string \"GSD Dashboard\" is never rendered." This
known-bad is subtle and non-crash per D-01: the page loads and renders completely normally (the
same `browser_navigate`/`browser_evaluate` reads that proved the known-good criterion also settle
this one), `GSD Dashboard` is a plausible-looking title for this app, and only the actual DOM
read — never a crash, error, or timeout — falsifies it.

**SELF-UAT log and guarded-write evidence:**
`.gsd/verify-agentic/browser-pilot-2026-09-21T00-46-20Z-SELF-UAT.md`. The header byte-matches
`renderSelfUat`'s exact PASS/FAIL shape (`# SELF-UAT — browser-pilot` / `target:` / `surface:` /
`timestamp:` / `log location:`), and contains exactly two `### ` criterion blocks (one `verdict:
PASS`, one `verdict: FAIL`). The string `write-self-uat.mjs` appears 58 times in the captured
stream, but — unlike 08-02's halt log, where every occurrence was SKILL/prompt narration — this
run's stream contains a genuine `bash` tool_call event (`call_c506fa2e825c4de695b51ec5`) whose
`arguments.command` field literally invokes `node --experimental-strip-types
src/resources/skills/agentic-tester/write-self-uat.mjs` piped the completed-run payload on stdin:
the guarded write path was genuinely exercised, not narrated around.

**Diagnose-only delta:** `comm -13` between the pre-dispatch and post-dispatch full-repo
`git status --porcelain` snapshots produced zero new lines; the pre-existing `web/next-env.d.ts`
dirty line was present in both `pilot-browser-rerun-before.txt` and `pilot-browser-rerun-after.txt`
and is excluded from the delta by construction, exactly as for every prior surface. The `--web`
server's parent PID had already exited on its own by the time Task 1 reached STEP 5 (matching the
08-02/08-05/08-07 precedent); the separate `next-server` child was located via `ss -tlnp` and
stopped directly, and port 4173 was confirmed free.

**Superseded history — the original 08-02 halt.** The 08-02 run halted at Preflight with
`browser_*` tools uncallable in the dispatched session
(`.gsd/verify-agentic/browser-pilot-2026-09-20T20-41-03Z-SELF-UAT.md`, recorded in this document's
prior revision and preserved unmodified on disk); `08-VERIFICATION.md` scored the phase 2/3 on
exactly that gap, and both criteria were recorded as UNVERIFIED — never a graded FAIL and never a
dispatch failure smoothed over as a pass. TWO independent source defects had to be fixed before a
re-dispatch could mean anything: `.planning/phases/08-pilot-verification/08-05-SUMMARY.md` fixed
the `session_start` fire-and-forget registration in
`src/resources/extensions/browser-tools/index.ts` (commit `10441800`), but its own live probe
still showed the tool absent from the model's advertised tool set; then
`.planning/phases/08-pilot-verification/08-07-SUMMARY.md` fixed the second, cross-cutting defect in
`packages/gsd-agent-core/src/session/agent-session-extensions.ts`'s `refreshToolRegistry()` (commit
`39cae891`), whose newly-registered-tool detection never activated a tool registered lazily inside
`session_start`, and live-proved a real `browser_navigate` call ("Title: GSD") with zero
tool-registry misses. This run (`.planning/phases/08-pilot-verification/08-06-SUMMARY.md`) is the
re-dispatch against that twice-fixed tree, carrying `PI_GSD_BROWSER_TOOLS=1` per 08-07's handoff.
Deleting the prior failure is prohibited — a document that erases its own history is not evidence.

### Android surface

**Dispatch command (RPC mode, the same recipe as CLI).** Credential exported by reading the key
file, never as a literal: `export OPENROUTER_API_KEY="$(cat ~/.config/y-pi-gsd/openrouter.key)"`.
Prompt submitted as
`{ printf '%s\n' "$RPC_CMD"; sleep 1800; } | node dist/bootstrap.js --mode rpc --model openrouter/deepseek/deepseek-v4.1-flash > /tmp/y-pi-gsd-pilot/pilot-android-run.json 2> /tmp/y-pi-gsd-pilot/pilot-android-run.stderr`,
where `$RPC_CMD` was
`{"id":"1","type":"prompt","message":"/gsd verify-agentic android-pilot --surface android --criteria \"KNOWN-GOOD: after launching com.sec.android.app.clockpackage/.ClockPackage on the wired tester serial R5CT10XNKQN, a fresh uiautomator view-hierarchy dump contains a node whose text attribute is exactly Stopwatch || KNOWN-BAD: that same fresh view-hierarchy dump contains a node whose text attribute is exactly Metronome\""}`.

**Invocation mode.** RPC mode was used directly (reused verbatim from the CLI-surface recipe). The
first attempt hung for 24+ minutes because the hand-constructed JSONL prompt file lacked a
trailing newline — RPC mode's line-buffered stdin reader never saw a complete line, so the
dispatched process stayed alive at ~0.2% CPU emitting only periodic notification churn, with no
`response`/`agent_start` event ever appearing. This was a self-authored bug (Rule 1), not a product
defect: the file was regenerated with `JSON.stringify(obj) + "\n"`, byte-verified via `xxd` to end
in `0a`, and redispatched — the corrected run was acknowledged within 5 seconds and reached
`agent_end` in ~175s (08-03-SUMMARY.md).

**Known-good:** "after launching `com.sec.android.app.clockpackage/.ClockPackage` on the wired
tester serial R5CT10XNKQN, a fresh uiautomator view-hierarchy dump contains a node whose text
attribute is exactly Stopwatch." — **verdict: PASS**.

**Known-bad:** "that same fresh view-hierarchy dump contains a node whose text attribute is exactly
Metronome." — **verdict: FAIL**. Root cause quoted verbatim from the log's `root_cause:` line:
"the string is not renderable in this surface at all -- ClockPackage versionName 12.4.10.10
(versionCode 1241010100, targetSdk 35) exposes its main surface as a four-tab pager with no
Metronome entry point, so no node carrying that text can exist in any dump of this activity. The
probe detected this correctly: the same exact-match mechanism returned 1 hit for the known-present
Stopwatch, so the 0-hit result is a true negative rather than a broken probe." This known-bad is
subtle and non-crash per D-01, and deliberately more rigorous than a crash-only check: the Clock
app launches and runs completely normally throughout (cold-launch status `ok`, correct focus, no
error dialog), and only a complete, non-truncated, case-insensitive scan of the entire dump — cross
validated against a positive-control exact match on the same file — falsifies the claim. This is
exactly the invariant D-01 required for Android specifically: proving adb-driven observation
catches a subtle wrong-state condition, not merely the absence of a crash.

**SELF-UAT log and guarded-write evidence:** `.gsd/verify-agentic/android-pilot-2026-09-20T21-27-42Z-SELF-UAT.md`.
The header byte-matches `renderSelfUat`'s exact shape (`# SELF-UAT — android-pilot` / `target:` /
`surface:` / `timestamp:` / `log location:`), contains exactly two `### ` criterion blocks. The
captured stream shows `write-self-uat.mjs` genuinely invoked (50 occurrences in
`/tmp/y-pi-gsd-pilot/pilot-android-run.json`) and a real `subagent` tool call fired (46
occurrences) (08-03-SUMMARY.md).

**Diagnose-only delta:** `comm -13` between the pre-dispatch and post-dispatch full-repo
`git status --porcelain` snapshots produced zero new lines; `web/next-env.d.ts` was present in
both and excluded from the delta (08-03-SUMMARY.md).

One disambiguated false positive is recorded here for completeness rather than silently dropped:
the plan's own literal grep for any `adb` invocation lacking `-s` over the raw captured stream
printed 18, not the scripted 0. 08-03's investigation traced all 18 matches to the same sentence,
repeated across streaming `partialResult` deltas, in which the dispatched child's own reasoning
paraphrases `drivers/android.md`'s already-`-s`-scoped example command while narrating the
playbook — not an actual executed `bash` tool_call. Filtering the stream to `toolName=="bash"`
events found zero unscoped `adb` invocations. This is a literal-verify-script limitation
(matching raw narration text rather than structured tool-call fields), not a genuine device-safety
violation, and is recorded transparently rather than force-passed.

### Android driver safety check

This entry is **distinct from the two graded PASS/FAIL criteria above** — it is not one of them
and is not counted toward the Android surface's known-good/known-bad pair. It records the D-02
serial-allowlist identity confirmation and the airplane-mode/tailscale-restore proof, captured
verbatim to `/tmp/y-pi-gsd-pilot/android-safety-check.txt`.

**Serial-allowlist identity.** A fresh (not cached) `adb devices -l` listing matched the
allowlisted serial exactly: `R5CT10XNKQN            device usb:1-5 product:b0qsqw model:SM_S908U device:b0q transport_id:9`
(plus its wireless mirror `100.118.21.106:1496    device product:b0qsqw model:SM_S908U device:b0q transport_id:10`).
The transcript states plainly: "The personal handset at 100.126.94.47 (yahirs-s22-ultra) was NOT
targeted by any command in this phase; only R5CT10XNKQN (yahirs-s22-ultra-2, wired tester) was
targeted, and only via explicit -s."

**Airplane-mode toggle and restore.** `airplane_mode_on` read `0` at baseline, `1` after
`adb -s R5CT10XNKQN shell cmd connectivity airplane-mode enable`, then `0` again after
`adb -s R5CT10XNKQN shell cmd connectivity airplane-mode disable`. Tailscale was relaunched
(`adb -s R5CT10XNKQN shell monkey -p com.tailscale.ipn 1`), the wireless port was re-armed
(`adb -s R5CT10XNKQN tcpip 1496`), and the wireless link was reconnected
(`adb connect 100.118.21.106:1496` — already connected).

**All three restore confirmations.** (1) `airplane_mode_on` reads `0`. (2)
`adb devices` lists `100.118.21.106:1496` in `device` state alongside `R5CT10XNKQN`. (3)
`tailscale ping -c 1 100.118.21.106` answered: "pong from yahirs-s22-ultra-2 (100.118.21.106) via
192.168.2.191:46640 in 34ms." All three signals were confirmed within seconds, well inside the
plan's 60-second allowance.

The toggle is permitted on this wired tester alone because USB adb survives an airplane-mode
cycle (only wifi/tailscale drops, which the transcript's own restore sequence re-arms) — it is
never permitted on the personal handset, which was never targeted by any command in this phase.

## Findings

- **AR-07-02 / T-07-11 backstop is now closed by observation for all three surfaces.** CLI,
  Android, and Browser dispatched children have each written genuine, uncontrolled
  model-generated PASS/FAIL content through the guarded `write-self-uat.mjs` → `renderSelfUat`
  path. For CLI and Android this rests on the existence of a genuine PASS/FAIL SELF-UAT log on
  disk (44 and 50 stream occurrences of `write-self-uat.mjs` respectively) — which could only be
  produced by the guarded script actually running (08-01-SUMMARY.md, 08-03-SUMMARY.md). For
  Browser, 08-02's original dispatch left this backstop **open** (its halt log went through the
  separate, SKILL.md-documented halt-persistence `write` tool instead, and all 40 stream mentions
  of `write-self-uat.mjs` were narration); 08-06's re-dispatch closes it: of the 58 stream mentions
  of `write-self-uat.mjs`, at least one is a genuine `bash` tool_call
  (`call_c506fa2e825c4de695b51ec5`) whose `arguments.command` literally invokes the script with the
  completed-run payload — the same disambiguation method (`toolName=="bash"` filtering) 08-01 and
  08-03 relied on for CLI and Android (08-06-SUMMARY.md).
- **TEST-09 is now fully satisfied.** CLI, Android, and Browser are each proven end to end
  (known-good PASS, known-bad FAIL with a tight root cause, guarded write confirmed, zero
  diagnose-only drift, zero credential leakage). The browser surface — genuinely blocked at 08-02,
  and still blocked after 08-05's registration-timing fix alone — is unblocked following 08-07's
  registry-propagation fix (commit `39cae891`) and this plan's (08-06) re-dispatch: real
  `browser_navigate`/`browser_evaluate` tool-call events (144 occurrences in the re-run stream),
  zero tool-registry misses, and a graded PASS/FAIL SELF-UAT log
  (`browser-pilot-2026-09-21T00-46-20Z-SELF-UAT.md`).
- **Every run required at least one deviation, all recorded honestly, none silently retried away:**
  the CLI surface's main dispatch needed the plan's own anticipated print-to-RPC fallback; the
  browser surface's STEP 2 preflight command independently needed the same print-to-RPC
  substitution in both 08-02 and 08-06 (each run's main dispatch succeeded on the first attempt);
  the Android surface's first dispatch attempt hung for 24+ minutes on a self-authored
  missing-trailing-newline bug, fixed and redispatched successfully. 08-06's browser re-dispatch
  itself needed zero source-level deviations — its only in-scope finding was operational (see
  below).
- **Root-cause hypothesis for the browser blocker — now fixed and live-proven.** 08-02's bounded,
  read-only investigation (not fully pinned to a single line) hypothesized
  `src/resources/extensions/browser-tools/index.ts`'s `session_start` hook firing
  `registerBrowserTools()` as `void`, fire-and-forget, whenever `ctx.hasUI` is true. 08-05 fixed
  exactly that (commit `10441800`) but its own live probe still showed the tool absent, surfacing a
  second, independent defect in `packages/gsd-agent-core/src/session/agent-session-extensions.ts`'s
  `refreshToolRegistry()` — its newly-registered-tool comparison was computed after the registry
  rebuild it was supposed to detect, making the incremental-activation branch a permanent no-op.
  08-07 fixed that (commit `39cae891`) and live-proved a real `browser_navigate` call. 08-06's
  re-dispatch is the end-to-end confirmation that both fixes together restore the browser surface
  to full pilot-grade evidence.
- **Android surface's literal unscoped-adb verify check printed 18, not 0** — disambiguated as
  narration text paraphrasing the driver playbook's own already-scoped example, not an actual
  executed command; zero real `bash` tool_call events contained an unscoped `adb` invocation. This
  is a verify-script limitation, not a device-safety violation, and is recorded here rather than
  hidden.
- **08-06 found a pre-existing, unrelated process-hygiene bug: the RPC-mode dispatch process from
  08-02's original browser-pilot run was still alive ~4h10m later**, still appending
  notification-churn heartbeat events to `/tmp/y-pi-gsd-pilot/pilot-browser-run.json` (growing it
  from the 408 lines 08-02 analyzed to 1390 lines by the time 08-06 discovered and killed it). This
  is append-only growth of trailing heartbeat noise — the original 408-line evidentiary content
  08-02's own analysis rests on is preserved as an exact byte-prefix (single `>`-redirected stdout,
  sequential writes only) — and it carries no criterion/verdict content of its own, so none of this
  document's CLI or historical Browser claims are affected. Several sibling orphaned processes from
  08-02/08-05/08-07's other diagnostic probes were found still running too; only the one actively
  writing to a file this document cites was stopped, the rest are logged as deferred, out-of-scope
  hygiene work (see `.planning/phases/08-pilot-verification/deferred-items.md`, 08-06-SUMMARY.md).
- **Diagnose-only invariant held across all four pilot-verification runs** (08-01 CLI, 08-02
  browser halt, 08-03 Android, 08-06 browser re-dispatch). Every before/after full-repo
  `git status --porcelain` delta was zero new lines; the pre-existing `web/next-env.d.ts` dirty
  line was present in every snapshot pair and excluded from every delta by construction.
- **Zero credential leakage across all four pilot-verification runs.** A grep for the OpenRouter
  key's literal prefix (the same pattern this document's AUDIT 3 and its automated verify script
  scan this document itself for — not reproduced here to avoid a self-match) across every SELF-UAT
  log and every capture file (stdout and stderr, all runs including 08-06's re-dispatch) returned 0
  matching files.

## Local Verification

Targeted commands run in `/home/yahir/Projects/yahir-agentic-tools/y-pi-gsd`:

```bash
# Phase 7 guard/dispatch-routing suite -- re-confirms no drift before trusting anything above
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/write-self-uat-enforcement.test.ts \
  src/resources/extensions/gsd/tests/verify-agentic-log.test.ts \
  src/resources/extensions/gsd/tests/commands-verify-agentic.test.ts \
  src/resources/extensions/gsd/tests/integration/commands-verify-agentic.integration.test.ts

# SELF-UAT header shape reads (CLI + Android + the browser re-dispatch byte-match renderSelfUat;
# the superseded 08-02 browser halt log differs by design, per its own halt-persistence rule)
head -6 .gsd/verify-agentic/cli-pilot-2026-09-20T20-28-06Z-SELF-UAT.md
head -6 .gsd/verify-agentic/android-pilot-2026-09-20T21-27-42Z-SELF-UAT.md
head -8 .gsd/verify-agentic/browser-pilot-2026-09-20T20-41-03Z-SELF-UAT.md
head -6 .gsd/verify-agentic/browser-pilot-2026-09-21T00-46-20Z-SELF-UAT.md

# Confirm the guarded write-self-uat.mjs script was genuinely invoked (CLI, Android, and the
# browser re-dispatch; the count alone is not proof — see 08-06-SUMMARY.md for how the genuine
# bash tool_call invocation was disambiguated from narration mentions in the browser stream)
grep -c 'write-self-uat.mjs' /tmp/y-pi-gsd-pilot/pilot-cli-run.json
grep -c 'write-self-uat.mjs' /tmp/y-pi-gsd-pilot/pilot-android-run.json
grep -c 'write-self-uat.mjs' /tmp/y-pi-gsd-pilot/pilot-browser-rerun-run.json

# Diagnose-only delta re-derivation (expect 0 new lines for all four runs)
comm -13 <(sort /tmp/y-pi-gsd-pilot/pilot-cli-before.txt) <(sort /tmp/y-pi-gsd-pilot/pilot-cli-after.txt)
comm -13 <(sort /tmp/y-pi-gsd-pilot/pilot-browser-before.txt) <(sort /tmp/y-pi-gsd-pilot/pilot-browser-after.txt)
comm -13 <(sort /tmp/y-pi-gsd-pilot/pilot-android-before.txt) <(sort /tmp/y-pi-gsd-pilot/pilot-android-after.txt)
comm -13 <(sort /tmp/y-pi-gsd-pilot/pilot-browser-rerun-before.txt) <(sort /tmp/y-pi-gsd-pilot/pilot-browser-rerun-after.txt)

# Repository's own secret scanner -- covers credential leakage across the whole repo and
# requires no manual substitution, unlike the targeted AUDIT-3 grep documented below.
pnpm run secret-scan
```

The one command in this document that is **not** copy-paste-runnable as printed is the targeted
credential-leak grep this plan's Task 2 AUDIT 3 and its automated verify script used to scan this
document and every capture file. Its pattern is the OpenRouter key's literal prefix, deliberately
not spelled out anywhere in this file (not even assigned to a shell variable) so that scanning this
document does not self-match. To re-derive that specific result, first substitute the real prefix
string from AUDIT 3 for `<openrouter-key-prefix-see-AUDIT-3>` below, then run:

```bash
grep -rc '<openrouter-key-prefix-see-AUDIT-3>' \
  .gsd/verify-agentic/cli-pilot-2026-09-20T20-28-06Z-SELF-UAT.md \
  .gsd/verify-agentic/browser-pilot-2026-09-20T20-41-03Z-SELF-UAT.md \
  .gsd/verify-agentic/browser-pilot-2026-09-21T00-46-20Z-SELF-UAT.md \
  .gsd/verify-agentic/android-pilot-2026-09-20T21-27-42Z-SELF-UAT.md \
  /tmp/y-pi-gsd-pilot/pilot-cli-run.json /tmp/y-pi-gsd-pilot/pilot-cli-run.stderr \
  /tmp/y-pi-gsd-pilot/pilot-browser-run.json /tmp/y-pi-gsd-pilot/pilot-browser-run.stderr \
  /tmp/y-pi-gsd-pilot/pilot-browser-rerun-run.json /tmp/y-pi-gsd-pilot/pilot-browser-rerun-run.stderr \
  /tmp/y-pi-gsd-pilot/pilot-android-run.json /tmp/y-pi-gsd-pilot/pilot-android-run.stderr
```

Run as literally printed above (without substitution), this command greps for a placeholder string
that cannot appear anywhere and reports 0 matches -- a no-op, not a working scan. It is left out of
the primary block above for exactly that reason.
