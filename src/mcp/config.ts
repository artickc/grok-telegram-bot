/**
 * MCP config store — reads and edits Grok CLI's MCP server definitions.
 *
 * Grok keeps them in two places:
 *   • global    → `~/.grok/user-settings.json` under `mcp.servers` (array), and
 *   • workspace → `<cwd>/.grok/settings.json` under `mcpServers` (object map).
 *
 * We normalize both shapes into a flat list. Edits are surgical: parse, flip a
 * single `disabled` flag on one entry, write back with 2-space indentation.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { detailOf, type McpScope, type McpServer, type McpServerConfig, transportOf } from "./types.js";

const log = createLogger("mcp:config");

/** Absolute path of the global settings file (Grok user settings). */
export function globalMcpPath(): string {
  return join(homedir(), ".grok", "user-settings.json");
}

/** Absolute path of a workspace settings file for a given project directory. */
export function workspaceMcpPath(cwd: string): string {
  return join(cwd, ".grok", "settings.json");
}

interface RawFile {
  mcpServers?: Record<string, McpServerConfig>;
  mcp?: { servers?: Array<McpServerConfig & { name?: string }> };
  servers?: Array<McpServerConfig & { name?: string }>;
  [k: string]: unknown;
}

function readJson(path: string): RawFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RawFile;
  } catch (e) {
    log.warn(`cannot parse ${path}: ${(e as Error).message}`);
    return undefined;
  }
}

/** Extract normalized servers from a file (supports object-map and array). */
function serversFrom(path: string, scope: McpScope): McpServer[] {
  const file = readJson(path);
  if (!file) return [];
  const out: McpServer[] = [];
  const push = (name: string, config: McpServerConfig): void => {
    out.push({
      name,
      scope,
      configPath: path,
      disabled: config?.disabled === true,
      transport: transportOf(config ?? {}),
      detail: detailOf(config ?? {}),
      config: config ?? {},
    });
  };
  if (file.mcpServers && typeof file.mcpServers === "object") {
    for (const [name, config] of Object.entries(file.mcpServers)) push(name, config);
  }
  const arr = file.mcp?.servers ?? file.servers;
  if (Array.isArray(arr)) {
    for (const entry of arr) if (entry?.name) push(entry.name, entry);
  }
  return out;
}

/** List all configured MCP servers (workspace entries shadow global). */
export function listMcpServers(cwd?: string): McpServer[] {
  const byName = new Map<string, McpServer>();
  for (const s of serversFrom(globalMcpPath(), "global")) byName.set(s.name, s);
  if (cwd) {
    for (const s of serversFrom(workspaceMcpPath(cwd), "workspace")) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function findMcpServer(name: string, cwd?: string): McpServer | undefined {
  return listMcpServers(cwd).find((s) => s.name === name);
}

export interface ToggleResult {
  ok: boolean;
  disabled?: boolean;
  error?: string;
}

/** Set the `disabled` flag for a server in its own config file. */
export function setMcpDisabled(server: McpServer, disabled: boolean): ToggleResult {
  const file = readJson(server.configPath);
  if (!file) return { ok: false, error: `cannot read ${server.configPath}` };

  const applyMap = (map?: Record<string, McpServerConfig>): boolean => {
    if (!map || !map[server.name]) return false;
    const entry = map[server.name]!;
    if (disabled) entry.disabled = true;
    else delete entry.disabled;
    return true;
  };
  const applyArr = (arr?: Array<McpServerConfig & { name?: string }>): boolean => {
    const entry = arr?.find((e) => e.name === server.name);
    if (!entry) return false;
    if (disabled) entry.disabled = true;
    else delete entry.disabled;
    return true;
  };

  const changed = applyMap(file.mcpServers) || applyArr(file.mcp?.servers) || applyArr(file.servers);
  if (!changed) return { ok: false, error: `server "${server.name}" not found in ${server.configPath}` };
  try {
    writeFileSync(server.configPath, JSON.stringify(file, null, 2) + "\n", "utf-8");
    return { ok: true, disabled };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
