/**
 * Auto-rotate-on-give-up. When a turn exhausts its retries (and auto-fork can't
 * recover it), the runtime can cycle through the OTHER saved Grok accounts,
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
 */
import type { GrokClient } from "../grok/client.js";
import type { AccountManager } from "../app/accounts.js";

export interface RotationTarget {
  id: string;
  label: string;
}

export interface AccountRotator {
  /** Whether auto-rotate is switched on. */
  enabled(): boolean;
  /** Saved accounts to try, EXCLUDING the one that's currently active. */
  targets(): Promise<RotationTarget[]>;
  /** Make a saved account active (swap the sign-in + re-bind). Throws on error. */
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

  async activate(id: string): Promise<void> {
    await this.accounts.switchTo(id);
    await this.acp.restart();
  }
}
