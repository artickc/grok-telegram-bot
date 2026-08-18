/**
 * Command-line interface for the Grok Telegram Bot.
 *
 *   grok-tg [--name <slug>] run|install|status|…
 *   grok-tg --name work setup <token> <userId>
 *   grok-tg instances
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listKnownInstances, stripInstanceFlags } from "./app/instance.js";
import { ENV_PATH, INSTANCE_DIR, PROJECT_ROOT } from "./config.js";
import { buildLaunchSpec, getController } from "./service/index.js";

const HELP = `Grok Telegram Bot — CLI

Usage: grok-tg [--name <slug>] [--instance <dir>] <command>

  run                 Run in the foreground
  setup [--path]      Create/update .env (default ~/.grok/tg/.env);
                      --name <slug> writes ~/.grok/tg/instances/<slug>/.env
  install             Install + start a background service (autostart on boot)
  uninstall           Stop + remove the background service
  start               Start the service
  stop                Stop the service
  restart             Restart the service
  status              Show install + running status
  logs [n]            Show the last n log lines (default 100)
  instances           List named bot instances on this host
  help                Show this help

Several Telegram bots on one host (one chat per project, no session switching):

  grok-tg --name work setup <BOT_TOKEN> <YOUR_USER_ID>
  grok-tg --name work install
  grok-tg --name work status
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rest = stripInstanceFlags(args);
  const [cmd, arg] = rest;

  switch (cmd) {
    case "run":
    case undefined:
      await import("./index.js");
      return;

    case "setup":
    case "config": {
      // Run the plain-node setup script against the resolved instance dir.
      const script = join(PROJECT_ROOT, "scripts", "setup.mjs");
      const r = spawnSync(process.execPath, [script, "--instance", INSTANCE_DIR, ...rest.slice(1)], {
        stdio: "inherit",
        env: { ...process.env, GROK_TG_DIR: INSTANCE_DIR, GROK_TG_CWD: INSTANCE_DIR },
      });
      process.exit(r.status ?? 0);
      break;
    }

    case "install": {
      preflight();
      const spec = buildLaunchSpec();
      const r = await getController().install(spec);
      console.log(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`);
      if (r.ok) {
        const flag = spec.slug ? `--name ${spec.slug} ` : "";
        console.log(`\nManage it with: grok-tg ${flag}status | stop | restart | logs`);
      }
      process.exit(r.ok ? 0 : 1);
      break;
    }

    case "uninstall":
    case "start":
    case "stop":
    case "restart":
    case "status": {
      const ctrl = getController();
      const spec = buildLaunchSpec();
      let result;
      if (cmd === "restart") {
        await ctrl.stop(spec);
        result = await ctrl.start(spec);
      } else {
        result = await ctrl[cmd](spec);
      }
      console.log(result.ok ? result.message : `✗ ${result.message}`);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case "logs":
      printLogs(arg ? Number(arg) || 100 : 100);
      break;

    case "instances":
      printInstances();
      break;

    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

function preflight(): void {
  const envPath = ENV_PATH;
  if (!existsSync(envPath)) {
    console.warn(`⚠ No .env found at ${envPath}. Run \`grok-tg setup\` and set TELEGRAM_BOT_TOKEN first.`);
    return;
  }
  const env = readFileSync(envPath, "utf-8");
  if (!/^TELEGRAM_BOT_TOKEN=.+/m.test(env)) {
    console.warn("⚠ TELEGRAM_BOT_TOKEN is not set in .env — the service will fail to start.");
  }
}

function printLogs(n: number): void {
  const file = buildLaunchSpec().logFile;
  if (!existsSync(file)) {
    console.log(`No log file yet at ${file}`);
    return;
  }
  const lines = readFileSync(file, "utf-8").split("\n");
  console.log(lines.slice(-n).join("\n"));
}

function printInstances(): void {
  const items = listKnownInstances();
  if (items.length === 0) {
    console.log("No instances found.");
    console.log("  grok-tg setup                         # default bot (~/.grok/tg)");
    console.log("  grok-tg --name work setup <token> <userId>   # second bot");
    return;
  }
  console.log("Instances:\n");
  for (const it of items) {
    const manage = it.slug ? `grok-tg --name ${it.slug}` : "grok-tg";
    console.log(`  ${it.name}`);
    console.log(`    dir:     ${it.dir}`);
    console.log(`    service: ${it.identity.id}`);
    console.log(`    manage:  ${manage} status | restart | logs\n`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
