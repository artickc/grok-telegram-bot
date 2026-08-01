/**
 * Per-chat / per-forum-topic settings persistence (project, agent, model,
 * reasoning, pinned status message id, controlled sessions).
 * Keys: `"12345"` for private chats, `"12345:t7"` for forum topic thread 7.
 * Backed by a single JSON file so state survives restarts.
 */
import { join } from "node:path";
import { JsonStore } from "./json-store.js";
import { type ChatSettings, defaultSettings } from "./types.js";

type SettingsMap = Record<string, ChatSettings>;

export class SettingsStore {
  private readonly store: JsonStore<SettingsMap>;

  constructor(dataDir: string) {
    this.store = new JsonStore<SettingsMap>(join(dataDir, "settings.json"), {});
  }

  /** Settings for a private chat (or legacy callers). */
  get(chatId: number): ChatSettings {
    return this.getKey(String(chatId));
  }

  /** Settings by storage key (`chatId` or `chatId:t{threadId}`). */
  getKey(key: string): ChatSettings {
    const existing = this.store.get()[key];
    return existing ?? defaultSettings();
  }

  update(chatId: number, patch: Partial<ChatSettings>): ChatSettings {
    return this.updateKey(String(chatId), patch);
  }

  updateKey(key: string, patch: Partial<ChatSettings>): ChatSettings {
    const next = { ...this.getKey(key), ...patch };
    this.store.update((m) => {
      m[key] = next;
    });
    return next;
  }

  /**
   * All settings entries whose projectPath matches (for bidirectional
   * bot ↔ forum session discovery).
   */
  entriesForProject(projectPath: string): Array<{ key: string; settings: ChatSettings }> {
    const want = normPath(projectPath);
    const out: Array<{ key: string; settings: ChatSettings }> = [];
    for (const [key, s] of Object.entries(this.store.get())) {
      if (s.projectPath && normPath(s.projectPath) === want) {
        out.push({ key, settings: s });
      }
      for (const cs of s.controlledSessions ?? []) {
        if (cs.projectPath && normPath(cs.projectPath) === want) {
          out.push({ key, settings: s });
          break;
        }
      }
    }
    return out;
  }

  /** All chat ids that have interacted (for broadcast announcements). */
  chatIds(): number[] {
    const ids = new Set<number>();
    for (const key of Object.keys(this.store.get())) {
      const n = Number(key.split(":")[0]);
      if (Number.isFinite(n)) ids.add(n);
    }
    return [...ids];
  }
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
