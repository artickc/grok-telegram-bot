/**
 * List the sessions a sibling telegram-bot currently treats as /running
 * (controlledSessions in its data/settings.json), enriched with on-disk meta
 * and first-prompt titles when available.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { createLogger } from "../logger.js";
import { type ForeignSessionMeta, resolveForeignMeta } from "./history-readers.js";
import type { ImportSource } from "./sources.js";

const log = createLogger("import:list");

export interface ImportableSession extends ForeignSessionMeta {
  /** Source tool id (kiro / opencode / …). */
  sourceId: string;
  /** True when listed from that bot's controlledSessions (/running). */
  fromRunning: boolean;
}

interface RawControlled {
  sessionId?: string;
  projectPath?: string;
  projectName?: string;
}

interface RawChatSettings {
  controlledSessions?: RawControlled[];
  sessionId?: string;
  projectPath?: string;
  projectName?: string;
  foregroundSessionId?: string;
}

/**
 * Sessions currently controlled by the source bot (its /running list).
 * When `chatId` is set, prefer that chat's controlled list; otherwise union
 * every chat's controlled sessions (deduped by session id).
 */
export function listRunningFromSource(
  src: ImportSource,
  chatId?: number,
): ImportableSession[] {
  const controlled = readControlled(src, chatId);
  const out: ImportableSession[] = [];
  const seen = new Set<string>();

  for (const c of controlled) {
    if (!c.sessionId || seen.has(c.sessionId)) continue;
    seen.add(c.sessionId);
    const meta = resolveForeignMeta(src.format, src.sessionsRoot, c.sessionId, {
      cwd: c.projectPath,
      projectName: c.projectName || (c.projectPath ? basename(c.projectPath) : undefined),
    });
    if (!meta.cwd && c.projectPath) meta.cwd = c.projectPath;
    if (!meta.projectName) {
      meta.projectName = c.projectName || (meta.cwd ? basename(meta.cwd) : undefined);
    }
    out.push({ ...meta, sourceId: src.id, fromRunning: true });
  }

  return out;
}

function readControlled(src: ImportSource, chatId?: number): RawControlled[] {
  if (!existsSync(src.settingsPath)) {
    log.warn(`settings missing for ${src.id}: ${src.settingsPath}`);
    return [];
  }
  let raw: Record<string, RawChatSettings>;
  try {
    raw = JSON.parse(readFileSync(src.settingsPath, "utf-8")) as Record<string, RawChatSettings>;
  } catch (e) {
    log.warn(`cannot parse settings for ${src.id}:`, (e as Error).message);
    return [];
  }

  const collect = (s: RawChatSettings | undefined): RawControlled[] => {
    if (!s) return [];
    const list = [...(s.controlledSessions ?? [])];
    // Also include the single-session fields if controlledSessions is empty.
    if (list.length === 0 && s.sessionId) {
      list.push({
        sessionId: s.sessionId,
        projectPath: s.projectPath,
        projectName: s.projectName,
      });
    }
    return list;
  };

  if (chatId !== undefined) {
    const key = String(chatId);
    if (raw[key]) return collect(raw[key]);
  }

  const all: RawControlled[] = [];
  for (const s of Object.values(raw)) all.push(...collect(s));
  return all;
}
