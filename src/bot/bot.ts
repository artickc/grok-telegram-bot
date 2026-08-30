/**
 * Assemble the grammY bot: dependencies, middleware, handlers, persistent menu,
 * status panel, and the task scheduler. Handler registration order matters:
 *   auth -> menu buttons -> wizard input -> commands -> photos -> text prompt.
 */
import { Bot } from "grammy";
import type { GrokClient } from "../grok/client.js";
import { AccountManager } from "../app/accounts.js";
import { AccountRotatorImpl } from "./account-rotator.js";
import { SettingsStore } from "../app/settings-store.js";
import { SttService } from "../app/stt.js";
import { Updater } from "../app/updater.js";
import { UsageService } from "../app/usage.js";
import { textPrompt } from "../app/types.js";
import type { AppConfig } from "../config.js";
import { INSTANCE_DIR } from "../config.js";
import { createLogger } from "../logger.js";
import { ProjectManager } from "../projects/manager.js";
import { SessionStore } from "../sessions/store.js";
import { TaskRunner } from "../tasks/runner.js";
import { Scheduler } from "../tasks/scheduler.js";
import { TaskStore } from "../tasks/store.js";
import { createAuthMiddleware } from "./auth.js";
import { isStaleCallbackError, safeCallbackMiddleware } from "./callback.js";
import { COMMANDS, GROUP_COMMANDS } from "./commands.js";
import { type BotDeps, MenuCache } from "./deps.js";
import { registerControl } from "./handlers/control.js";
import { registerDocuments } from "./handlers/document.js";
import { registerHistory } from "./handlers/history.js";
import { registerImportSession } from "./handlers/import-session.js";
import { registerKill } from "./handlers/kill.js";
import { registerMcp } from "./handlers/mcp.js";
import { registerMenu } from "./handlers/menu.js";
import { registerMessages } from "./handlers/message.js";
import { registerPhotos } from "./handlers/photo.js";
import { registerProjects } from "./handlers/projects.js";
import { registerRunning, switchAndShow } from "./handlers/running.js";
import { registerSessions } from "./handlers/sessions.js";
import { registerSessionKill } from "./handlers/session-kill.js";
import { registerAccounts } from "./handlers/accounts.js";
import { registerReauth } from "./handlers/auth.js";
import { registerSystem } from "./handlers/system.js";
import { registerTasks, registerWizardInput } from "./handlers/tasks.js";
import { registerUsage } from "./handlers/usage.js";
import { registerVoice } from "./handlers/voice.js";
import { registerForum } from "./handlers/forum.js";
import { registerGrokSlash } from "./handlers/grok-slash.js";
import { AskUserService } from "./ask-user-service.js";
import { PlanExitService } from "./plan-exit-service.js";
import { StatusPanel } from "./menu/status-panel.js";
import { sendMarkdownDoc } from "./telegram-io.js";
import { Ephemeral } from "./menu/ephemeral.js";
import { BAR_LABELS } from "./menu/keyboard.js";
import { PermissionService } from "./permission-service.js";
import { RuntimeRegistry } from "./registry.js";
import { TaskWizard } from "./wizard/task-wizard.js";
import { ForumManager } from "../forum/manager.js";
import { TelegramBotService } from "./telegram-bots.js";

const log = createLogger("bot");

/** Telegram methods that support disable_notification (silenced in quiet mode). */
const SILENCEABLE = new Set([
  "sendMessage",
  "sendPhoto",
  "sendDocument",
  "sendAudio",
  "sendVoice",
  "sendVideo",
  "sendAnimation",
  "sendMediaGroup",
  "copyMessage",
  "forwardMessage",
]);

export interface BotBundle {
  bot: Bot;
  registry: RuntimeRegistry;
  scheduler: Scheduler;
  updater: Updater;
}

export async function createBot(cfg: AppConfig, acp: GrokClient): Promise<BotBundle> {
  const bot = new Bot(cfg.token);

  // Quiet mode (default): silence every outgoing message unless the caller
  // explicitly set disable_notification:false (turn completion, permission
  // prompts, task results). Edits never notify, so they're unaffected.
  if (cfg.quietNotifications) {
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (SILENCEABLE.has(method)) {
        const p = payload as { disable_notification?: boolean };
        if (p.disable_notification === undefined) p.disable_notification = true;
      }
      return prev(method, payload, signal);
    });
  }

  const settings = new SettingsStore(cfg.dataDir);
  const store = new SessionStore(cfg.sessionsDir);
  const registry = new RuntimeRegistry(bot.api, acp, cfg, settings, store);
  const tasks = new TaskStore(cfg.dataDir);
  const taskRunner = new TaskRunner(bot.api, acp);
  const wizard = new TaskWizard(tasks);
  const statusPanel = new StatusPanel(bot.api, settings, registry);
  registry.setRefresher((chatId) => void statusPanel.refresh(chatId));

  const projects = new ProjectManager(cfg.projectRoots);
  const forum =
    cfg.topicGroupId !== undefined
      ? new ForumManager(bot.api, cfg, projects)
      : undefined;

  // Sibling bots + memory/topic actions for the agent telegram JSON bridge.
  const telegramBots = new TelegramBotService(bot.api, cfg);
  telegramBots.attachToBot(bot);
  registry.setBridge({
    store,
    forum,
    bots: telegramBots,
    // Cross-topic orchestration: General can create a topic and send_prompt there.
    // sessionId resumes a specific Grok session (memory follow-up) instead of
    // dumping into whatever is currently open in that topic.
    submitTopicPrompt: async ({
      threadId,
      cwd,
      projectName,
      prompt,
      newSession,
      sessionId,
      reportBack,
    }) => {
      if (cfg.topicGroupId === undefined) {
        throw new Error("TOPIC_GROUP_ID unset");
      }
      const groupId = cfg.topicGroupId;
      const controller = registry.forumController(groupId, threadId, cwd, projectName);
      // Explicit resume wins over newSession / foreground.
      if (sessionId) {
        const sw = await controller.addResume(sessionId, cwd, projectName);
        if (reportBack) sw.rt.setReportBack(reportBack);
        const outcome = await sw.rt.submit(textPrompt(prompt));
        return { outcome, sessionId: sw.rt.sessionId ?? sessionId };
      }
      if (newSession) {
        const rt = await controller.addNew(cwd, projectName);
        if (reportBack) rt.setReportBack(reportBack);
        const outcome = await rt.submit(textPrompt(prompt));
        return { outcome, sessionId: rt.sessionId };
      }
      const rt = controller.foreground();
      if (reportBack) rt.setReportBack(reportBack);
      const outcome = await rt.submit(textPrompt(prompt));
      return { outcome, sessionId: rt.sessionId };
    },
    // Child topic Done → wake General manager with a WORK REPORT.
    wakeManager: async ({ originChatId, originThreadId, prompt }) => {
      if (cfg.topicGroupId === undefined) {
        throw new Error("TOPIC_GROUP_ID unset");
      }
      const groupId = cfg.topicGroupId;
      // origin is always General in manager mode; bind workspace.
      const controller = registry.forumController(
        originChatId || groupId,
        originThreadId,
        cfg.workspace,
        "General",
      );
      const rt = controller.foreground();
      await rt.submit(
        textPrompt(prompt, undefined, undefined, { skipSelfRecheck: true }),
      );
    },
  });

  const deps: BotDeps = {
    api: bot.api,
    cfg,
    acp,
    registry,
    store,
    projects,
    menuCache: new MenuCache(),
    settings,
    statusPanel,
    ephemeral: new Ephemeral(bot.api, cfg.dataDir),
    tasks,
    taskRunner,
    wizard,
    stt: new SttService({
      apiUrl: cfg.sttApiUrl,
      apiKey: cfg.sttApiKey,
      model: cfg.sttModel,
      language: cfg.sttLanguage,
    }),
    usage: new UsageService(cfg.grokCliPath),
    accounts: new AccountManager(cfg.dataDir),
    forum,
  };

  // Auto-rotate-on-give-up: let a stuck turn cycle through other saved logins.
  registry.setAccountRotator(new AccountRotatorImpl(deps.accounts, acp));

  // Permission handling: default is auto-approve (prefer "this session" / always).
  // Interactive Approve/Deny buttons only when both trust-all and auto-approve are off.
  // Interactive prompts are pinned so they aren't lost in a busy chat; on
  // settle we re-pin the status panel (private chats keep a single pin).
  const autoApprovePerms = cfg.autoApprovePermissions || cfg.trustAllTools;
  const permissions = new PermissionService(bot.api, registry, autoApprovePerms, {
    onUnpinned: (chatId) => statusPanel.ensurePinned(chatId),
  });
  acp.permissionHandler = (p) => permissions.handle(p);

  const planExit = new PlanExitService(bot.api, registry, cfg.autoApprovePlan, (chatId) =>
    statusPanel.ensurePinned(chatId),
  );
  acp.planExitHandler = (params) => planExit.handle(params);

  const askUser = new AskUserService(
    bot.api,
    registry,
    cfg.autoApprovePlan && cfg.autoApprovePermissions,
  );
  acp.askUserHandler = (params) => askUser.handle(params);
  // /stop and /cancel must cancel pending interactive permissions for that
  // session only (ACP requires cancelled outcomes) — never kill the agent.
  acp.onSessionCancel = (sessionId) => {
    permissions.cancelForSession(sessionId);
  };

  // The bot pins/unpins the status panel, and Telegram emits a "pinned a
  // message" service message for each pin. Delete those so the chat stays clean
  // — registered BEFORE auth so these bot-authored updates never reach the gate.
  bot.on("message:pinned_message", (ctx) => void ctx.deleteMessage().catch(() => {}));

  bot.use(createAuthMiddleware(cfg));
  // Answer callback queries safely: never throw on stale IDs, auto-answer if a
  // handler forgets (prevents the loading spinner + unhandled 400 noise).
  bot.use(safeCallbackMiddleware());

  // Keep history clean: delete the user's command (/…) and persistent-bar
  // button taps INSTANTLY (before handlers) so slow ACP/CLI work never leaves
  // the raw slash sitting in chat. Handlers post bot status messages instead.
  // Plain prompts are adopted separately (see prompt-anchor.ts).
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/") || BAR_LABELS.includes(text)) {
      void ctx.deleteMessage().catch(() => {});
    }
    await next();
  });

  bot.callbackQuery(/^perm:(\d+):(\d+)$/, async (ctx) => {
    // resolveChoice unpins the prompt; we then rewrite it to the chosen label.
    const label = permissions.resolveChoice(ctx.match![1]!, Number(ctx.match![2]));
    await ctx.answerCallbackQuery({ text: label ?? "Expired" });
    await ctx
      .editMessageText(label ? `\u{1F510} ${label}` : "\u{1F510} (expired)", {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
  });

  bot.callbackQuery(/^permsw:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const sid = permissions.sessionFor(ctx.match![1]!);
    if (sid) await switchAndShow(ctx, deps, sid);
  });

  bot.callbackQuery(/^planx:(\d+):(ok|chg|no)$/, async (ctx) => {
    const toast = planExit.resolveChoice(ctx.match![1]!, ctx.match![2]!);
    await ctx.answerCallbackQuery({ text: toast ?? "Expired" });
  });

  bot.callbackQuery(/^asku:(\d+):(opt|next|prev|skip)(?::(.*))?$/, async (ctx) => {
    const toast = askUser.tap(ctx.match![1]!, ctx.match![2]!, ctx.match![3]);
    await ctx.answerCallbackQuery({ text: toast ?? "Expired" });
  });

  // Legacy complexity buttons (removed — agent decides; auto-plan if complex).
  bot.callbackQuery(/^cplx:(simple|complex)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Complexity is automatic now" });
    await ctx
      .editMessageText("\u2705 Complexity is decided by the agent automatically \u2014 just send your task.", {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
  });

  // Post-turn suggestion buttons on the Done message.
  bot.callbackQuery(/^sug:(\d+):(\d+)$/, async (ctx) => {
    const batchId = Number(ctx.match![1]);
    const index = Number(ctx.match![2]);
    const { resolveScope } = await import("./scope.js");
    const { adoptUserPrompt } = await import("./prompt-anchor.js");
    const { isGeneralThread } = await import("../forum/thread.js");
    const scope = resolveScope(ctx, deps);
    // General may have parallel sessions — find the runtime that owns this batch.
    const hit =
      scope.controller.takeSuggestionAnywhere(batchId, index) ??
      (() => {
        const t = scope.rt.takeSuggestion(batchId, index);
        return t ? { rt: scope.rt, text: t } : undefined;
      })();
    if (!hit) {
      await ctx.answerCallbackQuery({ text: "Suggestion expired", show_alert: true });
      return;
    }
    const { rt, text } = hit;
    await ctx.answerCallbackQuery({ text: "Sending\u2026" });
    // Dim the keyboard so double-taps don't re-fire.
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    try {
      const chatId = ctx.chat?.id;
      const isGeneral = isGeneralThread(scope.threadId);
      const sugMsgId = ctx.callbackQuery.message?.message_id;
      // General: keep chat clean — no anchor overwrite; continue same session
      // and reply to the message that carried the buttons.
      if (isGeneral) {
        if (rt.sessionId && sugMsgId !== undefined) {
          scope.controller.bindTelegramMessage(sugMsgId, rt.sessionId);
        }
        const outcome = await rt.submit(
          textPrompt(text, sugMsgId, undefined, { promptId: undefined }),
        );
        if (outcome === "queued") {
          const extra: Record<string, unknown> = { ...scope.threadExtra };
          if (sugMsgId !== undefined) {
            extra.reply_parameters = {
              message_id: sugMsgId,
              allow_sending_without_reply: true,
            };
          }
          await deps.api
            .sendMessage(chatId!, "\u{1F4E5} Queued on that thread.", extra)
            .catch(() => {});
        }
        return;
      }
      const anchor =
        chatId !== undefined
          ? await adoptUserPrompt(deps.api, {
              chatId,
              text,
              userMessageIds: [],
              messageThreadId: scope.threadExtra.message_thread_id,
              projectName: rt.projectName,
              prefix: "\u{1F4A1} Suggestion",
            })
          : undefined;
      const outcome = await rt.submit(
        textPrompt(text, anchor?.replyTo ?? ctx.callbackQuery.message?.message_id, undefined, {
          promptId: anchor?.promptId,
        }),
      );
      if (outcome === "queued") {
        const extra: Record<string, unknown> = { ...scope.threadExtra };
        if (anchor?.replyTo !== undefined) {
          extra.reply_parameters = {
            message_id: anchor.replyTo,
            allow_sending_without_reply: true,
          };
        }
        await ctx
          .reply(`\u{1F4E5} Queued suggestion (position ${rt.queueLength}).`, extra)
          .catch(() => {});
      }
    } catch (e) {
      await ctx
        .reply(`\u274C Couldn't run suggestion: ${(e as Error).message}`, scope.threadExtra)
        .catch(() => {});
    }
  });

  registerMenu(bot, deps); // persistent-keyboard buttons (hears)
  registerWizardInput(bot, deps); // wizard text input (before commands)
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message?.text ?? "";
    if (!text || text.startsWith("/")) return next();
    if (planExit.takeFeedback(ctx.chat.id, text)) return;
    await next();
  });
  if (forum) registerForum(bot, deps, forum);
  registerControl(bot, deps);
  registerProjects(bot, deps);
  registerSessions(bot, deps);
  registerImportSession(bot, deps);
  registerSessionKill(bot, deps);
  registerRunning(bot, deps);
  registerHistory(bot, deps);
  registerSystem(bot, deps);
  registerReauth(bot, deps);
  registerAccounts(bot, deps);
  registerUsage(bot, deps);
  registerKill(bot, deps);
  registerMcp(bot, deps);
  registerTasks(bot, deps);
  registerPhotos(bot, deps); // photos & image documents
  registerDocuments(bot, deps); // non-image files (text inlined, binaries saved)
  registerVoice(bot, deps); // voice / audio -> transcription -> prompt
  registerGrokSlash(bot, deps); // Grok Build /goal /plan /compact … + catch-all
  registerMessages(bot, deps); // catch-all text prompt — keep last

  bot.catch((err) => {
    // Stale callback answers are expected when the bot was busy past Telegram's
    // ~timeout — middleware already swallows most of them; keep noise out of ERROR.
    if (isStaleCallbackError(err.error)) {
      log.debug("stale callback query:", err.error instanceof Error ? err.error.message : err.error);
      return;
    }
    const e = err.error;
    if (e instanceof Error) {
      // Include Grammy error_code when present (429 / 403 / 409, etc.) for diagnosis.
      const codeNum = (e as unknown as { error_code?: number }).error_code;
      const code = typeof codeNum === "number" ? ` (code ${codeNum})` : "";
      log.error(`unhandled bot error${code}:`, e.stack || e.message);
    } else {
      log.error("unhandled bot error:", e);
    }
    // Never rethrow — a middleware failure must not take down long polling.
  });

  // Scoped command menus: private = full sorted list; groups = short list with
  // cancel/menu first (reply keyboard is unreliable in forum topics).
  const registerCommands = async (
    commands: typeof COMMANDS,
    scope?: { type: string; chat_id?: number },
    label = "default",
  ): Promise<void> => {
    try {
      await bot.api.setMyCommands(commands, scope ? { scope: scope as never } : undefined);
    } catch (e) {
      log.warn(`setMyCommands (${label}) failed:`, (e as Error).message);
    }
  };
  await registerCommands(COMMANDS, undefined, "default");
  await registerCommands(COMMANDS, { type: "all_private_chats" }, "private");
  await registerCommands(GROUP_COMMANDS, { type: "all_group_chats" }, "groups");
  if (cfg.topicGroupId !== undefined) {
    await registerCommands(
      GROUP_COMMANDS,
      { type: "chat", chat_id: cfg.topicGroupId },
      `chat:${cfg.topicGroupId}`,
    );
  }

  const updater = new Updater({
    enabled: cfg.autoUpdate,
    intervalMs: cfg.updateCheckMs,
    projectRoot: cfg.projectRoot,
    instanceDir: INSTANCE_DIR,
    dataDir: cfg.dataDir,
    isPromptInFlight: () => acp.hasInflightPrompt(),
    otherActiveSessions: () => store.listActive().filter((s) => s.lockPid !== acp.pid).length,
    announce: async (text, markdown) => {
      for (const id of settings.chatIds()) {
        try {
          if (markdown) await sendMarkdownDoc(bot.api, id, text, { loud: true });
          else await bot.api.sendMessage(id, text, { disable_notification: false });
        } catch {
          /* per-chat best-effort */
        }
      }
    },
    shutdown: async () => {
      try {
        await bot.stop();
      } catch {
        /* ignore */
      }
      try {
        acp.stop();
      } catch {
        /* ignore */
      }
    },
  });

  // Remove any navigation surface left over from before a restart.
  void deps.ephemeral.cleanupAll().catch(() => {});

  // Forum project topics: ensure AI Chat + optional catalog topics (best-effort).
  if (forum) {
    void forum.ensureSetup().catch((e) => {
      log.warn(`forum setup failed: ${(e as Error).message}`);
    });
  }

  return { bot, registry, scheduler: new Scheduler(tasks, taskRunner), updater };
}
