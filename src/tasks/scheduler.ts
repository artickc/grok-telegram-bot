/**
 * Scheduler — ticks periodically, runs due tasks one at a time, and reschedules
 * them. One-off tasks are disabled after running.
 */
import { createLogger } from "../logger.js";
import type { TaskRunner } from "./runner.js";
import { computeNextRun } from "./schedule.js";
import type { TaskStore } from "./store.js";

const log = createLogger("scheduler");
const TICK_MS = 30_000;

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: TaskStore,
    private readonly runner: TaskRunner,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    log.info(`scheduler started (tick ${TICK_MS / 1000}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // never overlap runs
    const due = this.store.due();
    if (due.length === 0) return;
    this.running = true;
    try {
      for (const task of due) {
        const ok = await this.runner.run(task);
        const isOnce = task.schedule.type === "once";
        this.store.update(task.id, {
          lastRun: Date.now(),
          lastStatus: ok ? "ok" : "error",
          enabled: isOnce ? false : task.enabled,
          nextRun: isOnce ? undefined : computeNextRun(task.schedule, Date.now() + 1000),
        });
      }
    } finally {
      this.running = false;
    }
  }
}
