/**
 * Process control helpers for Grok sessions: force-killing the process that
 * holds a session's `.lock` (its `lockPid`). Shared by /killall and the
 * per-session kill button so the behaviour stays identical.
 */
import { execFileSync } from "node:child_process";
import { createLogger } from "../logger.js";

const log = createLogger("sessions:process");

/**
 * Force-kill a process by PID — and its child tree on Windows (`taskkill /T`),
 * which a `grok` session may have spawned (shells, tools). Returns whether
 * the kill command was issued without throwing. A non-existent PID or one we
 * may not signal counts as failure (callers report it).
 */
export function killPid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
    return true;
  } catch (e) {
    log.debug(`kill ${pid} failed:`, (e as Error).message);
    return false;
  }
}
