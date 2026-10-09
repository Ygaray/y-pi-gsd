// Project/App: gsd-pi
// File Purpose: HANDOFF-01 body — pure tests for buildHandoffBody: the five-section structure
// yahir-handoff's template requires, HANDOFF.md folding (heading demotion, fence balance,
// gotcha routing), size caps, sanitization and redaction. No I/O.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildHandoffBody,
  buildHandoffTitle,
  demoteHeadings,
  oneLine,
  HANDOFF_BODY_MAX_BYTES,
  HANDOFF_NOTES_MAX_BYTES,
  HANDOFF_SECTIONS,
  HANDOFF_TITLE_MAX,
} from "../handoff-body.ts";
import type { HandoffBodyInput } from "../handoff-body.ts";

const NOW = new Date("2026-10-09T10:00:00.000Z");
const MTIME = "2026-10-08T21:30:00.000Z";
const HEADINGS = HANDOFF_SECTIONS.map((s) => `## ${s}`);

function input(overrides: Partial<HandoffBodyInput> = {}): HandoffBodyInput {
  return {
    source: "pause-work",
    projectName: "proj",
    milestone: null,
    slice: null,
    task: null,
    phase: null,
    nextAction: null,
    blockers: [],
    recentDecisions: [],
    paused: null,
    autoActiveAtRegistration: false,
    notes: null,
    now: NOW,
    ...overrides,
  };
}

const FULL = (): HandoffBodyInput =>
  input({
    source: "pause",
    milestone: { id: "M001", title: "Handoff wiring" },
    slice: { id: "S01", title: "Pause side" },
    task: { id: "T01", title: "Register" },
    phase: "executing",
    nextAction: "Execute T01",
    blockers: ["Waiting on the CLI contract"],
    recentDecisions: ["Use runtime_kv for the record"],
    paused: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      pausedAt: "2026-10-09T09:55:00.000Z",
      pauseReason: "user pause",
      stepMode: false,
      worktreePath: "/tmp/wt",
    },
  });

/** Mirrors yahir-handoff template.py parse_sections (fences respected). */
function parseSections(body: string): { order: string[]; text: Record<string, string>; extraHeadings: string[] } {
  const order: string[] = [];
  const text: Record<string, string> = {};
  const extraHeadings: string[] = [];
  const canon = new Map(HANDOFF_SECTIONS.map((s) => [s.toLowerCase(), s]));
  let fenced: string | null = null;
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (cur !== null) text[cur] = buf.join("\n").trim();
  };
  for (const line of body.split("\n")) {
    const fm = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fm) {
      const [, mark, rest] = fm;
      if (fenced === null) {
        if (mark[0] !== "`" || !rest.includes("`")) fenced = mark;
      } else if (mark[0] === fenced[0] && mark.length >= fenced.length && rest.trim() === "") {
        fenced = null;
      }
    }
    const m = fenced ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    const name = m ? canon.get(m[1].trim().toLowerCase()) : undefined;
    if (m && !name) extraHeadings.push(line);
    if (name) {
      flush();
      order.push(name);
      cur = name;
      buf = [];
    } else if (cur !== null) {
      buf.push(line);
    }
  }
  flush();
  return { order, text, extraHeadings };
}

function assertValid(body: string, label: string): void {
  const lines = body.split("\n");
  for (const h of HEADINGS) assert.equal(lines.filter((l) => l === h).length, 1, `${label}: exactly one "${h}" line`);
  assert.deepEqual(
    lines.filter((l) => l.startsWith("## ")),
    HEADINGS,
    `${label}: only the five canonical headings, in order`,
  );
  const parsed = parseSections(body);
  assert.deepEqual(parsed.order, [...HANDOFF_SECTIONS], `${label}: template parse finds the five sections in order`);
  for (const s of HANDOFF_SECTIONS) assert.notEqual((parsed.text[s] ?? "").trim(), "", `${label}: ${s} is non-empty`);
  assert.ok(Buffer.byteLength(body, "utf-8") <= HANDOFF_BODY_MAX_BYTES, `${label}: within the body cap`);
}

test("HANDOFF-01 body: every input combination yields the five canonical sections once, in order, each non-empty", () => {
  const hostileNotes = [
    "## Goal",
    "x",
    "## State",
    "y",
    "## Next steps",
    "z",
    "## Open decisions",
    "## Gotchas",
    "```",
    "~~~ts",
    "unclosed",
  ].join("\n");
  const combos: Record<string, HandoffBodyInput> = {
    empty: input(),
    full: FULL(),
    stepMode: { ...FULL(), paused: { ...FULL().paused!, stepMode: true } },
    hostileNotes: { ...FULL(), notes: { text: hostileNotes, mtime: MTIME } },
    hugeNotes: { ...FULL(), notes: { text: "line\n".repeat(8000), mtime: MTIME } },
    manyBlockers: { ...FULL(), blockers: Array.from({ length: 40 }, (_, i) => `blocker ${i} ${"b".repeat(900)}`) },
    headingInBlocker: { ...FULL(), blockers: ["## Goal", "```", "# x"], nextAction: "## Gotchas" },
  };
  for (const [label, inp] of Object.entries(combos)) assertValid(buildHandoffBody(inp).body, label);
});

test("HANDOFF-01 body: a secret-shaped value in the title inputs is redacted from the title and the body (WR-02)", () => {
  const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const input = { ...FULL(), milestone: { id: "M001", title: `Rotate ${secret}` } };
  const title = buildHandoffTitle(input);
  assert.ok(!title.includes(secret));
  assert.ok(title.includes("«redacted»"));
  const built = buildHandoffBody(input);
  assert.ok(!built.title.includes(secret));
  assert.ok(!built.body.includes(secret));
});

test("HANDOFF-01 body: full state with a paused session names the unit, the resume commands and a bounded title", () => {
  const { title, body } = buildHandoffBody(FULL());
  const state = parseSections(body).text["State"];
  assert.ok(state.includes("execute-task"));
  assert.ok(state.includes("M001/S01/T01"));
  assert.ok(state.includes("2026-10-09T09:55:00.000Z"));
  const next = parseSections(body).text["Next steps"];
  assert.ok(next.includes("/gsd resume-work"));
  assert.ok(next.includes("/gsd auto"));
  assert.ok(next.includes("Execute T01"));
  assert.equal(title, "y-pi-gsd paused: M001/S01/T01 — Handoff wiring");
  assert.ok(title.length <= HANDOFF_TITLE_MAX);
  assert.equal(buildHandoffTitle(FULL()), title);
  assert.ok(parseSections(body).text["Goal"].startsWith(title));
  assert.ok(parseSections(body).text["Open decisions"].includes("Waiting on the CLI contract"));
  assert.ok(state.includes("Use runtime_kv for the record"));
});

test("HANDOFF-01 body: step mode resumes through /gsd next", () => {
  const f = FULL();
  const { body } = buildHandoffBody({ ...f, paused: { ...f.paused!, stepMode: true } });
  const next = parseSections(body).text["Next steps"];
  assert.ok(next.split("\n")[0].includes("/gsd next"), "resume line re-enters /gsd next");
  assert.ok(!next.split("\n")[0].includes("/gsd auto"));
});

test("HANDOFF-01 body: no paused session and empty state falls back to the project name and canonical state", () => {
  const { title, body } = buildHandoffBody(input({ projectName: "my-proj" }));
  assert.equal(title, "y-pi-gsd paused: my-proj");
  const parsed = parseSections(body);
  assert.ok(parsed.text["Goal"].includes("my-proj"));
  assert.equal(parsed.text["Open decisions"], "None recorded.");
  assert.equal(parsed.text["Gotchas"], "None recorded.");
  assert.ok(parsed.text["Next steps"].includes("resumes from canonical project state"));
});

test("HANDOFF-01 body: auto-mode active at registration is stated in State", () => {
  const { body } = buildHandoffBody(input({ autoActiveAtRegistration: true }));
  assert.ok(parseSections(body).text["State"].includes("auto-mode was active at registration"));
  const quiet = buildHandoffBody(input());
  assert.ok(!quiet.body.includes("auto-mode was active at registration"));
});

test("HANDOFF-01 body: folded notes cannot create a canonical heading - headings are demoted and labelled with the mtime", () => {
  const { body } = buildHandoffBody({ ...FULL(), notes: { text: "## State\nfoo\n# Big\n### Small", mtime: MTIME } });
  assert.equal(body.split("\n").filter((l) => l === "## State").length, 1);
  for (const demoted of ["#### State", "#### Big", "#### Small"]) assert.ok(body.split("\n").includes(demoted), demoted);
  const state = parseSections(body).text["State"];
  assert.ok(state.includes(`Notes from .gsd/HANDOFF.md (last written ${MTIME}`));
  assert.ok(state.includes("may predate this pause"));
  assert.equal(demoteHeadings("## A\ntext\n   ### B\n####### not a heading"), "#### A\ntext\n#### B\n####### not a heading");
  assert.equal(
    demoteHeadings("## A\n```sh\n## build\n```\n## B\n~~~\n# c\n~~~"),
    "#### A\n```sh\n## build\n```\n#### B\n~~~\n# c\n~~~",
    "headings inside closed code fences are left alone (IN-02)",
  );
  assert.equal(demoteHeadings("```\n## open\nno closer"), "```\n#### open\nno closer", "an unclosed fence is not protected");
});

test("HANDOFF-01 body: an unclosed fence in the notes is closed before the next section", () => {
  const { body } = buildHandoffBody({ ...FULL(), notes: { text: "before\n```ts\nconst a = 1;\n## State\nstill code", mtime: MTIME } });
  const lines = body.split("\n");
  const nextAt = lines.indexOf("## Next steps");
  const fencesBefore = lines.slice(0, nextAt).filter((l) => /^\s*(```|~~~)/.test(l)).length;
  assert.equal(fencesBefore % 2, 0, "fence lines before Next steps are balanced");
  assertValid(body, "unclosed fence");
  const tilde = buildHandoffBody({ ...FULL(), notes: { text: "~~~\nopen tilde fence\n## Gotchas", mtime: MTIME } });
  assertValid(tilde.body, "unclosed tilde fence");
});

test("HANDOFF-01 body: gotcha-like notes sections are routed to Gotchas with a staleness line", () => {
  const notes = "## Progress\nall good\n## Gotchas\nwatch the flaky test\n## Caveats\nthe cache is stale\n## Misc\nother";
  const { body } = buildHandoffBody({ ...FULL(), notes: { text: notes, mtime: MTIME } });
  const gotchas = parseSections(body).text["Gotchas"];
  assert.ok(gotchas.includes("watch the flaky test"));
  assert.ok(gotchas.includes("the cache is stale"));
  assert.ok(!gotchas.includes("all good"), "non-gotcha sections stay out of Gotchas");
  assert.ok(gotchas.includes(`last written ${MTIME}`));
  assert.ok(gotchas.includes("#### Gotchas") && gotchas.includes("#### Caveats"), "routed headings are demoted");
  assert.ok(parseSections(body).text["State"].includes("all good"), "the whole notes text is still folded into State");
});

test("HANDOFF-01 body: caps - notes excerpt at 6 KiB with a truncation marker, whole body at 12 KiB", () => {
  const big = Array.from({ length: 1000 }, (_, i) => `note line ${i} ${"n".repeat(18)}`).join("\n");
  assert.ok(Buffer.byteLength(big) > 20 * 1024 - 2000);
  const { body } = buildHandoffBody({ ...FULL(), notes: { text: big, mtime: MTIME } });
  const state = parseSections(body).text["State"];
  const excerpt = state.slice(state.indexOf("Notes from .gsd/HANDOFF.md"));
  assert.ok(Buffer.byteLength(excerpt, "utf-8") <= HANDOFF_NOTES_MAX_BYTES, "excerpt within 6 KiB");
  assert.ok(excerpt.includes("[truncated]"));
  assertValid(body, "big notes");

  const blockers = [("x".repeat(10 * 1024)), ...Array.from({ length: 30 }, (_, i) => `b${i} ${"y".repeat(400)}`)];
  const heavy = buildHandoffBody({ ...FULL(), blockers, notes: { text: big, mtime: MTIME } });
  assert.ok(Buffer.byteLength(heavy.body, "utf-8") <= HANDOFF_BODY_MAX_BYTES);
  assertValid(heavy.body, "heavy blockers");
  assert.ok(parseSections(heavy.body).text["Next steps"].includes("/gsd resume-work"));
});

test("HANDOFF-01 body: a hostile pause reason is sanitized to one short line", () => {
  const f = FULL();
  const { body } = buildHandoffBody({
    ...f,
    paused: { ...f.paused!, pauseReason: "\u001b[31mboom\u001b[0m\r\u0007" + "tail ".repeat(400) },
  });
  assert.ok(!/[\u001b\r\u0007]/.test(body), "no ESC, CR or BEL");
  const reasonLine = body.split("\n").find((l) => l.startsWith("- Pause reason:"));
  assert.ok(reasonLine, "pause reason line present");
  assert.ok(reasonLine!.includes("boom"));
  assert.ok(reasonLine!.slice("- Pause reason: ".length).length <= 300);
});

test("HANDOFF-01 body: secrets in notes and state are redacted", () => {
  const key = "sk-ant-" + "A1b2C3d4E5".repeat(3);
  const notes = `token = 'abcdefgh12345678'\nuse ${key} for the call`;
  const { body } = buildHandoffBody({ ...FULL(), nextAction: `rotate ${key}`, notes: { text: notes, mtime: MTIME } });
  assert.ok(!body.includes("abcdefgh12345678"));
  assert.ok(!body.includes(key));
  assert.ok(body.includes("«redacted»"));
});

test("HANDOFF-01 body: an oversized milestone title is cut to a single-line title of at most 100 characters", () => {
  const long = "T".repeat(300);
  const { title, body } = buildHandoffBody(input({ milestone: { id: "M009", title: long } }));
  assert.ok(title.length <= HANDOFF_TITLE_MAX);
  assert.ok(title.startsWith("y-pi-gsd"));
  assert.ok(!title.includes("\n"));
  assert.equal(parseSections(body).text["Goal"].split("\n")[0], title);
});

test("HANDOFF-01 body: Next steps always carries at least one step line the template counts", () => {
  for (const inp of [input(), FULL()]) {
    const { body } = buildHandoffBody(inp);
    const steps = parseSections(body).text["Next steps"].split("\n").filter((l) => /^\s*(\d+[.)]|[-*+])\s+\S/.test(l));
    assert.ok(steps.length >= 2);
  }
});

test("HANDOFF-01 body: the builder is deterministic for the same input", () => {
  const a = buildHandoffBody({ ...FULL(), notes: { text: "## Gotchas\nx", mtime: MTIME } });
  const b = buildHandoffBody({ ...FULL(), notes: { text: "## Gotchas\nx", mtime: MTIME } });
  assert.deepEqual(a, b);
});

test("HANDOFF-01 body: char cuts never leave half of a surrogate pair (IN-04)", () => {
  const smile = "\u{1F600}";
  const cut = oneLine("a" + smile.repeat(10), 3); // slice(0, 2) would end inside the first emoji
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut), `no lone high surrogate: ${JSON.stringify(cut)}`);
  assert.ok(cut.endsWith("…"));
  assert.equal(oneLine("short", 10), "short");
});
