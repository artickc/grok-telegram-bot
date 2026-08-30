import { strict as assert } from "node:assert";
import { test } from "node:test";
import { subagentSummary } from "../src/render/subagent.js";
import type { SubagentInfo } from "../src/grok/types.js";

test("subagentSummary counts running crew", () => {
  const list: SubagentInfo[] = [
    {
      sessionId: "a",
      status: { type: "working" },
    },
    {
      sessionId: "b",
      status: { type: "running" },
    },
    {
      sessionId: "c",
      status: { type: "completed" },
    },
  ];
  const s = subagentSummary(list, [{ name: "next" }]);
  assert.ok(s);
  assert.ok(s!.includes("2 running"));
  assert.ok(s!.includes("1 pending"));
});
