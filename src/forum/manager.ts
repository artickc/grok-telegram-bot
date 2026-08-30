/**
 * Manage a Telegram forum group: AI Chat topic + optional one-topic-per-project
 * setup, path binding for user-created topics, and best-effort icon pins.
 */
import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import type { Api } from "grammy";
import { InputFile } from "grammy";
import type { AppConfig } from "../config.js";
import { withTelegramRetry } from "../bot/telegram-io.js";
import { createLogger } from "../logger.js";
import type { ProjectEntry, ProjectManager } from "../projects/manager.js";
import { resolveBindTarget } from "./bind-path.js";
import { discoverProjectIcon } from "./project-icon.js";
import { TopicStore } from "./topic-store.js";
import type { ForumTopicBinding } from "./types.js";

const log = createLogger("forum");

/** Telegram-allowed topic icon colors (Bot API enum). */
const TOPIC_ICON_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f] as const;
type TopicIconColor = (typeof TOPIC_ICON_COLORS)[number];
const DEFAULT_ICON_COLOR: TopicIconColor = 0x6fb9f0;

/** Pace createForumTopic + announce to stay under Telegram flood limits. */
const INTER_TOPIC_DELAY_MS = 500;
/** Generous 429 budget for bulk setup of 1000+ projects. */
const SETUP_RATE_LIMIT_RETRIES = 15;
const SETUP_NETWORK_RETRIES = 5;
const PROGRESS_EVERY = 25;

/** Why forum topic management is off (null when ready). */
export type ForumDisabledReason =
  | "access_error"
  | "not_supergroup"
  | "not_admin"
  | "no_manage_topics"
  | "not_forum"
  | "forums_disabled";

export class ForumManager {
  readonly store: TopicStore;
  private setupPromise: Promise<void> | undefined;
  /** True only after a successful probe (admin + forum topics usable). */
  private ready = false;
  private disabledReason: ForumDisabledReason | null = "access_error";
  private disabledDetail: string | null = "setup not run yet";

  constructor(
    private readonly api: Api,
    private readonly cfg: AppConfig,
    private readonly projects: ProjectManager,
  ) {
    this.store = new TopicStore(cfg.dataDir, cfg.topicGroupId!);
  }

  get groupId(): number {
    return this.cfg.topicGroupId!;
  }

  /** Topic management is active for this group (admin + forum enabled). */
  get isReady(): boolean {
    return this.ready;
  }

  /** Human-readable readiness for logs / /forum_setup. */
  getStatusText(): string {
    if (this.ready) {
      return `ready (${this.store.all().length} topic(s) mapped)`;
    }
    const code = this.disabledReason ?? "access_error";
    const detail = this.disabledDetail ? `: ${this.disabledDetail}` : "";
    return `disabled (${code})${detail}`;
  }

  /** True when this chat id is the configured group and setup succeeded. */
  isActiveForumChat(chatId: number): boolean {
    return this.ready && chatId === this.groupId;
  }

  /** Mark forum features off (not admin / no topics / etc.). */
  markDisabled(reason: ForumDisabledReason, detail: string): void {
    this.ready = false;
    this.disabledReason = reason;
    this.disabledDetail = detail;
    log.warn(`forum management ignored for group ${this.groupId}: [${reason}] ${detail}`);
  }

  /** Verify access and ensure AI chat + optional project topics. Idempotent. */
  async ensureSetup(): Promise<void> {
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = this.runSetup().finally(() => {
      this.setupPromise = undefined;
    });
    return this.setupPromise;
  }

  private async runSetup(): Promise<void> {
    const chatId = this.groupId;
    const probe = await this.probeGroup(chatId);
    if (!probe.ok) {
      this.markDisabled(probe.reason, probe.detail);
      return;
    }

    // Usable as a forum group — handlers may use topics while bulk create runs.
    this.ready = true;
    this.disabledReason = null;
    this.disabledDetail = null;
    log.info(`forum group ${chatId} ready (admin + topics enabled)`);

    try {
      await this.ensureAiChatTopic();
      if (this.cfg.topicAutoCreateProjects) {
        await this.ensureProjectTopics(this.projects.listAll());
      }
      this.store.setLastSetup();
      log.info(`forum setup complete for group ${chatId} (${this.store.all().length} topics mapped)`);
    } catch (e) {
      // Keep ready if probe passed — individual create failures are logged inside.
      const msg = (e as Error).message ?? String(e);
      if (isForumsDisabledError(e)) {
        this.markDisabled("forums_disabled", msg);
        return;
      }
      log.warn(`forum setup partially failed for ${chatId}: ${msg}`);
    }
  }

  /**
   * Check admin rights and forum mode. If Topics are off and the bot is admin,
   * try to enable them (Bot API has no official method — best-effort raw calls).
   * On failure, the group is ignored for forum features.
   */
  private async probeGroup(
    chatId: number,
  ): Promise<{ ok: true } | { ok: false; reason: ForumDisabledReason; detail: string }> {
    let chat: Awaited<ReturnType<Api["getChat"]>>;
    try {
      chat = await this.api.getChat(chatId);
    } catch (e) {
      return {
        ok: false,
        reason: "access_error",
        detail: `cannot getChat: ${(e as Error).message}`,
      };
    }

    const chatType = (chat as { type?: string }).type;
    if (chatType !== "supergroup") {
      return {
        ok: false,
        reason: "not_supergroup",
        detail: `chat type is "${chatType ?? "unknown"}" (need a supergroup with Topics)`,
      };
    }

    let me: { id: number };
    let member: { status: string; can_manage_topics?: boolean };
    try {
      me = await this.api.getMe();
      member = (await this.api.getChatMember(chatId, me.id)) as {
        status: string;
        can_manage_topics?: boolean;
      };
    } catch (e) {
      return {
        ok: false,
        reason: "access_error",
        detail: `cannot getChatMember: ${(e as Error).message}`,
      };
    }

    const status = member.status;
    if (status !== "administrator" && status !== "creator") {
      return {
        ok: false,
        reason: "not_admin",
        detail: `bot status is "${status}" — make the bot admin with Manage Topics, then /forum_setup`,
      };
    }

    // Creator always has topic rights; admins need can_manage_topics.
    if (status === "administrator" && member.can_manage_topics === false) {
      return {
        ok: false,
        reason: "no_manage_topics",
        detail: "bot is admin but can_manage_topics=false — enable Manage Topics for the bot",
      };
    }

    let isForum = Boolean((chat as { is_forum?: boolean }).is_forum);
    if (!isForum) {
      log.info(`group ${chatId} has Topics off — attempting to enable forum mode…`);
      const enabled = await this.tryEnableForumTopics(chatId);
      if (enabled) {
        isForum = true;
        log.info(`forum topics enabled on group ${chatId}`);
      } else {
        return {
          ok: false,
          reason: "not_forum",
          detail:
            "Topics are disabled and could not be enabled via Bot API. " +
            "In Telegram: Group settings → Topics → enable, then /forum_setup. " +
            "Ignoring this group for project topics until then.",
        };
      }
    }

    return { ok: true };
  }

  /**
   * Best-effort enable Topics on a supergroup.
   * Official Bot API does not document this (MTProto channels.toggleForum is
   * owner-only). We still try known raw method names so a future API works
   * without a bot change; failure is expected today.
   */
  private async tryEnableForumTopics(chatId: number): Promise<boolean> {
    // grammy api.raw is a proxy: any method name is callable and hits Telegram.
    // Official Bot API has no enable-Topics method; these fail with "method not
    // found" today and succeed only if Telegram adds them later.
    const attempts: Array<{ method: string; args: Record<string, unknown> }> = [
      { method: "setChatForum", args: { chat_id: chatId, is_forum: true } },
      { method: "toggleForum", args: { chat_id: chatId, enabled: true } },
      { method: "setChatIsForum", args: { chat_id: chatId, is_forum: true } },
    ];
    const raw = this.api.raw as unknown as Record<
      string,
      (args: Record<string, unknown>) => Promise<unknown>
    >;

    for (const { method, args } of attempts) {
      try {
        await raw[method]!(args);
        const chat = await this.api.getChat(chatId);
        if (Boolean((chat as { is_forum?: boolean }).is_forum)) {
          log.info(`enabled Topics on ${chatId} via raw ${method}`);
          return true;
        }
      } catch (e) {
        log.debug(`enable Topics via ${method} failed: ${(e as Error).message}`);
      }
    }
    return false;
  }

  /** Ensure the default "chat with AI" topic exists (workspace cwd). */
  async ensureAiChatTopic(): Promise<ForumTopicBinding> {
    const existing = this.store.findAiChat();
    if (existing) return existing;

    const name = this.cfg.topicAiChatName;
    // Reuse a stored topic with the same name if present.
    const byName = this.store.all().find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (byName) {
      const bound = this.store.bindProject(byName.threadId, this.cfg.workspace, name, "ai_chat");
      return bound;
    }

    const topic = await this.createTopic(name, DEFAULT_ICON_COLOR);
    const binding = this.store.bindProject(topic.message_thread_id, this.cfg.workspace, name, "ai_chat");
    await this.tgCall(
      () =>
        this.api.sendMessage(
          this.groupId,
          `\u{1F916} **AI Chat** — workspace coding chat.\nPath: \`${this.cfg.workspace}\`\n\n` +
            `Use **General** to orchestrate projects (manager). Code here or in a project topic.`,
          { message_thread_id: topic.message_thread_id, parse_mode: "Markdown" },
        ),
      "ai-chat-announce",
    ).catch(() => {});
    return binding;
  }

  /**
   * Create missing topics for catalog projects. Resumable: skips paths already
   * mapped. Uses pacing + 429/network retries so 1000+ projects can complete.
   */
  async ensureProjectTopics(projects: ProjectEntry[]): Promise<void> {
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const total = projects.length;
    log.info(`ensuring project topics: ${total} catalog project(s)`);

    for (let i = 0; i < projects.length; i++) {
      // Demotion / markDisabled mid-run should stop creating topics.
      if (!this.ready) {
        log.warn("aborting remaining project topics — forum no longer ready");
        break;
      }
      const p = projects[i]!;
      if (this.store.findByProjectPath(p.path)) {
        skipped++;
        continue;
      }
      try {
        await this.createProjectTopic(p);
        created++;
        if (created % PROGRESS_EVERY === 0 || i + 1 === total) {
          log.info(
            `project topics progress: created=${created} skipped=${skipped} failed=${failed} ` +
              `processed=${i + 1}/${total}`,
          );
        }
        // Pace even after success so we rarely hit flood limits.
        if (i + 1 < projects.length) await sleep(INTER_TOPIC_DELAY_MS);
      } catch (e) {
        failed++;
        log.warn(`create topic for ${p.name} failed: ${(e as Error).message}`);
        if (isForumsDisabledError(e)) {
          this.markDisabled("forums_disabled", (e as Error).message);
          log.warn("aborting remaining project topics — forum mode no longer available");
          break;
        }
        // Still pause after errors (especially non-429) to avoid a tight fail loop.
        if (i + 1 < projects.length) await sleep(INTER_TOPIC_DELAY_MS);
      }
    }

    log.info(
      `project topics done: created=${created} skipped=${skipped} failed=${failed} catalog=${total}`,
    );
  }

  async createProjectTopic(project: ProjectEntry): Promise<ForumTopicBinding> {
    const existing = this.store.findByProjectPath(project.path);
    if (existing) return existing;

    const iconPath = discoverProjectIcon(project.path);
    const topic = await this.createTopic(clampTopicName(project.name), DEFAULT_ICON_COLOR);
    const binding: ForumTopicBinding = {
      threadId: topic.message_thread_id,
      name: project.name,
      kind: "project",
      projectPath: project.path,
      iconPath,
      updatedAt: Date.now(),
    };
    this.store.upsert(binding);
    await this.announceProjectTopic(binding);
    return binding;
  }

  /**
   * Agent/user request: create a new forum topic, optionally bind a project.
   * Path rules match manual bind (absolute path or exact catalog name only).
   */
  async createBoundTopic(
    name: string,
    projectPath?: string,
  ): Promise<
    | { ok: true; binding: ForumTopicBinding }
    | { ok: false; error: string }
  > {
    if (!this.ready) {
      return { ok: false, error: `forum not ready (${this.getStatusText()})` };
    }
    const title = clampTopicName(name);
    if (!title.trim()) return { ok: false, error: "topic name is empty" };

    let resolvedPath: string | undefined;
    let kind: ForumTopicBinding["kind"] = "unbound";
    let pathCreated = false;
    if (projectPath?.trim()) {
      // Agent new-project flow: absolute paths that do not exist yet are created.
      const resolved = resolveBindTarget(projectPath, {
        existsSync,
        isDirectory: (p) => this.projects.isDirectory(p),
        findExactByName: (n) => this.projects.findExactByName(n),
        createIfMissing: true,
        mkdirSync: (p) => mkdirSync(p, { recursive: true }),
        defaultRoot: this.cfg.projectRoots[0],
      });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const already = this.store.findByProjectPath(resolved.path);
      if (already) {
        return {
          ok: false,
          error: `Project already bound to topic #${already.threadId} (${already.name})`,
        };
      }
      resolvedPath = resolved.path;
      pathCreated = !!resolved.created;
      kind = "project";
    }

    try {
      const topic = await this.createTopic(title, DEFAULT_ICON_COLOR);
      if (resolvedPath) {
        const iconPath = discoverProjectIcon(resolvedPath);
        const binding = this.store.bindProject(
          topic.message_thread_id,
          resolvedPath,
          title,
          kind,
        );
        if (iconPath) {
          binding.iconPath = iconPath;
          this.store.upsert(binding);
        }
        await this.announceProjectTopic(binding, pathCreated);
        return { ok: true, binding };
      }

      const binding: ForumTopicBinding = {
        threadId: topic.message_thread_id,
        name: title,
        kind: "unbound",
        projectPath: null,
        updatedAt: Date.now(),
      };
      this.store.upsert(binding);
      this.store.markPending(topic.message_thread_id);
      await this.tgCall(
        () =>
          this.api.sendMessage(
            this.groupId,
            `\u{1F4CC} **${title}**\n\nTopic created by the agent. Send an absolute project path or exact catalog name to bind it.`,
            { message_thread_id: topic.message_thread_id, parse_mode: "Markdown" },
          ),
        `agent-topic-announce:${topic.message_thread_id}`,
      ).catch(() => {});
      return { ok: true, binding };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (isForumsDisabledError(e)) {
        this.markDisabled("forums_disabled", msg);
      }
      return { ok: false, error: msg };
    }
  }

  private async createTopic(
    name: string,
    iconColor: TopicIconColor = DEFAULT_ICON_COLOR,
  ): Promise<{ message_thread_id: number; name: string }> {
    const res = await this.tgCall(
      () =>
        this.api.createForumTopic(this.groupId, name, {
          icon_color: iconColor,
        }),
      `createTopic:${name}`,
    );
    return { message_thread_id: res.message_thread_id, name: res.name };
  }

  private async announceProjectTopic(
    binding: ForumTopicBinding,
    pathCreated = false,
  ): Promise<void> {
    const chatId = this.groupId;
    const threadId = binding.threadId;
    const createdLine = pathCreated ? `\nFolder created on disk.\n` : `\n`;
    const caption =
      `\u{1F4C1} **${binding.name}**\n` +
      `Project path: \`${binding.projectPath}\`` +
      createdLine +
      `Messages in this topic run Grok sessions in that directory.`;
    try {
      if (binding.iconPath && existsSync(binding.iconPath)) {
        await this.tgCall(
          () =>
            this.api.sendPhoto(chatId, new InputFile(binding.iconPath!), {
              message_thread_id: threadId,
              caption,
              parse_mode: "Markdown",
            }),
          `announce-photo:${threadId}`,
        );
      } else {
        await this.tgCall(
          () =>
            this.api.sendMessage(chatId, caption, {
              message_thread_id: threadId,
              parse_mode: "Markdown",
            }),
          `announce-msg:${threadId}`,
        );
      }
    } catch (e) {
      log.debug(`announce topic ${threadId} failed: ${(e as Error).message}`);
      await this.tgCall(
        () =>
          this.api.sendMessage(chatId, `Project: ${binding.projectPath}`, {
            message_thread_id: threadId,
          }),
        `announce-fallback:${threadId}`,
      ).catch(() => {});
    }
  }

  private tgCall<T>(fn: () => Promise<T>, label: string): Promise<T> {
    return withTelegramRetry(fn, {
      maxRateLimitRetries: SETUP_RATE_LIMIT_RETRIES,
      maxNetworkRetries: SETUP_NETWORK_RETRIES,
      label: `forum:${label}`,
    });
  }

  /**
   * Register a user-created topic we have not seen. Marks it unbound and asks
   * for a project path on first message (caller sends the ask) unless auto-bound.
   * If the thread was noted earlier without a real title, refresh the name.
   */
  noteUserTopic(threadId: number, name: string): ForumTopicBinding {
    const prev = this.store.get(threadId);
    const title = (name || "").trim() || `Topic ${threadId}`;
    if (prev) {
      if (!prev.projectPath && title !== prev.name) {
        const next: ForumTopicBinding = { ...prev, name: title, updatedAt: Date.now() };
        this.store.upsert(next);
        this.store.markPending(threadId);
        return next;
      }
      return prev;
    }
    const binding: ForumTopicBinding = {
      threadId,
      name: title,
      kind: "unbound",
      projectPath: null,
      updatedAt: Date.now(),
    };
    this.store.upsert(binding);
    this.store.markPending(threadId);
    return binding;
  }

  /**
   * If the topic title exactly matches a catalog project name (and that path
   * is not already mapped to another thread), bind and announce.
   */
  async tryAutoBindByTopicName(threadId: number, topicName: string): Promise<AutoBindResult> {
    const prev = this.store.get(threadId);
    if (prev?.projectPath) return { status: "bound", binding: prev };

    const hit = this.projects.findExactByName(topicName);
    if (!hit) return { status: "no_match" };

    const already = this.store.findByProjectPath(hit.path);
    if (already && already.threadId !== threadId) {
      log.info(
        `topic "${topicName}" (#${threadId}) matches project ${hit.path} but path already bound to #${already.threadId}`,
      );
      return {
        status: "already_bound",
        projectPath: hit.path,
        otherThreadId: already.threadId,
      };
    }

    const iconPath = discoverProjectIcon(hit.path);
    // Prefer real topic title over a placeholder "Topic <id>" from an earlier note.
    const displayName =
      prev?.name && !/^Topic \d+$/i.test(prev.name) ? prev.name : hit.name;
    const binding = this.store.bindProject(threadId, hit.path, displayName, "project");
    if (iconPath) {
      binding.iconPath = iconPath;
      this.store.upsert(binding);
    }
    log.info(`auto-bound topic "${topicName}" (#${threadId}) → ${hit.path}`);
    await this.announceProjectTopic(binding);
    return { status: "bound", binding };
  }

  /**
   * Bind a topic to a path. When `createIfMissing` is true (agent set_path /
   * create_topic), absolute paths that do not exist yet are created on disk.
   * User-typed bind in an unbound topic stays strict (createIfMissing false).
   */
  tryBindPath(
    threadId: number,
    text: string,
    opts?: { createIfMissing?: boolean },
  ): { ok: true; binding: ForumTopicBinding; created?: boolean } | { ok: false; error: string } {
    const resolved = resolveBindTarget(text, {
      existsSync,
      isDirectory: (p) => this.projects.isDirectory(p),
      findExactByName: (n) => this.projects.findExactByName(n),
      createIfMissing: opts?.createIfMissing === true,
      mkdirSync: (p) => mkdirSync(p, { recursive: true }),
      defaultRoot: opts?.createIfMissing ? this.cfg.projectRoots[0] : undefined,
    });
    if (!resolved.ok) return resolved;

    const path = resolved.path;
    const already = this.store.findByProjectPath(path);
    if (already && already.threadId !== threadId) {
      return {
        ok: false,
        error:
          `That project is already bound to topic #${already.threadId} (${already.name}). ` +
          `Send a different absolute path or exact catalog name.`,
      };
    }

    const name = this.store.get(threadId)?.name || basename(path);
    const iconPath = discoverProjectIcon(path);
    const binding = this.store.bindProject(threadId, path, name, "project");
    if (iconPath) {
      binding.iconPath = iconPath;
      this.store.upsert(binding);
    }
    if (resolved.created) {
      return { ok: true, binding, created: true };
    }
    return { ok: true, binding };
  }

  /** Resolve cwd for a thread; undefined means not ready (unbound). */
  resolveCwd(threadId: number): { cwd: string; projectName: string; binding: ForumTopicBinding } | undefined {
    const b = this.store.get(threadId);
    if (!b?.projectPath) return undefined;
    return {
      cwd: b.projectPath,
      projectName: b.kind === "ai_chat" ? this.cfg.topicAiChatName : b.name,
      binding: b,
    };
  }
}

/** Result of auto-binding a user-created topic by its title. */
export type AutoBindResult =
  | { status: "bound"; binding: ForumTopicBinding }
  | { status: "no_match" }
  | { status: "already_bound"; projectPath: string; otherThreadId: number };

function clampTopicName(name: string): string {
  // Telegram topic names are short; keep readable.
  const t = name.trim() || "Project";
  return t.length > 128 ? t.slice(0, 125) + "…" : t;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Telegram errors when Topics are off or createForumTopic is impossible. */
function isForumsDisabledError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (
    msg.includes("forums_disabled") ||
    msg.includes("forum is disabled") ||
    msg.includes("topics are disabled") ||
    msg.includes("not a forum") ||
    msg.includes("chat is not a forum") ||
    msg.includes("supergroup required")
  );
}
