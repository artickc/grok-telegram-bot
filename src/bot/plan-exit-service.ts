/**
 * Interactive plan-mode approval in Telegram.
 * Grok's exit_plan_mode reverse request becomes Approve / Request changes /
 * Abandon. If no owning chat exists (scheduled / orphan) or the prompt cannot
 * be sent, we auto-approve so the agent never sits on a TUI gate.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import type { PlanExitDecision, PlanExitOutcome } from "../grok/ext-methods.js";
import { createLogger } from "../logger.js";
import { sendMarkdownDoc } from "./telegram-io.js";

const log = createLogger("plan-exit");
const TIMEOUT_MS = 30 * 60 * 1000;
const PREVIEW = 3500;

interface Pending {
  resolve: (d: PlanExitDecision) => void;
  chatId: number;
  messageId?: number;
  timer: NodeJS.Timeout;
  pinned: boolean;
  waitingFeedback: boolean;
}

export class PlanExitService {
  private readonly pending = new Map<string, Pending>();
  private readonly feedbackFor = new Map<number, string>();
  private seq = 0;

  constructor(
    private readonly api: Api,
    public autoApprove = false,
    private readonly onUnpinned?: (chatId: number) => void | Promise<void>,
  ) {}

  async handle(
    params: Record<string, unknown>,
    ctx: { chatId?: number; cwd?: string },
  ): Promise<PlanExitDecision> {
    const sessionId = str(params.sessionId) || str(params.session_id) || "";
    const planText = resolvePlanText(params, sessionId, ctx.cwd);
    if (this.autoApprove) {
      log.info(`auto-approved plan exit for ${sessionId.slice(0, 8) || "?"}`);
      return { outcome: "approved", feedback: "" };
    }
    const chatId = ctx.chatId;
    if (chatId === undefined) {
      log.info("no owning chat — auto-approving plan exit");
      return { outcome: "approved", feedback: "" };
    }

    const reqId = String(++this.seq);
    if (planText.trim()) {
      await sendMarkdownDoc(this.api, chatId, `**Plan**\n\n${planText}`, { loud: true }).catch((e) => {
        log.warn("send plan body failed:", (e as Error).message);
      });
    }

    const snippet = planText.replace(/\s+/g, " ").trim().slice(0, 400);
    const body = [
      "\u{1F4CB} Plan ready \u2014 approve before Grok implements.",
      snippet ? `\n${snippet}${planText.length > 400 ? "\u2026" : ""}` : "\n(No plan text in the request.)",
      "\nApprove / Changes / Abandon \u2014 or just send a message to request changes.",
    ].join("\n");

    const kb = new InlineKeyboard()
      .text("\u2705 Approve", `planx:${reqId}:ok`)
      .text("\u270F\uFE0F Changes", `planx:${reqId}:chg`)
      .row()
      .text("\u26D4 Abandon", `planx:${reqId}:no`);

    let messageId: number | undefined;
    let pinned = false;
    try {
      const msg = await this.api.sendMessage(chatId, body, {
        reply_markup: kb,
        disable_notification: false,
      });
      messageId = msg.message_id;
      try {
        await this.api.pinChatMessage(chatId, messageId, { disable_notification: true });
        pinned = true;
      } catch (e) {
        log.warn("pin plan prompt failed:", (e as Error).message);
      }
    } catch (e) {
      log.warn("send plan prompt failed — auto-approving:", (e as Error).message);
      return { outcome: "approved", feedback: "" };
    }

    return new Promise<PlanExitDecision>((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(reqId);
        if (!p) return;
        this.pending.delete(reqId);
        this.feedbackFor.delete(p.chatId);
        void this.finish(p, "\u231B Plan approval timed out \u2014 abandoned.");
        resolve({ outcome: "abandoned", feedback: "timed out waiting for review" });
      }, TIMEOUT_MS);
      this.pending.set(reqId, { resolve, chatId, messageId, timer, pinned, waitingFeedback: false });
      this.feedbackFor.set(chatId, reqId);
    });
  }

  resolveChoice(reqId: string, action: string): string | undefined {
    const p = this.pending.get(reqId);
    if (!p) return undefined;
    if (action === "chg") {
      p.waitingFeedback = true;
      this.feedbackFor.set(p.chatId, reqId);
      if (p.messageId !== undefined) {
        void this.api
          .editMessageText(p.chatId, p.messageId, "\u270F\uFE0F Send revision notes as your next message.", {
            reply_markup: { inline_keyboard: [] },
          })
          .catch(() => {});
      }
      return "Send change notes";
    }
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    this.feedbackFor.delete(p.chatId);
    const outcome: PlanExitOutcome = action === "ok" ? "approved" : "abandoned";
    const label = outcome === "approved" ? "\u2705 Plan approved \u2014 implementing." : "\u26D4 Plan abandoned.";
    void this.finish(p, label);
    p.resolve({ outcome, feedback: "" });
    return outcome === "approved" ? "Approved" : "Abandoned";
  }

  /**
   * Any plain follow-up in this chat while a plan is waiting counts as
   * "request changes" (the message is the revision note). Also used after
   * the Changes button.
   */
  takeFeedback(chatId: number, text: string): boolean {
    const reqId = this.feedbackFor.get(chatId) ?? this.reqIdForChat(chatId);
    if (!reqId) return false;
    const p = this.pending.get(reqId);
    this.feedbackFor.delete(chatId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    const notes = text.trim().slice(0, 4000);
    void this.finish(p, `\u270F\uFE0F Requested changes:\n${notes.slice(0, 400)}`);
    p.resolve({ outcome: "request_changes", feedback: notes || "Please revise the plan." });
    return true;
  }

  private reqIdForChat(chatId: number): string | undefined {
    for (const [id, p] of this.pending) {
      if (p.chatId === chatId) return id;
    }
    return undefined;
  }

  private async finish(p: Pending, text: string): Promise<void> {
    if (p.messageId !== undefined) {
      await this.api
        .editMessageText(p.chatId, p.messageId, text, { reply_markup: { inline_keyboard: [] } })
        .catch(() => {});
    }
    if (p.pinned && p.messageId !== undefined) {
      p.pinned = false;
      await this.api.unpinChatMessage(p.chatId, p.messageId).catch(() => {});
    }
    if (this.onUnpinned) {
      try {
        await this.onUnpinned(p.chatId);
      } catch {
        /* non-fatal */
      }
    }
  }
}

export function resolvePlanText(params: Record<string, unknown>, sessionId: string, cwd?: string): string {
  const inline = extractPlanText(params);
  if (inline.trim()) return inline.slice(0, PREVIEW * 4);
  const file = firstString(params, ["plan_path", "planPath", "path", "file"]);
  if (file && existsSync(file)) return readCap(file);
  if (sessionId && cwd) {
    const disk = join(homedir(), ".grok", "sessions", encodeURIComponent(cwd), sessionId, "plan.md");
    if (existsSync(disk)) return readCap(disk);
  }
  return "";
}

export function extractPlanText(params: Record<string, unknown>): string {
  return firstString(params, ["plan_content", "planContent", "content", "plan", "text"]);
}

function firstString(params: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function readCap(path: string): string {
  try {
    return readFileSync(path, "utf-8").slice(0, PREVIEW * 4);
  } catch {
    return "";
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
