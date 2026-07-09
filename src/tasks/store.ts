/**
 * Task persistence and CRUD, backed by a JSON file.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { JsonStore } from "../app/json-store.js";
import { computeNextRun } from "./schedule.js";
import type { Task } from "./types.js";

export class TaskStore {
  private readonly store: JsonStore<Task[]>;

  constructor(dataDir: string) {
    this.store = new JsonStore<Task[]>(join(dataDir, "tasks.json"), []);
  }

  all(): Task[] {
    return this.store.get();
  }

  forChat(chatId: number): Task[] {
    return this.all()
      .filter((t) => t.chatId === chatId)
      .sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity));
  }

  get(id: string): Task | undefined {
    return this.all().find((t) => t.id === id);
  }

  create(input: Omit<Task, "id" | "createdAt" | "enabled" | "nextRun">): Task {
    const task: Task = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now(),
      enabled: true,
      nextRun: computeNextRun(input.schedule),
    };
    this.store.update((list) => {
      list.push(task);
    });
    return task;
  }

  update(id: string, patch: Partial<Task>): Task | undefined {
    let updated: Task | undefined;
    this.store.update((list) => {
      const i = list.findIndex((t) => t.id === id);
      if (i === -1) return;
      const merged = { ...list[i]!, ...patch };
      // Recompute nextRun automatically unless the caller set it explicitly.
      if (!("nextRun" in patch)) {
        if (!merged.enabled) merged.nextRun = undefined;
        else if (patch.schedule || patch.enabled !== undefined) {
          merged.nextRun = computeNextRun(merged.schedule);
        }
      }
      list[i] = merged;
      updated = merged;
    });
    return updated;
  }

  delete(id: string): boolean {
    let removed = false;
    this.store.update((list) => {
      const i = list.findIndex((t) => t.id === id);
      if (i !== -1) {
        list.splice(i, 1);
        removed = true;
      }
    });
    return removed;
  }

  /** Tasks that are enabled and due to run at/under `now`. */
  due(now = Date.now()): Task[] {
    return this.all().filter((t) => t.enabled && t.nextRun !== undefined && t.nextRun <= now);
  }
}
