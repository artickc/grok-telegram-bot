import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildLastTurnSummary,
  buildLocalTurnComment,
  cleanCommentLine,
  cleanUserPreview,
  extractResultSnippet,
  formatFilesPhrase,
  stepFromThought,
  stepFromToolUpdate,
  stripDirectiveWrappers,
} from "../src/render/session-comment.js";
import type { SessionUpdate } from "../src/grok/types.js";
import type { FileOp } from "../src/render/file-summary.js";

test("cleanCommentLine strips progress markers and clamps", () => {
  const s = cleanCommentLine("Done with auth  {progress: 100%}  ", 40);
  assert.ok(!s.includes("progress"));
  assert.ok(s.includes("Done"));
});

test("cleanUserPreview drops directive and complexity wrapper", () => {
  const raw =
    "(Think carefully.)\n\nTASK COMPLEXITY: COMPLEX.\n...\nUser task:\nfix the login bug";
  const out = cleanUserPreview(raw, 80);
  assert.ok(out.toLowerCase().includes("login") || out.toLowerCase().includes("fix"));
  assert.ok(!out.includes("TASK COMPLEXITY"));
});

test("stripDirectiveWrappers peels AUTO COMPLEXITY and reply priming", () => {
  const complex =
    "COMPLEXITY (decide yourself — never ask the user):\n...\nUser task:\nadd password reset";
  assert.equal(stripDirectiveWrappers(complex), "add password reset");
  const primed =
    "Prior context here\n\n---\n\nUser's new message:\nfix the race";
  assert.equal(stripDirectiveWrappers(primed), "fix the race");
});

test("cleanUserPreview drops import confirm noise", () => {
  assert.equal(cleanUserPreview("Session import complete. Confirm you have the full imported context."), "");
});

test("extractResultSnippet prefers closing sentences", () => {
  const text =
    "I'll look into the running cards. " +
    "First I will read the handlers. " +
    "Fixed running cards to show last-turn outcomes with file lists. {progress: 100%}";
  const snip = extractResultSnippet(text, 160);
  assert.ok(snip.toLowerCase().includes("fixed") || snip.toLowerCase().includes("running"), snip);
  assert.ok(!snip.includes("progress"), snip);
  assert.ok(!/^i'?ll /i.test(snip), snip);
});

test("buildLastTurnSummary prefers assistant result over user ask", () => {
  const ops = new Map<string, FileOp>([
    ["src/render/tool-call.ts", "edited"],
    ["src/bot/handlers/running.ts", "edited"],
  ]);
  const s = buildLastTurnSummary({
    userText: "fix the cards please",
    assistantText:
      "I investigated the comment pipeline. Removed the meta prompt and now cards show last-turn outcomes with file lists.",
    fileOps: ops,
  });
  assert.ok(s.toLowerCase().includes("card") || s.toLowerCase().includes("outcome") || s.toLowerCase().includes("removed"), s);
  assert.ok(s.includes("tool-call") || s.includes("running") || s.includes("~"), s);
  assert.ok(!s.includes("fix the cards please") || s.length > 40, s);
});

test("buildLastTurnSummary with only files", () => {
  const ops = new Map<string, FileOp>([["a.ts", "edited"], ["b.ts", "created"]]);
  const s = buildLastTurnSummary({ userText: "improve cards", fileOps: ops });
  assert.ok(s.includes("a.ts") || s.includes("Changed") || s.includes("improve"), s);
});

test("formatFilesPhrase", () => {
  const ops = new Map<string, FileOp>([
    ["src/a.ts", "edited"],
    ["src/b.ts", "created"],
  ]);
  const p = formatFilesPhrase(ops);
  assert.ok(p.includes("a.ts"));
  assert.ok(p.includes("+") || p.includes("~"));
});

test("stepFromToolUpdate formats execute and edit", () => {
  const exec = stepFromToolUpdate({
    sessionUpdate: "tool_call",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "npm run typecheck" },
  } as SessionUpdate);
  assert.ok(exec?.includes("npm run typecheck"));

  const edit = stepFromToolUpdate({
    sessionUpdate: "tool_call",
    kind: "edit",
    status: "completed",
    rawInput: { path: "H:/proj/src/bot.ts" },
  } as SessionUpdate);
  assert.ok(edit?.includes("bot.ts"));
});

test("stepFromThought prefixes Thinking", () => {
  assert.ok(stepFromThought("consider edge cases").startsWith("Thinking"));
});

test("buildLocalTurnComment alias still works", () => {
  assert.equal(buildLocalTurnComment({ fileOps: new Map(), cancelled: true }), "Stopped by user");
  assert.ok(buildLocalTurnComment({ fileOps: new Map(), error: "boom" }).includes("boom"));
});
