import test from "node:test";
import assert from "node:assert/strict";

import { TASK_TOOL } from "../src/tools.js";
import { describeSubagentsForHumans, getSubagentDefinition } from "../src/subagents.js";

test("getSubagentDefinition falls back to general-purpose for unknown names", () => {
  const definition = getSubagentDefinition("missing-agent");

  assert.equal(definition.name, "general-purpose");
  assert.match(definition.systemPrompt, /general-purpose sub-agent/i);
});

test("describeSubagentsForHumans lists the minimal built-in catalog", () => {
  const description = describeSubagentsForHumans();

  assert.match(description, /general-purpose:/);
  assert.match(description, /explore:/);
});

test("task tool exposes subagent_type enum for minimal specialized delegation", () => {
  const subagentTypeSchema = TASK_TOOL.parameters.properties.subagent_type as { enum?: string[] };

  assert.deepEqual(subagentTypeSchema.enum, ["general-purpose", "explore"]);
});
