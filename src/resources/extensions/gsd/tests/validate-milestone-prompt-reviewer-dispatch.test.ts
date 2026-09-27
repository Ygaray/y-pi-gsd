// Project/App: gsd-pi
// File Purpose: Prompt contract tests for RELY-02 reviewer-dispatch shape and verdict-reconciliation in validate-milestone.md, plus the additive reviewer.md output-format override.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const promptPath = join(process.cwd(), "src/resources/extensions/gsd/prompts/validate-milestone.md");
const prompt = readFileSync(promptPath, "utf-8");

const reviewerPersonaPath = join(process.cwd(), "src/resources/agents/reviewer.md");
const reviewerPersona = readFileSync(reviewerPersonaPath, "utf-8");

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("Step 1 shows the literal reviewer TaskItem shape once per reviewer", () => {
  assert.equal(countOccurrences(prompt, 'agent: "reviewer"'), 3);
  const firstIndex = prompt.indexOf('agent: "reviewer"');
  assert.notEqual(firstIndex, -1);
  const sentenceStart = prompt.lastIndexOf("\n\n", firstIndex);
  const sentenceWindow = prompt.slice(sentenceStart === -1 ? 0 : sentenceStart, firstIndex + 200);
  assert.match(sentenceWindow, /`subagent`/);
});

test("Step 1 names GSD's subagent tool as the dispatch path rather than a generic agent type", () => {
  assert.match(prompt, /tasks:\s*\[/);
  assert.match(prompt, /`agent`\s+field is required/i);
  assert.match(prompt, /host runtime's (?:own )?generic (?:task|agent)/i);
});

test("the three reviewer sections are still present and still named A, B, C", () => {
  assert.match(prompt, /\*\*Reviewer A - Requirements Coverage\*\*/);
  assert.match(prompt, /\*\*Reviewer B - Cross-Slice Integration\*\*/);
  assert.match(prompt, /\*\*Reviewer C - Assessment & Acceptance Criteria\*\*/);
});

test("the reviewer persona defers to a dispatching task prompt's own output format", () => {
  assert.match(
    reviewerPersona,
    /if the task prompt that dispatched this agent specifies its own output format, verdict vocabulary, or table shape, follow those instructions exactly instead of the format below/i,
  );
});

test("the reviewer persona's default verdict vocabulary is preserved for its other callers", () => {
  assert.match(reviewerPersona, /## Output Format/);
  assert.match(reviewerPersona, /## Review Summary/);
  assert.match(reviewerPersona, /## Findings/);
  assert.match(reviewerPersona, /## Verdict/);
  assert.match(reviewerPersona, /APPROVE/);
  assert.match(reviewerPersona, /REQUEST_CHANGES/);
  assert.match(reviewerPersona, /NEEDS_DISCUSSION/);
  assert.match(reviewerPersona, /Critical/i);
  assert.match(reviewerPersona, /High/);
  assert.match(reviewerPersona, /Medium/);
  assert.match(reviewerPersona, /Low/);
});
