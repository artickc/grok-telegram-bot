/**
 * Interactive Grok `ask_user_question` reverse requests.
 *
 * Shows questions as Telegram inline buttons; user can also type a free-text
 * answer. Resolves the ACP reverse-request with the current wire format
 * (`outcome: accepted | skip_interview | cancelled`) so the session continues
 * without interruption.
 */
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { forumThreadId, interactiveWaitKey, outboundThreadExtra } from "../forum/thread.js";
import { createLogger } from "../logger.js";
import type { RuntimeRegistry } from "./registry.js";

const log = createLogger("ask-user");
const TIMEOUT_MS = 30 * 60 * 1000;

export interface InterviewQuestion {
  id: string;
  /** Exact prompt text — also used as the answers map key on the wire. */
  prompt: string;
  options: Array<{ id: string; label: string }>;
  multi: boolean;
}

/** Current Grok AskUserQuestionExtResponse (internally tagged on `outcome`). */
export type AskUserResult =
  | {
      outcome: "accepted";
      answers: Record<string, string[]>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
    }
  | { outcome: "skip_interview"; partial_answers?: Record<string, string> }
  | { outcome: "cancelled" }
  | { outcome: "chat_about_this"; partial_answers?: Record<string, string> };

interface Pending {
  resolve: (r: AskUserResult) => void;
  chatId: number;
  /** Forum topic id (1 = General); undefined for private chats. */
  threadId?: number;
  sessionId: string;
  messageId?: number;
  questions: InterviewQuestion[];
  /** questionId → selected option ids */
  picked: Map<string, Set<string>>;
  /** questionId → free-text notes (typed answer) */
  notes: Map<string, string>;
  index: number;
  timer: NodeJS.Timeout;
  waitingText: boolean;
}

export class AskUserService {
  private readonly pending = new Map<string, Pending>();
  /** `${chatId}:${threadId}` → reqId while waiting for a typed answer. */
  private readonly textFor = new Map<string, string>();
  private seq = 0;

  constructor(
    private readonly api: Api,
    private readonly registry: RuntimeRegistry,
    /** When true, skip the interview (unattended). Default false = interactive. */
    public autoSkip = false,
  ) {}

  async handle(params: Record<string, unknown>): Promise<AskUserResult> {
    const questions = parseQuestions(params);
    const sessionId = str(params.sessionId) || str(params.session_id) || "";
    if (this.autoSkip || questions.length === 0) {
      log.info(`skip ask_user_question (${questions.length} q, autoSkip=${this.autoSkip})`);
      return { outcome: "skip_interview", partial_answers: {} };
    }
    const desc = sessionId ? this.registry.describeSession(sessionId) : { chatId: undefined };
    const chatId = desc.chatId;
    if (chatId === undefined) {
      log.info("ask_user_question: no owning chat — skip");
      return { outcome: "skip_interview", partial_answers: {} };
    }
    const threadExtra = outboundThreadExtra(desc.threadId);

    const reqId = String(++this.seq);
    const picked = new Map<string, Set<string>>();
    const notes = new Map<string, string>();
    for (const q of questions) picked.set(q.id, new Set());

    // Surface wait on the busy live bubble.
    const waitLine = questions[0]?.prompt?.slice(0, 100) || "question";
    for (const rt of this.registry.busyRuntimesForChat(chatId, desc.threadId)) {
      try {
        rt.noticePermissionWait(`Answer needed: ${waitLine}`);
      } catch {
        /* non-fatal */
      }
    }

    try {
      log.info(
        `ask_user prompt chat=${chatId}` +
          (desc.threadId !== undefined ? ` thread=${desc.threadId}` : "") +
          ` q=${questions.length} session=${sessionId.slice(0, 8) || "?"}`,
      );
      const msg = await this.api.sendMessage(chatId, renderQuestion(questions, 0, picked, notes), {
        reply_markup: questionKeyboard(reqId, questions[0]!, picked.get(questions[0]!.id)!, 0, questions.length),
        disable_notification: false,
        ...threadExtra,
      });
      return new Promise<AskUserResult>((resolve) => {
        const timer = setTimeout(() => {
          const p = this.pending.get(reqId);
          if (!p) return;
          this.clearTextWait(p);
          this.pending.delete(reqId);
          void this.api
            .editMessageText(p.chatId, p.messageId ?? 0, "\u231B Question timed out \u2014 skipped.", {
              reply_markup: { inline_keyboard: [] },
            })
            .catch(() => {});
          resolve({ outcome: "skip_interview", partial_answers: {} });
        }, TIMEOUT_MS);
        this.pending.set(reqId, {
          resolve,
          chatId,
          threadId: desc.threadId,
          sessionId,
          messageId: msg.message_id,
          questions,
          picked,
          notes,
          index: 0,
          timer,
          waitingText: false,
        });
      });
    } catch (e) {
      log.warn("send ask_user failed:", (e as Error).message);
      return { outcome: "skip_interview", partial_answers: {} };
    }
  }

  tap(reqId: string, kind: string, value?: string): string | undefined {
    const p = this.pending.get(reqId);
    if (!p) return undefined;
    const q = p.questions[p.index];
    if (!q) return undefined;

    if (kind === "skip") {
      this.settle(p, reqId, { outcome: "skip_interview", partial_answers: {} }, "\u23ED Skipped questions.");
      return "Skipped";
    }
    if (kind === "cancel") {
      this.settle(p, reqId, { outcome: "cancelled" }, "\u26D4 Questions cancelled.");
      return "Cancelled";
    }
    if (kind === "type") {
      p.waitingText = true;
      this.textFor.set(interactiveWaitKey(p.chatId, p.threadId), reqId);
      void this.api
        .editMessageText(
          p.chatId,
          p.messageId ?? 0,
          `${renderQuestion(p.questions, p.index, p.picked, p.notes)}\n\n\u270F\uFE0F Type your answer as the next message.`,
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {});
      return "Type your answer";
    }
    if (kind === "opt" && value !== undefined) {
      const opt = q.options[Number(value)];
      if (!opt) return "Expired";
      const set = p.picked.get(q.id)!;
      // Choosing a canned option clears free-text for this question.
      p.notes.delete(q.id);
      if (q.multi) {
        if (set.has(opt.id)) set.delete(opt.id);
        else set.add(opt.id);
      } else {
        set.clear();
        set.add(opt.id);
      }
      void this.redraw(reqId, p);
      return q.multi ? "Toggled" : "Selected";
    }
    if (kind === "next") {
      const set = p.picked.get(q.id)!;
      const note = p.notes.get(q.id);
      if (set.size === 0 && !note) return "Pick an option or type an answer";
      if (p.index < p.questions.length - 1) {
        p.index += 1;
        p.waitingText = false;
        this.clearTextWait(p);
        void this.redraw(reqId, p);
        return "Next";
      }
      this.settle(p, reqId, buildAcceptedResult(p.questions, p.picked, p.notes), "\u2705 Answers sent.");
      return "Submitted";
    }
    if (kind === "prev" && p.index > 0) {
      p.index -= 1;
      p.waitingText = false;
      this.clearTextWait(p);
      void this.redraw(reqId, p);
      return "Back";
    }
    return undefined;
  }

  /**
   * If this forum topic / private chat is waiting for a typed answer, consume
   * the text as free-form for the current question. Returns true when consumed
   * (do not treat as a new agent prompt).
   * `messageThreadId` must be the inbound Telegram thread so other topics in
   * the same group cannot steal the reply.
   */
  takeText(chatId: number, text: string, messageThreadId?: number): boolean {
    const reqId = this.lookupTextWait(chatId, messageThreadId);
    if (!reqId) return false;
    const p = this.pending.get(reqId);
    if (!p || !p.waitingText) {
      this.textFor.delete(interactiveWaitKey(chatId, messageThreadId));
      this.textFor.delete(interactiveWaitKey(chatId, forumThreadId(messageThreadId)));
      return false;
    }
    const q = p.questions[p.index];
    if (!q) return false;
    const trimmed = text.trim();
    if (!trimmed) return true; // consume empty, stay waiting
    p.notes.set(q.id, trimmed);
    p.picked.get(q.id)!.clear(); // free-text replaces option picks
    p.waitingText = false;
    this.clearTextWait(p);
    void this.redraw(reqId, p);
    return true;
  }

  /** Cancel all pending interviews for a session (e.g. /cancel). */
  cancelForSession(sessionId: string): number {
    let n = 0;
    for (const [reqId, p] of [...this.pending.entries()]) {
      if (p.sessionId !== sessionId) continue;
      this.clearTextWait(p);
      this.settle(p, reqId, { outcome: "cancelled" }, "\u{1F510} (cancelled \u2014 turn stopped)");
      n++;
    }
    if (n > 0) log.info(`cancelled ${n} ask_user interview(s) for session ${sessionId.slice(0, 8)}`);
    return n;
  }

  private clearTextWait(p: { chatId: number; threadId?: number }): void {
    this.textFor.delete(interactiveWaitKey(p.chatId, p.threadId));
    // General may be stored as 1 but inbound messages sometimes omit thread id.
    if (p.threadId === 1 || p.threadId === undefined) {
      this.textFor.delete(interactiveWaitKey(p.chatId, 1));
      this.textFor.delete(interactiveWaitKey(p.chatId, undefined));
    }
  }

  private lookupTextWait(chatId: number, messageThreadId?: number): string | undefined {
    const keys = [
      interactiveWaitKey(chatId, messageThreadId),
      interactiveWaitKey(chatId, forumThreadId(messageThreadId)),
    ];
    if (messageThreadId === undefined) keys.push(interactiveWaitKey(chatId, 1));
    if (messageThreadId === 1) keys.push(interactiveWaitKey(chatId, undefined));
    for (const k of keys) {
      const id = this.textFor.get(k);
      if (id) return id;
    }
    return undefined;
  }

  private async redraw(reqId: string, p: Pending): Promise<void> {
    const q = p.questions[p.index]!;
    const set = p.picked.get(q.id)!;
    if (p.messageId === undefined) return;
    await this.api
      .editMessageText(p.chatId, p.messageId, renderQuestion(p.questions, p.index, p.picked, p.notes), {
        reply_markup: questionKeyboard(reqId, q, set, p.index, p.questions.length),
      })
      .catch(() => {});
  }

  private settle(p: Pending, reqId: string, result: AskUserResult, text: string): void {
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    this.clearTextWait(p);
    if (p.messageId !== undefined) {
      void this.api
        .editMessageText(p.chatId, p.messageId, text, { reply_markup: { inline_keyboard: [] } })
        .catch(() => {});
    }
    p.resolve(result);
  }
}

/** Build wire-format accepted response (question text → labels; notes for freeform). */
export function buildAcceptedResult(
  questions: InterviewQuestion[],
  picked: Map<string, Set<string>>,
  notes: Map<string, string>,
): AskUserResult {
  const answers: Record<string, string[]> = {};
  const annotations: Record<string, { notes?: string }> = {};
  for (const q of questions) {
    const note = notes.get(q.id)?.trim();
    const ids = [...(picked.get(q.id) ?? [])];
    if (note && ids.length === 0) {
      answers[q.prompt] = ["Other"];
      annotations[q.prompt] = { notes: note };
      continue;
    }
    if (ids.length === 0) continue;
    const labels = ids.map((id) => q.options.find((o) => o.id === id)?.label || id);
    answers[q.prompt] = labels;
    if (note) annotations[q.prompt] = { notes: note };
  }
  const result: AskUserResult = { outcome: "accepted", answers };
  if (Object.keys(annotations).length > 0) result.annotations = annotations;
  return result;
}

export function parseQuestions(params: Record<string, unknown>): InterviewQuestion[] {
  const raw = params.questions ?? params.questionnaire ?? params.items;
  if (!Array.isArray(raw)) return [];
  const out: InterviewQuestion[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const o = item as Record<string, unknown>;
    const prompt =
      str(o.question) || str(o.prompt) || str(o.header) || str(o.text) || `Question ${i + 1}`;
    const id = str(o.id) || str(o.questionId) || `q${i}`;
    const multi =
      o.multiSelect === true ||
      o.multi_select === true ||
      o.multi === true ||
      o.allow_multiple === true;
    const optsRaw = Array.isArray(o.options) ? o.options : [];
    const options = optsRaw
      .map((opt, j) => {
        if (typeof opt === "string") return { id: opt, label: opt };
        if (!opt || typeof opt !== "object") return undefined;
        const oo = opt as Record<string, unknown>;
        const label = str(oo.label) || str(oo.name) || str(oo.text) || `Option ${j + 1}`;
        const oid = str(oo.id) || str(oo.value) || label;
        return { id: oid, label };
      })
      .filter((x): x is { id: string; label: string } => Boolean(x));
    if (options.length === 0) {
      options.push({ id: "yes", label: "Yes" }, { id: "no", label: "No" });
    }
    out.push({ id, prompt, options, multi });
  });
  return out;
}

function renderQuestion(
  questions: InterviewQuestion[],
  index: number,
  picked: Map<string, Set<string>>,
  notes: Map<string, string>,
): string {
  const q = questions[index]!;
  const set = picked.get(q.id) ?? new Set();
  const note = notes.get(q.id);
  const selectedLabels = [...set].map((id) => q.options.find((o) => o.id === id)?.label || id);
  const lines = [
    `\u2753 Grok has a question (${index + 1}/${questions.length})`,
    "",
    q.prompt,
    q.multi ? "\n(multi-select \u2014 tap to toggle, then Next)" : "",
    selectedLabels.length ? `\nSelected: ${selectedLabels.join(", ")}` : "",
    note ? `\nYour text: ${note}` : "",
    "\nTap an option, or Type answer\u2026 then Next/Submit.",
  ];
  return lines.filter(Boolean).join("\n");
}

function questionKeyboard(
  reqId: string,
  q: InterviewQuestion,
  selected: Set<string>,
  index = 0,
  total = 1,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  q.options.slice(0, 10).forEach((opt, j) => {
    const mark = selected.has(opt.id) ? "\u2705 " : "";
    kb.text(`${mark}${opt.label.slice(0, 40)}`, `asku:${reqId}:opt:${j}`).row();
  });
  kb.text("\u270F\uFE0F Type answer\u2026", `asku:${reqId}:type`).row();
  if (index > 0) kb.text("\u25C0 Back", `asku:${reqId}:prev`);
  kb.text(index < total - 1 ? "Next \u25B6" : "\u2705 Submit", `asku:${reqId}:next`);
  kb.row().text("Skip", `asku:${reqId}:skip`).text("Cancel", `asku:${reqId}:cancel`);
  return kb;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
