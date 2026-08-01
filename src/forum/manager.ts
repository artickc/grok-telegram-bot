/**
 * Manage a Telegram forum group: AI Chat topic + optional one-topic-per-project
 * setup, path binding for user-created topics, and best-effort icon pins.
 */
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Api } from "grammy";
import { InputFile } from "grammy";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";
import type { ProjectEntry, ProjectManager } from "../projects/manager.js";
import { discoverProjectIcon } from "./project-icon.js";
import { TopicStore } from "./topic-store.js";
import type { ForumTopicBinding } from "./types.js";

const log = createLogger("forum");

/** Telegram-allowed topic icon colors (Bot API enum). */
const TOPIC_ICON_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f] as const;
type TopicIconColor = (typeof TOPIC_ICON_COLORS)[number];
const DEFAULT_ICON_COLOR: TopicIconColor = 0x6fb9f0;

export class ForumManager {
  readonly store: TopicStore;
  private setupPromise: Promise<void> | undefined;

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
    try {
      const chat = await this.api.getChat(chatId);
      const isForum = Boolean((chat as { is_forum?: boolean }).is_forum);
      if (!isForum) {
        log.warn(`TOPIC_GROUP_ID ${chatId} is not a forum supergroup — topic management disabled`);
        return;
      }
      const me = await this.api.getMe();
      const member = await this.api.getChatMember(chatId, me.id);
      const status = member.status;
      if (status !== "administrator" && status !== "creator") {
        log.warn(`bot is not admin in topic group ${chatId} (status=${status})`);
        return;
      }
      // Need Manage Topics to createForumTopic (creator always can).
      if (status === "administrator") {
        const admin = member as { can_manage_topics?: boolean };
        if (admin.can_manage_topics === false) {
          log.warn(
            `bot is admin in ${chatId} but can_manage_topics=false — cannot create topics`,
          );
          return;
        }
      }
    } catch (e) {
      log.warn(`cannot access topic group ${chatId}: ${(e as Error).message}`);
      return;
    }

    await this.ensureAiChatTopic();
    if (this.cfg.topicAutoCreateProjects) {
      await this.ensureProjectTopics(this.projects.list(200));
    }
    this.store.setLastSetup();
    log.info(`forum setup complete for group ${chatId} (${this.store.all().length} topics mapped)`);
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
    await this.api
      .sendMessage(
        this.groupId,
        `\u{1F916} **AI Chat** — general conversation (workspace).\nPath: \`${this.cfg.workspace}\``,
        { message_thread_id: topic.message_thread_id, parse_mode: "Markdown" },
      )
      .catch(() => {});
    return binding;
  }

  /** Create missing topics for catalog projects. */
  async ensureProjectTopics(projects: ProjectEntry[]): Promise<void> {
    for (const p of projects) {
      if (this.store.findByProjectPath(p.path)) continue;
      try {
        await this.createProjectTopic(p);
      } catch (e) {
        log.warn(`create topic for ${p.name} failed: ${(e as Error).message}`);
      }
    }
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

  private async createTopic(
    name: string,
    iconColor: TopicIconColor = DEFAULT_ICON_COLOR,
  ): Promise<{ message_thread_id: number; name: string }> {
    const res = await this.api.createForumTopic(this.groupId, name, {
      icon_color: iconColor,
    });
    return { message_thread_id: res.message_thread_id, name: res.name };
  }

  private async announceProjectTopic(binding: ForumTopicBinding): Promise<void> {
    const chatId = this.groupId;
    const threadId = binding.threadId;
    const caption =
      `\u{1F4C1} **${binding.name}**\n` +
      `Project path: \`${binding.projectPath}\`\n` +
      `Messages in this topic run Grok sessions in that directory.`;
    try {
      if (binding.iconPath && existsSync(binding.iconPath)) {
        await this.api.sendPhoto(chatId, new InputFile(binding.iconPath), {
          message_thread_id: threadId,
          caption,
          parse_mode: "Markdown",
        });
      } else {
        await this.api.sendMessage(chatId, caption, {
          message_thread_id: threadId,
          parse_mode: "Markdown",
        });
      }
    } catch (e) {
      log.debug(`announce topic ${threadId} failed: ${(e as Error).message}`);
      await this.api
        .sendMessage(chatId, `Project: ${binding.projectPath}`, { message_thread_id: threadId })
        .catch(() => {});
    }
  }

  /**
   * Register a user-created topic we have not seen. Marks it unbound and asks
   * for a project path on first message (caller sends the ask).
   */
  noteUserTopic(threadId: number, name: string): ForumTopicBinding {
    const prev = this.store.get(threadId);
    if (prev) return prev;
    const binding: ForumTopicBinding = {
      threadId,
      name: name || `Topic ${threadId}`,
      kind: "unbound",
      projectPath: null,
      updatedAt: Date.now(),
    };
    this.store.upsert(binding);
    this.store.markPending(threadId);
    return binding;
  }

  /**
   * Try to resolve a user reply as a project path or catalog name.
   * Returns the bound topic or undefined if still invalid.
   */
  tryBindPath(threadId: number, text: string): { ok: true; binding: ForumTopicBinding } | { ok: false; error: string } {
    const raw = text.trim().replace(/^["']|["']$/g, "");
    if (!raw) return { ok: false, error: "Empty path." };

    // Absolute path?
    let path = raw;
    if (existsSync(path)) {
      path = resolve(path);
    } else {
      // Match catalog by name (case-insensitive).
      const hit = this.projects.list(500).find((p) => p.name.toLowerCase() === raw.toLowerCase());
      if (hit) path = hit.path;
      else {
        const partial = this.projects.search(raw, 5);
        if (partial.length === 1) path = partial[0]!.path;
        else if (partial.length > 1) {
          return {
            ok: false,
            error:
              `Ambiguous project name. Matches:\n` +
              partial.map((p) => `• ${p.name} — ${p.path}`).join("\n"),
          };
        } else {
          return {
            ok: false,
            error:
              "Path not found. Send an absolute folder path, or an exact project name from the catalog.",
          };
        }
      }
    }

    if (!this.projects.isDirectory(path)) {
      return { ok: false, error: `Not a directory: ${path}` };
    }

    const name = this.store.get(threadId)?.name || basename(path);
    const iconPath = discoverProjectIcon(path);
    const binding = this.store.bindProject(threadId, path, name, "project");
    if (iconPath) {
      binding.iconPath = iconPath;
      this.store.upsert(binding);
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

function clampTopicName(name: string): string {
  // Telegram topic names are short; keep readable.
  const t = name.trim() || "Project";
  return t.length > 128 ? t.slice(0, 125) + "…" : t;
}
