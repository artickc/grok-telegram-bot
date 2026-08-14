/**
 * Interactive Grok `ask_user_question` reverse requests.
 * Headless default used to skip; we now present options as Telegram buttons.
 */
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { createLogger } from "../logger.js";
import type { RuntimeRegistry } from "./registry.js";

const log = createLogger("ask-user");
const TIMEOUT_MS = 30 * 60 * 1000;

export interface InterviewQuestion {
  id: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  multi: boolean;
}

export interface AskUserResult {
  type: "SkipInterview" | "SubmitAnswers";
  answers?: Array<{ questionId: string; selected: string[] }>;
}

interface Pending {
  resolve: (r: AskUserResult) => void;
  chatId: number;
  messageId?: number;
  questions: InterviewQuestion[];
  picked: Map<string, Set<string>>;
  index: number;
  timer: NodeJS.Timeout;
}

export class AskUserService {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private readonly api: Api,
    private readonly registry: RuntimeRegistry,
    public autoSkip = false,
  ) {}

  async handle(params: Record<string, unknown>): Promise<AskUserResult> {
    const questions = parseQuestions(params);
    const sessionId = str(params.sessionId) || str(params.session_id) || "";
    if (this.autoSkip || questions.length === 0) {
      log.info(`skip ask_user_question (${questions.length} q)`);
      return { type: "SkipInterview" };
    }
    const desc = sessionId ? this.registry.describeSession(sessionId) : { chatId: undefined };
    const chatId = desc.chatId;
    if (chatId === undefined) return { type: "SkipInterview" };

    const reqId = String(++this.seq);
    const picked = new Map<string, Set<string>>();
    for (const q of questions) picked.set(q.id, new Set());

    try {
      const msg = await this.api.sendMessage(chatId, renderQuestion(questions, 0, picked), {
        reply_markup: questionKeyboard(reqId, questions[0]!, picked.get(questions[0]!.id)!),
        disable_notification: false,
      });
      return new Promise<AskUserResult>((resolve) => {
        const timer = setTimeout(() => {
          const p = this.pending.get(reqId);
          if (!p) return;
          this.pending.delete(reqId);
          void this.api.editMessageText(p.chatId, p.messageId ?? 0, "\u231B Question timed out \u2014 skipped.").catch(
            () => {},
          );
          resolve({ type: "SkipInterview" });
        }, TIMEOUT_MS);
        this.pending.set(reqId, {
          resolve,
          chatId,
          messageId: msg.message_id,
          questions,
          picked,
          index: 0,
          timer,
        });
      });
    } catch (e) {
      log.warn("send ask_user failed:", (e as Error).message);
      return { type: "SkipInterview" };
    }
  }

  tap(reqId: string, kind: string, value?: string): string | undefined {
    const p = this.pending.get(reqId);
    if (!p) return undefined;
    const q = p.questions[p.index];
    if (!q) return undefined;

    if (kind === "skip") {
      this.settle(p, reqId, { type: "SkipInterview" }, "\u23ED Skipped questions.");
      return "Skipped";
    }
    if (kind === "opt" && value !== undefined) {
      const opt = q.options[Number(value)];
      if (!opt) return "Expired";
      const set = p.picked.get(q.id)!;
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
      if (p.index < p.questions.length - 1) {
        p.index += 1;
        void this.redraw(reqId, p);
        return "Next";
      }
      const answers = p.questions.map((qq) => ({
        questionId: qq.id,
        selected: [...(p.picked.get(qq.id) ?? [])],
      }));
      this.settle(p, reqId, { type: "SubmitAnswers", answers }, "\u2705 Answers sent.");
      return "Submitted";
    }
    if (kind === "prev" && p.index > 0) {
      p.index -= 1;
      void this.redraw(reqId, p);
      return "Back";
    }
    return undefined;
  }

  private async redraw(reqId: string, p: Pending): Promise<void> {
    const q = p.questions[p.index]!;
    const set = p.picked.get(q.id)!;
    if (p.messageId === undefined) return;
    await this.api
      .editMessageText(p.chatId, p.messageId, renderQuestion(p.questions, p.index, p.picked), {
        reply_markup: questionKeyboard(reqId, q, set, p.index, p.questions.length),
      })
      .catch(() => {});
  }

  private settle(p: Pending, reqId: string, result: AskUserResult, text: string): void {
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    if (p.messageId !== undefined) {
      void this.api.editMessageText(p.chatId, p.messageId, text, { reply_markup: { inline_keyboard: [] } }).catch(
        () => {},
      );
    }
    p.resolve(result);
  }
}

export function parseQuestions(params: Record<string, unknown>): InterviewQuestion[] {
  const raw = params.questions ?? params.questionnaire ?? params.items;
  if (!Array.isArray(raw)) return [];
  const out: InterviewQuestion[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const o = item as Record<string, unknown>;
    const prompt = str(o.question) || str(o.prompt) || str(o.header) || str(o.text) || `Question ${i + 1}`;
    const id = str(o.id) || str(o.questionId) || `q${i}`;
    const multi = o.multiSelect === true || o.multi === true || o.allow_multiple === true;
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
    if (options.length === 0) options.push({ id: "yes", label: "Yes" }, { id: "no", label: "No" });
    out.push({ id, prompt, options, multi });
  });
  return out;
}

function renderQuestion(
  questions: InterviewQuestion[],
  index: number,
  picked: Map<string, Set<string>>,
): string {
  const q = questions[index]!;
  const set = picked.get(q.id) ?? new Set();
  const lines = [
    `\u2753 Grok has a question (${index + 1}/${questions.length})`,
    "",
    q.prompt,
    q.multi ? "\n(multi-select \u2014 tap to toggle, then Next)" : "",
    set.size ? `\nSelected: ${[...set].join(", ")}` : "",
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
  q.options.slice(0, 12).forEach((opt, j) => {
    const mark = selected.has(opt.id) ? "\u2705 " : "";
    kb.text(`${mark}${opt.label.slice(0, 40)}`, `asku:${reqId}:opt:${j}`).row();
  });
  if (index > 0) kb.text("\u25C0 Back", `asku:${reqId}:prev`);
  kb.text(index < total - 1 ? "Next \u25B6" : "\u2705 Submit", `asku:${reqId}:next`);
  kb.row().text("Skip", `asku:${reqId}:skip`);
  return kb;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
