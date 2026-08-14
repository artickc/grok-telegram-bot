import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, BOT_COMMANDS } from "../src/bot/commands.js";
import {
  BOT_RESERVED_COMMANDS,
  GROK_FORWARDED_COMMANDS,
  GROK_SHELL_ACP_COMMANDS,
  GROK_SLASH_ALIASES,
  resolveGrokCommandName,
  shouldForwardSlashToGrok,
  toGrokSlashLine,
} from "../src/bot/handlers/grok-slash.js";

describe("grok slash forward", () => {
  it("forwards /goal and multi-word forms", () => {
    assert.equal(shouldForwardSlashToGrok("/goal status"), true);
    assert.equal(shouldForwardSlashToGrok("/plan migrate auth"), true);
    assert.equal(shouldForwardSlashToGrok("/view_plan"), true);
    assert.equal(shouldForwardSlashToGrok("/deep_research foo"), true);
    assert.equal(shouldForwardSlashToGrok("/imagine_video a cat"), true);
    assert.equal(shouldForwardSlashToGrok("/config_agents"), true);
    assert.equal(shouldForwardSlashToGrok("/release_notes"), true);
  });

  it("does not forward bot-reserved commands", () => {
    for (const name of [
      "help",
      "projects",
      "status",
      "reauth",
      "flush",
      "new",
      "usage",
      "btw",
      "model",
      "sessions",
      "history",
      "mcp",
      "sandbox",
    ]) {
      assert.equal(shouldForwardSlashToGrok(`/${name}`), false, name);
      assert.ok(BOT_RESERVED_COMMANDS.has(name), `reserved:${name}`);
    }
  });

  it("maps underscores to Grok hyphenated names", () => {
    assert.equal(toGrokSlashLine("/view_plan"), "/view-plan");
    assert.equal(toGrokSlashLine("/deep_research Compare X"), "/deep-research Compare X");
    assert.equal(toGrokSlashLine("/goal status"), "/goal status");
    assert.equal(toGrokSlashLine("/always_approve"), "/always-approve");
    assert.equal(toGrokSlashLine("/session_info"), "/session-info");
    assert.equal(toGrokSlashLine("/imagine_video demo"), "/imagine-video demo");
    assert.equal(toGrokSlashLine("/config_agents"), "/config-agents");
    assert.equal(toGrokSlashLine("/release_notes"), "/release-notes");
  });

  it("maps documented Grok aliases", () => {
    assert.equal(toGrokSlashLine("/show_plan"), "/view-plan");
    assert.equal(toGrokSlashLine("/plan_view"), "/view-plan");
    assert.equal(toGrokSlashLine("/clear"), "/new");
    assert.equal(toGrokSlashLine("/undo"), "/rewind");
    assert.equal(toGrokSlashLine("/title My Session"), "/rename My Session");
    assert.equal(toGrokSlashLine("/mem"), "/memory");
    assert.equal(toGrokSlashLine("/cost"), "/usage");
    assert.equal(toGrokSlashLine("/agents"), "/config-agents");
    assert.equal(toGrokSlashLine("/howto"), "/docs");
    assert.equal(toGrokSlashLine("/guides Getting Started"), "/docs Getting Started");
    assert.equal(toGrokSlashLine("/changelog"), "/release-notes");
  });

  it("maps collision aliases to Grok builtins without stealing bot names", () => {
    assert.equal(shouldForwardSlashToGrok("/memory_flush"), true);
    assert.equal(toGrokSlashLine("/memory_flush"), "/flush");
    assert.equal(toGrokSlashLine("/grok_flush"), "/flush");
    assert.equal(shouldForwardSlashToGrok("/grok_new"), true);
    assert.equal(toGrokSlashLine("/grok_new"), "/new");
    assert.equal(toGrokSlashLine("/session_new"), "/new");
    assert.equal(toGrokSlashLine("/grok_usage"), "/usage");
    assert.equal(toGrokSlashLine("/grok_cost"), "/usage");
    assert.equal(toGrokSlashLine("/grok_btw also check errors"), "/btw also check errors");
    // bare reserved still not forwarded
    assert.equal(shouldForwardSlashToGrok("/flush"), false);
    assert.equal(shouldForwardSlashToGrok("/new"), false);
    assert.equal(shouldForwardSlashToGrok("/usage"), false);
    assert.equal(shouldForwardSlashToGrok("/btw"), false);
  });

  it("strips @botname suffix", () => {
    assert.equal(toGrokSlashLine("/goal@MyBot status"), "/goal status");
    assert.equal(toGrokSlashLine("/view_plan@MyBot"), "/view-plan");
    assert.equal(toGrokSlashLine("/memory_flush@bot"), "/flush");
  });

  it("resolveGrokCommandName matches toGrokSlashLine base", () => {
    assert.equal(resolveGrokCommandName("view_plan"), "view-plan");
    assert.equal(resolveGrokCommandName("show_plan"), "view-plan");
    assert.equal(resolveGrokCommandName("memory_flush"), "flush");
    assert.equal(resolveGrokCommandName("compact"), "compact");
  });

  it("ACP shell catalog is reachable via menu mapping or alias or underscore fold", () => {
    // Every official ACP-useful shell command must resolve from some Telegram name
    // that is either in the menu, an alias, or the plain name (when not reserved).
    for (const grok of GROK_SHELL_ACP_COMMANDS) {
      const telegramForms = [
        grok,
        grok.replace(/-/g, "_"),
        ...Object.entries(GROK_SLASH_ALIASES)
          .filter(([, g]) => g === grok)
          .map(([t]) => t),
        ...GROK_FORWARDED_COMMANDS.filter((c) => c.grok === grok).map((c) => c.command),
      ];
      const unique = [...new Set(telegramForms)];
      const resolved = unique.some((t) => resolveGrokCommandName(t) === grok);
      assert.ok(resolved, `no telegram form resolves to /${grok} (tried ${unique.join(",")})`);

      // If bare name is not bot-reserved, catch-all must forward it
      if (!BOT_RESERVED_COMMANDS.has(grok) && !grok.includes("-")) {
        assert.equal(shouldForwardSlashToGrok(`/${grok}`), true, `forward bare /${grok}`);
      }
      // Hyphenated names are typed with underscores on Telegram
      if (grok.includes("-")) {
        const und = grok.replace(/-/g, "_");
        assert.equal(shouldForwardSlashToGrok(`/${und}`), true, `forward /${und}`);
        assert.equal(toGrokSlashLine(`/${und}`), `/${grok}`);
      }
    }
  });

  it("menu stays under Telegram 100-command limit and includes collision aliases", () => {
    assert.ok(COMMANDS.length <= 100, `COMMANDS length ${COMMANDS.length} > 100`);
    assert.ok(COMMANDS.length === BOT_COMMANDS.length + GROK_FORWARDED_COMMANDS.length);
    const names = new Set(COMMANDS.map((c) => c.command));
    // collision aliases advertised
    for (const need of ["memory_flush", "grok_new", "grok_usage", "grok_btw", "session_info"]) {
      assert.ok(names.has(need), `menu missing ${need}`);
    }
    // bot-owned bare names still present
    for (const need of ["flush", "new", "usage", "btw", "status", "help"]) {
      assert.ok(names.has(need), `menu missing bot ${need}`);
    }
    // no reserved name stolen as a Grok menu entry with different semantics
    for (const def of GROK_FORWARDED_COMMANDS) {
      assert.ok(!BOT_RESERVED_COMMANDS.has(def.command), `Grok menu uses reserved ${def.command}`);
    }
  });

  it("rejects multi-line and non-slash text for forward", () => {
    assert.equal(shouldForwardSlashToGrok("hello"), false);
    assert.equal(shouldForwardSlashToGrok("/goal\nstatus"), false);
    assert.equal(shouldForwardSlashToGrok(""), false);
  });
});
