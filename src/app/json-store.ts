/**
 * Minimal atomic JSON persistence. Reads on construction, writes atomically
 * (temp file + rename) on save. No external dependencies.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("json-store");

export class JsonStore<T> {
  private data: T;

  constructor(
    private readonly path: string,
    private readonly fallback: T,
  ) {
    this.data = this.read();
  }

  get(): T {
    return this.data;
  }

  set(data: T): void {
    this.data = data;
    this.save();
  }

  /** Mutate via a callback, then persist. */
  update(fn: (data: T) => void): void {
    fn(this.data);
    this.save();
  }

  private read(): T {
    try {
      return JSON.parse(readFileSync(this.path, "utf-8")) as T;
    } catch {
      return structuredClone(this.fallback);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
      renameSync(tmp, this.path);
    } catch (e) {
      log.error(`failed to save ${this.path}:`, (e as Error).message);
    }
  }
}
