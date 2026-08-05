/**
 * Grok Telegram Bot — entry point.
 * Starts the Grok ACP bridge (`grok agent stdio`), the Telegram bot, and wires
 * graceful shutdown between them.
 *
 * Lifetime rules (critical):
 *  - Prefer staying up over clean-but-dead exits.
 *  - Uncaught errors are logged; the process keeps polling Telegram.
 *  - grammY long-poll is restarted on transport/network death, 429, 409, etc.
 *  - Never exit without a clear stderr + log line.
 *  - Interactive `npm start` stays in-process (no silent detach re-exec).
 *  - Supervised launches (GROK_TG_SUPERVISED=1) may exit for external relaunch.
 */
import { join } from "node:path";
import type { Bot } from "grammy";
import { GrammyError, HttpError } from "grammy";
import { GrokClient } from "./grok/client.js";
import { createBot } from "./bot/bot.js";
import { CANONICAL_DIR, loadConfig } from "./config.js";
import { InstanceLock } from "./app/instance-lock.js";
import {
  isIntentionalShutdown,
  markIntentionalShutdown,
} from "./app/lifetime-flag.js";
import { createLogger, enableFileLogging, setLogLevel } from "./logger.js";

/** Last known reason for process end (read by exit/beforeExit handlers). */
let exitReason = "unknown";
/** Intentional exit in progress (SIGINT, fatal, lock, supervised relaunch). */
let shuttingDown = false;
/** beforeExit keep-alive armed at most once (avoid infinite 60s re-arm spam). */
let beforeExitKeepalive: ReturnType<typeof setInterval> | undefined;
/** Set immediately after config load; used by scream/shutdown. */
let log!: ReturnType<typeof createLogger>;

function noteExit(reason: string): void {
  exitReason = reason;
}

function beginShutdown(reason: string): void {
  shuttingDown = true;
  markIntentionalShutdown(reason);
  noteExit(reason);
  if (beforeExitKeepalive) {
    clearInterval(beforeExitKeepalive);
    beforeExitKeepalive = undefined;
  }
}

function scream(msg: string): void {
  try {
    process.stderr.write(`${msg}\n`);
  } catch {
    /* ignore */
  }
  try {
    process.stdout.write(`${msg}\n`);
  } catch {
    /* ignore */
  }
  try {
    log?.error(msg);
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  process.stdout.write("\u{1F916} Grok Telegram Bot — starting…\n");

  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  enableFileLogging(cfg.logFile);
  log = createLogger("main");

  // Always leave a trail — silent process death was the top reliability bug.
  process.on("exit", (code) => {
    const line = `[main] process exit code=${code} reason=${exitReason}`;
    try {
      // File logger may already be gone; still try console.
      console.error(line);
    } catch {
      /* ignore */
    }
  });
  process.on("beforeExit", (code) => {
    // Never fight an intentional shutdown / fatal exit / updater re-exec.
    if (shuttingDown || isIntentionalShutdown()) return;
    if (beforeExitKeepalive) return; // already holding the process open
    // Event loop emptied without an intentional shutdown — keep a handle alive
    // so we don't vanish with code 0 and no explanation.
    scream(
      `\u26A0\uFE0F Event loop emptying (beforeExit code=${code}, reason=${exitReason}). ` +
        `Keeping process alive — this usually means polling stopped unexpectedly.`,
    );
    noteExit(`beforeExit:${exitReason}`);
    // One ref'd interval (not stacking setTimeouts that re-fire beforeExit forever).
    beforeExitKeepalive = setInterval(() => {
      if (shuttingDown || isIntentionalShutdown()) {
        if (beforeExitKeepalive) clearInterval(beforeExitKeepalive);
        return;
      }
      log?.warn(`beforeExit keepalive still holding process (reason=${exitReason})`);
    }, 60_000);
    beforeExitKeepalive.ref?.();
  });

  // Single-instance guard: kill any ghost/duplicate already polling this token.
  const lock = new InstanceLock(cfg.token, join(CANONICAL_DIR, "locks"), process.env.GROK_TG_SUPERVISED === "1");
  if (cfg.singleInstance && !(await lock.acquire())) {
    const msg =
      "Another Grok Telegram Bot is already running for this token (a background service). Use `grok-tg restart`, or `grok-tg stop` first.";
    beginShutdown("instance-lock-held");
    log.warn(msg);
    scream(`\u26D4 ${msg}`);
    process.exit(1);
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
    noteExit(`uncaughtException:${err.message}`);
    log.error("uncaughtException (process stays up):", err);
    scream(`\u26A0\uFE0F uncaughtException (staying up): ${err.stack || err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    noteExit(`unhandledRejection:${msg.slice(0, 120)}`);
    log.error("unhandledRejection (process stays up):", reason instanceof Error ? reason : String(reason));
    scream(`\u26A0\uFE0F unhandledRejection (staying up): ${msg}`);
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
      scream(`\u26A0\uFE0F Grok ACP start failed (attempt ${attempt}): ${(e as Error).message}; retry in ${wait}ms`);
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
      const detail = formatTelegramError(e);
      log.error(`createBot failed (attempt ${attempt}): ${detail}; retry in ${wait}ms`);
      scream(`\u26A0\uFE0F createBot failed (attempt ${attempt}): ${detail}; retry in ${wait}ms`);
      await sleep(wait);
    }
  }

  scheduler!.start();
  await updater!.start();

  const shutdown = (code: number, reason: string): void => {
    if (shuttingDown) return;
    beginShutdown(reason);
    log.info(`shutting down (code=${code}, reason=${reason})…`);
    scream(`\u{1F6D1} Shutting down (code=${code}, reason=${reason})`);
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

  process.on("SIGINT", () => shutdown(0, "SIGINT"));
  process.on("SIGTERM", () => shutdown(0, "SIGTERM"));

  // Keepalive + lock heartbeat — REF'd so the process cannot exit with an empty
  // event loop while we still intend to run (unref was a silent-death footgun).
  let botUsername = "?";
  const keepalive = setInterval(() => {
    try {
      if (shuttingDown || isIntentionalShutdown()) return;
      lock.touch();
      log.info(
        `keepalive: alive as @${botUsername} polling=${bot!.isRunning()} ` +
          `pid=${process.pid} uptime=${Math.floor(process.uptime())}s`,
      );
    } catch (e) {
      log.warn(`keepalive tick failed: ${(e as Error).message}`);
    }
  }, 5 * 60_000);
  // Explicitly ref — do not unref.
  keepalive.ref?.();

  // Keep long-polling forever. On network / 409 / 429 / grammY fatal, wait and
  // restart the poller in-process. Interactive runs never detach-relaunch
  // (that looked like a silent death in the terminal).
  while (!shuttingDown && !isIntentionalShutdown()) {
    await runPollingForever(
      bot!,
      log,
      () => shuttingDown || isIntentionalShutdown(),
      (name) => {
        botUsername = name;
      },
    );
    if (shuttingDown || isIntentionalShutdown()) break;

    // runPollingForever should only return when shuttingDown; if not, recover.
    scream("\u26A0\uFE0F Telegram polling loop returned unexpectedly; recovering in-process");
    log.error("Telegram polling loop returned unexpectedly; recovering in-process (no silent exit)");
    noteExit("polling-loop-returned");

    if (process.env.GROK_TG_SUPERVISED === "1") {
      log.info("supervised mode — exiting for external relaunch");
      noteExit("supervised-relaunch");
      clearInterval(keepalive);
      shutdown(1, "supervised-relaunch");
      return;
    }

    // Stay in this process — re-enter polling after a short pause.
    await sleep(3000);
  }
  clearInterval(keepalive);
}

/** grammY start with automatic recovery and loud classification of API errors. */
async function runPollingForever(
  bot: Bot,
  log: ReturnType<typeof createLogger>,
  isShuttingDown: () => boolean,
  onOnline: (username: string) => void,
): Promise<void> {
  let attempt = 0;
  while (!isShuttingDown()) {
    try {
      attempt = 0;
      await bot.start({
        onStart: (info) => {
          onOnline(info.username);
          log.info(`bot online as @${info.username}`);
          process.stdout.write(`\u2705 Online as @${info.username}. Send it a message on Telegram.\n`);
        },
      });
      // bot.start resolves when polling is stopped (bot.stop) or loop ends.
      if (isShuttingDown()) return;
      log.warn("bot.start resolved without shutdown; restarting polling in 2s");
      scream("\u26A0\uFE0F bot.start resolved without shutdown; restarting polling in 2s");
      await sleep(2000);
    } catch (e) {
      attempt++;
      const classified = classifyPollingError(e);
      const wait = classified.waitMs ?? Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5));
      const line =
        `Telegram polling failed (attempt ${attempt}, ${classified.kind}): ${classified.message}; ` +
        `retry in ${wait}ms`;
      log.error(line);
      scream(`\u26A0\uFE0F ${line}`);
      try {
        await bot.stop();
      } catch {
        /* ignore */
      }
      await sleep(wait);
    }
  }
}

function classifyPollingError(e: unknown): { kind: string; message: string; waitMs?: number } {
  const message = formatTelegramError(e);
  if (e instanceof GrammyError) {
    if (e.error_code === 429) {
      const ra = e.parameters?.retry_after;
      const waitMs = typeof ra === "number" ? (ra + 1) * 1000 : 10_000;
      return { kind: "429-rate-limit", message, waitMs };
    }
    if (e.error_code === 409) {
      return {
        kind: "409-conflict",
        message: `${message} (another getUpdates consumer for this token?)`,
        waitMs: 15_000,
      };
    }
    if (e.error_code === 401) {
      return {
        kind: "401-unauthorized",
        message: `${message} (check TELEGRAM_BOT_TOKEN)`,
        waitMs: 60_000,
      };
    }
    return { kind: `grammy-${e.error_code}`, message };
  }
  if (e instanceof HttpError) {
    return { kind: "http-network", message, waitMs: 5_000 };
  }
  const msg = (e as Error)?.message ?? String(e);
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang|fetch failed|network/i.test(msg)) {
    return { kind: "network", message: msg, waitMs: 5_000 };
  }
  return { kind: "unknown", message: msg };
}

function formatTelegramError(e: unknown): string {
  if (e instanceof GrammyError) {
    const ra = e.parameters?.retry_after;
    const extra = typeof ra === "number" ? ` retry_after=${ra}s` : "";
    return `${e.message} (code ${e.error_code}${extra})`;
  }
  if (e instanceof HttpError) return `HttpError: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  // Mark intentional exit so beforeExit keep-alive cannot swallow a real fatal.
  beginShutdown(`fatal:${err instanceof Error ? err.message : String(err)}`);
  const text = err instanceof Error ? err.stack || err.message : String(err);
  console.error("Fatal:", text);
  scream(`\u274C Fatal (exiting in 1s): ${text}`);
  setTimeout(() => process.exit(1), 1000);
});
