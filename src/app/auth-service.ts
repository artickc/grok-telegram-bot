/**
 * Grok authentication control for /reauth: `grok logout` then `grok login`.
 * `grok login` performs the xAI account sign-in; on a bot host without a
 * browser it prints a verification URL/code, which we stream back to Telegram.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import { authFileExists, hasLogin, loginLabel } from "./grok-credentials.js";

const run = promisify(execFile);
const log = createLogger("auth");

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export interface LoginResult {
  ok: boolean;
  code: number | null;
  cancelled?: boolean;
  error?: string;
}

export interface LoginOptions {
  onOutput: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class AuthService {
  constructor(private readonly grokCliPath: string) {}

  /** Run `grok logout` (non-interactive, best-effort). */
  async logout(): Promise<{ ok: boolean; out: string }> {
    try {
      const { stdout, stderr } = await run(this.grokCliPath, ["logout"], { timeout: 30_000, encoding: "utf-8" });
      return { ok: true, out: clean(`${stdout}${stderr}`) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const out = clean(`${err.stdout ?? ""}${err.stderr ?? ""}`) || err.message || "logout failed";
      return { ok: false, out };
    }
  }

  /**
   * Adopt an existing sign-in already present on this machine (a prior
   * `grok login` wrote ~/.grok/auth.json). Returns ok:false with guidance when
   * none is present.
   */
  async importExisting(): Promise<{ ok: boolean; error?: string; label?: string }> {
    if (hasLogin()) return { ok: true, label: loginLabel() };
    if (!authFileExists()) {
      return {
        ok: false,
        error: "No Grok login found. Run `grok login` on the host (or set XAI_API_KEY), then try again.",
      };
    }
    return { ok: false, error: "The Grok auth file has no usable token — run `grok login` again." };
  }

  /**
   * Run `grok login`, streaming stdout/stderr (so any verification URL/code
   * reaches the user). Resolves when the process exits, times out, or aborts.
   */
  login(opts: LoginOptions): Promise<LoginResult> {
    const { onOutput, timeoutMs = 300_000, signal } = opts;
    return new Promise<LoginResult>((resolve) => {
      if (signal?.aborted) return resolve({ ok: false, code: null, cancelled: true });
      let proc;
      try {
        // Prefer device-code login so a headless/service host never opens a
        // browser window (which hangs the bot). The verification URL + code are
        // streamed to Telegram via onOutput.
        proc = spawn(this.grokCliPath, ["login", "--device-auth"], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        onOutput(`error: ${(e as Error).message}`);
        return resolve({ ok: false, code: null });
      }
      let cancelled = false;
      let settled = false;
      let hardKill: NodeJS.Timeout | undefined;

      const onAbort = (): void => {
        cancelled = true;
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        hardKill = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2000);
      };
      const finish = (r: LoginResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardKill) clearTimeout(hardKill);
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const feed = (b: Buffer): void => {
        const t = clean(b.toString("utf-8"));
        if (t) onOutput(t);
      };
      proc.stdout?.on("data", feed);
      proc.stderr?.on("data", feed);
      const timer = setTimeout(() => {
        onOutput("\n\u23F1\uFE0F Timed out waiting for login to complete.");
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      proc.on("error", (e: Error) => {
        onOutput(`error: ${e.message}`);
        finish({ ok: false, code: null, cancelled });
      });
      proc.on("exit", (code: number | null) => {
        // Success = clean exit AND a usable token now on disk.
        finish({ ok: code === 0 && !cancelled && hasLogin(), code, cancelled });
      });
    });
  }

  isConfigured(): boolean {
    return hasLogin();
  }
}

function clean(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r/g, "");
}
