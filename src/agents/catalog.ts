/**
 * Discover Grok sub-agents. Grok ships built-in sub-agents (general, explore,
 * vision, verify, computer) and supports custom ones defined under `subAgents`
 * in `~/.grok/user-settings.json`. There is no headless `--agent` flag, so the
 * bot surfaces these for visibility; the model delegates to them via its own
 * `task`/`delegate` tools during a turn.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("agents");

export interface AgentInfo {
  name: string;
  description?: string;
  scope: "project" | "global" | "builtin";
}

const BUILTINS: AgentInfo[] = [
  { name: "general", description: "General-purpose sub-agent", scope: "builtin" },
  { name: "explore", description: "Read-only codebase exploration", scope: "builtin" },
  { name: "vision", description: "Image understanding", scope: "builtin" },
  { name: "verify", description: "Build/run/test verification", scope: "builtin" },
];

interface SubAgentEntry {
  name?: string;
  instruction?: string;
  description?: string;
}

function readSubAgents(path: string, scope: "project" | "global", out: Map<string, AgentInfo>): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  try {
    const json = JSON.parse(raw) as { subAgents?: SubAgentEntry[] };
    for (const a of json.subAgents ?? []) {
      if (!a.name || out.has(a.name)) continue;
      out.set(a.name, { name: a.name, description: a.description || a.instruction, scope });
    }
  } catch (e) {
    log.debug(`skip ${path}:`, (e as Error).message);
  }
}

export function listAgents(projectPath?: string): AgentInfo[] {
  const found = new Map<string, AgentInfo>();
  if (projectPath) readSubAgents(join(projectPath, ".grok", "settings.json"), "project", found);
  readSubAgents(join(homedir(), ".grok", "user-settings.json"), "global", found);
  const custom = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return [...BUILTINS, ...custom];
}
