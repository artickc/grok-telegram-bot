/**
 * Host: one Grok ACP client, one scheduler, N Telegram bot surfaces.
 */
import type { GrokClient } from "../grok/client.js";
import { AccountManager } from "../app/accounts.js";
import { SttService } from "../app/stt.js";
import { Updater } from "../app/updater.js";
import { UsageService } from "../app/usage.js";
import type { AppConfig } from "../config.js";
import { INSTANCE_DIR } from "../config.js";
import { createLogger } from "../logger.js";
import { ProjectManager } from "../projects/manager.js";
import { SessionStore } from "../sessions/store.js";
import { TaskRunner } from "../tasks/runner.js";
import { Scheduler } from "../tasks/scheduler.js";
import { TaskStore } from "../tasks/store.js";
import { AccountRotatorImpl } from "./account-rotator.js";
import { autoDecideSession } from "./permission-service.js";
import { createSurface, type BotSurface } from "./surface.js";
import { sendMarkdownDoc } from "./telegram-io.js";

const log = createLogger("host");

export interface BotHost {
  cfg: AppConfig;
  acp: GrokClient;
  store: SessionStore;
  projects: ProjectManager;
  tasks: TaskStore;
  taskRunner: TaskRunner;
  stt: SttService;
  usage: UsageService;
  accounts: AccountManager;
  rotator: AccountRotatorImpl;
  surfaces: BotSurface[];
}

export interface BotBundle {
  surfaces: BotSurface[];
  scheduler: Scheduler;
  updater: Updater;
}

export async function createBots(cfg: AppConfig, acp: GrokClient): Promise<BotBundle> {
  const tasks = new TaskStore(cfg.dataDir);
  const taskRunner = new TaskRunner(acp);
  const accounts = new AccountManager(cfg.dataDir);
  const host: BotHost = {
    cfg,
    acp,
    store: new SessionStore(cfg.sessionsDir),
    projects: new ProjectManager(cfg.projectRoots),
    tasks,
    taskRunner,
    stt: new SttService({
      apiUrl: cfg.sttApiUrl,
      apiKey: cfg.sttApiKey,
      model: cfg.sttModel,
      language: cfg.sttLanguage,
    }),
    usage: new UsageService(cfg.grokCliPath),
    accounts,
    rotator: new AccountRotatorImpl(accounts, acp),
    surfaces: [],
  };

  for (const spec of cfg.bots) {
    host.surfaces.push(await createSurface(host, spec));
  }
  log.info(
    `surfaces: ${host.surfaces.map((s) => `${s.spec.label}=@${s.username ?? "?"}`).join(", ")}`,
  );

  wireAcp(host);
  const updater = createUpdater(host);
  return { surfaces: host.surfaces, scheduler: new Scheduler(tasks, taskRunner), updater };
}

function wireAcp(host: BotHost): void {
  host.acp.permissionHandler = (p) => {
    const owner = host.surfaces.find((s) => s.registry.describeSession(p.sessionId).chatId !== undefined);
    if (owner) return owner.permissions.handle(p);
    const fallback = host.surfaces[0];
    return fallback ? fallback.permissions.handle(p) : Promise.resolve(autoDecideSession(p));
  };

  // Headless: auto-approve plan-mode exit so Grok does not sit in the TUI
  // "approve plan" gate. Notify the owning Telegram chat (best-effort).
  host.acp.planExitHandler = async ({ params }) => {
    const sessionId =
      (typeof params.sessionId === "string" && params.sessionId) ||
      (typeof params.session_id === "string" && params.session_id) ||
      "";
    const planText =
      (typeof params.plan_content === "string" && params.plan_content) ||
      (typeof params.planContent === "string" && params.planContent) ||
      (typeof params.content === "string" && params.content) ||
      "";
    const preview = planText.replace(/\s+/g, " ").trim().slice(0, 280);
    const body = preview
      ? `\u{1F4CB} Plan approved (exit plan mode).\n\n${preview}${planText.length > 280 ? "\u2026" : ""}`
      : "\u{1F4CB} Plan approved \u2014 leaving plan mode and implementing.";
    if (sessionId) {
      for (const surface of host.surfaces) {
        const chatId = surface.registry.describeSession(sessionId).chatId;
        if (chatId === undefined) continue;
        void surface.bot.api.sendMessage(chatId, body, { disable_notification: true }).catch(() => {});
        break;
      }
    }
    return { outcome: "approved" as const, feedback: "" };
  };

  host.acp.on("subagents", (subagents, pending) => {
    const busy = host.surfaces.filter((s) => s.registry.hasActiveTurn());
    const attributer = busy.length === 1 ? busy[0] : undefined;
    for (const surface of host.surfaces) {
      surface.registry.handleSubagents(subagents, pending, surface === attributer);
    }
  });
}

function createUpdater(host: BotHost): Updater {
  const { cfg, acp, store } = host;
  return new Updater({
    enabled: cfg.autoUpdate,
    intervalMs: cfg.updateCheckMs,
    projectRoot: cfg.projectRoot,
    instanceDir: INSTANCE_DIR,
    dataDir: cfg.dataDir,
    isPromptInFlight: () => acp.hasInflightPrompt(),
    otherActiveSessions: () => store.listActive().filter((s) => s.lockPid !== acp.pid).length,
    announce: async (text, markdown) => {
      for (const surface of host.surfaces) {
        for (const id of surface.settings.chatIds()) {
          try {
            if (markdown) await sendMarkdownDoc(surface.bot.api, id, text, { loud: true });
            else await surface.bot.api.sendMessage(id, text, { disable_notification: false });
          } catch {
            /* per-chat best-effort */
          }
        }
      }
    },
    shutdown: async () => {
      for (const surface of host.surfaces) {
        try {
          await surface.bot.stop();
        } catch {
          /* ignore */
        }
      }
      try {
        acp.stop();
      } catch {
        /* ignore */
      }
    },
  });
}


