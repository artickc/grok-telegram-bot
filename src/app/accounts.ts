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

/** Real usage counters recorded by the bot from completed turns (not billing API). */
export interface AccountUsage {
  /** Completed (non-cancelled) turns on this account. */
  turns: number;
  /**
   * Sum of per-turn credit figures Grok reported via `_grok.dev/metadata`.
   * Only increments when the agent actually sends a credits value.
   */
  credits: number;
  /** ISO timestamp of the last successful turn on this account. */
  lastUsedAt?: string;
  /** Credits reported on the most recent turn (if any). */
  lastTurnCredits?: number;
  /** Context-window % from the most recent turn that reported it. */
  lastContextPct?: number;
}

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
  /** Live usage stats accumulated while this account was active. */
  usage?: AccountUsage;
  /** Excluded from automatic rotation after an account-specific quota/billing failure. */
  warning?: {
    reason: string;
    markedAt: string;
  };
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
   * Id of the saved account that matches the live auth.json (if any).
   * Token hash is authoritative — never trust a stale `activeId` when the host
   * login has changed (e.g. `grok login` / /reauth outside this menu).
   */
  activeAccountId(): string | undefined {
    const data = this.store.get();
    const lid = loginId();
    if (lid) {
      const byToken = data.accounts.find((a) => a.loginId === lid);
      if (byToken) return byToken.id;
      // Live login differs from every saved account (and any stale activeId).
      return undefined;
    }
    // No readable token (API-key-only / missing file) — last switch target only.
    if (data.activeId && data.accounts.some((a) => a.id === data.activeId)) {
      return data.activeId;
    }
    return undefined;
  }

  /**
   * Last switch/save target stored by the app, even when the host Grok login
   * no longer matches that snapshot (used only for mismatch UI copy).
   */
  markedActiveId(): string | undefined {
    const id = this.store.get().activeId;
    if (!id) return undefined;
    return this.store.get().accounts.some((a) => a.id === id) ? id : undefined;
  }

  /** Whether the host's live login matches the saved account marked active. */
  liveMatchesActive(): boolean {
    const lid = loginId();
    if (!lid) return false;
    const marked = this.markedActiveId();
    if (!marked) return this.activeAccountId() !== undefined;
    const meta = this.get(marked);
    return !!meta?.loginId && meta.loginId === lid;
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
    // Match by token hash first. Only reuse the marked active slot when it is
    // the same login (token refresh) or the same email — never overwrite a
    // different saved account when the host is signed in as someone else.
    const accounts = this.store.get().accounts;
    const byToken = accounts.find((a) => a.loginId === lid);
    const active = this.store.get().activeId ? this.get(this.store.get().activeId!) : undefined;
    const emailKey = email?.toLowerCase();
    const byEmail =
      emailKey && emailKey.includes("@")
        ? accounts.find((a) => (a.email || a.label || "").toLowerCase() === emailKey)
        : undefined;
    const sameActiveRefresh =
      active &&
      (active.loginId === lid ||
        (!!emailKey &&
          emailKey.includes("@") &&
          [active.email, active.label].some((v) => (v || "").toLowerCase() === emailKey)));
    const existing = byToken ?? (sameActiveRefresh ? active : undefined) ?? byEmail;
    const id = existing?.id ?? makeId();
    await writeFile(this.snapshotPath(id), raw, "utf-8");
    const meta: StoredAccount = {
      id,
      label: customLabel?.trim() || existing?.label || label,
      loginId: lid,
      email: (email && email.includes("@") ? email : undefined) || existing?.email,
      startUrl: (email && email.includes("@") ? email : undefined) || existing?.email || existing?.startUrl,
      savedAt: new Date().toISOString(),
      // Automatic pre-rotation snapshots must not silently re-enable an
      // account that was quarantined after a quota/billing failure.
      warning: existing?.warning,
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

  /** Mark an account as unsuitable for future automatic rotations. */
  markWarning(id: string, reason: string): StoredAccount | undefined {
    let updated: StoredAccount | undefined;
    this.store.update((d) => {
      const account = d.accounts.find((a) => a.id === id);
      if (account) {
        account.warning = { reason, markedAt: new Date().toISOString() };
        updated = account;
      }
    });
    if (updated) log.warn(`marked account ${updated.label} with rotation warning: ${reason}`);
    return updated;
  }

  /** Re-allow a manually restored account to participate in auto-rotation. */
  clearWarning(id: string): StoredAccount | undefined {
    let updated: StoredAccount | undefined;
    this.store.update((d) => {
      const account = d.accounts.find((a) => a.id === id);
      if (account?.warning) {
        delete account.warning;
        updated = account;
      }
    });
    return updated;
  }

  /**
   * Record a completed turn against the active (or given) saved account.
   * Credits are only added when Grok reported a figure for the turn; turns
   * always increment so /accounts shows real activity even without credits.
   */
  recordTurnUsage(
    stats: { credits?: number; contextPct?: number },
    accountId?: string,
  ): StoredAccount | undefined {
    const id = accountId ?? this.activeAccountId() ?? this.markedActiveId();
    if (!id) return undefined;
    let updated: StoredAccount | undefined;
    this.store.update((d) => {
      const account = d.accounts.find((a) => a.id === id);
      if (!account) return;
      const prev = account.usage ?? { turns: 0, credits: 0 };
      const credits =
        typeof stats.credits === "number" && Number.isFinite(stats.credits) && stats.credits > 0
          ? stats.credits
          : undefined;
      const next: AccountUsage = {
        turns: (prev.turns || 0) + 1,
        credits: (prev.credits || 0) + (credits ?? 0),
        lastUsedAt: new Date().toISOString(),
        lastTurnCredits: credits ?? prev.lastTurnCredits,
        lastContextPct:
          typeof stats.contextPct === "number" && Number.isFinite(stats.contextPct)
            ? stats.contextPct
            : prev.lastContextPct,
      };
      account.usage = next;
      updated = account;
    });
    return updated;
  }

  /** Compact one-line usage summary for menus (empty when no stats yet). */
  formatUsageLine(account: StoredAccount): string {
    const u = account.usage;
    if (!u || (u.turns <= 0 && u.credits <= 0 && !u.lastUsedAt)) return "";
    const parts: string[] = [];
    if (u.turns > 0) parts.push(`${u.turns} turn${u.turns === 1 ? "" : "s"}`);
    if (u.credits > 0) parts.push(`${fmtUsageNumber(u.credits)} credits`);
    if (u.lastUsedAt) parts.push(`last ${fmtRelative(u.lastUsedAt)}`);
    return parts.join(" \u00B7 ");
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

function fmtUsageNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toFixed(2);
}

/** Short relative time for usage lines ("2h ago", "just now"). */
function fmtRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86_400 * 14) return `${Math.floor(sec / 86_400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}
