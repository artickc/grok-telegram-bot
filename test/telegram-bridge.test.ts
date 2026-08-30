import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTelegramBridgeDirective,
  buildTelegramBridgeResultsPrompt,
  extractTelegramActions,
  isTelegramBridgeResultsPrompt,
  normalizeUsername,
  TELEGRAM_BRIDGE_MARKER,
  wrapTelegramBridgePrompt,
} from "../src/render/telegram-bridge.js";
import { textPrompt } from "../src/app/types.js";
import { stripDirectiveWrappers } from "../src/render/session-comment.js";

describe("extractTelegramActions", () => {
  it("parses multi-action telegram fence and strips it", () => {
    const raw = [
      "I'll create the topic and search memory.",
      "```json",
      JSON.stringify({
        telegram: [
          { action: "create_topic", name: "Feature X", path: "H:\\\\App" },
          { action: "search_memory", query: "password reset", limit: 5 },
          { action: "list_bots" },
        ],
      }),
      "```",
      "{progress: 40%}",
    ].join("\n");

    const { actions, cleaned } = extractTelegramActions(raw);
    assert.equal(actions.length, 3);
    assert.equal(actions[0]?.action, "create_topic");
    if (actions[0]?.action === "create_topic") {
      assert.equal(actions[0].name, "Feature X");
    }
    assert.equal(actions[1]?.action, "search_memory");
    assert.equal(actions[2]?.action, "list_bots");
    assert.ok(!cleaned.includes("```"));
    assert.ok(cleaned.includes("I'll create the topic"));
    assert.ok(cleaned.includes("{progress: 40%}"));
  });

  it("accepts a single action object under telegram", () => {
    const raw = '```json\n{"telegram":{"action":"list_bots"}}\n```';
    const { actions } = extractTelegramActions(raw);
    assert.deepEqual(actions, [{ action: "list_bots" }]);
  });

  it("accepts bare action array when every item has action", () => {
    const raw = '```json\n[{"action":"list_bots"},{"action":"search_memory","query":"foo"}]\n```';
    const { actions } = extractTelegramActions(raw);
    assert.equal(actions.length, 2);
  });

  it("ignores unrelated json fences", () => {
    const raw = 'Here is config:\n```json\n{"foo":1}\n```\ndone';
    const { actions, cleaned } = extractTelegramActions(raw);
    assert.equal(actions.length, 0);
    assert.ok(cleaned.includes('"foo":1'));
  });

  it("normalizes bot_command and caps bot commands", () => {
    const raw = [
      "```json",
      JSON.stringify({
        telegram: [
          { action: "bot_command", bot: "@HelperBot", command: "/status", args: "x" },
          { action: "bot_command", bot: "otherbot", command: "ping" },
          { action: "bot_command", bot: "thirdbot", command: "noop" },
          { action: "list_bots" },
        ],
      }),
      "```",
    ].join("\n");
    const { actions } = extractTelegramActions(raw);
    const cmds = actions.filter((a) => a.action === "bot_command");
    assert.equal(cmds.length, 2);
    assert.ok(actions.some((a) => a.action === "list_bots"));
    if (cmds[0]?.action === "bot_command") {
      assert.equal(cmds[0].bot, "helperbot");
      assert.equal(cmds[0].command, "status");
    }
  });

  it("rejects empty create_topic name", () => {
    const raw = '```json\n{"telegram":[{"action":"create_topic","name":"  "}]}\n```';
    const { actions } = extractTelegramActions(raw);
    assert.equal(actions.length, 0);
  });

  it("keeps long send_prompt bodies (not cropped at 4000)", () => {
    const long = "X".repeat(12_000);
    const raw = [
      "```json",
      JSON.stringify({
        telegram: [{ action: "send_prompt", topic: "MyApp", prompt: long }],
      }),
      "```",
    ].join("\n");
    const { actions } = extractTelegramActions(raw);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.action, "send_prompt");
    if (actions[0]?.action === "send_prompt") {
      assert.equal(actions[0].prompt.length, 12_000);
    }
  });

  it("splitBridgeAnnounceParts covers full prompt without loss", async () => {
    const { splitBridgeAnnounceParts } = await import("../src/bot/telegram-actions.js");
    const long = "ABCDEFGHIJ".repeat(800); // 8000 chars
    const parts = splitBridgeAnnounceParts(long, true);
    assert.ok(parts.length >= 2, "long prompt should multi-part");
    for (const p of parts) {
      assert.ok(p.length <= 4000, `part too long: ${p.length}`);
      assert.ok(p.includes("Prompt from bridge"));
    }
    // Reconstruct body by stripping headers — all payload chars present.
    const joined = parts
      .map((p) => p.replace(/^[^\n]*\n\n/, ""))
      .join("");
    assert.equal(joined, long, "multi-part announce must not drop prompt bytes");
  });

  it("parses set_path and send_prompt for cross-topic orchestration", () => {
    const raw = [
      "```json",
      JSON.stringify({
        telegram: [
          { action: "create_topic", name: "MyApp", path: "H:\\\\App" },
          { action: "set_path", topic: "MyApp", path: "H:\\\\App" },
          {
            action: "send_prompt",
            topic: "MyApp",
            prompt: "1) scaffold\n2) tests",
            new_session: true,
          },
          { action: "send_prompt", topic: "#42", prompt: "follow-up" },
        ],
      }),
      "```",
    ].join("\n");
    const { actions } = extractTelegramActions(raw);
    assert.equal(actions.length, 4);
    assert.equal(actions[1]?.action, "set_path");
    if (actions[1]?.action === "set_path") {
      assert.equal(actions[1].topic, "MyApp");
      assert.ok(actions[1].path.includes("App"));
    }
    assert.equal(actions[2]?.action, "send_prompt");
    if (actions[2]?.action === "send_prompt") {
      assert.equal(actions[2].newSession, true);
      assert.ok(actions[2].prompt.includes("scaffold"));
    }
    if (actions[3]?.action === "send_prompt") {
      assert.equal(actions[3].topic, "#42");
    }
  });

  it("caps send_prompt and allows up to 9 total actions", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      i < 6
        ? { action: "send_prompt", topic: `T${i}`, prompt: `do ${i}` }
        : { action: "list_bots" },
    );
    const raw = "```json\n" + JSON.stringify({ telegram: many }) + "\n```";
    const { actions } = extractTelegramActions(raw);
    assert.ok(actions.length <= 9);
    const sends = actions.filter((a) => a.action === "send_prompt");
    assert.ok(sends.length <= 5);
  });

  it("parses notify action and caps at 3", () => {
    const raw = [
      "```json",
      JSON.stringify({
        telegram: [
          { action: "notify", text: "On it." },
          { action: "notify", text: "Second", important: true },
          { action: "notify", text: "Third" },
          { action: "notify", text: "Fourth dropped" },
          { action: "send_prompt", topic: "MyApp", prompt: "go" },
        ],
      }),
      "```",
    ].join("\n");
    const { actions, cleaned } = extractTelegramActions(raw);
    const notes = actions.filter((a) => a.action === "notify");
    assert.equal(notes.length, 3);
    if (notes[0]?.action === "notify") assert.equal(notes[0].text, "On it.");
    if (notes[1]?.action === "notify") assert.equal(notes[1].important, true);
    assert.ok(!cleaned.includes("On it."));
    const dir = buildTelegramBridgeDirective({
      forumReady: true,
      topicGroupId: -100,
      allowedBots: [],
    });
    assert.ok(dir.includes("notify"));
    assert.ok(dir.includes("Quiet by default") || dir.includes("quiet"));
  });

  it("parses send_prompt session_id (and sess_ prefix forms)", () => {
    const raw = [
      "```json",
      JSON.stringify({
        telegram: [
          {
            action: "send_prompt",
            topic: "WSLG",
            session_id: "019fc9ec",
            prompt: "continue the fix",
          },
          {
            action: "send_prompt",
            topic: "WSLG",
            sessionId: "#sess_abcdef12",
            prompt: "also this",
          },
          {
            action: "send_prompt",
            session_id: "019fc9ec-full",
            prompt: "session only, no topic",
          },
        ],
      }),
      "```",
    ].join("\n");
    const { actions } = extractTelegramActions(raw);
    assert.equal(actions.length, 3);
    assert.equal(actions[0]?.action, "send_prompt");
    if (actions[0]?.action === "send_prompt") {
      assert.equal(actions[0].sessionId, "019fc9ec");
      assert.equal(actions[0].prompt, "continue the fix");
    }
    if (actions[1]?.action === "send_prompt") {
      assert.equal(actions[1].sessionId, "abcdef12");
    }
    if (actions[2]?.action === "send_prompt") {
      assert.equal(actions[2].sessionId, "019fc9ec-full");
      assert.equal(actions[2].topic, "");
    }
    // Directive must teach session_id resume.
    const dir = buildTelegramBridgeDirective({
      forumReady: true,
      topicGroupId: -100,
      allowedBots: [],
    });
    assert.ok(dir.includes("session_id"));
    assert.ok(dir.includes("RESUMES") || dir.includes("resume") || dir.includes("019fc9ec"));
    assert.ok(dir.includes("NEVER use placeholders") || dir.includes("placeholders"));
  });
});

describe("wrapTelegramBridgePrompt", () => {
  it("inserts after complexity User task marker", () => {
    const input = textPrompt("COMPLEXITY (decide yourself)\n\nUser task:\nfix the bug");
    const dir = buildTelegramBridgeDirective({
      forumReady: true,
      topicGroupId: -100,
      allowedBots: ["helperbot"],
    });
    const out = wrapTelegramBridgePrompt(input, dir);
    assert.ok(out.text.includes(TELEGRAM_BRIDGE_MARKER));
    assert.ok(out.text.includes("User task (continued):"));
    assert.ok(out.text.includes("fix the bug"));
    assert.ok(out.text.includes("@helperbot"));
    // Idempotent
    const again = wrapTelegramBridgePrompt(out, dir);
    assert.equal(again.text, out.text);
  });
});

describe("stripDirectiveWrappers + results", () => {
  it("strips telegram bridge continued task marker", () => {
    const raw =
      "COMPLEXITY (decide yourself)\n\nUser task:\n\nTELEGRAM BRIDGE (how to work in this chat):\nteach\n\nUser task (continued):\nreal ask";
    assert.equal(stripDirectiveWrappers(raw), "real ask");
  });

  it("does not leave '(continued):' when User task: is a prefix of continued", () => {
    // Regression: lastIndexOf("User task:") matched inside "User task (continued):".
    const raw = [
      "COMPLEXITY (decide yourself — never ask the user):",
      "stuff",
      "User task:",
      "",
      "TELEGRAM BRIDGE (how to work in this chat):",
      "Capabilities right now:",
      "- search_memory: always available",
      "",
      "User task (continued):",
      "inject telegram bridge memory",
    ].join("\n");
    const cleaned = stripDirectiveWrappers(raw);
    assert.equal(cleaned, "inject telegram bridge memory");
    assert.ok(!cleaned.includes("continued"));
    assert.ok(!cleaned.includes("TELEGRAM BRIDGE"));
  });

  it("detects results prompt", () => {
    const p = buildTelegramBridgeResultsPrompt([{ action: "list_bots", ok: true }]);
    assert.equal(isTelegramBridgeResultsPrompt(p), true);
    assert.equal(stripDirectiveWrappers(p), "");
  });
});

describe("normalizeUsername", () => {
  it("strips @ and lowercases", () => {
    assert.equal(normalizeUsername("@Foo_Bot"), "foo_bot");
  });
});
