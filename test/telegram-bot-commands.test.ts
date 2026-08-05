import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseTelegramBotCommands,
  parseTelegramBotUsernames,
} from "../src/config.js";
import { buildTelegramBridgeDirective } from "../src/render/telegram-bridge.js";

describe("parseTelegramBotUsernames", () => {
  it("strips @, lowercases, dedupes", () => {
    assert.deepEqual(parseTelegramBotUsernames("@HelperBot, helperbot, other_bot"), [
      "helperbot",
      "other_bot",
    ]);
  });
});

describe("parseTelegramBotCommands", () => {
  it("parses compact form with descriptions", () => {
    const m = parseTelegramBotCommands(
      "helperbot:status,help|Show help,ping;otherbot:start|Start the bot",
    );
    assert.deepEqual(m.helperbot, [
      { command: "status" },
      { command: "help", description: "Show help" },
      { command: "ping" },
    ]);
    assert.deepEqual(m.otherbot, [{ command: "start", description: "Start the bot" }]);
  });

  it("parses JSON object form", () => {
    const m = parseTelegramBotCommands(
      JSON.stringify({
        helperbot: ["status", "help"],
        otherbot: [{ command: "start", description: "Go" }],
      }),
    );
    assert.equal(m.helperbot?.length, 2);
    assert.deepEqual(m.otherbot, [{ command: "start", description: "Go" }]);
  });

  it("returns empty for blank", () => {
    assert.deepEqual(parseTelegramBotCommands(""), {});
    assert.deepEqual(parseTelegramBotCommands(undefined), {});
  });

  it("strips leading slash and rejects junk", () => {
    const m = parseTelegramBotCommands("botname:/Status,!!!,ok_cmd");
    assert.deepEqual(m.botname, [{ command: "status" }, { command: "ok_cmd" }]);
  });
});

describe("buildTelegramBridgeDirective with commands", () => {
  it("lists per-bot commands in capabilities", () => {
    const d = buildTelegramBridgeDirective({
      forumReady: false,
      allowedBots: ["helperbot"],
      botCommands: {
        helperbot: [
          { command: "status" },
          { command: "help", description: "Help text" },
        ],
      },
    });
    assert.ok(d.includes("@helperbot"));
    assert.ok(d.includes("/status"));
    assert.ok(d.includes("/help (Help text)"));
  });
});
