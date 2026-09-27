// Project/App: gsd-pi
// File Purpose: RELY-01 drift guard - every registered gsd_* tool's exitCode parameter must be documented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbTools } from "../bootstrap/db-tools.ts";

interface ToolDefinition {
  name: string;
  parameters: unknown;
}

function makeMockPi() {
  const tools: ToolDefinition[] = [];
  return {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    tools,
  };
}

interface ExitCodeField {
  toolName: string;
  path: string;
  schema: Record<string, unknown>;
}

/**
 * Recursively walks a JSON-schema-shaped node (as TypeBox emits) and records
 * every property named exactly "exitCode", along with a JSON-pointer-style
 * path so a failing assertion is self-diagnosing. Descends through
 * `properties`, `items`, and the members of `anyOf`/`allOf`/`oneOf`. Plain
 * object traversal only - no TypeBox-internal symbol or private API.
 */
function collectExitCodeFields(
  schema: unknown,
  path: string,
  toolName: string,
  out: ExitCodeField[],
): void {
  if (!schema || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;

  const properties = node["properties"];
  if (properties && typeof properties === "object") {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      const nextPath = `${path}.properties.${key}`;
      if (key === "exitCode" && value && typeof value === "object") {
        out.push({ toolName, path: nextPath, schema: value as Record<string, unknown> });
      }
      collectExitCodeFields(value, nextPath, toolName, out);
    }
  }

  if (node["items"] !== undefined) {
    collectExitCodeFields(node["items"], `${path}.items`, toolName, out);
  }

  for (const combinator of ["anyOf", "allOf", "oneOf"] as const) {
    const list = node[combinator];
    if (Array.isArray(list)) {
      list.forEach((entry, index) =>
        collectExitCodeFields(entry, `${path}.${combinator}[${index}]`, toolName, out)
      );
    }
  }
}

function collectAllExitCodeFields(tools: ToolDefinition[]): ExitCodeField[] {
  const out: ExitCodeField[] = [];
  for (const tool of tools) {
    collectExitCodeFields(tool.parameters, "parameters", tool.name, out);
  }
  return out;
}

test("gsd_validate_milestone documents its verificationEvidence exitCode field", () => {
  const pi = makeMockPi();
  registerDbTools(pi as never);

  const tool = pi.tools.find((candidate) => candidate.name === "gsd_validate_milestone");
  assert.ok(tool, "gsd_validate_milestone should be registered");

  const params = tool!.parameters as {
    properties: {
      verificationEvidence: {
        items: { properties: { exitCode: { description?: unknown } } };
      };
    };
  };
  const description = params.properties.verificationEvidence.items.properties.exitCode.description;

  assert.equal(typeof description, "string");
  assert.ok((description as string).length > 0, "exitCode description should be non-empty");
  assert.match(description as string, /evidenceClass/);
  assert.match(description as string, /command/);
});

test("every registered gsd tool documents every exitCode parameter", () => {
  const pi = makeMockPi();
  registerDbTools(pi as never);

  const fields = collectAllExitCodeFields(pi.tools);
  assert.ok(
    fields.length >= 2,
    `expected at least 2 exitCode fields across registered tools, found ${fields.length} - a vacuous pass would hide a broken walk`,
  );

  const undocumented = fields.filter((field) => {
    const description = field.schema["description"];
    return typeof description !== "string" || description.length === 0;
  });
  assert.deepEqual(
    undocumented.map((field) => `${field.toolName}: ${field.path}`),
    [],
    "every exitCode parameter must carry a non-empty description",
  );
});
