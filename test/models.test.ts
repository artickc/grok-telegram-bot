import { strict as assert } from "node:assert";
import { test } from "node:test";
import { contextWindowFor, DEFAULT_MODEL, KNOWN_MODELS, toolKind } from "../src/grok/models.js";

test("DEFAULT_MODEL is grok-4.5 and is a known model", () => {
  assert.equal(DEFAULT_MODEL, "grok-4.5");
  assert.ok(KNOWN_MODELS.some((m) => m.modelId === DEFAULT_MODEL));
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
