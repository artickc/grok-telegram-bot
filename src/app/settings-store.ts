/**
 * Per-chat settings persistence (project, agent, model, reasoning, pinned
 * status message id). Backed by a single JSON file so state survives restarts.
 */
import { join } from "node:path";
import { JsonStore } from "./json-store.js";
import { type ChatSettings, defaultSettings } from "./types.js";

type SettingsMap = Record<string, ChatSettings>;

export class SettingsStore {
  private readonly store: JsonStore<SettingsMap>;
  private readonly prefix: string;

  constructor(dataDir: string, namespace?: string) {
    this.store = new JsonStore<SettingsMap>(join(dataDir, "settings.json"), {});
    this.prefix = namespace ? `${namespace}:` : "";
  }

  get(chatId: number): ChatSettings {
    const existing = this.store.get()[this.key(chatId)];
    return existing ?? defaultSettings();
  }

  update(chatId: number, patch: Partial<ChatSettings>): ChatSettings {
    const key = this.key(chatId);
    const next = { ...this.get(chatId), ...patch };
    this.store.update((m) => {
      m[key] = next;
    });
    return next;
  }

  /** Chat ids in this namespace that have interacted (for broadcasts). */
  chatIds(): number[] {
    return Object.keys(this.store.get())
      .filter((k) => this.ownsKey(k))
      .map((k) => Number(this.prefix ? k.slice(this.prefix.length) : k))
      .filter((n) => Number.isFinite(n));
  }

  /** True when this namespace persisted `sessionId` for any of its chats. */
  hasSession(sessionId: string): boolean {
    for (const chatId of this.chatIds()) {
      const s = this.get(chatId);
      if (s.sessionId === sessionId) return true;
      if (s.controlledSessions?.some((c) => c.sessionId === sessionId)) return true;
    }
    return false;
  }

  private key(chatId: number): string {
    return `${this.prefix}${chatId}`;
  }

  private ownsKey(key: string): boolean {
    if (!this.prefix) return !key.includes(":");
    return key.startsWith(this.prefix);
  }
}
