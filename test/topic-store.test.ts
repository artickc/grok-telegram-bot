import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { TopicStore } from "../src/forum/topic-store.js";

test("TopicStore persists bindings and pending flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-topics-"));
  try {
    const s = new TopicStore(dir, -100123);
    s.bindProject(42, "H:/Lucru/Domains/Demo", "Demo", "project");
    assert.equal(s.get(42)?.projectPath?.includes("Demo"), true);
    assert.equal(s.findByProjectPath("H:/Lucru/Domains/Demo")?.threadId, 42);

    s.markPending(99);
    assert.equal(s.isPending(99), true);
    s.clearPending(99);
    assert.equal(s.isPending(99), false);

    // Reload from disk.
    const s2 = new TopicStore(dir, -100123);
    assert.equal(s2.get(42)?.name, "Demo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TopicStore tracks AI chat kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-topics-ai-"));
  try {
    const s = new TopicStore(dir, -1);
    s.bindProject(7, "H:/ws", "AI Chat", "ai_chat");
    assert.equal(s.findAiChat()?.threadId, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
