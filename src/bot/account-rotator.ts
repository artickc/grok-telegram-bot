/**
 * Auto-rotate-on-give-up. When a turn exhausts its retries (or fails immediately
 * with a permanent billing error like HTTP 402 balance exhausted) and auto-fork
 * can't recover it, the runtime can cycle through the OTHER saved Grok accounts,
 * retrying the same prompt on each — useful when the active account is
 * throttled, out of quota, or its backend keeps returning "dispatch failure".
 *
 * The rotation is bounded to a SINGLE pass over the saved accounts (no infinite
 * loop): each account is tried once; the first that succeeds wins and stays
 * active, otherwise the runtime reports the error gathered from every account.
 *
 * Account switching is process-global (one machine → one active Grok login), so
 * a rotation restarts the shared agent and affects every chat — intended, since
 * the whole point is to move everyone onto a working login.
 *
 * CRITICAL: every activate() MUST fully restart the CLI so the new auth applies:
 *   1. stop agent (`stopAndWait`) — process must exit so it cannot rewrite auth,
 *   2. replace ~/.grok/auth.json with the saved snapshot,
 *   3. start agent + `authenticate({ methodId: "cached_token" })` headlessly.
 * Never opens a browser / never runs `grok login`.
 */
import type { GrokClient } from "../grok/client.js";
import type { AccountManager } from "../app/accounts.js";
import { createLogger } from "../logger.js";

const log = createLogger("account-rotator");

export interface RotationTarget {
  id: string;
  label: string;
}

export interface AccountRotator {
  /** Whether auto-rotate is switched on. */
  enabled(): boolean;
  /** Saved accounts to try, EXCLUDING the one that's currently active. */
  targets(): Promise<RotationTarget[]>;
  /** Make a saved account active (swap auth.json + re-bind). Throws on error. */
  activate(id: string): Promise<void>;
}

export class AccountRotatorImpl implements AccountRotator {
  constructor(
    private readonly accounts: AccountManager,
    private readonly acp: GrokClient,
  ) {}

  enabled(): boolean {
    return this.accounts.autoRotateEnabled();
  }

  async targets(): Promise<RotationTarget[]> {
    const list = this.accounts.list();
    const activeId = this.accounts.activeAccountId();
    return list.filter((a) => a.id !== activeId).map((a) => ({ id: a.id, label: a.label }));
  }

  /**
   * Pure file-based account swap with a full CLI restart so the new token is
   * loaded (agent is process-local with `--no-leader`):
   *   1. Stop the shared agent and wait for exit (so it cannot rewrite auth.json),
   *   2. Copy the saved snapshot over ~/.grok/auth.json,
   *   3. Start a fresh agent process and authenticate with `cached_token`.
   * Never launches a browser.
   */
  async activate(id: string): Promise<void> {
    // Snapshot the current login first so we never lose it mid-rotation.
    await this.accounts.captureCurrent().catch((e) => {
      log.warn("pre-rotate capture failed (continuing):", (e as Error).message);
    });
    log.info(`rotating: stopping Grok CLI before auth.json swap (${id})`);
    await this.acp.stopAndWait();
    try {
      const meta = await this.accounts.switchTo(id);
      log.info(`rotating: auth.json now ${meta.label}; starting Grok CLI + re-auth`);
      // start() → connect() → initialize + authenticate(cached_token) against
      // the freshly written auth.json. A live process would keep the old token.
      await this.acp.start();
      log.info(`rotating: Grok CLI up on ${meta.label}`);
    } catch (e) {
      // Best-effort recover the agent so the bot stays usable even if the
      // target login was bad.
      await this.acp.start().catch((err) => log.warn("post-rotate restart failed:", (err as Error).message));
      throw e;
    }
  }
}
