/**
 * Windows service controller — runs the bot at logon. Preferred mechanism is a
 * hidden ONLOGON Scheduled Task, but registering a logon-triggered task needs
 * admin, so from a normal (non-elevated) terminal we fall back to a launcher in
 * the per-user Startup folder — both run a small .vbs that starts node with no
 * console window; the app logs to a file. Stop precisely targets our node
 * process by command line, so it works regardless of how it was launched.
 *
 * Named instances use a distinct task / VBS name so they do not overwrite the
 * default bot.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SERVICE_ID } from "../app/instance.js";
import { runSafe } from "./platform.js";
import type { LaunchSpec, ServiceController, ServiceResult } from "./types.js";

/** The per-user Startup folder (runs at logon for the current user, no admin).
 *  Undefined only if APPDATA is unset (e.g. running with no roaming profile). */
function startupDir(): string | undefined {
  const appData = process.env.APPDATA;
  return appData ? join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup") : undefined;
}

function startupVbsName(spec: LaunchSpec): string {
  return `${spec.windowsTaskName}.vbs`;
}

function startupVbsPath(spec: LaunchSpec): string | undefined {
  const dir = startupDir();
  return dir ? join(dir, startupVbsName(spec)) : undefined;
}

/** Remove a leftover Startup-folder launcher (e.g. from an earlier non-elevated
 *  install) so a task-based install never double-launches the bot at logon. */
function removeStartupLauncher(spec: LaunchSpec): void {
  const p = startupVbsPath(spec);
  if (p) rmSync(p, { force: true });
}

/** Canonical launcher in the bot folder (the Scheduled Task points at it). */
function vbsPath(spec: LaunchSpec): string {
  const name = spec.id === DEFAULT_SERVICE_ID ? "run-service.vbs" : `run-service-${spec.id}.vbs`;
  return join(spec.cwd, name);
}

/** True when our hidden Scheduled Task is registered. */
function taskInstalled(spec: LaunchSpec): boolean {
  return runSafe("schtasks", ["/Query", "/TN", spec.windowsTaskName]).ok;
}

/** True when a bot process matching this spec is currently running. Launch
 *  paths use this to avoid starting a second instance — two pollers on one
 *  bot token make Telegram return 409 Conflict. */
function isRunning(spec: LaunchSpec): boolean {
  const proc = runSafe("powershell", ["-NoProfile", "-Command", countScript(spec)]);
  return proc.ok && /[1-9]\d*/.test(proc.out.trim());
}

export const windowsController: ServiceController = {
  platform: "windows",

  async install(spec) {
    const task = spec.windowsTaskName;
    mkdirSync(spec.logsDir, { recursive: true });
    const vbs = vbsPath(spec);
    writeFileSync(vbs, vbsLauncher(spec), "utf-8");

    // Preferred: a hidden ONLOGON Scheduled Task. Registering a *logon-triggered*
    // task is a privileged operation, so /Create succeeds only from an elevated
    // (admin) terminal. From a normal terminal it returns "Access is denied".
    runSafe("schtasks", ["/Delete", "/F", "/TN", task]); // replace if present
    const res = runSafe("schtasks", [
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      task,
      "/TR",
      `wscript.exe "${vbs}"`,
    ]);
    if (res.ok) {
      removeStartupLauncher(spec); // avoid a leftover launcher double-starting the bot
      if (!isRunning(spec)) runSafe("schtasks", ["/Run", "/TN", task]);
      return ok(`Installed scheduled task "${task}" (starts at logon) and launched it.`);
    }

    // A task may still exist that we just couldn't overwrite (e.g. created by an
    // earlier elevated install). Reuse it rather than ALSO adding a Startup
    // launcher, which would double-launch the bot at logon (409 Conflict).
    if (taskInstalled(spec)) {
      removeStartupLauncher(spec);
      if (!isRunning(spec)) runSafe("schtasks", ["/Run", "/TN", task]);
      return ok(`Scheduled task "${task}" already exists; launched it. (Re-run elevated to recreate it.)`);
    }

    // Fallback (no admin — the common case): drop the launcher in the per-user
    // Startup folder. It runs hidden at every logon with no elevation.
    const startupVbs = startupVbsPath(spec);
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
    runSafe("schtasks", ["/Delete", "/F", "/TN", spec.windowsTaskName]); // best-effort (may not exist)
    rmSync(vbsPath(spec), { force: true });
    const startupVbs = startupVbsPath(spec);
    if (startupVbs) rmSync(startupVbs, { force: true });
    return ok(`Removed "${spec.windowsTaskName}" (scheduled task and/or Startup launcher).`);
  },

  async start(spec) {
    if (isRunning(spec)) return ok("Already running.");
    if (taskInstalled(spec)) {
      const res = runSafe("schtasks", ["/Run", "/TN", spec.windowsTaskName]);
      return res.ok ? ok("Started.") : fail(res.out);
    }
    const startupVbs = startupVbsPath(spec);
    if (startupVbs && existsSync(startupVbs)) {
      runSafe("wscript.exe", [startupVbs]);
      return ok("Started.");
    }
    return fail(`Not installed. Run "grok-tg install" first.`);
  },

  async stop(spec) {
    runSafe("schtasks", ["/End", "/TN", spec.windowsTaskName]); // best-effort if task-based
    const res = runSafe("powershell", ["-NoProfile", "-Command", killScript(spec)]);
    return ok(`Stopped. ${res.out.trim()}`);
  },

  async status(spec) {
    const installedTask = taskInstalled(spec);
    const startupVbs = startupVbsPath(spec);
    const installedStartup = !!startupVbs && existsSync(startupVbs);
    const installed = installedTask || installedStartup;
    const running = isRunning(spec);
    const how = installedTask ? "scheduled task" : installedStartup ? "Startup folder" : "—";
    const detail = installedTask
      ? `\n${runSafe("schtasks", ["/Query", "/TN", spec.windowsTaskName, "/FO", "LIST"]).out.trim()}`
      : installedStartup
        ? `\nLauncher: ${startupVbs}`
        : "";
    return ok(
      `Installed: ${installed ? `yes (${how})` : "no"} | Running: ${running ? "yes" : "no"}${detail}`,
    );
  },
};

function instanceDirOf(spec: LaunchSpec): string | undefined {
  const i = spec.args.indexOf("--instance");
  return i !== -1 ? spec.args[i + 1] : undefined;
}

function processFilter(spec: LaunchSpec): string {
  const inst = instanceDirOf(spec);
  if (inst) {
    const safe = inst.replace(/'/g, "''");
    return [
      `$n = '--instance ' + '${safe}';`,
      `$re = [regex]::Escape($n) + '(\\s|$)';`,
      `$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and ($_.CommandLine -match $re) };`,
    ].join(" ");
  }
  const entry =
    spec.args.find((a) => a.endsWith("index.ts")) ?? spec.args[spec.args.length - 1] ?? spec.cwd;
  const safe = entry.replace(/'/g, "''");
  return `$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${safe}*' };`;
}

function vbsLauncher(spec: LaunchSpec): string {
  const cmd = `""${spec.nodePath}"" ${spec.args.map((a) => `""${a}""`).join(" ")}`;
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${spec.cwd}"`,
    `sh.Run "${cmd}", 0, False`,
  ].join("\r\n");
}

function killScript(spec: LaunchSpec): string {
  return `${processFilter(spec)} $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; "killed " + (@($p).Count)`;
}

function countScript(spec: LaunchSpec): string {
  return `${processFilter(spec)} @($p).Count`;
}

function ok(message: string): ServiceResult {
  return { ok: true, message };
}
function fail(message: string): ServiceResult {
  return { ok: false, message };
}
