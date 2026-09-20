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
| Browser | UNVERIFIED (halted at Preflight) | UNVERIFIED (halted at Preflight) | `browser_*` tools returned "Tool `<name>` not found" in the dispatched session; neither criterion was ever evaluated | No — halt log written via the child's own `write` tool per SKILL.md Step 6, not through `write-self-uat.mjs` | 0 new lines | `browser-pilot-2026-09-20T20-41-03Z-SELF-UAT.md` |
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

**Dispatch command (RPC mode, the same recipe as CLI).** Credential exported by reading the key
file, never as a literal: `export OPENROUTER_API_KEY="$(cat ~/.config/y-pi-gsd/openrouter.key)"`.
Prompt submitted as
`{ printf '%s\n' "$RPC_CMD"; sleep 1800; } | node dist/bootstrap.js --mode rpc --model openrouter/deepseek/deepseek-v4.1-flash > /tmp/y-pi-gsd-pilot/pilot-browser-run.json 2> /tmp/y-pi-gsd-pilot/pilot-browser-run.stderr`,
where `$RPC_CMD` was
`{"id":"1","type":"prompt","message":"/gsd verify-agentic browser-pilot --surface browser --criteria \"KNOWN-GOOD: navigating to http://127.0.0.1:4173 renders a document whose title is exactly GSD || KNOWN-BAD: that same rendered document title is exactly GSD Dashboard\""}`.
The `web/` dashboard was served first via
`node dist/bootstrap.js --web --host 127.0.0.1 --port 4173`.

**Invocation mode.** The main dispatch used RPC mode directly (the CLI-surface recipe was already
proven) and fired a real `subagent` tool call on the first attempt — no retry needed (151
occurrences of `"subagent"` in the stream). A separate command, the plan's STEP 2 preflight
(`--print --mode json --no-session '/gsd extensions info browser-tools'`), needed its own
print-to-RPC substitution: print mode's `session.subscribe` never forwards the
`ctx.ui.notify()`-backed `extension_ui_request` channel that `/gsd extensions info` uses, so it
produced only a session header line. The RPC-mode equivalent of that same command confirmed
`browser-tools` was `enabled`, `bundled` tier, with its full `browser_*` tool list declared
(08-02-SUMMARY.md).

**Both criteria: UNVERIFIED — halted at Step 2 (Preflight), no PASS or FAIL recorded for either.**
This is not a graded outcome and this document does not record it as one. The dispatched child
attempted `browser_navigate` (26 tool-call attempts), `browser_screenshot` (24), and
`browser_get_page_source` (23) in the captured stream — real tool-call events, not prose mentions
— and every one failed at the tool-registry layer. Per the browser driver's halt-and-persist rule
it correctly declined to substitute `curl` output or the `gsd-browser` MCP fallback (which was
itself gated behind interactive trust approval it could not grant from a non-interactive child)
as rendered-title evidence, and halted rather than fabricate a verdict.

Root cause quoted verbatim from the log's `root_cause:` block: "All three `browser_*` tool
invocations returned "Tool `<name>` not found"; the gsd-browser MCP fallback returned an
interactive-trust refusal... The spawned agentic-tester session was presented a tool surface that
omitted the browser-tools extension tools, even though the agent frontmatter `tools:` line
declares them and the extension is built... and the manifest is present." The `gap_closure_route`
recommended next action, quoted as prose (not a patch): "Fix the dispatch surface so the browser
driver can actually be driven, then re-dispatch this exact verification. Concretely: ensure the
browser-tools extension is enabled and its `browser_*` tools are actually presented to the spawned
agentic-tester child before any browser-surface verification is dispatched."

This is a genuine, reproducible halt at a real product defect, not a graded FAIL and not a
dispatch failure smoothed over as a pass. 08-02's bounded (read-only, no source touched)
investigation root-caused it, without fully pinning it, to
`src/resources/extensions/browser-tools/index.ts`'s `session_start` hook firing
`registerBrowserTools()` fire-and-forget (`void ...`, never awaited) whenever `ctx.hasUI` is true —
true for both a plain top-level RPC session and a dispatched subagent child — with no readiness
signal the dispatching parent can observe from outside the process. MCP-trust gating and a simple
registration-timing race were both ruled out (an explicit 16-second pre-prompt wait, exceeding the
managed engine's own 10-second daemon-connect budget, still produced no browser tools).

**SELF-UAT log and guarded-write evidence:** `.gsd/verify-agentic/browser-pilot-2026-09-20T20-41-03Z-SELF-UAT.md`.
This log's header does **not** match `renderSelfUat`'s PASS/FAIL shape (`# SELF-UAT — browser-pilot
(browser surface)` / `target:` / `surface:` / `driver_playbook:` / `skill:` / `run_outcome: halted`)
— by design, per `SKILL.md:153-157`'s documented halt-persistence rule for a Steps 1-3 halt. The
log was written through the child's own `write` tool, **not** through the guarded
`write-self-uat.mjs` script — the guarded script is reserved for completed runs with per-criterion
results to validate, which this run never reached. The string `write-self-uat.mjs` appears 40
times in the captured stream, but 08-02's investigation confirmed every occurrence is prompt/SKILL
narration text describing the script, not an actual `bash` tool_call invoking it. This is the
correct, plan-anticipated path for a genuine Preflight halt, not a guard bypass and not the
`AR-07-02`/`T-07-11` risk materializing.

**Diagnose-only delta:** `comm -13` between the pre-dispatch and post-dispatch full-repo
`git status --porcelain` snapshots produced zero new lines; `web/next-env.d.ts` was present in
both and excluded from the delta (08-02-SUMMARY.md). The `--web` server's `next-server` child
process (which the parent PID's `kill` did not terminate on the first attempt) was located and
stopped separately, and port 4173 was confirmed free before Task 2 of that plan began.

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

- **AR-07-02 / T-07-11 backstop is closed by observation for the CLI and Android surfaces only.**
  Both surfaces' dispatched children wrote genuine, uncontrolled model-generated PASS/FAIL content
  through the guarded `write-self-uat.mjs` → `renderSelfUat` path (44 and 50 stream occurrences of
  `write-self-uat.mjs` respectively, both confirmed as real `bash` tool_call invocations, not
  narration). The backstop remains **open** for the browser surface: its child never reached the
  guarded write path at all — its halt log went through the separate, SKILL.md-documented
  halt-persistence `write` tool, which was never exercised by Phase 7's own tests.
- **TEST-09 is not fully satisfied.** CLI and Android are proven end to end (known-good PASS,
  known-bad FAIL with a tight root cause, guarded write confirmed, zero diagnose-only drift, zero
  credential leakage). The browser surface is genuinely blocked: `browser-tools` extension tools
  never became callable in any live GSD session during this run — confirmed in both the dispatched
  `agentic-tester` child and a plain top-level RPC session with no subagent involved at all, even
  after an explicit 16-second pre-prompt wait. This is recorded here as a real product defect, not
  smoothed over as a partial pass.
- **Every run required at least one deviation, all recorded honestly, none silently retried away:**
  the CLI surface's main dispatch needed the plan's own anticipated print-to-RPC fallback; the
  browser surface's STEP 2 preflight command independently needed the same print-to-RPC
  substitution (its main dispatch succeeded on the first attempt); the Android surface's first
  dispatch attempt hung for 24+ minutes on a self-authored missing-trailing-newline bug, fixed and
  redispatched successfully.
- **Root-cause hypothesis for the browser blocker** (bounded, read-only investigation; not fully
  pinned to a single line): `src/resources/extensions/browser-tools/index.ts`'s `session_start`
  hook fires `registerBrowserTools()` as `void`, fire-and-forget, whenever `ctx.hasUI` is true —
  true for both RPC-mode top-level sessions and subagent children — with no readiness signal the
  dispatching parent or child can observe from outside the process. MCP-trust gating on the managed
  `gsd-browser` engine and a simple registration-timing race were both ruled out.
- **Android surface's literal unscoped-adb verify check printed 18, not 0** — disambiguated as
  narration text paraphrasing the driver playbook's own already-scoped example, not an actual
  executed command; zero real `bash` tool_call events contained an unscoped `adb` invocation. This
  is a verify-script limitation, not a device-safety violation, and is recorded here rather than
  hidden.
- **Diagnose-only invariant held across all three runs.** Every before/after full-repo
  `git status --porcelain` delta was zero new lines; the pre-existing `web/next-env.d.ts` dirty
  line was present in every snapshot pair and excluded from every delta by construction.
- **Zero credential leakage across all three runs.** A grep for the OpenRouter key's literal
  prefix (the same pattern this plan's Task 2 AUDIT 3 and its automated verify script scan this
  document itself for — not reproduced here to avoid a self-match) across every SELF-UAT log and
  every capture file (stdout and stderr, all three surfaces) returned 0 matching files.

## Local Verification

Targeted commands run in `/home/yahir/Projects/yahir-agentic-tools/y-pi-gsd`:

```bash
# Phase 7 guard/dispatch-routing suite -- re-confirms no drift before trusting anything above
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/write-self-uat-enforcement.test.ts \
  src/resources/extensions/gsd/tests/verify-agentic-log.test.ts \
  src/resources/extensions/gsd/tests/commands-verify-agentic.test.ts \
  src/resources/extensions/gsd/tests/integration/commands-verify-agentic.integration.test.ts

# SELF-UAT header shape reads (CLI + Android byte-match renderSelfUat; browser differs by design)
head -6 .gsd/verify-agentic/cli-pilot-2026-09-20T20-28-06Z-SELF-UAT.md
head -6 .gsd/verify-agentic/android-pilot-2026-09-20T21-27-42Z-SELF-UAT.md
head -8 .gsd/verify-agentic/browser-pilot-2026-09-20T20-41-03Z-SELF-UAT.md

# Confirm the guarded write-self-uat.mjs script was genuinely invoked (CLI + Android only)
grep -c 'write-self-uat.mjs' /tmp/y-pi-gsd-pilot/pilot-cli-run.json
grep -c 'write-self-uat.mjs' /tmp/y-pi-gsd-pilot/pilot-android-run.json

# Diagnose-only delta re-derivation (expect 0 new lines for all three surfaces)
comm -13 <(sort /tmp/y-pi-gsd-pilot/pilot-cli-before.txt) <(sort /tmp/y-pi-gsd-pilot/pilot-cli-after.txt)
comm -13 <(sort /tmp/y-pi-gsd-pilot/pilot-browser-before.txt) <(sort /tmp/y-pi-gsd-pilot/pilot-browser-after.txt)
comm -13 <(sort /tmp/y-pi-gsd-pilot/pilot-android-before.txt) <(sort /tmp/y-pi-gsd-pilot/pilot-android-after.txt)

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
  .gsd/verify-agentic/android-pilot-2026-09-20T21-27-42Z-SELF-UAT.md \
  /tmp/y-pi-gsd-pilot/pilot-cli-run.json /tmp/y-pi-gsd-pilot/pilot-cli-run.stderr \
  /tmp/y-pi-gsd-pilot/pilot-browser-run.json /tmp/y-pi-gsd-pilot/pilot-browser-run.stderr \
  /tmp/y-pi-gsd-pilot/pilot-android-run.json /tmp/y-pi-gsd-pilot/pilot-android-run.stderr
```

Run as literally printed above (without substitution), this command greps for a placeholder string
that cannot appear anywhere and reports 0 matches -- a no-op, not a working scan. It is left out of
the primary block above for exactly that reason.
