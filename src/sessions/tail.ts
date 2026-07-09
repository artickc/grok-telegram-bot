/**
 * TailWatcher — follows a session's .jsonl event log and emits newly appended
 * entries. Polling (not fs.watch) is used because it is reliable for appends
 * across platforms and network drives.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createLogger } from "../logger.js";
import { parseEventLine } from "./history.js";
import type { HistoryEntry } from "./types.js";

const log = createLogger("sessions:tail");

export class TailWatcher {
  private pos = 0;
  private remainder = "";
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly path: string,
    private readonly onEntries: (entries: HistoryEntry[]) => void,
    private readonly intervalMs = 1500,
  ) {}

  /** Start watching. From the current end of file by default (only new events). */
  start(fromEnd = true): void {
    if (this.timer) return;
    try {
      this.pos = fromEnd ? statSync(this.path).size : 0;
    } catch {
      this.pos = 0;
    }
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  private poll(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size === this.pos) return;
    if (size < this.pos) {
      // File rotated/truncated — restart from the beginning.
      this.pos = 0;
      this.remainder = "";
    }

    const length = size - this.pos;
    let chunk = "";
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, this.pos);
      chunk = buf.toString("utf-8");
    } catch (e) {
      log.debug("tail read failed:", (e as Error).message);
      return;
    } finally {
      closeSync(fd);
    }
    this.pos = size;

    const text = this.remainder + chunk;
    const lines = text.split("\n");
    this.remainder = lines.pop() ?? ""; // keep last partial line

    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      const entry = parseEventLine(line);
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) this.onEntries(entries);
  }
}
