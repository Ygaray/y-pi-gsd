#!/usr/bin/env node
/**
 * GSD Test Suite Watchdog
 *
 * Zero-dependency supervisor for a long-running opaque command (the ~18k-test unit suite, or
 * any other long-running child). Spawns the command as a tracked child, samples its process
 * tree's CPU time / stdout+stderr byte growth / descendant count on a bounded cadence,
 * classifies liveness via the pure `classifyLiveness` decision function in
 * `./lib/test-suite-watchdog-core.mjs`, kills only a genuinely stalled tree, and always
 * propagates the child's real exit code — a red child never surfaces as a green wrapper
 * (GREEN-01, the exact masking defect 19-06-SUMMARY.md flagged).
 *
 * Usage:
 *   node scripts/test-suite-watchdog.mjs [options] -- <command> [args...]
 *
 * Options:
 *   --verdict <path>       Verdict JSON output path (default: .gsd/watchdog/verdict.json)
 *   --log <path>           Combined child stdout+stderr tee (default: .gsd/watchdog/run.log)
 *   --label <str>          Label echoed into the verdict (default: the joined command)
 *   --poll-ms <ms>         Sampling cadence (default: DEFAULTS.pollMs)
 *   --stall-cap-ms <ms>    Quiet-time cap before a stalled tree is killed (default: DEFAULTS.stallCapMs)
 *   --hard-cap-ms <ms>     Absolute wall-clock cap regardless of liveness (default: DEFAULTS.hardCapMs)
 *
 * Diagnostic rule: the CPU-vs-output liveness rule this watchdog operationalizes is documented
 * once, in full, at docs/dev/test-suite-quarantine.md §5 ("Runtime expectations") — this file
 * only implements it; see that doc for the underlying rationale and the measured legitimate
 * quiet windows the caps above must clear.
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname } from 'node:path';

import { DEFAULTS, classifyLiveness } from './lib/test-suite-watchdog-core.mjs';

// ─── Argument parsing ────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const sepIdx = rawArgs.indexOf('--');
if (sepIdx === -1 || rawArgs.slice(sepIdx + 1).length === 0) {
  process.stderr.write(
    'Usage: node scripts/test-suite-watchdog.mjs [options] -- <command> [args...]\n',
  );
  process.exit(2);
}
const optionArgs = rawArgs.slice(0, sepIdx);
const commandArgs = rawArgs.slice(sepIdx + 1);

function getArg(flag, defaultVal) {
  const idx = optionArgs.indexOf(flag);
  return idx !== -1 && optionArgs[idx + 1] !== undefined ? optionArgs[idx + 1] : defaultVal;
}

const verdictPath = getArg('--verdict', '.gsd/watchdog/verdict.json');
const logPath = getArg('--log', '.gsd/watchdog/run.log');
const label = getArg('--label', commandArgs.join(' '));
const pollMs = Number(getArg('--poll-ms', String(DEFAULTS.pollMs)));
const stallCapMs = Number(getArg('--stall-cap-ms', String(DEFAULTS.stallCapMs)));
const hardCapMs = Number(getArg('--hard-cap-ms', String(DEFAULTS.hardCapMs)));
const thresholds = { stallCapMs, hardCapMs };

mkdirSync(dirname(verdictPath), { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });

// ─── ps sampling helpers ─────────────────────────────────────────────────────

/**
 * Parse `[[DD-]HH:]MM:SS` (the `ps -o cputime=` shape) into milliseconds.
 * Returns null when unparseable.
 */
function parseCputimeMs(raw) {
  let rest = raw;
  let days = 0;
  const dashIdx = rest.indexOf('-');
  if (dashIdx !== -1) {
    days = Number(rest.slice(0, dashIdx));
    rest = rest.slice(dashIdx + 1);
  }
  const parts = rest.split(':').map(Number);
  let hours = 0;
  let minutes;
  let seconds;
  if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
  } else if (parts.length === 2) {
    [minutes, seconds] = parts;
  } else {
    return null;
  }
  if ([days, hours, minutes, seconds].some((n) => !Number.isFinite(n))) return null;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * Parse `ps -eo pid=,ppid=,cputime=` stdout into `{ pid, ppid, cpuMs }[]`, skipping any line
 * that does not match the expected shape (defensive — feeds T-22-05's inconclusive-sample path).
 */
function parsePsRows(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) continue;
    const cpuMs = parseCputimeMs(match[3]);
    if (cpuMs === null) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpuMs });
  }
  return rows;
}

/**
 * Walk the process tree from `rootPid` transitively over the parsed `ps` rows. Returns null
 * when `rootPid` is not present in the current snapshot (treated as an inconclusive sample by
 * the caller — never as "the tree is empty").
 */
function walkDescendants(rows, rootPid) {
  const byPid = new Map();
  const childrenByPpid = new Map();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const siblings = childrenByPpid.get(row.ppid) ?? [];
    siblings.push(row.pid);
    childrenByPpid.set(row.ppid, siblings);
  }
  if (!byPid.has(rootPid)) return null;
  const visited = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const kid of childrenByPpid.get(pid) ?? []) {
      if (!visited.has(kid)) {
        visited.add(kid);
        queue.push(kid);
      }
    }
  }
  let cpuMsTotal = 0;
  for (const pid of visited) cpuMsTotal += byPid.get(pid).cpuMs;
  return { cpuMsTotal, descendantCount: visited.size - 1 };
}

// ─── Spawn the supervised command ────────────────────────────────────────────

const [command, ...commandRest] = commandArgs;
// detached: true puts the child in its own process group so a stall kill can reach the whole
// tree via `process.kill(-child.pid, ...)`. child.pid is the ONLY authoritative kill root —
// never a process-name or command-string match (T-22-01).
const child = spawn(command, commandRest, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});

if (child.pid === undefined) {
  writeFileSync(
    verdictPath,
    JSON.stringify({ label, command, argv: commandArgs, spawnFailed: true }, null, 2),
  );
  process.exit(2);
}

const startedAt = Date.now();
let outputBytes = 0;
let psFailures = 0;
let sampleCount = 0;
let prevCpuMsTotal = 0;
let prevOutputBytes = 0;
let quietMsElapsed = 0;
let lastSampleAt = startedAt;
let lastVerdict = null;
let killedAs = null; // "stalled" | "hard-cap" | null
let cpuMsTotalAtEnd = 0;
let finished = false;

function tee(chunk) {
  appendFileSync(logPath, chunk);
  outputBytes += chunk.length;
}
child.stdout.on('data', (chunk) => {
  tee(chunk);
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  tee(chunk);
  process.stderr.write(chunk);
});

function killChildTree(reason, sample) {
  const reasonLine =
    `[watchdog] ${reason} — quietMsElapsed=${sample.quietMsElapsed} ` +
    `totalMsElapsed=${sample.totalMsElapsed} descendantCount=${sample.descendantCount}\n`;
  appendFileSync(logPath, reasonLine);
  process.stderr.write(reasonLine);
  killedAs = reason;
  try {
    // Process-group signal — reaches only descendants of the tracked child.pid, never a
    // name/command-string match (T-22-01).
    process.kill(-child.pid, 'SIGKILL');
  } catch (err) {
    if (err?.code !== 'ESRCH') {
      // Group signal failed for a reason other than "already gone" — fall back to a direct
      // signal on the tracked handle itself.
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* best effort — child may already be gone */
    }
  }
}

/** One liveness sample: run `ps`, classify, update running state. Called immediately at spawn
 * (so a short-lived child still yields >=1 sample) and then on every `--poll-ms` tick. */
function sampleTick() {
  const now = Date.now();
  const elapsedSinceLast = now - lastSampleAt;
  const totalMsElapsed = now - startedAt;
  lastSampleAt = now;

  // Hard cap is checked FIRST and unconditionally, before the `ps`-dependent sampling below,
  // so a persistently failing sampler (missing `ps` binary, non-POSIX host, permission issue,
  // or a momentarily-invisible root pid) can never suppress it — this is the absolute
  // wall-clock ceiling the docs promise "regardless of liveness" (CR-01 / GREEN-01 /
  // INC-2026-09-20-01).
  if (totalMsElapsed >= thresholds.hardCapMs) {
    killChildTree('hard-cap', {
      cpuMsDelta: 0,
      outputBytesDelta: 0,
      descendantCount: 0,
      quietMsElapsed,
      totalMsElapsed,
    });
    return;
  }

  const psResult = spawnSync('ps', ['-eo', 'pid=,ppid=,cputime='], {
    encoding: 'utf8',
    timeout: 5000,
  });
  const rows = psResult.status === 0 && psResult.stdout ? parsePsRows(psResult.stdout) : [];
  const tree = rows.length > 0 ? walkDescendants(rows, child.pid) : null;
  if (!tree) {
    // Inconclusive sample (ps failed, or the root pid was momentarily absent from the
    // snapshot) — never advances the quiet timer, so a broken sampler cannot manufacture a
    // stall verdict (T-22-05). The hard cap above still bounds the run regardless of how many
    // consecutive samples are inconclusive (CR-01).
    psFailures += 1;
    return;
  }
  const cpuMsDelta = tree.cpuMsTotal - prevCpuMsTotal;
  const outputBytesDelta = outputBytes - prevOutputBytes;
  const sample = {
    cpuMsDelta,
    outputBytesDelta,
    descendantCount: tree.descendantCount,
    quietMsElapsed,
    totalMsElapsed,
  };
  const verdict = classifyLiveness(sample, thresholds);
  lastVerdict = verdict;
  sampleCount += 1;
  prevCpuMsTotal = tree.cpuMsTotal;
  prevOutputBytes = outputBytes;
  cpuMsTotalAtEnd = tree.cpuMsTotal;
  quietMsElapsed = verdict === 'progressing' ? 0 : quietMsElapsed + elapsedSinceLast;

  if (verdict === 'stalled' || verdict === 'hard-cap') {
    killChildTree(verdict, sample);
  }
}

sampleTick();
const pollTimer = setInterval(sampleTick, pollMs);

function writeVerdictAtomic(verdict) {
  const tmpPath = `${verdictPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(verdict, null, 2));
  renameSync(tmpPath, verdictPath);
}

function finalize(code, signal) {
  if (finished) return;
  finished = true;
  clearInterval(pollTimer);
  const endedAt = Date.now();
  const finalVerdict = killedAs ?? lastVerdict ?? 'exited';
  const stalled = finalVerdict === 'stalled' || finalVerdict === 'hard-cap';

  writeVerdictAtomic({
    label,
    command,
    argv: commandArgs,
    pid: child.pid,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    exitCode: code,
    signal,
    stalled,
    verdict: finalVerdict,
    quietMsAtEnd: quietMsElapsed,
    cpuMsTotal: cpuMsTotalAtEnd,
    outputBytes,
    samples: sampleCount,
    psFailures,
    logPath,
    thresholds,
  });

  // Never assign 0 for any outcome other than a child that itself exited 0 — a masked exit
  // code is the defect this plan exists to prevent (GREEN-01, T-22-03).
  if (killedAs === 'stalled') {
    process.exitCode = DEFAULTS.stallExitCode;
  } else if (killedAs === 'hard-cap') {
    process.exitCode = DEFAULTS.hardCapExitCode;
  } else if (code !== null && code !== undefined) {
    process.exitCode = code;
  } else if (signal) {
    const signalNumber = osConstants.signals[signal];
    process.exitCode = signalNumber ? 128 + signalNumber : 1;
  } else {
    process.exitCode = 1;
  }
}

child.on('exit', (code, signal) => finalize(code, signal));
child.on('error', (err) => {
  appendFileSync(logPath, `[watchdog] child process error: ${err.message}\n`);
  finalize(null, null);
});

function forwardAndExit(sig) {
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* best effort */
    }
  }
  finalize(null, sig);
  process.exit(process.exitCode ?? 1);
}
process.on('SIGINT', () => forwardAndExit('SIGINT'));
process.on('SIGTERM', () => forwardAndExit('SIGTERM'));
