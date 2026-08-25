import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  compareModelIds,
  contextWindowFor,
  DEFAULT_MODEL,
  KNOWN_MODELS,
  newestModelId,
  parseGrokModelsOutput,
  toolKind,
} from "../src/grok/models.js";

test("DEFAULT_MODEL is the newest flagship in the catalog", () => {
  const flagship = KNOWN_MODELS.map((m) => m.modelId).filter((id) => /^grok-\d+(?:\.\d+)*$/.test(id));
  assert.equal(DEFAULT_MODEL, newestModelId(flagship));
  assert.ok(KNOWN_MODELS.some((m) => m.modelId === DEFAULT_MODEL));
  assert.ok(compareModelIds(DEFAULT_MODEL, "grok-4.5") >= 0);
});

test("newestModelId prefers a higher grok version", () => {
  assert.equal(newestModelId(["grok-4.5", "grok-4.6", "grok-4"]), "grok-4.6");
  assert.equal(newestModelId(["grok-4", "grok-4.5"]), "grok-4.5");
});

test("newestModelId prefers flagship over a same-version variant", () => {
  assert.equal(newestModelId(["grok-4.6-fast", "grok-4.6"]), "grok-4.6");
  assert.equal(newestModelId(["grok-4.20-non-reasoning", "grok-4.6"]), "grok-4.20-non-reasoning");
});

test("newestModelId ignores blanks and empty lists", () => {
  assert.equal(newestModelId([]), undefined);
  assert.equal(newestModelId(["", "  "]), undefined);
  assert.equal(newestModelId(["grok-4.5", ""]), "grok-4.5");
});

test("parseGrokModelsOutput reads grok models text", () => {
  const text = [
    "You are logged in with grok.com.",
    "",
    "Default model: grok-4.6",
    "",
    "Available models:",
    "  * grok-4.6 (default)",
    "  - grok-4.5",
  ].join("\n");
  const parsed = parseGrokModelsOutput(text);
  assert.equal(parsed.defaultId, "grok-4.6");
  assert.deepEqual(parsed.available, ["grok-4.6", "grok-4.5"]);
  assert.equal(newestModelId(parsed.available), "grok-4.6");
});

test("contextWindowFor returns known and default sizes", () => {
  assert.equal(contextWindowFor("grok-4.5"), 256_000);
  assert.equal(contextWindowFor("grok-code-fast-1"), 256_000);
  assert.equal(contextWindowFor("mystery"), 256_000);
  assert.equal(contextWindowFor(undefined), 256_000);
});

test("toolKind buckets tool names correctly", () => {
  assert.equal(toolKind("write_file"), "edit");
  assert.equal(toolKind("str_replace"), "edit");
  assert.equal(toolKind("read_file"), "read");
  assert.equal(toolKind("search_web"), "search");
  assert.equal(toolKind("bash"), "execute");
  assert.equal(toolKind("task"), "think");
  assert.equal(toolKind(undefined), "other");
});
