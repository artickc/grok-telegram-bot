/**
 * Linux service controller — installs a systemd *user* service so no sudo is
 * required. `loginctl enable-linger` is attempted so the bot runs at boot even
 * before you log in. Named instances get their own unit
 * (`grok-telegram-bot-<slug>.service`) so they do not overwrite the default.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { runSafe } from "./platform.js";
import type { LaunchSpec, ServiceController, ServiceResult } from "./types.js";

function unitName(spec: LaunchSpec): string {
  return `${spec.id}.service`;
}

function unitPath(spec: LaunchSpec): string {
  return join(homedir(), ".config", "systemd", "user", unitName(spec));
}

export const linuxController: ServiceController = {
  platform: "linux",

  async install(spec) {
    const unit = unitName(spec);
    mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    mkdirSync(spec.logsDir, { recursive: true });
    writeFileSync(unitPath(spec), unitFile(spec), "utf-8");

    runSafe("systemctl", ["--user", "daemon-reload"]);
    const en = runSafe("systemctl", ["--user", "enable", "--now", unit]);
    if (!en.ok) return fail(`systemctl enable failed: ${en.out}`);
    const linger = runSafe("loginctl", ["enable-linger", userInfo().username]);
    const note = linger.ok ? " Boot-without-login enabled (linger)." : " (run `loginctl enable-linger` for boot-without-login)";
    return ok(`Installed and started systemd user service "${unit}".${note}`);
  },

  async uninstall(spec) {
    const unit = unitName(spec);
    runSafe("systemctl", ["--user", "disable", "--now", unit]);
    rmSync(unitPath(spec), { force: true });
    runSafe("systemctl", ["--user", "daemon-reload"]);
    return ok(`Removed systemd user service "${unit}".`);
  },

  async start(spec) {
    const r = runSafe("systemctl", ["--user", "start", unitName(spec)]);
    return r.ok ? ok("Started.") : fail(r.out);
  },

  async stop(spec) {
    const r = runSafe("systemctl", ["--user", "stop", unitName(spec)]);
    return r.ok ? ok("Stopped.") : fail(r.out);
  },

  async status(spec) {
    const r = runSafe("systemctl", ["--user", "status", unitName(spec), "--no-pager"]);
    return ok(r.out.trim() || "No status.");
  },
};

function unitFile(spec: LaunchSpec): string {
  const exec = `${spec.nodePath} ${spec.args.join(" ")}`;
  const env = Object.entries(spec.env ?? {}).map(([k, v]) => `Environment=${k}=${v}`);
  return [
    "[Unit]",
    `Description=${spec.displayName}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${spec.cwd}`,
    ...env,
    `ExecStart=${exec}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function ok(message: string): ServiceResult {
  return { ok: true, message };
}
function fail(message: string): ServiceResult {
  return { ok: false, message };
}
