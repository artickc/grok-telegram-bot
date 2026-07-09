/**
 * Account info for Grok Build. Grok signs in with your xAI account
 * (`grok login`), so /usage surfaces the signed-in identity (from the token in
 * ~/.grok/auth.json) plus the live per-session context usage the ACP agent
 * reports.
 */
import { hasLogin, identityFromAuth, loginLabel } from "./grok-credentials.js";

export interface AccountInfo {
  /** Signed-in identity (email when the token carries one, else a label). */
  email?: string;
  /** Subscription/plan, when known. */
  accountType?: string;
  region?: string;
  /** Stable identifier for matching saved accounts. */
  startUrl?: string;
}

export class UsageService {
  // Kept for signature compatibility; Grok state lives in ~/.grok/auth.json.
  constructor(private readonly grokCliPath: string) {}

  async account(): Promise<AccountInfo | undefined> {
    if (!hasLogin()) {
      // XAI_API_KEY with no browser login still counts as usable.
      if (process.env.XAI_API_KEY?.trim()) return { email: "XAI_API_KEY", accountType: "api key" };
      return undefined;
    }
    const id = identityFromAuth();
    const label = loginLabel();
    return { email: id.email || label, accountType: undefined, startUrl: label };
  }

  /** Whether Grok has a usable sign-in (browser token or XAI_API_KEY). */
  async isLoggedIn(): Promise<boolean> {
    return hasLogin();
  }
}
