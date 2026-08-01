/**
 * Persist forum topic ↔ project bindings under the bot data directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForumTopicBinding, ForumTopicState, TopicKind } from "./types.js";

export class TopicStore {
  private readonly file: string;
  private state: ForumTopicState;

  constructor(dataDir: string, groupId: number) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, `forum-topics-${groupId}.json`);
    this.state = this.load(groupId);
  }

  get groupId(): number {
    return this.state.groupId;
  }

  all(): ForumTopicBinding[] {
    return Object.values(this.state.topics);
  }

  get(threadId: number): ForumTopicBinding | undefined {
    return this.state.topics[String(threadId)];
  }

  upsert(binding: ForumTopicBinding): void {
    this.state.topics[String(binding.threadId)] = { ...binding, updatedAt: Date.now() };
    this.save();
  }

  bindProject(threadId: number, projectPath: string, name?: string, kind: TopicKind = "project"): ForumTopicBinding {
    const prev = this.get(threadId);
    const next: ForumTopicBinding = {
      threadId,
      name: name || prev?.name || basenamePath(projectPath),
      kind,
      projectPath,
      iconPath: prev?.iconPath,
      sessionId: prev?.sessionId,
      updatedAt: Date.now(),
    };
    this.upsert(next);
    this.clearPending(threadId);
    return next;
  }

  markPending(threadId: number): void {
    if (!this.state.pendingBind.includes(threadId)) {
      this.state.pendingBind.push(threadId);
      this.save();
    }
  }

  isPending(threadId: number): boolean {
    return this.state.pendingBind.includes(threadId);
  }

  clearPending(threadId: number): void {
    this.state.pendingBind = this.state.pendingBind.filter((id) => id !== threadId);
    this.save();
  }

  findByProjectPath(projectPath: string): ForumTopicBinding | undefined {
    const key = norm(projectPath);
    return this.all().find((t) => t.projectPath && norm(t.projectPath) === key);
  }

  findAiChat(): ForumTopicBinding | undefined {
    return this.all().find((t) => t.kind === "ai_chat");
  }

  setLastSetup(): void {
    this.state.lastSetupAt = Date.now();
    this.save();
  }

  private load(groupId: number): ForumTopicState {
    if (!existsSync(this.file)) {
      return { groupId, topics: {}, pendingBind: [] };
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<ForumTopicState>;
      return {
        groupId: typeof raw.groupId === "number" ? raw.groupId : groupId,
        topics: (raw.topics && typeof raw.topics === "object" ? raw.topics : {}) as Record<
          string,
          ForumTopicBinding
        >,
        pendingBind: Array.isArray(raw.pendingBind) ? raw.pendingBind.filter((n) => typeof n === "number") : [],
        lastSetupAt: typeof raw.lastSetupAt === "number" ? raw.lastSetupAt : undefined,
      };
    } catch {
      return { groupId, topics: {}, pendingBind: [] };
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf-8");
  }
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function basenamePath(p: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}
