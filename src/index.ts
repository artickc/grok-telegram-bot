/**
 * Grok Telegram Bot — entry point.
 * Starts the Grok ACP bridge (`grok agent stdio`), the Telegram bot, and wires
 * graceful shutdown between them.
 */
import { GrokClient } from "./grok/client.js";
import { createBot } from "./bot/bot.js";
import { CANONICAL_DIR, loadConfig } from "./config.js";
import { InstanceLock } from "./app/instance-lock.js";
import { join } from "node:path";
import { createLogger, enableFileLogging, setLogLevel } from "./logger.js";

async function main(): Promise<void> {
  process.stdout.write("\u{1F916} Grok Telegram Bot — starting…\n");

  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  enableFileLogging(cfg.logFile);
  const log = createLogger("main");

  // Single-instance guard: kill any ghost/duplicate already polling this token.
  const lock = new InstanceLock(cfg.token, join(CANONICAL_DIR, "locks"), process.env.GROK_TG_SUPERVISED === "1");
  if (cfg.singleInstance && !(await lock.acquire())) {
    process.stdout.write(
      "\u26D4 Another Grok Telegram Bot is already running for this token (a background service). Use `grok-tg restart`, or `grok-tg stop` first.\n",
    );
    process.exit(0);
  }

  log.info("starting Grok Telegram Bot");
  log.info(`workspace: ${cfg.workspace}`);
  log.info(`grok:      ${cfg.grokCliPath}`);
  log.info(`sessions:  ${cfg.sessionsDir}`);
  log.info(`log file:  ${cfg.logFile}`);

  const grok = new GrokClient({
    grokCliPath: cfg.grokCliPath,
    workspace: cfg.workspace,
    sessionsDir: cfg.sessionsDir,
    trustAllTools: cfg.trustAllTools,
    apiKey: cfg.grokApiKey,
    model: cfg.grokModel,
    autoRestart: cfg.grokAutoRestart,
    promptIdleTimeoutMs: cfg.promptIdleMs,
  });

  await grok.start();
  const { bot, registry, scheduler, updater } = await createBot(cfg, grok);
  scheduler.start();
  await updater.start();

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down…");
    scheduler.stop();
    updater.stop();
    registry.disposeAll();
    void bot.stop().catch(() => {});
    grok.stop();
    lock.release();
    setTimeout(() => process.exit(code), 500);
  };

  grok.on("restarted", () => log.info("Grok bridge re-bound; sessions continue on next message."));

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("uncaughtException", (err) => log.error("uncaughtException:", err));
  process.on("unhandledRejection", (err) => log.error("unhandledRejection:", err));

  await bot.start({
    onStart: (info) => {
      log.info(`bot online as @${info.username}`);
      process.stdout.write(`\u2705 Online as @${info.username}. Send it a message on Telegram.\n`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
