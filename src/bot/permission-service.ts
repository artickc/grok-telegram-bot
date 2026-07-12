/**
 * PermissionService — turns Grok's ACP `session/request_permission` into either
 * an automatic session-level approval (default) or inline Approve/Deny buttons.
 *
 * Auto-approve prefers "allow for this session" / "always allow" options so the
 * agent stops re-prompting mid-turn. Interactive mode is only used when
 * auto-approve is off (GROK_TRUST_ALL_TOOLS=false and AUTO_APPROVE_PERMISSIONS=false).
 */
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import type { PermissionOutcome, RequestPermissionParams } from "../grok/types.js";
import { createLogger } from "../logger.js";
import type { RuntimeRegistry } from "./registry.js";

const log = createLogger("permissions");
const TIMEOUT_MS = 10 * 60 * 1000;

const KIND_ICON: Record<string, string> = {
  read: "\u{1F4D6}",
  edit: "\u270F\uFE0F",
  execute: "\u{1F4BB}",
  delete: "\u{1F5D1}\uFE0F",
  move: "\u{1F4E6}",
  fetch: "\u{1F310}",
};

interface Pending {
  resolve: (o: PermissionOutcome) => void;
  options: RequestPermissionParams["options"];
  chatId: number;
  sessionId: string;
  messageId?: number;
  timer: NodeJS.Timeout;
}

export class PermissionService {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  /** When true, every permission request is auto-approved (session-scope preferred). */
  autoApprove: boolean;

  constructor(
    private readonly api: Api,
    private readonly registry: RuntimeRegistry,
    autoApprove = true,
  ) {
    this.autoApprove = autoApprove;
  }

  /** Handle a permission request: auto-approve (default), ask the chat, or allow if unattended. */
  async handle(params: RequestPermissionParams): Promise<PermissionOutcome> {
    if (this.autoApprove) {
      const decision = autoDecideSession(params);
      log.info(
        `auto-approved permission for session ${params.sessionId.slice(0, 8)} ` +
          `(${params.toolCall?.kind ?? "tool"}: ${params.toolCall?.title ?? "?"})`,
      );
      return decision;
    }

    const desc = this.registry.describeSession(params.sessionId);
    const chatId = desc.chatId;
    if (chatId === undefined) return autoDecideSession(params); // unattended (scheduled / orphan)

    const reqId = String(++this.seq);
    const isForeground = !desc.subagent && this.registry.get(chatId).sessionId === params.sessionId;
    // A "Switch to it" button only makes sense for a real, controlled background
    // session — never for the foreground, and never for a subagent (which the
    // chat doesn't control directly).
    const canSwitch = desc.controlled && !isForeground;
    const label = desc.subagent
      ? desc.subagentName || "subagent"
      : desc.projectName || params.sessionId.slice(0, 8);

    const kb = new InlineKeyboard();
    params.options.forEach((o, i) => kb.text(buttonLabel(o), `perm:${reqId}:${i}`));
    kb.row();
    if (canSwitch) kb.text(`\u{1F500} Switch to ${label}`, `permsw:${reqId}`);

    let messageId: number | undefined;
    try {
      const msg = await this.api.sendMessage(
        chatId,
        describe(params, { label: isForeground ? undefined : label, subagent: desc.subagent, canSwitch }),
        {
          reply_markup: kb,
          disable_notification: false, // requires interaction → always with sound
        },
      );
      messageId = msg.message_id;
    } catch (e) {
      log.warn("failed to send permission prompt:", (e as Error).message);
      return autoDecideSession(params);
    }

    return new Promise<PermissionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        void this.api.editMessageText(chatId, messageId!, "\u231B Approval timed out \u2014 denied.").catch(() => {});
        resolve({ outcome: { outcome: "cancelled" } });
      }, TIMEOUT_MS);
      this.pending.set(reqId, { resolve, options: params.options, chatId, sessionId: params.sessionId, messageId, timer });
    });
  }

  /** Resolve a pending request from a button tap; returns the chosen label. */
  resolveChoice(reqId: string, index: number): string | undefined {
    const p = this.pending.get(reqId);
    if (!p) return undefined;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    const opt = p.options[index];
    if (!opt) {
      p.resolve({ outcome: { outcome: "cancelled" } });
      return undefined;
    }
    p.resolve({ outcome: { outcome: "selected", optionId: opt.optionId } });
    return opt.name;
  }

  /** The session a pending request belongs to (for the Switch button). */
  sessionFor(reqId: string): string | undefined {
    return this.pending.get(reqId)?.sessionId;
  }
}

function describe(
  params: RequestPermissionParams,
  ctx: { label?: string; subagent: boolean; canSwitch: boolean },
): string {
  const tc = params.toolCall;
  const kind = (tc?.kind || "other").toLowerCase();
  const icon = KIND_ICON[kind] ?? "\u{1F527}";
  const title = tc?.title || kind;
  const raw = (tc?.rawInput || {}) as Record<string, unknown>;
  const cmd = typeof raw.command === "string" ? raw.command : undefined;
  const path = typeof raw.path === "string" ? raw.path : undefined;
  const detail = cmd ? `\n\n$ ${cmd}` : path ? `\n\n${path}` : "";
  const who = ctx.subagent
    ? `\u{1F916}\u{1F510} Subagent "${ctx.label}" needs approval to run a tool:`
    : ctx.label
      ? `\u{1F510} Session "${ctx.label}" needs approval to run a tool:`
      : "\u{1F510} Grok wants to run a tool:";
  const tail = ctx.canSwitch
    ? "\n\nApprove here (no switch), or \u{1F500} switch to that session."
    : ctx.subagent
      ? "\n\nApprove for the subagent to continue?"
      : "\n\nApprove?";
  return `${who}\n${icon} ${title}${detail}${tail}`;
}

function buttonLabel(o: { name: string; kind?: string }): string {
  const k = `${o.kind ?? ""} ${o.name}`.toLowerCase();
  const icon = /reject|deny|no|cancel/.test(k) ? "\u26D4" : /always|all|session/.test(k) ? "\u2705\u267E\uFE0F" : "\u2705";
  return `${icon} ${o.name}`;
}

/**
 * Score an allow-option. Higher is better for bot auto-approve:
 *   4 — always allow all sessions / forever
 *   3 — allow for this session (preferred default)
 *   2 — allow always (unscoped)
 *   1 — allow once / approve / yes
 *   0 — not an allow option (reject/deny)
 */
function allowScore(o: { name: string; kind?: string }): number {
  const k = `${o.kind ?? ""} ${o.name}`.toLowerCase();
  if (/reject|deny|cancel|no\b|block/.test(k)) return 0;
  if (/all.?sessions|always_allow_all|forever|unrestricted/.test(k)) return 4;
  if (/this.?session|session|allow_session|always_allow_session/.test(k)) return 3;
  if (/always|allow_always|allow.?all\b/.test(k)) return 2;
  if (/allow|approve|yes|once|ok\b/.test(k)) return 1;
  return 0;
}

/**
 * Pick the best allow option, preferring "this session" / "always" so the agent
 * stops re-prompting. Falls back to cancelled only when no allow option exists.
 */
export function autoDecideSession(params: RequestPermissionParams): PermissionOutcome {
  let best: { optionId: string; score: number } | undefined;
  for (const o of params.options) {
    const score = allowScore(o);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { optionId: o.optionId, score };
  }
  if (best) return { outcome: { outcome: "selected", optionId: best.optionId } };
  // Last resort: first option if present (agent convention: allow first).
  const first = params.options[0];
  return first
    ? { outcome: { outcome: "selected", optionId: first.optionId } }
    : { outcome: { outcome: "cancelled" } };
}
