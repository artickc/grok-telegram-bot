#!/usr/bin/env node
/**
 * Easy setup: creates/updates the bot's .env, auto-detects the `grok` binary
 * and sensible PROJECT_ROOTS, and optionally writes the bot token / user id:
 *
 *   node scripts/setup.mjs [--path] [--instance <dir>] [--name <slug>]
 *                          [<TELEGRAM_BOT_TOKEN> [ALLOWED_USER_ID]]
 *
 * By default the .env lives in the canonical, path-independent home
 * `~/.grok/tg/.env`, so the bot loads the SAME config no matter where it's
 * started from. `--name work` writes `~/.grok/tg/instances/work/.env`.
 * `--path` just prints the resolved .env path and exits.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = join(root, ".env.example");
const CANONICAL_DIR = join(homedir(), ".grok", "tg");

function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** Mirror of src/app/instance.ts resolveInstanceDir() so setup writes EXACTLY
 *  where the bot will read from. Keep the two in sync. */
function resolveInstanceDir() {
  const flag = process.argv.indexOf("--instance");
  if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]);
  const nameEq = process.argv.find((a) => a.startsWith("--name="));
  const nameFlag = process.argv.indexOf("--name");
  const name = nameEq ? nameEq.slice("--name=".length) : nameFlag !== -1 ? process.argv[nameFlag + 1] : process.env.GROK_TG_NAME;
  if (name && String(name).trim()) {
    return join(CANONICAL_DIR, "instances", String(name).trim().toLowerCase());
  }
  const envDir = (process.env.GROK_TG_DIR || "").trim();
  if (envDir) return resolve(expandHome(envDir));
  const cwdHint = (process.env.GROK_TG_CWD || "").trim();
  if (cwdHint) {
    const hint = resolve(expandHome(cwdHint));
    if (existsSync(join(hint, ".env"))) return hint;
  }
  if (existsSync(join(process.cwd(), ".env"))) return process.cwd();
  return CANONICAL_DIR;
}

const argv = process.argv.slice(2);
let pathOnly = false;
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--path") pathOnly = true;
  else if (a === "--instance" || a === "--name") i++;
  else if (a.startsWith("--instance=") || a.startsWith("--name=")) continue;
  else positionals.push(a);
}
const [tokenArg, userArg] = positionals;

const instanceDir = resolveInstanceDir();
const envPath = join(instanceDir, ".env");

if (pathOnly) {
  console.log(envPath);
  process.exit(0);
}

mkdirSync(instanceDir, { recursive: true });

function detectGrok() {
  const home = homedir();
  const exe = process.platform === "win32" ? "grok.exe" : "grok";
  const candidates = [
    join(home, ".grok", "bin", exe),
    join(home, ".local", "bin", "grok"),
    "/usr/local/bin/grok",
    "/opt/homebrew/bin/grok",
  ];
  return candidates.find((p) => existsSync(p)) || "";
}

function detectRoots() {
  const guesses = ["H:\\Lucru\\Domains", "C:\\Lucru\\Domains", join(homedir(), "projects")];
  return guesses.filter((p) => existsSync(p));
}

let env = existsSync(envPath) ? readFileSync(envPath, "utf-8") : readFileSync(examplePath, "utf-8");

function setVar(key, value) {
  if (value === undefined || value === "") return;
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  env = re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`;
}

const grok = detectGrok();
if (grok) {
  setVar("GROK_CLI_PATH", grok);
  console.log(`\u2713 Found grok: ${grok}`);
} else {
  console.log("! grok not auto-detected \u2014 set GROK_CLI_PATH in .env or ensure it's on PATH.");
}

const roots = detectRoots();
if (roots.length) {
  setVar("PROJECT_ROOTS", roots.join(","));
  console.log(`\u2713 PROJECT_ROOTS: ${roots.join(", ")}`);
}

if (tokenArg) {
  setVar("TELEGRAM_BOT_TOKEN", tokenArg);
  console.log("\u2713 Wrote TELEGRAM_BOT_TOKEN");
}
if (userArg) {
  setVar("ALLOWED_USERS", userArg);
  console.log(`\u2713 Wrote ALLOWED_USERS=${userArg}`);
}

writeFileSync(envPath, env, "utf-8");
console.log(`\n\u2713 .env written to ${envPath}`);
console.log("  (loaded from here no matter which folder you start the bot in)");

if (!/^TELEGRAM_BOT_TOKEN=.+/m.test(env)) {
  console.log("\nNext: open .env, paste your bot token from @BotFather, then sign in with `grok login` (or /reauth). Then run `grok-tg run`.");
} else {
  console.log("\nReady! Sign in with `grok login` if you haven't, then run `grok-tg run` (or `npm start`).");
}
