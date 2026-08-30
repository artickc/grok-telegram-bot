import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildLastTurnSummary,
  buildLocalTurnComment,
  buildSessionCardComment,
  cleanCommentLine,
  cleanUserPreview,
  clampThinking,
  COMMENT_MAX,
  extractResultSnippet,
  formatFilesPhrase,
  stepFromThought,
  shortenLiveCommand,
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

test("shortenLiveCommand collapses heredocs and prefers git/npm lines", () => {
  const messy = `git add a.ts b.ts
$msg = @"
fix: never sticky done
"@
git commit -m $msg
git push`;
  const s = shortenLiveCommand(messy);
  assert.ok(s.startsWith("git add"), s);
  assert.ok(!s.includes("never sticky"), s);
  assert.ok(!s.includes("\n"), s);
});

test("stepFromToolUpdate formats execute and edit", () => {
  const exec = stepFromToolUpdate({
    sessionUpdate: "tool_call",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "npm run typecheck" },
  } as SessionUpdate);
  assert.ok(exec?.includes("npm run typecheck"));

  const heredoc = stepFromToolUpdate({
    sessionUpdate: "tool_call",
    kind: "execute",
    status: "in_progress",
    rawInput: {
      command: 'git add x.ts\n$msg = @"\nlong body\n"@\ngit commit -m $msg',
    },
  } as SessionUpdate);
  assert.ok(heredoc?.startsWith("Run: git add"), heredoc);
  assert.ok(!heredoc?.includes("long body"), heredoc);

  const edit = stepFromToolUpdate({
    sessionUpdate: "tool_call",
    kind: "edit",
    status: "in_progress",
    rawInput: { path: "H:/proj/src/bot.ts" },
  } as SessionUpdate);
  assert.ok(edit?.includes("bot.ts"));

  // Completed must not sticky "… done" on the live pulse.
  assert.equal(
    stepFromToolUpdate({
      sessionUpdate: "tool_call_update",
      kind: "read",
      status: "completed",
      rawInput: { path: "H:/proj/src/config.ts" },
    } as SessionUpdate),
    undefined,
  );
});

test("stepFromThought prefixes Thinking", () => {
  assert.ok(stepFromThought("consider edge cases").startsWith("Thinking"));
});

test("buildLocalTurnComment alias still works", () => {
  assert.equal(buildLocalTurnComment({ fileOps: new Map(), cancelled: true }), "Stopped by user");
  assert.ok(buildLocalTurnComment({ fileOps: new Map(), error: "boom" }).includes("boom"));
});

test("COMMENT_MAX is 250", () => {
  assert.equal(COMMENT_MAX, 250);
});

test("buildSessionCardComment idle is user prompt only", () => {
  const s = buildSessionCardComment({
    userPrompt: "make session cards show last user prompt",
    thinking: "I will read session-card.ts",
    busy: false,
  });
  assert.equal(s, "make session cards show last user prompt");
  assert.ok(!s.includes("session-card"));
});

test("buildSessionCardComment busy adds thinking on second line", () => {
  const s = buildSessionCardComment({
    userPrompt: "fix the cards",
    thinking: "Investigating session-runtime cardComment getter",
    busy: true,
  });
  const lines = s.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes("fix the cards"));
  assert.ok(lines[1]!.toLowerCase().includes("investigating") || lines[1]!.includes("cardComment"));
});

test("buildSessionCardComment clamps each line to 250", () => {
  const longUser = "u".repeat(400);
  const longThink = "t".repeat(400);
  const s = buildSessionCardComment({ userPrompt: longUser, thinking: longThink, busy: true });
  const lines = s.split("\n");
  assert.ok(lines[0]!.length <= 250);
  assert.ok(lines[1]!.length <= 250);
});

test("clampThinking prefers the ending", () => {
  const raw = "start noise ".repeat(30) + "final conclusion about the bug fix";
  const t = clampThinking(raw, 40);
  assert.ok(t.length <= 40);
  assert.ok(t.includes("bug") || t.includes("fix") || t.includes("conclusion") || t.startsWith("\u2026"));
});

test("buildSessionCardComment strips complexity wrappers from user line", () => {
  const raw =
    "COMPLEXITY (decide yourself — never ask the user):\n...\nUser task:\nadd password reset";
  const s = buildSessionCardComment({ userPrompt: raw, busy: false });
  assert.equal(s, "add password reset");
});
