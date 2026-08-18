/**
 * One Telegram bot surface: grammY bot, per-bot stores, handlers.
 * Several surfaces share one Grok ACP host (see host.ts).
 */
import { Bot } from "grammy";
import type { BotTokenSpec } from "../app/bot-tokens.js";
import { SettingsStore } from "../app/settings-store.js";
import { createLogger } from "../logger.js";
import { createAuthMiddleware } from "./auth.js";
import { isStaleCallbackError, safeCallbackMiddleware } from "./callback.js";
import { COMMANDS } from "./commands.js";
import { type BotDeps, MenuCache } from "./deps.js";
import { registerAccounts } from "./handlers/accounts.js";
import { registerReauth } from "./handlers/auth.js";
import { registerControl } from "./handlers/control.js";
import { registerDocuments } from "./handlers/document.js";
import { registerHistory } from "./handlers/history.js";
import { registerKill } from "./handlers/kill.js";
import { registerMcp } from "./handlers/mcp.js";
import { registerMenu } from "./handlers/menu.js";
import { registerMessages } from "./handlers/message.js";
import { registerPhotos } from "./handlers/photo.js";
import { registerProjects } from "./handlers/projects.js";
import { registerRunning, switchAndShow } from "./handlers/running.js";
import { registerSessionKill } from "./handlers/session-kill.js";
import { registerSessions } from "./handlers/sessions.js";
import { registerSystem } from "./handlers/system.js";
import { registerTasks, registerWizardInput } from "./handlers/tasks.js";
import { registerUsage } from "./handlers/usage.js";
import { registerVoice } from "./handlers/voice.js";
import type { BotHost } from "./host.js";
import { Ephemeral } from "./menu/ephemeral.js";
import { BAR_LABELS } from "./menu/keyboard.js";
import { StatusPanel } from "./menu/status-panel.js";
import { PermissionService } from "./permission-service.js";
import { PlanExitService } from "./plan-exit-service.js";
import { RuntimeRegistry } from "./registry.js";
import { TaskWizard } from "./wizard/task-wizard.js";

const log = createLogger("surface");

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

export interface BotSurface {
  spec: BotTokenSpec;
  bot: Bot;
  botId: number;
  username?: string;
  registry: RuntimeRegistry;
  settings: SettingsStore;
  permissions: PermissionService;
  planExit: PlanExitService;
  ephemeral: Ephemeral;
}

export async function createSurface(host: BotHost, spec: BotTokenSpec): Promise<BotSurface> {
  const { cfg, acp } = host;
  const bot = new Bot(spec.token);

  if (cfg.quietNotifications) {
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (SILENCEABLE.has(method)) {
        const p = payload as { disable_notification?: boolean };
        if (p.disable_notification === undefined) p.disable_notification = true;
      }
      return prev(method, payload, signal);
    });
  }

  const me = await bot.api.getMe();
  const namespace = spec.primary ? undefined : String(me.id);
  const surfaceBotId = spec.primary ? undefined : me.id;

  const settings = new SettingsStore(cfg.dataDir, namespace);
  const registry = new RuntimeRegistry(bot.api, acp, cfg, settings, host.store, { listenToAcp: false });
  const wizard = new TaskWizard(host.tasks, surfaceBotId);
  const statusPanel = new StatusPanel(bot.api, settings, registry);
  registry.setRefresher((chatId) => void statusPanel.refresh(chatId));
  registry.setAccountRotator(host.rotator);
  host.taskRunner.registerApi(bot.api, surfaceBotId);

  const autoApprovePerms = cfg.autoApprovePermissions || cfg.trustAllTools;
  const permissions = new PermissionService(bot.api, registry, autoApprovePerms, {
    onUnpinned: (chatId) => statusPanel.ensurePinned(chatId),
  });
  const planExit = new PlanExitService(bot.api, cfg.autoApprovePlan, (chatId) =>
    statusPanel.ensurePinned(chatId),
  );

  const surface: BotSurface = {
    spec,
    bot,
    botId: me.id,
    username: me.username,
    registry,
    settings,
    permissions,
    planExit,
    ephemeral: new Ephemeral(bot.api, cfg.dataDir, namespace),
  };

  const deps: BotDeps = {
    api: bot.api,
    token: spec.token,
    botId: surfaceBotId,
    botLabel: spec.label,
    sessionHome: (sessionId) => sessionHomeOf(host, surface, sessionId),
    cfg,
    acp,
    registry,
    store: host.store,
    projects: host.projects,
    menuCache: new MenuCache(),
    settings,
    statusPanel,
    ephemeral: surface.ephemeral,
    tasks: host.tasks,
    taskRunner: host.taskRunner,
    wizard,
    stt: host.stt,
    usage: host.usage,
    accounts: host.accounts,
  };

  bot.on("message:pinned_message", (ctx) => void ctx.deleteMessage().catch(() => {}));
  bot.use(createAuthMiddleware(cfg));
  bot.use(safeCallbackMiddleware());

  bot.on("message:text", async (ctx, next) => {
    await next();
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/") || BAR_LABELS.includes(text)) {
      await ctx.deleteMessage().catch(() => {});
    }
  });

  bot.callbackQuery(/^perm:(\d+):(\d+)$/, async (ctx) => {
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

  registerMenu(bot, deps);
  registerWizardInput(bot, deps);
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message?.text ?? "";
    if (!text || text.startsWith("/")) return next();
    if (planExit.takeFeedback(ctx.chat.id, text)) return;
    await next();
  });
  registerControl(bot, deps);
  registerProjects(bot, deps);
  registerSessions(bot, deps);
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
  registerPhotos(bot, deps);
  registerDocuments(bot, deps);
  registerVoice(bot, deps);
  registerMessages(bot, deps);

  bot.catch((err) => {
    if (isStaleCallbackError(err.error)) {
      log.debug("stale callback query:", err.error instanceof Error ? err.error.message : err.error);
      return;
    }
    log.error("unhandled bot error:", err.error instanceof Error ? err.error.message : err.error);
  });

  try {
    await bot.api.setMyCommands(COMMANDS);
  } catch (e) {
    log.warn(`setMyCommands failed (@${me.username ?? spec.label}):`, (e as Error).message);
  }

  void surface.ephemeral.cleanupAll().catch(() => {});
  log.info(`surface ${spec.label} online as @${me.username ?? "?"} (${me.id})`);
  return surface;
}

function sessionHomeOf(host: BotHost, from: BotSurface, sessionId: string): "this" | "other" | undefined {
  if (ownsSession(from, sessionId)) return "this";
  if (host.surfaces.some((s) => s !== from && ownsSession(s, sessionId))) return "other";
  return undefined;
}

function ownsSession(surface: BotSurface, sessionId: string): boolean {
  return surface.registry.isControlledSession(sessionId) || surface.settings.hasSession(sessionId);
}
