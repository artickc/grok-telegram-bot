/**
 * Named bot instances: each Telegram bot token gets its own directory
 * (`.env`, `logs/`, `data/`) and a unique OS service name so several bots
 * can run 24/7 on one host without overwriting each other.
 *
 * The unnamed default stays at `~/.grok/tg` with the original service id.
 * `grok-tg --name work …` uses `~/.grok/tg/instances/work` and
 * `grok-telegram-bot-work`.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Canonical home for the default (unnamed) instance. */
export const CANONICAL_DIR = join(homedir(), ".grok", "tg");
export const INSTANCES_SUBDIR = "instances";

export const DEFAULT_SERVICE_ID = "grok-telegram-bot";
export const DEFAULT_WINDOWS_TASK = "GrokTelegramBot";
export const DEFAULT_MACOS_LABEL = "com.grok.telegrambot";

const RESERVED = new Set(["default", "instances", "locks", "logs", "data"]);
const SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface InstanceFlags {
  instanceDir?: string;
  name?: string;
}

export interface ServiceIdentity {
  id: string;
  displayName: string;
  windowsTaskName: string;
  macosLabel: string;
  slug?: string;
}

export interface KnownInstance {
  /** `(default)` or the instance slug. */
  name: string;
  dir: string;
  slug?: string;
  identity: ServiceIdentity;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

export function parseInstanceFlags(argv: string[]): InstanceFlags {
  const out: InstanceFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if ((a === "--instance" || a === "--name") && argv[i + 1]) {
      const value = argv[++i]!;
      if (a === "--instance") out.instanceDir = value;
      else out.name = value;
      continue;
    }
    if (a.startsWith("--instance=")) out.instanceDir = a.slice("--instance=".length);
    else if (a.startsWith("--name=")) out.name = a.slice("--name=".length);
  }
  return out;
}

/** Drop `--instance` / `--name` (and their values) so the CLI command remains first. */
export function stripInstanceFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--instance" || a === "--name") {
      i++;
      continue;
    }
    if (a.startsWith("--instance=") || a.startsWith("--name=")) continue;
    out.push(a);
  }
  return out;
}

export function parseInstanceSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid instance name "${raw}". Use 1–32 characters: start with a letter, then letters, digits or hyphens (e.g. work, home, coding).`,
    );
  }
  if (RESERVED.has(slug)) {
    throw new Error(`Instance name "${slug}" is reserved. Pick another name.`);
  }
  return slug;
}

export function namedInstanceDir(name: string, canonicalDir = CANONICAL_DIR): string {
  return join(canonicalDir, INSTANCES_SUBDIR, parseInstanceSlug(name));
}

/**
 * Resolve this process's instance directory.
 *
 * Order: `--instance` → `--name` / `GROK_TG_NAME` → `GROK_TG_DIR` → a
 * `GROK_TG_CWD` or cwd that already contains `.env` → `~/.grok/tg`.
 *
 * `GROK_TG_CWD` is only a "user launched from here" hint (the `grok-tg`
 * launcher always sets it). It must not override `--name`, otherwise a
 * named instance could never be selected.
 */
export function resolveInstanceDir(opts: {
  argv?: string[];
  envDir?: string;
  nameEnv?: string;
  cwdHint?: string;
  cwd?: string;
  canonicalDir?: string;
} = {}): string {
  const canonicalDir = opts.canonicalDir ?? CANONICAL_DIR;
  const cwd = opts.cwd ?? process.cwd();
  const flags = parseInstanceFlags(opts.argv ?? process.argv);
  if (flags.instanceDir?.trim()) return resolve(expandHome(flags.instanceDir.trim()));
  const name = flags.name?.trim() || opts.nameEnv?.trim();
  if (name) return namedInstanceDir(name, canonicalDir);
  if (opts.envDir?.trim()) return resolve(expandHome(opts.envDir.trim()));
  const hinted = opts.cwdHint?.trim();
  if (hinted) {
    const hint = resolve(expandHome(hinted));
    if (existsSync(join(hint, ".env"))) return hint;
  }
  if (existsSync(join(cwd, ".env"))) return cwd;
  return canonicalDir;
}

/**
 * OS service names for this instance.
 *
 * Unique names are used only for `--name` / `~/.grok/tg/instances/<slug>` so
 * an existing default install (`grok-telegram-bot.service`) is unchanged.
 * A random folder with a `.env` keeps the default service id.
 */
export function serviceIdentity(
  instanceDir: string,
  name?: string,
  canonicalDir = CANONICAL_DIR,
): ServiceIdentity {
  const slug = name?.trim()
    ? parseInstanceSlug(name)
    : inferNamedInstanceSlug(instanceDir, canonicalDir);
  if (!slug) {
    return {
      id: DEFAULT_SERVICE_ID,
      displayName: "Grok Telegram Bot",
      windowsTaskName: DEFAULT_WINDOWS_TASK,
      macosLabel: DEFAULT_MACOS_LABEL,
    };
  }
  return {
    id: `${DEFAULT_SERVICE_ID}-${slug}`,
    displayName: `Grok Telegram Bot (${slug})`,
    windowsTaskName: `${DEFAULT_WINDOWS_TASK}-${slug}`,
    macosLabel: `${DEFAULT_MACOS_LABEL}.${slug}`,
    slug,
  };
}

export function listKnownInstances(canonicalDir = CANONICAL_DIR): KnownInstance[] {
  const out: KnownInstance[] = [];
  if (existsSync(join(canonicalDir, ".env"))) {
    out.push({
      name: "(default)",
      dir: canonicalDir,
      identity: serviceIdentity(canonicalDir, undefined, canonicalDir),
    });
  }
  const root = join(canonicalDir, INSTANCES_SUBDIR);
  if (!existsSync(root)) return out;
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const dir = join(root, name);
    if (!existsSync(join(dir, ".env"))) continue;
    out.push({
      name,
      dir,
      slug: name,
      identity: serviceIdentity(dir, undefined, canonicalDir),
    });
  }
  return out;
}

/** Basename when `instanceDir` is a direct child of `<canonical>/instances`. */
function namedChildName(instanceDir: string, canonicalDir: string): string | undefined {
  const resolved = resolve(instanceDir);
  const parent = resolve(join(resolved, ".."));
  const root = resolve(join(canonicalDir, INSTANCES_SUBDIR));
  if (parent !== root) return undefined;
  return basename(resolved);
}

function inferNamedInstanceSlug(instanceDir: string, canonicalDir: string): string | undefined {
  const child = namedChildName(instanceDir, canonicalDir);
  if (!child) return undefined;
  try {
    return parseInstanceSlug(child);
  } catch {
    const fallback = child
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    return fallback && SLUG_RE.test(fallback) && !RESERVED.has(fallback) ? fallback : "extra";
  }
}
