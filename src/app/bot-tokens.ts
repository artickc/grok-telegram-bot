/**
 * Parse Telegram bot tokens from the environment.
 *
 *   TELEGRAM_BOT_TOKEN              primary bot (unprefixed settings keys)
 *   TELEGRAM_BOT_TOKEN_<LABEL>      extra bots, e.g. TELEGRAM_BOT_TOKEN_APP
 *
 * Labels come from the suffix (APP → "app"). The primary token keeps existing
 * `settings.json` keys so an upgrade does not drop the current session.
 */
export interface BotTokenSpec {
  token: string;
  /** Lowercased suffix (`app`) or `"default"` for TELEGRAM_BOT_TOKEN. */
  label: string;
  /** First / legacy bot — settings and tasks stay unprefixed. */
  primary: boolean;
  envKey: string;
}

const LABELED_RE = /^TELEGRAM_BOT_TOKEN_([A-Z][A-Z0-9_]*)$/;

export function parseBotTokens(env: Record<string, string | undefined>): BotTokenSpec[] {
  const primaryRaw = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const labeled: BotTokenSpec[] = [];
  for (const [key, raw] of Object.entries(env)) {
    const m = LABELED_RE.exec(key);
    if (!m) continue;
    const token = (raw ?? "").trim();
    if (!token) continue;
    labeled.push({
      token,
      label: m[1]!.toLowerCase(),
      primary: false,
      envKey: key,
    });
  }
  labeled.sort((a, b) => a.label.localeCompare(b.label));

  const out: BotTokenSpec[] = [];
  const seen = new Set<string>();
  if (primaryRaw) {
    out.push({ token: primaryRaw, label: "default", primary: true, envKey: "TELEGRAM_BOT_TOKEN" });
    seen.add(primaryRaw);
  }
  for (const spec of labeled) {
    if (seen.has(spec.token)) continue;
    seen.add(spec.token);
    out.push(spec);
  }
  if (out.length === 0) {
    throw new Error(
      "No Telegram bot token set. Set TELEGRAM_BOT_TOKEN and/or TELEGRAM_BOT_TOKEN_<LABEL> (e.g. TELEGRAM_BOT_TOKEN_APP).",
    );
  }
  if (!out.some((s) => s.primary)) out[0]!.primary = true;
  return out;
}
