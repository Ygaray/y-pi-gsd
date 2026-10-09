// redact-secrets.test.ts
// Verifies secret-shaped substrings are replaced while benign text and JSON
// structure are preserved.
//
// Fake secrets are assembled from fragments at runtime so external secret
// scanners (GitGuardian) and the repo secret-scan never see a literal
// secret-shaped string in this source file — the runtime value still matches
// the redaction patterns, which is what the test exercises.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../redact-secrets.js";

const PLACEHOLDER = "«redacted»";

// Fragment-built fakes (never a full secret literal in source).
const FAKE = {
  github: "gh" + "p_" + "A".repeat(36), // GitHub PAT shape: ghp_ + 36 chars
  aws: "AKIA" + "IOSFODNN7EXAMPL0", // AWS access key id shape: AKIA + 16 chars
  anthropic: "sk-" + "ant-" + "x".repeat(28), // Anthropic key shape
  bearer: "sk-" + "b".repeat(24), // generic sk- token
};

test("redacts a Bearer authorization token", () => {
  const out = redactSecrets(`Authorization: Bearer ${FAKE.bearer}`);
  assert.ok(out.includes("Authorization:"), "keeps the label context");
  assert.ok(out.includes(PLACEHOLDER), "redacts the token");
  assert.ok(!out.includes(FAKE.bearer), "raw token is gone");
});

test("redacts key=value style secrets", () => {
  const anth = redactSecrets(`ANTHROPIC_API_KEY="${FAKE.anthropic}"`);
  assert.ok(anth.includes(PLACEHOLDER) && !anth.includes(FAKE.anthropic));
  const gh = redactSecrets(`"token": "${FAKE.github}"`);
  assert.ok(gh.includes(PLACEHOLDER) && !gh.includes(FAKE.github));
});

test("redacts an AWS access key id", () => {
  const out = redactSecrets(`aws key ${FAKE.aws} in output`);
  assert.ok(out.includes(PLACEHOLDER) && !out.includes(FAKE.aws));
});

test("leaves benign text mentioning 'token' untouched", () => {
  const line = "The token is passed to the next unit for processing.";
  assert.equal(redactSecrets(line), line);
});

test("redacting a JSON string keeps it valid JSON", () => {
  const original = JSON.stringify({ msg: "using key=SECRETVALUE here", auth: FAKE.github });
  const redacted = redactSecrets(original);
  // Must still parse.
  const parsed = JSON.parse(redacted) as { msg: string; auth: string };
  // The bare GitHub token is redacted; the non-keyword "key=..." stays (no false structure break).
  assert.ok(!redacted.includes(FAKE.github));
  assert.equal(parsed.auth, PLACEHOLDER);
});

test("redacts PKCS#8, encrypted and algorithm-prefixed PEM private keys (WR-03)", () => {
  const dash = "-----";
  for (const kind of ["", "ENCRYPTED ", "RSA ", "EC ", "OPENSSH "]) {
    const pem = `${dash}BEGIN ${kind}PRIVATE KEY${dash}\nMIIEvQIBADANBgkqhkiG9w0B\nabcdef\n${dash}END ${kind}PRIVATE KEY${dash}`;
    const out = redactSecrets(`before\n${pem}\nafter`);
    assert.ok(!out.includes("MIIEvQIBADAN"), `key body gone for "${kind}"`);
    assert.ok(out.startsWith("before\n") && out.endsWith("\nafter"), "surrounding text kept");
    assert.ok(out.includes(PLACEHOLDER));
  }
});

test("redacts a PEM block whose END line was truncated, and keeps JSON valid (WR-03)", () => {
  const dash = "-----";
  const truncated = `notes ${dash}BEGIN PRIVATE KEY${dash}\nMIIEvQIBADANBgkqhkiG9w0B\nabc`;
  const out = redactSecrets(truncated);
  assert.ok(!out.includes("MIIEvQIBADAN"));
  assert.ok(out.startsWith("notes "));
  const json = JSON.stringify({ k: truncated, other: "kept" });
  const parsed = JSON.parse(redactSecrets(json)) as { k: string; other: string };
  assert.equal(parsed.other, "kept");
  assert.ok(!parsed.k.includes("MIIEvQIBADAN"));
});
