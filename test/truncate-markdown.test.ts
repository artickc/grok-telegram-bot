import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toTelegramMarkdown } from "../src/render/markdown.js";
import {
  formatLiveTerminalOutput,
  truncateHead,
  truncateMiddle,
  truncateMiddleLines,
} from "../src/render/truncate.js";
import { extractToolOutput } from "../src/render/tool-call-detail.js";
import { formatToolCall } from "../src/render/tool-call.js";
import type { SessionUpdate } from "../src/grok/types.js";
import { wrapAutoComplexityPrompt, pickPlanModeId } from "../src/bot/complexity-gate.js";
import { textPrompt } from "../src/app/types.js";

test("truncateMiddle keeps head and tail", () => {
  const s = "A".repeat(100) + "MID" + "B".repeat(100);
  const out = truncateMiddle(s, 80);
  assert.ok(out.startsWith("A"));
  assert.ok(out.endsWith("B"));
  assert.ok(out.includes("omitted") || out.includes("…"));
  assert.ok(out.length <= 80 + 40); // marker adds a bit of structure but stays bounded
});

test("truncateHead never exceeds max", () => {
  assert.equal(truncateHead("hello", 10), "hello");
  assert.equal(truncateHead("hello world", 5).length, 5);
});

test("truncateMiddleLines omits middle lines", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
  const out = truncateMiddleLines(lines.join("\n"), 6);
  assert.ok(out.includes("L0"));
  assert.ok(out.includes("L19"));
  assert.ok(out.includes("omitted"));
});

test("formatLiveTerminalOutput keeps first line and live tail", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
  const out = formatLiveTerminalOutput(lines.join("\n"), 5, 5000);
  assert.ok(out.startsWith("line-0"), out);
  assert.ok(out.includes("line-29"), out);
  assert.ok(out.includes("line-25"), out);
  assert.ok(out.includes("omitted") || out.includes("live tail"), out);
  assert.ok(!out.includes("line-10"), out); // middle dropped
});

test("markdown preserves code fences and does not drop content", () => {
  const src = "Hello **bold** and `code`\n\n```ts\nconst x = 1;\n```\n\n> quote";
  const md = toTelegramMarkdown(src);
  assert.ok(md.includes("```ts"));
  assert.ok(md.includes("const x = 1;"));
  assert.ok(md.includes("bold") || md.includes("*bold*"));
  assert.ok(md.includes("code"));
  assert.ok(md.includes(">"));
});

test("markdown keeps unclosed fence content", () => {
  const src = "before\n```bash\necho hi";
  const md = toTelegramMarkdown(src);
  assert.ok(md.includes("before"));
  assert.ok(md.includes("echo hi"));
  assert.ok(md.includes("```"));
});

test("extractToolOutput pulls content_blocks text", () => {
  const u = {
    sessionUpdate: "tool_call_update",
    content_blocks: [
      { type: "content", content: { type: "text", text: "command stdout here" } },
    ],
  } as SessionUpdate;
  assert.equal(extractToolOutput(u), "command stdout here");
});

test("formatExecute includes command output when present", () => {
  const u = {
    sessionUpdate: "tool_call_update",
    kind: "execute",
    status: "completed",
    rawInput: { command: "echo hi" },
    content_blocks: [{ type: "content", content: { type: "text", text: "hi\n" } }],
  } as SessionUpdate;
  const md = formatToolCall(u, { showDiffs: true, diffMaxLines: 40 });
  assert.ok(md.includes("echo hi"));
  assert.ok(md.includes("Output") || md.includes("hi"));
});

test("wrapAutoComplexityPrompt steers agent without asking the user", () => {
  const wrapped = wrapAutoComplexityPrompt(textPrompt("add auth"));
  assert.ok(wrapped.text.includes("decide yourself"));
  assert.ok(wrapped.text.includes("never ask the user") || wrapped.text.includes("Do NOT ask"));
  assert.ok(wrapped.text.includes("add auth"));
  assert.ok(wrapped.text.includes("plan"));
  // Idempotent wrap.
  const twice = wrapAutoComplexityPrompt(wrapped);
  assert.equal(twice.text, wrapped.text);
});

test("pickPlanModeId finds plan-like modes", () => {
  assert.equal(
    pickPlanModeId(
      [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
      (id) => id === "plan" || id === "default",
    ),
    "plan",
  );
  assert.equal(
    pickPlanModeId([{ id: "code", name: "Code" }], () => false),
    undefined,
  );
});
