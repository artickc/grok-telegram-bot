/**
 * Grok Telegram Bot — entry point.
 * Starts the Grok ACP bridge (`grok agent stdio`), the Telegram bot, and wires
 * graceful shutdown between them.
 *
 * Lifetime rules (critical):
 *  - Prefer staying up over clean-but-dead exits.
 *  - Uncaught errors are logged; the process keeps polling Telegram.
 *  - grammY long-poll is restarted on transport/network death.
 *  - Supervised launches (GROK_TG_SUPERVISED=1 / service) may exit for relaunch;
 *    bare/manual runs re-exec when possible rather than dying silently.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Bot } from "grammy";
import { GrokClient } from "./grok/client.js";
import { createBot } from "./bot/bot.js";
import { CANONICAL_DIR, INSTANCE_DIR, loadConfig } from "./config.js";
import { InstanceLock } from "./app/instance-lock.js";
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
    const msg =
      "Another Grok Telegram Bot is already running for this token (a background service). Use `grok-tg restart`, or `grok-tg stop` first.";
    log.warn(msg);
    process.stdout.write(`\u26D4 ${msg}\n`);
    process.exit(0);
  }

  log.info("starting Grok Telegram Bot");
  log.info(`workspace: ${cfg.workspace}`);
  log.info(`grok:      ${cfg.grokCliPath}`);
  log.info(`sessions:  ${cfg.sessionsDir}`);
  log.info(`log file:  ${cfg.logFile}`);

  // Never die silently from stray exceptions — a dead bot is worse than a
  // partially inconsistent one. Registering these handlers overrides Node's
  // default "print and exit" for uncaughtException.
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException (process stays up):", err);
  });
  process.on("unhandledRejection", (reason) => {
    log.error(
      "unhandledRejection (process stays up):",
      reason instanceof Error ? reason : String(reason),
    );
  });

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

  // Retry ACP connect — agent crash at boot should not kill the Telegram bot.
  for (let attempt = 1; ; attempt++) {
    try {
      await grok.start();
      break;
    } catch (e) {
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 5));
      log.error(`Grok ACP start failed (attempt ${attempt}): ${(e as Error).message}; retry in ${wait}ms`);
      await sleep(wait);
    }
  }

  // createBot can fail on transient Telegram API issues — retry rather than die.
  let bot: Bot;
  let registry: Awaited<ReturnType<typeof createBot>>["registry"];
  let scheduler: Awaited<ReturnType<typeof createBot>>["scheduler"];
  let updater: Awaited<ReturnType<typeof createBot>>["updater"];
  for (let attempt = 1; ; attempt++) {
    try {
      const bundle = await createBot(cfg, grok);
      bot = bundle.bot;
      registry = bundle.registry;
      scheduler = bundle.scheduler;
      updater = bundle.updater;
      break;
    } catch (e) {
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 5));
      log.error(`createBot failed (attempt ${attempt}): ${(e as Error).message}; retry in ${wait}ms`);
      await sleep(wait);
    }
  }

  scheduler!.start();
  await updater!.start();

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down…");
    try {
      scheduler!.stop();
    } catch {
      /* ignore */
    }
    try {
      updater!.stop();
    } catch {
      /* ignore */
    }
    try {
      registry!.disposeAll();
    } catch {
      /* ignore */
    }
    void bot!.stop().catch(() => {});
    grok.stop();
    lock.release();
    setTimeout(() => process.exit(code), 500);
  };

  grok.on("restarted", () => log.info("Grok bridge re-bound; sessions continue on next message."));

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  // Refresh the single-instance lock periodically so a long-running process
  // stays clearly "alive" on disk (start time + pid).
  const lockHeartbeat = setInterval(() => {
    try {
      if (!shuttingDown) lock.touch();
    } catch {
      /* non-fatal */
    }
  }, 60_000);
  lockHeartbeat.unref?.();

  // Keep long-polling forever. On network / 409 / grammY fatal, wait and restart
  // the poller instead of ending the process (silent death was a critical bug).
  // If the inner loop still returns without shutdown, attempt self-relaunch; if
  // that fails, resume polling rather than dying.
  while (!shuttingDown) {
    await runPollingForever(bot!, log, () => shuttingDown);
    if (shuttingDown) break;
    log.error("Telegram polling loop exited unexpectedly; attempting self-relaunch");
    const replaced = await selfRelaunch(cfg.projectRoot, log);
    if (replaced) {
      clearInterval(lockHeartbeat);
      shutdown(1);
      return;
    }
    log.error("self-relaunch failed; resuming Telegram polling in 5s");
    await sleep(5000);
  }
  clearInterval(lockHeartbeat);
}

/** grammY start with automatic recovery. */
async function runPollingForever(
  bot: Bot,
  log: ReturnType<typeof createLogger>,
  isShuttingDown: () => boolean,
): Promise<void> {
  let attempt = 0;
  while (!isShuttingDown()) {
    try {
      attempt = 0;
      await bot.start({
        onStart: (info) => {
          log.info(`bot online as @${info.username}`);
          process.stdout.write(`\u2705 Online as @${info.username}. Send it a message on Telegram.\n`);
        },
      });
      // bot.start resolves when polling is stopped (bot.stop).
      if (isShuttingDown()) return;
      log.warn("bot.start resolved without shutdown; restarting polling in 2s");
      await sleep(2000);
    } catch (e) {
      attempt++;
      const wait = Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5));
      log.error(
        `Telegram polling failed (attempt ${attempt}): ${(e as Error).message}; retry in ${wait}ms`,
      );
      try {
        await bot.stop();
      } catch {
        /* ignore */
      }
      await sleep(wait);
    }
  }
}

/**
 * Spawn a fresh bot process then let the caller exit (manual / non-supervised).
 * Returns true when a replacement was started (or supervised exit is expected).
 */
async function selfRelaunch(projectRoot: string, log: ReturnType<typeof createLogger>): Promise<boolean> {
  if (process.env.GROK_TG_SUPERVISED === "1") {
    log.info("supervised mode — exiting for external relaunch");
    return true;
  }
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(projectRoot, "src", "index.ts"), "--instance", INSTANCE_DIR],
      { detached: true, stdio: "ignore", cwd: projectRoot, env: process.env },
    );
    child.unref();
    if (!child.pid) {
      log.error("self-relaunch spawn produced no pid — staying alive");
      return false;
    }
    log.info(`spawned replacement pid ${child.pid}`);
    return true;
  } catch (e) {
    log.error(`self-relaunch failed: ${(e as Error).message} — staying alive`);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.stack || err.message : err);
  // Delay exit so logs flush; VBS restart loop / supervisor can bring us back.
  setTimeout(() => process.exit(1), 1000);
});
