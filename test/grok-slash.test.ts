import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BOT_RESERVED_COMMANDS,
  shouldForwardSlashToGrok,
  toGrokSlashLine,
} from "../src/bot/handlers/grok-slash.js";

describe("grok slash forward", () => {
  it("forwards /goal and aliases", () => {
    assert.equal(shouldForwardSlashToGrok("/goal status"), true);
    assert.equal(shouldForwardSlashToGrok("/plan migrate auth"), true);
    assert.equal(shouldForwardSlashToGrok("/view_plan"), true);
    assert.equal(shouldForwardSlashToGrok("/deep_research foo"), true);
  });

  it("does not forward bot-reserved commands", () => {
    assert.equal(shouldForwardSlashToGrok("/help"), false);
    assert.equal(shouldForwardSlashToGrok("/projects"), false);
    assert.equal(shouldForwardSlashToGrok("/status"), false);
    assert.ok(BOT_RESERVED_COMMANDS.has("reauth"));
  });

  it("maps underscores to Grok hyphenated names", () => {
    assert.equal(toGrokSlashLine("/view_plan"), "/view-plan");
    assert.equal(toGrokSlashLine("/deep_research Compare X"), "/deep-research Compare X");
    assert.equal(toGrokSlashLine("/goal status"), "/goal status");
    assert.equal(toGrokSlashLine("/always_approve"), "/always-approve");
  });

  it("strips @botname suffix", () => {
    assert.equal(toGrokSlashLine("/goal@MyBot status"), "/goal status");
  });
});
