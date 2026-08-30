/**
 * Poll PROJECT_ROOTS for new top-level project folders and notify the caller
 * (ForumManager creates Telegram topics). Polling matches session-tail style —
 * more reliable than fs.watch alone on Windows.
 */
import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import {
  type ProjectEntry,
  shouldIgnoreProjectDirName,
} from "./manager.js";

const log = createLogger("projects:watch");

export type RootsWatcherFs = {
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isDirectory(): boolean; mtimeMs: number };
};

const defaultFs: RootsWatcherFs = {
  readdirSync: (p) => readdirSync(p),
  statSync: (p) => {
    const st = statSync(p);
    return { isDirectory: () => st.isDirectory(), mtimeMs: st.mtimeMs };
  },
};

/** List immediate project dirs under one root (same rules as ProjectManager). */
export function listRootProjectDirs(
  root: string,
  fsApi: RootsWatcherFs = defaultFs,
): ProjectEntry[] {
  let children: string[];
  try {
    children = fsApi.readdirSync(root);
  } catch (e) {
    log.debug(`cannot read root ${root}:`, (e as Error).message);
    return [];
  }
  const out: ProjectEntry[] = [];
  for (const child of children) {
    if (shouldIgnoreProjectDirName(child)) continue;
    const full = join(root, child);
    try {
      const st = fsApi.statSync(full);
      if (!st.isDirectory()) continue;
      out.push({ name: child, path: full, lastUsed: st.mtimeMs });
    } catch {
      /* race: vanished */
    }
  }
  return out;
}

/** Paths present now that were not in `known` (order stable by name). */
export function diffNewProjectDirs(
  known: ReadonlySet<string>,
  current: ProjectEntry[],
): ProjectEntry[] {
  const news: ProjectEntry[] = [];
  for (const p of current) {
    if (!known.has(p.path)) news.push(p);
  }
  return news.sort((a, b) => a.name.localeCompare(b.name));
}

export type ProjectRootsWatcherOpts = {
  roots: string[];
  intervalMs: number;
  /** Called for each newly seen directory (serialized by the watcher). */
  onNewProject: (entry: ProjectEntry) => Promise<void>;
  /** Skip create if already bound (e.g. TopicStore). */
  isAlreadyMapped?: (path: string) => boolean;
  fs?: RootsWatcherFs;
  /** Attach non-recursive fs.watch for faster wake (best-effort). */
  useFsWatch?: boolean;
};

/**
 * Watches configured project roots for new top-level folders.
 */
export class ProjectRootsWatcher {
  private readonly roots: string[];
  private readonly intervalMs: number;
  private readonly onNewProject: (entry: ProjectEntry) => Promise<void>;
  private readonly isAlreadyMapped?: (path: string) => boolean;
  private readonly fsApi: RootsWatcherFs;
  private readonly useFsWatch: boolean;

  private known = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private watchers: FSWatcher[] = [];
  private running = false;
  private scanning = false;
  private queue: ProjectEntry[] = [];
  private draining = false;
  private debounce: NodeJS.Timeout | undefined;

  constructor(opts: ProjectRootsWatcherOpts) {
    this.roots = [...opts.roots];
    this.intervalMs = Math.max(2_000, opts.intervalMs || 10_000);
    this.onNewProject = opts.onNewProject;
    this.isAlreadyMapped = opts.isAlreadyMapped;
    this.fsApi = opts.fs ?? defaultFs;
    this.useFsWatch = opts.useFsWatch !== false;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Seed known set without creating topics for existing folders.
    this.seedKnown();
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
    this.timer.unref?.();
    if (this.useFsWatch) this.attachFsWatchers();
    log.info(
      `watching ${this.roots.length} project root(s) every ${this.intervalMs}ms (${this.known.size} known)`,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
    this.queue = [];
  }

  /** Expose known paths for tests. */
  get knownPaths(): ReadonlySet<string> {
    return this.known;
  }

  private seedKnown(): void {
    for (const root of this.roots) {
      for (const p of listRootProjectDirs(root, this.fsApi)) {
        this.known.add(p.path);
      }
    }
  }

  private attachFsWatchers(): void {
    for (const root of this.roots) {
      try {
        const w = watch(root, { persistent: false }, () => {
          if (!this.running) return;
          if (this.debounce) clearTimeout(this.debounce);
          this.debounce = setTimeout(() => void this.scan(), 400);
          this.debounce.unref?.();
        });
        w.on("error", (err) => {
          log.debug(`fs.watch error on ${root}: ${(err as Error).message}`);
        });
        this.watchers.push(w);
      } catch (e) {
        log.debug(`fs.watch unavailable for ${root}: ${(e as Error).message}`);
      }
    }
  }

  private async scan(): Promise<void> {
    if (!this.running || this.scanning) return;
    this.scanning = true;
    try {
      const current: ProjectEntry[] = [];
      for (const root of this.roots) {
        current.push(...listRootProjectDirs(root, this.fsApi));
      }
      const news = diffNewProjectDirs(this.known, current);
      for (const p of news) {
        this.known.add(p.path);
        if (this.isAlreadyMapped?.(p.path)) continue;
        this.queue.push(p);
      }
      void this.drainQueue();
    } finally {
      this.scanning = false;
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.running && this.queue.length > 0) {
        const next = this.queue.shift()!;
        if (this.isAlreadyMapped?.(next.path)) continue;
        try {
          await this.onNewProject(next);
          log.info(`new project folder → topic: ${next.name} (${next.path})`);
        } catch (e) {
          log.warn(`failed to map new project ${next.name}: ${(e as Error).message}`);
        }
        // Pace Telegram creates similar to bulk setup.
        if (this.queue.length > 0) await sleep(500);
      }
    } finally {
      this.draining = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
