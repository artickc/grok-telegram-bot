/**
 * Windows service controller — runs the bot at logon. Preferred mechanism is a
 * hidden ONLOGON Scheduled Task, but registering a logon-triggered task needs
 * admin, so from a normal (non-elevated) terminal we fall back to a launcher in
 * the per-user Startup folder — both run a small .vbs that starts node with no
 * console window; the app logs to a file. Stop precisely targets our node
 * process by command line, so it works regardless of how it was launched.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSafe } from "./platform.js";
import type { LaunchSpec, ServiceController, ServiceResult } from "./types.js";

const TASK = "GrokTelegramBot";
/** Launcher dropped in the per-user Startup folder when no admin is available. */
const STARTUP_VBS = "GrokTelegramBot.vbs";

/** The per-user Startup folder (runs at logon for the current user, no admin).
 *  Undefined only if APPDATA is unset (e.g. running with no roaming profile). */
function startupDir(): string | undefined {
  const appData = process.env.APPDATA;
  return appData ? join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup") : undefined;
}

function startupVbsPath(): string | undefined {
  const dir = startupDir();
  return dir ? join(dir, STARTUP_VBS) : undefined;
}

/** Remove a leftover Startup-folder launcher (e.g. from an earlier non-elevated
 *  install) so a task-based install never double-launches the bot at logon. */
function removeStartupLauncher(): void {
  const p = startupVbsPath();
  if (p) rmSync(p, { force: true });
}

/** Canonical launcher in the bot folder (the Scheduled Task points at it). */
function vbsPath(spec: LaunchSpec): string {
  return join(spec.cwd, "run-service.vbs");
}

/** True when our hidden Scheduled Task is registered. */
function taskInstalled(): boolean {
  return runSafe("schtasks", ["/Query", "/TN", TASK]).ok;
}

/** True when a bot process matching this spec is currently running. Launch
 *  paths use this to avoid starting a second instance — two pollers on one
 *  bot token make Telegram return 409 Conflict. */
function isRunning(spec: LaunchSpec): boolean {
  const proc = runSafe("powershell", ["-NoProfile", "-Command", countScript(entryOf(spec))]);
  return proc.ok && /[1-9]\d*/.test(proc.out.trim());
}

export const windowsController: ServiceController = {
  platform: "windows",

  async install(spec) {
    mkdirSync(spec.logsDir, { recursive: true });
    const vbs = vbsPath(spec);
    writeFileSync(vbs, vbsLauncher(spec), "utf-8");

    // Preferred: a hidden ONLOGON Scheduled Task. Registering a *logon-triggered*
    // task is a privileged operation, so /Create succeeds only from an elevated
    // (admin) terminal. From a normal terminal it returns "Access is denied".
    runSafe("schtasks", ["/Delete", "/F", "/TN", TASK]); // replace if present
    const res = runSafe("schtasks", [
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      TASK,
      "/TR",
      `wscript.exe "${vbs}"`,
    ]);
    if (res.ok) {
      removeStartupLauncher(); // avoid a leftover launcher double-starting the bot
      if (!isRunning(spec)) runSafe("schtasks", ["/Run", "/TN", TASK]);
      return ok(`Installed scheduled task "${TASK}" (starts at logon) and launched it.`);
    }

    // A task may still exist that we just couldn't overwrite (e.g. created by an
    // earlier elevated install). Reuse it rather than ALSO adding a Startup
    // launcher, which would double-launch the bot at logon (409 Conflict).
    if (taskInstalled()) {
      removeStartupLauncher();
      if (!isRunning(spec)) runSafe("schtasks", ["/Run", "/TN", TASK]);
      return ok(`Scheduled task "${TASK}" already exists; launched it. (Re-run elevated to recreate it.)`);
    }

    // Fallback (no admin — the common case): drop the launcher in the per-user
    // Startup folder. It runs hidden at every logon with no elevation.
    const startupVbs = startupVbsPath();
    const dir = startupDir();
    if (!startupVbs || !dir) {
      return fail(
        `Could not create the logon task (${res.out.trim()}) and no per-user Startup folder is available. ` +
          `Re-run "grok-tg install" from an elevated terminal (Run as administrator).`,
      );
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(startupVbs, vbsLauncher(spec), "utf-8");
    } catch (e) {
      return fail(`Startup-folder install failed: ${(e as Error).message}`);
    }
    if (!isRunning(spec)) runSafe("wscript.exe", [startupVbs]); // launch now
    return ok(
      `Installed via the Startup folder — starts hidden at logon, no admin needed — and launched it.\n` +
        `(Tip: run "grok-tg install" from an elevated terminal to use a hidden Scheduled Task instead.)`,
    );
  },

  async uninstall(spec) {
    await this.stop(spec);
    runSafe("schtasks", ["/Delete", "/F", "/TN", TASK]); // best-effort (may not exist)
    rmSync(vbsPath(spec), { force: true });
    const startupVbs = startupVbsPath();
    if (startupVbs) rmSync(startupVbs, { force: true });
    return ok(`Removed "${TASK}" (scheduled task and/or Startup launcher).`);
  },

  async start(spec) {
    if (isRunning(spec)) return ok("Already running.");
    if (taskInstalled()) {
      const res = runSafe("schtasks", ["/Run", "/TN", TASK]);
      return res.ok ? ok("Started.") : fail(res.out);
    }
    const startupVbs = startupVbsPath();
    if (startupVbs && existsSync(startupVbs)) {
      runSafe("wscript.exe", [startupVbs]);
      return ok("Started.");
    }
    return fail(`Not installed. Run "grok-tg install" first.`);
  },

  async stop(spec) {
    runSafe("schtasks", ["/End", "/TN", TASK]); // best-effort if task-based
    const res = runSafe("powershell", ["-NoProfile", "-Command", killScript(entryOf(spec))]);
    return ok(`Stopped. ${res.out.trim()}`);
  },

  async status(spec) {
    const installedTask = taskInstalled();
    const startupVbs = startupVbsPath();
    const installedStartup = !!startupVbs && existsSync(startupVbs);
    const installed = installedTask || installedStartup;
    const running = isRunning(spec);
    const how = installedTask ? "scheduled task" : installedStartup ? "Startup folder" : "—";
    const detail = installedTask
      ? `\n${runSafe("schtasks", ["/Query", "/TN", TASK, "/FO", "LIST"]).out.trim()}`
      : installedStartup
        ? `\nLauncher: ${startupVbs}`
        : "";
    return ok(
      `Installed: ${installed ? `yes (${how})` : "no"} | Running: ${running ? "yes" : "no"}${detail}`,
    );
  },
};

/** The bot entry file — unique enough to identify the bot process. It may be
 *  followed by trailing args (e.g. `--instance <dir>`), so find it explicitly. */
function entryOf(spec: LaunchSpec): string {
  return (
    spec.args.find((a) => a.endsWith("index.ts")) ?? spec.args[spec.args.length - 1] ?? spec.cwd
  );
}

function vbsLauncher(spec: LaunchSpec): string {
  const cmd = `""${spec.nodePath}"" ${spec.args.map((a) => `""${a}""`).join(" ")}`;
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${spec.cwd}"`,
    `sh.Run "${cmd}", 0, False`,
  ].join("\r\n");
}

function killScript(entry: string): string {
  const safe = entry.replace(/'/g, "''");
  return [
    `$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${safe}*' };`,
    `$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };`,
    `"killed " + (@($p).Count)`,
  ].join(" ");
}

function countScript(entry: string): string {
  const safe = entry.replace(/'/g, "''");
  return `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${safe}*' }).Count`;
}

function ok(message: string): ServiceResult {
  return { ok: true, message };
}
function fail(message: string): ServiceResult {
  return { ok: false, message };
}
