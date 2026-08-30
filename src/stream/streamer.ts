/**
 * ResponseStreamer — renders a whole agent turn into as FEW Telegram messages as
 * possible, edited at most once per throttle window (anti-spam, avoids 429s).
 *
 * The turn is modelled as ordered segments so the transcript reads clearly:
 *   • plain prose      = the agent talking to you
 *   • > 💭 quoted block = the agent's thinking
 *   • 🔧 + code block   = tool calls / terminal commands / diffs
 *
 * A single "live" message is edited as content grows; only when it would exceed
 * Telegram's size limit is it sealed and a new live message started.
 */
import type { Api } from "grammy";
import { chunkMarkdown } from "../render/chunk.js";
import { toTelegramMarkdown } from "../render/markdown.js";
import { extractProgress, progressBar } from "../render/progress.js";
import { estimateProgress } from "../render/progress-estimate.js";
import { stripTelegramActionFences } from "../render/telegram-bridge.js";
import { truncateMiddle } from "../render/truncate.js";
import { safeEdit, safeSend } from "../bot/telegram-io.js";
import { outboundThreadExtra } from "../forum/thread.js";

const SOFT_LIMIT = 3500;
/** Display budget for a thinking block (middle-truncated; session context keeps all). */
const THINK_DISPLAY_MAX = 2800;
/** Do not pulse "still working" until the live bubble has been silent this long. */
export const LIVENESS_MIN_SILENCE_MS = 12_000;

type SegKind = "out" | "think" | "tool";
interface Seg {
  kind: SegKind;
  text: string;
  /** When set, later tool updates replace this segment instead of appending. */
  toolId?: string;
}

/** One-line (or short) honesty hint while ACP is silent on a long tool. */
export function formatLivenessHint(elapsedLabel: string, step?: string): string {
  const e = elapsedLabel.trim() || "?";
  const s = (step || "").trim();
  if (!s) return `\u23F3 Still working \u00B7 ${e}`;
  const short = s.length > 90 ? `${s.slice(0, 89)}\u2026` : s;
  return `\u23F3 Still working \u00B7 ${e}\n${short}`;
}

/** Whether a liveness pulse should edit the bubble (pure helper for tests). */
export function shouldPulseLiveness(opts: {
  closed: boolean;
  lastContentAt: number;
  now: number;
  nextHint: string;
  currentHint?: string;
  minSilenceMs?: number;
  /** Need an existing bubble or real content before pulsing. */
  hasLiveSurface: boolean;
}): boolean {
  if (opts.closed || !opts.hasLiveSurface) return false;
  const silence = opts.now - opts.lastContentAt;
  if (silence < (opts.minSilenceMs ?? LIVENESS_MIN_SILENCE_MS)) return false;
  if (opts.currentHint === opts.nextHint) return false;
  return true;
}

export interface StreamerOptions {
  /** Chat-like mode: drop thoughts/tools/plan; only stream agent prose. */
  proseOnly?: boolean;
  /** When false, never render a progress bar (manager chat). Default true. */
  showProgressBar?: boolean;
  /**
   * Pre-posted message id to edit in place (e.g. General "Thinking…" placeholder).
   * Avoids a separate bubble when the first real tokens arrive.
   */
  seedMessageId?: number;
}

export class ResponseStreamer {
  private readonly segs: Seg[] = [];
  private sealedIdx = 0;
  private liveId: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private flushing = false;
  private closed = false;
  /** Latest task-progress % parsed from the agent's `{progress: N%}` markers
   *  (sticky across flushes; rendered as a bar on the live message). */
  private progress: number | undefined;
  /** True once the agent emitted a real `{progress}` marker — from then on its
   *  values are authoritative and the bot fallback stops contributing. */
  private agentReported = false;
  /** Real work signals for the fallback estimate (monotonic within a turn). */
  private toolCalls = 0;
  private outChars = 0;
  private thoughtChars = 0;
  /**
   * Active plan board (ACP sessionUpdate "plan"). Always rendered just above
   * the progress bar when set — done / in-progress / pending steps.
   */
  private planMarkdown: string | undefined;
  private readonly proseOnly: boolean;
  private readonly showProgressBar: boolean;
  /** Wall clock of last real agent content (not liveness pulses). */
  private lastContentAt = Date.now();
  /** Sticky "still working" line while long tools emit no ACP updates. */
  private livenessLine: string | undefined;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly throttleMs: number,
    private replyTo?: number,
    private footer?: string,
    private readonly onProgress?: (pct: number) => void,
    /** Show a bot-computed bar when the agent emits no marker. */
    private readonly fallbackEnabled = false,
    /** Turn start time, used by the fallback's elapsed-time signal. */
    private readonly turnStartedAt = Date.now(),
    /** Forum topic thread — required so stream edits land in the right topic. */
    private readonly messageThreadId?: number,
    opts?: StreamerOptions,
  ) {
    this.proseOnly = !!opts?.proseOnly;
    this.showProgressBar = opts?.showProgressBar !== false;
    if (opts?.seedMessageId !== undefined) this.liveId = opts.seedMessageId;
  }

  /** Replace the hashtag footer (used after a logical fork swaps the session id
   *  mid-turn, so the streamed response carries the NEW session's tags). */
  setFooter(footer: string): void {
    this.footer = footer;
  }

  /** Seed/replace the live bubble id (General Thinking… placeholder). */
  seedLiveMessage(messageId: number): void {
    this.liveId = messageId;
  }

  /**
   * Post a placeholder live message immediately so typing+pulse have a surface
   * before the first ACP chunk (critical while subagents work silently).
   * Replaced in place when real content arrives.
   */
  async ensureLiveSurface(placeholder = "\u23F3 Working\u2026"): Promise<void> {
    if (this.closed || this.liveId !== undefined) return;
    const src = placeholder.trim() || "\u23F3 Working\u2026";
    const rendered = toTelegramMarkdown(src);
    this.liveId = await safeSend(this.api, this.chatId, rendered, src, this.replyExtra());
  }

  /** Current live Telegram message id (for attaching suggestions after finalize). */
  get liveMessageId(): number | undefined {
    return this.liveId;
  }

  /** "\n\n<footer>" appended to every finished message bubble (e.g. hashtags). */
  private footerSuffix(): string {
    return this.footer ? `\n\n${this.footer}` : "";
  }

  /** Strip `{progress: N%}` markers and telegram action JSON fences from
   *  rendered text, remembering the latest progress value. */
  private captureProgress(text: string): string {
    const withoutTg = stripTelegramActionFences(text);
    const { value, cleaned } = extractProgress(withoutTg);
    if (value !== undefined) this.setProgressValue(value, true);
    return cleaned;
  }

  /** Record a progress value, enforcing global monotonicity (never decreases)
   *  and notifying the owner on change. Agent markers are authoritative: once
   *  one arrives, the bot fallback stops contributing. */
  private setProgressValue(pct: number, fromAgent: boolean): void {
    if (!this.showProgressBar) return;
    if (fromAgent) this.agentReported = true;
    const next = Math.max(this.progress ?? 0, Math.round(pct));
    if (next === this.progress) return;
    this.progress = next;
    try {
      this.onProgress?.(next);
    } catch {
      /* non-fatal */
    }
  }

  /** Advance the fallback estimate from real activity signals, but only while
   *  the agent itself hasn't reported a value. No-op when fallback is off. */
  private applyFallback(): void {
    if (!this.showProgressBar || !this.fallbackEnabled || this.agentReported) return;
    const est = estimateProgress({
      toolCalls: this.toolCalls,
      outputChars: this.outChars,
      thoughtChars: this.thoughtChars,
      elapsedMs: Date.now() - this.turnStartedAt,
    });
    if (est > 0) this.setProgressValue(est, false);
  }

  /** Called when the turn finishes successfully: if the agent never reported
   *  its own progress, fill the fallback bar to 100. No-op otherwise. */
  completeFallback(): void {
    if (!this.showProgressBar || !this.fallbackEnabled || this.agentReported) return;
    this.setProgressValue(100, false);
  }

  private threadExtra(): Record<string, unknown> {
    // Never send message_thread_id=1 (General) — Telegram rejects it.
    return outboundThreadExtra(this.messageThreadId);
  }

  /** reply_parameters threading EVERY message of the turn to the user's prompt,
   *  so the whole response (all bubbles, tool calls and continuations) stays in
   *  one thread — not just the first message. Also carries forum topic id. */
  private replyExtra(): Record<string, unknown> {
    const extra: Record<string, unknown> = { ...this.threadExtra() };
    if (this.replyTo !== undefined) {
      extra.reply_parameters = { message_id: this.replyTo, allow_sending_without_reply: true };
    }
    return extra;
  }

  appendOutput(text: string): void {
    if (!text) return;
    this.outChars += text.length;
    this.merge("out", text);
    this.noteRealContent();
    this.schedule();
  }

  appendThought(text: string): void {
    if (!text || this.proseOnly) return;
    this.thoughtChars += text.length;
    this.merge("think", text);
    this.noteRealContent();
    this.schedule();
  }

  /**
   * Append a one-shot tool card (no live updates). Prefer {@link upsertTool}
   * for ACP tool calls that stream progress/output under a stable toolCallId.
   */
  addTool(rawMarkdown: string): void {
    if (!rawMarkdown || this.proseOnly) return;
    this.toolCalls += 1;
    this.segs.push({ kind: "tool", text: rawMarkdown });
    this.noteRealContent();
    this.schedule(true);
  }

  /**
   * Insert or replace a tool card keyed by toolCallId so one command/edit stays
   * a single Telegram block that auto-updates (no spam of new code sections).
   * Full tool results remain in the agent session; this is display-only.
   */
  /** Replace the live plan board (or clear with empty/undefined). */
  setPlan(markdown: string | undefined): void {
    if (this.proseOnly) return;
    const next = markdown?.trim() ? markdown.trim() : undefined;
    if (next === this.planMarkdown) return;
    this.planMarkdown = next;
    this.noteRealContent();
    this.schedule();
  }

  upsertTool(toolId: string | undefined, rawMarkdown: string): void {
    if (!rawMarkdown || this.proseOnly) return;
    const id = (toolId || "").trim();
    if (id) {
      // Replace any existing segment with this id (newest first; includes rare
      // sealed-region matches so we don't keep stale text in the segs model).
      for (let i = this.segs.length - 1; i >= 0; i--) {
        const s = this.segs[i]!;
        if (s.kind === "tool" && s.toolId === id) {
          if (s.text === rawMarkdown) return;
          s.text = rawMarkdown;
          // If the card lives only in a sealed bubble, also ensure a live copy
          // so the user sees the latest output on the current message.
          if (i < this.sealedIdx) {
            this.segs.push({ kind: "tool", text: rawMarkdown, toolId: id });
          }
          this.noteRealContent();
          this.schedule(true);
          return;
        }
      }
    }
    this.toolCalls += 1;
    this.segs.push({ kind: "tool", text: rawMarkdown, toolId: id || undefined });
    this.noteRealContent();
    this.schedule(true);
  }

  /**
   * Edit the live bubble with an honest "still working" elapsed line when ACP
   * has been silent (long SSH/shell with no mid-flight stdout). No-op when
   * real content arrived recently or the hint is unchanged.
   */
  pulseLiveness(elapsedLabel: string, step?: string): void {
    const next = formatLivenessHint(elapsedLabel, step);
    if (
      !shouldPulseLiveness({
        closed: this.closed,
        lastContentAt: this.lastContentAt,
        now: Date.now(),
        nextHint: next,
        currentHint: this.livenessLine,
        hasLiveSurface: this.liveId !== undefined || this.hasOutput,
      })
    ) {
      return;
    }
    this.livenessLine = next;
    this.schedule(true);
  }

  /** True when agent prose/tools/thoughts were appended (not just a seed bubble). */
  get hasOutput(): boolean {
    return this.segs.some((s) => s.text.trim().length > 0);
  }

  async finalize(): Promise<void> {
    this.closed = true;
    this.livenessLine = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush(true);
    // Seeded Thinking… with zero agent text: clear the placeholder.
    // Manager quiet mode also deletes/replaces this bubble explicitly.
    if (
      this.proseOnly &&
      this.liveId !== undefined &&
      !this.segs.some((s) => s.text.trim().length > 0)
    ) {
      try {
        await this.api.editMessageText(this.chatId, this.liveId, "\u2026");
      } catch {
        /* non-fatal */
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private merge(kind: SegKind, text: string): void {
    const last = this.segs.at(-1);
    if (last && last.kind === kind) last.text += text;
    else this.segs.push({ kind, text });
  }

  /** Real agent/tool content — clear any stale "still working" hint. */
  private noteRealContent(): void {
    this.lastContentAt = Date.now();
    this.livenessLine = undefined;
  }

  /**
   * @param urgent tool updates — flush sooner (~200ms) so heavy /goal turns
   * feel live instead of waiting a full throttle window.
   */
  private schedule(urgent = false): void {
    if (this.closed) return;
    this.dirty = true;
    const delay = urgent ? Math.min(200, this.throttleMs) : this.throttleMs;
    if (this.timer) {
      if (!urgent) return;
      // Reschedule sooner for tool cards.
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush(false);
    }, delay);
  }

  private async flush(final: boolean): Promise<void> {
    if (this.flushing) {
      if (!final) this.schedule();
      return;
    }
    if (!this.dirty && !final) return;
    this.flushing = true;
    this.dirty = false;
    try {
      await this.sealOverflow();
      const base = this.captureProgress(renderSegs(this.segs.slice(this.sealedIdx)));
      this.applyFallback();
      // Never send an empty / progress-only bubble. Plan alone is allowed so the
      // board is visible as soon as the agent publishes steps.
      if (!base.trim() && !this.planMarkdown && !this.livenessLine) return;
      // Live bubble: body → plan → progress → liveness (silent tools) → footer.
      const parts: string[] = [];
      if (base.trim()) parts.push(base);
      if (!this.proseOnly && this.planMarkdown) parts.push(this.planMarkdown);
      if (this.showProgressBar && this.progress !== undefined) parts.push(progressBar(this.progress));
      if (this.livenessLine) parts.push(this.livenessLine);
      if (parts.length === 0) return;
      const src = `${parts.join("\n\n")}${this.footerSuffix()}`;
      const rendered = toTelegramMarkdown(src);
      const chunks = chunkMarkdown(rendered);
      const plain = chunkMarkdown(src);
      if (chunks.length <= 1) {
        const mdv2 = chunks[0] ?? rendered;
        if (this.liveId === undefined) this.liveId = await safeSend(this.api, this.chatId, mdv2, src, this.replyExtra());
        else await safeEdit(this.api, this.chatId, this.liveId, mdv2, src);
      } else {
        // Remainder no longer fits one message: flush all, last stays live.
        for (let i = 0; i < chunks.length; i++) {
          const mdv2 = chunks[i]!;
          const p = plain[i] ?? mdv2;
          if (i === 0 && this.liveId !== undefined) await safeEdit(this.api, this.chatId, this.liveId, mdv2, p);
          else if (i < chunks.length - 1) await safeSend(this.api, this.chatId, mdv2, p, this.replyExtra());
          else this.liveId = await safeSend(this.api, this.chatId, mdv2, p, this.replyExtra());
        }
        this.sealedIdx = this.segs.length; // everything before the live tail is sealed
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Seal leading segments into finalized messages while the live view is too big. */
  private async sealOverflow(): Promise<void> {
    let live = this.segs.slice(this.sealedIdx);
    while (live.length > 1 && toTelegramMarkdown(renderSegs(live)).length > SOFT_LIMIT) {
      const headCount = live.length - 1;
      await this.seal(this.sealedIdx, this.sealedIdx + headCount);
      this.sealedIdx += headCount;
      this.liveId = undefined;
      live = this.segs.slice(this.sealedIdx);
    }
  }

  private async seal(from: number, to: number): Promise<void> {
    const base = this.captureProgress(renderSegs(this.segs.slice(from, to)));
    if (!base.trim()) return;
    // A sealed bubble is finished, so it carries the footer (hashtags).
    const src = `${base}${this.footerSuffix()}`;
    const chunks = chunkMarkdown(toTelegramMarkdown(src));
    const plain = chunkMarkdown(src);
    for (let i = 0; i < chunks.length; i++) {
      const mdv2 = chunks[i]!;
      const p = plain[i] ?? mdv2;
      if (i === 0 && this.liveId !== undefined) await safeEdit(this.api, this.chatId, this.liveId, mdv2, p);
      else await safeSend(this.api, this.chatId, mdv2, p, this.replyExtra());
    }
  }
}

function renderSegs(segs: Seg[]): string {
  return segs
    .map((s) => {
      if (s.kind === "out") return s.text.trim();
      if (s.kind === "think") return quoteThought(s.text);
      return s.text.trim();
    })
    .filter((x) => x.length > 0)
    .join("\n\n");
}

function quoteThought(text: string): string {
  const t = text.trim();
  if (!t) return "";
  // Keep both ends of long reasoning so early investigation is not lost in the UI.
  // Truncation is display-only — the agent session retains every thought token.
  // Neutralize fence markers and half-open emphasis so thinking never breaks
  // MarkdownV2 parsing of the surrounding live message.
  const safe = t
    .replace(/```+/g, "'''")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/~~/g, "");
  const short = truncateMiddle(safe, THINK_DISPLAY_MAX);
  const lines = short.split("\n");
  // Plain "thinking:" (no nested *bold*) — nested markers break mid-stream.
  return lines.map((l, i) => (i === 0 ? `> \u{1F4AD} thinking: ${l}` : `> ${l}`)).join("\n");
}
