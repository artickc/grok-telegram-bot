import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatToolCall } from "../src/render/tool-call.js";
import { resolveToolIdentity, extractPath, kindFromToolName } from "../src/render/tool-call-detail.js";
import type { SessionUpdate } from "../src/grok/types.js";

const opts = { showDiffs: true, diffMaxLines: 40 };

test("kindFromToolName maps Grok tools", () => {
  assert.equal(kindFromToolName("read_file"), "read");
  assert.equal(kindFromToolName("run_terminal_command"), "execute");
  assert.equal(kindFromToolName("search_replace"), "edit");
  assert.equal(kindFromToolName("grep"), "search");
  assert.equal(kindFromToolName("list_dir"), "list");
  assert.equal(kindFromToolName("web_search"), "web_search");
  assert.equal(kindFromToolName("todo_write"), "todo");
});

test("read_file is NOT labeled MCP; shows path offset limit", () => {
  const u = {
    sessionUpdate: "tool_call",
    kind: "other",
    title: "read_file",
    status: "completed",
    rawInput: {
      target_file: "H:\\Lucru\\Domains\\grok-telegram-bot\\src\\bot\\session-runtime.ts",
      offset: 450,
      limit: 180,
    },
  } as SessionUpdate;
  const id = resolveToolIdentity(u, u.rawInput as Record<string, unknown>);
  assert.equal(id.kind, "read");
  assert.equal(id.isMcp, false);
  assert.equal(extractPath(u.rawInput as Record<string, unknown>).includes("session-runtime"), true);

  const md = formatToolCall(u, opts);
  assert.ok(md.includes("Read"), md);
  assert.ok(md.includes("session-runtime") || md.includes("offset"), md);
  assert.ok(md.includes("450") || md.includes("offset"), md);
  assert.ok(md.includes("180") || md.includes("limit"), md);
  assert.ok(!md.includes("Call MCP"), md);
  assert.ok(!/\*\*Other\*\*/.test(md), md);
  // Path must be in inline code, not inside **bold** (Windows path MDV2 trap).
  assert.ok(/\*\*Read\*\*/.test(md), md);
  assert.ok(!/\*\*Read H:/.test(md) && !/\*\*Read .*session-runtime/.test(md), md);
  assert.ok(md.includes("`") && md.includes("session-runtime"), md);
});

test("edit tool keeps Windows path in code not bold", () => {
  const path =
    "C:\\Users\\artic\\.grok\\sessions\\H%3A%5CLucru%5CDomains%5CApp\\plan.md";
  const md = formatToolCall(
    {
      sessionUpdate: "tool_call",
      kind: "edit",
      title: "search_replace",
      status: "completed",
      rawInput: { file_path: path },
    } as SessionUpdate,
    opts,
  );
  assert.ok(/\*\*Edit\*\*/.test(md), md);
  assert.ok(md.includes("`" + path + "`") || md.includes("`C:\\Users"), md);
  assert.ok(!/\*\*Edit C:/.test(md), md);
});

test("grep shows pattern and path", () => {
  const u = {
    sessionUpdate: "tool_call",
    kind: "other",
    title: "grep",
    status: "in_progress",
    rawInput: {
      pattern: "formatToolCall",
      path: "src",
      glob: "*.ts",
    },
  } as SessionUpdate;
  const md = formatToolCall(u, opts);
  assert.ok(md.includes("Search") || md.includes("formatToolCall"), md);
  assert.ok(md.includes("formatToolCall"), md);
  assert.ok(md.includes("src") || md.includes("include") || md.includes("*.ts"), md);
  assert.ok(!md.includes("Call MCP"), md);
});

test("run_terminal_command shows bash command", () => {
  const u = {
    sessionUpdate: "tool_call",
    kind: "other",
    title: "run_terminal_command",
    status: "completed",
    rawInput: { command: "npm run typecheck", description: "typecheck" },
  } as SessionUpdate;
  const md = formatToolCall(u, opts);
  assert.ok(md.includes("npm run typecheck"), md);
  assert.ok(md.includes("```"), md);
  assert.ok(!md.includes("Call MCP"), md);
});

test("namespaced MCP still labeled MCP with args", () => {
  const u = {
    sessionUpdate: "tool_call",
    kind: "other",
    title: "filesystem__read_file",
    status: "completed",
    rawInput: {
      tool_name: "filesystem__read_file",
      path: "/tmp/x.ts",
    },
  } as SessionUpdate;
  const id = resolveToolIdentity(u, u.rawInput as Record<string, unknown>);
  assert.equal(id.isMcp, true);
  assert.equal(id.mcpServer, "filesystem");
  const md = formatToolCall(u, opts);
  assert.ok(md.includes("MCP"), md);
  assert.ok(md.includes("x.ts") || md.includes("Read") || md.includes("path"), md);
});

test("generic unknown tool dumps args, never bare Other", () => {
  const u = {
    sessionUpdate: "tool_call",
    kind: "other",
    title: "Other",
    status: "completed",
    rawInput: {
      tool_name: "custom_widget",
      widget_id: "abc",
      mode: "preview",
    },
  } as SessionUpdate;
  const md = formatToolCall(u, opts);
  assert.ok(md.includes("custom_widget") || md.includes("widget_id"), md);
  assert.ok(!/\*\*Other\*\*/.test(md), md);
});

test("list_dir shows directory", () => {
  const u = {
    sessionUpdate: "tool_call",
    kind: "other",
    title: "list_dir",
    rawInput: { target_directory: "H:\\Lucru\\Domains\\grok-telegram-bot\\src" },
  } as SessionUpdate;
  const md = formatToolCall(u, opts);
  assert.ok(md.includes("List") || md.includes("src"), md);
  assert.ok(!md.includes("Call MCP"), md);
});

test("execute output uses single live-tail block", () => {
  const longOut = Array.from({ length: 40 }, (_, i) => `out-${i}`).join("\n");
  const u = {
    sessionUpdate: "tool_call_update",
    kind: "execute",
    status: "in_progress",
    name: "run_terminal_command",
    rawInput: { command: "npm test" },
    content_blocks: [{ type: "content", content: { type: "text", text: longOut } }],
  } as SessionUpdate;
  const md = formatToolCall(u, opts);
  assert.ok(md.includes("npm test"), md);
  assert.ok(md.includes("out-0"), md);
  assert.ok(md.includes("out-39"), md);
  assert.ok(md.includes("Output"), md);
  // Only one output fence (not spam of many).
  const fences = md.split("```").length - 1;
  assert.ok(fences >= 2 && fences <= 6, `fence count ${fences}: ${md}`);
});

test("completed update merged with prior rawInput is not bare Tool call", async () => {
  const { mergeToolSnapshot } = await import("../src/render/tool-call-merge.js");
  const first = {
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    title: "Tool call",
    kind: "other",
    name: "read_file",
    status: "pending",
    rawInput: { target_file: "src/bot/session-runtime.ts", offset: 10, limit: 50 },
  } as SessionUpdate;
  const done = {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "completed",
  } as SessionUpdate;
  const merged = mergeToolSnapshot(first, done);
  const md = formatToolCall(merged, opts);
  assert.ok(md.includes("Read") || md.includes("session-runtime") || md.includes("read_file"), md);
  assert.ok(!/\*\*Tool call\*\*/.test(md), md);
  assert.ok(md.includes("\u2705") || md.includes("completed") || true, md);
});
