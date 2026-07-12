/**
 * Multi-account support for Grok Build. Grok has one active sign-in at a time
 * (`~/.grok/auth.json`, written by `grok login`). This manager keeps several
 * logins side by side and switches between them:
 *
 *   • capture — snapshot the current auth.json as a named account,
 *   • switch  — copy a saved snapshot back over auth.json (the caller restarts
 *               the agent so the new identity takes effect),
 *   • forget  — drop a saved snapshot.
 *
 * Snapshots are copies of auth.json under `<dataDir>/accounts/` (git-ignored).
 * The index stores only a label + token hash, never the token itself.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { JsonStore } from "./json-store.js";
import { grokAuthPath, hasLogin, loginId, loginLabel } from "./grok-credentials.js";
import type { AccountInfo } from "./usage.js";

const log = createLogger("accounts");

/** Persisted, non-secret metadata about a saved account. */
export interface StoredAccount {
  id: string;
  label: string;
  /** Hash of the sign-in token — the robust identity used to dedup/match. */
  loginId?: string;
  email?: string;
  savedAt: string;
  // Back-compat alias used by some callers.
  startUrl?: string;
  accountType?: string;
  region?: string;
}

interface AccountsData {
  accounts: StoredAccount[];
  autoRotate?: boolean;
  /** Explicitly tracked active account id (survives token-hash drift after refresh). */
  activeId?: string;
}

function makeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class AccountManager {
  private readonly store: JsonStore<AccountsData>;
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "accounts");
    this.store = new JsonStore<AccountsData>(join(this.dir, "index.json"), { accounts: [] });
  }

  list(): StoredAccount[] {
    return [...this.store.get().accounts].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  autoRotateEnabled(): boolean {
    return this.store.get().autoRotate === true;
  }

  setAutoRotate(on?: boolean): boolean {
    const next = on ?? !this.autoRotateEnabled();
    this.store.update((d) => {
      d.autoRotate = next;
    });
    return next;
  }

  matchActive(key: string | undefined): StoredAccount | undefined {
    if (!key) return undefined;
    return this.store.get().accounts.find((a) => a.email === key || a.startUrl === key || a.loginId === key);
  }

  /**
   * Id of the currently active saved account. Prefers the last switch target
   * (`activeId`), then falls back to matching the live auth.json token hash.
   */
  activeAccountId(): string | undefined {
    const data = this.store.get();
    if (data.activeId && data.accounts.some((a) => a.id === data.activeId)) {
      return data.activeId;
    }
    const lid = loginId();
    if (!lid) return undefined;
    return data.accounts.find((a) => a.loginId === lid)?.id;
  }

  get(id: string): StoredAccount | undefined {
    return this.store.get().accounts.find((a) => a.id === id);
  }

  private snapshotPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * Snapshot the current sign-in (auth.json) as a saved account. Refreshes an
   * existing account with the same token instead of duplicating. Throws when
   * not signed in.
   */
  async captureCurrent(_info?: AccountInfo, customLabel?: string): Promise<StoredAccount> {
    if (!hasLogin()) throw new Error("Not signed in — run /reauth (grok login) first.");
    const lid = loginId();
    if (!lid) throw new Error("No browser sign-in to save (an XAI_API_KEY-only login can't be snapshotted).");
    await mkdir(this.dir, { recursive: true });
    // Prefer a usable token in the live file; reject empty/corrupt auth.json.
    const raw = await readFile(grokAuthPath(), "utf-8").catch(() => undefined);
    if (!raw?.trim()) throw new Error("auth.json is empty or missing — run /reauth first.");
    try {
      JSON.parse(raw);
    } catch {
      throw new Error("auth.json is not valid JSON — run /reauth to repair it.");
    }
    const label = customLabel?.trim() || loginLabel() || `account ${lid.slice(0, 6)}`;
    const email = loginLabel();
    // Match by token hash first; fall back to the currently marked active slot
    // when the user is re-saving after a silent token refresh.
    const existing =
      this.store.get().accounts.find((a) => a.loginId === lid) ??
      (this.store.get().activeId ? this.get(this.store.get().activeId!) : undefined);
    const id = existing?.id ?? makeId();
    await writeFile(this.snapshotPath(id), raw, "utf-8");
    const meta: StoredAccount = {
      id,
      label: customLabel?.trim() || existing?.label || label,
      loginId: lid,
      email: email || existing?.email,
      startUrl: email || existing?.email,
      savedAt: new Date().toISOString(),
    };
    this.store.update((d) => {
      const idx = d.accounts.findIndex((a) => a.id === id);
      if (idx >= 0) d.accounts[idx] = meta;
      else d.accounts.push(meta);
      d.activeId = id;
    });
    log.info(`captured account ${meta.label} (${id})`);
    return meta;
  }

  /**
   * Make a saved account the active sign-in by copying its snapshot over
   * auth.json. The caller MUST stop the ACP agent first (so it cannot rewrite
   * auth.json mid-swap), then restart after this returns. Never opens a
   * browser — pure file replace. Throws when the snapshot is missing/invalid.
   */
  async switchTo(id: string): Promise<StoredAccount> {
    const meta = this.get(id);
    if (!meta) throw new Error("That account is no longer saved.");
    const snap = this.snapshotPath(id);
    const raw = await readFile(snap, "utf-8").catch(() => undefined);
    if (!raw?.trim()) throw new Error(`Saved login for ${meta.label} is missing — re-add it.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Saved login for ${meta.label} is corrupt — re-save it via /accounts.`);
    }
    // Sanity-check: snapshot must look like auth.json (object with at least one key).
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed as object).length === 0) {
      throw new Error(`Saved login for ${meta.label} has no token — re-save it via /accounts.`);
    }
    await mkdir(join(grokAuthPath(), ".."), { recursive: true });
    await writeFile(grokAuthPath(), raw, "utf-8");
    this.store.update((d) => {
      d.activeId = id;
    });
    log.info(`switched active login to ${meta.label} (${id}) — auth.json replaced`);
    return meta;
  }

  rename(id: string, label: string): StoredAccount | undefined {
    const clean = label.trim();
    if (!clean) return this.get(id);
    let updated: StoredAccount | undefined;
    this.store.update((d) => {
      const a = d.accounts.find((x) => x.id === id);
      if (a) {
        a.label = clean;
        updated = a;
      }
    });
    return updated;
  }

  async forget(id: string): Promise<boolean> {
    const existed = !!this.get(id);
    await rm(this.snapshotPath(id), { force: true }).catch(() => {});
    this.store.update((d) => {
      d.accounts = d.accounts.filter((a) => a.id !== id);
      if (d.activeId === id) d.activeId = undefined;
    });
    return existed;
  }
}
