/**
 * Allowlisted sibling Telegram bots — optional command catalogs + invoke
 * slash commands like lightweight MCP tools.
 *
 * Reply capture rules:
 *  - Only messages/edits from a bot we *just* triggered (pending wait) count.
 *  - Prefer replies to our trigger message_id; also accept non-reply messages
 *    from that bot in the same chat/thread after the trigger was sent.
 *  - Streaming bots often edit one message: we listen for edited_message and
 *    wait until activity settles (idle window) before resolving — Bot API does
 *    not expose other bots' typing indicators, so settle-after-idle is the
 *    practical equivalent of "wait until typing finishes".
 *  - Hard timeout: if any content arrived, return it as partial; else error.
 *    Session always continues (not a Done for the Grok turn).
 */
import type { Api, Bot, Context } from "grammy";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { normalizeUsername } from "../render/telegram-bridge.js";

const log = createLogger("telegram-bots");

export interface SiblingBotCommand {
  /** Command without leading slash. */
  command: string;
  /** Optional short description. */
  description?: string;
}

export interface SiblingBotInfo {
  username: string;
  id?: number;
  inGroup: boolean;
  status?: string;
  note?: string;
  /** From TELEGRAM_BOT_COMMANDS when configured. */
  commands: SiblingBotCommand[];
}

export interface BotWaitResult {
  text: string;
  /** True when hard timeout fired with incomplete stream content. */
  partial: boolean;
}

interface PendingWait {
  chatId: number;
  botId: number;
  messageThreadId?: number;
  /** Our /cmd@bot message id — preferred reply target. */
  triggerMessageId?: number;
  /** Only accept content after this timestamp (ms). */
  startedAt: number;
  settleMs: number;
  chunks: Map<number, string>; // message_id → latest text
  hardTimer: NodeJS.Timeout;
  settleTimer?: NodeJS.Timeout;
  resolve: (result: BotWaitResult) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

/**
 * Catalog + reply waiter for allowlisted bots.
 * Register once with {@link attachToBot} so message/edit updates fulfill waits.
 */
export class TelegramBotService {
  private readonly cache = new Map<string, SiblingBotInfo>();
  private readonly pending: PendingWait[] = [];

  constructor(
    private readonly api: Api,
    private readonly cfg: AppConfig,
  ) {}

  get allowedUsernames(): string[] {
    return this.cfg.allowedTelegramBots;
  }

  /** Commands configured for a bot (empty if none). */
  commandsFor(username: string): SiblingBotCommand[] {
    const u = normalizeUsername(username);
    return this.cfg.telegramBotCommands[u] ?? [];
  }

  /** Wire message + edit middleware so bot_command waits can resolve. */
  attachToBot(bot: Bot): void {
    bot.on("message", (ctx, next) => {
      this.onBotContent(ctx, "message");
      return next();
    });
    bot.on("edited_message", (ctx, next) => {
      this.onBotContent(ctx, "edited_message");
      return next();
    });
  }

  isAllowed(username: string): boolean {
    const u = normalizeUsername(username);
    return this.cfg.allowedTelegramBots.includes(u);
  }

  /** Probe each allowlisted bot (cached per process). */
  async listBots(force = false): Promise<SiblingBotInfo[]> {
    const out: SiblingBotInfo[] = [];
    for (const username of this.cfg.allowedTelegramBots) {
      if (!force && this.cache.has(username)) {
        // Refresh commands from live config (catalog can be static; membership cached).
        const cached = this.cache.get(username)!;
        cached.commands = this.commandsFor(username);
        out.push(cached);
        continue;
      }
      const info = await this.probeOne(username);
      this.cache.set(username, info);
      out.push(info);
    }
    return out;
  }

  /**
   * Send `/command@bot args` in the target chat and wait until the bot finishes
   * streaming (idle settle) or hard timeout. Only content from that bot after
   * our trigger is collected — unrelated bot chatter is ignored.
   */
  async invokeCommand(opts: {
    bot: string;
    command: string;
    args?: string;
    chatId: number;
    messageThreadId?: number;
  }): Promise<
    | { ok: true; reply: string; partial: boolean }
    | {
        ok: false;
        error: string;
        kind: "timeout" | "send" | "resolve" | "not_allowed" | "unknown_command";
        partialReply?: string;
      }
  > {
    const username = normalizeUsername(opts.bot);
    if (!this.isAllowed(username)) {
      return {
        ok: false,
        kind: "not_allowed",
        error: `@${username} is not in ALLOWED_TELEGRAM_BOTS`,
      };
    }

    const cmd = opts.command.replace(/^\//, "").trim().toLowerCase();
    if (!cmd) {
      return { ok: false, kind: "unknown_command", error: "empty command" };
    }

    // Optional catalog: unknown commands still attempt (bot may accept them) but
    // we annotate so the agent can adjust. We do NOT hard-fail — a dead command
    // becomes a timeout/error result, not a Done for the Grok session.
    const catalog = this.commandsFor(username);
    const catalogHint =
      catalog.length > 0 && !catalog.some((c) => c.command === cmd)
        ? ` (not in TELEGRAM_BOT_COMMANDS catalog for @${username}: ${catalog.map((c) => "/" + c.command).join(", ")})`
        : "";

    const info = (await this.listBots(true)).find((b) => b.username === username);
    if (!info?.id) {
      return {
        ok: false,
        kind: "resolve",
        error: `Could not resolve @${username} (public username required)`,
      };
    }

    const args = (opts.args ?? "").trim();
    const text = args
      ? `/${cmd}@${username} ${args}`.slice(0, 4000)
      : `/${cmd}@${username}`;

    const extra: Record<string, unknown> = {};
    // Omit General (1) — Bot API rejects message_thread_id=1.
    if (opts.messageThreadId !== undefined && opts.messageThreadId !== 1) {
      extra.message_thread_id = opts.messageThreadId;
    }

    // Register waiter BEFORE send so a fast reply cannot race past us.
    const replyPromise = this.waitForReply({
      chatId: opts.chatId,
      botId: info.id,
      messageThreadId: opts.messageThreadId,
      timeoutMs: this.cfg.telegramBotReplyTimeoutMs,
      settleMs: this.cfg.telegramBotSettleMs,
    });

    try {
      const sent = await this.api.sendMessage(opts.chatId, text, extra);
      const triggerMessageId = (sent as { message_id?: number }).message_id;
      if (triggerMessageId !== undefined) {
        this.setTriggerMessageId(opts.chatId, info.id, triggerMessageId);
      }
    } catch (e) {
      this.cancelWait(opts.chatId, info.id, "send failed");
      return {
        ok: false,
        kind: "send",
        error: `send failed: ${(e as Error).message}${catalogHint}`,
      };
    }

    try {
      const result = await replyPromise;
      return {
        ok: true,
        reply: result.text,
        partial: result.partial,
      };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const kind = /timed out/i.test(msg) ? "timeout" : "resolve";
      return {
        ok: false,
        kind,
        error: `${msg}${catalogHint}`,
      };
    }
  }

  private setTriggerMessageId(chatId: number, botId: number, messageId: number): void {
    // Prefer the most recently added wait without a trigger (LIFO for sequential invokes).
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.chatId === chatId && p.botId === botId && !p.settled && p.triggerMessageId === undefined) {
        p.triggerMessageId = messageId;
        return;
      }
    }
  }

  /** Drop pending wait(s) for this bot so the promise settles (send failure). */
  private cancelWait(chatId: number, botId: number, reason: string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.chatId === chatId && p.botId === botId && !p.settled) {
        this.finishWait(p, i, "reject", new Error(reason));
      }
    }
  }

  private async probeOne(username: string): Promise<SiblingBotInfo> {
    const commands = this.commandsFor(username);
    const base: SiblingBotInfo = { username, inGroup: false, commands };
    let id: number | undefined;
    try {
      const chat = await this.api.getChat(`@${username}`);
      id = (chat as { id?: number }).id;
      base.id = id;
    } catch (e) {
      base.note = `getChat(@${username}) failed: ${(e as Error).message}`;
      return base;
    }

    const groupId = this.cfg.topicGroupId;
    if (groupId === undefined || id === undefined) {
      base.note =
        groupId === undefined
          ? "TOPIC_GROUP_ID unset — cannot verify group membership"
          : base.note;
      return base;
    }

    try {
      const member = await this.api.getChatMember(groupId, id);
      const status = (member as { status?: string }).status ?? "unknown";
      base.status = status;
      base.inGroup = !["left", "kicked"].includes(status);
      if (!base.inGroup) base.note = `not in group (status=${status})`;
    } catch (e) {
      base.note = `getChatMember failed: ${(e as Error).message}`;
    }
    return base;
  }

  private waitForReply(opts: {
    chatId: number;
    botId: number;
    messageThreadId?: number;
    timeoutMs: number;
    settleMs: number;
  }): Promise<BotWaitResult> {
    return new Promise((resolve, reject) => {
      const entry: PendingWait = {
        chatId: opts.chatId,
        botId: opts.botId,
        messageThreadId: opts.messageThreadId,
        startedAt: Date.now(),
        settleMs: Math.max(400, opts.settleMs),
        chunks: new Map(),
        hardTimer: setTimeout(() => {
          if (entry.settled) return;
          const text = this.joinChunks(entry);
          // Partial content on timeout → resolve so the agent still gets what arrived.
          if (text) {
            this.finishWait(entry, this.pending.indexOf(entry), "resolve", {
              text,
              partial: true,
            });
            return;
          }
          this.finishWait(
            entry,
            this.pending.indexOf(entry),
            "reject",
            new Error(
              `Timed out after ${opts.timeoutMs}ms waiting for bot reply (offline, privacy mode, or unknown command?)`,
            ),
          );
        }, opts.timeoutMs),
        resolve,
        reject,
        settled: false,
      };
      this.pending.push(entry);
      log.debug(
        `waiting for bot ${opts.botId} in chat ${opts.chatId} ` +
          `(timeout ${opts.timeoutMs}ms, settle ${opts.settleMs}ms)`,
      );
    });
  }

  private finishWait(
    entry: PendingWait,
    index: number,
    mode: "resolve" | "reject",
    value: BotWaitResult | Error,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.hardTimer);
    if (entry.settleTimer) clearTimeout(entry.settleTimer);
    if (index >= 0) this.pending.splice(index, 1);
    else {
      const i = this.pending.indexOf(entry);
      if (i >= 0) this.pending.splice(i, 1);
    }
    if (mode === "resolve") entry.resolve(value as BotWaitResult);
    else entry.reject(value as Error);
  }

  private joinChunks(entry: PendingWait): string {
    // Preserve message order by message_id (Telegram ids increase).
    const parts = [...entry.chunks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => t.trim())
      .filter(Boolean);
    return parts.join("\n\n").slice(0, 8000);
  }

  private scheduleSettle(entry: PendingWait): void {
    if (entry.settled) return;
    if (entry.settleTimer) clearTimeout(entry.settleTimer);
    entry.settleTimer = setTimeout(() => {
      if (entry.settled || entry.chunks.size === 0) return;
      const text = this.joinChunks(entry);
      if (!text) return;
      this.finishWait(entry, this.pending.indexOf(entry), "resolve", {
        text,
        partial: false,
      });
    }, entry.settleMs);
  }

  private onBotContent(ctx: Context, kind: "message" | "edited_message"): void {
    if (this.pending.length === 0) return;
    const msg = kind === "edited_message" ? ctx.editedMessage : ctx.message;
    if (!msg) return;
    const from = msg.from;
    if (!from?.is_bot) return;

    const chatId = msg.chat.id;
    const botId = from.id;
    const threadId = msg.message_thread_id;
    const messageId = msg.message_id;
    const text = extractMessageText(msg);
    if (!text) return;

    const replyTo = msg.reply_to_message?.message_id;
    const msgDateMs = (msg.date ?? 0) * 1000;
    const editDateMs =
      typeof (msg as { edit_date?: number }).edit_date === "number"
        ? (msg as { edit_date: number }).edit_date * 1000
        : 0;

    for (const p of this.pending) {
      if (p.settled) continue;
      if (p.chatId !== chatId || p.botId !== botId) continue;

      // Strict thread match when the wait is topic-scoped (forum).
      if (p.messageThreadId !== undefined && threadId !== p.messageThreadId) {
        continue;
      }

      if (
        !shouldAcceptBotContent({
          kind,
          alreadyTracked: p.chunks.has(messageId),
          startedAt: p.startedAt,
          msgDateMs,
          editDateMs,
          triggerMessageId: p.triggerMessageId,
          replyToMessageId: replyTo,
        })
      ) {
        continue;
      }

      p.chunks.set(messageId, text);
      this.scheduleSettle(p);
      log.debug(
        `bot ${botId} ${kind} #${messageId} (${text.length} chars) — settle in ${p.settleMs}ms`,
      );
      return;
    }
  }
}

/**
 * Pure filter: should this update count toward a pending sibling-bot wait?
 * Exported for unit tests.
 */
export function shouldAcceptBotContent(opts: {
  kind: "message" | "edited_message";
  alreadyTracked: boolean;
  startedAt: number;
  msgDateMs: number;
  editDateMs: number;
  triggerMessageId?: number;
  replyToMessageId?: number;
}): boolean {
  // Edits of messages we already collected always win (streaming / SSE bots).
  if (opts.kind === "edited_message" && opts.alreadyTracked) return true;

  // Explicit reply to something other than our trigger → not our call.
  if (
    opts.triggerMessageId !== undefined &&
    opts.replyToMessageId !== undefined &&
    opts.replyToMessageId !== opts.triggerMessageId
  ) {
    return false;
  }

  // Prefer content that replies to our trigger.
  if (
    opts.triggerMessageId !== undefined &&
    opts.replyToMessageId === opts.triggerMessageId
  ) {
    return true;
  }

  // New message: drop stale chatter from before we started waiting (2s slack).
  if (opts.kind === "message") {
    if (opts.msgDateMs > 0 && opts.msgDateMs + 2000 < opts.startedAt) return false;
    return true;
  }

  // First sighting of a message via edit only (no prior chunk): require it looks
  // "new enough" — use edit_date or date so we do not steal ancient bot posts.
  const effective = opts.editDateMs || opts.msgDateMs;
  if (effective > 0 && effective + 2000 < opts.startedAt) return false;
  return true;
}

function extractMessageText(msg: {
  text?: string;
  caption?: string;
  photo?: unknown;
  document?: unknown;
  video?: unknown;
  audio?: unknown;
  voice?: unknown;
  sticker?: unknown;
  animation?: unknown;
}): string {
  const t = (msg.text || msg.caption || "").trim();
  if (t) return t;
  // Media-only replies still count so settle can finish (not hang until timeout).
  if (
    msg.photo ||
    msg.document ||
    msg.video ||
    msg.audio ||
    msg.voice ||
    msg.sticker ||
    msg.animation
  ) {
    return "[media]";
  }
  return "";
}
