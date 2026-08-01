/**
 * /usage — Grok CLI live monthly quota + session context + bot-tracked
 * per-account turn stats.
 */
import type { Bot, Context } from "grammy";
import type { StoredAccount } from "../../app/accounts.js";
import { formatCliBillingLines } from "../../app/usage.js";
import type { BotDeps } from "../deps.js";

export async function showUsage(ctx: Context, deps: BotDeps): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const rt = deps.registry.get(ctx.chat!.id);
  const acct = await deps.usage.account();
  const meta = rt.contextInfo();
  const ctx100 = meta?.contextUsagePercentage;
  const list = deps.accounts.list();
  const activeId = deps.accounts.activeAccountId();
  const activeMeta = activeId ? deps.accounts.get(activeId) : undefined;
  const { billing, error: billingError } = await deps.usage.cliBilling();

  const lines: string[] = [
    "\u{1F4CA} Usage & accounts",
    "",
    "\u{1F464} Current login",
    acct?.email ? `  ${acct.email}` : "  (identity unknown)",
  ];
  if (acct?.accountType) {
    lines.push(`  \u{1F511} ${acct.accountType}${acct.region ? ` \u00B7 ${acct.region}` : ""}`);
  }
  if (acct?.teamId) lines.push(`  Team: ${acct.teamId.slice(0, 8)}\u2026`);
  if (activeMeta) {
    const uLine = deps.accounts.formatUsageLine(activeMeta);
    lines.push(`  Saved as: ${activeMeta.label}`);
    if (uLine) lines.push(`  Bot-tracked: ${uLine}`);
  }

  lines.push("");
  if (billing) {
    lines.push(...formatCliBillingLines(billing));
  } else {
    lines.push(
      "\u{1F4B3} Grok CLI monthly quota",
      `  \u26A0\uFE0F ${billingError || "unavailable"}`,
      "  (Requires `grok login` OIDC token — not XAI_API_KEY alone.)",
    );
  }

  lines.push(
    "",
    "\u{1F9F5} This session (ACP)",
    `  Id: ${rt.sessionId ? rt.sessionId.slice(0, 8) : "none"}`,
    `  Model: ${rt.model || "default"}`,
    `  Context used: ${ctx100 !== undefined ? `${ctx100.toFixed(0)}%` : "\u2014"}`,
    `  Turns this session: ${rt.turns}`,
  );
  if (meta?.credits !== undefined) {
    lines.push(`  Credits (session report): ${fmtNum(meta.credits)}`);
  }
  if (meta?.effort) lines.push(`  Effort: ${meta.effort}`);
  if (meta?.totalTokens !== undefined) {
    lines.push(`  Tokens (session report): ${meta.totalTokens.toLocaleString("en-US")}`);
  }

  if (list.length > 0) {
    lines.push("", "\u{1F465} Saved accounts (bot-tracked turns on this machine)");
    for (const a of list) {
      lines.push(accountUsageBlock(deps, a, a.id === activeId));
    }
    const totals = aggregate(list);
    lines.push(
      "",
      `\u{1F4CA} Bot totals: ${totals.turns} turn${totals.turns === 1 ? "" : "s"}` +
        (totals.credits > 0 ? ` \u00B7 ${fmtNum(totals.credits)} session credits` : "") +
        ` \u00B7 ${totals.withUsage}/${list.length} accounts used`,
    );
  } else {
    lines.push("", "\u{1F465} No saved accounts yet \u2014 /accounts to save & switch.");
  }

  lines.push(
    "",
    "\u2139\uFE0F Monthly quota is live from Grok CLI (`cli-chat-proxy` billing). Bot-tracked turns are local to this bot.",
  );

  if (!acct) lines.splice(3, 0, "  (account info unavailable \u2014 is grok logged in?)");

  await deps.ephemeral.open(ctx);
  await deps.ephemeral.reply(ctx, lines.join("\n"));
}

function accountUsageBlock(deps: BotDeps, a: StoredAccount, active: boolean): string {
  const mark = a.warning ? "\u26A0\uFE0F" : active ? "\u2705" : "\u{1F464}";
  const u = a.usage;
  const head = `${mark} ${a.label}${active ? " (active)" : ""}`;
  if (!u || (u.turns <= 0 && u.credits <= 0 && !u.lastUsedAt)) {
    return `${head}\n  no bot-tracked usage yet`;
  }
  const bits: string[] = [];
  bits.push(`${u.turns || 0} turn${(u.turns || 0) === 1 ? "" : "s"}`);
  if (u.credits > 0) bits.push(`${fmtNum(u.credits)} session credits`);
  if (u.lastTurnCredits !== undefined) bits.push(`last turn ${fmtNum(u.lastTurnCredits)}`);
  if (u.lastContextPct !== undefined) bits.push(`last ctx ${u.lastContextPct.toFixed(0)}%`);
  if (u.lastUsedAt) bits.push(`last ${shortWhen(u.lastUsedAt)}`);
  return `${head}\n  ${bits.join(" \u00B7 ")}`;
}

function aggregate(list: StoredAccount[]): { turns: number; credits: number; withUsage: number } {
  let turns = 0;
  let credits = 0;
  let withUsage = 0;
  for (const a of list) {
    const u = a.usage;
    if (!u) continue;
    turns += u.turns || 0;
    credits += u.credits || 0;
    if (u.turns > 0 || u.credits > 0 || u.lastUsedAt) withUsage++;
  }
  return { turns, credits, withUsage };
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toFixed(2);
}

function shortWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86_400 * 14) return `${Math.floor(sec / 86_400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

export function registerUsage(bot: Bot, deps: BotDeps): void {
  bot.command("usage", (ctx) => showUsage(ctx, deps));
}
