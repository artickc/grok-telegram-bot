import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parsePlanUpdate,
  renderPlanMarkdown,
  renderPlanOneLine,
} from "../src/render/plan.js";
import type { SessionUpdate } from "../src/grok/types.js";

test("parsePlanUpdate reads entries[] with statuses", () => {
  const u = {
    sessionUpdate: "plan",
    entries: [
      { content: "Explore codebase", status: "completed" },
      { content: "Implement fix", status: "in_progress" },
      { content: "Verify typecheck", status: "pending" },
    ],
  } as SessionUpdate;
  const entries = parsePlanUpdate(u);
  assert.ok(entries);
  assert.equal(entries!.length, 3);
  assert.equal(entries![1]!.status, "in_progress");
});

test("renderPlanMarkdown shows icons and counts above progress", () => {
  const md = renderPlanMarkdown([
    { content: "Done step", status: "completed" },
    { content: "Active step", status: "in_progress" },
    { content: "Next step", status: "pending" },
  ]);
  assert.ok(md.includes("Plan"));
  assert.ok(md.includes("1/3"));
  assert.ok(md.includes("Done step"));
  assert.ok(md.includes("Active step"));
  assert.ok(md.includes("Next step"));
  // Header first, then steps
  const lines = md.split("\n");
  assert.ok(lines[0]!.startsWith("\u{1F4CB}"));
});

test("renderPlanOneLine highlights current step", () => {
  const line = renderPlanOneLine([
    { content: "A", status: "completed" },
    { content: "Current work item", status: "in_progress" },
    { content: "C", status: "pending" },
  ]);
  assert.ok(line.includes("1/3"));
  assert.ok(line.includes("Current work item"));
});
