/**
 * Platform detection, launch-spec construction, and a small command runner
 * shared by the per-OS service controllers.
 */
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { parseInstanceFlags, serviceIdentity } from "../app/instance.js";
import { PROJECT_ROOT, INSTANCE_DIR } from "../config.js";

export type Platform = "windows" | "linux" | "macos" | "unknown";

export function detectPlatform(): Platform {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    default:
      return "unknown";
  }
}

import type { LaunchSpec } from "./types.js";

/** Build the launch spec that runs the bot via the current node + tsx loader. */
export function buildLaunchSpec(): LaunchSpec {
  const logsDir = join(INSTANCE_DIR, "logs");
  const args = ["--import", "tsx", join(PROJECT_ROOT, "src", "index.ts")];
  // Run the code from the package dir (cwd below) so `tsx` resolves, but tell
  // the bot where its .env/logs/data live. Only appended for a global install
  // (instance dir differs) so in-place checkouts keep identical launch args.
  if (INSTANCE_DIR !== PROJECT_ROOT) args.push("--instance", INSTANCE_DIR);
  const flags = parseInstanceFlags(process.argv);
  const ident = serviceIdentity(INSTANCE_DIR, flags.name || process.env.GROK_TG_NAME);
  return {
    id: ident.id,
    displayName: ident.displayName,
    windowsTaskName: ident.windowsTaskName,
    macosLabel: ident.macosLabel,
    slug: ident.slug,
    nodePath: process.execPath,
    args,
    cwd: PROJECT_ROOT,
    // Tells the running bot it's under a supervisor (systemd/launchd) that
    // relaunches on exit — so its auto-updater exits cleanly instead of
    // re-exec'ing (which would double-run). Windows applies no env, so its
    // Scheduled Task (no auto-restart) takes the re-exec path instead.
    env: {
      GROK_TG_SUPERVISED: "1",
      ...(ident.slug ? { GROK_TG_NAME: ident.slug } : {}),
    },
    logsDir,
    logFile: join(logsDir, "grok-telegram-bot.log"),
  };
}

/** Default max wait for schtasks/systemctl/powershell helpers — never hang the CLI. */
const RUN_TIMEOUT_MS = 45_000;

/** Run a command, returning combined output. Throws on non-zero exit or timeout. */
export function run(cmd: string, args: string[], timeoutMs = RUN_TIMEOUT_MS): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
}

/** Run a command, swallowing errors and returning { ok, out }. */
export function runSafe(cmd: string, args: string[], timeoutMs = RUN_TIMEOUT_MS): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(cmd, args, timeoutMs) };
  } catch (e) {
    const err = e as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      message?: string;
      killed?: boolean;
      code?: string;
    };
    // Node sets killed=true when the timeout option aborts the child.
    if (err.killed || err.code === "ETIMEDOUT") {
      return { ok: false, out: `timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}` };
    }
    const out = String(err.stdout ?? "") + String(err.stderr ?? "") || err.message || "failed";
    return { ok: false, out };
  }
}

/**
 * Fire-and-forget process (detached). Use for forever-restart supervisors
 * (Windows VBS loop) so `grok-tg install|start|restart` does not hang waiting
 * for a process that never exits.
 */
export function launchDetached(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    if (child.pid == null) return { ok: false, out: "spawn produced no pid" };
    return { ok: true, out: `pid ${child.pid}` };
  } catch (e) {
    return { ok: false, out: (e as Error).message || "spawn failed" };
  }
}
