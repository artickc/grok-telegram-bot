/**
 * Interactive plan-mode approval. Grok's exit_plan_mode reverse request
 * becomes Approve / Request changes / Abandon buttons (same idea as
 * PermissionService). Auto-approve is used when configured, or when the
 * session has no owning chat (scheduled / orphan).
 */
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import type { PlanExitDecision, PlanExitOutcome } from "../grok/plan-approval.js";
import { forumThreadId, interactiveWaitKey, outboundThreadExtra } from "../forum/thread.js";
import { createLogger } from "../logger.js";
import type { RuntimeRegistry } from "./registry.js";

const log = createLogger("plan-exit");
const TIMEOUT_MS = 30 * 60 * 1000;
const PREVIEW = 900;

interface Pending {
  resolve: (d: PlanExitDecision) => void;
  chatId: number;
  threadId?: number;
  messageId?: number;
  timer: NodeJS.Timeout;
  pinned: boolean;
  waitingFeedback: boolean;
}

export class PlanExitService {
  private readonly pending = new Map<string, Pending>();
  /** `${chatId}:${threadId}` → reqId while waiting for revision notes. */
  private readonly feedbackFor = new Map<string, string>();
  private seq = 0;

  constructor(
    private readonly api: Api,
    private readonly registry: RuntimeRegistry,
    public autoApprove = false,
    private readonly onUnpinned?: (chatId: number) => void | Promise<void>,
  ) {}

  async handle(params: Record<string, unknown>): Promise<PlanExitDecision> {
    const sessionId = str(params.sessionId) || str(params.session_id) || "";
    const planText = extractPlanText(params);
    if (this.autoApprove) {
      log.info(`auto-approved plan exit for ${sessionId.slice(0, 8) || "?"}`);
      return { outcome: "approved", feedback: "" };
    }

    const desc = sessionId ? this.registry.describeSession(sessionId) : { chatId: undefined };
    const chatId = desc.chatId;
    if (chatId === undefined) return { outcome: "approved", feedback: "" };
    const threadExtra = outboundThreadExtra(desc.threadId);

    const reqId = String(++this.seq);
    const preview = planText.replace(/\s+/g, " ").trim().slice(0, PREVIEW);
    const body = [
      "\u{1F4CB} Plan ready \u2014 review before Grok implements.",
      preview ? `\n${preview}${planText.length > PREVIEW ? "\u2026" : ""}` : "\n(No plan text in the request.)",
      "\nApprove to build, request changes (then send notes), or abandon.",
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
        ...threadExtra,
      });
      messageId = msg.message_id;
      try {
        await this.api.pinChatMessage(chatId, messageId, { disable_notification: true });
        pinned = true;
      } catch (e) {
        log.warn("pin plan prompt failed:", (e as Error).message);
      }
    } catch (e) {
      log.warn("send plan prompt failed:", (e as Error).message);
      return { outcome: "approved", feedback: "" };
    }

    return new Promise<PlanExitDecision>((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(reqId);
        if (!p) return;
        this.pending.delete(reqId);
        this.clearFeedbackWait(p);
        void this.finish(p, "\u231B Plan approval timed out \u2014 abandoned.");
        resolve({ outcome: "abandoned", feedback: "timed out waiting for review" });
      }, TIMEOUT_MS);
      this.pending.set(reqId, {
        resolve,
        chatId,
        threadId: desc.threadId,
        messageId,
        timer,
        pinned,
        waitingFeedback: false,
      });
    });
  }

  /** Button tap. Returns a short toast; "chg" waits for the next text message. */
  resolveChoice(reqId: string, action: string): string | undefined {
    const p = this.pending.get(reqId);
    if (!p) return undefined;
    if (action === "chg") {
      p.waitingFeedback = true;
      this.feedbackFor.set(interactiveWaitKey(p.chatId, p.threadId), reqId);
      void this.api
        .editMessageText(p.chatId, p.messageId ?? 0, "\u270F\uFE0F Send revision notes as your next message.", {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
      return "Send change notes";
    }
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    this.clearFeedbackWait(p);
    const outcome: PlanExitOutcome = action === "ok" ? "approved" : "abandoned";
    const label = outcome === "approved" ? "\u2705 Plan approved \u2014 implementing." : "\u26D4 Plan abandoned.";
    void this.finish(p, label);
    p.resolve({ outcome, feedback: "" });
    return outcome === "approved" ? "Approved" : "Abandoned";
  }

  /** If this forum topic is waiting for revision notes, consume the text. */
  takeFeedback(chatId: number, text: string, messageThreadId?: number): boolean {
    const reqId = this.lookupFeedbackWait(chatId, messageThreadId);
    if (!reqId) return false;
    const p = this.pending.get(reqId);
    if (!p) {
      this.feedbackFor.delete(interactiveWaitKey(chatId, messageThreadId));
      return false;
    }
    this.clearFeedbackWait(p);
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    const notes = text.trim().slice(0, 4000);
    void this.finish(p, `\u270F\uFE0F Requested changes:\n${notes.slice(0, 400)}`);
    p.resolve({ outcome: "request_changes", feedback: notes || "Please revise the plan." });
    return true;
  }

  private clearFeedbackWait(p: { chatId: number; threadId?: number }): void {
    this.feedbackFor.delete(interactiveWaitKey(p.chatId, p.threadId));
    if (p.threadId === 1 || p.threadId === undefined) {
      this.feedbackFor.delete(interactiveWaitKey(p.chatId, 1));
      this.feedbackFor.delete(interactiveWaitKey(p.chatId, undefined));
    }
  }

  private lookupFeedbackWait(chatId: number, messageThreadId?: number): string | undefined {
    const keys = [
      interactiveWaitKey(chatId, messageThreadId),
      interactiveWaitKey(chatId, forumThreadId(messageThreadId)),
    ];
    if (messageThreadId === undefined) keys.push(interactiveWaitKey(chatId, 1));
    if (messageThreadId === 1) keys.push(interactiveWaitKey(chatId, undefined));
    for (const k of keys) {
      const id = this.feedbackFor.get(k);
      if (id) return id;
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

export function extractPlanText(params: Record<string, unknown>): string {
  for (const k of ["plan_content", "planContent", "content", "plan", "text"]) {
    const v = params[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
