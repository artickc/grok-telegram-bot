/**
 * Grok Build login state. The official CLI signs in with your xAI account
 * (`grok login`, browser OIDC) and stores the token in `~/.grok/auth.json`:
 *
 *   { "<scope_url>": { "key": "<token>" }, ... }
 *
 * (An `XAI_API_KEY` env var is an alternative for non-browser hosts.) This
 * module reads that file so the bot can show who's signed in, detect a usable
 * login, and snapshot/switch logins as named accounts (/accounts). The token is
 * never transmitted anywhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** Guidance shown when no usable login is configured. */
export const UNSUPPORTED_LOGIN_HELP =
  "Grok isn't signed in. Run `grok login` on the machine hosting the bot (or use " +
  "/reauth), or set XAI_API_KEY. You need a SuperGrok or X Premium+ subscription.";

/** OIDC + legacy sign-in scope keys used in ~/.grok/auth.json. */
const OIDC_SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const LEGACY_SCOPE = "https://accounts.x.ai/sign-in";

export function grokConfigDir(): string {
  return join(homedir(), ".grok");
}

/** Path to the Grok CLI auth token file (written by `grok login`). */
export function grokAuthPath(): string {
  return join(grokConfigDir(), "auth.json");
}

export function authFileExists(): boolean {
  return existsSync(grokAuthPath());
}

type AuthFile = Record<string, { key?: string } | undefined>;

export function readAuth(): AuthFile {
  try {
    return JSON.parse(readFileSync(grokAuthPath(), "utf-8")) as AuthFile;
  } catch {
    return {};
  }
}

/** The active sign-in token from auth.json (OIDC preferred, then legacy). */
export function currentToken(auth: AuthFile = readAuth()): string | undefined {
  const oidc = auth[OIDC_SCOPE]?.key?.trim();
  if (oidc) return oidc;
  const legacy = auth[LEGACY_SCOPE]?.key?.trim();
  return legacy || undefined;
}

/** Whether a usable login exists (a token in auth.json, or XAI_API_KEY). */
export function hasLogin(): boolean {
  return !!currentToken() || !!process.env.XAI_API_KEY?.trim();
}

/** A stable, non-reversible id for the active login, for account dedup/match. */
export function loginId(auth: AuthFile = readAuth()): string | undefined {
  const tok = currentToken(auth);
  if (!tok) return undefined;
  return createHash("sha256").update(tok).digest("hex").slice(0, 16);
}

export interface LoginIdentity {
  email?: string;
  name?: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Best-effort identity (email/name) decoded from the sign-in JWT. */
export function identityFromAuth(auth: AuthFile = readAuth()): LoginIdentity {
  const tok = currentToken(auth);
  if (!tok) return {};
  const claims = decodeJwtPayload(tok);
  if (!claims) return {};
  const str = (k: string): string | undefined => (typeof claims[k] === "string" ? (claims[k] as string) : undefined);
  const emailish = str("email") || str("preferred_username") || str("upn");
  const email = emailish && emailish.includes("@") ? emailish : undefined;
  return { email, name: str("name") || str("given_name") };
}

/** A short human label for the active login (email, else a short token hash). */
export function loginLabel(auth: AuthFile = readAuth()): string | undefined {
  const id = identityFromAuth(auth);
  if (id.email) return id.email;
  if (id.name) return id.name;
  const lid = loginId(auth);
  return lid ? `account ${lid.slice(0, 6)}` : undefined;
}
