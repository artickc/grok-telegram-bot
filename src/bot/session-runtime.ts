/**
 * SessionRuntime вЂ” binds one Telegram chat to one Grok ACP session and drives
 * the prompt/stream lifecycle, typing indicator, follow-up queue, live watch,
 * and per-chat preferences (project, agent, model, reasoning). State persists
 * to the settings store so it survives restarts.
 */
import { basename, join } from "node:path";
import { type Api, InlineKeyboard } from "grammy";
import {
  type GrokClient,
  isAccountRotationError,
  isContextExhaustedError,
  isSessionLifecycleError,
  isTransientError,
  type SessionMetadata,
} from "../grok/client.js";
import type { AccountRotator } from "./account-rotator.js";
import { contentText, type ContentBlock, type PromptResult, type SessionUpdate } from "../grok/types.js";
import type { AppConfig } from "../config.js";
import { reasoningDirective } from "../app/reasoning.js";
import type { SettingsStore } from "../app/settings-store.js";
import { type PromptInput, type ReasoningEffort, textPrompt } from "../app/types.js";
import { createLogger } from "../logger.js";
import { buildTranscript, readHistory } from "../sessions/history.js";
import { sessionHashtags } from "../render/hashtags.js";
import { extractProgress, PROGRESS_DIRECTIVE } from "../render/progress.js";
import { buildPriming, recentTranscript } from "./session-fork.js";
import { TailWatcher } from "../sessions/tail.js";
import type { HistoryEntry } from "../sessions/types.js";
import { formatToolCall } from "../render/tool-call.js";
import {
  mergeToolSnapshot,
  snapshotHasDetail,
  type ToolSnapshot,
} from "../render/tool-call-merge.js";
import {
  type FileOp,
  cloneFileOps,
  fileOpFromUpdate,
  mergeFileOp,
  summarizeFileOps,
  summarizeFileOpsShort,
  summarizeFileOpsSplit,
} from "../render/file-summary.js";
import {
  isActiveStatus,
  renderSubagentTransition,
  statusKey,
  subagentLabel,
  subagentSummary,
} from "../render/subagent.js";
import type { PendingStage, SubagentInfo } from "../grok/types.js";
import { ResponseStreamer } from "../stream/streamer.js";
import { IMAGE_OUTPUT_DIRECTIVE } from "../render/image-output.js";
import { collectTurnImagePaths, sendImages } from "./image-return.js";
import { buildContentBlocks, mergeInputs } from "./prompt-content.js";
import { wrapAutoComplexityPrompt } from "./complexity-gate.js";
import {
  autoApproveSuggestions,
  buildSelfRecheckDecisionPrompt,
  buildSelfRecheckPrompt,
  buildSuggestionsPrompt,
  composeSelfRecheckTurn,
  formatBatchedSuggestionsPrompt,
  isSelfRecheckPrompt,
  parseSelfRecheckDecision,
  parseSuggestions,
  type Suggestion,
  suggestionsKeyboard,
} from "./suggestions.js";
import type { ForumManager } from "../forum/manager.js";
import { isGeneralThread, outboundThreadExtra } from "../forum/thread.js";
import type { SessionStore } from "../sessions/store.js";
import type { TelegramBotService } from "./telegram-bots.js";
import { executeTelegramActions } from "./telegram-actions.js";
import {
  buildManagerContextBlock,
  injectManagerContext,
} from "./manager-context.js";
import {
  bindJobSession,
  updateManagerJob,
  type ReportBackMeta,
} from "./manager-jobs.js";
import {
  buildManagerWorkReportPrompt,
  isManagerWorkReportPrompt,
  wrapManagerDirective,
} from "../render/manager-directive.js";
import {
  buildTelegramBridgeDirective,
  buildTelegramBridgeResultsPrompt,
  extractTelegramActions,
  isTelegramBridgeResultsPrompt,
  stripTelegramActionFences,
  wrapTelegramBridgePrompt,
} from "../render/telegram-bridge.js";
import {
  parsePlanUpdate,
  renderPlanMarkdown,
  renderPlanOneLine,
  type PlanEntry,
} from "../render/plan.js";
import {
  buildSessionCardComment,
  clampThinking,
  cleanCommentLine,
  cleanUserPreview,
  COMMENT_MAX,
  stepFromThought,
  stepFromToolUpdate,
  stripDirectiveWrappers,
} from "../render/session-comment.js";
import {
  backoffSchedule,
  fmtSeconds,
  formatAccountSwitchNotice,
  formatErrorSummary,
  formatRetryNotice,
  RETRY_BASE_MS,
} from "./prompt-retry.js";
import { sendMarkdownDoc } from "./telegram-io.js";
import { TypingIndicator } from "./typing.js";

const log = createLogger("runtime");

const WATCH_ENTRY_MAX = 700;
const WATCH_ICON: Record<string, string> = {
  user: "\u{1F464}",
  assistant: "\u{1F916}",
  tool: "\u{1F527}",
  system: "\u2139\uFE0F",
};

export type AttachResult = "resumed" | "forked";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Continuation nudge sent to the SAME session to recover from a transient error
 * that struck mid-stream. The partial reply + any completed tool results are
 * already in the session history, so we ask the agent to finish WITHOUT redoing
 * work (which is why we resume rather than re-send the original prompt).
 */
const RESUME_INSTRUCTION =
  "Your previous response was interrupted by a transient service error (the model stream was throttled), " +
  "so your last turn did not finish. Continue from exactly where you stopped and complete the response. " +
  "Do NOT repeat any file edits, commands, or other tool calls you already completed вЂ” their results are " +
  "already in this conversation. If you had already fully answered, just briefly conclude.";

export class SessionRuntime {
  sessionId: string | undefined;
  cwd: string;
  projectName: string | undefined;
  /** Invoked whenever observable state changes (for the status panel). */
  onStateChange: (() => void) | undefined;

  private busy = false;
  private cancelled = false;
  /** Keeps ACP idle-watch alive during long tools/goals with sparse updates. */
  private activityHeartbeat: NodeJS.Timeout | undefined;
  /** Edits the live Telegram bubble with "still working" while tools are silent. */
  private livenessPulse: NodeJS.Timeout | undefined;
  /** Turn start for liveness elapsed labels. */
  private turnPulseStartedAt = 0;
  private readonly queue: PromptInput[] = [];
  private streamer: ResponseStreamer | undefined;
  private readonly typing: TypingIndicator;
  private shownToolIds = new Set<string>();
  /** toolCallId → merged snapshot so completed updates keep title/args. */
  private toolCallCache = new Map<string, ToolSnapshot>();
  /** Files touched this turn (path -> operation), tracked even in background so
   *  the completion message can summarise what changed. */
  private fileOps = new Map<string, FileOp>();
  /** The full Done/summary of the most recent finished turn, replayed when you
   *  switch (back) into this session so you see how it ended. */
  private lastCompletion: string | undefined;
  /** Latest task-completion % parsed from the agent's `{progress: N%}` markers,
   *  shown as a bar in the status panel and session cards. Reset each turn. */
  private progress: number | undefined;
  /** Subagent sessionId -> last status key shown this turn (dedupe). */
  private subagentShown = new Map<string, string>();
  /** Child ACP sessions spawned for this busy turn — mirror their updates. */
  private ownedSubagentIds = new Set<string>();
  /** Throttle mirrored thought cards per subagent (ms epoch of last upsert). */
  private subagentThinkPulse = new Map<string, number>();
  /** Per-subagent tool snapshot cache (child session toolCallIds). */
  private subagentToolCache = new Map<string, ToolSnapshot>();
  private turnStartedAt = 0;
  /** Count of completed (non-cancelled) turns this session вЂ” shown in /usage. */
  private turnCount = 0;
  /** Telegram message id of the current turn's prompt, so replies thread to it. */
  private turnReplyTo: number | undefined;
  /** Short id for `#prompt_<id>` on all AI messages of this turn. */
  private turnPromptId: string | undefined;
  private imageScanText = "";
  private sentImagesThisTurn = new Set<string>();
  /** Monotonic count used to reject ACP "success" responses with no turn updates. */
  private sessionUpdateCount = 0;
  private readonly listener: (sessionId: string, update: SessionUpdate) => void;
  private readonly planExitListener: (sessionId: string | undefined, result: unknown) => void;
  private primingContext: string | undefined;
  private watcher: TailWatcher | undefined;
  /** True when the active watch is a transient "follow" of this session's own
   *  in-flight turn (started on switch) rather than an explicit /watch of
   *  another session вЂ” follow-watches are auto-stopped when a new turn streams. */
  private watchIsFollow = false;
  private rebindPending = false;
  private sessionLive = false;
  /** Only the foreground runtime streams to Telegram; background ones stay quiet
   *  (their output lands in the session's .jsonl and shows as "unread" on switch). */
  private foreground = true;
  private readonly restartListener: () => void;
  /** Invoked when this runtime starts/stops a turn (for subagent attribution). */
  onActivity: ((busy: boolean) => void) | undefined;
  /** Invoked when this runtime adopts a *different* session id (new session or
   *  a logical fork), so the owning ChatController can re-persist its controlled
   *  list and mark the new session seen. */
  onSessionChange: (() => void) | undefined;
  /** Optional multi-account rotator: when a turn gives up, cycle through the
   *  other saved logins once and retry on each. Injected by the registry. */
  accountRotator: AccountRotator | undefined;
  /** Session ids that already received the first-prompt auto-complexity directive. */
  private complexitySteered = new Set<string>();
  /** Session ids that already received the first-prompt Telegram bridge directive. */
  private telegramBridgeSteered = new Set<string>();
  /**
   * How many TELEGRAM BRIDGE RESULTS follow-ups are chained after the current
   * user turn. Caps infinite list_bots/bot_command loops; reset on real user work.
   */
  private bridgeResultDepth = 0;
  /** Max sequential bridge result turns per user request. */
  private static readonly BRIDGE_CHAIN_MAX = 4;
  /**
   * Optional Telegram bridge services (forum / session store / sibling bots).
   * Injected by the registry after construct.
   */
  bridge?: {
    store: SessionStore;
    forum?: ForumManager;
    bots: TelegramBotService;
    /** Cross-topic prompt dispatch (create_topic → send_prompt orchestration). */
    submitTopicPrompt?: import("./telegram-actions.js").SubmitTopicPromptFn;
    /** Wake General manager with a work-report prompt. */
    wakeManager?: (opts: {
      originChatId: number;
      originThreadId: number;
      prompt: string;
    }) => Promise<void>;
  };
  /**
   * Report-back for the *current* turn chain (dispatch + recheck/suggestions).
   * Set from PromptInput.reportBack at turn start; kept until queue drains.
   */
  private pendingReportBack: ReportBackMeta | undefined;
  /**
   * Staged by {@link setReportBack} and attached to the next {@link submit}
   * so concurrent dispatches carry their own job through the queue.
   */
  private stagedReportBack: ReportBackMeta | undefined;
  /** Last credits total reported for this session (for per-turn delta accounting). */
  private lastReportedCredits = 0;
  /** Live "what is happening now" line while a turn is in flight (tools/plan). */
  private liveStep: string | undefined;
  /**
   * Card comment on disk / idle: last user prompt (≤ COMMENT_MAX).
   * While busy, {@link cardComment} also appends last agent thinking.
   */
  private sessionComment: string | undefined;
  /** Cleaned last user prompt for cards (not overwritten by self-recheck meta). */
  private cardUserPrompt: string | undefined;
  /** Accumulated agent_thought_chunk text for the current turn (card display). */
  private cardThinking = "";
  /** User text of the turn currently running (for local card-comment fallback). */
  private turnUserText = "";
  /** Assistant prose streamed this turn — used for suggestions / completion. */
  private turnAssistantText = "";
  /** Quiet meta capture (suggestions) — never stream to Telegram. */
  private capturingQuiet = false;
  private quietCaptureBuf = "";
  /**
   * General manager: Thinking… / Starting… bubble for this turn (deleted when
   * silent, or replaced by a single fallback reply).
   */
  private managerStatusMsgId: number | undefined;
  /** Count of successful notify actions this turn (user-facing messages). */
  private managerNotifyCount = 0;
  /** True when this turn already delivered at least one user-visible message. */
  private managerUserVisible = false;
  /**
   * Done delivery bookkeeping for this turn: expect a loud Done ping, and whether
   * one was successfully sent (finally forces a short Done if expected but missing).
   */
  private turnExpectDone = false;
  private turnDonePinged = false;
  /** Batches of post-turn suggestions for inline-button callbacks. */
  private suggestionBatches = new Map<number, Suggestion[]>();
  private suggestionBatchSeq = 0;
  /**
   * Last successful Done's suggestions — kept so a background "Done from other
   * session" can carry buttons, and so switching back to this session re-shows
   * them even if the user missed the notify (or notify was off).
   */
  private pendingSuggestions:
    | { batchId: number; suggestions: Suggestion[]; banner: string }
    | undefined;
  /** Live ACP plan board for the current turn (done / in-progress / pending). */
  private planEntries: PlanEntry[] | undefined;
  /** True while the active turn is the automatic one-shot self-recheck pass. */
  private isSelfRecheckTurn = false;
  /**
   * Original user prompt (and first-pass assistant text) for suggestions after
   * a self-recheck turn, so follow-ups stay grounded in the real user request.
   */
  private suggestionUserText = "";
  private preRecheckAssistantText = "";
  /** File ops from the first turn, frozen before the self-recheck pass. */
  private preRecheckFileOps = new Map<string, FileOp>();
  /**
   * When true, this turn must not schedule a self-recheck (meta / auto-queue /
   * already-recheck). Set from PromptInput.skipSelfRecheck or recheck marker.
   */
  private skipSelfRecheck = false;

  /**
   * Forum topic thread id (message_thread_id). When set, all outbound messages
   * for this runtime are posted into that topic.
   */
  readonly messageThreadId: number | undefined;
  /** Settings storage key (`chatId` or `chatId:t{threadId}`). */
  readonly settingsKey: string;
  /**
   * General topic only: OpenClaw-style manager chat (orchestrate, no coding UX).
   */
  readonly managerMode: boolean;
  /**
   * Optional: register Telegram message id → session for General reply-routing
   * (user message, Done, stream bubbles). Wired by ChatController.
   */
  onTelegramMessageBound: ((messageId: number, sessionId: string) => void) | undefined;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly acp: GrokClient,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsStore,
    init?: {
      cwd: string;
      projectName?: string;
      sessionId?: string;
      messageThreadId?: number;
      settingsKey?: string;
    },
  ) {
    this.messageThreadId = init?.messageThreadId;
    this.settingsKey = init?.settingsKey ?? String(chatId);
    // Only the forum General topic is the manager — not AI Chat / private DMs.
    this.managerMode =
      this.messageThreadId !== undefined && isGeneralThread(this.messageThreadId);
    if (init) {
      this.cwd = init.cwd;
      this.projectName = init.projectName;
      this.sessionId = init.sessionId;
    } else {
      const s = settings.getKey(this.settingsKey);
      this.cwd = s.projectPath ?? cfg.workspace;
      this.projectName = s.projectName;
      this.sessionId = s.sessionId;
    }
    if (this.sessionId) this.rebindPending = true; // lazily reload on first use

    this.typing = new TypingIndicator(api, chatId);
    this.listener = (sid, update) => this.onUpdate(sid, update);
    this.acp.on("session-update", this.listener);
    this.planExitListener = (sid, result) => this.onPlanExit(sid, result);
    this.acp.on("plan-exit", this.planExitListener);
    this.restartListener = () => {
      this.sessionLive = false;
      if (this.sessionId) this.rebindPending = true;
    };
    this.acp.on("restarted", this.restartListener);
  }

  get isBusy(): boolean {
    return this.busy;
  }
  get queueLength(): number {
    return this.queue.length;
  }
  get isWatching(): boolean {
    return this.watcher?.running ?? false;
  }
  get isForeground(): boolean {
    return this.foreground;
  }

  /** The Done/summary of this session's most recent finished turn, if any. */
  get lastTurnSummary(): string | undefined {
    return this.lastCompletion;
  }

  /** Latest task-completion % (0–100) parsed this turn, or undefined if none. */
  get taskProgress(): number | undefined {
    // Manager chat never shows a progress bar.
    if (this.managerMode) return undefined;
    return this.progress;
  }

  /**
   * Stage report-back for the next {@link submit} (General → project dispatch).
   * Attached to that prompt so a second dispatch cannot steal the first job's
   * completion report when the child session is busy/queued.
   */
  setReportBack(meta: ReportBackMeta): void {
    if (this.stagedReportBack && this.stagedReportBack.jobId !== meta.jobId) {
      updateManagerJob(this.stagedReportBack.jobId, {
        status: "cancelled",
        resultSummary: "superseded by a newer manager dispatch before start",
      });
    }
    this.stagedReportBack = meta;
    if (this.sessionId) bindJobSession(meta.jobId, this.sessionId);
  }

  /**
   * Full plan board for the live stream / status panel (above the progress bar).
   * Empty when no plan is active this turn.
   */
  get planBoard(): string | undefined {
    if (!this.planEntries?.length) return undefined;
    return renderPlanMarkdown(this.planEntries);
  }

  /** One-line plan summary for compact cards. */
  get planSummary(): string | undefined {
    if (!this.planEntries?.length) return undefined;
    return renderPlanOneLine(this.planEntries);
  }

  /**
   * Pending post-turn suggestions for switch replay / Done markup.
   * Returns text + keyboard without clearing (taps still resolve via batch id).
   */
  peekPendingSuggestions():
    | { text: string; markup: InlineKeyboard; batchId: number }
    | undefined {
    const p = this.pendingSuggestions;
    if (!p?.suggestions.length) return undefined;
    return {
      text: p.banner,
      markup: suggestionsKeyboard(p.batchId, p.suggestions),
      batchId: p.batchId,
    };
  }

  /**
   * Session card comment:
   *   always — last user prompt (≤250)
   *   busy   — plus last AI agent thinking on the next line (≤250)
   */
  get cardComment(): string | undefined {
    const user =
      this.cardUserPrompt ||
      this.sessionComment ||
      (this.sessionId ? this.acp.sessionComment(this.sessionId) : undefined) ||
      cleanUserPreview(this.suggestionUserText || this.turnUserText || "", COMMENT_MAX) ||
      undefined;
    const built = buildSessionCardComment({
      userPrompt: user,
      thinking: this.busy && this.cardThinking ? this.cardThinking : undefined,
      busy: this.busy,
    });
    return built || undefined;
  }

  /** Record a new progress value and refresh the status panel / cards. The bar
   *  is monotonic within a turn (it's reset to undefined when a new turn starts),
   *  so a streamer recreated mid-turn can't make it jump backwards. */
  private setProgress(pct: number): void {
    const next = Math.max(this.progress ?? 0, pct);
    if (next === this.progress) return;
    this.progress = next;
    this.changed();
  }

  /** Update the live step (tools/plan) — kept for diagnostics; cards use user+thinking. */
  private setLiveStep(step: string | undefined): void {
    const next = step?.trim() ? cleanCommentLine(step) : undefined;
    if (next === this.liveStep) return;
    this.liveStep = next;
    this.changed();
  }

  /** Append thought text and refresh cards when the display line changes. */
  private appendCardThinking(chunk: string): void {
    const piece = chunk.replace(/\s+/g, " ").trim();
    if (!piece) return;
    const prevShown = this.cardThinking ? clampThinking(this.cardThinking, COMMENT_MAX) : "";
    this.cardThinking = this.cardThinking ? `${this.cardThinking} ${piece}` : piece;
    const nextShown = clampThinking(this.cardThinking, COMMENT_MAX);
    if (nextShown !== prevShown) this.changed();
  }

  /** Persist last user prompt (disk + memory) so /running and /sessions see it. */
  private setSessionComment(comment: string | undefined): void {
    const next = comment?.trim()
      ? cleanUserPreview(comment, COMMENT_MAX) || cleanCommentLine(comment, COMMENT_MAX)
      : undefined;
    if (next === this.sessionComment) return;
    this.sessionComment = next;
    if (next && this.sessionId) {
      try {
        this.acp.setSessionComment(this.sessionId, next);
      } catch {
        /* non-fatal */
      }
    }
    this.changed();
  }

  /** Keep disk/memory comment = last real user prompt after a turn ends. */
  private persistCardUserPrompt(): void {
    const prompt =
      this.cardUserPrompt ||
      cleanUserPreview(this.suggestionUserText || this.turnUserText || "", COMMENT_MAX);
    if (prompt) {
      this.cardUserPrompt = prompt;
      this.setSessionComment(prompt);
    }
  }

  /** Hydrate last user prompt from disk after bind/resume. */
  private loadPersistedComment(): void {
    if (!this.sessionId) return;
    const c = this.acp.sessionComment(this.sessionId);
    if (c) {
      this.sessionComment = c;
      if (!this.cardUserPrompt) this.cardUserPrompt = cleanUserPreview(c, COMMENT_MAX) || c;
    }
  }

  /** Searchable hashtag footer for this session (project В· session В· model В·
   *  reasoning) вЂ” appended to every AI-output surface for this session. */
  get tags(): string {
    return this.hashtags();
  }

  /** Switch live-streaming on/off. Going background seals any in-flight turn;
   *  returning to the foreground while a turn is still running resumes RICH
   *  live streaming (thinking / tools / prose) rather than a degraded tail. */
  async setForeground(value: boolean): Promise<void> {
    if (this.foreground === value) return;
    this.foreground = value;
    if (value) {
      // A turn was started here and is still in flight, but its streamer was
      // finalized when we went background. Recreate it and let onUpdate feed
      // the remaining chunks/thoughts/tools just like a normal live turn.
      // Manager mode never streams (quiet notify-only) — skip streamer rebuild.
      if (this.busy && !this.streamer && !this.managerMode) {
        // Any transient follow-watch of this session is now superseded.
        if (this.watchIsFollow) this.stopWatch();
        this.streamer = new ResponseStreamer(
          this.api,
          this.chatId,
          this.cfg.streamThrottleMs,
          this.turnReplyTo,
          this.hashtags(),
          (pct) => this.setProgress(pct),
          this.cfg.progressFallback,
          this.turnStartedAt,
          this.messageThreadId,
        );
        // Restore the live plan board so steps stay visible above the progress bar.
        if (this.planEntries?.length) {
          this.streamer.setPlan(renderPlanMarkdown(this.planEntries));
        }
        this.typing.start();
      }
    } else {
      this.typing.stop();
      this.stopWatch();
      // Seal live bubble when demoted (manager has no streamer).
      if (this.streamer) {
        // Finalize off the critical path so project/session switches never wait
        // on Telegram edits of the previous live stream.
        const prev = this.streamer;
        this.streamer = undefined;
        void prev.finalize().catch(() => {});
      }
    }
    this.changed();
  }
  get reasoning(): ReasoningEffort {
    return this.settings.getKey(this.settingsKey).reasoning;
  }
  get agent(): string | undefined {
    return this.settings.getKey(this.settingsKey).agent;
  }
  get model(): string | undefined {
    return this.settings.getKey(this.settingsKey).model;
  }
  get preferredAccountId(): string | undefined {
    return this.settings.getKey(this.settingsKey).preferredAccountId;
  }

  /** Latest context-usage % / effort / credits for the current session. */
  contextInfo(): SessionMetadata | undefined {
    return this.acp.metadataFor(this.sessionId);
  }

  /** Number of turns (prompts) this runtime has completed this session. */
  get turns(): number {
    return this.turnCount;
  }

  dispose(): void {
    this.acp.off("session-update", this.listener);
    this.acp.off("plan-exit", this.planExitListener);
    this.acp.off("restarted", this.restartListener);
    this.typing.stop();
    this.stopActivityHeartbeat();
    this.stopLivenessPulse();
    this.stopWatch();
  }

  /** Plan → build transition: show it and keep the idle watch warm. */
  private onPlanExit(sessionId: string | undefined, result: unknown): void {
    if (!this.busy) return;
    if (sessionId && this.sessionId && sessionId !== this.sessionId) return;
    this.acp.touchActivity(this.sessionId);
    const outcome =
      result && typeof result === "object" && "outcome" in result
        ? String((result as { outcome?: unknown }).outcome ?? "")
        : "";
    const approved = !outcome || outcome === "approved" || outcome === "accept";
    if (!this.foreground || !this.streamer) return;
    if (approved) {
      this.setLiveStep("Plan approved \u2014 implementing\u2026");
      this.streamer.addTool("\u2705 **Plan approved** \u2014 implementing.");
    } else {
      this.setLiveStep(`Plan exit: ${outcome || "done"}`);
      this.streamer.addTool(`\u{1F4CB} Plan exit: **${outcome || "done"}**`);
    }
  }

  // в”Ђв”Ђ sessions в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

  async startNewSession(cwd: string, projectName?: string): Promise<void> {
    await this.accountRotator?.waitForIdle();
    if (this.busy) await this.cancel();
    await this.bindNewSession(cwd, projectName);
  }

  /**
   * Create a fresh live session and adopt it. Does NOT cancel an in-flight turn
   * (the caller decides), so the auto-fork-on-error path can swap to a clean
   * session mid-turn without flagging the turn as user-cancelled.
   */
  private async bindNewSession(cwd: string, projectName?: string): Promise<void> {
    this.stopWatch();
    this.sessionId = await this.acp.newSession(cwd);
    this.sessionLive = true;
    this.rebindPending = false;
    this.cwd = cwd;
    this.projectName = projectName;
    this.turnCount = 0;
    this.lastReportedCredits = 0;
    this.liveStep = undefined;
    this.sessionComment = undefined;
    this.cardUserPrompt = undefined;
    this.cardThinking = "";
    await this.applySessionPrefs();
    this.persist();
    this.sessionChanged();
    log.info(`chat ${this.chatId} -> new session ${this.sessionId} @ ${cwd}`);
    this.changed();
  }

  /** Ensure a session is live in the current ACP process (used before menus). */
  async prepare(): Promise<void> {
    await this.ensureSession();
  }

  async resumeSession(sessionId: string, cwd: string, projectName?: string): Promise<void> {
    if (!this.acp.supportsLoadSession) {
      throw new Error("This Grok CLI build does not support loading sessions.");
    }
    if (this.busy) await this.cancel();
    this.stopWatch();
    await this.acp.loadSession(sessionId, cwd);
    this.sessionId = sessionId;
    this.sessionLive = true;
    this.rebindPending = false;
    this.cwd = cwd;
    this.projectName = projectName;
    this.loadPersistedComment();
    this.persist();
    log.info(`chat ${this.chatId} -> resumed session ${sessionId} @ ${cwd}`);
    this.changed();
  }

  async attach(
    sessionId: string,
    cwd: string,
    projectName: string | undefined,
    priorEntries: HistoryEntry[],
  ): Promise<AttachResult> {
    try {
      await this.resumeSession(sessionId, cwd, projectName);
      return "resumed";
    } catch (err) {
      log.warn(`load failed (${(err as Error).message}); forking ${sessionId.slice(0, 8)}`);
      await this.startNewSession(cwd, projectName);
      if (priorEntries.length > 0) this.primingContext = buildPriming(buildTranscript(priorEntries));
      return "forked";
    }
  }

  /**
   * Start a brand-new Grok session primed with a full foreign transcript
   * (import from Kiro / OpenCode / Claude / Codex). Priming is applied on the
   * next {@link submit} so the imported context becomes part of Grok's history.
   */
  async startImportedSession(cwd: string, projectName: string | undefined, priming: string): Promise<void> {
    await this.startNewSession(cwd, projectName);
    if (priming.trim()) this.primingContext = priming;
    // Imported transcripts already have context — skip first-prompt directives.
    this.markFirstPromptSteered();
  }

  startWatch(jsonlPath: string, follow = false): void {
    this.stopWatch();
    this.watchIsFollow = follow;
    this.watcher = new TailWatcher(jsonlPath, (entries) => void this.onWatchEntries(entries));
    this.watcher.start(true);
  }

  stopWatch(): boolean {
    if (!this.watcher) return false;
    this.watcher.stop();
    this.watcher = undefined;
    this.watchIsFollow = false;
    return true;
  }

  // в”Ђв”Ђ preferences в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

  async setModelPref(modelId: string): Promise<{ ok: boolean; error?: string }> {
    // Persist the choice always; only talk to Grok when a session is live in
    // the current process (set_model on an unloaded session crashes the agent).
    this.settings.updateKey(this.settingsKey, { model: modelId });
    if (modelId && this.sessionLive && this.sessionId) {
      if (!this.acp.hasModel(modelId)) return { ok: false, error: `unknown model: ${modelId}` };
      try {
        await this.acp.setModel(this.sessionId, modelId);
      } catch (e) {
        this.changed();
        return { ok: false, error: (e as Error).message };
      }
    }
    this.changed();
    return { ok: true };
  }

  async setAgentPref(agent: string): Promise<void> {
    this.settings.updateKey(this.settingsKey, { agent });
    if (agent && this.sessionLive && this.sessionId && this.acp.hasMode(agent)) {
      try {
        await this.acp.setMode(this.sessionId, agent);
      } catch (e) {
        log.warn(`set_mode(${agent}) failed: ${(e as Error).message}`);
      }
    }
    this.changed();
  }

  setReasoningPref(effort: ReasoningEffort): void {
    this.settings.updateKey(this.settingsKey, { reasoning: effort });
    this.changed();
  }

  setPreferredAccountId(id: string | undefined): void {
    this.settings.updateKey(this.settingsKey, { preferredAccountId: id || undefined });
    // Force re-apply on next ensureSession when user changes preference.
    this.preferredAccountApplied = undefined;
    this.changed();
  }

  private async applySessionPrefs(): Promise<void> {
    const s = this.settings.getKey(this.settingsKey);
    // Drop any persisted model the agent doesn't actually offer (an unknown id
    // is silently accepted by set_model but then breaks the next prompt).
    if (s.model && !this.acp.hasModel(s.model)) {
      log.warn(`clearing invalid persisted model "${s.model}" for scope ${this.settingsKey}`);
      this.settings.updateKey(this.settingsKey, { model: "" });
    }
    const cur = this.settings.getKey(this.settingsKey);
    // Adopt the session's current agent (mode) when the user hasn't chosen one.
    if (!cur.agent && this.acp.currentModeId) {
      this.settings.updateKey(this.settingsKey, { agent: this.acp.currentModeId });
    } else if (this.sessionId && cur.agent && this.acp.hasMode(cur.agent) && cur.agent !== this.acp.currentModeId) {
      try {
        await this.acp.setMode(this.sessionId, cur.agent);
      } catch (e) {
        log.debug(`apply agent failed: ${(e as Error).message}`);
      }
    }
    if (this.sessionId && cur.model && this.acp.hasModel(cur.model)) {
      try {
        await this.acp.setModel(this.sessionId, cur.model);
      } catch (e) {
        log.debug(`apply model failed: ${(e as Error).message}`);
      }
    }
  }

  // ── prompting ────────────────────────────────────────────────────────────

  async submit(input: PromptInput): Promise<"ran" | "queued"> {
    await this.ensureSession();
    // Attach staged manager report-back to this prompt (FIFO through the queue).
    let toSubmit = input;
    if (this.stagedReportBack) {
      const rb = this.stagedReportBack;
      this.stagedReportBack = undefined;
      toSubmit = input.reportBack ? input : { ...input, reportBack: rb };
      if (this.sessionId) bindJobSession(rb.jobId, this.sessionId);
    }
    if (this.busy) {
      this.queue.push(toSubmit);
      this.changed();
      return "queued";
    }
    // First-prompt steering is applied inside runTurn so queued first messages
    // (and flushQueue) get the same complexity + telegram bridge directives.
    void this.runTurn(toSubmit);
    return "ran";
  }

  private markFirstPromptSteered(): void {
    if (!this.sessionId) return;
    this.complexitySteered.add(this.sessionId);
    this.telegramBridgeSteered.add(this.sessionId);
  }

  private telegramBridgeDirective(): string {
    return buildTelegramBridgeDirective({
      forumReady: !!this.bridge?.forum?.isReady,
      topicGroupId: this.cfg.topicGroupId,
      allowedBots: this.cfg.allowedTelegramBots,
      botCommands: this.cfg.telegramBotCommands,
      managerMode: this.managerMode,
    });
  }

  /**
   * Complexity + telegram bridge teaching on the first prompt of a brand-new
   * conversation only (no prior user turns in this process / session jsonl).
   * Manager mode uses MANAGER_DIRECTIVE instead of complexity/progress coding UX.
   */
  private applyFirstPromptSteering(input: PromptInput): PromptInput {
    // Grok slash commands (/goal …) must stay the first agent text.
    if (input.rawSlashCommand) return input;
    if (!this.shouldSteerFirstPrompt(input)) return input;
    let toRun: PromptInput;
    if (this.managerMode) {
      toRun = wrapManagerDirective(input);
      toRun = wrapTelegramBridgePrompt(toRun, this.telegramBridgeDirective());
      this.markFirstPromptSteered();
      log.info(`chat ${this.chatId}: first-prompt manager + telegram bridge applied`);
      return toRun;
    }
    toRun = wrapAutoComplexityPrompt(input);
    toRun = wrapTelegramBridgePrompt(toRun, this.telegramBridgeDirective());
    this.markFirstPromptSteered();
    log.info(`chat ${this.chatId}: first-prompt complexity + telegram bridge applied`);
    return toRun;
  }

  /**
   * Apply first-prompt directives only on a brand-new conversation (no prior
   * user turns in this process / session jsonl).
   */
  private shouldSteerFirstPrompt(input: PromptInput): boolean {
    if (!this.sessionId) return false;
    if (this.complexitySteered.has(this.sessionId) && this.telegramBridgeSteered.has(this.sessionId)) {
      return false;
    }
    if (this.turnCount > 0) return false;
    // Never wrap meta follow-ups even if somehow first.
    if (
      input.skipSelfRecheck ||
      isSelfRecheckPrompt(input.text) ||
      isTelegramBridgeResultsPrompt(input.text) ||
      isManagerWorkReportPrompt(input.text)
    ) {
      return false;
    }
    try {
      const path = join(this.cfg.sessionsDir, `${this.sessionId}.jsonl`);
      const hist = readHistory(path, 8);
      if (hist.some((e) => e.role === "user" && e.text.trim().length > 0)) {
        this.complexitySteered.add(this.sessionId);
        this.telegramBridgeSteered.add(this.sessionId);
        return false;
      }
    } catch {
      /* treat as fresh */
    }
    return true;
  }

  /** Memory + topic catalog inject for every real manager user turn. */
  private applyManagerContext(input: PromptInput): PromptInput {
    if (!this.managerMode) return input;
    if (input.rawSlashCommand) return input;
    if (
      isTelegramBridgeResultsPrompt(input.text) ||
      isManagerWorkReportPrompt(input.text) ||
      isSelfRecheckPrompt(input.text)
    ) {
      return input;
    }
    if (!this.bridge) return input;
    const userText = stripDirectiveWrappers(input.text) || input.text;
    const block = buildManagerContextBlock({
      userText,
      sessionsDir: this.cfg.sessionsDir,
      store: this.bridge.store,
      forum: this.bridge.forum,
    });
    return {
      ...input,
      text: injectManagerContext(input.text, block),
    };
  }

  /**
   * Stop the current turn for this runtime only.
   * Soft ACP cancel + session-scoped force-complete; never kills the shared
   * agent (that would stop every multiplexed chat and take the bot offline).
   */
  async cancel(): Promise<boolean> {
    if (!this.busy || !this.sessionId) return false;
    this.cancelled = true;
    // Clear queue of follow-ups for this turn? No — only stop the active turn;
    // queued user messages remain so the user can flush later if they want.
    await this.acp.cancel(this.sessionId);
    return true;
  }

  clearQueue(): number {
    const n = this.queue.length;
    this.queue.length = 0;
    this.changed();
    return n;
  }

  drainQueueToPrompt(): PromptInput | undefined {
    if (this.queue.length === 0) return undefined;
    return mergeInputs(this.queue.splice(0, this.queue.length));
  }

  private async ensureSession(): Promise<void> {
    // Account rotation restarts the process globally. Do not bind a new chat
    // to a candidate account until the owner has finished probing it.
    await this.accountRotator?.waitForIdle();
    await this.applyPreferredAccount();
    if (this.rebindPending && this.sessionId) {
      // The ACP process is frequently mid-restart the first time we re-bind
      // (auto-restart after a crash, or a fresh bot boot), so a single attempt
      // is flaky. Retry briefly before giving up.
      if (await this.rebindWithRetries(this.sessionId)) {
        this.sessionLive = true;
        this.rebindPending = false;
        await this.applySessionPrefs();
        log.info(`chat ${this.chatId} re-bound session ${this.sessionId.slice(0, 8)}`);
        return;
      }
      // The session genuinely can't be reloaded (its exclusive lock is held,
      // or its log/metadata is gone). Never silently drop the conversation:
      // fork a linked continuation primed with the recent transcript so the
      // thread survives вЂ” including any question the agent had just asked.
      // forkFromLostSession() only throws if the agent is fully down, in which
      // case we leave rebindPending set so the next message retries cleanly.
      await this.forkFromLostSession(this.sessionId);
      this.rebindPending = false;
      return;
    }
    if (!this.sessionId) await this.startNewSession(this.cwd, this.projectName);
  }

  /** Last preferred account we successfully aligned to (avoids activate thrash). */
  private preferredAccountApplied?: string;

  /**
   * If this scope prefers a saved account and the process is on another login,
   * switch before binding the session. Skips when another turn is in flight
   * (account switch restarts the agent) or we already applied this preference.
   */
  private async applyPreferredAccount(): Promise<void> {
    const preferred = this.preferredAccountId;
    const rotator = this.accountRotator;
    if (!preferred || !rotator) return;
    const st = rotator.state();
    if (st.activeId === preferred) {
      this.preferredAccountApplied = preferred;
      return;
    }
    // User cleared or changed preference — allow one more activate.
    if (this.preferredAccountApplied === preferred) return;
    if (this.acp.hasInflightPrompt()) {
      log.debug(`scope ${this.settingsKey}: skip preferred account (turn in flight)`);
      return;
    }
    try {
      await rotator.activate(preferred);
      this.preferredAccountApplied = preferred;
      log.info(`scope ${this.settingsKey}: activated preferred account ${preferred.slice(0, 8)}`);
    } catch (e) {
      log.debug(`preferred account activate failed: ${(e as Error).message}`);
    }
  }

  /** Reload a persisted session, retrying flaky failures with a short backoff.
   *  Returns true once loaded, false after the attempts are exhausted. */
  private async rebindWithRetries(sessionId: string, attempts = 4): Promise<boolean> {
    const delays = [400, 1200, 3000]; // ~4.6s total before giving up
    for (let i = 0; i < attempts; i++) {
      try {
        await this.acp.loadSession(sessionId, this.cwd);
        this.loadPersistedComment();
        return true;
      } catch (err) {
        log.warn(
          `re-bind ${sessionId.slice(0, 8)} attempt ${i + 1}/${attempts} failed: ${(err as Error).message}`,
        );
        if (i === attempts - 1) return false;
        await sleep(delays[Math.min(i, delays.length - 1)]!);
      }
    }
    return false;
  }

  /** Continue a session we could not reload by forking a fresh one primed with
   *  the lost session's recent transcript, so no context is dropped. */
  private async forkFromLostSession(lostId: string): Promise<void> {
    const transcript = recentTranscript(this.cfg.sessionsDir, lostId);
    log.warn(
      `chat ${this.chatId} could not reload ${lostId.slice(0, 8)}; forking a linked continuation` +
        (transcript ? " (primed with recent transcript)" : ""),
    );
    await this.startNewSession(this.cwd, this.projectName); // sets a fresh, live sessionId
    if (transcript) this.primingContext = buildPriming(transcript);
    if (this.foreground) {
      await this.notify(
        transcript
          ? "\u{1F517} Couldn't reopen the previous session, so I started a linked continuation primed with the recent transcript \u2014 we can keep going from where we left off."
          : "\u{1F517} Couldn't reopen the previous session, so I started a fresh one here.",
      );
    }
  }

  private async runTurn(input: PromptInput): Promise<void> {
    // Apply before any turn bookkeeping so card previews / logs see the wrapped
    // text the same way the agent does (also covers flushQueue first messages).
    input = this.applyFirstPromptSteering(input);
    input = this.applyManagerContext(input);

    this.busy = true;
    this.cancelled = false;
    this.turnReplyTo = input.replyTo;
    this.turnPromptId = input.promptId;
    this.turnUserText = input.text;
    this.turnAssistantText = "";
    this.cardThinking = "";
    this.turnExpectDone = false;
    this.turnDonePinged = false;
    // Drop any orphaned Thinking… from a prior turn (e.g. bridge-chain defer).
    if (this.managerStatusMsgId !== undefined) {
      const orphan = this.managerStatusMsgId;
      this.managerStatusMsgId = undefined;
      void this.deleteManagerStatus(orphan);
    }
    this.isSelfRecheckTurn = isSelfRecheckPrompt(input.text);
    // Meta turns (recheck, bridge results, work reports) never arm another recheck.
    const isBridgeResults = isTelegramBridgeResultsPrompt(input.text);
    const isWorkReport = isManagerWorkReportPrompt(input.text);
    this.skipSelfRecheck =
      !!input.skipSelfRecheck ||
      this.isSelfRecheckTurn ||
      isBridgeResults ||
      isWorkReport ||
      this.managerMode;
    // Fresh user work resets bridge-chain depth + suggestion anchors.
    if (!this.isSelfRecheckTurn && !isBridgeResults && !isWorkReport) {
      this.bridgeResultDepth = 0;
    }
    // Fresh user work resets suggestion anchors; recheck / bridge results keep the original ask.
    // Strip complexity/reply wrappers so suggestions + recheck see the real ask.
    if (!this.isSelfRecheckTurn && !isBridgeResults && !isWorkReport) {
      this.suggestionUserText = stripDirectiveWrappers(input.text) || input.text;
      this.preRecheckAssistantText = "";
      this.preRecheckFileOps = new Map();
      // Card comment: last real user prompt (not self-recheck / empty meta).
      const preview = input.text.trim()
        ? cleanUserPreview(input.text, COMMENT_MAX)
        : input.images.length
          ? "Attached image(s)"
          : "";
      if (preview) {
        this.cardUserPrompt = preview;
        this.setSessionComment(preview);
      }
    }
    // Bind THIS prompt's report-back (manager dispatch). Meta follow-ups
    // (recheck / bridge results) omit reportBack and keep the prior job until
    // the queue drains and we report once.
    if (input.reportBack) {
      this.pendingReportBack = input.reportBack as ReportBackMeta;
    }
    if (this.pendingReportBack && this.sessionId) {
      bindJobSession(this.pendingReportBack.jobId, this.sessionId);
    }
    this.shownToolIds = new Set();
    this.toolCallCache = new Map();
    this.fileOps = new Map();
    this.subagentShown = new Map();
    this.ownedSubagentIds = new Set();
    this.subagentThinkPulse = new Map();
    this.subagentToolCache = new Map();
    this.progress = undefined; // a new turn = a new task; clear the old bar
    this.planEntries = undefined; // plan board is per-turn
    this.pendingSuggestions = undefined; // new work supersedes previous Done suggestions
    this.setLiveStep(
      this.isSelfRecheckTurn
        ? "Self-recheck: hunting bugs / incomplete logic\u2026"
        : input.text.trim()
          ? `Working: ${cleanUserPreview(input.text, 110)}`
          : input.images.length
            ? "Working on attached image(s)\u2026"
            : "Working\u2026",
    );
    // A new streamed turn supersedes any transient "follow" watch of this same
    // session's previous in-flight turn (avoids duplicated output).
    if (this.watchIsFollow) this.stopWatch();
    // Manager (General): quiet-by-default — no prose stream. User-facing text
    // only via notify actions (or one fallback reply for direct user asks).
    // Project topics stream when foreground. Raw slash (/goal) always streams.
    const rawSlash = !!input.rawSlashCommand;
    const live = (this.foreground && !this.managerMode) || rawSlash;
    const startedAt = Date.now();
    this.turnStartedAt = startedAt;
    this.managerNotifyCount = 0;
    this.managerUserVisible = false;
    this.managerStatusMsgId = undefined;
    // General: Starting… (from message handler) → Thinking… status only.
    // Meta wakes (work report / bridge results) stay fully silent (no bubble).
    const managerMeta =
      this.managerMode &&
      !rawSlash &&
      (isManagerWorkReportPrompt(input.text) ||
        isTelegramBridgeResultsPrompt(input.text) ||
        isSelfRecheckPrompt(input.text) ||
        !!input.skipSelfRecheck);
    let thinkingMsgId: number | undefined = input.seedMessageId;
    if (this.managerMode && !managerMeta && this.turnReplyTo !== undefined) {
      if (thinkingMsgId !== undefined) {
        await this.editManagerStatus(thinkingMsgId, "Thinking\u2026");
      } else {
        thinkingMsgId = await this.postManagerStatus(this.turnReplyTo, "Thinking\u2026");
      }
      this.managerStatusMsgId = thinkingMsgId;
    } else if (this.managerMode && managerMeta && thinkingMsgId !== undefined) {
      // Drop Starting… leftover on meta turns.
      await this.deleteManagerStatus(thinkingMsgId);
      thinkingMsgId = undefined;
    }
    this.streamer = live
      ? new ResponseStreamer(
          this.api,
          this.chatId,
          this.cfg.streamThrottleMs,
          this.turnReplyTo,
          this.hashtags(),
          this.managerMode && !rawSlash ? undefined : (pct) => this.setProgress(pct),
          this.managerMode && !rawSlash ? false : this.cfg.progressFallback,
          startedAt,
          this.messageThreadId,
          this.managerMode && rawSlash
            ? { proseOnly: true, showProgressBar: false }
            : undefined,
        )
      : undefined;
    // Seed a live bubble immediately so "Still working" / subagent cards have a
    // message to edit before the first ACP chunk (long crew waits).
    if (this.streamer && live && !this.managerMode) {
      void this.streamer.ensureLiveSurface("\u23F3 Working\u2026").catch(() => {});
    }
    // Bind user message (+ status bubble) → session for reply routing.
    if (this.managerMode && this.sessionId) {
      if (this.turnReplyTo !== undefined) {
        this.onTelegramMessageBound?.(this.turnReplyTo, this.sessionId);
      }
      if (thinkingMsgId !== undefined) {
        this.onTelegramMessageBound?.(thinkingMsgId, this.sessionId);
      }
    }
    // Typing indicator for user-facing manager turns and live project streams.
    if (live || (this.managerMode && !managerMeta)) this.typing.start();
    this.activity(true);
    this.turnPulseStartedAt = startedAt;
    this.startActivityHeartbeat();
    this.startLivenessPulse();
    this.changed();
    this.imageScanText = "";
    this.sentImagesThisTurn = new Set();

    const content = buildContentBlocks(input, {
      reasoning: reasoningDirective(this.reasoning),
      priming: this.primingContext,
      imageOutput:
        !this.managerMode && this.cfg.sendAgentImages
          ? IMAGE_OUTPUT_DIRECTIVE
          : undefined,
      // Manager chat: no progress spam; project topics keep the usual directive.
      progress:
        !this.managerMode && this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
    });
    this.primingContext = undefined;

    try {
      const outcome = await this.runPromptWithRetries(content);
      const rebound = await this.maybeRecoverAgentSession(input, outcome);
      let final = rebound ?? outcome;
      const recovered = await this.maybeAutoFork(input, final);
      final = recovered ?? final;
      // Last resort: if the turn still failed, rotate through other saved
      // accounts (once) and retry on each until one works.
      const rotated = await this.maybeRotateAccount(input, final);
      if (rotated) final = rotated;
      // A transient error that struck AFTER streaming began skips the paths
      // above (they must not re-run already-executed tools). Recover by asking
      // the SAME session to CONTINUE from where it stopped, with backoff.
      const resumed = await this.maybeResumeAfterStream(final);
      if (resumed) final = resumed;
      const streamedOutput = this.streamer?.hasOutput ?? false;
      // On a successful, non-cancelled turn, top the fallback bar up to 100 (a
      // no-op when the agent reported its own progress — its value is kept).
      if (final.result && !this.cancelled) this.streamer?.completeFallback();
      if (this.streamer) await this.streamer.finalize();
      if (this.foreground) await this.sendTurnImages();

      // Telegram bridge actions (JSON fences in the agent reply). Process on
      // normal turns AND bridge-results follow-ups so multi-step bot_command /
      // search chains work; depth cap prevents infinite loops.
      let queuedBridgeResults = false;
      if (final.result && !this.cancelled) {
        queuedBridgeResults = await this.processTelegramBridgeActions();
      }

      // Always build the completion (records `lastCompletion` so switching back
      // to this session can replay its Done + summary). Only PING the chat for
      // the foreground turn, or a background turn when NOTIFY_OTHER_SESSIONS is on.
      const canPing = this.foreground || this.cfg.notifyOtherSessions;
      // A background session about to run a queued follow-up shouldn't ping its
      // interim "Done" — only the final, queue-empty turn announces completion.
      const hasQueued = this.queue.length > 0;
      const switchKb = this.switchKeyboard();
      if (final.result && !this.cancelled) {
        this.turnCount++;
        // Persist real per-account usage (turns + reported credits) for /accounts and /usage.
        this.recordAccountUsage();
        // Card comment: last user prompt (thinking cleared when idle).
        this.persistCardUserPrompt();
        this.cardThinking = "";
        // Keep live step while bridge/sibling-bot results are still queued —
        // clearing here made "Waiting for bot" vanish before the interim notify.
        if (!queuedBridgeResults) this.setLiveStep(undefined);
      } else if (this.cancelled) {
        this.persistCardUserPrompt();
        this.cardThinking = "";
        this.setLiveStep(undefined);
      } else if (final.error) {
        this.persistCardUserPrompt();
        this.cardThinking = "";
        this.setLiveStep(undefined);
      }
      if (final.result || this.cancelled) {
        // Bridge results in the queue mean "not Done yet" — never treat as a
        // completion ping even in the foreground. Do not post bridge status
        // spam to the chat (live step / status panel only).
        const pingDone =
          canPing && (this.foreground || !hasQueued) && !queuedBridgeResults;
        // Manager uses notify/finishManagerUserFacing — never arm Done safety-net spam.
        // Raw slash (/goal) uses normal project Done path when streamed.
        this.turnExpectDone = pingDone && !(this.managerMode && !rawSlash);

        // One-shot self-recheck: only after a real *user* turn (not meta/auto),
        // with idle queue. skipSelfRecheck blocks loops after recheck / auto-batch.
        // Also skipped when no files were modified, or when a quiet AI decision
        // refuses (simple tasks, pure build, nothing worth re-verifying).
        // Delay recheck/Done when bridge results are queued (like self-recheck).
        const wantSelfRecheck =
          !!final.result &&
          !this.cancelled &&
          !hasQueued &&
          !queuedBridgeResults &&
          this.cfg.selfRecheckEnabled &&
          !this.skipSelfRecheck &&
          !this.isSelfRecheckTurn;

        let queuedRecheck = false;
        if (wantSelfRecheck) {
          this.preRecheckAssistantText = this.turnAssistantText;
          // Strip COMPLEXITY wrapper so recheck + suggestions see the real ask.
          this.suggestionUserText = stripDirectiveWrappers(this.turnUserText) || this.turnUserText;
          this.preRecheckFileOps = cloneFileOps(this.fileOps);
          this.setLiveStep("Deciding if self-recheck is needed\u2026");
          this.changed();
          // Visible chat status so stream-complete is not mistaken for a silent exit.
          if (pingDone) {
            await this.notify(
              "\u{1F50D} Checking if a quality pass is needed\u2026",
              { loud: true, replyTo: this.turnReplyTo },
            );
          }
          const recheck = await this.maybePlanSelfRecheck();
          this.setLiveStep(undefined);
          // User may cancel during the quiet decision call — first turn still
          // succeeded; never queue a recheck after cancel.
          if (this.cancelled) {
            this.preRecheckFileOps = new Map();
            this.preRecheckAssistantText = "";
          } else if (recheck) {
            queuedRecheck = true;
            this.turnExpectDone = false; // final Done comes after the recheck turn
            // Front of queue; mark skip so the recheck turn never re-arms itself.
            this.queue.unshift(
              textPrompt(recheck, this.turnReplyTo, undefined, {
                skipSelfRecheck: true,
                promptId: this.turnPromptId,
              }),
            );
            this.changed();
            if (pingDone) {
              // Interim status + first-turn file list (final Done comes after recheck).
              const firstFiles = summarizeFileOps(this.preRecheckFileOps, this.cwd);
              await this.notify(
                `\u{1F50D} Self-recheck \u2014 bugs, logic gaps, related follow-through (once)\u2026\n\n` +
                  `\u{1F4C1} After first turn\n${firstFiles}`,
                { loud: true, replyTo: this.turnReplyTo, replyMarkup: switchKb },
              );
            }
          } else {
            // No recheck — clear frozen first-turn ops (nothing to split later).
            this.preRecheckFileOps = new Map();
            this.preRecheckAssistantText = "";
          }
        }

        // Manager: if bridge results are still chaining, drop Thinking… so it
        // does not stick forever (meta follow-up is silent by default).
        if (this.managerMode && queuedBridgeResults) {
          if (this.managerStatusMsgId !== undefined && this.managerNotifyCount === 0) {
            const sid = this.managerStatusMsgId;
            this.managerStatusMsgId = undefined;
            void this.deleteManagerStatus(sid);
          }
        }

        if (!queuedRecheck && !queuedBridgeResults) {
          // Manager (General): quiet-by-default completion — no Done spam.
          // User-facing only via notify (already sent) or one fallback reply.
          if (this.managerMode && !rawSlash) {
            await this.finishManagerUserFacing(managerMeta, final.result?.stopReason, startedAt);
            this.turnDonePinged = true;
            // Suggestions only when something was actually shown to the user.
            if (
              final.result &&
              !this.cancelled &&
              !hasQueued &&
              this.managerUserVisible &&
              !managerMeta
            ) {
              try {
                const baseForSug =
                  cleanManagerVisibleText(this.turnAssistantText).slice(0, 500) || "Done";
                await this.collectAndApplySuggestions(baseForSug, undefined, {
                  autoQueue: true,
                });
              } catch (e) {
                log.debug(`manager suggestions failed: ${(e as Error).message}`);
              }
            }
          } else {
          // Build Done text *now* (after quiet decision) so a cancel during the
          // recheck-decision wait shows ⏹ Stopped, not a stale ✅ Done head.
          let doneText = this.isSelfRecheckTurn
              ? this.completionMessageSplit(final.result?.stopReason, startedAt, streamedOutput)
              : this.completionMessage(final.result?.stopReason, startedAt, streamedOutput);
          // 1) Always send Done FIRST — never block the completion ping on the
          // quiet suggestions prompt (which can hang and look like "no Done").
          let doneMsgId: number | undefined;
          const shouldPingDone = pingDone;
          if (shouldPingDone && doneText.trim()) {
            doneMsgId = await this.notify(doneText, {
              loud: true,
              replyTo: this.turnReplyTo,
              replyMarkup: switchKb,
            });
            if (doneMsgId !== undefined) this.turnDonePinged = true;
          }
          // 2) Suggestions: project topics keep Done-edit UX.
          if (final.result && !this.cancelled && !hasQueued) {
            try {
              const baseForSug = doneText;
              const sug = await this.collectAndApplySuggestions(
                baseForSug,
                switchKb,
                {
                  autoQueue: this.foreground,
                },
              );
              if (shouldPingDone && sug.text !== doneText) {
                await this.enhanceDoneMessage(doneMsgId, sug.text, sug.markup ?? switchKb);
              }
            } catch (e) {
              log.debug(`suggestions after Done failed: ${(e as Error).message}`);
            }
          }
          }
          // Clear frozen first-turn ops after final Done (recheck path done).
          if (this.isSelfRecheckTurn) this.preRecheckFileOps = new Map();

          // Child work dispatched from General → wake manager with a report.
          // (Waits only for same-job meta follow-ups; see maybeReportBackToManager.)
          await this.maybeReportBackToManager({
            ok: !!final.result && !this.cancelled,
            cancelled: this.cancelled,
            stopReason: final.result?.stopReason,
            error: undefined,
          });
        }
        // queuedBridgeResults: stay quiet in chat — agent gets results via queue.
      } else if (final.error) {
        // Manager: one short important message (or edit Thinking…); never Done spam.
        if (this.managerMode) {
          await this.finishManagerError(final.error.message, startedAt);
          this.turnDonePinged = true;
          await this.maybeReportBackToManager({
            ok: false,
            cancelled: false,
            error: final.error.message,
          });
        } else if (this.isSelfRecheckTurn && !hasQueued) {
          // If the self-recheck pass itself failed, still surface Done for the
          // original work (split files + suggestions) so the user is not stuck.
          const switchKb = this.switchKeyboard();
          const pingDone = canPing && (this.foreground || !hasQueued);
          this.turnExpectDone = pingDone;
          let doneText =
            this.completionMessageSplit(undefined, startedAt, streamedOutput) +
            `\n\n\u26A0\uFE0F Self-recheck failed: ${final.error.message}`;
          let doneMsgId: number | undefined;
          if (pingDone) {
            doneMsgId = await this.notify(doneText, {
              loud: true,
              replyTo: this.turnReplyTo,
              replyMarkup: switchKb,
            });
            if (doneMsgId !== undefined) this.turnDonePinged = true;
          }
          if (!this.cancelled) {
            try {
              const sug = await this.collectAndApplySuggestions(doneText, switchKb, {
                autoQueue: this.foreground,
              });
              if (pingDone && sug.text !== doneText) {
                await this.enhanceDoneMessage(doneMsgId, sug.text, sug.markup ?? switchKb);
              }
            } catch (e) {
              log.debug(`suggestions after recheck-fail Done failed: ${(e as Error).message}`);
            }
          }
          this.preRecheckFileOps = new Map();
          // Self-recheck failed after real work — still report manager job if any.
          await this.maybeReportBackToManager({
            ok: true,
            cancelled: this.cancelled,
            stopReason: "self_recheck_failed",
            error: final.error.message,
          });
        } else {
          const transient = isTransientError(final.error);
          const liveMsg = this.errorMessage(final.error, startedAt, final.attempts, transient);
          this.turnExpectDone = canPing;
          if (canPing) {
            const id = await this.notify(liveMsg, {
              loud: true,
              replyTo: this.turnReplyTo,
              replyMarkup: switchKb,
            });
            if (id !== undefined) this.turnDonePinged = true;
          }
          await this.maybeReportBackToManager({
            ok: false,
            cancelled: false,
            error: final.error.message,
          });
        }
      }
    } catch (err) {
      // Unexpected failure outside the prompt path (e.g. while finalizing).
      await this.streamer?.finalize().catch(() => {});
      const errMsg = (err as Error).message;
      this.persistCardUserPrompt();
      this.cardThinking = "";
      this.setLiveStep(undefined);
      // If the self-recheck pass itself blew up, still surface Done for the
      // original work (split files + suggestions) so the user is not stuck.
      if (this.isSelfRecheckTurn && this.queue.length === 0) {
        const switchKb = this.switchKeyboard();
        const canPing = this.foreground || this.cfg.notifyOtherSessions;
        this.turnExpectDone = canPing;
        let doneText =
          this.completionMessageSplit(undefined, startedAt, this.streamer?.hasOutput ?? false) +
          `\n\n\u26A0\uFE0F Self-recheck failed: ${errMsg}`;
        try {
          let doneMsgId: number | undefined;
          if (canPing) {
            doneMsgId = await this.notify(doneText, {
              loud: true,
              replyTo: this.turnReplyTo,
              replyMarkup: switchKb,
            });
            if (doneMsgId !== undefined) this.turnDonePinged = true;
          }
          if (!this.cancelled) {
            try {
              const sug = await this.collectAndApplySuggestions(doneText, switchKb, {
                autoQueue: this.foreground,
              });
              if (canPing && sug.text !== doneText) {
                await this.enhanceDoneMessage(doneMsgId, sug.text, sug.markup ?? switchKb);
              }
            } catch (e2) {
              log.debug(`suggestions after recheck catch failed: ${(e2 as Error).message}`);
            }
          }
        } catch (e2) {
          log.debug(`recheck catch recovery failed: ${(e2 as Error).message}`);
          if (canPing && !this.turnDonePinged) {
            const id = await this.notify(doneText, {
              loud: true,
              replyTo: this.turnReplyTo,
              replyMarkup: switchKb,
            });
            if (id !== undefined) this.turnDonePinged = true;
          }
        }
        this.preRecheckFileOps = new Map();
      } else if (this.managerMode) {
        await this.finishManagerError(errMsg, startedAt);
        this.turnDonePinged = true;
        await this.maybeReportBackToManager({
          ok: false,
          cancelled: this.cancelled,
          error: errMsg,
        });
      } else {
        const msg = `\u274C Error after ${fmtDuration(Date.now() - startedAt)}: ${errMsg}`;
        this.lastCompletion = msg;
        const canPing = this.foreground || this.cfg.notifyOtherSessions;
        this.turnExpectDone = canPing;
        if (canPing) {
          const from = this.foreground ? "" : `\u{1F4E8} From other session ${this.sessionTag()}\n`;
          const id = await this.notify(`${from}${msg}`, {
            loud: true,
            replyTo: this.turnReplyTo,
            replyMarkup: this.switchKeyboard(),
          });
          if (id !== undefined) this.turnDonePinged = true;
        }
        await this.maybeReportBackToManager({
          ok: false,
          cancelled: this.cancelled,
          error: errMsg,
        });
      }
    } finally {
      // Safety net: turn completed with an expected Done ping that never landed
      // (notify failed, hung path, etc.). Never block queue flush on this.
      // Manager never uses this path (turnExpectDone is false in manager mode).
      if (this.turnExpectDone && !this.turnDonePinged && !this.managerMode) {
        const fallback =
          this.lastCompletion?.trim() ||
          `\u2705 Done \u00B7 ${fmtDuration(Date.now() - startedAt)}`;
        const short =
          fallback.length > 3500 ? fallback.slice(0, 3499) + "\u2026" : fallback;
        try {
          const id = await this.notify(short, {
            loud: true,
            replyTo: this.turnReplyTo,
            replyMarkup: this.switchKeyboard(),
          });
          if (id !== undefined) this.turnDonePinged = true;
          else log.warn(`chat ${this.chatId}: Done safety-net notify failed`);
        } catch (e) {
          log.warn(`chat ${this.chatId}: Done safety-net error: ${(e as Error).message}`);
        }
      }
      this.turnExpectDone = false;
      this.typing.stop();
      this.stopActivityHeartbeat();
      this.stopLivenessPulse();
      this.streamer = undefined;
      this.capturingQuiet = false;
      this.quietCaptureBuf = "";
      this.busy = false;
      this.activity(false);
      // The in-flight turn we may have been following live is over.
      if (this.watchIsFollow) this.stopWatch();
      // Turn ended (done / stopped / error): drop the live task-progress value so
      // the bar is removed from the status panel, session cards and switch
      // messages. The finished streamed bubble keeps its own (frozen) bar.
      this.progress = undefined;
      this.planEntries = undefined;
      // Idle cards show last user prompt only (clear live step / thinking).
      this.cardThinking = "";
      if (!this.liveStep || this.sessionComment) this.liveStep = undefined;
      this.changed();
    }

    await this.flushQueue();
  }

  private activity(busy: boolean): void {
    try {
      this.onActivity?.(busy);
    } catch {
      /* non-fatal */
    }
  }

  /** Touch ACP activity every 30s so long tools/plan waits do not trip idle. */
  private startActivityHeartbeat(): void {
    this.stopActivityHeartbeat();
    this.activityHeartbeat = setInterval(() => {
      if (!this.busy || this.cancelled) return;
      this.acp.touchActivity(this.sessionId);
    }, 30_000);
    // Unref so this timer alone cannot keep the process alive on shutdown.
    this.activityHeartbeat.unref?.();
  }

  private stopActivityHeartbeat(): void {
    if (this.activityHeartbeat) {
      clearInterval(this.activityHeartbeat);
      this.activityHeartbeat = undefined;
    }
  }

  /**
   * Every 15s, if we know a live step (tool/subagent) and the bubble is quiet,
   * refresh that step with elapsed time. Never spam a bare "Still working" timer.
   */
  private startLivenessPulse(): void {
    this.stopLivenessPulse();
    this.livenessPulse = setInterval(() => {
      if (!this.busy || this.cancelled || !this.streamer || !this.foreground) return;
      if (!this.liveStep?.trim()) return;
      this.streamer.pulseLiveness(
        fmtDuration(Date.now() - this.turnPulseStartedAt),
        this.liveStep,
      );
    }, 15_000);
    this.livenessPulse.unref?.();
  }

  private stopLivenessPulse(): void {
    if (this.livenessPulse) {
      clearInterval(this.livenessPulse);
      this.livenessPulse = undefined;
    }
  }

  /**
   * Parse telegram JSON actions from the assistant reply, execute them, notify
   * the user, and queue a results follow-up for the agent when useful.
   * Returns true when a results prompt was queued (delay Done/recheck).
   */
  private async processTelegramBridgeActions(): Promise<boolean> {
    const { actions, cleaned } = extractTelegramActions(this.turnAssistantText);
    if (cleaned !== this.turnAssistantText) {
      this.turnAssistantText = cleaned;
    }
    if (actions.length === 0) return false;
    if (!this.bridge) {
      log.warn(`chat ${this.chatId}: telegram actions present but bridge not wired`);
      return false;
    }

    const botCmds = actions.filter((a) => a.action === "bot_command");
    // bot_command means Grok ended its turn early to wait on a sibling bot —
    // this is NOT a Done. Keep busy; status panel live-step only (no chat spam).
    if (botCmds.length > 0) {
      const labels = botCmds
        .map((a) =>
          a.action === "bot_command" ? `@${a.bot} /${a.command}` : "",
        )
        .filter(Boolean)
        .join(", ");
      this.setLiveStep(`Waiting for sibling bot: ${labels}`);
    } else {
      this.setLiveStep("Running Telegram bridge actions\u2026");
    }
    this.changed();
    log.info(`chat ${this.chatId}: executing ${actions.length} telegram bridge action(s)`);

    const results = await executeTelegramActions(actions, {
      api: this.api,
      cfg: this.cfg,
      chatId: this.chatId,
      messageThreadId: this.messageThreadId,
      replyToMessageId: this.turnReplyTo,
      forum: this.bridge.forum,
      store: this.bridge.store,
      bots: this.bridge.bots,
      submitTopicPrompt: this.bridge.submitTopicPrompt,
      managerMode: this.managerMode,
      managerUserAskPreview: this.suggestionUserText || cleanUserPreview(this.turnUserText, 400),
    });

    // Count successful notify actions (General user-facing channel).
    // Drop the Thinking… placeholder once a real notify is out.
    for (const r of results) {
      if (r.action === "notify" && r.ok) {
        this.managerNotifyCount++;
        this.managerUserVisible = true;
        if (this.managerStatusMsgId !== undefined) {
          const sid = this.managerStatusMsgId;
          this.managerStatusMsgId = undefined;
          void this.deleteManagerStatus(sid);
        }
        const mid = (r.data as { messageId?: number } | undefined)?.messageId;
        if (mid !== undefined && this.sessionId) {
          this.onTelegramMessageBound?.(mid, this.sessionId);
        }
      }
    }

    // Only announce durable side-effects in chat (topic create/bind/cross-prompt).
    // Manager mode stays quiet — use notify for user text; no auto notes.
    // search_memory / list_* / bot wait status stay silent — results go to the agent.
    const durableActions = new Set(["create_topic", "set_path", "send_prompt"]);
    const notes = results
      .filter((r) => durableActions.has(r.action) && r.userNote?.trim())
      .map((r) => r.userNote!)
      .filter(Boolean);
    if (notes.length > 0 && this.foreground && !this.managerMode) {
      await this.notify(notes.join("\n"), {
        loud: true,
        replyTo: this.turnReplyTo,
      });
    }

    // Cap chained result turns so a model that re-emits list_bots forever cannot
    // block Done. Side-effects already ran; user notes were sent above.
    // Still queue once when we have bot_command errors so the agent can recover.
    if (this.bridgeResultDepth >= SessionRuntime.BRIDGE_CHAIN_MAX) {
      log.warn(
        `chat ${this.chatId}: telegram bridge chain depth ${this.bridgeResultDepth} — not re-queuing results`,
      );
      return false;
    }

    // Feed results back so the agent can use search hits / bot replies / errors.
    const prompt = buildTelegramBridgeResultsPrompt(
      results.map((r) => ({
        action: r.action,
        ok: r.ok,
        data: r.data,
        error: r.error,
      })),
    );
    this.bridgeResultDepth++;
    this.queue.unshift(
      textPrompt(prompt, this.turnReplyTo, undefined, {
        skipSelfRecheck: true,
        promptId: this.turnPromptId,
      }),
    );
    this.setLiveStep("Feeding sibling-bot / bridge results to the agent\u2026");
    this.changed();
    return true;
  }

  /**
   * Quietly ask for 1–3 follow-ups, attach buttons to the Done text, store them
   * for switch-replay, and optionally queue auto-approved items as **one**
   * numbered multi-step prompt (`1) …\n2) …`).
   */
  private async collectAndApplySuggestions(
    doneText: string,
    switchKb: InlineKeyboard | undefined,
    opts?: { autoQueue?: boolean },
  ): Promise<{ text: string; markup?: InlineKeyboard; suggestions?: Suggestion[] }> {
    if (!this.cfg.suggestionsEnabled || !this.sessionId) {
      return { text: doneText, markup: switchKb };
    }
    let suggestions: Suggestion[] = [];
    try {
      suggestions = await this.fetchSuggestionsQuiet();
    } catch (e) {
      log.debug(`suggestions fetch failed: ${(e as Error).message}`);
    }
    // Manager: keep 1–4 short follow-ups only.
    if (this.managerMode) suggestions = suggestions.slice(0, 4);
    if (suggestions.length === 0) return { text: doneText, markup: switchKb };

    const batchId = ++this.suggestionBatchSeq;
    this.suggestionBatches.set(batchId, suggestions);
    // Bound memory: keep last ~20 batches.
    if (this.suggestionBatches.size > 20) {
      const oldest = [...this.suggestionBatches.keys()].sort((a, b) => a - b)[0]!;
      this.suggestionBatches.delete(oldest);
    }

    const thr = this.cfg.suggestionsAutoApprovePct;
    const autoQueue = opts?.autoQueue !== false;
    const auto = autoQueue ? autoApproveSuggestions(suggestions, thr) : [];
    let text = doneText;
    let banner: string;
    if (auto.length > 0) {
      const batched = formatBatchedSuggestionsPrompt(auto);
      // Hard, visible auto-approve block (especially for General chat).
      const lines = auto.map((s) => `\u2022 ${s.text}`);
      const autoBlock =
        `\n\n\u2705 Auto Approved:\n${lines.join("\n")}` +
        (this.managerMode ? "" : `\n(need \u2265 ${thr}%)`);
      text += autoBlock;
      banner = `\u2705 Auto Approved:\n${lines.join("\n")}`;
      // Single queue entry — agent executes 1) 2) 3) in one turn.
      // skipSelfRecheck: auto-follow-ups must not arm another recheck cycle.
      this.queue.push(
        textPrompt(batched, this.turnReplyTo, undefined, {
          skipSelfRecheck: true,
          promptId: this.turnPromptId,
        }),
      );
      this.changed();
    } else {
      text += this.managerMode
        ? "\n\nTap a suggestion to continue:"
        : "\n\n\u{1F4A1} Suggestions \u2014 tap one to continue:";
      banner = "\u{1F4A1} Suggestions \u2014 tap one to continue:";
    }

    // Keep for switch-to-session replay (and for Done pings that already include
    // the same keyboard). Cleared when a new turn starts.
    this.pendingSuggestions = { batchId, suggestions, banner };

    // Keyboard: show remaining (non-auto) suggestions; if all auto, no buttons.
    const remaining = suggestions.filter((s) => !auto.some((a) => a.text === s.text));
    const markup =
      remaining.length > 0
        ? suggestionsKeyboard(batchId, remaining, switchKb)
        : switchKb;
    return { text, markup, suggestions };
  }

  /** Post General status bubble (Starting… / Thinking…) — streamer edits it later. */
  private async postManagerStatus(
    replyTo: number,
    text: string,
  ): Promise<number | undefined> {
    try {
      const extra: Record<string, unknown> = {
        disable_notification: true,
        ...outboundThreadExtra(this.messageThreadId),
        reply_parameters: {
          message_id: replyTo,
          allow_sending_without_reply: true,
        },
      };
      const msg = await this.api.sendMessage(this.chatId, text, extra);
      return msg.message_id;
    } catch (e) {
      log.debug(`manager status "${text}" failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async editManagerStatus(messageId: number, text: string): Promise<void> {
    try {
      await this.api.editMessageText(this.chatId, messageId, text);
    } catch (e) {
      log.debug(`manager status edit failed: ${(e as Error).message}`);
    }
  }

  private async deleteManagerStatus(messageId: number): Promise<void> {
    try {
      await this.api.deleteMessage(this.chatId, messageId);
    } catch (e) {
      log.debug(`manager status delete failed: ${(e as Error).message}`);
    }
  }

  /** Surface a short important error in General; clear Thinking… bubble. */
  private async finishManagerError(errorMessage: string, startedAt: number): Promise<void> {
    const elapsed = fmtDuration(Date.now() - startedAt);
    const short =
      errorMessage.length > 280 ? errorMessage.slice(0, 277) + "\u2026" : errorMessage;
    const text = `\u274C ${short} \u00B7 ${elapsed}`;
    this.lastCompletion = text;
    if (this.managerStatusMsgId !== undefined) {
      await this.editManagerStatus(this.managerStatusMsgId, text);
      this.managerUserVisible = true;
      if (this.sessionId) this.onTelegramMessageBound?.(this.managerStatusMsgId, this.sessionId);
      this.managerStatusMsgId = undefined;
      return;
    }
    if (this.turnReplyTo !== undefined) {
      const id = await this.notify(text, { loud: true, replyTo: this.turnReplyTo });
      if (id !== undefined) this.managerUserVisible = true;
    }
  }

  /**
   * General quiet completion:
   * - if notify already sent → drop Thinking… bubble
   * - else if direct user ask and clean prose → one short fallback message
   * - else → delete Thinking… and stay silent
   */
  private async finishManagerUserFacing(
    metaTurn: boolean,
    stopReason: string | undefined,
    startedAt: number,
  ): Promise<void> {
    const elapsed = fmtDuration(Date.now() - startedAt);
    if (this.cancelled || stopReason === "cancelled") {
      this.lastCompletion = `\u23F9 Stopped \u00B7 ${elapsed}`;
      // Only surface cancel if user was waiting on a visible bubble.
      if (this.managerStatusMsgId !== undefined && !metaTurn) {
        await this.editManagerStatus(this.managerStatusMsgId, this.lastCompletion);
        this.managerUserVisible = true;
      } else if (this.managerStatusMsgId !== undefined) {
        await this.deleteManagerStatus(this.managerStatusMsgId);
      }
      this.managerStatusMsgId = undefined;
      return;
    }

    if (this.managerNotifyCount > 0) {
      this.lastCompletion =
        cleanManagerVisibleText(this.turnAssistantText).slice(0, 500) ||
        `\u2705 Done \u00B7 ${elapsed}`;
      if (this.managerStatusMsgId !== undefined) {
        await this.deleteManagerStatus(this.managerStatusMsgId);
        this.managerStatusMsgId = undefined;
      }
      return;
    }

    // Meta / bridge / work-report turns: silent unless cancelled (handled above).
    if (metaTurn) {
      this.lastCompletion = `\u2705 Done \u00B7 ${elapsed}`;
      if (this.managerStatusMsgId !== undefined) {
        await this.deleteManagerStatus(this.managerStatusMsgId);
        this.managerStatusMsgId = undefined;
      }
      return;
    }

    // Direct user ask: optional single fallback if model forgot notify.
    const cleaned = cleanManagerVisibleText(this.turnAssistantText);
    const fallback = pickManagerFallbackText(cleaned);
    if (fallback && this.managerStatusMsgId !== undefined) {
      await this.editManagerStatus(this.managerStatusMsgId, fallback);
      this.managerUserVisible = true;
      this.lastCompletion = fallback.slice(0, 500);
      if (this.sessionId) this.onTelegramMessageBound?.(this.managerStatusMsgId, this.sessionId);
      this.managerStatusMsgId = undefined;
      return;
    }
    if (fallback && this.turnReplyTo !== undefined) {
      const id = await this.notify(fallback, {
        loud: false,
        replyTo: this.turnReplyTo,
      });
      if (id !== undefined) {
        this.managerUserVisible = true;
        this.lastCompletion = fallback.slice(0, 500);
        if (this.sessionId) this.onTelegramMessageBound?.(id, this.sessionId);
      }
    } else {
      this.lastCompletion = `\u2705 Done \u00B7 ${elapsed}`;
    }
    if (this.managerStatusMsgId !== undefined) {
      await this.deleteManagerStatus(this.managerStatusMsgId);
      this.managerStatusMsgId = undefined;
    }
  }

  /**
   * Decide whether to queue a self-recheck turn.
   * - Hard skip when no files were modified this turn.
   * - Quiet AI decision: refuse (simple / not needed) or write recheck prompt.
   * - Returns the full recheck turn text, or undefined to skip.
   */
  private async maybePlanSelfRecheck(): Promise<string | undefined> {
    if (this.fileOps.size === 0) {
      log.info(`chat ${this.chatId}: self-recheck skipped (no files modified)`);
      return undefined;
    }
    if (this.cancelled) return undefined;
    const user =
      this.suggestionUserText ||
      stripDirectiveWrappers(this.turnUserText) ||
      this.turnUserText;
    const did = this.turnAssistantText;
    const files = summarizeFileOpsShort(this.fileOps);

    let decision;
    try {
      decision = await this.fetchSelfRecheckDecisionQuiet(user, did, files);
    } catch (e) {
      log.debug(`self-recheck decision failed: ${(e as Error).message}; skipping`);
      return undefined;
    }
    if (this.cancelled) return undefined;
    if (!decision.needed) {
      log.info(
        `chat ${this.chatId}: self-recheck skipped by agent` +
          (decision.reason ? ` (${decision.reason})` : ""),
      );
      return undefined;
    }

    // Optional env template overrides the AI-written body when set.
    if (this.cfg.selfRecheckPrompt) {
      return buildSelfRecheckPrompt(user, did, this.cfg.selfRecheckPrompt);
    }
    if (decision.prompt.trim()) {
      return composeSelfRecheckTurn(decision.prompt, user, did);
    }
    // needed=true but empty prompt — fall back to built-in default template.
    return buildSelfRecheckPrompt(user, did);
  }

  /** Quiet JSON: should we recheck, and if so what prompt? Never streams. */
  private async fetchSelfRecheckDecisionQuiet(
    user: string,
    did: string,
    filesSummary: string,
  ): Promise<ReturnType<typeof parseSelfRecheckDecision>> {
    if (!this.sessionId) return { needed: false, reason: "no session" };
    const prompt = buildSelfRecheckDecisionPrompt(user, did, filesSummary);
    try {
      const raw = await this.runQuietPrompt(prompt);
      return parseSelfRecheckDecision(raw);
    } catch (e) {
      log.debug(`self-recheck decision quiet prompt failed: ${(e as Error).message}`);
      return { needed: false, reason: "decision prompt failed" };
    }
  }

  /** Quiet JSON suggestion turn — never streams to Telegram. */
  private async fetchSuggestionsQuiet(): Promise<Suggestion[]> {
    if (!this.sessionId) return [];
    // Prefer the original user ask (before self-recheck) so need scores stay honest.
    const user =
      this.suggestionUserText ||
      stripDirectiveWrappers(this.turnUserText) ||
      this.turnUserText;
    const didParts = [this.preRecheckAssistantText, this.turnAssistantText].filter((s) => s?.trim());
    const did = didParts.join("\n") || this.turnAssistantText;
    const prompt = buildSuggestionsPrompt(user, did);
    try {
      const raw = await this.runQuietPrompt(prompt);
      return parseSuggestions(raw);
    } catch (e) {
      log.debug(`suggestions quiet prompt failed: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Run a quiet meta ACP prompt (JSON only) with a hard timeout.
   * On timeout: session/cancel so the shared agent is not stuck holding the
   * session (which would block Done forever). Does NOT set this.cancelled
   * (user /stop is separate). Timed-out / partial capture is discarded.
   */
  private async runQuietPrompt(text: string): Promise<string> {
    if (!this.sessionId) return "";
    const ms = Math.max(5_000, this.cfg.quietPromptTimeoutMs || 90_000);
    this.capturingQuiet = true;
    this.quietCaptureBuf = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      // Ignore timer if the prompt already settled (avoids discarding a good JSON
      // reply that finished in the same tick as the timeout).
      if (settled) return;
      timedOut = true;
      log.warn(
        `chat ${this.chatId}: quiet meta prompt timed out after ${ms}ms — cancelling session prompt`,
      );
      // Session-scoped cancel only — never kill the shared agent process.
      void this.acp.cancel(this.sessionId!);
    }, ms);
    let buf = "";
    try {
      await this.acp.prompt(this.sessionId, [{ type: "text", text }]);
      settled = true;
      clearTimeout(timer);
      buf = this.quietCaptureBuf;
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      buf = this.quietCaptureBuf;
      if (!timedOut) throw e;
      log.debug(`quiet prompt ended after timeout: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      this.capturingQuiet = false;
      this.quietCaptureBuf = "";
    }
    // Timed-out meta replies are often half-JSON — skip rather than act on garbage.
    // If we settled successfully before the timer fired, timedOut stays false.
    if (timedOut) return "";
    return buf;
  }

  /** Resolve a tapped suggestion button; returns the prompt text or undefined. */
  takeSuggestion(batchId: number, index: number): string | undefined {
    const batch = this.suggestionBatches.get(batchId);
    if (!batch) return undefined;
    const s = batch[index];
    if (!s) return undefined;
    return s.text;
  }

  /** Attribute a finished turn's credits/context to the active saved account. */
  private recordAccountUsage(): void {
    const meta = this.contextInfo();
    // Grok's metadata credits are typically a running session total — store the
    // per-turn delta so /accounts totals stay accurate across many turns.
    let turnCredits: number | undefined;
    if (typeof meta?.credits === "number" && Number.isFinite(meta.credits)) {
      const delta = meta.credits - this.lastReportedCredits;
      turnCredits = delta > 0 ? delta : meta.credits > 0 && this.lastReportedCredits === 0 ? meta.credits : undefined;
      if (meta.credits >= this.lastReportedCredits) this.lastReportedCredits = meta.credits;
      else this.lastReportedCredits = meta.credits; // reset if agent restarted counters
    }
    try {
      this.accountRotator?.recordTurnUsage({
        credits: turnCredits,
        contextPct: meta?.contextUsagePercentage,
      });
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Show subagent ("crew") status transitions for the given (already
   * chat-attributed) subagents, so the user sees progress while the main agent
   * waits on them. No-op unless this runtime is the live foreground turn.
   */
  renderSubagents(subagents: SubagentInfo[], pending: PendingStage[]): void {
    if (!this.cfg.showSubagents) return;
    if (!this.busy) return;
    // Keep parent idle-watch warm while crew is active (even if no new cards).
    this.acp.touchActivity(this.sessionId);
    for (const s of subagents) this.ownedSubagentIds.add(s.sessionId);
    const summary = subagentSummary(subagents, pending);
    if (summary) this.setLiveStep(summary);
    if (!this.foreground || !this.streamer) return;
    for (const s of subagents) {
      const key = statusKey(s);
      const prev = this.subagentShown.get(s.sessionId);
      if (prev === key) continue;
      const kind: "start" | "status" = prev === undefined && isActiveStatus(key) ? "start" : "status";
      this.subagentShown.set(s.sessionId, key);
      const md = renderSubagentTransition(s, kind);
      if (md) this.streamer.addTool(md);
    }
    // Ensure pulse has a surface even if no status transition this tick.
    void this.streamer.ensureLiveSurface("\u23F3 Working\u2026").catch(() => {});
  }

  /**
   * Mirror a child subagent's ACP session/update into this parent turn's
   * Telegram stream so long crew waits are not a blank "Still working".
   */
  private mirrorSubagentUpdate(childId: string, update: SessionUpdate): void {
    this.acp.touchActivity(this.sessionId);
    if (!this.foreground || !this.streamer || !this.cfg.showSubagents) return;

    const info = this.acp.subagentById(childId);
    const label = info ? subagentLabel(info) : childId.slice(0, 8);
    const kind = update.sessionUpdate;

    if (kind === "agent_thought_chunk") {
      const text = contentText(update.content)?.replace(/\s+/g, " ").trim();
      if (!text) return;
      this.setLiveStep(`\u{1F916} ${label}: ${text.length > 110 ? text.slice(0, 109) + "\u2026" : text}`);
      const now = Date.now();
      const last = this.subagentThinkPulse.get(childId) ?? 0;
      if (now - last < 1500) return;
      this.subagentThinkPulse.set(childId, now);
      const snippet = text.length > 500 ? `${text.slice(0, 499)}\u2026` : text;
      this.streamer.upsertTool(
        `sub:${childId}:think`,
        `\u{1F916} **${label}** thinking\n> ${snippet.replace(/\n/g, "\n> ")}`,
      );
      return;
    }

    if (kind === "agent_message_chunk") {
      const text = contentText(update.content)?.replace(/\s+/g, " ").trim();
      if (!text) return;
      this.setLiveStep(`\u{1F916} ${label}: ${text.length > 110 ? text.slice(0, 109) + "\u2026" : text}`);
      return;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      if (!this.cfg.showToolCalls) return;
      const tid = update.toolCallId || "";
      const cacheKey = `${childId}:${tid || update.title || "tool"}`;
      const merged = mergeToolSnapshot(this.subagentToolCache.get(cacheKey), update);
      this.subagentToolCache.set(cacheKey, merged);
      const status = (update.status || "").toLowerCase();
      if (!snapshotHasDetail(merged) && status !== "completed" && status !== "failed") return;
      if (kind === "tool_call_update" && (status === "pending" || status === "in_progress")) {
        const hasNew =
          (Array.isArray(update.content_blocks) && update.content_blocks.length > 0) ||
          (Array.isArray(update.content) && (update.content as unknown[]).length > 0) ||
          (!!update.rawInput && Object.keys(update.rawInput).length > 0) ||
          update.rawOutput !== undefined;
        if (!hasNew && this.shownToolIds.has(`sub:${cacheKey}`)) return;
      }
      const md = formatToolCall(merged, {
        showDiffs: this.cfg.showEditDiffs,
        diffMaxLines: Math.min(40, this.cfg.diffMaxLines),
      });
      if (!md) return;
      this.shownToolIds.add(`sub:${cacheKey}`);
      const step = stepFromToolUpdate(merged);
      if (step) this.setLiveStep(`\u{1F916} ${label}: ${step}`);
      this.streamer.upsertTool(`sub:${cacheKey}`, `\u{1F916} **${label}**\n${md}`);
    }
  }

  /**
   * True when a prompt failure is attributable to an exhausted context window вЂ”
   * either the error message says so, or this session's last-known context
   * usage is at/above the configured fork threshold. Such failures won't clear
   * by retrying the same oversized prompt (throttling on a near-full session
   * surfaces as a plain "-32603 вЂ¦ throttled"), so the session must be compacted
   * by forking a fresh, smaller continuation.
   */
  private isContextRelatedFailure(error: Error): boolean {
    if (isContextExhaustedError(error)) return true;
    const threshold = this.cfg.autoForkContextPct;
    if (threshold <= 0) return false;
    const pct = this.contextInfo()?.contextUsagePercentage;
    return pct !== undefined && pct >= threshold;
  }

  /** A shared-process restart invalidates this runtime's ACP session binding,
   * but says nothing about account health. Wait for any account probe to
   * settle, re-bind/fork this chat on the selected account, and retry once. */
  private async maybeRecoverAgentSession(
    input: PromptInput,
    outcome: { result?: PromptResult; error?: Error; attempts: number },
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number } | undefined> {
    if (
      !outcome.error ||
      !isSessionLifecycleError(outcome.error) ||
      this.cancelled ||
      (this.streamer?.hasOutput ?? false)
    ) {
      return undefined;
    }
    try {
      await this.accountRotator?.waitForIdle();
      if (this.cancelled) return outcome;
      const previousId = this.sessionId;
      this.sessionLive = false;
      this.rebindPending = Boolean(previousId);
      await this.ensureSession();
      this.shownToolIds = new Set();
      this.subagentShown = new Map();
      this.streamer?.setFooter(this.hashtags());
      const retryContent = buildContentBlocks(input, {
        reasoning: reasoningDirective(this.reasoning),
        priming: this.primingContext,
        imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
        progress:
          !this.managerMode && this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
      });
      this.primingContext = undefined;
      log.info(
        `chat ${this.chatId} recovered lifecycle error on the active account` +
          (previousId && this.sessionId !== previousId
            ? ` with fresh session ${this.sessionId?.slice(0, 8)}`
            : " by re-binding its session"),
      );
      return this.runPromptWithRetries(retryContent);
    } catch (error) {
      log.warn(`chat ${this.chatId} session recovery failed: ${(error as Error).message}`);
      return { error: error as Error, attempts: outcome.attempts };
    }
  }

  /**
   * Auto-fork-on-error recovery. When a turn fails with a *transient* error (or
   * a context-exhaustion error) and nothing was streamed to the user, the
   * session is throttled / context-exhausted / stuck. We "logically fork" it:
   * open a fresh session in the same project primed with the recent transcript
   * (the old session is dropped from this chat), then retry the SAME message
   * once on the clean session. For context-exhausted sessions the retry backoff
   * is skipped upstream so this fires immediately. Returns the retried outcome,
   * or undefined when no fork was attempted.
   */
  private async maybeAutoFork(
    input: PromptInput,
    outcome: { result?: PromptResult; error?: Error; attempts: number },
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number } | undefined> {
    if (!this.cfg.autoForkOnError || !outcome.error || !this.sessionId) return undefined;
    if (this.cancelled || (this.streamer?.hasOutput ?? false)) return undefined;
    const contextRelated = this.isContextRelatedFailure(outcome.error);
    if (!isTransientError(outcome.error) && !contextRelated) return undefined;

    const lostId = this.sessionId;
    const transcript = recentTranscript(this.cfg.sessionsDir, lostId);
    if (this.foreground) {
      const reason = contextRelated
        ? "That session's context looks full \u2014 compacting into a fresh continuation and retrying"
        : "That session looks exhausted or stuck \u2014 forking a fresh continuation and retrying";
      await this.notify(
        `\u26A0\uFE0F ${outcome.error.message}\n\n\u{1F517} ${reason}${transcript ? " (primed with the recent transcript)" : ""}\u2026`,
        { replyTo: this.turnReplyTo },
      );
    }
    try {
      await this.bindNewSession(this.cwd, this.projectName); // new live id; old session dropped
    } catch (e) {
      log.warn(`auto-fork failed (agent down?): ${(e as Error).message}`);
      return undefined;
    }
    log.info(
      `chat ${this.chatId} auto-forked ${lostId.slice(0, 8)} -> ${this.sessionId!.slice(0, 8)} after ${contextRelated ? "context-exhaustion" : "transient"} error`,
    );
    // Reset per-turn render state so the retry streams cleanly on the new session.
    this.shownToolIds = new Set();
    this.subagentShown = new Map();
    this.streamer?.setFooter(this.hashtags()); // streamed reply tags the NEW session
    const forkContent = buildContentBlocks(input, {
      reasoning: reasoningDirective(this.reasoning),
      priming: transcript ? buildPriming(transcript) : undefined,
      imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
      progress:
          !this.managerMode && this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
    });
    return this.runPromptWithRetries(forkContent);
  }

  /**
   * Auto-rotate-on-give-up. When a turn has failed (retries exhausted / billing
   * 402 with no same-account retry, auto-fork didn't recover) and nothing was
   * streamed, cycle through the OTHER saved accounts once — each step:
   *   stop Grok CLI → replace ~/.grok/auth.json → start CLI + headless auth →
   *   open a fresh session → retry the same prompt.
   * The first account that succeeds wins and stays active; if every account
   * fails we stop with a combined error. Bounded to ONE pass (no infinite
   * loop). No-op unless the rotator is enabled and other accounts exist.
   *
   * Billing/quota failures (402 balance exhausted) skip backoff retries on
   * each account and rotate instantly so the turn continues without a long wait.
   */
  private async maybeRotateAccount(
    input: PromptInput,
    final: { result?: PromptResult; error?: Error; attempts: number },
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number } | undefined> {
    const rotator = this.accountRotator;
    if (!rotator?.enabled() || !final.error || this.cancelled) return undefined;
    if (isSessionLifecycleError(final.error)) return undefined;
    const originalError = final.error;
    const observed = rotator.state();
    return rotator.withRotationLock(observed, async (changed) => {
      if (this.cancelled) return final;
      if (changed) {
        if (this.streamer?.hasOutput ?? false) return undefined;
        const current = rotator.state();
        const transcript = this.sessionId ? recentTranscript(this.cfg.sessionsDir, this.sessionId) : undefined;
        if (this.foreground) {
          await this.notify(
            `\u{1F504} Reusing ${current.activeLabel ?? "the account selected by another chat"} with a fresh session…`,
            { replyTo: this.turnReplyTo },
          );
        }
        log.info(`chat ${this.chatId} reusing account generation ${current.generation} selected by another chat`);
        try {
          await this.bindNewSession(this.cwd, this.projectName);
        } catch (error) {
          return { error: error as Error, attempts: final.attempts };
        }
        this.shownToolIds = new Set();
        this.subagentShown = new Map();
        this.streamer?.setFooter(this.hashtags());
        const content = buildContentBlocks(input, {
          reasoning: reasoningDirective(this.reasoning),
          priming: transcript ? buildPriming(transcript) : undefined,
          imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
          progress:
          !this.managerMode && this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
        });
        return this.runPromptWithRetries(content);
      }
    // A quota-exhausted or access-denied response cannot be recovered by retrying
    // this login. Quarantine it before choosing targets, so later rotations do not
    // cycle back to a known-bad account. This intentionally happens before the
    // partial-stream guard: we must not retry/rotate a partial reply, but its
    // account still needs to be skipped during a future rotation.
    if (isAccountRotationError(originalError)) {
      await rotator.markFailed(observed.activeId, originalError.message);
    }
    if (this.streamer?.hasOutput ?? false) return undefined;
    const targets = await rotator.targets().catch(() => [] as { id: string; label: string }[]);
    if (targets.length === 0) return undefined;

    const transcript = this.sessionId ? recentTranscript(this.cfg.sessionsDir, this.sessionId) : undefined;
    const errors: string[] = [`\u2022 previous: ${originalError.message}`];
    let last = final;

    for (const t of targets) {
      if (this.cancelled) return last;
      const failReason = last.error ?? originalError;
      if (this.foreground) {
        await this.notify(formatAccountSwitchNotice(t.label, failReason), { replyTo: this.turnReplyTo });
      }
      try {
        // stop CLI → swap auth.json → start CLI + authenticate(cached_token)
        await rotator.activate(t.id);
      } catch (e) {
        errors.push(`\u2022 ${t.label}: couldn't switch \u2014 ${(e as Error).message}`);
        continue;
      }
      try {
        await this.bindNewSession(this.cwd, this.projectName); // fresh session on the new login
      } catch (e) {
        errors.push(`\u2022 ${t.label}: no session \u2014 ${(e as Error).message}`);
        continue;
      }
      // Reset per-turn render state so the retry streams cleanly.
      this.shownToolIds = new Set();
      this.subagentShown = new Map();
      this.streamer?.setFooter(this.hashtags());
      const content = buildContentBlocks(input, {
        reasoning: reasoningDirective(this.reasoning),
        priming: transcript ? buildPriming(transcript) : undefined,
        imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
      progress:
          !this.managerMode && this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
      });
      log.info(
        `chat ${this.chatId} auto-rotating to account ${t.label}` +
          (isAccountRotationError(failReason) ? " (previous account unavailable)" : ""),
      );
      // runPromptWithRetries already skips backoff for 402 / balance exhausted.
      last = await this.runPromptWithRetries(content);
      if (last.result && !this.cancelled) {
        if (this.foreground) {
          await this.notify(`\u2705 Recovered on ${t.label}.`, { replyTo: this.turnReplyTo });
        }
        return last;
      }
      if (last.error && isAccountRotationError(last.error)) {
        await rotator.markFailed(t.id, last.error.message);
      }
      if (this.cancelled || (this.streamer?.hasOutput ?? false)) return last;
      errors.push(`\u2022 ${t.label}: ${last.error?.message ?? "failed"}`);
    }

    // One full cycle done and still failing — stop with a combined report.
    const combined = new Error(`Tried ${targets.length + 1} account(s), all failed:\n${errors.join("\n")}`);
    return { error: combined, attempts: last.attempts };
    });
  }

  /**
   * Run the prompt, retrying *transient* agent errors (e.g. "high volume of
   * traffic" / -32603) with an exponential backoff (6s в†’ 12s в†’ 24s в†’ 48s в†’ 60s,
   * then give up). The real error is shown to the user on every failed attempt.
   *
   * We only retry while the turn has produced **no streamed output** (so tools
   * aren't re-run and text isn't duplicated) and the user hasn't cancelled.
   * Returns the result, or the last error once retries are exhausted.
   */
  private async runPromptWithRetries(
    content: ContentBlock[],
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number }> {
    const delays = this.cfg.promptRetryAttempts > 0 ? backoffSchedule(this.cfg.promptRetryAttempts) : [];
    const totalAttempts = delays.length + 1;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const updatesBeforePrompt = this.sessionUpdateCount;
        const result = await this.acp.prompt(this.sessionId!, content);
        // User /stop force-complete or agent honouring session/cancel often
        // returns cancelled with zero session/update chunks — that is success.
        if (this.cancelled || result?.stopReason === "cancelled") {
          return { result: result ?? { stopReason: "cancelled" }, attempts: attempt };
        }
        // A healthy ACP turn emits at least one session/update (text, thought,
        // or tool event) before resolving session/prompt. Grok can otherwise
        // report a successful end-turn after an upstream model failure; never
        // present that as a completed user request.
        await sleep(0);
        if (this.sessionUpdateCount === updatesBeforePrompt) {
          throw new Error("Empty agent response — Grok ended the turn without any output or tool activity");
        }
        return { result, attempts: attempt };
      } catch (err) {
        const error = err as Error;
        const canRecover = !this.cancelled && !(this.streamer?.hasOutput ?? false);
        // A context-exhausted session won't recover by retrying the same
        // oversized prompt — skip the backoff and let auto-fork compact it now.
        const forkInstead = canRecover && this.cfg.autoForkOnError && this.isContextRelatedFailure(error);
        // Billing/quota 402 (balance exhausted) is permanent for this login —
        // never backoff-retry; surface immediately so auto-rotate can switch.
        const willRetry =
          attempt <= delays.length &&
          canRecover &&
          !forkInstead &&
          !isAccountRotationError(error) &&
          isTransientError(error);
        if (!willRetry) return { error, attempts: attempt };
        const waitMs = delays[attempt - 1]!;
        if (this.foreground) {
          await this.notify(formatRetryNotice(error, attempt + 1, totalAttempts, waitMs), {
            replyTo: this.turnReplyTo,
          });
        }
        if (await this.interruptibleSleep(waitMs)) return { error, attempts: attempt };
      }
    }
  }

  /** Sleep that returns true early if the user cancels the turn meanwhile. */
  private async interruptibleSleep(ms: number): Promise<boolean> {
    const step = 500;
    for (let waited = 0; waited < ms; waited += step) {
      if (this.cancelled) return true;
      await sleep(Math.min(step, ms - waited));
    }
    return this.cancelled;
  }

  /**
   * Recover from a transient error (throttle / internal error / dropped
   * response stream) that struck AFTER the turn already started streaming.
   *
   * The pre-stream paths (retry / auto-fork / account-rotate) all bail once any
   * output exists, because re-sending the original prompt would re-execute the
   * tools that already ran (duplicate/destructive side effects). Instead we ask
   * the SAME session to CONTINUE from where it stopped вЂ” its partial reply and
   * any completed tool results are already in history, so nothing is repeated вЂ”
   * using the same exponential backoff so a throttle has time to clear. The
   * open streamer keeps appending, so the reply is completed in place.
   *
   * Returns the recovered outcome, or `undefined` when this path doesn't apply
   * (feature off, no error, cancelled, nothing streamed, or non-transient).
   */
  private async maybeResumeAfterStream(
    final: { result?: PromptResult; error?: Error; attempts: number },
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number } | undefined> {
    if (!this.cfg.resumeOnStreamError || !final.error || this.cancelled || !this.sessionId) return undefined;
    // Only for the post-stream case; the pre-stream paths own the rest.
    if (!(this.streamer?.hasOutput ?? false)) return undefined;
    if (!isTransientError(final.error)) return undefined;
    // A context-full session won't recover by continuing (it'll just throttle
    // again each attempt) вЂ” don't burn the backoff; surface the error so the
    // user can fork/compact. Resume targets transient throttles on a session
    // that still has headroom.
    if (this.isContextRelatedFailure(final.error)) return undefined;

    const sessionId = this.sessionId;
    const delays = this.cfg.promptRetryAttempts > 0 ? backoffSchedule(this.cfg.promptRetryAttempts) : [RETRY_BASE_MS];
    const resumeContent = buildContentBlocks(textPrompt(RESUME_INSTRUCTION), {
      reasoning: reasoningDirective(this.reasoning),
      imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
      progress:
          !this.managerMode && this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
    });

    let last = final;
    let attempts = final.attempts;
    for (let i = 0; i < delays.length; i++) {
      if (this.cancelled) return last;
      const waitMs = delays[i]!;
      if (this.foreground) {
        await this.notify(
          `\u26A0\uFE0F ${last.error!.message}\n\n\u{1F501} The reply was cut off mid-stream \u2014 resuming in ${fmtSeconds(waitMs)} (attempt ${i + 1} of ${delays.length})\u2026`,
          { replyTo: this.turnReplyTo },
        );
      }
      if (await this.interruptibleSleep(waitMs)) return last;
      attempts++; // this resume prompt is one more attempt for the turn
      try {
        const result = await this.acp.prompt(sessionId, resumeContent);
        log.info(`chat ${this.chatId} resumed after mid-stream ${last.error!.message.slice(0, 40)} (attempt ${i + 1})`);
        return { result, attempts };
      } catch (err) {
        last = { error: err as Error, attempts };
        // If the follow-up fails for a NON-transient reason, stop early.
        if (!isTransientError(last.error!)) return last;
      }
    }
    return last;
  }

  /** Send any fresh images the agent produced this turn (Imagine, screenshots…). */
  private async sendTurnImages(): Promise<void> {
    if (!this.cfg.sendAgentImages) return;
    // Always check session images/ + assets/ even when the agent never named a
    // path in text — image_gen writes under ~/.grok/sessions/.../images/.
    const paths = collectTurnImagePaths({
      scanText: this.imageScanText,
      cwd: this.cwd,
      sessionId: this.sessionId,
      since: this.turnStartedAt,
    });
    if (paths.length === 0) return;
    try {
      const n = await sendImages(this.api, this.chatId, paths, {
        since: this.turnStartedAt,
        already: this.sentImagesThisTurn,
        max: this.cfg.agentImagesMax,
        replyTo: this.turnReplyTo,
        messageThreadId: this.messageThreadId,
      });
      if (n > 0) log.info(`chat ${this.chatId}: sent ${n} agent image file(s)`);
    } catch {
      /* non-fatal */
    }
  }

  /** Build the "turn finished" message and record `lastCompletion` (the full
   *  in-session version with the file list). Foreground gets the full version;
   *  a background turn gets a labelled "other session" ping with short counts. */
  private completionMessage(stopReason: string | undefined, startedAt: number, streamedOutput: boolean): string {
    const head = this.doneHead(stopReason, startedAt, streamedOutput);
    const tags = this.hashtags();
    const base = `${head}\n${summarizeFileOps(this.fileOps, this.cwd)}`;
    this.lastCompletion = `${base}\n\n${tags}`; // switch-replay stays searchable
    if (this.foreground) {
      // The streamed response already carries the tag footer; only add tags to
      // the Done line when there was no response to tag (tool-only / no output).
      return streamedOutput ? base : `${base}\n\n${tags}`;
    }
    return `\u{1F4E8} From other session ${this.sessionTag()}\n${head}\n${summarizeFileOpsShort(this.fileOps)}\n\n${tags}`;
  }

  /** Soft completion for General manager (no file-ops / progress spam). */
  private managerCompletionMessage(
    stopReason: string | undefined,
    startedAt: number,
    streamedOutput: boolean,
  ): string {
    const elapsed = fmtDuration(Date.now() - startedAt);
    if (this.cancelled || stopReason === "cancelled") {
      const msg = `\u23F9 Stopped \u00B7 ${elapsed}`;
      this.lastCompletion = msg;
      return streamedOutput ? "" : msg;
    }
    // When prose already streamed, no extra Done line (chat-like).
    if (streamedOutput) {
      this.lastCompletion = this.turnAssistantText.slice(0, 800) || `\u2705 Done \u00B7 ${elapsed}`;
      return "";
    }
    const msg = `\u2705 Done \u00B7 ${elapsed}`;
    this.lastCompletion = msg;
    return msg;
  }

  /**
   * True when the next queued prompt is a continuation of the *same* manager
   * job (self-recheck / bridge results / suggestion batch), not a new user
   * ask or a different send_prompt dispatch.
   */
  private queueIsSameJobContinuation(jobId: string): boolean {
    if (this.queue.length === 0) return false;
    const next = this.queue[0]!;
    if (next.reportBack && next.reportBack.jobId !== jobId) return false;
    if (next.reportBack && next.reportBack.jobId === jobId) return true;
    // Meta continuations omit reportBack but keep the open job.
    return (
      !!next.skipSelfRecheck ||
      isSelfRecheckPrompt(next.text) ||
      isTelegramBridgeResultsPrompt(next.text) ||
      isManagerWorkReportPrompt(next.text)
    );
  }

  /**
   * If this runtime was dispatched from General, wake the manager with a
   * structured WORK REPORT once for this job. Waits only for same-job meta
   * follow-ups; reports immediately when a different dispatch/user turn is next.
   */
  private async maybeReportBackToManager(opts: {
    ok: boolean;
    cancelled: boolean;
    stopReason?: string;
    error?: string;
  }): Promise<void> {
    const meta = this.pendingReportBack;
    if (!meta || !this.bridge?.wakeManager) return;
    // Same-job recheck / bridge results / suggestions still pending — wait.
    if (this.queueIsSameJobContinuation(meta.jobId)) return;

    const status = opts.cancelled ? "cancelled" : opts.ok ? "done" : "failed";
    const assistantSummary = (
      this.turnAssistantText.trim() ||
      this.lastCompletion ||
      "(no assistant text)"
    ).replace(/\s+/g, " ").trim();
    const filesSummary =
      this.fileOps.size > 0 ? summarizeFileOpsShort(this.fileOps) : undefined;

    updateManagerJob(meta.jobId, {
      status: status === "done" ? "done" : status === "cancelled" ? "cancelled" : "failed",
      resultSummary: assistantSummary.slice(0, 400),
      childSessionId: this.sessionId,
    });

    const prompt = buildManagerWorkReportPrompt({
      jobId: meta.jobId,
      targetName: meta.targetName || this.projectName || basename(this.cwd),
      targetThreadId: this.messageThreadId ?? 0,
      targetPath: meta.targetPath || this.cwd,
      userAskPreview: meta.userAskPreview,
      dispatchPromptPreview: meta.dispatchPrompt,
      status,
      stopReason: opts.stopReason,
      error: opts.error,
      assistantSummary,
      filesSummary,
      childSessionId: this.sessionId,
    });

    // Clear before await so a re-entry cannot double-report this job.
    this.pendingReportBack = undefined;
    try {
      await this.bridge.wakeManager({
        originChatId: meta.originChatId,
        originThreadId: meta.originThreadId,
        prompt,
      });
      log.info(
        `report-back job ${meta.jobId} → general (#${meta.originThreadId}) status=${status}`,
      );
    } catch (e) {
      log.warn(`report-back failed for job ${meta.jobId}: ${(e as Error).message}`);
      // Restore so a later turn might retry once if still attached.
      this.pendingReportBack = meta;
    }
  }

  /**
   * Final Done after a self-recheck: head + split file lists (first turn vs recheck).
   */
  private completionMessageSplit(
    stopReason: string | undefined,
    startedAt: number,
    streamedOutput: boolean,
  ): string {
    const head = this.doneHead(stopReason, startedAt, streamedOutput);
    const tags = this.hashtags();
    const files = summarizeFileOpsSplit(this.preRecheckFileOps, this.fileOps, this.cwd);
    const base = `${head}\n${files}`;
    this.lastCompletion = `${base}\n\n${tags}`;
    if (this.foreground) {
      return streamedOutput ? base : `${base}\n\n${tags}`;
    }
    return (
      `\u{1F4E8} From other session ${this.sessionTag()}\n${head}\n` +
      `${summarizeFileOpsShort(this.preRecheckFileOps)} \u2192 recheck ${summarizeFileOpsShort(this.fileOps)}\n\n${tags}`
    );
  }

  /** The compact one-line status of a finished turn (no "end_turn" noise). */
  private doneHead(stopReason: string | undefined, startedAt: number, streamedOutput: boolean): string {
    const elapsed = fmtDuration(Date.now() - startedAt);
    if (this.cancelled || stopReason === "cancelled") return `\u23F9 Stopped \u00B7 ${elapsed}`;
    const reason = stopReason && stopReason !== "end_turn" ? ` \u00B7 ${stopReason}` : "";
    const meta = this.contextInfo();
    const ctx = meta?.contextUsagePercentage;
    const ctxStr = ctx !== undefined ? ` \u00B7 ctx ${ctx.toFixed(0)}%` : "";
    // Credits consumed this turn вЂ” only shown when Grok actually reports it
    // (not part of ACP today; degrades to nothing rather than guessing).
    const credits = meta?.credits;
    const creditStr = credits !== undefined ? ` \u00B7 \u{1FA99} ${fmtCredits(credits)}` : "";
    // Only claim "no text output" when we were actually streaming (foreground).
    const noOut = this.foreground && !streamedOutput ? " \u00B7 no text output" : "";
    return `\u2705 Done${reason} \u00B7 ${elapsed}${ctxStr}${creditStr}${noOut}`;
  }

  /** Build the turn-failed message and record `lastCompletion`. */
  private errorMessage(error: Error, startedAt: number, attempts: number, transient: boolean): string {
    const summary = formatErrorSummary(error, fmtDuration(Date.now() - startedAt), attempts, transient);
    const files = this.fileOps.size > 0 ? `\n${summarizeFileOps(this.fileOps, this.cwd)}` : "";
    const tags = this.hashtags();
    this.lastCompletion = `${summary}${files}\n\n${tags}`;
    if (this.foreground) return this.lastCompletion;
    const shortFiles = this.fileOps.size > 0 ? `\n${summarizeFileOpsShort(this.fileOps)}` : "";
    return `\u{1F4E8} From other session ${this.sessionTag()}\n${summary}${shortFiles}\n\n${tags}`;
  }

  /** "[project В· 1a2b3c4d]" вЂ” identifies which background session a ping is from. */
  private sessionTag(): string {
    const name = this.projectName || basename(this.cwd) || "session";
    const id = this.sessionId ? ` \u00B7 ${this.sessionId.slice(0, 8)}` : "";
    return `[${name}${id}]`;
  }

  /** Inline keyboard offering to switch to this session, attached to background
   *  ("From other session") pings so you can jump straight in. Foreground turns
   *  are already in view, so they get no button. */
  private switchKeyboard(): InlineKeyboard | undefined {
    if (this.foreground || !this.sessionId) return undefined;
    return new InlineKeyboard().text("\u{1F500} Switch to this session", `run:switch:${this.sessionId}`);
  }

  /** Searchable Telegram hashtags so you can pull up every message of a session
   *  or project (and this turn's prompt) by tapping the tag. */
  private hashtags(): string {
    // General manager: no tags (user requested clean chat). Reply routing uses
    // Telegram message-id → session map, not #sess_ footers.
    if (this.managerMode) return "";
    return sessionHashtags({
      projectName: this.projectName,
      cwd: this.cwd,
      sessionId: this.sessionId,
      promptId: this.turnPromptId,
    });
  }

  private async flushQueue(): Promise<void> {
    if (this.queue.length === 0 || this.busy) return;
    // Meta / system turns (self-recheck, auto-suggestion batches) must run
    // alone: merging them with user messages corrupts the prompt and can drop
    // the one-shot skipSelfRecheck guard via text concatenation.
    const head = this.queue[0]!;
    const isMeta =
      !!head.skipSelfRecheck ||
      !!head.rawSlashCommand ||
      isSelfRecheckPrompt(head.text) ||
      isTelegramBridgeResultsPrompt(head.text);
    const batch = isMeta
      ? this.queue.shift()!
      : mergeInputs(this.queue.splice(0, this.queue.length));
    // Real user follow-ups only — never spam chat for bridge/recheck meta turns.
    if (this.foreground && !isMeta) {
      await this.notify("\u25B6\uFE0F Processing queued message\u2026", {
        replyTo: batch.replyTo,
      });
    }
    void this.runTurn(batch);
  }

  private onUpdate(sessionId: string, update: SessionUpdate): void {
    if (!this.busy) return;
    // Child crew sessions: mirror tools/thoughts into the parent live bubble.
    if (sessionId !== this.sessionId) {
      // list_update may lag the first child session/update — adopt known crew ids.
      if (!this.ownedSubagentIds.has(sessionId) && this.acp.subagentById(sessionId)) {
        this.ownedSubagentIds.add(sessionId);
      }
      if (this.ownedSubagentIds.has(sessionId)) {
        this.mirrorSubagentUpdate(sessionId, update);
      }
      return;
    }
    this.sessionUpdateCount++;
    const kind = update.sessionUpdate;

    // Quiet meta turns (follow-up suggestions): capture prose only, never stream.
    if (this.capturingQuiet) {
      if (kind === "agent_message_chunk") {
        const text = contentText(update.content);
        if (text) this.quietCaptureBuf += text;
      }
      return;
    }

    // Accumulate the turn's file-change summary + image-scan text even when this
    // session is in the background (its output isn't streamed here, but the
    // completion message still reports what changed / which images were made).
    if (kind === "tool_call" || kind === "tool_call_update") {
      // Merge early so background live-step + file ops use full title/args.
      const tid = update.toolCallId || "";
      const mergedEarly = mergeToolSnapshot(tid ? this.toolCallCache.get(tid) : undefined, update);
      if (tid) this.toolCallCache.set(tid, mergedEarly);

      if (mergedEarly.rawInput) this.imageScanText += " " + JSON.stringify(mergedEarly.rawInput);
      if (mergedEarly.title) this.imageScanText += " " + mergedEarly.title;
      if (Array.isArray(mergedEarly.content_blocks)) {
        this.imageScanText += " " + JSON.stringify(mergedEarly.content_blocks);
      }
      const ct = contentText(mergedEarly.content);
      if (ct) this.imageScanText += " " + ct;
      const fo = fileOpFromUpdate(mergedEarly);
      if (fo) this.fileOps.set(fo.path, mergeFileOp(this.fileOps.get(fo.path), fo.op));
      // Live card step — always, even for background sessions.
      const step = stepFromToolUpdate(mergedEarly);
      if (step) this.setLiveStep(step);
    } else if (kind === "agent_message_chunk") {
      const text = contentText(update.content);
      if (text) {
        this.imageScanText += text;
        this.turnAssistantText += text;
      }
    } else if (kind === "agent_thought_chunk") {
      const text = contentText(update.content);
      if (text?.trim()) {
        this.appendCardThinking(text);
        this.setLiveStep(stepFromThought(text));
      }
    } else if (kind === "plan") {
      // Always track plan entries (background too) so switch-to-live restores the board.
      const entries = parsePlanUpdate(update);
      if (entries?.length) {
        this.planEntries = entries;
        const one = renderPlanOneLine(entries);
        if (one) this.setLiveStep(one);
        this.changed();
      }
    }

    // Only the live foreground turn streams to Telegram.
    if (!this.foreground || !this.streamer) return;

    if (kind === "plan") {
      if (this.planEntries?.length) {
        this.streamer.setPlan(renderPlanMarkdown(this.planEntries));
      }
      return;
    }
    if (kind === "agent_message_chunk") {
      const text = contentText(update.content);
      if (text) this.streamer.appendOutput(text);
      return;
    }
    if (kind === "agent_thought_chunk") {
      const text = contentText(update.content);
      if (text) this.streamer.appendThought(text);
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      if (!this.cfg.showToolCalls) return;
      const id = update.toolCallId || "";
      const status = (update.status || "").toLowerCase();

      // Snapshot already merged above for file-ops / live step.
      const merged = (id && this.toolCallCache.get(id)) || mergeToolSnapshot(undefined, update);

      // Skip hollow shells with nothing useful yet.
      if (!snapshotHasDetail(merged) && status !== "completed" && status !== "failed") {
        return;
      }

      // Status-only mid-flight patches (no new content/input): skip if we already
      // painted this tool once — upsert would be a no-op anyway.
      if (kind === "tool_call_update" && (status === "pending" || status === "in_progress")) {
        const hasNewContent =
          (Array.isArray(update.content_blocks) && update.content_blocks.length > 0) ||
          (Array.isArray(update.content) && (update.content as unknown[]).length > 0) ||
          (!!update.rawInput && Object.keys(update.rawInput).length > 0) ||
          update.rawOutput !== undefined;
        const key = id || `tool_call:${update.title ?? ""}`;
        if (!hasNewContent && this.shownToolIds.has(key)) return;
      }

      const md = formatToolCall(merged, {
        showDiffs: this.cfg.showEditDiffs,
        diffMaxLines: this.cfg.diffMaxLines,
      });
      if (!md) return;

      // One live card per toolCallId: replace in place as output streams
      // (no spam of new code sections). Session/agent context keeps full output.
      const key = id || `tool_call:${merged.title ?? merged.name ?? ""}`;
      this.shownToolIds.add(key);
      if (status === "completed" || status === "failed") {
        this.shownToolIds.add(key + ":done");
      }
      this.streamer.upsertTool(id || undefined, md);
    }
  }

  private persist(): void {
    if (!this.foreground) return; // only the foreground session is the chat's restored default
    this.settings.updateKey(this.settingsKey, {
      projectPath: this.cwd,
      projectName: this.projectName,
      sessionId: this.sessionId,
    });
  }

  private changed(): void {
    try {
      this.onStateChange?.();
    } catch {
      /* non-fatal */
    }
  }

  private sessionChanged(): void {
    try {
      this.onSessionChange?.();
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Send a chat message. Returns Telegram message_id on success.
   * On failure, retries once truncated (~3500) without reply_markup so a long
   * Done / markup error cannot silently drop the completion ping.
   */
  private async notify(
    text: string,
    opts?: { loud?: boolean; replyTo?: number; replyMarkup?: InlineKeyboard },
  ): Promise<number | undefined> {
    const send = async (body: string, withMarkup: boolean): Promise<number | undefined> => {
      try {
        const extra: Record<string, unknown> = {
          ...(opts?.loud ? { disable_notification: false } : {}),
          // Never pass message_thread_id=1 (General) — Telegram rejects it.
          ...outboundThreadExtra(this.messageThreadId),
        };
        if (opts?.replyTo !== undefined) {
          extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
        }
        if (withMarkup && opts?.replyMarkup) extra.reply_markup = opts.replyMarkup;
        const msg = await this.api.sendMessage(this.chatId, body, extra);
        if (this.sessionId) this.onTelegramMessageBound?.(msg.message_id, this.sessionId);
        return msg.message_id;
      } catch (e) {
        log.debug("notify failed:", (e as Error).message);
        return undefined;
      }
    };
    const id = await send(text, true);
    if (id !== undefined) return id;
    const short = text.length > 3500 ? text.slice(0, 3499) + "\u2026" : text;
    return send(short, false);
  }

  /**
   * After Done was already sent, attach suggestion text + buttons by editing
   * that message (or sending a follow-up if edit fails / no message id).
   */
  private async enhanceDoneMessage(
    messageId: number | undefined,
    text: string,
    markup: InlineKeyboard | undefined,
  ): Promise<void> {
    if (messageId !== undefined) {
      try {
        // editMessageText does not need message_thread_id; keep markup only.
        const extra: Record<string, unknown> = {};
        if (markup) extra.reply_markup = markup;
        await this.api.editMessageText(this.chatId, messageId, text, extra);
        return;
      } catch (e) {
        log.debug("enhanceDoneMessage edit failed:", (e as Error).message);
      }
    }
    await this.notify(text, {
      loud: false,
      replyTo: this.turnReplyTo,
      replyMarkup: markup,
    });
  }

  private async onWatchEntries(entries: HistoryEntry[]): Promise<void> {
    const body = entries
      .map((e) => {
        const icon = WATCH_ICON[e.role] ?? "\u2022";
        if (e.role === "tool") return `${icon} ${e.tool ? `\`${e.tool}\`` : "tool"}`;
        const text = e.text.length > WATCH_ENTRY_MAX ? e.text.slice(0, WATCH_ENTRY_MAX) + " вЂ¦" : e.text;
        return `${icon} ${text}`;
      })
      .filter(Boolean)
      .join("\n\n");
    if (body.trim()) {
      await sendMarkdownDoc(this.api, this.chatId, `${body}\n\n${this.tags}`, {
        messageThreadId: this.messageThreadId,
      });
    }
  }
}

/** Visible manager reply body (no progress markers / telegram action fences). */
function cleanManagerVisibleText(raw: string): string {
  if (!raw?.trim()) return "";
  const withoutTg = stripTelegramActionFences(raw);
  return extractProgress(withoutTg).cleaned.trim();
}

/**
 * One short user-facing fallback when General forgot `notify`.
 * Drops empty, table-spam, and pure status narration.
 */
export function pickManagerFallbackText(cleaned: string): string | undefined {
  let t = cleaned.replace(/\r\n/g, "\n").trim();
  if (!t) return undefined;
  // Drop markdown tables and multi-line job dumps.
  if (/^\s*\|.+\|/m.test(t) && (t.match(/\|/g) || []).length >= 6) return undefined;
  // Collapse whitespace.
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  // Prefer first 1–2 short paragraphs.
  const paras = t.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  let out = paras.slice(0, 2).join("\n\n");
  if (out.length > 600) out = out.slice(0, 597) + "\u2026";
  // Ignore pure meta / empty placeholders.
  if (/^(thinking|starting|ok|done|\.+|\u2026)+$/i.test(out.trim())) return undefined;
  if (out.length < 2) return undefined;
  // Skip "Dispatching… / Sending to…" spam patterns if that is all we got.
  if (
    /^(dispatching|sending to|queued|cancelling|already running)\b/i.test(out) &&
    out.length < 280
  ) {
    return undefined;
  }
  return out;
}

/** Format an elapsed duration compactly (e.g. "8s", "2m 13s", "1h 4m"). */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Format a credits/cost figure compactly (drops noise decimals). */
function fmtCredits(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toFixed(2);
}

/** Convenience for callers that only have text. */
export { textPrompt };
