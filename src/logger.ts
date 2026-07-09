/**
 * Tiny leveled logger with timestamps and optional file output (for daemon
 * mode, where stdout may not be captured).
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;
let filePath: string | undefined;

const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate when the log file exceeds 5 MB

export function setLogLevel(level: string | undefined): void {
  const lvl = (level || "info").toLowerCase() as LogLevel;
  threshold = LEVELS[lvl] ?? LEVELS.info;
}

/** Mirror all log output to a file (rotated once at startup if too large). */
export function enableFileLogging(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.old`);
    } catch {
      /* no existing file */
    }
    filePath = path;
  } catch {
    filePath = undefined;
  }
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(tag, ...args);
  if (filePath) {
    try {
      appendFileSync(filePath, `${tag} ${args.map(stringify).join(" ")}\n`);
    } catch {
      /* non-fatal */
    }
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
  };
}
