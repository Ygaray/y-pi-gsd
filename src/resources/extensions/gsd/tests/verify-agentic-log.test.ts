/**
 * Unit tests for the SELF-UAT log formatter (`verify-agentic-log.ts`).
 *
 * `src/resources/skills/agentic-tester/SKILL.md` Step 6 is the contract under
 * test: the per-criterion block shape, the FAIL guards (Task 2), and the
 * prose-only gap-closure guard (D-02, Task 2). Organized one `describe` per
 * exported function, mirroring `commands-eval-review.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PATCH_MARKER_PATTERN,
  SELF_UAT_LOG_DIR_RELATIVE,
  SELF_UAT_SUFFIX,
  SelfUatRenderError,
  aggregateSelfUat,
  isSelfUatResult,
  isSelfUatVerdict,
  renderSelfUat,
  selfUatLogFileName,
  type SelfUatCriterionResult,
  type SelfUatMeta,
} from "../verify-agentic-log.js";
import { splitFrontmatter } from "../../shared/frontmatter.js";
import { extractFrontmatterVerdict } from "../verdict-parser.js";

const BASE_META: SelfUatMeta = {
  target: "S07",
  surface: "cli",
  timestampIso: "2026-09-20T12:00:00.000Z",
};

// Build patch-marker fixtures via explicit character construction rather than
// pasting the raw markers inline, so no fixture is mistaken for real diff
// content when this file is read or grepped (per Task 2's action text).
const BACKTICK = String.fromCharCode(96);
function fencedDiffBlock(): string {
  return [BACKTICK, BACKTICK, BACKTICK, "diff", "\n", "+line", "\n", BACKTICK, BACKTICK, BACKTICK].join("");
}
function fencedPatchBlock(): string {
  return [BACKTICK, BACKTICK, BACKTICK, "patch", "\n", "+line", "\n", BACKTICK, BACKTICK, BACKTICK].join("");
}
function unifiedDiffHeaderLine(): string {
  return ["+", "+", "+", " a/file.ts"].join("");
}
function hunkRangeLine(): string {
  return ["@", "@", " -1,5 +1,5 @@"].join("");
}
function indexHeaderLine(): string {
  return ["Index", ":", " file.ts"].join("");
}

// ─── renderSelfUat: happy-path render contract (Task 1) ───────────────────────

describe("renderSelfUat", () => {
  it("renders a per-criterion block with heading, verdict, and evidence lines for a PASS", () => {
    const results: SelfUatCriterionResult[] = [
      { criterion: "user can log in", verdict: "PASS", evidence: "exit 0, stdout: ok" },
    ];
    const doc = renderSelfUat(results, BASE_META);
    assert.match(doc, /^### 1\. user can log in$/m);
    assert.match(doc, /^verdict: PASS$/m);
    assert.match(doc, /^evidence: exit 0, stdout: ok$/m);
  });

  it("names meta.target, meta.surface, and meta.timestampIso in the header", () => {
    const results: SelfUatCriterionResult[] = [
      { criterion: "c", verdict: "PASS", evidence: "e" },
    ];
    const doc = renderSelfUat(results, BASE_META);
    assert.match(doc, new RegExp(BASE_META.target));
    assert.match(doc, new RegExp(BASE_META.surface));
    assert.match(doc, new RegExp(BASE_META.timestampIso.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("names the .gsd/verify-agentic/ log location in the header", () => {
    const results: SelfUatCriterionResult[] = [
      { criterion: "c", verdict: "PASS", evidence: "e" },
    ];
    const doc = renderSelfUat(results, BASE_META);
    assert.match(doc, /\.gsd\/verify-agentic\//);
  });

  it("numbers results one-based and increments per result", () => {
    const results: SelfUatCriterionResult[] = [
      { criterion: "first", verdict: "PASS", evidence: "e1" },
      { criterion: "second", verdict: "PASS", evidence: "e2" },
      { criterion: "third", verdict: "PASS", evidence: "e3" },
    ];
    const doc = renderSelfUat(results, BASE_META);
    assert.match(doc, /^### 1\. first$/m);
    assert.match(doc, /^### 2\. second$/m);
    assert.match(doc, /^### 3\. third$/m);
  });

  it("renders a root_cause line for a FAIL with a non-empty rootCause", () => {
    const results: SelfUatCriterionResult[] = [
      {
        criterion: "c",
        verdict: "FAIL",
        evidence: "exit 1, stderr: ENOENT",
        rootCause: "exit 1, stderr: ENOENT — the binary was never built",
      },
    ];
    const doc = renderSelfUat(results, BASE_META);
    assert.match(doc, /^root_cause: exit 1, stderr: ENOENT — the binary was never built$/m);
  });

  it("renders a gap_closure line for a FAIL with a gapClosureRoute", () => {
    const results: SelfUatCriterionResult[] = [
      {
        criterion: "c",
        verdict: "FAIL",
        evidence: "exit 1, stderr: ENOENT",
        rootCause: "exit 1, stderr: ENOENT — the binary was never built",
        gapClosureRoute: "Rebuild and re-run; see src/bootstrap.ts",
      },
    ];
    const doc = renderSelfUat(results, BASE_META);
    assert.match(doc, /^gap_closure: Rebuild and re-run; see src\/bootstrap\.ts$/m);
  });

  it("renders no root_cause line for a PASS", () => {
    const results: SelfUatCriterionResult[] = [
      { criterion: "c", verdict: "PASS", evidence: "e" },
    ];
    const doc = renderSelfUat(results, BASE_META);
    assert.doesNotMatch(doc, /^root_cause: /m);
  });

  it("renders a visible no-criteria marker for an empty results array without throwing", () => {
    const doc = renderSelfUat([], BASE_META);
    assert.match(doc, /\(no criteria were evaluated\)/);
  });

  it("performs no filesystem, network, or process-spawning I/O (module source scan)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../verify-agentic-log.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(src, /from ["']node:(fs|net|http|https|dgram|child_process)/);
  });
});

// ─── selfUatLogFileName (Task 1) ───────────────────────────────────────────────

describe("selfUatLogFileName", () => {
  it("produces the colon-free <slug>-<timestamp>-SELF-UAT.md shape", () => {
    const name = selfUatLogFileName("S07", "2026-09-20T12:00:00.000Z");
    assert.equal(name, "s07-2026-09-20T12-00-00Z-SELF-UAT.md");
  });

  it("slugifies the target to lowercase alphanumerics separated by single dashes", () => {
    const name = selfUatLogFileName("Slice 07/beta", "2026-09-20T12:00:00.000Z");
    assert.equal(name, "slice-07-beta-2026-09-20T12-00-00Z-SELF-UAT.md");
  });

  it("never contains a colon character", () => {
    const name = selfUatLogFileName("Slice 07/beta", "2026-09-20T12:00:00.000Z");
    assert.doesNotMatch(name, /:/);
  });
});

// ─── renderSelfUat: rejection guards (Task 2) ──────────────────────────────────

describe("renderSelfUat guards", () => {
  describe("evidence guard", () => {
    it("throws for a PASS with empty-string evidence", () => {
      assert.throws(
        () => renderSelfUat([{ criterion: "c", verdict: "PASS", evidence: "" }], BASE_META),
        SelfUatRenderError,
      );
    });

    it("throws for a FAIL with empty-string evidence", () => {
      assert.throws(
        () =>
          renderSelfUat(
            [{ criterion: "c", verdict: "FAIL", evidence: "", rootCause: "exit 1, stderr: x" }],
            BASE_META,
          ),
        SelfUatRenderError,
      );
    });

    it("throws for whitespace-only evidence", () => {
      assert.throws(
        () => renderSelfUat([{ criterion: "c", verdict: "PASS", evidence: "   " }], BASE_META),
        SelfUatRenderError,
      );
    });

    it("names the offending criterion in the thrown message", () => {
      try {
        renderSelfUat([{ criterion: "user can log in", verdict: "PASS", evidence: "" }], BASE_META);
        assert.fail("expected renderSelfUat to throw");
      } catch (err) {
        assert.ok(err instanceof SelfUatRenderError);
        assert.match((err as Error).message, /user can log in/);
      }
    });
  });

  describe("root-cause presence guard", () => {
    it("throws for a FAIL with rootCause omitted", () => {
      assert.throws(
        () => renderSelfUat([{ criterion: "c", verdict: "FAIL", evidence: "e" }], BASE_META),
        SelfUatRenderError,
      );
    });

    it("throws for a FAIL with rootCause set to the empty string", () => {
      assert.throws(
        () =>
          renderSelfUat([{ criterion: "c", verdict: "FAIL", evidence: "e", rootCause: "" }], BASE_META),
        SelfUatRenderError,
      );
    });

    it("throws for a FAIL with rootCause set to only whitespace", () => {
      assert.throws(
        () =>
          renderSelfUat(
            [{ criterion: "c", verdict: "FAIL", evidence: "e", rootCause: "   " }],
            BASE_META,
          ),
        SelfUatRenderError,
      );
    });

    it("does not throw for a PASS with rootCause omitted", () => {
      assert.doesNotThrow(() =>
        renderSelfUat([{ criterion: "c", verdict: "PASS", evidence: "e" }], BASE_META),
      );
    });
  });

  describe("rubber-stamp guard", () => {
    it("throws when trimmed rootCause equals trimmed criterion", () => {
      assert.throws(
        () =>
          renderSelfUat(
            [{ criterion: "criterion failed", verdict: "FAIL", evidence: "e", rootCause: "  criterion failed  " }],
            BASE_META,
          ),
        SelfUatRenderError,
      );
    });

    it("is case-insensitive", () => {
      assert.throws(
        () =>
          renderSelfUat(
            [{ criterion: "Criterion Failed", verdict: "FAIL", evidence: "e", rootCause: "criterion failed" }],
            BASE_META,
          ),
        SelfUatRenderError,
      );
    });

    it("does not throw when rootCause names something other than the criterion", () => {
      assert.doesNotThrow(() =>
        renderSelfUat(
          [
            {
              criterion: "criterion failed",
              verdict: "FAIL",
              evidence: "e",
              rootCause: "exit 1, stderr: ENOENT",
            },
          ],
          BASE_META,
        ),
      );
    });
  });

  describe("prose-only guard (D-02)", () => {
    it("throws when gapClosureRoute opens a fenced code block tagged diff", () => {
      assert.throws(
        () =>
          renderSelfUat(
            [
              {
                criterion: "c",
                verdict: "FAIL",
                evidence: "e",
                rootCause: "exit 1, stderr: x",
                gapClosureRoute: fencedDiffBlock(),
              },
            ],
            BASE_META,
          ),
        SelfUatRenderError,
      );
    });

    it("throws when gapClosureRoute opens a fenced code block tagged patch", () => {
      assert.throws(
        () =>
          renderSelfUat(
            [
              {
                criterion: "c",
                verdict: "FAIL",
                evidence: "e",
                rootCause: "exit 1, stderr: x",
                gapClosureRoute: fencedPatchBlock(),
              },
            ],
            BASE_META,
          ),
        SelfUatRenderError,
      );
    });

    it("throws when gapClosureRoute contains a unified-diff file header line", () => {
      assert.throws(
        () =>
          renderSelfUat(
            [
              {
                criterion: "c",
                verdict: "FAIL",
                evidence: "e",
                rootCause: "exit 1, stderr: x",
                gapClosureRoute: unifiedDiffHeaderLine(),
              },
            ],
            BASE_META,
          ),
        SelfUatRenderError,
      );
    });

    it("throws when gapClosureRoute contains a hunk-range line", () => {
      assert.throws(
        () =>
          renderSelfUat(
            [
              {
                criterion: "c",
                verdict: "FAIL",
                evidence: "e",
                rootCause: "exit 1, stderr: x",
                gapClosureRoute: hunkRangeLine(),
              },
            ],
            BASE_META,
          ),
        SelfUatRenderError,
      );
    });

    it("throws when gapClosureRoute contains an Index: header line", () => {
      assert.throws(
        () =>
          renderSelfUat(
            [
              {
                criterion: "c",
                verdict: "FAIL",
                evidence: "e",
                rootCause: "exit 1, stderr: x",
                gapClosureRoute: indexHeaderLine(),
              },
            ],
            BASE_META,
          ),
        SelfUatRenderError,
      );
    });

    it("throws when rootCause itself carries a patch marker", () => {
      assert.throws(
        () =>
          renderSelfUat(
            [
              {
                criterion: "c",
                verdict: "FAIL",
                evidence: "e",
                rootCause: `exit 1, stderr: x\n${unifiedDiffHeaderLine()}`,
              },
            ],
            BASE_META,
          ),
        SelfUatRenderError,
      );
    });

    it("renders normally for an ordinary prose gap-closure route naming a file and a next action", () => {
      const doc = renderSelfUat(
        [
          {
            criterion: "c",
            verdict: "FAIL",
            evidence: "exit 1, stderr: ENOENT",
            rootCause: "exit 1, stderr: ENOENT — the binary was never built",
            gapClosureRoute: "Rebuild and re-run; see src/bootstrap.ts",
          },
        ],
        BASE_META,
      );
      assert.doesNotMatch(doc, PATCH_MARKER_PATTERN);
    });
  });

  it("runs guards before any string building, so a rejected input produces no partial document", () => {
    let thrown: unknown;
    try {
      renderSelfUat(
        [
          { criterion: "ok one", verdict: "PASS", evidence: "e1" },
          { criterion: "bad one", verdict: "PASS", evidence: "" },
        ],
        BASE_META,
      );
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof SelfUatRenderError);
  });
});

// ─── PATCH_MARKER_PATTERN ───────────────────────────────────────────────────────

describe("PATCH_MARKER_PATTERN", () => {
  it("is exported and is a RegExp", () => {
    assert.ok(PATCH_MARKER_PATTERN instanceof RegExp);
  });
});

// ─── Constants ──────────────────────────────────────────────────────────────────

describe("SELF_UAT_LOG_DIR_RELATIVE / SELF_UAT_SUFFIX", () => {
  it("SELF_UAT_LOG_DIR_RELATIVE is the literal .gsd/verify-agentic/ path", () => {
    assert.equal(SELF_UAT_LOG_DIR_RELATIVE, ".gsd/verify-agentic/");
  });

  it("SELF_UAT_SUFFIX is the literal -SELF-UAT.md suffix", () => {
    assert.equal(SELF_UAT_SUFFIX, "-SELF-UAT.md");
  });
});

// ─── Frontmatter verdict channel (GATE-01, Task 1) ─────────────────────────────

// Golden body captured from the pre-Phase-9 renderer for a three-criterion
// (PASS, FAIL-with-rootCause-and-gapClosure, PASS) fixture with BASE_META's
// sibling values below. SC5 pins the post-change body to this exact string.
const THREE_CRITERION_GOLDEN_BODY =
  "# SELF-UAT — S07\n\ntarget: S07\nsurface: cli\ntimestamp: 2026-09-20T12:00:00.000Z\nlog location: .gsd/verify-agentic/\n\n### 1. first check\nverdict: PASS\nevidence: exit 0, stdout: ok\n\n### 2. second check\nverdict: FAIL\nevidence: exit 1, stderr: ENOENT\nroot_cause: exit 1, stderr: ENOENT — the binary was never built\ngap_closure: Rebuild and re-run; see src/bootstrap.ts\n\n### 3. third check\nverdict: PASS\nevidence: exit 0, stdout: ok again\n";

const THREE_CRITERION_RESULTS: SelfUatCriterionResult[] = [
  { criterion: "first check", verdict: "PASS", evidence: "exit 0, stdout: ok" },
  {
    criterion: "second check",
    verdict: "FAIL",
    evidence: "exit 1, stderr: ENOENT",
    rootCause: "exit 1, stderr: ENOENT — the binary was never built",
    gapClosureRoute: "Rebuild and re-run; see src/bootstrap.ts",
  },
  { criterion: "third check", verdict: "PASS", evidence: "exit 0, stdout: ok again" },
];

describe("aggregateSelfUat", () => {
  it("returns { result: all_pass, verdict: pass } for a single PASS result", () => {
    assert.deepEqual(
      aggregateSelfUat([{ criterion: "c", verdict: "PASS", evidence: "e" }]),
      { result: "all_pass", verdict: "pass" },
    );
  });
});

describe("isSelfUatResult / isSelfUatVerdict", () => {
  it("isSelfUatVerdict accepts pass and rejects passed", () => {
    assert.equal(isSelfUatVerdict("pass"), true);
    assert.equal(isSelfUatVerdict("passed"), false);
  });

  it("isSelfUatResult accepts all_pass and rejects allpass", () => {
    assert.equal(isSelfUatResult("all_pass"), true);
    assert.equal(isSelfUatResult("allpass"), false);
  });
});

describe("renderSelfUat frontmatter channel", () => {
  it("begins with a literal --- line with no trailing space", () => {
    const doc = renderSelfUat([{ criterion: "c", verdict: "PASS", evidence: "e" }], BASE_META);
    const firstLine = doc.split("\n")[0];
    assert.equal(firstLine, "---");
    assert.equal(firstLine.length, 3);
  });

  it("carries a splitFrontmatter-parseable block with exactly two lines naming result and verdict", () => {
    const doc = renderSelfUat([{ criterion: "c", verdict: "PASS", evidence: "e" }], BASE_META);
    const [frontmatterLines] = splitFrontmatter(doc);
    assert.ok(frontmatterLines !== null);
    assert.equal(frontmatterLines!.length, 2);
    assert.match(frontmatterLines![0], /^result:/);
    assert.match(frontmatterLines![1], /^verdict:/);
  });

  it("extractFrontmatterVerdict reads pass for an all-PASS render", () => {
    const doc = renderSelfUat([{ criterion: "c", verdict: "PASS", evidence: "e" }], BASE_META);
    assert.equal(extractFrontmatterVerdict(doc), "pass");
  });

  it("preserves the pre-Phase-9 markdown body byte-identically below the fence", () => {
    const doc = renderSelfUat(THREE_CRITERION_RESULTS, BASE_META);
    const [, body] = splitFrontmatter(doc);
    assert.equal(body, THREE_CRITERION_GOLDEN_BODY);
  });
});
