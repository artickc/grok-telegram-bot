/**
 * Grok Telegram Bot — entry point.
 * Starts the Grok ACP bridge (`grok agent stdio`), one or more Telegram bots,
 * and wires graceful shutdown between them.
 */
import { GrokClient } from "./grok/client.js";
import { createBots } from "./bot/bot.js";
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

  const supervised = process.env.GROK_TG_SUPERVISED === "1";
  const locks: InstanceLock[] = [];
  if (cfg.singleInstance) {
    for (const spec of cfg.bots) {
      const lock = new InstanceLock(spec.token, join(CANONICAL_DIR, "locks"), supervised);
      if (!(await lock.acquire())) {
        for (const held of locks) held.release();
        process.stdout.write(
          `\u26D4 Another Grok Telegram Bot is already polling ${spec.envKey} (a background service). Use \`grok-tg restart\`, or \`grok-tg stop\` first.\n`,
        );
        process.exit(0);
      }
      locks.push(lock);
    }
  }

  log.info("starting Grok Telegram Bot");
  log.info(`workspace: ${cfg.workspace}`);
  log.info(`grok:      ${cfg.grokCliPath}`);
  log.info(`sessions:  ${cfg.sessionsDir}`);
  log.info(`log file:  ${cfg.logFile}`);
  log.info(`bots:      ${cfg.bots.map((b) => b.envKey).join(", ")}`);

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
  const { surfaces, scheduler, updater } = await createBots(cfg, grok);
  scheduler.start();
  await updater.start();

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down…");
    scheduler.stop();
    updater.stop();
    for (const surface of surfaces) surface.registry.disposeAll();
    for (const surface of surfaces) void surface.bot.stop().catch(() => {});
    grok.stop();
    for (const lock of locks) lock.release();
    setTimeout(() => process.exit(code), 500);
  };

  grok.on("restarted", () => log.info("Grok bridge re-bound; sessions continue on next message."));

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("uncaughtException", (err) => log.error("uncaughtException:", err));
  process.on("unhandledRejection", (err) => log.error("unhandledRejection:", err));

  await Promise.all(
    surfaces.map((surface) =>
      surface.bot.start({
        onStart: (info) => {
          log.info(`bot online as @${info.username} (${surface.spec.envKey})`);
          process.stdout.write(`\u2705 Online as @${info.username} [${surface.spec.label}]. Send it a message on Telegram.\n`);
        },
      }),
    ),
  );
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
