import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatGoalUsage, normalizeGoalSlashLine } from "../src/bot/goal-command.js";
import { buildContentBlocks } from "../src/bot/prompt-content.js";
import { textPrompt } from "../src/app/types.js";

describe("normalizeGoalSlashLine", () => {
  it("returns undefined for empty args", () => {
    assert.equal(normalizeGoalSlashLine(""), undefined);
    assert.equal(normalizeGoalSlashLine("   "), undefined);
    assert.equal(normalizeGoalSlashLine("/goal"), undefined);
  });

  it("normalizes subcommands", () => {
    assert.equal(normalizeGoalSlashLine("status"), "/goal status");
    assert.equal(normalizeGoalSlashLine("PAUSE"), "/goal pause");
    assert.equal(normalizeGoalSlashLine("resume extra"), "/goal resume");
    assert.equal(normalizeGoalSlashLine("clear"), "/goal clear");
  });

  it("keeps objectives including budget flag", () => {
    assert.equal(
      normalizeGoalSlashLine("Fix auth. Done when tests pass. --budget 200000"),
      "/goal Fix auth. Done when tests pass. --budget 200000",
    );
  });

  it("strips a duplicated leading /goal", () => {
    assert.equal(normalizeGoalSlashLine("/goal status"), "/goal status");
    assert.equal(
      normalizeGoalSlashLine("goal Migrate the module"),
      "/goal Migrate the module",
    );
  });
});

describe("formatGoalUsage", () => {
  it("mentions subcommands and project topic guidance", () => {
    const u = formatGoalUsage();
    assert.ok(u.includes("/goal status"));
    assert.ok(u.includes("project topic") || u.includes("AI Chat"));
  });
});

describe("rawSlashCommand content blocks", () => {
  it("keeps /goal as the only/first text with no wrappers", () => {
    const input = textPrompt("/goal status", 1, "quoted should vanish", {
      rawSlashCommand: true,
      skipSelfRecheck: true,
    });
    const blocks = buildContentBlocks(input, {
      reasoning: "high",
      priming: "PRIOR CONTEXT",
      progress: "PROGRESS RULES",
      imageOutput: "IMAGE RULES",
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "text");
    assert.equal(blocks[0]?.text, "/goal status");
  });
});
