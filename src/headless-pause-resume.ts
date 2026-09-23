// Project/App: gsd-pi
// File Purpose: Host-side pause classification and the bounded resume
// decision for `gsd headless auto` (Phase 16, DRIVER-02). This is the seam
// `src/headless.ts` calls into so every branch condition is testable without
// spawning a process -- `headless.ts` itself holds only the state mutation
// and the re-prompt.
//
// Two things happen here, and neither substitutes for the other (this
// plan's prohibition names both):
//   1. `classifyHeadlessPause` adapts 16-04's `parsePauseKindFromNotice` --
//      it does not re-implement kind detection -- into a structured pause
//      description, additionally pulling the milestone/slice ids and an
//      optional Gate-2 entry id out of the producer's own reason text (the
//      one channel both real producers already travel: `for {mid}/{sid}`
//      and `(gate2-entry: {id})`), since no separate structured field exists
//      for them yet.
//   2. `decideHeadlessResume` enforces the SECOND bound this phase requires:
//      a maximum consecutive-resume count, evaluated BEFORE the DB-backed
//      resume condition ever runs. 16-04's `resolveResumeCondition()` alone
//      only refuses a resume that would change nothing (the
//      strictly-decreased-since-pause clause) -- it has no notion of "this
//      has already resumed N times." Without this count, a pathological
//      sequence where something changes on every cycle but never enough to
//      finish could resume forever, burning tokens overnight unattended.
//
// Never throws: `classifyHeadlessPause` is pure text parsing and
// `decideHeadlessResume` delegates every DB-touching branch to
// `resolveResumeCondition()`, which is itself never-throws (16-04).

import { EXIT_BLOCKED } from './headless-events.js'
import {
  resolveResumeCondition,
  type PauseContext,
} from './resources/extensions/gsd/run-pause-resume.js'
import {
  parsePauseKindFromNotice,
  stopNoticeDisplayReason,
  stripPauseKindMarker,
} from './resources/extensions/gsd/stop-notice.js'
import type { PauseKind } from './resources/extensions/gsd/types.js'

export interface ClassifiedPause {
  /** Never null -- an absent/malformed/unrecognised marker maps to `"human-decision"` (fail closed). */
  kind: PauseKind
  /** Operator-facing reason text, with the `Blocked:` prefix and the machine `[pause-kind: ...]` marker both stripped. */
  reason: string
  milestoneId: string | null
  sliceId: string | null
  /** Present only when the reason names a Gate-2 entry (certify-escalation pauses). */
  gate2EntryId: string | null
}

// Matches the `for {mid}/{sid}` fragment both real pause producers embed in
// their reason text (`rule-registry.ts`'s gap-closure-cap branch,
// `escalateCertifyGapsToGate2`'s certify-escalation reason). Stops before
// whitespace, `:`, or `(` so a trailing clause (`(max 3)`, `: N gap(s)...`)
// is never swallowed into the slice id.
const UNIT_REF_RE = /for\s+([^\s/]+)\/([^\s:()]+)/i

// Matches `(gate2-entry: {id})`, the marker `escalateCertifyGapsToGate2`
// appends after registering the Gate-2 row (16-04).
const GATE2_ENTRY_RE = /\(gate2-entry:\s*([^)]+)\)/i

/**
 * Classify a headless notice's message text into a pause kind (defaulting
 * unparseable/absent to `"human-decision"`, per 16-04's default-deny
 * contract) plus a cleaned display reason and the unit/Gate-2 identifiers
 * the resume condition needs. Does not touch the database and cannot throw.
 *
 * The `[pause-kind: ...]` marker is stripped from the display reason via
 * `stop-notice.ts`'s `stripPauseKindMarker` (WR-01, review of
 * 16-driver-ergonomics) -- NOT a locally re-declared copy of the pattern --
 * so a future change to the marker's wire format in `stop-notice.ts` (the
 * ONE owner of this vocabulary) propagates here automatically instead of
 * silently drifting out of sync.
 */
export function classifyHeadlessPause(noticeMessage: string | null | undefined): ClassifiedPause {
  const kind = parsePauseKindFromNotice(noticeMessage) ?? 'human-decision'
  const reason = stripPauseKindMarker(stopNoticeDisplayReason(noticeMessage)).trim()
  const unitMatch = UNIT_REF_RE.exec(reason)
  const gate2Match = GATE2_ENTRY_RE.exec(reason)
  return {
    kind,
    reason,
    milestoneId: unitMatch?.[1] ?? null,
    sliceId: unitMatch?.[2] ?? null,
    gate2EntryId: gate2Match?.[1]?.trim() ?? null,
  }
}

/**
 * The maximum number of consecutive resumes a single headless run may
 * perform. Exported so the test suite asserts against the exact value the
 * host uses rather than a duplicated literal. This bound and 16-04's
 * strictly-decreased-since-pause clause are BOTH required (this plan's
 * prohibition) -- neither alone stops every runaway shape: the decreased
 * clause refuses a resume that changes nothing on ONE cycle, this count
 * refuses a sequence where something changes on EVERY cycle but never
 * enough to finish.
 */
export const MAX_CONSECUTIVE_RESUMES = 5

export interface DecideHeadlessResumeInput {
  /** Whether the just-completed run ended blocked. */
  blocked: boolean
  exitCode: number
  pause: ClassifiedPause
  /**
   * The unresolved-blocking-gap-finding count captured AT PAUSE TIME
   * (`recordHeadlessRunPause`'s return value) -- never re-captured here, so
   * a caller can call `decideHeadlessResume` more than once against the
   * SAME pause and still compare against the original snapshot. `null` for
   * any kind other than `gap-closure-cap`, or when no milestone/slice could
   * be resolved from the notice.
   */
  unresolvedAtPause: number | null
  /** How many consecutive resumes this run has already performed. */
  resumeCount: number
  /** The consecutive-resume bound -- pass `MAX_CONSECUTIVE_RESUMES`. */
  max: number
  basePath: string
}

/**
 * The bounded resume decision. Evaluates cheap refusals first, the
 * DB-backed resume condition last:
 *   1. Not blocked, or not `EXIT_BLOCKED` -- a clean completion is never
 *      treated as a pause, regardless of kind.
 *   2. `resumeCount >= max` -- the consecutive-resume bound, named in the
 *      reason so an operator reading the run-log sees WHY an otherwise-safe
 *      pause stopped resuming.
 *   3. Otherwise, delegate unchanged to `resolveResumeCondition()` -- the
 *      swappable slot, never `defaultResumeCondition` directly (D-03
 *      Runtime Decision #3) -- which performs the actual DB-derived
 *      readiness check for the two named safe kinds and default-denies
 *      everything else.
 */
export function decideHeadlessResume(input: DecideHeadlessResumeInput) {
  if (!input.blocked || input.exitCode !== EXIT_BLOCKED) {
    return { resume: false, reason: 'the run did not end in a blocked state -- nothing to resume' }
  }
  if (input.resumeCount >= input.max) {
    return {
      resume: false,
      reason: `consecutive-resume bound reached (${input.max}) -- refusing to resume further to avoid a runaway unattended loop`,
    }
  }
  const pauseContext: PauseContext = {
    kind: input.pause.kind,
    milestoneId: input.pause.milestoneId ?? '',
    sliceId: input.pause.sliceId ?? '',
    ...(input.pause.gate2EntryId ? { gate2EntryId: input.pause.gate2EntryId } : {}),
    ...(input.unresolvedAtPause !== null ? { snapshot: { unresolvedAtPause: input.unresolvedAtPause } } : {}),
  }
  return resolveResumeCondition()(input.basePath, pauseContext)
}
