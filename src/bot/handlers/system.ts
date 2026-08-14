/**
 * System commands: /queue /clearqueue /model /restart /sandbox.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { ENV_PATH } from "../../config.js";
import type { BotDeps } from "../deps.js";

const SANDBOX_PROFILES = ["workspace-safe", "workspace", "strict", "read-only", "off"] as const;

export function registerSystem(bot: Bot, deps: BotDeps): void {
  bot.command("queue", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    if (rt.queueLength === 0) {
      await ctx.reply("Queue is empty. Send a message while I'm busy, or use /btw <text>.");
      return;
    }
    await ctx.reply(`\u{1F4E5} ${rt.queueLength} follow-up(s) queued. They run automatically after the current turn, or use /flush.`);
  });

  bot.command("clearqueue", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    const n = rt.clearQueue();
    await ctx.reply(n > 0 ? `\u{1F5D1} Cleared ${n} queued message(s).` : "Queue was already empty.");
  });

  bot.command("model", async (ctx) => {
    const modelId = (ctx.match || "").toString().trim();
    const rt = deps.registry.get(ctx.chat.id);
    if (!modelId) {
      await ctx.reply("Usage: /model <model-id>  (changes the model for the current session)");
      return;
    }
    if (!rt.sessionId) {
      await ctx.reply("No active session yet. Send a message or pick a /projects folder first.");
      return;
    }
    try {
      await deps.acp.setModel(rt.sessionId, modelId);
      await ctx.reply(`\u2705 Model set to \`${modelId}\` for this session.`, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`\u274C Could not set model: ${(err as Error).message}`);
    }
  });

  bot.command("restart", async (ctx) => {
    await ctx.reply("\u{1F501} Restarting the Grok agent\u2026");
    try {
      await deps.acp.restart();
      await ctx.reply("\u2705 Grok agent restarted. Your session will re-bind on the next message.");
    } catch (err) {
      await ctx.reply(`\u274C Restart failed: ${(err as Error).message}`);
    }
  });

  bot.command("sandbox", async (ctx) => {
    const arg = (ctx.match || "").toString().trim();
    const current = deps.cfg.sandboxProfile || process.env.GROK_SANDBOX || "(from ~/.grok/config.toml)";
    if (!arg) {
      const kb = new InlineKeyboard();
      for (const p of SANDBOX_PROFILES) kb.text(p, `sbx:${p}`).row();
      await ctx.reply(
        `\u{1F6E1} Sandbox profile now: ${current}\n` +
          `Grok 1.x reads GROK_SANDBOX or [sandbox] profile. Pick one, then /restart.\n` +
          `Or: /sandbox workspace-safe`,
        { reply_markup: kb },
      );
      return;
    }
    if (!(SANDBOX_PROFILES as readonly string[]).includes(arg)) {
      await ctx.reply(`Unknown profile. Use: ${SANDBOX_PROFILES.join(", ")}`);
      return;
    }
    try {
      upsertEnv("GROK_SANDBOX", arg);
      deps.cfg.sandboxProfile = arg;
      process.env.GROK_SANDBOX = arg;
      deps.acp.setAgentOptions({ sandboxProfile: arg });
      await ctx.reply(`\u2705 GROK_SANDBOX=${arg} written. Send /restart to apply.`);
    } catch (e) {
      await ctx.reply(`\u274C Could not write .env: ${(e as Error).message}`);
    }
  });

  bot.callbackQuery(/^sbx:([\w-]+)$/, async (ctx) => {
    const profile = ctx.match![1]!;
    if (!(SANDBOX_PROFILES as readonly string[]).includes(profile)) {
      await ctx.answerCallbackQuery({ text: "Unknown profile" });
      return;
    }
    try {
      upsertEnv("GROK_SANDBOX", profile);
      deps.cfg.sandboxProfile = profile;
      process.env.GROK_SANDBOX = profile;
      deps.acp.setAgentOptions({ sandboxProfile: profile });
      await ctx.answerCallbackQuery({ text: profile });
      await ctx.editMessageText(`\u2705 GROK_SANDBOX=${profile}. Send /restart to apply.`).catch(() => {});
    } catch (e) {
      await ctx.answerCallbackQuery({ text: (e as Error).message.slice(0, 40) });
    }
  });
}

/** Set KEY=value in the instance .env without dumping secrets. */
function upsertEnv(key: string, value: string): void {
  if (!existsSync(ENV_PATH)) throw new Error(".env not found");
  let body = readFileSync(ENV_PATH, "utf-8");
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) body = body.replace(re, `${key}=${value}`);
  else body = body.replace(/\s*$/, `\n${key}=${value}\n`);
  writeFileSync(ENV_PATH, body, "utf-8");
}
