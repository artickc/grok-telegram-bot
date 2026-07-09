/**
 * ReauthController — signs in to Grok from chat. `/reauth` offers "Sign in"
 * (runs `grok login`, streaming any verification URL/code to the chat) or
 * "Import existing" (adopt a login already on the host). The agent is taken
 * down before sign-in and restarted after, so it re-binds under the new
 * identity. State is per chat so button callbacks work across updates.
 */
import { type Api, InlineKeyboard } from "grammy";
import type { GrokClient } from "../grok/client.js";
import { AuthService } from "../app/auth-service.js";
import type { AccountInfo } from "../app/usage.js";
import { createLogger } from "../logger.js";

const log = createLogger("reauth");

const LOADER = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰"];
const ANIM_MS = 2500;
const LOGIN_TIMEOUT_MS = 300_000;

type Phase = "choosing" | "login" | "restarting" | "done" | "failed" | "cancelled";
const ACTIVE: ReadonlySet<Phase> = new Set<Phase>(["login", "restarting"]);

interface ReauthSession {
  chatId: number;
  messageId: number;
  phase: Phase;
  abort?: AbortController;
  anim?: NodeJS.Timeout;
  frame: number;
  url?: string;
  code?: string;
  errorMsg?: string;
  accountLabel?: string;
  lastText?: string;
}

/** Pull a verification URL and short code out of streaming login output. */
function parseLoginOutput(raw: string): { url?: string; code?: string } {
  const text = raw.replace(/\r/g, "");
  const url = text.match(/https?:\/\/[^\s'"<>)\]]+/i)?.[0];
  const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0] ?? text.match(/code[:\s]+([A-Z0-9][A-Z0-9-]{3,})/i)?.[1];
  return { url, code };
}

export class ReauthController {
  private readonly auth: AuthService;
  private readonly sessions = new Map<number, ReauthSession>();

  constructor(
    private readonly api: Api,
    private readonly grok: GrokClient,
    grokCliPath: string,
    private readonly getAccount?: () => Promise<AccountInfo | undefined>,
    private readonly verifyLogin?: () => Promise<boolean>,
  ) {
    this.auth = new AuthService(grokCliPath);
  }

  isBusy(chatId: number): boolean {
    const s = this.sessions.get(chatId);
    return !!s && ACTIVE.has(s.phase);
  }

  private anyActive(): boolean {
    for (const s of this.sessions.values()) if (ACTIVE.has(s.phase)) return true;
    return false;
  }

  /** Show the sign-in entry screen. */
  async chooseMethod(chatId: number, existingMessageId?: number): Promise<void> {
    if (this.isBusy(chatId)) return;
    let messageId = existingMessageId;
    if (messageId === undefined) {
      const m = await this.api.sendMessage(chatId, "\u{1F510} Sign in to Grok\u2026").catch(() => undefined);
      if (!m) return;
      messageId = m.message_id;
    }
    const s: ReauthSession = { chatId, messageId, phase: "choosing", frame: 0 };
    this.sessions.set(chatId, s);
    await this.render(s);
  }

  /** Run `grok logout` + `grok login`, then restart the agent. */
  async beginLogin(chatId: number, messageId: number): Promise<void> {
    if (this.isBusy(chatId) || this.anyActive()) return;
    if (this.grok.hasInflightPrompt()) {
      await this.api.sendMessage(chatId, "\u23F3 Grok is busy running a turn — try /reauth when idle (or /cancel first).").catch(() => {});
      return;
    }
    const s: ReauthSession = this.sessions.get(chatId) ?? { chatId, messageId, phase: "login", frame: 0 };
    s.messageId = messageId;
    s.phase = "login";
    s.errorMsg = undefined;
    s.url = undefined;
    s.code = undefined;
    this.sessions.set(chatId, s);
    void this.run(s);
  }

  /** Adopt an existing on-host login, then restart the agent. */
  async importExisting(chatId: number, messageId: number): Promise<void> {
    if (this.isBusy(chatId) || this.anyActive()) return;
    const s: ReauthSession = this.sessions.get(chatId) ?? { chatId, messageId, phase: "restarting", frame: 0 };
    s.messageId = messageId;
    const res = await this.auth.importExisting();
    if (!res.ok) {
      s.phase = "failed";
      s.errorMsg = res.error;
      this.sessions.set(chatId, s);
      return void this.render(s);
    }
    s.phase = "restarting";
    s.errorMsg = undefined;
    this.sessions.set(chatId, s);
    this.startAnim(s);
    await this.render(s);
    await this.finishRestart(s);
  }

  cancel(chatId: number): boolean {
    const s = this.sessions.get(chatId);
    if (!s || !ACTIVE.has(s.phase)) return false;
    s.abort?.abort();
    return true;
  }

  async cancelChoice(chatId: number, messageId: number): Promise<void> {
    const s = this.sessions.get(chatId);
    if (s && s.phase === "choosing") this.sessions.delete(chatId);
    await this.api.editMessageText(chatId, messageId, "\u{1F510} Sign-in cancelled.").catch(() => {});
  }

  async retry(chatId: number, messageId: number): Promise<void> {
    await this.chooseMethod(chatId, messageId);
  }

  // ── flow ───────────────────────────────────────────────────────────────────

  private async run(s: ReauthSession): Promise<void> {
    s.abort = new AbortController();
    s.accountLabel = undefined;
    let agentDown = false;
    try {
      this.startAnim(s);
      await this.render(s);
      await this.grok.stopAndWait(); // release the agent before sign-in
      agentDown = true;
      await this.auth.logout();
      if (s.abort.signal.aborted) {
        s.phase = "cancelled";
        return;
      }
      let raw = "";
      const result = await this.auth.login({
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal: s.abort.signal,
        onOutput: (t) => {
          raw += t;
          const p = parseLoginOutput(raw);
          let changed = false;
          if (p.url && p.url !== s.url) {
            s.url = p.url;
            changed = true;
          }
          if (p.code && p.code !== s.code) {
            s.code = p.code;
            changed = true;
          }
          if (changed) void this.render(s);
        },
      });
      if (result.cancelled || s.abort.signal.aborted) {
        s.phase = "cancelled";
        return;
      }
      if (!result.ok) {
        s.phase = "failed";
        s.errorMsg = result.error ?? `Sign-in did not complete (exit ${result.code ?? "?"}).`;
        return;
      }
      s.phase = "restarting";
      await this.render(s);
      await this.grok.start();
      agentDown = false;
      s.accountLabel = accountLabel(await this.getAccount?.().catch(() => undefined));
      s.phase = "done";
    } catch (e) {
      log.warn("reauth flow failed:", (e as Error).message);
      s.phase = "failed";
      s.errorMsg = (e as Error).message;
    } finally {
      s.abort = undefined;
      this.stopAnim(s);
      if (agentDown) await this.grok.start().catch((e) => log.warn("post-reauth restart failed:", (e as Error).message));
      await this.render(s);
    }
  }

  private async finishRestart(s: ReauthSession): Promise<void> {
    try {
      await this.grok.restart();
      s.accountLabel = accountLabel(await this.getAccount?.().catch(() => undefined));
      s.phase = "done";
    } catch (e) {
      s.phase = "failed";
      s.errorMsg = (e as Error).message;
    }
    this.stopAnim(s);
    await this.render(s);
  }

  private startAnim(s: ReauthSession): void {
    if (s.anim) return;
    s.anim = setInterval(() => {
      s.frame++;
      void this.render(s);
    }, ANIM_MS);
  }

  private stopAnim(s: ReauthSession): void {
    if (s.anim) {
      clearInterval(s.anim);
      s.anim = undefined;
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────────

  private text(s: ReauthSession): string {
    const loader = LOADER[s.frame % LOADER.length] ?? "";
    switch (s.phase) {
      case "choosing":
        return (
          "\u{1F510} Sign in to Grok\n\n" +
          "Grok signs in with your xAI account (SuperGrok / X Premium+).\n\n" +
          "\u2022 \u{1F511} Sign in \u2014 runs `grok login`; if a link/code appears, open it to approve.\n" +
          "\u2022 \u{1F4E5} Import existing \u2014 use a `grok login` already done on this machine."
        );
      case "login": {
        const lines = ["\u{1F511} Signing in to Grok\u2026", ""];
        if (s.url) lines.push(`\u{1F517} Open this link to approve:\n${s.url}`, "");
        if (s.code) lines.push(`\u{1F522} Verification code: ${s.code}`, "");
        if (!s.url && !s.code) lines.push("Starting sign-in (a browser may open on the host)\u2026", "");
        lines.push(`${loader} Waiting\u2026`);
        return lines.join("\n");
      }
      case "restarting":
        return `\u2705 Signed in.\n\u{1F504} Restarting the Grok agent\u2026  ${loader}`;
      case "done":
        return (
          `\u2705 Signed in${s.accountLabel ? ` as ${s.accountLabel}` : ""} and agent restarted.\n` +
          "Your next message runs on this account."
        );
      case "cancelled":
        return "\u{1F6D1} Sign-in cancelled. Tap Retry to try again.";
      case "failed":
        return `\u274C ${s.errorMsg ?? "Sign-in failed."}\nTap Retry to try again.`;
      default:
        return "";
    }
  }

  private keyboard(s: ReauthSession): InlineKeyboard | undefined {
    switch (s.phase) {
      case "choosing":
        return new InlineKeyboard()
          .text("\u{1F511} Sign in", "reauth:login")
          .text("\u{1F4E5} Import existing", "reauth:import")
          .row()
          .text("\u274C Cancel", "reauth:choose-cancel");
      case "login":
      case "restarting":
        return new InlineKeyboard().text("\u274C Cancel", "reauth:cancel");
      case "cancelled":
      case "failed":
        return new InlineKeyboard().text("\u{1F501} Retry", "reauth:retry");
      default:
        return undefined;
    }
  }

  private async render(s: ReauthSession): Promise<void> {
    const text = this.text(s);
    if (text === s.lastText) return;
    s.lastText = text;
    await this.api
      .editMessageText(s.chatId, s.messageId, text, {
        reply_markup: this.keyboard(s),
        link_preview_options: { is_disabled: true },
      })
      .catch(() => {});
  }
}

function accountLabel(a: AccountInfo | undefined): string | undefined {
  return a?.email || a?.startUrl || a?.accountType;
}
