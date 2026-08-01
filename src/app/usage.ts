/**
 * Account + Grok CLI billing usage.
 *
 * Identity comes from ~/.grok/auth.json. Live Grok Build quota is fetched from
 * the same CLI chat proxy OmniRoute-style clients use:
 *   GET https://cli-chat-proxy.grok.com/v1/billing
 * with the OIDC token from `grok login` (Bearer).
 *
 * Session-level context/credits still come from ACP `_grok.dev/metadata`.
 */
import { createLogger } from "../logger.js";
import {
  currentAuthEntry,
  currentToken,
  hasLogin,
  identityFromAuth,
  loginLabel,
} from "./grok-credentials.js";

const log = createLogger("usage");

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
/** Cache live billing for a short window so /usage + /accounts don't spam the API. */
const BILLING_TTL_MS = 30_000;

export interface AccountInfo {
  /** Signed-in identity (email when the token carries one, else a label). */
  email?: string;
  /** Subscription/plan, when known. */
  accountType?: string;
  region?: string;
  /** Stable identifier for matching saved accounts. */
  startUrl?: string;
  /** JWT tier claim when present (Grok CLI subscription tier). */
  tier?: string | number;
  teamId?: string;
}

/** Live Grok CLI monthly quota from cli-chat-proxy. */
export interface GrokCliBilling {
  /** Included monthly allowance (raw units from the API). */
  monthlyLimit: number;
  /** Used so far this billing period. */
  used: number;
  /** Remaining = max(0, limit - used). */
  remaining: number;
  /** 0–100 percent of monthly limit consumed. */
  usedPct: number;
  onDemandCap: number;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  /** Prior cycles when the API returns them. */
  history?: Array<{ year: number; month: number; totalUsed: number }>;
  fetchedAt: string;
}

interface BillingCache {
  at: number;
  data?: GrokCliBilling;
  error?: string;
}

export class UsageService {
  private billingCache: BillingCache | undefined;

  // Kept for signature compatibility; Grok state lives in ~/.grok/auth.json.
  constructor(private readonly grokCliPath: string) {}

  async account(): Promise<AccountInfo | undefined> {
    if (!hasLogin()) {
      if (process.env.XAI_API_KEY?.trim()) return { email: "XAI_API_KEY", accountType: "api key" };
      return undefined;
    }
    const id = identityFromAuth();
    const label = loginLabel();
    const entry = currentAuthEntry();
    const tok = currentToken();
    let tier: string | number | undefined;
    let teamId = typeof entry?.team_id === "string" ? entry.team_id : undefined;
    if (tok) {
      const claims = decodeJwt(tok);
      if (claims?.tier !== undefined) tier = claims.tier as string | number;
      if (!teamId && typeof claims?.team_id === "string") teamId = claims.team_id;
    }
    return {
      email: id.email || label,
      accountType: tier !== undefined ? `tier ${tier}` : undefined,
      startUrl: label,
      tier,
      teamId,
    };
  }

  /** Whether Grok has a usable sign-in (browser token or XAI_API_KEY). */
  async isLoggedIn(): Promise<boolean> {
    return hasLogin();
  }

  /**
   * Live Grok Build monthly quota for the active CLI login.
   * Same endpoint OmniRoute uses for grok-cli remaining % dashboards.
   */
  async cliBilling(force = false): Promise<{ billing?: GrokCliBilling; error?: string }> {
    const now = Date.now();
    if (
      !force &&
      this.billingCache &&
      now - this.billingCache.at < BILLING_TTL_MS
    ) {
      return { billing: this.billingCache.data, error: this.billingCache.error };
    }

    const token = currentToken();
    if (!token) {
      if (process.env.XAI_API_KEY?.trim()) {
        return { error: "XAI_API_KEY mode — CLI monthly quota is only available after `grok login`" };
      }
      return { error: "Not signed in (no grok login token)" };
    }

    try {
      const res = await fetch(BILLING_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        const err = `billing HTTP ${res.status}`;
        log.warn(err);
        this.billingCache = { at: now, error: err };
        return { error: err };
      }
      const json = (await res.json()) as BillingWire;
      const billing = parseBilling(json);
      this.billingCache = { at: now, data: billing };
      return { billing };
    } catch (e) {
      const err = (e as Error).message || "billing fetch failed";
      log.warn("cli billing:", err);
      this.billingCache = { at: now, error: err };
      return { error: err };
    }
  }
}

interface BillingWire {
  config?: {
    monthlyLimit?: { val?: number };
    used?: { val?: number };
    onDemandCap?: { val?: number };
    billingPeriodStart?: string;
    billingPeriodEnd?: string;
    history?: Array<{
      billingCycle?: { year?: number; month?: number };
      totalUsed?: { val?: number };
      includedUsed?: { val?: number };
      onDemandUsed?: { val?: number };
    }>;
  };
}

function parseBilling(json: BillingWire): GrokCliBilling {
  const c = json.config ?? {};
  const monthlyLimit = num(c.monthlyLimit?.val);
  const used = num(c.used?.val);
  const remaining = Math.max(0, monthlyLimit - used);
  const usedPct = monthlyLimit > 0 ? Math.min(100, Math.round((used / monthlyLimit) * 1000) / 10) : 0;
  const history = (c.history ?? [])
    .map((h) => ({
      year: h.billingCycle?.year ?? 0,
      month: h.billingCycle?.month ?? 0,
      totalUsed: num(h.totalUsed?.val ?? h.includedUsed?.val),
    }))
    .filter((h) => h.year > 0);
  return {
    monthlyLimit,
    used,
    remaining,
    usedPct,
    onDemandCap: num(c.onDemandCap?.val),
    billingPeriodStart: c.billingPeriodStart,
    billingPeriodEnd: c.billingPeriodEnd,
    history: history.length ? history : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function decodeJwt(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Format billing for Telegram plain-text UIs. */
export function formatCliBillingLines(b: GrokCliBilling): string[] {
  const lines = [
    "\u{1F4B3} Grok CLI monthly quota (cli-chat-proxy)",
    `  Used: ${fmt(b.used)} / ${fmt(b.monthlyLimit)} (${b.usedPct}%)`,
    `  Remaining: ${fmt(b.remaining)}`,
  ];
  if (b.billingPeriodStart || b.billingPeriodEnd) {
    lines.push(
      `  Period: ${fmtDate(b.billingPeriodStart)} \u2192 ${fmtDate(b.billingPeriodEnd)}`,
    );
  }
  if (b.onDemandCap > 0) lines.push(`  On-demand cap: ${fmt(b.onDemandCap)}`);
  if (b.history?.length) {
    const prev = b.history
      .slice(0, 3)
      .map((h) => `${h.year}-${String(h.month).padStart(2, "0")}: ${fmt(h.totalUsed)}`)
      .join(" \u00B7 ");
    lines.push(`  History: ${prev}`);
  }
  return lines;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtDate(iso?: string): string {
  if (!iso) return "\u2014";
  return iso.slice(0, 10);
}
